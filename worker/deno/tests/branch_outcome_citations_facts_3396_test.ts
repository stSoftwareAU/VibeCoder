/**
 * Tests for the Issue #3536 facts-file reading of the stale Branch-outcomes
 * citation check (`branch_outcome_citations.ts`, wired in by
 * `pr_feedback_drift_check.ts`): a ref with a `pr-summary-<N>.facts.json`
 * contributes its structured `path`/`line`/`endLine` entries instead of its
 * prose `Branch outcomes:` list, and an unreadable or malformed facts file is
 * reported as not checked rather than read as "no citations".
 *
 * Pure tests call the real citation functions; integration tests drive
 * `runPrFeedbackDriftCheck` against a real temporary git repo.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  changedFilesCitedBy,
  factsCitations,
  findStaleCitations,
  parseDiffHunks,
} from "../lib/branch_outcome_citations.ts";
import {
  type DriftCheckDeps,
  type DriftFinding,
  runPrFeedbackDriftCheck,
} from "../lib/pr_feedback_drift_check.ts";
import { parseSummaryFacts, type SummaryFacts } from "../lib/summary_facts.ts";

interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function git(dir: string, args: string[]): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

async function writeFile(dir: string, path: string, content: string) {
  const full = `${dir}/${path}`;
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, content);
}

async function commitAll(dir: string, message: string) {
  assertEquals((await git(dir, ["add", "."])).code, 0);
  assertEquals((await git(dir, ["commit", "-m", message])).code, 0);
}

async function initRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "drift_check_3536_" });
  assertEquals((await git(dir, ["init", "-b", "main"])).code, 0);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

/** Fake `runGit` that shells out to real git in `dir`. */
function makeRunGit(dir: string): DriftCheckDeps["runGit"] {
  return async (args: string[]) => await git(dir, args);
}

/** Fake `runMutationCheck` for tests not about the mutation gate (Issue #3750). */
const notMutationChecked: DriftCheckDeps["runMutationCheck"] = async () => ({
  kind: "not_applicable",
  reason: "not under test",
});

/** Fake `runGh` that always answers the `baseRefName` read with `main`. */
function makeRunGh(): DriftCheckDeps["runGh"] {
  return async () => "main\n";
}

type AgentResponse =
  | { ok: true; output: string }
  | { ok: false; error: Error };
type AgentCall = { prompt: string; readOnly: boolean };

function makeRunAgent(
  responses: readonly (AgentResponse | ((call: AgentCall) => AgentResponse))[],
  calls: AgentCall[],
): DriftCheckDeps["runAgent"] {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const resp = responses[i++];
    if (!resp) {
      throw new Error(`runAgent called more times (${i}) than expected`);
    }
    return typeof resp === "function" ? resp(req) : resp;
  };
}

