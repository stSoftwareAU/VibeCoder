/**
 * The repository's formatters run before the PR-feedback and CI-fix pushes
 * (follow-up to #3806, part of #2932).
 *
 * #3806 formats the issue run's changes before its gates. A review-fix or
 * CI-fix round pushes through `commitAndPushPending` instead, whose Step 1b
 * gate only ran `deno fmt --check` — so a formatting-only miss in a fix round
 * failed the push, or (with no pre-flight configured) shipped to CI and cost
 * another round. Both processors now format the round's unpushed commits
 * between Step 1's commit and Step 1b's gate.
 *
 * Composition tests: the REAL processor entry points (`processPrFeedback`,
 * `processCiFailure`) drive the REAL `commitAndPushPending`, the REAL
 * `formatBranchChanges` and the REAL Step 1b gate (`deno fmt --check`, `deno
 * lint`) against a real repository with a real bare remote. Only the agent,
 * GitHub and the remote-landing verification are mocked.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type PrFeedbackInput,
  type PrFeedbackProcessorDeps,
  processPrFeedback,
} from "../lib/pr_feedback_processor.ts";
import {
  type CiFixInput,
  type CiProcessorDeps,
  processCiFailure,
} from "../lib/pr_ci_processor.ts";
import { commitAndPushPending } from "../lib/git_push.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  createMockDeps,
  type GitDeps,
  type GitHubDeps,
} from "../lib/issue_worker_wiring.ts";
import {
  formatBranchChanges,
  FORMATTER_COMMIT_MESSAGE,
  type RepoFormatterDeps,
} from "../lib/repo_formatters.ts";
import type { Logger, RepoConfig } from "../types.ts";
import { isPrLiveStateRead } from "./support/pr_live_state_stub.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const REPO = "org/repo";
const BRANCH = "issue-2524-feedback";

/** Keeps the host's agent-run git config (a pre-push hook) out of the fixture. */
const NO_HOST_GIT_CONFIG = { GIT_CONFIG_COUNT: "0" };

const UNFORMATTED_TS = "export const   x  =  1\n";
const FORMATTED_TS = "export const x = 1;\n";
/** Formatting is fine once fixed, but `deno lint` (prefer-const) still fails. */
const LINT_FAILING_TS = "let   y = 1\nexport { y };\n";
/** Markdown `deno fmt` would rewrite (`*` bullets become `-`). */
const UNFORMATTED_MD = "# Guide\n\n*   one\n*   two\n";

/** A configured pre-flight turns on `commitAndPushPending`'s Step 1b gate. */
const GATED: Record<string, RepoConfig> = {
  [REPO]: { preFlight: ["true"] } as unknown as RepoConfig,
};

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

interface Fixture {
  tmp: string;
  repo: string;
  upstream: string;
  /** The PR branch tip on the remote before the round. */
  remoteTipBefore: string;
}

/** A VibeCoder-shaped PR branch, already pushed, checked out in a clone. */
async function makeFixture(): Promise<Fixture> {
  const tmp = await Deno.makeTempDir({ prefix: "pr_round_fmt_" });
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
  await Deno.writeTextFile(
    `${repo}/worker/deno/lib/feature.ts`,
    "export const feature = true;\n",
  );
  await git(["add", "."], repo);
  await git(["commit", "-m", "Agent work"], repo);
  await git(["push", "-u", "origin", BRANCH], repo);
  const remoteTipBefore = (await git(["rev-parse", BRANCH], upstream)).trim();
  return { tmp, repo, upstream, remoteTipBefore };
}

async function writeFiles(
  repo: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const slash = path.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(`${repo}/${path.slice(0, slash)}`, { recursive: true });
    }
    await Deno.writeTextFile(`${repo}/${path}`, content);
  }
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
function realFormatterDeps(): RepoFormatterDeps {
  return {
    runCommand: async (cmd, options) => {
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
    },
    runGitCommand: (args, options) =>
      runGitCommand(args, { ...options, env: NO_HOST_GIT_CONFIG }),
    logger: silentLogger,
    runId: () => "fixture-run",
  };
}

const ghStub: GitHubDeps["runGhCommand"] = ((args: string[]) => {
  if (isPrLiveStateRead(args)) return Promise.resolve("OPEN");
  if (args[0] === "label" && args[1] === "list") return Promise.resolve("[]");
  return Promise.resolve("");
}) as GitHubDeps["runGhCommand"];

const REMOTE_CONFIRMS_PUSH = () =>
  Promise.resolve({
    landed: true,
    localSha: "f".repeat(40),
    remoteSha: "f".repeat(40),
    reason: "verified in test",
  });

/**
 * Deps whose agent run is `agent`, and whose final mile is the real
 * `commitAndPushPending` + formatters on the fixture.
 */
function makeDeps(
  agent: () => Promise<void>,
  formatter?: GitDeps["formatBranchChanges"],
) {
  return createMockDeps({
    claude: {
      runClaudeWithRetry: (async () => {
        await agent();
        return { ok: true, value: { output: "Fixed", exitCode: 0 } };
      }) as never,
    },
    github: { runGhCommand: ghStub },
    git: {
      commitAndPushPending: ((...a: Parameters<typeof commitAndPushPending>) =>
        commitAndPushPending(
          a[0],
          a[1],
          { ...a[2], env: NO_HOST_GIT_CONFIG },
          a[3],
          a[4],
          a[5],
          a[6],
        )) as GitDeps["commitAndPushPending"],
      formatBranchChanges: formatter ??
        ((repo, baseRef) =>
          formatBranchChanges(repo, baseRef, realFormatterDeps())),
    },
  });
}

