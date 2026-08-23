/**
 * Local `gh` state changes the agent subprocess may not make (Issue #187).
 *
 * `classifyGhMutation` classifies commands that change state **on GitHub**.
 * Commands that rewrite the local `gh` installation instead — the credential
 * store, the config file, the alias table, the installed extensions — carry
 * none of its mutating sub-verbs (`login`, `logout`, `switch`, `setup-git`,
 * `refresh`, `install`, …), so they classified as plain reads and
 * {@link evaluateGhCommand} waved them through with `allowed: true`.
 *
 * That is a hole in the containment boundary, not a read:
 *
 * - The wrapper pins `GH_CONFIG_DIR` to the worker's own persistent identity
 *   directory, so a credential the agent writes there outlives the spawn that
 *   wrote it. An injected credential login re-points every later `gh` call —
 *   the worker's included — at an attacker's account.
 * - `setup-git` rewrites the git credential helper, carrying the same
 *   redirection into `git push`.
 * - A config, alias or extension write changes what a later `gh <name>` runs.
 *   The guard already refuses to *run* an alias or an extension (Issue #3866,
 *   `GH_UNKNOWN_COMMAND`) precisely because it cannot see the real command;
 *   refusing to *write* one closes the same gap at the other end.
 *
 * None of these has a legitimate use during a run: credentials are provisioned
 * once, non-interactively, by `setup.sh` (see `credential_preflight.ts`) and
 * consumed read-only — the same unattended-operation invariant
 * `interactive_login_scanner.ts` holds the worker's own source to, applied here
 * at the runtime guard. Read verbs (`gh auth status`, `gh config get`,
 * `gh alias list`, `gh extension list`) are untouched; the worker's own health
 * checks depend on them.
 *
 * Pure by design — it runs inside the guard's short-lived child process.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { ghRootCommand, ghSubVerb } from "./audit_mutation_classifier.ts";
import { normaliseGhArgs } from "./gh_flag_parser.ts";

/**
 * Sub-verbs that rewrite local `gh` state, per root command.
 *
 * A positive denylist rather than "everything but the known reads": a future
 * `gh` release adding a read verb must not be refused, and the roots here are
 * small and stable. Every verb listed writes to `GH_CONFIG_DIR` (or, for
 * `setup-git`, to the git config it points at).
 */
export const GH_LOCAL_STATE_VERBS: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  // Credential store. `status` and `token` are reads and stay allowed.
  auth: new Set(["login", "logout", "switch", "refresh", "setup-git"]),
  // Config file. `get` and `list` are reads.
  config: new Set(["set", "clear-cache"]),
  // Alias table — what a later `gh <name>` expands to.
  alias: new Set(["set", "delete", "import"]),
  // Installed extensions — what a later `gh <name>` executes. `exec` runs one
  // directly, which is the same unseen command by another spelling.
  extension: new Set(["install", "upgrade", "remove", "exec"]),
};

/** `gh` root commands whose local-state verbs are denied to the agent. */
const GUARDED_ROOTS: Readonly<Record<string, string>> = {
  auth: "the credential store",
  config: "the gh configuration",
  alias: "the alias table",
  extension: "the installed extensions",
};

/** Root aliases the real binary accepts for a guarded root. */
const ROOT_ALIASES: Readonly<Record<string, string>> = {
  extensions: "extension",
  ext: "extension",
};

/** One classified attempt to rewrite local `gh` state. */
export interface GhLocalStateChange {
  /** Canonical root command — `auth`, `config`, `alias`, `extension`. */
  root: string;
  /** The sub-verb as spelled on the command line. */
  verb: string;
  /** Which local store the command rewrites, for the refusal message. */
  target: string;
}

/**
 * Classify a `gh` argument vector as a local-state rewrite.
 *
 * @param args - Arguments about to be passed to the `gh` binary.
 * @returns The change, or `undefined` when the command rewrites no local `gh`
 *   state (a read, or any other root command).
 */
export function classifyGhLocalStateChange(
  rawArgs: readonly string[],
): GhLocalStateChange | undefined {
  // Issue #3867: pflag's attached shorthand spellings are rewritten to their
  // separated form first, so the root/verb scan sees the one spelling.
  const args = normaliseGhArgs(rawArgs);
  const rawRoot = ghRootCommand(args)?.toLowerCase();
  if (rawRoot === undefined) return undefined;
  const root = ROOT_ALIASES[rawRoot] ?? rawRoot;
  const target = GUARDED_ROOTS[root];
  if (target === undefined) return undefined;

  const verb = ghSubVerb(args);
  if (verb === undefined) return undefined;
  if (!GH_LOCAL_STATE_VERBS[root]?.has(verb.toLowerCase())) return undefined;

  return { root, verb, target };
}
