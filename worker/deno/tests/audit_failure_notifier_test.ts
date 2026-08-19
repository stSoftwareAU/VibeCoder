/**
 * Tests for the dependency-audit failure notifier (Issue #2691,
 * SCR-AUTO-UPDATE).
 *
 * The notifier turns the existing weekly `deno audit` detection in
 * `.github/workflows/dependency-audit.yml` into an actionable
 * notification channel: when a scheduled audit fails (a known advisory
 * landed against an already-committed Deno dependency) it files a single
 * tracking issue so the detect->remediate gap does not depend on a human
 * noticing a red scheduled cron.
 *
 * Every test exercises the real functions with an injected `gh` runner
 * (a fake that records calls and returns canned output) — no network,
 * no `gh` binary.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AUDIT_FAILURE_LABEL,
  buildAuditFailureIssue,
  notifyAuditFailure,
} from "../lib/audit_failure_notifier.ts";

/**
 * Build a fake `gh` runner. `responses` maps a matcher predicate to a
 * canned stdout string (or a function that throws to simulate failure).
 * Every invocation is recorded in `calls` for assertions.
 */
function makeFakeGh(
  handler: (args: string[]) => string,
): { gh: (args: string[]) => Promise<string>; calls: string[][] } {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    return Promise.resolve(handler(args));
  };
  return { gh, calls };
}

const CREATE_URL = "https://github.com/stSoftwareAU/VibeCoder/issues/4242";

Deno.test("buildAuditFailureIssue - names the ecosystem and embeds the run URL", () => {
  const issue = buildAuditFailureIssue(
    "deno",
    "https://github.com/o/r/actions/runs/99",
  );
  assertStringIncludes(issue.title.toLowerCase(), "deno");
  assertStringIncludes(issue.body, "https://github.com/o/r/actions/runs/99");
  // The body must point a responder at the remediation path, not just
  // report a red cron.
  assertStringIncludes(issue.body.toLowerCase(), "deno task audit");
});

Deno.test("buildAuditFailureIssue - falls back to a sensible ecosystem label", () => {
  const issue = buildAuditFailureIssue("   ");
  assertStringIncludes(issue.title.toLowerCase(), "deno");
});

Deno.test("buildAuditFailureIssue - distinguishes 'could not audit' from 'audited, vulnerable'", () => {
  const advisory = buildAuditFailureIssue("deno", undefined, "advisory");
  const unreachable = buildAuditFailureIssue(
    "deno",
    undefined,
    "registry-unreachable",
  );

  // Distinct titles keep the two failure modes separately idempotent and
  // tell a responder which one they are looking at.
  assert(
    advisory.title !== unreachable.title,
    "the two failure modes must not share a tracking-issue title",
  );
  // The unmoded call keeps the pre-#3955 advisory content.
  assertEquals(buildAuditFailureIssue("deno").title, advisory.title);

  const body = unreachable.body.toLowerCase();
  assertStringIncludes(body, "could not");
  assertStringIncludes(body, "nothing was audited");
  // A responder must not be tempted to re-add the opt-out that caused this.
  assertStringIncludes(unreachable.body, "--ignore-registry-errors");
});

Deno.test("notifyAuditFailure - an unreachable registry files the 'could not audit' issue", async () => {
  const expected = buildAuditFailureIssue(
    "deno",
    undefined,
    "registry-unreachable",
  );
  const { gh, calls } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "issue" && args[1] === "create") return CREATE_URL;
    return "";
  });

  const result = await notifyAuditFailure({
    repo: "x/y",
    ecosystem: "deno",
    auditLogPath: "/tmp/deno-audit.log",
    readTextFileFn: () =>
      Promise.resolve(
        "error: error sending request for url " +
          "(https://registry.npmjs.org/-/npm/v1/security/advisories/bulk): " +
          "tcp connect error: Connection refused (os error 61)",
      ),
    ghCommandFn: gh,
  });

  assertEquals(result.action, "filed");
  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create, "expected an issue-create call");
  assertEquals(create[create.indexOf("--title") + 1], expected.title);
});

Deno.test("notifyAuditFailure - an advisory log keeps the advisory issue", async () => {
  const expected = buildAuditFailureIssue("deno", undefined, "advisory");
  const { gh, calls } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "issue" && args[1] === "create") return CREATE_URL;
    return "";
  });

  await notifyAuditFailure({
    repo: "x/y",
    ecosystem: "deno",
    auditLogPath: "/tmp/deno-audit.log",
    readTextFileFn: () =>
      Promise.resolve("1 vulnerability found\nGHSA-aaaa-bbbb-cccc  high"),
    ghCommandFn: gh,
  });

  const create = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assert(create, "expected an issue-create call");
  assertEquals(create[create.indexOf("--title") + 1], expected.title);
});

Deno.test("notifyAuditFailure - an unreadable audit log is warned about, not swallowed", async () => {
  const warnings: string[] = [];
  const { gh } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "issue" && args[1] === "create") return CREATE_URL;
    return "";
  });

  const result = await notifyAuditFailure({
    repo: "x/y",
    ecosystem: "deno",
    auditLogPath: "/tmp/missing.log",
    readTextFileFn: () => Promise.reject(new Error("no such file")),
    ghCommandFn: gh,
    warnFn: (m) => warnings.push(m),
  });

  // The notification still happens — the audit failure itself is the point.
  assertEquals(result.action, "filed");
  assert(
    warnings.some((w) => w.includes("/tmp/missing.log")),
    `expected a warning naming the unreadable log, got: ${warnings.join("; ")}`,
  );
});

