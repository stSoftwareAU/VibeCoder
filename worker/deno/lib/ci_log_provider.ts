/**
 * CI log provider extension point (Issue #3579).
 *
 * GitHub Actions is the built-in default provider every repo gets with
 * no configuration. External CI/CD systems plug in through this
 * interface — Jenkins is simply the first one — so adding a third
 * provider never touches the dispatcher.
 *
 * A provider answers two questions: `matches()` — can I resolve a log
 * for this failing check? — and `fetchLog()` — here is a bounded
 * root-cause excerpt. Neither ever throws; failures come back as
 * `Result.error` so the CI fix flow keeps running.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

import type { CiProviderConfig, Result } from "../types.ts";
import type { FetchFn } from "./jenkins_log_fetcher.ts";
import type { EnvReader } from "./jenkins_access_check.ts";
import type {
  fetchGithubActionsLogExcerpt,
  GhCommandFn,
} from "./github_actions_log_fetcher.ts";
import { githubActionsCiLogProvider } from "./ci_provider_github_actions.ts";
import { jenkinsCiLogProvider } from "./ci_provider_jenkins.ts";

/** The failing check a provider is asked to resolve a log for. */
export interface CiFailureContext {
  /** Repository in `owner/repo` format. */
  repo: string;
  /** PR number, or `undefined` in issue mode (no PR exists yet). */
  prNumber?: number;
  /** Name of the failing check. */
  checkName: string;
  /** GitHub check run id of the failing check, when known. */
  checkRunId?: string;
  /** Check `target_url` / `details_url`, when known. */
  targetUrl?: string;
  /** Resolved per-repo configuration entry for the provider. */
  providerConfig?: CiProviderConfig;
  /** Injection seam: HTTP fetch used by the Jenkins provider. */
  fetchFn?: FetchFn;
  /**
   * Injection seam: environment reader used by the Jenkins provider to
   * resolve its credentials (Issue #958). Defaults to the process
   * environment when omitted.
   */
  readEnv?: EnvReader;
  /** Injection seam: authenticated `gh` runner used by the Actions provider. */
  ghFn?: GhCommandFn;
  /** Injection seam: Actions log fetcher (tests replace the network call). */
  actionsLogFn?: typeof fetchGithubActionsLogExcerpt;
}

/** A bounded root-cause log excerpt fetched by a provider. */
export interface CiLogExcerpt {
  /** Id of the provider that produced this excerpt. */
  providerId: string;
  /** Build or run identifier within that provider. */
  buildId: string;
  /** URL a human can open to see the full build. */
  url: string;
  /** Provider-reported build status, when available. */
  status?: string;
  /** Byte-capped log text. Never empty on a successful fetch. */
  logText: string;
}

/** A pluggable source of CI logs for a failing check. */
export interface CiLogProvider {
  /** Stable id, e.g. `github-actions` or `jenkins`. */
  readonly id: string;
  /** Can this provider resolve a log for this failing check? */
  matches(ctx: CiFailureContext): boolean;
  /** Fetch a bounded root-cause log excerpt. Never throws. */
  fetchLog(ctx: CiFailureContext): Promise<Result<CiLogExcerpt, string>>;
}

// ---------------------------------------------------------------------------
// Check-name pattern helper (shared by providers)
// ---------------------------------------------------------------------------

/** Maximum accepted length for operator-configured check-name patterns. */
export const MAX_CHECK_PATTERN_LENGTH = 200;

/**
 * Compiled-once regex that rejects catastrophic-backtracking constructs.
 *
 * Matches a quantifier (`+`, `*`, `?`, or `{`) immediately following a
 * group that already contains a quantifier — the canonical ReDoS form
 * `(a+)+`. Best-effort defence; it need not catch every ReDoS variant.
 */
const UNSAFE_NESTED_QUANTIFIER = /(\([^)]*[+*?][^)]*\))[+*?{]/;

/**
 * Compile a configured `checkNamePattern` to a RegExp, falling back to
 * `fallback` when unset.
 *
 * An oversized, unsafe, or invalid pattern is returned as an error
 * rather than thrown — callers surface it as a provider result.
 */
export function compileCheckNamePattern(
  pattern: string | undefined,
  fallback: RegExp,
): Result<RegExp, string> {
  if (pattern === undefined || pattern === "") {
    return { ok: true, value: fallback };
  }
  if (pattern.length > MAX_CHECK_PATTERN_LENGTH) {
    return {
      ok: false,
      error:
        `checkNamePattern exceeds ${MAX_CHECK_PATTERN_LENGTH} character limit`,
    };
  }
  if (UNSAFE_NESTED_QUANTIFIER.test(pattern)) {
    return {
      ok: false,
      error: "checkNamePattern contains unsafe nested quantifiers",
    };
  }
  try {
    // Pattern is operator-controlled config (not end-user input), length-bounded,
    // and validated against catastrophic-backtracking constructs above.
    // The strings matched against are short CI check names, limiting ReDoS exposure.
    return { ok: true, value: new RegExp(pattern, "i") }; // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `invalid checkNamePattern '${pattern}': ${message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Insertion-ordered registry of providers, keyed by id. */
const registry = new Map<string, CiLogProvider>();

/**
 * Register a provider. Ids are unique — re-registering an id throws so a
 * clashing extension fails loudly at start-up rather than silently
 * shadowing a built-in.
 */
export function registerCiLogProvider(provider: CiLogProvider): void {
  if (provider.id === "") {
    throw new Error("CI log provider id must be a non-empty string");
  }
  if (registry.has(provider.id)) {
    throw new Error(
      `CI log provider '${provider.id}' is already registered`,
    );
  }
  registry.set(provider.id, provider);
}

/** Remove a registered provider. Returns `true` when one was removed. */
export function unregisterCiLogProvider(id: string): boolean {
  return registry.delete(id);
}

/** Look up a provider by id, or `undefined` when none is registered. */
export function getCiLogProvider(id: string): CiLogProvider | undefined {
  return registry.get(id);
}

/** All registered providers in registration order. */
export function listCiLogProviders(): CiLogProvider[] {
  return [...registry.values()];
}

/**
 * Pick the provider for a failing check: the first registered provider
 * that matches, falling back to the built-in GitHub Actions provider
 * when nothing external does.
 */
export function resolveCiLogProvider(ctx: CiFailureContext): CiLogProvider {
  for (const provider of registry.values()) {
    if (provider.matches(ctx)) return provider;
  }
  return githubActionsCiLogProvider;
}

// Built-in providers. Jenkins is registered ahead of GitHub Actions so a
// repo that configures Jenkins wins over the default; GitHub Actions is
// also the fall-back returned when nothing matches.
registerCiLogProvider(jenkinsCiLogProvider);
registerCiLogProvider(githubActionsCiLogProvider);
