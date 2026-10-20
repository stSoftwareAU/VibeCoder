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
  main,
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

/** A reader serving `inner`'s templates and recording each path it is asked for. */
function recordingTemplates(inner: CheckovTemplateReader): {
  reader: CheckovTemplateReader;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    reader: async (path) => {
      calls.push(path);
      return await inner(path);
    },
  };
}

/** The reasoned_skip report with its one skipped check's `file_path` replaced. */
async function reasonedSkipAt(filePath: string): Promise<string> {
  const parsed = JSON.parse(await report("reasoned_skip"));
  parsed.results.skipped_checks[0].file_path = filePath;
  return JSON.stringify(parsed);
}

/** The `- ` problem lines of a verdict report. */
function problemLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("- "));
}

/** A parsed JSON value, typed as `JSON.parse` returns it, for in-place edits. */
type ParsedJson = ReturnType<typeof JSON.parse>;

/** A captured report with `edit` applied to its parsed JSON, re-serialised. */
async function editedReport(
  name: string,
  edit: (parsed: ParsedJson) => void,
): Promise<string> {
  const parsed = JSON.parse(await report(name));
  edit(parsed);
  return JSON.stringify(parsed);
}

/** The reasoned_skip report judged with its one skipped check edited by `edit`. */
async function judgeEditedSkip(edit: (entry: ParsedJson) => void): Promise<{
  verdict: Awaited<ReturnType<typeof judgeCheckovRun>>;
  calls: string[];
}> {
  const { reader, calls } = recordingTemplates(
    fixtureTemplates("reasoned_skip"),
  );
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await editedReport(
      "reasoned_skip",
      (parsed) => edit(parsed.results.skipped_checks[0]),
    ),
    templates: reader,
  });
  return { verdict, calls };
}

/** A summary-only Checkov object (no templates found) with `overrides` applied. */
function summaryOnly(overrides: Record<string, number> = {}): string {
  return JSON.stringify({
    passed: 0,
    failed: 0,
    skipped: 0,
    parsing_errors: 0,
    resource_count: 0,
    ...overrides,
  });
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
    "--skip-path",
    "worker/deno/tests/fixtures/checkov",
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

Deno.test("checkov-report - FAILED for a failed check entry that is not an object", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 1,
    stdout: await editedReport("failed", (parsed) => {
      parsed.results.failed_checks[0] = "not-an-entry";
    }),
    templates: fixtureTemplates("failed"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "malformed failed-check entry in results.failed_checks",
  );
  assertStringIncludes(verdict.report, "Status: FAILED");
  assertEquals(problemLines(verdict.report).length, 1);
});

Deno.test("checkov-report - FAILED names a placeholder for a failed check with an empty check ID", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 1,
    stdout: await editedReport("failed", (parsed) => {
      parsed.results.failed_checks[0].check_id = "";
    }),
    templates: fixtureTemplates("failed"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "<unnamed check> failed at /template.yaml lines 3-6",
  );
  assertEquals(problemLines(verdict.report).length, 1);
});

