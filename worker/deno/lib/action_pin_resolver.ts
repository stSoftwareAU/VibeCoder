/**
 * Resolve the action pins emitted into managed repositories against upstream
 * (Issue #1823).
 *
 * `lib/pinned_actions.ts` records one hand-maintained SHA per action. That
 * catalogue is immutable — which is the point — but it is also frozen: an
 * action whose upstream cut a new major after the catalogue was last touched
 * is emitted a major behind, and the Actions audit reports it (check 16) on
 * every repository the template reached.
 *
 * This module closes that gap without giving up immutability. For every
 * `"release"` entry it reads upstream's own published release history, keeps
 * only the releases that have aged past `VIBE_BUMP_QUARANTINE_HOURS` — the
 * same supply-chain embargo `bump_deps.ts` and `tool_release_age.ts` apply —
 * and emits the **highest** of those, resolved to a 40-character commit SHA.
 *
 * Highest, not newest: a backport patch cut on an older major yesterday is
 * more recently *published* than last month's newer major, so picking by
 * publish date would walk the pin backwards and trip the very audit check
 * this exists to satisfy. `selectNewestAged` in `tool_release_age.ts` picks by
 * date and is deliberately not used here.
 *
 * Everything is pure over an injected runner, so the whole selection — window,
 * ordering, and every fallback — is unit-testable with no network access. A
 * pin is never invented: a resolved SHA came from the runner's output, and any
 * failure returns the catalogue SHA unchanged with exactly one logged reason.
 *
 * Australian English used throughout (behaviour, honoured, recognised).
 */

import type { Result } from "../types.ts";
import { type ActionPin, PINNED_ACTIONS } from "./pinned_actions.ts";
import {
  evaluateReleaseAge,
  normaliseQuarantineHours,
  parseGhCommitLine,
  RELEASE_LOOKUP_TIMEOUT_SECONDS,
  type ReleaseCandidate,
  resolveGitHubReleaseHistory,
} from "./tool_release_age.ts";

/** Prefix every fallback line carries, so an operator can grep for it. */
export const PIN_RESOLUTION_FAILURE_PREFIX =
  "[workflow-sync] pin resolution failed:";

/** Environment variable naming the supply-chain quarantine window. */
export const QUARANTINE_HOURS_ENV = "VIBE_BUMP_QUARANTINE_HOURS";

/** `owner/repo` shape accepted in a GitHub API path (no traversal, no shell). */
const ACTION_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Release tag shape accepted in a GitHub API path.
 *
 * `parseGhReleaseListing` already keeps stable `MAJOR.MINOR.PATCH` tags only,
 * so this is defence in depth: the tag is interpolated into an API path, and
 * nothing but a plain semver tag may ever get there.
 */
const RELEASE_TAG_PATTERN = /^v?\d+\.\d+\.\d+$/;

/** Commit sha shape accepted as a pin. */
const SHA_PATTERN = /^[0-9a-f]{40}$/;