function noopLogger(): DriftCheckDeps["logger"] {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

const DRIFT_OPEN = "<!-- vibe-drift-verdict -->";
const DRIFT_CLOSE = "<!-- /vibe-drift-verdict -->";

function verdictBlock(findings: DriftFinding[]): string {
  return [
    DRIFT_OPEN,
    "```json",
    JSON.stringify({ findings }, null, 2),
    "```",
    DRIFT_CLOSE,
  ].join("\n");
}

const RULE_TS_V1 =
  `export function checkRule(entry: { subject?: string }): boolean {
  if (!entry.subject) return true;
  return entry.subject.length > 0;
}
`;

// Inserts two lines above the cited line (originally line 2), moving it to
// line 4, and leaves the rest of the file (and its behaviour) unchanged.
const RULE_TS_V2 =
  `export function checkRule(entry: { subject?: string }): boolean {
  // A comment added by the fix push.
  // Another comment line.
  if (!entry.subject) return true;
  return entry.subject.length > 0;
}
`;

const RULE_TEST_TS = `import { assertEquals } from "@std/assert";
import { checkRule } from "../lib/rule.ts";

Deno.test("checkRule - accepts a subject", () => {
  assertEquals(checkRule({ subject: "x" }), true);
});
`;

const SUMMARY_PATH = "docs/archive/pr-summaries/pr-summary-7.md";
const FACTS_PATH = "docs/archive/pr-summaries/pr-summary-7.facts.json";
const DEFAULT_INPUT = { repo: "org/repo", prNumber: 7 };

function factsJson(
  line: number,
  endLine?: number,
): string {
  return JSON.stringify({
    version: 1,
    branchOutcomes: {
      noneAdded: false,
      entries: [{
        path: "lib/rule.ts",
        line,
        ...(endLine !== undefined ? { endLine } : {}),
        outcome: "A missing subject is accepted",
        test: "tests/rule_test.ts",
        testName: "checkRule - accepts a subject",
        flipWentRed: "failed before the fix",
      }],
    },
  });
}

function facts(line: number, endLine?: number): SummaryFacts {
  const parsed = parseSummaryFacts(factsJson(line, endLine));
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function proseCiting(citation: string): string {
  return `## Summary

**Branch outcomes:**

- A missing subject is accepted — \`${citation}\` — tested by \`tests/rule_test.ts::checkRule - accepts a subject\`.

**Docs sweep** — grep: \`subject\`; section: none — no manual documents this flag; siblings: none — no existing set gained a member

## Test Plan

- Added \`tests/rule_test.ts\` (1 test).
`;
}

// Two lines inserted above line 2 of lib/rule.ts: 2 maps to 4.
const INSERT_HUNKS = new Map([
  ["lib/rule.ts", parseDiffHunks("@@ -1,0 +2,2 @@\n")!],
]);
// Line 2 replaced in place.
const REPLACE_HUNKS = new Map([
  ["lib/rule.ts", parseDiffHunks("@@ -2 +2 @@\n")!],
]);

function check(
  extra: {
    previousSummary?: string;
    currentSummary?: string;
    previousFacts?: SummaryFacts | null;
    currentFacts?: SummaryFacts | null;
  },
  hunksByPath = INSERT_HUNKS,
) {
  return findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: extra.previousSummary ?? "",
    currentSummary: extra.currentSummary ?? "",
    previousFacts: extra.previousFacts,
    currentFacts: extra.currentFacts,
    changedFiles: ["lib/rule.ts"],
    hunksByPath,
  });
}

// ---------------------------------------------------------------------------
// Pure tests
// ---------------------------------------------------------------------------

Deno.test("findStaleCitations - facts at both refs, current unchanged, is stale; renumbered is clean", () => {
  assertEquals(INSERT_HUNKS.get("lib/rule.ts")!.length, 1);
  const stale = check({ previousFacts: facts(2), currentFacts: facts(2) });
  assertEquals(stale.stale.length, 1);
  assertStringIncludes(stale.stale[0]!, "lib/rule.ts:2");
  assertStringIncludes(stale.stale[0]!, "lib/rule.ts:4");

  const clean = check({ previousFacts: facts(2), currentFacts: facts(4) });
  assertEquals(clean.stale, []);
  assertEquals(clean.unchecked, []);
});

Deno.test("findStaleCitations - prose at the previous ref and facts now compares the two forms", () => {
  const previousSummary = proseCiting("lib/rule.ts:2");
  const stale = check({ previousSummary, currentFacts: facts(2) });
  assertEquals(stale.stale.length, 1);
  assertStringIncludes(stale.stale[0]!, "lib/rule.ts:4");

  const clean = check({ previousSummary, currentFacts: facts(4) });
  assertEquals(clean.stale, []);
});

Deno.test("findStaleCitations - facts win over the same ref's prose list", () => {
  const clean = check({
    previousFacts: facts(2),
    currentFacts: facts(4),
    currentSummary: proseCiting("lib/rule.ts:2"),
  });
  assertEquals(clean.stale, []);

  const stale = check({
    previousFacts: facts(2),
    currentFacts: facts(2),
    currentSummary: proseCiting("lib/rule.ts:4"),
  });
  assertEquals(stale.stale.length, 1);
});

