/**
 * npm registry `time`-based dependency-age quarantine (Issue #2799).
 *
 * Some third-party npm packages are invoked as
 * `deno run npm:<pkg>@<version>` subprocess specifiers built from hard-coded
 * TypeScript constants — for example the Playwright MCP server and browser
 * installer in `setup/screenshot.ts`. Because the version lives in a `.ts`
 * string literal rather than `deno.json` `imports` or a `package.json`, it is
 * covered by NEITHER Deno's native `minimumDependencyAge` quarantine (which
 * only gates declared imports) NOR Renovate's `minimumReleaseAge` (Renovate's
 * `deno` manager is disabled and its `npm` manager parses `package.json`, not
 * `.ts` literals). A future manual bump could therefore land a version
 * published only minutes ago, unverified, with full host access.
 *
 * This module closes that gap with an explicit npm-registry `time`-based age
 * check that mirrors `VIBE_BUMP_QUARANTINE_HOURS` (default 24h). It is pure
 * and fully injectable so it can be unit-tested with no network access.
 *
 * **Fail closed (Issue #3711).** Every registry failure — a dropped
 * connection, a 5xx, an unknown version, an unparseable timestamp — funnels
 * into an `indeterminate` verdict. Indeterminate verdicts used to be excluded
 * from the block path, so one failed lookup converted a block into a pass for
 * a package that then ran under `--allow-all`. A lookup that could not be
 * performed is not a lookup that passed: indeterminate now refuses, and the
 * refusal names the failure that caused it.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  describeFetchFailure,
  discardBody,
  withRequestTimeout,
} from "./bounded_fetch.ts";

/** Base URL of the public npm registry. */
export const NPM_REGISTRY_BASE = "https://registry.npmjs.org";

/**
 * Cap on the captured `time` map (16 MiB — Issue #3710, repurposed by
 * Issue #4390). It used to cap the whole packument held in memory, which
 * made every packument over it — playwright-core's is 18 MB — unverifiable;
 * the packument is now streamed and only the map is held.
 */
