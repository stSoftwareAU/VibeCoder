/**
 * The repository's formatters run before the completion phase's pre-push gate
 * (part of #2932, building on #2967).
 *
 * A PR sent back by review, or failed by CI, for a formatting-only miss costs a
 * whole round of tokens. The issue run now runs the repo's own formatters over
 * the files the branch changed and commits the result before the gate checks
 * them, so such a miss is fixed rather than failed or shipped.
 *
 * Composition tests: `workOnIssueCompletion` drives the REAL
 * `formatBranchChanges` and the REAL `gateUnpushedCommits` (`deno fmt
 * --check`, `deno lint`) against a real git repository; only the push and the
 * GitHub calls are mocked. Both directions are covered: an unformatted `.ts`
 * change now passes the gate (and Markdown in the change is left
 * byte-identical), while a non-formatting failure still fails it, and a
 * formatter that crashes still leaves the check to report the problem.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { PRE_PUSH_GATE_MARKER } from "../lib/failure_diagnosis.ts";
import { gateUnpushedCommits } from "../lib/git_push.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import { workOnIssueCompletion } from "../lib/phases/completion_phase.ts";
import type { IssueContext, PhaseState } from "../lib/issue_worker_types.ts";
import { createMockDeps } from "../lib/issue_worker_wiring.ts";
import {
  formatBranchChanges,
  FORMATTER_COMMIT_MESSAGE,
  type RepoFormatterDeps,
} from "../lib/repo_formatters.ts";
import type { GitHubClient, Logger, Result, WorkerConfig } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createMissingScopeWarner } from "../lib/workflow_scope.ts";

const BRANCH = "issue-10-tidy-the-worker";

/** Keeps the host's agent-run git config (a pre-push hook) out of the fixture. */
const NO_HOST_GIT_CONFIG = { GIT_CONFIG_COUNT: "0" };

const UNFORMATTED_TS = "export const   x  =  1\n";
const FORMATTED_TS = "export const x = 1;\n";
/** Formatting is fine once fixed, but `deno lint` (prefer-const) still fails. */
const LINT_FAILING_TS = "let   y = 1\nexport { y };\n";
/** Markdown `deno fmt` would rewrite (`*` bullets become `-`). */
const UNFORMATTED_MD = "# Guide\n\n*   one\n*   two\n";
/** Rust `cargo fmt` would rewrite (no space after `fn`, unspaced `->`). */
const UNFORMATTED_RS = "pub fn   add(a:i32,b:i32)->i32 {\n    return a+b;\n}\n";
const FORMATTED_RS =
  "pub fn add(a: i32, b: i32) -> i32 {\n    return a + b;\n}\n";
/** Nested-Deno JSON `deno fmt` would rewrite (collapsed to two-space indent). */
const UNFORMATTED_JSON = '{"a":  1, "b": [1,2,  3], "c": {\n  "d": "e"\n}}\n';
const CARGO_TOML =
  `[package]\nname = "probe"\nversion = "0.1.0"\nedition = "2021"\n\n[workspace]\n`;

const SUMMARY = `## Summary
Tidied the worker. Closes #10.

## Test Plan
- Ran the unit tests.
`;

async function git(args: string[], cwd: string): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    env: NO_HOST_GIT_CONFIG,
  }).output();
  const stderr = new TextDecoder().decode(out.stderr);
  assertEquals(out.code, 0, `git ${args.join(" ")}: ${stderr}`);
  return new TextDecoder().decode(out.stdout);
}

/** Local identity only: the CI runner has no global user.name. */
async function setIdentity(cwd: string): Promise<void> {
  await git(["config", "user.useConfigOnly", "true"], cwd);
  await git(["config", "user.name", "Fixture"], cwd);
  await git(["config", "user.email", "fixture@example.com"], cwd);
}

/**
 * A VibeCoder-shaped repository — a deno root at `worker/deno`, Markdown
 * docs beside it — with one branch commit carrying `files`.
 */
