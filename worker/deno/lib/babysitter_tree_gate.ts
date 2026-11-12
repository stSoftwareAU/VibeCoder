/**
 * The pre-push gate run over a babysitter repair's uncommitted tree (Issue #4930).
 *
 * The repair agent leaves its edits uncommitted in a clone whose `.git` is
 * mounted read-only, so nothing here may write to `.git`. The gate runs the
 * checks the host's push would otherwise skip: deno test, markdownlint, the
 * ShellCheck policy and cargo-deny. The gate's git calls that would write
 * (`worktree add`, `worktree remove`, `worktree prune`) are emulated through the
 * `git` seam: the fork commit is extracted with `git archive` and `tar` into a
 * temp root, and the working-tree paths are listed as tracked, so new files are
 * checked too. The Deno process writes only under that temp root.
 *
 * The checks run inside the clone, so anything they leave there as an untracked
 * or modified path would be staged by the host's later `git add -A`. After the
 * gate returns, the working tree is read again and its paths are compared with
 * the set read before the checks: a change overrides a pass with a blocked
 * outcome, and a failed re-read is an infrastructure outcome.
 *
 * Uses Australian English spelling (behaviour, neutralise, etc.)
 */

import {
  defaultPrePushGit,
  PrePushGateInfrastructureError,
  type PrePushGit,
  runPrePushGate,
} from "./pre_push_gate.ts";
import { isBabysitterReady } from "./babysitter_ready.ts";
import { redactSecrets } from "./secret_redaction.ts";

/** Written in front of a response whose READY line was withheld. */
export const BABYSITTER_GATE_BLOCKED_MARKER = "[BABYSITTER_GATE_BLOCKED]";

/** The READY line the host looks for; never allowed in a withheld message. */
const READY_LINE = "BABYSITTER_READY";

/** The scratch files the agent may leave in the clone; they are not its edits. */
const SCRATCH_PATHS: ReadonlySet<string> = new Set([
  ".babysitter-response",
  ".babysitter-pr-body",
]);

/** Longest message written to a response or a log. */
const MESSAGE_CHARS = 1500;

/** The pseudo ref the gate is asked to check, as git's pre-push stdin names it. */
const TREE_REF = "refs/heads/babysitter-tree";

const SHA_PATTERN = /^[0-9a-f]{40,64}$/;

/** The status call read before and after the checks (Issue #4930). */
const STATUS_ARGS = [
  "--no-optional-locks",
  "status",
  "--porcelain=v1",
  "-z",
  "--untracked-files=all",
];

/** Most changed paths named in a message that reports a changed tree. */
const CHANGED_PATHS_NAMED = 10;

/** What the gate found for the uncommitted tree. */
export type BabysitterTreeGateOutcome =
  | { kind: "clean" }
  | { kind: "passed"; checksRun: string[] }
  | { kind: "blocked"; message: string }
  | { kind: "infrastructure"; message: string };

/** The seams the gate touches, injected so tests need no real checks. */
export interface BabysitterTreeGateDeps {
  git?: PrePushGit;
  gate?: typeof runPrePushGate;
  makeTempDir?: () => Promise<string>;
  removeTree?: (path: string) => Promise<void>;
  extractTree?: (
    dir: string,
    sha: string,
    dest: string,
  ) => Promise<{ code: number; stderr: string }>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Redacts, neutralises the READY text, and keeps the first characters. */
function boundedMessage(text: string): string {
  const safe = redactSecrets(text).replaceAll(READY_LINE, "ready marker");
  return Array.from(safe).slice(0, MESSAGE_CHARS).join("");
}

function infrastructure(message: string): BabysitterTreeGateOutcome {
  return { kind: "infrastructure", message: boundedMessage(message) };
}

async function defaultMakeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "babysitter-tree-gate-" });
}

async function defaultRemoveTree(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** `git archive` the commit into a tar beside `dest`, then unpack it into `dest`. */
async function defaultExtractTree(
  dir: string,
  sha: string,
  dest: string,
): Promise<{ code: number; stderr: string }> {
  const tarPath = `${dest}.tar`;
  const archive = await defaultPrePushGit(
    ["archive", "--format=tar", "-o", tarPath, sha],
    dir,
  );
  if (archive.code !== 0) {
    return { code: archive.code, stderr: archive.stderr };
  }
  const tar = await new Deno.Command("tar", {
    args: ["-xf", tarPath, "-C", dest],
    stdin: "null",
    stdout: "null",
    stderr: "piped",
  }).output();
  return { code: tar.code, stderr: new TextDecoder().decode(tar.stderr) };
}

/**
 * The paths `git status --porcelain=v1 -z` reports, without the scratch files.
 * `paths` holds every touched path; `added` holds the untracked or new ones.
 * A rename or copy record is `XY new\0orig`, so the next field is taken too.
 */
function parseStatus(
  output: string,
): { paths: string[]; added: string[] } {
  const paths = new Set<string>();
  const added = new Set<string>();
  const records = output.split("\0");
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (record === "") continue;
    if (record.length < 4) {
      throw new Error(`malformed git status record: ${JSON.stringify(record)}`);
    }
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    const fields = [{ path, isNew: xy === "??" || /[ARC]/.test(xy) }];
    if (/[RC]/.test(xy)) {
      const original = records[++i];
      if (original === undefined || original === "") {
        throw new Error(`git status rename without an original path: ${path}`);
      }
      fields.push({ path: original, isNew: false });
    }
    for (const field of fields) {
      if (SCRATCH_PATHS.has(field.path)) continue;
      paths.add(field.path);
      if (field.isNew) added.add(field.path);
    }
  }
  return { paths: [...paths], added: [...added] };
}

