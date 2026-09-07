/**
 * Credential *reads* the agent subprocess may not make (Issue #1371).
 *
 * Every control the agent-side `gh` guard enforces — the write-repo allowlist,
 * the reserved-label denylist, the claimed-issue lifecycle guard, the body
 * redaction — is reached by classifying the argument vector of a `gh` call.
 * That is a containment boundary around the *channel*, and it holds only for
 * as long as the channel is the agent's only way to reach GitHub. The guard's
 * own residual-risk note says so plainly: an agent that talks to the REST API
 * directly never re-enters the classifier at all.
 *
 * What made that residual risk reachable through the guarded channel was a
 * pair of commands the guard classified as harmless reads. `gh auth token`
 * and `gh auth status --show-token` print the run's GitHub credential in
 * plaintext, and `gh_local_state_guard.ts` deliberately let them through
 * ("`status` and `token` are reads and stay allowed") because neither changes
 * anything — on GitHub or locally. But the value they return is precisely the
 * one that makes every later call unguarded, so the guard was handing out its
 * own bypass on request.
 *
 * They are therefore refused, whether or not the write-repo allowlist is
 * active. Nothing in a run needs them: the worker authenticates its own `gh`
 * subprocesses from `gh_spawn.ts` and checks token health with
 * `ensureValidToken` or a plain `gh auth status`, and the agent authenticates
 * from the `GH_CONFIG_DIR` the wrapper pins for it — it never has to see the
 * secret to use it. Plain `gh auth status` stays allowed, so the health checks
 * that read it are untouched.
 *
 * **This narrows the boundary; it does not close it.** An agent with
 * filesystem read access to the pinned `GH_CONFIG_DIR` still shares the host's
 * credentials, and no argv classifier can change that. The durable fix remains
 * the one `gh_guard_shim.ts` names — a per-run token scoped to the target repo,
 * so that what leaks is worth less. Refusing the disclosure removes the
 * supported, one-command way to obtain it.
 *
 * Pure by design — it runs inside the guard's short-lived child process, which
 * has no permissions beyond reading a named body file.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { ghRootCommand, ghSubVerb } from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";

/**
 * The flag that turns `gh auth status` from a health check into a credential
 * dump, in its long spelling.
 */
const SHOW_TOKEN_FLAG = "--show-token";

/** The shorthand for {@link SHOW_TOKEN_FLAG}. */
const SHOW_TOKEN_SHORTHAND = "t";

/**
 * Shorthand letters of `gh auth status` that take a value, and so end a
 * shorthand group by swallowing the rest of the token.
 *
 * pflag hands the remainder of a group to the first value-taking flag in it,
 * so `-ht github.com` is `--hostname t`, not `--hostname --show-token`. Only
 * `-h`/`--hostname` behaves that way on this subcommand; `-a`/`--active` and
 * `-t`/`--show-token` are booleans and are walked through.
 */
const VALUE_SHORTHANDS: ReadonlySet<string> = new Set(["h"]);

/** One classified attempt to read the run's GitHub credential. */
export interface GhCredentialDisclosure {
  /** Canonical root command — always `auth`. */
  root: string;
  /** The sub-verb as spelled on the command line — `token` or `status`. */
  verb: string;
  /** What the command would print, for the refusal message. */
  disclosed: string;
}

/**
 * Whether a `gh auth status` argument vector asks for the token.
 *
 * Matches `--show-token`, `--show-token=<anything>` and the `-t` shorthand,
 * including inside a shorthand group (`-at`). A `--show-token=false` is
 * matched too: over-refusing a spelling nobody writes is the safe direction,
 * and the plain command is right there.
 *
 * @param args - Normalised arguments, root and verb included.
 * @returns true when the vector would print the credential.
 */
function asksForToken(args: readonly string[]): boolean {
  for (const arg of args) {
    if (arg === SHOW_TOKEN_FLAG || arg.startsWith(`${SHOW_TOKEN_FLAG}=`)) {
      return true;
    }
    if (arg === "--") break;
    if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 2) {
      continue;
    }
    for (const letter of arg.slice(1)) {
      if (letter === SHOW_TOKEN_SHORTHAND) return true;
      if (VALUE_SHORTHANDS.has(letter)) break;
    }
  }
  return false;
}

/**
 * Classify a `gh` argument vector as a credential disclosure.
 *
 * @param rawArgs - Arguments about to be passed to the `gh` binary.
 * @returns The disclosure, or `undefined` when the command prints no
 *   credential (every other command, plain `gh auth status` included).
 */
export function classifyGhCredentialDisclosure(
  rawArgs: readonly string[],
): GhCredentialDisclosure | undefined {
  // Issue #3867: the attached shorthand spellings are rewritten to their
  // separated form first, so the root/verb scan sees the one spelling.
  const args = normaliseGhArgs(rawArgs);
  if (ghRootCommand(args)?.toLowerCase() !== "auth") return undefined;

  const verb = ghSubVerb(args)?.toLowerCase();
  if (verb === "token") {
    return {
      root: "auth",
      verb: "token",
      disclosed: "the run's GitHub token",
    };
  }
  if (verb === "status" && asksForToken(args)) {
    return {
      root: "auth",
      verb: "status",
      disclosed: "the run's GitHub token",
    };
  }
  return undefined;
}
