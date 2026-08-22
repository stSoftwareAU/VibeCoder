# PR Summary — Issue #272

## Summary

Mermaid's `securityLevel` and the CDN script's SRI hash are the two things
standing between the Pages site and arbitrary JavaScript from a third-party
CDN. Both were asserted **only** on the source include:
`mermaid_security_level_test.ts` and `mermaid_cdn_integrity_test.ts` each read
`_includes/head-custom.html`. `runMermaidCheck` is syntax-only — it validates
diagram blocks in Markdown, not head configuration. `pages.yml` inspected the
artifact for structural files (`index.html`, `README.html`, `SECURITY.md`,
`docs/OVERVIEW.html`) and never looked at what those files execute.

Between the include and the served page sit Jekyll, a layout that may or may
not pull the include in, `strip_unpublished_links.rb` and
`normalise_heading_ids.rb`. A Mermaid bump that loosened `strict` or dropped
`integrity` in the built HTML would pass every test and every Pages step. The
value that matters is the one that ships.

New `worker/deno/lib/mermaid_built_output_check.ts` walks the built site and
asserts, per page:

- every page that initialises Mermaid carries a safe `securityLevel`
  (`strict` or `antiscript`); and
- every page that loads Mermaid from the CDN pins an exact `X.Y.Z` version and
  carries a valid SRI hash with `crossorigin`.

It reuses `parseMermaidCdnScript`, `isHardenedMermaidCdnScript`,
`extractMermaidSecurityLevel` and `isSafeSecurityLevel` rather than
reimplementing any of them, so the built-output rule and the source rule cannot
drift apart. Pages that mention Mermaid nowhere are out of scope; most of the
site is exactly that.

**Absent build output is SKIPPED, never PASSED.** The local quality gate does
not run Jekyll, and a check that silently passes when it inspected nothing is
how the regression window in #272 stayed open in the first place. Strict mode
promotes the skip to a failure, matching `pages-liquid`.

Wired in two places, per the issue's "quality gate **or** a Pages-build step" —
both, because they catch different things:

- **`quality.ts`** as the `mermaid built output` check. SKIPPED locally.
- **`pages.yml`**, via the new `check-mermaid-built-output` command, run against
  the real `_site` after the build and **before** `Upload artifact`, so an
  unhardened site fails the deploy rather than shipping. This adds a pinned
  `denoland/setup-deno` step (the same SHA the other seven workflows use);
  `docs/audits/dependency-inventory.md` is regenerated accordingly.

Closes #272.

## Evidence

**The check is proven against the real include, both ways.** Using the actual
`_includes/head-custom.html` as a built page:

```text
$ mod.ts check-mermaid-built-output --site-dir <site with the real include>
mermaid built output: PASSED (1 Mermaid page(s) hardened, of 1 scanned)

$ # same site, plus a copy with securityLevel: 'strict' → 'loose'
mermaid built output: FAILED (1 problem(s) across 2 Mermaid page(s) of 2 scanned)
  docs/OVERVIEW.html: Mermaid securityLevel is "loose" in the built page; must be "strict" or "antiscript"
$ echo $?
1
```

Exit 1 is what makes the workflow step block the deploy.

**Absent build output does not pass:**

```text
$ mod.ts check-mermaid-built-output --site-dir /nonexistent
mermaid built output: SKIPPED (no build at /nonexistent — run the Pages build first; strict mode fails on this)
```

**Unit suite:**

```text
$ deno test --allow-all tests/mermaid_built_output_check_test.ts
ok | 14 passed | 0 failed (68ms)
```

**Full quality gate** (`./quality.sh`, host run) — every check PASSED except the
known-environmental ones:

```text
  git ref chokepoint             PASSED     mermaid                        PASSED
  workflow hygiene               PASSED     mermaid built output           SKIPPED
  source targets                 PASSED     markdownlint                   PASSED
  deno lint                      PASSED     docs prompt versions           PASSED
  deno type check                PASSED     deno fmt                       PASSED
```

`mermaid built output` correctly reports SKIPPED with no local Jekyll build.
`deno tests` reports only the 11 pre-existing `setup.ps1` failures
(`NotFound: Failed to spawn 'pwsh'`, environmental — reproduces on the
milestone branch).

Three gate findings from the first run were fixed rather than waived:

| Finding | Fix |
| --- | --- |
| `deno fmt` FAILED | `deno fmt worker/deno/` |
| `mod - createDefaultRegistry has all built-in commands registered` (138 vs 139) | Count bumped with a comment naming this issue, matching the existing convention in that test |
| `supply-chain-gate: inventory-stale` | `mod.ts supply-chain-gate --write-inventory` — the new pinned `denoland/setup-deno` reference in `pages.yml` had to be recorded |

## Test plan

`worker/deno/tests/mermaid_built_output_check_test.ts` — 14 new cases:

| Group | Cases |
| --- | --- |
| Page classification | A page with neither the script nor `mermaid.initialize` is out of scope; either one alone brings it in scope |
| Per-page assertions | A hardened strict page is clean; a non-Mermaid page yields nothing; **`securityLevel` loosened in the built page is caught**; **a dropped SRI hash is caught**; a floating `mermaid@10` pin is caught; initialising with no verifiable script tag is reported; two problems on one page are reported separately |
| Whole-site scan | A hardened site passes and counts what it saw; one loosened page fails the whole site and is named in the output; **a missing build is SKIPPED, never PASSED**; a build with no HTML is SKIPPED |

The two bolded per-page cases are the regression the issue describes; the
bolded site case is the property that keeps the check honest.

Acceptance criteria from the issue:

- *Wire `mermaid_security_level` + `mermaid_cdn_integrity` into the quality gate
  (or a Pages-build step)* — both: the `mermaid built output` gate check and the
  `pages.yml` step, sharing one implementation.
- *Prefer asserting the built `_site` HTML, not only the include source* — the
  check reads `_site` exclusively; the existing source-include tests are left in
  place as the fast local signal.
