/**
 * Tests for trust exclusion sources (Issue #251, parent #234).
 *
 * Static exclusions (host login, service accounts, `[bot]`-shaped logins)
 * and the optional org-team membership fetch. An exclusion source that
 * fails must never become an empty exclusion set — that would widen trust.
 */

import { assert, assertEquals } from "@std/assert";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type GhSpawnResult,
} from "../lib/gh_spawn.ts";
import { normaliseLogin } from "../lib/identity_guard.ts";
import {
  fetchTeamMembers,
  isBotLogin,
  resolveStaticExclusions,
  type TeamMemberSet,
} from "../lib/trust_exclusions.ts";

const TEAM_SLUG = "stSoftwareAU/vibe-workers";
const TEAM_PATH = "orgs/stSoftwareAU/teams/vibe-workers/members?per_page=100";

function ok(stdout: string): GhSpawnResult {
  return { code: 0, success: true, stdout, stderr: "" };
}

function fail(stderr: string, code = 1): GhSpawnResult {
  return { code, success: false, stdout: "", stderr };
}

function member(login: string): Record<string, unknown> {
  return { login, id: login.length };
}

function restore(): void {
  _resetGhSpawnRunner();
}

/** Record every spawn and return a fixed result. */
function stubGh(
  result: GhSpawnResult | ((args: readonly string[]) => GhSpawnResult),
): { calls: string[][] } {
  const calls: string[][] = [];
  _setGhSpawnRunner((args) => {
    calls.push([...args]);
    return Promise.resolve(
      typeof result === "function" ? result(args) : result,
    );
  });
  return { calls };
}

/**
 * The only safe way to turn a team result into exclusion logins. An error
 * result yields `"unusable"` — never `[]` — so a failed fetch cannot be
 * spread into an exclusion list.
 */
function exclusionLoginsFrom(
  result: TeamMemberSet,
): string[] | "unusable" {
  if (!result.ok) return "unusable";
  if (result.value.kind === "off") return [];
  return [...result.value.members];
}

// =============================================================================
// isBotLogin — the single [bot]-detection predicate
// =============================================================================

Deno.test("isBotLogin - detects [bot] suffix case-insensitively", () => {
  assertEquals(isBotLogin("myapp[bot]"), true);
  assertEquals(isBotLogin("MyApp[BOT]"), true);
  assertEquals(isBotLogin("  renovate[Bot]  "), true);
});

Deno.test("isBotLogin - detects known-bot-without-suffix case-insensitively", () => {
  assertEquals(isBotLogin("dependabot"), true);
  assertEquals(isBotLogin("Renovate"), true);
  assertEquals(isBotLogin("GITHUB-ACTIONS"), true);
});

Deno.test("isBotLogin - rejects ordinary human logins", () => {
  assertEquals(isBotLogin("alice"), false);
  assertEquals(isBotLogin("nleck"), false);
  assertEquals(isBotLogin(""), false);
});

// =============================================================================
// resolveStaticExclusions
// =============================================================================

Deno.test("resolveStaticExclusions - includes host login and every service account", () => {
  const exclusions = resolveStaticExclusions({
    serviceAccounts: ["stsvcbot", "Vibecoderbot"],
    githubUser: "host-bot",
  });
  assertEquals(exclusions, new Set(["stsvcbot", "vibecoderbot", "host-bot"]));
});

Deno.test("resolveStaticExclusions - matching is case-insensitive", () => {
  const exclusions = resolveStaticExclusions({
    serviceAccounts: ["  STSvcBot  ", "VibeCoderBot"],
    githubUser: "Host-BOT",
  });
  assert(exclusions.has(normaliseLogin("stsvcbot")));
  assert(exclusions.has(normaliseLogin("VIBECODERBOT")));
  assert(exclusions.has(normaliseLogin("host-bot")));
  assertEquals(exclusions.size, 3);
});

Deno.test("resolveStaticExclusions - [bot] suffix login is excluded case-insensitively", () => {
  const exclusions = resolveStaticExclusions({
    serviceAccounts: ["Reviewer[bot]"],
    githubUser: "MyApp[BOT]",
  });
  assert(exclusions.has(normaliseLogin("reviewer[bot]")));
  assert(exclusions.has(normaliseLogin("myapp[bot]")));
  assertEquals(isBotLogin("Reviewer[bot]"), true);
  assertEquals(isBotLogin("someone-else[BOT]"), true);
});

Deno.test("resolveStaticExclusions - known-bot-without-suffix is excluded case-insensitively", () => {
  const exclusions = resolveStaticExclusions({
    serviceAccounts: ["Dependabot", "renovate"],
    githubUser: "GitHub-Actions",
  });
  assert(exclusions.has("dependabot"));
  assert(exclusions.has("renovate"));
  assert(exclusions.has("github-actions"));
  assertEquals(isBotLogin("DEPENDABOT"), true);
  assertEquals(isBotLogin("Renovate"), true);
  assertEquals(isBotLogin("github-actions"), true);
});

Deno.test("resolveStaticExclusions - skips blank entries", () => {
  const exclusions = resolveStaticExclusions({
    serviceAccounts: ["", "  ", "stsvcbot"],
    githubUser: "   ",
  });
  assertEquals(exclusions, new Set(["stsvcbot"]));
});

