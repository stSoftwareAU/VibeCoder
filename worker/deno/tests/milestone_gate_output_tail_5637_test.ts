/**
 * The kept tail of a check's output keeps the failing test's report (Issue
 * #5637).
 *
 * A cold module cache writes hundreds of Deno `Download https://…` progress
 * lines to stderr, ahead of the test report on stdout. The gate joined the two
 * and kept the last 40 lines, so the recorded output and the repair prompt
 * held only the download lines and `error: Test failed`. Each run of download
 * lines now collapses to one marker line before the tail is taken.
 *
 * The output shapes are those Deno 2.9.8 printed for `deno task test:unit`
 * with `deno test --reporter=dot`, colour codes included. The entry points are
 * driven with injected fakes; no check is spawned.
 *
 * Australian English spelling throughout (behaviour, colour).
 */

import { assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { stripAnsi } from "../lib/github_actions_log_fetcher.ts";
import {
  checkMergedTree,
  collapseDownloadProgress,
} from "../lib/milestone_merge_gate.ts";
import {
  spawnTask,
  verifyResolvedTree,
} from "../lib/milestone_resolution_gate.ts";
import { runMergeFastChecks } from "../lib/merge_fast_checks.ts";
import type { runRepositoryCommand } from "../lib/untrusted_gate_spawn.ts";

const DENO_MANIFEST = JSON.stringify({
  tasks: {
    check: "deno check **/*.ts",
    "check:manifests": "deno run check_manifests.ts",
    "test:unit": "deno test",
    test: "deno test --all",
  },
});

/** The stdout of the failing `deno test --reporter=dot` run, as Deno printed it. */
const STDOUT = [
  "\x1b[0m\x1b[38;5;245m.\x1b[0m",
  "\x1b[0m\x1b[1m\x1b[31m!\x1b[0m",
  "",
  "\x1b[0m\x1b[1m\x1b[37m\x1b[41m ERRORS \x1b[0m",
  "",
  "the ensemble error is common \x1b[0m\x1b[38;5;245m=> ./t_test.ts:3:6\x1b[0m",
  "\x1b[0m\x1b[1m\x1b[31merror\x1b[0m: Error: expected 2, got 1000",
  "    at file:///tmp/x/t_test.ts:3:77",
  "",
  "\x1b[0m\x1b[1m\x1b[37m\x1b[41m FAILURES \x1b[0m",
  "",
  "the ensemble error is common \x1b[0m\x1b[38;5;245m=> ./t_test.ts:3:6\x1b[0m",
  "",
  "\x1b[0m\x1b[31mFAILED\x1b[0m | 1 passed | 1 failed \x1b[0m\x1b[38;5;245m(12ms)\x1b[0m",
].join("\n");

/** One Download progress line per module: a cold cache for a large tree. */
const DOWNLOAD_LINES = Array.from(
  { length: 150 },
  (_, i) =>
    `\x1b[0m\x1b[32mDownload\x1b[0m https://registry.npmjs.org/dep${i}/-/dep${i}-1.0.0.tgz`,
);

/** The stderr of the same run: the download lines, the task, then the error. */
const STDERR = [
  ...DOWNLOAD_LINES,
  "\x1b[0m\x1b[32mTask\x1b[0m \x1b[0m\x1b[36mtest:unit\x1b[0m deno test --no-prompt --reporter=dot t_test.ts",
  "\x1b[0m\x1b[1m\x1b[31merror\x1b[0m: Test failed",
].join("\n");

/** The combined text of the run, stdout then stderr, as `spawnTask` joins it. */
const COMBINED = [STDOUT, STDERR].join("\n");

/** A command runner that finished with the failing run's streams. */
const fakeRun: typeof runRepositoryCommand = async () => ({
  ok: true,
  value: {
    success: false,
    code: 1,
    stdout: STDOUT,
    stderr: STDERR,
    timedOut: false,
  },
});

const passingTypeCheck = () =>
  Promise.resolve({
    status: "passed" as const,
    detail: "deno task check passed",
    output: "",
  });

/**
 * Assert the failing report survived into a recorded output: the test name,
 * its assertion, the run summary and the one marker standing for the downloads.
 */
function assertFailingReport(output: string): void {
  const text = stripAnsi(output);
  assertStringIncludes(text, "the ensemble error is common");
  assertStringIncludes(text, "expected 2, got 1000");
  assertStringIncludes(text, "error: Test failed");
  assertStringIncludes(text, "FAILED | 1 passed | 1 failed");
  assertStringIncludes(
    text,
    "[150 Deno module download line(s) omitted]",
  );
  assertFalse(/^Download /m.test(text));
}

Deno.test("verifyResolvedTree - a test report survives a cold module cache's download lines (Issue #5637)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-5637-" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ tasks: { "test:unit": "deno test" } }),
    );
    const outcome = await verifyResolvedTree(
      dir,
      (task) => spawnTask(task, fakeRun),
      passingTypeCheck,
      undefined,
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "failed");
    assertEquals(outcome.cause, "tree-check-failed");
    assertFailingReport(outcome.output);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("checkMergedTree - a test report survives a cold module cache's download lines (Issue #5637)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "issue-5637-" });
  try {
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({ tasks: { "test:unit": "deno test" } }),
    );
    const outcome = await checkMergedTree(
      dir,
      () => Promise.resolve({ code: 1, output: COMBINED }),
      () => Promise.resolve(false),
    );
    assertEquals(outcome.status, "failed");
    assertEquals(outcome.cause, "tree-check-failed");
    assertFailingReport(outcome.output);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("runMergeFastChecks - a test report survives a cold module cache's download lines (Issue #5637)", async () => {
  const root = await Deno.makeTempDir({ prefix: "issue-5637-" });
  try {
    await Deno.writeTextFile(`${root}/deno.json`, DENO_MANIFEST);
    const failing = `deno task test:unit in ${root}`;
    const outcome = await runMergeFastChecks(
      root,
      ["src/main.ts"],
      (check) =>
        Promise.resolve(
          check.label === failing
            ? { code: 1, output: COMBINED }
            : { code: 0, output: "" },
        ),
      () => 0,
    );
    assertEquals(outcome.status, "failed");
    if (outcome.status !== "failed") return;
    assertEquals(outcome.failingCommand, failing);
    assertFailingReport(outcome.output);
  } finally {
    await Deno.remove(root, { recursive: true }).catch(() => {});
  }
});

Deno.test("collapseDownloadProgress - two separate runs become two markers with their own counts (Issue #5637)", () => {
  assertEquals(
    collapseDownloadProgress(
      [
        "\x1b[0m\x1b[32mDownload\x1b[0m https://a.example/x",
        "Download https://a.example/y",
        "kept one",
        "Download https://b.example/x",
        "Download https://b.example/y",
        "Download https://b.example/z",
      ].join("\n"),
    ),
    [
      "[2 Deno module download line(s) omitted]",
      "kept one",
      "[3 Deno module download line(s) omitted]",
    ].join("\n"),
  );
});

Deno.test("collapseDownloadProgress - a single coloured download line becomes a [1] marker (Issue #5637)", () => {
  assertEquals(
    collapseDownloadProgress(
      "\x1b[0m\x1b[32mDownload\x1b[0m https://x/y",
    ),
    "[1 Deno module download line(s) omitted]",
  );
});

Deno.test("collapseDownloadProgress - an uncoloured download line, as under NO_COLOR, is collapsed (Issue #5637)", () => {
  assertEquals(
    collapseDownloadProgress("Download https://x/y"),
    "[1 Deno module download line(s) omitted]",
  );
});

Deno.test("collapseDownloadProgress - look-alike lines are kept verbatim (Issue #5637)", () => {
  const lookAlikes = [
    "Downloaded https://x/y",
    "error: Failed downloading https://x/y",
    "Download",
    "Download failed: https://x/y",
  ].join("\n");
  assertEquals(collapseDownloadProgress(lookAlikes), lookAlikes);
});

Deno.test("collapseDownloadProgress - output with no download lines is returned unchanged (Issue #5637)", () => {
  assertEquals(
    collapseDownloadProgress("first line\nsecond line\nthird line"),
    "first line\nsecond line\nthird line",
  );
});

Deno.test("collapseDownloadProgress - a hostile line of escapes returns unchanged, without backtracking (Issue #5637)", () => {
  const hostile = "\x1b[0m".repeat(50_000) + "Download" +
    "\x1b[0m".repeat(50_000) + "X";
  assertEquals(collapseDownloadProgress(hostile), hostile);
});
