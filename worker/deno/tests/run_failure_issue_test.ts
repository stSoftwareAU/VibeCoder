/**
 * Tests for auto-filing deduped run-failure issues (Issue #4329, part of
 * #4291). Every test asserts against a recorded gh call log so both "did
 * not file" and "filed twice" are caught.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  fileRunFailureIssue,
  formatRunFailureFollowUpMarker,
  formatRunFailureMarker,
  isRunFailureIssue,
  parseRunFailureFollowUpMarker,
  parseRunFailureMarker,
  RUN_FAILURE_FAMILY_ID,
  RUN_FAILURE_TARGET_REPO,
  type RunFailureReport,
} from "../lib/run_failure_issue.ts";
import { CI_FAILURE_EXCERPT_BYTES } from "../lib/ci_failure_issue.ts";
import type { SelfDiagnosticFiling } from "../lib/self_diagnostic_attestation.ts";
import { formatRunFailureExcerpt } from "../lib/run_failure_issue.ts";

/**
 * The fleet account these fixtures file as. A dedup match is only evidence
 * the alert already exists when a fleet account authored it, so every seeded
 * and created issue carries an author and every call states the fleet.
 */
const FLEET_LOGIN = "vibe-coder-bot";
const FLEET: readonly string[] = [FLEET_LOGIN];

interface Recorded {
  calls: string[][];
  creates: string[][];
  comments: string[][];
  patches: string[][];
}

/** A fake gh: open issues and their comments live in memory. */
function fakeGh(
  seed: {
    issues?: { number: number; body: string; author?: string }[];
    comments?: { id: number; body: string; author?: string }[];
  } = {},
  behaviour: { failAll?: boolean; visibility?: string } = {},
) {
  const rec: Recorded = { calls: [], creates: [], comments: [], patches: [] };
  const issues = [...(seed.issues ?? [])];
  // The production `--jq` projection asks for the commenter (Issue #1216),
  // so the fake renders it too; an unstated author is the fleet's own.
  const comments = [...(seed.comments ?? [])].map((c) => ({
    author: FLEET_LOGIN,
    ...c,
  }));
  const ghFn = (args: string[]): Promise<string> => {
    rec.calls.push(args);
    if (behaviour.failAll) return Promise.reject(new Error("gh: HTTP 500"));
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(
        JSON.stringify(
          issues.map((i) => ({
            ...i,
            author: { login: i.author ?? FLEET_LOGIN },
          })),
        ),
      );
    }
    if (args[0] === "issue" && args[1] === "create") {
      rec.creates.push(args);
      const n = 9000 + rec.creates.length;
      issues.push({ number: n, body: args[args.indexOf("--body") + 1]! });
      return Promise.resolve(
        `https://github.com/${RUN_FAILURE_TARGET_REPO}/issues/${n}\n`,
      );
    }
    if (args[0] === "issue" && args[1] === "comment") {
      rec.comments.push(args);
      comments.push({
        id: 500 + rec.comments.length,
        body: args[args.indexOf("--body") + 1]!,
        author: FLEET_LOGIN,
      });
      return Promise.resolve("");
    }
    if (args[0] === "api" && args[1]?.endsWith("/comments")) {
      return Promise.resolve(JSON.stringify(comments));
    }
    if (args[0] === "api" && args.includes("PATCH")) {
      rec.patches.push(args);
      return Promise.resolve("{}");
    }
    // Source visibility (Issue #4318). Default public so existing filings
    // still name the source; a test opts into private or a failed lookup.
    if (
      args[0] === "api" && args[1]?.startsWith("repos/") &&
      args.includes(".visibility")
    ) {
      const visibility = behaviour.visibility ?? "public";
      if (visibility === "fail") {
        return Promise.reject(new Error("visibility lookup failed"));
      }
      return Promise.resolve(visibility);
    }
    return Promise.resolve("");
  };
  return { ghFn, rec, issues, comments };
}

