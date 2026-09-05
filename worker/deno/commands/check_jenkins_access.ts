/**
 * check-jenkins-access command (Issue #3583).
 *
 * Credentials preflight for the Jenkins log fetcher. Runs one probe
 * request and reports an actionable diagnosis — missing environment
 * variables by name, 401 vs 403 vs 404, or a connection error — instead
 * of the bare HTTP status that used to stall the auto-fix flow.
 *
 * Examples:
 *   deno run --allow-env --allow-net mod.ts check-jenkins-access --job MyJob
 *   deno run --allow-env --allow-net mod.ts check-jenkins-access \
 *     --job MyFolder/job/MyJob --build 42
 *
 * Reads JENKINS_URL, JENKINS_USER, and JENKINS_TOKEN from the
 * environment — the token never appears on the command line or in output.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  checkJenkinsAccess,
  type JenkinsAccessDiagnosis,
} from "../lib/jenkins_access_check.ts";
import { type EnvLookup, processEnvLookup } from "../lib/env_lookup.ts";

/**
 * The command, plus the environment seam it reads the Jenkins credentials
 * through (Issue #944).
 *
 * Declared as a widening of {@link Command} — the extra parameter is
 * optional and defaults to the process environment, so the registry and
 * `mod.ts` see the interface they always did.
 */
export interface CheckJenkinsAccessCommand extends Command {
  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
    env?: EnvLookup,
  ): Promise<CommandResult<JenkinsAccessDiagnosis>>;
}

export const checkJenkinsAccessCommand: CheckJenkinsAccessCommand = {
  name: "check-jenkins-access",
  description:
    "Preflight Jenkins credentials and report an actionable diagnosis",

  /**
   * @param args - The job path and optional build to probe.
   * @param _config - The worker configuration, which the probe does not read.
   * @param env - Where the Jenkins credentials are read from (Issue #944).
   *   Defaults to the process environment, so shell callers are unchanged;
   *   a test states the credentials instead of setting them on the process.
   */
  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
    env: EnvLookup = processEnvLookup,
  ): Promise<CommandResult<JenkinsAccessDiagnosis>> {
    const jobPath = args["job"] as string | undefined;
    if (!jobPath) {
      return {
        success: false,
        message: "Required argument '--job' is missing",
      };
    }

    const buildArg = args["build"];
    const build = buildArg === undefined || buildArg === null || buildArg === ""
      ? undefined
      : typeof buildArg === "number"
      ? buildArg
      : String(buildArg);

    const diagnosis = await checkJenkinsAccess({
      jobPath,
      ...(build !== undefined ? { build } : {}),
      readEnv: env,
    });

    return {
      success: diagnosis.ok,
      message: diagnosis.ok
        ? diagnosis.summary
        : `${diagnosis.summary}. ${diagnosis.remediation}`,
      data: diagnosis,
    };
  },
};
