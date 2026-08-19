/**
 * Tests for lib/reported_check_names.ts — discovery of the status-check names
 * a repository genuinely reports (Issue #4163).
 */

import { assert, assertEquals, assertFalse } from "@std/assert";
import { getReportedCheckNames } from "../lib/reported_check_names.ts";
import type { GhExec } from "../lib/repo_rulesets.ts";

/** Scripted `gh` returning per-endpoint JSON; anything unscripted rejects. */
function makeGh(
  responses: Record<string, unknown>,
): { gh: GhExec; endpoints: string[] } {
  const endpoints: string[] = [];
  const gh: GhExec = (args) => {
    const endpoint = String(args[1]);
    endpoints.push(endpoint);
    for (const [pattern, value] of Object.entries(responses)) {
      if (endpoint.includes(pattern)) {
        return Promise.resolve(JSON.stringify(value));
      }
    }
    return Promise.reject(new Error("gh failed: Not Found (HTTP 404)"));
  };
  return { gh, endpoints };
}

Deno.test("reported checks - collects check-run names from the default branch head", async () => {
  const { gh } = makeGh({
    "commits/main/check-runs": { check_runs: [{ name: "quality" }] },
    "commits/main/status": { statuses: [] },
    "pulls?": [],
  });

  const result = await getReportedCheckNames("org/repo", "main", gh);

  assert(result.ok);
  assertEquals(result.names, ["quality"]);
});

Deno.test("reported checks - falls back to the latest closed PR head (pull_request-only workflows)", async () => {
  // The canonical workflows trigger on `pull_request`, so a squash-merged
  // default branch head carries no check runs at all.
  const { gh } = makeGh({
    "commits/main/check-runs": { check_runs: [] },
    "commits/main/status": { statuses: [] },
    "pulls?": [{ head: { sha: "deadbee" } }],
    "commits/deadbee/check-runs": {
      check_runs: [{ name: "gitleaks" }, { name: "Semgrep SAST scan" }],
    },
    "commits/deadbee/status": { statuses: [{ context: "legacy/ci" }] },
  });

  const result = await getReportedCheckNames("org/repo", "main", gh);

  assert(result.ok);
  assertEquals(result.names, ["gitleaks", "Semgrep SAST scan", "legacy/ci"]);
});

Deno.test("reported checks - duplicate names across refs are de-duplicated", async () => {
  const { gh } = makeGh({
    "commits/main/check-runs": { check_runs: [{ name: "quality" }] },
    "commits/main/status": { statuses: [] },
    "pulls?": [{ head: { sha: "abc1234" } }],
    "commits/abc1234/check-runs": { check_runs: [{ name: "quality" }] },
    "commits/abc1234/status": { statuses: [] },
  });

  const result = await getReportedCheckNames("org/repo", "main", gh);

  assertEquals(result.names, ["quality"]);
});

Deno.test("reported checks - an unreadable repo reports failure, not an empty pass", async () => {
  const gh: GhExec = () =>
    Promise.reject(new Error("gh failed: Bad credentials (HTTP 401)"));

  const result = await getReportedCheckNames("org/repo", "main", gh);

  assertFalse(result.ok);
  assertEquals(result.names, []);
});

Deno.test("reported checks - an invalid slug or branch makes no gh call", async () => {
  const { gh, endpoints } = makeGh({});

  assertFalse((await getReportedCheckNames("not-a-slug", "main", gh)).ok);
  assertFalse((await getReportedCheckNames("org/repo", "main;evil", gh)).ok);
  assertEquals(endpoints.length, 0);
});

Deno.test("reported checks - a malformed PR head SHA is ignored", async () => {
  const { gh, endpoints } = makeGh({
    "commits/main/check-runs": { check_runs: [{ name: "quality" }] },
    "commits/main/status": { statuses: [] },
    "pulls?": [{ head: { sha: "../../etc/passwd" } }],
  });

  const result = await getReportedCheckNames("org/repo", "main", gh);

  assertEquals(result.names, ["quality"]);
  assertFalse(endpoints.some((e) => e.includes("passwd")));
});
