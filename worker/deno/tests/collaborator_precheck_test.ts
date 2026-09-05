/**
 * Tests for the setup-time collaborator precheck (Issue #2326).
 *
 * Verifies that `verifyMonitoredCollaborators` classifies each monitored
 * repo as `ok`, `not_visible`, or `not_assignable` from the worker token's
 * own view, and files exactly one consolidated issue against
 * stSoftwareAU/VibeCoder when any repo is misconfigured (commenting on an
 * existing open issue rather than duplicating).
 */

import { assertEquals } from "@std/assert";
import {
  classifyRepoAccess,
  type CommandOutput,
  PRECHECK_DEDUP_TAG,
  verifyMonitoredCollaborators,
} from "../setup/collaborator_precheck.ts";

/** The fleet login the seeded precheck issue is authored by. */
const FLEET_AUTHOR = "vibe-coder-bot";

/** Build a fake runner from a map of command-key → output. */
function fakeRunner(
  handler: (cmd: string[]) => CommandOutput,
): { runner: (cmd: string[]) => Promise<CommandOutput>; calls: string[][] } {
  const calls: string[][] = [];
  const runner = (cmd: string[]): Promise<CommandOutput> => {
    calls.push(cmd);
    return Promise.resolve(handler(cmd));
  };
  return { runner, calls };
}

/** Standard "I am the worker" response for `gh api user`. */
function userResponse(login: string): CommandOutput {
  return { success: true, stdout: login, stderr: "" };
}

/** A repo JSON body with the given triage permission. */
function repoJson(triage: boolean): string {
  return JSON.stringify({
    full_name: "org/repo",
    permissions: {
      admin: false,
      push: false,
      pull: true,
      triage,
      maintain: false,
    },
  });
}

