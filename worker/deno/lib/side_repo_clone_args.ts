/**
 * Clone arguments for side/data repositories a gate pulls in (Issue #243).
 *
 * Tier 2 of the work volume (Issue #242) is disposable: a sibling data repo a
 * monitored repo's gate clones as `../<name>` is aged out after three idle
 * days and dropped largest-first when the host disk is low. That reclaim is
 * only cheap if re-fetching it is cheap, and today it is not:
 * `GRQ-shareprices2026Q2` is 7.3 GB with an 832 MB `.git` of daily data
 * commits, so every reclaim buys back disk at the price of a full re-download
 * on the next gate run — on every fleet host.
 *
 * A **blobless partial clone** (`--filter=blob:none`) keeps the whole commit
 * history — `git log`, `git blame` and pulls all behave — and fetches file
 * contents lazily, so a data repo checked out at one revision costs roughly
 * its working tree rather than every blob ever committed. A `--depth` shallow
 * clone is smaller still but breaks history-based tooling, so blobless is the
 * safe fleet-wide default.
 *
 * The worker exports {@link SIDE_REPO_CLONE_ARGS_ENV} into every gate and
 * agent run (see `run_bootstrap.ts`); a monitored repo's script adopts it with
 * `git clone ${VIBE_SIDE_REPO_CLONE_ARGS:-} …`. An operator override wins
 * verbatim — including an empty value, which means "no extra arguments", the
 * documented way back to a full clone.
 *
 * This applies to **new** clones only. A partial clone already on disk is left
 * exactly as it is: nothing here re-clones a checkout to shrink it, because
 * that would cost the very download the filter exists to avoid.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

/** Environment variable carrying the side-repo clone arguments. */
export const SIDE_REPO_CLONE_ARGS_ENV = "VIBE_SIDE_REPO_CLONE_ARGS";

/** Fleet default: full history, blobs fetched lazily. */
export const DEFAULT_SIDE_REPO_CLONE_ARGS = "--filter=blob:none";

/**
 * Shape every token of an override must have.
 *
 * The value is word-split unquoted by adopting shell scripts
 * (`git clone ${VIBE_SIDE_REPO_CLONE_ARGS:-} …`), so a token carrying shell
 * metacharacters would be a command-injection surface in every gate that
 * honours it. Restricting tokens to the characters `git clone` options
 * actually use closes that door without constraining any real option.
 */
const CLONE_ARG_TOKEN_PATTERN = /^-{1,2}[A-Za-z0-9][A-Za-z0-9=:,./+@_-]*$/;

/** Where the resolved value came from. */
export type SideRepoCloneArgsSource =
  /** No override set — the blobless fleet default. */
  | "default"
  /** An operator override, honoured verbatim. */
  | "override"
  /** An override that failed validation; the default was used instead. */
  | "rejected";

/** Outcome of {@link resolveSideRepoCloneArgs}. */
export interface SideRepoCloneArgsResolution {
  /** The arguments to export, verbatim. */
  value: string;
  /** Which of the three paths produced {@link value}. */
  source: SideRepoCloneArgsSource;
  /** Why an override was rejected — populated only when `source` is `rejected`. */
  reason?: string;
}

/**
 * Resolve the clone arguments for side/data repositories.
 *
 * Precedence: an operator override wins verbatim; otherwise the blobless
 * default. An override whose tokens are not plain `git clone` options is
 * refused loudly (never silently mangled) and the default stands, so a
 * malformed value cannot inject shell syntax into every gate.
 *
 * @param env - Environment reader; `undefined` means the variable is unset.
 * @returns The value to export, its source, and the refusal reason if any.
 */
export function resolveSideRepoCloneArgs(
  env: (name: string) => string | undefined,
): SideRepoCloneArgsResolution {
  const override = env(SIDE_REPO_CLONE_ARGS_ENV);
  if (override === undefined) {
    return { value: DEFAULT_SIDE_REPO_CLONE_ARGS, source: "default" };
  }

  // An explicitly empty value is a deliberate opt-out: no extra arguments,
  // i.e. the full clone git would have made before this variable existed.
  const tokens = splitArgs(override);
  if (tokens.length === 0) return { value: "", source: "override" };

  const bad = tokens.find((token) => !CLONE_ARG_TOKEN_PATTERN.test(token));
  if (bad !== undefined) {
    return {
      value: DEFAULT_SIDE_REPO_CLONE_ARGS,
      source: "rejected",
      reason: `${SIDE_REPO_CLONE_ARGS_ENV} token ${
        JSON.stringify(bad)
      } is not a plain git clone option — using the default instead`,
    };
  }
  return { value: override, source: "override" };
}

/**
 * The resolved arguments as an argv list, ready for a `git clone` spawn.
 *
 * For the worker's own on-demand clone of a tier-2 repository: the same value
 * the gates receive, split on whitespace so it is passed as arguments rather
 * than through a shell. Today every tier-2 data repo is re-fetched by the
 * consuming repo's own script (`work_volume_tiers.ts` documents why removal is
 * safe), so this is the seam a worker-side re-clone uses rather than inventing
 * a second answer to "how do we clone a side repo".
 *
 * @param env - Environment reader.
 * @returns Zero or more `git clone` arguments.
 */
export function sideRepoCloneArgList(
  env: (name: string) => string | undefined,
): string[] {
  return splitArgs(resolveSideRepoCloneArgs(env).value);
}

/** Split a whitespace-separated argument string, dropping empty tokens. */
function splitArgs(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 0);
}
