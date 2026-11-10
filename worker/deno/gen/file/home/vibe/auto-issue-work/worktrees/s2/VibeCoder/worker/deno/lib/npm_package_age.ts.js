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
 */ import { DEFAULT_FETCH_TIMEOUT_MS, describeFetchFailure, discardBody, withRequestTimeout } from "./bounded_fetch.ts";
/** Base URL of the public npm registry. */ export const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
/**
 * Cap on the captured `time` map (16 MiB — Issue #3710, repurposed by
 * Issue #4390). It used to cap the whole packument held in memory, which
 * made every packument over it — playwright-core's is 18 MB — unverifiable;
 * the packument is now streamed and only the map is held.
 */ export const MAX_NPM_RESPONSE_BYTES = 16 * 1024 * 1024;
/** Default quarantine window in hours (mirrors `VIBE_BUMP_QUARANTINE_HOURS`). */ export const DEFAULT_NPM_QUARANTINE_HOURS = 24;
/**
 * Build the npm registry metadata URL for a package name.
 *
 * Scoped names (`@scope/name`) contain a `/`; the registry keeps the
 * `@scope/name` path form, so only the embedded slash is percent-encoded.
 */ export function npmRegistryUrl(pkg, base = NPM_REGISTRY_BASE) {
  return `${base}/${pkg.replaceAll("/", "%2F")}`;
}
/**
 * Pure age evaluator: decide whether `pkg@version` clears the quarantine
 * window given the registry `time` map and the current time.
 *
 * A non-positive `quarantineHours` floor makes every known version eligible.
 * `lookupError` carries the message of a failed registry lookup so the refusal
 * names its cause instead of reporting a bare "no publish time".
 */ export function evaluateNpmVersionAge(pkg, version, timeData, quarantineHours, now, lookupError) {
  const floor = Number.isFinite(quarantineHours) && quarantineHours > 0 ? quarantineHours : 0;
  const published = timeData?.[version];
  if (!published) {
    const cause = lookupError ? `the registry lookup failed (${lookupError})` : `the registry returned no publish time`;
    return {
      package: pkg,
      version,
      eligible: false,
      indeterminate: true,
      ageHours: null,
      publishedAt: null,
      reason: `Cannot verify the ${floor}h quarantine for ${pkg}@${version}: ` + `${cause}. Refusing to use an unverified version — an age that could ` + `not be checked is not an age that cleared the window.`
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
      reason: `Unparseable npm publish timestamp "${published}" for ` + `${pkg}@${version}; cannot verify the ${floor}h quarantine, so the ` + `version is refused.`
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
    reason: eligible ? `${pkg}@${version} is ${ageText} (>= ${floor}h quarantine).` : `${pkg}@${version} is only ${ageText} (< ${floor}h quarantine); ` + `refusing to use it until it ages past the window.`
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
 */ export async function fetchNpmTimeData(pkg, options = {}) {
  // A bare number stays accepted so existing callers reading only the
  // timeout keep working.
  const opts = typeof options === "number" ? {
    timeoutMs: options
  } : options;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_NPM_STREAM_BYTES;
  const maxTimeMapBytes = opts.maxTimeMapBytes ?? MAX_NPM_RESPONSE_BYTES;
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  // Issue #3710: bounded in time (abort signal) and in memory (streaming size
  // cap) so a hung or hostile registry cannot wedge the worker. Every bound
  // breach throws (Issue #3711) — the caller folds it into an indeterminate
  // verdict, which refuses the package.
  let resp;
  try {
    resp = await fetchFn(npmRegistryUrl(pkg), withRequestTimeout({
      method: "GET"
    }, timeoutMs));
  } catch (error) {
    throw new Error(`npm registry lookup for ${pkg} failed: ${describeFetchFailure(error, timeoutMs)}`);
  }
  if (!resp.ok) {
    await discardBody(resp);
    throw new Error(`npm registry returned HTTP ${resp.status} for ${pkg}`);
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
      maxTimeMapBytes
    });
  } catch (error) {
    throw new Error(`npm registry response for ${pkg} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}
/**
 * Cap on the bytes streamed while looking for the `time` map (Issue #4390).
 * Streamed, not held: the largest packuments on npm run to well over 100 MB.
 */ export const MAX_NPM_STREAM_BYTES = 512 * 1024 * 1024;
const TIME_KEY_RE = /"time"\s*:\s*\{/;
/** Longest prefix of `"time" : {` that can straddle a chunk boundary. */ const TIME_KEY_TAIL = 32;
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
 */ export async function extractNpmTimeMap(body, options = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? MAX_NPM_STREAM_BYTES;
  const maxTimeMapBytes = options.maxTimeMapBytes ?? MAX_NPM_RESPONSE_BYTES;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  // Searching state: the last few chars of the previous chunk, so a key
  // split across chunks is still found.
  let tail = "";
  // Capturing state.
  let capture;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let lastCandidate;
  const finish = async ()=>{
    try {
      await reader.cancel();
    } catch  {
    // Already closed.
    }
  };
  try {
    while(true){
      const { value, done } = await reader.read();
      let text = value ? decoder.decode(value, {
        stream: true
      }) : "";
      if (done) text += decoder.decode();
      bytesRead += value?.byteLength ?? 0;
      if (bytesRead > maxBodyBytes) {
        throw new Error(`packument exceeded the ${maxBodyBytes}-byte streaming cap before a "time" map was found`);
      }
      let cursor = 0;
      while(cursor < text.length || capture === undefined && done){
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
            text = window.slice(startInWindow, tail.length) + text.slice(cursor);
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
        for(let i = cursor; i < text.length; i++){
          const ch = text[i];
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
          throw new Error(`"time" object exceeded the ${maxTimeMapBytes}-byte cap`);
        }
        cursor = end;
        if (closedAt === -1) break; // need more chunks
        // A complete object: the registry's map carries created/modified.
        let parsed;
        try {
          parsed = JSON.parse(capture);
        } catch  {
          parsed = undefined;
        }
        capture = undefined;
        if (parsed && typeof parsed === "object") {
          if ("modified" in parsed || "created" in parsed) {
            return parsed;
          }
          // A registry that omits created/modified: remember the object if
          // it is shaped like a version → date map (a per-version `time`
          // field of some other shape is not). The registry's map comes
          // after `versions`, so the last such candidate wins.
          const entries = Object.values(parsed);
          if (entries.length > 0 && entries.every((v)=>typeof v === "string" && !Number.isNaN(Date.parse(v)))) {
            lastCandidate = parsed;
          }
        }
        tail = "";
      }
      if (done) break;
    }
  } finally{
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
 */ export async function checkNpmVersionAge(pkg, version, quarantineHours, deps) {
  let timeData;
  let lookupError;
  try {
    timeData = await deps.fetchTimeData(pkg);
  } catch (error) {
    timeData = undefined;
    lookupError = error instanceof Error ? error.message : String(error);
  }
  return evaluateNpmVersionAge(pkg, version, timeData, quarantineHours, deps.now(), lookupError);
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
 */ export async function verifyNpmPackagesQuarantine(packages, quarantineHours, deps) {
  const verdicts = [];
  for (const p of packages){
    verdicts.push(await checkNpmVersionAge(p.name, p.version, quarantineHours, deps));
  }
  const blocked = verdicts.filter((v)=>!v.eligible && !v.indeterminate);
  const indeterminate = verdicts.filter((v)=>v.indeterminate);
  const refused = verdicts.filter((v)=>!v.eligible);
  return {
    verdicts,
    blocked,
    indeterminate,
    refused,
    ok: refused.length === 0
  };
}
/** Default production deps: real registry fetch + system clock. */ export function defaultNpmAgeDeps() {
  return {
    fetchTimeData: fetchNpmTimeData,
    now: ()=>new Date()
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ucG1fcGFja2FnZV9hZ2UudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBucG0gcmVnaXN0cnkgYHRpbWVgLWJhc2VkIGRlcGVuZGVuY3ktYWdlIHF1YXJhbnRpbmUgKElzc3VlICMyNzk5KS5cbiAqXG4gKiBTb21lIHRoaXJkLXBhcnR5IG5wbSBwYWNrYWdlcyBhcmUgaW52b2tlZCBhc1xuICogYGRlbm8gcnVuIG5wbTo8cGtnPkA8dmVyc2lvbj5gIHN1YnByb2Nlc3Mgc3BlY2lmaWVycyBidWlsdCBmcm9tIGhhcmQtY29kZWRcbiAqIFR5cGVTY3JpcHQgY29uc3RhbnRzIOKAlCBmb3IgZXhhbXBsZSB0aGUgUGxheXdyaWdodCBNQ1Agc2VydmVyIGFuZCBicm93c2VyXG4gKiBpbnN0YWxsZXIgaW4gYHNldHVwL3NjcmVlbnNob3QudHNgLiBCZWNhdXNlIHRoZSB2ZXJzaW9uIGxpdmVzIGluIGEgYC50c2BcbiAqIHN0cmluZyBsaXRlcmFsIHJhdGhlciB0aGFuIGBkZW5vLmpzb25gIGBpbXBvcnRzYCBvciBhIGBwYWNrYWdlLmpzb25gLCBpdCBpc1xuICogY292ZXJlZCBieSBORUlUSEVSIERlbm8ncyBuYXRpdmUgYG1pbmltdW1EZXBlbmRlbmN5QWdlYCBxdWFyYW50aW5lICh3aGljaFxuICogb25seSBnYXRlcyBkZWNsYXJlZCBpbXBvcnRzKSBOT1IgUmVub3ZhdGUncyBgbWluaW11bVJlbGVhc2VBZ2VgIChSZW5vdmF0ZSdzXG4gKiBgZGVub2AgbWFuYWdlciBpcyBkaXNhYmxlZCBhbmQgaXRzIGBucG1gIG1hbmFnZXIgcGFyc2VzIGBwYWNrYWdlLmpzb25gLCBub3RcbiAqIGAudHNgIGxpdGVyYWxzKS4gQSBmdXR1cmUgbWFudWFsIGJ1bXAgY291bGQgdGhlcmVmb3JlIGxhbmQgYSB2ZXJzaW9uXG4gKiBwdWJsaXNoZWQgb25seSBtaW51dGVzIGFnbywgdW52ZXJpZmllZCwgd2l0aCBmdWxsIGhvc3QgYWNjZXNzLlxuICpcbiAqIFRoaXMgbW9kdWxlIGNsb3NlcyB0aGF0IGdhcCB3aXRoIGFuIGV4cGxpY2l0IG5wbS1yZWdpc3RyeSBgdGltZWAtYmFzZWQgYWdlXG4gKiBjaGVjayB0aGF0IG1pcnJvcnMgYFZJQkVfQlVNUF9RVUFSQU5USU5FX0hPVVJTYCAoZGVmYXVsdCAyNGgpLiBJdCBpcyBwdXJlXG4gKiBhbmQgZnVsbHkgaW5qZWN0YWJsZSBzbyBpdCBjYW4gYmUgdW5pdC10ZXN0ZWQgd2l0aCBubyBuZXR3b3JrIGFjY2Vzcy5cbiAqXG4gKiAqKkZhaWwgY2xvc2VkIChJc3N1ZSAjMzcxMSkuKiogRXZlcnkgcmVnaXN0cnkgZmFpbHVyZSDigJQgYSBkcm9wcGVkXG4gKiBjb25uZWN0aW9uLCBhIDV4eCwgYW4gdW5rbm93biB2ZXJzaW9uLCBhbiB1bnBhcnNlYWJsZSB0aW1lc3RhbXAg4oCUIGZ1bm5lbHNcbiAqIGludG8gYW4gYGluZGV0ZXJtaW5hdGVgIHZlcmRpY3QuIEluZGV0ZXJtaW5hdGUgdmVyZGljdHMgdXNlZCB0byBiZSBleGNsdWRlZFxuICogZnJvbSB0aGUgYmxvY2sgcGF0aCwgc28gb25lIGZhaWxlZCBsb29rdXAgY29udmVydGVkIGEgYmxvY2sgaW50byBhIHBhc3MgZm9yXG4gKiBhIHBhY2thZ2UgdGhhdCB0aGVuIHJhbiB1bmRlciBgLS1hbGxvdy1hbGxgLiBBIGxvb2t1cCB0aGF0IGNvdWxkIG5vdCBiZVxuICogcGVyZm9ybWVkIGlzIG5vdCBhIGxvb2t1cCB0aGF0IHBhc3NlZDogaW5kZXRlcm1pbmF0ZSBub3cgcmVmdXNlcywgYW5kIHRoZVxuICogcmVmdXNhbCBuYW1lcyB0aGUgZmFpbHVyZSB0aGF0IGNhdXNlZCBpdC5cbiAqXG4gKiBBdXN0cmFsaWFuIEVuZ2xpc2ggdXNlZCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbiwgZXRjLikuXG4gKi9cblxuaW1wb3J0IHtcbiAgREVGQVVMVF9GRVRDSF9USU1FT1VUX01TLFxuICBkZXNjcmliZUZldGNoRmFpbHVyZSxcbiAgZGlzY2FyZEJvZHksXG4gIHdpdGhSZXF1ZXN0VGltZW91dCxcbn0gZnJvbSBcIi4vYm91bmRlZF9mZXRjaC50c1wiO1xuXG4vKiogQmFzZSBVUkwgb2YgdGhlIHB1YmxpYyBucG0gcmVnaXN0cnkuICovXG5leHBvcnQgY29uc3QgTlBNX1JFR0lTVFJZX0JBU0UgPSBcImh0dHBzOi8vcmVnaXN0cnkubnBtanMub3JnXCI7XG5cbi8qKlxuICogQ2FwIG9uIHRoZSBjYXB0dXJlZCBgdGltZWAgbWFwICgxNiBNaUIg4oCUIElzc3VlICMzNzEwLCByZXB1cnBvc2VkIGJ5XG4gKiBJc3N1ZSAjNDM5MCkuIEl0IHVzZWQgdG8gY2FwIHRoZSB3aG9sZSBwYWNrdW1lbnQgaGVsZCBpbiBtZW1vcnksIHdoaWNoXG4gKiBtYWRlIGV2ZXJ5IHBhY2t1bWVudCBvdmVyIGl0IOKAlCBwbGF5d3JpZ2h0LWNvcmUncyBpcyAxOCBNQiDigJQgdW52ZXJpZmlhYmxlO1xuICogdGhlIHBhY2t1bWVudCBpcyBub3cgc3RyZWFtZWQgYW5kIG9ubHkgdGhlIG1hcCBpcyBoZWxkLlxuICovXG5leHBvcnQgY29uc3QgTUFYX05QTV9SRVNQT05TRV9CWVRFUyA9IDE2ICogMTAyNCAqIDEwMjQ7XG5cbi8qKiBCb3VuZHMgYW5kIGluamVjdGlvbiBwb2ludHMgZm9yIGEgcmVnaXN0cnkgYHRpbWVgIGxvb2t1cCAoSXNzdWUgIzM3MTApLiAqL1xuZXhwb3J0IGludGVyZmFjZSBOcG1UaW1lRGF0YU9wdGlvbnMge1xuICAvKiogSGFyZCByZXF1ZXN0IHRpbWVvdXQgaW4gbWlsbGlzZWNvbmRzLiAqL1xuICB0aW1lb3V0TXM/OiBudW1iZXI7XG4gIC8qKlxuICAgKiBDYXAgb24gdGhlIHBhY2t1bWVudCBib2R5IHN0cmVhbWVkIHdoaWxlIGxvb2tpbmcgZm9yIHRoZSBgdGltZWAgbWFwOyBhXG4gICAqIGxhcmdlciBib2R5IGlzIHJlZnVzZWQgKHN0cmVhbSBjYW5jZWxsZWQpLCBuZXZlciBoZWxkLiBEZWZhdWx0XG4gICAqIHtAbGluayBNQVhfTlBNX1NUUkVBTV9CWVRFU30g4oCUIHRoZSBib2R5IGlzIHN0cmVhbWVkLCBub3QgYnVmZmVyZWRcbiAgICogKElzc3VlICM0MzkwKSwgc28gdGhlIG9sZCAxNiBNaUIgaW4tbWVtb3J5IGNhcCBubyBsb25nZXIgYXBwbGllcy5cbiAgICovXG4gIG1heEJ5dGVzPzogbnVtYmVyO1xuICAvKiogQ2FwIG9uIHRoZSBjYXB0dXJlZCBgdGltZWAgbWFwIGl0c2VsZiAoSXNzdWUgIzQzOTApLiAqL1xuICBtYXhUaW1lTWFwQnl0ZXM/OiBudW1iZXI7XG4gIC8qKiBJbmplY3RhYmxlIGZldGNoIGZ1bmN0aW9uIChkZWZhdWx0cyB0byBgZ2xvYmFsVGhpcy5mZXRjaGApLiAqL1xuICBmZXRjaEZuPzogKFxuICAgIHVybDogc3RyaW5nIHwgVVJMIHwgUmVxdWVzdCxcbiAgICBpbml0PzogUmVxdWVzdEluaXQsXG4gICkgPT4gUHJvbWlzZTxSZXNwb25zZT47XG59XG5cbi8qKiBEZWZhdWx0IHF1YXJhbnRpbmUgd2luZG93IGluIGhvdXJzIChtaXJyb3JzIGBWSUJFX0JVTVBfUVVBUkFOVElORV9IT1VSU2ApLiAqL1xuZXhwb3J0IGNvbnN0IERFRkFVTFRfTlBNX1FVQVJBTlRJTkVfSE9VUlMgPSAyNDtcblxuLyoqIEEgcGlubmVkIHRoaXJkLXBhcnR5IG5wbSBzcGVjaWZpZXIgdG8gZ2F0ZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUXVhcmFudGluZWRQYWNrYWdlIHtcbiAgLyoqIFBhY2thZ2UgbmFtZSwgZS5nLiBgQHBsYXl3cmlnaHQvbWNwYCBvciBgcGxheXdyaWdodGAuICovXG4gIG5hbWU6IHN0cmluZztcbiAgLyoqIEV4YWN0IHBpbm5lZCB2ZXJzaW9uLCBlLmcuIGAwLjAuNzVgLiAqL1xuICB2ZXJzaW9uOiBzdHJpbmc7XG59XG5cbi8qKiBPdXRjb21lIG9mIGNoZWNraW5nIGEgc2luZ2xlIHBpbm5lZCBgcGFja2FnZUB2ZXJzaW9uYC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTnBtQWdlVmVyZGljdCB7XG4gIC8qKiBQYWNrYWdlIG5hbWUuICovXG4gIHBhY2thZ2U6IHN0cmluZztcbiAgLyoqIFZlcnNpb24gdGhhdCB3YXMgY2hlY2tlZC4gKi9cbiAgdmVyc2lvbjogc3RyaW5nO1xuICAvKiogVHJ1ZSB3aGVuIHRoZSB2ZXJzaW9uIGhhcyBiZWVuIHB1Ymxpc2hlZCBhdCBsZWFzdCBgcXVhcmFudGluZUhvdXJzYCBhZ28uICovXG4gIGVsaWdpYmxlOiBib29sZWFuO1xuICAvKipcbiAgICogVHJ1ZSB3aGVuIHRoZSBwdWJsaXNoIHRpbWUgY291bGQgbm90IGJlIGRldGVybWluZWQgKHJlZ2lzdHJ5IHVucmVhY2hhYmxlLFxuICAgKiB1bmtub3duIHZlcnNpb24sIG9yIGFuIHVucGFyc2VhYmxlIHRpbWVzdGFtcCkuIEluZGV0ZXJtaW5hdGUgdmVyZGljdHNcbiAgICogKipyZWZ1c2UqKiB0aGUgcGFja2FnZSAoSXNzdWUgIzM3MTEpIOKAlCBhbiBhZ2Ugbm9ib2R5IGNvdWxkIHZlcmlmeSBpcyBub3RcbiAgICogYW4gYWdlIHRoYXQgY2xlYXJlZCB0aGUgd2luZG93LlxuICAgKi9cbiAgaW5kZXRlcm1pbmF0ZTogYm9vbGVhbjtcbiAgLyoqIEFnZSBpbiBob3VycyBzaW5jZSBwdWJsaWNhdGlvbiwgb3IgYG51bGxgIHdoZW4gaW5kZXRlcm1pbmF0ZS4gKi9cbiAgYWdlSG91cnM6IG51bWJlciB8IG51bGw7XG4gIC8qKiBJU08gcHVibGlzaCB0aW1lc3RhbXAsIG9yIGBudWxsYCB3aGVuIGluZGV0ZXJtaW5hdGUuICovXG4gIHB1Ymxpc2hlZEF0OiBzdHJpbmcgfCBudWxsO1xuICAvKiogSHVtYW4tcmVhZGFibGUgZXhwbGFuYXRpb24gc3VpdGFibGUgZm9yIGEgbG9nIGxpbmUuICovXG4gIHJlYXNvbjogc3RyaW5nO1xufVxuXG4vKiogSW5qZWN0YWJsZSBzaWRlLWVmZmVjdHMgZm9yIHtAbGluayBjaGVja05wbVZlcnNpb25BZ2V9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBOcG1BZ2VGZXRjaERlcHMge1xuICAvKipcbiAgICogUmV0dXJuIHRoZSBucG0gcmVnaXN0cnkgYHRpbWVgIG1hcCAodmVyc2lvbiDihpIgSVNPIHRpbWVzdGFtcCkgZm9yIGFcbiAgICogcGFja2FnZS4gTWF5IHJlamVjdCBvciByZXNvbHZlIGB1bmRlZmluZWRgIHdoZW4gdGhlIGxvb2t1cCBmYWlsczsgZWl0aGVyXG4gICAqIHdheSB0aGUgcGFja2FnZSBpcyByZWZ1c2VkLCBhbmQgYSByZWplY3Rpb24ncyBtZXNzYWdlIGlzIHF1b3RlZCBpbiB0aGVcbiAgICogdmVyZGljdCBzbyB0aGUgb3BlcmF0b3Igc2VlcyAqd2h5KiB0aGUgbG9va3VwIGZhaWxlZC5cbiAgICovXG4gIGZldGNoVGltZURhdGE6IChwa2c6IHN0cmluZykgPT4gUHJvbWlzZTxSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgdW5kZWZpbmVkPjtcbiAgLyoqIEN1cnJlbnQgd2FsbC1jbG9jayB0aW1lLiAqL1xuICBub3c6ICgpID0+IERhdGU7XG59XG5cbi8qKiBBZ2dyZWdhdGUgcmVwb3J0IGZvciBhIGJhdGNoIG9mIHBpbm5lZCBwYWNrYWdlcy4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgTnBtUXVhcmFudGluZVJlcG9ydCB7XG4gIC8qKiBBbGwgdmVyZGljdHMsIGluIGlucHV0IG9yZGVyLiAqL1xuICB2ZXJkaWN0czogTnBtQWdlVmVyZGljdFtdO1xuICAvKiogVmVyZGljdHMgdGhhdCBhcmUgZGVmaW5pdGl2ZWx5IHRvbyBuZXcgKG5vdCBlbGlnaWJsZSwgbm90IGluZGV0ZXJtaW5hdGUpLiAqL1xuICBibG9ja2VkOiBOcG1BZ2VWZXJkaWN0W107XG4gIC8qKiBWZXJkaWN0cyB3aG9zZSBhZ2UgY291bGQgbm90IGJlIHZlcmlmaWVkLiAqL1xuICBpbmRldGVybWluYXRlOiBOcG1BZ2VWZXJkaWN0W107XG4gIC8qKlxuICAgKiBFdmVyeSB2ZXJkaWN0IHRoYXQgcmVmdXNlcyB0aGUgcGFja2FnZSDigJQgYGJsb2NrZWRgIHBsdXMgYGluZGV0ZXJtaW5hdGVgXG4gICAqIChJc3N1ZSAjMzcxMSkuIFRoaXMgaXMgdGhlIHNldCBhbiBvcGVyYXRvciBtdXN0IGJlIHRvbGQgYWJvdXQuXG4gICAqL1xuICByZWZ1c2VkOiBOcG1BZ2VWZXJkaWN0W107XG4gIC8qKiBUcnVlIG9ubHkgd2hlbiBldmVyeSBwYWNrYWdlIHBvc2l0aXZlbHkgY2xlYXJlZCB0aGUgd2luZG93LiAqL1xuICBvazogYm9vbGVhbjtcbn1cblxuLyoqXG4gKiBCdWlsZCB0aGUgbnBtIHJlZ2lzdHJ5IG1ldGFkYXRhIFVSTCBmb3IgYSBwYWNrYWdlIG5hbWUuXG4gKlxuICogU2NvcGVkIG5hbWVzIChgQHNjb3BlL25hbWVgKSBjb250YWluIGEgYC9gOyB0aGUgcmVnaXN0cnkga2VlcHMgdGhlXG4gKiBgQHNjb3BlL25hbWVgIHBhdGggZm9ybSwgc28gb25seSB0aGUgZW1iZWRkZWQgc2xhc2ggaXMgcGVyY2VudC1lbmNvZGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gbnBtUmVnaXN0cnlVcmwocGtnOiBzdHJpbmcsIGJhc2UgPSBOUE1fUkVHSVNUUllfQkFTRSk6IHN0cmluZyB7XG4gIHJldHVybiBgJHtiYXNlfS8ke3BrZy5yZXBsYWNlQWxsKFwiL1wiLCBcIiUyRlwiKX1gO1xufVxuXG4vKipcbiAqIFB1cmUgYWdlIGV2YWx1YXRvcjogZGVjaWRlIHdoZXRoZXIgYHBrZ0B2ZXJzaW9uYCBjbGVhcnMgdGhlIHF1YXJhbnRpbmVcbiAqIHdpbmRvdyBnaXZlbiB0aGUgcmVnaXN0cnkgYHRpbWVgIG1hcCBhbmQgdGhlIGN1cnJlbnQgdGltZS5cbiAqXG4gKiBBIG5vbi1wb3NpdGl2ZSBgcXVhcmFudGluZUhvdXJzYCBmbG9vciBtYWtlcyBldmVyeSBrbm93biB2ZXJzaW9uIGVsaWdpYmxlLlxuICogYGxvb2t1cEVycm9yYCBjYXJyaWVzIHRoZSBtZXNzYWdlIG9mIGEgZmFpbGVkIHJlZ2lzdHJ5IGxvb2t1cCBzbyB0aGUgcmVmdXNhbFxuICogbmFtZXMgaXRzIGNhdXNlIGluc3RlYWQgb2YgcmVwb3J0aW5nIGEgYmFyZSBcIm5vIHB1Ymxpc2ggdGltZVwiLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZXZhbHVhdGVOcG1WZXJzaW9uQWdlKFxuICBwa2c6IHN0cmluZyxcbiAgdmVyc2lvbjogc3RyaW5nLFxuICB0aW1lRGF0YTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZCxcbiAgcXVhcmFudGluZUhvdXJzOiBudW1iZXIsXG4gIG5vdzogRGF0ZSxcbiAgbG9va3VwRXJyb3I/OiBzdHJpbmcsXG4pOiBOcG1BZ2VWZXJkaWN0IHtcbiAgY29uc3QgZmxvb3IgPSBOdW1iZXIuaXNGaW5pdGUocXVhcmFudGluZUhvdXJzKSAmJiBxdWFyYW50aW5lSG91cnMgPiAwXG4gICAgPyBxdWFyYW50aW5lSG91cnNcbiAgICA6IDA7XG5cbiAgY29uc3QgcHVibGlzaGVkID0gdGltZURhdGE/Llt2ZXJzaW9uXTtcbiAgaWYgKCFwdWJsaXNoZWQpIHtcbiAgICBjb25zdCBjYXVzZSA9IGxvb2t1cEVycm9yXG4gICAgICA/IGB0aGUgcmVnaXN0cnkgbG9va3VwIGZhaWxlZCAoJHtsb29rdXBFcnJvcn0pYFxuICAgICAgOiBgdGhlIHJlZ2lzdHJ5IHJldHVybmVkIG5vIHB1Ymxpc2ggdGltZWA7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhY2thZ2U6IHBrZyxcbiAgICAgIHZlcnNpb24sXG4gICAgICBlbGlnaWJsZTogZmFsc2UsXG4gICAgICBpbmRldGVybWluYXRlOiB0cnVlLFxuICAgICAgYWdlSG91cnM6IG51bGwsXG4gICAgICBwdWJsaXNoZWRBdDogbnVsbCxcbiAgICAgIHJlYXNvbjogYENhbm5vdCB2ZXJpZnkgdGhlICR7Zmxvb3J9aCBxdWFyYW50aW5lIGZvciAke3BrZ31AJHt2ZXJzaW9ufTogYCArXG4gICAgICAgIGAke2NhdXNlfS4gUmVmdXNpbmcgdG8gdXNlIGFuIHVudmVyaWZpZWQgdmVyc2lvbiDigJQgYW4gYWdlIHRoYXQgY291bGQgYCArXG4gICAgICAgIGBub3QgYmUgY2hlY2tlZCBpcyBub3QgYW4gYWdlIHRoYXQgY2xlYXJlZCB0aGUgd2luZG93LmAsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHB1Ymxpc2hlZE1zID0gRGF0ZS5wYXJzZShwdWJsaXNoZWQpO1xuICBpZiAoTnVtYmVyLmlzTmFOKHB1Ymxpc2hlZE1zKSkge1xuICAgIHJldHVybiB7XG4gICAgICBwYWNrYWdlOiBwa2csXG4gICAgICB2ZXJzaW9uLFxuICAgICAgZWxpZ2libGU6IGZhbHNlLFxuICAgICAgaW5kZXRlcm1pbmF0ZTogdHJ1ZSxcbiAgICAgIGFnZUhvdXJzOiBudWxsLFxuICAgICAgcHVibGlzaGVkQXQ6IHB1Ymxpc2hlZCxcbiAgICAgIHJlYXNvbjogYFVucGFyc2VhYmxlIG5wbSBwdWJsaXNoIHRpbWVzdGFtcCBcIiR7cHVibGlzaGVkfVwiIGZvciBgICtcbiAgICAgICAgYCR7cGtnfUAke3ZlcnNpb259OyBjYW5ub3QgdmVyaWZ5IHRoZSAke2Zsb29yfWggcXVhcmFudGluZSwgc28gdGhlIGAgK1xuICAgICAgICBgdmVyc2lvbiBpcyByZWZ1c2VkLmAsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGFnZUhvdXJzID0gKG5vdy5nZXRUaW1lKCkgLSBwdWJsaXNoZWRNcykgLyAzXzYwMF8wMDA7XG4gIGNvbnN0IGVsaWdpYmxlID0gYWdlSG91cnMgPj0gZmxvb3I7XG4gIGNvbnN0IGFnZVRleHQgPSBgJHthZ2VIb3Vycy50b0ZpeGVkKDEpfWggb2xkYDtcbiAgcmV0dXJuIHtcbiAgICBwYWNrYWdlOiBwa2csXG4gICAgdmVyc2lvbixcbiAgICBlbGlnaWJsZSxcbiAgICBpbmRldGVybWluYXRlOiBmYWxzZSxcbiAgICBhZ2VIb3VycyxcbiAgICBwdWJsaXNoZWRBdDogcHVibGlzaGVkLFxuICAgIHJlYXNvbjogZWxpZ2libGVcbiAgICAgID8gYCR7cGtnfUAke3ZlcnNpb259IGlzICR7YWdlVGV4dH0gKD49ICR7Zmxvb3J9aCBxdWFyYW50aW5lKS5gXG4gICAgICA6IGAke3BrZ31AJHt2ZXJzaW9ufSBpcyBvbmx5ICR7YWdlVGV4dH0gKDwgJHtmbG9vcn1oIHF1YXJhbnRpbmUpOyBgICtcbiAgICAgICAgYHJlZnVzaW5nIHRvIHVzZSBpdCB1bnRpbCBpdCBhZ2VzIHBhc3QgdGhlIHdpbmRvdy5gLFxuICB9O1xufVxuXG4vKipcbiAqIERlZmF1bHQgcmVnaXN0cnkgZmV0Y2hlci4gUmVxdWVzdHMgZnVsbCBwYWNrYWdlIG1ldGFkYXRhICh0aGUgYWJicmV2aWF0ZWRcbiAqIGBpbnN0YWxsLXYxYCBkb2N1bWVudCBvbWl0cyBgdGltZWApIGFuZCByZXR1cm5zIGl0cyBgdGltZWAgbWFwLlxuICpcbiAqIEZhaWxzIGxvdWQgKElzc3VlICMzMjM0KTogYSBuZXR3b3JrLCBwZXJtaXNzaW9uLCBIVFRQLCBvciBwYXJzZSBmYWlsdXJlXG4gKiByZWplY3RzIHdpdGggYSBtZXNzYWdlIG5hbWluZyB0aGUgY2F1c2UuIENhbGxlcnMgZm9sZCB0aGF0IHJlamVjdGlvbiBpbnRvIGFuXG4gKiBpbmRldGVybWluYXRlIHZlcmRpY3QsIHdoaWNoIHJlZnVzZXMgdGhlIHBhY2thZ2Ug4oCUIHRoZSBjYXVzZSBpcyBuZXZlclxuICogZGlzY2FyZGVkIG9uIHRoZSB3YXkgKElzc3VlICMzNzExKS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoTnBtVGltZURhdGEoXG4gIHBrZzogc3RyaW5nLFxuICBvcHRpb25zOiBudW1iZXIgfCBOcG1UaW1lRGF0YU9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4ge1xuICAvLyBBIGJhcmUgbnVtYmVyIHN0YXlzIGFjY2VwdGVkIHNvIGV4aXN0aW5nIGNhbGxlcnMgcmVhZGluZyBvbmx5IHRoZVxuICAvLyB0aW1lb3V0IGtlZXAgd29ya2luZy5cbiAgY29uc3Qgb3B0cyA9IHR5cGVvZiBvcHRpb25zID09PSBcIm51bWJlclwiID8geyB0aW1lb3V0TXM6IG9wdGlvbnMgfSA6IG9wdGlvbnM7XG4gIGNvbnN0IHRpbWVvdXRNcyA9IG9wdHMudGltZW91dE1zID8/IERFRkFVTFRfRkVUQ0hfVElNRU9VVF9NUztcbiAgY29uc3QgbWF4Qnl0ZXMgPSBvcHRzLm1heEJ5dGVzID8/IE1BWF9OUE1fU1RSRUFNX0JZVEVTO1xuICBjb25zdCBtYXhUaW1lTWFwQnl0ZXMgPSBvcHRzLm1heFRpbWVNYXBCeXRlcyA/PyBNQVhfTlBNX1JFU1BPTlNFX0JZVEVTO1xuICBjb25zdCBmZXRjaEZuID0gb3B0cy5mZXRjaEZuID8/IGdsb2JhbFRoaXMuZmV0Y2g7XG5cbiAgLy8gSXNzdWUgIzM3MTA6IGJvdW5kZWQgaW4gdGltZSAoYWJvcnQgc2lnbmFsKSBhbmQgaW4gbWVtb3J5IChzdHJlYW1pbmcgc2l6ZVxuICAvLyBjYXApIHNvIGEgaHVuZyBvciBob3N0aWxlIHJlZ2lzdHJ5IGNhbm5vdCB3ZWRnZSB0aGUgd29ya2VyLiBFdmVyeSBib3VuZFxuICAvLyBicmVhY2ggdGhyb3dzIChJc3N1ZSAjMzcxMSkg4oCUIHRoZSBjYWxsZXIgZm9sZHMgaXQgaW50byBhbiBpbmRldGVybWluYXRlXG4gIC8vIHZlcmRpY3QsIHdoaWNoIHJlZnVzZXMgdGhlIHBhY2thZ2UuXG4gIGxldCByZXNwOiBSZXNwb25zZTtcbiAgdHJ5IHtcbiAgICByZXNwID0gYXdhaXQgZmV0Y2hGbihcbiAgICAgIG5wbVJlZ2lzdHJ5VXJsKHBrZyksXG4gICAgICB3aXRoUmVxdWVzdFRpbWVvdXQoeyBtZXRob2Q6IFwiR0VUXCIgfSwgdGltZW91dE1zKSxcbiAgICApO1xuICB9IGNhdGNoIChlcnJvcjogdW5rbm93bikge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBucG0gcmVnaXN0cnkgbG9va3VwIGZvciAke3BrZ30gZmFpbGVkOiAke1xuICAgICAgICBkZXNjcmliZUZldGNoRmFpbHVyZShlcnJvciwgdGltZW91dE1zKVxuICAgICAgfWAsXG4gICAgKTtcbiAgfVxuICBpZiAoIXJlc3Aub2spIHtcbiAgICBhd2FpdCBkaXNjYXJkQm9keShyZXNwKTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgbnBtIHJlZ2lzdHJ5IHJldHVybmVkIEhUVFAgJHtyZXNwLnN0YXR1c30gZm9yICR7cGtnfWAsXG4gICAgKTtcbiAgfVxuICAvLyBJc3N1ZSAjNDM5MDogdGhlIHdob2xlIHBhY2t1bWVudCBpcyBuZXZlciBoZWxkLiBwbGF5d3JpZ2h0LWNvcmUncyBpc1xuICAvLyAxOCBNQiDigJQgb3ZlciB0aGUgb2xkIDE2IE1pQiBpbi1tZW1vcnkgY2FwIOKAlCB3aGljaCBsZWZ0IHRoZSAyNCBoXG4gIC8vIHF1YXJhbnRpbmUgc2lsZW50bHkgdW52ZXJpZmlhYmxlIGZvciBleGFjdGx5IHRoZSBsYXJnZSwgd2lkZWx5LXVzZWRcbiAgLy8gcGFja2FnZXMuIE9ubHkgdGhlIHRvcC1sZXZlbCBgdGltZWAgbWFwIGlzIGV4dHJhY3RlZCBmcm9tIHRoZSBzdHJlYW07XG4gIC8vIG1lbW9yeSBpcyBib3VuZGVkIGJ5IHRoZSBtYXAgKGEgZmV3IHRlbnMgb2YgS0IpLCB0aGUgYm9keSBieVxuICAvLyBgbWF4Qm9keUJ5dGVzYCwgYW5kIHRoZSB3aG9sZSB0aGluZyBieSB0aGUgcmVxdWVzdCB0aW1lb3V0LlxuICBpZiAoIXJlc3AuYm9keSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgbnBtIHJlZ2lzdHJ5IHJlc3BvbnNlIGZvciAke3BrZ30gaGFkIG5vIGJvZHlgKTtcbiAgfVxuICB0cnkge1xuICAgIHJldHVybiBhd2FpdCBleHRyYWN0TnBtVGltZU1hcChyZXNwLmJvZHksIHtcbiAgICAgIG1heEJvZHlCeXRlczogbWF4Qnl0ZXMsXG4gICAgICBtYXhUaW1lTWFwQnl0ZXMsXG4gICAgfSk7XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgYG5wbSByZWdpc3RyeSByZXNwb25zZSBmb3IgJHtwa2d9IGNvdWxkIG5vdCBiZSByZWFkOiAke1xuICAgICAgICBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IubWVzc2FnZSA6IFN0cmluZyhlcnJvcilcbiAgICAgIH1gLFxuICAgICk7XG4gIH1cbn1cblxuLyoqXG4gKiBDYXAgb24gdGhlIGJ5dGVzIHN0cmVhbWVkIHdoaWxlIGxvb2tpbmcgZm9yIHRoZSBgdGltZWAgbWFwIChJc3N1ZSAjNDM5MCkuXG4gKiBTdHJlYW1lZCwgbm90IGhlbGQ6IHRoZSBsYXJnZXN0IHBhY2t1bWVudHMgb24gbnBtIHJ1biB0byB3ZWxsIG92ZXIgMTAwIE1CLlxuICovXG5leHBvcnQgY29uc3QgTUFYX05QTV9TVFJFQU1fQllURVMgPSA1MTIgKiAxMDI0ICogMTAyNDtcblxuLyoqIE9wdGlvbnMgZm9yIHtAbGluayBleHRyYWN0TnBtVGltZU1hcH0uICovXG5leHBvcnQgaW50ZXJmYWNlIEV4dHJhY3ROcG1UaW1lTWFwT3B0aW9ucyB7XG4gIC8qKiBHaXZlIHVwIGFmdGVyIHN0cmVhbWluZyB0aGlzIG1hbnkgYnl0ZXMgd2l0aG91dCBhIGNvbXBsZXRlIG1hcC4gKi9cbiAgbWF4Qm9keUJ5dGVzPzogbnVtYmVyO1xuICAvKiogQ2FwIG9uIHRoZSBjYXB0dXJlZCBgdGltZWAgb2JqZWN0IGl0c2VsZi4gKi9cbiAgbWF4VGltZU1hcEJ5dGVzPzogbnVtYmVyO1xufVxuXG5jb25zdCBUSU1FX0tFWV9SRSA9IC9cInRpbWVcIlxccyo6XFxzKlxcey87XG4vKiogTG9uZ2VzdCBwcmVmaXggb2YgYFwidGltZVwiIDoge2AgdGhhdCBjYW4gc3RyYWRkbGUgYSBjaHVuayBib3VuZGFyeS4gKi9cbmNvbnN0IFRJTUVfS0VZX1RBSUwgPSAzMjtcblxuLyoqXG4gKiBTdHJlYW0gYSBwYWNrdW1lbnQgYW5kIHJldHVybiBpdHMgdG9wLWxldmVsIGB0aW1lYCBtYXAgd2l0aG91dCBob2xkaW5nXG4gKiB0aGUgZG9jdW1lbnQgKElzc3VlICM0MzkwKS5cbiAqXG4gKiBUaGUgbWFwIGlzIHJlY29nbmlzZWQgc3RydWN0dXJhbGx5IHJhdGhlciB0aGFuIHBvc2l0aW9uYWxseTogdGhlIGZpcnN0XG4gKiBgXCJ0aW1lXCI6e+KApn1gIG9iamVjdCB0aGF0IGNhcnJpZXMgYSBgY3JlYXRlZGAgb3IgYG1vZGlmaWVkYCBrZXkgaXMgdGhlXG4gKiByZWdpc3RyeSdzIG93biBtYXAgKHBlci12ZXJzaW9uIG1hbmlmZXN0cyBtYXkgY2FycnkgYSBgdGltZWAgZmllbGQgb2ZcbiAqIHRoZWlyIG93biBmcm9tIGEgcGFja2FnZS5qc29uIOKAlCB0aG9zZSBhcmUgc2tpcHBlZCkuIFN0cmluZ3MgaW5zaWRlIHRoZVxuICogbWFwIGFyZSB0cmFja2VkIHNvIGEgYH1gIGluIGEgdmFsdWUgY2Fubm90IGVuZCB0aGUgY2FwdHVyZSBlYXJseS4gVGhyb3dzXG4gKiB3aGVuIHRoZSBib2R5IGVuZHMgb3IgdGhlIGNhcHMgYXJlIGhpdCB3aXRob3V0IGEgY29tcGxldGUgbWFwLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZXh0cmFjdE5wbVRpbWVNYXAoXG4gIGJvZHk6IFJlYWRhYmxlU3RyZWFtPFVpbnQ4QXJyYXk+LFxuICBvcHRpb25zOiBFeHRyYWN0TnBtVGltZU1hcE9wdGlvbnMgPSB7fSxcbik6IFByb21pc2U8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4ge1xuICBjb25zdCBtYXhCb2R5Qnl0ZXMgPSBvcHRpb25zLm1heEJvZHlCeXRlcyA/PyBNQVhfTlBNX1NUUkVBTV9CWVRFUztcbiAgY29uc3QgbWF4VGltZU1hcEJ5dGVzID0gb3B0aW9ucy5tYXhUaW1lTWFwQnl0ZXMgPz8gTUFYX05QTV9SRVNQT05TRV9CWVRFUztcbiAgY29uc3QgcmVhZGVyID0gYm9keS5nZXRSZWFkZXIoKTtcbiAgY29uc3QgZGVjb2RlciA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICBsZXQgYnl0ZXNSZWFkID0gMDtcbiAgLy8gU2VhcmNoaW5nIHN0YXRlOiB0aGUgbGFzdCBmZXcgY2hhcnMgb2YgdGhlIHByZXZpb3VzIGNodW5rLCBzbyBhIGtleVxuICAvLyBzcGxpdCBhY3Jvc3MgY2h1bmtzIGlzIHN0aWxsIGZvdW5kLlxuICBsZXQgdGFpbCA9IFwiXCI7XG4gIC8vIENhcHR1cmluZyBzdGF0ZS5cbiAgbGV0IGNhcHR1cmU6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgbGV0IGRlcHRoID0gMDtcbiAgbGV0IGluU3RyaW5nID0gZmFsc2U7XG4gIGxldCBlc2NhcGVkID0gZmFsc2U7XG4gIGxldCBsYXN0Q2FuZGlkYXRlOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+IHwgdW5kZWZpbmVkO1xuXG4gIGNvbnN0IGZpbmlzaCA9IGFzeW5jICgpOiBQcm9taXNlPHZvaWQ+ID0+IHtcbiAgICB0cnkge1xuICAgICAgYXdhaXQgcmVhZGVyLmNhbmNlbCgpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgLy8gQWxyZWFkeSBjbG9zZWQuXG4gICAgfVxuICB9O1xuXG4gIHRyeSB7XG4gICAgd2hpbGUgKHRydWUpIHtcbiAgICAgIGNvbnN0IHsgdmFsdWUsIGRvbmUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgICBsZXQgdGV4dCA9IHZhbHVlID8gZGVjb2Rlci5kZWNvZGUodmFsdWUsIHsgc3RyZWFtOiB0cnVlIH0pIDogXCJcIjtcbiAgICAgIGlmIChkb25lKSB0ZXh0ICs9IGRlY29kZXIuZGVjb2RlKCk7XG4gICAgICBieXRlc1JlYWQgKz0gdmFsdWU/LmJ5dGVMZW5ndGggPz8gMDtcbiAgICAgIGlmIChieXRlc1JlYWQgPiBtYXhCb2R5Qnl0ZXMpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICAgIGBwYWNrdW1lbnQgZXhjZWVkZWQgdGhlICR7bWF4Qm9keUJ5dGVzfS1ieXRlIHN0cmVhbWluZyBjYXAgYmVmb3JlIGEgXCJ0aW1lXCIgbWFwIHdhcyBmb3VuZGAsXG4gICAgICAgICk7XG4gICAgICB9XG5cbiAgICAgIGxldCBjdXJzb3IgPSAwO1xuICAgICAgd2hpbGUgKGN1cnNvciA8IHRleHQubGVuZ3RoIHx8IChjYXB0dXJlID09PSB1bmRlZmluZWQgJiYgZG9uZSkpIHtcbiAgICAgICAgaWYgKGNhcHR1cmUgPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgIGNvbnN0IHdpbmRvdyA9IHRhaWwgKyB0ZXh0LnNsaWNlKGN1cnNvcik7XG4gICAgICAgICAgY29uc3QgbSA9IHdpbmRvdy5tYXRjaChUSU1FX0tFWV9SRSk7XG4gICAgICAgICAgaWYgKCFtIHx8IG0uaW5kZXggPT09IHVuZGVmaW5lZCkge1xuICAgICAgICAgICAgLy8gTm8ga2V5IGluIHRoaXMgY2h1bms6IGNhcnJ5IGl0cyB0YWlsIGFuZCB3YWl0IGZvciB0aGUgbmV4dC5cbiAgICAgICAgICAgIHRhaWwgPSB3aW5kb3cuc2xpY2UoLVRJTUVfS0VZX1RBSUwpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgfVxuICAgICAgICAgIC8vIFN0YXJ0IGNhcHR1cmluZyBhdCB0aGUgYHtgLiBgd2luZG93YCBpcyBgdGFpbCArIHRleHRbY3Vyc29yLi5dYCxcbiAgICAgICAgICAvLyBzbyBhIG1hdGNoIGluc2lkZSB0aGUgY2FycmllZCB0YWlsIGlzIHJlLWZlZCBhaGVhZCBvZiB0aGUgdGV4dC5cbiAgICAgICAgICBjb25zdCBzdGFydEluV2luZG93ID0gbS5pbmRleCArIG1bMF0ubGVuZ3RoIC0gMTtcbiAgICAgICAgICBpZiAoc3RhcnRJbldpbmRvdyA+PSB0YWlsLmxlbmd0aCkge1xuICAgICAgICAgICAgY3Vyc29yID0gY3Vyc29yICsgKHN0YXJ0SW5XaW5kb3cgLSB0YWlsLmxlbmd0aCk7XG4gICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRleHQgPSB3aW5kb3cuc2xpY2Uoc3RhcnRJbldpbmRvdywgdGFpbC5sZW5ndGgpICtcbiAgICAgICAgICAgICAgdGV4dC5zbGljZShjdXJzb3IpO1xuICAgICAgICAgICAgY3Vyc29yID0gMDtcbiAgICAgICAgICB9XG4gICAgICAgICAgdGFpbCA9IFwiXCI7XG4gICAgICAgICAgY2FwdHVyZSA9IFwiXCI7XG4gICAgICAgICAgZGVwdGggPSAwO1xuICAgICAgICAgIGluU3RyaW5nID0gZmFsc2U7XG4gICAgICAgICAgZXNjYXBlZCA9IGZhbHNlO1xuICAgICAgICB9XG4gICAgICAgIC8vIENhcHR1cmluZzogY29uc3VtZSB1bnRpbCB0aGUgb2JqZWN0IGNsb3Nlcy5cbiAgICAgICAgbGV0IGNsb3NlZEF0ID0gLTE7XG4gICAgICAgIGZvciAobGV0IGkgPSBjdXJzb3I7IGkgPCB0ZXh0Lmxlbmd0aDsgaSsrKSB7XG4gICAgICAgICAgY29uc3QgY2ggPSB0ZXh0W2ldITtcbiAgICAgICAgICBpZiAoaW5TdHJpbmcpIHtcbiAgICAgICAgICAgIGlmIChlc2NhcGVkKSBlc2NhcGVkID0gZmFsc2U7XG4gICAgICAgICAgICBlbHNlIGlmIChjaCA9PT0gXCJcXFxcXCIpIGVzY2FwZWQgPSB0cnVlO1xuICAgICAgICAgICAgZWxzZSBpZiAoY2ggPT09ICdcIicpIGluU3RyaW5nID0gZmFsc2U7XG4gICAgICAgICAgfSBlbHNlIGlmIChjaCA9PT0gJ1wiJykgaW5TdHJpbmcgPSB0cnVlO1xuICAgICAgICAgIGVsc2UgaWYgKGNoID09PSBcIntcIikgZGVwdGgrKztcbiAgICAgICAgICBlbHNlIGlmIChjaCA9PT0gXCJ9XCIpIHtcbiAgICAgICAgICAgIGRlcHRoLS07XG4gICAgICAgICAgICBpZiAoZGVwdGggPT09IDApIHtcbiAgICAgICAgICAgICAgY2xvc2VkQXQgPSBpO1xuICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgZW5kID0gY2xvc2VkQXQgPT09IC0xID8gdGV4dC5sZW5ndGggOiBjbG9zZWRBdCArIDE7XG4gICAgICAgIGNhcHR1cmUgKz0gdGV4dC5zbGljZShjdXJzb3IsIGVuZCk7XG4gICAgICAgIGlmIChjYXB0dXJlLmxlbmd0aCA+IG1heFRpbWVNYXBCeXRlcykge1xuICAgICAgICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgICAgICAgIGBcInRpbWVcIiBvYmplY3QgZXhjZWVkZWQgdGhlICR7bWF4VGltZU1hcEJ5dGVzfS1ieXRlIGNhcGAsXG4gICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgICAgICBjdXJzb3IgPSBlbmQ7XG4gICAgICAgIGlmIChjbG9zZWRBdCA9PT0gLTEpIGJyZWFrOyAvLyBuZWVkIG1vcmUgY2h1bmtzXG4gICAgICAgIC8vIEEgY29tcGxldGUgb2JqZWN0OiB0aGUgcmVnaXN0cnkncyBtYXAgY2FycmllcyBjcmVhdGVkL21vZGlmaWVkLlxuICAgICAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICAgICAgICB0cnkge1xuICAgICAgICAgIHBhcnNlZCA9IEpTT04ucGFyc2UoY2FwdHVyZSk7XG4gICAgICAgIH0gY2F0Y2gge1xuICAgICAgICAgIHBhcnNlZCA9IHVuZGVmaW5lZDtcbiAgICAgICAgfVxuICAgICAgICBjYXB0dXJlID0gdW5kZWZpbmVkO1xuICAgICAgICBpZiAocGFyc2VkICYmIHR5cGVvZiBwYXJzZWQgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICBpZiAoXCJtb2RpZmllZFwiIGluIHBhcnNlZCB8fCBcImNyZWF0ZWRcIiBpbiBwYXJzZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgc3RyaW5nPjtcbiAgICAgICAgICB9XG4gICAgICAgICAgLy8gQSByZWdpc3RyeSB0aGF0IG9taXRzIGNyZWF0ZWQvbW9kaWZpZWQ6IHJlbWVtYmVyIHRoZSBvYmplY3QgaWZcbiAgICAgICAgICAvLyBpdCBpcyBzaGFwZWQgbGlrZSBhIHZlcnNpb24g4oaSIGRhdGUgbWFwIChhIHBlci12ZXJzaW9uIGB0aW1lYFxuICAgICAgICAgIC8vIGZpZWxkIG9mIHNvbWUgb3RoZXIgc2hhcGUgaXMgbm90KS4gVGhlIHJlZ2lzdHJ5J3MgbWFwIGNvbWVzXG4gICAgICAgICAgLy8gYWZ0ZXIgYHZlcnNpb25zYCwgc28gdGhlIGxhc3Qgc3VjaCBjYW5kaWRhdGUgd2lucy5cbiAgICAgICAgICBjb25zdCBlbnRyaWVzID0gT2JqZWN0LnZhbHVlcyhwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pO1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgIGVudHJpZXMubGVuZ3RoID4gMCAmJlxuICAgICAgICAgICAgZW50cmllcy5ldmVyeSgodikgPT5cbiAgICAgICAgICAgICAgdHlwZW9mIHYgPT09IFwic3RyaW5nXCIgJiYgIU51bWJlci5pc05hTihEYXRlLnBhcnNlKHYpKVxuICAgICAgICAgICAgKVxuICAgICAgICAgICkge1xuICAgICAgICAgICAgbGFzdENhbmRpZGF0ZSA9IHBhcnNlZCBhcyBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICB0YWlsID0gXCJcIjtcbiAgICAgIH1cbiAgICAgIGlmIChkb25lKSBicmVhaztcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgLy8gV2hhdGV2ZXIgdGhlIGV4aXQg4oCUIGZvdW5kLCBmYWlsZWQsIGNhcHBlZCDigJQgdGhlIHJlZ2lzdHJ5IHN0cmVhbSBpc1xuICAgIC8vIGNhbmNlbGxlZCwgbmV2ZXIgbGVmdCBkcmFpbmluZy5cbiAgICBhd2FpdCBmaW5pc2goKTtcbiAgfVxuICBpZiAobGFzdENhbmRpZGF0ZSkgcmV0dXJuIGxhc3RDYW5kaWRhdGU7XG4gIHRocm93IG5ldyBFcnJvcihgdGhlIHBhY2t1bWVudCBoYXMgbm8gdG9wLWxldmVsIFwidGltZVwiIG1hcGApO1xufVxuXG4vKipcbiAqIENoZWNrIGEgc2luZ2xlIHBpbm5lZCBgcGtnQHZlcnNpb25gIGFnYWluc3QgdGhlIHF1YXJhbnRpbmUgd2luZG93LlxuICpcbiAqIEEgcmVqZWN0ZWQgb3IgZW1wdHkgbG9va3VwIGJlY29tZXMgYW4gaW5kZXRlcm1pbmF0ZSB2ZXJkaWN0IOKAlCB3aGljaCByZWZ1c2VzXG4gKiB0aGUgcGFja2FnZSDigJQgd2l0aCB0aGUgZmFpbHVyZSBtZXNzYWdlIHF1b3RlZCBpbiB0aGUgcmVhc29uLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY2hlY2tOcG1WZXJzaW9uQWdlKFxuICBwa2c6IHN0cmluZyxcbiAgdmVyc2lvbjogc3RyaW5nLFxuICBxdWFyYW50aW5lSG91cnM6IG51bWJlcixcbiAgZGVwczogTnBtQWdlRmV0Y2hEZXBzLFxuKTogUHJvbWlzZTxOcG1BZ2VWZXJkaWN0PiB7XG4gIGxldCB0aW1lRGF0YTogUmVjb3JkPHN0cmluZywgc3RyaW5nPiB8IHVuZGVmaW5lZDtcbiAgbGV0IGxvb2t1cEVycm9yOiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgdGltZURhdGEgPSBhd2FpdCBkZXBzLmZldGNoVGltZURhdGEocGtnKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICB0aW1lRGF0YSA9IHVuZGVmaW5lZDtcbiAgICBsb29rdXBFcnJvciA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgfVxuICByZXR1cm4gZXZhbHVhdGVOcG1WZXJzaW9uQWdlKFxuICAgIHBrZyxcbiAgICB2ZXJzaW9uLFxuICAgIHRpbWVEYXRhLFxuICAgIHF1YXJhbnRpbmVIb3VycyxcbiAgICBkZXBzLm5vdygpLFxuICAgIGxvb2t1cEVycm9yLFxuICApO1xufVxuXG4vKipcbiAqIENoZWNrIGEgYmF0Y2ggb2YgcGlubmVkIHBhY2thZ2VzIGFuZCBjbGFzc2lmeSB0aGUgb3V0Y29tZS5cbiAqXG4gKiBgb2tgIGlzIHRydWUgb25seSB3aGVuIGV2ZXJ5IHBhY2thZ2UgcG9zaXRpdmVseSBjbGVhcmVkIHRoZSB3aW5kb3cuIEFcbiAqIHBhY2thZ2UgdGhhdCBpcyBkZWZpbml0aXZlbHkgdG9vIG5ldyBibG9ja3MsIGFuZCBzbyBkb2VzIG9uZSB3aG9zZSBhZ2UgY291bGRcbiAqIG5vdCBiZSB2ZXJpZmllZCAoSXNzdWUgIzM3MTEpIOKAlCB0aGUgZ2F0ZSBndWFyZHMgc3BlY2lmaWVycyB0aGF0IHRoZW4gcnVuXG4gKiB3aXRoIGZ1bGwgaG9zdCBhY2Nlc3MsIHNvIGFuIHVudmVyaWZpYWJsZSBhZ2UgbXVzdCBmYWlsIGNsb3NlZCByYXRoZXIgdGhhblxuICogZGVncmFkZSBpbnRvIGEgcGFzcy4gVGhlcmUgaXMgZGVsaWJlcmF0ZWx5IG5vIG9wdC1vdXQ6IHJldHJ5IG9uY2UgdGhlXG4gKiByZWdpc3RyeSBpcyByZWFjaGFibGUuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiB2ZXJpZnlOcG1QYWNrYWdlc1F1YXJhbnRpbmUoXG4gIHBhY2thZ2VzOiByZWFkb25seSBRdWFyYW50aW5lZFBhY2thZ2VbXSxcbiAgcXVhcmFudGluZUhvdXJzOiBudW1iZXIsXG4gIGRlcHM6IE5wbUFnZUZldGNoRGVwcyxcbik6IFByb21pc2U8TnBtUXVhcmFudGluZVJlcG9ydD4ge1xuICBjb25zdCB2ZXJkaWN0czogTnBtQWdlVmVyZGljdFtdID0gW107XG4gIGZvciAoY29uc3QgcCBvZiBwYWNrYWdlcykge1xuICAgIHZlcmRpY3RzLnB1c2goXG4gICAgICBhd2FpdCBjaGVja05wbVZlcnNpb25BZ2UocC5uYW1lLCBwLnZlcnNpb24sIHF1YXJhbnRpbmVIb3VycywgZGVwcyksXG4gICAgKTtcbiAgfVxuICBjb25zdCBibG9ja2VkID0gdmVyZGljdHMuZmlsdGVyKCh2KSA9PiAhdi5lbGlnaWJsZSAmJiAhdi5pbmRldGVybWluYXRlKTtcbiAgY29uc3QgaW5kZXRlcm1pbmF0ZSA9IHZlcmRpY3RzLmZpbHRlcigodikgPT4gdi5pbmRldGVybWluYXRlKTtcbiAgY29uc3QgcmVmdXNlZCA9IHZlcmRpY3RzLmZpbHRlcigodikgPT4gIXYuZWxpZ2libGUpO1xuICByZXR1cm4ge1xuICAgIHZlcmRpY3RzLFxuICAgIGJsb2NrZWQsXG4gICAgaW5kZXRlcm1pbmF0ZSxcbiAgICByZWZ1c2VkLFxuICAgIG9rOiByZWZ1c2VkLmxlbmd0aCA9PT0gMCxcbiAgfTtcbn1cblxuLyoqIERlZmF1bHQgcHJvZHVjdGlvbiBkZXBzOiByZWFsIHJlZ2lzdHJ5IGZldGNoICsgc3lzdGVtIGNsb2NrLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlZmF1bHROcG1BZ2VEZXBzKCk6IE5wbUFnZUZldGNoRGVwcyB7XG4gIHJldHVybiB7IGZldGNoVGltZURhdGE6IGZldGNoTnBtVGltZURhdGEsIG5vdzogKCkgPT4gbmV3IERhdGUoKSB9O1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0EyQkMsR0FFRCxTQUNFLHdCQUF3QixFQUN4QixvQkFBb0IsRUFDcEIsV0FBVyxFQUNYLGtCQUFrQixRQUNiLHFCQUFxQjtBQUU1Qix5Q0FBeUMsR0FDekMsT0FBTyxNQUFNLG9CQUFvQiw2QkFBNkI7QUFFOUQ7Ozs7O0NBS0MsR0FDRCxPQUFPLE1BQU0seUJBQXlCLEtBQUssT0FBTyxLQUFLO0FBc0J2RCwrRUFBK0UsR0FDL0UsT0FBTyxNQUFNLCtCQUErQixHQUFHO0FBK0QvQzs7Ozs7Q0FLQyxHQUNELE9BQU8sU0FBUyxlQUFlLEdBQVcsRUFBRSxPQUFPLGlCQUFpQjtFQUNsRSxPQUFPLEdBQUcsS0FBSyxDQUFDLEVBQUUsSUFBSSxVQUFVLENBQUMsS0FBSyxRQUFRO0FBQ2hEO0FBRUE7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sU0FBUyxzQkFDZCxHQUFXLEVBQ1gsT0FBZSxFQUNmLFFBQTRDLEVBQzVDLGVBQXVCLEVBQ3ZCLEdBQVMsRUFDVCxXQUFvQjtFQUVwQixNQUFNLFFBQVEsT0FBTyxRQUFRLENBQUMsb0JBQW9CLGtCQUFrQixJQUNoRSxrQkFDQTtFQUVKLE1BQU0sWUFBWSxVQUFVLENBQUMsUUFBUTtFQUNyQyxJQUFJLENBQUMsV0FBVztJQUNkLE1BQU0sUUFBUSxjQUNWLENBQUMsNEJBQTRCLEVBQUUsWUFBWSxDQUFDLENBQUMsR0FDN0MsQ0FBQyxxQ0FBcUMsQ0FBQztJQUMzQyxPQUFPO01BQ0wsU0FBUztNQUNUO01BQ0EsVUFBVTtNQUNW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
// denoCacheMetadata=10348146208258912923,2439681500236306958