Deno.test("checkov-report - FAILED names a failed check's name only when it is set", async () => {
  const named = await judgeCheckovRun({
    exitCode: 1,
    stdout: await report("failed"),
    templates: fixtureTemplates("failed"),
  });
  assertEquals(problemLines(named.report), [
    "- CKV_AWS_158 failed at /template.yaml lines 3-6 (Ensure that CloudWatch Log Group is encrypted by KMS)",
  ]);

  const unnamed = await judgeCheckovRun({
    exitCode: 1,
    stdout: await editedReport("failed", (parsed) => {
      parsed.results.failed_checks[0].check_name = "";
    }),
    templates: fixtureTemplates("failed"),
  });
  assertEquals(problemLines(unnamed.report), [
    "- CKV_AWS_158 failed at /template.yaml lines 3-6",
  ]);
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

Deno.test("checkov-report - PASSED for a skip whose reason is only at the top level of the entry", async () => {
  const { verdict, calls } = await judgeEditedSkip((entry) => {
    delete entry.check_result.suppress_comment;
    entry.suppress_comment = "Log group holds no sensitive data";
  });
  assertEquals(verdict.status, "PASSED");
  assertEquals(calls, ["template.yaml"]);
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

Deno.test("checkov-report - FAILED for an inline skip naming a different check ID", async () => {
  const template = await Deno.readTextFile(
    new URL("reasoned_skip/template.yaml", FIXTURES),
  );
  const swapped = template.replace(
    "# checkov:skip=CKV_AWS_158:",
    "# checkov:skip=CKV_AWS_999:",
  );
  assertStringIncludes(
    swapped,
    "# checkov:skip=CKV_AWS_999:Log group holds no sensitive data",
  );

  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("reasoned_skip"),
    templates: fixtureTemplates("reasoned_skip"),
  });
  assertEquals(control.status, "PASSED");

  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("reasoned_skip"),
    templates: (path) =>
      Promise.resolve(path === "template.yaml" ? swapped : null),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 skip at /template.yaml");
  assertStringIncludes(verdict.report, "no inline");
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

Deno.test("checkov-report - FAILED names the JSON parse error, not just the status", async () => {
  const stdout = `{"results":`;
  let parseMessage = "";
  try {
    JSON.parse(stdout);
  } catch (error) {
    parseMessage = error instanceof Error ? error.message : String(error);
  }
  assert(parseMessage !== "", "JSON.parse should throw on the truncated input");
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout,
    templates: noTemplates,
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    `output is not valid Checkov JSON (parse error: ${parseMessage})`,
  );
  assertEquals(problemLines(verdict.report).length, 1);
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

Deno.test("checkov-report - FAILED for a skipped check entry that is not an object", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await editedReport("reasoned_skip", (parsed) => {
      parsed.results.skipped_checks[0] = "not-an-entry";
    }),
    templates: fixtureTemplates("reasoned_skip"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "malformed skipped-check entry in results.skipped_checks",
  );
  assertStringIncludes(verdict.report, "Status: FAILED");
  assertEquals(problemLines(verdict.report).length, 1);
});

Deno.test("checkov-report - FAILED without reading a skip whose file path leaves the scan", async () => {
  for (
    const filePath of ["/../template.yaml", "/missing/../../template.yaml"]
  ) {
    const { reader, calls } = recordingTemplates(
      fixtureTemplates("reasoned_skip"),
    );
    const verdict = await judgeCheckovRun({
      exitCode: 0,
      stdout: await reasonedSkipAt(filePath),
      templates: reader,
    });
    assertEquals(verdict.status, "FAILED", filePath);
    assertStringIncludes(verdict.report, `CKV_AWS_158 skip at ${filePath}`);
    assertStringIncludes(
      verdict.report,
      "has a file path outside the scanned directory",
    );
    assertEquals(calls, [], `reader called for ${filePath}`);
    assertEquals(problemLines(verdict.report).length, 1);
  }
});

Deno.test("checkov-report - PASSED for the same skip at its original file path (control)", async () => {
  const { reader, calls } = recordingTemplates(
    fixtureTemplates("reasoned_skip"),
  );
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await reasonedSkipAt("/template.yaml"),
    templates: reader,
  });
  assertEquals(verdict.status, "PASSED");
  assertEquals(calls, ["template.yaml"]);
});

Deno.test("checkov-report - FAILED for a skip whose file_line_range is not two entries", async () => {
  for (const range of [[3], [3, 6, 9]]) {
    const { verdict, calls } = await judgeEditedSkip((entry) => {
      entry.file_line_range = range;
    });
    assertEquals(verdict.status, "FAILED", JSON.stringify(range));
    assertStringIncludes(
      verdict.report,
      "CKV_AWS_158 skip at /template.yaml has no valid file_line_range",
    );
    assertEquals(calls, [], JSON.stringify(range));
    assertEquals(problemLines(verdict.report).length, 1, JSON.stringify(range));
  }
  const control = await judgeEditedSkip((entry) => {
    entry.file_line_range = [3, 6];
  });
  assertEquals(control.verdict.status, "PASSED");
});

Deno.test("checkov-report - FAILED for a skip whose file_line_range holds non-integers", async () => {
  for (const range of [[3.5, 6], [3, 6.5]]) {
    const { verdict, calls } = await judgeEditedSkip((entry) => {
      entry.file_line_range = range;
    });
    assertEquals(verdict.status, "FAILED", JSON.stringify(range));
    assertStringIncludes(
      verdict.report,
      "CKV_AWS_158 skip at /template.yaml has no valid file_line_range",
    );
    assertEquals(calls, [], JSON.stringify(range));
    assertEquals(problemLines(verdict.report).length, 1, JSON.stringify(range));
  }
  const control = await judgeEditedSkip((entry) => {
    entry.file_line_range = [3, 6];
  });
  assertEquals(control.verdict.status, "PASSED");
});

Deno.test("checkov-report - FAILED for a skip whose file_line_range starts below 1 or ends before it starts", async () => {
  for (const range of [[0, 6], [6, 3]]) {
    const { verdict, calls } = await judgeEditedSkip((entry) => {
      entry.file_line_range = range;
    });
    assertEquals(verdict.status, "FAILED", JSON.stringify(range));
    assertStringIncludes(
      verdict.report,
      "CKV_AWS_158 skip at /template.yaml has no valid file_line_range",
    );
    assertEquals(calls, [], JSON.stringify(range));
    assertEquals(problemLines(verdict.report).length, 1, JSON.stringify(range));
  }
  const control = await judgeEditedSkip((entry) => {
    entry.file_line_range = [3, 6];
  });
  assertEquals(control.verdict.status, "PASSED");
});

Deno.test("checkov-report - FAILED for a skip with no file_line_range", async () => {
  const { verdict, calls } = await judgeEditedSkip((entry) => {
    delete entry.file_line_range;
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "CKV_AWS_158 skip at /template.yaml has no valid file_line_range",
  );
  assertEquals(calls, []);
  assertEquals(problemLines(verdict.report).length, 1);
});

Deno.test("checkov-report - FAILED for a skip whose file_path is not a string", async () => {
  for (const filePath of [42, true]) {
    const { verdict, calls } = await judgeEditedSkip((entry) => {
      entry.file_path = filePath;
    });
    assertEquals(verdict.status, "FAILED", String(filePath));
    assertStringIncludes(
      verdict.report,
      "CKV_AWS_158 skip at <unknown file> lines 3-7 has no usable file_path",
    );
    assertEquals(calls, [], String(filePath));
    assertEquals(problemLines(verdict.report).length, 1, String(filePath));
  }
});

Deno.test("checkov-report - FAILED for a skip with no file_path", async () => {
  const { verdict, calls } = await judgeEditedSkip((entry) => {
    delete entry.file_path;
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "CKV_AWS_158 skip at <unknown file> lines 3-7 has no usable file_path",
  );
  assertEquals(calls, []);
  assertEquals(problemLines(verdict.report).length, 1);
});

Deno.test("checkov-report - FAILED for a skip whose file_path is empty once stripped", async () => {
  for (const filePath of ["", "/", "./"]) {
    const { verdict, calls } = await judgeEditedSkip((entry) => {
      entry.file_path = filePath;
    });
    assertEquals(verdict.status, "FAILED", JSON.stringify(filePath));
    assertStringIncludes(verdict.report, "has no usable file_path");
    assertEquals(calls, [], JSON.stringify(filePath));
    assertEquals(
      problemLines(verdict.report).length,
      1,
      JSON.stringify(filePath),
    );
  }
});

Deno.test("checkov-report - FAILED without reading a skip whose file path is absolute or holds a NUL", async () => {
  for (
    const filePath of ["//etc/passwd", "\\etc\\passwd", "template.yaml\u0000"]
  ) {
    const { verdict, calls } = await judgeEditedSkip((entry) => {
      entry.file_path = filePath;
    });
    assertEquals(verdict.status, "FAILED", JSON.stringify(filePath));
    assertStringIncludes(
      verdict.report,
      `CKV_AWS_158 skip at ${filePath} lines 3-7 has a file path outside the scanned directory`,
    );
    assertEquals(calls, [], JSON.stringify(filePath));
    assertEquals(
      problemLines(verdict.report).length,
      1,
      JSON.stringify(filePath),
    );
  }
});

Deno.test("checkov-report - FAILED for a summary-only object that reports failed checks", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 1,
    stdout: summaryOnly({ failed: 1 }),
    templates: noTemplates,
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "summary reports 1 failed check(s) with no report body to name them",
  );
  assertEquals(problemLines(verdict.report).length, 1);

  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: summaryOnly(),
    templates: noTemplates,
  });
  assertEquals(control.status, "PASSED");
  assertStringIncludes(control.report, "No CloudFormation templates found");
});

