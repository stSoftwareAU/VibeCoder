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
 *     G -- "stdin message consumed<br/>(argv carries it; git runs with stdin closed)" --> R
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
 * **One subcommand is matched by name, because options cannot see it.**
 * `git commit-tree <tree>` reads its message from stdin when neither `-m` nor
 * `-F` is given, so no option in that argv betrays a message and the lexical
 * test alone waved it through into permanent history (Issue #1969). The bare
 * word `commit-tree` therefore joins the patterns, and the guard refuses the
 * flagless spelling — naming `-m`/`-F`, which it does scan.
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
 */ import { GIT_GUARD_ALLOW_MARKER, GIT_GUARD_ALLOW_STDIN_MARKER, GIT_GUARD_REFUSE_MARKER } from "./git_guard_cli.ts";
import { posixSingleQuote as shellQuote } from "./shell_quote.ts";
import { resolveGuardModulePath } from "./guard_module_path.ts";
/**
 * The shim's own header words — how a process tells the shim is the `git` on
 * its `PATH` (Issue #2669).
 */ export const GIT_GUARD_SHIM_MARKER = "Vibe Coder git guard shim";
/** Absolute path of the guard entry point the `git` shim invokes. */ export function defaultGitGuardModulePath() {
  // Issue #1444: resolved from the read-only checkout for the same reason as
  // its `gh` twin — see `guard_module_path.ts`.
  return resolveGuardModulePath("git_guard_cli.ts", import.meta.url);
}
/**
 * Render the `git` wrapper script.
 *
 * Exported for direct assertion of the fail-closed contract in tests.
 *
 * @param opts - Absolute binary/module paths plus the wrapper's own private
 *   directory, where it buffers the guard's NUL-framed verdict.
 * @returns The bash script body.
 */ export function renderGitShimScript(opts) {
  // Quoted once: the wrapper names the real binary three times, and an inline
  // call in the template would be wrapped mid-command by the formatter.
  const realGit = shellQuote(opts.realGitPath);
  // bash 3.2 (macOS) under `set -u` treats an empty array expansion as an
  // unbound variable, hence the ${arr[@]+"${arr[@]}"} guard.
  // `#!/bin/bash` rather than `/usr/bin/env bash`: a security wrapper must not
  // depend on the PATH of whoever invokes it.
  return `#!/bin/bash
# ${GIT_GUARD_SHIM_MARKER} (Issue #1284) — generated per run; do not edit.
# Redacts secrets from the message arguments of every git command the agent
# runs, then delegates to the real binary. A pushed commit message is
# permanent public history.
set -uo pipefail

# Issue #1448 — the guard child reads its compiled modules back from this
# cache, so it is the run's choice (read-only where one exists), not the
# caller's.
export DENO_DIR=${shellQuote(opts.denoDir)}

# Fast path: nothing that could carry a message, so there is nothing to
# redact. The patterns are a strict superset of what the guard rewrites —
# ANY option containing an "m" or an "F" (so a short cluster such as -am or
# -aF is caught, not just a leading -m), plus every long --f… form. They
# deliberately over-match (--format, --amend, --force all reach the guard and
# come back untouched); under-matching would be a silent bypass.
# "commit-tree" is matched as a bare word because that subcommand takes its
# message from stdin with no option at all (Issue #1969): a purely lexical
# option test cannot see it, so every commit-tree reaches the guard.
needs_guard=0
for arg in "$@"; do
  case "$arg" in
    -*m*|-*F*|--f*|commit-tree) needs_guard=1; break ;;
  esac
done
if [ "$needs_guard" -eq 0 ]; then
  exec ${realGit} "$@"
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

# Positive markers only: a missing/garbled verdict means the guard did not run,
# which is refused rather than waved through. The second marker (Issue #1953)
# says the guard consumed a stdin message (git commit -F -) and put it in the
# argv, so the real git is run with its stdin closed: a stream reads once, and
# a second reader would see an empty or partial message.
allowed=0
case "$verdict" in
  ${GIT_GUARD_ALLOW_MARKER}|${GIT_GUARD_ALLOW_STDIN_MARKER}) allowed=1 ;;
esac
if [ "$status" -eq 0 ] && [ "$allowed" -eq 1 ]; then
  GIT_ARGS=()
  seen_verdict=0
  for field in \${fields[@]+"\${fields[@]}"}; do
    if [ "$seen_verdict" -eq 0 ]; then seen_verdict=1; continue; fi
    GIT_ARGS+=("$field")
  done
  # Redaction never adds or drops an argument, so a different count means the
  # rewrite is not the command the guard judged.
  if [ "\${#GIT_ARGS[@]}" -eq "$#" ]; then
    if [ "$verdict" = "${GIT_GUARD_ALLOW_STDIN_MARKER}" ]; then
      exec ${realGit} \${GIT_ARGS[@]+"\${GIT_ARGS[@]}"} </dev/null
    fi
    exec ${realGit} \${GIT_ARGS[@]+"\${GIT_ARGS[@]}"}
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRfZ3VhcmRfc2hpbS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEFnZW50LXNpZGUgYGdpdGAgZ3VhcmQgc2hpbSAoSXNzdWUgIzEyODQpLlxuICpcbiAqIFRoZSBgZ2hgIHNoaW0gZXhpc3RzIGJlY2F1c2UgdGhlIGFnZW50IHJ1bnMgd2l0aCB1bnJlc3RyaWN0ZWQgYmFzaCBhbmQgYW5cbiAqIGluaGVyaXRlZCBgR0hfVE9LRU5gLCBzbyBpdHMgb3duIGBnaGAgY2FsbHMgbmVlZGVkIGEgYm91bmRhcnkuIFRoZSBzYW1lXG4gKiByZWFzb25pbmcgYXBwbGllcyB0byBgZ2l0YCBhbmQgaGFkIG5ldmVyIGJlZW4gYXBwbGllZDogd2l0aCBubyBzaGltLFxuICogYGdpdCBjb21taXQgLW0gXCIkR0hfVE9LRU5cIiAmJiBnaXQgcHVzaGAgcmVhY2hlZCBhIHB1YmxpYyBicmFuY2ggd2l0aCBub1xuICogY29udHJvbCBhbnl3aGVyZSBpbiB0aGUgcGF0aCDigJQgYW5kIHVubGlrZSBhIGNvbW1lbnQsIHB1c2hlZCBoaXN0b3J5IGlzXG4gKiBwZXJtYW5lbnQgYW5kIG1pcnJvcmVkIGJ5IGV2ZXJ5IGNsb25lLlxuICpcbiAqIEEgd3JhcHBlciBuYW1lZCBgZ2l0YCBpcyB3cml0dGVuIGJlc2lkZSB0aGUgYGdoYCBvbmUgaW4gdGhlIHNhbWUgcGVyLXNwYXduXG4gKiBkaXJlY3RvcnksIHdoaWNoIGlzIHByZXBlbmRlZCB0byB0aGUgY2hpbGQncyBgUEFUSGAuIEV2ZXJ5IG1lc3NhZ2UtY2FycnlpbmdcbiAqIGBnaXRgIHRoZSBhZ2VudCBydW5zIHRoZXJlZm9yZSByZS1lbnRlcnMge0BsaW5rIHJ1bkdpdEd1YXJkQ2xpfSwgd2hpY2hcbiAqIGFwcGxpZXMge0BsaW5rIHJlZGFjdEdpdE1lc3NhZ2VBcmdzfSBhbmQgaGFuZHMgYmFjayB0aGUgYXJndiB0byBydW4sXG4gKiBOVUwtZnJhbWVkLiBUaGUgd3JhcHBlciBgZXhlY2BzICp0aGF0KiBhcmd2LlxuICpcbiAqIGBgYG1lcm1haWRcbiAqIGZsb3djaGFydCBMUlxuICogICAgIEFbXCJBZ2VudCBCYXNoOiBnaXQgY29tbWl0IC1tIOKAplwiXSAtLT4gU1tcIlBBVEggc2hpbTogZ2l0XCJdXG4gKiAgICAgUyAtLT58bm8gbWVzc2FnZSBmbGFnfCBSW1wicmVhbCBnaXQgYmluYXJ5XCJdXG4gKiAgICAgUyAtLT58bWVzc2FnZSBmbGFnfCBHW1wiZ2l0X2d1YXJkX2NsaS50czxici8+cmVkYWN0R2l0TWVzc2FnZUFyZ3NcIl1cbiAqICAgICBHIC0tIFwiYWxsb3dlZCAocmVkYWN0ZWQgYXJndilcIiAtLT4gUlxuICogICAgIEcgLS0gXCJzdGRpbiBtZXNzYWdlIGNvbnN1bWVkPGJyLz4oYXJndiBjYXJyaWVzIGl0OyBnaXQgcnVucyB3aXRoIHN0ZGluIGNsb3NlZClcIiAtLT4gUlxuICogICAgIEcgLS0gdW5zY2FubmFibGUgLS0+IFhbXCJleGl0IDEgKyBTRUNVUklUWSBsb2cgbGluZVwiXVxuICogYGBgXG4gKlxuICogKipUaGUgZmFzdCBwYXRoIGlzIGEgc3VwZXJzZXQsIG5vdCBhIGRlY2lzaW9uLioqIEEgYGdpdGAgaW52b2NhdGlvbiB3aXRoIG5vXG4gKiBvcHRpb24gY29udGFpbmluZyBhbiBgbWAgb3IgYW4gYEZgLCBhbmQgbm8gbG9uZyBgLS1m4oCmYCBvcHRpb24sIGNhcnJpZXMgbm9cbiAqIG1lc3NhZ2UgZm9yIHRoZSBndWFyZCB0byByZWRhY3QsIHNvIGl0IGRlbGVnYXRlcyBzdHJhaWdodCB0byB0aGUgcmVhbCBiaW5hcnlcbiAqIHJhdGhlciB0aGFuIHBheWluZyBhIERlbm8gc3RhcnQtdXAgZm9yIGV2ZXJ5IGBnaXQgc3RhdHVzYCB0aGUgYWdlbnQgcnVucy5cbiAqIFRoZSB0ZXN0IGlzIG9uIHRoZSB3aG9sZSBvcHRpb24sIG5vdCBpdHMgZmlyc3QgbGV0dGVyLCBwcmVjaXNlbHkgYmVjYXVzZVxuICogYGdpdGAgY2x1c3RlcnMgc2hvcnQgb3B0aW9uczogYGdpdCBjb21taXQgLWFtIFwiJEdIX1RPS0VOXCJgIGlzIHRoZSBzYW1lXG4gKiBleHBsb2l0IGFzIGAtbWAgYW5kIGFuIGFuY2hvcmVkIGAtbSpgIHRlc3Qgd291bGQgaGF2ZSB3YXZlZCBpdCB0aHJvdWdoLlxuICogVGhlIHBhdHRlcm5zIG92ZXItbWF0Y2ggYnkgZGVzaWduIChgLS1mb3JtYXRgLCBgLS1hbWVuZGAgYW5kIGAtLWZvcmNlYCBhbGxcbiAqIHJlYWNoIHRoZSBndWFyZCBhbmQgY29tZSBiYWNrIHVudG91Y2hlZCk7IHVuZGVyLW1hdGNoaW5nIHdvdWxkIGJlIGEgc2lsZW50XG4gKiBieXBhc3MuXG4gKlxuICogKipPbmUgc3ViY29tbWFuZCBpcyBtYXRjaGVkIGJ5IG5hbWUsIGJlY2F1c2Ugb3B0aW9ucyBjYW5ub3Qgc2VlIGl0LioqXG4gKiBgZ2l0IGNvbW1pdC10cmVlIDx0cmVlPmAgcmVhZHMgaXRzIG1lc3NhZ2UgZnJvbSBzdGRpbiB3aGVuIG5laXRoZXIgYC1tYCBub3JcbiAqIGAtRmAgaXMgZ2l2ZW4sIHNvIG5vIG9wdGlvbiBpbiB0aGF0IGFyZ3YgYmV0cmF5cyBhIG1lc3NhZ2UgYW5kIHRoZSBsZXhpY2FsXG4gKiB0ZXN0IGFsb25lIHdhdmVkIGl0IHRocm91Z2ggaW50byBwZXJtYW5lbnQgaGlzdG9yeSAoSXNzdWUgIzE5NjkpLiBUaGUgYmFyZVxuICogd29yZCBgY29tbWl0LXRyZWVgIHRoZXJlZm9yZSBqb2lucyB0aGUgcGF0dGVybnMsIGFuZCB0aGUgZ3VhcmQgcmVmdXNlcyB0aGVcbiAqIGZsYWdsZXNzIHNwZWxsaW5nIOKAlCBuYW1pbmcgYC1tYC9gLUZgLCB3aGljaCBpdCBkb2VzIHNjYW4uXG4gKlxuICogKipOb3QgY292ZXJlZDogdGhlIHNoaW0gcmlkZXMgb24gdGhlIGBnaGAgaW5zdGFsbC4qKiBUaGUgd3JhcHBlciBpcyB3cml0dGVuXG4gKiBieSBgaW5zdGFsbEdoR3VhcmRTaGltYCwgc28gYSBydW4gdGhhdCByZXNvbHZlcyBubyBgZ2hgIGJpbmFyeSDigJQgb3IgYW5cbiAqIG9wZXJhdG9yIHdobyBvcHRzIGludG8gYW4gdW5ndWFyZGVkIGFnZW50IHdpdGhcbiAqIGBWSUJFX0FMTE9XX1VOR1VBUkRFRF9BR0VOVF9HSD0xYCDigJQgZ2V0cyBubyBgZ2l0YCB3cmFwcGVyIGVpdGhlci4gU3RhdGVkXG4gKiByYXRoZXIgdGhhbiBjbG9zZWQ6IHRoZSB0d28gc2hpbXMgc2hhcmUgb25lIGRpcmVjdG9yeSwgb25lIFBBVEggcHJlZml4IGFuZFxuICogb25lIGNsZWFudXAsIGFuZCBzcGxpdHRpbmcgdGhlIGluc3RhbGwgd291bGQgdHJhZGUgYSByZWFsIHNpbXBsaWZpY2F0aW9uIGZvclxuICogYSBjYXNlIGluIHdoaWNoIHRoZSBydW4gaXMgYWxyZWFkeSBrbm93aW5nbHkgdW5ndWFyZGVkLlxuICpcbiAqICoqRmFpbHMgY2xvc2VkLioqIElmIHRoZSBndWFyZCBjYW5ub3QgYmUgZXZhbHVhdGVkIChtaXNzaW5nIERlbm8sIG1pc3NpbmdcbiAqIG1vZHVsZSwgYW55IG5vbi1yZWZ1c2FsIGVycm9yKSB0aGUgd3JhcHBlciByZWZ1c2VzIHRoZSBjYWxsIHJhdGhlciB0aGFuXG4gKiBwYXNzaW5nIGl0IHRocm91Z2guXG4gKlxuICogKipSZXNpZHVhbCByaXNrLCBzdGF0ZWQgcGxhaW5seS4qKiBMaWtlIGl0cyBgZ2hgIHNpYmxpbmcgdGhpcyBpcyBhXG4gKiBjb250YWlubWVudCBib3VuZGFyeSBhZ2FpbnN0IGEgc2luZ2xlIGluamVjdGVkIGNvbW1hbmQsIG5vdCBhIHNhbmRib3g6IGFuXG4gKiBhZ2VudCB0aGF0IGludm9rZXMgdGhlIHJlYWwgYmluYXJ5IGJ5IGFic29sdXRlIHBhdGgsIG9yIGVkaXRzIGBQQVRIYCxcbiAqIGJ5cGFzc2VzIGl0LlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbmltcG9ydCB7XG4gIEdJVF9HVUFSRF9BTExPV19NQVJLRVIsXG4gIEdJVF9HVUFSRF9BTExPV19TVERJTl9NQVJLRVIsXG4gIEdJVF9HVUFSRF9SRUZVU0VfTUFSS0VSLFxufSBmcm9tIFwiLi9naXRfZ3VhcmRfY2xpLnRzXCI7XG5pbXBvcnQgeyBwb3NpeFNpbmdsZVF1b3RlIGFzIHNoZWxsUXVvdGUgfSBmcm9tIFwiLi9zaGVsbF9xdW90ZS50c1wiO1xuaW1wb3J0IHsgcmVzb2x2ZUd1YXJkTW9kdWxlUGF0aCB9IGZyb20gXCIuL2d1YXJkX21vZHVsZV9wYXRoLnRzXCI7XG5cbi8qKlxuICogVGhlIHNoaW0ncyBvd24gaGVhZGVyIHdvcmRzIOKAlCBob3cgYSBwcm9jZXNzIHRlbGxzIHRoZSBzaGltIGlzIHRoZSBgZ2l0YCBvblxuICogaXRzIGBQQVRIYCAoSXNzdWUgIzI2NjkpLlxuICovXG5leHBvcnQgY29uc3QgR0lUX0dVQVJEX1NISU1fTUFSS0VSID0gXCJWaWJlIENvZGVyIGdpdCBndWFyZCBzaGltXCI7XG5cbi8qKiBBYnNvbHV0ZSBwYXRoIG9mIHRoZSBndWFyZCBlbnRyeSBwb2ludCB0aGUgYGdpdGAgc2hpbSBpbnZva2VzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHRHaXRHdWFyZE1vZHVsZVBhdGgoKTogc3RyaW5nIHtcbiAgLy8gSXNzdWUgIzE0NDQ6IHJlc29sdmVkIGZyb20gdGhlIHJlYWQtb25seSBjaGVja291dCBmb3IgdGhlIHNhbWUgcmVhc29uIGFzXG4gIC8vIGl0cyBgZ2hgIHR3aW4g4oCUIHNlZSBgZ3VhcmRfbW9kdWxlX3BhdGgudHNgLlxuICByZXR1cm4gcmVzb2x2ZUd1YXJkTW9kdWxlUGF0aChcImdpdF9ndWFyZF9jbGkudHNcIiwgaW1wb3J0Lm1ldGEudXJsKTtcbn1cblxuLyoqXG4gKiBSZW5kZXIgdGhlIGBnaXRgIHdyYXBwZXIgc2NyaXB0LlxuICpcbiAqIEV4cG9ydGVkIGZvciBkaXJlY3QgYXNzZXJ0aW9uIG9mIHRoZSBmYWlsLWNsb3NlZCBjb250cmFjdCBpbiB0ZXN0cy5cbiAqXG4gKiBAcGFyYW0gb3B0cyAtIEFic29sdXRlIGJpbmFyeS9tb2R1bGUgcGF0aHMgcGx1cyB0aGUgd3JhcHBlcidzIG93biBwcml2YXRlXG4gKiAgIGRpcmVjdG9yeSwgd2hlcmUgaXQgYnVmZmVycyB0aGUgZ3VhcmQncyBOVUwtZnJhbWVkIHZlcmRpY3QuXG4gKiBAcmV0dXJucyBUaGUgYmFzaCBzY3JpcHQgYm9keS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHJlbmRlckdpdFNoaW1TY3JpcHQob3B0czoge1xuICBkZW5vUGF0aDogc3RyaW5nO1xuICBndWFyZE1vZHVsZVBhdGg6IHN0cmluZztcbiAgcmVhbEdpdFBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSB3cmFwcGVyJ3Mgb3duIHByaXZhdGUgZGlyZWN0b3J5IOKAlCB3aGVyZSBpdCBidWZmZXJzIHRoZSB2ZXJkaWN0LiAqL1xuICB2ZXJkaWN0RGlyOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBUaGUgYERFTk9fRElSYCB0aGUgZ3VhcmQgY2hpbGQgcnVucyB3aXRoIChJc3N1ZSAjMTQ0OCkg4oCUIHBpbm5lZCBzbyB0aGVcbiAgICogYWdlbnQncyBlbnZpcm9ubWVudCBjYW5ub3QgY2hvb3NlIGl0OyBzZWUgYGd1YXJkX2Rlbm9fZGlyLnRzYC5cbiAgICovXG4gIGRlbm9EaXI6IHN0cmluZztcbn0pOiBzdHJpbmcge1xuICAvLyBRdW90ZWQgb25jZTogdGhlIHdyYXBwZXIgbmFtZXMgdGhlIHJlYWwgYmluYXJ5IHRocmVlIHRpbWVzLCBhbmQgYW4gaW5saW5lXG4gIC8vIGNhbGwgaW4gdGhlIHRlbXBsYXRlIHdvdWxkIGJlIHdyYXBwZWQgbWlkLWNvbW1hbmQgYnkgdGhlIGZvcm1hdHRlci5cbiAgY29uc3QgcmVhbEdpdCA9IHNoZWxsUXVvdGUob3B0cy5yZWFsR2l0UGF0aCk7XG5cbiAgLy8gYmFzaCAzLjIgKG1hY09TKSB1bmRlciBgc2V0IC11YCB0cmVhdHMgYW4gZW1wdHkgYXJyYXkgZXhwYW5zaW9uIGFzIGFuXG4gIC8vIHVuYm91bmQgdmFyaWFibGUsIGhlbmNlIHRoZSAke2FycltAXStcIiR7YXJyW0BdfVwifSBndWFyZC5cbiAgLy8gYCMhL2Jpbi9iYXNoYCByYXRoZXIgdGhhbiBgL3Vzci9iaW4vZW52IGJhc2hgOiBhIHNlY3VyaXR5IHdyYXBwZXIgbXVzdCBub3RcbiAgLy8gZGVwZW5kIG9uIHRoZSBQQVRIIG9mIHdob2V2ZXIgaW52b2tlcyBpdC5cbiAgcmV0dXJuIGAjIS9iaW4vYmFzaFxuIyAke0dJVF9HVUFSRF9TSElNX01BUktFUn0gKElzc3VlICMxMjg0KSDigJQgZ2VuZXJhdGVkIHBlciBydW47IGRvIG5vdCBlZGl0LlxuIyBSZWRhY3RzIHNlY3JldHMgZnJvbSB0aGUgbWVzc2FnZSBhcmd1bWVudHMgb2YgZXZlcnkgZ2l0IGNvbW1hbmQgdGhlIGFnZW50XG4jIHJ1bnMsIHRoZW4gZGVsZWdhdGVzIHRvIHRoZSByZWFsIGJpbmFyeS4gQSBwdXNoZWQgY29tbWl0IG1lc3NhZ2UgaXNcbiMgcGVybWFuZW50IHB1YmxpYyBoaXN0b3J5Llxuc2V0IC11byBwaXBlZmFpbFxuXG4jIElzc3VlICMxNDQ4IOKAlCB0aGUgZ3VhcmQgY2hpbGQgcmVhZHMgaXRzIGNvbXBpbGVkIG1vZHVsZXMgYmFjayBmcm9tIHRoaXNcbiMgY2FjaGUsIHNvIGl0IGlzIHRoZSBydW4ncyBjaG9pY2UgKHJlYWQtb25seSB3aGVyZSBvbmUgZXhpc3RzKSwgbm90IHRoZVxuIyBjYWxsZXIncy5cbmV4cG9ydCBERU5PX0RJUj0ke3NoZWxsUXVvdGUob3B0cy5kZW5vRGlyKX1cblxuIyBGYXN0IHBhdGg6IG5vdGhpbmcgdGhhdCBjb3VsZCBjYXJyeSBhIG1lc3NhZ2UsIHNvIHRoZXJlIGlzIG5vdGhpbmcgdG9cbiMgcmVkYWN0LiBUaGUgcGF0dGVybnMgYXJlIGEgc3RyaWN0IHN1cGVyc2V0IG9mIHdoYXQgdGhlIGd1YXJkIHJld3JpdGVzIOKAlFxuIyBBTlkgb3B0aW9uIGNvbnRhaW5pbmcgYW4gXCJtXCIgb3IgYW4gXCJGXCIgKHNvIGEgc2hvcnQgY2x1c3RlciBzdWNoIGFzIC1hbSBvclxuIyAtYUYgaXMgY2F1Z2h0LCBub3QganVzdCBhIGxlYWRpbmcgLW0pLCBwbHVzIGV2ZXJ5IGxvbmcgLS1m4oCmIGZvcm0uIFRoZXlcbiMgZGVsaWJlcmF0ZWx5IG92ZXItbWF0Y2ggKC0tZm9ybWF0LCAtLWFtZW5kLCAtLWZvcmNlIGFsbCByZWFjaCB0aGUgZ3VhcmQgYW5kXG4jIGNvbWUgYmFjayB1bnRvdWNoZWQpOyB1bmRlci1tYXRjaGluZyB3b3VsZCBiZSBhIHNpbGVudCBieXBhc3MuXG4jIFwiY29tbWl0LXRyZWVcIiBpcyBtYXRjaGVkIGFzIGEgYmFyZSB3b3JkIGJlY2F1c2UgdGhhdCBzdWJjb21tYW5kIHRha2VzIGl0c1xuIyBtZXNzYWdlIGZyb20gc3RkaW4gd2l0aCBubyBvcHRpb24gYXQgYWxsIChJc3N1ZSAjMTk2OSk6IGEgcHVyZWx5IGxleGljYWxcbiMgb3B0aW9uIHRlc3QgY2Fubm90IHNlZSBpdCwgc28gZXZlcnkgY29tbWl0LXRyZWUgcmVhY2hlcyB0aGUgZ3VhcmQuXG5uZWVkc19ndWFyZD0wXG5mb3IgYXJnIGluIFwiJEBcIjsgZG9cbiAgY2FzZSBcIiRhcmdcIiBpblxuICAgIC0qbSp8LSpGKnwtLWYqfGNvbW1pdC10cmVlKSBuZWVkc19ndWFyZD0xOyBicmVhayA7O1xuICBlc2FjXG5kb25lXG5pZiBbIFwiJG5lZWRzX2d1YXJkXCIgLWVxIDAgXTsgdGhlblxuICBleGVjICR7cmVhbEdpdH0gXCIkQFwiXG5maVxuXG4jIFRoZSBndWFyZCByZXR1cm5zIHRoZSBhcmd2IHRvIHJ1biBhcyBOVUwtdGVybWluYXRlZCBmaWVsZHMuIEEgTlVMIGNhbm5vdFxuIyBjcm9zcyBhIGNvbW1hbmQgc3Vic3RpdHV0aW9uLCBzbyB0aGUgdmVyZGljdCBpcyBidWZmZXJlZCBpbiB0aGUgd3JhcHBlcidzIG93blxuIyBwcml2YXRlIGRpcmVjdG9yeSAoY3JlYXRlZCBieSB0aGUgd29ya2VyLCByZW1vdmVkIHdoZW4gdGhlIHJ1biBlbmRzKSBpbnN0ZWFkLlxuR1VBUkRfT1VUPSR7c2hlbGxRdW90ZShvcHRzLnZlcmRpY3REaXIpfS9naXQtdmVyZGljdC4kJFxuaWYgISA6ID4gXCIkR1VBUkRfT1VUXCI7IHRoZW5cbiAgcHJpbnRmICclc1xcXFxuJyBcIltTRUNVUklUWV0gW0dJVF9HVUFSRF9FUlJPUl0gY291bGQgbm90IGNyZWF0ZSB0aGUgZ3VhcmQncyB2ZXJkaWN0IGZpbGUg4oCUIHJlZnVzaW5nIHRvIHJ1biB0aGlzIGdpdCBjb21tYW5kLlwiID4mMlxuICBleGl0IDEyNlxuZmlcblxuc3RhdHVzPTBcbiR7c2hlbGxRdW90ZShvcHRzLmRlbm9QYXRoKX0gcnVuIC0tcXVpZXQgLS1uby1jb25maWcgLS1uby1sb2NrIC0tYWxsb3ctcmVhZCBcXFxcXG4gICR7c2hlbGxRdW90ZShvcHRzLmd1YXJkTW9kdWxlUGF0aCl9IC0tIFwiJEBcIiA+XCIkR1VBUkRfT1VUXCIgfHwgc3RhdHVzPSQ/XG5cbmZpZWxkcz0oKVxud2hpbGUgSUZTPSByZWFkIC1yIC1kICcnIGZpZWxkOyBkb1xuICBmaWVsZHMrPShcIiRmaWVsZFwiKVxuZG9uZSA8IFwiJEdVQVJEX09VVFwiXG4jIERyb3AgdGhlIGJ1ZmZlcmVkIG1lc3NhZ2UgaW1tZWRpYXRlbHk7IHRoZSBkaXJlY3RvcnkgaXRzZWxmIGdvZXMgYXQgcnVuIGVuZC5cbjogPiBcIiRHVUFSRF9PVVRcIlxuXG52ZXJkaWN0PVwiXFwke2ZpZWxkc1swXS19XCJcblxuIyBQb3NpdGl2ZSBtYXJrZXJzIG9ubHk6IGEgbWlzc2luZy9nYXJibGVkIHZlcmRpY3QgbWVhbnMgdGhlIGd1YXJkIGRpZCBub3QgcnVuLFxuIyB3aGljaCBpcyByZWZ1c2VkIHJhdGhlciB0aGFuIHdhdmVkIHRocm91Z2guIFRoZSBzZWNvbmQgbWFya2VyIChJc3N1ZSAjMTk1MylcbiMgc2F5cyB0aGUgZ3VhcmQgY29uc3VtZWQgYSBzdGRpbiBtZXNzYWdlIChnaXQgY29tbWl0IC1GIC0pIGFuZCBwdXQgaXQgaW4gdGhlXG4jIGFyZ3YsIHNvIHRoZSByZWFsIGdpdCBpcyBydW4gd2l0aCBpdHMgc3RkaW4gY2xvc2VkOiBhIHN0cmVhbSByZWFkcyBvbmNlLCBhbmRcbiMgYSBzZWNvbmQgcmVhZGVyIHdvdWxkIHNlZSBhbiBlbXB0eSBvciBwYXJ0aWFsIG1lc3NhZ2UuXG5hbGxvd2VkPTBcbmNhc2UgXCIkdmVyZGljdFwiIGluXG4gICR7R0lUX0dVQVJEX0FMTE9XX01BUktFUn18JHtHSVRfR1VBUkRfQUxMT1dfU1RESU5fTUFSS0VSfSkgYWxsb3dlZD0xIDs7XG5lc2FjXG5pZiBbIFwiJHN0YXR1c1wiIC1lcSAwIF0gJiYgWyBcIiRhbGxvd2VkXCIgLWVxIDEgXTsgdGhlblxuICBHSVRfQVJHUz0oKVxuICBzZWVuX3ZlcmRpY3Q9MFxuICBmb3IgZmllbGQgaW4gXFwke2ZpZWxkc1tAXStcIlxcJHtmaWVsZHNbQF19XCJ9OyBkb1xuICAgIGlmIFsgXCIkc2Vlbl92ZXJkaWN0XCIgLWVxIDAgXTsgdGhlbiBzZWVuX3ZlcmRpY3Q9MTsgY29udGludWU7IGZpXG4gICAgR0lUX0FSR1MrPShcIiRmaWVsZFwiKVxuICBkb25lXG4gICMgUmVkYWN0aW9uIG5ldmVyIGFkZHMgb3IgZHJvcHMgYW4gYXJndW1lbnQsIHNvIGEgZGlmZmVyZW50IGNvdW50IG1lYW5zIHRoZVxuICAjIHJld3JpdGUgaXMgbm90IHRoZSBjb21tYW5kIHRoZSBndWFyZCBqdWRnZWQuXG4gIGlmIFsgXCJcXCR7I0dJVF9BUkdTW0BdfVwiIC1lcSBcIiQjXCIgXTsgdGhlblxuICAgIGlmIFsgXCIkdmVyZGljdFwiID0gXCIke0dJVF9HVUFSRF9BTExPV19TVERJTl9NQVJLRVJ9XCIgXTsgdGhlblxuICAgICAgZXhlYyAke3JlYWxHaXR9IFxcJHtHSVRfQVJHU1tAXStcIlxcJHtHSVRfQVJHU1tAXX1cIn0gPC9kZXYvbnVsbFxuICAgIGZpXG4gICAgZXhlYyAke3JlYWxHaXR9IFxcJHtHSVRfQVJHU1tAXStcIlxcJHtHSVRfQVJHU1tAXX1cIn1cbiAgZmlcbiAgcHJpbnRmICclc1xcXFxuJyBcIltTRUNVUklUWV0gW0dJVF9HVUFSRF9FUlJPUl0gdGhlIGd1YXJkIHJldHVybmVkIFxcJHsjR0lUX0FSR1NbQF19IGFyZ3VtZW50cyBmb3IgYSAkIyBhcmd1bWVudCBjb21tYW5kIOKAlCByZWZ1c2luZyB0byBydW4gaXQuXCIgPiYyXG4gIGV4aXQgMTI2XG5maVxuXG5pZiBbIFwiJHZlcmRpY3RcIiAhPSBcIiR7R0lUX0dVQVJEX1JFRlVTRV9NQVJLRVJ9XCIgXTsgdGhlblxuICBwcmludGYgJyVzXFxcXG4nIFwiW1NFQ1VSSVRZXSBbR0lUX0dVQVJEX0VSUk9SXSBndWFyZCBjb3VsZCBub3QgZXZhbHVhdGUgdGhpcyBnaXQgY29tbWFuZCAoZXhpdCAkc3RhdHVzKSDigJQgcmVmdXNpbmcgdG8gcnVuIGl0LlwiID4mMlxuICBpZiBbIFwiJHN0YXR1c1wiIC1lcSAwIF07IHRoZW4gc3RhdHVzPTEyNjsgZmlcbmZpXG5leGl0IFwiJHN0YXR1c1wiXG5gO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQThEQyxHQUVELFNBQ0Usc0JBQXNCLEVBQ3RCLDRCQUE0QixFQUM1Qix1QkFBdUIsUUFDbEIscUJBQXFCO0FBQzVCLFNBQVMsb0JBQW9CLFVBQVUsUUFBUSxtQkFBbUI7QUFDbEUsU0FBUyxzQkFBc0IsUUFBUSx5QkFBeUI7QUFFaEU7OztDQUdDLEdBQ0QsT0FBTyxNQUFNLHdCQUF3Qiw0QkFBNEI7QUFFakUsbUVBQW1FLEdBQ25FLE9BQU8sU0FBUztFQUNkLDJFQUEyRTtFQUMzRSw4Q0FBOEM7RUFDOUMsT0FBTyx1QkFBdUIsb0JBQW9CLFlBQVksR0FBRztBQUNuRTtBQUVBOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxTQUFTLG9CQUFvQixJQVduQztFQUNDLDRFQUE0RTtFQUM1RSxzRUFBc0U7RUFDdEUsTUFBTSxVQUFVLFdBQVcsS0FBSyxXQUFXO0VBRTNDLHdFQUF3RTtFQUN4RSwyREFBMkQ7RUFDM0QsNkVBQTZFO0VBQzdFLDRDQUE0QztFQUM1QyxPQUFPLENBQUM7RUFDUixFQUFFLHNCQUFzQjs7Ozs7Ozs7O2dCQVNWLEVBQUUsV0FBVyxLQUFLLE9BQU8sRUFBRTs7Ozs7Ozs7Ozs7Ozs7Ozs7O09Ba0JwQyxFQUFFLFFBQVE7Ozs7OztVQU1QLEVBQUUsV0FBVyxLQUFLLFVBQVUsRUFBRTs7Ozs7OztBQU94QyxFQUFFLFdBQVcsS0FBSyxRQUFRLEVBQUU7RUFDMUIsRUFBRSxXQUFXLEtBQUssZUFBZSxFQUFFOzs7Ozs7Ozs7Ozs7Ozs7Ozs7RUFrQm5DLEVBQUUsdUJBQXVCLENBQUMsRUFBRSw2QkFBNkI7Ozs7Ozs7Ozs7Ozt1QkFZcEMsRUFBRSw2QkFBNkI7V0FDM0MsRUFBRSxRQUFROztTQUVaLEVBQUUsUUFBUTs7Ozs7O29CQU1DLEVBQUUsd0JBQXdCOzs7OztBQUs5QyxDQUFDO0FBQ0QifQ==
// denoCacheMetadata=5913949499101609235,17084063260464112120