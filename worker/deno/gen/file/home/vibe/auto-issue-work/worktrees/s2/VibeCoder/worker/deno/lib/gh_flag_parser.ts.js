/**
 * pflag-faithful argv normalisation for the `gh` guards (Issue #3867).
 *
 * `gh` is a Go program built on cobra + pflag, and pflag accepts a shorthand
 * flag's value **attached** to the flag as well as separated:
 * `-Rowner/repo` and `-R=owner/repo` mean exactly what `-R owner/repo` means.
 * The guards hand-rolled their own argv scanning and matched only the
 * separated form, so `gh issue comment 5 -Rattacker/evil` derived no repo at
 * all — the write-repo allowlist saw a cwd-scoped write and waved it through,
 * and `-ltop-priority` never reached the reserved-label denylist.
 *
 * Normalising once, here, keeps a single place that knows the pflag spelling
 * rules: every consumer then only has to match the separated form.
 *
 * ## Shorthand groups (Issue #1219, SEC-1219-01)
 *
 * The first version of this module only looked at `token[1]`, and only for
 * `R`, `l` and `X`. pflag also accepts a **group** of shorthands in one token,
 * where the first flag that takes a value swallows the remainder of the group
 * as that value — so `-iXDELETE` is `-i -X DELETE`. Verified against the
 * installed `gh`: `gh api -iXGET rate_limit` returns a 200 with response
 * headers (so `-i` was honoured *and* `X` took `GET`), and `-iXBOGUSMETHOD`
 * is rejected by the server with a 403 (so the bogus method really was sent).
 *
 * Because `-X` sat at index 2 rather than index 1, `normaliseGhArgs` passed
 * the token through untouched and `classifyGhApi` never saw a method: it fell
 * back to `GET`, decided the command was not a mutation at all, and
 * `gh api -iXDELETE repos/o/r/git/refs/heads/main` reached GitHub without
 * passing the audit journal, the write-repo allowlist or the issue-lifecycle
 * guard. The same gap covered `f`/`F`, which were absent from the expansion
 * set entirely: `gh api -XPATCH repos/o/r/issues/9 -fstate=closed` was
 * classified as a body `edit` — a verb allowed by default — rather than a
 * `close`, defeating the guard that exists to stop an agent closing its own
 * issue.
 *
 * ## Why the walk stops where it does
 *
 * A letter listed in {@link GH_VALUE_SHORTHANDS} ends the group: pflag would
 * hand it the rest of the token, so there is no hidden flag behind it. Only
 * letters treated as boolean are walked through. That ordering is what keeps
 * the rewrite honest in both directions — it cannot invent an `-X` out of the
 * middle of a `-q` jq expression (a false mutation), and it cannot miss one
 * hiding behind a boolean (a waved-through mutation). The set is not a perfect
 * model of `gh` — one letter is genuinely ambiguous across subcommands — so
 * see {@link GH_VALUE_SHORTHANDS} for which way that ambiguity is resolved and
 * why the residue is bounded.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ /**
 * Shorthand flags whose value the guards read, and which are therefore
 * rewritten into the separated form.
 *
 * `R` is `--repo` (write-repo allowlist), `l` is `--label`/`--add-label`
 * (reserved-label denylist), `X` is `--method` (`gh api` mutation detection)
 * and `f`/`F` are `--raw-field`/`--field` (the `state=closed` payload the
 * issue-lifecycle guard reads).
 */ const GH_GUARD_SHORTHANDS = new Set([
  "R",
  "l",
  "X",
  "f",
  "F"
]);
/**
 * Shorthand letters treated as taking a value, so the group walk stops there.
 *
 * Enumerated from `gh <subcommand> --help` across `api`, `issue`, `pr`,
 * `label`, `release`, `repo`, `run`, `search` and `workflow`. A letter is
 * listed when *any* subcommand gives it an argument, because this set is only
 * used to decide where a shorthand group ends — and treating a value-carrying
 * letter as boolean is the mistake that invents flags out of flag *values*.
 *
 * **`i` is the one deliberate omission, and it is not "boolean everywhere".**
 * `gh api -i` is `--include` (boolean) while `gh run watch -i` is
 * `--interval int` (a value). The two cannot both be honoured by a
 * subcommand-agnostic set, and `api` is the subcommand whose method the
 * mutation classifier reads — listing `i` would end the walk at `-iXDELETE`
 * and wave the mutation through, which is the bypass this module exists to
 * close. So `i` is walked past, and the residue is bounded: only a `gh run
 * watch` interval *value* whose text begins with `R`, `l`, `X`, `f` or `F`
 * misexpands, and `--interval` takes an int, so no such value parses.
 *
 * The failure direction of a wrong guess here is asymmetric, which is why the
 * omission is safe to make in this direction only: treating a value letter as
 * boolean can invent flag evidence and *refuse* a legitimate command
 * (fail-closed), whereas treating a boolean letter as value-carrying ends the
 * walk early and lets a real mutation past (fail-open).
 */ const GH_VALUE_SHORTHANDS = new Set("ABDFHLORSTXabcdefjklmnopqrstuw".split(""));
