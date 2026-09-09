/**
 * Quality gate check: GitHub Actions workflow hygiene (Issue #3716).
 *
 * Two invariants, both statically decidable from the workflow text:
 *
 * 1. **Every multi-line `run:` block starts with `set -euo pipefail`.**
 *    GitHub runs `run:` steps as `bash -e`, so an unset variable or a
 *    failing command mid-pipeline is silently ignored — the step still
 *    reports green. The security-notification block in
 *    `dependency-audit.yml` had drifted this way: a failed
 *    `notify-audit-failure` would have vanished into a green step, exactly
 *    the never-fail-silently class.
 *
 * 2. **One pinned SHA carries one version comment.** Actions are pinned to
 *    40-character commit SHAs (Issue #2123) and the corresponding tag is
 *    recorded in a comment beside the pin — leading (`# owner/action@v1`
 *    above the `uses:`) or trailing (`uses: owner/action@<sha> # v1`, the
 *    form emitted workflow templates render). When the same SHA is annotated
 *    `v6.0.0` in one workflow and `v6.0.2` in another, the comment — the
 *    only human-readable signal that makes SHA pinning auditable — is
 *    worthless.
 *
 * The scanning functions are pure and exported so they can be tested
 * behaviourally against literal workflow text.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** Kind of workflow-hygiene violation. */
export type WorkflowHygieneKind =
  | "missing-strict-mode"
  | "version-comment-drift";

/** A single workflow-hygiene violation. */
export interface WorkflowHygieneViolation {
  kind: WorkflowHygieneKind;
  /** Repo-relative path of the offending workflow. */
  file: string;
  /** 1-based line number the violation anchors to. */
  line: number;
  /** Human-readable description of what is wrong. */
  detail: string;
}

/** Result of scanning a workflow directory. */
export interface WorkflowHygieneResult {
  violations: WorkflowHygieneViolation[];
  filesScanned: number;
}

/** The strict-mode preamble every multi-line `run:` block must open with. */
export const STRICT_MODE_LINE = "set -euo pipefail";

/** Matches a block-scalar `run:` key, capturing its indentation. */
const RUN_BLOCK_RE = /^(\s*)(- )?run:\s*[|>][-+]?\s*$/;

/** Matches a SHA-pinned `uses:` reference. */
const USES_SHA_RE =
  /uses:\s*([\w.\-]+\/[\w.\-]+(?:\/[\w.\-]+)*)@([0-9a-f]{40})\b/;

/** Matches an `# owner/action@version` pin comment. */
const PIN_COMMENT_RE = /#\s*([\w.\-]+\/[\w.\-]+(?:\/[\w.\-]+)*)@(v?[\w.\-]+)/;