async function makeRepo(
  files: Record<string, string>,
): Promise<{ tmp: string; repo: string }> {
  const tmp = await Deno.makeTempDir({ prefix: "completion_fmt_" });
  const upstream = `${tmp}/upstream.git`;
  const repo = `${tmp}/repo`;
  await git(["init", "--bare", "-b", "main", upstream], tmp);
  await git(["clone", upstream, repo], tmp);
  await setIdentity(repo);
  await Deno.mkdir(`${repo}/worker/deno/lib`, { recursive: true });
  await Deno.writeTextFile(`${repo}/worker/deno/deno.json`, "{}\n");
  await Deno.writeTextFile(`${repo}/worker/deno/lib/base.ts`, FORMATTED_TS);
  await git(["add", "."], repo);
  await git(["commit", "-m", "seed"], repo);
  await git(["push", "origin", "main"], repo);
  await git(["checkout", "-b", BRANCH], repo);
  for (const [path, content] of Object.entries(files)) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(`${repo}/${path.slice(0, slash)}`, { recursive: true });
    }
    await Deno.writeTextFile(`${repo}/${path}`, content);
  }
  await git(["add", "."], repo);
  await git(["commit", "-m", "Agent work"], repo);
  // Untracked, as the agent leaves it: the completion phase reads it.
  await Deno.mkdir(`${repo}/docs/archive/pr-summaries`, { recursive: true });
  await Deno.writeTextFile(
    `${repo}/docs/archive/pr-summaries/pr-summary-10.md`,
    SUMMARY,
  );
  return { tmp, repo };
}