export const MAX_NPM_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Bounds and injection points for a registry `time` lookup (Issue #3710). */
export interface NpmTimeDataOptions {
  /** Hard request timeout in milliseconds. */
  timeoutMs?: number;
  /**
   * Cap on the packument body streamed while looking for the `time` map; a
   * larger body is refused (stream cancelled), never held. Default
   * {@link MAX_NPM_STREAM_BYTES} — the body is streamed, not buffered
   * (Issue #4390), so the old 16 MiB in-memory cap no longer applies.
   */
  maxBytes?: number;
  /** Cap on the captured `time` map itself (Issue #4390). */
  maxTimeMapBytes?: number;
  /** Injectable fetch function (defaults to `globalThis.fetch`). */
  fetchFn?: (
    url: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/** Default quarantine window in hours (mirrors `VIBE_BUMP_QUARANTINE_HOURS`). */
export const DEFAULT_NPM_QUARANTINE_HOURS = 24;

/** A pinned third-party npm specifier to gate. */
export interface QuarantinedPackage {
  /** Package name, e.g. `@playwright/mcp` or `playwright`. */
  name: string;
  /** Exact pinned version, e.g. `0.0.75`. */
  version: string;
}

/** Outcome of checking a single pinned `package@version`. */
export interface NpmAgeVerdict {
  /** Package name. */
  package: string;
  /** Version that was checked. */
  version: string;
  /** True when the version has been published at least `quarantineHours` ago. */
  eligible: boolean;
  /**
   * True when the publish time could not be determined (registry unreachable,
   * unknown version, or an unparseable timestamp). Indeterminate verdicts
   * **refuse** the package (Issue #3711) — an age nobody could verify is not
   * an age that cleared the window.
   */
  indeterminate: boolean;
  /** Age in hours since publication, or `null` when indeterminate. */
  ageHours: number | null;
  /** ISO publish timestamp, or `null` when indeterminate. */
  publishedAt: string | null;
  /** Human-readable explanation suitable for a log line. */
  reason: string;
}

/** Injectable side-effects for {@link checkNpmVersionAge}. */
export interface NpmAgeFetchDeps {
  /**
   * Return the npm registry `time` map (version → ISO timestamp) for a
   * package. May reject or resolve `undefined` when the lookup fails; either
   * way the package is refused, and a rejection's message is quoted in the
   * verdict so the operator sees *why* the lookup failed.
   */
  fetchTimeData: (pkg: string) => Promise<Record<string, string> | undefined>;
  /** Current wall-clock time. */
  now: () => Date;
}

/** Aggregate report for a batch of pinned packages. */
export interface NpmQuarantineReport {
  /** All verdicts, in input order. */
  verdicts: NpmAgeVerdict[];
  /** Verdicts that are definitively too new (not eligible, not indeterminate). */
  blocked: NpmAgeVerdict[];
  /** Verdicts whose age could not be verified. */
  indeterminate: NpmAgeVerdict[];
  /**
   * Every verdict that refuses the package — `blocked` plus `indeterminate`
   * (Issue #3711). This is the set an operator must be told about.
   */
  refused: NpmAgeVerdict[];
  /** True only when every package positively cleared the window. */
  ok: boolean;
}

/**
 * Build the npm registry metadata URL for a package name.
 *
 * Scoped names (`@scope/name`) contain a `/`; the registry keeps the
 * `@scope/name` path form, so only the embedded slash is percent-encoded.
 */
export function npmRegistryUrl(pkg: string, base = NPM_REGISTRY_BASE): string {
  return `${base}/${pkg.replaceAll("/", "%2F")}`;
}

/**
 * Pure age evaluator: decide whether `pkg@version` clears the quarantine
 * window given the registry `time` map and the current time.
 *
 * A non-positive `quarantineHours` floor makes every known version eligible.
 * `lookupError` carries the message of a failed registry lookup so the refusal
 * names its cause instead of reporting a bare "no publish time".
 */
export function evaluateNpmVersionAge(
  pkg: string,
  version: string,
  timeData: Record<string, string> | undefined,
  quarantineHours: number,
  now: Date,
  lookupError?: string,
): NpmAgeVerdict {
  const floor = Number.isFinite(quarantineHours) && quarantineHours > 0
    ? quarantineHours
    : 0;

  const published = timeData?.[version];
  if (!published) {
    const cause = lookupError
      ? `the registry lookup failed (${lookupError})`
      : `the registry returned no publish time`;
    return {
      package: pkg,
      version,
      eligible: false,
      indeterminate: true,
      ageHours: null,
      publishedAt: null,
      reason: `Cannot verify the ${floor}h quarantine for ${pkg}@${version}: ` +
        `${cause}. Refusing to use an unverified version — an age that could ` +
        `not be checked is not an age that cleared the window.`,
    };
  }

  const publishedMs = Date.parse(published);
  if (Number.isNaN(publishedMs)) {
    return {
      package: pkg,
      version,
      eligible: false,
      indeterminate: true,
      ageHours: null,
      publishedAt: published,
      reason: `Unparseable npm publish timestamp "${published}" for ` +
        `${pkg}@${version}; cannot verify the ${floor}h quarantine, so the ` +
        `version is refused.`,
    };
  }

  const ageHours = (now.getTime() - publishedMs) / 3_600_000;
  const eligible = ageHours >= floor;
  const ageText = `${ageHours.toFixed(1)}h old`;
  return {
    package: pkg,
    version,
    eligible,
    indeterminate: false,
    ageHours,
    publishedAt: published,
    reason: eligible
      ? `${pkg}@${version} is ${ageText} (>= ${floor}h quarantine).`
      : `${pkg}@${version} is only ${ageText} (< ${floor}h quarantine); ` +
        `refusing to use it until it ages past the window.`,
  };
}

/**
 * Default registry fetcher. Requests full package metadata (the abbreviated
 * `install-v1` document omits `time`) and returns its `time` map.
 *
 * Fails loud (Issue #3234): a network, permission, HTTP, or parse failure
 * rejects with a message naming the cause. Callers fold that rejection into an
 * indeterminate verdict, which refuses the package — the cause is never
 * discarded on the way (Issue #3711).
 */
export async function fetchNpmTimeData(
  pkg: string,
  options: number | NpmTimeDataOptions = {},
): Promise<Record<string, string>> {
  // A bare number stays accepted so existing callers reading only the
  // timeout keep working.
  const opts = typeof options === "number" ? { timeoutMs: options } : options;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_NPM_STREAM_BYTES;
  const maxTimeMapBytes = opts.maxTimeMapBytes ?? MAX_NPM_RESPONSE_BYTES;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;

  // Issue #3710: bounded in time (abort signal) and in memory (streaming size
  // cap) so a hung or hostile registry cannot wedge the worker. Every bound
  // breach throws (Issue #3711) — the caller folds it into an indeterminate
  // verdict, which refuses the package.
  let resp: Response;
  try {
    resp = await fetchFn(
      npmRegistryUrl(pkg),
      withRequestTimeout({ method: "GET" }, timeoutMs),
    );
  } catch (error: unknown) {
    throw new Error(
      `npm registry lookup for ${pkg} failed: ${
        describeFetchFailure(error, timeoutMs)
      }`,
    );
  }
  if (!resp.ok) {
    await discardBody(resp);
    throw new Error(
      `npm registry returned HTTP ${resp.status} for ${pkg}`,
    );
  }
  // Issue #4390: the whole packument is never held. playwright-core's is
  // 18 MB — over the old 16 MiB in-memory cap — which left the 24 h
  // quarantine silently unverifiable for exactly the large, widely-used
  // packages. Only the top-level `time` map is extracted from the stream;
  // memory is bounded by the map (a few tens of KB), the body by
  // `maxBodyBytes`, and the whole thing by the request timeout.
  if (!resp.body) {
    throw new Error(`npm registry response for ${pkg} had no body`);
  }
  try {
    return await extractNpmTimeMap(resp.body, {
      maxBodyBytes: maxBytes,
      maxTimeMapBytes,
    });
  } catch (error: unknown) {
    throw new Error(
      `npm registry response for ${pkg} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Cap on the bytes streamed while looking for the `time` map (Issue #4390).
 * Streamed, not held: the largest packuments on npm run to well over 100 MB.
 */
export const MAX_NPM_STREAM_BYTES = 512 * 1024 * 1024;

/** Options for {@link extractNpmTimeMap}. */
export interface ExtractNpmTimeMapOptions {
  /** Give up after streaming this many bytes without a complete map. */
  maxBodyBytes?: number;
  /** Cap on the captured `time` object itself. */
  maxTimeMapBytes?: number;
}

const TIME_KEY_RE = /"time"\s*:\s*\{/;
/** Longest prefix of `"time" : {` that can straddle a chunk boundary. */
const TIME_KEY_TAIL = 32;

/**
 * Stream a packument and return its top-level `time` map without holding
 * the document (Issue #4390).
 *
 * The map is recognised structurally rather than positionally: the first
 * `"time":{…}` object that carries a `created` or `modified` key is the
 * registry's own map (per-version manifests may carry a `time` field of
 * their own from a package.json — those are skipped). Strings inside the
 * map are tracked so a `}` in a value cannot end the capture early. Throws
 * when the body ends or the caps are hit without a complete map.
 */
export async function extractNpmTimeMap(
  body: ReadableStream<Uint8Array>,
  options: ExtractNpmTimeMapOptions = {},
): Promise<Record<string, string>> {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_NPM_STREAM_BYTES;
  const maxTimeMapBytes = options.maxTimeMapBytes ?? MAX_NPM_RESPONSE_BYTES;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  // Searching state: the last few chars of the previous chunk, so a key
  // split across chunks is still found.
  let tail = "";
  // Capturing state.
  let capture: string | undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastCandidate: Record<string, string> | undefined;

  const finish = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      let text = value ? decoder.decode(value, { stream: true }) : "";
      if (done) text += decoder.decode();
      bytesRead += value?.byteLength ?? 0;
      if (bytesRead > maxBodyBytes) {
        throw new Error(
          `packument exceeded the ${maxBodyBytes}-byte streaming cap before a "time" map was found`,
        );
      }

      let cursor = 0;
      while (cursor < text.length || (capture === undefined && done)) {
        if (capture === undefined) {
          const window = tail + text.slice(cursor);
          const m = window.match(TIME_KEY_RE);
          if (!m || m.index === undefined) {
            // No key in this chunk: carry its tail and wait for the next.
            tail = window.slice(-TIME_KEY_TAIL);
            break;
          }
          // Start capturing at the `{`. `window` is `tail + text[cursor..]`,
          // so a match inside the carried tail is re-fed ahead of the text.
          const startInWindow = m.index + m[0].length - 1;
          if (startInWindow >= tail.length) {
            cursor = cursor + (startInWindow - tail.length);
          } else {
            text = window.slice(startInWindow, tail.length) +
              text.slice(cursor);
            cursor = 0;
          }
          tail = "";
          capture = "";
          depth = 0;
          inString = false;
          escaped = false;
        }
        // Capturing: consume until the object closes.
        let closedAt = -1;
        for (let i = cursor; i < text.length; i++) {
          const ch = text[i]!;
          if (inString) {
            if (escaped) escaped = false;
            else if (ch === "\\") escaped = true;
            else if (ch === '"') inString = false;
          } else if (ch === '"') inString = true;
          else if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) {
              closedAt = i;
              break;
            }
          }
        }
        const end = closedAt === -1 ? text.length : closedAt + 1;
        capture += text.slice(cursor, end);
        if (capture.length > maxTimeMapBytes) {
          throw new Error(
            `"time" object exceeded the ${maxTimeMapBytes}-byte cap`,
          );
        }
        cursor = end;
        if (closedAt === -1) break; // need more chunks
        // A complete object: the registry's map carries created/modified.
        let parsed: unknown;
        try {
          parsed = JSON.parse(capture);
        } catch {
          parsed = undefined;
        }
        capture = undefined;
        if (parsed && typeof parsed === "object") {
          if ("modified" in parsed || "created" in parsed) {
            return parsed as Record<string, string>;
          }
          // A registry that omits created/modified: remember the object if
          // it is shaped like a version → date map (a per-version `time`
          // field of some other shape is not). The registry's map comes
          // after `versions`, so the last such candidate wins.
          const entries = Object.values(parsed as Record<string, unknown>);
          if (
            entries.length > 0 &&
            entries.every((v) =>
              typeof v === "string" && !Number.isNaN(Date.parse(v))
            )
          ) {
            lastCandidate = parsed as Record<string, string>;
          }
        }
        tail = "";
      }
      if (done) break;
    }
  } finally {
    // Whatever the exit — found, failed, capped — the registry stream is
    // cancelled, never left draining.
    await finish();
  }
  if (lastCandidate) return lastCandidate;
  throw new Error(`the packument has no top-level "time" map`);
}

/**
 * Check a single pinned `pkg@version` against the quarantine window.
 *
 * A rejected or empty lookup becomes an indeterminate verdict — which refuses
 * the package — with the failure message quoted in the reason.
 */
export async function checkNpmVersionAge(
  pkg: string,
  version: string,
  quarantineHours: number,
  deps: NpmAgeFetchDeps,
): Promise<NpmAgeVerdict> {
  let timeData: Record<string, string> | undefined;
  let lookupError: string | undefined;
  try {
    timeData = await deps.fetchTimeData(pkg);
  } catch (error) {
    timeData = undefined;
    lookupError = error instanceof Error ? error.message : String(error);
  }
  return evaluateNpmVersionAge(
    pkg,
    version,
    timeData,
    quarantineHours,
    deps.now(),
    lookupError,
  );
}

/**
 * Check a batch of pinned packages and classify the outcome.
 *
 * `ok` is true only when every package positively cleared the window. A
 * package that is definitively too new blocks, and so does one whose age could
 * not be verified (Issue #3711) — the gate guards specifiers that then run
 * with full host access, so an unverifiable age must fail closed rather than
 * degrade into a pass. There is deliberately no opt-out: retry once the
 * registry is reachable.
 */
export async function verifyNpmPackagesQuarantine(
  packages: readonly QuarantinedPackage[],
  quarantineHours: number,
  deps: NpmAgeFetchDeps,
): Promise<NpmQuarantineReport> {
  const verdicts: NpmAgeVerdict[] = [];
  for (const p of packages) {
    verdicts.push(
      await checkNpmVersionAge(p.name, p.version, quarantineHours, deps),
    );
  }
  const blocked = verdicts.filter((v) => !v.eligible && !v.indeterminate);
  const indeterminate = verdicts.filter((v) => v.indeterminate);
  const refused = verdicts.filter((v) => !v.eligible);
  return {
    verdicts,
    blocked,
    indeterminate,
    refused,
    ok: refused.length === 0,
  };
}

/** Default production deps: real registry fetch + system clock. */
export function defaultNpmAgeDeps(): NpmAgeFetchDeps {
  return { fetchTimeData: fetchNpmTimeData, now: () => new Date() };
}
