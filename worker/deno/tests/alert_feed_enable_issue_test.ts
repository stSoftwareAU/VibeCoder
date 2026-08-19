/**
 * Tests for alert_feed_enable_issue.ts — fail-loud enable/authorise issue filer
 * for an unavailable alert feed (Issue #3396, part of #3386 / #3394).
 *
 * Every test exercises the real functions against an injected, stateful `gh`
 * runner — no filesystem, no network. The three acceptance behaviours are
 * pinned (Issue #3396):
 *
 *   - **fail-loud:** a `feed-unavailable` (403 not-enabled / 404 no-access)
 *     outcome for an allowlisted repo files exactly one enable-feed issue;
 *   - **dedup:** a second run with the issue still open files nothing;
 *   - **allowlist:** a repo absent from `.config.json` `repos` files nothing.
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildEnableFeedBody,
  buildEnableFeedTitle,
  ENABLE_FEED_LABEL,
  enableFeedFindingId,
  type FeedUnavailable,
  isRepoAllowlisted,
  maybeFileEnableFeedIssue,
} from "../lib/alert_feeds/alert_feed_enable_issue.ts";

// ---------------------------------------------------------------------------
// A stateful in-memory `gh` fake: `issue list` returns the currently-open
// issues; `issue create` appends one and returns its URL. This lets a second
// run see the first run's issue and dedup against it — exactly the production
// `fileFindingOnce` contract.
// ---------------------------------------------------------------------------

interface FakeIssue {
  number: number;
  body: string;
  labels: string[];
}

function createGhFake(repo: string) {
  const issues: FakeIssue[] = [];
  let nextNumber = 100;
  const createCalls: string[][] = [];

  const gh = (args: string[]): Promise<string> => {
    if (args[0] === "issue" && args[1] === "list") {
      const labelIdx = args.indexOf("--label");
      const label = labelIdx >= 0 ? (args[labelIdx + 1] ?? "") : "";
      const matching = issues.filter((i) => i.labels.includes(label));
      return Promise.resolve(
        JSON.stringify(
          matching.map((i) => ({ number: i.number, body: i.body })),
        ),
      );
    }
    if (args[0] === "issue" && args[1] === "create") {
      createCalls.push(args);
      const bodyIdx = args.indexOf("--body");
      const body = bodyIdx >= 0 ? (args[bodyIdx + 1] ?? "") : "";
      const labels: string[] = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === "--label") labels.push(args[i + 1] ?? "");
      }
      const number = nextNumber++;
      issues.push({ number, body, labels });
      return Promise.resolve(`https://github.com/${repo}/issues/${number}`);
    }
    return Promise.reject(new Error(`unexpected gh args: ${args.join(" ")}`));
  };

  return { gh, issues, createCalls };
}

const UNAVAILABLE_403: FeedUnavailable = {
  status: 403,
  reason: "Code scanning is not enabled for this repository (HTTP 403)",
};
const UNAVAILABLE_404: FeedUnavailable = {
  status: 404,
  reason: "Not Found (HTTP 404)",
};

const ALLOWLIST = ["stSoftwareAU/VibeCoder", "stSoftwareAU/private-repo-14"];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

Deno.test("enableFeedFindingId - feed-keyed, matches finding-id grammar", () => {
  assertEquals(enableFeedFindingId("dependabot"), "ENABLE-FEED-dependabot");
  assertEquals(
    enableFeedFindingId("code-scanning"),
    "ENABLE-FEED-code-scanning",
  );
  // Must satisfy the finding-id marker grammar [A-Za-z0-9-]+.
  assert(/^[A-Za-z0-9-]+$/.test(enableFeedFindingId("code-scanning")));
});

Deno.test("isRepoAllowlisted - case-insensitive, whitespace-tolerant", () => {
  assert(isRepoAllowlisted("stSoftwareAU/VibeCoder", ALLOWLIST));
  assert(isRepoAllowlisted("stsoftwareau/vibecoder", ALLOWLIST));
  assert(isRepoAllowlisted("  stSoftwareAU/private-repo-14  ", ALLOWLIST));
  assert(!isRepoAllowlisted("TitlePage/tp-web-react", ALLOWLIST));
  assert(!isRepoAllowlisted("", ALLOWLIST));
});

Deno.test("buildEnableFeedTitle - names the feed and repo", () => {
  assertEquals(
    buildEnableFeedTitle("o/r", "dependabot"),
    "Enable Dependabot alerts for o/r",
  );
  assert(
    buildEnableFeedTitle("o/r", "code-scanning").includes("Code Security"),
  );
});

Deno.test("buildEnableFeedBody - embeds the dedup finding-id marker and evidence", () => {
  const body = buildEnableFeedBody("o/r", "code-scanning", UNAVAILABLE_403);
  assert(body.includes("<!-- finding-id: ENABLE-FEED-code-scanning -->"));
  // The observed status/reason are surfaced verbatim as evidence.
  assert(body.includes("HTTP 403"));
  assert(body.includes("Code scanning is not enabled"));
});

Deno.test("buildEnableFeedBody - appends an attribution footer when supplied", () => {
  const footer = "🏷️ Filed by idle-task template: alert-feed";
  const body = buildEnableFeedBody(
    "o/r",
    "dependabot",
    UNAVAILABLE_404,
    footer,
  );
  assert(body.endsWith(footer));
});

// ---------------------------------------------------------------------------
// Acceptance 1 — fail-loud: 403 not-enabled → exactly one enable-feed issue
// ---------------------------------------------------------------------------

Deno.test("acceptance - 403 not-enabled files exactly one enable-feed issue", async () => {
  const repo = "stSoftwareAU/VibeCoder";
  const { gh, issues, createCalls } = createGhFake(repo);

  const outcome = await maybeFileEnableFeedIssue({
    repo,
    feed: "code-scanning",
    unavailable: UNAVAILABLE_403,
    allowlist: ALLOWLIST,
    ghCommandFn: gh,
    logFn: () => {},
  });

  assertEquals(outcome.action, "filed");
  assertEquals(createCalls.length, 1);
  assertEquals(issues.length, 1);
  // The one issue carries the enable-feed label and the dedup marker.
  const filed = issues[0]!;
  assert(filed.labels.includes(ENABLE_FEED_LABEL));
  assert(filed.body.includes("ENABLE-FEED-code-scanning"));
});

Deno.test("acceptance - 404 no-access (Dependabot) also files one enable-feed issue", async () => {
  const repo = "stSoftwareAU/private-repo-14";
  const { gh, createCalls } = createGhFake(repo);

  const outcome = await maybeFileEnableFeedIssue({
    repo,
    feed: "dependabot",
    unavailable: UNAVAILABLE_404,
    allowlist: ALLOWLIST,
    ghCommandFn: gh,
    logFn: () => {},
  });

  assertEquals(outcome.action, "filed");
  assertEquals(createCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Acceptance 2 — dedup: second run with the issue still open files nothing
// ---------------------------------------------------------------------------

Deno.test("acceptance - second run with an open enable-feed issue files nothing", async () => {
  const repo = "stSoftwareAU/VibeCoder";
  const { gh, createCalls } = createGhFake(repo);

  const first = await maybeFileEnableFeedIssue({
    repo,
    feed: "code-scanning",
    unavailable: UNAVAILABLE_403,
    allowlist: ALLOWLIST,
    ghCommandFn: gh,
    logFn: () => {},
  });
  assertEquals(first.action, "filed");
  assertEquals(createCalls.length, 1);

  // Second run: the first issue is still open, so nothing new is filed.
  const second = await maybeFileEnableFeedIssue({
    repo,
    feed: "code-scanning",
    unavailable: UNAVAILABLE_403,
    allowlist: ALLOWLIST,
    ghCommandFn: gh,
    logFn: () => {},
  });
  assertEquals(second.action, "already-open");
  assertEquals(createCalls.length, 1); // no second create
  if (second.action === "already-open" && first.action === "filed") {
    assertEquals(second.number, first.number);
  }
});

Deno.test("dedup is per-feed - both feeds unavailable file two distinct issues", async () => {
  const repo = "stSoftwareAU/VibeCoder";
  const { gh, createCalls } = createGhFake(repo);

  const dep = await maybeFileEnableFeedIssue({
    repo,
    feed: "dependabot",
    unavailable: UNAVAILABLE_404,
    allowlist: ALLOWLIST,
    ghCommandFn: gh,
    logFn: () => {},
  });
  const code = await maybeFileEnableFeedIssue({
    repo,
    feed: "code-scanning",
    unavailable: UNAVAILABLE_403,
    allowlist: ALLOWLIST,
    ghCommandFn: gh,
    logFn: () => {},
  });

  assertEquals(dep.action, "filed");
  assertEquals(code.action, "filed");
  assertEquals(createCalls.length, 2); // one per feed
});

// ---------------------------------------------------------------------------
// Acceptance 3 — allowlist: a repo outside .config.json files nothing
// ---------------------------------------------------------------------------

Deno.test("acceptance - repo outside the allowlist files nothing", async () => {
  const repo = "TitlePage/tp-web-react"; // another instance's scope
  const { gh, createCalls, issues } = createGhFake(repo);

  const outcome = await maybeFileEnableFeedIssue({
    repo,
    feed: "dependabot",
    unavailable: UNAVAILABLE_404,
    allowlist: ALLOWLIST,
    ghCommandFn: gh,
    logFn: () => {},
  });

  assertEquals(outcome.action, "not-allowlisted");
  assertEquals(createCalls.length, 0);
  assertEquals(issues.length, 0);
});

// ---------------------------------------------------------------------------
// Fail-loud plumbing: create failure is surfaced, and every run logs the signal
// ---------------------------------------------------------------------------

Deno.test("gh create failure surfaces action file-failed (never masked)", async () => {
  const repo = "stSoftwareAU/VibeCoder";
  // list returns none (no dedup match); create rejects.
  const gh = (args: string[]): Promise<string> => {
    if (args[1] === "list") return Promise.resolve("[]");
    return Promise.reject(new Error("gh create boom"));
  };

  const outcome = await maybeFileEnableFeedIssue({
    repo,
    feed: "code-scanning",
    unavailable: UNAVAILABLE_403,
    allowlist: ALLOWLIST,
    ghCommandFn: gh,
    logFn: () => {},
  });

  assertEquals(outcome.action, "file-failed");
});

Deno.test("every run logs the feed-unavailable outcome per repo+feed", async () => {
  const repo = "stSoftwareAU/VibeCoder";
  const { gh } = createGhFake(repo);
  const logs: string[] = [];

  await maybeFileEnableFeedIssue({
    repo,
    feed: "code-scanning",
    unavailable: UNAVAILABLE_403,
    allowlist: ALLOWLIST,
    ghCommandFn: gh,
    logFn: (m) => logs.push(m),
  });

  assertEquals(logs.length, 1);
  const line = logs[0]!;
  assert(line.includes("feed-unavailable"));
  assert(line.includes(repo));
  assert(line.includes("code-scanning"));
  assert(line.includes("status=403"));
});

Deno.test("out-of-allowlist run still logs the skip (visible, not silent)", async () => {
  const repo = "TitlePage/tp-web-react";
  const { gh } = createGhFake(repo);
  const logs: string[] = [];

  await maybeFileEnableFeedIssue({
    repo,
    feed: "dependabot",
    unavailable: UNAVAILABLE_404,
    allowlist: ALLOWLIST,
    ghCommandFn: gh,
    logFn: (m) => logs.push(m),
  });

  assertEquals(logs.length, 1);
  assert(logs[0]!.includes("not in allowlist"));
});
