/**
 * Documentation-drift tests for Issue #3599 — the unattended-host Deno PATH
 * learning (Issue #3532) must live in the operator manuals
 * (`docs/DEPLOYMENT.md`, `docs/TROUBLESHOOTING.md`), not only in the
 * pr-summaries archive.
 *
 * The tests drive the real helpers (`applyDefaults`, `buildBumpScriptEnv`,
 * `runBumpDeps`) with injected stubs and assert the manuals quote the values
 * the code actually produces — the `~/.deno/bin` directory and the
 * `rejected_by_script` bump status — so code and docs must move together.
 * They assert against real outputs rather than grepping prose wording, so a
 * harmless reword never reddens the suite (Issue #3264).
 *
 * Australian English spelling used throughout (behaviour, unattended).
 */

import { assert, assertEquals } from "@std/assert";
import { applyDefaults } from "../lib/path_bootstrap.ts";
import { buildBumpScriptEnv } from "../lib/phases/bump_deps_phase.ts";
import { type BumpDepsDeps, runBumpDeps } from "../lib/bump_deps.ts";
import { emptyBumpAgeAudit } from "../lib/bump_age_audit.ts";

// tests/ → worker/deno/ → worker/ → repo root
const REPO_ROOT = new URL("../../../", import.meta.url);
const DEPLOYMENT_PATH = "docs/DEPLOYMENT.md";
const TROUBLESHOOTING_PATH = "docs/TROUBLESHOOTING.md";

function readDoc(relative: string): Promise<string> {
  return Deno.readTextFile(new URL(relative, REPO_ROOT));
}

Deno.test("DEPLOYMENT.md documents the user Deno bin directory applyDefaults adds", async () => {
  const home = await Deno.makeTempDir({ prefix: "vibe-deno-path-docs-" });
  try {
    await Deno.mkdir(`${home}/.deno/bin`, { recursive: true });
    const result = await applyDefaults("/usr/bin:/bin", home);
    const denoDir = result.added.find((dir) => dir.startsWith(home));
    assert(
      denoDir,
      "applyDefaults must add the installer's Deno bin directory under HOME",
    );
    // Derive the documented suffix from what the bootstrap really added.
    const suffix = denoDir.slice(home.length + 1);
    assertEquals(suffix, ".deno/bin");

    const doc = await readDoc(DEPLOYMENT_PATH);
    assert(
      doc.includes(`~/${suffix}`),
      `${DEPLOYMENT_PATH} must document the unattended PATH covering ~/${suffix}`,
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("DEPLOYMENT.md documents that spawned repo scripts inherit the resolved deno directory", async () => {
  const env = buildBumpScriptEnv(
    { PATH: "/usr/bin:/bin" },
    {},
    "/Users/worker/.deno/bin/deno",
  );
  assertEquals(env["PATH"]?.split(":")[0], "/Users/worker/.deno/bin");

  const doc = await readDoc(DEPLOYMENT_PATH);
  assert(
    doc.includes("bump-deps.sh"),
    `${DEPLOYMENT_PATH} must name bump-deps.sh as a spawned repo script covered by the PATH handling`,
  );
});

Deno.test("TROUBLESHOOTING.md documents the bump status a failed deno pre-flight produces", async () => {
  const deps: BumpDepsDeps = {
    fileExists: () => Promise.resolve(true),
    // What an unattended host without ~/.deno/bin really sees.
    runScript: () =>
      Promise.resolve({ exitCode: 1, output: "ERROR: deno is required" }),
    getModifiedFiles: () => Promise.resolve(["deno.lock"]),
    revertWorkingTree: () => Promise.resolve(),
    getHeadSha: () => Promise.resolve({ ok: true, value: "deadbeef" }),
    commitFiles: () => Promise.resolve({ ok: true, value: "cafebabe" }),
    auditBumpedVersions: () => Promise.resolve(emptyBumpAgeAudit()),
  };
  const result = await runBumpDeps({ repoPath: "/tmp/repo" }, deps);
  assertEquals(result.status, "rejected_by_script");

  const doc = await readDoc(TROUBLESHOOTING_PATH);
  assert(
    doc.includes(result.status),
    `${TROUBLESHOOTING_PATH} must document the ${result.status} bump symptom`,
  );
  assert(
    doc.includes(".deno/bin"),
    `${TROUBLESHOOTING_PATH} must point at ~/.deno/bin as the remedy`,
  );
});

Deno.test("pr-summary-3532 learnings are absorbed, so the archived summary is gone", async () => {
  const relative = "docs/archive/pr-summaries/pr-summary-3532.md";
  try {
    await Deno.stat(new URL(relative, REPO_ROOT));
  } catch (err) {
    assert(err instanceof Deno.errors.NotFound, `unexpected error: ${err}`);
    return;
  }
  throw new Error(`${relative} must be removed once absorbed into the manuals`);
});
