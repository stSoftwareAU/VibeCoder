/**
 * Tests for setup/label_sync.ts
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 */

import { assertEquals, assertRejects } from "@std/assert";
import {
  detectRepoUi,
  fetchRemoteLabelNames,
  removeDeprecatedLabels,
  syncLabelsForAllRepos,
  syncLabelsForRepo,
  syncSingleLabel,
} from "../setup/label_sync.ts";
import type { LabelSyncOptions } from "../setup/label_sync.ts";
import { LABEL_DEFINITIONS } from "../setup/label_definitions.ts";
import type { LabelDefinition } from "../setup/label_definitions.ts";

// ── Mock command runner ─────────────────────────────────────────────────

interface MockState {
  created: string[];
  edited: string[];
  deleted: string[];
  /** Every argv the code under test issued, for dry-run assertions. */
  commands: string[][];
}

/** Create a mock runner that tracks gh label operations. */
function mockGhRunner(existingLabels: string[] = []): {
  runner: LabelSyncOptions["runCommand"];
  state: MockState;
} {
  const state: MockState = {
    created: [],
    edited: [],
    deleted: [],
    commands: [],
  };

  const runner = async (
    cmd: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }> => {
    state.commands.push([...cmd]);
    if (cmd[0] !== "gh") {
      return { success: false, stdout: "", stderr: "unexpected" };
    }

    if (cmd[1] === "label" && cmd[2] === "list") {
      return {
        success: true,
        stdout: JSON.stringify(existingLabels.map((name) => ({ name }))),
        stderr: "",
      };
    }

    if (cmd[1] === "label" && cmd[2] === "create") {
      const labelName = cmd[3]!;
      if (existingLabels.includes(labelName)) {
        return { success: false, stdout: "", stderr: "already exists" };
      }
      state.created.push(labelName);
      return { success: true, stdout: "", stderr: "" };
    }

    if (cmd[1] === "label" && cmd[2] === "edit") {
      const labelName = cmd[3]!;
      state.edited.push(labelName);
      return { success: true, stdout: "", stderr: "" };
    }

    if (cmd[1] === "label" && cmd[2] === "delete") {
      const labelName = cmd[3]!;
      if (existingLabels.includes(labelName)) {
        state.deleted.push(labelName);
        return { success: true, stdout: "", stderr: "" };
      }
      return { success: false, stdout: "", stderr: "not found" };
    }

    if (cmd[1] === "api") {
      // repos/{owner/repo}/languages
      return {
        success: true,
        stdout: JSON.stringify({ TypeScript: 5000, Shell: 2000 }),
        stderr: "",
      };
    }

    return { success: false, stdout: "", stderr: "unknown command" };
  };

  return { runner, state };
}

// ── syncSingleLabel ─────────────────────────────────────────────────────

Deno.test("syncSingleLabel - creates label when it does not exist", async () => {
  const { runner, state } = mockGhRunner([]);
  const label: LabelDefinition = {
    name: "test-label",
    colour: "ff0000",
    description: "Test label",
    category: "workflow",
  };
  const result = await syncSingleLabel("org/repo", label, {
    runCommand: runner,
  });
  assertEquals(result, "created");
  assertEquals(state.created, ["test-label"]);
});

Deno.test("syncSingleLabel - dry run plans without creating or editing (Issue #1295)", async () => {
  const { runner, state } = mockGhRunner(["test-label"]);
  const label: LabelDefinition = {
    name: "test-label",
    colour: "ff0000",
    description: "Test label",
    category: "workflow",
  };
  const result = await syncSingleLabel("org/repo", label, {
    runCommand: runner,
    dryRun: true,
  });
  assertEquals(result, "updated");
  assertEquals(state.edited, []);
  assertEquals(state.created, []);
});

Deno.test("syncSingleLabel - updates label when it already exists", async () => {
  const { runner, state } = mockGhRunner(["test-label"]);
  const label: LabelDefinition = {
    name: "test-label",
    colour: "ff0000",
    description: "Test label",
    category: "workflow",
  };
  const result = await syncSingleLabel("org/repo", label, {
    runCommand: runner,
  });
  assertEquals(result, "updated");
  assertEquals(state.edited, ["test-label"]);
});

// ── removeDeprecatedLabels ──────────────────────────────────────────────

