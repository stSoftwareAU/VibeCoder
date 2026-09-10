/**
 * crates.io publish-time resolution for the release-age quarantine
 * (stSoftwareAU/NEAT-AI-scorer#627).
 *
 * The bump audit could resolve npm and JSR publish times only, so a Rust
 * repository's bump was refused wholesale and its dependencies never moved.
 * crates.io serves the release date of a single version directly —
 * `GET /api/v1/crates/<crate>/<version>` → `version.created_at` — which is a
 * far smaller read than the full `…/versions` listing for a crate with
 * hundreds of releases.
 *
 * Bounded in time and in memory like every other registry read
 * (`bounded_fetch.ts`), and injectable so it unit-tests with no network.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  discardBody,
  readTextBounded,
  withRequestTimeout,
} from "./bounded_fetch.ts";

/** Base URL of the public crates.io API. */
export const CRATES_IO_API_BASE = "https://crates.io/api/v1/crates";

/**
 * crates.io rejects a request with no `User-Agent` (HTTP 403) and its
 * crawler policy asks that the agent identify the caller, so the header is
 * set explicitly rather than left to the runtime default.
 */
export const CRATES_IO_USER_AGENT =
  "VibeCoder-release-age-quarantine (+https://github.com/stSoftwareAU/VibeCoder)";

/** Cap on a single-version metadata document (well under 64 KiB in practice). */
export const MAX_CRATES_RESPONSE_BYTES = 1024 * 1024;

/** A crate name crates.io can actually serve. */
const CRATE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A version string safe to place in a URL path segment. */
const CRATE_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]*$/;

/** Bounds and injection points for a crates.io lookup. */
export interface CratesAgeOptions {
  /** Hard request timeout in milliseconds. */
  timeoutMs?: number;
  /** Cap on the response body held in memory. */
  maxBytes?: number;
  /** Injectable fetch function (defaults to `globalThis.fetch`). */
  fetchFn?: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/**
 * Metadata URL for one published crate version.
 *
 * Both segments are validated by the caller and percent-encoded here, so a
 * crafted lockfile entry can never smuggle extra path or query into the
 * request.
 */
export function cratesVersionUrl(crate: string, version: string): string {
  return `${CRATES_IO_API_BASE}/${encodeURIComponent(crate)}/${
    encodeURIComponent(version)
  }`;
}

/** Read `version.created_at` out of a crates.io version document. */
function publishTimeFrom(body: string, version: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  const doc = (parsed as { version?: unknown })?.version;
  if (typeof doc !== "object" || doc === null) return undefined;
  const { num, created_at: createdAt } = doc as {
    num?: unknown;
    created_at?: unknown;
  };
  // A registry that answered about some other release has not answered
  // about this one; treating it as an answer would be a silent pass.
  if (typeof num === "string" && num !== version) return undefined;
  return typeof createdAt === "string" ? createdAt : undefined;
}

/**
 * ISO publish timestamp for `crate@version`, or `undefined` when it cannot
 * be determined. Never throws — an unreachable, slow or unparseable
 * registry yields `undefined`, which the audit reports as an indeterminate
 * verdict rather than a pass.
 */
export async function fetchCratesPublishTime(
  crate: string,
  version: string,
  options: CratesAgeOptions = {},
): Promise<string | undefined> {
  if (!CRATE_NAME_RE.test(crate) || !CRATE_VERSION_RE.test(version)) {
    return undefined;
  }
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  try {
    const response = await fetchFn(
      cratesVersionUrl(crate, version),
      withRequestTimeout(
        {
          method: "GET",
          headers: {
            "accept": "application/json",
            "user-agent": CRATES_IO_USER_AGENT,
          },
        },
        options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      ),
    );
    if (!response.ok) {
      await discardBody(response);
      return undefined;
    }
    const body = await readTextBounded(
      response,
      options.maxBytes ?? MAX_CRATES_RESPONSE_BYTES,
    );
    if (!body.ok) return undefined;
    return publishTimeFrom(body.value, version);
  } catch {
    return undefined;
  }
}