// =============================================================================
// fetchTeamMembers — no slug / invalid slug
// =============================================================================

Deno.test("fetchTeamMembers - no-slug-configured returns team exclusion off with zero gh calls", async () => {
  const { calls } = stubGh(ok("[]"));
  try {
    for (const slug of [undefined, null, "", "   "]) {
      const result = await fetchTeamMembers(slug, {});
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(result.value.kind, "off");
      }
    }
    assertEquals(calls, [], "unconfigured slug must not call gh");
  } finally {
    restore();
  }
});

Deno.test("fetchTeamMembers - bare slug is an error, not exclusion-off", async () => {
  const { calls } = stubGh(ok("[]"));
  try {
    const result = await fetchTeamMembers("vibe-workers", {});
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.reason, "invalid-slug");
    }
    assertEquals(calls, [], "invalid slug must not call gh");
  } finally {
    restore();
  }
});

// =============================================================================
// fetchTeamMembers — success and pagination
// =============================================================================

Deno.test("fetchTeamMembers - success returns normalised logins", async () => {
  const { calls } = stubGh(
    ok(JSON.stringify([member("Alice"), member("Bob-Bot")])),
  );
  try {
    const result = await fetchTeamMembers(TEAM_SLUG, {});
    assertEquals(result.ok, true);
    if (result.ok && result.value.kind === "members") {
      assertEquals(result.value.members, new Set(["alice", "bob-bot"]));
    }
    assertEquals(calls.length, 1);
    assertEquals(calls[0]![0], "api");
    assert(calls[0]!.includes("--paginate"));
    assert(calls[0]!.includes(TEAM_PATH));
  } finally {
    restore();
  }
});

Deno.test("fetchTeamMembers - pagination concatenates every page", async () => {
  const page1 = [member("user-1"), member("user-2")];
  const page2 = [member("user-3")];
  // gh --paginate may emit one merged array or concatenated arrays.
  const concatenated = `${JSON.stringify(page1)}\n${JSON.stringify(page2)}`;
  stubGh(ok(concatenated));
  try {
    const result = await fetchTeamMembers(TEAM_SLUG, {});
    assertEquals(result.ok, true);
    if (result.ok && result.value.kind === "members") {
      assertEquals(
        result.value.members,
        new Set(["user-1", "user-2", "user-3"]),
      );
    }
  } finally {
    restore();
  }
});

Deno.test("fetchTeamMembers - empty membership is a successful empty set", async () => {
  stubGh(ok("[]"));
  try {
    const result = await fetchTeamMembers(TEAM_SLUG, {});
    assertEquals(result.ok, true);
    if (result.ok && result.value.kind === "members") {
      assertEquals(result.value.members.size, 0);
    }
    assertEquals(exclusionLoginsFrom(result), []);
  } finally {
    restore();
  }
});

// =============================================================================
// fetchTeamMembers — fail loud (never an empty exclusion set)
// =============================================================================

Deno.test("fetchTeamMembers - 404 team does not exist is an error result", async () => {
  stubGh(fail("gh: Not Found (HTTP 404)"));
  try {
    const result = await fetchTeamMembers(TEAM_SLUG, {});
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.reason, "http-404");
      assertEquals(result.error.status, 404);
    }
    assertEquals("members" in result, false);
    assertEquals(exclusionLoginsFrom(result), "unusable");
  } finally {
    restore();
  }
});

Deno.test("team fetch 403 does not widen trust", async () => {
  stubGh(
    fail(
      "gh: Resource not accessible by integration (HTTP 403)",
    ),
  );
  try {
    const result = await fetchTeamMembers(TEAM_SLUG, {});
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.reason, "http-403");
      assertEquals(result.error.status, 403);
      assert(
        result.error.message.toLowerCase().includes("read:org"),
        `403 must mention the missing read:org scope, got: ${result.error.message}`,
      );
    }
    // The failure mode this issue exists to prevent: treating a 403 as
    // "no exclusions" and spreading [] into the derived allowlist.
    assertEquals("members" in result, false);
    assertEquals(exclusionLoginsFrom(result), "unusable");
    assert(
      !Array.isArray(
        "members" in result
          ? (result as { members?: unknown }).members
          : undefined,
      ),
      "error result must not carry a members array a caller could spread",
    );
  } finally {
    restore();
  }
});

Deno.test("fetchTeamMembers - malformed JSON is an error result", async () => {
  stubGh(ok("{not-json"));
  try {
    const result = await fetchTeamMembers(TEAM_SLUG, {});
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.reason, "malformed-json");
    }
    assertEquals("members" in result, false);
    assertEquals(exclusionLoginsFrom(result), "unusable");
  } finally {
    restore();
  }
});

Deno.test("fetchTeamMembers - non-zero exit without HTTP status is an error result", async () => {
  stubGh(fail("connection reset"));
  try {
    const result = await fetchTeamMembers(TEAM_SLUG, {});
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(result.error.reason, "gh-exit");
    }
    assertEquals(exclusionLoginsFrom(result), "unusable");
  } finally {
    restore();
  }
});