Deno.test("removeDeprecatedLabels - removes deprecated labels that exist", async () => {
  // Issue #1295: `good first issue` is no longer deprecated — `answered`
  // stands in as the second retired worker label.
  const { runner, state } = mockGhRunner(["best-model", "answered"]);
  const removed = await removeDeprecatedLabels("org/repo", {
    runCommand: runner,
  });
  assertEquals(removed, 2);
  assertEquals(state.deleted.includes("best-model"), true);
  assertEquals(state.deleted.includes("answered"), true);
});

Deno.test("removeDeprecatedLabels - never deletes GitHub's stock labels (Issue #1295)", async () => {
  // Stock labels a human maintainer uses for their own triage. Deleting a
  // label is irreversible and takes its issue associations with it.
  const { runner, state } = mockGhRunner(["good first issue", "help wanted"]);
  const removed = await removeDeprecatedLabels("org/repo", {
    runCommand: runner,
  });
  assertEquals(removed, 0);
  assertEquals(state.deleted, []);
});

Deno.test("removeDeprecatedLabels - dry run issues no gh label delete (Issue #1295)", async () => {
  const { runner, state } = mockGhRunner(["best-model", "answered"]);
  const wouldRemove = await removeDeprecatedLabels("org/repo", {
    runCommand: runner,
    dryRun: true,
  });
  assertEquals(wouldRemove, 2);
  assertEquals(state.deleted, []);
  assertEquals(
    state.commands.some((c) => c[1] === "label" && c[2] === "delete"),
    false,
  );
});

Deno.test("removeDeprecatedLabels - handles non-existent deprecated labels", async () => {
  const { runner } = mockGhRunner([]);
  const removed = await removeDeprecatedLabels("org/repo", {
    runCommand: runner,
  });
  assertEquals(removed, 0);
});

// ── detectRepoUi ────────────────────────────────────────────────────────

Deno.test("detectRepoUi - true when languages include a UI language", async () => {
  const runner = async () => ({
    success: true,
    stdout: JSON.stringify({ TypeScript: 5000, CSS: 800 }),
    stderr: "",
  });
  assertEquals(await detectRepoUi("org/repo", { runCommand: runner }), true);
});

Deno.test("detectRepoUi - false when languages are non-UI only", async () => {
  const runner = async () => ({
    success: true,
    stdout: JSON.stringify({ Rust: 9000, Shell: 1200 }),
    stderr: "",
  });
  assertEquals(await detectRepoUi("org/repo", { runCommand: runner }), false);
});

Deno.test("detectRepoUi - false when the gh command fails", async () => {
  const runner = async () => ({ success: false, stdout: "", stderr: "boom" });
  assertEquals(await detectRepoUi("org/repo", { runCommand: runner }), false);
});

Deno.test("detectRepoUi - false when the response is unparseable JSON", async () => {
  const runner = async () => ({
    success: true,
    stdout: "not json",
    stderr: "",
  });
  assertEquals(await detectRepoUi("org/repo", { runCommand: runner }), false);
});

Deno.test("detectRepoUi - queries the languages endpoint for the given repo", async () => {
  let requested: string[] = [];
  const runner = async (cmd: string[]) => {
    requested = cmd;
    return {
      success: true,
      stdout: JSON.stringify({ HTML: 3000 }),
      stderr: "",
    };
  };
  assertEquals(await detectRepoUi("org/repo", { runCommand: runner }), true);
  assertEquals(requested, ["gh", "api", "repos/org/repo/languages"]);
});

// ── syncLabelsForRepo ───────────────────────────────────────────────────

Deno.test("syncLabelsForRepo - creates all labels in a new repo", async () => {
  const { runner, state } = mockGhRunner([]);
  const result = await syncLabelsForRepo("org/repo", true, {
    runCommand: runner,
  });
  assertEquals(result.ok, true);
  assertEquals(result.repo, "org/repo");
  // All 11 labels should be created (UI repo)
  assertEquals(state.created.length, LABEL_DEFINITIONS.length);
  assertEquals(result.created, LABEL_DEFINITIONS.length);
});

Deno.test("syncLabelsForRepo - skips UI labels for non-UI repos", async () => {
  const { runner, state } = mockGhRunner([]);
  const result = await syncLabelsForRepo("org/repo", false, {
    runCommand: runner,
  });
  assertEquals(result.ok, true);
  // Only workflow labels (17, after Issue #2022 + Issue #2031 + Issue #2030 +
  // Issue #2029 + Issue #2055 + Issue #2077 + Issue #2650 + Issue #2904 +
  // Issue #4112 + Issue #59) should be created.
  assertEquals(state.created.length, 17);
  assertEquals(result.skipped, 1); // 1 UI label skipped
});