/** A `uses:` line already pinned to a commit SHA, with optional comment. */
const PINNED_USES_LINE =
  /^(\s*(?:-\s+)?uses:\s+)([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)@([0-9a-f]{40})(?:[ \t]+#[^\n]*)?$/;

/** Injectable side-effects for {@link resolveActionPins}. */
export interface ActionPinResolverDeps {
  /** Command runner used for the `gh api` lookups. */
  runFn: (
    cmd: string[],
    timeoutSeconds: number,
  ) => Promise<Result<{ exitCode: number; output: string }>>;
  /** Quarantine window in hours; defaults to `VIBE_BUMP_QUARANTINE_HOURS`. */
  quarantineHours?: number;
  /** Current wall-clock time, sampled once per resolution. */
  now?: () => Date;
  /** Sink for fallback lines. Defaults to `console.warn`. */
  log?: (message: string) => void;
}

/** One action that could not be resolved, and why. */
export interface ActionPinFailure {
  /** Action coordinate (`owner/repo`). */
  action: string;
  /** Why the catalogue SHA was emitted instead of a resolved one. */
  reason: string;
}

/** Outcome of resolving the whole catalogue. */
export interface ResolvedActionPins {
  /** One pin per catalogue entry — resolved, or the catalogue's own. */
  pins: Record<string, ActionPin>;
  /** Every entry that fell back, in catalogue order. */
  failures: ActionPinFailure[];
}

/** Compare two stable `MAJOR.MINOR.PATCH` versions numerically. */
function compareStableVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The highest-versioned candidate in a non-empty list. */
function highestVersion(candidates: ReleaseCandidate[]): ReleaseCandidate {
  return candidates.reduce((best, candidate) =>
    compareStableVersions(candidate.version ?? "", best.version ?? "") > 0
      ? candidate
      : best
  );
}

/** Shorthand for a failed resolution carrying a human-readable reason. */
function failed(reason: string): Result<ActionPin> {
  return { ok: false, error: new Error(reason) };
}

/**
 * Resolve one action to the highest release that has cleared the window.
 *
 * Every exit that is not a 40-character SHA read out of the runner's own
 * output is an error naming what went wrong, so the caller can log it and
 * fall back rather than guessing.
 */
async function resolveOnePin(
  action: string,
  deps: ActionPinResolverDeps,
  quarantineHours: number,
  evaluatedAt: Date,
): Promise<Result<ActionPin>> {
  if (!ACTION_PATTERN.test(action)) {
    return failed(`"${action}" is not an owner/repo action coordinate`);
  }

  const history = await resolveGitHubReleaseHistory(action, deps.runFn);
  if (!history.ok) {
    return failed(`release history lookup failed — ${history.error.message}`);
  }
  if (history.value.length === 0) {
    return failed("upstream publishes no stable MAJOR.MINOR.PATCH release");
  }

  const eligible = history.value.filter((candidate) =>
    evaluateReleaseAge(action, candidate, quarantineHours, evaluatedAt).eligible
  );
  if (eligible.length === 0) {
    return failed(
      `no stable release has cleared the ${quarantineHours}h quarantine window`,
    );
  }

  const tag = highestVersion(eligible).ref ?? "";
  if (!RELEASE_TAG_PATTERN.test(tag)) {
    return failed(`release tag "${tag}" is not a stable release tag`);
  }

  const commit = await deps.runFn([
    "gh",
    "api",
    `repos/${action}/commits/${tag}`,
    "--jq",
    '.sha + " " + .commit.committer.date',
  ], RELEASE_LOOKUP_TIMEOUT_SECONDS);
  if (!commit.ok) {
    return failed(
      `resolving tag ${tag} to a commit failed — ${commit.error.message}`,
    );
  }
  if (commit.value.exitCode !== 0) {
    return failed(
      `resolving tag ${tag} to a commit exited ${commit.value.exitCode}`,
    );
  }

  const { sha } = parseGhCommitLine(commit.value.output);
  if (!sha || !SHA_PATTERN.test(sha)) {
    return failed(`tag ${tag} did not resolve to a 40-character commit SHA`);
  }
  return { ok: true, value: { sha, version: tag } };
}

/**
 * Resolve every catalogue entry against upstream.
 *
 * `"catalogue"` entries are returned verbatim and are never looked up, so they
 * cost no runner call and never log. Every `"release"` entry that cannot be
 * resolved falls back to its catalogue pin and emits exactly one line
 * `[workflow-sync] pin resolution failed: <action> — <reason>`, so a stale pin
 * is loud rather than silent.
 */
export async function resolveActionPins(
  deps: ActionPinResolverDeps,
): Promise<ResolvedActionPins> {
  const quarantineHours = normaliseQuarantineHours(
    deps.quarantineHours ?? Deno.env.get(QUARANTINE_HOURS_ENV),
  );
  const evaluatedAt = (deps.now ?? (() => new Date()))();
  const log = deps.log ?? ((message: string) => console.warn(message));

  const pins: Record<string, ActionPin> = {};
  const failures: ActionPinFailure[] = [];

  for (const [action, catalogue] of Object.entries(PINNED_ACTIONS)) {
    if ((catalogue.resolution ?? "release") === "catalogue") {
      pins[action] = catalogue;
      continue;
    }
    const resolved = await resolveOnePin(
      action,
      deps,
      quarantineHours,
      evaluatedAt,
    );
    if (resolved.ok) {
      pins[action] = resolved.value;
      continue;
    }
    const reason = resolved.error.message;
    pins[action] = catalogue;
    failures.push({ action, reason });
    log(`${PIN_RESOLUTION_FAILURE_PREFIX} ${action} — ${reason}`);
  }

  return { pins, failures };
}

/**
 * Rewrite a template's already-pinned `uses:` lines to the resolved pins.
 *
 * Only a line of the form `uses: <owner>/<repo>@<40-hex>` — optionally
 * carrying a trailing `# comment` — is touched, and only when the catalogue
 * holds a resolved pin for that action. Every other byte of the template is
 * returned unchanged, including the Semgrep `image:` reference, whose tag and
 * digest are pinned separately and must not be rewritten as an action.
 */
export function applyResolvedPins(
  template: string,
  pins: Record<string, ActionPin>,
): string {
  return template
    .split("\n")
    .map((line) => {
      const match = PINNED_USES_LINE.exec(line);
      if (!match) return line;
      const [, prefix, action] = match;
      const pin = pins[action!];
      // A pin whose SHA did not survive validation is not emitted — the
      // template keeps whatever it already had rather than gaining a
      // fabricated ref.
      if (!pin || !SHA_PATTERN.test(pin.sha)) return line;
      return `${prefix}${action}@${pin.sha} # ${pin.version}`;
    })
    .join("\n");
}
