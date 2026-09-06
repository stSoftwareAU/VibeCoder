/**
 * Agent-side `git` guard shim (Issue #1284).
 *
 * The `gh` shim exists because the agent runs with unrestricted bash and an
 * inherited `GH_TOKEN`, so its own `gh` calls needed a boundary. The same
 * reasoning applies to `git` and had never been applied: with no shim,
 * `git commit -m "$GH_TOKEN" && git push` reached a public branch with no
 * control anywhere in the path — and unlike a comment, pushed history is
 * permanent and mirrored by every clone.
 *
 * A wrapper named `git` is written beside the `gh` one in the same per-spawn
 * directory, which is prepended to the child's `PATH`. Every message-carrying
 * `git` the agent runs therefore re-enters {@link runGitGuardCli}, which
 * applies {@link redactGitMessageArgs} and hands back the argv to run,
 * NUL-framed. The wrapper `exec`s *that* argv.
 *
 * ```mermaid
 * flowchart LR
 *     A["Agent Bash: git commit -m …"] --> S["PATH shim: git"]
 *     S -->|no message flag| R["real git binary"]
 *     S -->|message flag| G["git_guard_cli.ts<br/>redactGitMessageArgs"]
 *     G -- "allowed (redacted argv)" --> R
 *     G -- unscannable --> X["exit 1 + SECURITY log line"]
 * ```
 *
 * **The fast path is a superset, not a decision.** A `git` invocation with no
 * option containing an `m` or an `F`, and no long `--f…` option, carries no
 * message for the guard to redact, so it delegates straight to the real binary
 * rather than paying a Deno start-up for every `git status` the agent runs.
 * The test is on the whole option, not its first letter, precisely because
 * `git` clusters short options: `git commit -am "$GH_TOKEN"` is the same
 * exploit as `-m` and an anchored `-m*` test would have waved it through.
 * The patterns over-match by design (`--format`, `--amend` and `--force` all
 * reach the guard and come back untouched); under-matching would be a silent
 * bypass.
 *
 * **Not covered: the shim rides on the `gh` install.** The wrapper is written
 * by `installGhGuardShim`, so a run that resolves no `gh` binary — or an
 * operator who opts into an unguarded agent with
 * `VIBE_ALLOW_UNGUARDED_AGENT_GH=1` — gets no `git` wrapper either. Stated
 * rather than closed: the two shims share one directory, one PATH prefix and
 * one cleanup, and splitting the install would trade a real simplification for
 * a case in which the run is already knowingly unguarded.
 *
 * **Fails closed.** If the guard cannot be evaluated (missing Deno, missing
 * module, any non-refusal error) the wrapper refuses the call rather than
 * passing it through.
 *
 * **Residual risk, stated plainly.** Like its `gh` sibling this is a
 * containment boundary against a single injected command, not a sandbox: an
 * agent that invokes the real binary by absolute path, or edits `PATH`,
 * bypasses it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  GIT_GUARD_ALLOW_MARKER,
  GIT_GUARD_REFUSE_MARKER,
} from "./git_guard_cli.ts";
import { posixSingleQuote as shellQuote } from "./shell_quote.ts";

/** Absolute path of the guard entry point the `git` shim invokes. */
export function defaultGitGuardModulePath(): string {
  return decodeURIComponent(
    new URL("./git_guard_cli.ts", import.meta.url).pathname,
  );
}

/**
 * Render the `git` wrapper script.
 *
 * Exported for direct assertion of the fail-closed contract in tests.
 *
 * @param opts - Absolute binary/module paths plus the wrapper's own private
 *   directory, where it buffers the guard's NUL-framed verdict.
 * @returns The bash script body.
 */
export function renderGitShimScript(opts: {
  denoPath: string;
  guardModulePath: string;
  realGitPath: string;
  /** The wrapper's own private directory — where it buffers the verdict. */
  verdictDir: string;
}): string {
  // bash 3.2 (macOS) under `set -u` treats an empty array expansion as an
  // unbound variable, hence the ${arr[@]+"${arr[@]}"} guard.
  // `#!/bin/bash` rather than `/usr/bin/env bash`: a security wrapper must not
  // depend on the PATH of whoever invokes it.
  return `#!/bin/bash
# Vibe Coder git guard shim (Issue #1284) — generated per run; do not edit.
# Redacts secrets from the message arguments of every git command the agent
# runs, then delegates to the real binary. A pushed commit message is
# permanent public history.
set -uo pipefail

# Fast path: nothing that could carry a message, so there is nothing to
# redact. The patterns are a strict superset of what the guard rewrites —
# ANY option containing an "m" or an "F" (so a short cluster such as -am or
# -aF is caught, not just a leading -m), plus every long --f… form. They
# deliberately over-match (--format, --amend, --force all reach the guard and
# come back untouched); under-matching would be a silent bypass.
needs_guard=0
for arg in "$@"; do
  case "$arg" in
    -*m*|-*F*|--f*) needs_guard=1; break ;;
  esac
done
if [ "$needs_guard" -eq 0 ]; then
  exec ${shellQuote(opts.realGitPath)} "$@"
fi

# The guard returns the argv to run as NUL-terminated fields. A NUL cannot
# cross a command substitution, so the verdict is buffered in the wrapper's own
# private directory (created by the worker, removed when the run ends) instead.
GUARD_OUT=${shellQuote(opts.verdictDir)}/git-verdict.$$
if ! : > "$GUARD_OUT"; then
  printf '%s\\n' "[SECURITY] [GIT_GUARD_ERROR] could not create the guard's verdict file — refusing to run this git command." >&2
  exit 126
fi

status=0
${shellQuote(opts.denoPath)} run --quiet --no-config --no-lock --allow-read \\
  ${shellQuote(opts.guardModulePath)} -- "$@" >"$GUARD_OUT" || status=$?

fields=()
while IFS= read -r -d '' field; do
  fields+=("$field")
done < "$GUARD_OUT"
# Drop the buffered message immediately; the directory itself goes at run end.
: > "$GUARD_OUT"

verdict="\${fields[0]-}"

# Positive marker only: a missing/garbled verdict means the guard did not run,
# which is refused rather than waved through.
if [ "$status" -eq 0 ] && [ "$verdict" = "${GIT_GUARD_ALLOW_MARKER}" ]; then
  GIT_ARGS=()
  seen_verdict=0
  for field in \${fields[@]+"\${fields[@]}"}; do
    if [ "$seen_verdict" -eq 0 ]; then seen_verdict=1; continue; fi
    GIT_ARGS+=("$field")
  done
  # Redaction never adds or drops an argument, so a different count means the
  # rewrite is not the command the guard judged.
  if [ "\${#GIT_ARGS[@]}" -eq "$#" ]; then
    exec ${shellQuote(opts.realGitPath)} \${GIT_ARGS[@]+"\${GIT_ARGS[@]}"}
  fi
  printf '%s\\n' "[SECURITY] [GIT_GUARD_ERROR] the guard returned \${#GIT_ARGS[@]} arguments for a $# argument command — refusing to run it." >&2
  exit 126
fi

if [ "$verdict" != "${GIT_GUARD_REFUSE_MARKER}" ]; then
  printf '%s\\n' "[SECURITY] [GIT_GUARD_ERROR] guard could not evaluate this git command (exit $status) — refusing to run it." >&2
  if [ "$status" -eq 0 ]; then status=126; fi
fi
exit "$status"
`;
}
