/**
 * Tests for setup/label_colour_reconcile.ts (Issue #368).
 *
 * The reconcile pass is where the canonical colour table earns its keep:
 * creation-time consistency fixes nothing that already drifted on the
 * remote. These tests cover the drift repaint, the no-op case, the
 * human-label carve-out, dry-run, and the fail-loud paths.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  reconcileLabelColoursForAllRepos,
  reconcileLabelColoursForRepo,
} from "../setup/label_colour_reconcile.ts";
import type { LabelColourReconcileOptions } from "../setup/label_colour_reconcile.ts";

interface RemoteLabel {
  name: string;
  color: string;
}

interface MockState {
  edited: { label: string; colour: string; repo: string }[];
  listed: string[];
}

/**
 * Mock `gh` runner over a fixed remote label set.
 *
 * @param remote Labels per repo, as `gh label list --json name,color`
 *   would return them.
 * @param failEdits Label names whose `gh label edit` must fail.
 * @param failList Repos whose `gh label list` must fail.
 */
function mockGh(
  remote: Record<string, RemoteLabel[]>,
  opts: { failEdits?: string[]; failList?: string[] } = {},
): {
  runner: NonNullable<LabelColourReconcileOptions["runCommand"]>;
  state: MockState;
} {
  const state: MockState = { edited: [], listed: [] };
  const runner = (cmd: string[]) => {
    const repoIndex = cmd.indexOf("--repo");
    const repo = repoIndex >= 0 ? cmd[repoIndex + 1]! : "";

    if (cmd[1] === "label" && cmd[2] === "list") {
      state.listed.push(repo);
      if (opts.failList?.includes(repo)) {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "HTTP 404: Not Found",
        });
      }
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify(remote[repo] ?? []),
        stderr: "",
      });
    }

    if (cmd[1] === "label" && cmd[2] === "edit") {
      const label = cmd[3]!;
      const colourIndex = cmd.indexOf("--color");
      if (opts.failEdits?.includes(label)) {
        return Promise.resolve({
          success: false,
          stdout: "",
          stderr: "HTTP 403: Resource not accessible",
        });
      }
      state.edited.push({ label, colour: cmd[colourIndex + 1]!, repo });
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    }

    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: "unexpected",
    });
  };
  return { runner, state };
}

// ── Drift repair ────────────────────────────────────────────────────────

