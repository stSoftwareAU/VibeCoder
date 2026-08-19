/**
 * Regression test for Issue #3025: the `build` job in
 * `.github/workflows/pages.yml` must grant `pages: read` so the
 * `actions/configure-pages` (Setup Pages) step can call
 * `GET /repos/{owner}/{repo}/pages` instead of failing with HTTP 403
 * "Resource not accessible by integration".
 *
 * The fix must NOT re-grant `pages: write` or `id-token: write` to
 * `build` — the Issue #2969 hardening scopes publish + OIDC-mint to the
 * `deploy` job alone. This test parses the real workflow YAML and asserts
 * on its permission structure (behaviour, not source text).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";

/** Resolve the repository root (three levels up from worker/deno/tests/). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

interface Job {
  permissions?: Record<string, string>;
}
interface PagesWorkflow {
  permissions?: Record<string, string>;
  jobs?: Record<string, Job>;
}

async function loadPagesWorkflow(): Promise<PagesWorkflow> {
  const path = `${repoRoot()}.github/workflows/pages.yml`;
  const text = await Deno.readTextFile(path);
  return parseYaml(text) as PagesWorkflow;
}

Deno.test("pages.yml build job grants pages:read for Setup Pages", async () => {
  const wf = await loadPagesWorkflow();
  const build = wf.jobs?.build;
  assert(build, "pages.yml must define a `build` job");

  const perms = build.permissions;
  assert(
    perms,
    "build job must declare its own `permissions:` block (it cannot rely " +
      "on the read-only workflow default for the `pages` scope)",
  );
  assertEquals(
    perms.pages,
    "read",
    "build job must grant `pages: read` so configure-pages can read the " +
      "site config (Issue #3025)",
  );
  assertEquals(
    perms.contents,
    "read",
    "build job must retain `contents: read` to checkout the repo",
  );
});

Deno.test("pages.yml build job does NOT hold publish/OIDC capability (Issue #2969)", async () => {
  const wf = await loadPagesWorkflow();
  const perms = wf.jobs?.build?.permissions ?? {};

  assert(
    perms.pages !== "write",
    "build job must not grant `pages: write` — publish stays in `deploy`",
  );
  assert(
    !("id-token" in perms),
    "build job must not grant `id-token: write` — OIDC-mint stays in `deploy`",
  );
});

Deno.test("pages.yml deploy job retains publish + OIDC capability", async () => {
  const wf = await loadPagesWorkflow();
  const deploy = wf.jobs?.deploy;
  assert(deploy, "pages.yml must define a `deploy` job");

  const perms = deploy.permissions ?? {};
  assertEquals(perms.pages, "write", "deploy publishes the Pages site");
  assertEquals(perms["id-token"], "write", "deploy mints the OIDC token");
});
