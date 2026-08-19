/**
 * Tests for the alert-feed idle-task template (Issue #3394, parent #3386 —
 * template #14).
 *
 * Coverage:
 *   - registration at module load; contract flags
 *   - title + body fingerprint dispatch signals; no raw placeholders
 *   - pure finding assembly from stubbed fetcher results (fingerprint,
 *     severity, title, feed-unavailable note, hard error)
 *   - runTask happy path: high/critical alerts present → one issue per alert
 *     filed with the `alert-feed` + `severity:*` labels
 *   - runTask edge case: zero alerts → "no findings", nothing filed
 *   - runTask dedup: an alert already in the known-open fingerprint list is
 *     skipped (no issue filed)
 *   - runTask fail-loud: a fetcher `error` result → ok:false (never throws)
 *   - feed-unavailable: a 403/404 feed is a non-fatal note, still ok:true
 *   - claim handler dispatches the wrapper to runTask
 *
 * Every test exercises the real functions against injected stubs — no network,
 * no filesystem, no Claude. Australian English throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  ALERT_FEED_BODY_FINGERPRINT,
  ALERT_FEED_ISSUE_TITLE,
  ALERT_FEED_LABEL,
  alertFeedTemplate,
  buildCodeScanningFinding,
  buildDependabotFinding,
  collectAlertFindings,
  createAlertFeedTemplate,
  renderAlertFeedSummary,
  renderAlertFindingBody,
} from "../lib/idle_task_templates/alert_feed_template.ts";
import type {
  DependabotAlert,
  DependabotAlertsResult,
} from "../lib/alert_feeds/dependabot_alerts.ts";
import type {
  CodeScanningAlert,
  CodeScanningAlertsResult,
} from "../lib/alert_feeds/code_scanning_alerts.ts";
import {
  alertFingerprintMarker,
  dependabotAlertFingerprint,
} from "../lib/alert_feeds/alert_fingerprint.ts";
import { getTemplate, listTemplates } from "../lib/idle_task_template.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import type { Logger, Result } from "../types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STUB_PROMPT = [
  "# Alert Feed — New High/Critical Security Alerts (v1)",
  "",
  "Body describing the native alert feed.",
  "",
  "{{ATTRIBUTION_FOOTER}}",
].join("\n");

const okPrompt = (): Promise<Result<string>> =>
  Promise.resolve({ ok: true, value: STUB_PROMPT });

const okLabel = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined });

function dependabotAlert(
  overrides: Partial<DependabotAlert> = {},
): DependabotAlert {
  return {
    number: 11,
    ghsaId: "GHSA-aaaa-bbbb-cccc",
    packageName: "lodash",
    ecosystem: "npm",
    severity: "critical",
    summary: "Prototype pollution in lodash",
    htmlUrl: "https://github.com/acme/widget/security/dependabot/11",
    ...overrides,
  };
}

function codeScanningAlert(
  overrides: Partial<CodeScanningAlert> = {},
): CodeScanningAlert {
  return {
    number: 42,
    ruleId: "js/zipslip",
    severity: "high",
    description: "Arbitrary file write during archive extraction",
    htmlUrl: "https://github.com/acme/widget/security/code-scanning/42",
    ...overrides,
  };
}

const dependabotResult = (
  alerts: DependabotAlert[],
): DependabotAlertsResult => ({ kind: "alerts", alerts });

const codeScanningResult = (
  alerts: CodeScanningAlert[],
): CodeScanningAlertsResult => ({ kind: "alerts", alerts });

/**
 * gh stub. `--json number` calls are the before/after snapshots; the
 * `--json number,body` call is the fingerprint dedup lookup; `issue create`
 * returns a synthetic issue URL from `createNumbers`.
 */
