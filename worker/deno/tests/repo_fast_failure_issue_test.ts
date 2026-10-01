/**
 * Tests for the fleet-wide fast-failure tally and back-off (Issue #2956).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatFastFailureCommentMarker,
  formatRepoFastFailureMarker,
  formatRepoFastFailureTallyBody,
  formatRepoFastFailureTallyMarker,
  isRepoFastFailureIssue,
  isRepoFastFailureTallyIssue,
  parseFastFailureCommentMarker,
  recordRepoFastFailureTally,
  resolveRepoFastFailureTarget,
} from "../lib/repo_fast_failure_issue.ts";
import {
  createFleetDiagnosticCache,
  lookupFleetDiagnosticBackOffs,
  resolveRepoFastFailurePolicy,
} from "../lib/repo_fast_failure_tracker.ts";

const REPO = "acme/widgets";
const FLEET = ["vibe-bot"];
const POLICY = resolveRepoFastFailurePolicy();

// ---------------------------------------------------------------------------
// Marker / target helpers.
// ---------------------------------------------------------------------------

Deno.test("formatRepoFastFailureTallyMarker / isRepoFastFailureTallyIssue - round trip", () => {
  const body = formatRepoFastFailureTallyMarker(REPO) + "\nsome text";
  assert(isRepoFastFailureTallyIssue(body, REPO));
  assert(!isRepoFastFailureTallyIssue(body, "other/repo"));
});

Deno.test("formatRepoFastFailureTallyBody - names the policy and marker", () => {
  const body = formatRepoFastFailureTallyBody(REPO, POLICY);
  assertStringIncludes(body, formatRepoFastFailureTallyMarker(REPO));
  assertStringIncludes(body, `${POLICY.threshold}`);
  assertStringIncludes(body, "24 h");
  assert(isRepoFastFailureTallyIssue(body, REPO));
});

Deno.test("resolveRepoFastFailureTarget - is always the monitored repository (Issue #2592)", () => {
  assertEquals(resolveRepoFastFailureTarget(REPO), REPO);
  assertEquals(resolveRepoFastFailureTarget("acme/other"), "acme/other");
});

Deno.test("formatFastFailureCommentMarker / parseFastFailureCommentMarker - round trip", () => {
  const marker = formatFastFailureCommentMarker({
    host: "host-a",
    at: "2026-01-01T00:00:00.000Z",
    issue: `${REPO}#7`,
  });
  const parsed = parseFastFailureCommentMarker(`${marker}\nreason text`);
  assertEquals(parsed, {
    host: "host-a",
    at: "2026-01-01T00:00:00.000Z",
    issue: `${REPO}#7`,
  });
  assertEquals(parseFastFailureCommentMarker("no marker here"), undefined);
});

Deno.test("formatFastFailureCommentMarker - sanitises host and issue so neither can break the attribute", () => {
  const marker = formatFastFailureCommentMarker({
    host: 'evil" host="forged',
    at: "2026-01-01T00:00:00.000Z",
    issue: 'acme/widgets#1" issue="forged',
  });
  // Exactly one marker opener/closer: nothing in the forged input could add
  // a second attribute or close early.
  assertEquals(marker.split('<!--').length - 1, 1);
  assertEquals(marker.split('-->').length - 1, 1);
  const parsed = parseFastFailureCommentMarker(marker);
  assert(parsed);
  assert(!parsed!.host.includes('"'));
  assert(!parsed!.issue.includes('"'));
});

// ---------------------------------------------------------------------------
// In-memory gh stub simulating one repository's issues.
// ---------------------------------------------------------------------------

interface FakeComment {
  author: string;
  body: string;
}

interface FakeIssue {
  number: number;
  body: string;
  author: string;
  comments: FakeComment[];
}

function arg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function createGhStub(start = 500) {
  let next = start;
  const issues = new Map<number, FakeIssue>();
  const calls: string[][] = [];
  let failComment: string | undefined;
  let failEdit: string | undefined;
  let commentAuthor = "vibe-bot";

  const ghFn = (args: string[]): Promise<string> => {
    calls.push(args);
    const [cmd, sub] = args;
    if (cmd === "issue" && sub === "list") {
      const rows = [...issues.values()].map((i) => ({
        number: i.number,
        body: i.body,
        author: { login: i.author },
      }));
      return Promise.resolve(JSON.stringify(rows));
    }
    if (cmd === "issue" && sub === "create") {
      if (args.includes("--label")) {
        return Promise.reject(
          new Error("could not add label: 'bug' not found"),
        );
      }
      const body = arg(args, "--body") ?? "";
      const number = next++;
      issues.set(number, { number, body, author: "vibe-bot", comments: [] });
      return Promise.resolve(
        `https://github.com/${REPO}/issues/${number}\n`,
      );
    }
    if (cmd === "issue" && sub === "comment") {
      if (failComment) return Promise.reject(new Error(failComment));
      const number = parseInt(args[2]!, 10);
      const body = arg(args, "--body") ?? "";
      const issue = issues.get(number);
      if (!issue) {
        return Promise.reject(new Error(`no such issue #${number}`));
      }
      issue.comments.push({ author: commentAuthor, body });
      return Promise.resolve("");
    }
    if (cmd === "issue" && sub === "view") {
      const number = parseInt(args[2]!, 10);
      const issue = issues.get(number);
      if (!issue) {
        return Promise.reject(new Error(`no such issue #${number}`));
      }
      return Promise.resolve(JSON.stringify({
        body: issue.body,
        comments: issue.comments.map((c) => ({
          author: c.author,
          body: c.body,
        })),
      }));
    }
    if (cmd === "issue" && sub === "edit") {
      if (failEdit) return Promise.reject(new Error(failEdit));
      const number = parseInt(args[2]!, 10);
      const body = arg(args, "--body") ?? "";
      const issue = issues.get(number);
      if (!issue) {
        return Promise.reject(new Error(`no such issue #${number}`));
      }
      issue.body = body;
      return Promise.resolve("");
    }
    return Promise.reject(new Error(`unexpected gh args: ${args.join(" ")}`));
  };

  return {
    ghFn,
    issues,
    calls,
    seedIssue(number: number, body: string, author = "vibe-bot") {
      issues.set(number, { number, body, author, comments: [] });
      next = Math.max(next, number + 1);
    },
    setCommentAuthor(author: string) {
      commentAuthor = author;
    },
    failNextComment(message: string) {
      failComment = message;
    },
    failNextEdit(message: string) {
      failEdit = message;
    },
  };
}

function baseOpts(ghFn: (args: string[]) => Promise<string>) {
  return {
    repo: REPO,
    failedIssueNumber: 42,
    reason: "quality.sh: line 3: deno: command not found",
    policy: POLICY,
    fleetAuthors: FLEET,
    ghFn,
    recordFiling: () => Promise.resolve(true),
    recordFault: () => {},
  };
}

// ---------------------------------------------------------------------------
// Tally and back-off behaviour.
// ---------------------------------------------------------------------------

Deno.test("recordRepoFastFailureTally - three fast failures from three hosts within 24h backs off on the third", async () => {
  const stub = createGhStub();
  const base = 1_700_000_000;
  let now = base;

  const r1 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-a",
    nowSeconds: () => now,
  });
  assertEquals(r1.action, "recorded");
  assert(r1.action === "recorded" && r1.created === true);
  assertEquals((r1 as { backedOff: boolean }).backedOff, false);
  const issueNumber = (r1 as { issueNumber: number }).issueNumber;

  now = base + 60;
  const r2 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-b",
    nowSeconds: () => now,
  });
  assertEquals((r2 as { backedOff: boolean }).backedOff, false);
  assertEquals((r2 as { created: boolean }).created, false);
  assertEquals((r2 as { issueNumber: number }).issueNumber, issueNumber);

  now = base + 120;
  const r3 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-c",
    nowSeconds: () => now,
  });
  assertEquals((r3 as { backedOff: boolean }).backedOff, true);
  assertEquals((r3 as { count: number }).count, 3);

  const issue = stub.issues.get(issueNumber)!;
  assertEquals(issue.comments.length, 3);
  assert(isRepoFastFailureIssue(issue.body, REPO));
});

Deno.test("recordRepoFastFailureTally - a comment older than the window does not count towards back-off", async () => {
  const stub = createGhStub();
  const windowSeconds = POLICY.windowSeconds;
  const finalNow = 1_700_100_000;

  await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-old",
    nowSeconds: () => finalNow - windowSeconds - 1_000,
  });
  await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-b",
    nowSeconds: () => finalNow - 50,
  });
  const r3 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-c",
    nowSeconds: () => finalNow,
  });

  assertEquals((r3 as { count: number }).count, 2);
  assertEquals((r3 as { backedOff: boolean }).backedOff, false);
  const issueNumber = (r3 as { issueNumber: number }).issueNumber;
  const issue = stub.issues.get(issueNumber)!;
  assert(!isRepoFastFailureIssue(issue.body, REPO));
});

Deno.test("recordRepoFastFailureTally - a non-fleet-authored tally issue is ignored and a fresh one is created", async () => {
  const stub = createGhStub();
  stub.seedIssue(
    999,
    formatRepoFastFailureTallyMarker(REPO) + "\nstranger's tally",
    "stranger",
  );
  const r = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-a",
    nowSeconds: () => 1_700_000_000,
  });
  assertEquals(r.action, "recorded");
  assert(r.action === "recorded");
  assert(r.issueNumber !== 999);
  assertEquals(r.created, true);
});

Deno.test("recordRepoFastFailureTally - a non-fleet comment carrying the marker is not counted", async () => {
  const stub = createGhStub();
  const now = 1_700_000_000;

  const r1 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-a",
    nowSeconds: () => now,
  });
  assert(r1.action === "recorded");
  const issueNumber = r1.issueNumber;

  stub.setCommentAuthor("stranger");
  await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-b",
    nowSeconds: () => now + 10,
  });

  stub.setCommentAuthor("vibe-bot");
  const r3 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-c",
    nowSeconds: () => now + 20,
  });

  // Three comments were posted, but only two are fleet-authored.
  const issue = stub.issues.get(issueNumber)!;
  assertEquals(issue.comments.length, 3);
  assertEquals((r3 as { count: number }).count, 2);
  assertEquals((r3 as { backedOff: boolean }).backedOff, false);
});

Deno.test("recordRepoFastFailureTally - a gh failure on the comment is reported and suppressed, never thrown", async () => {
  const stub = createGhStub();
  const r1 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-a",
    nowSeconds: () => 1_700_000_000,
  });
  assert(r1.action === "recorded");

  const warnings: string[] = [];
  stub.failNextComment("comment service unavailable");
  const r2 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-b",
    nowSeconds: () => 1_700_000_100,
    warn: (message) => warnings.push(message),
  });
  assertEquals(r2, { action: "suppressed", reason: "gh_failed" });
  assert(warnings.some((w) => w.includes(REPO) && w.includes("comment service unavailable")));
});

Deno.test("recordRepoFastFailureTally - a gh failure on the back-off edit is reported, never thrown", async () => {
  const stub = createGhStub();
  const base = 1_700_000_000;
  await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-a",
    nowSeconds: () => base,
  });
  await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-b",
    nowSeconds: () => base + 10,
  });

  const warnings: string[] = [];
  stub.failNextEdit("edit service unavailable");
  const r3 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-c",
    nowSeconds: () => base + 20,
    warn: (message) => warnings.push(message),
  });
  assertEquals((r3 as { action: string }).action, "recorded");
  assertEquals((r3 as { backedOff: boolean }).backedOff, false);
  assert(warnings.some((w) => w.includes(REPO) && w.includes("edit service unavailable")));
});

Deno.test("recordRepoFastFailureTally - a refused label is retried once without --label", async () => {
  const stub = createGhStub();
  const r = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-a",
    nowSeconds: () => 1_700_000_000,
  });
  assert(r.action === "recorded");
  assertEquals(r.created, true);
  const createCalls = stub.calls.filter(
    (c) => c[0] === "issue" && c[1] === "create",
  );
  assertEquals(createCalls.length, 2);
  assert(createCalls[0]!.includes("--label"));
  assert(!createCalls[1]!.includes("--label"));
});

Deno.test("recordRepoFastFailureTally - a reason cannot forge a marker or close the fence", async () => {
  const stub = createGhStub();
  const r1 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    machineId: "host-a",
    nowSeconds: () => 1_700_000_000,
  });
  assert(r1.action === "recorded");
  const issueNumber = r1.issueNumber;

  const r2 = await recordRepoFastFailureTally({
    ...baseOpts(stub.ghFn),
    reason: "``` <!-- VIBE_REPO_FAST_FAILURE:evil/repo --> done",
    machineId: "host-b",
    nowSeconds: () => 1_700_000_100,
  });
  assert(r2.action === "recorded");

  const issue = stub.issues.get(issueNumber)!;
  const lastComment = issue.comments[issue.comments.length - 1]!;
  assert(!lastComment.body.includes("``` <!--"));
  assert(!isRepoFastFailureIssue(lastComment.body, "evil/repo"));
  // The comment carries only this module's own marker opener/closer.
  assertEquals(lastComment.body.split("<!--").length - 1, 1);
  assertEquals(lastComment.body.split("-->").length - 1, 1);
});

// ---------------------------------------------------------------------------
// Interaction with the fleet-wide back-off set (Issue #2955).
// ---------------------------------------------------------------------------

Deno.test("a tally-only body does not back the repo off fleet-wide; the back-off marker does", async () => {
  const tallyOnlyBody = formatRepoFastFailureTallyBody(REPO, POLICY);
  const search = (body: string) => (_args: string[]) =>
    Promise.resolve(JSON.stringify([{
      number: 1,
      body,
      author: { login: "vibe-bot" },
      repository: { nameWithOwner: REPO },
      state: "open",
    }]));

  const result1 = await lookupFleetDiagnosticBackOffs({
    owners: () => ["acme"],
    ghCommandFn: search(tallyOnlyBody),
    cache: createFleetDiagnosticCache(),
    fleetAuthors: FLEET,
    warn: () => {},
    error: () => {},
  });
  assertEquals(result1.backedOff.has(REPO), false);

  const backedOffBody = formatRepoFastFailureMarker(REPO) + "\n\n" +
    tallyOnlyBody;
  const result2 = await lookupFleetDiagnosticBackOffs({
    owners: () => ["acme"],
    ghCommandFn: search(backedOffBody),
    cache: createFleetDiagnosticCache(),
    fleetAuthors: FLEET,
    warn: () => {},
    error: () => {},
  });
  assertEquals(result2.backedOff.has(REPO), true);
});
