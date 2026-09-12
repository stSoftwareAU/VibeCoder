/**
 * A conflicted milestone sync resolves what it can and escalates only what it
 * cannot (Issue #1559).
 *
 * Real git repositories throughout — a bare remote, a clone, a milestone
 * branch and a default branch that has moved on — because the decisions being
 * pinned here are decisions about a conflicted index, and a stub of one proves
 * nothing about the real thing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { syncMilestoneBranchWithDefault } from "../lib/git_pull.ts";
import { isConflictEscalation } from "../lib/milestone_conflict_triage.ts";
import type { MergeGateFn } from "../lib/milestone_merge_gate.ts";
import type {
  MilestoneConflictAgentFn,
  MilestoneConflictAgentRequest,
} from "../lib/milestone_conflict_ladder.ts";
import type { MergeConflictAgentOutcome } from "../lib/merge_conflict_agent.ts";
import type { Result } from "../types.ts";

async function git(
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = new TextDecoder();
  return {
    code: out.code,
    stdout: decode.decode(out.stdout),
    stderr: decode.decode(out.stderr),
  };
}

async function gitOk(args: string[], cwd: string): Promise<string> {
  const r = await git(args, cwd);
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  }
  return r.stdout;
}

interface Fixture {
  clone: string;
  cleanup: () => Promise<void>;
}

/** What one side writes to a file, and the commit subject it writes it under. */
interface Side {
  files: Record<string, string>;
  subject: string;
  /** Paths this side deletes. */
  remove?: string[];
}

/**
 * A remote whose `main` and `milestone/1559` both moved over the same files.
 *
 * @param seedFiles - The content both branches start from
 * @param milestone - What the milestone branch changed
 * @param main - What the default branch changed
 */
async function setup(
  seedFiles: Record<string, string>,
  milestone: Side,
  main: Side,
): Promise<Fixture> {
  const root = await Deno.makeTempDir({ prefix: "issue-1559-" });
  const remote = `${root}/remote.git`;
  const seed = `${root}/seed`;
  await Deno.mkdir(remote, { recursive: true });
  await gitOk(["init", "--bare", "--initial-branch=main", "."], remote);
  await gitOk(["clone", remote, seed], root);
  await gitOk(["config", "user.email", "t@example.com"], seed);
  await gitOk(["config", "user.name", "Test"], seed);

  const write = async (
    files: Record<string, string>,
    remove: string[] = [],
  ) => {
    for (const [path, content] of Object.entries(files)) {
      const dir = path.includes("/")
        ? `${seed}/${path.slice(0, path.lastIndexOf("/"))}`
        : seed;
      await Deno.mkdir(dir, { recursive: true });
      await Deno.writeTextFile(`${seed}/${path}`, content);
    }
    for (const path of remove) await Deno.remove(`${seed}/${path}`);
    await gitOk(["add", "-A"], seed);
  };

  await write(seedFiles);
  await gitOk(["commit", "-m", "Seed"], seed);
  await gitOk(["push", "origin", "main"], seed);

  await gitOk(["checkout", "-b", "milestone/1559"], seed);
  await write(milestone.files, milestone.remove ?? []);
  await gitOk(["commit", "-m", milestone.subject], seed);
  await gitOk(["push", "origin", "milestone/1559"], seed);

  await gitOk(["checkout", "main"], seed);
  await write(main.files, main.remove ?? []);
  await gitOk(["commit", "-m", main.subject], seed);
  await gitOk(["push", "origin", "main"], seed);

  const clone = `${root}/clone`;
  await gitOk(["clone", remote, clone], root);
  await gitOk(["config", "user.email", "t@example.com"], clone);
  await gitOk(["config", "user.name", "Test"], clone);
  await gitOk(["checkout", "milestone/1559"], clone);

  return {
    clone,
    cleanup: () => Deno.remove(root, { recursive: true }).catch(() => {}),
  };
}

const passingGate: MergeGateFn = () =>
  Promise.resolve({ status: "passed" as const, detail: "checked", output: "" });

// ---------------------------------------------------------------------------
// Case 1 — the same fix landed twice
// ---------------------------------------------------------------------------