const OOM_REPORT: RunFailureReport = {
  sourceRepo: "stSoftwareAU/private-repo-6",
  sourceIssueNumber: 147,
  machineId: "vibe-coder-50110-0f8e2a1b-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
  releaseCommentUrl:
    "https://github.com/stSoftwareAU/private-repo-6/issues/147#issuecomment-1",
  outcome: {
    kind: "no_pr",
    category: "killed",
    phase: "execute",
    elapsedSeconds: 539,
    message:
      "Claude was killed (exit 137, SIGKILL — possible out-of-memory in the VM) without creating changes",
  },
};

async function tmp(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "run-failure-issue-" });
}

Deno.test("run failure issue - code_fixable + no existing issue → exactly one issue create in stSoftwareAU/VibeCoder whose body carries the class marker (Issue #4329)", async () => {
  const dir = await tmp();
  try {
    const { ghFn, rec } = fakeGh();
    const decision = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: OOM_REPORT,
      ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1_700_000_000,
    });
    assertEquals(decision.action, "filed");
    assertEquals(rec.creates.length, 1);
    assertEquals(rec.comments.length, 0);
    const create = rec.creates[0]!;
    assertEquals(create[create.indexOf("--repo") + 1], RUN_FAILURE_TARGET_REPO);
    const body = create[create.indexOf("--body") + 1]!;
    assert(body.startsWith(formatRunFailureMarker("oom")), body);
    assertEquals(parseRunFailureMarker(body), "oom");
    assert(isRunFailureIssue(body, "oom"));
    assert(!isRunFailureIssue(body, "disk-full"));
    // The source repo and issue are named, the target is not the source.
    assert(body.includes("stSoftwareAU/private-repo-6#147"), body);
    assert(body.includes(OOM_REPORT.releaseCommentUrl!));
    assert(body.includes("`execute` after 539s"));
    assertEquals(
      create[create.indexOf("--title") + 1],
      "fix(worker): oom — runs releasing with no PR",
    );
    assertEquals(create[create.indexOf("--label") + 1], "bug");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - code_fixable + existing open issue for the class → zero creates, exactly one follow-up comment (Issue #4329)", async () => {
  const dir = await tmp();
  try {
    const { ghFn, rec } = fakeGh({
      issues: [{
        number: 4200,
        body: `${formatRunFailureMarker("oom")}\n\nolder`,
      }],
    });
    const decision = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: OOM_REPORT,
      ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1_700_000_000,
    });
    assertEquals(decision, {
      action: "commented",
      issueNumber: 4200,
      failureClass: "oom",
      updated: false,
    });
    assertEquals(rec.creates.length, 0);
    assertEquals(rec.comments.length, 1);
    const body = rec.comments[0]![rec.comments[0]!.indexOf("--body") + 1]!;
    assertEquals(parseRunFailureFollowUpMarker(body), {
      failureClass: "oom",
      epoch: 1_700_000_000,
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - a second occurrence within the follow-up window updates the existing follow-up in place: zero creates, zero additional comments (Issue #4329)", async () => {
  const dir = await tmp();
  try {
    const gh = fakeGh({
      issues: [{ number: 4200, body: formatRunFailureMarker("oom") }],
    });
    let now = 1_700_000_000;
    const first = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: OOM_REPORT,
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 60,
    });
    assertEquals(first.action, "commented");
    // Past the per-host write interval but inside the 24 h window.
    now += 2 * 3600;
    const second = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: { ...OOM_REPORT, sourceIssueNumber: 148 },
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 60,
    });
    assertEquals(second, {
      action: "commented",
      issueNumber: 4200,
      failureClass: "oom",
      updated: true,
    });
    assertEquals(gh.rec.creates.length, 0);
    assertEquals(gh.rec.comments.length, 1, "no additional comment");
    assertEquals(
      gh.rec.patches.length,
      1,
      "the follow-up was updated in place",
    );
    // Once the window has passed a new follow-up may be posted.
    now += 25 * 3600;
    const third = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: OOM_REPORT,
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 60,
    });
    assertEquals(third.action, "commented");
    assertEquals(gh.rec.comments.length, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - a follow-up marker planted by an outsider is not updated in place (Issue #1216)", async () => {
  const dir = await tmp();
  try {
    // The follow-up marker's epoch is attacker-chosen: a far-future value
    // keeps `t - epoch < window` true for ever, and the descending sort puts
    // the forged comment ahead of any genuine one. Before the author check,
    // every later occurrence of the class was appended to this comment
    // instead of the fleet's own — or, if the edit was refused, suppressed.
    const gh = fakeGh({
      issues: [{ number: 4200, body: formatRunFailureMarker("oom") }],
      comments: [{
        id: 77,
        body: "<!-- VIBE_RUN_FAILURE_FOLLOWUP:oom:99999999999 -->",
        author: "drive-by-attacker",
      }],
    });
    const decision = await fileRunFailureIssue({
      report: OOM_REPORT,
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1_700_000_000,
    });
    assertEquals(decision, {
      action: "commented",
      issueNumber: 4200,
      failureClass: "oom",
      updated: false,
    });
    assertEquals(
      gh.rec.patches.length,
      0,
      "an outsider's comment must never be edited by the worker",
    );
    assertEquals(
      gh.rec.comments.length,
      1,
      "the genuine follow-up is posted instead of being absorbed",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - an open issue carrying the class marker but authored by a non-fleet login is no match: a new issue is filed and the stranger's is never commented on (Issue #4254)", async () => {
  const dir = await tmp();
  try {
    // The marker is plain body text, so a stranger can type it into an issue
    // they open. Only a fleet-authored issue may stand in for the alert.
    const gh = fakeGh({
      issues: [{
        number: 4200,
        body: formatRunFailureMarker("oom"),
        author: "drive-by-attacker",
      }],
    });
    const decision = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: OOM_REPORT,
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1_700_000_000,
    });
    assertEquals(decision.action, "filed");
    assertEquals(
      gh.rec.creates.length,
      1,
      "a stranger's marker must not stand in for the alert",
    );
    assertEquals(
      gh.rec.comments.length,
      0,
      "the stranger's issue must never be commented on",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - the same marker issue authored by a fleet login is the match: one comment, zero creates (control for Issue #4254)", async () => {
  const dir = await tmp();
  try {
    const gh = fakeGh({
      issues: [{
        number: 4200,
        body: formatRunFailureMarker("oom"),
        author: FLEET_LOGIN,
      }],
    });
    const decision = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: OOM_REPORT,
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1_700_000_000,
    });
    assertEquals(decision, {
      action: "commented",
      issueNumber: 4200,
      failureClass: "oom",
      updated: false,
    });
    assertEquals(gh.rec.creates.length, 0);
    assertEquals(gh.rec.comments.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - not_code_fixable (usage limit) and unknown (timeout) → zero writes (Issue #4329)", async () => {
  const dir = await tmp();
  try {
    const { ghFn, rec } = fakeGh();
    const limit = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: {
        ...OOM_REPORT,
        outcome: {
          kind: "no_pr",
          category: "rate_limit",
          phase: "execute",
          elapsedSeconds: 12,
          message: "Claude usage limit reached (subscription window)",
        },
      },
      ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1,
    });
    assertEquals(limit, {
      action: "suppressed",
      reason: "not_code_fixable",
      failureClass: "usage-limit",
    });
    const timeout = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: {
        ...OOM_REPORT,
        outcome: {
          kind: "no_pr",
          category: "timeout",
          phase: "execute",
          elapsedSeconds: 3600,
          message: "Claude timed out after 3600s",
        },
      },
      ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1,
    });
    assertEquals(timeout, {
      action: "suppressed",
      reason: "unknown",
      failureClass: "timeout",
    });
    assertEquals(rec.calls.length, 0, "no GitHub call of any kind");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - a run on a different monitored repo still files into stSoftwareAU/VibeCoder, naming the source (Issue #4329)", async () => {
  const dir = await tmp();
  try {
    const { ghFn, rec } = fakeGh();
    await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: {
        ...OOM_REPORT,
        sourceRepo: "stSoftwareAU/private-repo-21",
        sourceIssueNumber: 61,
        outcome: {
          kind: "no_pr",
          category: "internal_error",
          phase: "quality_gate",
          elapsedSeconds: 88,
          message: "Error: ENOSPC: no space left on device, write",
        },
      },
      ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1,
    });
    const create = rec.creates[0]!;
    assertEquals(
      create[create.indexOf("--repo") + 1],
      "stSoftwareAU/VibeCoder",
    );
    const body = create[create.indexOf("--body") + 1]!;
    assert(body.includes("stSoftwareAU/private-repo-21#61"));
    assertEquals(parseRunFailureMarker(body), "disk-full");
    assertEquals(create[create.indexOf("--label") + 1], "enhancement");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - every GitHub call failing → resolves suppressed:gh_failed, never throws, so the release completes (Issue #4329)", async () => {
  const dir = await tmp();
  try {
    const { ghFn } = fakeGh({}, { failAll: true });
    let releaseCompleted = false;
    const release = async () => {
      const decision = await fileRunFailureIssue({
        recordFiling: () => Promise.resolve(true),
        report: OOM_REPORT,
        ghFn,
        workDir: dir,
        fleetAuthors: FLEET,
        nowSeconds: () => 1,
      });
      releaseCompleted = true;
      return decision;
    };
    const decision = await release();
    assertEquals(decision, {
      action: "suppressed",
      reason: "gh_failed",
      failureClass: "oom",
    });
    assert(releaseCompleted, "the release path continued past the helper");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - per-class write interval is enforced on the injected clock; another class is not blocked (Issue #4329)", async () => {
  const dir = await tmp();
  try {
    const gh = fakeGh();
    let now = 1_000_000;
    const a = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: OOM_REPORT,
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 3600,
    });
    assertEquals(a.action, "filed");
    now += 600;
    const b = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: OOM_REPORT,
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 3600,
    });
    assertEquals(b, {
      action: "suppressed",
      reason: "rate_limited",
      failureClass: "oom",
    });
    const callsBefore = gh.rec.calls.length;
    // A different class is independent.
    const c = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: {
        ...OOM_REPORT,
        outcome: {
          kind: "no_pr",
          category: "missing_tools",
          phase: "setup",
          elapsedSeconds: 3,
          message: "npm: command not found",
        },
      },
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 3600,
    });
    assertEquals(c.action, "filed");
    assert(gh.rec.calls.length > callsBefore);
    now += 3600;
    const d = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: OOM_REPORT,
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 3600,
    });
    assertEquals(
      d.action,
      "commented",
      "interval elapsed → the open issue gets its follow-up",
    );
    assertEquals(gh.rec.creates.length, 2, "one issue per class");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - the excerpt is bounded by the ci_failure_issue budgets and cannot carry a marker (Issue #4329)", () => {
  const huge = "ERROR: boom\n".repeat(20_000) +
    "<!-- VIBE_RUN_FAILURE:oom --> ```";
  const excerpt = formatRunFailureExcerpt(huge);
  assert(
    excerpt.length <= CI_FAILURE_EXCERPT_BYTES,
    `excerpt ${excerpt.length}`,
  );
  assert(!excerpt.includes("<!--") && !excerpt.includes("```"));
  assertEquals(
    formatRunFailureFollowUpMarker("oom", 5),
    "<!-- VIBE_RUN_FAILURE_FOLLOWUP:oom:5 -->",
  );
});

