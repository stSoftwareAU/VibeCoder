/**
 * Jenkins HTTP client for fetching build status and console logs (Issue #1891).
 *
 * Mirrors the behaviour of the sibling repo's `scripts/fetch-jenkins-build.sh`
 * (see private-repo-12/docs/jenkins-access.md). The worker calls Jenkins
 * directly so it can summarise CI failures without shelling out.
 *
 * Credentials are read from `JENKINS_URL`, `JENKINS_USER` and
 * `JENKINS_TOKEN` — through the injectable `readEnv` seam, defaulting to
 * the process environment (Issue #958) — and are never logged or included
 * in error messages.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

import type { Result } from "../types.ts";
import {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_MAX_STREAM_BYTES,
  describeFetchFailure,
  discardBody,
  readTailBounded,
  readTextBounded,
  withRequestTimeout,
} from "./bounded_fetch.ts";
import {
  basicAuthHeader,
  buildJenkinsUrl,
  describeJenkinsHttpFailure,
  loadJenkinsCredentials,
  redactJenkinsSecrets,
} from "./jenkins_access_check.ts";
import type { EnvReader } from "./jenkins_access_check.ts";

/** Default cap on log size returned to callers (64 KiB). */
export const DEFAULT_MAX_LOG_BYTES = 64 * 1024;

/**
 * Cap on the build-status JSON body (256 KiB — Issue #3710). The document is
 * a few kilobytes in practice; anything larger is a hostile or broken server.
 */
export const MAX_STATUS_BYTES = 256 * 1024;

/** Parsed Jenkins build status response. */
export interface JenkinsBuild {
  number: number;
  result: "SUCCESS" | "FAILURE" | "UNSTABLE" | "ABORTED" | "UNKNOWN";
  url: string;
}