Deno.test("checkov-report - FAILED for a summary-only object that reports parsing errors", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: summaryOnly({ parsing_errors: 1 }),
    templates: noTemplates,
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "summary reports 1 parsing error(s) with no report body to name the files",
  );
  assertEquals(problemLines(verdict.report).length, 1);

  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: summaryOnly(),
    templates: noTemplates,
  });
  assertEquals(control.status, "PASSED");
});

Deno.test("checkov-report - FAILED when a results list is not a list", async () => {
  for (const key of ["failed_checks", "skipped_checks", "parsing_errors"]) {
    const verdict = await judgeCheckovRun({
      exitCode: 0,
      stdout: await editedReport("clean", (parsed) => {
        parsed.results[key] = "none";
      }),
      templates: fixtureTemplates("clean"),
    });
    assertEquals(verdict.status, "FAILED", key);
    assertStringIncludes(verdict.report, `results.${key} is not a list`);
    assertEquals(problemLines(verdict.report).length, 1, key);
  }

  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean"),
  });
  assertEquals(control.status, "PASSED");
});

Deno.test("checkov-report - FAILED when a summary count is not a number", async () => {
  for (const key of ["passed", "failed", "skipped", "parsing_errors"]) {
    const verdict = await judgeCheckovRun({
      exitCode: 0,
      stdout: await editedReport("clean", (parsed) => {
        parsed.summary[key] = "0";
      }),
      templates: fixtureTemplates("clean"),
    });
    assertEquals(verdict.status, "FAILED", key);
    assertStringIncludes(verdict.report, `summary.${key} is not a number`);
    assertEquals(problemLines(verdict.report).length, 1, key);
  }

  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean"),
  });
  assertEquals(control.status, "PASSED");
});

