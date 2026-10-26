/**
 * Owned, open, fleet-authored artefact reuse (Issue #3854).
 *
 * Calls the real functions with an injected `gh` fake and explicit fleet
 * authors, so no test touches the network or reads a config file.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  findOwnedOpenArtefact,
  verifyOwnedOpenIssue,
} from "../lib/owned_open_artefact.ts";
import type { GhCommandFn } from "../lib/issue_routing_github.ts";

const REPO = "stSoftwareAU/VibeCoder";
const FLEET = ["fleet-bot"];
const ISSUE_MARKER = "<!-- issue-routing";
const PR_MARKER = "milestone-fix/";

/** A `gh` fake that answers with `stdout` and records every argv it was given. */
function ghReturning(stdout: string): { gh: GhCommandFn; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhCommandFn = (args) => {
    calls.push(args);
    return Promise.resolve(stdout);
  };
  return { gh, calls };
}

/** A `gh` fake that fails the way `runGhCommand` does: a rejected promise. */
function ghFailing(message: string): GhCommandFn {
  return () => Promise.reject(new Error(message));
}

function issueRow(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: "Stale finding",
    body: `${ISSUE_MARKER} finding=abc -->\nreport`,
    author: { login: "fleet-bot" },
    url: `https://github.com/${REPO}/issues/${number}`,
    state: "OPEN",
    ...overrides,
  };
}

function prRow(number: number, overrides: Record<string, unknown> = {}) {
  return {
    number,
    url: `https://github.com/${REPO}/pull/${number}`,
    headRefName: `${PR_MARKER}issue-1-fix`,
    author: { login: "fleet-bot" },
    isCrossRepository: false,
    state: "OPEN",
    ...overrides,
  };
}

function issueLookup(rows: unknown[], log: string[] = []) {
  const { gh, calls } = ghReturning(JSON.stringify(rows));
  return {
    calls,
    log,
    run: () =>
      findOwnedOpenArtefact({
        repo: REPO,
        kind: "issue",
        marker: ISSUE_MARKER,
        ghCommandFn: gh,
        authors: { fleetAuthors: FLEET },
        log: (m) => log.push(m),
      }),
  };
}

