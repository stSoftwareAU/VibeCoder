/**
 * Tests for findOpenMilestoneFixPr reusing only an owned, open, fleet-authored
 * fix PR (Issue #3065). Calls the real lookup with an injected gh fake.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  findOpenMilestoneFixPr,
  milestoneFixPrefixFor,
} from "../lib/milestone_fix_pr.ts";

const REPO = "org/repo";
const MILESTONE = "milestone/523-idle-task-scans";
const FLEET = "fleet-bot";
const FLEET_AUTHORS = [FLEET];
const PREFIX = milestoneFixPrefixFor(MILESTONE, 42);

interface ListRow {
  number: number;
  url: string;
  headRefName: string;
  state: string;
  author: { login: string };
  isCrossRepository: boolean;
}

/** A fix PR this fleet raised: same repository, open, fleet-authored. */
function ownedRow(
  number: number,
  headRefName: string,
  overrides: Partial<ListRow> = {},
): ListRow {
  return {
    number,
    url: `https://github.com/org/repo/pull/${number}`,
    headRefName,
    state: "OPEN",
    author: { login: FLEET },
    isCrossRepository: false,
    ...overrides,
  };
}

/** Records every gh call; a `pr list` is answered by `list`. */
function fakeGh(list: (args: string[]) => string | Error) {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "pr" && args[1] === "list") {
      const reply = list(args);
      return reply instanceof Error
        ? Promise.reject(reply)
        : Promise.resolve(reply);
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
  return { gh, calls };
}

Deno.test("findOpenMilestoneFixPr - a foreign-authored prefix match is not reused (Issue #3065)", async () => {
  const { gh } = fakeGh(() =>
    JSON.stringify([
      ownedRow(901, `${PREFIX}ci-abc`, { author: { login: "someone-else" } }),
    ])
  );
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, {
    gh,
    fleetAuthors: FLEET_AUTHORS,
  });
  assert(result.ok);
  assertEquals(result.value, null);
});

Deno.test("findOpenMilestoneFixPr - a fork PR (isCrossRepository true) is not reused (Issue #3065)", async () => {
  const { gh } = fakeGh(() =>
    JSON.stringify([
      ownedRow(901, `${PREFIX}ci-abc`, { isCrossRepository: true }),
    ])
  );
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, {
    gh,
    fleetAuthors: FLEET_AUTHORS,
  });
  assert(result.ok);
  assertEquals(result.value, null);
});

Deno.test("findOpenMilestoneFixPr - a closed or merged fix PR is not reused (Issue #3065)", async () => {
  const { gh } = fakeGh(() =>
    JSON.stringify([
      ownedRow(901, `${PREFIX}ci-abc`, { state: "CLOSED" }),
      ownedRow(902, `${PREFIX}ci-def`, { state: "MERGED" }),
    ])
  );
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, {
    gh,
    fleetAuthors: FLEET_AUTHORS,
  });
  assert(result.ok);
  assertEquals(result.value, null);
});

Deno.test("findOpenMilestoneFixPr - a fleet-authored owned open fix PR is returned (Issue #3065)", async () => {
  const { gh, calls } = fakeGh(() =>
    JSON.stringify([ownedRow(901, `${PREFIX}ci-abc`)])
  );
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, {
    gh,
    fleetAuthors: FLEET_AUTHORS,
  });
  assert(result.ok);
  assertEquals(result.value?.number, 901);
  assertEquals(result.value?.url, "https://github.com/org/repo/pull/901");
  assertEquals(result.value?.opened, false);
  assert(calls.some((a) => a[0] === "pr" && a[1] === "list"));
});

Deno.test("findOpenMilestoneFixPr - an empty fleet set finds nothing and logs why (Issue #3065)", async () => {
  const { gh } = fakeGh(() =>
    JSON.stringify([ownedRow(901, `${PREFIX}ci-abc`)])
  );
  const logs: string[] = [];
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, {
    gh,
    fleetAuthors: [],
    log: (m) => logs.push(m),
  });
  assert(result.ok);
  assertEquals(result.value, null);
  assert(logs.length > 0, "an unresolved fleet set must log a line");
});

Deno.test("findOpenMilestoneFixPr - a gh failure is an error Result (Issue #3065)", async () => {
  const { gh } = fakeGh(() => new Error("gh exited 1: boom"));
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, {
    gh,
    fleetAuthors: FLEET_AUTHORS,
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "findOpenMilestoneFixPr");
  assertStringIncludes(result.error.message, "boom");
});

Deno.test("findOpenMilestoneFixPr - an unparseable listing is an error Result (Issue #3065)", async () => {
  const { gh } = fakeGh(() => "not json at all");
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, {
    gh,
    fleetAuthors: FLEET_AUTHORS,
  });
  assert(!result.ok);
  assertStringIncludes(result.error.message, "findOpenMilestoneFixPr");
});

Deno.test("findOpenMilestoneFixPr - a discriminator narrows the match (Issue #3065)", async () => {
  const { gh } = fakeGh(() =>
    JSON.stringify([
      ownedRow(901, `${PREFIX}ci-abc`),
      ownedRow(902, `${PREFIX}takeover-abc`),
    ])
  );
  const deps = { gh, fleetAuthors: FLEET_AUTHORS };
  const anyFix = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, deps);
  const takeover = await findOpenMilestoneFixPr(
    REPO,
    MILESTONE,
    42,
    deps,
    "takeover-",
  );
  const review = await findOpenMilestoneFixPr(
    REPO,
    MILESTONE,
    42,
    deps,
    "review-",
  );
  assert(anyFix.ok && takeover.ok && review.ok);
  assertEquals(anyFix.value?.number, 901);
  assertEquals(takeover.value?.number, 902);
  assertEquals(review.value, null);
});

Deno.test("findOpenMilestoneFixPr - the milestone branch is passed as --base (Issue #3065)", async () => {
  const { gh, calls } = fakeGh(() => "[]");
  const result = await findOpenMilestoneFixPr(REPO, MILESTONE, 42, {
    gh,
    fleetAuthors: FLEET_AUTHORS,
  });
  assert(result.ok);
  const list = calls.find((a) => a[0] === "pr" && a[1] === "list");
  assert(list !== undefined, "a pr list call is made");
  assertEquals(list[list.indexOf("--base") + 1], MILESTONE);
  assertEquals(list[list.indexOf("--state") + 1], "open");
});
