/**
 * Tests for security_sarif_emit.ts — the additive SARIF emission orchestration
 * the security-scan template calls after filing its issues (Issue #3538).
 *
 * Every dependency (gh list, gh exec, git) is injected, so the tests are
 * hermetic. The pinned behaviours:
 *
 *   - zero newly-filed → skipped, no gh/git touched,
 *   - filed findings are read back, built into SARIF, and uploaded, with the
 *     upload scoped to only the newly-filed issue numbers,
 *   - a code-scanning-unavailable upload is surfaced (not silently swallowed)
 *     while remaining additive (never throws),
 *   - a detached-HEAD / missing git ref is surfaced without an upload.
 *
 * Australian English spelling used throughout (behaviour, normalise).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { emitSecuritySarif } from "../lib/security_sarif_emit.ts";
import type { GhExec, GitRunner } from "../lib/security_sarif_upload.ts";

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

const okGit: GitRunner = (args) => {
  const key = args.join(" ");
  if (key === "rev-parse HEAD") {
    return Promise.resolve({ code: 0, stdout: `${FULL_SHA}\n`, stderr: "" });
  }
  if (key === "symbolic-ref -q HEAD") {
    return Promise.resolve({
      code: 0,
      stdout: "refs/heads/main\n",
      stderr: "",
    });
  }
  throw new Error(`unexpected git call: ${key}`);
};

/** gh issue-list stub returning two filed findings (#50, #51) plus a stranger. */
const issuesListJson = JSON.stringify([
  {
    number: 50,
    title: "🟠 SQL injection in src/api/orders.ts:47",
    body: "<!-- finding-id: SEC-aaa111 -->\n<!-- cwe: CWE-89 -->\ndetail",
    labels: [{ name: "security" }, { name: "severity:high" }],
  },
  {
    number: 51,
    title: "🟢 Weak setting in config.ts:3",
    body: "<!-- finding-id: SEC-bbb222 -->\ndetail",
    labels: [{ name: "security" }, { name: "severity:low" }],
  },
  {
    number: 99,
    title: "🔴 Not in this run",
    body: "<!-- finding-id: SEC-ccc333 -->",
    labels: [{ name: "security" }],
  },
]);

Deno.test("emitSecuritySarif - zero newly-filed skips without touching gh/git", async () => {
  let ghExecCalls = 0;
  const ghExecFn: GhExec = () => {
    ghExecCalls++;
    return Promise.resolve("{}");
  };
  const outcome = await emitSecuritySarif(
    { repo: "org/repo", checkoutDir: "/repo", newlyFiled: [] },
    { ghListFn: () => Promise.resolve("[]"), ghExecFn, runGitFn: okGit },
  );
  assertEquals(outcome.upload, null);
  assertStringIncludes(outcome.summary, "0 findings");
  assertEquals(ghExecCalls, 0);
});

Deno.test("emitSecuritySarif - uploads only the newly-filed findings", async () => {
  let uploadBody: Record<string, unknown> | null = null;
  const ghExecFn: GhExec = (_args, stdin) => {
    uploadBody = JSON.parse(stdin ?? "{}");
    return Promise.resolve('{"id":"sarif-7"}');
  };
  const outcome = await emitSecuritySarif(
    { repo: "org/repo", checkoutDir: "/repo", newlyFiled: [50, 51] },
    {
      ghListFn: () => Promise.resolve(issuesListJson),
      ghExecFn,
      runGitFn: okGit,
    },
  );
  assert(outcome.upload);
  assertEquals(outcome.upload?.kind, "uploaded");
  assertStringIncludes(outcome.summary, "uploaded 2 findings");

  // The uploaded SARIF must contain exactly the two in-scope findings, not #99.
  assert(uploadBody);
  const body = uploadBody as { sarif: string };
  const bytes = Uint8Array.from(atob(body.sarif), (c) => c.charCodeAt(0));
  const sarif = JSON.parse(
    await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text(),
  );
  const ruleIds = sarif.runs[0].tool.driver.rules.map(
    (r: { id: string }) => r.id,
  );
  assertEquals(ruleIds, ["SEC-aaa111", "SEC-bbb222"]);
});

Deno.test("emitSecuritySarif - code-scanning-unavailable is surfaced, stays additive", async () => {
  const ghExecFn: GhExec = () =>
    Promise.reject(new Error("gh: must enable (HTTP 403)"));
  const outcome = await emitSecuritySarif(
    { repo: "org/repo", checkoutDir: "/repo", newlyFiled: [50] },
    {
      ghListFn: () => Promise.resolve(issuesListJson),
      ghExecFn,
      runGitFn: okGit,
    },
  );
  assertEquals(outcome.upload?.kind, "code-scanning-unavailable");
  assertStringIncludes(outcome.summary, "code scanning unavailable");
});

Deno.test("emitSecuritySarif - detached HEAD is surfaced without an upload", async () => {
  let ghExecCalls = 0;
  const ghExecFn: GhExec = () => {
    ghExecCalls++;
    return Promise.resolve("{}");
  };
  const detachedGit: GitRunner = (args) => {
    const key = args.join(" ");
    if (key === "rev-parse HEAD") {
      return Promise.resolve({ code: 0, stdout: `${FULL_SHA}\n`, stderr: "" });
    }
    return Promise.resolve({ code: 1, stdout: "", stderr: "detached" });
  };
  const outcome = await emitSecuritySarif(
    { repo: "org/repo", checkoutDir: "/repo", newlyFiled: [50] },
    {
      ghListFn: () => Promise.resolve(issuesListJson),
      ghExecFn,
      runGitFn: detachedGit,
    },
  );
  assertEquals(outcome.upload, null);
  assertStringIncludes(outcome.summary, "not uploaded");
  assertEquals(ghExecCalls, 0, "no upload attempted without a ref");
});

Deno.test("emitSecuritySarif - no parseable findings skips upload", async () => {
  let ghExecCalls = 0;
  const ghExecFn: GhExec = () => {
    ghExecCalls++;
    return Promise.resolve("{}");
  };
  // Newly-filed number present, but the issue carries no finding-id marker.
  const noMarker = JSON.stringify([
    { number: 50, title: "tracker", body: "no marker", labels: [] },
  ]);
  const outcome = await emitSecuritySarif(
    { repo: "org/repo", checkoutDir: "/repo", newlyFiled: [50] },
    { ghListFn: () => Promise.resolve(noMarker), ghExecFn, runGitFn: okGit },
  );
  assertEquals(outcome.upload, null);
  assertStringIncludes(outcome.summary, "no parseable findings");
  assertEquals(ghExecCalls, 0);
});
