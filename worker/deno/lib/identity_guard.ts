/**
 * Worker identity guard (Issue #3528).
 *
 * A regression let a worker host whose ambient `gh` auth had drifted to a
 * human personal token perform milestone-completion writes (tracking-issue
 * creation, summary-PR raising, tracking-issue closing) authenticated as that
 * human account — silently operating with elevated permissions. Nothing
 * validated the login `gh` resolved against an expected service account, so
 * the drift went unnoticed.
 *
 * This guard is deliberately fail-loud (never fail silently). It evaluates the
 * authenticated login against a config-driven allowlist of service accounts
 * and refuses to proceed on a mismatch, logging the hostname plus the expected
 * and actual login so the offending host self-identifies (the operator does
 * not otherwise know which host holds the drifted credentials). Fixing the
 * host's `gh` auth is a human action once the guard surfaces it.
 *
 * The allowlist lives in `.config.json` (`service_accounts`) — an allowlist,
 * not a per-host key. When it is empty the guard cannot enforce; rather than
 * silently allowing anything, it emits a loud `[SECURITY]` warning so the
 * inactive state is visible in every run log.
 *
 * Australian English spelling throughout (behaviour, defence, authorised).
 */

/** Outcome of evaluating a resolved login against the service-account allowlist. */
export interface IdentityEvaluation {
  /** True when the login may perform worker writes. */
  permitted: boolean;
  /**
   * True when an allowlist was configured, so the decision was actively
   * enforced. False means the guard is inactive (empty allowlist).
   */
  enforced: boolean;
  /** The authenticated login as resolved (trimmed), or "" when unresolved. */
  actual: string;
  /** The configured allowlist (trimmed, empties removed). */
  expected: string[];
  /** The host the worker is running on. */
  hostname: string;
  /** Fail-loud, human-readable description of the outcome (tagged [SECURITY]). */
  message: string;
}

/** Normalise a GitHub login for comparison. GitHub logins are case-insensitive. */
export function normaliseLogin(login: string): string {
  return login.trim().toLowerCase();
}

/** Resolve the current hostname, falling back to a sentinel on failure. */
export function readHostname(): string {
  try {
    return Deno.hostname();
  } catch {
    return "unknown-host";
  }
}

/**
 * Evaluate an authenticated login against the service-account allowlist.
 *
 * Pure — no logging, no throwing, no I/O — so the decision is trivially
 * testable. {@link assertWorkerIdentity} wraps this with fail-loud logging.
 *
 * @param actualLogin - The login `gh` resolved (may be empty/unresolved).
 * @param allowedServiceAccounts - Configured allowlist of service accounts.
 * @param hostname - The host the worker is running on.
 */
export function evaluateWorkerIdentity(
  actualLogin: string,
  allowedServiceAccounts: readonly string[],
  hostname: string,
): IdentityEvaluation {
  const actual = actualLogin.trim();
  const host = hostname.trim() || "unknown-host";
  const expected = allowedServiceAccounts
    .map((account) => account.trim())
    .filter((account) => account.length > 0);

  // No allowlist configured — the guard cannot enforce. Warn loudly rather
  // than silently allowing anything (never fail silently).
  if (expected.length === 0) {
    return {
      permitted: true,
      enforced: false,
      actual,
      expected,
      hostname: host,
      message:
        `[SECURITY] worker identity guard INACTIVE on host '${host}': no ` +
        `service accounts configured (set 'service_accounts' in .config.json). ` +
        `Running as '${actual || "<unresolved>"}' — identity drift cannot be ` +
        `detected until the allowlist is configured.`,
    };
  }

  // Allowlist configured — enforce.
  if (actual === "") {
    return {
      permitted: false,
      enforced: true,
      actual,
      expected,
      hostname: host,
      message:
        `[SECURITY] worker identity guard FAILED on host '${host}': could not ` +
        `resolve an authenticated GitHub login. Expected one of ` +
        `[${expected.join(", ")}]. Refusing to proceed.`,
    };
  }

  const normalisedExpected = new Set(expected.map(normaliseLogin));
  if (normalisedExpected.has(normaliseLogin(actual))) {
    return {
      permitted: true,
      enforced: true,
      actual,
      expected,
      hostname: host,
      message:
        `[SECURITY] worker identity OK on host '${host}': authenticated as ` +
        `'${actual}' (allowed service account).`,
    };
  }

  return {
    permitted: false,
    enforced: true,
    actual,
    expected,
    hostname: host,
    message:
      `[SECURITY] worker identity MISMATCH on host '${host}': authenticated ` +
      `as '${actual}' but expected one of [${expected.join(", ")}]. Refusing ` +
      `to proceed — this host's 'gh' auth has drifted to a non-service ` +
      `account and would operate with that account's permissions. Fix the ` +
      `'gh' auth on host '${host}' (re-authenticate as a service account).`,
  };
}

/**
 * Thrown when the identity guard rejects the resolved login. Carries the
 * full {@link IdentityEvaluation} so callers can inspect the decision.
 */
export class IdentityGuardError extends Error {
  readonly evaluation: IdentityEvaluation;
  constructor(evaluation: IdentityEvaluation) {
    super(evaluation.message);
    this.name = "IdentityGuardError";
    this.evaluation = evaluation;
  }
}

/** Injectable side effects for {@link assertWorkerIdentity}. */
export interface IdentityGuardDeps {
  /** Resolve the hostname (tests inject a fixed value). */
  hostname?: () => string;
  /** Log an informational/warning line. */
  log?: (message: string) => void;
  /** Log an error line. */
  logError?: (message: string) => void;
}

/**
 * Fail-loud identity guard. Evaluates the login and:
 *
 * - on a mismatch (or unresolved login under an active allowlist): logs the
 *   fault via `logError` and throws {@link IdentityGuardError};
 * - on an inactive allowlist: logs a loud warning via `log` and returns;
 * - on a match: logs a confirmation via `log` and returns.
 *
 * @returns The {@link IdentityEvaluation} when permitted to proceed.
 * @throws {IdentityGuardError} when the login is not an allowed service account.
 */
export function assertWorkerIdentity(
  actualLogin: string,
  allowedServiceAccounts: readonly string[],
  deps: IdentityGuardDeps = {},
): IdentityEvaluation {
  const host = deps.hostname?.() ?? readHostname();
  const log = deps.log ?? ((message: string) => console.error(message));
  const logError = deps.logError ??
    ((message: string) => console.error(message));

  const evaluation = evaluateWorkerIdentity(
    actualLogin,
    allowedServiceAccounts,
    host,
  );

  if (!evaluation.permitted) {
    logError(evaluation.message);
    throw new IdentityGuardError(evaluation);
  }

  // Permitted — but still log loudly (confirmation or inactive-guard warning).
  log(evaluation.message);
  return evaluation;
}
