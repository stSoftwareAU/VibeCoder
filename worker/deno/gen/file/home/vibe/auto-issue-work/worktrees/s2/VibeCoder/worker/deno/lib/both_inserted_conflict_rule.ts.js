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
 */ import { applyHunkChoices, manifestRuleRegistry } from "./dependency_conflict_rules.ts";
import { unionJsonInsertions } from "./json_insertion_union.ts";
/** The rule's registered name, quoted in the pass's log and PR comment. */ export const BOTH_INSERTED_RULE_NAME = "both-inserted";
/**
 * Files another rule owns, or that are never text-merged.
 *
 * Registration order already puts this rule last, so a manifest reaches its own
 * rule first; the list is restated here so `matches` is honest on its own and a
 * future registration order cannot quietly hand `deno.lock` to a union.
 */ const OWNED_ELSEWHERE = new Set([
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
  "go.sum"
]);
/** The last path component, lower-cased. */ function baseName(path) {
  return (path.split("/").pop() ?? path).toLowerCase();
}
/** Whether this rule is willing to look at a repository-relative path. */ export function isBothInsertedCandidate(path) {
  return !OWNED_ELSEWHERE.has(baseName(path));
}
/**
 * Whether a path is a JSON document, which is unioned by value (Issue #1968).
 *
 * Exported because the milestone ladder's union rung asks the same question of
 * the same paths (Issue #2013), and two spellings of "is this JSON" could drift
 * into two different answers.
 */ export function isJsonPath(path) {
  return baseName(path).endsWith(".json");
}
/**
 * One side of a conflicted file, rendered whole.
 *
 * Every hunk resolves to the one side, so the result is that side's version of
 * the file plus whatever the *other* side inserted cleanly — git merged those
 * regions without asking, so they are common text. The structured union treats
 * a shared insertion as one entry, so the extra common text costs nothing.
 */ function renderSide(segments, side) {
  const hunkCount = segments.filter((s)=>s.kind === "conflict").length;
  return applyHunkChoices(segments, Array(hunkCount).fill(side));
}
/** An `unresolved` outcome, so the reason reads the same way every time. */ function defer(reason) {
  return {
    kind: "unresolved",
    reason
  };
}
/** Lines of a file, terminators dropped, with no trailing empty element. */ function lines(text) {
  const split = text.split("\n");
  if (split.length > 0 && split[split.length - 1] === "") split.pop();
  return split;
}
/**
 * Whether every line of `subset` appears in `superset`, in order.
 *
 * Order matters: it is what separates "the base survived and more was added
 * around it" from "a base line was replaced by a different one".
 */ export function isLineSubsequence(subset, superset) {
  const want = lines(subset);
  const have = lines(superset);
  let i = 0;
  for (const line of have){
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
 */ export function resolveBothInserted(segments, context) {
  if (context.base === null) {
    return defer(`${context.path} has no merge-base version to compare against, so ` + `"both sides only inserted" cannot be established`);
  }
  const hunks = segments.filter((s)=>s.kind === "conflict");
  if (hunks.length === 0) {
    return defer(`${context.path} has no conflict hunk to resolve`);
  }
  if (isJsonPath(context.path)) {
    const union = unionJsonInsertions(context.base, renderSide(segments, "ours"), renderSide(segments, "theirs"));
    return union.ok ? {
      kind: "resolved",
      text: union.value
    } : defer(`${context.path} was not unioned as JSON: ${union.error}`);
  }
  // A file merged with `diff3` markers states its base regions outright; a
  // non-empty one is a deletion or an edit, whatever the whole-file check says.
  for (const hunk of hunks){
    if (hunk.base !== null && hunk.base !== "") {
      return defer(`${context.path} has a conflict hunk whose merge base is not empty, ` + `so at least one side changed or deleted a base line`);
    }
  }
  const literals = segments.filter((s)=>s.kind === "literal").map((s)=>s.text).join("");
  if (!isLineSubsequence(context.base, literals)) {
    return defer(`${context.path} does not read as two pure insertions: a line the merge ` + `base had does not survive outside the conflict hunks, so it was ` + `changed, moved or deleted`);
  }
  let merged = "";
  for (const segment of segments){
    merged += segment.kind === "literal" ? segment.text : segment.theirs + segment.ours;
  }
  return {
    kind: "resolved",
    text: merged
  };
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
 * above, which cannot produce an invalid document — and since Issue #2013 the
 * milestone ladder's union merge (`milestone_conflict_git.ts`) tries that same
 * structured union first. It still falls back to `git merge-file --union` for
 * anything the structured union refuses, so that fallback is the rung this
 * guard now protects.
 */ export function unionIsWellFormed(path, text) {
  if (!isJsonPath(path)) return true;
  try {
    JSON.parse(text);
    return true;
  } catch  {
    return false;
  }
}
/** The rule as the registry holds it. */ export const bothInsertedRule = {
  name: BOTH_INSERTED_RULE_NAME,
  needsBase: true,
  matches: isBothInsertedCandidate,
  resolve: resolveBothInserted
};
/**
 * Register the rule.
 *
 * Registered **last**, because it matches almost every path: the manifest rules
 * must see their own files first.
 */ export function registerBothInsertedRule(registry = manifestRuleRegistry) {
  registry.register(bothInsertedRule);
}
registerBothInsertedRule();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ib3RoX2luc2VydGVkX2NvbmZsaWN0X3J1bGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBUaGUgYXBwZW5kLW9ubHkgbGVkZ2VyIHJ1bGU6IGJvdGggc2lkZXMgaW5zZXJ0ZWQsIG5vdGhpbmcgd2FzIGRlbGV0ZWRcbiAqIChJc3N1ZSAjMTc2OCwgcGFydCBvZiAjMTczMCkuXG4gKlxuICogYENIQU5HRUxPRy5tZGAsIGBkb2NzL1JFTEVBU0UtTk9URVMubWRgIGFuZCB0aGUgYXVkaXQgbGVkZ2VycyB1bmRlclxuICogYGRvY3MvYXVkaXRzL2AgYXJlIHdyaXR0ZW4gYnkgYXBwZW5kaW5nLiBUd28gYnJhbmNoZXMgdGhhdCBlYWNoIGFwcGVuZCB0byB0aGVcbiAqIHNhbWUgbGlzdCBjb25mbGljdCBvbiBldmVyeSBtZXJnZSwgYW5kIHRoZSByZXNvbHV0aW9uIGlzIG5ldmVyIGEganVkZ2VtZW50OlxuICogYm90aCBlbnRyaWVzIHdlcmUgd3JpdHRlbiBkZWxpYmVyYXRlbHksIG5laXRoZXIgcmVtb3ZlZCBhbnl0aGluZywgc28gdGhlXG4gKiBtZXJnZSBrZWVwcyBib3RoLiBSb3VuZCA1IG9mICMxNzMwIG1lYXN1cmVkIHRoYXQgc2hhcGUgYXMgdGhlIHNlY29uZC1sYXJnZXN0XG4gKiBjb25mbGljdCBjbGFzcyBvbiB0aGUgbWlsZXN0b25lIGJyYW5jaGVzLCBhbmQgZWFjaCBvbmUgY3VycmVudGx5IGNvc3RzIGFuIEFJXG4gKiBjYWxsLlxuICpcbiAqIFRoaXMgcnVsZSBzZXR0bGVzIGl0IGRldGVybWluaXN0aWNhbGx5LCByZWdpc3RlcmVkIGJlc2lkZSB0aGUgbWFuaWZlc3QgcnVsZXNcbiAqIHNvIHRoZSBwYXNzIGluIGBkZXBlbmRlbmN5X2NvbmZsaWN0X2FwcGx5LnRzYCBvZmZlcnMgaXQgZXZlcnkgY29uZmxpY3RlZFxuICogcGF0aC5cbiAqXG4gKiAjIyBIb3cgXCJub3RoaW5nIHdhcyBkZWxldGVkXCIgaXMgZXN0YWJsaXNoZWRcbiAqXG4gKiBUaGUgUFIgbWVyZ2UgZG9lcyAqKm5vdCoqIHJ1biB3aXRoIGBkaWZmM2AgY29uZmxpY3Qgc3R5bGUsIHNvIGEgaHVuayBjYXJyaWVzXG4gKiBubyBgfHx8fHx8fCBiYXNlYCBzZWN0aW9uIHRvIHJlYWQgYW4gZW1wdHkgYmFzZSBvZmYuIFRoZSBtZXJnZSBiYXNlIGlzIHJlYWRcbiAqIG91dCBvZiB0aGUgY29uZmxpY3RlZCBpbmRleCBpbnN0ZWFkIChgZ2l0IHNob3cgOjE6PHBhdGg+YCkgYW5kIGhhbmRlZCB0byB0aGVcbiAqIHJ1bGUgYXMge0BsaW5rIFJ1bGVDb250ZXh0LmJhc2V9LlxuICpcbiAqIEEgY29uZmxpY3RlZCBmaWxlIGlzIGxpdGVyYWwgKGNvbW1vbikgcmVnaW9ucyBpbnRlcmxlYXZlZCB3aXRoIGh1bmtzLiBBIGJhc2VcbiAqIGxpbmUgdGhhdCBzdXJ2aXZlZCBvbiBib3RoIHNpZGVzIGlzIGNvbW1vbiwgc28gaXQgc2l0cyBpbiBhIGxpdGVyYWw7IGEgYmFzZVxuICogbGluZSBvbmUgc2lkZSBkZWxldGVkIG9yIGVkaXRlZCBkb2VzIG5vdCwgYmVjYXVzZSB0aGUgdHdvIHNpZGVzIHRoZW4gZGlmZmVyXG4gKiBvdmVyIGl0IGFuZCBnaXQgcHV0cyBpdCBpbnNpZGUgYSBodW5rLiBTbyB0aGUgdGVzdCBpczogKipldmVyeSBsaW5lIG9mIHRoZVxuICogbWVyZ2UgYmFzZSBzdGlsbCBhcHBlYXJzLCBpbiBvcmRlciwgb3V0c2lkZSB0aGUgY29uZmxpY3QgaHVua3MuKiogV2hlbiBpdFxuICogZG9lcywgbm90aGluZyB0aGUgYmFzZSBoYWQgd2FzIHJlbW92ZWQgb3IgZWRpdGVkIGFuZCBlYWNoIGh1bmsgaG9sZHMgb25seVxuICogd2hhdCB0aGUgdHdvIHNpZGVzIGFkZGVkLlxuICpcbiAqIEl0IGlzIGEgc3Vic2VxdWVuY2UgcmF0aGVyIHRoYW4gYW4gZXF1YWxpdHksIGJlY2F1c2UgdGhlIGxpdGVyYWxzIGxlZ2l0aW1hdGVseVxuICogY2FycnkgbW9yZSB0aGFuIHRoZSBiYXNlOiBhIGJsYW5rIGxpbmUgYm90aCBzaWRlcyBhZGRlZCBhcm91bmQgdGhlaXIgZW50cnksXG4gKiBhbmQgYW55ICpvdGhlciogaW5zZXJ0aW9uIGluIHRoZSBzYW1lIGZpbGUgdGhhdCBtZXJnZWQgY2xlYW5seSwgYXJlIGJvdGhcbiAqIGNvbW1vbiB0ZXh0IGFuZCBib3RoIGFwcGVhciB0aGVyZS4gUmVxdWlyaW5nIGVxdWFsaXR5IHdvdWxkIGRlZmVyIHRoZSB2ZXJ5XG4gKiBtZXJnZXMgdGhpcyBydWxlIGV4aXN0cyBmb3IuXG4gKlxuICogIyMgV2hhdCBpdCByZWZ1c2VzXG4gKlxuICogLSAqKk5vIG1lcmdlIGJhc2UqKiDigJQgYW4gYWRkL2FkZCBjb25mbGljdCwgb3IgYSBzdGFnZSAxIGdpdCB3b3VsZCBub3QgZ2l2ZVxuICogICB1cC4gXCJDb3VsZCBub3QgcmVhZCB0aGUgYmFzZVwiIGlzIG5ldmVyIHRyZWF0ZWQgYXMgXCJ0aGUgYmFzZSB3YXMgZW1wdHlcIi5cbiAqIC0gKipNYW5pZmVzdHMgYW5kIGxvY2sgZmlsZXMqKiDigJQgdGhvc2UgaGF2ZSB0aGVpciBvd24gcnVsZXMsIGFuZCBhIGxvY2sgZmlsZVxuICogICBpcyByZWdlbmVyYXRlZCByYXRoZXIgdGhhbiB0ZXh0LW1lcmdlZC5cbiAqIC0gKipBIGAuanNvbmAgdW5pb24gdGhlIHN0cnVjdHVyZWQgbWVyZ2Ugd2lsbCBub3QgbWFrZSoqIOKAlCBhIGRlbGV0aW9uLCBhXG4gKiAgIGNvbmZsaWN0aW5nIGVkaXQsIG9yIGEgZmlsZSB3aG9zZSBmb3JtYXR0aW5nIGl0IHdvdWxkIG5vdCByZXByb2R1Y2UuIEFuXG4gKiAgIGludmFsaWQgb3IgcmVmb3JtYXR0ZWQgbGVkZ2VyIGlzIGRlZmVycmVkLCBuZXZlciB3cml0dGVuLlxuICpcbiAqICMjIGAuanNvbmAgaXMgdW5pb25lZCBieSB2YWx1ZSwgbm90IGJ5IHRleHQgKElzc3VlICMxOTY4KVxuICpcbiAqIFR3byBicmFuY2hlcyB0aGF0IGVhY2ggYXBwZW5kIGFuIG9iamVjdCB0byB0aGUgc2FtZSBKU09OIGFycmF5IGNvbmZsaWN0XG4gKiAqaW5zaWRlKiB0aGUgb2JqZWN0LCBzbyBubyBhcnJhbmdlbWVudCBvZiB0aGUgdHdvIGh1bmtzJyB0ZXh0IGlzIHZhbGlkIEpTT04g4oCUXG4gKiB0aGUgb25lIHNoYXBlIGBkb2NzL2F1ZGl0cy9saWItc3dlZXAtY292ZXJhZ2UuanNvbmAgcHJvZHVjZXMgaW4gcHJhY3RpY2Ugd2FzXG4gKiBleGFjdGx5IHRoZSBvbmUgdGhlIHRleHR1YWwgdW5pb24gY291bGQgbm90IHJlc29sdmUsIGFuZCBhIGhhbmQgcmVzb2x1dGlvblxuICogZHJvcHBlZCBhIHN3ZWVwIHNsaWNlIGFuZCB0dXJuZWQgYG1haW5gIHJlZCAoIzE5NjYpLlxuICpcbiAqIEEgYC5qc29uYCBwYXRoIGlzIHRoZXJlZm9yZSBtZXJnZWQgc3RydWN0dXJhbGx5IGJ5XG4gKiBganNvbl9pbnNlcnRpb25fdW5pb24udHNgOiBib3RoIHNpZGVzIGFyZSByZWNvbnN0cnVjdGVkIHdob2xlIGZyb20gdGhlXG4gKiBzZWdtZW50cywgcGFyc2VkLCB1bmlvbmVkIG92ZXIgdGhlIG1lcmdlIGJhc2UsIGFuZCByZS1zZXJpYWxpc2VkIGluIHRoZVxuICogZmlsZSdzIG93biBmb3JtYXR0aW5nLiBUaGF0IG1lcmdlIGRvZXMgaXRzIG93biBpbnNlcnRpb24tb25seSBjaGVja2luZyDigJQgdGhlXG4gKiBiYXNlJ3MgYXJyYXkgaXRlbXMgYW5kIG9iamVjdCBrZXlzIG11c3Qgc3Vydml2ZSBvbiBib3RoIHNpZGVzIOKAlCBzbyBpdFxuICogcmVwbGFjZXMgdGhlIGxpbmUtYmFzZWQgY2hlY2tzIGJlbG93IHJhdGhlciB0aGFuIHJ1bm5pbmcgYWZ0ZXIgdGhlbSwgd2hpY2hcbiAqIG1hdHRlcnMgYmVjYXVzZSBhcHBlbmRpbmcgdG8gYSBKU09OIGFycmF5IGFsc28gZWRpdHMgdGhlIHByZXZpb3VzIGVudHJ5J3NcbiAqIGNsb3NpbmcgbGluZSB0byBhZGQgYSBjb21tYS4gQW55dGhpbmcgaXQgcmVmdXNlcyBkZWZlcnMsIGFzIGJlZm9yZS5cbiAqXG4gKiBUaGUgbW9kdWxlIGlzIHB1cmUg4oCUIG5vIGdpdCwgbm8gbmV0d29yaywgbm8gZmlsZSBJL08uXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHtcbiAgYXBwbHlIdW5rQ2hvaWNlcyxcbiAgdHlwZSBDb25mbGljdFNlZ21lbnQsXG4gIHR5cGUgQ29uZmxpY3RTaWRlLFxuICB0eXBlIE1hbmlmZXN0UnVsZSxcbiAgdHlwZSBNYW5pZmVzdFJ1bGVSZWdpc3RyeSxcbiAgbWFuaWZlc3RSdWxlUmVnaXN0cnksXG4gIHR5cGUgUnVsZUNvbnRleHQsXG4gIHR5cGUgUnVsZU91dGNvbWUsXG59IGZyb20gXCIuL2RlcGVuZGVuY3lfY29uZmxpY3RfcnVsZXMudHNcIjtcbmltcG9ydCB7IHVuaW9uSnNvbkluc2VydGlvbnMgfSBmcm9tIFwiLi9qc29uX2luc2VydGlvbl91bmlvbi50c1wiO1xuXG4vKiogVGhlIHJ1bGUncyByZWdpc3RlcmVkIG5hbWUsIHF1b3RlZCBpbiB0aGUgcGFzcydzIGxvZyBhbmQgUFIgY29tbWVudC4gKi9cbmV4cG9ydCBjb25zdCBCT1RIX0lOU0VSVEVEX1JVTEVfTkFNRSA9IFwiYm90aC1pbnNlcnRlZFwiO1xuXG4vKipcbiAqIEZpbGVzIGFub3RoZXIgcnVsZSBvd25zLCBvciB0aGF0IGFyZSBuZXZlciB0ZXh0LW1lcmdlZC5cbiAqXG4gKiBSZWdpc3RyYXRpb24gb3JkZXIgYWxyZWFkeSBwdXRzIHRoaXMgcnVsZSBsYXN0LCBzbyBhIG1hbmlmZXN0IHJlYWNoZXMgaXRzIG93blxuICogcnVsZSBmaXJzdDsgdGhlIGxpc3QgaXMgcmVzdGF0ZWQgaGVyZSBzbyBgbWF0Y2hlc2AgaXMgaG9uZXN0IG9uIGl0cyBvd24gYW5kIGFcbiAqIGZ1dHVyZSByZWdpc3RyYXRpb24gb3JkZXIgY2Fubm90IHF1aWV0bHkgaGFuZCBgZGVuby5sb2NrYCB0byBhIHVuaW9uLlxuICovXG5jb25zdCBPV05FRF9FTFNFV0hFUkUgPSBuZXcgU2V0KFtcbiAgXCJkZW5vLmpzb25cIixcbiAgXCJkZW5vLmpzb25jXCIsXG4gIFwicGFja2FnZS5qc29uXCIsXG4gIFwiY2FyZ28udG9tbFwiLFxuICBcImdvLm1vZFwiLFxuICBcImRlbm8ubG9ja1wiLFxuICBcInBhY2thZ2UtbG9jay5qc29uXCIsXG4gIFwicG5wbS1sb2NrLnlhbWxcIixcbiAgXCJ5YXJuLmxvY2tcIixcbiAgXCJjYXJnby5sb2NrXCIsXG4gIFwiZ28uc3VtXCIsXG5dKTtcblxuLyoqIFRoZSBsYXN0IHBhdGggY29tcG9uZW50LCBsb3dlci1jYXNlZC4gKi9cbmZ1bmN0aW9uIGJhc2VOYW1lKHBhdGg6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiAocGF0aC5zcGxpdChcIi9cIikucG9wKCkgPz8gcGF0aCkudG9Mb3dlckNhc2UoKTtcbn1cblxuLyoqIFdoZXRoZXIgdGhpcyBydWxlIGlzIHdpbGxpbmcgdG8gbG9vayBhdCBhIHJlcG9zaXRvcnktcmVsYXRpdmUgcGF0aC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0JvdGhJbnNlcnRlZENhbmRpZGF0ZShwYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuICFPV05FRF9FTFNFV0hFUkUuaGFzKGJhc2VOYW1lKHBhdGgpKTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIGEgcGF0aCBpcyBhIEpTT04gZG9jdW1lbnQsIHdoaWNoIGlzIHVuaW9uZWQgYnkgdmFsdWUgKElzc3VlICMxOTY4KS5cbiAqXG4gKiBFeHBvcnRlZCBiZWNhdXNlIHRoZSBtaWxlc3RvbmUgbGFkZGVyJ3MgdW5pb24gcnVuZyBhc2tzIHRoZSBzYW1lIHF1ZXN0aW9uIG9mXG4gKiB0aGUgc2FtZSBwYXRocyAoSXNzdWUgIzIwMTMpLCBhbmQgdHdvIHNwZWxsaW5ncyBvZiBcImlzIHRoaXMgSlNPTlwiIGNvdWxkIGRyaWZ0XG4gKiBpbnRvIHR3byBkaWZmZXJlbnQgYW5zd2Vycy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzSnNvblBhdGgocGF0aDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBiYXNlTmFtZShwYXRoKS5lbmRzV2l0aChcIi5qc29uXCIpO1xufVxuXG4vKipcbiAqIE9uZSBzaWRlIG9mIGEgY29uZmxpY3RlZCBmaWxlLCByZW5kZXJlZCB3aG9sZS5cbiAqXG4gKiBFdmVyeSBodW5rIHJlc29sdmVzIHRvIHRoZSBvbmUgc2lkZSwgc28gdGhlIHJlc3VsdCBpcyB0aGF0IHNpZGUncyB2ZXJzaW9uIG9mXG4gKiB0aGUgZmlsZSBwbHVzIHdoYXRldmVyIHRoZSAqb3RoZXIqIHNpZGUgaW5zZXJ0ZWQgY2xlYW5seSDigJQgZ2l0IG1lcmdlZCB0aG9zZVxuICogcmVnaW9ucyB3aXRob3V0IGFza2luZywgc28gdGhleSBhcmUgY29tbW9uIHRleHQuIFRoZSBzdHJ1Y3R1cmVkIHVuaW9uIHRyZWF0c1xuICogYSBzaGFyZWQgaW5zZXJ0aW9uIGFzIG9uZSBlbnRyeSwgc28gdGhlIGV4dHJhIGNvbW1vbiB0ZXh0IGNvc3RzIG5vdGhpbmcuXG4gKi9cbmZ1bmN0aW9uIHJlbmRlclNpZGUoXG4gIHNlZ21lbnRzOiByZWFkb25seSBDb25mbGljdFNlZ21lbnRbXSxcbiAgc2lkZTogQ29uZmxpY3RTaWRlLFxuKTogc3RyaW5nIHtcbiAgY29uc3QgaHVua0NvdW50ID0gc2VnbWVudHMuZmlsdGVyKChzKSA9PiBzLmtpbmQgPT09IFwiY29uZmxpY3RcIikubGVuZ3RoO1xuICByZXR1cm4gYXBwbHlIdW5rQ2hvaWNlcyhzZWdtZW50cywgQXJyYXkoaHVua0NvdW50KS5maWxsKHNpZGUpKTtcbn1cblxuLyoqIEFuIGB1bnJlc29sdmVkYCBvdXRjb21lLCBzbyB0aGUgcmVhc29uIHJlYWRzIHRoZSBzYW1lIHdheSBldmVyeSB0aW1lLiAqL1xuZnVuY3Rpb24gZGVmZXIocmVhc29uOiBzdHJpbmcpOiBSdWxlT3V0Y29tZSB7XG4gIHJldHVybiB7IGtpbmQ6IFwidW5yZXNvbHZlZFwiLCByZWFzb24gfTtcbn1cblxuLyoqIExpbmVzIG9mIGEgZmlsZSwgdGVybWluYXRvcnMgZHJvcHBlZCwgd2l0aCBubyB0cmFpbGluZyBlbXB0eSBlbGVtZW50LiAqL1xuZnVuY3Rpb24gbGluZXModGV4dDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBzcGxpdCA9IHRleHQuc3BsaXQoXCJcXG5cIik7XG4gIGlmIChzcGxpdC5sZW5ndGggPiAwICYmIHNwbGl0W3NwbGl0Lmxlbmd0aCAtIDFdID09PSBcIlwiKSBzcGxpdC5wb3AoKTtcbiAgcmV0dXJuIHNwbGl0O1xufVxuXG4vKipcbiAqIFdoZXRoZXIgZXZlcnkgbGluZSBvZiBgc3Vic2V0YCBhcHBlYXJzIGluIGBzdXBlcnNldGAsIGluIG9yZGVyLlxuICpcbiAqIE9yZGVyIG1hdHRlcnM6IGl0IGlzIHdoYXQgc2VwYXJhdGVzIFwidGhlIGJhc2Ugc3Vydml2ZWQgYW5kIG1vcmUgd2FzIGFkZGVkXG4gKiBhcm91bmQgaXRcIiBmcm9tIFwiYSBiYXNlIGxpbmUgd2FzIHJlcGxhY2VkIGJ5IGEgZGlmZmVyZW50IG9uZVwiLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNMaW5lU3Vic2VxdWVuY2Uoc3Vic2V0OiBzdHJpbmcsIHN1cGVyc2V0OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgY29uc3Qgd2FudCA9IGxpbmVzKHN1YnNldCk7XG4gIGNvbnN0IGhhdmUgPSBsaW5lcyhzdXBlcnNldCk7XG4gIGxldCBpID0gMDtcbiAgZm9yIChjb25zdCBsaW5lIG9mIGhhdmUpIHtcbiAgICBpZiAoaSA8IHdhbnQubGVuZ3RoICYmIGxpbmUgPT09IHdhbnRbaV0pIGkrKztcbiAgfVxuICByZXR1cm4gaSA9PT0gd2FudC5sZW5ndGg7XG59XG5cbi8qKlxuICogUmVzb2x2ZSBhIGNvbmZsaWN0IGluIHdoaWNoIGJvdGggc2lkZXMgb25seSBpbnNlcnRlZC5cbiAqXG4gKiBUaGUgYmFzZSBicmFuY2gncyBodW5rIGlzIGVtaXR0ZWQgZmlyc3QgYW5kIHRoaXMgYnJhbmNoJ3Mgc2Vjb25kOiB0aGUgcGFzc1xuICogcnVucyBkdXJpbmcgYGdpdCBtZXJnZSBvcmlnaW4vPGJhc2U+YCBvbiB0aGUgUFIgYnJhbmNoLCBzbyBzdGFnZSAzXG4gKiAoXCJ0aGVpcnNcIikgaXMgdGhlIGJhc2UgYnJhbmNoJ3Mgc2lkZS4gT3JkZXJpbmcgdGhlIG5ld2VzdCBsb2NhbCBlbnRyeSBhZnRlclxuICogdGhlIGJhc2UgYnJhbmNoJ3Mga2VlcHMgYSBsZWRnZXIgcmVhZGluZyB0aGUgd2F5IGJvdGggYXV0aG9ycyB3cm90ZSBpdC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlc29sdmVCb3RoSW5zZXJ0ZWQoXG4gIHNlZ21lbnRzOiByZWFkb25seSBDb25mbGljdFNlZ21lbnRbXSxcbiAgY29udGV4dDogUnVsZUNvbnRleHQsXG4pOiBSdWxlT3V0Y29tZSB7XG4gIGlmIChjb250ZXh0LmJhc2UgPT09IG51bGwpIHtcbiAgICByZXR1cm4gZGVmZXIoXG4gICAgICBgJHtjb250ZXh0LnBhdGh9IGhhcyBubyBtZXJnZS1iYXNlIHZlcnNpb24gdG8gY29tcGFyZSBhZ2FpbnN0LCBzbyBgICtcbiAgICAgICAgYFwiYm90aCBzaWRlcyBvbmx5IGluc2VydGVkXCIgY2Fubm90IGJlIGVzdGFibGlzaGVkYCxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgaHVua3MgPSBzZWdtZW50cy5maWx0ZXIoKHMpID0+IHMua2luZCA9PT0gXCJjb25mbGljdFwiKTtcbiAgaWYgKGh1bmtzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBkZWZlcihgJHtjb250ZXh0LnBhdGh9IGhhcyBubyBjb25mbGljdCBodW5rIHRvIHJlc29sdmVgKTtcbiAgfVxuXG4gIGlmIChpc0pzb25QYXRoKGNvbnRleHQucGF0aCkpIHtcbiAgICBjb25zdCB1bmlvbiA9IHVuaW9uSnNvbkluc2VydGlvbnMoXG4gICAgICBjb250ZXh0LmJhc2UsXG4gICAgICByZW5kZXJTaWRlKHNlZ21lbnRzLCBcIm91cnNcIiksXG4gICAgICByZW5kZXJTaWRlKHNlZ21lbnRzLCBcInRoZWlyc1wiKSxcbiAgICApO1xuICAgIHJldHVybiB1bmlvbi5va1xuICAgICAgPyB7IGtpbmQ6IFwicmVzb2x2ZWRcIiwgdGV4dDogdW5pb24udmFsdWUgfVxuICAgICAgOiBkZWZlcihgJHtjb250ZXh0LnBhdGh9IHdhcyBub3QgdW5pb25lZCBhcyBKU09OOiAke3VuaW9uLmVycm9yfWApO1xuICB9XG5cbiAgLy8gQSBmaWxlIG1lcmdlZCB3aXRoIGBkaWZmM2AgbWFya2VycyBzdGF0ZXMgaXRzIGJhc2UgcmVnaW9ucyBvdXRyaWdodDsgYVxuICAvLyBub24tZW1wdHkgb25lIGlzIGEgZGVsZXRpb24gb3IgYW4gZWRpdCwgd2hhdGV2ZXIgdGhlIHdob2xlLWZpbGUgY2hlY2sgc2F5cy5cbiAgZm9yIChjb25zdCBodW5rIG9mIGh1bmtzKSB7XG4gICAgaWYgKGh1bmsuYmFzZSAhPT0gbnVsbCAmJiBodW5rLmJhc2UgIT09IFwiXCIpIHtcbiAgICAgIHJldHVybiBkZWZlcihcbiAgICAgICAgYCR7Y29udGV4dC5wYXRofSBoYXMgYSBjb25mbGljdCBodW5rIHdob3NlIG1lcmdlIGJhc2UgaXMgbm90IGVtcHR5LCBgICtcbiAgICAgICAgICBgc28gYXQgbGVhc3Qgb25lIHNpZGUgY2hhbmdlZCBvciBkZWxldGVkIGEgYmFzZSBsaW5lYCxcbiAgICAgICk7XG4gICAgfVxuICB9XG5cbiAgY29uc3QgbGl0ZXJhbHMgPSBzZWdtZW50c1xuICAgIC5maWx0ZXIoKHMpID0+IHMua2luZCA9PT0gXCJsaXRlcmFsXCIpXG4gICAgLm1hcCgocykgPT4gcy50ZXh0KVxuICAgIC5qb2luKFwiXCIpO1xuICBpZiAoIWlzTGluZVN1YnNlcXVlbmNlKGNvbnRleHQuYmFzZSwgbGl0ZXJhbHMpKSB7XG4gICAgcmV0dXJuIGRlZmVyKFxuICAgICAgYCR7Y29udGV4dC5wYXRofSBkb2VzIG5vdCByZWFkIGFzIHR3byBwdXJlIGluc2VydGlvbnM6IGEgbGluZSB0aGUgbWVyZ2UgYCArXG4gICAgICAgIGBiYXNlIGhhZCBkb2VzIG5vdCBzdXJ2aXZlIG91dHNpZGUgdGhlIGNvbmZsaWN0IGh1bmtzLCBzbyBpdCB3YXMgYCArXG4gICAgICAgIGBjaGFuZ2VkLCBtb3ZlZCBvciBkZWxldGVkYCxcbiAgICApO1xuICB9XG5cbiAgbGV0IG1lcmdlZCA9IFwiXCI7XG4gIGZvciAoY29uc3Qgc2VnbWVudCBvZiBzZWdtZW50cykge1xuICAgIG1lcmdlZCArPSBzZWdtZW50LmtpbmQgPT09IFwibGl0ZXJhbFwiXG4gICAgICA/IHNlZ21lbnQudGV4dFxuICAgICAgOiBzZWdtZW50LnRoZWlycyArIHNlZ21lbnQub3VycztcbiAgfVxuXG4gIHJldHVybiB7IGtpbmQ6IFwicmVzb2x2ZWRcIiwgdGV4dDogbWVyZ2VkIH07XG59XG5cbi8qKlxuICogV2hldGhlciBrZWVwaW5nIGJvdGggc2lkZXMgb2YgYHBhdGhgIGxlYXZlcyBhIHdlbGwtZm9ybWVkIGRvY3VtZW50LlxuICpcbiAqIEpTT04gaXMgdGhlIG9uZSBmb3JtYXQgY2hlYXAgZW5vdWdoIHRvIGNoZWNrIGFuZCBjb21tb24gZW5vdWdoIHRvIG1hdHRlcjogYVxuICogdW5pb24gb2YgdHdvIGxlZGdlciBlbnRyaWVzIHJlYWRpbHkgbGVhdmVzIGFuIGFycmF5IHdpdGggYSBtaXNzaW5nIG9yXG4gKiBkb3VibGVkIGNvbW1hLCBhbmQgYW4gaW52YWxpZCBsZWRnZXIgbXVzdCBuZXZlciBiZSB3cml0dGVuLiBBIHBhdGggaW4gYW55XG4gKiBvdGhlciBmb3JtYXQgaGFzIG5vIHN1Y2ggY2hlY2sgYW5kIGlzIG5vdCBibG9ja2VkIGJ5IG9uZS5cbiAqXG4gKiBUaGlzIHJ1bGUgbm8gbG9uZ2VyIG5lZWRzIGl0IOKAlCBhIGAuanNvbmAgcGF0aCB0YWtlcyB0aGUgc3RydWN0dXJlZCB1bmlvblxuICogYWJvdmUsIHdoaWNoIGNhbm5vdCBwcm9kdWNlIGFuIGludmFsaWQgZG9jdW1lbnQg4oCUIGFuZCBzaW5jZSBJc3N1ZSAjMjAxMyB0aGVcbiAqIG1pbGVzdG9uZSBsYWRkZXIncyB1bmlvbiBtZXJnZSAoYG1pbGVzdG9uZV9jb25mbGljdF9naXQudHNgKSB0cmllcyB0aGF0IHNhbWVcbiAqIHN0cnVjdHVyZWQgdW5pb24gZmlyc3QuIEl0IHN0aWxsIGZhbGxzIGJhY2sgdG8gYGdpdCBtZXJnZS1maWxlIC0tdW5pb25gIGZvclxuICogYW55dGhpbmcgdGhlIHN0cnVjdHVyZWQgdW5pb24gcmVmdXNlcywgc28gdGhhdCBmYWxsYmFjayBpcyB0aGUgcnVuZyB0aGlzXG4gKiBndWFyZCBub3cgcHJvdGVjdHMuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB1bmlvbklzV2VsbEZvcm1lZChwYXRoOiBzdHJpbmcsIHRleHQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBpZiAoIWlzSnNvblBhdGgocGF0aCkpIHJldHVybiB0cnVlO1xuICB0cnkge1xuICAgIEpTT04ucGFyc2UodGV4dCk7XG4gICAgcmV0dXJuIHRydWU7XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiBmYWxzZTtcbiAgfVxufVxuXG4vKiogVGhlIHJ1bGUgYXMgdGhlIHJlZ2lzdHJ5IGhvbGRzIGl0LiAqL1xuZXhwb3J0IGNvbnN0IGJvdGhJbnNlcnRlZFJ1bGU6IE1hbmlmZXN0UnVsZSA9IHtcbiAgbmFtZTogQk9USF9JTlNFUlRFRF9SVUxFX05BTUUsXG4gIG5lZWRzQmFzZTogdHJ1ZSxcbiAgbWF0Y2hlczogaXNCb3RoSW5zZXJ0ZWRDYW5kaWRhdGUsXG4gIHJlc29sdmU6IHJlc29sdmVCb3RoSW5zZXJ0ZWQsXG59O1xuXG4vKipcbiAqIFJlZ2lzdGVyIHRoZSBydWxlLlxuICpcbiAqIFJlZ2lzdGVyZWQgKipsYXN0KiosIGJlY2F1c2UgaXQgbWF0Y2hlcyBhbG1vc3QgZXZlcnkgcGF0aDogdGhlIG1hbmlmZXN0IHJ1bGVzXG4gKiBtdXN0IHNlZSB0aGVpciBvd24gZmlsZXMgZmlyc3QuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiByZWdpc3RlckJvdGhJbnNlcnRlZFJ1bGUoXG4gIHJlZ2lzdHJ5OiBNYW5pZmVzdFJ1bGVSZWdpc3RyeSA9IG1hbmlmZXN0UnVsZVJlZ2lzdHJ5LFxuKTogdm9pZCB7XG4gIHJlZ2lzdHJ5LnJlZ2lzdGVyKGJvdGhJbnNlcnRlZFJ1bGUpO1xufVxuXG5yZWdpc3RlckJvdGhJbnNlcnRlZFJ1bGUoKTtcbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQW1FQyxHQUVELFNBQ0UsZ0JBQWdCLEVBS2hCLG9CQUFvQixRQUdmLGlDQUFpQztBQUN4QyxTQUFTLG1CQUFtQixRQUFRLDRCQUE0QjtBQUVoRSx5RUFBeUUsR0FDekUsT0FBTyxNQUFNLDBCQUEwQixnQkFBZ0I7QUFFdkQ7Ozs7OztDQU1DLEdBQ0QsTUFBTSxrQkFBa0IsSUFBSSxJQUFJO0VBQzlCO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRDtBQUVELDBDQUEwQyxHQUMxQyxTQUFTLFNBQVMsSUFBWTtFQUM1QixPQUFPLENBQUMsS0FBSyxLQUFLLENBQUMsS0FBSyxHQUFHLE1BQU0sSUFBSSxFQUFFLFdBQVc7QUFDcEQ7QUFFQSx3RUFBd0UsR0FDeEUsT0FBTyxTQUFTLHdCQUF3QixJQUFZO0VBQ2xELE9BQU8sQ0FBQyxnQkFBZ0IsR0FBRyxDQUFDLFNBQVM7QUFDdkM7QUFFQTs7Ozs7O0NBTUMsR0FDRCxPQUFPLFNBQVMsV0FBVyxJQUFZO0VBQ3JDLE9BQU8sU0FBUyxNQUFNLFFBQVEsQ0FBQztBQUNqQztBQUVBOzs7Ozs7O0NBT0MsR0FDRCxTQUFTLFdBQ1AsUUFBb0MsRUFDcEMsSUFBa0I7RUFFbEIsTUFBTSxZQUFZ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
// denoCacheMetadata=10356761209502257438,15742862394996805568