/**
 * Tests for the idle-task label framework (Issue #1961).
 *
 * Covers:
 *   - `idle-task` appears in LABEL_DEFINITIONS as a workflow label.
 *   - `ensureIdleTaskLabel` creates the label idempotently.
 *   - `isWorkerSelfAppliable` only returns true for `idle-task`.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  getLabelByName,
  LABEL_DEFINITIONS,
} from "../setup/label_definitions.ts";
import {
  ensureIdleTaskLabel,
  labelCacheFilePath,
} from "../lib/label_manager.ts";
import {
  isWorkerSelfAppliable,
  WORKER_SELF_APPLIABLE_LABELS,
} from "../lib/workflow_labels.ts";

async function makeTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "idle-task-test-" });
}

function createMockGh() {
  const calls: string[][] = [];
  const ghCommandFn = async (args: string[]): Promise<string> => {
    calls.push(args);
    const joined = args.join(" ");
    // Cache miss returns empty label list so the helper proceeds to create.
    if (joined.includes("label list")) return "bug\nfeature\n";
    return "";
  };
  return { ghCommandFn, calls };
}

function wasCalledWith(calls: string[][], pattern: string): boolean {
  return calls.some((call) => call.join(" ").includes(pattern));
}

// ─── Label definition ───────────────────────────────────────────────────

Deno.test("idle-task label - appears in LABEL_DEFINITIONS as workflow", () => {
  const label = getLabelByName("idle-task");
  assertEquals(label !== undefined, true, "idle-task must be defined");
  assertEquals(label!.category, "workflow");
  assertEquals(label!.colour, "cccccc");
  assertEquals(
    label!.description,
    "Worker-filed task to run when no claimable work exists. Lowest priority.",
  );
});

Deno.test("idle-task label - is exactly one entry in LABEL_DEFINITIONS", () => {
  const matches = LABEL_DEFINITIONS.filter((l) => l.name === "idle-task");
  assertEquals(matches.length, 1);
});

// ─── ensureIdleTaskLabel ────────────────────────────────────────────────

Deno.test("ensureIdleTaskLabel - creates the label when not cached", async () => {
  const dir = await makeTempDir();
  try {
    const { ghCommandFn, calls } = createMockGh();
    const result = await ensureIdleTaskLabel("org/repo", {
      ghCommandFn,
      cacheDir: dir,
    });
    assertEquals(result.ok, true);
    // Should have called the REST API to create the label.
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/labels"),
      true,
    );
    // The label name must be passed.
    assertEquals(
      wasCalledWith(calls, "name=idle-task"),
      true,
    );
    // The canonical colour must come from LABEL_DEFINITIONS.
    assertEquals(wasCalledWith(calls, "color=cccccc"), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("ensureIdleTaskLabel - is a no-op when label already exists", async () => {
  const dir = await makeTempDir();
  try {
    // Pre-populate the cache with idle-task already present.
    const cachePath = labelCacheFilePath(dir, "org/repo");
    const now = Math.floor(Date.now() / 1000);
    await Deno.writeTextFile(cachePath, `${now}\nbug\nidle-task\nfeature\n`);

    const { ghCommandFn, calls } = createMockGh();
    const result = await ensureIdleTaskLabel("org/repo", {
      ghCommandFn,
      cacheDir: dir,
    });
    assertEquals(result.ok, true);
    // Must not have attempted label creation.
    assertEquals(
      wasCalledWith(calls, "api -X POST repos/org/repo/labels"),
      false,
    );
    assertEquals(wasCalledWith(calls, "label create"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ─── isWorkerSelfAppliable ──────────────────────────────────────────────

Deno.test(
  "isWorkerSelfAppliable - returns true only for idle-task (Issue #2077)",
  () => {
    assertEquals(isWorkerSelfAppliable("idle-task"), true);
    // Issue #2077: `idle-task-pending` retired alongside the
    // `requiresApproval` template flag.
    assertEquals(isWorkerSelfAppliable("idle-task-pending"), false);
  },
);

Deno.test("isWorkerSelfAppliable - returns false for every other workflow label", () => {
  for (
    const name of [
      "work-on",
      "planning",
      "question",
      "answered",
      "failed",
      "failed-once",
      "needs-clarification",
      "needs-revision",
      "needs-human",
      "top-priority",
      "refine-issue",
      "grill-me",
      "documentation",
      "low-priority",
      "needs-screenshot",
    ]
  ) {
    assertEquals(
      isWorkerSelfAppliable(name),
      false,
      `'${name}' must NOT be worker-self-appliable`,
    );
  }
});

Deno.test("isWorkerSelfAppliable - returns false for non-workflow labels", () => {
  for (const name of ["bug", "enhancement", "priority-high", "security"]) {
    assertEquals(
      isWorkerSelfAppliable(name),
      false,
      `'${name}' must NOT be worker-self-appliable`,
    );
  }
});

Deno.test(
  "WORKER_SELF_APPLIABLE_LABELS - contains only idle-task (Issue #2077)",
  () => {
    assertEquals(WORKER_SELF_APPLIABLE_LABELS.size, 1);
    assertEquals(WORKER_SELF_APPLIABLE_LABELS.has("idle-task"), true);
    assertEquals(WORKER_SELF_APPLIABLE_LABELS.has("idle-task-pending"), false);
  },
);