/** Injectable fetch function type for testing. */
export type FetchFn = (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Options shared by both status and log fetchers. */
interface JenkinsFetcherBaseOptions {
  /** Jenkins job path (e.g. "MyJob" or "MyFolder/job/MyJob"). */
  jobPath: string;
  /** Build number or label (e.g. 42, "lastBuild"). */
  build: string | number;
  /** Injectable fetch function (defaults to globalThis.fetch). */
  fetchFn?: FetchFn;
  /**
   * Injectable environment reader (Issue #958). Defaults to the process
   * environment, so every production caller is unchanged; a test supplies
   * the three Jenkins variables as a plain object rather than writing a
   * credential-shaped value into the process every parallel worker shares.
   */
  readEnv?: EnvReader;
  /**
   * Hard timeout for the request, in milliseconds (Issue #3710). Defaults to
   * {@link DEFAULT_FETCH_TIMEOUT_MS}; a hung Jenkins can no longer wedge the
   * worker.
   */
  timeoutMs?: number;
}

export type FetchStatusOptions = JenkinsFetcherBaseOptions;

export interface FetchLogOptions extends JenkinsFetcherBaseOptions {
  /**
   * Maximum number of UTF-8 bytes returned. Defaults to
   * {@link DEFAULT_MAX_LOG_BYTES}. The tail of the log is preserved
   * — failures usually surface at the end.
   */
  maxBytes?: number;
  /**
   * Ceiling on the bytes pulled off the wire while scanning for the tail
   * (Issue #3710). Defaults to {@link DEFAULT_MAX_STREAM_BYTES}. Past it the
   * stream is cancelled, so an endless console log cannot stream forever.
   */
  maxStreamBytes?: number;
}

/** Coerce an unknown `result` field to the JenkinsBuild union. */
function coerceResult(raw: unknown): JenkinsBuild["result"] {
  if (typeof raw !== "string") return "UNKNOWN";
  switch (raw) {
    case "SUCCESS":
    case "FAILURE":
    case "UNSTABLE":
    case "ABORTED":
      return raw;
    default:
      return "UNKNOWN";
  }
}

/**
 * Fetch a Jenkins build's status (number, result, URL).
 *
 * Calls `${JENKINS_URL}/job/<jobPath>/<build>/api/json` with HTTP Basic
 * auth. Returns a descriptive error string on missing credentials,
 * non-2xx responses, non-JSON bodies, or network failures. The token
 * is never included in returned errors.
 */
export async function fetchJenkinsBuildStatus(
  opts: FetchStatusOptions,
): Promise<Result<JenkinsBuild, string>> {
  const credsResult = loadJenkinsCredentials(opts.readEnv);
  if (!credsResult.ok) return credsResult;
  const { baseUrl, user, token } = credsResult.value;

  const url = buildJenkinsUrl(baseUrl, opts.jobPath, opts.build, "api/json");
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
    return {
      ok: false,
      error: `Jenkins request failed (network): ${
        redactJenkinsSecrets(describeFetchFailure(error, timeoutMs), {
          user,
          token,
        })
      }`,
    };
  }

  if (!response.ok) {
    // Discard the body so the connection is freed without buffering it.
    await discardBody(response);
    return {
      ok: false,
      error: describeJenkinsHttpFailure(
        "status",
        response.status,
        response.statusText,
        opts.jobPath,
      ),
    };
  }

  const bodyResult = await readTextBounded(response, MAX_STATUS_BYTES);
  if (!bodyResult.ok) {
    return {
      ok: false,
      error: `Failed to read Jenkins status response body: ${bodyResult.error}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyResult.value);
  } catch {
    return {
      ok: false,
      error: "Jenkins status response was not valid JSON",
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      error: "Jenkins status response was not a JSON object",
    };
  }

  const obj = parsed as Record<string, unknown>;
  const numberRaw = obj["number"];
  const urlRaw = obj["url"];

  const number = typeof numberRaw === "number" && Number.isFinite(numberRaw)
    ? numberRaw
    : Number(numberRaw);
  if (!Number.isFinite(number)) {
    return {
      ok: false,
      error: "Jenkins status response missing numeric 'number' field",
    };
  }

  const build: JenkinsBuild = {
    number,
    result: coerceResult(obj["result"]),
    url: typeof urlRaw === "string" ? urlRaw : "",
  };

  return { ok: true, value: build };
}

/**
 * Fetch a Jenkins build's console log.
 *
 * Calls `${JENKINS_URL}/job/<jobPath>/<build>/consoleText` with HTTP Basic
 * auth. The response is truncated to `maxBytes` (default 64 KiB),
 * preserving the tail of the log where failures usually surface.
 * The token is never included in returned errors.
 */
export async function fetchJenkinsBuildLog(
  opts: FetchLogOptions,
): Promise<Result<string, string>> {
  const credsResult = loadJenkinsCredentials(opts.readEnv);
  if (!credsResult.ok) return credsResult;
  const { baseUrl, user, token } = credsResult.value;

  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_LOG_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return {
      ok: false,
      error: `maxBytes must be a positive number; got ${opts.maxBytes}`,
    };
  }

  const url = buildJenkinsUrl(baseUrl, opts.jobPath, opts.build, "consoleText");
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
          Accept: "text/plain",
        },
      }, timeoutMs),
    );
  } catch (error: unknown) {
    return {
      ok: false,
      error: `Jenkins request failed (network): ${
        redactJenkinsSecrets(describeFetchFailure(error, timeoutMs), {
          user,
          token,
        })
      }`,
    };
  }

  if (!response.ok) {
    await discardBody(response);
    return {
      ok: false,
      error: describeJenkinsHttpFailure(
        "log",
        response.status,
        response.statusText,
        opts.jobPath,
      ),
    };
  }

  // Issue #3710: stream the body, retaining only the trailing `maxBytes`.
  // Peak memory no longer scales with the log size.
  const readResult = await readTailBounded(
    response,
    maxBytes,
    opts.maxStreamBytes ?? DEFAULT_MAX_STREAM_BYTES,
  );
  if (!readResult.ok) {
    return {
      ok: false,
      error: `Failed to read Jenkins log response body: ${readResult.error}`,
    };
  }

  const { tail, totalBytes, streamCapped } = readResult.value;
  return {
    ok: true,
    value: renderTail(tail, totalBytes, maxBytes, streamCapped),
  };
}

/**
 * Render the retained tail bytes as text. When the head of the log was
 * dropped a short notice is prefixed so readers see why, and the tail is
 * trimmed to keep the whole string within `maxBytes`.
 */
function renderTail(
  tail: Uint8Array,
  totalBytes: number,
  maxBytes: number,
  streamCapped = false,
): string {
  const decoder = new TextDecoder();
  if (totalBytes <= maxBytes && !streamCapped) return decoder.decode(tail);

  // A capped stream was cut mid-body, so `totalBytes` is a floor, not the
  // original size — say so rather than reporting a length we cannot know.
  const size = streamCapped
    ? `at least ${totalBytes} bytes (stream capped)`
    : `${totalBytes} bytes`;
  const notice =
    `[log truncated — original ${size}, showing last ${maxBytes}]\n`;
  const noticeBytes = new TextEncoder().encode(notice);

  // Reserve space for the notice. If the notice is itself larger than
  // maxBytes (degenerate case), the tail budget collapses to zero.
  const tailBudget = Math.max(maxBytes - noticeBytes.byteLength, 0);

  // `decode` with fatal=false replaces any leading bytes that fall in the
  // middle of a UTF-8 codepoint with U+FFFD, acceptable for log output.
  return notice + decoder.decode(tail.subarray(tail.byteLength - tailBudget));
}