/**
 * Expand one shorthand token into the separated spellings the guards match.
 *
 * Walks the group left to right. Boolean letters are emitted as their own
 * tokens; the first value-carrying letter takes the remainder of the token as
 * its value (pflag strips one leading `=`). When that letter is not one the
 * guards read, the token is left byte-identical so downstream scanning
 * behaves exactly as it did before — rewriting `-q.foo` into `-q .foo` would
 * turn a jq expression into a positional the classifier would read as the
 * endpoint.
 *
 * @param token - A single argv token.
 * @returns The expanded tokens, or `undefined` when the token must be passed
 *   through verbatim (not a shorthand group, or nothing the guards read).
 */ function expandShorthandGroup(token) {
  if (token.length <= 2) return undefined;
  if (!token.startsWith("-") || token.startsWith("--")) return undefined;
  const booleans = [];
  for(let i = 1; i < token.length; i++){
    const letter = token[i];
    if (!GH_VALUE_SHORTHANDS.has(letter)) {
      // Boolean everywhere in `gh`; pflag moves on to the next letter.
      booleans.push(`-${letter}`);
      continue;
    }
    // This letter takes the rest of the token as its value.
    if (!GH_GUARD_SHORTHANDS.has(letter)) return undefined;
    const rest = token.slice(i + 1);
    // pflag: `-R=value` strips the `=`, `-Rvalue` takes the remainder verbatim.
    const value = rest.startsWith("=") ? rest.slice(1) : rest;
    // An empty remainder means the value is the next argv token, which is
    // already the separated form the guards match.
    return value === "" ? [
      ...booleans,
      `-${letter}`
    ] : [
      ...booleans,
      `-${letter}`,
      value
    ];
  }
  // An all-boolean group carries no value for a guard to read.
  return undefined;
}
/**
 * Rewrite a `gh` argument vector into the spellings the guards match.
 *
 * Attached shorthand values are expanded to their separated form, including
 * when the flag is buried in a shorthand group; every other token — long
 * flags, `--`, positionals, values — is passed through verbatim.
 *
 * @param args - Arguments as they would be passed to the `gh` binary.
 * @returns An equivalent vector using only separated shorthand values.
 */ export function normaliseGhArgs(args) {
  const out = [];
  for (const token of args){
    if (token === undefined) continue;
    const expanded = expandShorthandGroup(token);
    if (expanded) out.push(...expanded);
    else out.push(token);
  }
  return out;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naF9mbGFnX3BhcnNlci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIHBmbGFnLWZhaXRoZnVsIGFyZ3Ygbm9ybWFsaXNhdGlvbiBmb3IgdGhlIGBnaGAgZ3VhcmRzIChJc3N1ZSAjMzg2NykuXG4gKlxuICogYGdoYCBpcyBhIEdvIHByb2dyYW0gYnVpbHQgb24gY29icmEgKyBwZmxhZywgYW5kIHBmbGFnIGFjY2VwdHMgYSBzaG9ydGhhbmRcbiAqIGZsYWcncyB2YWx1ZSAqKmF0dGFjaGVkKiogdG8gdGhlIGZsYWcgYXMgd2VsbCBhcyBzZXBhcmF0ZWQ6XG4gKiBgLVJvd25lci9yZXBvYCBhbmQgYC1SPW93bmVyL3JlcG9gIG1lYW4gZXhhY3RseSB3aGF0IGAtUiBvd25lci9yZXBvYCBtZWFucy5cbiAqIFRoZSBndWFyZHMgaGFuZC1yb2xsZWQgdGhlaXIgb3duIGFyZ3Ygc2Nhbm5pbmcgYW5kIG1hdGNoZWQgb25seSB0aGVcbiAqIHNlcGFyYXRlZCBmb3JtLCBzbyBgZ2ggaXNzdWUgY29tbWVudCA1IC1SYXR0YWNrZXIvZXZpbGAgZGVyaXZlZCBubyByZXBvIGF0XG4gKiBhbGwg4oCUIHRoZSB3cml0ZS1yZXBvIGFsbG93bGlzdCBzYXcgYSBjd2Qtc2NvcGVkIHdyaXRlIGFuZCB3YXZlZCBpdCB0aHJvdWdoLFxuICogYW5kIGAtbHRvcC1wcmlvcml0eWAgbmV2ZXIgcmVhY2hlZCB0aGUgcmVzZXJ2ZWQtbGFiZWwgZGVueWxpc3QuXG4gKlxuICogTm9ybWFsaXNpbmcgb25jZSwgaGVyZSwga2VlcHMgYSBzaW5nbGUgcGxhY2UgdGhhdCBrbm93cyB0aGUgcGZsYWcgc3BlbGxpbmdcbiAqIHJ1bGVzOiBldmVyeSBjb25zdW1lciB0aGVuIG9ubHkgaGFzIHRvIG1hdGNoIHRoZSBzZXBhcmF0ZWQgZm9ybS5cbiAqXG4gKiAjIyBTaG9ydGhhbmQgZ3JvdXBzIChJc3N1ZSAjMTIxOSwgU0VDLTEyMTktMDEpXG4gKlxuICogVGhlIGZpcnN0IHZlcnNpb24gb2YgdGhpcyBtb2R1bGUgb25seSBsb29rZWQgYXQgYHRva2VuWzFdYCwgYW5kIG9ubHkgZm9yXG4gKiBgUmAsIGBsYCBhbmQgYFhgLiBwZmxhZyBhbHNvIGFjY2VwdHMgYSAqKmdyb3VwKiogb2Ygc2hvcnRoYW5kcyBpbiBvbmUgdG9rZW4sXG4gKiB3aGVyZSB0aGUgZmlyc3QgZmxhZyB0aGF0IHRha2VzIGEgdmFsdWUgc3dhbGxvd3MgdGhlIHJlbWFpbmRlciBvZiB0aGUgZ3JvdXBcbiAqIGFzIHRoYXQgdmFsdWUg4oCUIHNvIGAtaVhERUxFVEVgIGlzIGAtaSAtWCBERUxFVEVgLiBWZXJpZmllZCBhZ2FpbnN0IHRoZVxuICogaW5zdGFsbGVkIGBnaGA6IGBnaCBhcGkgLWlYR0VUIHJhdGVfbGltaXRgIHJldHVybnMgYSAyMDAgd2l0aCByZXNwb25zZVxuICogaGVhZGVycyAoc28gYC1pYCB3YXMgaG9ub3VyZWQgKmFuZCogYFhgIHRvb2sgYEdFVGApLCBhbmQgYC1pWEJPR1VTTUVUSE9EYFxuICogaXMgcmVqZWN0ZWQgYnkgdGhlIHNlcnZlciB3aXRoIGEgNDAzIChzbyB0aGUgYm9ndXMgbWV0aG9kIHJlYWxseSB3YXMgc2VudCkuXG4gKlxuICogQmVjYXVzZSBgLVhgIHNhdCBhdCBpbmRleCAyIHJhdGhlciB0aGFuIGluZGV4IDEsIGBub3JtYWxpc2VHaEFyZ3NgIHBhc3NlZFxuICogdGhlIHRva2VuIHRocm91Z2ggdW50b3VjaGVkIGFuZCBgY2xhc3NpZnlHaEFwaWAgbmV2ZXIgc2F3IGEgbWV0aG9kOiBpdCBmZWxsXG4gKiBiYWNrIHRvIGBHRVRgLCBkZWNpZGVkIHRoZSBjb21tYW5kIHdhcyBub3QgYSBtdXRhdGlvbiBhdCBhbGwsIGFuZFxuICogYGdoIGFwaSAtaVhERUxFVEUgcmVwb3Mvby9yL2dpdC9yZWZzL2hlYWRzL21haW5gIHJlYWNoZWQgR2l0SHViIHdpdGhvdXRcbiAqIHBhc3NpbmcgdGhlIGF1ZGl0IGpvdXJuYWwsIHRoZSB3cml0ZS1yZXBvIGFsbG93bGlzdCBvciB0aGUgaXNzdWUtbGlmZWN5Y2xlXG4gKiBndWFyZC4gVGhlIHNhbWUgZ2FwIGNvdmVyZWQgYGZgL2BGYCwgd2hpY2ggd2VyZSBhYnNlbnQgZnJvbSB0aGUgZXhwYW5zaW9uXG4gKiBzZXQgZW50aXJlbHk6IGBnaCBhcGkgLVhQQVRDSCByZXBvcy9vL3IvaXNzdWVzLzkgLWZzdGF0ZT1jbG9zZWRgIHdhc1xuICogY2xhc3NpZmllZCBhcyBhIGJvZHkgYGVkaXRgIOKAlCBhIHZlcmIgYWxsb3dlZCBieSBkZWZhdWx0IOKAlCByYXRoZXIgdGhhbiBhXG4gKiBgY2xvc2VgLCBkZWZlYXRpbmcgdGhlIGd1YXJkIHRoYXQgZXhpc3RzIHRvIHN0b3AgYW4gYWdlbnQgY2xvc2luZyBpdHMgb3duXG4gKiBpc3N1ZS5cbiAqXG4gKiAjIyBXaHkgdGhlIHdhbGsgc3RvcHMgd2hlcmUgaXQgZG9lc1xuICpcbiAqIEEgbGV0dGVyIGxpc3RlZCBpbiB7QGxpbmsgR0hfVkFMVUVfU0hPUlRIQU5EU30gZW5kcyB0aGUgZ3JvdXA6IHBmbGFnIHdvdWxkXG4gKiBoYW5kIGl0IHRoZSByZXN0IG9mIHRoZSB0b2tlbiwgc28gdGhlcmUgaXMgbm8gaGlkZGVuIGZsYWcgYmVoaW5kIGl0LiBPbmx5XG4gKiBsZXR0ZXJzIHRyZWF0ZWQgYXMgYm9vbGVhbiBhcmUgd2Fsa2VkIHRocm91Z2guIFRoYXQgb3JkZXJpbmcgaXMgd2hhdCBrZWVwc1xuICogdGhlIHJld3JpdGUgaG9uZXN0IGluIGJvdGggZGlyZWN0aW9ucyDigJQgaXQgY2Fubm90IGludmVudCBhbiBgLVhgIG91dCBvZiB0aGVcbiAqIG1pZGRsZSBvZiBhIGAtcWAganEgZXhwcmVzc2lvbiAoYSBmYWxzZSBtdXRhdGlvbiksIGFuZCBpdCBjYW5ub3QgbWlzcyBvbmVcbiAqIGhpZGluZyBiZWhpbmQgYSBib29sZWFuIChhIHdhdmVkLXRocm91Z2ggbXV0YXRpb24pLiBUaGUgc2V0IGlzIG5vdCBhIHBlcmZlY3RcbiAqIG1vZGVsIG9mIGBnaGAg4oCUIG9uZSBsZXR0ZXIgaXMgZ2VudWluZWx5IGFtYmlndW91cyBhY3Jvc3Mgc3ViY29tbWFuZHMg4oCUIHNvXG4gKiBzZWUge0BsaW5rIEdIX1ZBTFVFX1NIT1JUSEFORFN9IGZvciB3aGljaCB3YXkgdGhhdCBhbWJpZ3VpdHkgaXMgcmVzb2x2ZWQgYW5kXG4gKiB3aHkgdGhlIHJlc2lkdWUgaXMgYm91bmRlZC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG4vKipcbiAqIFNob3J0aGFuZCBmbGFncyB3aG9zZSB2YWx1ZSB0aGUgZ3VhcmRzIHJlYWQsIGFuZCB3aGljaCBhcmUgdGhlcmVmb3JlXG4gKiByZXdyaXR0ZW4gaW50byB0aGUgc2VwYXJhdGVkIGZvcm0uXG4gKlxuICogYFJgIGlzIGAtLXJlcG9gICh3cml0ZS1yZXBvIGFsbG93bGlzdCksIGBsYCBpcyBgLS1sYWJlbGAvYC0tYWRkLWxhYmVsYFxuICogKHJlc2VydmVkLWxhYmVsIGRlbnlsaXN0KSwgYFhgIGlzIGAtLW1ldGhvZGAgKGBnaCBhcGlgIG11dGF0aW9uIGRldGVjdGlvbilcbiAqIGFuZCBgZmAvYEZgIGFyZSBgLS1yYXctZmllbGRgL2AtLWZpZWxkYCAodGhlIGBzdGF0ZT1jbG9zZWRgIHBheWxvYWQgdGhlXG4gKiBpc3N1ZS1saWZlY3ljbGUgZ3VhcmQgcmVhZHMpLlxuICovXG5jb25zdCBHSF9HVUFSRF9TSE9SVEhBTkRTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiUlwiLFxuICBcImxcIixcbiAgXCJYXCIsXG4gIFwiZlwiLFxuICBcIkZcIixcbl0pO1xuXG4vKipcbiAqIFNob3J0aGFuZCBsZXR0ZXJzIHRyZWF0ZWQgYXMgdGFraW5nIGEgdmFsdWUsIHNvIHRoZSBncm91cCB3YWxrIHN0b3BzIHRoZXJlLlxuICpcbiAqIEVudW1lcmF0ZWQgZnJvbSBgZ2ggPHN1YmNvbW1hbmQ+IC0taGVscGAgYWNyb3NzIGBhcGlgLCBgaXNzdWVgLCBgcHJgLFxuICogYGxhYmVsYCwgYHJlbGVhc2VgLCBgcmVwb2AsIGBydW5gLCBgc2VhcmNoYCBhbmQgYHdvcmtmbG93YC4gQSBsZXR0ZXIgaXNcbiAqIGxpc3RlZCB3aGVuICphbnkqIHN1YmNvbW1hbmQgZ2l2ZXMgaXQgYW4gYXJndW1lbnQsIGJlY2F1c2UgdGhpcyBzZXQgaXMgb25seVxuICogdXNlZCB0byBkZWNpZGUgd2hlcmUgYSBzaG9ydGhhbmQgZ3JvdXAgZW5kcyDigJQgYW5kIHRyZWF0aW5nIGEgdmFsdWUtY2FycnlpbmdcbiAqIGxldHRlciBhcyBib29sZWFuIGlzIHRoZSBtaXN0YWtlIHRoYXQgaW52ZW50cyBmbGFncyBvdXQgb2YgZmxhZyAqdmFsdWVzKi5cbiAqXG4gKiAqKmBpYCBpcyB0aGUgb25lIGRlbGliZXJhdGUgb21pc3Npb24sIGFuZCBpdCBpcyBub3QgXCJib29sZWFuIGV2ZXJ5d2hlcmVcIi4qKlxuICogYGdoIGFwaSAtaWAgaXMgYC0taW5jbHVkZWAgKGJvb2xlYW4pIHdoaWxlIGBnaCBydW4gd2F0Y2ggLWlgIGlzXG4gKiBgLS1pbnRlcnZhbCBpbnRgIChhIHZhbHVlKS4gVGhlIHR3byBjYW5ub3QgYm90aCBiZSBob25vdXJlZCBieSBhXG4gKiBzdWJjb21tYW5kLWFnbm9zdGljIHNldCwgYW5kIGBhcGlgIGlzIHRoZSBzdWJjb21tYW5kIHdob3NlIG1ldGhvZCB0aGVcbiAqIG11dGF0aW9uIGNsYXNzaWZpZXIgcmVhZHMg4oCUIGxpc3RpbmcgYGlgIHdvdWxkIGVuZCB0aGUgd2FsayBhdCBgLWlYREVMRVRFYFxuICogYW5kIHdhdmUgdGhlIG11dGF0aW9uIHRocm91Z2gsIHdoaWNoIGlzIHRoZSBieXBhc3MgdGhpcyBtb2R1bGUgZXhpc3RzIHRvXG4gKiBjbG9zZS4gU28gYGlgIGlzIHdhbGtlZCBwYXN0LCBhbmQgdGhlIHJlc2lkdWUgaXMgYm91bmRlZDogb25seSBhIGBnaCBydW5cbiAqIHdhdGNoYCBpbnRlcnZhbCAqdmFsdWUqIHdob3NlIHRleHQgYmVnaW5zIHdpdGggYFJgLCBgbGAsIGBYYCwgYGZgIG9yIGBGYFxuICogbWlzZXhwYW5kcywgYW5kIGAtLWludGVydmFsYCB0YWtlcyBhbiBpbnQsIHNvIG5vIHN1Y2ggdmFsdWUgcGFyc2VzLlxuICpcbiAqIFRoZSBmYWlsdXJlIGRpcmVjdGlvbiBvZiBhIHdyb25nIGd1ZXNzIGhlcmUgaXMgYXN5bW1ldHJpYywgd2hpY2ggaXMgd2h5IHRoZVxuICogb21pc3Npb24gaXMgc2FmZSB0byBtYWtlIGluIHRoaXMgZGlyZWN0aW9uIG9ubHk6IHRyZWF0aW5nIGEgdmFsdWUgbGV0dGVyIGFzXG4gKiBib29sZWFuIGNhbiBpbnZlbnQgZmxhZyBldmlkZW5jZSBhbmQgKnJlZnVzZSogYSBsZWdpdGltYXRlIGNvbW1hbmRcbiAqIChmYWlsLWNsb3NlZCksIHdoZXJlYXMgdHJlYXRpbmcgYSBib29sZWFuIGxldHRlciBhcyB2YWx1ZS1jYXJyeWluZyBlbmRzIHRoZVxuICogd2FsayBlYXJseSBhbmQgbGV0cyBhIHJlYWwgbXV0YXRpb24gcGFzdCAoZmFpbC1vcGVuKS5cbiAqL1xuY29uc3QgR0hfVkFMVUVfU0hPUlRIQU5EUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoXG4gIFwiQUJERkhMT1JTVFhhYmNkZWZqa2xtbm9wcXJzdHV3XCIuc3BsaXQoXCJcIiksXG4pO1xuXG4vKiogQSBzaG9ydGhhbmQgZ3JvdXAgc3BsaXQgaW50byB0aGUgdG9rZW5zIHBmbGFnIHdvdWxkIHNlZS4gKi9cbnR5cGUgRXhwYW5kZWRHcm91cCA9IHN0cmluZ1tdO1xuXG4vKipcbiAqIEV4cGFuZCBvbmUgc2hvcnRoYW5kIHRva2VuIGludG8gdGhlIHNlcGFyYXRlZCBzcGVsbGluZ3MgdGhlIGd1YXJkcyBtYXRjaC5cbiAqXG4gKiBXYWxrcyB0aGUgZ3JvdXAgbGVmdCB0byByaWdodC4gQm9vbGVhbiBsZXR0ZXJzIGFyZSBlbWl0dGVkIGFzIHRoZWlyIG93blxuICogdG9rZW5zOyB0aGUgZmlyc3QgdmFsdWUtY2FycnlpbmcgbGV0dGVyIHRha2VzIHRoZSByZW1haW5kZXIgb2YgdGhlIHRva2VuIGFzXG4gKiBpdHMgdmFsdWUgKHBmbGFnIHN0cmlwcyBvbmUgbGVhZGluZyBgPWApLiBXaGVuIHRoYXQgbGV0dGVyIGlzIG5vdCBvbmUgdGhlXG4gKiBndWFyZHMgcmVhZCwgdGhlIHRva2VuIGlzIGxlZnQgYnl0ZS1pZGVudGljYWwgc28gZG93bnN0cmVhbSBzY2FubmluZ1xuICogYmVoYXZlcyBleGFjdGx5IGFzIGl0IGRpZCBiZWZvcmUg4oCUIHJld3JpdGluZyBgLXEuZm9vYCBpbnRvIGAtcSAuZm9vYCB3b3VsZFxuICogdHVybiBhIGpxIGV4cHJlc3Npb24gaW50byBhIHBvc2l0aW9uYWwgdGhlIGNsYXNzaWZpZXIgd291bGQgcmVhZCBhcyB0aGVcbiAqIGVuZHBvaW50LlxuICpcbiAqIEBwYXJhbSB0b2tlbiAtIEEgc2luZ2xlIGFyZ3YgdG9rZW4uXG4gKiBAcmV0dXJucyBUaGUgZXhwYW5kZWQgdG9rZW5zLCBvciBgdW5kZWZpbmVkYCB3aGVuIHRoZSB0b2tlbiBtdXN0IGJlIHBhc3NlZFxuICogICB0aHJvdWdoIHZlcmJhdGltIChub3QgYSBzaG9ydGhhbmQgZ3JvdXAsIG9yIG5vdGhpbmcgdGhlIGd1YXJkcyByZWFkKS5cbiAqL1xuZnVuY3Rpb24gZXhwYW5kU2hvcnRoYW5kR3JvdXAodG9rZW46IHN0cmluZyk6IEV4cGFuZGVkR3JvdXAgfCB1bmRlZmluZWQge1xuICBpZiAodG9rZW4ubGVuZ3RoIDw9IDIpIHJldHVybiB1bmRlZmluZWQ7XG4gIGlmICghdG9rZW4uc3RhcnRzV2l0aChcIi1cIikgfHwgdG9rZW4uc3RhcnRzV2l0aChcIi0tXCIpKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gIGNvbnN0IGJvb2xlYW5zOiBzdHJpbmdbXSA9IFtdO1xuICBmb3IgKGxldCBpID0gMTsgaSA8IHRva2VuLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgbGV0dGVyID0gdG9rZW5baV0hO1xuICAgIGlmICghR0hfVkFMVUVfU0hPUlRIQU5EUy5oYXMobGV0dGVyKSkge1xuICAgICAgLy8gQm9vbGVhbiBldmVyeXdoZXJlIGluIGBnaGA7IHBmbGFnIG1vdmVzIG9uIHRvIHRoZSBuZXh0IGxldHRlci5cbiAgICAgIGJvb2xlYW5zLnB1c2goYC0ke2xldHRlcn1gKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICAvLyBUaGlzIGxldHRlciB0YWtlcyB0aGUgcmVzdCBvZiB0aGUgdG9rZW4gYXMgaXRzIHZhbHVlLlxuICAgIGlmICghR0hfR1VBUkRfU0hPUlRIQU5EUy5oYXMobGV0dGVyKSkgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICBjb25zdCByZXN0ID0gdG9rZW4uc2xpY2UoaSArIDEpO1xuICAgIC8vIHBmbGFnOiBgLVI9dmFsdWVgIHN0cmlwcyB0aGUgYD1gLCBgLVJ2YWx1ZWAgdGFrZXMgdGhlIHJlbWFpbmRlciB2ZXJiYXRpbS5cbiAgICBjb25zdCB2YWx1ZSA9IHJlc3Quc3RhcnRzV2l0aChcIj1cIikgPyByZXN0LnNsaWNlKDEpIDogcmVzdDtcbiAgICAvLyBBbiBlbXB0eSByZW1haW5kZXIgbWVhbnMgdGhlIHZhbHVlIGlzIHRoZSBuZXh0IGFyZ3YgdG9rZW4sIHdoaWNoIGlzXG4gICAgLy8gYWxyZWFkeSB0aGUgc2VwYXJhdGVkIGZvcm0gdGhlIGd1YXJkcyBtYXRjaC5cbiAgICByZXR1cm4gdmFsdWUgPT09IFwiXCJcbiAgICAgID8gWy4uLmJvb2xlYW5zLCBgLSR7bGV0dGVyfWBdXG4gICAgICA6IFsuLi5ib29sZWFucywgYC0ke2xldHRlcn1gLCB2YWx1ZV07XG4gIH1cbiAgLy8gQW4gYWxsLWJvb2xlYW4gZ3JvdXAgY2FycmllcyBubyB2YWx1ZSBmb3IgYSBndWFyZCB0byByZWFkLlxuICByZXR1cm4gdW5kZWZpbmVkO1xufVxuXG4vKipcbiAqIFJld3JpdGUgYSBgZ2hgIGFyZ3VtZW50IHZlY3RvciBpbnRvIHRoZSBzcGVsbGluZ3MgdGhlIGd1YXJkcyBtYXRjaC5cbiAqXG4gKiBBdHRhY2hlZCBzaG9ydGhhbmQgdmFsdWVzIGFyZSBleHBhbmRlZCB0byB0aGVpciBzZXBhcmF0ZWQgZm9ybSwgaW5jbHVkaW5nXG4gKiB3aGVuIHRoZSBmbGFnIGlzIGJ1cmllZCBpbiBhIHNob3J0aGFuZCBncm91cDsgZXZlcnkgb3RoZXIgdG9rZW4g4oCUIGxvbmdcbiAqIGZsYWdzLCBgLS1gLCBwb3NpdGlvbmFscywgdmFsdWVzIOKAlCBpcyBwYXNzZWQgdGhyb3VnaCB2ZXJiYXRpbS5cbiAqXG4gKiBAcGFyYW0gYXJncyAtIEFyZ3VtZW50cyBhcyB0aGV5IHdvdWxkIGJlIHBhc3NlZCB0byB0aGUgYGdoYCBiaW5hcnkuXG4gKiBAcmV0dXJucyBBbiBlcXVpdmFsZW50IHZlY3RvciB1c2luZyBvbmx5IHNlcGFyYXRlZCBzaG9ydGhhbmQgdmFsdWVzLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbm9ybWFsaXNlR2hBcmdzKGFyZ3M6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBvdXQ6IHN0cmluZ1tdID0gW107XG4gIGZvciAoY29uc3QgdG9rZW4gb2YgYXJncykge1xuICAgIGlmICh0b2tlbiA9PT0gdW5kZWZpbmVkKSBjb250aW51ZTtcbiAgICBjb25zdCBleHBhbmRlZCA9IGV4cGFuZFNob3J0aGFuZEdyb3VwKHRva2VuKTtcbiAgICBpZiAoZXhwYW5kZWQpIG91dC5wdXNoKC4uLmV4cGFuZGVkKTtcbiAgICBlbHNlIG91dC5wdXNoKHRva2VuKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FnREMsR0FFRDs7Ozs7Ozs7Q0FRQyxHQUNELE1BQU0sc0JBQTJDLElBQUksSUFBSTtFQUN2RDtFQUNBO0VBQ0E7RUFDQTtFQUNBO0NBQ0Q7QUFFRDs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBd0JDLEdBQ0QsTUFBTSxzQkFBMkMsSUFBSSxJQUNuRCxpQ0FBaUMsS0FBSyxDQUFDO0FBTXpDOzs7Ozs7Ozs7Ozs7OztDQWNDLEdBQ0QsU0FBUyxxQkFBcUIsS0FBYTtFQUN6QyxJQUFJLE1BQU0sTUFBTSxJQUFJLEdBQUcsT0FBTztFQUM5QixJQUFJLENBQUMsTUFBTSxVQUFVLENBQUMsUUFBUSxNQUFNLFVBQVUsQ0FBQyxPQUFPLE9BQU87RUFFN0QsTUFBTSxXQUFxQixFQUFFO0VBQzdCLElBQUssSUFBSSxJQUFJLEdBQUcsSUFBSSxNQUFNLE1BQU0sRUFBRSxJQUFLO0lBQ3JDLE1BQU0sU0FBUyxLQUFLLENBQUMsRUFBRTtJQUN2QixJQUFJLENBQUMsb0JBQW9CLEdBQUcsQ0FBQyxTQUFTO01BQ3BDLGlFQUFpRTtNQUNqRSxTQUFTLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRSxRQUFRO01BQzFCO0lBQ0Y7SUFDQSx3REFBd0Q7SUFDeEQsSUFBSSxDQUFDLG9CQUFvQixHQUFHLENBQUMsU0FBUyxPQUFPO0lBQzdDLE1BQU0sT0FBTyxNQUFNLEtBQUssQ0FBQyxJQUFJO0lBQzdCLDRFQUE0RTtJQUM1RSxNQUFNLFFBQVEsS0FBSyxVQUFVLENBQUMsT0FBTyxLQUFLLEtBQUssQ0FBQyxLQUFLO0lBQ3JELHNFQUFzRTtJQUN0RSwrQ0FBK0M7SUFDL0MsT0FBTyxVQUFVLEtBQ2I7U0FBSTtNQUFVLENBQUMsQ0FBQyxFQUFFLFFBQVE7S0FBQyxHQUMzQjtTQUFJO01BQVUsQ0FBQyxDQUFDLEVBQUUsUUFBUTtNQUFFO0tBQU07RUFDeEM7RUFDQSw2REFBNkQ7RUFDN0QsT0FBTztBQUNUO0FBRUE7Ozs7Ozs7OztDQVNDLEdBQ0QsT0FBTyxTQUFTLGdCQUFnQixJQUF1QjtFQUNyRCxNQUFNLE1BQWdCLEVBQUU7RUFDeEIsS0FBSyxNQUFNLFNBQVMsS0FBTTtJQUN4QixJQUFJLFVBQVUsV0FBVztJQUN6QixNQUFNLFdBQVcscUJBQXFCO0lBQ3RDLElBQUksVUFBVSxJQUFJLElBQUksSUFBSTtTQUNyQixJQUFJLElBQUksQ0FBQztFQUNoQjtFQUNBLE9BQU87QUFDVCJ9
// denoCacheMetadata=1011064312571379535,12324594823934524668