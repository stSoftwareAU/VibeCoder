/**
 * The append-only ledger rule: both sides inserted, nothing was deleted
 * (Issue #1768, part of #1730).
 *
 * `CHANGELOG.md`, `docs/RELEASE-NOTES.md` and the audit ledgers under
 * `docs/audits/` are written by appending. Two branches that each append to the
 * same list conflict on every merge, and the resolution is never a judgement:
 * both entries were written deliberately, neither removed anything, so the
 * merge keeps both. Round 5 measured that shape as the second-largest conflict
 * class on the milestone branches, and each one currently costs an AI call.
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
 * A conflicted file is literal (common) regions interleaved with hunks, and the
 * base's own text is those same literals interleaved with each hunk's base
 * region. So when the literals **concatenate to exactly the base file**, every
 * hunk's base region is empty: both sides only inserted, and nothing that was
 * in the base was removed or edited. That equality is the whole test — precise,
 * cheap, and conservative in the right direction, because anything else (a
 * deleted line, an edited line, a line both sides added identically outside a
 * hunk) makes the two texts differ and the file defers to the agent.
 *
 * ## What it refuses
 *
 * - **No merge base** — an add/add conflict, or a stage 1 git would not give
 *   up. "Could not read the base" is never treated as "the base was empty".
 * - **Manifests and lock files** — those have their own rules, and a lock file
 *   is regenerated rather than text-merged.
 * - **A `.json` result that does not parse** — the union of two ledger entries
 *   can be invalid JSON (two objects appended into one array without a comma),
 *   and an unparseable ledger is deferred, never written.
 *
 * The module is pure — no git, no network, no file I/O.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  type ConflictSegment,
  type ManifestRule,
  type ManifestRuleRegistry,
  manifestRuleRegistry,
  type RuleContext,
  type RuleOutcome,
} from "./dependency_conflict_rules.ts";

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

/** An `unresolved` outcome, so the reason reads the same way every time. */
function defer(reason: string): RuleOutcome {
  return { kind: "unresolved", reason };
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
  if (literals !== context.base) {
    return defer(
      `${context.path} does not read as two pure insertions: its unconflicted ` +
        `text differs from the merge base, so a base line was changed, moved ` +
        `or deleted`,
    );
  }

  let merged = "";
  for (const segment of segments) {
    merged += segment.kind === "literal"
      ? segment.text
      : segment.theirs + segment.ours;
  }

  if (baseName(context.path).endsWith(".json") && !parsesAsJson(merged)) {
    return defer(
      `keeping both sides of ${context.path} does not parse as JSON, so the ` +
        `union was not written`,
    );
  }

  return { kind: "resolved", text: merged };
}

/** Whether text is valid JSON — the guard for a `.json` ledger. */
function parsesAsJson(text: string): boolean {
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
