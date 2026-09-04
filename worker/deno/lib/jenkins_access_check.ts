/**
 * Jenkins credentials preflight (Issue #3583).
 *
 * A bare `HTTP 403` from Jenkins tells an unattended worker nothing it can
 * act on, so log fetching stalls and a human ends up pasting the console
 * output by hand. This module fails loud instead: every failure mode —
 * missing environment variables, 401, 403, 404, other HTTP errors, and
 * connection errors — is classified into a one-line diagnosis plus a
 * one-line remediation.
 *
 * It also owns the shared credential/URL/auth helpers used by
 * `jenkins_log_fetcher.ts`, so there is exactly one place that reads
 * `JENKINS_URL` / `JENKINS_USER` / `JENKINS_TOKEN`.
 *
 * The token is never echoed — not in success paths, not in failure
 * messages, and not in any thrown error's text.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

import type { Result } from "../types.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  describeFetchFailure,
  discardBody,
  withRequestTimeout,
} from "./bounded_fetch.ts";
import { getEnvOrDefault } from "./config.ts";
import type { EnvLookup } from "./env_lookup.ts";

/** Injectable fetch function type (mirrors the log fetcher's seam). */
export type FetchFn = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Environment variables the Jenkins client requires, in report order. */
export const REQUIRED_JENKINS_ENV_VARS = [
  "JENKINS_URL",
  "JENKINS_USER",
  "JENKINS_TOKEN",
] as const;

/** Outcome classes the preflight distinguishes. */
export type JenkinsAccessStatus =
  | "ok"
  | "missing-env"
  | "unauthorised"
  | "forbidden"
  | "not-found"
  | "http-error"
  | "network-error";

/** A classified, token-free Jenkins access outcome. */
export interface JenkinsAccessDiagnosis {
  /** True only when Jenkins answered 2xx for the probed job path. */
  ok: boolean;
  /** Failure class, or `"ok"`. */
  status: JenkinsAccessStatus;
  /** HTTP status code, when the outcome came from a response. */
  httpStatus?: number;
  /** One-line summary of what happened. Never contains the token. */
  summary: string;
  /** One-line "what to do about it". Never contains the token. */
  remediation: string;
}

/** Resolved Jenkins credentials. */
export interface JenkinsCredentials {
  baseUrl: string;
  user: string;
  token: string;
}

/**
 * Reads one environment variable — injectable so tests need no real env.
 *
 * @deprecated Use {@link EnvLookup}, the canonical spelling of this seam
 * (Issue #956). Kept as an alias because every caller in and out of this
 * module still names it `EnvReader`.
 */
export type EnvReader = EnvLookup;

const defaultEnvReader: EnvReader = (name) => {
  const value = getEnvOrDefault(name, "");
  return value === "" ? undefined : value;
};

/**
 * Names of the required environment variables that are unset or blank,
 * in {@link REQUIRED_JENKINS_ENV_VARS} order.
 */
export function missingJenkinsEnvVars(
  readEnv: EnvReader = defaultEnvReader,
): string[] {
  return REQUIRED_JENKINS_ENV_VARS.filter(
    (name) => (readEnv(name) ?? "").trim() === "",
  );
}

/**
 * Read Jenkins credentials from the environment.
 *
 * Returns an actionable error naming every missing variable when any of
 * the three is absent. The token value is never echoed back.
 */
export function loadJenkinsCredentials(
  readEnv: EnvReader = defaultEnvReader,
): Result<JenkinsCredentials, string> {
  const missing = missingJenkinsEnvVars(readEnv);
  if (missing.length > 0) {
    return { ok: false, error: describeMissingEnv(missing).summary };
  }

  const url = (readEnv("JENKINS_URL") ?? "").trim();
  // Strip a single trailing slash so URL joins do not produce //.
  const baseUrl = url.endsWith("/") ? url.slice(0, -1) : url;
  return {
    ok: true,
    value: {
      baseUrl,
      user: (readEnv("JENKINS_USER") ?? "").trim(),
      token: readEnv("JENKINS_TOKEN") ?? "",
    },
  };
}

/** Build the HTTP Basic auth header value. */
export function basicAuthHeader(user: string, token: string): string {
  return `Basic ${btoa(`${user}:${token}`)}`;
}

