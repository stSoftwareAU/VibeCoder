/**
 * Tests for checkov_report.ts (Issue #3970).
 *
 * Covers:
 *   - the shared Checkov scan arguments, exactly as CI and the local gate run
 *     them;
 *   - the real Checkov 3.3.29 outputs under `fixtures/checkov/`, each judged
 *     PASSED or FAILED with the specific cause named in the report: a failed
 *     check, a parse error (Checkov exits 0), a reasonless skip (Checkov's
 *     "No comment provided" placeholder), a skip set in `Metadata` (accepted
 *     by Checkov, refused here), and the summary-only no-templates object;
 *   - malformed input (bad exit code, malformed or empty JSON, objects that
 *     are not reports) refused rather than passed;
 *   - multi-framework output judged element by element;
 *   - the CLI entry point's exit codes, including bad usage and an unreadable
 *     report, run with the scanned case directory as the working directory so
 *     template reads resolve.
 *
 * Fixtures are captured from `bridgecrew/checkov:3.3.29` (see
 * `fixtures/checkov/README.md`). Australian English spelling used throughout
 * (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CHECKOV_SCAN_ARGS,
  type CheckovTemplateReader,
  judgeCheckovRun,
} from "../lib/checkov_report.ts";

/** Root of the captured Checkov fixtures. */
const FIXTURES = new URL("./fixtures/checkov/", import.meta.url);

/** Absolute path of the CLI entry point the gate and CI invoke. */
const CLI_PATH = new URL("../lib/checkov_report.ts", import.meta.url).pathname;

/** Read a captured Checkov stdout verbatim. */
async function report(name: string): Promise<string> {
  return await Deno.readTextFile(new URL(`${name}/report.json`, FIXTURES));
}

/** A template reader serving files from one fixture case directory. */
function fixtureTemplates(name: string): CheckovTemplateReader {
  return async (path) => {
    try {
      return await Deno.readTextFile(new URL(`${name}/${path}`, FIXTURES));
    } catch {
      return null;
    }
  };
}

/** A template reader that cannot find any template. */
const noTemplates: CheckovTemplateReader = () => Promise.resolve(null);

/** The `- ` problem lines of a verdict report. */
function problemLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("- "));
}

Deno.test("checkov-report - scan arguments match the CI and local gate command", () => {
  assertEquals([...CHECKOV_SCAN_ARGS], [
    "-d",
    ".",
    "--framework",
    "cloudformation",
    "-o",
    "json",
    "--skip-download",
  ]);
});

Deno.test("checkov-report - PASSED for a clean scan (exit 0)", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean"),
  });
  assertEquals(verdict.status, "PASSED");
  assertStringIncludes(verdict.report, "Checkov passed: 2 passed, 0 skipped");
  assertStringIncludes(verdict.report, "Status: PASSED");
});

Deno.test("checkov-report - PASSED for no CloudFormation templates (exit 0)", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("no_templates"),
    templates: noTemplates,
  });
  assertEquals(verdict.status, "PASSED");
  assertStringIncludes(verdict.report, "No CloudFormation templates found");
  assertStringIncludes(verdict.report, "Status: PASSED");
});

Deno.test("checkov-report - PASSED for a skip with a reason in the template (exit 0)", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("reasoned_skip"),
    templates: fixtureTemplates("reasoned_skip"),
  });
  assertEquals(verdict.status, "PASSED");
  assertStringIncludes(verdict.report, "1 skipped with a reason");
});

Deno.test("checkov-report - FAILED names the failed check, file and lines (exit 1)", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 1,
    stdout: await report("failed"),
    templates: fixtureTemplates("failed"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "CKV_AWS_158 failed at /template.yaml lines 3-6",
  );
  assertStringIncludes(verdict.report, "Status: FAILED");
});

Deno.test("checkov-report - FAILED for a parse error even though Checkov exits 0", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("parse_error"),
    templates: fixtureTemplates("parse_error"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "./template.yaml could not be parsed");
  assertStringIncludes(verdict.report, "parse error");
});

Deno.test("checkov-report - FAILED for a skip with no reason (Checkov's placeholder)", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("reasonless_skip"),
    templates: fixtureTemplates("reasonless_skip"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "CKV_AWS_158 skipped without a reason at /template.yaml lines 3-7",
  );
  assertStringIncludes(verdict.report, "No comment provided");
  assertStringIncludes(verdict.report, "no inline");
});

