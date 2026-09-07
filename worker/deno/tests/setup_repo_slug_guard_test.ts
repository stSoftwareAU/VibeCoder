/**
 * Regression tests for the setup CLI's repo-slug guard (Issue #1291).
 *
 * The setup CLI has its own config reader, which validated nothing: a slug
 * such as `org/..` escaped the work directory when `syncGitignoreForAllRepos`
 * derived a path from it, and a slug carrying a backtick reached a
 * ```bash fence in a filed issue that a repo admin is told to paste.
 *
 * Every test here calls the real function with the attack input and asserts
 * the refusal — they fail against the unguarded code.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  loadExistingConfig,
  mergeNonInteractive,
  writeConfigFile,
} from "../setup/config_setup.ts";
import { syncGitignoreForAllRepos } from "../setup/gitignore_sync.ts";
import { buildIssueBody } from "../setup/collaborator_precheck.ts";
import {
  isValidRepoSlug,
  partitionRepoSlugs,
  renderInertRepoSlug,
} from "../lib/repo_slug.ts";

/** The slugs the issue names as the attack inputs. */
const ATTACK_SLUGS = ["org/..", "org/`id`/x"];

// ---------------------------------------------------------------------------
// lib/repo_slug.ts — the shared guard
// ---------------------------------------------------------------------------

Deno.test("isValidRepoSlug - accepts real slugs and rejects traversal/injection", () => {
  for (const slug of ["stSoftwareAU/VibeCoder", "org/repo.js", "a-b_c/d.e-f"]) {
    assertEquals(isValidRepoSlug(slug), true, `expected ${slug} valid`);
  }
  for (
    const slug of [
      ...ATTACK_SLUGS,
      "org/",
      "org/.",
      "../x",
      "org/repo; rm -rf /",
      "org/$(id)",
      "",
      "orgrepo",
    ]
  ) {
    assertEquals(isValidRepoSlug(slug), false, `expected ${slug} invalid`);
  }
  assertEquals(isValidRepoSlug(42), false);
});

