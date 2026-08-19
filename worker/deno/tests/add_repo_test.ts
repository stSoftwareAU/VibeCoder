/**
 * Tests for add_repo.ts — runtime validation of an add-repo target.
 *
 * Issue #2576: validate target repo access and determine visibility at
 * runtime. Covers ok-public, ok-private, not-found, and no-access via an
 * injected gh mock — no real network.
 */

import { assertEquals } from "@std/assert";
import {
  type AddRepoDeps,
  type AddRepoFsDeps,
  type AddRepoTargetStatus,
  addRepoToMonitoredList,
  parseAddRepoTitle,
  validateAddRepoTarget,
} from "../lib/add_repo.ts";
import type { CommandOutput } from "../setup/collaborator_precheck.ts";

function ok(stdout: string): CommandOutput {
  return { success: true, stdout, stderr: "" };
}

function fail(stderr: string): CommandOutput {
  return { success: false, stdout: "", stderr };
}

/**
 * Build a deps object whose gh runner replies based on the request.
 *
 * `classifyRepoAccess` calls `gh api repos/{owner}/{repo}` (no --jq);
 * `getRepoVisibility` calls `gh api repos/{owner}/{repo} --jq .visibility`.
 * We disambiguate on the presence of the `--jq` argument.
 */
function deps(
  accessOutput: CommandOutput,
  visibilityOutput: CommandOutput,
): AddRepoDeps {
  return {
    runCommand: (cmd: string[]) =>
      Promise.resolve(
        cmd.includes("--jq") ? visibilityOutput : accessOutput,
      ),
  };
}

const TRIAGE_OK = JSON.stringify({ permissions: { triage: true } });
const TRIAGE_FALSE = JSON.stringify({ permissions: { triage: false } });

