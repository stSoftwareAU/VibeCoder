/**
 * Pins `isMilestoneHeadAlreadyMerged` and its use in `hasNothingToMerge`
 * (Issue #4514): exact gh arguments, argument allowlist, error results and
 * the merged-rollup match rules.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { hasNothingToMerge } from "../lib/milestone_completion.ts";
import { isMilestoneHeadAlreadyMerged } from "../lib/milestone_route_restore.ts";

const REPO = "owner/repo";
const BRANCH = "milestone/scan";
const DEFAULT = "main";
const HEAD = "0123456789abcdef0123456789abcdef01234567";

const HEAD_ARGS = [
  "api",
  `repos/${REPO}/branches/${BRANCH}`,
  "--jq",
  ".commit.sha",
];
const LIST_ARGS = [
  "pr",
  "list",
  "--repo",
  REPO,
  "--head",
  BRANCH,
  "--state",
  "all",
  "--json",
  "number,state,baseRefName,mergedAt,headRefOid",
  "--limit",
  "50",
];

interface StrictOptions {
  head?: string | Error;
  prs?: unknown;
  listFails?: boolean;
  calls?: string[][];
}

/** A gh stub that answers only the exact argument vectors the code should send. */
function strictGh(options: StrictOptions = {}) {
  return (args: string[]): Promise<string> => {
    options.calls?.push(args);
    const key = JSON.stringify(args);
    if (key === JSON.stringify(HEAD_ARGS)) {
      const head = options.head ?? HEAD;
      return head instanceof Error
        ? Promise.reject(head)
        : Promise.resolve(`${head}\n`);
    }
    if (key === JSON.stringify(LIST_ARGS)) {
      if (options.listFails) return Promise.reject(new Error("list refused"));
      return Promise.resolve(JSON.stringify(options.prs ?? []));
    }
    return Promise.reject(new Error(`unexpected gh call: ${key}`));
  };
}

function merged(overrides: Record<string, unknown> = {}) {
  return {
    number: 4077,
    state: "MERGED",
    baseRefName: DEFAULT,
    mergedAt: "2026-10-13T13:58:25Z",
    headRefOid: HEAD,
    ...overrides,
  };
}

function check(
  options: StrictOptions & {
    repo?: string;
    milestoneBranch?: string;
    defaultBranch?: string;
    withPrs?: readonly unknown[];
  } = {},
) {
  return isMilestoneHeadAlreadyMerged({
    repo: options.repo ?? REPO,
    milestoneBranch: options.milestoneBranch ?? BRANCH,
    defaultBranch: options.defaultBranch ?? DEFAULT,
    ghCommandFn: strictGh(options),
    // deno-lint-ignore no-explicit-any
    prs: options.withPrs as any,
  });
}

Deno.test("isMilestoneHeadAlreadyMerged - matches a merged rollup with the same head (Issue #4514)", async () => {
  const calls: string[][] = [];
  const result = await check({ prs: [merged()], calls });
  assertEquals(result, { ok: true, value: true });
  assertEquals(calls, [HEAD_ARGS, LIST_ARGS]);
});

Deno.test("isMilestoneHeadAlreadyMerged - compares the head case-insensitively (Issue #4514)", async () => {
  const result = await check({
    head: HEAD.toUpperCase(),
    prs: [merged({ state: "merged" })],
  });
  assertEquals(result, { ok: true, value: true });
});

Deno.test("isMilestoneHeadAlreadyMerged - an open pull request with the same head does not match (Issue #4514)", async () => {
  assertEquals(await check({ prs: [merged({ state: "OPEN" })] }), {
    ok: true,
    value: false,
  });
});

Deno.test("isMilestoneHeadAlreadyMerged - a pull request without a state does not match (Issue #4514)", async () => {
  assertEquals(await check({ prs: [merged({ state: undefined })] }), {
    ok: true,
    value: false,
  });
});

