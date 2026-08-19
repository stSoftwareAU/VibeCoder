/**
 * Tests for the escape-hatch follow-up label strip (Issue #2824).
 *
 *   - `parseFollowUpIssueRef`        — same-repo `#NNN` and cross-repo
 *                                      `owner/repo#NNN` parsing.
 *   - `stripReservedLabelsFromFollowUp` — strips reserved labels from the
 *                                      follow-up issue, preserves descriptive
 *                                      ones, and is non-fatal end to end.
 *
 * Mirrors `reserved_label_strip_test.ts`. Verifies that a follow-up carrying a
 * reserved label ends up without it after detection, that descriptive labels
 * survive, that both ref forms are handled, and that a deliberate
 * `escalateToHuman`-style `needs-human` add to a *separate* existing issue is
 * never touched by this guard.
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import type { GitHubIssue, Logger } from "../types.ts";
import {
  parseFollowUpIssueRef,
  stripReservedLabelsFromFollowUp,
  stripReservedLabelsFromModelFollowUp,
} from "../lib/escape_hatch_label_strip.ts";
import { RESERVED_LABELS } from "../lib/config_defaults.ts";

/** A logger that records warn calls (message + context) for assertions. */
function recordingLogger(): {
  logger: Logger;
  warnings: Array<{ msg: string; context?: Record<string, unknown> }>;
} {
  const warnings: Array<{ msg: string; context?: Record<string, unknown> }> =
    [];
  const noop = () => {};
  const logger: Logger = {
    info: noop,
    warn: (msg: string, context?: Record<string, unknown>) =>
      warnings.push({ msg, context }),
    error: noop,
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, warnings };
}

const RESERVED = "top-priority";

function assertReserved(label: string) {
  assert(
    RESERVED_LABELS.includes(label),
    `test precondition: '${label}' must be a reserved label`,
  );
}

/**
 * A fake GitHub client recording each `getIssue`/`removeLabel` call.
 * `labelsByIssue` is keyed by `"repo#number"` so cross-repo refs are
 * distinguishable. `failRead` injects a non-fatal read failure.
 */
