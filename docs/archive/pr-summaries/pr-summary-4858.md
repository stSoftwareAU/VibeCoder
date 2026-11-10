## Summary

`findUnpinnedInstalls` now tokenises every tool's command (npm, npx, gem, cargo)
with one shared tokeniser instead of `command.split(/\s+/)`. A `${{ … }}`
expression and a quoted value stay one token, a backslash outside quotes
escapes the next character, and unquoted `#` comments and redirections are
never read as package arguments — including a bare operator whose target
follows on the next word (`>& out.log`, `2>& 1`, `<<< y`, `<> f`, `<<- EOF`)
and the attached forms (`>&2`, `2>&1`, `<&-`). Closes #4858 (which also owns
#4859).

Version bump: `VERSION` is not touched by this change.

## Spec

### Intent and Rationale

- npm and gem split on whitespace, so `foo@${{ env.V }}` yielded junk findings
  for `env.V` and `}}`, and `foo@1.2.3 # c` or `2>&1` yielded fake packages.
  Cargo already had a correct tokeniser; it is now the only one.
- The shared tokeniser read a backslash outside quotes as a literal character,
  so `--loglevel=\"warn\"` minted a `warn\` package, and an escaped-quote
  version inside a `sh -c` script split into made-up names (`\`, `2.5.0\`,
  `9.1.0\`).

### Essential Design Decisions

- One tokeniser (`shellTokens` → `shellArgumentTokens`) for all tools, rather
  than a second npm/gem parser. The cargo-only re-tokenise branch is removed.
- Collector logic is unchanged: an expression version is not a confirmed pin, so
  npm and gem still flag the real package once, with the whole expression as its
  version (documented: "exempt for cargo only"). No junk package names result.
- Quote-stripping leaves `${{ … }}` spans byte-for-byte, so evidence and version
  text keep the expression as written (this also fixes the same alteration for
  cargo).
- A redirection operator is matched as `(?:>>?|<<<|<<-|<>|<<?)&?`, so `<<<`,
  `<<-` and `<>` are operators in their own right and a trailing `&` (`>&`,
  `2>&`) is the operator, not its target. When the captured target is empty the
  operator is bare and the next token is skipped; attached targets (`>&2`,
  `2>&1`, `<&-`) keep the operator token out of the arguments.
- A backslash outside quotes escapes the next character in both the tokeniser
  (`[^\s"'$\\]` plus a `\\.` alternative) and the quote-stripper (`\\(.)`), so
  an escaped quote stays within its word instead of splitting it.

### Undiscoverable Facts

- None.

## Evidence

Backend only (no UI files). Probe before the fix, run on the base code:
`npm install -g foo@${{ env.V }}` gave `foo@${{`, `env.V`, `}}`;
`gem install foo -v ${{ env.V }}` the same three;
`npm install -g foo > /dev/null` gave `foo` and `>`; `foo@1.2.3 2>&1` gave
`2>&1`. After the fix each gives only the real finding, or none.

The backslash probes were run on the previous review head:
`npm install -g pnpm@9.1.0 --loglevel=\"warn\"` gave `warn\`;
`sh -c "gem install bundler -v \"2.5.0\" && bundle install"` gave `bundler`
and `2.5.0\`; `npm install -g \"pnpm@9.1.0\"` gave `\` and `pnpm` at version
`9.1.0\`. After the fix the flag case is clean, the gem script yields only
`bundler`, and the escaped npm argument yields one finding with no made-up
name.

## Test Plan

- Added five tests to `worker/deno/tests/ci_install_pin_scanner_test.ts`:
  expression stays one argument (npm and gem, including
  `${{ inputs.v || '1.2.3' }}` kept verbatim and a trailing comment); pinned
  install before a comment or redirection is clean (bare and attached, `2>&1`,
  `&>`, plus the bare operators `>& out.log`, `2>& 1`, `<<< y`, `<> f`,
  `<<- EOF` and the attached `>&2` / `<&-`); an unpinned package before a
  comment or redirection yields exactly one `foo` finding (the same
  bare-operator forms including `<<- EOF`, with targets chosen not to start
  with `/` so `SPEC_EXEMPT` cannot hide a skip failure);
  quoted values stay within one argument (`'foo bar'`, quoted `'#bar'`);
  a backslash escape outside quotes keeps one argument (`--loglevel=\"warn\"`
  is clean, and escaped quotes inside a `sh -c` script yield only the real
  package, not `\`, `2.5.0\` or `9.1.0\`).
- Red check: with the old `split(/\s+/)…map(unquote)` tokenisation restored, the
  first four new tests fail (and six existing cargo tests); with only the
  verbatim-expression quote handling reverted, the expression test fails at the
  `foo@${{ inputs.v || '1.2.3' }}` assertion; with `<<-` dropped from the
  redirection match, restoring the previous head's `(?:>>?|<<<|<>|<<?)&?`,
  the two redirection tests fail on the `<<- EOF` cases (the heredoc delimiter
  `EOF` is read back as a package); with the backslash-escape alternatives
  dropped (`|\\.` in the tokeniser, `|\\(.)` in the quote-stripper), the
  backslash test fails at the `--loglevel=\"warn\"` assertion (a `warn\`
  package is reported).
- No existing assertion was removed or edited.
- Ran `deno task test:unit` on `ci_install_pin_scanner_test.ts`,
  `issue_3642_ci_install_pin_test.ts`, `issue_4683_cargo_install_pins_test.ts`
  (79 passed) and on `checkov_workflow_test.ts`,
  `workflow_template_audit_conformance_test.ts`, `workflow_file_checks_test.ts`
  (66 passed). `./quality.sh` on the head: PASSED (checkov and config
  integration skipped by the gate itself).
- Docs: `docs/GITHUB-ACTIONS-AUDIT-SCAN.md` paragraph on exempt specs read
  through and updated.
- Callers of `findUnpinnedInstalls` checked: `workflow_file_checks.ts` and the
  audit template both consume its output only; their tests pass.
