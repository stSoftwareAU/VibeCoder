/**
 * The append-only ledger rule: both sides inserted, nothing was deleted
 * (Issue #1768, part of #1730).
 *
 * `CHANGELOG.md`, `docs/RELEASE-NOTES.md` and the audit ledgers under
 * `docs/audits/` are written by appending. Two branches that each append to the
 * same list conflict on every merge, and the resolution is never a judgement:
 * both entries were written deliberately, neither removed anything, so the
 * merge keeps both. Round 5 of #1730 measured that shape as the second-largest
 * conflict class on the milestone branches, and each one currently costs an AI
 * call.
 *
 * This rule settles it deterministically, registered beside the manifest rules
 * so the pass in `dependency_conflict_apply.ts` offers it every conflicted
 * path.
 *
 * ## How "nothing was deleted" is established
 *
 * The PR merge does **not** run with `diff3` conflict style, so a hunk carries
 * no `||||||| base` section to read an empty base off. The merge base is read
 * out of the conflicted index instead (`git show :1:<path>`) and handed to the
 * rule as {@link RuleContext.base}.
 *
 * A conflicted file is literal (common) regions interleaved with hunks. A base
 * line that survived on both sides is common, so it sits in a literal; a base
 * line one side deleted or edited does not, because the two sides then differ
 * over it and git puts it inside a hunk. So the test is: **every line of the
 * merge base still appears, in order, outside the conflict hunks.** When it
 * does, nothing the base had was removed or edited and each hunk holds only
 * what the two sides added.
 *
 * It is a subsequence rather than an equality, because the literals legitimately
 * carry more than the base: a blank line both sides added around their entry,
 * and any *other* insertion in the same file that merged cleanly, are both
 * common text and both appear there. Requiring equality would defer the very
 * merges this rule exists for.
 *
 * ## What it refuses
 *
 * - **No merge base** — an add/add conflict, or a stage 1 git would not give
 *   up. "Could not read the base" is never treated as "the base was empty".
 * - **Manifests and lock files** — those have their own rules, and a lock file
 *   is regenerated rather than text-merged.
 * - **A `.json` union the structured merge will not make** — a deletion, a
 *   conflicting edit, or a file whose formatting it would not reproduce. An
 *   invalid or reformatted ledger is deferred, never written.
 *
 * ## `.json` is unioned by value, not by text (Issue #1968)
 *
 * Two branches that each append an object to the same JSON array conflict
 * *inside* the object, so no arrangement of the two hunks' text is valid JSON —
 * the one shape `docs/audits/lib-sweep-coverage.json` produces in practice was
 * exactly the one the textual union could not resolve, and a hand resolution
 * dropped a sweep slice and turned `main` red (#1966).
 *
 * A `.json` path is therefore merged structurally by
 * `json_insertion_union.ts`: both sides are reconstructed whole from the
 * segments, parsed, unioned over the merge base, and re-serialised in the
 * file's own formatting. That merge does its own insertion-only checking — the
 * base's array items and object keys must survive on both sides — so it
 * replaces the line-based checks below rather than running after them, which
 * matters because appending to a JSON array also edits the previous entry's
 * closing line to add a comma. Anything it refuses defers, as before.
 *
 * The module is pure — no git, no network, no file I/O.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  applyHunkChoices,
  type ConflictSegment,
  type ConflictSide,
  type ManifestRule,
  type ManifestRuleRegistry,
  manifestRuleRegistry,
  type RuleContext,
  type RuleOutcome,
} from "./dependency_conflict_rules.ts";
import { unionJsonInsertions } from "./json_insertion_union.ts";

/** The rule's registered name, quoted in the pass's log and PR comment. */
export const BOTH_INSERTED_RULE_NAME = "both-inserted";

/**
 * Files another rule owns, or that are never text-merged.
 *
 * Registration order already puts this rule last, so a manifest reaches its own
 * rule first; the list is restated here so `matches` is honest on its own and a
 * future registration order cannot quietly hand `deno.lock` to a union.
 */
const OWNED_ELSEWHERE = new Set([
  "deno.json",
  "deno.jsonc",
  "package.json",
  "cargo.toml",
  "go.mod",
  "deno.lock",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "cargo.lock",
  "go.sum",
]);

/** The last path component, lower-cased. */
function baseName(path: string): string {
  return (path.split("/").pop() ?? path).toLowerCase();
}

/** Whether this rule is willing to look at a repository-relative path. */
export function isBothInsertedCandidate(path: string): boolean {
  return !OWNED_ELSEWHERE.has(baseName(path));
}

/**
 * Whether a path is a JSON document, which is unioned by value (Issue #1968).
 *
 * Exported because the milestone ladder's union rung asks the same question of
 * the same paths (Issue #2013), and two spellings of "is this JSON" could drift
 * into two different answers.
 */
