/**
 * Tests for the fail-closed posture of the scheduled dependency audit
 * (Issue #3955).
 *
 * `deno audit --ignore-registry-errors` is documented as "Return exit code 0
 * if remote service(s) responds with an error". On the weekly scheduled run
 * — the only thing that re-audits an unchanged `deno.lock`, because
 * Renovate's deno manager is deliberately disabled (Issue #2536) — an
 * advisory-service outage therefore produced a green job having checked
 * nothing, and the `Notify on scheduled audit failure` step (gated on
 * `failure()`) never fired.
 *
 * Two layers are covered here:
 *
 *  1. **Behavioural** — the pure helpers in `lib/audit_fail_closed.ts` are
 *     called with literal command strings and literal audit output, and the
 *     returned verdicts are asserted.
 *  2. **Repository invariant** — the same helpers are applied to the real
 *     `worker/deno/deno.json` and `.github/workflows/dependency-audit.yml`,
 *     so the opt-out reappearing on the scheduled path fails the quality
 *     gate at PR time rather than during the next outage.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  auditOptOutFlags,
  classifyAuditFailure,
  isAuditFailClosed,
  REGISTRY_ERROR_OPT_OUT_FLAGS,
} from "../lib/audit_fail_closed.ts";

const DENO_JSON_PATH = new URL("../deno.json", import.meta.url).pathname;
const WORKFLOW_PATH =
  new URL("../../../.github/workflows/dependency-audit.yml", import.meta.url)
    .pathname;

// deno-lint-ignore no-explicit-any
function loadWorkflow(): any {
  return parseYaml(Deno.readTextFileSync(WORKFLOW_PATH));
}

/** The `run:` text of the step that invokes the Deno audit. */
function denoAuditRunBlock(): string {
  const job = loadWorkflow().jobs["deno-audit"];
  assert(job, "dependency-audit.yml is missing the deno-audit job");
  // deno-lint-ignore no-explicit-any
  const steps: any[] = job.steps;
  const step = steps.find((s) =>
    typeof s.run === "string" && s.run.includes("deno task audit")
  );
  assert(step, "no step invoking the canonical `deno task audit` task found");
  return step.run as string;
}

// ---------------------------------------------------------------------------
// auditOptOutFlags / isAuditFailClosed — behaviour
// ---------------------------------------------------------------------------

Deno.test("auditOptOutFlags - a bare `deno audit` has no opt-out", () => {
  assertEquals(auditOptOutFlags("deno audit"), []);
  assertEquals(isAuditFailClosed("deno audit"), true);
});

Deno.test("auditOptOutFlags - detects the registry-error opt-out", () => {
  assertEquals(
    auditOptOutFlags("deno audit --ignore-registry-errors"),
    ["--ignore-registry-errors"],
  );
  assertEquals(isAuditFailClosed("deno audit --ignore-registry-errors"), false);
});

Deno.test("auditOptOutFlags - detects the opt-out in an explicit-value form", () => {
  assertEquals(
    auditOptOutFlags("deno audit --ignore-registry-errors=true --level=high"),
    ["--ignore-registry-errors"],
  );
});

Deno.test("auditOptOutFlags - detects the opt-out anywhere in a composed command", () => {
  const command =
    "cd worker/deno && deno audit --ignore-registry-errors && echo done";
  assertEquals(auditOptOutFlags(command), ["--ignore-registry-errors"]);
  assertEquals(isAuditFailClosed(command), false);
});

Deno.test("auditOptOutFlags - unrelated flags are not opt-outs", () => {
  assertEquals(auditOptOutFlags("deno audit --level=high --ignore GHSA-1"), []);
  // A flag that merely shares a prefix must not match.
  assertEquals(auditOptOutFlags("deno audit --ignore-registry-errors-not"), []);
});

Deno.test("auditOptOutFlags - empty input is fail-closed by definition", () => {
  assertEquals(auditOptOutFlags(""), []);
  assertEquals(isAuditFailClosed("   "), true);
});

Deno.test("auditOptOutFlags - the opt-out list is non-empty and well formed", () => {
  assert(REGISTRY_ERROR_OPT_OUT_FLAGS.length > 0);
  for (const flag of REGISTRY_ERROR_OPT_OUT_FLAGS) {
    assert(flag.startsWith("--"), `${flag} should be a long flag`);
  }
});

