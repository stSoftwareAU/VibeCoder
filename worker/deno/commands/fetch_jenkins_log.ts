/**
 * fetch-jenkins-log command (Issue #1891).
 *
 * Small CLI entry point around the `jenkins_log_fetcher` library so a
 * developer can invoke a Jenkins fetch locally for ad-hoc debugging.
 *
 * Examples:
 *   deno run --allow-env --allow-net mod.ts fetch-jenkins-log \
 *     --job MyJob --build 42
 *   deno run --allow-env --allow-net mod.ts fetch-jenkins-log \
 *     --job MyJob --build 42 --status
 *
 * Reads JENKINS_URL, JENKINS_USER, and JENKINS_TOKEN from the
 * environment — credentials never appear on the command line.
 */

import type { Command, CommandResult } from "../types.ts";
import {
  DEFAULT_MAX_LOG_BYTES,
  fetchJenkinsBuildLog,
  fetchJenkinsBuildStatus,
  type JenkinsBuild,
} from "../lib/jenkins_log_fetcher.ts";

interface FetchJenkinsLogData {
  status?: JenkinsBuild;
  log?: string;
}

export const fetchJenkinsLogCommand: Command = {
  name: "fetch-jenkins-log",
  description:
    "Fetch a Jenkins build's status and/or console log for local debugging",

  async execute(
    args: Record<string, unknown>,
  ): Promise<CommandResult<FetchJenkinsLogData>> {
    const jobPath = args["job"] as string | undefined;
    const buildArg = args["build"];

    if (!jobPath) {
      return {
        success: false,
        message: "Required argument '--job' is missing",
      };
    }
    if (buildArg === undefined || buildArg === null || buildArg === "") {
      return {
        success: false,
        message: "Required argument '--build' is missing",
      };
    }

    const build = typeof buildArg === "number" ? buildArg : String(buildArg);
    const wantStatusOnly = args["status"] === true;
    const wantLogOnly = args["log"] === true;
    const maxBytesArg = args["max-bytes"];
    const maxBytes = typeof maxBytesArg === "number"
      ? maxBytesArg
      : maxBytesArg !== undefined
      ? Number(maxBytesArg)
      : DEFAULT_MAX_LOG_BYTES;

    const data: FetchJenkinsLogData = {};

    // Default: fetch both. Flags narrow the request.
    const fetchStatus = wantStatusOnly || !wantLogOnly;
    const fetchLog = wantLogOnly || !wantStatusOnly;

    if (fetchStatus) {
      const statusResult = await fetchJenkinsBuildStatus({ jobPath, build });
      if (!statusResult.ok) {
        return { success: false, message: statusResult.error };
      }
      data.status = statusResult.value;
    }

    if (fetchLog) {
      const logResult = await fetchJenkinsBuildLog({
        jobPath,
        build,
        maxBytes,
      });
      if (!logResult.ok) {
        return { success: false, message: logResult.error };
      }
      data.log = logResult.value;
    }

    const summary = data.status
      ? `Build #${data.status.number} → ${data.status.result}`
      : `Log fetched (${data.log?.length ?? 0} chars)`;

    return {
      success: true,
      message: summary,
      data,
    };
  },
};