/**
 * Compose a Jenkins API URL for a build resource.
 *
 * Jenkins nests folders as `/job/<a>/job/<b>/job/<c>`, so every segment of
 * `jobPath` gets its own `/job/` prefix — a folder path must not collapse
 * to `/job/<a>/<b>/<c>`, which 404s. This matches the reference
 * implementation in `scripts/fetch-jenkins-build.sh`
 * (stSoftwareAU/private-repo-12#585).
 *
 * Paths that already spell the separators out (`MyFolder/job/MyJob`) are
 * accepted and produce the same URL, so both spellings are equivalent.
 */
export function buildJenkinsUrl(
  baseUrl: string,
  jobPath: string,
  build: string | number,
  suffix: string,
): string {
  const segments = jobPath.split("/").filter((s) =>
    s.length > 0 && s !== "job"
  );
  const expanded = segments.map((s) => `/job/${s}`).join("");
  return `${baseUrl}${expanded}/${build}/${suffix}`;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Diagnosis for one or more unset environment variables. */
export function describeMissingEnv(missing: string[]): JenkinsAccessDiagnosis {
  return {
    ok: false,
    status: "missing-env",
    summary: `Jenkins credentials are not configured: ${missing.join(", ")} ${
      missing.length === 1 ? "is" : "are"
    } not set`,
    remediation: `Export ${
      missing.join(", ")
    } in the worker's environment (see docs/jenkins-access.md) and re-run.`,
  };
}

/**
 * Classify a Jenkins HTTP response status into an actionable diagnosis.
 *
 * `jobPath` is echoed in the 403/404 messages because those two failures
 * are almost always about the *path* — wrong permission scope or wrong
 * job name — and the operator needs to see which path was probed.
 */
export function classifyJenkinsHttpStatus(
  httpStatus: number,
  jobPath: string,
): JenkinsAccessDiagnosis {
  if (httpStatus >= 200 && httpStatus < 300) {
    return {
      ok: true,
      status: "ok",
      httpStatus,
      summary: `Jenkins accepted the credentials for job '${jobPath}'`,
      remediation: "No action required.",
    };
  }

  switch (httpStatus) {
    case 401:
      return {
        ok: false,
        status: "unauthorised",
        httpStatus,
        summary:
          "Jenkins rejected the credentials (HTTP 401) — JENKINS_USER or JENKINS_TOKEN is wrong or expired",
        remediation:
          "Re-issue the API token for JENKINS_USER in Jenkins (User → Configure → API Token) and update the worker's JENKINS_TOKEN.",
      };
    case 403:
      return {
        ok: false,
        status: "forbidden",
        httpStatus,
        summary:
          `Jenkins authenticated the user but denied access (HTTP 403) — the token lacks Job/Read on '${jobPath}'`,
        remediation:
          `Grant JENKINS_USER the Job/Read permission on '${jobPath}' (Manage Jenkins → Security → Authorization), then re-run.`,
      };
    case 404:
      return {
        ok: false,
        status: "not-found",
        httpStatus,
        summary: `Jenkins has no such job or build (HTTP 404) for '${jobPath}'`,
        remediation:
          `Check the configured job path — folders need the full 'Folder/job/Name' form — and that the build number still exists.`,
      };
    default:
      return {
        ok: false,
        status: "http-error",
        httpStatus,
        summary: `Jenkins returned HTTP ${httpStatus} for job '${jobPath}'`,
        remediation:
          "Check the Jenkins server logs and status page; retry once the server is healthy.",
      };
  }
}

/**
 * Strip credential material from a message before it is surfaced.
 *
 * A transport exception can echo the whole request back — including the
 * `Authorization` header — so any error text derived from a Jenkins call
 * passes through here first. Both the raw token and its base64 Basic
 * encoding are replaced.
 */
export function redactJenkinsSecrets(
  message: string,
  creds: { user: string; token: string },
): string {
  const secrets = [
    basicAuthHeader(creds.user, creds.token),
    btoa(`${creds.user}:${creds.token}`),
    creds.token,
  ].filter((secret) => secret !== "");

  let redacted = message;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

/** Diagnosis for a connection-level failure (DNS, TLS, refused, timeout). */
export function describeNetworkError(
  message: string,
  baseUrl: string,
): JenkinsAccessDiagnosis {
  return {
    ok: false,
    status: "network-error",
    summary: `Could not reach Jenkins at ${baseUrl}: ${message}`,
    remediation:
      "Check JENKINS_URL, DNS, and that the worker's network can reach the Jenkins host (VPN or firewall rules).",
  };
}

/**
 * One-line failure message for the log fetcher's non-2xx branch, so a
 * plain fetch error already carries the remediation.
 */
export function describeJenkinsHttpFailure(
  kind: string,
  httpStatus: number,
  statusText: string,
  jobPath: string,
): string {
  const diagnosis = classifyJenkinsHttpStatus(httpStatus, jobPath);
  const suffix = statusText === "" ? "" : ` ${statusText}`;
  return `Jenkins ${kind} request failed with HTTP ${httpStatus}${suffix} — ` +
    `${diagnosis.summary}. ${diagnosis.remediation}`;
}

/**
 * Recover a diagnosis from a Jenkins fetch error string.
 *
 * The CI log provider interface carries failures as plain strings, so the
 * dispatcher classifies them back into the auth/not-found classes that
 * warrant escalation. Returns `undefined` for any error that is not a
 * credentials or job-path problem (e.g. a malformed response body), so
 * unrelated failures keep their existing tolerant handling.
 */
export function classifyJenkinsFetchError(
  error: string,
  jobPath = "the configured job",
): JenkinsAccessDiagnosis | undefined {
  const missing = REQUIRED_JENKINS_ENV_VARS.filter((name) =>
    error.includes(name)
  );
  if (missing.length > 0 && /not set|not configured/.test(error)) {
    return describeMissingEnv([...missing]);
  }

  const match = /HTTP (\d{3})/.exec(error);
  if (!match) return undefined;
  const httpStatus = Number.parseInt(match[1]!, 10);
  if (httpStatus !== 401 && httpStatus !== 403 && httpStatus !== 404) {
    return undefined;
  }
  return classifyJenkinsHttpStatus(httpStatus, jobPath);
}

/** Render a diagnosis as a Markdown block for an issue or PR comment. */
export function formatJenkinsAccessDiagnosis(
  diagnosis: JenkinsAccessDiagnosis,
): string {
  const code = diagnosis.httpStatus === undefined
    ? diagnosis.status
    : `${diagnosis.status} (HTTP ${diagnosis.httpStatus})`;
  return [
    `**Jenkins access check:** ${code}`,
    "",
    diagnosis.summary,
    "",
    `**What to do:** ${diagnosis.remediation}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/** Options for {@link checkJenkinsAccess}. */
export interface CheckJenkinsAccessOptions {
  /** Jenkins job path (e.g. "MyJob" or "MyFolder/job/MyJob"). */
  jobPath: string;
  /** Build number or label to probe. Defaults to `"lastBuild"`. */
  build?: string | number;
  /** Injectable fetch function (defaults to `globalThis.fetch`). */
  fetchFn?: FetchFn;
  /** Injectable environment reader (defaults to the process environment). */
  readEnv?: EnvReader;
  /**
   * Hard timeout for the probe, in milliseconds (Issue #3710). Defaults to
   * {@link DEFAULT_FETCH_TIMEOUT_MS} so a hung Jenkins is reported as a
   * network error instead of stalling the preflight forever.
   */
  timeoutMs?: number;
}

/**
 * Probe Jenkins with the configured credentials and classify the result.
 *
 * Never throws and never echoes the token: a fetch that rejects is
 * reported as a network error carrying only the exception's message, and
 * the token only ever reaches the `Authorization` header.
 */
export async function checkJenkinsAccess(
  opts: CheckJenkinsAccessOptions,
): Promise<JenkinsAccessDiagnosis> {
  const readEnv = opts.readEnv ?? defaultEnvReader;
  const missing = missingJenkinsEnvVars(readEnv);
  if (missing.length > 0) return describeMissingEnv(missing);

  const creds = loadJenkinsCredentials(readEnv);
  if (!creds.ok) return describeMissingEnv([...REQUIRED_JENKINS_ENV_VARS]);
  const { baseUrl, user, token } = creds.value;

  const url = buildJenkinsUrl(
    baseUrl,
    opts.jobPath,
    opts.build ?? "lastBuild",
    "api/json",
  );
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  let response: Response;
  try {
    response = await fetchFn(
      url,
      withRequestTimeout({
        method: "GET",
        headers: {
          Authorization: basicAuthHeader(user, token),
          Accept: "application/json",
        },
      }, timeoutMs),
    );
  } catch (error: unknown) {
    return describeNetworkError(
      redactJenkinsSecrets(describeFetchFailure(error, timeoutMs), {
        user,
        token,
      }),
      baseUrl,
    );
  }

  // Discard the body so the connection is freed without buffering it; it is
  // never echoed because a Jenkins error page can contain unrelated detail.
  await discardBody(response);

  return classifyJenkinsHttpStatus(response.status, opts.jobPath);
}