Deno.test("checkov-report - FAILED when the summary counts failed checks but none are listed", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 1,
    stdout: await editedReport("clean", (parsed) => {
      parsed.summary.failed = 1;
    }),
    templates: fixtureTemplates("clean"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "summary reports 1 failed check(s) but none are listed",
  );
  assertEquals(problemLines(verdict.report).length, 1);

  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean"),
  });
  assertEquals(control.status, "PASSED");
});

Deno.test("checkov-report - FAILED when the summary counts parse errors but names no file", async () => {
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await editedReport("clean", (parsed) => {
      parsed.summary.parsing_errors = 1;
    }),
    templates: fixtureTemplates("clean"),
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(
    verdict.report,
    "summary reports 1 parsing error(s) but names no file",
  );
  assertEquals(problemLines(verdict.report).length, 1);

  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean"),
  });
  assertEquals(control.status, "PASSED");
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

Deno.test("checkov-report CLI - exit 2 for too many arguments", async () => {
  const result = await runCli([
    new URL("clean/report.json", FIXTURES).pathname,
    "0",
    "extra",
  ]);
  assertEquals(result.code, 2);
  assertStringIncludes(result.stderr, "usage:");
  assertEquals(result.stdout, "");
});

Deno.test("checkov-report CLI - exit 1 when the report file is missing", async () => {
  const missing = new URL("does-not-exist.json", FIXTURES).pathname;
  const result = await runCli([missing, "0"]);
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "cannot read report");
  assertStringIncludes(result.stderr, missing);
});

Deno.test("checkov-report CLI - an unreadable report prints no verdict to stdout", async () => {
  const missing = new URL("does-not-exist.json", FIXTURES).pathname;
  const result = await runCli([missing, "0"]);
  assertEquals(result.code, 1);
  assertEquals(
    result.stdout,
    "",
    "no verdict should be judged from a report that was not read",
  );
  assertStringIncludes(result.stderr, `cannot read report ${missing}`);
});

Deno.test("checkov-report - an unreadable report makes main return 1 without throwing", async () => {
  const missing = new URL("does-not-exist.json", FIXTURES).pathname;
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  let code = -1;
  try {
    code = await main([missing, "0"]);
  } finally {
    console.error = originalError;
  }
  assertEquals(code, 1);
  assertEquals(logged.length, 1);
  assertStringIncludes(logged[0] ?? "", `cannot read report ${missing}`);
});