Deno.test("notifyAuditFailure - files a tracking issue when none exists", async () => {
  const { gh, calls } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "issue" && args[1] === "create") return CREATE_URL;
    return ""; // label create / edit succeed silently
  });

  const result = await notifyAuditFailure({
    repo: "stSoftwareAU/VibeCoder",
    ecosystem: "deno",
    runUrl: "https://github.com/o/r/actions/runs/99",
    ghCommandFn: gh,
  });

  assertEquals(result.action, "filed");
  assertEquals(result.issueNumber, 4242);
  assertEquals(result.url, CREATE_URL);
  // A create call must have happened.
  assert(
    calls.some((c) => c[0] === "issue" && c[1] === "create"),
    "expected an issue-create call",
  );
});

Deno.test("notifyAuditFailure - is idempotent when a matching open issue exists", async () => {
  const built = buildAuditFailureIssue("deno");
  const existing = JSON.stringify([
    { number: 7, title: built.title, url: "https://github.com/x/y/issues/7" },
  ]);
  const { gh, calls } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return existing;
    if (args[0] === "issue" && args[1] === "create") {
      throw new Error("must not create a duplicate");
    }
    return "";
  });

  const result = await notifyAuditFailure({
    repo: "x/y",
    ecosystem: "deno",
    ghCommandFn: gh,
  });

  assertEquals(result.action, "skipped");
  assertEquals(result.issueNumber, 7);
  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "create"),
    "must not create when a matching open issue exists",
  );
});

Deno.test("notifyAuditFailure - a different open issue title does not block filing", async () => {
  const other = JSON.stringify([
    { number: 1, title: "Some unrelated issue", url: "u" },
  ]);
  const { gh } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return other;
    if (args[0] === "issue" && args[1] === "create") return CREATE_URL;
    return "";
  });

  const result = await notifyAuditFailure({
    repo: "x/y",
    ecosystem: "deno",
    ghCommandFn: gh,
  });

  assertEquals(result.action, "filed");
});

Deno.test("notifyAuditFailure - applies the tracking label best-effort", async () => {
  const { gh, calls } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "issue" && args[1] === "create") return CREATE_URL;
    return "";
  });

  const result = await notifyAuditFailure({
    repo: "x/y",
    ecosystem: "deno",
    ghCommandFn: gh,
  });

  assertEquals(result.labelApplied, true);
  assert(
    calls.some((c) =>
      c.includes("--add-label") && c.includes(AUDIT_FAILURE_LABEL)
    ),
    "expected an add-label call carrying the tracking label",
  );
});

Deno.test("notifyAuditFailure - still files when labelling fails", async () => {
  const { gh } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "issue" && args[1] === "create") return CREATE_URL;
    if (args[0] === "issue" && args[1] === "edit") {
      throw new Error("no permission to label");
    }
    return ""; // label create succeeds
  });

  const result = await notifyAuditFailure({
    repo: "x/y",
    ecosystem: "deno",
    ghCommandFn: gh,
  });

  // The tracking issue is the guarantee; the label is a bonus.
  assertEquals(result.action, "filed");
  assertEquals(result.labelApplied, false);
});

Deno.test("notifyAuditFailure - reports an error when issue creation fails", async () => {
  const { gh } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") return "[]";
    if (args[0] === "issue" && args[1] === "create") {
      throw new Error("gh create failed");
    }
    return "";
  });

  const result = await notifyAuditFailure({
    repo: "x/y",
    ecosystem: "deno",
    ghCommandFn: gh,
  });

  assertEquals(result.action, "error");
  assert(result.reason && result.reason.length > 0);
});

// ---------------------------------------------------------------------------
// Lookup failure must not masquerade as idempotent success (Issue #3649,
// SEC-c8172be04d3a). A failed `gh issue list` used to return a
// `{ number: 0 }` sentinel, which the caller read as "a matching issue
// already exists" — so the workflow reported success while no advisory
// issue existed, and the caught error was never logged.
// ---------------------------------------------------------------------------

Deno.test("notifyAuditFailure - a failed lookup reports an error, not a skip", async () => {
  const { gh, calls } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") {
      throw new Error("gh: could not reach api.github.com");
    }
    if (args[0] === "issue" && args[1] === "create") return CREATE_URL;
    return "";
  });

  const result = await notifyAuditFailure({
    repo: "x/y",
    ecosystem: "deno",
    ghCommandFn: gh,
  });

  assertEquals(result.action, "error");
  // The sentinel used to surface as issue 0 alongside action=skipped.
  assertEquals(result.issueNumber, undefined);
  assert(
    result.reason !== undefined && result.reason.length > 0,
    "the swallowed lookup error must be reported in the reason",
  );
  assertStringIncludes(result.reason ?? "", "api.github.com");
  assert(
    !calls.some((c) => c[0] === "issue" && c[1] === "create"),
    "a duplicate-or-nothing gamble must not create an issue",
  );
});

Deno.test("notifyAuditFailure - a failed lookup is logged, not swallowed", async () => {
  const logged: string[] = [];
  const { gh } = makeFakeGh((args) => {
    if (args[0] === "issue" && args[1] === "list") {
      throw new Error("gh: rate limited");
    }
    return "";
  });

  const result = await notifyAuditFailure({
    repo: "x/y",
    ecosystem: "deno",
    ghCommandFn: gh,
    warnFn: (message) => logged.push(message),
  });

  assertEquals(result.action, "error");
  assertEquals(logged.length, 1);
  assertStringIncludes(logged[0] ?? "", "rate limited");
});
