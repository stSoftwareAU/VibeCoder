## Summary

Clarified that only the Claude CLI enforces `--disallowed-tools`; Codex and
Gemini receive the list as prompt text. Documented that provider selection does
not itself disable fallbacks or provide process, filesystem or network
isolation, and that Codex checkout restoration does not deny commands outside
the checkout. No provider behaviour changed. Closes #4856.

Version bump: none; this wording correction does not change the release version.

## Spec

### Intent and Rationale

- Corrected comments and operator/security documentation that could make
  provider-specific tool restrictions sound like a general execution boundary.
- Kept the existing provider eligibility, selection, fallback and container
  behaviour unchanged.

### Essential Design Decisions

- Claude's CLI enforces its `--disallowed-tools` argument; Codex and Gemini
  receive the list as prompt text.
- The Codex read-only guard restores the selected checkout. It does not deny
  Bash or reverse commands and builds outside that checkout.
- The read-only pre-PR verifier explicitly selects Claude and requests Claude
  config isolation; a non-Claude fallback is refused before spawn.

### Undiscoverable Facts

- None.

## Evidence

- `buildClaudeCliArgs` emits `--disallowed-tools`; `composeAgentPrompt` renders
  the list as one prompt sentence for Codex and Gemini.
- `runRetryLadder` can switch `agentProvider` after a model refusal.
  `runClaudeWithTimeoutBody` refuses a non-Claude provider when Claude config
  isolation is requested; `runPrePrVerifier` sets that isolation and pins Claude
  for its read-only mode.
- `assertRoleSupported` still makes the existing role decision. Its module
  header, JSDoc and Codex commentary now state the rule the function applies:
  only the Claude CLI (Claude and DeepSeek) enforces `--disallowed-tools`;
  Gemini is refused; Codex is admitted with `Bash` still not denied because
  delegation is off and the read-only checkout restoration applies.
  `docs/MANAGER-WORKER-CONTRACT.md` states the same for the external review
  gate.
- Backend/documentation-only change; no browser evidence applies.

## Test Plan

- No tests added or changed; this issue corrects comments and documentation.
- `deno fmt --check` on the five changed TypeScript files: passed.
- `./quality.sh < /dev/null`: passed. Deno tests, lint, type check, formatter,
  markdownlint and semgrep passed. Config integration was skipped; the gate
  reported `deno or .config.json not available` (Deno was available here, so
  `.config.json` was missing). Checkov was skipped because it was not available
  on `PATH` or through Docker/Podman.
- A direct `deno fmt --check` across the TypeScript and Markdown files reported
  document-wide Markdown reflow differences; those unrelated reflows were left
  out of scope. The repository formatter and markdownlint checks passed.

Not done: no provider selection, fallback, tool enforcement or container
behaviour changed. No test was added because no runtime behaviour changed.
Remaining check limitations: config integration and checkov did not run.