// ---------------------------------------------------------------------------
// classifyAuditFailure — behaviour
// ---------------------------------------------------------------------------

Deno.test("classifyAuditFailure - a connect failure is an unreachable registry", () => {
  // Captured verbatim from `deno audit` with egress blocked.
  const output =
    "error: error sending request for url (https://registry.npmjs.org/-/npm/v1/security/advisories/bulk): " +
    "client error (Connect): tcp connect error: Connection refused (os error 61)";
  assertEquals(classifyAuditFailure(output), "registry-unreachable");
});

Deno.test("classifyAuditFailure - the masked registry message is unreachable", () => {
  // What `--ignore-registry-errors` printed while exiting 0 — the exact
  // condition this issue makes fail loud.
  const output =
    "Failed to get data from the registry: error sending request for url (https://registry.npmjs.org/)";
  assertEquals(classifyAuditFailure(output), "registry-unreachable");
});

Deno.test("classifyAuditFailure - a 5xx from the advisory service is unreachable", () => {
  assertEquals(
    classifyAuditFailure("error: Bad response: 503 Service Unavailable"),
    "registry-unreachable",
  );
});

Deno.test("classifyAuditFailure - a timeout is unreachable", () => {
  assertEquals(
    classifyAuditFailure("error: request timed out after 30s"),
    "registry-unreachable",
  );
});

Deno.test("classifyAuditFailure - an advisory listing is an advisory", () => {
  const output = [
    "1 vulnerability found",
    "GHSA-xxxx-yyyy-zzzz  high  Prototype pollution in example@1.2.3",
    "  fixed in 1.2.4",
  ].join("\n");
  assertEquals(classifyAuditFailure(output), "advisory");
});

Deno.test("classifyAuditFailure - unrecognised output defaults to advisory", () => {
  // No positive evidence of an outage, so the more urgent reading wins;
  // either way the job is already red.
  assertEquals(classifyAuditFailure(""), "advisory");
  assertEquals(classifyAuditFailure("error: something unexpected"), "advisory");
});

// ---------------------------------------------------------------------------
// Repository invariants
// ---------------------------------------------------------------------------

Deno.test("scheduled audit task must not pass --ignore-registry-errors", () => {
  const denoJson = JSON.parse(Deno.readTextFileSync(DENO_JSON_PATH)) as {
    tasks?: Record<string, string>;
  };
  const task = denoJson.tasks?.audit;
  assert(typeof task === "string", "worker/deno/deno.json has no `audit` task");
  assertEquals(
    auditOptOutFlags(task),
    [],
    `the audit task must be fail-closed, got: ${task}`,
  );
});

Deno.test("dependency-audit workflow runs the canonical audit task fail-closed", () => {
  const run = denoAuditRunBlock();
  assertEquals(
    auditOptOutFlags(run),
    [],
    "the workflow audit step must not re-add a registry-error opt-out",
  );
});

Deno.test("dependency-audit workflow captures the audit output for classification", () => {
  const run = denoAuditRunBlock();
  assert(
    run.includes("deno-audit.log"),
    "the audit step must tee its output so the notifier can tell an " +
      "outage from an advisory",
  );
});

Deno.test("dependency-audit notify step fires on a failed scheduled run", () => {
  const job = loadWorkflow().jobs["deno-audit"];
  // deno-lint-ignore no-explicit-any
  const steps: any[] = job.steps;
  const notify = steps.find((s) =>
    typeof s.run === "string" && s.run.includes("notify-audit-failure")
  );
  assert(notify, "no notify-audit-failure step found in the deno-audit job");
  const condition = String(notify.if ?? "");
  assert(
    condition.includes("failure()"),
    "the notify step must be gated on failure()",
  );
  assert(
    condition.includes("schedule"),
    "the notify step must be scoped to scheduled runs",
  );
  assert(
    notify.run.includes("--audit-log"),
    "the notify step must pass the audit log so the tracking issue can " +
      "distinguish 'did not audit' from 'audited, vulnerable'",
  );
});