Deno.test(
  "syncMilestoneBranchWithDefault - the same fix landed twice resolves without a human, with the reasoning on the merge commit (Issue #1559)",
  async () => {
    const fx = await setup(
      {
        "lib/spawn.ts": "export const impl = 'seed';\n",
        "tests/spawn_test.ts": 'Deno.test("shared case", () => {});\n',
      },
      {
        files: {
          "lib/spawn.ts": "export const impl = 'branch';\n",
          "tests/spawn_test.ts":
            'Deno.test("shared case", () => {});\nDeno.test("branch adds a case", () => {});\n',
        },
        subject: "Fixes #1270: bound the spawn fallback",
      },
      {
        files: {
          "lib/spawn.ts": "export const impl = 'main';\n",
          "tests/spawn_test.ts": 'Deno.test("shared case", () => {});\n',
        },
        subject: "Fixes #1270: bound the spawn fallback (again)",
      },
    );
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(
        result.ok,
        `expected the duplicate fix to resolve: ${
          !result.ok && result.error.message
        }`,
      );
      assertEquals(
        await Deno.readTextFile(`${fx.clone}/lib/spawn.ts`),
        "export const impl = 'branch';\n",
        "the side whose tests are a superset is the one kept",
      );
      assertStringIncludes(
        await Deno.readTextFile(`${fx.clone}/tests/spawn_test.ts`),
        "branch adds a case",
      );

      const message = await gitOk(
        ["log", "-1", "--format=%B", "milestone/1559"],
        fx.clone,
      );
      assertStringIncludes(message, "duplicate-fix");
      assertStringIncludes(message, "#1270");
      assertStringIncludes(message, "lib/spawn.ts");
      assertEquals(result.value.conflict?.resolution, "auto");
    } finally {
      await fx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// The coverage rule
// ---------------------------------------------------------------------------

Deno.test(
  "syncMilestoneBranchWithDefault - a conflicted test file resolves as a union, never by taking one side (Issue #1559)",
  async () => {
    const fx = await setup(
      { "tests/gate_test.ts": 'Deno.test("shared case", () => {});\n' },
      {
        files: {
          "tests/gate_test.ts":
            'Deno.test("shared case", () => {});\nDeno.test("branch only", () => {});\n',
        },
        subject: "Issue #1557: the branch's cases",
      },
      {
        files: {
          "tests/gate_test.ts":
            'Deno.test("shared case", () => {});\nDeno.test("main only", () => {});\n',
        },
        subject: "Issue #1557: main's cases",
      },
    );
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(
        result.ok,
        `expected the union to land: ${!result.ok && result.error.message}`,
      );
      const merged = await Deno.readTextFile(`${fx.clone}/tests/gate_test.ts`);
      assertStringIncludes(merged, "branch only");
      assertStringIncludes(
        merged,
        "main only",
        "a union keeps both sides' cases — taking a side would drop one",
      );
      assertEquals(result.value.conflict?.decisions?.[0]?.action, "union");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a test file whose union would lose a case escalates instead (Issue #1559)",
  async () => {
    // The default branch DELETED the branch's test file: there is no union to
    // build, and deleting it would drop its cases.
    const fx = await setup(
      { "tests/gate_test.ts": 'Deno.test("shared case", () => {});\n' },
      {
        files: {
          "tests/gate_test.ts":
            'Deno.test("shared case", () => {});\nDeno.test("branch only", () => {});\n',
        },
        subject: "Issue #1557: the branch's cases",
      },
      {
        files: {},
        subject: "main removes the gate test",
        remove: [
          "tests/gate_test.ts",
        ],
      },
    );
    try {
      const published = (await gitOk(["rev-parse", "milestone/1559"], fx.clone))
        .trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(!result.ok, "a test file with no union to build reaches a human");
      assert(isConflictEscalation(result.error));
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        published,
        "the branch is exactly as it was",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Append-only ledgers — both inserted, nothing deleted (Issue #1768)
// ---------------------------------------------------------------------------

Deno.test(
  "syncMilestoneBranchWithDefault - a CHANGELOG both branches appended to keeps both entries, the default branch's first (Issue #1768)",
  async () => {
    const fx = await setup(
      { "CHANGELOG.md": "# Changelog\n\n## Unreleased\n" },
      {
        files: {
          "CHANGELOG.md":
            "# Changelog\n\n## Unreleased\n\n- the branch's entry\n",
        },
        subject: "Issue #1768: the branch's entry",
      },
      {
        files: {
          "CHANGELOG.md": "# Changelog\n\n## Unreleased\n\n- main's entry\n",
        },
        subject: "Issue #1768: main's entry",
      },
    );
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(
        result.ok,
        `expected the ledger union to land: ${
          !result.ok && result.error.message
        }`,
      );
      assertEquals(
        await Deno.readTextFile(`${fx.clone}/CHANGELOG.md`),
        "# Changelog\n\n## Unreleased\n\n- main's entry\n- the branch's entry\n",
      );
      assertEquals(result.value.conflict?.decisions?.[0]?.action, "union");
      assertEquals(
        result.value.conflict?.decisions?.[0]?.case,
        "both-inserted",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a JSON ledger whose union does not parse escalates rather than being written (Issue #1768)",
  async () => {
    // Both sides appended an entry to the same array, so the union leaves two
    // objects with no comma between them.
    const seed = '{\n  "entries": [\n  ]\n}\n';
    const fx = await setup(
      { "docs/audits/ledger.json": seed },
      {
        files: {
          "docs/audits/ledger.json":
            '{\n  "entries": [\n    { "id": "branch" }\n  ]\n}\n',
        },
        subject: "Issue #1768: the branch's audit entry",
      },
      {
        files: {
          "docs/audits/ledger.json":
            '{\n  "entries": [\n    { "id": "main" }\n  ]\n}\n',
        },
        subject: "Issue #1768: main's audit entry",
      },
    );
    try {
      const published = (await gitOk(["rev-parse", "milestone/1559"], fx.clone))
        .trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(!result.ok, "an unparseable JSON union must not be written");
      assert(isConflictEscalation(result.error));
      assertStringIncludes(result.error.message, "does not parse as JSON");
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        published,
        "the branch is exactly as it was",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a .json the structural union refuses says why, alongside the parse failure (Issue #2013)",
  async () => {
    // A hand-formatted empty array (`[\n  ]`) is not what JSON.stringify
    // emits, so the structural union declines rather than reformat lines
    // neither side touched. The textual union then leaves two objects with no
    // comma between them, exactly as before — but the escalation now also
    // names why the by-value merge was not available, so a human reading it is
    // not left to guess which rung declined.
    const fx = await setup(
      { "docs/audits/ledger.json": '{\n  "entries": [\n  ]\n}\n' },
      {
        files: {
          "docs/audits/ledger.json":
            '{\n  "entries": [\n    { "id": "branch" }\n  ]\n}\n',
        },
        subject: "Issue #2013: the branch's audit entry",
      },
      {
        files: {
          "docs/audits/ledger.json":
            '{\n  "entries": [\n    { "id": "main" }\n  ]\n}\n',
        },
        subject: "Issue #2013: main's audit entry",
      },
    );
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(!result.ok, "an unparseable JSON union must not be written");
      assert(isConflictEscalation(result.error));
      assertStringIncludes(result.error.message, "does not parse as JSON");
      assertStringIncludes(
        result.error.message,
        "it was not unioned as JSON first",
      );
      assertStringIncludes(result.error.message, "round-trip");
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - two appended ledger slices are unioned by value, not escalated (Issue #2013)",
  async () => {
    // The shape `docs/audits/lib-sweep-coverage.json` actually produces: each
    // branch appends a slice to the same array, so the hunk falls *inside* the
    // appended object and no arrangement of the two sides' text is valid JSON.
    // The textual union could only refuse it; the structural one merges it.
    const ledger = (slices: { slice: string; files: number }[]): string =>
      JSON.stringify({ slices }, null, 2) + "\n";
    const seed = { slice: "seed", files: 1 };
    const path = "docs/audits/lib-sweep-coverage.json";
    const fx = await setup(
      { [path]: ledger([seed]) },
      {
        files: { [path]: ledger([seed, { slice: "milestone", files: 3 }]) },
        subject: "Issue #2013: the branch's sweep slice",
      },
      {
        files: { [path]: ledger([seed, { slice: "main", files: 5 }]) },
        subject: "Issue #2013: main's sweep slice",
      },
    );
    try {
      const published = (await gitOk(["rev-parse", "milestone/1559"], fx.clone))
        .trim();

      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
      );

      assert(
        result.ok,
        `expected the JSON ledger union to land: ${
          !result.ok && result.error.message
        }`,
      );
      // Both slices survive, the default branch's first, in the file's own
      // formatting — and the result is a document that parses.
      assertEquals(
        await Deno.readTextFile(`${fx.clone}/${path}`),
        ledger([
          seed,
          { slice: "main", files: 5 },
          { slice: "milestone", files: 3 },
        ]),
      );
      assertEquals(result.value.conflict?.decisions?.[0]?.action, "union");
      assertEquals(
        result.value.conflict?.decisions?.[0]?.case,
        "both-inserted",
      );
      assert(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim() !== published,
        "the resolution should have been committed",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// A resolution that cannot be verified is not a resolution
// ---------------------------------------------------------------------------

Deno.test(
  "syncMilestoneBranchWithDefault - a resolution nothing could verify is refused, not pushed (Issue #1559)",
  async () => {
    const fx = await setup(
      { "lib/spawn.ts": "const a = 1;\n" },
      {
        files: { "lib/spawn.ts": "const a = 1;\nconst branch = true;\n" },
        subject: "Issue #1559: the branch's side",
      },
      {
        files: {
          "lib/spawn.ts":
            "const a = 1;\nconst branch = true;\nconst bounded = true;\n",
        },
        subject: "Issue #1559: main subsumes it",
      },
    );
    try {
      const published = (await gitOk(["rev-parse", "milestone/1559"], fx.clone))
        .trim();

      // No gate injected: the real resolution gate finds no Deno project in
      // this tree, so nothing verified the resolution.
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
      );

      assert(!result.ok, "an unverified resolution must not be pushed");
      assertStringIncludes(result.error.message, "Issue #1559");
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        published,
        "the local merge is reset away",
      );
      assertEquals(
        (await gitOk(["rev-parse", "origin/milestone/1559"], fx.clone)).trim(),
        published,
        "nothing reached the remote",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// The ladder — rules, then the agent, before any human (Issue #1777)
// ---------------------------------------------------------------------------

/** A `deno.json` whose import map pins `@std/assert` at `version`. */
function denoJson(version: string): string {
  return `{\n  "imports": {\n    "@std/assert": "jsr:@std/assert@${version}"\n  }\n}\n`;
}

/** An agent stub that records its calls and does whatever `act` says. */
function recordingAgent(
  act: (request: MilestoneConflictAgentRequest) => Promise<
    Result<MergeConflictAgentOutcome>
  >,
): { fn: MilestoneConflictAgentFn; calls: MilestoneConflictAgentRequest[] } {
  const calls: MilestoneConflictAgentRequest[] = [];
  return {
    calls,
    fn: (request) => {
      calls.push(request);
      return act(request);
    },
  };
}

Deno.test(
  "syncMilestoneBranchWithDefault - a manifest conflict the triage cannot decide is settled by the dependency rules and pushed, with no agent run (Issue #1777)",
  async () => {
    const fx = await setup(
      { "deno.json": denoJson("1.0.0") },
      {
        files: { "deno.json": denoJson("1.0.1") },
        subject: "Issue #1777: the branch bumped assert",
      },
      {
        files: { "deno.json": denoJson("1.0.6") },
        subject: "Issue #1777: main bumped assert",
      },
    );
    const agent = recordingAgent(() =>
      Promise.resolve({ ok: true as const, value: { terminated: false } })
    );
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
        undefined,
        agent.fn,
      );

      assert(
        result.ok,
        `expected the rules to settle the manifest: ${
          !result.ok && result.error.message
        }`,
      );
      assertEquals(
        agent.calls.length,
        0,
        "a file the deterministic rules can decide never reaches the agent",
      );
      assertStringIncludes(
        await Deno.readTextFile(`${fx.clone}/deno.json`),
        "1.0.6",
        "the higher published version wins, per the dependency rules",
      );
      const decision = result.value.conflict?.decisions?.find((d) =>
        d.path === "deno.json"
      );
      assertEquals(decision?.rung, "rule");
      assertStringIncludes(result.value.message, "rule:");
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        (await gitOk(["rev-parse", "origin/milestone/1559"], fx.clone)).trim(),
        "the resolution is pushed in the same call",
      );
      assertStringIncludes(
        await gitOk(["log", "-1", "--format=%B", "milestone/1559"], fx.clone),
        "rule:",
        "the merge commit names the rung that settled each file",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - a source conflict neither the triage nor the rules can decide is handed to the agent, then gated and pushed (Issue #1777)",
  async () => {
    const fx = await setup(
      { "lib/spawn.ts": "export const impl = 'seed';\n" },
      {
        files: { "lib/spawn.ts": "export const impl = 'branch';\n" },
        subject: "Issue #1777: the branch's design",
      },
      {
        files: { "lib/spawn.ts": "export const impl = 'main';\n" },
        subject: "Issue #1777: main's rival design",
      },
    );
    // A conforming agent resolves the file and stages it, exactly as the
    // merge-conflict prompt instructs and as the PR pass already requires.
    const agent = recordingAgent(async (request) => {
      await Deno.writeTextFile(
        `${request.workDir}/lib/spawn.ts`,
        "export const impl = 'branch' ?? 'main';\n",
      );
      await gitOk(["add", "--", "lib/spawn.ts"], request.workDir);
      return { ok: true as const, value: { terminated: false } };
    });
    try {
      const result = await syncMilestoneBranchWithDefault(
        "milestone/1559",
        "main",
        { cwd: fx.clone },
        undefined,
        passingGate,
        undefined,
        agent.fn,
      );

      assert(
        result.ok,
        `expected the agent's resolution to land: ${
          !result.ok && result.error.message
        }`,
      );
      assertEquals(agent.calls.length, 1);
      assertEquals(agent.calls[0]?.conflictedFiles, ["lib/spawn.ts"]);
      assertEquals(agent.calls[0]?.milestoneBranch, "milestone/1559");
      assertEquals(agent.calls[0]?.defaultBranch, "main");
      assertEquals(
        await Deno.readTextFile(`${fx.clone}/lib/spawn.ts`),
        "export const impl = 'branch' ?? 'main';\n",
        "what the agent wrote is what was committed",
      );
      assertEquals(
        result.value.conflict?.decisions?.[0]?.rung,
        "agent",
        "the outcome names the rung that settled the file",
      );
      assertStringIncludes(result.value.message, "agent");
      assertEquals(
        (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
        (await gitOk(["rev-parse", "origin/milestone/1559"], fx.clone)).trim(),
        "the agent's resolution is pushed in the same call",
      );
    } finally {
      await fx.cleanup();
    }
  },
);

Deno.test(
  "syncMilestoneBranchWithDefault - an agent that aborts leaves the branch at its pre-merge SHA and names the failed rung (Issue #1777)",
  async () => {
    for (
      const [what, outcome] of [
        [
          "a failed run",
          { ok: false as const, error: new Error("agent run failed: refused") },
        ],
        [
          "a run the worker ended",
          { ok: true as const, value: { terminated: true } },
        ],
      ] as const
    ) {
      const fx = await setup(
        { "lib/spawn.ts": "export const impl = 'seed';\n" },
        {
          files: { "lib/spawn.ts": "export const impl = 'branch';\n" },
          subject: "Issue #1777: the branch's design",
        },
        {
          files: { "lib/spawn.ts": "export const impl = 'main';\n" },
          subject: "Issue #1777: main's rival design",
        },
      );
      // Half-edits the tree first: an agent that aborts mid-resolution must
      // still leave the branch exactly where it started.
      const agent = recordingAgent(async (request) => {
        await Deno.writeTextFile(
          `${request.workDir}/lib/spawn.ts`,
          "export const impl = 'half-edited';\n",
        );
        return outcome;
      });
      try {
        const published =
          (await gitOk(["rev-parse", "milestone/1559"], fx.clone)).trim();

        const result = await syncMilestoneBranchWithDefault(
          "milestone/1559",
          "main",
          { cwd: fx.clone },
          undefined,
          passingGate,
          undefined,
          agent.fn,
        );

        assert(!result.ok, `${what}: nothing may be pushed`);
        assert(isConflictEscalation(result.error), `${what}: an escalation`);
        assertStringIncludes(
          result.error.message,
          "agent: ",
          `${what}: the escalation names the agent as the rung that failed, ` +
            `not merely that no agent ran`,
        );
        assertEquals(
          (await gitOk(["rev-parse", "HEAD"], fx.clone)).trim(),
          published,
          `${what}: the branch is exactly at its pre-merge SHA`,
        );
        assertEquals(
          (await gitOk(["rev-parse", "origin/milestone/1559"], fx.clone))
            .trim(),
          published,
          `${what}: nothing reached the remote`,
        );
        assertEquals(
          (await gitOk(["status", "--porcelain"], fx.clone)).trim(),
          "",
          `${what}: the agent's half-edit is gone with the aborted merge`,
        );
      } finally {
        await fx.cleanup();
      }
    }
  },
);