function prLookup(rows: unknown[], base?: string, log: string[] = []) {
  const { gh, calls } = ghReturning(JSON.stringify(rows));
  return {
    calls,
    log,
    run: () =>
      findOwnedOpenArtefact({
        repo: REPO,
        kind: "pr",
        marker: PR_MARKER,
        ghCommandFn: gh,
        base,
        authors: { fleetAuthors: FLEET },
        log: (m) => log.push(m),
      }),
  };
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

Deno.test("owned open artefact - an owned open fleet issue is returned", async () => {
  const found = await issueLookup([issueRow(12)]).run();
  assertEquals(found?.number, 12);
  assertEquals(found?.url, `https://github.com/${REPO}/issues/12`);
});

Deno.test("owned open artefact - a foreign-authored owned issue is not reused", async () => {
  const log: string[] = [];
  const found = await issueLookup(
    [issueRow(12, { author: { login: "stranger" } })],
    log,
  ).run();
  assertEquals(found, null);
  assert(
    log.some((m) => m.includes("ignored 1 marker match(es)")),
    "the foreign-authored match was not logged as discarded",
  );
});

Deno.test("owned open artefact - an issue missing the marker is not reused", async () => {
  const found = await issueLookup([
    issueRow(12, { body: "no marker here" }),
  ]).run();
  assertEquals(found, null);
});

Deno.test("owned open artefact - an issue rejected by accept is not reused", async () => {
  const { gh } = ghReturning(JSON.stringify([issueRow(12)]));
  const found = await findOwnedOpenArtefact({
    repo: REPO,
    kind: "issue",
    marker: ISSUE_MARKER,
    ghCommandFn: gh,
    accept: () => false,
    authors: { fleetAuthors: FLEET },
    log: () => {},
  });
  assertEquals(found, null);
});

Deno.test("owned open artefact - a closed owned issue is not reused", async () => {
  const found = await issueLookup([issueRow(12, { state: "CLOSED" })]).run();
  assertEquals(found, null);
});

Deno.test("owned open artefact - the lowest-numbered owned match is chosen", async () => {
  const found = await issueLookup([
    issueRow(30),
    issueRow(7),
    issueRow(19),
  ]).run();
  assertEquals(found?.number, 7);
});

Deno.test("owned open artefact - search is passed to gh issue list", async () => {
  const { gh, calls } = ghReturning("[]");
  await findOwnedOpenArtefact({
    repo: REPO,
    kind: "issue",
    marker: ISSUE_MARKER,
    ghCommandFn: gh,
    search: "in:title Stale",
    authors: { fleetAuthors: FLEET },
    log: () => {},
  });
  const args = calls[0] ?? [];
  const at = args.indexOf("--search");
  assert(at >= 0, "gh issue list was not given --search");
  assertEquals(args[at + 1], "in:title Stale");
  assertEquals(args.slice(0, 2), ["issue", "list"]);
  assertEquals(args[args.indexOf("--limit") + 1], "200");
});

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

Deno.test("owned open artefact - an owned open fleet PR is returned with its url", async () => {
  const found = await prLookup([prRow(44)]).run();
  assertEquals(found?.number, 44);
  assertEquals(found?.url, `https://github.com/${REPO}/pull/44`);
  assertEquals(found?.headRefName, `${PR_MARKER}issue-1-fix`);
});

Deno.test("owned open artefact - a prefix match from another repository is not reused", async () => {
  const found = await prLookup([prRow(44, { isCrossRepository: true })]).run();
  assertEquals(found, null);
});

Deno.test("owned open artefact - a prefix match by a foreign author is not reused", async () => {
  const found = await prLookup([
    prRow(44, { author: { login: "stranger" } }),
  ]).run();
  assertEquals(found, null);
});

Deno.test("owned open artefact - base is passed as --base to gh pr list", async () => {
  const lookup = prLookup([], "milestone/3.2");
  await lookup.run();
  const args = lookup.calls[0] ?? [];
  assertEquals(args.slice(0, 2), ["pr", "list"]);
  assertEquals(args[args.indexOf("--base") + 1], "milestone/3.2");
  assertEquals(args[args.indexOf("--limit") + 1], "100");
});

// ---------------------------------------------------------------------------
// Author set, failure and limit
// ---------------------------------------------------------------------------

Deno.test("owned open artefact - an unresolved fleet set returns null and logs it", async () => {
  const log: string[] = [];
  const { gh } = ghReturning(JSON.stringify([issueRow(12)]));
  const found = await findOwnedOpenArtefact({
    repo: REPO,
    kind: "issue",
    marker: ISSUE_MARKER,
    ghCommandFn: gh,
    authors: { fleetAuthors: [] },
    log: (m) => log.push(m),
  });
  assertEquals(found, null);
  assert(
    log.some((m) => m.includes("fleet author set unresolved")),
    "an unresolved fleet set was not logged",
  );
  // The log states the consequence: nothing is reused or written to.
  assert(
    log.some((m) => m.includes("so none is reused or written to")),
    `the consequence was not logged: ${JSON.stringify(log)}`,
  );
});

Deno.test("owned open artefact - a gh failure throws with repo, kind and stderr", async () => {
  await assertRejects(
    () =>
      findOwnedOpenArtefact({
        repo: REPO,
        kind: "pr",
        marker: PR_MARKER,
        ghCommandFn: ghFailing("GraphQL: rate limited\nretry later"),
        authors: { fleetAuthors: FLEET },
        log: () => {},
      }),
    Error,
    `Owned pr lookup in ${REPO} failed: GraphQL: rate limited`,
  );
});

Deno.test("owned open artefact - invalid JSON throws instead of reading as no match", async () => {
  const { gh } = ghReturning("not json at all");
  await assertRejects(
    () =>
      findOwnedOpenArtefact({
        repo: REPO,
        kind: "issue",
        marker: ISSUE_MARKER,
        ghCommandFn: gh,
        authors: { fleetAuthors: FLEET },
        log: () => {},
      }),
    Error,
    "returned invalid JSON",
  );
});

Deno.test("owned open artefact - a row with a bad shape throws", async () => {
  await assertRejects(
    () => issueLookup([{ number: "twelve", state: "OPEN", url: "u" }]).run(),
    Error,
    "unexpected shape",
  );
});

Deno.test("owned open artefact - a listing that reaches the limit throws", async () => {
  const full = Array.from({ length: 200 }, (_, i) => issueRow(i + 1));
  await assertRejects(
    () => issueLookup(full).run(),
    Error,
    "returned the limit of 200 results",
  );
});

Deno.test("owned open artefact - a PR listing that reaches the limit throws", async () => {
  const full = Array.from({ length: 100 }, (_, i) => prRow(i + 1));
  await assertRejects(
    () => prLookup(full).run(),
    Error,
    "returned the limit of 100 results",
  );
});

// ---------------------------------------------------------------------------
// verifyOwnedOpenIssue
// ---------------------------------------------------------------------------

function viewOf(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    number: 12,
    url: `https://github.com/${REPO}/issues/12`,
    state: "OPEN",
    body: `${ISSUE_MARKER} finding=abc -->\nreport`,
    author: { login: "fleet-bot" },
    ...overrides,
  });
}

