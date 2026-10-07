# PR Summary — Issue #3323

## Summary

Closes #3323

The pre-commit safety gate's `id_rsa` entry in `FORBIDDEN_STAGED_PATTERNS` —
`/(^|\/)id_rsa(\..*)?$/` — backtracked quadratically on a long staged path
holding many `id_rsa.` prefixes followed by a line break: without an `m`/`s`
flag, `.*` stops at `\n` and `$` then fails to match, so the engine rescans
from every `id_rsa.` start. It is now `/(^|\/)id_rsa(\.[^/\n]*)?$/`, bounding
the optional suffix to a single path segment and line.

## Spec

### Intent and Rationale

`classifyStagedPath` runs every staged path through `FORBIDDEN_STAGED_PATTERNS`.
The old `id_rsa` entry's suffix group, `(\..*)?`, let `.*` try every length
from longest to shortest at each `id_rsa.` start before giving up when `$`
could not match past an embedded `\n`. A hostile or accidental staged path
repeating `/id_rsa.` many times, ending in a line break, could stall a commit.

### Essential Design Decisions

- **Bounded `[^/\n]*` suffix, not a final-segment string compare.** This is
  the smallest change: it keeps the regex list uniform with its neighbours
  (the dotenv, config and key-material entries all stay single regex
  literals) rather than introducing a different kind of check just for this
  one pattern.
- **Still catches `id_rsa.pub` and `id_rsa.old`.** Both end their final
  segment in a run of non-slash, non-newline characters, which `[^/\n]*`
  matches in full before `$`.
- **A final segment containing a newline is no longer matched by this
  entry.** A staged path from `git -z` can legally contain `\n`, but
  `id_rsa.` immediately followed by a newline in the final segment is not a
  real key filename. The old pattern also failed to match that case — `.`
  already excludes `\n` and `$` has no `m` flag — so behaviour on such paths
  is unchanged by this fix.

### Undiscoverable Facts

- The issue records the unfixed cost: roughly 10 ms at 10,000 characters and
  roughly 151 ms at 40,000 characters.

## Evidence

Full diff:

```diff
--- a/worker/deno/lib/pre_commit_safety.ts
+++ b/worker/deno/lib/pre_commit_safety.ts
@@ -53,7 +53,8 @@ export const FORBIDDEN_STAGED_PATTERNS: readonly RegExp[] = [
   // final path segment so nested paths (`certs/server.pem`) are caught too.
   /(^|\/)[^/]+\.(pem|key|p12|pfx)$/,
-  /(^|\/)id_rsa(\..*)?$/,
+  // Suffix bounded to one segment and line; `\..*` backtracked quadratically (Issue #3323).
+  /(^|\/)id_rsa(\.[^/\n]*)?$/,
   /(^|\/)credentials\.json$/,
   /(^|\/)service-account[^/]*\.json$/,
 ];
--- a/worker/deno/tests/pre_commit_safety_test.ts
+++ b/worker/deno/tests/pre_commit_safety_test.ts
@@ -203,6 +203,18 @@ Deno.test(
   },
 );

+Deno.test(
+  "classifyStagedPath - id_rsa pattern stays linear on hostile input (Issue #3323)",
+  () => {
+    assertLinearGrowth(
+      "classifyStagedPath, repeated /id_rsa. prefixes before a line break",
+      (chars) => "/id_rsa.".repeat(chars) + "\nx",
+      classifyStagedPath,
+      { baseChars: 10_000 },
+    );
+  },
+);
+
 Deno.test("classifyStagedPath - hidden top-level file is a violation", () => {
   assertEquals(classifyStagedPath(".aws"), "violation");
   assertEquals(classifyStagedPath(".npmrc"), "violation");
```

- **Red on base.** The new growth test, run alone against the unfixed
  pattern (`deno task test:unit tests/pre_commit_safety_test.ts < /dev/null`):
  `AssertionError: classifyStagedPath, repeated /id_rsa. prefixes before a
  line break: 80002 chars took 267 ms but 320002 chars (4.0x) took 4244 ms,
  over the 2134 ms a linear rule allows — the rule is super-linear`.
- **Green after the fix:** `ok | 56 passed | 0 failed` for the whole file.
- **Docs sweep:** grepped `id_rsa`, `FORBIDDEN_STAGED_PATTERNS` and the old pattern text `id_rsa(\.`. No doc quotes the regex. `CODING-STANDARDS.md:1182`, `SECURITY.md:681` and `prompts/coding_guidelines/prompt.md:1042` list `id_rsa` / `id_rsa.*` as glob-style names — still true, since `id_rsa` and every `id_rsa.<suffix>` final segment remain violations. `prompts/coding_guidelines/prompt.md:1014` (`.ssh/id_rsa` example) and `prompts/security_scan/prompt.md:920` (`id_rsa` in a list) are unaffected. The `FORBIDDEN_STAGED_PATTERNS` doc comment in `worker/deno/lib/pre_commit_safety.ts` still holds.
- **Cited issues:**
  - `#3311`: Pre-commit safety gate classifies a dotenv, .config*.json or
    .secrets/ file in a subdirectory as safe
  - `#3316`: Pre-commit safety gate: `/.*\.secret\.json$/` backtracks
    quadratically on long staged paths
  - `#3323`: Pre-commit safety gate: the id_rsa entry in
    `FORBIDDEN_STAGED_PATTERNS` backtracks quadratically on long staged paths
    containing a line break
  - The pre-existing `#3660` reference in the module doc comment is untouched
    by this diff.

## Test Plan

- `worker/deno/tests/pre_commit_safety_test.ts`:
  - new: "classifyStagedPath - id_rsa pattern stays linear on hostile input
    (Issue #3323)";
  - red against the old pattern (quoted under Evidence), green after the fix;
  - existing `id_rsa` cases still pass: `id_rsa`, `id_rsa.pub`, `keys/id_rsa`
    and `.ssh/id_rsa` are still classified as violations, and
    `src/id_rsa_helper.ts` stays safe.
- **Branch outcomes:** none added. The change replaces one regex literal and
  adds no condition.
- No assertion removed.

## Pre-PR Security Self-Check

- [x] Input validation: `classifyStagedPath` still receives the same staged
      path strings from `git diff --cached --name-only -z`; no new input
      surface.
- [x] Least privilege: the fix narrows the regex's suffix match (excludes
      `/` and `\n`); it does not widen what is classified as safe.
- [x] Secrets: none staged. The change itself is a regex literal and a test.
- [x] Injection surface: no new shell, SQL, filesystem or HTTP calls.
- [x] Authorisation: N/A — no change to who may commit or what is exempted.
- [x] Denial of service: this is the fix for the reported quadratic-time
      regex; the new growth test guards against regression.
