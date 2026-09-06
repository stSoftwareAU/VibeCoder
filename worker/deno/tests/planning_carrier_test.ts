/**
 * Tests for planning_carrier.ts (Issue #2995, part of #2993).
 *
 * Covers the worker-side carrier safety net: when a planning run ends with
 * zero sub-issues and the close is not an explicit nothing-to-do close,
 * exactly one carrier sub-issue is created, labelled for pickup, with a
 * `Part of #<parent>` body, and natively linked to the parent.
 *
 * Coverage:
 *   - hasNothingToDoSignal: label and marker-line detection, negatives.
 *   - buildCarrierTitle / buildCarrierBody: format and truncation.
 *   - parseCarrierUrl: extracts the created issue number from gh output.
 *   - Zero sub-issues + real work → carrier created and natively linked.
 *   - Zero sub-issues + nothing-to-do (label) → no carrier.
 *   - Zero sub-issues + nothing-to-do (marker line) → no carrier.
 *   - 1+ sub-issues → no carrier (idempotency / no duplicate).
 *   - Carrier-creation failure does not throw (created=false).
 *   - Link failure leaves created=true, linked=false (best-effort).
 *
 * Australian English spelling used throughout.
 */

import { assertEquals } from "@std/assert";
import {
  buildCarrierBody,
  buildCarrierTitle,
  CARRIER_SUB_ISSUE_LABEL,
  fetchNothingToDoSignal,
  hasNothingToDoSignal,
  MAX_CARRIER_TITLE_LENGTH,
  maybeCreateCarrierSubIssue,
  parseCarrierUrl,
} from "../lib/planning_carrier.ts";
import type { Logger } from "../types.ts";

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  security() {},
  skipReason() {},
  timing() {},
  scanSummary() {},
  workerSummary() {},
};

const REPO = "stSoftwareAU/Example";
const PARENT = 42;

/**
 * The fleet login and author options the nothing-to-do tests state
 * (Issue #1244).
 *
 * Stated rather than left to the configured fleet identity so no test depends
 * on a `.config.json` in the working directory.
 */
const FLEET_LOGIN = "fleet-bot";
const FLEET_OPTIONS = { fleetAuthors: [FLEET_LOGIN] };

/**
 * Build a stub gh runner that records calls and returns canned output per
 * argument-prefix match. `viewJson` is returned for the nothing-to-do fetch;
 * `createUrl` for `gh issue create`; `id` for the carrier id lookup; the
 * sub_issues POST returns "{}".
 */
function makeGh(opts: {
  viewJson?: string;
  createUrl?: string;
  id?: string;
  failCreate?: boolean;
  failLink?: boolean;
  calls: string[][];
}): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    opts.calls.push(args);
    // Nothing-to-do fetch.
    if (args[0] === "issue" && args[1] === "view") {
      return Promise.resolve(
        opts.viewJson ?? '{"labels":[],"body":"","comments":[]}',
      );
    }
    // Carrier creation.
    if (args[0] === "issue" && args[1] === "create") {
      if (opts.failCreate) return Promise.reject(new Error("create boom"));
      return Promise.resolve(
        opts.createUrl ?? `https://github.com/${REPO}/issues/99\n`,
      );
    }
    // Carrier id lookup.
    if (args[0] === "api" && args.includes("--jq")) {
      return Promise.resolve(opts.id ?? "555000\n");
    }
    // Native link POST.
    if (args[0] === "api" && args.includes("POST")) {
      if (opts.failLink) return Promise.reject(new Error("link boom"));
      return Promise.resolve("{}");
    }
    return Promise.resolve("");
  };
}

// ---------------------------------------------------------------------------
// hasNothingToDoSignal
// ---------------------------------------------------------------------------

Deno.test("hasNothingToDoSignal - detects invalid/duplicate/wontfix labels", () => {
  assertEquals(hasNothingToDoSignal(["invalid"], []), true);
  assertEquals(hasNothingToDoSignal(["Duplicate"], []), true);
  assertEquals(hasNothingToDoSignal(["bug", "wontfix"], []), true);
});

Deno.test("hasNothingToDoSignal - detects the marker line in text", () => {
  assertEquals(
    hasNothingToDoSignal([], ["Nothing to do — already implemented in #1"]),
    true,
  );
  assertEquals(
    hasNothingToDoSignal([], ["preamble\nNothing to do: duplicate"]),
    true,
  );
  assertEquals(hasNothingToDoSignal([], ["nothing to do - invalid"]), true);
});

Deno.test("hasNothingToDoSignal - negative when neither signal present", () => {
  assertEquals(
    hasNothingToDoSignal(["bug", "enhancement"], ["Real work remains here."]),
    false,
  );
  assertEquals(hasNothingToDoSignal([], ["I have nothing to do today"]), false);
});

// ---------------------------------------------------------------------------
// buildCarrierTitle / buildCarrierBody
// ---------------------------------------------------------------------------

