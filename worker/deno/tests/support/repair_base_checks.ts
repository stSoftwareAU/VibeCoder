/** Stateful-response GitHub boundary for repair check evidence (Issue #4943). */
import type { GitHubDeps } from "../../lib/issue_worker_wiring.ts";
const REPO = "owner/repo";
const DEFAULT_BRANCH = "main";
/** What the default branch's run of the failing check shows (Issue #4943). */
export type BaseRunState =
  | "green"
  | "red"
  | "no-run"
  | "unavailable"
  | "probe-throws"
  | "matching-historical-failure"
  | "stale-check-head"
  | "different-historical-failure"
  | "dependency-audit";

export const CI_CHECK_RUN_ID = "123";
export const BASE_RUN_ID = 901;
export const BASE_SHA = "b".repeat(40);
export const HEAD_SHA = "a".repeat(40);
export const MERGE_BASE_SHA = "c".repeat(40);

/**
 * A gh runner for the CI-fix processor's base-fix probe (Issue #4943). It
 * answers the mergeable read with `mergeable`, the PR's failing check (run 123,
 * named like the processor's `check-name`) and its workflow, and the default
 * branch's run of that check as `base` describes. Any other call is rejected.
 */
export function baseFixGh(
  mergeable: string,
  base: BaseRunState,
  options: { headSha?: string; baseSha?: string; mergeBaseSha?: string } = {},
): GitHubDeps["runGhCommand"] {
  const headSha = options.headSha ?? HEAD_SHA;
  const checkName = base === "dependency-audit" ? "Dependency audit" : "test";
  const baseSha = options.baseSha ?? BASE_SHA;
  const mergeBaseSha = options.mergeBaseSha ?? MERGE_BASE_SHA;
  return (args: string[]) => {
    const endpoint = args[1] === "--allow-escape-sequences" ? args[2] : args[1];
    if (args[0] === "pr" && endpoint === "view") {
      if (args[args.indexOf("--json") + 1] === "headRefOid") {
        return Promise.resolve(JSON.stringify({ headRefOid: headSha }));
      }
      return Promise.resolve(JSON.stringify({ mergeable }));
    }
    if (args[0] === "api") {
      if (
        endpoint === `repos/${REPO}/commits/${headSha}/check-runs?per_page=100`
      ) {
        return Promise.resolve(
          JSON.stringify({
            total: 1,
            runs: [{ id: 123, name: checkName, conclusion: "failure" }],
          }),
        );
      }
      if (endpoint === `repos/${REPO}/check-runs/${CI_CHECK_RUN_ID}`) {
        if (base === "probe-throws") {
          return Promise.reject(new Error("HTTP 502 from check-runs"));
        }
        return Promise.resolve(
          args[args.indexOf("--jq") + 1] === ".head_sha"
            ? `${base === "stale-check-head" ? "d".repeat(40) : headSha}\n`
            : JSON.stringify({
              name: checkName,
              app_slug: "github-actions",
              details_url: `https://github.com/${REPO}/actions/runs/900/job/1`,
            }),
        );
      }
      if (endpoint === `repos/${REPO}/check-runs/902`) {
        return Promise.resolve(
          JSON.stringify({
            name: checkName,
            app_slug: "github-actions",
            details_url: `https://github.com/${REPO}/actions/runs/902/job/2`,
          }),
        );
      }
      if (
        endpoint === `repos/${REPO}/actions/jobs/1/logs` ||
        endpoint === `repos/${REPO}/actions/jobs/2/logs`
      ) {
        if (
          base === "different-historical-failure" &&
          endpoint.endsWith("/2/logs")
        ) {
          return Promise.resolve(
            "src/network.ts(21,4): error TS1005: semicolon expected.\n",
          );
        }
        return Promise.resolve(
          "2026-11-01T10:00:00Z src/parser.ts(10,5): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.\n",
        );
      }
      if (
        endpoint === `repos/${REPO}/actions/runs/900` ||
        endpoint === `repos/${REPO}/actions/runs/902` ||
        endpoint === `repos/${REPO}/actions/runs/${BASE_RUN_ID}`
      ) {
        return Promise.resolve(".github/workflows/ci.yml\n");
      }
      if (endpoint === `repos/${REPO}/commits/${DEFAULT_BRANCH}`) {
        return Promise.resolve(`${baseSha}\n`);
      }
      if (endpoint === `repos/${REPO}/compare/${baseSha}...${headSha}`) {
        return Promise.resolve(`${mergeBaseSha}\n`);
      }
      if (endpoint === `repos/${REPO}/commits/${mergeBaseSha}`) {
        return Promise.resolve(
          args[args.indexOf("--jq") + 1] === ".sha"
            ? `${mergeBaseSha}\n`
            : `${"f".repeat(40)}\n`,
        );
      }
      if (
        endpoint ===
          `repos/${REPO}/commits/${mergeBaseSha}/check-runs?per_page=100`
      ) {
        const checkRuns = (base === "matching-historical-failure" ||
            base === "stale-check-head" ||
            base === "different-historical-failure")
          ? [{
            id: 902,
            name: checkName,
            status: "completed",
            conclusion: "failure",
            head_sha: mergeBaseSha,
            app_slug: "github-actions",
            details_url: `https://github.com/${REPO}/actions/runs/902/job/2`,
          }]
          : [];
        return Promise.resolve(JSON.stringify({ check_runs: checkRuns }));
      }
      if (
        endpoint ===
          `repos/${REPO}/commits/${mergeBaseSha}/pulls?per_page=5`
      ) {
        return Promise.resolve("[]");
      }
      if (
        endpoint ===
          `repos/${REPO}/commits/${DEFAULT_BRANCH}/check-runs?per_page=100`
      ) {
        if (base === "unavailable") {
          return Promise.reject(new Error("HTTP 503 from check-runs"));
        }
        const checkRuns = base === "no-run" ? [] : [{
          id: BASE_RUN_ID,
          name: checkName,
          status: "completed",
          conclusion: base === "red" ? "failure" : "success",
          head_sha: baseSha,
          app_slug: "github-actions",
          details_url:
            `https://github.com/${REPO}/actions/runs/${BASE_RUN_ID}/job/2`,
        }];
        return Promise.resolve(JSON.stringify({ check_runs: checkRuns }));
      }
    }
    return Promise.reject(new Error(`unexpected gh call: ${args.join(" ")}`));
  };
}
