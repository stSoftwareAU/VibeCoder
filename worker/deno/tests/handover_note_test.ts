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
  HANDOVER_MARKER,
  MAX_PRIOR_ATTEMPTS,
  writeHandoverNote,
} from "../lib/handover_note.ts";
import { handoverFilePath } from "../lib/preserved_wip_branch.ts";
import { classifyStagedPath } from "../lib/pre_commit_safety.ts";
import { fenceUntrustedIssueText } from "../lib/prompt_delimiter.ts";
import { describeWipCause } from "../lib/wip_checkpoint.ts";
import { WIND_DOWN_NOTICE_FILENAME } from "../lib/wind_down_notice.ts";

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

Deno.test("handover note #769 - a fixed, discoverable, committable path", () => {
  // The writer must use the one shared constant: #770 advertises this path in
  // the release comment and #771 reads it into the resuming prompt, so a
  // writer with its own path would write a file nothing looks for.
  assertEquals(handoverFilePath(769), "docs/archive/handover/issue-769.md");
  // Load-bearing: the note is worthless unless it can actually be committed.
  // The `.vibe/…` path the issue sketched is a hidden path — the enforced
  // `.gitignore` never stages it and the pre-commit gate refuses it, so it
  // would have been dropped in silence.
  assertEquals(classifyStagedPath(handoverFilePath(769)), "safe");
  assertEquals(classifyStagedPath(".vibe/handover/issue-769.md"), "violation");
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

Deno.test("describeWipCause #769 - every cause has prose the note can print", () => {
  const causes = [
    "timed-out",
    "killed",
    "external-sigterm",
    "scheduled-release",
  ] as const;
  const phrases = causes.map(describeWipCause);
  for (const phrase of phrases) assert(phrase.length > 0, phrase);
  assertEquals(new Set(phrases).size, causes.length, "each cause reads apart");
});

Deno.test("buildHandoverNote #769 - carries the structure marker a reader can key on", () => {
  assertStringIncludes(buildHandoverNote(FACTS), HANDOVER_MARKER);
});

Deno.test("buildHandoverNote #769 - a long dirty list is truncated and says so", () => {
  const note = buildHandoverNote({
    ...FACTS,
    dirtyFiles: Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`),
  });
  assertStringIncludes(note, "src/file-19.ts");
  assertEquals(note.includes("src/file-20.ts"), false, note);
  assertStringIncludes(note, "and 5 more file(s)");
});

Deno.test("buildHandoverNote #769 - non-portable paths are dropped and counted", () => {
  const note = buildHandoverNote({
    ...FACTS,
    dirtyFiles: ["src/kept.ts", "/tmp/dropped.ts", "~/also-dropped.ts"],
  });
  assertStringIncludes(note, "src/kept.ts");
  assertStringIncludes(note, "2 path(s) were omitted");
});

Deno.test("buildHandoverNote #769 - Liquid tags in interpolated content are defused", () => {
  const note = buildHandoverNote({
    ...FACTS,
    wipCommitSubjects: ["fix: escape {% raw %} and {{ site.url }}"],
  });
  assertEquals(note.includes("{%"), false, note);
  assertEquals(note.includes("{{"), false, note);
  assertStringIncludes(note, "{ % raw %} and { { site.url }}");
});

Deno.test("buildHandoverNote #769 - a host path inside a commit subject is stripped", () => {
  const note = buildHandoverNote({
    ...FACTS,
    wipCommitSubjects: [
      "fix: read /home/vibe/auto-issue-work/VibeCoder/worker/deno/x.ts",
      "chore: tidy C:\\Users\\vibe\\repo\\y.ts",
    ],
  });
  assertEquals(note.includes("/home/"), false, note);
  assertEquals(note.includes("C:\\"), false, note);
  assertStringIncludes(note, "<path>");
});

Deno.test("buildHandoverNote #769 - a session id inside a commit subject is stripped", () => {
  const note = buildHandoverNote({
    ...FACTS,
    wipCommitSubjects: [
      "chore: resume 3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      "chore: cache 0123456789abcdef0123456789abcdef",
    ],
  });
  assertEquals(note.includes("3f2504e0-4f89"), false, note);
  assertEquals(note.includes("0123456789abcdef"), false, note);
  assertStringIncludes(note, "<session-id>");
});

Deno.test("buildHandoverNote #769 - an unreadable git state is reported as unknown, never as clean", () => {
  const note = buildHandoverNote({
    ...FACTS,
    dirtyFiles: null,
    wipCommitSubjects: null,
  });
  // The note is a permanent record: "git could not tell us" must never be
  // written down as "the tree was clean" or "no commits were made".
  assertEquals(note.includes("The working tree was clean"), false, note);
  assertEquals(note.includes("No commit was recorded"), false, note);
  assertStringIncludes(note, "could not be inspected");
  assertStringIncludes(note, "commit log could not be read");
  assertStringIncludes(note, "an unknown number of uncommitted file(s)");
});

Deno.test("buildHandoverNote #769 - the attempt line counts only the files the note lists", () => {
  const note = buildHandoverNote({
    ...FACTS,
    dirtyFiles: ["src/kept.ts", "/tmp/dropped.ts", "~/also-dropped.ts"],
  });
  assertStringIncludes(note, "1 uncommitted file(s) preserved");
  assertEquals(note.includes("3 uncommitted file(s)"), false, note);
});

Deno.test("buildHandoverNote #769 - the structure marker survives the untrusted fencing #771 applies", () => {
  const note = buildHandoverNote(FACTS);
  const fenced = fenceUntrustedIssueText(note, "### handover").join("\n");
  // #771 splices the note into a prompt through this fence, which rewrites
  // `<!--`. A marker mangled before its only consumer reads it is not a
  // machine-readable marker.
  assertStringIncludes(fenced, HANDOVER_MARKER);
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
    assertEquals(outcome.path, handoverFilePath(769));
    const written = await Deno.readTextFile(
      `${repoPath}/${handoverFilePath(769)}`,
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
      `${repoPath}/${handoverFilePath(769)}`,
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
      `${repoPath}/${handoverFilePath(769)}`,
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
    await Deno.mkdir(`${repoPath}/docs/archive`, { recursive: true });
    await Deno.writeTextFile(`${repoPath}/docs/archive/handover`, "in the way");
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
      `${repoPath}/${WIND_DOWN_NOTICE_FILENAME}`,
      "# Run budget: 120s remaining — wind down now",
    );
    await writeHandoverNote({
      repoPath,
      facts: { ...FACTS, windDownNoticeDelivered: undefined },
    });
    const written = await Deno.readTextFile(
      `${repoPath}/${handoverFilePath(769)}`,
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
