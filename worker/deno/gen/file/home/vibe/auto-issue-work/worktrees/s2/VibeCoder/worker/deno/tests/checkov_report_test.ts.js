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
 */ import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { CHECKOV_SCAN_ARGS, judgeCheckovRun } from "../lib/checkov_report.ts";
/** Root of the captured Checkov fixtures. */ const FIXTURES = new URL("./fixtures/checkov/", import.meta.url);
/** Absolute path of the CLI entry point the gate and CI invoke. */ const CLI_PATH = new URL("../lib/checkov_report.ts", import.meta.url).pathname;
/** Read a captured Checkov stdout verbatim. */ async function report(name) {
  return await Deno.readTextFile(new URL(`${name}/report.json`, FIXTURES));
}
/** A template reader serving files from one fixture case directory. */ function fixtureTemplates(name) {
  return async (path)=>{
    try {
      return await Deno.readTextFile(new URL(`${name}/${path}`, FIXTURES));
    } catch  {
      return null;
    }
  };
}
/** A template reader that cannot find any template. */ const noTemplates = ()=>Promise.resolve(null);
/** A reader serving `inner`'s templates and recording each path it is asked for. */ function recordingTemplates(inner) {
  const calls = [];
  return {
    calls,
    reader: async (path)=>{
      calls.push(path);
      return await inner(path);
    }
  };
}
/** The reasoned_skip report with its one skipped check's `file_path` replaced. */ async function reasonedSkipAt(filePath) {
  const parsed = JSON.parse(await report("reasoned_skip"));
  parsed.results.skipped_checks[0].file_path = filePath;
  return JSON.stringify(parsed);
}
/** The `- ` problem lines of a verdict report. */ function problemLines(text) {
  return text.split("\n").filter((line)=>line.startsWith("- "));
}
/** A captured report with `edit` applied to its parsed JSON, re-serialised. */ async function editedReport(name, edit) {
  const parsed = JSON.parse(await report(name));
  edit(parsed);
  return JSON.stringify(parsed);
}
/** The reasoned_skip report judged with its one skipped check edited by `edit`. */ async function judgeEditedSkip(edit) {
  const { reader, calls } = recordingTemplates(fixtureTemplates("reasoned_skip"));
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await editedReport("reasoned_skip", (parsed)=>edit(parsed.results.skipped_checks[0])),
    templates: reader
  });
  return {
    verdict,
    calls
  };
}
/** A summary-only Checkov object (no templates found) with `overrides` applied. */ function summaryOnly(overrides = {}) {
  return JSON.stringify({
    passed: 0,
    failed: 0,
    skipped: 0,
    parsing_errors: 0,
    resource_count: 0,
    ...overrides
  });
}
Deno.test("checkov-report - scan arguments match the CI and local gate command", ()=>{
  assertEquals([
    ...CHECKOV_SCAN_ARGS
  ], [
    "-d",
    ".",
    "--framework",
    "cloudformation",
    "-o",
    "json",
    "--skip-download"
  ]);
});
Deno.test("checkov-report - PASSED for a clean scan (exit 0)", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean")
  });
  assertEquals(verdict.status, "PASSED");
  assertStringIncludes(verdict.report, "Checkov passed: 2 passed, 0 skipped");
  assertStringIncludes(verdict.report, "Status: PASSED");
});
Deno.test("checkov-report - PASSED for no CloudFormation templates (exit 0)", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("no_templates"),
    templates: noTemplates
  });
  assertEquals(verdict.status, "PASSED");
  assertStringIncludes(verdict.report, "No CloudFormation templates found");
  assertStringIncludes(verdict.report, "Status: PASSED");
});
Deno.test("checkov-report - PASSED for a skip with a reason in the template (exit 0)", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("reasoned_skip"),
    templates: fixtureTemplates("reasoned_skip")
  });
  assertEquals(verdict.status, "PASSED");
  assertStringIncludes(verdict.report, "1 skipped with a reason");
});
Deno.test("checkov-report - FAILED names the failed check, file and lines (exit 1)", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 1,
    stdout: await report("failed"),
    templates: fixtureTemplates("failed")
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 failed at /template.yaml lines 3-6");
  assertStringIncludes(verdict.report, "Status: FAILED");
});
Deno.test("checkov-report - FAILED for a parse error even though Checkov exits 0", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("parse_error"),
    templates: fixtureTemplates("parse_error")
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "./template.yaml could not be parsed");
  assertStringIncludes(verdict.report, "parse error");
});
Deno.test("checkov-report - FAILED for a skip with no reason (Checkov's placeholder)", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("reasonless_skip"),
    templates: fixtureTemplates("reasonless_skip")
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 skipped without a reason at /template.yaml lines 3-7");
  assertStringIncludes(verdict.report, "No comment provided");
  assertStringIncludes(verdict.report, "no inline");
});
Deno.test("checkov-report - FAILED for a skip set only in Metadata", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("metadata_skip"),
    templates: fixtureTemplates("metadata_skip")
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 skip at /template.yaml");
  assertStringIncludes(verdict.report, "no inline");
  assertStringIncludes(verdict.report, "Metadata");
  assertEquals(problemLines(verdict.report).length, 1);
});
Deno.test("checkov-report - FAILED for exit code 2 even with a clean report", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 2,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean")
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "exited with code 2");
  assertEquals(problemLines(verdict.report).length, 1);
});
Deno.test("checkov-report - FAILED for malformed JSON", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: `{"results":`,
    templates: noTemplates
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "not valid Checkov JSON");
});
Deno.test("checkov-report - FAILED names the JSON parse error, not just the status", async ()=>{
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
    templates: noTemplates
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, `output is not valid Checkov JSON (parse error: ${parseMessage})`);
  assertEquals(problemLines(verdict.report).length, 1);
});
Deno.test("checkov-report - FAILED for empty or whitespace-only stdout", async ()=>{
  for (const stdout of [
    "",
    "  \n\t"
  ]){
    const verdict = await judgeCheckovRun({
      exitCode: 0,
      stdout,
      templates: noTemplates
    });
    assertEquals(verdict.status, "FAILED");
    assertStringIncludes(verdict.report, "stdout is empty");
  }
});
Deno.test("checkov-report - FAILED for JSON that is not a Checkov report", async ()=>{
  for (const stdout of [
    "{}",
    "[]",
    "5",
    `{"results": 5}`
  ]){
    const verdict = await judgeCheckovRun({
      exitCode: 0,
      stdout,
      templates: noTemplates
    });
    assertEquals(verdict.status, "FAILED", `accepted ${stdout}`);
    assertStringIncludes(verdict.report, "not valid Checkov JSON");
  }
});
Deno.test("checkov-report - FAILED when a skip's template cannot be read", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("reasoned_skip"),
    templates: noTemplates
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 skip at /template.yaml");
  assertStringIncludes(verdict.report, "could not be read");
  assertEquals(problemLines(verdict.report).length, 1);
});
Deno.test("checkov-report - FAILED without reading a skip whose file path leaves the scan", async ()=>{
  for (const filePath of [
    "/../template.yaml",
    "/missing/../../template.yaml"
  ]){
    const { reader, calls } = recordingTemplates(fixtureTemplates("reasoned_skip"));
    const verdict = await judgeCheckovRun({
      exitCode: 0,
      stdout: await reasonedSkipAt(filePath),
      templates: reader
    });
    assertEquals(verdict.status, "FAILED", filePath);
    assertStringIncludes(verdict.report, `CKV_AWS_158 skip at ${filePath}`);
    assertStringIncludes(verdict.report, "has a file path outside the scanned directory");
    assertEquals(calls, [], `reader called for ${filePath}`);
    assertEquals(problemLines(verdict.report).length, 1);
  }
});
Deno.test("checkov-report - PASSED for the same skip at its original file path (control)", async ()=>{
  const { reader, calls } = recordingTemplates(fixtureTemplates("reasoned_skip"));
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await reasonedSkipAt("/template.yaml"),
    templates: reader
  });
  assertEquals(verdict.status, "PASSED");
  assertEquals(calls, [
    "template.yaml"
  ]);
});
Deno.test("checkov-report - FAILED for a skip whose file_line_range is not two entries", async ()=>{
  for (const range of [
    [
      3
    ],
    [
      3,
      6,
      9
    ]
  ]){
    const { verdict, calls } = await judgeEditedSkip((entry)=>{
      entry.file_line_range = range;
    });
    assertEquals(verdict.status, "FAILED", JSON.stringify(range));
    assertStringIncludes(verdict.report, "CKV_AWS_158 skip at /template.yaml has no valid file_line_range");
    assertEquals(calls, [], JSON.stringify(range));
    assertEquals(problemLines(verdict.report).length, 1, JSON.stringify(range));
  }
  const control = await judgeEditedSkip((entry)=>{
    entry.file_line_range = [
      3,
      6
    ];
  });
  assertEquals(control.verdict.status, "PASSED");
});
Deno.test("checkov-report - FAILED for a skip whose file_line_range holds non-integers", async ()=>{
  for (const range of [
    [
      3.5,
      6
    ],
    [
      3,
      6.5
    ]
  ]){
    const { verdict, calls } = await judgeEditedSkip((entry)=>{
      entry.file_line_range = range;
    });
    assertEquals(verdict.status, "FAILED", JSON.stringify(range));
    assertStringIncludes(verdict.report, "CKV_AWS_158 skip at /template.yaml has no valid file_line_range");
    assertEquals(calls, [], JSON.stringify(range));
    assertEquals(problemLines(verdict.report).length, 1, JSON.stringify(range));
  }
  const control = await judgeEditedSkip((entry)=>{
    entry.file_line_range = [
      3,
      6
    ];
  });
  assertEquals(control.verdict.status, "PASSED");
});
Deno.test("checkov-report - FAILED for a skip whose file_line_range starts below 1 or ends before it starts", async ()=>{
  for (const range of [
    [
      0,
      6
    ],
    [
      6,
      3
    ]
  ]){
    const { verdict, calls } = await judgeEditedSkip((entry)=>{
      entry.file_line_range = range;
    });
    assertEquals(verdict.status, "FAILED", JSON.stringify(range));
    assertStringIncludes(verdict.report, "CKV_AWS_158 skip at /template.yaml has no valid file_line_range");
    assertEquals(calls, [], JSON.stringify(range));
    assertEquals(problemLines(verdict.report).length, 1, JSON.stringify(range));
  }
  const control = await judgeEditedSkip((entry)=>{
    entry.file_line_range = [
      3,
      6
    ];
  });
  assertEquals(control.verdict.status, "PASSED");
});
Deno.test("checkov-report - FAILED for a skip with no file_line_range", async ()=>{
  const { verdict, calls } = await judgeEditedSkip((entry)=>{
    delete entry.file_line_range;
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 skip at /template.yaml has no valid file_line_range");
  assertEquals(calls, []);
  assertEquals(problemLines(verdict.report).length, 1);
});
Deno.test("checkov-report - FAILED for a skip whose file_path is not a string", async ()=>{
  for (const filePath of [
    42,
    true
  ]){
    const { verdict, calls } = await judgeEditedSkip((entry)=>{
      entry.file_path = filePath;
    });
    assertEquals(verdict.status, "FAILED", String(filePath));
    assertStringIncludes(verdict.report, "CKV_AWS_158 skip at <unknown file> lines 3-7 has no usable file_path");
    assertEquals(calls, [], String(filePath));
    assertEquals(problemLines(verdict.report).length, 1, String(filePath));
  }
});
Deno.test("checkov-report - FAILED for a skip with no file_path", async ()=>{
  const { verdict, calls } = await judgeEditedSkip((entry)=>{
    delete entry.file_path;
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 skip at <unknown file> lines 3-7 has no usable file_path");
  assertEquals(calls, []);
  assertEquals(problemLines(verdict.report).length, 1);
});
Deno.test("checkov-report - FAILED for a skip whose file_path is empty once stripped", async ()=>{
  for (const filePath of [
    "",
    "/",
    "./"
  ]){
    const { verdict, calls } = await judgeEditedSkip((entry)=>{
      entry.file_path = filePath;
    });
    assertEquals(verdict.status, "FAILED", JSON.stringify(filePath));
    assertStringIncludes(verdict.report, "has no usable file_path");
    assertEquals(calls, [], JSON.stringify(filePath));
    assertEquals(problemLines(verdict.report).length, 1, JSON.stringify(filePath));
  }
});
Deno.test("checkov-report - FAILED without reading a skip whose file path is absolute or holds a NUL", async ()=>{
  for (const filePath of [
    "//etc/passwd",
    "\\etc\\passwd",
    "template.yaml\u0000"
  ]){
    const { verdict, calls } = await judgeEditedSkip((entry)=>{
      entry.file_path = filePath;
    });
    assertEquals(verdict.status, "FAILED", JSON.stringify(filePath));
    assertStringIncludes(verdict.report, `CKV_AWS_158 skip at ${filePath} lines 3-7 has a file path outside the scanned directory`);
    assertEquals(calls, [], JSON.stringify(filePath));
    assertEquals(problemLines(verdict.report).length, 1, JSON.stringify(filePath));
  }
});
Deno.test("checkov-report - FAILED for a summary-only object that reports failed checks", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 1,
    stdout: summaryOnly({
      failed: 1
    }),
    templates: noTemplates
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "summary reports 1 failed check(s) with no report body to name them");
  assertEquals(problemLines(verdict.report).length, 1);
  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: summaryOnly(),
    templates: noTemplates
  });
  assertEquals(control.status, "PASSED");
  assertStringIncludes(control.report, "No CloudFormation templates found");
});
Deno.test("checkov-report - FAILED for a summary-only object that reports parsing errors", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: summaryOnly({
      parsing_errors: 1
    }),
    templates: noTemplates
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "summary reports 1 parsing error(s) with no report body to name the files");
  assertEquals(problemLines(verdict.report).length, 1);
  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: summaryOnly(),
    templates: noTemplates
  });
  assertEquals(control.status, "PASSED");
});
Deno.test("checkov-report - FAILED when a results list is not a list", async ()=>{
  for (const key of [
    "failed_checks",
    "skipped_checks",
    "parsing_errors"
  ]){
    const verdict = await judgeCheckovRun({
      exitCode: 0,
      stdout: await editedReport("clean", (parsed)=>{
        parsed.results[key] = "none";
      }),
      templates: fixtureTemplates("clean")
    });
    assertEquals(verdict.status, "FAILED", key);
    assertStringIncludes(verdict.report, `results.${key} is not a list`);
    assertEquals(problemLines(verdict.report).length, 1, key);
  }
  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean")
  });
  assertEquals(control.status, "PASSED");
});
Deno.test("checkov-report - FAILED when a summary count is not a number", async ()=>{
  for (const key of [
    "passed",
    "failed",
    "skipped",
    "parsing_errors"
  ]){
    const verdict = await judgeCheckovRun({
      exitCode: 0,
      stdout: await editedReport("clean", (parsed)=>{
        parsed.summary[key] = "0";
      }),
      templates: fixtureTemplates("clean")
    });
    assertEquals(verdict.status, "FAILED", key);
    assertStringIncludes(verdict.report, `summary.${key} is not a number`);
    assertEquals(problemLines(verdict.report).length, 1, key);
  }
  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean")
  });
  assertEquals(control.status, "PASSED");
});
Deno.test("checkov-report - FAILED when the summary counts failed checks but none are listed", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 1,
    stdout: await editedReport("clean", (parsed)=>{
      parsed.summary.failed = 1;
    }),
    templates: fixtureTemplates("clean")
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "summary reports 1 failed check(s) but none are listed");
  assertEquals(problemLines(verdict.report).length, 1);
  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean")
  });
  assertEquals(control.status, "PASSED");
});
Deno.test("checkov-report - FAILED when the summary counts parse errors but names no file", async ()=>{
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout: await editedReport("clean", (parsed)=>{
      parsed.summary.parsing_errors = 1;
    }),
    templates: fixtureTemplates("clean")
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "summary reports 1 parsing error(s) but names no file");
  assertEquals(problemLines(verdict.report).length, 1);
  const control = await judgeCheckovRun({
    exitCode: 0,
    stdout: await report("clean"),
    templates: fixtureTemplates("clean")
  });
  assertEquals(control.status, "PASSED");
});
Deno.test("checkov-report - multi-framework array is FAILED when one element fails", async ()=>{
  const stdout = JSON.stringify([
    JSON.parse(await report("clean")),
    JSON.parse(await report("failed"))
  ]);
  const verdict = await judgeCheckovRun({
    exitCode: 1,
    stdout,
    templates: fixtureTemplates("failed")
  });
  assertEquals(verdict.status, "FAILED");
  assertStringIncludes(verdict.report, "CKV_AWS_158 failed");
});
Deno.test("checkov-report - multi-framework array of one clean report is PASSED", async ()=>{
  const stdout = JSON.stringify([
    JSON.parse(await report("clean"))
  ]);
  const verdict = await judgeCheckovRun({
    exitCode: 0,
    stdout,
    templates: fixtureTemplates("clean")
  });
  assertEquals(verdict.status, "PASSED");
});
/** Run the CLI entry point, optionally from a fixture case directory. */ async function runCli(args, caseDir) {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--quiet",
      "--no-config",
      "--no-lock",
      "--allow-read",
      CLI_PATH,
      ...args
    ],
    cwd: caseDir === undefined ? undefined : new URL(`${caseDir}/`, FIXTURES).pathname,
    stdin: "null",
    stdout: "piped",
    stderr: "piped"
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr)
  };
}
Deno.test("checkov-report CLI - exit 0 for a clean report", async ()=>{
  const result = await runCli([
    new URL("clean/report.json", FIXTURES).pathname,
    "0"
  ], "clean");
  assertEquals(result.code, 0, result.stderr);
  assertStringIncludes(result.stdout, "Status: PASSED");
});
Deno.test("checkov-report CLI - exit 1 for a failed report", async ()=>{
  const result = await runCli([
    new URL("failed/report.json", FIXTURES).pathname,
    "1"
  ], "failed");
  assertEquals(result.code, 1, result.stderr);
  assertStringIncludes(result.stdout, "CKV_AWS_158 failed");
});
Deno.test("checkov-report CLI - exit 1 for a reasonless skip, template read from the working directory", async ()=>{
  const result = await runCli([
    new URL("reasonless_skip/report.json", FIXTURES).pathname,
    "0"
  ], "reasonless_skip");
  assertEquals(result.code, 1, result.stderr);
  assertStringIncludes(result.stdout, "skipped without a reason");
  assertStringIncludes(result.stdout, "no inline");
  assert(!result.stdout.includes("could not be read"));
});
Deno.test("checkov-report CLI - exit 2 for bad usage", async ()=>{
  const result = await runCli([
    new URL("clean/report.json", FIXTURES).pathname,
    "not-a-number"
  ]);
  assertEquals(result.code, 2);
  assertStringIncludes(result.stderr, "usage:");
});
Deno.test("checkov-report CLI - exit 1 when the report file is missing", async ()=>{
  const missing = new URL("does-not-exist.json", FIXTURES).pathname;
  const result = await runCli([
    missing,
    "0"
  ]);
  assertEquals(result.code, 1);
  assertStringIncludes(result.stderr, "cannot read report");
  assertStringIncludes(result.stderr, missing);
});
Deno.test("checkov-report CLI - an unreadable report prints no verdict to stdout", async ()=>{
  const missing = new URL("does-not-exist.json", FIXTURES).pathname;
  const result = await runCli([
    missing,
    "0"
  ]);
  assertEquals(result.code, 1);
  assertEquals(result.stdout, "", "no verdict should be judged from a report that was not read");
  assertStringIncludes(result.stderr, `cannot read report ${missing}`);
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL3Rlc3RzL2NoZWNrb3ZfcmVwb3J0X3Rlc3QudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUZXN0cyBmb3IgY2hlY2tvdl9yZXBvcnQudHMgKElzc3VlICMzOTcwKS5cbiAqXG4gKiBDb3ZlcnM6XG4gKiAgIC0gdGhlIHNoYXJlZCBDaGVja292IHNjYW4gYXJndW1lbnRzLCBleGFjdGx5IGFzIENJIGFuZCB0aGUgbG9jYWwgZ2F0ZSBydW5cbiAqICAgICB0aGVtO1xuICogICAtIHRoZSByZWFsIENoZWNrb3YgMy4zLjI5IG91dHB1dHMgdW5kZXIgYGZpeHR1cmVzL2NoZWNrb3YvYCwgZWFjaCBqdWRnZWRcbiAqICAgICBQQVNTRUQgb3IgRkFJTEVEIHdpdGggdGhlIHNwZWNpZmljIGNhdXNlIG5hbWVkIGluIHRoZSByZXBvcnQ6IGEgZmFpbGVkXG4gKiAgICAgY2hlY2ssIGEgcGFyc2UgZXJyb3IgKENoZWNrb3YgZXhpdHMgMCksIGEgcmVhc29ubGVzcyBza2lwIChDaGVja292J3NcbiAqICAgICBcIk5vIGNvbW1lbnQgcHJvdmlkZWRcIiBwbGFjZWhvbGRlciksIGEgc2tpcCBzZXQgaW4gYE1ldGFkYXRhYCAoYWNjZXB0ZWRcbiAqICAgICBieSBDaGVja292LCByZWZ1c2VkIGhlcmUpLCBhbmQgdGhlIHN1bW1hcnktb25seSBuby10ZW1wbGF0ZXMgb2JqZWN0O1xuICogICAtIG1hbGZvcm1lZCBpbnB1dCAoYmFkIGV4aXQgY29kZSwgbWFsZm9ybWVkIG9yIGVtcHR5IEpTT04sIG9iamVjdHMgdGhhdFxuICogICAgIGFyZSBub3QgcmVwb3J0cykgcmVmdXNlZCByYXRoZXIgdGhhbiBwYXNzZWQ7XG4gKiAgIC0gbXVsdGktZnJhbWV3b3JrIG91dHB1dCBqdWRnZWQgZWxlbWVudCBieSBlbGVtZW50O1xuICogICAtIHRoZSBDTEkgZW50cnkgcG9pbnQncyBleGl0IGNvZGVzLCBpbmNsdWRpbmcgYmFkIHVzYWdlIGFuZCBhbiB1bnJlYWRhYmxlXG4gKiAgICAgcmVwb3J0LCBydW4gd2l0aCB0aGUgc2Nhbm5lZCBjYXNlIGRpcmVjdG9yeSBhcyB0aGUgd29ya2luZyBkaXJlY3Rvcnkgc29cbiAqICAgICB0ZW1wbGF0ZSByZWFkcyByZXNvbHZlLlxuICpcbiAqIEZpeHR1cmVzIGFyZSBjYXB0dXJlZCBmcm9tIGBicmlkZ2VjcmV3L2NoZWNrb3Y6My4zLjI5YCAoc2VlXG4gKiBgZml4dHVyZXMvY2hlY2tvdi9SRUFETUUubWRgKS4gQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dFxuICogKGJlaGF2aW91ciwgY29sb3VyLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgeyBhc3NlcnQsIGFzc2VydEVxdWFscywgYXNzZXJ0U3RyaW5nSW5jbHVkZXMgfSBmcm9tIFwiQHN0ZC9hc3NlcnRcIjtcbmltcG9ydCB7XG4gIENIRUNLT1ZfU0NBTl9BUkdTLFxuICB0eXBlIENoZWNrb3ZUZW1wbGF0ZVJlYWRlcixcbiAganVkZ2VDaGVja292UnVuLFxufSBmcm9tIFwiLi4vbGliL2NoZWNrb3ZfcmVwb3J0LnRzXCI7XG5cbi8qKiBSb290IG9mIHRoZSBjYXB0dXJlZCBDaGVja292IGZpeHR1cmVzLiAqL1xuY29uc3QgRklYVFVSRVMgPSBuZXcgVVJMKFwiLi9maXh0dXJlcy9jaGVja292L1wiLCBpbXBvcnQubWV0YS51cmwpO1xuXG4vKiogQWJzb2x1dGUgcGF0aCBvZiB0aGUgQ0xJIGVudHJ5IHBvaW50IHRoZSBnYXRlIGFuZCBDSSBpbnZva2UuICovXG5jb25zdCBDTElfUEFUSCA9IG5ldyBVUkwoXCIuLi9saWIvY2hlY2tvdl9yZXBvcnQudHNcIiwgaW1wb3J0Lm1ldGEudXJsKS5wYXRobmFtZTtcblxuLyoqIFJlYWQgYSBjYXB0dXJlZCBDaGVja292IHN0ZG91dCB2ZXJiYXRpbS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlcG9ydChuYW1lOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICByZXR1cm4gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUobmV3IFVSTChgJHtuYW1lfS9yZXBvcnQuanNvbmAsIEZJWFRVUkVTKSk7XG59XG5cbi8qKiBBIHRlbXBsYXRlIHJlYWRlciBzZXJ2aW5nIGZpbGVzIGZyb20gb25lIGZpeHR1cmUgY2FzZSBkaXJlY3RvcnkuICovXG5mdW5jdGlvbiBmaXh0dXJlVGVtcGxhdGVzKG5hbWU6IHN0cmluZyk6IENoZWNrb3ZUZW1wbGF0ZVJlYWRlciB7XG4gIHJldHVybiBhc3luYyAocGF0aCkgPT4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUobmV3IFVSTChgJHtuYW1lfS8ke3BhdGh9YCwgRklYVFVSRVMpKTtcbiAgICB9IGNhdGNoIHtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cbiAgfTtcbn1cblxuLyoqIEEgdGVtcGxhdGUgcmVhZGVyIHRoYXQgY2Fubm90IGZpbmQgYW55IHRlbXBsYXRlLiAqL1xuY29uc3Qgbm9UZW1wbGF0ZXM6IENoZWNrb3ZUZW1wbGF0ZVJlYWRlciA9ICgpID0+IFByb21pc2UucmVzb2x2ZShudWxsKTtcblxuLyoqIEEgcmVhZGVyIHNlcnZpbmcgYGlubmVyYCdzIHRlbXBsYXRlcyBhbmQgcmVjb3JkaW5nIGVhY2ggcGF0aCBpdCBpcyBhc2tlZCBmb3IuICovXG5mdW5jdGlvbiByZWNvcmRpbmdUZW1wbGF0ZXMoaW5uZXI6IENoZWNrb3ZUZW1wbGF0ZVJlYWRlcik6IHtcbiAgcmVhZGVyOiBDaGVja292VGVtcGxhdGVSZWFkZXI7XG4gIGNhbGxzOiBzdHJpbmdbXTtcbn0ge1xuICBjb25zdCBjYWxsczogc3RyaW5nW10gPSBbXTtcbiAgcmV0dXJuIHtcbiAgICBjYWxscyxcbiAgICByZWFkZXI6IGFzeW5jIChwYXRoKSA9PiB7XG4gICAgICBjYWxscy5wdXNoKHBhdGgpO1xuICAgICAgcmV0dXJuIGF3YWl0IGlubmVyKHBhdGgpO1xuICAgIH0sXG4gIH07XG59XG5cbi8qKiBUaGUgcmVhc29uZWRfc2tpcCByZXBvcnQgd2l0aCBpdHMgb25lIHNraXBwZWQgY2hlY2sncyBgZmlsZV9wYXRoYCByZXBsYWNlZC4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYXNvbmVkU2tpcEF0KGZpbGVQYXRoOiBzdHJpbmcpOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGF3YWl0IHJlcG9ydChcInJlYXNvbmVkX3NraXBcIikpO1xuICBwYXJzZWQucmVzdWx0cy5za2lwcGVkX2NoZWNrc1swXS5maWxlX3BhdGggPSBmaWxlUGF0aDtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHBhcnNlZCk7XG59XG5cbi8qKiBUaGUgYC0gYCBwcm9ibGVtIGxpbmVzIG9mIGEgdmVyZGljdCByZXBvcnQuICovXG5mdW5jdGlvbiBwcm9ibGVtTGluZXModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICByZXR1cm4gdGV4dC5zcGxpdChcIlxcblwiKS5maWx0ZXIoKGxpbmUpID0+IGxpbmUuc3RhcnRzV2l0aChcIi0gXCIpKTtcbn1cblxuLyoqIEEgcGFyc2VkIEpTT04gdmFsdWUsIHR5cGVkIGFzIGBKU09OLnBhcnNlYCByZXR1cm5zIGl0LCBmb3IgaW4tcGxhY2UgZWRpdHMuICovXG50eXBlIFBhcnNlZEpzb24gPSBSZXR1cm5UeXBlPHR5cGVvZiBKU09OLnBhcnNlPjtcblxuLyoqIEEgY2FwdHVyZWQgcmVwb3J0IHdpdGggYGVkaXRgIGFwcGxpZWQgdG8gaXRzIHBhcnNlZCBKU09OLCByZS1zZXJpYWxpc2VkLiAqL1xuYXN5bmMgZnVuY3Rpb24gZWRpdGVkUmVwb3J0KFxuICBuYW1lOiBzdHJpbmcsXG4gIGVkaXQ6IChwYXJzZWQ6IFBhcnNlZEpzb24pID0+IHZvaWQsXG4pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBwYXJzZWQgPSBKU09OLnBhcnNlKGF3YWl0IHJlcG9ydChuYW1lKSk7XG4gIGVkaXQocGFyc2VkKTtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHBhcnNlZCk7XG59XG5cbi8qKiBUaGUgcmVhc29uZWRfc2tpcCByZXBvcnQganVkZ2VkIHdpdGggaXRzIG9uZSBza2lwcGVkIGNoZWNrIGVkaXRlZCBieSBgZWRpdGAuICovXG5hc3luYyBmdW5jdGlvbiBqdWRnZUVkaXRlZFNraXAoZWRpdDogKGVudHJ5OiBQYXJzZWRKc29uKSA9PiB2b2lkKTogUHJvbWlzZTx7XG4gIHZlcmRpY3Q6IEF3YWl0ZWQ8UmV0dXJuVHlwZTx0eXBlb2YganVkZ2VDaGVja292UnVuPj47XG4gIGNhbGxzOiBzdHJpbmdbXTtcbn0+IHtcbiAgY29uc3QgeyByZWFkZXIsIGNhbGxzIH0gPSByZWNvcmRpbmdUZW1wbGF0ZXMoXG4gICAgZml4dHVyZVRlbXBsYXRlcyhcInJlYXNvbmVkX3NraXBcIiksXG4gICk7XG4gIGNvbnN0IHZlcmRpY3QgPSBhd2FpdCBqdWRnZUNoZWNrb3ZSdW4oe1xuICAgIGV4aXRDb2RlOiAwLFxuICAgIHN0ZG91dDogYXdhaXQgZWRpdGVkUmVwb3J0KFxuICAgICAgXCJyZWFzb25lZF9za2lwXCIsXG4gICAgICAocGFyc2VkKSA9PiBlZGl0KHBhcnNlZC5yZXN1bHRzLnNraXBwZWRfY2hlY2tzWzBdKSxcbiAgICApLFxuICAgIHRlbXBsYXRlczogcmVhZGVyLFxuICB9KTtcbiAgcmV0dXJuIHsgdmVyZGljdCwgY2FsbHMgfTtcbn1cblxuLyoqIEEgc3VtbWFyeS1vbmx5IENoZWNrb3Ygb2JqZWN0IChubyB0ZW1wbGF0ZXMgZm91bmQpIHdpdGggYG92ZXJyaWRlc2AgYXBwbGllZC4gKi9cbmZ1bmN0aW9uIHN1bW1hcnlPbmx5KG92ZXJyaWRlczogUmVjb3JkPHN0cmluZywgbnVtYmVyPiA9IHt9KTogc3RyaW5nIHtcbiAgcmV0dXJuIEpTT04uc3RyaW5naWZ5KHtcbiAgICBwYXNzZWQ6IDAsXG4gICAgZmFpbGVkOiAwLFxuICAgIHNraXBwZWQ6IDAsXG4gICAgcGFyc2luZ19lcnJvcnM6IDAsXG4gICAgcmVzb3VyY2VfY291bnQ6IDAsXG4gICAgLi4ub3ZlcnJpZGVzLFxuICB9KTtcbn1cblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgLSBzY2FuIGFyZ3VtZW50cyBtYXRjaCB0aGUgQ0kgYW5kIGxvY2FsIGdhdGUgY29tbWFuZFwiLCAoKSA9PiB7XG4gIGFzc2VydEVxdWFscyhbLi4uQ0hFQ0tPVl9TQ0FOX0FSR1NdLCBbXG4gICAgXCItZFwiLFxuICAgIFwiLlwiLFxuICAgIFwiLS1mcmFtZXdvcmtcIixcbiAgICBcImNsb3VkZm9ybWF0aW9uXCIsXG4gICAgXCItb1wiLFxuICAgIFwianNvblwiLFxuICAgIFwiLS1za2lwLWRvd25sb2FkXCIsXG4gIF0pO1xufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gUEFTU0VEIGZvciBhIGNsZWFuIHNjYW4gKGV4aXQgMClcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IGF3YWl0IHJlcG9ydChcImNsZWFuXCIpLFxuICAgIHRlbXBsYXRlczogZml4dHVyZVRlbXBsYXRlcyhcImNsZWFuXCIpLFxuICB9KTtcbiAgYXNzZXJ0RXF1YWxzKHZlcmRpY3Quc3RhdHVzLCBcIlBBU1NFRFwiKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXModmVyZGljdC5yZXBvcnQsIFwiQ2hlY2tvdiBwYXNzZWQ6IDIgcGFzc2VkLCAwIHNraXBwZWRcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKHZlcmRpY3QucmVwb3J0LCBcIlN0YXR1czogUEFTU0VEXCIpO1xufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gUEFTU0VEIGZvciBubyBDbG91ZEZvcm1hdGlvbiB0ZW1wbGF0ZXMgKGV4aXQgMClcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IGF3YWl0IHJlcG9ydChcIm5vX3RlbXBsYXRlc1wiKSxcbiAgICB0ZW1wbGF0ZXM6IG5vVGVtcGxhdGVzLFxuICB9KTtcbiAgYXNzZXJ0RXF1YWxzKHZlcmRpY3Quc3RhdHVzLCBcIlBBU1NFRFwiKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXModmVyZGljdC5yZXBvcnQsIFwiTm8gQ2xvdWRGb3JtYXRpb24gdGVtcGxhdGVzIGZvdW5kXCIpO1xuICBhc3NlcnRTdHJpbmdJbmNsdWRlcyh2ZXJkaWN0LnJlcG9ydCwgXCJTdGF0dXM6IFBBU1NFRFwiKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCAtIFBBU1NFRCBmb3IgYSBza2lwIHdpdGggYSByZWFzb24gaW4gdGhlIHRlbXBsYXRlIChleGl0IDApXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgZXhpdENvZGU6IDAsXG4gICAgc3Rkb3V0OiBhd2FpdCByZXBvcnQoXCJyZWFzb25lZF9za2lwXCIpLFxuICAgIHRlbXBsYXRlczogZml4dHVyZVRlbXBsYXRlcyhcInJlYXNvbmVkX3NraXBcIiksXG4gIH0pO1xuICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiUEFTU0VEXCIpO1xuICBhc3NlcnRTdHJpbmdJbmNsdWRlcyh2ZXJkaWN0LnJlcG9ydCwgXCIxIHNraXBwZWQgd2l0aCBhIHJlYXNvblwiKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCAtIEZBSUxFRCBuYW1lcyB0aGUgZmFpbGVkIGNoZWNrLCBmaWxlIGFuZCBsaW5lcyAoZXhpdCAxKVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHZlcmRpY3QgPSBhd2FpdCBqdWRnZUNoZWNrb3ZSdW4oe1xuICAgIGV4aXRDb2RlOiAxLFxuICAgIHN0ZG91dDogYXdhaXQgcmVwb3J0KFwiZmFpbGVkXCIpLFxuICAgIHRlbXBsYXRlczogZml4dHVyZVRlbXBsYXRlcyhcImZhaWxlZFwiKSxcbiAgfSk7XG4gIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKFxuICAgIHZlcmRpY3QucmVwb3J0LFxuICAgIFwiQ0tWX0FXU18xNTggZmFpbGVkIGF0IC90ZW1wbGF0ZS55YW1sIGxpbmVzIDMtNlwiLFxuICApO1xuICBhc3NlcnRTdHJpbmdJbmNsdWRlcyh2ZXJkaWN0LnJlcG9ydCwgXCJTdGF0dXM6IEZBSUxFRFwiKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCAtIEZBSUxFRCBmb3IgYSBwYXJzZSBlcnJvciBldmVuIHRob3VnaCBDaGVja292IGV4aXRzIDBcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IGF3YWl0IHJlcG9ydChcInBhcnNlX2Vycm9yXCIpLFxuICAgIHRlbXBsYXRlczogZml4dHVyZVRlbXBsYXRlcyhcInBhcnNlX2Vycm9yXCIpLFxuICB9KTtcbiAgYXNzZXJ0RXF1YWxzKHZlcmRpY3Quc3RhdHVzLCBcIkZBSUxFRFwiKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXModmVyZGljdC5yZXBvcnQsIFwiLi90ZW1wbGF0ZS55YW1sIGNvdWxkIG5vdCBiZSBwYXJzZWRcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKHZlcmRpY3QucmVwb3J0LCBcInBhcnNlIGVycm9yXCIpO1xufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIGZvciBhIHNraXAgd2l0aCBubyByZWFzb24gKENoZWNrb3YncyBwbGFjZWhvbGRlcilcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IGF3YWl0IHJlcG9ydChcInJlYXNvbmxlc3Nfc2tpcFwiKSxcbiAgICB0ZW1wbGF0ZXM6IGZpeHR1cmVUZW1wbGF0ZXMoXCJyZWFzb25sZXNzX3NraXBcIiksXG4gIH0pO1xuICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiRkFJTEVEXCIpO1xuICBhc3NlcnRTdHJpbmdJbmNsdWRlcyhcbiAgICB2ZXJkaWN0LnJlcG9ydCxcbiAgICBcIkNLVl9BV1NfMTU4IHNraXBwZWQgd2l0aG91dCBhIHJlYXNvbiBhdCAvdGVtcGxhdGUueWFtbCBsaW5lcyAzLTdcIixcbiAgKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXModmVyZGljdC5yZXBvcnQsIFwiTm8gY29tbWVudCBwcm92aWRlZFwiKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXModmVyZGljdC5yZXBvcnQsIFwibm8gaW5saW5lXCIpO1xufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIGZvciBhIHNraXAgc2V0IG9ubHkgaW4gTWV0YWRhdGFcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IGF3YWl0IHJlcG9ydChcIm1ldGFkYXRhX3NraXBcIiksXG4gICAgdGVtcGxhdGVzOiBmaXh0dXJlVGVtcGxhdGVzKFwibWV0YWRhdGFfc2tpcFwiKSxcbiAgfSk7XG4gIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKHZlcmRpY3QucmVwb3J0LCBcIkNLVl9BV1NfMTU4IHNraXAgYXQgL3RlbXBsYXRlLnlhbWxcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKHZlcmRpY3QucmVwb3J0LCBcIm5vIGlubGluZVwiKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXModmVyZGljdC5yZXBvcnQsIFwiTWV0YWRhdGFcIik7XG4gIGFzc2VydEVxdWFscyhwcm9ibGVtTGluZXModmVyZGljdC5yZXBvcnQpLmxlbmd0aCwgMSk7XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgLSBGQUlMRUQgZm9yIGV4aXQgY29kZSAyIGV2ZW4gd2l0aCBhIGNsZWFuIHJlcG9ydFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHZlcmRpY3QgPSBhd2FpdCBqdWRnZUNoZWNrb3ZSdW4oe1xuICAgIGV4aXRDb2RlOiAyLFxuICAgIHN0ZG91dDogYXdhaXQgcmVwb3J0KFwiY2xlYW5cIiksXG4gICAgdGVtcGxhdGVzOiBmaXh0dXJlVGVtcGxhdGVzKFwiY2xlYW5cIiksXG4gIH0pO1xuICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiRkFJTEVEXCIpO1xuICBhc3NlcnRTdHJpbmdJbmNsdWRlcyh2ZXJkaWN0LnJlcG9ydCwgXCJleGl0ZWQgd2l0aCBjb2RlIDJcIik7XG4gIGFzc2VydEVxdWFscyhwcm9ibGVtTGluZXModmVyZGljdC5yZXBvcnQpLmxlbmd0aCwgMSk7XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgLSBGQUlMRUQgZm9yIG1hbGZvcm1lZCBKU09OXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgZXhpdENvZGU6IDAsXG4gICAgc3Rkb3V0OiBge1wicmVzdWx0c1wiOmAsXG4gICAgdGVtcGxhdGVzOiBub1RlbXBsYXRlcyxcbiAgfSk7XG4gIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKHZlcmRpY3QucmVwb3J0LCBcIm5vdCB2YWxpZCBDaGVja292IEpTT05cIik7XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgLSBGQUlMRUQgbmFtZXMgdGhlIEpTT04gcGFyc2UgZXJyb3IsIG5vdCBqdXN0IHRoZSBzdGF0dXNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBzdGRvdXQgPSBge1wicmVzdWx0c1wiOmA7XG4gIGxldCBwYXJzZU1lc3NhZ2UgPSBcIlwiO1xuICB0cnkge1xuICAgIEpTT04ucGFyc2Uoc3Rkb3V0KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBwYXJzZU1lc3NhZ2UgPSBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcik7XG4gIH1cbiAgYXNzZXJ0KHBhcnNlTWVzc2FnZSAhPT0gXCJcIiwgXCJKU09OLnBhcnNlIHNob3VsZCB0aHJvdyBvbiB0aGUgdHJ1bmNhdGVkIGlucHV0XCIpO1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQsXG4gICAgdGVtcGxhdGVzOiBub1RlbXBsYXRlcyxcbiAgfSk7XG4gIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKFxuICAgIHZlcmRpY3QucmVwb3J0LFxuICAgIGBvdXRwdXQgaXMgbm90IHZhbGlkIENoZWNrb3YgSlNPTiAocGFyc2UgZXJyb3I6ICR7cGFyc2VNZXNzYWdlfSlgLFxuICApO1xuICBhc3NlcnRFcXVhbHMocHJvYmxlbUxpbmVzKHZlcmRpY3QucmVwb3J0KS5sZW5ndGgsIDEpO1xufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIGZvciBlbXB0eSBvciB3aGl0ZXNwYWNlLW9ubHkgc3Rkb3V0XCIsIGFzeW5jICgpID0+IHtcbiAgZm9yIChjb25zdCBzdGRvdXQgb2YgW1wiXCIsIFwiICBcXG5cXHRcIl0pIHtcbiAgICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICAgIGV4aXRDb2RlOiAwLFxuICAgICAgc3Rkb3V0LFxuICAgICAgdGVtcGxhdGVzOiBub1RlbXBsYXRlcyxcbiAgICB9KTtcbiAgICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiRkFJTEVEXCIpO1xuICAgIGFzc2VydFN0cmluZ0luY2x1ZGVzKHZlcmRpY3QucmVwb3J0LCBcInN0ZG91dCBpcyBlbXB0eVwiKTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIGZvciBKU09OIHRoYXQgaXMgbm90IGEgQ2hlY2tvdiByZXBvcnRcIiwgYXN5bmMgKCkgPT4ge1xuICBmb3IgKGNvbnN0IHN0ZG91dCBvZiBbXCJ7fVwiLCBcIltdXCIsIFwiNVwiLCBge1wicmVzdWx0c1wiOiA1fWBdKSB7XG4gICAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgICBleGl0Q29kZTogMCxcbiAgICAgIHN0ZG91dCxcbiAgICAgIHRlbXBsYXRlczogbm9UZW1wbGF0ZXMsXG4gICAgfSk7XG4gICAgYXNzZXJ0RXF1YWxzKHZlcmRpY3Quc3RhdHVzLCBcIkZBSUxFRFwiLCBgYWNjZXB0ZWQgJHtzdGRvdXR9YCk7XG4gICAgYXNzZXJ0U3RyaW5nSW5jbHVkZXModmVyZGljdC5yZXBvcnQsIFwibm90IHZhbGlkIENoZWNrb3YgSlNPTlwiKTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIHdoZW4gYSBza2lwJ3MgdGVtcGxhdGUgY2Fubm90IGJlIHJlYWRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IGF3YWl0IHJlcG9ydChcInJlYXNvbmVkX3NraXBcIiksXG4gICAgdGVtcGxhdGVzOiBub1RlbXBsYXRlcyxcbiAgfSk7XG4gIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKHZlcmRpY3QucmVwb3J0LCBcIkNLVl9BV1NfMTU4IHNraXAgYXQgL3RlbXBsYXRlLnlhbWxcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKHZlcmRpY3QucmVwb3J0LCBcImNvdWxkIG5vdCBiZSByZWFkXCIpO1xuICBhc3NlcnRFcXVhbHMocHJvYmxlbUxpbmVzKHZlcmRpY3QucmVwb3J0KS5sZW5ndGgsIDEpO1xufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIHdpdGhvdXQgcmVhZGluZyBhIHNraXAgd2hvc2UgZmlsZSBwYXRoIGxlYXZlcyB0aGUgc2NhblwiLCBhc3luYyAoKSA9PiB7XG4gIGZvciAoXG4gICAgY29uc3QgZmlsZVBhdGggb2YgW1wiLy4uL3RlbXBsYXRlLnlhbWxcIiwgXCIvbWlzc2luZy8uLi8uLi90ZW1wbGF0ZS55YW1sXCJdXG4gICkge1xuICAgIGNvbnN0IHsgcmVhZGVyLCBjYWxscyB9ID0gcmVjb3JkaW5nVGVtcGxhdGVzKFxuICAgICAgZml4dHVyZVRlbXBsYXRlcyhcInJlYXNvbmVkX3NraXBcIiksXG4gICAgKTtcbiAgICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICAgIGV4aXRDb2RlOiAwLFxuICAgICAgc3Rkb3V0OiBhd2FpdCByZWFzb25lZFNraXBBdChmaWxlUGF0aCksXG4gICAgICB0ZW1wbGF0ZXM6IHJlYWRlcixcbiAgICB9KTtcbiAgICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiRkFJTEVEXCIsIGZpbGVQYXRoKTtcbiAgICBhc3NlcnRTdHJpbmdJbmNsdWRlcyh2ZXJkaWN0LnJlcG9ydCwgYENLVl9BV1NfMTU4IHNraXAgYXQgJHtmaWxlUGF0aH1gKTtcbiAgICBhc3NlcnRTdHJpbmdJbmNsdWRlcyhcbiAgICAgIHZlcmRpY3QucmVwb3J0LFxuICAgICAgXCJoYXMgYSBmaWxlIHBhdGggb3V0c2lkZSB0aGUgc2Nhbm5lZCBkaXJlY3RvcnlcIixcbiAgICApO1xuICAgIGFzc2VydEVxdWFscyhjYWxscywgW10sIGByZWFkZXIgY2FsbGVkIGZvciAke2ZpbGVQYXRofWApO1xuICAgIGFzc2VydEVxdWFscyhwcm9ibGVtTGluZXModmVyZGljdC5yZXBvcnQpLmxlbmd0aCwgMSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCAtIFBBU1NFRCBmb3IgdGhlIHNhbWUgc2tpcCBhdCBpdHMgb3JpZ2luYWwgZmlsZSBwYXRoIChjb250cm9sKVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcmVhZGVyLCBjYWxscyB9ID0gcmVjb3JkaW5nVGVtcGxhdGVzKFxuICAgIGZpeHR1cmVUZW1wbGF0ZXMoXCJyZWFzb25lZF9za2lwXCIpLFxuICApO1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IGF3YWl0IHJlYXNvbmVkU2tpcEF0KFwiL3RlbXBsYXRlLnlhbWxcIiksXG4gICAgdGVtcGxhdGVzOiByZWFkZXIsXG4gIH0pO1xuICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiUEFTU0VEXCIpO1xuICBhc3NlcnRFcXVhbHMoY2FsbHMsIFtcInRlbXBsYXRlLnlhbWxcIl0pO1xufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIGZvciBhIHNraXAgd2hvc2UgZmlsZV9saW5lX3JhbmdlIGlzIG5vdCB0d28gZW50cmllc1wiLCBhc3luYyAoKSA9PiB7XG4gIGZvciAoY29uc3QgcmFuZ2Ugb2YgW1szXSwgWzMsIDYsIDldXSkge1xuICAgIGNvbnN0IHsgdmVyZGljdCwgY2FsbHMgfSA9IGF3YWl0IGp1ZGdlRWRpdGVkU2tpcCgoZW50cnkpID0+IHtcbiAgICAgIGVudHJ5LmZpbGVfbGluZV9yYW5nZSA9IHJhbmdlO1xuICAgIH0pO1xuICAgIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIiwgSlNPTi5zdHJpbmdpZnkocmFuZ2UpKTtcbiAgICBhc3NlcnRTdHJpbmdJbmNsdWRlcyhcbiAgICAgIHZlcmRpY3QucmVwb3J0LFxuICAgICAgXCJDS1ZfQVdTXzE1OCBza2lwIGF0IC90ZW1wbGF0ZS55YW1sIGhhcyBubyB2YWxpZCBmaWxlX2xpbmVfcmFuZ2VcIixcbiAgICApO1xuICAgIGFzc2VydEVxdWFscyhjYWxscywgW10sIEpTT04uc3RyaW5naWZ5KHJhbmdlKSk7XG4gICAgYXNzZXJ0RXF1YWxzKHByb2JsZW1MaW5lcyh2ZXJkaWN0LnJlcG9ydCkubGVuZ3RoLCAxLCBKU09OLnN0cmluZ2lmeShyYW5nZSkpO1xuICB9XG4gIGNvbnN0IGNvbnRyb2wgPSBhd2FpdCBqdWRnZUVkaXRlZFNraXAoKGVudHJ5KSA9PiB7XG4gICAgZW50cnkuZmlsZV9saW5lX3JhbmdlID0gWzMsIDZdO1xuICB9KTtcbiAgYXNzZXJ0RXF1YWxzKGNvbnRyb2wudmVyZGljdC5zdGF0dXMsIFwiUEFTU0VEXCIpO1xufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIGZvciBhIHNraXAgd2hvc2UgZmlsZV9saW5lX3JhbmdlIGhvbGRzIG5vbi1pbnRlZ2Vyc1wiLCBhc3luYyAoKSA9PiB7XG4gIGZvciAoY29uc3QgcmFuZ2Ugb2YgW1szLjUsIDZdLCBbMywgNi41XV0pIHtcbiAgICBjb25zdCB7IHZlcmRpY3QsIGNhbGxzIH0gPSBhd2FpdCBqdWRnZUVkaXRlZFNraXAoKGVudHJ5KSA9PiB7XG4gICAgICBlbnRyeS5maWxlX2xpbmVfcmFuZ2UgPSByYW5nZTtcbiAgICB9KTtcbiAgICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiRkFJTEVEXCIsIEpTT04uc3RyaW5naWZ5KHJhbmdlKSk7XG4gICAgYXNzZXJ0U3RyaW5nSW5jbHVkZXMoXG4gICAgICB2ZXJkaWN0LnJlcG9ydCxcbiAgICAgIFwiQ0tWX0FXU18xNTggc2tpcCBhdCAvdGVtcGxhdGUueWFtbCBoYXMgbm8gdmFsaWQgZmlsZV9saW5lX3JhbmdlXCIsXG4gICAgKTtcbiAgICBhc3NlcnRFcXVhbHMoY2FsbHMsIFtdLCBKU09OLnN0cmluZ2lmeShyYW5nZSkpO1xuICAgIGFzc2VydEVxdWFscyhwcm9ibGVtTGluZXModmVyZGljdC5yZXBvcnQpLmxlbmd0aCwgMSwgSlNPTi5zdHJpbmdpZnkocmFuZ2UpKTtcbiAgfVxuICBjb25zdCBjb250cm9sID0gYXdhaXQganVkZ2VFZGl0ZWRTa2lwKChlbnRyeSkgPT4ge1xuICAgIGVudHJ5LmZpbGVfbGluZV9yYW5nZSA9IFszLCA2XTtcbiAgfSk7XG4gIGFzc2VydEVxdWFscyhjb250cm9sLnZlcmRpY3Quc3RhdHVzLCBcIlBBU1NFRFwiKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCAtIEZBSUxFRCBmb3IgYSBza2lwIHdob3NlIGZpbGVfbGluZV9yYW5nZSBzdGFydHMgYmVsb3cgMSBvciBlbmRzIGJlZm9yZSBpdCBzdGFydHNcIiwgYXN5bmMgKCkgPT4ge1xuICBmb3IgKGNvbnN0IHJhbmdlIG9mIFtbMCwgNl0sIFs2LCAzXV0pIHtcbiAgICBjb25zdCB7IHZlcmRpY3QsIGNhbGxzIH0gPSBhd2FpdCBqdWRnZUVkaXRlZFNraXAoKGVudHJ5KSA9PiB7XG4gICAgICBlbnRyeS5maWxlX2xpbmVfcmFuZ2UgPSByYW5nZTtcbiAgICB9KTtcbiAgICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiRkFJTEVEXCIsIEpTT04uc3RyaW5naWZ5KHJhbmdlKSk7XG4gICAgYXNzZXJ0U3RyaW5nSW5jbHVkZXMoXG4gICAgICB2ZXJkaWN0LnJlcG9ydCxcbiAgICAgIFwiQ0tWX0FXU18xNTggc2tpcCBhdCAvdGVtcGxhdGUueWFtbCBoYXMgbm8gdmFsaWQgZmlsZV9saW5lX3JhbmdlXCIsXG4gICAgKTtcbiAgICBhc3NlcnRFcXVhbHMoY2FsbHMsIFtdLCBKU09OLnN0cmluZ2lmeShyYW5nZSkpO1xuICAgIGFzc2VydEVxdWFscyhwcm9ibGVtTGluZXModmVyZGljdC5yZXBvcnQpLmxlbmd0aCwgMSwgSlNPTi5zdHJpbmdpZnkocmFuZ2UpKTtcbiAgfVxuICBjb25zdCBjb250cm9sID0gYXdhaXQganVkZ2VFZGl0ZWRTa2lwKChlbnRyeSkgPT4ge1xuICAgIGVudHJ5LmZpbGVfbGluZV9yYW5nZSA9IFszLCA2XTtcbiAgfSk7XG4gIGFzc2VydEVxdWFscyhjb250cm9sLnZlcmRpY3Quc3RhdHVzLCBcIlBBU1NFRFwiKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCAtIEZBSUxFRCBmb3IgYSBza2lwIHdpdGggbm8gZmlsZV9saW5lX3JhbmdlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyB2ZXJkaWN0LCBjYWxscyB9ID0gYXdhaXQganVkZ2VFZGl0ZWRTa2lwKChlbnRyeSkgPT4ge1xuICAgIGRlbGV0ZSBlbnRyeS5maWxlX2xpbmVfcmFuZ2U7XG4gIH0pO1xuICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiRkFJTEVEXCIpO1xuICBhc3NlcnRTdHJpbmdJbmNsdWRlcyhcbiAgICB2ZXJkaWN0LnJlcG9ydCxcbiAgICBcIkNLVl9BV1NfMTU4IHNraXAgYXQgL3RlbXBsYXRlLnlhbWwgaGFzIG5vIHZhbGlkIGZpbGVfbGluZV9yYW5nZVwiLFxuICApO1xuICBhc3NlcnRFcXVhbHMoY2FsbHMsIFtdKTtcbiAgYXNzZXJ0RXF1YWxzKHByb2JsZW1MaW5lcyh2ZXJkaWN0LnJlcG9ydCkubGVuZ3RoLCAxKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCAtIEZBSUxFRCBmb3IgYSBza2lwIHdob3NlIGZpbGVfcGF0aCBpcyBub3QgYSBzdHJpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICBmb3IgKGNvbnN0IGZpbGVQYXRoIG9mIFs0MiwgdHJ1ZV0pIHtcbiAgICBjb25zdCB7IHZlcmRpY3QsIGNhbGxzIH0gPSBhd2FpdCBqdWRnZUVkaXRlZFNraXAoKGVudHJ5KSA9PiB7XG4gICAgICBlbnRyeS5maWxlX3BhdGggPSBmaWxlUGF0aDtcbiAgICB9KTtcbiAgICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiRkFJTEVEXCIsIFN0cmluZyhmaWxlUGF0aCkpO1xuICAgIGFzc2VydFN0cmluZ0luY2x1ZGVzKFxuICAgICAgdmVyZGljdC5yZXBvcnQsXG4gICAgICBcIkNLVl9BV1NfMTU4IHNraXAgYXQgPHVua25vd24gZmlsZT4gbGluZXMgMy03IGhhcyBubyB1c2FibGUgZmlsZV9wYXRoXCIsXG4gICAgKTtcbiAgICBhc3NlcnRFcXVhbHMoY2FsbHMsIFtdLCBTdHJpbmcoZmlsZVBhdGgpKTtcbiAgICBhc3NlcnRFcXVhbHMocHJvYmxlbUxpbmVzKHZlcmRpY3QucmVwb3J0KS5sZW5ndGgsIDEsIFN0cmluZyhmaWxlUGF0aCkpO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgLSBGQUlMRUQgZm9yIGEgc2tpcCB3aXRoIG5vIGZpbGVfcGF0aFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgdmVyZGljdCwgY2FsbHMgfSA9IGF3YWl0IGp1ZGdlRWRpdGVkU2tpcCgoZW50cnkpID0+IHtcbiAgICBkZWxldGUgZW50cnkuZmlsZV9wYXRoO1xuICB9KTtcbiAgYXNzZXJ0RXF1YWxzKHZlcmRpY3Quc3RhdHVzLCBcIkZBSUxFRFwiKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXMoXG4gICAgdmVyZGljdC5yZXBvcnQsXG4gICAgXCJDS1ZfQVdTXzE1OCBza2lwIGF0IDx1bmtub3duIGZpbGU+IGxpbmVzIDMtNyBoYXMgbm8gdXNhYmxlIGZpbGVfcGF0aFwiLFxuICApO1xuICBhc3NlcnRFcXVhbHMoY2FsbHMsIFtdKTtcbiAgYXNzZXJ0RXF1YWxzKHByb2JsZW1MaW5lcyh2ZXJkaWN0LnJlcG9ydCkubGVuZ3RoLCAxKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCAtIEZBSUxFRCBmb3IgYSBza2lwIHdob3NlIGZpbGVfcGF0aCBpcyBlbXB0eSBvbmNlIHN0cmlwcGVkXCIsIGFzeW5jICgpID0+IHtcbiAgZm9yIChjb25zdCBmaWxlUGF0aCBvZiBbXCJcIiwgXCIvXCIsIFwiLi9cIl0pIHtcbiAgICBjb25zdCB7IHZlcmRpY3QsIGNhbGxzIH0gPSBhd2FpdCBqdWRnZUVkaXRlZFNraXAoKGVudHJ5KSA9PiB7XG4gICAgICBlbnRyeS5maWxlX3BhdGggPSBmaWxlUGF0aDtcbiAgICB9KTtcbiAgICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiRkFJTEVEXCIsIEpTT04uc3RyaW5naWZ5KGZpbGVQYXRoKSk7XG4gICAgYXNzZXJ0U3RyaW5nSW5jbHVkZXModmVyZGljdC5yZXBvcnQsIFwiaGFzIG5vIHVzYWJsZSBmaWxlX3BhdGhcIik7XG4gICAgYXNzZXJ0RXF1YWxzKGNhbGxzLCBbXSwgSlNPTi5zdHJpbmdpZnkoZmlsZVBhdGgpKTtcbiAgICBhc3NlcnRFcXVhbHMoXG4gICAgICBwcm9ibGVtTGluZXModmVyZGljdC5yZXBvcnQpLmxlbmd0aCxcbiAgICAgIDEsXG4gICAgICBKU09OLnN0cmluZ2lmeShmaWxlUGF0aCksXG4gICAgKTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIHdpdGhvdXQgcmVhZGluZyBhIHNraXAgd2hvc2UgZmlsZSBwYXRoIGlzIGFic29sdXRlIG9yIGhvbGRzIGEgTlVMXCIsIGFzeW5jICgpID0+IHtcbiAgZm9yIChcbiAgICBjb25zdCBmaWxlUGF0aCBvZiBbXCIvL2V0Yy9wYXNzd2RcIiwgXCJcXFxcZXRjXFxcXHBhc3N3ZFwiLCBcInRlbXBsYXRlLnlhbWxcXHUwMDAwXCJdXG4gICkge1xuICAgIGNvbnN0IHsgdmVyZGljdCwgY2FsbHMgfSA9IGF3YWl0IGp1ZGdlRWRpdGVkU2tpcCgoZW50cnkpID0+IHtcbiAgICAgIGVudHJ5LmZpbGVfcGF0aCA9IGZpbGVQYXRoO1xuICAgIH0pO1xuICAgIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIiwgSlNPTi5zdHJpbmdpZnkoZmlsZVBhdGgpKTtcbiAgICBhc3NlcnRTdHJpbmdJbmNsdWRlcyhcbiAgICAgIHZlcmRpY3QucmVwb3J0LFxuICAgICAgYENLVl9BV1NfMTU4IHNraXAgYXQgJHtmaWxlUGF0aH0gbGluZXMgMy03IGhhcyBhIGZpbGUgcGF0aCBvdXRzaWRlIHRoZSBzY2FubmVkIGRpcmVjdG9yeWAsXG4gICAgKTtcbiAgICBhc3NlcnRFcXVhbHMoY2FsbHMsIFtdLCBKU09OLnN0cmluZ2lmeShmaWxlUGF0aCkpO1xuICAgIGFzc2VydEVxdWFscyhcbiAgICAgIHByb2JsZW1MaW5lcyh2ZXJkaWN0LnJlcG9ydCkubGVuZ3RoLFxuICAgICAgMSxcbiAgICAgIEpTT04uc3RyaW5naWZ5KGZpbGVQYXRoKSxcbiAgICApO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgLSBGQUlMRUQgZm9yIGEgc3VtbWFyeS1vbmx5IG9iamVjdCB0aGF0IHJlcG9ydHMgZmFpbGVkIGNoZWNrc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHZlcmRpY3QgPSBhd2FpdCBqdWRnZUNoZWNrb3ZSdW4oe1xuICAgIGV4aXRDb2RlOiAxLFxuICAgIHN0ZG91dDogc3VtbWFyeU9ubHkoeyBmYWlsZWQ6IDEgfSksXG4gICAgdGVtcGxhdGVzOiBub1RlbXBsYXRlcyxcbiAgfSk7XG4gIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKFxuICAgIHZlcmRpY3QucmVwb3J0LFxuICAgIFwic3VtbWFyeSByZXBvcnRzIDEgZmFpbGVkIGNoZWNrKHMpIHdpdGggbm8gcmVwb3J0IGJvZHkgdG8gbmFtZSB0aGVtXCIsXG4gICk7XG4gIGFzc2VydEVxdWFscyhwcm9ibGVtTGluZXModmVyZGljdC5yZXBvcnQpLmxlbmd0aCwgMSk7XG5cbiAgY29uc3QgY29udHJvbCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgZXhpdENvZGU6IDAsXG4gICAgc3Rkb3V0OiBzdW1tYXJ5T25seSgpLFxuICAgIHRlbXBsYXRlczogbm9UZW1wbGF0ZXMsXG4gIH0pO1xuICBhc3NlcnRFcXVhbHMoY29udHJvbC5zdGF0dXMsIFwiUEFTU0VEXCIpO1xuICBhc3NlcnRTdHJpbmdJbmNsdWRlcyhjb250cm9sLnJlcG9ydCwgXCJObyBDbG91ZEZvcm1hdGlvbiB0ZW1wbGF0ZXMgZm91bmRcIik7XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgLSBGQUlMRUQgZm9yIGEgc3VtbWFyeS1vbmx5IG9iamVjdCB0aGF0IHJlcG9ydHMgcGFyc2luZyBlcnJvcnNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IHN1bW1hcnlPbmx5KHsgcGFyc2luZ19lcnJvcnM6IDEgfSksXG4gICAgdGVtcGxhdGVzOiBub1RlbXBsYXRlcyxcbiAgfSk7XG4gIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKFxuICAgIHZlcmRpY3QucmVwb3J0LFxuICAgIFwic3VtbWFyeSByZXBvcnRzIDEgcGFyc2luZyBlcnJvcihzKSB3aXRoIG5vIHJlcG9ydCBib2R5IHRvIG5hbWUgdGhlIGZpbGVzXCIsXG4gICk7XG4gIGFzc2VydEVxdWFscyhwcm9ibGVtTGluZXModmVyZGljdC5yZXBvcnQpLmxlbmd0aCwgMSk7XG5cbiAgY29uc3QgY29udHJvbCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgZXhpdENvZGU6IDAsXG4gICAgc3Rkb3V0OiBzdW1tYXJ5T25seSgpLFxuICAgIHRlbXBsYXRlczogbm9UZW1wbGF0ZXMsXG4gIH0pO1xuICBhc3NlcnRFcXVhbHMoY29udHJvbC5zdGF0dXMsIFwiUEFTU0VEXCIpO1xufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIHdoZW4gYSByZXN1bHRzIGxpc3QgaXMgbm90IGEgbGlzdFwiLCBhc3luYyAoKSA9PiB7XG4gIGZvciAoY29uc3Qga2V5IG9mIFtcImZhaWxlZF9jaGVja3NcIiwgXCJza2lwcGVkX2NoZWNrc1wiLCBcInBhcnNpbmdfZXJyb3JzXCJdKSB7XG4gICAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgICBleGl0Q29kZTogMCxcbiAgICAgIHN0ZG91dDogYXdhaXQgZWRpdGVkUmVwb3J0KFwiY2xlYW5cIiwgKHBhcnNlZCkgPT4ge1xuICAgICAgICBwYXJzZWQucmVzdWx0c1trZXldID0gXCJub25lXCI7XG4gICAgICB9KSxcbiAgICAgIHRlbXBsYXRlczogZml4dHVyZVRlbXBsYXRlcyhcImNsZWFuXCIpLFxuICAgIH0pO1xuICAgIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIiwga2V5KTtcbiAgICBhc3NlcnRTdHJpbmdJbmNsdWRlcyh2ZXJkaWN0LnJlcG9ydCwgYHJlc3VsdHMuJHtrZXl9IGlzIG5vdCBhIGxpc3RgKTtcbiAgICBhc3NlcnRFcXVhbHMocHJvYmxlbUxpbmVzKHZlcmRpY3QucmVwb3J0KS5sZW5ndGgsIDEsIGtleSk7XG4gIH1cblxuICBjb25zdCBjb250cm9sID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQ6IGF3YWl0IHJlcG9ydChcImNsZWFuXCIpLFxuICAgIHRlbXBsYXRlczogZml4dHVyZVRlbXBsYXRlcyhcImNsZWFuXCIpLFxuICB9KTtcbiAgYXNzZXJ0RXF1YWxzKGNvbnRyb2wuc3RhdHVzLCBcIlBBU1NFRFwiKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCAtIEZBSUxFRCB3aGVuIGEgc3VtbWFyeSBjb3VudCBpcyBub3QgYSBudW1iZXJcIiwgYXN5bmMgKCkgPT4ge1xuICBmb3IgKGNvbnN0IGtleSBvZiBbXCJwYXNzZWRcIiwgXCJmYWlsZWRcIiwgXCJza2lwcGVkXCIsIFwicGFyc2luZ19lcnJvcnNcIl0pIHtcbiAgICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICAgIGV4aXRDb2RlOiAwLFxuICAgICAgc3Rkb3V0OiBhd2FpdCBlZGl0ZWRSZXBvcnQoXCJjbGVhblwiLCAocGFyc2VkKSA9PiB7XG4gICAgICAgIHBhcnNlZC5zdW1tYXJ5W2tleV0gPSBcIjBcIjtcbiAgICAgIH0pLFxuICAgICAgdGVtcGxhdGVzOiBmaXh0dXJlVGVtcGxhdGVzKFwiY2xlYW5cIiksXG4gICAgfSk7XG4gICAgYXNzZXJ0RXF1YWxzKHZlcmRpY3Quc3RhdHVzLCBcIkZBSUxFRFwiLCBrZXkpO1xuICAgIGFzc2VydFN0cmluZ0luY2x1ZGVzKHZlcmRpY3QucmVwb3J0LCBgc3VtbWFyeS4ke2tleX0gaXMgbm90IGEgbnVtYmVyYCk7XG4gICAgYXNzZXJ0RXF1YWxzKHByb2JsZW1MaW5lcyh2ZXJkaWN0LnJlcG9ydCkubGVuZ3RoLCAxLCBrZXkpO1xuICB9XG5cbiAgY29uc3QgY29udHJvbCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgZXhpdENvZGU6IDAsXG4gICAgc3Rkb3V0OiBhd2FpdCByZXBvcnQoXCJjbGVhblwiKSxcbiAgICB0ZW1wbGF0ZXM6IGZpeHR1cmVUZW1wbGF0ZXMoXCJjbGVhblwiKSxcbiAgfSk7XG4gIGFzc2VydEVxdWFscyhjb250cm9sLnN0YXR1cywgXCJQQVNTRURcIik7XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgLSBGQUlMRUQgd2hlbiB0aGUgc3VtbWFyeSBjb3VudHMgZmFpbGVkIGNoZWNrcyBidXQgbm9uZSBhcmUgbGlzdGVkXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgZXhpdENvZGU6IDEsXG4gICAgc3Rkb3V0OiBhd2FpdCBlZGl0ZWRSZXBvcnQoXCJjbGVhblwiLCAocGFyc2VkKSA9PiB7XG4gICAgICBwYXJzZWQuc3VtbWFyeS5mYWlsZWQgPSAxO1xuICAgIH0pLFxuICAgIHRlbXBsYXRlczogZml4dHVyZVRlbXBsYXRlcyhcImNsZWFuXCIpLFxuICB9KTtcbiAgYXNzZXJ0RXF1YWxzKHZlcmRpY3Quc3RhdHVzLCBcIkZBSUxFRFwiKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXMoXG4gICAgdmVyZGljdC5yZXBvcnQsXG4gICAgXCJzdW1tYXJ5IHJlcG9ydHMgMSBmYWlsZWQgY2hlY2socykgYnV0IG5vbmUgYXJlIGxpc3RlZFwiLFxuICApO1xuICBhc3NlcnRFcXVhbHMocHJvYmxlbUxpbmVzKHZlcmRpY3QucmVwb3J0KS5sZW5ndGgsIDEpO1xuXG4gIGNvbnN0IGNvbnRyb2wgPSBhd2FpdCBqdWRnZUNoZWNrb3ZSdW4oe1xuICAgIGV4aXRDb2RlOiAwLFxuICAgIHN0ZG91dDogYXdhaXQgcmVwb3J0KFwiY2xlYW5cIiksXG4gICAgdGVtcGxhdGVzOiBmaXh0dXJlVGVtcGxhdGVzKFwiY2xlYW5cIiksXG4gIH0pO1xuICBhc3NlcnRFcXVhbHMoY29udHJvbC5zdGF0dXMsIFwiUEFTU0VEXCIpO1xufSk7XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IC0gRkFJTEVEIHdoZW4gdGhlIHN1bW1hcnkgY291bnRzIHBhcnNlIGVycm9ycyBidXQgbmFtZXMgbm8gZmlsZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHZlcmRpY3QgPSBhd2FpdCBqdWRnZUNoZWNrb3ZSdW4oe1xuICAgIGV4aXRDb2RlOiAwLFxuICAgIHN0ZG91dDogYXdhaXQgZWRpdGVkUmVwb3J0KFwiY2xlYW5cIiwgKHBhcnNlZCkgPT4ge1xuICAgICAgcGFyc2VkLnN1bW1hcnkucGFyc2luZ19lcnJvcnMgPSAxO1xuICAgIH0pLFxuICAgIHRlbXBsYXRlczogZml4dHVyZVRlbXBsYXRlcyhcImNsZWFuXCIpLFxuICB9KTtcbiAgYXNzZXJ0RXF1YWxzKHZlcmRpY3Quc3RhdHVzLCBcIkZBSUxFRFwiKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXMoXG4gICAgdmVyZGljdC5yZXBvcnQsXG4gICAgXCJzdW1tYXJ5IHJlcG9ydHMgMSBwYXJzaW5nIGVycm9yKHMpIGJ1dCBuYW1lcyBubyBmaWxlXCIsXG4gICk7XG4gIGFzc2VydEVxdWFscyhwcm9ibGVtTGluZXModmVyZGljdC5yZXBvcnQpLmxlbmd0aCwgMSk7XG5cbiAgY29uc3QgY29udHJvbCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgZXhpdENvZGU6IDAsXG4gICAgc3Rkb3V0OiBhd2FpdCByZXBvcnQoXCJjbGVhblwiKSxcbiAgICB0ZW1wbGF0ZXM6IGZpeHR1cmVUZW1wbGF0ZXMoXCJjbGVhblwiKSxcbiAgfSk7XG4gIGFzc2VydEVxdWFscyhjb250cm9sLnN0YXR1cywgXCJQQVNTRURcIik7XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgLSBtdWx0aS1mcmFtZXdvcmsgYXJyYXkgaXMgRkFJTEVEIHdoZW4gb25lIGVsZW1lbnQgZmFpbHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBzdGRvdXQgPSBKU09OLnN0cmluZ2lmeShbXG4gICAgSlNPTi5wYXJzZShhd2FpdCByZXBvcnQoXCJjbGVhblwiKSksXG4gICAgSlNPTi5wYXJzZShhd2FpdCByZXBvcnQoXCJmYWlsZWRcIikpLFxuICBdKTtcbiAgY29uc3QgdmVyZGljdCA9IGF3YWl0IGp1ZGdlQ2hlY2tvdlJ1bih7XG4gICAgZXhpdENvZGU6IDEsXG4gICAgc3Rkb3V0LFxuICAgIHRlbXBsYXRlczogZml4dHVyZVRlbXBsYXRlcyhcImZhaWxlZFwiKSxcbiAgfSk7XG4gIGFzc2VydEVxdWFscyh2ZXJkaWN0LnN0YXR1cywgXCJGQUlMRURcIik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKHZlcmRpY3QucmVwb3J0LCBcIkNLVl9BV1NfMTU4IGZhaWxlZFwiKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCAtIG11bHRpLWZyYW1ld29yayBhcnJheSBvZiBvbmUgY2xlYW4gcmVwb3J0IGlzIFBBU1NFRFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHN0ZG91dCA9IEpTT04uc3RyaW5naWZ5KFtKU09OLnBhcnNlKGF3YWl0IHJlcG9ydChcImNsZWFuXCIpKV0pO1xuICBjb25zdCB2ZXJkaWN0ID0gYXdhaXQganVkZ2VDaGVja292UnVuKHtcbiAgICBleGl0Q29kZTogMCxcbiAgICBzdGRvdXQsXG4gICAgdGVtcGxhdGVzOiBmaXh0dXJlVGVtcGxhdGVzKFwiY2xlYW5cIiksXG4gIH0pO1xuICBhc3NlcnRFcXVhbHModmVyZGljdC5zdGF0dXMsIFwiUEFTU0VEXCIpO1xufSk7XG5cbi8qKiBSdW4gdGhlIENMSSBlbnRyeSBwb2ludCwgb3B0aW9uYWxseSBmcm9tIGEgZml4dHVyZSBjYXNlIGRpcmVjdG9yeS4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJ1bkNsaShhcmdzOiBzdHJpbmdbXSwgY2FzZURpcj86IHN0cmluZykge1xuICBjb25zdCBvdXRwdXQgPSBhd2FpdCBuZXcgRGVuby5Db21tYW5kKERlbm8uZXhlY1BhdGgoKSwge1xuICAgIGFyZ3M6IFtcbiAgICAgIFwicnVuXCIsXG4gICAgICBcIi0tcXVpZXRcIixcbiAgICAgIFwiLS1uby1jb25maWdcIixcbiAgICAgIFwiLS1uby1sb2NrXCIsXG4gICAgICBcIi0tYWxsb3ctcmVhZFwiLFxuICAgICAgQ0xJX1BBVEgsXG4gICAgICAuLi5hcmdzLFxuICAgIF0sXG4gICAgY3dkOiBjYXNlRGlyID09PSB1bmRlZmluZWRcbiAgICAgID8gdW5kZWZpbmVkXG4gICAgICA6IG5ldyBVUkwoYCR7Y2FzZURpcn0vYCwgRklYVFVSRVMpLnBhdGhuYW1lLFxuICAgIHN0ZGluOiBcIm51bGxcIixcbiAgICBzdGRvdXQ6IFwicGlwZWRcIixcbiAgICBzdGRlcnI6IFwicGlwZWRcIixcbiAgfSkub3V0cHV0KCk7XG4gIHJldHVybiB7XG4gICAgY29kZTogb3V0cHV0LmNvZGUsXG4gICAgc3Rkb3V0OiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUob3V0cHV0LnN0ZG91dCksXG4gICAgc3RkZXJyOiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUob3V0cHV0LnN0ZGVyciksXG4gIH07XG59XG5cbkRlbm8udGVzdChcImNoZWNrb3YtcmVwb3J0IENMSSAtIGV4aXQgMCBmb3IgYSBjbGVhbiByZXBvcnRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5DbGkoXG4gICAgW25ldyBVUkwoXCJjbGVhbi9yZXBvcnQuanNvblwiLCBGSVhUVVJFUykucGF0aG5hbWUsIFwiMFwiXSxcbiAgICBcImNsZWFuXCIsXG4gICk7XG4gIGFzc2VydEVxdWFscyhyZXN1bHQuY29kZSwgMCwgcmVzdWx0LnN0ZGVycik7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKHJlc3VsdC5zdGRvdXQsIFwiU3RhdHVzOiBQQVNTRURcIik7XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgQ0xJIC0gZXhpdCAxIGZvciBhIGZhaWxlZCByZXBvcnRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5DbGkoXG4gICAgW25ldyBVUkwoXCJmYWlsZWQvcmVwb3J0Lmpzb25cIiwgRklYVFVSRVMpLnBhdGhuYW1lLCBcIjFcIl0sXG4gICAgXCJmYWlsZWRcIixcbiAgKTtcbiAgYXNzZXJ0RXF1YWxzKHJlc3VsdC5jb2RlLCAxLCByZXN1bHQuc3RkZXJyKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXMocmVzdWx0LnN0ZG91dCwgXCJDS1ZfQVdTXzE1OCBmYWlsZWRcIik7XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgQ0xJIC0gZXhpdCAxIGZvciBhIHJlYXNvbmxlc3Mgc2tpcCwgdGVtcGxhdGUgcmVhZCBmcm9tIHRoZSB3b3JraW5nIGRpcmVjdG9yeVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkNsaShcbiAgICBbbmV3IFVSTChcInJlYXNvbmxlc3Nfc2tpcC9yZXBvcnQuanNvblwiLCBGSVhUVVJFUykucGF0aG5hbWUsIFwiMFwiXSxcbiAgICBcInJlYXNvbmxlc3Nfc2tpcFwiLFxuICApO1xuICBhc3NlcnRFcXVhbHMocmVzdWx0LmNvZGUsIDEsIHJlc3VsdC5zdGRlcnIpO1xuICBhc3NlcnRTdHJpbmdJbmNsdWRlcyhyZXN1bHQuc3Rkb3V0LCBcInNraXBwZWQgd2l0aG91dCBhIHJlYXNvblwiKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXMocmVzdWx0LnN0ZG91dCwgXCJubyBpbmxpbmVcIik7XG4gIGFzc2VydCghcmVzdWx0LnN0ZG91dC5pbmNsdWRlcyhcImNvdWxkIG5vdCBiZSByZWFkXCIpKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCBDTEkgLSBleGl0IDIgZm9yIGJhZCB1c2FnZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkNsaShbXG4gICAgbmV3IFVSTChcImNsZWFuL3JlcG9ydC5qc29uXCIsIEZJWFRVUkVTKS5wYXRobmFtZSxcbiAgICBcIm5vdC1hLW51bWJlclwiLFxuICBdKTtcbiAgYXNzZXJ0RXF1YWxzKHJlc3VsdC5jb2RlLCAyKTtcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXMocmVzdWx0LnN0ZGVyciwgXCJ1c2FnZTpcIik7XG59KTtcblxuRGVuby50ZXN0KFwiY2hlY2tvdi1yZXBvcnQgQ0xJIC0gZXhpdCAxIHdoZW4gdGhlIHJlcG9ydCBmaWxlIGlzIG1pc3NpbmdcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBtaXNzaW5nID0gbmV3IFVSTChcImRvZXMtbm90LWV4aXN0Lmpzb25cIiwgRklYVFVSRVMpLnBhdGhuYW1lO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5DbGkoW21pc3NpbmcsIFwiMFwiXSk7XG4gIGFzc2VydEVxdWFscyhyZXN1bHQuY29kZSwgMSk7XG4gIGFzc2VydFN0cmluZ0luY2x1ZGVzKHJlc3VsdC5zdGRlcnIsIFwiY2Fubm90IHJlYWQgcmVwb3J0XCIpO1xuICBhc3NlcnRTdHJpbmdJbmNsdWRlcyhyZXN1bHQuc3RkZXJyLCBtaXNzaW5nKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJjaGVja292LXJlcG9ydCBDTEkgLSBhbiB1bnJlYWRhYmxlIHJlcG9ydCBwcmludHMgbm8gdmVyZGljdCB0byBzdGRvdXRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBtaXNzaW5nID0gbmV3IFVSTChcImRvZXMtbm90LWV4aXN0Lmpzb25cIiwgRklYVFVSRVMpLnBhdGhuYW1lO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5DbGkoW21pc3NpbmcsIFwiMFwiXSk7XG4gIGFzc2VydEVxdWFscyhyZXN1bHQuY29kZSwgMSk7XG4gIGFzc2VydEVxdWFscyhcbiAgICByZXN1bHQuc3Rkb3V0LFxuICAgIFwiXCIsXG4gICAgXCJubyB2ZXJkaWN0IHNob3VsZCBiZSBqdWRnZWQgZnJvbSBhIHJlcG9ydCB0aGF0IHdhcyBub3QgcmVhZFwiLFxuICApO1xuICBhc3NlcnRTdHJpbmdJbmNsdWRlcyhyZXN1bHQuc3RkZXJyLCBgY2Fubm90IHJlYWQgcmVwb3J0ICR7bWlzc2luZ31gKTtcbn0pO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FxQkMsR0FFRCxTQUFTLE1BQU0sRUFBRSxZQUFZLEVBQUUsb0JBQW9CLFFBQVEsY0FBYztBQUN6RSxTQUNFLGlCQUFpQixFQUVqQixlQUFlLFFBQ1YsMkJBQTJCO0FBRWxDLDJDQUEyQyxHQUMzQyxNQUFNLFdBQVcsSUFBSSxJQUFJLHVCQUF1QixZQUFZLEdBQUc7QUFFL0QsaUVBQWlFLEdBQ2pFLE1BQU0sV0FBVyxJQUFJLElBQUksNEJBQTRCLFlBQVksR0FBRyxFQUFFLFFBQVE7QUFFOUUsNkNBQTZDLEdBQzdDLGVBQWUsT0FBTyxJQUFZO0VBQ2hDLE9BQU8sTUFBTSxLQUFLLFlBQVksQ0FBQyxJQUFJLElBQUksR0FBRyxLQUFLLFlBQVksQ0FBQyxFQUFFO0FBQ2hFO0FBRUEscUVBQXFFLEdBQ3JFLFNBQVMsaUJBQWlCLElBQVk7RUFDcEMsT0FBTyxPQUFPO0lBQ1osSUFBSTtNQUNGLE9BQU8sTUFBTSxLQUFL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
// denoCacheMetadata=7523612893891541464,2000696968675284679