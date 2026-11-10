/**
 * Shared `gh` argv classifier (Issue #1588).
 *
 * Two counters used to decide independently what an `api graphql`
 * invocation is, and they parsed argv differently:
 *
 * - `classifyGhArgs` (`gh_call_metrics.ts`) skipped any token starting with
 *   `-` as a flag, so the *value* of a value-taking flag was read as the next
 *   positional — `["api", "-f", "query=…", "graphql"]` classified as `"api"`.
 * - `isQuotaExemptGhCall` (`primary_quota_latch.ts`) required `args[0] ===
 *   "api"` with no flag skipping at all, then tested `args.includes(
 *   "graphql")`, which matched the token anywhere in argv — including as a
 *   flag value.
 *
 * The two therefore answered slightly different questions, and the
 * `api-graphql=` bucket could not be reconciled with the GraphQL attribution
 * that shares the `isQuotaExemptGhCall` predicate. This module is the single
 * argv classifier both now derive from: flag-aware, with an explicit list of
 * value-taking flags so a flag value is never mistaken for a positional.
 *
 * It deliberately lives in its own module rather than in either caller:
 * `gh_call_metrics.ts` already imports from `primary_quota_latch.ts`, so a
 * helper in `gh_call_metrics.ts` would invert that direction.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { normaliseGhArgs } from "./gh_flag_parser.ts";
/**
 * Long `gh` flags that consume the following argv token as their value.
 *
 * Anything not listed here is treated as a boolean flag, so a missing entry
 * lets that flag's value be read as a positional token. The list is a
 * superset of the long flags named in Issue #1588: it also covers the
 * remaining value-taking `gh api` and global flags (`--cache`, `--preview`,
 * `--hostname`), because those are the ones that can precede the `graphql`
 * endpoint token and would otherwise let a real GraphQL call be classified as
 * REST — the direction the latch must never be wrong in.
 *
 * `--flag=value` needs no entry: it is one token and consumes nothing.
 */ export const GH_VALUE_TAKING_LONG_FLAGS = new Set([
  "--field",
  "--raw-field",
  "--header",
  "--method",
  "--jq",
  "--template",
  "--input",
  "--repo",
  "--cache",
  "--preview",
  "--hostname"
]);
/**
 * Shorthand letters that consume the following argv token as their value:
 * `-f`, `-F`, `-H`, `-X`, `-q`, `-t`, `-R`, `-p`, matching the long flags
 * above.
 *
 * This is deliberately *not* `gh_flag_parser.ts`'s `GH_VALUE_SHORTHANDS`, and
 * the two must not be merged: that set is intentionally over-inclusive
 * (any letter that takes a value under *any* subcommand) because ending a
 * shorthand-group walk too late is its fail-closed direction. Here the
 * asymmetry is the other way round — treating a boolean letter as
 * value-taking would swallow the endpoint token and classify a GraphQL call
 * as REST — so this set lists only the letters that genuinely take a value,
 * and it is complete for `gh api`'s own value-taking shorthands.
 */ export const GH_VALUE_TAKING_SHORTHANDS = new Set([
  "f",
  "F",
  "H",
  "X",
  "q",
  "t",
  "R",
  "p"
]);
/**
 * Every separated value-taking flag token (`--field`, `-f`, …) — the one table
 * every `gh` argv walker shares (Issue #3568). The audit classifier kept its
 * own shorter list, which lacked `-p`/`--preview`, so the two disagreed about
 * which token was the endpoint (Issue #3561).
 */ export const GH_SEPARATED_VALUE_FLAGS = new Set([
  ...GH_VALUE_TAKING_LONG_FLAGS,
  ...[
    ...GH_VALUE_TAKING_SHORTHANDS
  ].map((letter)=>`-${letter}`)
]);
/**
 * Whether a shorthand token takes the *following* argv token as its value.
 *
 * pflag reads `-iq .data` as `-i -q .data`: boolean letters are walked past,
 * and the first value-taking letter ends the group. If that letter is last,
 * its value is the next argv token; if anything follows it in the same token,
 * that remainder is the value and nothing further is consumed (`-iq.data`).
 *
 * `normaliseGhArgs` already expands the groups whose value the `gh` guards
 * read (`-R`, `-l`, `-X`, `-f`, `-F`); this covers the rest, so a group like
 * `gh api -iq .data graphql` cannot hide the endpoint token.
 */ export function shorthandTakesNextToken(token) {
  for(let i = 1; i < token.length; i++){
    const letter = token[i];
    // Boolean here; pflag moves on to the next letter in the group.
    if (!GH_VALUE_TAKING_SHORTHANDS.has(letter)) continue;
    return i === token.length - 1;
  }
  return false;
}
/**
 * The positional tokens of a `gh` argument list, in order, with flags and
 * their values removed.
 *
 * `--` ends flag processing: every token after it is positional, which is how
 * `gh` itself reads argv.
 *
 * argv is first run through `normaliseGhArgs` so a pflag shorthand group
 * carrying an attached value — `gh api -iXPOST graphql`, which is
 * `-i -X POST graphql` — is expanded to its separated form.
 *
 * @param args - Argument list passed to the `gh` binary.
 */ export function ghPositionalArgs(args) {
  const normalised = normaliseGhArgs(args);
  const positionals = [];
  for(let i = 0; i < normalised.length; i++){
    const token = normalised[i];
    if (token === "--") {
      positionals.push(...normalised.slice(i + 1));
      break;
    }
    if (token.startsWith("--")) {
      // `--flag=value` carries its value in the same token.
      if (!token.includes("=") && GH_VALUE_TAKING_LONG_FLAGS.has(token)) i++;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      if (shorthandTakesNextToken(token)) i++;
      continue;
    }
    positionals.push(token);
  }
  return positionals;
}
/**
 * The flag **names** of a `gh` invocation, never their values (Issue #2409).
 *
 * Walks the argv exactly as {@link ghPositionalArgs} does, so the same table
 * decides which tokens are a flag's value and are therefore skipped — a
 * `--body` whose text contains `--looks-like-a-flag` contributes `--body` and
 * nothing else. `--flag=value` keeps the name and drops the value.
 *
 * @param args - Argument list passed to the `gh` binary.
 * @returns The flag names in argv order, duplicates included.
 */ export function ghFlagNames(args) {
  const normalised = normaliseGhArgs(args);
  const names = [];
  for(let i = 0; i < normalised.length; i++){
    const token = normalised[i];
    if (token === "--") break;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      names.push(eq < 0 ? token : token.slice(0, eq));
      if (eq < 0 && GH_VALUE_TAKING_LONG_FLAGS.has(token)) i++;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      names.push(token);
      if (shorthandTakesNextToken(token)) i++;
    }
  }
  return names;
}
/**
 * Classify already-extracted positional tokens (Issue #1588).
 *
 * Exposed so a caller that has parsed argv once — `classifyGhArgs`, which
 * also needs the sub-command verb — does not parse it a second time to ask
 * the same question.
 *
 * `graphql` counts only as the positional token immediately after `api`, so a
 * REST path or a flag value containing the word — `gh api
 * /search/issues?q=graphql`, `gh api repos/o/r/labels --jq graphql` — is REST,
 * not GraphQL.
 */ export function ghCallKindOf(positionals) {
  const head = positionals[0];
  if (head === undefined) return "unknown";
  if (head !== "api") return "sub-command";
  return positionals[1] === "graphql" ? "api-graphql" : "api-rest";
}
/**
 * Classify a `gh` argument list by which API budget it spends (Issue #1588).
 *
 * @param args - Argument list passed to the `gh` binary.
 */ export function classifyGhCall(args) {
  return ghCallKindOf(ghPositionalArgs(args));
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9hcmd2LnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogU2hhcmVkIGBnaGAgYXJndiBjbGFzc2lmaWVyIChJc3N1ZSAjMTU4OCkuXG4gKlxuICogVHdvIGNvdW50ZXJzIHVzZWQgdG8gZGVjaWRlIGluZGVwZW5kZW50bHkgd2hhdCBhbiBgYXBpIGdyYXBocWxgXG4gKiBpbnZvY2F0aW9uIGlzLCBhbmQgdGhleSBwYXJzZWQgYXJndiBkaWZmZXJlbnRseTpcbiAqXG4gKiAtIGBjbGFzc2lmeUdoQXJnc2AgKGBnaF9jYWxsX21ldHJpY3MudHNgKSBza2lwcGVkIGFueSB0b2tlbiBzdGFydGluZyB3aXRoXG4gKiAgIGAtYCBhcyBhIGZsYWcsIHNvIHRoZSAqdmFsdWUqIG9mIGEgdmFsdWUtdGFraW5nIGZsYWcgd2FzIHJlYWQgYXMgdGhlIG5leHRcbiAqICAgcG9zaXRpb25hbCDigJQgYFtcImFwaVwiLCBcIi1mXCIsIFwicXVlcnk94oCmXCIsIFwiZ3JhcGhxbFwiXWAgY2xhc3NpZmllZCBhcyBgXCJhcGlcImAuXG4gKiAtIGBpc1F1b3RhRXhlbXB0R2hDYWxsYCAoYHByaW1hcnlfcXVvdGFfbGF0Y2gudHNgKSByZXF1aXJlZCBgYXJnc1swXSA9PT1cbiAqICAgXCJhcGlcImAgd2l0aCBubyBmbGFnIHNraXBwaW5nIGF0IGFsbCwgdGhlbiB0ZXN0ZWQgYGFyZ3MuaW5jbHVkZXMoXG4gKiAgIFwiZ3JhcGhxbFwiKWAsIHdoaWNoIG1hdGNoZWQgdGhlIHRva2VuIGFueXdoZXJlIGluIGFyZ3Yg4oCUIGluY2x1ZGluZyBhcyBhXG4gKiAgIGZsYWcgdmFsdWUuXG4gKlxuICogVGhlIHR3byB0aGVyZWZvcmUgYW5zd2VyZWQgc2xpZ2h0bHkgZGlmZmVyZW50IHF1ZXN0aW9ucywgYW5kIHRoZVxuICogYGFwaS1ncmFwaHFsPWAgYnVja2V0IGNvdWxkIG5vdCBiZSByZWNvbmNpbGVkIHdpdGggdGhlIEdyYXBoUUwgYXR0cmlidXRpb25cbiAqIHRoYXQgc2hhcmVzIHRoZSBgaXNRdW90YUV4ZW1wdEdoQ2FsbGAgcHJlZGljYXRlLiBUaGlzIG1vZHVsZSBpcyB0aGUgc2luZ2xlXG4gKiBhcmd2IGNsYXNzaWZpZXIgYm90aCBub3cgZGVyaXZlIGZyb206IGZsYWctYXdhcmUsIHdpdGggYW4gZXhwbGljaXQgbGlzdCBvZlxuICogdmFsdWUtdGFraW5nIGZsYWdzIHNvIGEgZmxhZyB2YWx1ZSBpcyBuZXZlciBtaXN0YWtlbiBmb3IgYSBwb3NpdGlvbmFsLlxuICpcbiAqIEl0IGRlbGliZXJhdGVseSBsaXZlcyBpbiBpdHMgb3duIG1vZHVsZSByYXRoZXIgdGhhbiBpbiBlaXRoZXIgY2FsbGVyOlxuICogYGdoX2NhbGxfbWV0cmljcy50c2AgYWxyZWFkeSBpbXBvcnRzIGZyb20gYHByaW1hcnlfcXVvdGFfbGF0Y2gudHNgLCBzbyBhXG4gKiBoZWxwZXIgaW4gYGdoX2NhbGxfbWV0cmljcy50c2Agd291bGQgaW52ZXJ0IHRoYXQgZGlyZWN0aW9uLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7IG5vcm1hbGlzZUdoQXJncyB9IGZyb20gXCIuL2doX2ZsYWdfcGFyc2VyLnRzXCI7XG5cbi8qKlxuICogTG9uZyBgZ2hgIGZsYWdzIHRoYXQgY29uc3VtZSB0aGUgZm9sbG93aW5nIGFyZ3YgdG9rZW4gYXMgdGhlaXIgdmFsdWUuXG4gKlxuICogQW55dGhpbmcgbm90IGxpc3RlZCBoZXJlIGlzIHRyZWF0ZWQgYXMgYSBib29sZWFuIGZsYWcsIHNvIGEgbWlzc2luZyBlbnRyeVxuICogbGV0cyB0aGF0IGZsYWcncyB2YWx1ZSBiZSByZWFkIGFzIGEgcG9zaXRpb25hbCB0b2tlbi4gVGhlIGxpc3QgaXMgYVxuICogc3VwZXJzZXQgb2YgdGhlIGxvbmcgZmxhZ3MgbmFtZWQgaW4gSXNzdWUgIzE1ODg6IGl0IGFsc28gY292ZXJzIHRoZVxuICogcmVtYWluaW5nIHZhbHVlLXRha2luZyBgZ2ggYXBpYCBhbmQgZ2xvYmFsIGZsYWdzIChgLS1jYWNoZWAsIGAtLXByZXZpZXdgLFxuICogYC0taG9zdG5hbWVgKSwgYmVjYXVzZSB0aG9zZSBhcmUgdGhlIG9uZXMgdGhhdCBjYW4gcHJlY2VkZSB0aGUgYGdyYXBocWxgXG4gKiBlbmRwb2ludCB0b2tlbiBhbmQgd291bGQgb3RoZXJ3aXNlIGxldCBhIHJlYWwgR3JhcGhRTCBjYWxsIGJlIGNsYXNzaWZpZWQgYXNcbiAqIFJFU1Qg4oCUIHRoZSBkaXJlY3Rpb24gdGhlIGxhdGNoIG11c3QgbmV2ZXIgYmUgd3JvbmcgaW4uXG4gKlxuICogYC0tZmxhZz12YWx1ZWAgbmVlZHMgbm8gZW50cnk6IGl0IGlzIG9uZSB0b2tlbiBhbmQgY29uc3VtZXMgbm90aGluZy5cbiAqL1xuZXhwb3J0IGNvbnN0IEdIX1ZBTFVFX1RBS0lOR19MT05HX0ZMQUdTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiLS1maWVsZFwiLFxuICBcIi0tcmF3LWZpZWxkXCIsXG4gIFwiLS1oZWFkZXJcIixcbiAgXCItLW1ldGhvZFwiLFxuICBcIi0tanFcIixcbiAgXCItLXRlbXBsYXRlXCIsXG4gIFwiLS1pbnB1dFwiLFxuICBcIi0tcmVwb1wiLFxuICBcIi0tY2FjaGVcIixcbiAgXCItLXByZXZpZXdcIixcbiAgXCItLWhvc3RuYW1lXCIsXG5dKTtcblxuLyoqXG4gKiBTaG9ydGhhbmQgbGV0dGVycyB0aGF0IGNvbnN1bWUgdGhlIGZvbGxvd2luZyBhcmd2IHRva2VuIGFzIHRoZWlyIHZhbHVlOlxuICogYC1mYCwgYC1GYCwgYC1IYCwgYC1YYCwgYC1xYCwgYC10YCwgYC1SYCwgYC1wYCwgbWF0Y2hpbmcgdGhlIGxvbmcgZmxhZ3NcbiAqIGFib3ZlLlxuICpcbiAqIFRoaXMgaXMgZGVsaWJlcmF0ZWx5ICpub3QqIGBnaF9mbGFnX3BhcnNlci50c2AncyBgR0hfVkFMVUVfU0hPUlRIQU5EU2AsIGFuZFxuICogdGhlIHR3byBtdXN0IG5vdCBiZSBtZXJnZWQ6IHRoYXQgc2V0IGlzIGludGVudGlvbmFsbHkgb3Zlci1pbmNsdXNpdmVcbiAqIChhbnkgbGV0dGVyIHRoYXQgdGFrZXMgYSB2YWx1ZSB1bmRlciAqYW55KiBzdWJjb21tYW5kKSBiZWNhdXNlIGVuZGluZyBhXG4gKiBzaG9ydGhhbmQtZ3JvdXAgd2FsayB0b28gbGF0ZSBpcyBpdHMgZmFpbC1jbG9zZWQgZGlyZWN0aW9uLiBIZXJlIHRoZVxuICogYXN5bW1ldHJ5IGlzIHRoZSBvdGhlciB3YXkgcm91bmQg4oCUIHRyZWF0aW5nIGEgYm9vbGVhbiBsZXR0ZXIgYXNcbiAqIHZhbHVlLXRha2luZyB3b3VsZCBzd2FsbG93IHRoZSBlbmRwb2ludCB0b2tlbiBhbmQgY2xhc3NpZnkgYSBHcmFwaFFMIGNhbGxcbiAqIGFzIFJFU1Qg4oCUIHNvIHRoaXMgc2V0IGxpc3RzIG9ubHkgdGhlIGxldHRlcnMgdGhhdCBnZW51aW5lbHkgdGFrZSBhIHZhbHVlLFxuICogYW5kIGl0IGlzIGNvbXBsZXRlIGZvciBgZ2ggYXBpYCdzIG93biB2YWx1ZS10YWtpbmcgc2hvcnRoYW5kcy5cbiAqL1xuZXhwb3J0IGNvbnN0IEdIX1ZBTFVFX1RBS0lOR19TSE9SVEhBTkRTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChcbiAgW1wiZlwiLCBcIkZcIiwgXCJIXCIsIFwiWFwiLCBcInFcIiwgXCJ0XCIsIFwiUlwiLCBcInBcIl0sXG4pO1xuXG4vKipcbiAqIEV2ZXJ5IHNlcGFyYXRlZCB2YWx1ZS10YWtpbmcgZmxhZyB0b2tlbiAoYC0tZmllbGRgLCBgLWZgLCDigKYpIOKAlCB0aGUgb25lIHRhYmxlXG4gKiBldmVyeSBgZ2hgIGFyZ3Ygd2Fsa2VyIHNoYXJlcyAoSXNzdWUgIzM1NjgpLiBUaGUgYXVkaXQgY2xhc3NpZmllciBrZXB0IGl0c1xuICogb3duIHNob3J0ZXIgbGlzdCwgd2hpY2ggbGFja2VkIGAtcGAvYC0tcHJldmlld2AsIHNvIHRoZSB0d28gZGlzYWdyZWVkIGFib3V0XG4gKiB3aGljaCB0b2tlbiB3YXMgdGhlIGVuZHBvaW50IChJc3N1ZSAjMzU2MSkuXG4gKi9cbmV4cG9ydCBjb25zdCBHSF9TRVBBUkFURURfVkFMVUVfRkxBR1M6IFJlYWRvbmx5U2V0PHN0cmluZz4gPSBuZXcgU2V0KFtcbiAgLi4uR0hfVkFMVUVfVEFLSU5HX0xPTkdfRkxBR1MsXG4gIC4uLlsuLi5HSF9WQUxVRV9UQUtJTkdfU0hPUlRIQU5EU10ubWFwKChsZXR0ZXIpID0+IGAtJHtsZXR0ZXJ9YCksXG5dKTtcblxuLyoqXG4gKiBXaGV0aGVyIGEgc2hvcnRoYW5kIHRva2VuIHRha2VzIHRoZSAqZm9sbG93aW5nKiBhcmd2IHRva2VuIGFzIGl0cyB2YWx1ZS5cbiAqXG4gKiBwZmxhZyByZWFkcyBgLWlxIC5kYXRhYCBhcyBgLWkgLXEgLmRhdGFgOiBib29sZWFuIGxldHRlcnMgYXJlIHdhbGtlZCBwYXN0LFxuICogYW5kIHRoZSBmaXJzdCB2YWx1ZS10YWtpbmcgbGV0dGVyIGVuZHMgdGhlIGdyb3VwLiBJZiB0aGF0IGxldHRlciBpcyBsYXN0LFxuICogaXRzIHZhbHVlIGlzIHRoZSBuZXh0IGFyZ3YgdG9rZW47IGlmIGFueXRoaW5nIGZvbGxvd3MgaXQgaW4gdGhlIHNhbWUgdG9rZW4sXG4gKiB0aGF0IHJlbWFpbmRlciBpcyB0aGUgdmFsdWUgYW5kIG5vdGhpbmcgZnVydGhlciBpcyBjb25zdW1lZCAoYC1pcS5kYXRhYCkuXG4gKlxuICogYG5vcm1hbGlzZUdoQXJnc2AgYWxyZWFkeSBleHBhbmRzIHRoZSBncm91cHMgd2hvc2UgdmFsdWUgdGhlIGBnaGAgZ3VhcmRzXG4gKiByZWFkIChgLVJgLCBgLWxgLCBgLVhgLCBgLWZgLCBgLUZgKTsgdGhpcyBjb3ZlcnMgdGhlIHJlc3QsIHNvIGEgZ3JvdXAgbGlrZVxuICogYGdoIGFwaSAtaXEgLmRhdGEgZ3JhcGhxbGAgY2Fubm90IGhpZGUgdGhlIGVuZHBvaW50IHRva2VuLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc2hvcnRoYW5kVGFrZXNOZXh0VG9rZW4odG9rZW46IHN0cmluZyk6IGJvb2xlYW4ge1xuICBmb3IgKGxldCBpID0gMTsgaSA8IHRva2VuLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgbGV0dGVyID0gdG9rZW5baV0hO1xuICAgIC8vIEJvb2xlYW4gaGVyZTsgcGZsYWcgbW92ZXMgb24gdG8gdGhlIG5leHQgbGV0dGVyIGluIHRoZSBncm91cC5cbiAgICBpZiAoIUdIX1ZBTFVFX1RBS0lOR19TSE9SVEhBTkRTLmhhcyhsZXR0ZXIpKSBjb250aW51ZTtcbiAgICByZXR1cm4gaSA9PT0gdG9rZW4ubGVuZ3RoIC0gMTtcbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKlxuICogVGhlIHBvc2l0aW9uYWwgdG9rZW5zIG9mIGEgYGdoYCBhcmd1bWVudCBsaXN0LCBpbiBvcmRlciwgd2l0aCBmbGFncyBhbmRcbiAqIHRoZWlyIHZhbHVlcyByZW1vdmVkLlxuICpcbiAqIGAtLWAgZW5kcyBmbGFnIHByb2Nlc3Npbmc6IGV2ZXJ5IHRva2VuIGFmdGVyIGl0IGlzIHBvc2l0aW9uYWwsIHdoaWNoIGlzIGhvd1xuICogYGdoYCBpdHNlbGYgcmVhZHMgYXJndi5cbiAqXG4gKiBhcmd2IGlzIGZpcnN0IHJ1biB0aHJvdWdoIGBub3JtYWxpc2VHaEFyZ3NgIHNvIGEgcGZsYWcgc2hvcnRoYW5kIGdyb3VwXG4gKiBjYXJyeWluZyBhbiBhdHRhY2hlZCB2YWx1ZSDigJQgYGdoIGFwaSAtaVhQT1NUIGdyYXBocWxgLCB3aGljaCBpc1xuICogYC1pIC1YIFBPU1QgZ3JhcGhxbGAg4oCUIGlzIGV4cGFuZGVkIHRvIGl0cyBzZXBhcmF0ZWQgZm9ybS5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50IGxpc3QgcGFzc2VkIHRvIHRoZSBgZ2hgIGJpbmFyeS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGdoUG9zaXRpb25hbEFyZ3MoYXJnczogcmVhZG9ubHkgc3RyaW5nW10pOiBzdHJpbmdbXSB7XG4gIGNvbnN0IG5vcm1hbGlzZWQgPSBub3JtYWxpc2VHaEFyZ3MoYXJncyk7XG4gIGNvbnN0IHBvc2l0aW9uYWxzOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGxldCBpID0gMDsgaSA8IG5vcm1hbGlzZWQubGVuZ3RoOyBpKyspIHtcbiAgICBjb25zdCB0b2tlbiA9IG5vcm1hbGlzZWRbaV0hO1xuICAgIGlmICh0b2tlbiA9PT0gXCItLVwiKSB7XG4gICAgICBwb3NpdGlvbmFscy5wdXNoKC4uLm5vcm1hbGlzZWQuc2xpY2UoaSArIDEpKTtcbiAgICAgIGJyZWFrO1xuICAgIH1cbiAgICBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi0tXCIpKSB7XG4gICAgICAvLyBgLS1mbGFnPXZhbHVlYCBjYXJyaWVzIGl0cyB2YWx1ZSBpbiB0aGUgc2FtZSB0b2tlbi5cbiAgICAgIGlmICghdG9rZW4uaW5jbHVkZXMoXCI9XCIpICYmIEdIX1ZBTFVFX1RBS0lOR19MT05HX0ZMQUdTLmhhcyh0b2tlbikpIGkrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAodG9rZW4uc3RhcnRzV2l0aChcIi1cIikgJiYgdG9rZW4gIT09IFwiLVwiKSB7XG4gICAgICBpZiAoc2hvcnRoYW5kVGFrZXNOZXh0VG9rZW4odG9rZW4pKSBpKys7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgcG9zaXRpb25hbHMucHVzaCh0b2tlbik7XG4gIH1cbiAgcmV0dXJuIHBvc2l0aW9uYWxzO1xufVxuXG4vKipcbiAqIFRoZSBmbGFnICoqbmFtZXMqKiBvZiBhIGBnaGAgaW52b2NhdGlvbiwgbmV2ZXIgdGhlaXIgdmFsdWVzIChJc3N1ZSAjMjQwOSkuXG4gKlxuICogV2Fsa3MgdGhlIGFyZ3YgZXhhY3RseSBhcyB7QGxpbmsgZ2hQb3NpdGlvbmFsQXJnc30gZG9lcywgc28gdGhlIHNhbWUgdGFibGVcbiAqIGRlY2lkZXMgd2hpY2ggdG9rZW5zIGFyZSBhIGZsYWcncyB2YWx1ZSBhbmQgYXJlIHRoZXJlZm9yZSBza2lwcGVkIOKAlCBhXG4gKiBgLS1ib2R5YCB3aG9zZSB0ZXh0IGNvbnRhaW5zIGAtLWxvb2tzLWxpa2UtYS1mbGFnYCBjb250cmlidXRlcyBgLS1ib2R5YCBhbmRcbiAqIG5vdGhpbmcgZWxzZS4gYC0tZmxhZz12YWx1ZWAga2VlcHMgdGhlIG5hbWUgYW5kIGRyb3BzIHRoZSB2YWx1ZS5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50IGxpc3QgcGFzc2VkIHRvIHRoZSBgZ2hgIGJpbmFyeS5cbiAqIEByZXR1cm5zIFRoZSBmbGFnIG5hbWVzIGluIGFyZ3Ygb3JkZXIsIGR1cGxpY2F0ZXMgaW5jbHVkZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnaEZsYWdOYW1lcyhhcmdzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgbm9ybWFsaXNlZCA9IG5vcm1hbGlzZUdoQXJncyhhcmdzKTtcbiAgY29uc3QgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbm9ybWFsaXNlZC5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHRva2VuID0gbm9ybWFsaXNlZFtpXSE7XG4gICAgaWYgKHRva2VuID09PSBcIi0tXCIpIGJyZWFrO1xuICAgIGlmICh0b2tlbi5zdGFydHNXaXRoKFwiLS1cIikpIHtcbiAgICAgIGNvbnN0IGVxID0gdG9rZW4uaW5kZXhPZihcIj1cIik7XG4gICAgICBuYW1lcy5wdXNoKGVxIDwgMCA/IHRva2VuIDogdG9rZW4uc2xpY2UoMCwgZXEpKTtcbiAgICAgIGlmIChlcSA8IDAgJiYgR0hfVkFMVUVfVEFLSU5HX0xPTkdfRkxBR1MuaGFzKHRva2VuKSkgaSsrO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGlmICh0b2tlbi5zdGFydHNXaXRoKFwiLVwiKSAmJiB0b2tlbiAhPT0gXCItXCIpIHtcbiAgICAgIG5hbWVzLnB1c2godG9rZW4pO1xuICAgICAgaWYgKHNob3J0aGFuZFRha2VzTmV4dFRva2VuKHRva2VuKSkgaSsrO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbmFtZXM7XG59XG5cbi8qKlxuICogV2hhdCBraW5kIG9mIEdpdEh1YiBBUEkgYnVkZ2V0IGEgYGdoYCBpbnZvY2F0aW9uIHNwZW5kcy5cbiAqXG4gKiAtIGBhcGktZ3JhcGhxbGAg4oCUIGFuIGV4cGxpY2l0IGBnaCBhcGkgZ3JhcGhxbCDigKZgIGNhbGwuXG4gKiAtIGBhcGktcmVzdGAg4oCUIGEgcGxhaW4gYGdoIGFwaSA8cGF0aD5gIGNhbGwsIHdoaWNoIHJpZGVzIHRoZSBzZXBhcmF0ZVxuICogICBjb3JlIFJFU1QgcXVvdGEuXG4gKiAtIGBzdWItY29tbWFuZGAg4oCUIGV2ZXJ5IG90aGVyIGBnaGAgc3ViLWNvbW1hbmQgKGBpc3N1ZSBsaXN0YCwgYHByIHZpZXdgLFxuICogICBgc2VhcmNoIOKApmApOyBhbGwgb2YgdGhlbSBhcmUgR3JhcGhRTC1iYWNrZWQuXG4gKiAtIGB1bmtub3duYCDigJQgbm8gcG9zaXRpb25hbCB0b2tlbiBhdCBhbGwgKGBnaCAtLXZlcnNpb25gLCBgZ2hgKS4gTm90IGFcbiAqICAgUkVTVCBgYXBpYCBjYWxsLCBzbyB0aGUgbGF0Y2ggYmlsbHMgaXQgbGlrZSBhbnkgb3RoZXIgbm9uLVJFU1RcbiAqICAgaW52b2NhdGlvbiByYXRoZXIgdGhhbiB3YXZpbmcgaXQgdGhyb3VnaC5cbiAqL1xuZXhwb3J0IHR5cGUgR2hDYWxsS2luZCA9IFwiYXBpLWdyYXBocWxcIiB8IFwiYXBpLXJlc3RcIiB8IFwic3ViLWNvbW1hbmRcIiB8IFwidW5rbm93blwiO1xuXG4vKipcbiAqIENsYXNzaWZ5IGFscmVhZHktZXh0cmFjdGVkIHBvc2l0aW9uYWwgdG9rZW5zIChJc3N1ZSAjMTU4OCkuXG4gKlxuICogRXhwb3NlZCBzbyBhIGNhbGxlciB0aGF0IGhhcyBwYXJzZWQgYXJndiBvbmNlIOKAlCBgY2xhc3NpZnlHaEFyZ3NgLCB3aGljaFxuICogYWxzbyBuZWVkcyB0aGUgc3ViLWNvbW1hbmQgdmVyYiDigJQgZG9lcyBub3QgcGFyc2UgaXQgYSBzZWNvbmQgdGltZSB0byBhc2tcbiAqIHRoZSBzYW1lIHF1ZXN0aW9uLlxuICpcbiAqIGBncmFwaHFsYCBjb3VudHMgb25seSBhcyB0aGUgcG9zaXRpb25hbCB0b2tlbiBpbW1lZGlhdGVseSBhZnRlciBgYXBpYCwgc28gYVxuICogUkVTVCBwYXRoIG9yIGEgZmxhZyB2YWx1ZSBjb250YWluaW5nIHRoZSB3b3JkIOKAlCBgZ2ggYXBpXG4gKiAvc2VhcmNoL2lzc3Vlcz9xPWdyYXBocWxgLCBgZ2ggYXBpIHJlcG9zL28vci9sYWJlbHMgLS1qcSBncmFwaHFsYCDigJQgaXMgUkVTVCxcbiAqIG5vdCBHcmFwaFFMLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2hDYWxsS2luZE9mKHBvc2l0aW9uYWxzOiByZWFkb25seSBzdHJpbmdbXSk6IEdoQ2FsbEtpbmQge1xuICBjb25zdCBoZWFkID0gcG9zaXRpb25hbHNbMF07XG4gIGlmIChoZWFkID09PSB1bmRlZmluZWQpIHJldHVybiBcInVua25vd25cIjtcbiAgaWYgKGhlYWQgIT09IFwiYXBpXCIpIHJldHVybiBcInN1Yi1jb21tYW5kXCI7XG4gIHJldHVybiBwb3NpdGlvbmFsc1sxXSA9PT0gXCJncmFwaHFsXCIgPyBcImFwaS1ncmFwaHFsXCIgOiBcImFwaS1yZXN0XCI7XG59XG5cbi8qKlxuICogQ2xhc3NpZnkgYSBgZ2hgIGFyZ3VtZW50IGxpc3QgYnkgd2hpY2ggQVBJIGJ1ZGdldCBpdCBzcGVuZHMgKElzc3VlICMxNTg4KS5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50IGxpc3QgcGFzc2VkIHRvIHRoZSBgZ2hgIGJpbmFyeS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsYXNzaWZ5R2hDYWxsKGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogR2hDYWxsS2luZCB7XG4gIHJldHVybiBnaENhbGxLaW5kT2YoZ2hQb3NpdGlvbmFsQXJncyhhcmdzKSk7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0F5QkMsR0FFRCxTQUFTLGVBQWUsUUFBUSxzQkFBc0I7QUFFdEQ7Ozs7Ozs7Ozs7OztDQVlDLEdBQ0QsT0FBTyxNQUFNLDZCQUFrRCxJQUFJLElBQUk7RUFDckU7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtDQUNELEVBQUU7QUFFSDs7Ozs7Ozs7Ozs7OztDQWFDLEdBQ0QsT0FBTyxNQUFNLDZCQUFrRCxJQUFJLElBQ2pFO0VBQUM7RUFBSztFQUFLO0VBQUs7RUFBSztFQUFLO0VBQUs7RUFBSztDQUFJLEVBQ3hDO0FBRUY7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0sMkJBQWdELElBQUksSUFBSTtLQUNoRTtLQUNBO09BQUk7R0FBMkIsQ0FBQyxHQUFHLENBQUMsQ0FBQyxTQUFXLENBQUMsQ0FBQyxFQUFFLFFBQVE7Q0FDaEUsRUFBRTtBQUVIOzs7Ozs7Ozs7OztDQVdDLEdBQ0QsT0FBTyxTQUFTLHdCQUF3QixLQUFhO0VBQ25ELElBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxNQUFNLE1BQU0sRUFBRSxJQUFLO0lBQ3JDLE1BQU0sU0FBUyxLQUFLLENBQUMsRUFBRTtJQUN2QixnRUFBZ0U7SUFDaEUsSUFBSSxDQUFDLDJCQUEyQixHQUFHLENBQUMsU0FBUztJQUM3QyxPQUFPLE1BQU0sTUFBTSxNQUFNLEdBQUc7RUFDOUI7RUFDQSxPQUFPO0FBQ1Q7QUFFQTs7Ozs7Ozs7Ozs7O0NBWUMsR0FDRCxPQUFPLFNBQVMsaUJBQWlCLElBQXVCO0VBQ3RELE1BQU0sYUFBYSxnQkFBZ0I7RUFDbkMsTUFBTSxjQUF3QixFQUFFO0VBQ2hDLElBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxXQUFXLE1BQU0sRUFBRSxJQUFLO0lBQzFDLE1BQU0sUUFBUSxVQUFVLENBQUMsRUFBRTtJQUMzQixJQUFJLFVBQVUsTUFBTTtNQUNsQixZQUFZLElBQUksSUFBSSxXQUFXLEtBQUssQ0FBQyxJQUFJO01BQ3pDO0lBQ0Y7SUFDQSxJQUFJLE1BQU0sVUFBVSxDQUFDLE9BQU87TUFDMUIsc0RBQXNEO01BQ3RELElBQUksQ0FBQyxNQUFNLFFBQVEsQ0FBQyxRQUFRLDJCQUEyQixHQUFHLENBQUMsUUFBUTtNQUNuRTtJQUNGO0lBQ0EsSUFBSSxNQUFNLFVBQVUsQ0FBQyxRQUFRLFVBQVUsS0FBSztNQUMxQyxJQUFJLHdCQUF3QixRQUFRO01BQ3BDO0lBQ0Y7SUFDQSxZQUFZLElBQUksQ0FBQztFQUNuQjtFQUNBLE9BQU87QUFDVDtBQUVBOzs7Ozs7Ozs7O0NBVUMsR0FDRCxPQUFPLFNBQVMsWUFBWSxJQUF1QjtFQUNqRCxNQUFNLGFBQWEsZ0JBQWdCO0VBQ25DLE1BQU0sUUFBa0IsRUFBRTtFQUMxQixJQUFLLElBQUksSUFBSSxHQUFHLElBQUksV0FBVyxNQUFNLEVBQUUsSUFBSztJQUMxQyxNQUFNLFFBQVEsVUFBVSxDQUFDLEVBQUU7SUFDM0IsSUFBSSxVQUFVLE1BQU07SUFDcEIsSUFBSSxNQUFNLFVBQVUsQ0FBQyxPQUFPO01BQzFCLE1BQU0sS0FBSyxNQUFNLE9BQU8sQ0FBQztNQUN6QixNQUFNLElBQUksQ0FBQyxLQUFLLElBQUksUUFBUSxNQUFNLEtBQUssQ0FBQyxHQUFHO01BQzNDLElBQUksS0FBSyxLQUFLLDJCQUEyQixHQUFHLENBQUMsUUFBUTtNQUNyRDtJQUNGO0lBQ0EsSUFBSSxNQUFNLFVBQVUsQ0FBQyxRQUFRLFVBQVUsS0FBSztNQUMxQyxNQUFNLElBQUksQ0FBQztNQUNYLElBQUksd0JBQXdCLFFBQVE7SUFDdEM7RUFDRjtFQUNBLE9BQU87QUFDVDtBQWdCQTs7Ozs7Ozs7Ozs7Q0FXQyxHQUNELE9BQU8sU0FBUyxhQUFhLFdBQThCO0VBQ3pELE1BQU0sT0FBTyxXQUFXLENBQUMsRUFBRTtFQUMzQixJQUFJLFNBQVMsV0FBVyxPQUFPO0VBQy9CLElBQUksU0FBUyxPQUFPLE9BQU87RUFDM0IsT0FBTyxXQUFXLENBQUMsRUFBRSxLQUFLLFlBQVksZ0JBQWdCO0FBQ3hEO0FBRUE7Ozs7Q0FJQyxHQUNELE9BQU8sU0FBUyxlQUFlLElBQXVCO0VBQ3BELE9BQU8sYUFBYSxpQkFBaUI7QUFDdkMifQ==
// denoCacheMetadata=4852758542157389877,4587936341146155662