Deno.test("isMilestoneHeadAlreadyMerged - a merged rollup into another base does not match (Issue #4514)", async () => {
  assertEquals(await check({ prs: [merged({ baseRefName: "other" })] }), {
    ok: true,
    value: false,
  });
});

Deno.test("isMilestoneHeadAlreadyMerged - a merged rollup with a different head does not match (Issue #4514)", async () => {
  const other = "1111111111111111111111111111111111111111";
  assertEquals(await check({ prs: [merged({ headRefOid: other })] }), {
    ok: true,
    value: false,
  });
});

Deno.test("isMilestoneHeadAlreadyMerged - a merged rollup with a non-string head does not match (Issue #4514)", async () => {
  assertEquals(await check({ prs: [merged({ headRefOid: 42 })] }), {
    ok: true,
    value: false,
  });
});

Deno.test("isMilestoneHeadAlreadyMerged - supplied pull requests are used without listing (Issue #4514)", async () => {
  const calls: string[][] = [];
  const result = await check({
    listFails: true,
    withPrs: [merged()],
    calls,
  });
  assertEquals(result, { ok: true, value: true });
  assertEquals(calls, [HEAD_ARGS]);
});

Deno.test("isMilestoneHeadAlreadyMerged - rejects arguments outside the allowlist without calling gh (Issue #4514)", async () => {
  const bad: Array<
    { repo?: string; milestoneBranch?: string; defaultBranch?: string }
  > = [
    { repo: "owner/repo; rm -rf" },
    { milestoneBranch: "milestone/a b" },
    { defaultBranch: "main;x" },
  ];
  for (const overrides of bad) {
    const calls: string[][] = [];
    const result = await check({ ...overrides, prs: [merged()], calls });
    assertEquals(result.ok, false, JSON.stringify(overrides));
    if (!result.ok) {
      assertStringIncludes(result.error.message, "allowlist");
    }
    assertEquals(calls, [], JSON.stringify(overrides));
  }
});

Deno.test("isMilestoneHeadAlreadyMerged - an unreadable head is an error result (Issue #4514)", async () => {
  const result = await check({ head: new Error("branch refused") });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "could not read the head");
    assertStringIncludes(result.error.message, "branch refused");
  }
});

Deno.test("isMilestoneHeadAlreadyMerged - a head that is not a commit sha is an error result (Issue #4514)", async () => {
  const result = await check({ head: "not-a-sha" });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "40-hex");
  }
});

Deno.test("isMilestoneHeadAlreadyMerged - a failed rollup list is an error result (Issue #4514)", async () => {
  const result = await check({ listFails: true });
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "could not list rollup PRs");
    assertStringIncludes(result.error.message, "list refused");
  }
});

Deno.test("hasNothingToMerge - reads the head of the milestone branch itself (Issue #4514)", async () => {
  const gh = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/branches/") && key.endsWith(".name")) {
      return Promise.resolve(BRANCH);
    }
    if (key.includes("/compare/")) {
      return Promise.resolve(
        JSON.stringify({ ahead_by: 20, files: [{ filename: "a.ts" }] }),
      );
    }
    return strictGh({ prs: [merged()] })(args);
  };
  assertEquals(await hasNothingToMerge(REPO, BRANCH, DEFAULT, gh), true);
});

Deno.test("hasNothingToMerge - false when a rollup list holds a null entry (Issue #4514)", async () => {
  const gh = (args: string[]): Promise<string> => {
    const key = args.join(" ");
    if (key.includes("/branches/") && key.endsWith(".name")) {
      return Promise.resolve(BRANCH);
    }
    if (key.includes("/compare/")) {
      return Promise.resolve(
        JSON.stringify({ ahead_by: 20, files: [{ filename: "a.ts" }] }),
      );
    }
    return strictGh({ prs: [null] })(args);
  };
  const result = await hasNothingToMerge(REPO, BRANCH, DEFAULT, gh);
  assert(result === false, "a malformed list fails safe");
});