/** Whether `target` is a path strictly under `root` (no traversal). */
function isUnder(target: string, root: string): boolean {
  return target.startsWith(`${root}/`) && !target.split("/").includes("..");
}

/**
 * The {@link PrePushGit} the gate sees. Only the calls that would write to
 * `.git` (or read the common git directory they need) are intercepted; the
 * rest pass through to the real git.
 */
function gateGit(opts: {
  real: PrePushGit;
  root: string;
  paths: readonly string[];
  added: readonly string[];
  removeTree: (path: string) => Promise<void>;
  extractTree: NonNullable<BabysitterTreeGateDeps["extractTree"]>;
}): PrePushGit {
  const refused = (message: string) => ({
    code: 1,
    stdout: "",
    stderr: message,
  });
  return async (args, cwd) => {
    if (args[0] === "log" && args.includes("--name-only")) {
      return { code: 0, stdout: opts.paths.join("\0"), stderr: "" };
    }
    if (args[0] === "ls-files" && args.includes("-z")) {
      const listed = await opts.real(args, cwd);
      if (listed.code !== 0) return listed;
      const names = new Set(listed.stdout.split("\0").filter((p) => p !== ""));
      for (const path of opts.added) names.add(path);
      return { code: 0, stdout: [...names].join("\0") + "\0", stderr: "" };
    }
    if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
      return { code: 0, stdout: `${opts.root}\n`, stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "add") {
      const target = args[3] ?? "";
      const sha = args[4] ?? "";
      if (!isUnder(target, opts.root)) {
        return refused(`refusing worktree outside ${opts.root}: ${target}`);
      }
      try {
        await Deno.mkdir(target, { recursive: true });
      } catch (error) {
        return refused(`cannot create ${target}: ${errorMessage(error)}`);
      }
      const extracted = await opts.extractTree(cwd, sha, target);
      return { code: extracted.code, stdout: "", stderr: extracted.stderr };
    }
    if (args[0] === "worktree" && args[1] === "remove") {
      const target = args.at(-1) ?? "";
      if (!isUnder(target, opts.root)) {
        return refused(`refusing to remove outside ${opts.root}: ${target}`);
      }
      try {
        await opts.removeTree(target);
      } catch (error) {
        return refused(`cannot remove ${target}: ${errorMessage(error)}`);
      }
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "worktree" && args[1] === "prune") {
      return { code: 0, stdout: "", stderr: "" };
    }
    return await opts.real(args, cwd);
  };
}

/**
 * Sorted, comma-separated list of the first {@link CHANGED_PATHS_NAMED} paths
 * the checks added or removed, with a count of any beyond them.
 */
function listChangedPaths(changed: readonly string[]): string {
  const named = changed.slice(0, CHANGED_PATHS_NAMED).join(", ");
  const rest = changed.length - CHANGED_PATHS_NAMED;
  return rest > 0 ? `${named}, and ${rest} more` : named;
}

/**
 * Re-reads the working tree after the gate returned and compares its paths
 * with `before`, the set read before the checks (Issue #4930). A failed re-read
 * is infrastructure whatever the gate said. A changed set overrides a pass; a
 * gate that already blocked or hit infrastructure keeps its own outcome.
 */
async function settleAfterChecks(
  git: PrePushGit,
  dir: string,
  before: readonly string[],
  verdict: BabysitterTreeGateOutcome,
): Promise<BabysitterTreeGateOutcome> {
  const after = await git([...STATUS_ARGS], dir);
  if (after.code !== 0) {
    return infrastructure(
      `git status failed after the checks (exit ${after.code}): ${after.stderr.trim()}`,
    );
  }
  const afterPaths = new Set(parseStatus(after.stdout).paths);
  const beforePaths = new Set(before);
  const changed = [...new Set([...beforePaths, ...afterPaths])]
    .filter((path) => beforePaths.has(path) !== afterPaths.has(path))
    .sort();
  if (changed.length === 0 || verdict.kind !== "passed") return verdict;
  return {
    kind: "blocked",
    message: boundedMessage(
      `the checks changed the working tree: ${listChangedPaths(changed)}`,
    ),
  };
}