/** Matches a same-line trailing comment on a SHA-pinned `uses:` line. */
const TRAILING_COMMENT_RE = /@[0-9a-f]{40}\s+(#\s*\S.*?)\s*$/;

/** Matches a step-level `shell:` key. */
const SHELL_KEY_RE = /^\s*(- )?shell:\s*(\S+)/;

/** Shells for which `set -euo pipefail` is meaningful. */
const POSIX_SHELLS = new Set(["bash", "sh", "bash{0}", "/bin/bash", "/bin/sh"]);

/** Indentation width of a line (tabs count as one column). */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Column at which the mapping keys of the step owning this `run:` sit.
 * For `- run: |` the key column is two past the dash.
 */
function keyColumn(match: RegExpMatchArray): number {
  return (match[1] ?? "").length + (match[2] ?? "").length;
}

/**
 * Resolve the `shell:` declared by the step owning the `run:` block at
 * `keyLine`, or `undefined` when the step does not declare one.
 *
 * Only keys at the same column and inside the same step (bounded by the
 * enclosing sequence dashes) are considered, so a sibling step's `shell:`
 * never leaks in.
 */
export function findStepShell(
  lines: string[],
  keyLine: number,
  column: number,
): string | undefined {
  const isStepBoundary = (line: string): boolean =>
    line.trimStart().startsWith("- ") && indentOf(line) < column;

  const matchShell = (line: string): string | undefined => {
    const m = line.match(SHELL_KEY_RE);
    return m?.[2]?.replace(/["']/g, "");
  };

  const scan = (from: number, step: -1 | 1): string | undefined => {
    for (let i = from; i >= 0 && i < lines.length; i += step) {
      const line = lines[i] ?? "";
      if (line.trim() === "") continue;
      const ind = indentOf(line);
      if (ind < column && !isStepBoundary(line)) break;
      if (isStepBoundary(line)) {
        // Upwards this is our own step's dash; downwards it is the next step.
        return step === -1 ? matchShell(line) : undefined;
      }
      if (ind !== column) continue;
      const shell = matchShell(line);
      if (shell) return shell;
    }
    return undefined;
  };

  return scan(keyLine - 1, -1) ?? scan(keyLine + 1, 1);
}

/**
 * Scan one workflow's text for `run:` blocks that do not open with
 * `set -euo pipefail`.
 *
 * A block is exempt when it carries a single effective command (nothing
 * can be silently skipped after it) or when the step declares a
 * non-POSIX shell such as `python`.
 *
 * @param content - Raw workflow YAML.
 * @param repoRelPath - Repo-relative path recorded on each violation.
 */
export function scanWorkflowForStrictMode(
  content: string,
  repoRelPath: string,
): WorkflowHygieneViolation[] {
  const lines = content.split("\n");
  const violations: WorkflowHygieneViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const match = (lines[i] ?? "").match(RUN_BLOCK_RE);
    if (!match) continue;

    const column = keyColumn(match);
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      if (line.trim() !== "" && indentOf(line) <= column) break;
      body.push(line.trim());
    }

    const effective = body.filter((l) => l !== "" && !l.startsWith("#"));
    if (effective.length < 2) continue;

    const shell = findStepShell(lines, i, column);
    if (shell !== undefined && !POSIX_SHELLS.has(shell)) continue;

    if (effective[0] !== STRICT_MODE_LINE) {
      violations.push({
        kind: "missing-strict-mode",
        file: repoRelPath,
        line: i + 1,
        detail:
          `multi-line \`run:\` block does not open with \`${STRICT_MODE_LINE}\``,
      });
    }
  }

  return violations;
}

/** One SHA-pinned action reference plus the version its comment claims. */
export interface ActionPinComment {
  action: string;
  sha: string;
  /** Version from the trailing or leading comment; absent when neither. */
  version?: string;
  file: string;
  /** 1-based line of the `uses:` reference. */
  line: number;
}

/**
 * Version claimed by a same-line trailing comment on a SHA-pinned `uses:`
 * line — `uses: owner/action@<sha> # v1.2.3`, the form `pinnedAction()`
 * renders into every emitted workflow template.
 *
 * A trailing comment written in the fuller `# owner/action@v1.2.3` form is
 * read the same way, and one naming a *different* action is not borrowed —
 * the same rule the leading-comment search applies.
 */
function trailingVersion(line: string, action: string): string | undefined {
  const comment = line.match(TRAILING_COMMENT_RE)?.[1];
  if (comment === undefined) return undefined;
  const qualified = comment.match(PIN_COMMENT_RE);
  if (qualified) return qualified[1] === action ? qualified[2] : undefined;
  return comment.replace(/^#\s*/, "");
}

/**
 * Version a leading `# owner/action@version` comment claims for `action`,
 * searched up to three lines above `index` so an intervening
 * `- name:`/blank line does not hide it.
 */
function leadingVersion(
  lines: string[],
  index: number,
  action: string,
): string | undefined {
  for (let j = index - 1; j >= 0 && j >= index - 3; j--) {
    const comment = (lines[j] ?? "").match(PIN_COMMENT_RE);
    if (comment && comment[1] === action) return comment[2];
  }
  return undefined;
}

/**
 * Collect every SHA-pinned `uses:` reference and the version its comments
 * record — a same-line trailing comment, a leading comment, or both.
 *
 * A pin annotated **both** ways emits one entry per *distinct* version, so
 * two forms disagreeing about one SHA reach {@link findVersionCommentDrift}
 * as a drift violation instead of one silently losing to the other. The
 * ordinary case — one comment, or two that agree — is a single entry.
 */
export function collectActionPins(
  content: string,
  repoRelPath: string,
): ActionPinComment[] {
  const lines = content.split("\n");
  const pins: ActionPinComment[] = [];

  for (let i = 0; i < lines.length; i++) {
    const uses = (lines[i] ?? "").match(USES_SHA_RE);
    if (!uses) continue;

    const [, action, sha] = uses;
    if (action === undefined || sha === undefined) continue;

    const claimed = [
      trailingVersion(lines[i] ?? "", action),
      leadingVersion(lines, i, action),
    ].filter((v): v is string => v !== undefined);
    const versions = [...new Set(claimed)];

    for (const version of versions.length === 0 ? [undefined] : versions) {
      pins.push({
        action,
        sha,
        ...(version === undefined ? {} : { version }),
        file: repoRelPath,
        line: i + 1,
      });
    }
  }

  return pins;
}

/**
 * Report every SHA annotated with more than one distinct version comment.
 * One violation is emitted per offending reference so the operator sees
 * each site that needs reconciling.
 */
export function findVersionCommentDrift(
  pins: ActionPinComment[],
): WorkflowHygieneViolation[] {
  const bySha = new Map<string, ActionPinComment[]>();
  for (const pin of pins) {
    const group = bySha.get(pin.sha) ?? [];
    group.push(pin);
    bySha.set(pin.sha, group);
  }

  const violations: WorkflowHygieneViolation[] = [];
  for (const [sha, group] of bySha) {
    const versions = new Set(
      group.map((p) => p.version).filter((v): v is string => v !== undefined),
    );
    if (versions.size < 2) continue;

    const claimed = [...versions].sort().join(", ");
    for (const pin of group) {
      violations.push({
        kind: "version-comment-drift",
        file: pin.file,
        line: pin.line,
        detail: `${pin.action}@${sha.slice(0, 8)} is annotated ${
          pin.version ?? "(no version comment)"
        } here but ${claimed} across the repo`,
      });
    }
  }

  return violations;
}

/** List workflow files (`.yml`/`.yaml`) in a directory, sorted by name. */
async function listWorkflowFiles(dir: string): Promise<string[]> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile && /\.ya?ml$/.test(e.name))
    .map((e) => `${dir}/${e.name}`)
    .sort();
}

/**
 * Scan `.github/workflows` under `repoRoot` for both hygiene invariants.
 *
 * @param repoRoot - Absolute repo root (trailing slash optional).
 */
export async function scanWorkflowsForHygiene(
  repoRoot: string,
): Promise<WorkflowHygieneResult> {
  const root = repoRoot.replace(/\/$/, "");
  const files = await listWorkflowFiles(`${root}/.github/workflows`);

  const violations: WorkflowHygieneViolation[] = [];
  const pins: ActionPinComment[] = [];

  for (const absFile of files) {
    const repoRel = absFile.slice(root.length + 1);
    const content = await Deno.readTextFile(absFile);
    violations.push(...scanWorkflowForStrictMode(content, repoRel));
    pins.push(...collectActionPins(content, repoRel));
  }

  violations.push(...findVersionCommentDrift(pins));

  return { violations, filesScanned: files.length };
}