Deno.test("classifyRepoAccess - 200 with triage true is ok", async () => {
  const { runner } = fakeRunner((cmd) => {
    if (cmd.includes("repos/org/repo")) {
      return { success: true, stdout: repoJson(true), stderr: "" };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });
  const status = await classifyRepoAccess("org/repo", runner);
  assertEquals(status, "ok");
});

Deno.test("classifyRepoAccess - 200 with triage false is not_assignable", async () => {
  const { runner } = fakeRunner(() => ({
    success: true,
    stdout: repoJson(false),
    stderr: "",
  }));
  const status = await classifyRepoAccess("org/repo", runner);
  assertEquals(status, "not_assignable");
});

Deno.test("classifyRepoAccess - 404 is not_visible", async () => {
  const { runner } = fakeRunner(() => ({
    success: false,
    stdout: "",
    stderr: "gh: Not Found (HTTP 404)",
  }));
  const status = await classifyRepoAccess("org/repo", runner);
  assertEquals(status, "not_visible");
});

Deno.test("classifyRepoAccess - 403 is not_visible", async () => {
  const { runner } = fakeRunner(() => ({
    success: false,
    stdout: "",
    stderr: "gh: Forbidden (HTTP 403)",
  }));
  const status = await classifyRepoAccess("org/repo", runner);
  assertEquals(status, "not_visible");
});

Deno.test("verifyMonitoredCollaborators - all ok files no issue", async () => {
  const { runner, calls } = fakeRunner((cmd) => {
    if (cmd.includes("user")) return userResponse("VibeWorker");
    if (cmd.some((a) => a.startsWith("repos/"))) {
      return { success: true, stdout: repoJson(true), stderr: "" };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });

  const result = await verifyMonitoredCollaborators({
    repos: ["org/a", "org/b"],
    runCommand: runner,
  });

  assertEquals(result.workerUser, "VibeWorker");
  assertEquals(result.misses.length, 0);
  assertEquals(result.issueFiled, false);
  // No issue list/create/comment commands were issued.
  const filed = calls.some((c) =>
    c.includes("issue") && (c.includes("create") || c.includes("comment"))
  );
  assertEquals(filed, false);
});

Deno.test("verifyMonitoredCollaborators - one missing files one issue", async () => {
  const { runner, calls } = fakeRunner((cmd) => {
    if (cmd.includes("user")) return userResponse("VibeWorker");
    if (cmd.includes("repos/org/good")) {
      return { success: true, stdout: repoJson(true), stderr: "" };
    }
    if (cmd.includes("repos/org/bad")) {
      return { success: false, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    }
    // No existing open issue.
    if (cmd.includes("list")) {
      return { success: true, stdout: "[]", stderr: "" };
    }
    // Issue create.
    if (cmd.includes("create")) {
      return {
        success: true,
        stdout: "https://github.com/stSoftwareAU/VibeCoder/issues/1",
        stderr: "",
      };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });

  const result = await verifyMonitoredCollaborators({
    repos: ["org/good", "org/bad"],
    runCommand: runner,
  });

  assertEquals(result.misses.length, 1);
  assertEquals(result.misses[0]!.repo, "org/bad");
  assertEquals(result.misses[0]!.status, "not_visible");
  assertEquals(result.issueFiled, true);
  assertEquals(result.issueUpdated, false);

  const createCall = calls.find((c) => c.includes("create"));
  assertEquals(createCall !== undefined, true);
  // The body carries the dedup tag and the invite command for the bad repo.
  const body = createCall!.find((a) => a.includes(PRECHECK_DEDUP_TAG)) ?? "";
  assertEquals(body.includes("collaborators/VibeWorker"), true);
  assertEquals(body.includes("org/bad"), true);
});

Deno.test("verifyMonitoredCollaborators - multiple missing listed in one issue", async () => {
  const { runner, calls } = fakeRunner((cmd) => {
    if (cmd.includes("user")) return userResponse("VibeWorker");
    if (cmd.includes("repos/org/bad1")) {
      return { success: false, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    }
    if (cmd.includes("repos/org/bad2")) {
      return { success: true, stdout: repoJson(false), stderr: "" };
    }
    if (cmd.includes("list")) {
      return { success: true, stdout: "[]", stderr: "" };
    }
    if (cmd.includes("create")) {
      return { success: true, stdout: "url", stderr: "" };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });

  const result = await verifyMonitoredCollaborators({
    repos: ["org/bad1", "org/bad2"],
    runCommand: runner,
  });

  assertEquals(result.misses.length, 2);
  assertEquals(result.issueFiled, true);
  const createCall = calls.find((c) => c.includes("create"))!;
  const body = createCall.find((a) => a.includes(PRECHECK_DEDUP_TAG))!;
  assertEquals(body.includes("org/bad1"), true);
  assertEquals(body.includes("org/bad2"), true);
  assertEquals(body.includes("not_visible"), true);
  assertEquals(body.includes("not_assignable"), true);
});

Deno.test("verifyMonitoredCollaborators - existing open issue is commented not duplicated", async () => {
  const { runner, calls } = fakeRunner((cmd) => {
    if (cmd.includes("user")) return userResponse("VibeWorker");
    if (cmd.includes("repos/org/bad")) {
      return { success: false, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    }
    // Existing open issue found via search.
    if (cmd.includes("list")) {
      return {
        success: true,
        stdout: JSON.stringify([{
          number: 42,
          body: `Filed by the fleet.\n${PRECHECK_DEDUP_TAG}`,
          author: { login: FLEET_AUTHOR },
        }]),
        stderr: "",
      };
    }
    if (cmd.includes("comment")) {
      return { success: true, stdout: "url", stderr: "" };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });

  const result = await verifyMonitoredCollaborators({
    repos: ["org/bad"],
    runCommand: runner,
    fleetAuthors: [FLEET_AUTHOR],
  });

  assertEquals(result.issueUpdated, true);
  assertEquals(result.issueFiled, false);
  // A comment was posted on issue 42; no create was issued.
  const commentCall = calls.find((c) => c.includes("comment"));
  assertEquals(commentCall !== undefined, true);
  assertEquals(commentCall!.includes("42"), true);
  const createCall = calls.find((c) => c.includes("create"));
  assertEquals(createCall, undefined);
});

// ============================================================================
// Identity-guard reporting (Issue #4030)
// ============================================================================

Deno.test("verifyMonitoredCollaborators - empty service_accounts files an issue even when every repo is ok", async () => {
  const { runner, calls } = fakeRunner((cmd) => {
    if (cmd.includes("user")) return userResponse("VibeWorker");
    if (cmd.some((a) => a.startsWith("repos/"))) {
      return { success: true, stdout: repoJson(true), stderr: "" };
    }
    if (cmd.includes("list")) {
      return { success: true, stdout: "[]", stderr: "" };
    }
    if (cmd.includes("create")) {
      return { success: true, stdout: "url", stderr: "" };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });

  const result = await verifyMonitoredCollaborators({
    repos: ["org/a"],
    serviceAccounts: [],
    runCommand: runner,
  });

  assertEquals(result.misses.length, 0);
  assertEquals(result.identityGuardInactive, true);
  assertEquals(result.issueFiled, true);

  const createCall = calls.find((c) => c.includes("create"))!;
  const body = createCall.find((a) => a.includes(PRECHECK_DEDUP_TAG))!;
  assertEquals(body.includes("service_accounts"), true);
  assertEquals(body.includes("VibeWorker"), true);
});

Deno.test("verifyMonitoredCollaborators - blank-only service_accounts counts as inactive", async () => {
  const { runner } = fakeRunner((cmd) => {
    if (cmd.includes("user")) return userResponse("VibeWorker");
    if (cmd.some((a) => a.startsWith("repos/"))) {
      return { success: true, stdout: repoJson(true), stderr: "" };
    }
    if (cmd.includes("list")) {
      return { success: true, stdout: "[]", stderr: "" };
    }
    if (cmd.includes("create")) {
      return { success: true, stdout: "url", stderr: "" };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });

  const result = await verifyMonitoredCollaborators({
    repos: ["org/a"],
    serviceAccounts: ["  ", ""],
    runCommand: runner,
  });

  assertEquals(result.identityGuardInactive, true);
  assertEquals(result.issueFiled, true);
});

Deno.test("verifyMonitoredCollaborators - a configured allowlist files nothing", async () => {
  const { runner, calls } = fakeRunner((cmd) => {
    if (cmd.includes("user")) return userResponse("VibeWorker");
    if (cmd.some((a) => a.startsWith("repos/"))) {
      return { success: true, stdout: repoJson(true), stderr: "" };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });

  const result = await verifyMonitoredCollaborators({
    repos: ["org/a"],
    serviceAccounts: ["VibeWorker"],
    runCommand: runner,
  });

  assertEquals(result.identityGuardInactive, false);
  assertEquals(result.issueFiled, false);
  const filed = calls.some((c) =>
    c.includes("issue") && (c.includes("create") || c.includes("comment"))
  );
  assertEquals(filed, false);
});

Deno.test("verifyMonitoredCollaborators - inactive guard and repo misses share one issue", async () => {
  const { runner, calls } = fakeRunner((cmd) => {
    if (cmd.includes("user")) return userResponse("VibeWorker");
    if (cmd.includes("repos/org/bad")) {
      return { success: false, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    }
    if (cmd.includes("list")) {
      return { success: true, stdout: "[]", stderr: "" };
    }
    if (cmd.includes("create")) {
      return { success: true, stdout: "url", stderr: "" };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });

  const result = await verifyMonitoredCollaborators({
    repos: ["org/bad"],
    serviceAccounts: [],
    runCommand: runner,
  });

  assertEquals(result.misses.length, 1);
  assertEquals(result.identityGuardInactive, true);
  // Exactly one issue carries both findings.
  const createCalls = calls.filter((c) => c.includes("create"));
  assertEquals(createCalls.length, 1);
  const body = createCalls[0]!.find((a) => a.includes(PRECHECK_DEDUP_TAG))!;
  assertEquals(body.includes("org/bad"), true);
  assertEquals(body.includes("service_accounts"), true);
});

Deno.test("verifyMonitoredCollaborators - omitted serviceAccounts skips the identity check", async () => {
  const { runner, calls } = fakeRunner((cmd) => {
    if (cmd.includes("user")) return userResponse("VibeWorker");
    if (cmd.some((a) => a.startsWith("repos/"))) {
      return { success: true, stdout: repoJson(true), stderr: "" };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });

  const result = await verifyMonitoredCollaborators({
    repos: ["org/a"],
    runCommand: runner,
  });

  assertEquals(result.identityGuardInactive, false);
  const filed = calls.some((c) =>
    c.includes("issue") && (c.includes("create") || c.includes("comment"))
  );
  assertEquals(filed, false);
});

Deno.test("verifyMonitoredCollaborators - user lookup failure returns error, files nothing", async () => {
  const { runner, calls } = fakeRunner((cmd) => {
    if (cmd.includes("user")) {
      return { success: false, stdout: "", stderr: "not authenticated" };
    }
    return { success: false, stdout: "", stderr: "unexpected" };
  });

  const result = await verifyMonitoredCollaborators({
    repos: ["org/a"],
    runCommand: runner,
  });

  assertEquals(result.workerUser, undefined);
  assertEquals(result.error !== undefined, true);
  assertEquals(result.issueFiled, false);
  const filed = calls.some((c) =>
    c.includes("create") || c.includes("comment")
  );
  assertEquals(filed, false);
});
