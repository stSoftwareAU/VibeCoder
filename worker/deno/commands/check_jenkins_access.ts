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

import type { Command, CommandResult } from "../types.ts";
import {
  checkJenkinsAccess,
  type EnvReader,
  type FetchFn,
  type JenkinsAccessDiagnosis,
} from "../lib/jenkins_access_check.ts";

/**
 * Injection seams for the command (Issue #958).
 *
 * `Command.execute` has a fixed `(args, config)` signature, so the seams
 * are bound when the command is built. Production registers the command
 * built with no deps, which is exactly the previous behaviour; a test
 * supplies the credentials as a plain object rather than writing them
 * into the process environment.
 */
export interface CheckJenkinsAccessDeps {
  /** Environment reader (defaults to the process environment). */
  readEnv?: EnvReader;
  /** HTTP fetch (defaults to `globalThis.fetch`). */
  fetchFn?: FetchFn;
}

/** Build the command with injected seams (tests) or the defaults. */
export function createCheckJenkinsAccessCommand(
  deps: CheckJenkinsAccessDeps = {},
): Command {
  return {
    name: "check-jenkins-access",
    description:
      "Preflight Jenkins credentials and report an actionable diagnosis",

    async execute(
      args: Record<string, unknown>,
    ): Promise<CommandResult<JenkinsAccessDiagnosis>> {
      const jobPath = args["job"] as string | undefined;
      if (!jobPath) {
        return {
          success: false,
          message: "Required argument '--job' is missing",
        };
      }

      const buildArg = args["build"];
      const build =
        buildArg === undefined || buildArg === null || buildArg === ""
          ? undefined
          : typeof buildArg === "number"
          ? buildArg
          : String(buildArg);

      const diagnosis = await checkJenkinsAccess({
        jobPath,
        ...(build !== undefined ? { build } : {}),
        ...(deps.readEnv !== undefined ? { readEnv: deps.readEnv } : {}),
        ...(deps.fetchFn !== undefined ? { fetchFn: deps.fetchFn } : {}),
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
}

/** The registered command, reading the process environment. */
export const checkJenkinsAccessCommand: Command =
  createCheckJenkinsAccessCommand();