Deno.test("renderInertRepoSlug - strips shell and Markdown metacharacters", () => {
  const rendered = renderInertRepoSlug("org/`id`$(whoami)");
  assertEquals(/[`$()]/.test(rendered), false, rendered);
  assertEquals(renderInertRepoSlug(""), "(empty)");
});

Deno.test("partitionRepoSlugs - splits valid from invalid without dropping either", () => {
  const { valid, invalid } = partitionRepoSlugs([
    "org/repo",
    "org/..",
    "other/repo",
  ]);
  assertEquals(valid, ["org/repo", "other/repo"]);
  assertEquals(invalid, ["org/.."]);
});

// ---------------------------------------------------------------------------
// loadExistingConfig — the second reader that had no guard
// ---------------------------------------------------------------------------

Deno.test("loadExistingConfig - rejects traversal and injection slugs (Issue #1291)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "repo_slug_load_" });
  const configPath = `${dir}/.config.json`;
  try {
    await Deno.writeTextFile(
      configPath,
      JSON.stringify({ repos: ATTACK_SLUGS }),
    );
    const error = await assertRejects(
      () => loadExistingConfig(configPath),
      Error,
    );
    // Both bad entries are reported, and neither is echoed with its
    // metacharacters intact.
    assert(error.message.includes("org/.."), error.message);
    assertEquals(error.message.includes("`id`"), false, error.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadExistingConfig - rejects a non-array repos value", async () => {
  const dir = await Deno.makeTempDir({ prefix: "repo_slug_load_shape_" });
  const configPath = `${dir}/.config.json`;
  try {
    await Deno.writeTextFile(configPath, JSON.stringify({ repos: "org/repo" }));
    await assertRejects(() => loadExistingConfig(configPath), Error);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadExistingConfig - still loads a config whose repos are valid", async () => {
  const dir = await Deno.makeTempDir({ prefix: "repo_slug_load_ok_" });
  const configPath = `${dir}/.config.json`;
  try {
    await writeConfigFile(configPath, { repos: ["org/repo", "other/repo"] });
    const config = await loadExistingConfig(configPath);
    assertEquals(config.repos, ["org/repo", "other/repo"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// mergeNonInteractive — VIBE_REPOS / VIBE_ADD_REPOS
// ---------------------------------------------------------------------------

Deno.test("mergeNonInteractive - rejects an invalid slug in VIBE_REPOS", () => {
  const env = (name: string) =>
    name === "VIBE_REPOS" ? "org/repo,org/.." : undefined;
  const error = assertThrows(() => mergeNonInteractive({}, env), Error);
  assert(error.message.includes("VIBE_REPOS"), error.message);
});

Deno.test("mergeNonInteractive - rejects an invalid slug in VIBE_ADD_REPOS", () => {
  const env = (name: string) =>
    name === "VIBE_ADD_REPOS" ? "org/`id`/x" : undefined;
  const error = assertThrows(
    () => mergeNonInteractive({ repos: ["org/repo"] }, env),
    Error,
  );
  assert(error.message.includes("VIBE_ADD_REPOS"), error.message);
});

Deno.test("mergeNonInteractive - valid repos still merge", () => {
  const env = (name: string) =>
    name === "VIBE_ADD_REPOS" ? "other/repo" : undefined;
  const result = mergeNonInteractive({ repos: ["org/repo"] }, env);
  assertEquals(result.repos, ["org/repo", "other/repo"]);
});

// ---------------------------------------------------------------------------
// 4a — path traversal in syncGitignoreForAllRepos
// ---------------------------------------------------------------------------

Deno.test("syncGitignoreForAllRepos - refuses org/.. and writes nothing outside the clone", async () => {
  const root = await Deno.makeTempDir({ prefix: "repo_slug_sync_" });
  const workDir = `${root}/work`;
  try {
    await Deno.mkdir(workDir);
    const summary = await syncGitignoreForAllRepos(
      ["org/..", "org/", "org/repo"],
      workDir,
    );

    // The two malformed slugs fail loudly; the valid one is skipped because
    // it has not been cloned into the temp work dir.
    assertEquals(summary.failed, 2);
    assertEquals(summary.applied, 0);
    assertEquals(summary.skipped, 1);
    for (const result of summary.results.slice(0, 2)) {
      assert(result.error, "expected an error for the malformed slug");
    }

    // Nothing was written to the work-volume root or its parent.
    for (
      const path of [
        `${workDir}/.gitignore`,
        `${workDir}/.gitattributes`,
        `${root}/.gitignore`,
        `${root}/.gitattributes`,
      ]
    ) {
      let exists = true;
      try {
        await Deno.stat(path);
      } catch {
        exists = false;
      }
      assertEquals(exists, false, `${path} must not have been written`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// 4b — shell injection into the command an admin is told to paste
// ---------------------------------------------------------------------------

Deno.test("buildIssueBody - never emits a pasteable command for an injected slug", () => {
  const body = buildIssueBody("worker-bot", [
    { repo: "org/`id`", status: "not_visible" },
    { repo: "org/repo", status: "not_assignable" },
  ]);

  // The valid repo still gets its invite command...
  assert(
    body.includes(
      "gh api -X PUT repos/org/repo/collaborators/worker-bot -f permission=triage",
    ),
    body,
  );
  // ...and the injected slug reaches neither a command nor the prose intact.
  assertEquals(body.includes("`id`"), false, body);
  assertEquals(
    body.includes("repos/org/`id`/collaborators"),
    false,
    body,
  );
  assert(body.includes("invalid repo slug"), body);
});

Deno.test("buildIssueBody - emits no bare invite fence when every slug is invalid", () => {
  const body = buildIssueBody("worker-bot", [
    { repo: "org/$(id)", status: "not_visible" },
  ]);
  assertEquals(body.includes("gh api -X PUT repos/org/$(id)"), false, body);
  assert(body.includes("invalid repo slug"), body);
});
