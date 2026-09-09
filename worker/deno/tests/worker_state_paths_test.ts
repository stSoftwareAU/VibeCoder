/**
 * Tests for the worker-owned state path matcher (Issue #1661).
 *
 * `isWorkerStatePath` decides what the final-mile chokepoint silently
 * unstages, so its rejections matter as much as its matches: anything it
 * accepts by mistake is a repository file quietly dropped from a commit.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  DEFAULT_BRANCH_CACHE_FILE,
  HEARTBEAT_FILE_PREFIX,
  HEARTBEAT_MARKER_FILE_PREFIX,
  isWorkerStatePath,
  PR_RESPONSE_MESSAGE_FILE,
} from "../lib/worker_state_paths.ts";
import { prResponseMessagePath } from "../lib/pr_branch_preparation.ts";
import {
  heartbeatFilePath,
  markerStateFilePath,
} from "../lib/heartbeat_storage.ts";

Deno.test("isWorkerStatePath - matches the worker's own state files", () => {
  for (
    const path of [
      ".heartbeat_stSoftwareAU_VibeCoder_1661",
      ".heartbeat-marker_stSoftwareAU_VibeCoder_1661",
      ".vibe_default_branch",
      ".pr_response_message",
      ".heartbeat_owner_repo-with-dash_7",
      ".heartbeat-marker_owner_repo.name_12345",
    ]
  ) {
    assertEquals(isWorkerStatePath(path), true, `expected match: ${path}`);
  }
});

Deno.test("isWorkerStatePath - matches the paths the writers actually produce", () => {
  // The matcher and the writers share the same prefix constants; this proves
  // they have not drifted apart.
  const heartbeat = heartbeatFilePath("/work", "stSoftwareAU/VibeCoder", 1661);
  const marker = markerStateFilePath("/work", "stSoftwareAU/VibeCoder", 1661);

  assertEquals(
    heartbeat,
    `/work/${HEARTBEAT_FILE_PREFIX}stSoftwareAU_VibeCoder_1661`,
  );
  assertEquals(
    marker,
    `/work/${HEARTBEAT_MARKER_FILE_PREFIX}stSoftwareAU_VibeCoder_1661`,
  );

  // Basenames — what git reports for a file at the root of the clone.
  assertEquals(isWorkerStatePath(heartbeat.slice("/work/".length)), true);
  assertEquals(isWorkerStatePath(marker.slice("/work/".length)), true);

  // The agent's PR reply file (Issue #1711): the reader in
  // `pr_branch_preparation.ts` and the matcher share one constant.
  const response = prResponseMessagePath("/work");
  assertEquals(response, `/work/${PR_RESPONSE_MESSAGE_FILE}`);
  assertEquals(PR_RESPONSE_MESSAGE_FILE, ".pr_response_message");
  assertEquals(isWorkerStatePath(response.slice("/work/".length)), true);
});

Deno.test("isWorkerStatePath - rejects nested, truncated and unrelated paths", () => {
  for (
    const path of [
      // Nested — only exact top-level names are worker state.
      ".heartbeat_x_1/notes.txt",
      ".heartbeat-marker_x_1/notes.txt",
      "foo/.vibe_default_branch",
      "docs/.heartbeat_x_1",
      "foo/.pr_response_message",
      // Missing the trailing `_<issue>`.
      ".heartbeat_x",
      ".heartbeat-marker_x",
      ".heartbeat_x_",
      ".heartbeat_x_12a",
      // Prefix present but not at the start, or not the prefix at all.
      "heartbeat_x_1",
      ".heartbeats_x_1",
      ".vibe_default_branch.bak",
      ".vibe_default_branchx",
      ".pr_response_message.bak",
      ".pr_response_messagex",
      "pr_response_message",
      // Genuinely secret-bearing paths must stay the safety gate's business.
      ".env",
      "credentials.json",
      // Degenerate input.
      "",
      ".",
      "..",
      // Unicode outside the permitted character class.
      ".heartbeat_ownér_repo_1",
      ".heartbeat_x_١٢",
      `${DEFAULT_BRANCH_CACHE_FILE}​`,
    ]
  ) {
    assertEquals(
      isWorkerStatePath(path),
      false,
      `expected rejection: ${JSON.stringify(path)}`,
    );
  }
});