Deno.test("syncLabelsForRepo - updates existing labels", async () => {
  const existingLabels = LABEL_DEFINITIONS.map((l) => l.name);
  const { runner, state } = mockGhRunner(existingLabels);
  const result = await syncLabelsForRepo("org/repo", true, {
    runCommand: runner,
  });
  assertEquals(result.ok, true);
  // All labels should be edited (not created) since they all exist
  assertEquals(state.edited.length, LABEL_DEFINITIONS.length);
  assertEquals(state.created.length, 0);
});

Deno.test("syncLabelsForRepo - auto-detects UI via detectRepoUi when hasUi omitted", async () => {
  // The mock runner serves TypeScript for the languages endpoint, so the
  // omitted hasUi triggers detectRepoUi, which resolves to a UI repo.
  const { runner, state } = mockGhRunner([]);
  const result = await syncLabelsForRepo("org/repo", undefined, {
    runCommand: runner,
  });
  assertEquals(result.ok, true);
  assertEquals(result.skipped, 0); // UI repo → no UI labels skipped
  assertEquals(state.created.length, LABEL_DEFINITIONS.length);
});

Deno.test("syncLabelsForRepo - dry run issues no mutating gh call (Issue #1295)", async () => {
  const existing = [LABEL_DEFINITIONS[0]!.name, "best-model", "help wanted"];
  const { runner, state } = mockGhRunner(existing);
  const result = await syncLabelsForRepo("org/repo", true, {
    runCommand: runner,
    dryRun: true,
  });

  assertEquals(result.ok, true);
  assertEquals(result.dryRun, true);
  // Nothing was created, edited or deleted — only the read-only listing ran.
  assertEquals(state.created, []);
  assertEquals(state.edited, []);
  assertEquals(state.deleted, []);
  const mutating = state.commands.filter((c) =>
    c[1] === "label" && (c[2] === "create" || c[2] === "edit" ||
      c[2] === "delete")
  );
  assertEquals(mutating, []);

  // The plan still reports what a real run would do.
  assertEquals(result.updated, 1);
  assertEquals(result.created, LABEL_DEFINITIONS.length - 1);
  // `best-model` is deprecated; `help wanted` is a protected stock label.
  assertEquals(result.deprecated_removed, 1);
});

Deno.test("syncLabelsForRepo - dry run fails loud when the label listing fails", async () => {
  const runner = () =>
    Promise.resolve({ success: false, stdout: "", stderr: "gh: not found" });
  const result = await syncLabelsForRepo("org/repo", true, {
    runCommand: runner,
    dryRun: true,
  });
  assertEquals(result.ok, false);
  assertEquals(result.failures, 1);
  assertEquals(result.error?.includes("gh: not found"), true);
});

// ── fetchRemoteLabelNames ───────────────────────────────────────────────

Deno.test("fetchRemoteLabelNames - returns lower-cased existing label names", async () => {
  const { runner } = mockGhRunner(["Best-Model", "help wanted"]);
  const names = await fetchRemoteLabelNames("org/repo", { runCommand: runner });
  assertEquals(names.has("best-model"), true);
  assertEquals(names.has("help wanted"), true);
  assertEquals(names.has("absent"), false);
});

Deno.test("fetchRemoteLabelNames - throws rather than reporting an empty repo", async () => {
  const runner = () =>
    Promise.resolve({ success: false, stdout: "", stderr: "HTTP 404" });
  await assertRejects(
    () => fetchRemoteLabelNames("org/repo", { runCommand: runner }),
    Error,
    "HTTP 404",
  );
});

// ── syncLabelsForAllRepos ───────────────────────────────────────────────

Deno.test("syncLabelsForAllRepos - syncs labels for multiple repos", async () => {
  const { runner } = mockGhRunner([]);
  const results = await syncLabelsForAllRepos(["org/repo1", "org/repo2"], {
    runCommand: runner,
  });
  assertEquals(results.length, 2);
  assertEquals(results[0]!.repo, "org/repo1");
  assertEquals(results[1]!.repo, "org/repo2");
});

Deno.test("syncLabelsForAllRepos - skips empty repo strings", async () => {
  const { runner } = mockGhRunner([]);
  const results = await syncLabelsForAllRepos(["org/repo1", "", "org/repo2"], {
    runCommand: runner,
  });
  assertEquals(results.length, 2);
});

Deno.test("syncLabelsForAllRepos - returns empty array for empty input", async () => {
  const { runner } = mockGhRunner([]);
  const results = await syncLabelsForAllRepos([], { runCommand: runner });
  assertEquals(results.length, 0);
});
