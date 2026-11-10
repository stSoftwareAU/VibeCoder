/**
 * Built-in GitHub Actions CI log provider (Issue #3580).
 *
 * GitHub Actions is the default CI provider every repo gets with zero
 * configuration, but until now the worker only saw check *annotations* —
 * a summary surface that routinely omits the stack trace, the failing
 * assertion diff, and the compiler error context the fix prompt needs.
 * This module fetches the failing job's actual log through the worker's
 * existing authenticated `gh` CLI (no new secret), trims it down to the
 * signal, and hands it to the same `{{PR_FAILURE_ACTIONS}}` prompt slot
 * an externally-provided CI log provider uses.
 *
 * A failing check that is not an Actions job — a commit status posted by
 * some other CI system, say — yields a clean "not applicable" outcome so
 * callers fall through rather than error.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */ /** A startup-suite identity is distinct from a check-run or Actions job id. */ export function parseCheckSuiteId(checkId) {
  const match = /^suite-(\d+)$/.exec(checkId);
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
/** Provider id logged on every CI-fix run so fall-through is visible. */ export const GITHUB_ACTIONS_PROVIDER_ID = "github-actions";
/**
 * Hard cap on the excerpt handed to the fix prompt (16 KiB).
 *
 * Deliberately smaller than any sensible fetch-side cap: a provider bounds
 * what it pulls off the wire, and this bounds what reaches the model, so a
 * multi-megabyte Actions log cannot blow the context.
 */ export const MAX_ACTIONS_EXCERPT_BYTES = 16 * 1024;
/** Lines of context kept before the first failure marker. */ const FAILURE_LEAD_LINES = 30;
/** Lines of context kept after the first failure marker. */ const FAILURE_TRAIL_LINES = 120;
/** Lines of log tail always kept — failures usually surface at the end. */ const TAIL_LINES = 200;
/**
 * Hosts whose Actions URLs the built-in provider will claim.
 *
 * GitHub Enterprise hosts are deliberately absent: the provider declines
 * rather than guessing, so an Enterprise deployment gets no log excerpt
 * instead of a wrongly-trusted origin. Declining is the safe direction.
 */ const GITHUB_HOSTS = new Set([
  "github.com",
  "www.github.com"
]);
/** Whether `hostname` is a GitHub host this provider will claim. */ export function isGithubHost(hostname) {
  return GITHUB_HOSTS.has(hostname.toLowerCase());
}
/**
 * Parse a check `details_url` into the Actions run/job ids it encodes.
 *
 * Actions check runs point at `/{owner}/{repo}/actions/runs/{run}/job/{job}`
 * (the `/jobs/{job}` spelling also occurs). A check-suite entry may only
 * carry the run. Anything else — another CI system's build URL, an empty
 * string — is `other`.
 */ export function parseActionsCheckUrl(url) {
  if (!url) return {
    kind: "other"
  };
  // The origin is checked before the path, and a value that is not an
  // absolute GitHub URL is `other` rather than being matched on shape.
  //
  // This function decides whether the built-in provider CLAIMS a failing
  // check, and its input reaches here from untrusted places — a `Build URL`
  // line in an issue body (`ci_failure_issue.ts` calls that body untrusted in
  // its own header) and a check run's `details_url`. Matching on the path
  // alone meant `https://attacker.example/o/r/actions/runs/1/job/2` parsed as
  // a job: the provider claimed it, and the caller echoed the attacker's
  // string back into the CI-fix prompt. The log itself was always fetched
  // through `gh api` from real GitHub, so nothing was ever read from the
  // foreign host — what leaked was an attacker-chosen string into a prompt,
  // and a false account of where the log came from.
  //
  // A relative path is refused for the same reason: an origin that cannot be
  // established is not one that can be trusted. GitHub's `details_url` is
  // always absolute, so nothing legitimate is lost.
  let parsed;
  try {
    parsed = new URL(url);
  } catch  {
    return {
      kind: "other"
    };
  }
  if (!isGithubHost(parsed.hostname)) return {
    kind: "other"
  };
  const path = parsed.pathname;
  const job = /\/actions\/runs\/(\d+)\/jobs?\/(\d+)/.exec(path);
  if (job) {
    return {
      kind: "job",
      runId: Number(job[1]),
      jobId: Number(job[2])
    };
  }
  const run = /\/actions\/runs\/(\d+)/.exec(path);
  if (run) return {
    kind: "run",
    runId: Number(run[1])
  };
  return {
    kind: "other"
  };
}
/** Run `gh api <endpoint>` and return stdout, or a descriptive error. */ async function ghApi(ghFn, endpoint) {
  try {
    return {
      ok: true,
      body: await ghFn([
        "api",
        endpoint
      ])
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `gh api ${endpoint} failed: ${message}`
    };
  }
}
/**
 * Terminal control sequences that Actions logs carry (colour, cursor,
 * OSC titles). Built from the escape byte at runtime — a literal control
 * character in a regex source trips `no-control-regex`.
 */ const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_RE = new RegExp(`${ESC}\\[[?0-9;]*[A-Za-z]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
/** Strip ANSI/OSC escape sequences from a fetched log. */ export function stripAnsi(text) {
  return text.replace(ANSI_RE, "");
}
/** The refusal `gh` ≥ 2.9x gives for a body carrying escape sequences. */ const ESCAPE_SEQUENCE_REFUSAL = /allow-escape-sequences/i;
/**
 * Fetch a raw log body (Issue #4376). Actions logs always contain ANSI
 * colour codes, and `gh` ≥ 2.9x refuses to emit such a response unless
 * `--allow-escape-sequences` is passed — observed live as "No CI log
 * provider produced an excerpt … pass --allow-escape-sequences to output
 * it anyway", which left the CI-fix agent working blind. The flag is passed
 * first; a `gh` too old to know it ("unknown flag") gets the plain call.
 * The body is ANSI-stripped either way.
 */ async function ghApiLogs(ghFn, endpoint) {
  try {
    const body = await ghFn([
      "api",
      "--allow-escape-sequences",
      endpoint
    ]);
    return {
      ok: true,
      body: stripAnsi(body)
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/unknown flag|unknown option|unrecognised|unrecognized/i.test(message)) {
      // The flagged call is the right one on a current gh; report its error
      // unless the flag itself was the problem.
      if (!ESCAPE_SEQUENCE_REFUSAL.test(message)) {
        return {
          ok: false,
          error: `gh api ${endpoint} failed: ${message}`
        };
      }
    }
  }
  // Older gh: no such flag (or a refusal we cannot explain) — plain call.
  const plain = await ghApi(ghFn, endpoint);
  return plain.ok ? {
    ok: true,
    body: stripAnsi(plain.body)
  } : plain;
}
/**
 * Resolve a failing check run to a GitHub Actions job id.
 *
 * Resolution order:
 * 1. A supplied `targetUrl` that already encodes the job id.
 * 2. The check-run API (`/repos/{repo}/check-runs/{id}`) — its
 *    `details_url` carries the job id, and `app.slug` tells us whether
 *    the check is an Actions job at all.
 * 3. When only a run id is known, the run's job listing, matched on
 *    check name and falling back to the first non-successful job.
 */ export async function resolveActionsJobId(opts) {
  const { repo, checkRunId, checkName, targetUrl, ghFn } = opts;
  if (parseCheckSuiteId(checkRunId) !== null) {
    return {
      kind: "not-applicable",
      reason: "startup-failed suite has no Actions job"
    };
  }
  if (targetUrl) {
    const parsed = parseActionsCheckUrl(targetUrl);
    if (parsed.kind === "job") return {
      kind: "job",
      jobId: parsed.jobId
    };
    if (parsed.kind === "run") {
      return await resolveJobFromRun(repo, parsed.runId, checkName, ghFn);
    }
    return {
      kind: "not-applicable",
      reason: `check target URL is not a GitHub Actions job URL: ${targetUrl}`
    };
  }
  const response = await ghApi(ghFn, `repos/${repo}/check-runs/${checkRunId}`);
  if (!response.ok) return {
    kind: "error",
    error: response.error
  };
  let checkRun;
  try {
    const parsed = JSON.parse(response.body);
    if (typeof parsed !== "object" || parsed === null) {
      return {
        kind: "error",
        error: "check-run response was not an object"
      };
    }
    checkRun = parsed;
  } catch  {
    return {
      kind: "error",
      error: "check-run response was not valid JSON"
    };
  }
  const app = checkRun["app"];
  const slug = typeof app?.["slug"] === "string" ? app["slug"] : "";
  if (slug !== "" && slug !== GITHUB_ACTIONS_PROVIDER_ID) {
    return {
      kind: "not-applicable",
      reason: `check run is owned by '${slug}', not GitHub Actions`
    };
  }
  const detailsUrl = typeof checkRun["details_url"] === "string" ? checkRun["details_url"] : "";
  const parsedDetails = parseActionsCheckUrl(detailsUrl);
  if (parsedDetails.kind === "job") {
    return {
      kind: "job",
      jobId: parsedDetails.jobId
    };
  }
  if (parsedDetails.kind === "run") {
    return await resolveJobFromRun(repo, parsedDetails.runId, checkName, ghFn);
  }
  return {
    kind: "not-applicable",
    reason: "check run has no GitHub Actions job URL"
  };
}
/** Pick the failing job of a workflow run by name, else the first failure. */ async function resolveJobFromRun(repo, runId, checkName, ghFn) {
  const response = await ghApi(ghFn, `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`);
  if (!response.ok) return {
    kind: "error",
    error: response.error
  };
  let jobs;
  try {
    const parsed = JSON.parse(response.body);
    jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  } catch  {
    return {
      kind: "error",
      error: "run jobs response was not valid JSON"
    };
  }
  const byName = checkName ? jobs.find((j)=>j["name"] === checkName) : undefined;
  const failing = jobs.find((j)=>j["conclusion"] === "failure" || j["conclusion"] === "timed_out");
  const chosen = byName ?? failing;
  const jobId = typeof chosen?.["id"] === "number" ? chosen["id"] : NaN;
  if (!Number.isFinite(jobId)) {
    return {
      kind: "not-applicable",
      reason: `workflow run ${runId} has no resolvable failing job`
    };
  }
  return {
    kind: "job",
    jobId
  };
}
/**
 * Name the first step that failed inside the Actions job behind a check
 * run (Issue #1579).
 *
 * A GitHub Actions *job* bundles many steps, and its check name says
 * nothing about which of them failed — NEAT-AI-core's `Scripts & spelling`
 * job runs bats and codespell under one name. Callers routing a failure to
 * a specialised fixer need the step, not the job name.
 *
 * `name` is the first failed step; `failedSteps` lists every failed step,
 * because a job configured with `continue-on-error` can fail in more than
 * one, and a caller routing on the step needs to see all of them.
 *
 * Returns `not-applicable` when the check is not an Actions job or the job
 * reports no failed step, and `error` when the lookup itself failed. Never
 * throws, and never guesses a step name.
 */ export async function resolveFailedStepName(opts) {
  const resolution = await resolveActionsJobId(opts);
  if (resolution.kind !== "job") return resolution;
  const response = await ghApi(opts.ghFn, `repos/${opts.repo}/actions/jobs/${resolution.jobId}`);
  if (!response.ok) return {
    kind: "error",
    error: response.error
  };
  let steps;
  try {
    const parsed = JSON.parse(response.body);
    steps = Array.isArray(parsed.steps) ? parsed.steps : [];
  } catch  {
    return {
      kind: "error",
      error: "job response was not valid JSON"
    };
  }
  const failedSteps = steps.filter((step)=>step["conclusion"] === "failure").map((step)=>typeof step["name"] === "string" ? step["name"] : "").filter((name)=>name !== "");
  const name = failedSteps[0];
  if (name === undefined) {
    return {
      kind: "not-applicable",
      reason: `Actions job ${resolution.jobId} reports no failed step`
    };
  }
  return {
    kind: "step",
    name,
    failedSteps
  };
}
/**
 * Strip the ISO-8601 timestamp GitHub Actions prepends to every log
 * line. The timestamps burn context for no diagnostic signal. Lines
 * without a prefix are returned unchanged.
 */ function stripTimestamp(line) {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\s?/, "");
}
/** Markers identifying the first genuine failure in an Actions log. */ const FAILURE_MARKERS = [
  /##\[error\]/i,
  /^\s*(?:error|fail(?:ed|ure)?)\b[:\s]/i,
  /\bBUILD FAILURE\b/,
  /\bFAILED\b/,
  /\bTests? run:.*Failures: [1-9]/,
  // TAP (bats, prove, node:test): the failing assertion is a `not ok N`
  // line carrying no error word at all, so without this marker a bats
  // failure far from the log tail was trimmed out of the excerpt
  // entirely (Issue #1579).
  /^\s*not ok \d+\b/,
  /\bAssertionError\b/,
  /\bException\b/
];
function isFailureMarker(line) {
  return FAILURE_MARKERS.some((re)=>re.test(line));
}
/**
 * Trim a raw GitHub Actions job log to the material worth putting in a
 * fix prompt: the window around the first failure marker plus the log
 * tail, with timestamp prefixes stripped and the result hard-capped.
 *
 * Mirrors an approach already proven against a much noisier console log in
 * a private deployment.
 */ export function summariseActionsLog(rawLog, opts = {}) {
  const maxBytes = opts.maxBytes ?? MAX_ACTIONS_EXCERPT_BYTES;
  const lines = rawLog.split("\n").map(stripTimestamp);
  const failureIndex = lines.findIndex(isFailureMarker);
  const tailStart = Math.max(0, lines.length - TAIL_LINES);
  const kept = [];
  if (failureIndex >= 0 && failureIndex < tailStart) {
    const from = Math.max(0, failureIndex - FAILURE_LEAD_LINES);
    const to = Math.min(tailStart, failureIndex + FAILURE_TRAIL_LINES + 1);
    if (from > 0) kept.push(`[... ${from} earlier lines omitted ...]`);
    kept.push(...lines.slice(from, to));
    kept.push(`[... ${tailStart - to} lines omitted ...]`);
  } else if (tailStart > 0) {
    kept.push(`[... ${tailStart} earlier lines omitted ...]`);
  }
  kept.push(...lines.slice(tailStart));
  return capBytesPreservingTail(kept.join("\n"), maxBytes);
}
/**
 * Cap `text` at `maxBytes` UTF-8 bytes, keeping the tail and prefixing a
 * marker so a reader knows content was dropped.
 */ function capBytesPreservingTail(text, maxBytes) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  const marker = `[... truncated ${bytes.byteLength - maxBytes} bytes — showing tail ...]\n`;
  const budget = Math.max(0, maxBytes - encoder.encode(marker).byteLength);
  const tail = bytes.subarray(bytes.byteLength - budget);
  return marker + new TextDecoder("utf-8", {
    fatal: false
  }).decode(tail);
}
/**
 * Fetch and trim the log of the failing GitHub Actions job behind a
 * check run.
 *
 * Returns `not-applicable` when the check is not an Actions job (so the
 * caller falls through cleanly), `error` when resolution or retrieval
 * genuinely failed, and `excerpt` on success. Never throws.
 */ export async function fetchGithubActionsLogExcerpt(opts) {
  const resolution = await resolveActionsJobId(opts);
  if (resolution.kind !== "job") return resolution;
  const response = await ghApiLogs(opts.ghFn, `repos/${opts.repo}/actions/jobs/${resolution.jobId}/logs`);
  if (!response.ok) return {
    kind: "error",
    error: response.error
  };
  if (response.body.trim() === "") {
    return {
      kind: "error",
      error: `GitHub Actions job ${resolution.jobId} returned an empty log`
    };
  }
  const excerpt = summariseActionsLog(response.body, {
    ...opts.maxBytes !== undefined ? {
      maxBytes: opts.maxBytes
    } : {}
  });
  return {
    kind: "excerpt",
    providerId: GITHUB_ACTIONS_PROVIDER_ID,
    jobId: resolution.jobId,
    excerpt
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9naXRodWJfYWN0aW9uc19sb2dfZmV0Y2hlci50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEJ1aWx0LWluIEdpdEh1YiBBY3Rpb25zIENJIGxvZyBwcm92aWRlciAoSXNzdWUgIzM1ODApLlxuICpcbiAqIEdpdEh1YiBBY3Rpb25zIGlzIHRoZSBkZWZhdWx0IENJIHByb3ZpZGVyIGV2ZXJ5IHJlcG8gZ2V0cyB3aXRoIHplcm9cbiAqIGNvbmZpZ3VyYXRpb24sIGJ1dCB1bnRpbCBub3cgdGhlIHdvcmtlciBvbmx5IHNhdyBjaGVjayAqYW5ub3RhdGlvbnMqIOKAlFxuICogYSBzdW1tYXJ5IHN1cmZhY2UgdGhhdCByb3V0aW5lbHkgb21pdHMgdGhlIHN0YWNrIHRyYWNlLCB0aGUgZmFpbGluZ1xuICogYXNzZXJ0aW9uIGRpZmYsIGFuZCB0aGUgY29tcGlsZXIgZXJyb3IgY29udGV4dCB0aGUgZml4IHByb21wdCBuZWVkcy5cbiAqIFRoaXMgbW9kdWxlIGZldGNoZXMgdGhlIGZhaWxpbmcgam9iJ3MgYWN0dWFsIGxvZyB0aHJvdWdoIHRoZSB3b3JrZXInc1xuICogZXhpc3RpbmcgYXV0aGVudGljYXRlZCBgZ2hgIENMSSAobm8gbmV3IHNlY3JldCksIHRyaW1zIGl0IGRvd24gdG8gdGhlXG4gKiBzaWduYWwsIGFuZCBoYW5kcyBpdCB0byB0aGUgc2FtZSBge3tQUl9GQUlMVVJFX0FDVElPTlN9fWAgcHJvbXB0IHNsb3RcbiAqIGFuIGV4dGVybmFsbHktcHJvdmlkZWQgQ0kgbG9nIHByb3ZpZGVyIHVzZXMuXG4gKlxuICogQSBmYWlsaW5nIGNoZWNrIHRoYXQgaXMgbm90IGFuIEFjdGlvbnMgam9iIOKAlCBhIGNvbW1pdCBzdGF0dXMgcG9zdGVkIGJ5XG4gKiBzb21lIG90aGVyIENJIHN5c3RlbSwgc2F5IOKAlCB5aWVsZHMgYSBjbGVhbiBcIm5vdCBhcHBsaWNhYmxlXCIgb3V0Y29tZSBzb1xuICogY2FsbGVycyBmYWxsIHRocm91Z2ggcmF0aGVyIHRoYW4gZXJyb3IuXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24sIGNvbG91cikuXG4gKi9cblxuLyoqIEEgc3RhcnR1cC1zdWl0ZSBpZGVudGl0eSBpcyBkaXN0aW5jdCBmcm9tIGEgY2hlY2stcnVuIG9yIEFjdGlvbnMgam9iIGlkLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQ2hlY2tTdWl0ZUlkKGNoZWNrSWQ6IHN0cmluZyk6IG51bWJlciB8IG51bGwge1xuICBjb25zdCBtYXRjaCA9IC9ec3VpdGUtKFxcZCspJC8uZXhlYyhjaGVja0lkKTtcbiAgaWYgKCFtYXRjaCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGlkID0gTnVtYmVyKG1hdGNoWzFdKTtcbiAgcmV0dXJuIE51bWJlci5pc1NhZmVJbnRlZ2VyKGlkKSAmJiBpZCA+IDAgPyBpZCA6IG51bGw7XG59XG5cbi8qKiBQcm92aWRlciBpZCBsb2dnZWQgb24gZXZlcnkgQ0ktZml4IHJ1biBzbyBmYWxsLXRocm91Z2ggaXMgdmlzaWJsZS4gKi9cbmV4cG9ydCBjb25zdCBHSVRIVUJfQUNUSU9OU19QUk9WSURFUl9JRCA9IFwiZ2l0aHViLWFjdGlvbnNcIjtcblxuLyoqXG4gKiBIYXJkIGNhcCBvbiB0aGUgZXhjZXJwdCBoYW5kZWQgdG8gdGhlIGZpeCBwcm9tcHQgKDE2IEtpQikuXG4gKlxuICogRGVsaWJlcmF0ZWx5IHNtYWxsZXIgdGhhbiBhbnkgc2Vuc2libGUgZmV0Y2gtc2lkZSBjYXA6IGEgcHJvdmlkZXIgYm91bmRzXG4gKiB3aGF0IGl0IHB1bGxzIG9mZiB0aGUgd2lyZSwgYW5kIHRoaXMgYm91bmRzIHdoYXQgcmVhY2hlcyB0aGUgbW9kZWwsIHNvIGFcbiAqIG11bHRpLW1lZ2FieXRlIEFjdGlvbnMgbG9nIGNhbm5vdCBibG93IHRoZSBjb250ZXh0LlxuICovXG5leHBvcnQgY29uc3QgTUFYX0FDVElPTlNfRVhDRVJQVF9CWVRFUyA9IDE2ICogMTAyNDtcblxuLyoqIExpbmVzIG9mIGNvbnRleHQga2VwdCBiZWZvcmUgdGhlIGZpcnN0IGZhaWx1cmUgbWFya2VyLiAqL1xuY29uc3QgRkFJTFVSRV9MRUFEX0xJTkVTID0gMzA7XG4vKiogTGluZXMgb2YgY29udGV4dCBrZXB0IGFmdGVyIHRoZSBmaXJzdCBmYWlsdXJlIG1hcmtlci4gKi9cbmNvbnN0IEZBSUxVUkVfVFJBSUxfTElORVMgPSAxMjA7XG4vKiogTGluZXMgb2YgbG9nIHRhaWwgYWx3YXlzIGtlcHQg4oCUIGZhaWx1cmVzIHVzdWFsbHkgc3VyZmFjZSBhdCB0aGUgZW5kLiAqL1xuY29uc3QgVEFJTF9MSU5FUyA9IDIwMDtcblxuLyoqIEluamVjdGFibGUgYGdoYCBDTEkgcnVubmVyIChyZXR1cm5zIHN0ZG91dCkuICovXG5leHBvcnQgdHlwZSBHaENvbW1hbmRGbiA9IChhcmdzOiBzdHJpbmdbXSkgPT4gUHJvbWlzZTxzdHJpbmc+O1xuXG4vKiogUmVzdWx0IG9mIHJlc29sdmluZyBhIGZhaWxpbmcgY2hlY2sgcnVuIHRvIGFuIEFjdGlvbnMgam9iIGlkLiAqL1xuZXhwb3J0IHR5cGUgQWN0aW9uc0pvYlJlc29sdXRpb24gPVxuICB8IHsga2luZDogXCJqb2JcIjsgam9iSWQ6IG51bWJlciB9XG4gIHwgeyBraW5kOiBcIm5vdC1hcHBsaWNhYmxlXCI7IHJlYXNvbjogc3RyaW5nIH1cbiAgfCB7IGtpbmQ6IFwiZXJyb3JcIjsgZXJyb3I6IHN0cmluZyB9O1xuXG4vKiogUmVzdWx0IG9mIHRoZSBlbmQtdG8tZW5kIHByb3ZpZGVyIGNhbGwuICovXG5leHBvcnQgdHlwZSBBY3Rpb25zTG9nT3V0Y29tZSA9XG4gIHwge1xuICAgIGtpbmQ6IFwiZXhjZXJwdFwiO1xuICAgIHByb3ZpZGVySWQ6IHR5cGVvZiBHSVRIVUJfQUNUSU9OU19QUk9WSURFUl9JRDtcbiAgICBqb2JJZDogbnVtYmVyO1xuICAgIGV4Y2VycHQ6IHN0cmluZztcbiAgfVxuICB8IHsga2luZDogXCJub3QtYXBwbGljYWJsZVwiOyByZWFzb246IHN0cmluZyB9XG4gIHwgeyBraW5kOiBcImVycm9yXCI7IGVycm9yOiBzdHJpbmcgfTtcblxuLyoqIE9wdGlvbnMgc2hhcmVkIGJ5IHJlc29sdXRpb24gYW5kIHRoZSBlbmQtdG8tZW5kIGZldGNoLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBY3Rpb25zTG9nT3B0aW9ucyB7XG4gIC8qKiBSZXBvc2l0b3J5IGluIGBvd25lci9yZXBvYCBmb3JtYXQuICovXG4gIHJlcG86IHN0cmluZztcbiAgLyoqIEdpdEh1YiBjaGVjayBydW4gaWQgb2YgdGhlIGZhaWxpbmcgY2hlY2suICovXG4gIGNoZWNrUnVuSWQ6IHN0cmluZztcbiAgLyoqIEZhaWxpbmcgY2hlY2sgbmFtZSDigJQgdXNlZCB0byBwaWNrIHRoZSBqb2IgZnJvbSBhIHJ1biBsaXN0aW5nLiAqL1xuICBjaGVja05hbWU/OiBzdHJpbmc7XG4gIC8qKiBDaGVjayBgdGFyZ2V0X3VybGAgLyBgZGV0YWlsc191cmxgIHdoZW4gdGhlIGNhbGxlciBhbHJlYWR5IGhhcyBpdC4gKi9cbiAgdGFyZ2V0VXJsPzogc3RyaW5nO1xuICAvKiogSW5qZWN0YWJsZSBgZ2hgIHJ1bm5lci4gKi9cbiAgZ2hGbjogR2hDb21tYW5kRm47XG4gIC8qKiBPdmVycmlkZSB0aGUgZXhjZXJwdCBieXRlIGNhcCAoZGVmYXVsdHMgdG8ge0BsaW5rIE1BWF9BQ1RJT05TX0VYQ0VSUFRfQllURVN9KS4gKi9cbiAgbWF4Qnl0ZXM/OiBudW1iZXI7XG59XG5cbi8qKiBQYXJzZWQgc2hhcGUgb2YgYW4gQWN0aW9ucyBjaGVjayBgZGV0YWlsc191cmxgLiAqL1xuZXhwb3J0IHR5cGUgQWN0aW9uc0NoZWNrVXJsID1cbiAgfCB7IGtpbmQ6IFwiam9iXCI7IHJ1bklkOiBudW1iZXI7IGpvYklkOiBudW1iZXIgfVxuICB8IHsga2luZDogXCJydW5cIjsgcnVuSWQ6IG51bWJlciB9XG4gIHwgeyBraW5kOiBcIm90aGVyXCIgfTtcblxuLyoqXG4gKiBIb3N0cyB3aG9zZSBBY3Rpb25zIFVSTHMgdGhlIGJ1aWx0LWluIHByb3ZpZGVyIHdpbGwgY2xhaW0uXG4gKlxuICogR2l0SHViIEVudGVycHJpc2UgaG9zdHMgYXJlIGRlbGliZXJhdGVseSBhYnNlbnQ6IHRoZSBwcm92aWRlciBkZWNsaW5lc1xuICogcmF0aGVyIHRoYW4gZ3Vlc3NpbmcsIHNvIGFuIEVudGVycHJpc2UgZGVwbG95bWVudCBnZXRzIG5vIGxvZyBleGNlcnB0XG4gKiBpbnN0ZWFkIG9mIGEgd3JvbmdseS10cnVzdGVkIG9yaWdpbi4gRGVjbGluaW5nIGlzIHRoZSBzYWZlIGRpcmVjdGlvbi5cbiAqL1xuY29uc3QgR0lUSFVCX0hPU1RTOiBSZWFkb25seVNldDxzdHJpbmc+ID0gbmV3IFNldChbXG4gIFwiZ2l0aHViLmNvbVwiLFxuICBcInd3dy5naXRodWIuY29tXCIsXG5dKTtcblxuLyoqIFdoZXRoZXIgYGhvc3RuYW1lYCBpcyBhIEdpdEh1YiBob3N0IHRoaXMgcHJvdmlkZXIgd2lsbCBjbGFpbS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0dpdGh1Ykhvc3QoaG9zdG5hbWU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gR0lUSFVCX0hPU1RTLmhhcyhob3N0bmFtZS50b0xvd2VyQ2FzZSgpKTtcbn1cblxuLyoqXG4gKiBQYXJzZSBhIGNoZWNrIGBkZXRhaWxzX3VybGAgaW50byB0aGUgQWN0aW9ucyBydW4vam9iIGlkcyBpdCBlbmNvZGVzLlxuICpcbiAqIEFjdGlvbnMgY2hlY2sgcnVucyBwb2ludCBhdCBgL3tvd25lcn0ve3JlcG99L2FjdGlvbnMvcnVucy97cnVufS9qb2Ive2pvYn1gXG4gKiAodGhlIGAvam9icy97am9ifWAgc3BlbGxpbmcgYWxzbyBvY2N1cnMpLiBBIGNoZWNrLXN1aXRlIGVudHJ5IG1heSBvbmx5XG4gKiBjYXJyeSB0aGUgcnVuLiBBbnl0aGluZyBlbHNlIOKAlCBhbm90aGVyIENJIHN5c3RlbSdzIGJ1aWxkIFVSTCwgYW4gZW1wdHlcbiAqIHN0cmluZyDigJQgaXMgYG90aGVyYC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlQWN0aW9uc0NoZWNrVXJsKHVybDogc3RyaW5nKTogQWN0aW9uc0NoZWNrVXJsIHtcbiAgaWYgKCF1cmwpIHJldHVybiB7IGtpbmQ6IFwib3RoZXJcIiB9O1xuXG4gIC8vIFRoZSBvcmlnaW4gaXMgY2hlY2tlZCBiZWZvcmUgdGhlIHBhdGgsIGFuZCBhIHZhbHVlIHRoYXQgaXMgbm90IGFuXG4gIC8vIGFic29sdXRlIEdpdEh1YiBVUkwgaXMgYG90aGVyYCByYXRoZXIgdGhhbiBiZWluZyBtYXRjaGVkIG9uIHNoYXBlLlxuICAvL1xuICAvLyBUaGlzIGZ1bmN0aW9uIGRlY2lkZXMgd2hldGhlciB0aGUgYnVpbHQtaW4gcHJvdmlkZXIgQ0xBSU1TIGEgZmFpbGluZ1xuICAvLyBjaGVjaywgYW5kIGl0cyBpbnB1dCByZWFjaGVzIGhlcmUgZnJvbSB1bnRydXN0ZWQgcGxhY2VzIOKAlCBhIGBCdWlsZCBVUkxgXG4gIC8vIGxpbmUgaW4gYW4gaXNzdWUgYm9keSAoYGNpX2ZhaWx1cmVfaXNzdWUudHNgIGNhbGxzIHRoYXQgYm9keSB1bnRydXN0ZWQgaW5cbiAgLy8gaXRzIG93biBoZWFkZXIpIGFuZCBhIGNoZWNrIHJ1bidzIGBkZXRhaWxzX3VybGAuIE1hdGNoaW5nIG9uIHRoZSBwYXRoXG4gIC8vIGFsb25lIG1lYW50IGBodHRwczovL2F0dGFja2VyLmV4YW1wbGUvby9yL2FjdGlvbnMvcnVucy8xL2pvYi8yYCBwYXJzZWQgYXNcbiAgLy8gYSBqb2I6IHRoZSBwcm92aWRlciBjbGFpbWVkIGl0LCBhbmQgdGhlIGNhbGxlciBlY2hvZWQgdGhlIGF0dGFja2VyJ3NcbiAgLy8gc3RyaW5nIGJhY2sgaW50byB0aGUgQ0ktZml4IHByb21wdC4gVGhlIGxvZyBpdHNlbGYgd2FzIGFsd2F5cyBmZXRjaGVkXG4gIC8vIHRocm91Z2ggYGdoIGFwaWAgZnJvbSByZWFsIEdpdEh1Yiwgc28gbm90aGluZyB3YXMgZXZlciByZWFkIGZyb20gdGhlXG4gIC8vIGZvcmVpZ24gaG9zdCDigJQgd2hhdCBsZWFrZWQgd2FzIGFuIGF0dGFja2VyLWNob3NlbiBzdHJpbmcgaW50byBhIHByb21wdCxcbiAgLy8gYW5kIGEgZmFsc2UgYWNjb3VudCBvZiB3aGVyZSB0aGUgbG9nIGNhbWUgZnJvbS5cbiAgLy9cbiAgLy8gQSByZWxhdGl2ZSBwYXRoIGlzIHJlZnVzZWQgZm9yIHRoZSBzYW1lIHJlYXNvbjogYW4gb3JpZ2luIHRoYXQgY2Fubm90IGJlXG4gIC8vIGVzdGFibGlzaGVkIGlzIG5vdCBvbmUgdGhhdCBjYW4gYmUgdHJ1c3RlZC4gR2l0SHViJ3MgYGRldGFpbHNfdXJsYCBpc1xuICAvLyBhbHdheXMgYWJzb2x1dGUsIHNvIG5vdGhpbmcgbGVnaXRpbWF0ZSBpcyBsb3N0LlxuICBsZXQgcGFyc2VkOiBVUkw7XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gbmV3IFVSTCh1cmwpO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBraW5kOiBcIm90aGVyXCIgfTtcbiAgfVxuICBpZiAoIWlzR2l0aHViSG9zdChwYXJzZWQuaG9zdG5hbWUpKSByZXR1cm4geyBraW5kOiBcIm90aGVyXCIgfTtcbiAgY29uc3QgcGF0aCA9IHBhcnNlZC5wYXRobmFtZTtcblxuICBjb25zdCBqb2IgPSAvXFwvYWN0aW9uc1xcL3J1bnNcXC8oXFxkKylcXC9qb2JzP1xcLyhcXGQrKS8uZXhlYyhwYXRoKTtcbiAgaWYgKGpvYikge1xuICAgIHJldHVybiB7IGtpbmQ6IFwiam9iXCIsIHJ1bklkOiBOdW1iZXIoam9iWzFdKSwgam9iSWQ6IE51bWJlcihqb2JbMl0pIH07XG4gIH1cblxuICBjb25zdCBydW4gPSAvXFwvYWN0aW9uc1xcL3J1bnNcXC8oXFxkKykvLmV4ZWMocGF0aCk7XG4gIGlmIChydW4pIHJldHVybiB7IGtpbmQ6IFwicnVuXCIsIHJ1bklkOiBOdW1iZXIocnVuWzFdKSB9O1xuXG4gIHJldHVybiB7IGtpbmQ6IFwib3RoZXJcIiB9O1xufVxuXG4vKiogUnVuIGBnaCBhcGkgPGVuZHBvaW50PmAgYW5kIHJldHVybiBzdGRvdXQsIG9yIGEgZGVzY3JpcHRpdmUgZXJyb3IuICovXG5hc3luYyBmdW5jdGlvbiBnaEFwaShcbiAgZ2hGbjogR2hDb21tYW5kRm4sXG4gIGVuZHBvaW50OiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgb2s6IHRydWU7IGJvZHk6IHN0cmluZyB9IHwgeyBvazogZmFsc2U7IGVycm9yOiBzdHJpbmcgfT4ge1xuICB0cnkge1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCBib2R5OiBhd2FpdCBnaEZuKFtcImFwaVwiLCBlbmRwb2ludF0pIH07XG4gIH0gY2F0Y2ggKGVycjogdW5rbm93bikge1xuICAgIGNvbnN0IG1lc3NhZ2UgPSBlcnIgaW5zdGFuY2VvZiBFcnJvciA/IGVyci5tZXNzYWdlIDogU3RyaW5nKGVycik7XG4gICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYGdoIGFwaSAke2VuZHBvaW50fSBmYWlsZWQ6ICR7bWVzc2FnZX1gIH07XG4gIH1cbn1cblxuLyoqXG4gKiBUZXJtaW5hbCBjb250cm9sIHNlcXVlbmNlcyB0aGF0IEFjdGlvbnMgbG9ncyBjYXJyeSAoY29sb3VyLCBjdXJzb3IsXG4gKiBPU0MgdGl0bGVzKS4gQnVpbHQgZnJvbSB0aGUgZXNjYXBlIGJ5dGUgYXQgcnVudGltZSDigJQgYSBsaXRlcmFsIGNvbnRyb2xcbiAqIGNoYXJhY3RlciBpbiBhIHJlZ2V4IHNvdXJjZSB0cmlwcyBgbm8tY29udHJvbC1yZWdleGAuXG4gKi9cbmNvbnN0IEVTQyA9IFN0cmluZy5mcm9tQ2hhckNvZGUoMHgxYik7XG5jb25zdCBCRUwgPSBTdHJpbmcuZnJvbUNoYXJDb2RlKDB4MDcpO1xuY29uc3QgQU5TSV9SRSA9IG5ldyBSZWdFeHAoXG4gIGAke0VTQ31cXFxcW1s/MC05O10qW0EtWmEtel18JHtFU0N9XFxcXF1bXiR7QkVMfSR7RVNDfV0qKD86JHtCRUx9fCR7RVNDfVxcXFxcXFxcKWAsXG4gIFwiZ1wiLFxuKTtcblxuLyoqIFN0cmlwIEFOU0kvT1NDIGVzY2FwZSBzZXF1ZW5jZXMgZnJvbSBhIGZldGNoZWQgbG9nLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN0cmlwQW5zaSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKEFOU0lfUkUsIFwiXCIpO1xufVxuXG4vKiogVGhlIHJlZnVzYWwgYGdoYCDiiaUgMi45eCBnaXZlcyBmb3IgYSBib2R5IGNhcnJ5aW5nIGVzY2FwZSBzZXF1ZW5jZXMuICovXG5jb25zdCBFU0NBUEVfU0VRVUVOQ0VfUkVGVVNBTCA9IC9hbGxvdy1lc2NhcGUtc2VxdWVuY2VzL2k7XG5cbi8qKlxuICogRmV0Y2ggYSByYXcgbG9nIGJvZHkgKElzc3VlICM0Mzc2KS4gQWN0aW9ucyBsb2dzIGFsd2F5cyBjb250YWluIEFOU0lcbiAqIGNvbG91ciBjb2RlcywgYW5kIGBnaGAg4omlIDIuOXggcmVmdXNlcyB0byBlbWl0IHN1Y2ggYSByZXNwb25zZSB1bmxlc3NcbiAqIGAtLWFsbG93LWVzY2FwZS1zZXF1ZW5jZXNgIGlzIHBhc3NlZCDigJQgb2JzZXJ2ZWQgbGl2ZSBhcyBcIk5vIENJIGxvZ1xuICogcHJvdmlkZXIgcHJvZHVjZWQgYW4gZXhjZXJwdCDigKYgcGFzcyAtLWFsbG93LWVzY2FwZS1zZXF1ZW5jZXMgdG8gb3V0cHV0XG4gKiBpdCBhbnl3YXlcIiwgd2hpY2ggbGVmdCB0aGUgQ0ktZml4IGFnZW50IHdvcmtpbmcgYmxpbmQuIFRoZSBmbGFnIGlzIHBhc3NlZFxuICogZmlyc3Q7IGEgYGdoYCB0b28gb2xkIHRvIGtub3cgaXQgKFwidW5rbm93biBmbGFnXCIpIGdldHMgdGhlIHBsYWluIGNhbGwuXG4gKiBUaGUgYm9keSBpcyBBTlNJLXN0cmlwcGVkIGVpdGhlciB3YXkuXG4gKi9cbmFzeW5jIGZ1bmN0aW9uIGdoQXBpTG9ncyhcbiAgZ2hGbjogR2hDb21tYW5kRm4sXG4gIGVuZHBvaW50OiBzdHJpbmcsXG4pOiBQcm9taXNlPHsgb2s6IHRydWU7IGJvZHk6IHN0cmluZyB9IHwgeyBvazogZmFsc2U7IGVycm9yOiBzdHJpbmcgfT4ge1xuICB0cnkge1xuICAgIGNvbnN0IGJvZHkgPSBhd2FpdCBnaEZuKFtcImFwaVwiLCBcIi0tYWxsb3ctZXNjYXBlLXNlcXVlbmNlc1wiLCBlbmRwb2ludF0pO1xuICAgIHJldHVybiB7IG9rOiB0cnVlLCBib2R5OiBzdHJpcEFuc2koYm9keSkgfTtcbiAgfSBjYXRjaCAoZXJyOiB1bmtub3duKSB7XG4gICAgY29uc3QgbWVzc2FnZSA9IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKTtcbiAgICBpZiAoXG4gICAgICAhL3Vua25vd24gZmxhZ3x1bmtub3duIG9wdGlvbnx1bnJlY29nbmlzZWR8dW5yZWNvZ25pemVkL2kudGVzdChtZXNzYWdlKVxuICAgICkge1xuICAgICAgLy8gVGhlIGZsYWdnZWQgY2FsbCBpcyB0aGUgcmlnaHQgb25lIG9uIGEgY3VycmVudCBnaDsgcmVwb3J0IGl0cyBlcnJvclxuICAgICAgLy8gdW5sZXNzIHRoZSBmbGFnIGl0c2VsZiB3YXMgdGhlIHByb2JsZW0uXG4gICAgICBpZiAoIUVTQ0FQRV9TRVFVRU5DRV9SRUZVU0FMLnRlc3QobWVzc2FnZSkpIHtcbiAgICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogYGdoIGFwaSAke2VuZHBvaW50fSBmYWlsZWQ6ICR7bWVzc2FnZX1gIH07XG4gICAgICB9XG4gICAgfVxuICB9XG4gIC8vIE9sZGVyIGdoOiBubyBzdWNoIGZsYWcgKG9yIGEgcmVmdXNhbCB3ZSBjYW5ub3QgZXhwbGFpbikg4oCUIHBsYWluIGNhbGwuXG4gIGNvbnN0IHBsYWluID0gYXdhaXQgZ2hBcGkoZ2hGbiwgZW5kcG9pbnQpO1xuICByZXR1cm4gcGxhaW4ub2sgPyB7IG9rOiB0cnVlLCBib2R5OiBzdHJpcEFuc2kocGxhaW4uYm9keSkgfSA6IHBsYWluO1xufVxuXG4vKipcbiAqIFJlc29sdmUgYSBmYWlsaW5nIGNoZWNrIHJ1biB0byBhIEdpdEh1YiBBY3Rpb25zIGpvYiBpZC5cbiAqXG4gKiBSZXNvbHV0aW9uIG9yZGVyOlxuICogMS4gQSBzdXBwbGllZCBgdGFyZ2V0VXJsYCB0aGF0IGFscmVhZHkgZW5jb2RlcyB0aGUgam9iIGlkLlxuICogMi4gVGhlIGNoZWNrLXJ1biBBUEkgKGAvcmVwb3Mve3JlcG99L2NoZWNrLXJ1bnMve2lkfWApIOKAlCBpdHNcbiAqICAgIGBkZXRhaWxzX3VybGAgY2FycmllcyB0aGUgam9iIGlkLCBhbmQgYGFwcC5zbHVnYCB0ZWxscyB1cyB3aGV0aGVyXG4gKiAgICB0aGUgY2hlY2sgaXMgYW4gQWN0aW9ucyBqb2IgYXQgYWxsLlxuICogMy4gV2hlbiBvbmx5IGEgcnVuIGlkIGlzIGtub3duLCB0aGUgcnVuJ3Mgam9iIGxpc3RpbmcsIG1hdGNoZWQgb25cbiAqICAgIGNoZWNrIG5hbWUgYW5kIGZhbGxpbmcgYmFjayB0byB0aGUgZmlyc3Qgbm9uLXN1Y2Nlc3NmdWwgam9iLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUFjdGlvbnNKb2JJZChcbiAgb3B0czogQWN0aW9uc0xvZ09wdGlvbnMsXG4pOiBQcm9taXNlPEFjdGlvbnNKb2JSZXNvbHV0aW9uPiB7XG4gIGNvbnN0IHsgcmVwbywgY2hlY2tSdW5JZCwgY2hlY2tOYW1lLCB0YXJnZXRVcmwsIGdoRm4gfSA9IG9wdHM7XG4gIGlmIChwYXJzZUNoZWNrU3VpdGVJZChjaGVja1J1bklkKSAhPT0gbnVsbCkge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcIm5vdC1hcHBsaWNhYmxlXCIsXG4gICAgICByZWFzb246IFwic3RhcnR1cC1mYWlsZWQgc3VpdGUgaGFzIG5vIEFjdGlvbnMgam9iXCIsXG4gICAgfTtcbiAgfVxuXG4gIGlmICh0YXJnZXRVcmwpIHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZUFjdGlvbnNDaGVja1VybCh0YXJnZXRVcmwpO1xuICAgIGlmIChwYXJzZWQua2luZCA9PT0gXCJqb2JcIikgcmV0dXJuIHsga2luZDogXCJqb2JcIiwgam9iSWQ6IHBhcnNlZC5qb2JJZCB9O1xuICAgIGlmIChwYXJzZWQua2luZCA9PT0gXCJydW5cIikge1xuICAgICAgcmV0dXJuIGF3YWl0IHJlc29sdmVKb2JGcm9tUnVuKHJlcG8sIHBhcnNlZC5ydW5JZCwgY2hlY2tOYW1lLCBnaEZuKTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IFwibm90LWFwcGxpY2FibGVcIixcbiAgICAgIHJlYXNvbjogYGNoZWNrIHRhcmdldCBVUkwgaXMgbm90IGEgR2l0SHViIEFjdGlvbnMgam9iIFVSTDogJHt0YXJnZXRVcmx9YCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBnaEFwaShnaEZuLCBgcmVwb3MvJHtyZXBvfS9jaGVjay1ydW5zLyR7Y2hlY2tSdW5JZH1gKTtcbiAgaWYgKCFyZXNwb25zZS5vaykgcmV0dXJuIHsga2luZDogXCJlcnJvclwiLCBlcnJvcjogcmVzcG9uc2UuZXJyb3IgfTtcblxuICBsZXQgY2hlY2tSdW46IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmVzcG9uc2UuYm9keSk7XG4gICAgaWYgKHR5cGVvZiBwYXJzZWQgIT09IFwib2JqZWN0XCIgfHwgcGFyc2VkID09PSBudWxsKSB7XG4gICAgICByZXR1cm4geyBraW5kOiBcImVycm9yXCIsIGVycm9yOiBcImNoZWNrLXJ1biByZXNwb25zZSB3YXMgbm90IGFuIG9iamVjdFwiIH07XG4gICAgfVxuICAgIGNoZWNrUnVuID0gcGFyc2VkIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBraW5kOiBcImVycm9yXCIsIGVycm9yOiBcImNoZWNrLXJ1biByZXNwb25zZSB3YXMgbm90IHZhbGlkIEpTT05cIiB9O1xuICB9XG5cbiAgY29uc3QgYXBwID0gY2hlY2tSdW5bXCJhcHBcIl0gYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHNsdWcgPSB0eXBlb2YgYXBwPy5bXCJzbHVnXCJdID09PSBcInN0cmluZ1wiID8gYXBwW1wic2x1Z1wiXSA6IFwiXCI7XG4gIGlmIChzbHVnICE9PSBcIlwiICYmIHNsdWcgIT09IEdJVEhVQl9BQ1RJT05TX1BST1ZJREVSX0lEKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IFwibm90LWFwcGxpY2FibGVcIixcbiAgICAgIHJlYXNvbjogYGNoZWNrIHJ1biBpcyBvd25lZCBieSAnJHtzbHVnfScsIG5vdCBHaXRIdWIgQWN0aW9uc2AsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IGRldGFpbHNVcmwgPSB0eXBlb2YgY2hlY2tSdW5bXCJkZXRhaWxzX3VybFwiXSA9PT0gXCJzdHJpbmdcIlxuICAgID8gY2hlY2tSdW5bXCJkZXRhaWxzX3VybFwiXVxuICAgIDogXCJcIjtcbiAgY29uc3QgcGFyc2VkRGV0YWlscyA9IHBhcnNlQWN0aW9uc0NoZWNrVXJsKGRldGFpbHNVcmwpO1xuICBpZiAocGFyc2VkRGV0YWlscy5raW5kID09PSBcImpvYlwiKSB7XG4gICAgcmV0dXJuIHsga2luZDogXCJqb2JcIiwgam9iSWQ6IHBhcnNlZERldGFpbHMuam9iSWQgfTtcbiAgfVxuICBpZiAocGFyc2VkRGV0YWlscy5raW5kID09PSBcInJ1blwiKSB7XG4gICAgcmV0dXJuIGF3YWl0IHJlc29sdmVKb2JGcm9tUnVuKHJlcG8sIHBhcnNlZERldGFpbHMucnVuSWQsIGNoZWNrTmFtZSwgZ2hGbik7XG4gIH1cblxuICByZXR1cm4ge1xuICAgIGtpbmQ6IFwibm90LWFwcGxpY2FibGVcIixcbiAgICByZWFzb246IFwiY2hlY2sgcnVuIGhhcyBubyBHaXRIdWIgQWN0aW9ucyBqb2IgVVJMXCIsXG4gIH07XG59XG5cbi8qKiBQaWNrIHRoZSBmYWlsaW5nIGpvYiBvZiBhIHdvcmtmbG93IHJ1biBieSBuYW1lLCBlbHNlIHRoZSBmaXJzdCBmYWlsdXJlLiAqL1xuYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUpvYkZyb21SdW4oXG4gIHJlcG86IHN0cmluZyxcbiAgcnVuSWQ6IG51bWJlcixcbiAgY2hlY2tOYW1lOiBzdHJpbmcgfCB1bmRlZmluZWQsXG4gIGdoRm46IEdoQ29tbWFuZEZuLFxuKTogUHJvbWlzZTxBY3Rpb25zSm9iUmVzb2x1dGlvbj4ge1xuICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGdoQXBpKFxuICAgIGdoRm4sXG4gICAgYHJlcG9zLyR7cmVwb30vYWN0aW9ucy9ydW5zLyR7cnVuSWR9L2pvYnM/cGVyX3BhZ2U9MTAwYCxcbiAgKTtcbiAgaWYgKCFyZXNwb25zZS5vaykgcmV0dXJuIHsga2luZDogXCJlcnJvclwiLCBlcnJvcjogcmVzcG9uc2UuZXJyb3IgfTtcblxuICBsZXQgam9iczogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmVzcG9uc2UuYm9keSkgYXMgeyBqb2JzPzogdW5rbm93biB9O1xuICAgIGpvYnMgPSBBcnJheS5pc0FycmF5KHBhcnNlZC5qb2JzKVxuICAgICAgPyBwYXJzZWQuam9icyBhcyBBcnJheTxSZWNvcmQ8c3RyaW5nLCB1bmtub3duPj5cbiAgICAgIDogW107XG4gIH0gY2F0Y2gge1xuICAgIHJldHVybiB7IGtpbmQ6IFwiZXJyb3JcIiwgZXJyb3I6IFwicnVuIGpvYnMgcmVzcG9uc2Ugd2FzIG5vdCB2YWxpZCBKU09OXCIgfTtcbiAgfVxuXG4gIGNvbnN0IGJ5TmFtZSA9IGNoZWNrTmFtZVxuICAgID8gam9icy5maW5kKChqKSA9PiBqW1wibmFtZVwiXSA9PT0gY2hlY2tOYW1lKVxuICAgIDogdW5kZWZpbmVkO1xuICBjb25zdCBmYWlsaW5nID0gam9icy5maW5kKChqKSA9PlxuICAgIGpbXCJjb25jbHVzaW9uXCJdID09PSBcImZhaWx1cmVcIiB8fCBqW1wiY29uY2x1c2lvblwiXSA9PT0gXCJ0aW1lZF9vdXRcIlxuICApO1xuICBjb25zdCBjaG9zZW4gPSBieU5hbWUgPz8gZmFpbGluZztcbiAgY29uc3Qgam9iSWQgPSB0eXBlb2YgY2hvc2VuPy5bXCJpZFwiXSA9PT0gXCJudW1iZXJcIiA/IGNob3NlbltcImlkXCJdIDogTmFOO1xuXG4gIGlmICghTnVtYmVyLmlzRmluaXRlKGpvYklkKSkge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcIm5vdC1hcHBsaWNhYmxlXCIsXG4gICAgICByZWFzb246IGB3b3JrZmxvdyBydW4gJHtydW5JZH0gaGFzIG5vIHJlc29sdmFibGUgZmFpbGluZyBqb2JgLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsga2luZDogXCJqb2JcIiwgam9iSWQgfTtcbn1cblxuLyoqIFJlc3VsdCBvZiByZXNvbHZpbmcgdGhlIHN0ZXAgdGhhdCBmYWlsZWQgaW5zaWRlIGFuIEFjdGlvbnMgam9iLiAqL1xuZXhwb3J0IHR5cGUgRmFpbGVkU3RlcFJlc29sdXRpb24gPVxuICB8IHsga2luZDogXCJzdGVwXCI7IG5hbWU6IHN0cmluZzsgZmFpbGVkU3RlcHM6IHN0cmluZ1tdIH1cbiAgfCB7IGtpbmQ6IFwibm90LWFwcGxpY2FibGVcIjsgcmVhc29uOiBzdHJpbmcgfVxuICB8IHsga2luZDogXCJlcnJvclwiOyBlcnJvcjogc3RyaW5nIH07XG5cbi8qKlxuICogTmFtZSB0aGUgZmlyc3Qgc3RlcCB0aGF0IGZhaWxlZCBpbnNpZGUgdGhlIEFjdGlvbnMgam9iIGJlaGluZCBhIGNoZWNrXG4gKiBydW4gKElzc3VlICMxNTc5KS5cbiAqXG4gKiBBIEdpdEh1YiBBY3Rpb25zICpqb2IqIGJ1bmRsZXMgbWFueSBzdGVwcywgYW5kIGl0cyBjaGVjayBuYW1lIHNheXNcbiAqIG5vdGhpbmcgYWJvdXQgd2hpY2ggb2YgdGhlbSBmYWlsZWQg4oCUIE5FQVQtQUktY29yZSdzIGBTY3JpcHRzICYgc3BlbGxpbmdgXG4gKiBqb2IgcnVucyBiYXRzIGFuZCBjb2Rlc3BlbGwgdW5kZXIgb25lIG5hbWUuIENhbGxlcnMgcm91dGluZyBhIGZhaWx1cmUgdG9cbiAqIGEgc3BlY2lhbGlzZWQgZml4ZXIgbmVlZCB0aGUgc3RlcCwgbm90IHRoZSBqb2IgbmFtZS5cbiAqXG4gKiBgbmFtZWAgaXMgdGhlIGZpcnN0IGZhaWxlZCBzdGVwOyBgZmFpbGVkU3RlcHNgIGxpc3RzIGV2ZXJ5IGZhaWxlZCBzdGVwLFxuICogYmVjYXVzZSBhIGpvYiBjb25maWd1cmVkIHdpdGggYGNvbnRpbnVlLW9uLWVycm9yYCBjYW4gZmFpbCBpbiBtb3JlIHRoYW5cbiAqIG9uZSwgYW5kIGEgY2FsbGVyIHJvdXRpbmcgb24gdGhlIHN0ZXAgbmVlZHMgdG8gc2VlIGFsbCBvZiB0aGVtLlxuICpcbiAqIFJldHVybnMgYG5vdC1hcHBsaWNhYmxlYCB3aGVuIHRoZSBjaGVjayBpcyBub3QgYW4gQWN0aW9ucyBqb2Igb3IgdGhlIGpvYlxuICogcmVwb3J0cyBubyBmYWlsZWQgc3RlcCwgYW5kIGBlcnJvcmAgd2hlbiB0aGUgbG9va3VwIGl0c2VsZiBmYWlsZWQuIE5ldmVyXG4gKiB0aHJvd3MsIGFuZCBuZXZlciBndWVzc2VzIGEgc3RlcCBuYW1lLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVzb2x2ZUZhaWxlZFN0ZXBOYW1lKFxuICBvcHRzOiBBY3Rpb25zTG9nT3B0aW9ucyxcbik6IFByb21pc2U8RmFpbGVkU3RlcFJlc29sdXRpb24+IHtcbiAgY29uc3QgcmVzb2x1dGlvbiA9IGF3YWl0IHJlc29sdmVBY3Rpb25zSm9iSWQob3B0cyk7XG4gIGlmIChyZXNvbHV0aW9uLmtpbmQgIT09IFwiam9iXCIpIHJldHVybiByZXNvbHV0aW9uO1xuXG4gIGNvbnN0IHJlc3BvbnNlID0gYXdhaXQgZ2hBcGkoXG4gICAgb3B0cy5naEZuLFxuICAgIGByZXBvcy8ke29wdHMucmVwb30vYWN0aW9ucy9qb2JzLyR7cmVzb2x1dGlvbi5qb2JJZH1gLFxuICApO1xuICBpZiAoIXJlc3BvbnNlLm9rKSByZXR1cm4geyBraW5kOiBcImVycm9yXCIsIGVycm9yOiByZXNwb25zZS5lcnJvciB9O1xuXG4gIGxldCBzdGVwczogQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+O1xuICB0cnkge1xuICAgIGNvbnN0IHBhcnNlZCA9IEpTT04ucGFyc2UocmVzcG9uc2UuYm9keSkgYXMgeyBzdGVwcz86IHVua25vd24gfTtcbiAgICBzdGVwcyA9IEFycmF5LmlzQXJyYXkocGFyc2VkLnN0ZXBzKVxuICAgICAgPyBwYXJzZWQuc3RlcHMgYXMgQXJyYXk8UmVjb3JkPHN0cmluZywgdW5rbm93bj4+XG4gICAgICA6IFtdO1xuICB9IGNhdGNoIHtcbiAgICByZXR1cm4geyBraW5kOiBcImVycm9yXCIsIGVycm9yOiBcImpvYiByZXNwb25zZSB3YXMgbm90IHZhbGlkIEpTT05cIiB9O1xuICB9XG5cbiAgY29uc3QgZmFpbGVkU3RlcHMgPSBzdGVwc1xuICAgIC5maWx0ZXIoKHN0ZXApID0+IHN0ZXBbXCJjb25jbHVzaW9uXCJdID09PSBcImZhaWx1cmVcIilcbiAgICAubWFwKChzdGVwKSA9PiB0eXBlb2Ygc3RlcFtcIm5hbWVcIl0gPT09IFwic3RyaW5nXCIgPyBzdGVwW1wibmFtZVwiXSA6IFwiXCIpXG4gICAgLmZpbHRlcigobmFtZSkgPT4gbmFtZSAhPT0gXCJcIik7XG4gIGNvbnN0IG5hbWUgPSBmYWlsZWRTdGVwc1swXTtcbiAgaWYgKG5hbWUgPT09IHVuZGVmaW5lZCkge1xuICAgIHJldHVybiB7XG4gICAgICBraW5kOiBcIm5vdC1hcHBsaWNhYmxlXCIsXG4gICAgICByZWFzb246IGBBY3Rpb25zIGpvYiAke3Jlc29sdXRpb24uam9iSWR9IHJlcG9ydHMgbm8gZmFpbGVkIHN0ZXBgLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsga2luZDogXCJzdGVwXCIsIG5hbWUsIGZhaWxlZFN0ZXBzIH07XG59XG5cbi8qKlxuICogU3RyaXAgdGhlIElTTy04NjAxIHRpbWVzdGFtcCBHaXRIdWIgQWN0aW9ucyBwcmVwZW5kcyB0byBldmVyeSBsb2dcbiAqIGxpbmUuIFRoZSB0aW1lc3RhbXBzIGJ1cm4gY29udGV4dCBmb3Igbm8gZGlhZ25vc3RpYyBzaWduYWwuIExpbmVzXG4gKiB3aXRob3V0IGEgcHJlZml4IGFyZSByZXR1cm5lZCB1bmNoYW5nZWQuXG4gKi9cbmZ1bmN0aW9uIHN0cmlwVGltZXN0YW1wKGxpbmU6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBsaW5lLnJlcGxhY2UoXG4gICAgL15cXGR7NH0tXFxkezJ9LVxcZHsyfVRcXGR7Mn06XFxkezJ9OlxcZHsyfSg/OlxcLlxcZCspP1o/XFxzPy8sXG4gICAgXCJcIixcbiAgKTtcbn1cblxuLyoqIE1hcmtlcnMgaWRlbnRpZnlpbmcgdGhlIGZpcnN0IGdlbnVpbmUgZmFpbHVyZSBpbiBhbiBBY3Rpb25zIGxvZy4gKi9cbmNvbnN0IEZBSUxVUkVfTUFSS0VSUyA9IFtcbiAgLyMjXFxbZXJyb3JcXF0vaSxcbiAgL15cXHMqKD86ZXJyb3J8ZmFpbCg/OmVkfHVyZSk/KVxcYls6XFxzXS9pLFxuICAvXFxiQlVJTEQgRkFJTFVSRVxcYi8sXG4gIC9cXGJGQUlMRURcXGIvLFxuICAvXFxiVGVzdHM/IHJ1bjouKkZhaWx1cmVzOiBbMS05XS8sXG4gIC8vIFRBUCAoYmF0cywgcHJvdmUsIG5vZGU6dGVzdCk6IHRoZSBmYWlsaW5nIGFzc2VydGlvbiBpcyBhIGBub3Qgb2sgTmBcbiAgLy8gbGluZSBjYXJyeWluZyBubyBlcnJvciB3b3JkIGF0IGFsbCwgc28gd2l0aG91dCB0aGlzIG1hcmtlciBhIGJhdHNcbiAgLy8gZmFpbHVyZSBmYXIgZnJvbSB0aGUgbG9nIHRhaWwgd2FzIHRyaW1tZWQgb3V0IG9mIHRoZSBleGNlcnB0XG4gIC8vIGVudGlyZWx5IChJc3N1ZSAjMTU3OSkuXG4gIC9eXFxzKm5vdCBvayBcXGQrXFxiLyxcbiAgL1xcYkFzc2VydGlvbkVycm9yXFxiLyxcbiAgL1xcYkV4Y2VwdGlvblxcYi8sXG5dO1xuXG5mdW5jdGlvbiBpc0ZhaWx1cmVNYXJrZXIobGluZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBGQUlMVVJFX01BUktFUlMuc29tZSgocmUpID0+IHJlLnRlc3QobGluZSkpO1xufVxuXG4vKiogT3B0aW9ucyBmb3Ige0BsaW5rIHN1bW1hcmlzZUFjdGlvbnNMb2d9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBTdW1tYXJpc2VPcHRpb25zIHtcbiAgLyoqIEhhcmQgYnl0ZSBjYXAgKGRlZmF1bHRzIHRvIHtAbGluayBNQVhfQUNUSU9OU19FWENFUlBUX0JZVEVTfSkuICovXG4gIG1heEJ5dGVzPzogbnVtYmVyO1xufVxuXG4vKipcbiAqIFRyaW0gYSByYXcgR2l0SHViIEFjdGlvbnMgam9iIGxvZyB0byB0aGUgbWF0ZXJpYWwgd29ydGggcHV0dGluZyBpbiBhXG4gKiBmaXggcHJvbXB0OiB0aGUgd2luZG93IGFyb3VuZCB0aGUgZmlyc3QgZmFpbHVyZSBtYXJrZXIgcGx1cyB0aGUgbG9nXG4gKiB0YWlsLCB3aXRoIHRpbWVzdGFtcCBwcmVmaXhlcyBzdHJpcHBlZCBhbmQgdGhlIHJlc3VsdCBoYXJkLWNhcHBlZC5cbiAqXG4gKiBNaXJyb3JzIGFuIGFwcHJvYWNoIGFscmVhZHkgcHJvdmVuIGFnYWluc3QgYSBtdWNoIG5vaXNpZXIgY29uc29sZSBsb2cgaW5cbiAqIGEgcHJpdmF0ZSBkZXBsb3ltZW50LlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3VtbWFyaXNlQWN0aW9uc0xvZyhcbiAgcmF3TG9nOiBzdHJpbmcsXG4gIG9wdHM6IFN1bW1hcmlzZU9wdGlvbnMgPSB7fSxcbik6IHN0cmluZyB7XG4gIGNvbnN0IG1heEJ5dGVzID0gb3B0cy5tYXhCeXRlcyA/PyBNQVhfQUNUSU9OU19FWENFUlBUX0JZVEVTO1xuICBjb25zdCBsaW5lcyA9IHJhd0xvZy5zcGxpdChcIlxcblwiKS5tYXAoc3RyaXBUaW1lc3RhbXApO1xuXG4gIGNvbnN0IGZhaWx1cmVJbmRleCA9IGxpbmVzLmZpbmRJbmRleChpc0ZhaWx1cmVNYXJrZXIpO1xuICBjb25zdCB0YWlsU3RhcnQgPSBNYXRoLm1heCgwLCBsaW5lcy5sZW5ndGggLSBUQUlMX0xJTkVTKTtcblxuICBjb25zdCBrZXB0OiBzdHJpbmdbXSA9IFtdO1xuICBpZiAoZmFpbHVyZUluZGV4ID49IDAgJiYgZmFpbHVyZUluZGV4IDwgdGFpbFN0YXJ0KSB7XG4gICAgY29uc3QgZnJvbSA9IE1hdGgubWF4KDAsIGZhaWx1cmVJbmRleCAtIEZBSUxVUkVfTEVBRF9MSU5FUyk7XG4gICAgY29uc3QgdG8gPSBNYXRoLm1pbih0YWlsU3RhcnQsIGZhaWx1cmVJbmRleCArIEZBSUxVUkVfVFJBSUxfTElORVMgKyAxKTtcbiAgICBpZiAoZnJvbSA+IDApIGtlcHQucHVzaChgWy4uLiAke2Zyb219IGVhcmxpZXIgbGluZXMgb21pdHRlZCAuLi5dYCk7XG4gICAga2VwdC5wdXNoKC4uLmxpbmVzLnNsaWNlKGZyb20sIHRvKSk7XG4gICAga2VwdC5wdXNoKGBbLi4uICR7dGFpbFN0YXJ0IC0gdG99IGxpbmVzIG9taXR0ZWQgLi4uXWApO1xuICB9IGVsc2UgaWYgKHRhaWxTdGFydCA+IDApIHtcbiAgICBrZXB0LnB1c2goYFsuLi4gJHt0YWlsU3RhcnR9IGVhcmxpZXIgbGluZXMgb21pdHRlZCAuLi5dYCk7XG4gIH1cbiAga2VwdC5wdXNoKC4uLmxpbmVzLnNsaWNlKHRhaWxTdGFydCkpO1xuXG4gIHJldHVybiBjYXBCeXRlc1ByZXNlcnZpbmdUYWlsKGtlcHQuam9pbihcIlxcblwiKSwgbWF4Qnl0ZXMpO1xufVxuXG4vKipcbiAqIENhcCBgdGV4dGAgYXQgYG1heEJ5dGVzYCBVVEYtOCBieXRlcywga2VlcGluZyB0aGUgdGFpbCBhbmQgcHJlZml4aW5nIGFcbiAqIG1hcmtlciBzbyBhIHJlYWRlciBrbm93cyBjb250ZW50IHdhcyBkcm9wcGVkLlxuICovXG5mdW5jdGlvbiBjYXBCeXRlc1ByZXNlcnZpbmdUYWlsKHRleHQ6IHN0cmluZywgbWF4Qnl0ZXM6IG51bWJlcik6IHN0cmluZyB7XG4gIGNvbnN0IGVuY29kZXIgPSBuZXcgVGV4dEVuY29kZXIoKTtcbiAgY29uc3QgYnl0ZXMgPSBlbmNvZGVyLmVuY29kZSh0ZXh0KTtcbiAgaWYgKGJ5dGVzLmJ5dGVMZW5ndGggPD0gbWF4Qnl0ZXMpIHJldHVybiB0ZXh0O1xuXG4gIGNvbnN0IG1hcmtlciA9IGBbLi4uIHRydW5jYXRlZCAke1xuICAgIGJ5dGVzLmJ5dGVMZW5ndGggLSBtYXhCeXRlc1xuICB9IGJ5dGVzIOKAlCBzaG93aW5nIHRhaWwgLi4uXVxcbmA7XG4gIGNvbnN0IGJ1ZGdldCA9IE1hdGgubWF4KDAsIG1heEJ5dGVzIC0gZW5jb2Rlci5lbmNvZGUobWFya2VyKS5ieXRlTGVuZ3RoKTtcbiAgY29uc3QgdGFpbCA9IGJ5dGVzLnN1YmFycmF5KGJ5dGVzLmJ5dGVMZW5ndGggLSBidWRnZXQpO1xuICByZXR1cm4gbWFya2VyICsgbmV3IFRleHREZWNvZGVyKFwidXRmLThcIiwgeyBmYXRhbDogZmFsc2UgfSkuZGVjb2RlKHRhaWwpO1xufVxuXG4vKipcbiAqIEZldGNoIGFuZCB0cmltIHRoZSBsb2cgb2YgdGhlIGZhaWxpbmcgR2l0SHViIEFjdGlvbnMgam9iIGJlaGluZCBhXG4gKiBjaGVjayBydW4uXG4gKlxuICogUmV0dXJucyBgbm90LWFwcGxpY2FibGVgIHdoZW4gdGhlIGNoZWNrIGlzIG5vdCBhbiBBY3Rpb25zIGpvYiAoc28gdGhlXG4gKiBjYWxsZXIgZmFsbHMgdGhyb3VnaCBjbGVhbmx5KSwgYGVycm9yYCB3aGVuIHJlc29sdXRpb24gb3IgcmV0cmlldmFsXG4gKiBnZW51aW5lbHkgZmFpbGVkLCBhbmQgYGV4Y2VycHRgIG9uIHN1Y2Nlc3MuIE5ldmVyIHRocm93cy5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIGZldGNoR2l0aHViQWN0aW9uc0xvZ0V4Y2VycHQoXG4gIG9wdHM6IEFjdGlvbnNMb2dPcHRpb25zLFxuKTogUHJvbWlzZTxBY3Rpb25zTG9nT3V0Y29tZT4ge1xuICBjb25zdCByZXNvbHV0aW9uID0gYXdhaXQgcmVzb2x2ZUFjdGlvbnNKb2JJZChvcHRzKTtcbiAgaWYgKHJlc29sdXRpb24ua2luZCAhPT0gXCJqb2JcIikgcmV0dXJuIHJlc29sdXRpb247XG5cbiAgY29uc3QgcmVzcG9uc2UgPSBhd2FpdCBnaEFwaUxvZ3MoXG4gICAgb3B0cy5naEZuLFxuICAgIGByZXBvcy8ke29wdHMucmVwb30vYWN0aW9ucy9qb2JzLyR7cmVzb2x1dGlvbi5qb2JJZH0vbG9nc2AsXG4gICk7XG4gIGlmICghcmVzcG9uc2Uub2spIHJldHVybiB7IGtpbmQ6IFwiZXJyb3JcIiwgZXJyb3I6IHJlc3BvbnNlLmVycm9yIH07XG5cbiAgaWYgKHJlc3BvbnNlLmJvZHkudHJpbSgpID09PSBcIlwiKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIGtpbmQ6IFwiZXJyb3JcIixcbiAgICAgIGVycm9yOiBgR2l0SHViIEFjdGlvbnMgam9iICR7cmVzb2x1dGlvbi5qb2JJZH0gcmV0dXJuZWQgYW4gZW1wdHkgbG9nYCxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgZXhjZXJwdCA9IHN1bW1hcmlzZUFjdGlvbnNMb2cocmVzcG9uc2UuYm9keSwge1xuICAgIC4uLihvcHRzLm1heEJ5dGVzICE9PSB1bmRlZmluZWQgPyB7IG1heEJ5dGVzOiBvcHRzLm1heEJ5dGVzIH0gOiB7fSksXG4gIH0pO1xuXG4gIHJldHVybiB7XG4gICAga2luZDogXCJleGNlcnB0XCIsXG4gICAgcHJvdmlkZXJJZDogR0lUSFVCX0FDVElPTlNfUFJPVklERVJfSUQsXG4gICAgam9iSWQ6IHJlc29sdXRpb24uam9iSWQsXG4gICAgZXhjZXJwdCxcbiAgfTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FpQkMsR0FFRCw2RUFBNkUsR0FDN0UsT0FBTyxTQUFTLGtCQUFrQixPQUFlO0VBQy9DLE1BQU0sUUFBUSxnQkFBZ0IsSUFBSSxDQUFDO0VBQ25DLElBQUksQ0FBQyxPQUFPLE9BQU87RUFDbkIsTUFBTSxLQUFLLE9B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
// denoCacheMetadata=7430107750851337294,17659617904517839326