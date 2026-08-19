/**
 * Jenkins CI log provider (Issue #3579).
 *
 * Reimplements the former hard-coded `fetch-jenkins-log` action as an
 * instance of the general {@link CiLogProvider} extension point, over
 * the unchanged `jenkins_log_fetcher.ts`. Behaviour is preserved:
 * `checkNamePattern` matching (defaulting to `/jenkins/i`), build-number
 * extraction from the check `target_url`, and the fetcher's byte cap.
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
 */

import type { Result } from "../types.ts";
import type {
  CiFailureContext,
  CiLogExcerpt,
  CiLogProvider,
} from "./ci_log_provider.ts";
import { compileCheckNamePattern } from "./ci_log_provider.ts";
import {
  fetchJenkinsBuildLog,
  fetchJenkinsBuildStatus,
} from "./jenkins_log_fetcher.ts";

/** Provider id used in configuration and logs. */
export const JENKINS_PROVIDER_ID = "jenkins";

/** Check-name pattern applied when the operator configures none. */
const DEFAULT_CHECK_NAME_PATTERN = /jenkins/i;

/**
 * Extract the Jenkins build number from a check `target_url`.
 *
 * Jenkins paths are `/job/<name>[/job/<name>...]/<build>[/<view>...]`, so
 * the build number is the segment immediately after the last `job/<name>`
 * pair. A view suffix may follow it — GitHub's
 * `continuous-integration/jenkins/pr-head` status records
 * `.../job/PR-599/6/display/redirect` — and must be ignored rather than
 * read as the build (example-org/private-repo-27#585).
 *
 * URLs with no `job` segment fall back to the trailing path segment.
 *
 * Returns an error result when the URL is empty, missing a build
 * segment, or that segment is non-numeric (e.g. `lastBuild`).
 */
export function extractJenkinsBuildNumber(
  targetUrl: string,
): Result<number, string> {
  if (!targetUrl) {
    return { ok: false, error: "target URL is empty" };
  }

  let parsedPath: string;
  try {
    parsedPath = new URL(targetUrl).pathname;
  } catch {
    parsedPath = targetUrl;
  }

  // Strip leading/trailing slashes, drop empty segments.
  const segments = parsedPath.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) {
    return { ok: false, error: `no path segments in URL '${targetUrl}'` };
  }

  const lastJob = segments.lastIndexOf("job");
  // `job` at index i names a job at i+1, so the build sits at i+2.
  const buildIndex = lastJob >= 0 ? lastJob + 2 : segments.length - 1;
  const last = segments[buildIndex];
  if (last === undefined) {
    return {
      ok: false,
      error: `no build segment after job path in URL '${targetUrl}'`,
    };
  }
  if (!/^\d+$/.test(last)) {
    return {
      ok: false,
      error: `build segment '${last}' is not a numeric build id`,
    };
  }

  const num = Number.parseInt(last, 10);
  if (!Number.isFinite(num) || num < 0) {
    return {
      ok: false,
      error: `build number '${last}' is not a valid integer`,
    };
  }
  return { ok: true, value: num };
}

/** Job-name segments Jenkins accepts; anything else is refused outright. */
const SAFE_JOB_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Extract the Jenkins job path from a check `target_url`.
 *
 * Jenkins paths interleave `job` markers with job names
 * (`/job/example-org/private-repo-26/Migration_v21/job/PR-599/6/...`), so the job path
 * is every segment following a `job` marker, joined with `/` —
 * `example-org/private-repo-27/PR-599` for that example.
 *
 * A multibranch PR check runs under a per-PR `PR-<n>` job, which the static
 * `jobPath` configuration cannot name; this recovers it from the URL
 * (example-org/private-repo-27#585). Segments are validated so a traversal
 * or encoded separator can never reach the Jenkins URL builder.
 */
export function extractJenkinsJobPath(
  targetUrl: string,
): Result<string, string> {
  if (!targetUrl) {
    return { ok: false, error: "target URL is empty" };
  }

  let parsedPath: string;
  try {
    parsedPath = new URL(targetUrl).pathname;
  } catch {
    return { ok: false, error: `could not parse URL '${targetUrl}'` };
  }

  const segments = parsedPath.split("/").filter((s) => s.length > 0);
  const names: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    if (segments[i] !== "job") continue;
    const raw = segments[i + 1];
    if (raw === undefined) {
      return { ok: false, error: `trailing 'job' marker in '${targetUrl}'` };
    }
    // Decode per segment, so an encoded separator stays inside the name and
    // is caught below rather than silently splitting the path.
    let name: string;
    try {
      name = decodeURIComponent(raw);
    } catch {
      return { ok: false, error: `undecodable job name segment '${raw}'` };
    }
    if (!SAFE_JOB_SEGMENT.test(name) || name === "." || name === "..") {
      return { ok: false, error: `unsafe job name segment '${name}'` };
    }
    names.push(name);
  }

  if (names.length === 0) {
    return { ok: false, error: `no job segments in URL '${targetUrl}'` };
  }
  return { ok: true, value: names.join("/") };
}