Deno.test("validateAddRepoTarget - ok + public", async () => {
  const result = await validateAddRepoTarget(
    "owner/repo",
    deps(ok(TRIAGE_OK), ok("public")),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const expected: AddRepoTargetStatus = { kind: "ok", visibility: "public" };
  assertEquals(result.value, expected);
});

Deno.test("validateAddRepoTarget - ok + private", async () => {
  const result = await validateAddRepoTarget(
    "owner/repo",
    deps(ok(TRIAGE_OK), ok("private")),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  const expected: AddRepoTargetStatus = { kind: "ok", visibility: "private" };
  assertEquals(result.value, expected);
});

Deno.test("validateAddRepoTarget - not_found when repo unreadable (404/403)", async () => {
  const result = await validateAddRepoTarget(
    "owner/missing",
    deps(fail("HTTP 404: Not Found"), ok("public")),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, { kind: "not_found" });
});

Deno.test("validateAddRepoTarget - no_access when visible but no triage", async () => {
  const result = await validateAddRepoTarget(
    "owner/repo",
    deps(ok(TRIAGE_FALSE), ok("public")),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, { kind: "no_access" });
});

Deno.test("validateAddRepoTarget - visibility fail-safes to private on unknown output", async () => {
  const result = await validateAddRepoTarget(
    "owner/repo",
    deps(ok(TRIAGE_OK), ok("internal")),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, { kind: "ok", visibility: "private" });
});

Deno.test("validateAddRepoTarget - returns err when visibility lookup itself fails", async () => {
  // Access succeeds (repo readable + triage), but the follow-up visibility
  // call fails transiently. Surface that as a Result.err rather than guessing.
  const result = await validateAddRepoTarget(
    "owner/repo",
    deps(ok(TRIAGE_OK), fail("HTTP 502: Bad Gateway")),
  );
  assertEquals(result.ok, false);
  if (result.ok) return;
  assertEquals(typeof result.error, "string");
  assertEquals(result.error.length > 0, true);
});

// ---------------------------------------------------------------------------
// parseAddRepoTitle (Issue #2575)
// ---------------------------------------------------------------------------

Deno.test("parseAddRepoTitle - parses a valid add-repo title", () => {
  assertEquals(parseAddRepoTitle("add-repo: example-org/private-repo-23"), {
    repo: "example-org/private-repo-23",
  });
});

Deno.test("parseAddRepoTitle - tolerates surrounding whitespace", () => {
  assertEquals(
    parseAddRepoTitle("  add-repo:   example-org/private-repo-23  "),
    {
      repo: "example-org/private-repo-23",
    },
  );
});

Deno.test("parseAddRepoTitle - is case-insensitive on the prefix", () => {
  assertEquals(parseAddRepoTitle("Add-Repo: owner/repo"), {
    repo: "owner/repo",
  });
});

Deno.test("parseAddRepoTitle - returns null without the prefix", () => {
  assertEquals(parseAddRepoTitle("please add owner/repo"), null);
});

Deno.test("parseAddRepoTitle - returns null for an empty slug", () => {
  assertEquals(parseAddRepoTitle("add-repo:"), null);
  assertEquals(parseAddRepoTitle("add-repo:   "), null);
});

Deno.test("parseAddRepoTitle - returns null for a malformed slug", () => {
  assertEquals(parseAddRepoTitle("add-repo: not a slug"), null);
  assertEquals(parseAddRepoTitle("add-repo: foo"), null);
  assertEquals(parseAddRepoTitle("add-repo: a/b/c"), null);
});

Deno.test("parseAddRepoTitle - rejects path-traversal slugs (Issue #2692)", () => {
  // A `..` or dot-only segment would steer setupRepo()'s derived path
  // above WORK_DIR, so it must never parse to a slug.
  assertEquals(parseAddRepoTitle("add-repo: owner/.."), null);
  assertEquals(parseAddRepoTitle("add-repo: owner/."), null);
  assertEquals(parseAddRepoTitle("add-repo: ../x"), null);
  assertEquals(parseAddRepoTitle("add-repo: ./x"), null);
});

// ---------------------------------------------------------------------------
// addRepoToMonitoredList (Issue #2575)
// ---------------------------------------------------------------------------

/**
 * Build injected fs deps backed by an in-memory store so tests touch no
 * real filesystem. `missing: true` makes the read reject (no such file).
 */
function fsDeps(
  store: { content?: string },
): AddRepoFsDeps {
  return {
    readTextFile: (_path: string) =>
      store.content === undefined
        ? Promise.reject(new Error("ENOENT"))
        : Promise.resolve(store.content),
    writeTextFile: (_path: string, data: string) => {
      store.content = data;
      return Promise.resolve();
    },
  };
}

Deno.test("addRepoToMonitoredList - appends a new slug to repos", async () => {
  const store = { content: JSON.stringify({ repos: ["owner/existing"] }) };
  const result = await addRepoToMonitoredList(
    "owner/new",
    "/tmp/.config.json",
    fsDeps(store),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, { added: true });
  const written = JSON.parse(store.content) as { repos: string[] };
  assertEquals(written.repos, ["owner/existing", "owner/new"]);
});

Deno.test("addRepoToMonitoredList - is idempotent for an already-present slug", async () => {
  const original = JSON.stringify({ repos: ["owner/existing"] });
  const store = { content: original };
  const result = await addRepoToMonitoredList(
    "owner/existing",
    "/tmp/.config.json",
    fsDeps(store),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, { added: false });
  // No rewrite — content is untouched, so no duplicate can be introduced.
  assertEquals(store.content, original);
});

Deno.test("addRepoToMonitoredList - bootstraps repos when the file is missing", async () => {
  const store: { content?: string } = {};
  const result = await addRepoToMonitoredList(
    "owner/first",
    "/tmp/.config.json",
    fsDeps(store),
  );
  assertEquals(result.ok, true);
  if (!result.ok) return;
  assertEquals(result.value, { added: true });
  const written = JSON.parse(store.content as string) as { repos: string[] };
  assertEquals(written.repos, ["owner/first"]);
});

Deno.test("addRepoToMonitoredList - preserves unknown config keys", async () => {
  const store = {
    content: JSON.stringify({
      repos: ["owner/existing"],
      claude_model: "opus",
      idle_task_template_weights: { "security-scan": 2 },
    }),
  };
  const result = await addRepoToMonitoredList(
    "owner/new",
    "/tmp/.config.json",
    fsDeps(store),
  );
  assertEquals(result.ok, true);
  const written = JSON.parse(store.content) as Record<string, unknown>;
  assertEquals(written.claude_model, "opus");
  assertEquals(written.idle_task_template_weights, { "security-scan": 2 });
  assertEquals(written.repos, ["owner/existing", "owner/new"]);
});

Deno.test("addRepoToMonitoredList - rejects an invalid slug without writing", async () => {
  const store = { content: JSON.stringify({ repos: ["owner/existing"] }) };
  let wrote = false;
  const deps: AddRepoFsDeps = {
    readTextFile: () => Promise.resolve(store.content),
    writeTextFile: () => {
      wrote = true;
      return Promise.resolve();
    },
  };
  const result = await addRepoToMonitoredList(
    "not a slug",
    "/tmp/.config.json",
    deps,
  );
  assertEquals(result.ok, false);
  assertEquals(wrote, false);
});

Deno.test("addRepoToMonitoredList - returns err on invalid JSON", async () => {
  const store = { content: "{ this is not json" };
  const result = await addRepoToMonitoredList(
    "owner/new",
    "/tmp/.config.json",
    fsDeps(store),
  );
  assertEquals(result.ok, false);
});