Deno.test("findStaleCitations - a replaced cited line with facts unchanged is reported as changed or removed", () => {
  const result = check(
    { previousFacts: facts(2), currentFacts: facts(2) },
    REPLACE_HUNKS,
  );
  assertEquals(result.stale.length, 1);
  assertStringIncludes(result.stale[0]!, "changed or removed");
  assertStringIncludes(result.stale[0]!, "lib/rule.ts:2");
});

Deno.test("changedFilesCitedBy - previous facts supply citations the previous prose lacks", () => {
  assertEquals(changedFilesCitedBy("No list here.", ["lib/rule.ts"]), []);
  assertEquals(
    changedFilesCitedBy("No list here.", ["lib/rule.ts"], facts(2)),
    ["lib/rule.ts"],
  );
});

Deno.test("factsCitations - endLine gives a range; noneAdded gives nothing", () => {
  const set = factsCitations(facts(3, 5));
  assertEquals(set.citations.length, 1);
  const c = set.citations[0]!;
  assertEquals(c.text, "lib/rule.ts:3-5");
  assertEquals(c.start, 3);
  assertEquals(c.end, 5);
  assertEquals(set.malformed, []);
  assertEquals(set.truncated, false);

  const none = parseSummaryFacts(
    JSON.stringify({
      version: 1,
      branchOutcomes: { noneAdded: true, entries: [] },
    }),
  );
  if (!none.ok) throw none.error;
  assertEquals(factsCitations(none.value).citations, []);
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

/** Baseline with a prose summary, optionally a facts file, committed as the before-run head. */
async function setupBaseline(
  summary: string,
  beforeFacts?: string,
): Promise<{ dir: string; beforeSha: string }> {
  const dir = await initRepo();
  await writeFile(dir, "lib/rule.ts", RULE_TS_V1);
  await writeFile(dir, "tests/rule_test.ts", RULE_TEST_TS);
  await commitAll(dir, "base");
  assertEquals(
    (await git(dir, ["update-ref", "refs/remotes/origin/main", "HEAD"])).code,
    0,
  );
  assertEquals((await git(dir, ["checkout", "-b", "issue-7-fix"])).code, 0);
  await writeFile(dir, SUMMARY_PATH, summary);
  if (beforeFacts !== undefined) await writeFile(dir, FACTS_PATH, beforeFacts);
  await commitAll(dir, "docs: add PR summary");
  const rev = await git(dir, ["rev-parse", "HEAD"]);
  return { dir, beforeSha: rev.stdout.trim() };
}

async function run(
  dir: string,
  beforeSha: string,
  runGit: DriftCheckDeps["runGit"] = makeRunGit(dir),
) {
  const calls: AgentCall[] = [];
  const runAgent = makeRunAgent(
    [
      { ok: true, output: verdictBlock([]) },
      { ok: true, output: "did nothing" },
    ],
    calls,
  );
  const outcome = await runPrFeedbackDriftCheck(
    { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
    {
      runGit,
      runGh: makeRunGh(),
      runMutationCheck: notMutationChecked,
      runAgent,
      logger: noopLogger(),
    },
  );
  return { outcome, calls };
}

function assertNotChecked(
  result: Awaited<ReturnType<typeof run>>,
  expected: string,
) {
  const { outcome, calls } = result;
  assertEquals(outcome.status, "reported");
  if (outcome.status === "reported") {
    const unavailable = outcome.residual.citationCheckUnavailable ?? "";
    assertStringIncludes(unavailable, "not checked");
    assertStringIncludes(unavailable, expected);
    assertEquals(outcome.residual.staleCitations ?? [], []);
  }
  assert(!calls.some((c) => !c.readOnly), "no recovery (non-readOnly) call");
}

Deno.test("runPrFeedbackDriftCheck - facts at both heads with the line moved and not renumbered is reported stale", async () => {
  // The prose cites an unmoved file before and the renumbered line now, so
  // only the (unrenumbered) facts can make this stale.
  const { dir, beforeSha } = await setupBaseline(
    proseCiting("lib/other.ts:9"),
    factsJson(2),
  );
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, SUMMARY_PATH, proseCiting("lib/rule.ts:4"));
    const { outcome } = await run(dir, beforeSha);
    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assert(
        outcome.residual.staleCitations?.some((c) =>
          c.includes("lib/rule.ts:2") && c.includes("lib/rule.ts:4")
        ),
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - prose at the before-run head and facts at the head are compared", async () => {
  const stale = await setupBaseline(proseCiting("lib/rule.ts:2"));
  try {
    await writeFile(stale.dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(stale.dir, FACTS_PATH, factsJson(2));
    const { outcome } = await run(stale.dir, stale.beforeSha);
    assertEquals(outcome.status, "reported");
    if (outcome.status === "reported") {
      assert(
        outcome.residual.staleCitations?.some((c) =>
          c.includes("lib/rule.ts:2") && c.includes("lib/rule.ts:4")
        ),
      );
    }
  } finally {
    await Deno.remove(stale.dir, { recursive: true });
  }

  const clean = await setupBaseline(proseCiting("lib/rule.ts:2"));
  try {
    await writeFile(clean.dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(clean.dir, FACTS_PATH, factsJson(4));
    const calls: AgentCall[] = [];
    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: clean.dir, beforeSha: clean.beforeSha },
      {
        runGit: makeRunGit(clean.dir),
        runGh: makeRunGh(),
        runMutationCheck: notMutationChecked,
        runAgent: makeRunAgent([{ ok: true, output: verdictBlock([]) }], calls),
        logger: noopLogger(),
      },
    );
    assertEquals(outcome.status, "clean");
  } finally {
    await Deno.remove(clean.dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - malformed facts at the before-run head are not checked", async () => {
  const { dir, beforeSha } = await setupBaseline(
    proseCiting("lib/rule.ts:2"),
    "{ not json",
  );
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    // The head's facts are valid, so only the before-run head's can fail.
    await writeFile(dir, FACTS_PATH, factsJson(2));
    assertNotChecked(
      await run(dir, beforeSha),
      `${FACTS_PATH} at the before-run head does not parse`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - malformed facts at the head are not checked, with the parse error", async () => {
  const { dir, beforeSha } = await setupBaseline(proseCiting("lib/rule.ts:2"));
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await writeFile(dir, FACTS_PATH, factsJson(0));
    const result = await run(dir, beforeSha);
    assertNotChecked(result, FACTS_PATH);
    assertNotChecked(result, "must be a positive integer");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a facts path that cannot be read at the head is not checked", async () => {
  const { dir, beforeSha } = await setupBaseline(proseCiting("lib/rule.ts:2"));
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    await Deno.mkdir(`${dir}/${FACTS_PATH}`, { recursive: true });
    assertNotChecked(await run(dir, beforeSha), "Failed to read");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - a failed git read of the facts file at the before-run head is not checked", async () => {
  const cases: [string, "code128" | "null"][] = [
    ["ls-tree", "code128"],
    ["show", "code128"],
    ["ls-tree", "null"],
    ["show", "null"],
  ];
  for (const [failing, mode] of cases) {
    const { dir, beforeSha } = await setupBaseline(
      proseCiting("lib/rule.ts:2"),
      factsJson(2),
    );
    try {
      await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
      const real = makeRunGit(dir);
      const runGit: DriftCheckDeps["runGit"] = async (args) => {
        if (args[0] === failing && args.at(-1)!.endsWith(".facts.json")) {
          return mode === "null"
            ? null
            : { code: 128, stdout: "", stderr: "boom" };
        }
        return await real(args);
      };
      assertNotChecked(
        await run(dir, beforeSha, runGit),
        `could not read ${FACTS_PATH} at the before-run head`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("findStaleCitations - a stale facts citation names the facts file and its line/endLine", () => {
  const moved = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: "",
    currentSummary: "",
    previousFacts: facts(2),
    currentFacts: facts(2),
    currentFactsPath: FACTS_PATH,
    changedFiles: ["lib/rule.ts"],
    hunksByPath: INSERT_HUNKS,
  });
  assertEquals(moved.stale.length, 1);
  assert(moved.stale[0]!.startsWith(`${FACTS_PATH}: `));
  assertStringIncludes(moved.stale[0]!, "`line`/`endLine`");

  const changed = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: "",
    currentSummary: "",
    previousFacts: facts(2),
    currentFacts: facts(2),
    currentFactsPath: FACTS_PATH,
    changedFiles: ["lib/rule.ts"],
    hunksByPath: REPLACE_HUNKS,
  });
  assertEquals(changed.stale.length, 1);
  assert(changed.stale[0]!.startsWith(`${FACTS_PATH}: `));
  assertStringIncludes(changed.stale[0]!, "`line`/`endLine`");

  // With prose citations now, the prose summary is the file to edit.
  const prose = findStaleCitations({
    summaryPath: SUMMARY_PATH,
    previousSummary: "",
    currentSummary: proseCiting("lib/rule.ts:2"),
    previousFacts: facts(2),
    currentFacts: null,
    currentFactsPath: FACTS_PATH,
    changedFiles: ["lib/rule.ts"],
    hunksByPath: INSERT_HUNKS,
  });
  assertEquals(prose.stale.length, 1);
  assert(prose.stale[0]!.startsWith(`${SUMMARY_PATH}: `));
  assert(!prose.stale[0]!.includes("`line`/`endLine`"));
});

Deno.test("runPrFeedbackDriftCheck - a recovery turn that renumbers the facts entry reports recovered", async () => {
  const { dir, beforeSha } = await setupBaseline(
    proseCiting("lib/other.ts:9"),
    factsJson(2),
  );
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    const calls: AgentCall[] = [];
    const runAgent = makeRunAgent(
      [
        { ok: true, output: verdictBlock([]) },
        (call) => {
          // The recovery turn is pointed at the facts file, not the prose list.
          assertStringIncludes(
            call.prompt,
            `${FACTS_PATH}: Branch outcomes still cites \`lib/rule.ts:2\``,
          );
          assertStringIncludes(call.prompt, "set that entry's `line`");
          return { ok: true, output: "fixed" };
        },
      ],
      calls,
    );
    const outcome = await runPrFeedbackDriftCheck(
      { ...DEFAULT_INPUT, repoPath: dir, beforeSha },
      {
        runGit: makeRunGit(dir),
        runGh: makeRunGh(),
        runMutationCheck: notMutationChecked,
        runAgent: async (req) => {
          const result = await runAgent(req);
          if (!req.readOnly) await writeFile(dir, FACTS_PATH, factsJson(4));
          return result;
        },
        logger: noopLogger(),
      },
    );
    assertEquals(calls.length, 2);
    assertEquals(calls[1]!.readOnly, false);
    assertEquals(outcome.status, "recovered");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runPrFeedbackDriftCheck - the facts file is looked up by name only, with the path after --", async () => {
  const { dir, beforeSha } = await setupBaseline(
    proseCiting("lib/other.ts:9"),
    factsJson(2),
  );
  try {
    await writeFile(dir, "lib/rule.ts", RULE_TS_V2);
    const real = makeRunGit(dir);
    const gitCalls: string[][] = [];
    const runGit: DriftCheckDeps["runGit"] = async (args) => {
      gitCalls.push(args);
      return await real(args);
    };
    await run(dir, beforeSha, runGit);
    const factsLsTree = gitCalls.filter((a) =>
      a[0] === "ls-tree" && a.at(-1) === FACTS_PATH
    );
    assert(factsLsTree.length > 0, "the facts file was looked up");
    for (const args of factsLsTree) {
      assertEquals(args, [
        "ls-tree",
        "--name-only",
        beforeSha,
        "--",
        FACTS_PATH,
      ]);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