/** The folder containing a job, i.e. the path minus its final segment. */
function jobFolder(jobPath: string): string {
  const segments = jobPath.split("/").filter((s) =>
    s.length > 0 && s !== "job"
  );
  return segments.slice(0, -1).join("/");
}

/**
 * Decide which Jenkins job to fetch: the one the check URL names, falling
 * back to the configured path when the URL does not name one.
 *
 * Trusting the URL is bounded — the job it names must sit in the same
 * folder as the configured job, so a rogue `target_url` cannot redirect the
 * fetch at an unrelated Jenkins job.
 */
function resolveJobPath(
  configuredPath: string,
  targetUrl: string | undefined,
): Result<string, string> {
  const derived = extractJenkinsJobPath(targetUrl ?? "");
  if (!derived.ok) return { ok: true, value: configuredPath };

  const configuredFolder = jobFolder(configuredPath);
  const derivedFolder = jobFolder(derived.value);
  if (derivedFolder !== configuredFolder) {
    return {
      ok: false,
      error:
        `check target URL names job '${derived.value}', which is outside ` +
        `the configured folder '${configuredFolder}' — refusing to fetch`,
    };
  }
  return { ok: true, value: derived.value };
}

/** The built-in Jenkins provider. */
export const jenkinsCiLogProvider: CiLogProvider = {
  id: JENKINS_PROVIDER_ID,

  matches(ctx: CiFailureContext): boolean {
    const config = ctx.providerConfig;
    // Jenkins needs a job path, so it only ever handles a check the
    // operator explicitly configured it for.
    if (!config || config.provider !== JENKINS_PROVIDER_ID) return false;
    if (typeof config.jobPath !== "string" || config.jobPath === "") {
      return false;
    }
    const pattern = compileCheckNamePattern(
      config.checkNamePattern,
      DEFAULT_CHECK_NAME_PATTERN,
    );
    return pattern.ok && pattern.value.test(ctx.checkName);
  },

  async fetchLog(
    ctx: CiFailureContext,
  ): Promise<Result<CiLogExcerpt, string>> {
    const configuredPath = ctx.providerConfig?.jobPath;
    if (typeof configuredPath !== "string" || configuredPath === "") {
      return { ok: false, error: "jenkins provider requires a jobPath" };
    }

    const build = extractJenkinsBuildNumber(ctx.targetUrl ?? "");
    if (!build.ok) {
      return {
        ok: false,
        error: `could not extract Jenkins build number: ${build.error}`,
      };
    }

    const resolved = resolveJobPath(configuredPath, ctx.targetUrl);
    if (!resolved.ok) return resolved;
    const jobPath = resolved.value;

    const status = await fetchJenkinsBuildStatus({
      jobPath,
      build: build.value,
      ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
    });
    if (!status.ok) return status;

    const log = await fetchJenkinsBuildLog({
      jobPath,
      build: build.value,
      ...(ctx.fetchFn !== undefined ? { fetchFn: ctx.fetchFn } : {}),
    });
    if (!log.ok) return log;

    return {
      ok: true,
      value: {
        providerId: JENKINS_PROVIDER_ID,
        buildId: String(status.value.number),
        url: status.value.url,
        status: status.value.result,
        logText: log.value,
      },
    };
  },
};