function makeGhStub(scenario: {
  snapshots?: [number[], number[]];
  dedup?: Array<{ number: number; body: string }>;
  createNumbers?: number[];
  wrapperOpen?: boolean;
}): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  let snapshotCount = 0;
  let createCount = 0;
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    if (args[0] === "issue" && args[1] === "create") {
      const nums = scenario.createNumbers ?? [];
      const n = nums[createCount] ?? 999;
      createCount += 1;
      return Promise.resolve(`https://github.com/acme/widget/issues/${n}`);
    }
    const jsonIdx = args.indexOf("--json");
    const jsonField = jsonIdx >= 0 ? args[jsonIdx + 1] : "";
    if (jsonField === "number,title") {
      // Wrapper-open lookup used by shouldFile.
      return Promise.resolve(
        scenario.wrapperOpen
          ? JSON.stringify([{ number: 1, title: ALERT_FEED_ISSUE_TITLE }])
          : "[]",
      );
    }
    if (jsonField === "number") {
      const snap = scenario.snapshots ?? [[], []];
      const result = snapshotCount === 0 ? snap[0] : snap[1];
      snapshotCount += 1;
      return Promise.resolve(
        JSON.stringify(result.map((n) => ({ number: n }))),
      );
    }
    if (jsonField === "number,body") {
      return Promise.resolve(JSON.stringify(scenario.dedup ?? []));
    }
    return Promise.resolve("[]");
  };
  return { gh, calls };
}

function createCalls(calls: string[][]): string[][] {
  return calls.filter((c) => c[0] === "issue" && c[1] === "create");
}

function makeLogger(): Logger {
  const noop = () => {};
  return {
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
}

// ---------------------------------------------------------------------------
// Registration + contract
// ---------------------------------------------------------------------------

Deno.test("alert-feed - registered at module load", () => {
  const t = getTemplate("alert-feed");
  assert(t !== undefined);
  assertEquals(t, alertFeedTemplate);
  assert(listTemplates().some((x) => x.name === "alert-feed"));
});

Deno.test("alert-feed - contract flags", () => {
  assertEquals(alertFeedTemplate.cooldownHours, 168);
  assertEquals(alertFeedTemplate.skipMilestone, true);
  assertEquals(alertFeedTemplate.outputLabel, ALERT_FEED_LABEL);
  assertEquals(alertFeedTemplate.requiresStructuredOutput, true);
  assertEquals(
    alertFeedTemplate.buildIssueTitle("acme/widget"),
    ALERT_FEED_ISSUE_TITLE,
  );
});

Deno.test("alert-feed - buildIssueBody matches title and fingerprint", async () => {
  const t = createAlertFeedTemplate({ loadPromptFn: okPrompt });
  const body = await Promise.resolve(
    t.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-07-05T00:00:00Z",
      workerUser: "vibe",
    }),
  );
  assertEquals(t.buildIssueTitle("acme/widget"), ALERT_FEED_ISSUE_TITLE);
  assert(t.matchesIdleTaskBody?.(body) === true);
  assert(ALERT_FEED_BODY_FINGERPRINT.test(body));
  assert(!body.includes("{{"), "expected no raw placeholders");
  assertStringIncludes(body, "🏷️ Filed by idle-task template: `alert-feed`");
});

// ---------------------------------------------------------------------------
// Pure finding assembly
// ---------------------------------------------------------------------------

Deno.test("buildDependabotFinding - carries fingerprint, severity, package", () => {
  const alert = dependabotAlert();
  const finding = buildDependabotFinding("acme/widget", alert);
  assertEquals(
    finding.fingerprint,
    dependabotAlertFingerprint("acme/widget", {
      number: alert.number,
      ghsaId: alert.ghsaId,
    }),
  );
  assertEquals(finding.severity, "critical");
  assertEquals(finding.source, "dependabot");
  assertStringIncludes(finding.title, "[Dependabot]");
  assertStringIncludes(finding.title, "lodash");
  assertStringIncludes(finding.title, "GHSA-aaaa-bbbb-cccc");
});

Deno.test("buildCodeScanningFinding - carries fingerprint, severity, rule", () => {
  const finding = buildCodeScanningFinding("acme/widget", codeScanningAlert());
  assertEquals(finding.fingerprint, "code-scanning:acme/widget:js/zipslip:42");
  assertEquals(finding.severity, "high");
  assertEquals(finding.source, "code-scanning");
  assertStringIncludes(finding.title, "[Code scanning]");
  assertStringIncludes(finding.title, "js/zipslip");
});