function fakeClient(opts: {
  labelsByIssue: Record<string, string[]>;
  failRead?: boolean;
}) {
  const removeCalls: Array<{ repo: string; issue: number; label: string }> = [];
  const getCalls: Array<{ repo: string; issue: number }> = [];
  const ghClient = {
    getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
      getCalls.push({ repo, issue: issueNumber });
      if (opts.failRead) return Promise.reject(new Error("read failed"));
      return Promise.resolve({
        number: issueNumber,
        title: "t",
        body: "",
        labels: opts.labelsByIssue[`${repo}#${issueNumber}`] ?? [],
        author: "a",
        assignees: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
    removeLabel(
      repo: string,
      issueNumber: number,
      label: string,
    ): Promise<void> {
      removeCalls.push({ repo, issue: issueNumber, label });
      return Promise.resolve();
    },
  };
  return { ghClient, removeCalls, getCalls };
}

// ---------------------------------------------------------------------------
// parseFollowUpIssueRef
// ---------------------------------------------------------------------------

Deno.test("parseFollowUpIssueRef - same-repo bare #NNN resolves against currentRepo", () => {
  assertEquals(parseFollowUpIssueRef("#123", "owner/repo"), {
    repo: "owner/repo",
    issueNumber: 123,
  });
});

Deno.test("parseFollowUpIssueRef - cross-repo owner/repo#NNN keeps its own repo", () => {
  assertEquals(parseFollowUpIssueRef("other/proj#7", "owner/repo"), {
    repo: "other/proj",
    issueNumber: 7,
  });
});

Deno.test("parseFollowUpIssueRef - surrounding whitespace is trimmed", () => {
  assertEquals(parseFollowUpIssueRef("  #42  ", "owner/repo"), {
    repo: "owner/repo",
    issueNumber: 42,
  });
});

Deno.test("parseFollowUpIssueRef - unparseable ref returns undefined", () => {
  assertEquals(parseFollowUpIssueRef("not-a-ref", "owner/repo"), undefined);
  assertEquals(parseFollowUpIssueRef("", "owner/repo"), undefined);
  assertEquals(parseFollowUpIssueRef("#", "owner/repo"), undefined);
});

// ---------------------------------------------------------------------------
// stripReservedLabelsFromFollowUp
// ---------------------------------------------------------------------------

Deno.test("stripReservedLabelsFromFollowUp - strips a reserved label from a same-repo follow-up", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { "owner/repo#50": [RESERVED, "bug"] },
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromFollowUp({
    issueRef: "#50",
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  // The reserved label is removed from the same-repo follow-up.
  assertEquals(removeCalls, [{
    repo: "owner/repo",
    issue: 50,
    label: RESERVED,
  }]);
});

Deno.test("stripReservedLabelsFromFollowUp - strips a reserved label from an allowlisted cross-repo follow-up", async () => {
  // Issue #3074: a cross-repo strip is now only performed when the target is on
  // the monitored-repo allowlist (or is the current repo). This test was
  // previously unconditional; it now passes the target via `allowedRepos` to
  // verify legitimate, configured cross-repo hand-offs still work.
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { "other/proj#9": [RESERVED, "enhancement"] },
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromFollowUp({
    issueRef: "other/proj#9",
    currentRepo: "owner/repo",
    allowedRepos: ["owner/repo", "other/proj"],
    ghClient,
    logger,
  });

  // Removed from the cross-repo follow-up, not the current repo.
  assertEquals(removeCalls, [{
    repo: "other/proj",
    issue: 9,
    label: RESERVED,
  }]);
});

Deno.test("stripReservedLabelsFromFollowUp - off-allowlist cross-repo ref is ignored (Issue #3074)", async () => {
  // A prompt-injection payload could steer Claude to emit a cross-repo ref to
  // an arbitrary victim repo. Without the target on the allowlist the strip
  // must be skipped — no getIssue, no removeLabel — and a warning logged.
  assertReserved(RESERVED);
  const { ghClient, removeCalls, getCalls } = fakeClient({
    labelsByIssue: { "victim/repo#1": [RESERVED, "work-on"] },
  });
  const { logger, warnings } = recordingLogger();

  await stripReservedLabelsFromFollowUp({
    issueRef: "victim/repo#1",
    currentRepo: "owner/repo",
    allowedRepos: ["owner/repo", "other/proj"],
    ghClient,
    logger,
  });

  assertEquals(getCalls.length, 0, "must not read the off-allowlist issue");
  assertEquals(
    removeCalls.length,
    0,
    "must not mutate the off-allowlist issue",
  );
  assert(
    warnings.some((w) => w.msg.includes("cross-repo target is not")),
    "expected a non-fatal off-allowlist warning",
  );
});

Deno.test("stripReservedLabelsFromFollowUp - cross-repo ref with no allowlist is ignored (secure default, Issue #3074)", async () => {
  // When no allowlist is supplied only the current repo is permitted, so any
  // cross-repo ref is denied by default.
  assertReserved(RESERVED);
  const { ghClient, removeCalls, getCalls } = fakeClient({
    labelsByIssue: { "other/proj#9": [RESERVED] },
  });
  const { logger, warnings } = recordingLogger();

  await stripReservedLabelsFromFollowUp({
    issueRef: "other/proj#9",
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  assertEquals(getCalls.length, 0);
  assertEquals(removeCalls.length, 0);
  assert(
    warnings.some((w) => w.msg.includes("cross-repo target is not")),
    "expected a non-fatal off-allowlist warning",
  );
});

Deno.test("stripReservedLabelsFromFollowUp - bare #NNN is unaffected by allowlist (Issue #3074)", async () => {
  // The bare same-repo form always resolves to currentRepo, so it is permitted
  // regardless of the allowlist contents.
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { "owner/repo#5": [RESERVED, "bug"] },
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromFollowUp({
    issueRef: "#5",
    currentRepo: "owner/repo",
    allowedRepos: [], // empty allowlist must not block the same-repo strip
    ghClient,
    logger,
  });

  assertEquals(removeCalls, [{
    repo: "owner/repo",
    issue: 5,
    label: RESERVED,
  }]);
});

Deno.test("stripReservedLabelsFromFollowUp - descriptive labels are preserved", async () => {
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { "owner/repo#3": ["bug", "enhancement", "documentation"] },
  });
  const { logger, warnings } = recordingLogger();

  await stripReservedLabelsFromFollowUp({
    issueRef: "#3",
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  assertEquals(removeCalls.length, 0);
  assertEquals(warnings.length, 0);
});

Deno.test("stripReservedLabelsFromFollowUp - undefined ref is a no-op", async () => {
  const { ghClient, removeCalls, getCalls } = fakeClient({ labelsByIssue: {} });
  const { logger, warnings } = recordingLogger();

  await stripReservedLabelsFromFollowUp({
    issueRef: undefined,
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  assertEquals(getCalls.length, 0);
  assertEquals(removeCalls.length, 0);
  assertEquals(warnings.length, 0);
});

Deno.test("stripReservedLabelsFromFollowUp - unparseable ref logs and does not call gh", async () => {
  const { ghClient, getCalls } = fakeClient({ labelsByIssue: {} });
  const { logger, warnings } = recordingLogger();

  await stripReservedLabelsFromFollowUp({
    issueRef: "garbage",
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  assertEquals(getCalls.length, 0);
  assert(
    warnings.some((w) => w.msg.includes("Could not parse")),
    "expected a non-fatal parse-failure warning",
  );
});

Deno.test("stripReservedLabelsFromFollowUp - a read failure is logged, not thrown", async () => {
  assertReserved(RESERVED);
  const { ghClient } = fakeClient({
    labelsByIssue: { "owner/repo#8": [RESERVED] },
    failRead: true,
  });
  const { logger, warnings } = recordingLogger();

  // Must not throw — the escape-hatch hand-off result is unchanged.
  await stripReservedLabelsFromFollowUp({
    issueRef: "#8",
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  assert(
    warnings.some((w) => w.msg.includes("Failed to read labels")),
    "expected a non-fatal read-failure warning",
  );
});

Deno.test("stripReservedLabelsFromFollowUp - deliberate escalateToHuman add on a separate issue is untouched", async () => {
  // The guard only ever reads/modifies the follow-up named in issueRef. The
  // deliberate `escalateToHuman` path (Issue #1471) adds `needs-human` to a
  // *different* existing issue, post-creation, via a separate code path — it
  // is on another issue number, so this guard never reads or touches it.
  const { ghClient, removeCalls, getCalls } = fakeClient({
    // #100 is the follow-up Claude created (the ref). #200 is the
    // deliberately-escalated existing issue — NOT the ref.
    labelsByIssue: {
      "owner/repo#100": [RESERVED],
      "owner/repo#200": ["needs-human", "bug"],
    },
  });
  const { logger } = recordingLogger();

  await stripReservedLabelsFromFollowUp({
    issueRef: "#100",
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  // Only the follow-up (#100) is read and scrubbed; the escalated #200 is
  // never even read, so its deliberate `needs-human` is left intact.
  assertEquals(getCalls, [{ repo: "owner/repo", issue: 100 }]);
  assertEquals(removeCalls, [{
    repo: "owner/repo",
    issue: 100,
    label: RESERVED,
  }]);
  assert(
    !getCalls.some((c) => c.issue === 200),
    "the deliberately-escalated issue must never be read",
  );
});

// ---------------------------------------------------------------------------
// Issue #3708 — the strip reports failure, retries, and covers every path
// ---------------------------------------------------------------------------

/**
 * A client whose `removeLabel` fails for the first `failures` calls and then
 * succeeds — models a transient API error the old code hid behind a warning.
 */
function flakyClient(opts: { labels: string[]; failures: number }) {
  let remaining = opts.failures;
  const removeCalls: Array<{ issue: number; label: string }> = [];
  const ghClient = {
    getIssue(_repo: string, issueNumber: number): Promise<GitHubIssue> {
      return Promise.resolve({
        number: issueNumber,
        title: "t",
        body: "",
        labels: opts.labels,
        author: "a",
        assignees: [],
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
      });
    },
    removeLabel(
      _repo: string,
      issueNumber: number,
      label: string,
    ): Promise<void> {
      if (remaining > 0) {
        remaining--;
        return Promise.reject(new Error("transient API error"));
      }
      removeCalls.push({ issue: issueNumber, label });
      return Promise.resolve();
    },
  };
  return { ghClient, removeCalls };
}

Deno.test("stripReservedLabelsFromFollowUp - a transient removal failure is retried and then succeeds", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = flakyClient({
    labels: [RESERVED],
    failures: 1,
  });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromFollowUp({
    issueRef: "#501",
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  assert(result.ok, "the retry must recover the transient failure");
  assertEquals(removeCalls, [{ issue: 501, label: RESERVED }]);
});

Deno.test("stripReservedLabelsFromFollowUp - a persistent removal failure is returned, not swallowed", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = flakyClient({
    labels: [RESERVED],
    failures: 99,
  });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromFollowUp({
    issueRef: "#502",
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  assertEquals(removeCalls, []);
  assert(
    !result.ok,
    "a follow-up still carrying a reserved label is a failure",
  );
  assertEquals(result.error.summary.failures[0]?.label, RESERVED);
});

Deno.test("stripReservedLabelsFromFollowUp - an unparseable ref is reported as a failure", async () => {
  const { ghClient, getCalls } = fakeClient({ labelsByIssue: {} });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromFollowUp({
    issueRef: "not-an-issue-ref",
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  assertEquals(getCalls.length, 0);
  assert(!result.ok, "an unparseable ref means the guard did not apply");
  assertEquals(result.error.summary.failures[0]?.stage, "parse");
});

Deno.test("stripReservedLabelsFromFollowUp - never strips the issue the run is working on", async () => {
  assertReserved(RESERVED);
  // The run is working on #77 and the model's text names it. Removing a
  // human-applied reserved label from live work would be the worst outcome.
  const { ghClient, removeCalls, getCalls } = fakeClient({
    labelsByIssue: { "owner/repo#77": [RESERVED] },
  });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromFollowUp({
    issueRef: "#77",
    currentRepo: "owner/repo",
    excludeIssueNumber: 77,
    ghClient,
    logger,
  });

  assert(result.ok, "a self-reference is not a strip failure");
  assertEquals(removeCalls, []);
  assertEquals(getCalls.length, 0);
});

// ---------------------------------------------------------------------------
// stripReservedLabelsFromModelFollowUp — the message-level entry point
// ---------------------------------------------------------------------------

Deno.test("stripReservedLabelsFromModelFollowUp - strips the follow-up named in Claude's own text", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { "owner/repo#909": [RESERVED, "bug"] },
  });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromModelFollowUp({
    message: "This is out of scope for the CI fix, so I opened follow-up " +
      "issue #909 with the analysis.",
    currentRepo: "owner/repo",
    excludeIssueNumber: 12,
    ghClient,
    logger,
  });

  assert(result.ok);
  assertEquals(removeCalls, [
    { repo: "owner/repo", issue: 909, label: RESERVED },
  ]);
});

Deno.test("stripReservedLabelsFromModelFollowUp - an ordinary message makes no GitHub call", async () => {
  const { ghClient, getCalls } = fakeClient({
    labelsByIssue: { "owner/repo#909": [RESERVED] },
  });
  const { logger } = recordingLogger();
  let allowlistLoaded = false;

  const result = await stripReservedLabelsFromModelFollowUp({
    message: "I fixed the failing test in src/foo.ts; see #909 for context.",
    currentRepo: "owner/repo",
    loadAllowedRepos: () => {
      allowlistLoaded = true;
      return Promise.resolve(["owner/repo"]);
    },
    ghClient,
    logger,
  });

  assert(result.ok);
  assertEquals(getCalls.length, 0);
  assertEquals(
    allowlistLoaded,
    false,
    "the allowlist must only be read once a hand-off is detected",
  );
});

Deno.test("stripReservedLabelsFromModelFollowUp - an allowlisted cross-repo follow-up is stripped", async () => {
  assertReserved(RESERVED);
  const { ghClient, removeCalls } = fakeClient({
    labelsByIssue: { "owner/dep#5": [RESERVED, "enhancement"] },
  });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromModelFollowUp({
    message: "The root cause is in the dependency — out of scope here. " +
      "Opened follow-up issue owner/dep#5.",
    currentRepo: "owner/repo",
    loadAllowedRepos: () => Promise.resolve(["owner/repo", "owner/dep"]),
    ghClient,
    logger,
  });

  assert(result.ok);
  assertEquals(removeCalls, [
    { repo: "owner/dep", issue: 5, label: RESERVED },
  ]);
});

Deno.test("stripReservedLabelsFromModelFollowUp - no message is a no-op", async () => {
  const { ghClient, getCalls } = fakeClient({ labelsByIssue: {} });
  const { logger } = recordingLogger();

  const result = await stripReservedLabelsFromModelFollowUp({
    message: undefined,
    currentRepo: "owner/repo",
    ghClient,
    logger,
  });

  assert(result.ok);
  assertEquals(getCalls.length, 0);
});