Deno.test("checkov-report - FAILED for a skip set only in Metadata", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("metadata_skip"),
    templates: fixtureTemplates("metadata_skip"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 skip at /template.yaml");
  assertStringIncludes(verdict.report, "no inline");
  assertStringIncludes(verdict.report, "Metadata");
  assertEquals(problemLines(verdict.report).length, 1);
});

Deno.test("checkov-report - FAILED for exit code 2 even with a clean report", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 2,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "exited with code 2");
  assertEquals(problemLines(verdict.report).length, 1);
});

Deno.test("checkov-report - FAILED for malformed JSON", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: `{"results":`,
    templates: noTemplates,
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "not valid Checkov JSON");
});

Deno.test("checkov-report - FAILED for empty or whitespace-only stdout", async () => {
  for (const stdout of ["", "  \n\t"]) {
    const verdict = await judgeCheckovRun({
      exitCode: 0,
      stdout,
      templates: noTemplates,
    });
    assertEquals(verdict.status, "FAILED");
    assertStringIncludes(verdict.report, "stdout is empty");
  }
});

Deno.test("checkov-report - FAILED for JSON that is not a Checkov report", async () => {
  for (const stdout of ["{}", "[]", "5", `{"results": 5}`]) {
    const verdict = await judgeCheckovRun({
      exitCode: 0,
      stdout,
      templates: noTemplates,
    });
    assertEquals(verdict.status, "FAILED", `accepted ${stdout}`);
    assertStringIncludes(verdict.report, "not valid Checkov JSON");
  }
});

Deno.test("checkov-report - FAILED when a skip's template cannot be read", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("reasoned_skip"),
    templates: noTemplates,
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 skip at /template.yaml");
  assertStringIncludes(verdict.report, "could not be read");
  assertEquals(problemLines(verdict.report).length, 1);
});

Deno.test("checkov-report - multi-framework array is FAILED when one element fails", async () => {
  const stdout = JSON.stringify([
    JSON.parse(await report("clean")),
    JSON.parse(await report("failed")),
  ]);
  const verdict = await judgeCheckovRun({
    exitCode: 1,
    stdout,
    templates: fixtureTemplates("failed"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 failed");
});

Deno.test("checkov-report - multi-framework array of one clean report is PASSED", async () => {
  const stdout = JSON.stringify([JSON.parse(await report("clean"))]);
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout,
    templates: fixtureTemplates("clean"),
  });
  assertEquals(verdict.status, "PASSED");
});

/** Run the CLI entry point, optionally from a fixture case directory. */
async function runCli(args: string[], caseDir?: string) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--no-config",
      "--no-lock",
      "--allow-read",
      CLI_PATH,
      ...args,
    ],
    cwd: caseDir === undefined
      ? undefined
      : new URL(`${caseDir}/`, FIXTURES).pathname,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("checkov-report CLI - exit 0 for a clean report", async () => {
  const result = await runCli(
    [new URL("clean/report.json", FIXTURES).pathname, "0"],
    "clean",
  );
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "Status: PASSED");
});

Deno.test("checkov-report CLI - exit 1 for a failed report", async () => {
  const result = await runCli(
    [new URL("failed/report.json", FIXTURES).pathname, "1"],
    "failed",
  );
  assertEquals(result.code, 1, result.stderr);
  assertStringIncludes(result.stdout, "CKV_AWS_158 failed");
});

Deno.test("checkov-report CLI - exit 1 for a reasonless skip, template read from the working directory", async () => {
  const result = await runCli(
    [new URL("reasonless_skip/report.json", FIXTURES).pathname, "0"],
    "reasonless_skip",
  );
  assertEquals(result.code, 1, result.stderr);
  assertStringIncludes(result.stdout, "skipped without a reason");
  assertStringIncludes(result.stdout, "no inline");
  assert(!result.stdout.includes("could not be read"));
});

Deno.test("checkov-report CLI - exit 2 for bad usage", async () => {
  const result = await runCli([
    new URL("clean/report.json", FIXTURES).pathname,
    "not-a-number",
  ]);
  assertEquals(result.code, 2);
  assertStringIncludes(result.stderr, "usage:");
});

Deno.test("checkov-report CLI - exit 1 when the report file is missing", async () => {
  const missing = new URL("does-not-exist.json", FIXTURES).pathname;
  const result = await runCli([missing, "0"]);
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "cannot read report");
  assertStringIncludes(result.stderr, missing);
});