/**
 * Runs the pre-push gate over the uncommitted tree at `dir`. A clean tree is
 * `clean` and the gate is not called. Any failure to read the tree, to make
 * the temp root, or to run the gate is `infrastructure`; a failed check is
 * `blocked`; only a gate that passed is `passed`. After the gate returns, the
 * tree is read again and compared with the set read before the checks: a
 * change the checks left behind turns a pass into `blocked`, and a failed
 * re-read is `infrastructure` (Issue #4930). The temp root is always removed.
 */
export async function runBabysitterTreeGate(
  dir: string,
  baseBranch: string | undefined,
  deps: BabysitterTreeGateDeps = {},
): Promise<BabysitterTreeGateOutcome> {
  const git = deps.git ?? defaultPrePushGit;
  const gate = deps.gate ?? runPrePushGate;
  const makeTempDir = deps.makeTempDir ?? defaultMakeTempDir;
  const removeTree = deps.removeTree ?? defaultRemoveTree;
  const extractTree = deps.extractTree ?? defaultExtractTree;
  let root: string | undefined;

  const check = async (): Promise<BabysitterTreeGateOutcome> => {
    const status = await git([...STATUS_ARGS], dir);
    if (status.code !== 0) {
      return infrastructure(
        `git status failed (exit ${status.code}): ${status.stderr.trim()}`,
      );
    }
    const { paths, added } = parseStatus(status.stdout);
    if (paths.length === 0) return { kind: "clean" };

    const head = await git(["rev-parse", "HEAD"], dir);
    const sha = head.stdout.trim();
    if (head.code !== 0 || !SHA_PATTERN.test(sha)) {
      return infrastructure(
        `git rev-parse HEAD failed (exit ${head.code}): ${head.stderr.trim()}`,
      );
    }

    const tempRoot = await makeTempDir();
    root = tempRoot;
    const adapter = gateGit({
      real: git,
      root: tempRoot,
      paths,
      added,
      removeTree,
      extractTree,
    });
    const result = await gate({
      cwd: dir,
      stdin: `${TREE_REF} ${sha} ${TREE_REF} ${sha}\n`,
      preFlightCommands: [],
      shellcheckOnly: true,
      git: adapter,
      ...(baseBranch ? { baselineBranch: baseBranch } : {}),
    });
    let verdict: BabysitterTreeGateOutcome;
    if (result.ok) {
      verdict = { kind: "passed", checksRun: result.value.checksRun };
    } else if (result.error instanceof PrePushGateInfrastructureError) {
      verdict = infrastructure(result.error.message);
    } else {
      verdict = {
        kind: "blocked",
        message: boundedMessage(result.error.message),
      };
    }
    return await settleAfterChecks(git, dir, paths, verdict);
  };

  let outcome: BabysitterTreeGateOutcome;
  try {
    outcome = await check();
  } catch (error) {
    outcome = infrastructure(errorMessage(error));
  }
  if (root !== undefined) {
    try {
      await removeTree(root);
    } catch (error) {
      // A leftover temp root is not a verdict on the tree, but a pass that
      // cannot clean up after itself is reported as a failure, never silently.
      if (outcome.kind === "passed") {
        outcome = infrastructure(
          `could not remove the temp root ${root}: ${errorMessage(error)}`,
        );
      }
    }
  }
  return outcome;
}

/**
 * Removes a trailing READY line, repeatedly, until the text no longer satisfies
 * {@link isBabysitterReady}. Text without READY is returned unchanged.
 */
function withoutReadyLines(output: string): string {
  let text = output;
  while (text !== "" && isBabysitterReady(text)) {
    const trimmed = text.trimEnd();
    const cut = trimmed.lastIndexOf("\n");
    text = cut === -1 ? "" : trimmed.slice(0, cut);
  }
  return text;
}

/**
 * The response written when the gate blocked or could not run: a marker line
 * with the cause, then the agent's output with its READY line removed. The
 * result never satisfies {@link isBabysitterReady}, so the host refuses to push.
 */
export function withholdReady(
  output: string,
  outcome: Extract<
    BabysitterTreeGateOutcome,
    { kind: "blocked" | "infrastructure" }
  >,
): string {
  const headline = outcome.kind === "blocked"
    ? "pre-push checks failed"
    : "pre-push checks could not run";
  return `${BABYSITTER_GATE_BLOCKED_MARKER} ${headline}: ${
    boundedMessage(outcome.message)
  }\n\n${withoutReadyLines(output)}`;
}
