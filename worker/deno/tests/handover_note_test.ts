/**
 * Tests for the portable handover note (Issue #769).
 *
 * A killed run preserves its code as WIP commits but used to lose its
 * intent: what it did, what it left, and what comes next existed only in
 * the dead session's own transcript, which is host-local and
 * provider-specific. The note is the portable half — a file committed on
 * the claim-locked issue branch that any host and any provider can read.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildHandoverNote,
  extractAttemptLines,
  handoverNotePath,
  MAX_PRIOR_ATTEMPTS,
  writeHandoverNote,
} from "../lib/handover_note.ts";
import { classifyStagedPath } from "../lib/pre_commit_safety.ts";

const FACTS = {
  issueNumber: 769,
  branch: "issue-769-commit-a-portable-handover-file",
  cause: "timed-out" as const,
  elapsedSeconds: 3600,
  interruptedAtIso: "2026-09-02T04:05:06Z",
  dirtyFiles: ["worker/deno/lib/handover_note.ts", "README.md"],
  wipCommitSubjects: ["WIP checkpoint: periodic agent progress snapshot"],
  windDownNoticeDelivered: true,
  priorAttempts: [],
};

Deno.test("handoverNotePath #769 - a fixed, discoverable, committable path", () => {
  assertEquals(handoverNotePath(769), "docs/handover/issue-769.md");
  // The path must survive the pre-commit safety gate (#1758) and git's
  // hidden-file ignore rules — a hidden path could never be committed.
  assertEquals(classifyStagedPath(handoverNotePath(769)), "safe");
  assert(!handoverNotePath(769).startsWith("."));
});

Deno.test("buildHandoverNote #769 - names the cause, branch, what was done and what remains", () => {
  const note = buildHandoverNote(FACTS);
  assertStringIncludes(note, "# Handover — issue #769");
  assertStringIncludes(note, "issue-769-commit-a-portable-handover-file");
  assertStringIncludes(note, "timed out");
  assertStringIncludes(note, "3600s");
  assertStringIncludes(note, "## What was done");
  assertStringIncludes(note, "worker/deno/lib/handover_note.ts");
  assertStringIncludes(
    note,
    "WIP checkpoint: periodic agent progress snapshot",
  );
  assertStringIncludes(note, "## What remains");
  assertStringIncludes(note, "## Known blockers");
  assertStringIncludes(note, "Wind-down notice: delivered");
});

Deno.test("buildHandoverNote #769 - a scheduled release is not described as a timeout", () => {
  const note = buildHandoverNote({ ...FACTS, cause: "scheduled-release" });
  assertStringIncludes(note, "released on schedule");
  assertEquals(note.includes("timed out"), false, note);
});

Deno.test("buildHandoverNote #769 - carries no host paths, session ids or provider identifiers", () => {
  const note = buildHandoverNote({
    ...FACTS,
    // Absolute paths must never survive into the note, whatever the caller
    // hands it: a Codex worker on another host cannot use them.
    dirtyFiles: [
      "worker/deno/lib/handover_note.ts",
      "/home/vibe/auto-issue-work/VibeCoder/worker/deno/lib/leak.ts",
      "C:\\Users\\vibe\\repo\\leak.ts",
    ],
  }).toLowerCase();
  for (
    const forbidden of [
      "/home/",
      "/users/",
      "/tmp/",
      "/var/",
      "c:\\",
      "session id",
      "session_id",
      "sessionid",
      "--resume",
      "claude",
      "codex",
      "gemini",
      "copilot",
      "${workdir}",
      ".claude-sessions",
    ]
  ) {
    assertEquals(
      note.includes(forbidden),
      false,
      `handover note leaked '${forbidden}':\n${note}`,
    );
  }
});

Deno.test("extractAttemptLines #769 - reads back the attempts a note records", () => {
  const first = buildHandoverNote(FACTS);
  const lines = extractAttemptLines(first);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0] ?? "", "2026-09-02T04:05:06Z");
});

Deno.test("extractAttemptLines #769 - reads every attempt line, ignoring other prose", () => {
  const many = [
    "# Handover — issue #769",
    "Some prose that is not an attempt line.",
    "- Branch: `issue-769-something`",
    ...Array.from(
      { length: 10 },
      (_, i) => `- 2026-09-0${(i % 9) + 1}T04:05:06Z — execute timed out`,
    ),
  ].join("\n");
  assertEquals(extractAttemptLines(many).length, 10);
});

Deno.test("writeHandoverNote #769 - writes the note into the clone", async () => {
  const repoPath = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoPath}/.git`);
    const outcome = await writeHandoverNote({
      repoPath,
      facts: FACTS,
    });
    assertEquals(outcome.kind, "written");
    assertEquals(outcome.path, "docs/handover/issue-769.md");
    const written = await Deno.readTextFile(
      `${repoPath}/docs/handover/issue-769.md`,
    );
    assertStringIncludes(written, "# Handover — issue #769");
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("writeHandoverNote #769 - a second interruption rewrites the note and records the prior attempt", async () => {
  const repoPath = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoPath}/.git`);
    await writeHandoverNote({ repoPath, facts: FACTS });
    await writeHandoverNote({
      repoPath,
      facts: {
        ...FACTS,
        cause: "scheduled-release",
        interruptedAtIso: "2026-09-03T09:10:11Z",
        elapsedSeconds: 1800,
      },
    });
    const written = await Deno.readTextFile(
      `${repoPath}/docs/handover/issue-769.md`,
    );
    // Rewritten, not appended: one note, one "this attempt" heading.
    assertEquals(written.split("## This attempt").length - 1, 1);
    assertStringIncludes(written, "## Previous attempts");
    assertStringIncludes(written, "2026-09-03T09:10:11Z");
    assertStringIncludes(written, "2026-09-02T04:05:06Z");
    assertEquals(extractAttemptLines(written).length, 2);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("writeHandoverNote #769 - the prior-attempts tail is bounded", async () => {
  const repoPath = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoPath}/.git`);
    for (let i = 1; i <= 6; i++) {
      await writeHandoverNote({
        repoPath,
        facts: {
          ...FACTS,
          interruptedAtIso: `2026-09-0${i}T04:05:06Z`,
        },
      });
    }
    const written = await Deno.readTextFile(
      `${repoPath}/docs/handover/issue-769.md`,
    );
    assertEquals(extractAttemptLines(written).length, MAX_PRIOR_ATTEMPTS + 1);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("writeHandoverNote #769 - a write failure is reported and logged, never thrown", async () => {
  const repoPath = await Deno.makeTempDir();
  const warnings: string[] = [];
  try {
    await Deno.mkdir(`${repoPath}/.git`);
    // A file where the handover directory must go: the write cannot succeed.
    await Deno.mkdir(`${repoPath}/docs`);
    await Deno.writeTextFile(`${repoPath}/docs/handover`, "in the way");
    const outcome = await writeHandoverNote({
      repoPath,
      facts: FACTS,
      logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
    });
    assertEquals(outcome.kind, "failed");
    assert(outcome.reason && outcome.reason.length > 0);
    assert(
      warnings.some((w) => w.toLowerCase().includes("handover")),
      `expected a logged warning, got: ${warnings.join(" | ")}`,
    );
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

Deno.test("writeHandoverNote #769 - a path that is not a clone is skipped, not created", async () => {
  const parent = await Deno.makeTempDir();
  const repoPath = `${parent}/never-cloned`;
  try {
    const outcome = await writeHandoverNote({ repoPath, facts: FACTS });
    assertEquals(outcome.kind, "skipped");
    assertEquals(await exists(repoPath), false);
  } finally {
    await Deno.remove(parent, { recursive: true });
  }
});

Deno.test("writeHandoverNote #769 - records the wind-down notice the run was handed", async () => {
  const repoPath = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${repoPath}/.git`);
    await Deno.writeTextFile(
      `${repoPath}/.vibe-run-budget.md`,
      "# Run budget: 120s remaining — wind down now",
    );
    await writeHandoverNote({
      repoPath,
      facts: { ...FACTS, windDownNoticeDelivered: undefined },
    });
    const written = await Deno.readTextFile(
      `${repoPath}/docs/handover/issue-769.md`,
    );
    assertStringIncludes(written, "Wind-down notice: delivered");
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
});

/** True when `path` exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}