Deno.test("buildCarrierTitle - includes parent number and title", () => {
  assertEquals(
    buildCarrierTitle(7, "Fix the parser"),
    "Implement remaining work from #7: Fix the parser",
  );
});

Deno.test("buildCarrierTitle - handles empty title and truncates long titles", () => {
  assertEquals(buildCarrierTitle(7, "   "), "Implement remaining work from #7");
  const long = buildCarrierTitle(7, "x".repeat(500));
  assertEquals(long.length, MAX_CARRIER_TITLE_LENGTH);
  assertEquals(long.endsWith("…"), true);
});

Deno.test("buildCarrierBody - includes the Part of link", () => {
  const body = buildCarrierBody(42);
  assertEquals(body.includes("Part of #42"), true);
  assertEquals(body.includes("Acceptance criteria"), true);
});

// ---------------------------------------------------------------------------
// parseCarrierUrl
// ---------------------------------------------------------------------------

Deno.test("parseCarrierUrl - extracts number from the last matching URL", () => {
  const out = `Creating issue...\nhttps://github.com/${REPO}/issues/123\n`;
  assertEquals(parseCarrierUrl(out, REPO), {
    url: `https://github.com/${REPO}/issues/123`,
    number: 123,
  });
});

Deno.test("parseCarrierUrl - returns null when no matching URL", () => {
  assertEquals(parseCarrierUrl("no url here", REPO), null);
});

Deno.test("parseCarrierUrl - ignores issue URLs from a different repo", () => {
  const out = `https://github.com/other/repo/issues/7\n`;
  assertEquals(parseCarrierUrl(out, REPO), null);
});

// ---------------------------------------------------------------------------
// maybeCreateCarrierSubIssue
// ---------------------------------------------------------------------------

Deno.test("maybeCreateCarrierSubIssue - zero sub-issues + real work creates and links carrier", async () => {
  const calls: string[][] = [];
  const gh = makeGh({
    calls,
    viewJson:
      '{"labels":[{"name":"bug"}],"body":"Real work here","comments":[]}',
    createUrl: `https://github.com/${REPO}/issues/99\n`,
    id: "555000\n",
  });

  const outcome = await maybeCreateCarrierSubIssue({
    repo: REPO,
    parentIssueNumber: PARENT,
    parentIssueTitle: "Tidy the thing",
    subIssueNumbers: [],
    ghCommandFn: gh,
    logger: silentLogger,
  });

  assertEquals(outcome.created, true);
  assertEquals(outcome.carrierNumber, 99);
  assertEquals(outcome.linked, true);

  // Created with the carrier label.
  const createCall = calls.find((c) => c[0] === "issue" && c[1] === "create");
  assertEquals(createCall?.includes("--label"), true);
  assertEquals(createCall?.includes(CARRIER_SUB_ISSUE_LABEL), true);

  // Linked the carrier's internal id to the parent.
  const linkCall = calls.find(
    (c) =>
      c[0] === "api" && c.includes("POST") &&
      c.some((a) => a.includes("sub_issues")),
  );
  assertEquals(linkCall?.includes("sub_issue_id=555000"), true);
});

Deno.test("maybeCreateCarrierSubIssue - nothing-to-do label skips carrier", async () => {
  const calls: string[][] = [];
  const gh = makeGh({
    calls,
    viewJson:
      '{"labels":[{"name":"duplicate"}],"body":"dupe of #1","comments":[]}',
  });

  const outcome = await maybeCreateCarrierSubIssue({
    repo: REPO,
    parentIssueNumber: PARENT,
    parentIssueTitle: "x",
    subIssueNumbers: [],
    ghCommandFn: gh,
    logger: silentLogger,
  });

  assertEquals(outcome.created, false);
  assertEquals(outcome.skippedReason, "nothing-to-do");
  assertEquals(calls.some((c) => c[0] === "issue" && c[1] === "create"), false);
});

// The marker comment now needs a fleet author: a comment thread is writable
// by anyone and this signal disables the safety net (Issue #1244).
Deno.test("maybeCreateCarrierSubIssue - nothing-to-do marker line skips carrier", async () => {
  const calls: string[][] = [];
  const gh = makeGh({
    calls,
    viewJson: JSON.stringify({
      labels: [],
      body: "",
      comments: [{
        body: "Nothing to do — already implemented in #1",
        author: { login: FLEET_LOGIN },
      }],
    }),
  });

  const outcome = await maybeCreateCarrierSubIssue({
    repo: REPO,
    parentIssueNumber: PARENT,
    parentIssueTitle: "x",
    subIssueNumbers: [],
    ghCommandFn: gh,
    logger: silentLogger,
    authorOptions: FLEET_OPTIONS,
  });

  assertEquals(outcome.created, false);
  assertEquals(outcome.skippedReason, "nothing-to-do");
});