Deno.test("collectAlertFindings - merges both feeds' alerts", () => {
  const collected = collectAlertFindings(
    "acme/widget",
    dependabotResult([dependabotAlert()]),
    codeScanningResult([codeScanningAlert()]),
  );
  assertEquals(collected.findings.length, 2);
  assertEquals(collected.feedNotes.length, 0);
  assertEquals(collected.errors.length, 0);
});

Deno.test("collectAlertFindings - feed-unavailable is a note, not an error", () => {
  const collected = collectAlertFindings(
    "acme/widget",
    { kind: "feed-unavailable", status: 403, reason: "disabled" },
    codeScanningResult([]),
  );
  assertEquals(collected.findings.length, 0);
  assertEquals(collected.errors.length, 0);
  assertEquals(collected.feedNotes.length, 1);
  assertStringIncludes(collected.feedNotes[0]!, "Dependabot feed unavailable");
  assertStringIncludes(collected.feedNotes[0]!, "403");
});

Deno.test("collectAlertFindings - a fetcher error is a hard error", () => {
  const collected = collectAlertFindings(
    "acme/widget",
    { kind: "error", error: "network down" },
    codeScanningResult([codeScanningAlert()]),
  );
  // The other feed's alert still becomes a finding.
  assertEquals(collected.findings.length, 1);
  assertEquals(collected.errors.length, 1);
  assertStringIncludes(collected.errors[0]!, "Dependabot fetch failed");
});

Deno.test("renderAlertFindingBody - embeds the fingerprint marker and url", () => {
  const finding = buildDependabotFinding("acme/widget", dependabotAlert());
  const body = renderAlertFindingBody(finding, "FOOTER");
  assertStringIncludes(body, alertFingerprintMarker(finding.fingerprint));
  assertStringIncludes(body, "Prototype pollution in lodash");
  assertStringIncludes(body, finding.url);
  assertStringIncludes(body, "FOOTER");
});

Deno.test("renderAlertFeedSummary - wording for filed / none / errors", () => {
  assertEquals(renderAlertFeedSummary([]), "no findings");
  assertEquals(
    renderAlertFeedSummary([102, 101]),
    "Alert-feed scan complete. Filed 2 issues: #101, #102",
  );
  const withErr = renderAlertFeedSummary([], [], [
    "Dependabot fetch failed: x",
  ]);
  assertStringIncludes(withErr, "no findings");
  assertStringIncludes(withErr, "Fetcher errors:");
});

// ---------------------------------------------------------------------------
// runTask — alerts present → one issue per alert
// ---------------------------------------------------------------------------

Deno.test("alert-feed runTask - high/critical alerts present → one issue per alert filed", async () => {
  const { gh, calls } = makeGhStub({
    snapshots: [[], [101, 102]],
    createNumbers: [101, 102],
  });
  const t = createAlertFeedTemplate({
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    fetchDependabotAlertsFn: () =>
      Promise.resolve(dependabotResult([dependabotAlert()])),
    fetchCodeScanningAlertsFn: () =>
      Promise.resolve(codeScanningResult([codeScanningAlert()])),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp",
    idleTaskIssueNumber: 7,
  });

  assertEquals(result.ok, true);
  assertStringIncludes(result.summary, "Filed 2 issues: #101, #102");

  const creates = createCalls(calls);
  assertEquals(creates.length, 2);
  for (const c of creates) {
    assert(c.includes(ALERT_FEED_LABEL), "each issue carries alert-feed label");
    // One of the severity labels is present.
    assert(
      c.includes("severity:critical") || c.includes("severity:high"),
      "each issue carries a severity label",
    );
  }
});

// ---------------------------------------------------------------------------
// runTask — zero alerts → nothing filed
// ---------------------------------------------------------------------------