function verify(
  stdout: string,
  extra: { authors?: { fleetAuthors: string[] } } = {},
) {
  const { gh, calls } = ghReturning(stdout);
  return {
    calls,
    run: () =>
      verifyOwnedOpenIssue({
        repo: REPO,
        number: 12,
        marker: ISSUE_MARKER,
        ghCommandFn: gh,
        authors: extra.authors ?? { fleetAuthors: FLEET },
        log: () => {},
      }),
  };
}

Deno.test("owned open artefact - verify accepts an open, marked, fleet-authored issue", async () => {
  const lookup = verify(viewOf());
  const verdict = await lookup.run();
  assertEquals(verdict, {
    ok: true,
    url: `https://github.com/${REPO}/issues/12`,
  });
  assertEquals(lookup.calls[0]?.slice(0, 2), ["issue", "view"]);
});

Deno.test("owned open artefact - verify refuses a closed issue and names the state", async () => {
  const verdict = await verify(viewOf({ state: "CLOSED" })).run();
  assertEquals(verdict.ok, false);
  if (!verdict.ok) assert(verdict.reason.includes("state is CLOSED"));
});

Deno.test("owned open artefact - verify refuses a body without the marker", async () => {
  const verdict = await verify(viewOf({ body: "plain body" })).run();
  assertEquals(verdict.ok, false);
  if (!verdict.ok) {
    assert(verdict.reason.includes("does not contain the marker"));
  }
});

Deno.test("owned open artefact - verify refuses a foreign-authored issue", async () => {
  const verdict = await verify(
    viewOf({ author: { login: "stranger" } }),
  ).run();
  assertEquals(verdict.ok, false);
  if (!verdict.ok) assert(verdict.reason.includes("not a fleet account"));
});

Deno.test("owned open artefact - verify with an unresolved fleet set refuses and logs the consequence", async () => {
  const log: string[] = [];
  const { gh } = ghReturning(viewOf());
  const verdict = await verifyOwnedOpenIssue({
    repo: REPO,
    number: 12,
    marker: ISSUE_MARKER,
    ghCommandFn: gh,
    authors: { fleetAuthors: [] },
    log: (m) => log.push(m),
  });
  assertEquals(verdict, { ok: false, reason: "author is not a fleet account" });
  assert(
    log.some((m) =>
      m.includes("fleet author set unresolved") &&
      m.includes("so it is not reused or written to")
    ),
    `the consequence was not logged: ${JSON.stringify(log)}`,
  );
});

Deno.test("owned open artefact - verify throws when gh fails", async () => {
  await assertRejects(
    () =>
      verifyOwnedOpenIssue({
        repo: REPO,
        number: 12,
        marker: ISSUE_MARKER,
        ghCommandFn: ghFailing("Could not resolve to an Issue"),
        authors: { fleetAuthors: FLEET },
        log: () => {},
      }),
    Error,
    "failed: Could not resolve to an Issue",
  );
});