Deno.test("reconcileLabelColoursForRepo - repaints a drifted label to the canonical colour", async () => {
  const { runner, state } = mockGh({
    "org/repo": [
      { name: "severity:critical", color: "ededed" },
      { name: "confidence:low", color: "cfd3d7" },
    ],
  });

  const result = await reconcileLabelColoursForRepo("org/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  assertEquals(result.drifted, 2);
  assertEquals(result.changed, 2);
  assertEquals(result.failures, 0);
  assertEquals(
    state.edited.find((e) => e.label === "severity:critical")?.colour,
    "b60205",
  );
  assertEquals(
    state.edited.find((e) => e.label === "confidence:low")?.colour,
    "c2e0c6",
  );
});

Deno.test("reconcileLabelColoursForRepo - reports each change with its before and after colour", async () => {
  const { runner } = mockGh({
    "org/repo": [{ name: "security", color: "ededed" }],
  });

  const result = await reconcileLabelColoursForRepo("org/repo", {
    runCommand: runner,
  });

  assertEquals(result.changes.length, 1);
  assertEquals(result.changes[0]!.label, "security");
  assertEquals(result.changes[0]!.from, "ededed");
  assertEquals(result.changes[0]!.to, "b60205");
  assertEquals(result.changes[0]!.applied, true);
});

Deno.test("reconcileLabelColoursForRepo - leaves an already-canonical label alone", async () => {
  const { runner, state } = mockGh({
    "org/repo": [{ name: "severity:high", color: "d93f0b" }],
  });

  const result = await reconcileLabelColoursForRepo("org/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  assertEquals(result.inspected, 1);
  assertEquals(result.drifted, 0);
  assertEquals(result.changed, 0);
  assertEquals(state.edited.length, 0);
});

Deno.test("reconcileLabelColoursForRepo - casing alone is not drift (B60205 == b60205)", async () => {
  const { runner, state } = mockGh({
    "org/repo": [
      { name: "severity:critical", color: "B60205" },
      { name: "SEVERITY:HIGH", color: "D93F0B" },
    ],
  });

  const result = await reconcileLabelColoursForRepo("org/repo", {
    runCommand: runner,
  });

  assertEquals(result.inspected, 2);
  assertEquals(result.changed, 0);
  assertEquals(state.edited.length, 0);
});

// ── Human labels are never touched ──────────────────────────────────────

Deno.test("reconcileLabelColoursForRepo - never touches a label the table does not name", async () => {
  const { runner, state } = mockGh({
    "org/repo": [
      { name: "scenario-count-low", color: "b60205" },
      { name: "Project", color: "e6be15" },
      { name: "severity:low", color: "ededed" },
    ],
  });

  const result = await reconcileLabelColoursForRepo("org/repo", {
    runCommand: runner,
  });

  assertEquals(result.inspected, 1);
  assertEquals(state.edited.map((e) => e.label), ["severity:low"]);
});

Deno.test("reconcileLabelColoursForRepo - never creates a label that is absent from the repo", async () => {
  const { runner, state } = mockGh({ "org/repo": [] });

  const result = await reconcileLabelColoursForRepo("org/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, true);
  assertEquals(result.inspected, 0);
  assertEquals(result.changed, 0);
  assertEquals(state.edited.length, 0);
});

// ── Dry run ─────────────────────────────────────────────────────────────

Deno.test("reconcileLabelColoursForRepo - dry run reports drift without editing", async () => {
  const { runner, state } = mockGh({
    "org/repo": [{ name: "severity:critical", color: "ededed" }],
  });

  const result = await reconcileLabelColoursForRepo("org/repo", {
    runCommand: runner,
    dryRun: true,
  });

  assertEquals(result.ok, true);
  assertEquals(result.dryRun, true);
  assertEquals(result.drifted, 1);
  assertEquals(result.changed, 0);
  assertEquals(result.changes[0]!.applied, false);
  assertEquals(state.edited.length, 0);
});

// ── Fail loud ───────────────────────────────────────────────────────────

Deno.test("reconcileLabelColoursForRepo - an unreadable label list fails loud, not as a clean zero", async () => {
  const { runner } = mockGh({}, { failList: ["org/repo"] });

  const result = await reconcileLabelColoursForRepo("org/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, false);
  assertEquals(result.failures, 1);
  assertStringIncludes(result.error ?? "", "404");
});

Deno.test("reconcileLabelColoursForRepo - unparseable label list output fails loud", async () => {
  const runner = () =>
    Promise.resolve({ success: true, stdout: "not json", stderr: "" });

  const result = await reconcileLabelColoursForRepo("org/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, false);
  assertEquals(result.failures, 1);
});

Deno.test("reconcileLabelColoursForRepo - a failed edit is counted, not swallowed", async () => {
  const { runner } = mockGh({
    "org/repo": [
      { name: "severity:critical", color: "ededed" },
      { name: "severity:low", color: "ededed" },
    ],
  }, { failEdits: ["severity:critical"] });

  const result = await reconcileLabelColoursForRepo("org/repo", {
    runCommand: runner,
  });

  assertEquals(result.ok, false);
  assertEquals(result.failures, 1);
  assertEquals(result.changed, 1);
  const failed = result.changes.find((c) => c.label === "severity:critical")!;
  assertEquals(failed.applied, false);
  assertStringIncludes(failed.error ?? "", "403");
});

// ── Fleet sweep ─────────────────────────────────────────────────────────

Deno.test("reconcileLabelColoursForAllRepos - one result per repo, drift fixed independently", async () => {
  const { runner, state } = mockGh({
    "org/one": [{ name: "security", color: "ededed" }],
    "org/two": [{ name: "security", color: "b60205" }],
  });

  const results = await reconcileLabelColoursForAllRepos(
    ["org/one", "org/two"],
    { runCommand: runner },
  );

  assertEquals(results.length, 2);
  assertEquals(results[0]!.changed, 1);
  assertEquals(results[1]!.changed, 0);
  assertEquals(state.edited.map((e) => e.repo), ["org/one"]);
});

Deno.test("reconcileLabelColoursForAllRepos - a failing repo does not stop the sweep", async () => {
  const { runner, state } = mockGh({
    "org/two": [{ name: "security", color: "ededed" }],
  }, { failList: ["org/one"] });

  const results = await reconcileLabelColoursForAllRepos(
    ["org/one", "org/two"],
    { runCommand: runner },
  );

  assertEquals(results.length, 2);
  assertEquals(results[0]!.ok, false);
  assertEquals(results[1]!.changed, 1);
  assertEquals(state.edited.map((e) => e.repo), ["org/two"]);
});

Deno.test("reconcileLabelColoursForAllRepos - skips empty repo entries", async () => {
  const { runner, state } = mockGh({ "org/one": [] });

  const results = await reconcileLabelColoursForAllRepos(
    ["org/one", ""],
    { runCommand: runner },
  );

  assertEquals(results.length, 1);
  assertEquals(state.listed, ["org/one"]);
});