export function isJsonPath(path: string): boolean {
  return baseName(path).endsWith(".json");
}

/**
 * One side of a conflicted file, rendered whole.
 *
 * Every hunk resolves to the one side, so the result is that side's version of
 * the file plus whatever the *other* side inserted cleanly — git merged those
 * regions without asking, so they are common text. The structured union treats
 * a shared insertion as one entry, so the extra common text costs nothing.
 */
function renderSide(
  segments: readonly ConflictSegment[],
  side: ConflictSide,
): string {
  const hunkCount = segments.filter((s) => s.kind === "conflict").length;
  return applyHunkChoices(segments, Array(hunkCount).fill(side));
}

/** An `unresolved` outcome, so the reason reads the same way every time. */
function defer(reason: string): RuleOutcome {
  return { kind: "unresolved", reason };
}

/** Lines of a file, terminators dropped, with no trailing empty element. */
function lines(text: string): string[] {
  const split = text.split("\n");
  if (split.length > 0 && split[split.length - 1] === "") split.pop();
  return split;
}

/**
 * Whether every line of `subset` appears in `superset`, in order.
 *
 * Order matters: it is what separates "the base survived and more was added
 * around it" from "a base line was replaced by a different one".
 */
export function isLineSubsequence(subset: string, superset: string): boolean {
  const want = lines(subset);
  const have = lines(superset);
  let i = 0;
  for (const line of have) {
    if (i < want.length && line === want[i]) i++;
  }
  return i === want.length;
}

/**
 * Resolve a conflict in which both sides only inserted.
 *
 * The base branch's hunk is emitted first and this branch's second: the pass
 * runs during `git merge origin/<base>` on the PR branch, so stage 3
 * ("theirs") is the base branch's side. Ordering the newest local entry after
 * the base branch's keeps a ledger reading the way both authors wrote it.
 */
export function resolveBothInserted(
  segments: readonly ConflictSegment[],
  context: RuleContext,
): RuleOutcome {
  if (context.base === null) {
    return defer(
      `${context.path} has no merge-base version to compare against, so ` +
        `"both sides only inserted" cannot be established`,
    );
  }

  const hunks = segments.filter((s) => s.kind === "conflict");
  if (hunks.length === 0) {
    return defer(`${context.path} has no conflict hunk to resolve`);
  }

  if (isJsonPath(context.path)) {
    const union = unionJsonInsertions(
      context.base,
      renderSide(segments, "ours"),
      renderSide(segments, "theirs"),
    );
    return union.ok
      ? { kind: "resolved", text: union.value }
      : defer(`${context.path} was not unioned as JSON: ${union.error}`);
  }

  // A file merged with `diff3` markers states its base regions outright; a
  // non-empty one is a deletion or an edit, whatever the whole-file check says.
  for (const hunk of hunks) {
    if (hunk.base !== null && hunk.base !== "") {
      return defer(
        `${context.path} has a conflict hunk whose merge base is not empty, ` +
          `so at least one side changed or deleted a base line`,
      );
    }
  }

  const literals = segments
    .filter((s) => s.kind === "literal")
    .map((s) => s.text)
    .join("");
  if (!isLineSubsequence(context.base, literals)) {
    return defer(
      `${context.path} does not read as two pure insertions: a line the merge ` +
        `base had does not survive outside the conflict hunks, so it was ` +
        `changed, moved or deleted`,
    );
  }

  let merged = "";
  for (const segment of segments) {
    merged += segment.kind === "literal"
      ? segment.text
      : segment.theirs + segment.ours;
  }

  return { kind: "resolved", text: merged };
}

/**
 * Whether keeping both sides of `path` leaves a well-formed document.
 *
 * JSON is the one format cheap enough to check and common enough to matter: a
 * union of two ledger entries readily leaves an array with a missing or
 * doubled comma, and an invalid ledger must never be written. A path in any
 * other format has no such check and is not blocked by one.
 *
 * This rule no longer needs it — a `.json` path takes the structured union
 * above, which cannot produce an invalid document — but the milestone ladder's
 * union merge (`milestone_conflict_git.ts`) still text-unions with
 * `git merge-file --union`, and that is the rung this guard now protects.
 */
export function unionIsWellFormed(path: string, text: string): boolean {
  if (!isJsonPath(path)) return true;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The rule as the registry holds it. */
export const bothInsertedRule: ManifestRule = {
  name: BOTH_INSERTED_RULE_NAME,
  needsBase: true,
  matches: isBothInsertedCandidate,
  resolve: resolveBothInserted,
};

/**
 * Register the rule.
 *
 * Registered **last**, because it matches almost every path: the manifest rules
 * must see their own files first.
 */
export function registerBothInsertedRule(
  registry: ManifestRuleRegistry = manifestRuleRegistry,
): void {
  registry.register(bothInsertedRule);
}

registerBothInsertedRule();