Deno.test("alert-feed runTask - zero alerts → no findings, nothing filed", async () => {
  const { gh, calls } = makeGhStub({ snapshots: [[], []] });
  const t = createAlertFeedTemplate({
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    fetchDependabotAlertsFn: () => Promise.resolve(dependabotResult([])),
    fetchCodeScanningAlertsFn: () => Promise.resolve(codeScanningResult([])),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp",
    idleTaskIssueNumber: 7,
  });

  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
  assertEquals(createCalls(calls).length, 0);
});

// ---------------------------------------------------------------------------
// runTask — dedup skips a known-open alert
// ---------------------------------------------------------------------------

Deno.test("alert-feed runTask - alert already in known-open list is skipped", async () => {
  const alert = dependabotAlert();
  const fingerprint = dependabotAlertFingerprint("acme/widget", {
    number: alert.number,
    ghsaId: alert.ghsaId,
  });
  const { gh, calls } = makeGhStub({
    snapshots: [[55], [55]],
    // The dedup lookup returns an open issue already carrying this fingerprint.
    dedup: [{ number: 55, body: alertFingerprintMarker(fingerprint) }],
  });
  const t = createAlertFeedTemplate({
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    fetchDependabotAlertsFn: () => Promise.resolve(dependabotResult([alert])),
    fetchCodeScanningAlertsFn: () => Promise.resolve(codeScanningResult([])),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp",
    idleTaskIssueNumber: 7,
  });

  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
  assertEquals(createCalls(calls).length, 0, "dedup must skip the filing");
});

// ---------------------------------------------------------------------------
// runTask — fail-loud on a fetcher error
// ---------------------------------------------------------------------------

Deno.test("alert-feed runTask - a fetcher error forces ok:false (fail-loud)", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const t = createAlertFeedTemplate({
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    fetchDependabotAlertsFn: () =>
      Promise.resolve({ kind: "error", error: "network down" }),
    fetchCodeScanningAlertsFn: () => Promise.resolve(codeScanningResult([])),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp",
    idleTaskIssueNumber: 7,
  });

  assertEquals(result.ok, false);
  assertStringIncludes(result.summary, "Fetcher errors:");
  assertStringIncludes(result.summary, "network down");
});

// ---------------------------------------------------------------------------
// runTask — feed-unavailable is non-fatal
// ---------------------------------------------------------------------------

Deno.test("alert-feed runTask - feed-unavailable is a non-fatal note", async () => {
  const { gh, calls } = makeGhStub({ snapshots: [[], []] });
  const t = createAlertFeedTemplate({
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    fetchDependabotAlertsFn: () =>
      Promise.resolve({ kind: "feed-unavailable", status: 404, reason: "off" }),
    fetchCodeScanningAlertsFn: () => Promise.resolve(codeScanningResult([])),
  });

  const result = await t.runTask({
    repo: "acme/widget",
    workDir: "/tmp",
    idleTaskIssueNumber: 7,
  });

  assertEquals(result.ok, true);
  assertStringIncludes(result.summary, "Feed notes:");
  assertStringIncludes(result.summary, "Dependabot feed unavailable");
  assertEquals(createCalls(calls).length, 0);
});

// ---------------------------------------------------------------------------
// Claim handler dispatch
// ---------------------------------------------------------------------------

Deno.test("alert-feed - claim handler dispatches wrapper to runTask", async () => {
  const { gh } = makeGhStub({ snapshots: [[], []] });
  const template = createAlertFeedTemplate({
    ghCommandFn: gh,
    ensureLabelFn: okLabel,
    fetchDependabotAlertsFn: () => Promise.resolve(dependabotResult([])),
    fetchCodeScanningAlertsFn: () => Promise.resolve(codeScanningResult([])),
  });
  const deps: HandleIdleTaskIssueDeps = {
    logger: makeLogger(),
    listTemplatesFn: () => [template],
  };

  const result = await handleIdleTaskIssue({
    repo: "acme/widget",
    issueNumber: 7,
    issueTitle: ALERT_FEED_ISSUE_TITLE,
    issueLabels: ["idle-task"],
    issueBody: "",
    workDir: "/tmp/widget",
  }, deps);

  assertEquals(result.handled, true);
  assertEquals(result.ok, true);
  assertEquals(result.summary, "no findings");
});