// ---------------------------------------------------------------------------
// Nothing-to-do author verification (Issue #1244)
// ---------------------------------------------------------------------------

Deno.test("maybeCreateCarrierSubIssue - an outsider's nothing-to-do comment still creates the carrier", async () => {
  const calls: string[][] = [];
  const warnings: string[] = [];
  const gh = makeGh({
    calls,
    viewJson: JSON.stringify({
      labels: [{ name: "enhancement" }],
      body: "Real work remains here.",
      comments: [{
        body: "Nothing to do — dupe",
        author: { login: "outsider" },
      }],
    }),
  });

  const outcome = await maybeCreateCarrierSubIssue({
    repo: REPO,
    parentIssueNumber: PARENT,
    parentIssueTitle: "Tidy the thing",
    subIssueNumbers: [],
    ghCommandFn: gh,
    logger: { ...silentLogger, warn: (m: string) => warnings.push(m) },
    authorOptions: FLEET_OPTIONS,
  });

  assertEquals(outcome.created, true);
  assertEquals(outcome.skippedReason, undefined);
  assertEquals(calls.some((c) => c[0] === "issue" && c[1] === "create"), true);
  assertEquals(
    warnings.some((w) => w.includes("authored outside the fleet")),
    true,
  );
});

Deno.test("fetchNothingToDoSignal - an unresolved fleet discards every marker comment", async () => {
  const warnings: string[] = [];
  const calls: string[][] = [];
  const gh = makeGh({
    calls,
    viewJson: JSON.stringify({
      labels: [],
      body: "",
      comments: [{
        body: "Nothing to do — dupe",
        author: { login: FLEET_LOGIN },
      }],
    }),
  });

  const signalled = await fetchNothingToDoSignal(
    REPO,
    PARENT,
    gh,
    { fleetAuthors: [] },
    (m) => warnings.push(m),
  );

  assertEquals(signalled, false);
  assertEquals(
    warnings.some((w) => w.includes("fleet author set unresolved")),
    true,
  );
});

Deno.test("fetchNothingToDoSignal - a fleet comment and the parent body are both honoured", async () => {
  const calls: string[][] = [];
  const fleetComment = await fetchNothingToDoSignal(
    REPO,
    PARENT,
    makeGh({
      calls,
      viewJson: JSON.stringify({
        labels: [],
        body: "",
        comments: [{
          body: "Nothing to do — duplicate of #1",
          author: { login: "FLEET-BOT" },
        }],
      }),
    }),
    FLEET_OPTIONS,
    () => {},
  );
  assertEquals(fleetComment, true);

  // The body is the artefact being planned, not third-party commentary, so it
  // is read unfiltered — as is a triage-permission label.
  const bodyMarker = await fetchNothingToDoSignal(
    REPO,
    PARENT,
    makeGh({
      calls,
      viewJson: JSON.stringify({
        labels: [],
        body: "Nothing to do — already implemented",
        comments: [],
      }),
    }),
    FLEET_OPTIONS,
    () => {},
  );
  assertEquals(bodyMarker, true);
});

Deno.test("maybeCreateCarrierSubIssue - existing sub-issues skip carrier (no duplicate)", async () => {
  const calls: string[][] = [];
  const gh = makeGh({ calls });

  const outcome = await maybeCreateCarrierSubIssue({
    repo: REPO,
    parentIssueNumber: PARENT,
    parentIssueTitle: "x",
    subIssueNumbers: [101],
    ghCommandFn: gh,
    logger: silentLogger,
  });

  assertEquals(outcome.created, false);
  assertEquals(outcome.skippedReason, "has-sub-issues");
  // Did not even query the nothing-to-do signal.
  assertEquals(calls.length, 0);
});

Deno.test("maybeCreateCarrierSubIssue - create failure does not throw (created=false)", async () => {
  const calls: string[][] = [];
  const gh = makeGh({ calls, failCreate: true });

  const outcome = await maybeCreateCarrierSubIssue({
    repo: REPO,
    parentIssueNumber: PARENT,
    parentIssueTitle: "x",
    subIssueNumbers: [],
    ghCommandFn: gh,
    logger: silentLogger,
  });

  assertEquals(outcome.created, false);
});

Deno.test("maybeCreateCarrierSubIssue - link failure leaves created=true, linked=false", async () => {
  const calls: string[][] = [];
  const gh = makeGh({
    calls,
    createUrl: `https://github.com/${REPO}/issues/99\n`,
    id: "555000\n",
    failLink: true,
  });

  const outcome = await maybeCreateCarrierSubIssue({
    repo: REPO,
    parentIssueNumber: PARENT,
    parentIssueTitle: "x",
    subIssueNumbers: [],
    ghCommandFn: gh,
    logger: silentLogger,
  });

  assertEquals(outcome.created, true);
  assertEquals(outcome.linked, false);
});
