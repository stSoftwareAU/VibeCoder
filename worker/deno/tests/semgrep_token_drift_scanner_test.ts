/**
 * Tests for semgrep_token_drift_scanner.ts (Issue #4341): existing fleet
 * copies of the old `semgrep` template, which passed SEMGREP_APP_TOKEN to
 * `semgrep ci --config`, are flagged; the current template is not.
 */

import { assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { scanSemgrepTokenDrift } from "../lib/semgrep_token_drift_scanner.ts";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

function wf(
  rawText: string,
  path = ".github/workflows/semgrep.yml",
  kind: WorkflowFile["kind"] = "workflow",
): WorkflowFile {
  let parsed: unknown = null;
  try {
    parsed = parseYaml(rawText);
  } catch {
    parsed = null;
  }
  return { path, rawText, parsed, kind };
}

const ID = "BP-SEMGREP-TOKEN-CONFIG-semgrep";

const STEP_ENV = `name: Semgrep
on:
  pull_request:
jobs:
  semgrep:
    runs-on: ubuntu-latest
    steps:
      - run: semgrep ci --config p/default
        env:
          SEMGREP_APP_TOKEN: \${{ secrets.SEMGREP_APP_TOKEN }}
`;

const JOB_ENV = `jobs:
  semgrep:
    env:
      SEMGREP_APP_TOKEN: \${{ secrets.SEMGREP_APP_TOKEN }}
    steps:
      - run: semgrep ci --config p/default
`;

const TOP_ENV = `env:
  SEMGREP_APP_TOKEN: \${{ secrets.SEMGREP_APP_TOKEN }}
jobs:
  semgrep:
    steps:
      - run: semgrep ci --config p/default
`;

Deno.test("scanSemgrepTokenDrift - flags the token at step, job and top level", () => {
  for (const text of [STEP_ENV, JOB_ENV, TOP_ENV]) {
    const findings = scanSemgrepTokenDrift([wf(text)]);
    assertEquals(findings.map((f) => f.findingId), [ID]);
    assertEquals(findings[0]?.severity, "medium");
    assertEquals(findings[0]?.file, ".github/workflows/semgrep.yml");
  }
});

Deno.test("scanSemgrepTokenDrift - cites the line of the token", () => {
  assertEquals(scanSemgrepTokenDrift([wf(STEP_ENV)])[0]?.lines, 10);
});

Deno.test("scanSemgrepTokenDrift - the current semgrep template is clean", () => {
  const template = WORKFLOW_SPECS.find((s) => s.id === "semgrep")!.template;
  assertEquals(scanSemgrepTokenDrift([wf(template)]), []);
});

Deno.test("scanSemgrepTokenDrift - token without --config is not drift", () => {
  const text = STEP_ENV.replace(" --config p/default", "");
  assertEquals(scanSemgrepTokenDrift([wf(text)]), []);
});

Deno.test("scanSemgrepTokenDrift - ignores non-workflow and unparseable files", () => {
  assertEquals(
    scanSemgrepTokenDrift([wf(STEP_ENV, "a/semgrep.yml", "other" as never)]),
    [],
  );
  assertEquals(scanSemgrepTokenDrift([wf("jobs: [unclosed")]), []);
});

Deno.test("scanSemgrepTokenDrift - honours suppressed and known-open ids", () => {
  assertEquals(
    scanSemgrepTokenDrift([wf(STEP_ENV)], { suppressedIds: [ID] }),
    [],
  );
  assertEquals(
    scanSemgrepTokenDrift([wf(STEP_ENV)], { knownOpenFindingIds: [ID] }),
    [],
  );
});