/** True when `cargo` and `rustfmt` are both runnable; the Rust tests skip otherwise. */
async function hasCargo(): Promise<boolean> {
  for (
    const [bin, flag] of [["cargo", "--version"], [
      "rustfmt",
      "--version",
    ]] as const
  ) {
    try {
      const out = await new Deno.Command(bin, {
        args: [flag],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).output();
      if (out.code !== 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * A Rust-workspace repository at the root (no deno root), with one branch
 * commit carrying `branchFiles` over a formatted `src/lib.rs` seed.
 */
async function makeCargoRepo(
  branchFiles: Record<string, string>,
): Promise<{ tmp: string; repo: string }> {
  const tmp = await Deno.makeTempDir({ prefix: "completion_cargo_fmt_" });
  const upstream = `${tmp}/upstream.git`;
  const repo = `${tmp}/repo`;
  await git(["init", "--bare", "-b", "main", upstream], tmp);
  await git(["clone", upstream, repo], tmp);
  await setIdentity(repo);
  await Deno.mkdir(`${repo}/src`, { recursive: true });
  await Deno.writeTextFile(`${repo}/Cargo.toml`, CARGO_TOML);
  await Deno.writeTextFile(`${repo}/src/lib.rs`, FORMATTED_RS);
  await Deno.writeTextFile(`${repo}/README.md`, "# probe\n");
  await git(["add", "."], repo);
  await git(["commit", "-m", "seed"], repo);
  await git(["push", "origin", "main"], repo);
  await git(["checkout", "-b", BRANCH], repo);
  for (const [path, content] of Object.entries(branchFiles)) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(`${repo}/${path.slice(0, slash)}`, { recursive: true });
    }
    await Deno.writeTextFile(`${repo}/${path}`, content);
  }
  await git(["add", "."], repo);
  await git(["commit", "-m", "Agent work"], repo);
  return { tmp, repo };
}

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  security: () => {},
  skipReason: () => {},
  timing: () => {},
  scanSummary: () => {},
  workerSummary: () => {},
};

/** Real formatter deps, with git kept away from the host's agent config. */
function realFormatterDeps(
  runCommand?: RepoFormatterDeps["runCommand"],
): RepoFormatterDeps {
  return {
    runCommand: runCommand ?? (async (cmd, options) => {
      const out = await new Deno.Command(cmd[0]!, {
        args: cmd.slice(1),
        cwd: options?.cwd,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const decoder = new TextDecoder();
      return {
        exitCode: out.code,
        output: decoder.decode(out.stdout) + decoder.decode(out.stderr),
      };
    }),
    runGitCommand: (args, options) =>
      runGitCommand(args, { ...options, env: NO_HOST_GIT_CONFIG }),
    logger: silentLogger,
    runId: () => "fixture-run",
  };
}

function stubClient(): GitHubClient {
  return {
    getIssue: () => {
      throw new Error("stub");
    },
    getIssueComments: () => Promise.resolve([]),
    addLabel: () => Promise.resolve(),
    removeLabel: () => Promise.resolve(),
    postComment: () => Promise.resolve(undefined),
    editIssue: () => Promise.resolve(),
    assignIssue: () => Promise.resolve(),
    unassignIssue: () => Promise.resolve(),
    closeIssue: () => Promise.resolve(),
  };
}

type GitResult = Result<{ code: number; stdout: string; stderr: string }>;

interface Outcome {
  status: string;
  reason?: string;
  pushes: number;
  /** Seam order: "format" and "gate" as each was called. */
  order: string[];
}

async function runCompletion(
  repoPath: string,
  formatter: (repo: string, baseRef: string | undefined) => Promise<unknown>,
): Promise<Outcome> {
  let pushes = 0;
  const order: string[] = [];
  const config: WorkerConfig = buildDefaultWorkerConfig();
  config.infraRetryBackoffMs = 1;
  const ctx: IssueContext = {
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 10,
    issueTitle: "Tidy the worker",
    issueBody: "",
    issueLabels: ["work-on"],
    issueComments: "",
    githubUser: "testbot",
    config,
  };
  const state = {
    branchName: BRANCH,
    defaultBranch: "main",
    repoPath,
  } as PhaseState;
  const deps = createMockDeps({
    github: {
      createClient: () => stubClient(),
      runGhCommand: () =>
        Promise.resolve("https://github.com/stSoftwareAU/VibeCoder/pull/99"),
    },
    git: {
      // Everything else the completion phase asks git is answered by a mock;
      // the formatter and the gate below run their own real git.
      runGitCommand: (cmdArgs: string[]): Promise<GitResult> => {
        const ok = (stdout: string): Promise<GitResult> =>
          Promise.resolve({
            ok: true as const,
            value: { code: 0, stdout, stderr: "" },
          });
        if (cmdArgs[0] === "rev-parse") {
          return ok("1f0c2b3a4d5e6f708192a3b4c5d6e7f8091a2b3c\n");
        }
        if (cmdArgs[0] === "rev-list") return ok("1\n");
        return ok("");
      },
      formatBranchChanges: async (repo, baseRef) => {
        order.push("format");
        return await formatter(repo, baseRef) as never;
      },
      gateUnpushedCommits: (...args) => {
        order.push("gate");
        return gateUnpushedCommits(
          args[0],
          { ...args[1], env: NO_HOST_GIT_CONFIG },
          args[2],
          args[3],
          args[4],
        );
      },
      pushUnpushedCommits: () => {
        pushes++;
        return Promise.resolve({ ok: true as const, value: 1 });
      },
    },
    pr: {
      findExistingPrForIssue: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
      findExistingPrForBranch: () =>
        Promise.resolve({ ok: false, error: new Error("none") }),
    },
    infrastructure: {
      workflowScopeState: () => "granted",
      warnMissingWorkflowScope: createMissingScopeWarner(),
    },
  });
  const result = await workOnIssueCompletion(ctx, state, deps);
  return {
    status: result.status,
    reason: result.status === "failure" ? result.reason : undefined,
    pushes,
    order,
  };
}

const real = (repo: string, baseRef: string | undefined) =>
  formatBranchChanges(repo, baseRef, realFormatterDeps());

Deno.test({
  name:
    "completion - an unformatted .ts change is formatted and committed, then passes the gate; Markdown is untouched",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const { tmp, repo } = await makeRepo({
      "worker/deno/lib/a.ts": UNFORMATTED_TS,
      "docs/GUIDE.md": UNFORMATTED_MD,
    });
    try {
      // Positive control: without the formatters the gate fails this branch.
      const before = await gateUnpushedCommits(
        BRANCH,
        { cwd: repo, env: NO_HOST_GIT_CONFIG },
        { commands: [] },
        false,
        "origin/main",
      );
      assert(!before.ok, "the unformatted change must fail the bare gate");

      const o = await runCompletion(repo, real);
      assertEquals(o.order.slice(0, 2), ["format", "gate"]);
      assertEquals(o.pushes, 1, `gate should pass: ${o.reason ?? ""}`);
      assert(!(o.reason ?? "").includes("PRE_PUSH_BLOCKED"));

      assertEquals(
        await Deno.readTextFile(`${repo}/worker/deno/lib/a.ts`),
        FORMATTED_TS,
      );
      assertEquals(
        await Deno.readTextFile(`${repo}/docs/GUIDE.md`),
        UNFORMATTED_MD,
        "Markdown in the change must be left byte-identical",
      );
      const subject = (await git(["log", "-1", "--format=%s"], repo)).trim();
      assertEquals(subject, FORMATTER_COMMIT_MESSAGE);
      const touched = (await git(
        ["show", "--name-only", "--format=", "HEAD"],
        repo,
      )).trim();
      assertEquals(touched, "worker/deno/lib/a.ts");
      assertEquals(
        (await git(["status", "--porcelain"], repo)).includes(
          "a.ts",
        ),
        false,
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "completion - Markdown inside the deno root is never formatted; the gate still reports it",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const { tmp, repo } = await makeRepo({
      "worker/deno/lib/a.ts": UNFORMATTED_TS,
      "worker/deno/NOTES.md": UNFORMATTED_MD,
    });
    try {
      const o = await runCompletion(repo, real);
      assertEquals(o.status, "failure");
      assertEquals(o.pushes, 0);
      assert((o.reason ?? "").startsWith(PRE_PUSH_GATE_MARKER));
      assertStringIncludes(o.reason ?? "", "NOTES.md");
      assertEquals(
        await Deno.readTextFile(`${repo}/worker/deno/NOTES.md`),
        UNFORMATTED_MD,
      );
      // The code half was still fixed.
      assertEquals(
        await Deno.readTextFile(`${repo}/worker/deno/lib/a.ts`),
        FORMATTED_TS,
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "completion - a non-formatting failure still fails the gate after the formatters run",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const { tmp, repo } = await makeRepo({
      "worker/deno/lib/a.ts": LINT_FAILING_TS,
    });
    try {
      const o = await runCompletion(repo, real);
      assertEquals(o.status, "failure");
      assertEquals(o.pushes, 0, "a lint failure must never reach the push");
      assert((o.reason ?? "").startsWith(PRE_PUSH_GATE_MARKER));
      assertStringIncludes(o.reason ?? "", "deno lint");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "completion - a formatter that crashes leaves the check to report the problem",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const { tmp, repo } = await makeRepo({
      "worker/deno/lib/a.ts": UNFORMATTED_TS,
    });
    try {
      const crashing = (r: string, baseRef: string | undefined) =>
        formatBranchChanges(
          r,
          baseRef,
          realFormatterDeps(() => {
            throw new Error("spawn deno: No such file or directory");
          }),
        );
      const o = await runCompletion(repo, crashing);
      assertEquals(o.status, "failure");
      assertEquals(o.pushes, 0);
      assert((o.reason ?? "").startsWith(PRE_PUSH_GATE_MARKER));
      assertStringIncludes(o.reason ?? "", "deno fmt --check");
      assertStringIncludes(o.reason ?? "", "a.ts");
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "completion - a formatter seam that throws never fails the run on its own; the gate still runs",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const { tmp, repo } = await makeRepo({
      "worker/deno/lib/a.ts": "export const z = 1;\n",
    });
    try {
      const o = await runCompletion(repo, () => {
        throw new Error("formatter seam exploded");
      });
      assertEquals(o.order.slice(0, 2), ["format", "gate"]);
      assertEquals(o.pushes, 1, `gate should pass: ${o.reason ?? ""}`);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "completion - an unformatted Rust change is formatted and committed, then passes the gate",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    if (!await hasCargo()) {
      console.warn("skipping Rust formatter test: cargo/rustfmt not installed");
      return;
    }
    const { tmp, repo } = await makeCargoRepo({ "src/lib.rs": UNFORMATTED_RS });
    try {
      const before = await gateUnpushedCommits(
        BRANCH,
        { cwd: repo, env: NO_HOST_GIT_CONFIG },
        { commands: [] },
        false,
        "origin/main",
      );
      assert(!before.ok, "the unformatted Rust change must fail the bare gate");

      const result = await formatBranchChanges(
        repo,
        "origin/main",
        realFormatterDeps(),
      );
      assert(
        result.committed,
        result.gitError ?? "formatter should commit the Rust fix",
      );
      assertEquals(await Deno.readTextFile(`${repo}/src/lib.rs`), FORMATTED_RS);

      const after = await gateUnpushedCommits(
        BRANCH,
        { cwd: repo, env: NO_HOST_GIT_CONFIG },
        { commands: [] },
        false,
        "origin/main",
      );
      assert(after.ok, after.ok ? "" : after.error.message);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "completion - an unformatted nested-Deno JSON change is formatted and committed, then passes the gate",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const { tmp, repo } = await makeRepo({
      "worker/deno/data.json": UNFORMATTED_JSON,
    });
    try {
      const before = await gateUnpushedCommits(
        BRANCH,
        { cwd: repo, env: NO_HOST_GIT_CONFIG },
        { commands: [] },
        false,
        "origin/main",
      );
      assert(!before.ok, "the unformatted JSON change must fail the bare gate");

      const result = await formatBranchChanges(
        repo,
        "origin/main",
        realFormatterDeps(),
      );
      assert(
        result.committed,
        result.gitError ?? "formatter should commit the JSON fix",
      );

      const after = await gateUnpushedCommits(
        BRANCH,
        { cwd: repo, env: NO_HOST_GIT_CONFIG },
        { commands: [] },
        false,
        "origin/main",
      );
      assert(after.ok, after.ok ? "" : after.error.message);
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "completion - cargo fmt stages only the branch's .rs files, not an unrelated uncommitted edit",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    if (!await hasCargo()) {
      console.warn("skipping cargo staging test: cargo/rustfmt not installed");
      return;
    }
    const { tmp, repo } = await makeCargoRepo({ "src/lib.rs": UNFORMATTED_RS });
    try {
      // An unrelated, uncommitted edit to a tracked non-Rust file, left in the
      // working tree exactly as the agent would leave it.
      await Deno.writeTextFile(
        `${repo}/README.md`,
        "# probe (edited, uncommitted)\n",
      );

      const result = await formatBranchChanges(
        repo,
        "origin/main",
        realFormatterDeps(),
      );
      assert(
        result.committed,
        result.gitError ?? "formatter should commit the Rust fix",
      );

      const touched = (await git(
        ["show", "--name-only", "--format=", "HEAD"],
        repo,
      )).trim();
      assertEquals(touched, "src/lib.rs");
      assert(
        (await git(["status", "--porcelain"], repo)).includes("README.md"),
        "the unrelated README edit must stay uncommitted",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});
