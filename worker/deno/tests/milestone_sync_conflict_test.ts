/**
 * The conflict report a milestone sync merge carries back (Issue #1558).
 *
 * Pure unit tests over the reporting module: what the comment names, how a
 * report is keyed, and what a side whose commit could not be read says.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildConflictEscalationComment,
  conflictDiagnosticTitle,
  describeBranchTips,
  type MilestoneSyncConflict,
  resolveBranchTips,
  UNRESOLVED_SHA,
} from "../lib/milestone_sync_conflict.ts";

const MILESTONE_BRANCH = "milestone/1558-drift";
const MILESTONE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const DEFAULT_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

const CONFLICT: MilestoneSyncConflict = {
  files: ["worker/deno/lib/scan_content.ts"],
  milestoneSha: MILESTONE_SHA,
  defaultSha: DEFAULT_SHA,
  resolution: "theirs",
};

Deno.test(
  "resolveBranchTips - a failed lookup still names the commit it was given (Issue #1558)",
  async () => {
    const tips = await resolveBranchTips(
      "owner/repo",
      [{ branch: "main", sha: DEFAULT_SHA }, { branch: MILESTONE_BRANCH }],
      () => Promise.reject(new Error("gh api: 502")),
    );

    assertEquals(
      tips[0]?.sha,
      DEFAULT_SHA,
      "the caller's SHA is authoritative",
    );
    assertEquals(tips[0]?.subject, "");
    assertEquals(
      tips[1]?.sha,
      "unknown",
      "a side with no SHA and no lookup says so rather than reading as empty",
    );
  },
);

Deno.test(
  "buildConflictEscalationComment - names every conflicting file and both sides (Issue #1558)",
  () => {
    const body = buildConflictEscalationComment({
      repo: "owner/repo",
      milestoneBranch: MILESTONE_BRANCH,
      defaultBranch: "main",
      conflict: { ...CONFLICT, files: ["a.ts", "b.ts"], resolution: "manual" },
      tips: [
        { branch: "main", sha: DEFAULT_SHA, subject: "Issue #1227: scan" },
        { branch: MILESTONE_BRANCH, sha: MILESTONE_SHA, subject: "" },
      ],
    });

    assertStringIncludes(body, "`a.ts`");
    assertStringIncludes(body, "`b.ts`");
    assertStringIncludes(body, "Issue #1227: scan");
    assertStringIncludes(body, MILESTONE_SHA);
    assertStringIncludes(body, "was pushed");
  },
);

Deno.test(
  "conflictDiagnosticTitle - keyed on the branch and the conflicting commit (Issue #1558)",
  () => {
    const first = conflictDiagnosticTitle(MILESTONE_BRANCH, DEFAULT_SHA);
    assertStringIncludes(first, MILESTONE_BRANCH);
    assertStringIncludes(first, DEFAULT_SHA.slice(0, 8));
    assert(
      first !== conflictDiagnosticTitle(MILESTONE_BRANCH, "c".repeat(40)),
      "a different conflicting commit is a different report",
    );
  },
);

Deno.test(
  "buildConflictEscalationComment - a conflict git could not name still says so (Issue #1558)",
  () => {
    const body = buildConflictEscalationComment({
      repo: "owner/repo",
      milestoneBranch: MILESTONE_BRANCH,
      defaultBranch: "main",
      conflict: { ...CONFLICT, files: [] },
      tips: [],
    });

    assertStringIncludes(body, "git named no conflicting files");
  },
);

Deno.test(
  "resolveBranchTips - a failed lookup is logged, not swallowed (Issue #1558)",
  async () => {
    const logs: string[] = [];
    const tips = await resolveBranchTips(
      "owner/repo",
      [{ branch: MILESTONE_BRANCH }],
      () => Promise.reject(new Error("gh api: 502")),
      (message) => logs.push(message),
    );

    assertEquals(tips[0]?.sha, UNRESOLVED_SHA);
    assertEquals(logs.length, 1, "a degraded report says why it is degraded");
    assertStringIncludes(logs[0]!, "502");
  },
);

Deno.test(
  "describeBranchTips - names each side, with or without a subject (Issue #1558)",
  () => {
    const section = describeBranchTips([
      { branch: "main", sha: DEFAULT_SHA, subject: "Issue #1227: scan" },
      { branch: MILESTONE_BRANCH, sha: UNRESOLVED_SHA, subject: "" },
    ]);

    assertStringIncludes(section, "Both sides at the time of the merge");
    assertStringIncludes(section, `\`main\` — \`${DEFAULT_SHA}\``);
    assertStringIncludes(section, "Issue #1227: scan");
    assertStringIncludes(section, `\`${MILESTONE_BRANCH}\` — \`unknown\``);
  },
);

Deno.test(
  "conflictDiagnosticTitle - an unreadable commit still yields a stable title (Issue #1558)",
  () => {
    assertStringIncludes(
      conflictDiagnosticTitle(MILESTONE_BRANCH, ""),
      UNRESOLVED_SHA,
    );
  },
);

Deno.test(
  "buildConflictEscalationComment - an automatic resolution reports what it decided, not what to check (Issue #1559)",
  () => {
    const body = buildConflictEscalationComment({
      repo: "owner/repo",
      milestoneBranch: MILESTONE_BRANCH,
      defaultBranch: "main",
      conflict: {
        ...CONFLICT,
        resolution: "auto",
        decisions: [
          {
            path: "worker/deno/lib/scan_content.ts",
            case: "superset",
            action: "theirs",
            reason: "the default branch's side keeps every line of the other",
          },
          {
            path: "worker/deno/tests/scan_content_test.ts",
            case: "test-union",
            action: "union",
            reason: "both sides' hunks are kept",
          },
        ],
      },
      tips: [{ branch: "main", sha: DEFAULT_SHA, subject: "" }],
    });

    assertStringIncludes(body, "resolved a conflict automatically");
    assertStringIncludes(body, "worker/deno/lib/scan_content.ts");
    assertStringIncludes(body, "superset");
    assertStringIncludes(body, "kept both sides' hunks");
    assert(
      !body.includes("check what was overwritten"),
      "a verified resolution is a report, not a warning to go and check",
    );
  },
);

Deno.test(
  "buildConflictEscalationComment - an automatic resolution with no recorded decision still says so (Issue #1559)",
  () => {
    const body = buildConflictEscalationComment({
      repo: "owner/repo",
      milestoneBranch: MILESTONE_BRANCH,
      defaultBranch: "main",
      conflict: { ...CONFLICT, resolution: "auto" },
      tips: [],
    });

    assertStringIncludes(body, "no decision was recorded");
  },
);