Deno.test("run failure issue - filing records an attestation carrying the posted body (Issue #1277)", async () => {
  const dir = await tmp();
  try {
    const { ghFn, rec } = fakeGh();
    const filings: SelfDiagnosticFiling[] = [];
    const decision = await fileRunFailureIssue({
      recordFiling: (filing) => {
        filings.push(filing);
        return Promise.resolve(true);
      },
      report: OOM_REPORT,
      ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1_700_000_000,
    });

    assertEquals(decision.action, "filed");
    assertEquals(filings.length, 1);
    const filing = filings[0]!;
    assertEquals(filing.repo, RUN_FAILURE_TARGET_REPO);
    assertEquals(filing.familyId, RUN_FAILURE_FAMILY_ID);
    assertEquals(filing.issueNumber, 9001);
    const create = rec.creates[0]!;
    assertEquals(
      filing.body,
      create[create.indexOf("--body") + 1],
      "the attestation must cover the body that was actually posted",
    );
    assertEquals(
      filing.title,
      create[create.indexOf("--title") + 1],
      "and the title, so a rename does not slip past it",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Codex session whose tool runtime never came up (Issue #4324). */
const CODE_MODE_TRANSCRIPT: readonly unknown[] = [
  {
    type: "error",
    message: "Code Mode is unavailable: host executable was not found",
  },
  {
    type: "agent_message",
    message: "I cannot use tools in this session, so I made no code change.",
  },
];

Deno.test("run failure issue - a Code Mode unavailable transcript files one VIBE_RUN_FAILURE issue and does not relabel the source (Issue #4324)", async () => {
  const dir = await tmp();
  try {
    const sourceRepo = "stSoftwareAU/GRQ";
    const { ghFn, rec } = fakeGh();
    const decision = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: {
        sourceRepo,
        sourceIssueNumber: 23,
        machineId: "vibe-coder-23",
        transcript: CODE_MODE_TRANSCRIPT,
        outcome: {
          kind: "no_pr",
          category: "no_changes",
          phase: "execute",
          elapsedSeconds: 77,
          message: "Completed without making any changes",
        },
      },
      ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1_700_000_000,
    });
    assertEquals(decision.action, "filed");
    if (decision.action !== "filed") return;
    assertEquals(decision.failureClass, "tool-runtime");
    assertEquals(rec.creates.length, 1);
    assertEquals(rec.comments.length, 0);
    const create = rec.creates[0]!;
    assertEquals(create[create.indexOf("--repo") + 1], RUN_FAILURE_TARGET_REPO);
    const body = create[create.indexOf("--body") + 1]!;
    assert(body.startsWith(formatRunFailureMarker("tool-runtime")), body);
    assertEquals(create[create.indexOf("--label") + 1], "bug");
    // The source issue's labels are untouched: no failed-once, no label edit.
    const sourceLabelWrites = rec.calls.filter((args) =>
      args.includes(sourceRepo) &&
      (args.includes("failed-once") || args.includes("edit") ||
        args.includes("--add-label"))
    );
    assertEquals(sourceLabelWrites, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - an ordinary no-change run, where tools worked, is not filed (Issue #4324)", async () => {
  const dir = await tmp();
  try {
    const { ghFn, rec } = fakeGh();
    const decision = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: {
        sourceRepo: "stSoftwareAU/GRQ",
        sourceIssueNumber: 24,
        machineId: "vibe-coder-23",
        transcript: [
          { type: "function_call", name: "shell", status: "completed" },
          { type: "agent_message", message: "No code change was required." },
        ],
        outcome: {
          kind: "no_pr",
          category: "no_changes",
          phase: "execute",
          elapsedSeconds: 600,
          message: "Completed without making any changes",
        },
      },
      ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => 1,
    });
    assertEquals(decision, {
      action: "suppressed",
      reason: "not_code_fixable",
      failureClass: "agent-outcome",
    });
    assertEquals(rec.creates.length, 0);
    assertEquals(rec.calls.length, 0, "no GitHub call of any kind");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A string that must never reach a public issue from a private source. */
const PRIVATE_MESSAGE = "zephyr-991 the private agent said this exact sentence";
const PRIVATE_REPO = "acme/secret-fleet-repo";
const PRIVATE_URL =
  "https://github.com/acme/secret-fleet-repo/issues/42#issuecomment-99";

function privateReport(): RunFailureReport {
  return {
    sourceRepo: PRIVATE_REPO,
    sourceIssueNumber: 42,
    machineId: "host-4318",
    releaseCommentUrl: PRIVATE_URL,
    outcome: {
      kind: "no_pr",
      category: "killed",
      phase: "execute",
      elapsedSeconds: 77,
      message: PRIVATE_MESSAGE,
      classification: {
        fixability: "code_fixable",
        failureClass: "oom",
        rationale:
          "The run was killed (SIGKILL) with out-of-memory evidence in the message.",
      },
    },
  };
}

function postedText(args: string[]): string {
  const index = args.indexOf("--body");
  return index === -1 ? "" : args[index + 1] ?? "";
}

Deno.test("run failure issue - a private source omits the repo, the release comment and the excerpt from the body and the follow-up (Issue #4318)", async () => {
  const dir = await tmp();
  try {
    const gh = fakeGh({}, { visibility: "private" });
    let now = 1_700_000_000;
    const filed = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: privateReport(),
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 0,
    });
    assertEquals(filed.action, "filed");
    const body = postedText(gh.rec.creates[0]!);
    assert(body.includes("**Failure class:** `oom`"), body);
    assert(body.includes("**Category:**"), body);
    assert(body.includes("`execute` after 77s"), body);
    assert(body.includes("`host-4318`"), body);
    assert(!body.includes(PRIVATE_REPO), body);
    assert(!body.includes(PRIVATE_MESSAGE), body);
    assert(!body.includes(PRIVATE_URL), body);
    assert(!body.includes("**Source:**"), body);
    assert(!body.includes("**Release comment:**"), body);
    assert(!body.includes("## Failure message"), body);

    now += 60;
    const commented = await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: privateReport(),
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 0,
    });
    assertEquals(commented.action, "commented");
    const comment = postedText(gh.rec.comments[0]!);
    assert(comment.includes("`host-4318`"), comment);
    assert(comment.includes("`execute`"), comment);
    assert(comment.includes("77s"), comment);
    assert(!comment.includes(PRIVATE_REPO), comment);
    assert(!comment.includes(PRIVATE_MESSAGE), comment);
    assert(!comment.includes(PRIVATE_URL), comment);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("run failure issue - unknown source visibility is treated as private (Issue #4318)", async () => {
  for (const visibility of ["fail", "internal", ""]) {
    const dir = await tmp();
    try {
      const { ghFn, rec } = fakeGh({}, { visibility });
      const decision = await fileRunFailureIssue({
        recordFiling: () => Promise.resolve(true),
        report: privateReport(),
        ghFn,
        workDir: dir,
        fleetAuthors: FLEET,
        nowSeconds: () => 1_700_000_000,
      });
      assertEquals(decision.action, "filed", visibility);
      const body = postedText(rec.creates[0]!);
      assert(!body.includes(PRIVATE_REPO), `${visibility}: ${body}`);
      assert(!body.includes(PRIVATE_MESSAGE), visibility);
      assert(!body.includes(PRIVATE_URL), visibility);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("run failure issue - a public source still names the repo, the release comment and the excerpt (Issue #4318)", async () => {
  const dir = await tmp();
  try {
    const gh = fakeGh({}, { visibility: "public" });
    let now = 1_700_000_000;
    await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: privateReport(),
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 0,
    });
    const body = postedText(gh.rec.creates[0]!);
    assert(body.includes(`${PRIVATE_REPO}#42`), body);
    assert(body.includes(PRIVATE_URL), body);
    assert(body.includes(PRIVATE_MESSAGE), body);

    now += 60;
    await fileRunFailureIssue({
      recordFiling: () => Promise.resolve(true),
      report: privateReport(),
      ghFn: gh.ghFn,
      workDir: dir,
      fleetAuthors: FLEET,
      nowSeconds: () => now,
      minWriteIntervalSeconds: 0,
    });
    const comment = postedText(gh.rec.comments[0]!);
    assert(comment.includes(`${PRIVATE_REPO}#42`), comment);
    assert(comment.includes("`host-4318`"), comment);
    assert(comment.includes("`execute`"), comment);
    assert(comment.includes("77s"), comment);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
