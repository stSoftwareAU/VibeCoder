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
  RUN_FAILURE_TARGET_REPO,
  type RunFailureReport,
} from "../lib/run_failure_issue.ts";
import { CI_FAILURE_EXCERPT_BYTES } from "../lib/ci_failure_issue.ts";
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
    issues?: { number: number; body: string }[];
    comments?: { id: number; body: string }[];
  } = {},
  behaviour: { failAll?: boolean } = {},
) {
  const rec: Recorded = { calls: [], creates: [], comments: [], patches: [] };
  const issues = [...(seed.issues ?? [])];
  const comments = [...(seed.comments ?? [])];
  const ghFn = (args: string[]): Promise<string> => {
    rec.calls.push(args);
    if (behaviour.failAll) return Promise.reject(new Error("gh: HTTP 500"));
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve(
        JSON.stringify(
          issues.map((i) => ({ ...i, author: { login: FLEET_LOGIN } })),
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

Deno.test("run failure issue - not_code_fixable (usage limit) and unknown (timeout) → zero writes (Issue #4329)", async () => {
  const dir = await tmp();
  try {
    const { ghFn, rec } = fakeGh();
    const limit = await fileRunFailureIssue({
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
