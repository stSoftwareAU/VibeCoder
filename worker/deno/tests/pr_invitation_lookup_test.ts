/**
 * Tests for the invited-human-PR listing (Issue #4077).
 *
 * The listing is the impure half of the invitation mechanism: it gathers
 * the facts, hands them to `isPrInvited`, and admits only what that
 * predicate accepts. Every failure path here must fail **closed** — an
 * unreadable listing or timeline admits nothing.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  INVITATION_PR_FIELDS,
  listInvitedHumanPrs,
} from "../lib/pr_invitation_lookup.ts";

const REPO = "owner/repo";
const HOST = "VibeCoderBot";
const SIBLING = "stsvcbot";
const HUMAN = "courtyen";
const PR_NUMBER = 2312;

interface StubOptions {
  labels?: Array<{ name: string }>;
  labelledBy?: string;
  comments?: Array<{ author: { login: string }; body: string }>;
  /** Throw on `pr list` instead of answering it. */
  listThrows?: boolean;
  /** Throw on the timeline read instead of answering it. */
  timelineThrows?: boolean;
  /** Record every call. */
  calls?: string[][];
}

function buildGh(opts: StubOptions): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    opts.calls?.push(args);
    const key = args.join(" ");
    if (args[0] === "pr" && args[1] === "list") {
      if (opts.listThrows) return Promise.reject(new Error("gh list boom"));
      if (!key.includes(`--author ${HUMAN}`)) return Promise.resolve("[]");
      return Promise.resolve(JSON.stringify([{
        number: PR_NUMBER,
        headRefName: "courtyen/hand-written-fix",
        author: { login: HUMAN },
        labels: opts.labels ?? [],
        comments: opts.comments ?? [],
        reviews: [],
      }]));
    }
    if (key.includes("timeline")) {
      if (opts.timelineThrows) {
        return Promise.reject(new Error("timeline boom"));
      }
      const events = opts.labelledBy === undefined ? [] : [{
        event: "labeled",
        label: { name: "work-on" },
        actor: { login: opts.labelledBy },
        created_at: "2026-05-18T00:00:00Z",
      }];
      return Promise.resolve(JSON.stringify(events));
    }
    return Promise.resolve("[]");
  };
}

function run(
  stub: StubOptions,
  overrides: Record<string, unknown> = {},
  log?: (message: string) => void,
) {
  return listInvitedHumanPrs<{ number: number }>({
    repo: REPO,
    githubUser: HOST,
    allowedAuthors: [HUMAN, SIBLING],
    fleetPrAuthors: [SIBLING],
    fields: "number,headRefName",
    ghCommandFn: buildGh(stub),
    log,
    ...overrides,
  });
}

Deno.test("listInvitedHumanPrs - admits a labelled PR and logs the cause", async () => {
  const lines: string[] = [];
  const admitted = await run(
    { labels: [{ name: "work-on" }], labelledBy: HUMAN },
    {},
    (m) => lines.push(m),
  );

  assertEquals(admitted.map((pr) => pr.number), [PR_NUMBER]);
  assertEquals(lines, [
    `[pr-invitation] admitted repo=${REPO} prNumber=${PR_NUMBER} ` +
    `author=${HUMAN} via=label invitedBy=${HUMAN}`,
  ]);
});

Deno.test("listInvitedHumanPrs - only queries humans outside the maintenance set", async () => {
  const calls: string[][] = [];
  await run({ calls });

  const authors = calls
    .filter((c) => c[0] === "pr" && c[1] === "list")
    .map((c) => c[c.indexOf("--author") + 1]);
  // The sibling fleet login is in `allowed_authors` for PR dedup, but the
  // maintenance listing already covers it — no duplicate query.
  assertEquals(authors, [HUMAN]);
});

Deno.test("listInvitedHumanPrs - requests the fields the predicate needs", async () => {
  const calls: string[][] = [];
  await run({ calls });

  const list = calls.find((c) => c[0] === "pr" && c[1] === "list")!;
  const fields = list[list.indexOf("--json") + 1]!.split(",");
  assertEquals(fields.slice(0, 2), ["number", "headRefName"]);
  for (const field of INVITATION_PR_FIELDS) assert(fields.includes(field));
  // No duplicate `number` from merging the caller's fields.
  assertEquals(fields.filter((f) => f === "number").length, 1);
});

Deno.test("listInvitedHumanPrs - an unreadable listing admits nothing and is logged", async () => {
  const lines: string[] = [];
  const admitted = await run({ listThrows: true }, {}, (m) => lines.push(m));

  assertEquals(admitted, []);
  assertEquals(lines.length, 1);
  assert(lines[0]!.includes("invitation listing for author"));
  assert(lines[0]!.includes("gh list boom"));
});

Deno.test("listInvitedHumanPrs - an unreadable timeline fails closed and is logged", async () => {
  const lines: string[] = [];
  const admitted = await run(
    { labels: [{ name: "work-on" }], labelledBy: HUMAN, timelineThrows: true },
    {},
    (m) => lines.push(m),
  );

  assertEquals(admitted, []);
  assertEquals(lines.length, 1);
  assert(lines[0]!.includes("label authorship check"));
  assert(lines[0]!.includes("not invited"));
});

Deno.test("listInvitedHumanPrs - no trusted humans configured means no listing at all", async () => {
  const calls: string[][] = [];
  const admitted = await run({ calls }, { allowedAuthors: [] });

  assertEquals(admitted, []);
  assertEquals(calls, []);
});

Deno.test("listInvitedHumanPrs - a mention admits the PR without a timeline read", async () => {
  const calls: string[][] = [];
  const admitted = await run({
    calls,
    comments: [{ author: { login: HUMAN }, body: `@${HOST} please fix CI` }],
  });

  assertEquals(admitted.map((pr) => pr.number), [PR_NUMBER]);
  assertEquals(calls.some((c) => c.join(" ").includes("timeline")), false);
});

Deno.test("listInvitedHumanPrs - an uninvited human PR is not admitted", async () => {
  const admitted = await run({
    labels: [{ name: "bug" }],
    comments: [{ author: { login: HUMAN }, body: "rebased onto main" }],
  });

  assertEquals(admitted, []);
});

Deno.test("listInvitedHumanPrs - a --limit is passed through when supplied", async () => {
  const calls: string[][] = [];
  await run({ calls }, { limit: 50 });

  const list = calls.find((c) => c[0] === "pr" && c[1] === "list")!;
  assertEquals(list[list.indexOf("--limit") + 1], "50");
});