async function runFeedbackRound(
  fx: Fixture,
  agentFiles: Record<string, string>,
  repoConfigs: Record<string, RepoConfig> | undefined,
  formatter?: GitDeps["formatBranchChanges"],
) {
  const input: PrFeedbackInput = {
    repo: REPO,
    prNumber: 2524,
    branchName: BRANCH,
    commentType: "review",
    commentId: "999",
    commentBody: "Please tidy the feature",
  };
  const processorDeps: PrFeedbackProcessorDeps = {
    promptsDir: PROMPTS_DIR,
    logger: silentLogger,
    // The agent leaves its fix uncommitted, as a review round usually does.
    deps: makeDeps(() => writeFiles(fx.repo, agentFiles), formatter),
    workDir: fx.repo,
    workRoot: fx.tmp,
    verifyPushFn: REMOTE_CONFIRMS_PUSH,
    ...(repoConfigs ? { repoConfigs } : {}),
  };
  return await processPrFeedback(input, processorDeps);
}

const remoteFile = (fx: Fixture, path: string) =>
  git(["show", `${BRANCH}:${path}`], fx.upstream);

for (
  const [label, configs] of [
    ["with the Step 1b gate configured", GATED],
    ["with no pre-flight configured", undefined],
  ] as const
) {
  Deno.test({
    name:
      `pr feedback - an unformatted .ts fix is formatted, committed and pushed ${label}; Markdown is untouched`,
    permissions: { read: true, write: true, run: true, env: true },
    async fn() {
      const fx = await makeFixture();
      try {
        const result = await runFeedbackRound(fx, {
          "worker/deno/lib/a.ts": UNFORMATTED_TS,
          "docs/GUIDE.md": UNFORMATTED_MD,
        }, configs);
        assert(result.ok, result.ok ? "" : result.error.message);

        assertEquals(
          await remoteFile(fx, "worker/deno/lib/a.ts"),
          FORMATTED_TS,
        );
        assertEquals(
          await remoteFile(fx, "docs/GUIDE.md"),
          UNFORMATTED_MD,
          "Markdown in the round must be left byte-identical",
        );
        const subjects = await git(
          ["log", "--format=%s", `${fx.remoteTipBefore}..${BRANCH}`],
          fx.upstream,
        );
        assertEquals(subjects.split("\n")[0], FORMATTER_COMMIT_MESSAGE);
      } finally {
        await Deno.remove(fx.tmp, { recursive: true });
      }
    },
  });
}

Deno.test({
  name:
    "pr feedback - a non-formatting failure still blocks the push after the formatters run",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const fx = await makeFixture();
    try {
      const result = await runFeedbackRound(fx, {
        "worker/deno/lib/a.ts": LINT_FAILING_TS,
      }, GATED);
      assert(result.ok, result.ok ? "" : result.error.message);
      if (result.ok) assertEquals(result.value.changesPushed, false);
      assertEquals(
        (await git(["rev-parse", BRANCH], fx.upstream)).trim(),
        fx.remoteTipBefore,
        "a lint failure must never reach the remote",
      );
    } finally {
      await Deno.remove(fx.tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "pr feedback - a formatter that throws leaves the gate to block the unformatted fix",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const fx = await makeFixture();
    try {
      const result = await runFeedbackRound(
        fx,
        { "worker/deno/lib/a.ts": UNFORMATTED_TS },
        GATED,
        () => Promise.reject(new Error("spawn deno: No such file")),
      );
      assert(result.ok, result.ok ? "" : result.error.message);
      if (result.ok) assertEquals(result.value.changesPushed, false);
      assertEquals(
        (await git(["rev-parse", BRANCH], fx.upstream)).trim(),
        fx.remoteTipBefore,
        "the --check gate still blocks what the formatter did not fix",
      );
    } finally {
      await Deno.remove(fx.tmp, { recursive: true });
    }
  },
});

Deno.test({
  name:
    "ci fix - an unformatted .ts fix the agent committed is formatted and pushed",
  permissions: { read: true, write: true, run: true, env: true },
  async fn() {
    const fx = await makeFixture();
    try {
      const input: CiFixInput = {
        repo: REPO,
        prNumber: 2524,
        branchName: BRANCH,
        checkRunId: "67890",
        checkName: "Quality Checks",
        encodedAnnotations: btoa(JSON.stringify([])),
      };
      const processorDeps: CiProcessorDeps = {
        promptsDir: PROMPTS_DIR,
        logger: silentLogger,
        // The agent commits its fix but never pushes it.
        deps: makeDeps(async () => {
          await writeFiles(fx.repo, { "worker/deno/lib/a.ts": UNFORMATTED_TS });
          await git(["add", "."], fx.repo);
          await git(["commit", "-m", "Fix CI"], fx.repo);
        }),
        stateDir: `${fx.tmp}/.ci_check_state`,
        workDir: fx.repo,
        workRoot: fx.tmp,
        verifyPushFn: REMOTE_CONFIRMS_PUSH,
        repoConfigs: GATED,
      };
      const result = await processCiFailure(input, processorDeps);
      assert(result.ok, result.ok ? "" : result.error.message);
      assertEquals(
        await remoteFile(fx, "worker/deno/lib/a.ts"),
        FORMATTED_TS,
      );
    } finally {
      await Deno.remove(fx.tmp, { recursive: true });
    }
  },
});
