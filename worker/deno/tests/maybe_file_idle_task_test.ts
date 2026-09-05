/**
 * Tests for the `maybe-file-idle-task` Deno command (Issue #1963).
 *
 * Covers:
 *   - happy path — when no claimable work and no matching idle-task issue
 *     is open, the command files a new issue with the `idle-task` label
 *     and exits 0;
 *   - dedup hit — when a matching open issue exists, the command logs
 *     `action=skipped reason=duplicate` and exits 0 without filing;
 *   - no `work_available` short-circuit (Issue #2026) — the broken
 *     re-check that caused the filer to skip every cycle has been
 *     removed; the test asserts the filer no longer short-circuits;
 *   - gh-create failure — when `gh issue create` fails the command
 *     surfaces `success: false` and logs an error line.
 *
 * The tests inject all dependencies via the `__testDeps` escape hatch so
 * they never touch the network. A purpose-built test template is
 * registered into the live registry so the tests do not depend on the
 * production `security-scan` template's prose.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  defaultPickTemplate,
  maybeFileIdleTaskCommand,
  weightedPickTemplate,
} from "../commands/maybe_file_idle_task.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import {
  getTemplate,
  type IdleTaskTemplate,
  registerTemplate,
} from "../lib/idle_task_template.ts";
import type { ExistingIdleTaskIssue } from "../lib/idle_task_issue.ts";
import type { IdleTaskMilestone } from "../lib/idle_task_milestone.ts";
import type { Result } from "../types.ts";
import { getRunId } from "../lib/run_id.ts";
import {
  GITHUB_ISSUE_BODY_MAX_CHARS,
  IDLE_TASK_BODY_TRUNCATION_MARKER,
} from "../lib/idle_task_body_limit.ts";
import {
  type DueScan,
  IMPORTANT_TEMPLATE_NAMES,
} from "../lib/idle_task_cadence.ts";
import { resetDueScanCache } from "../lib/idle_task_due_scans.ts";
import { buildAttributionFooter } from "../lib/idle_task_attribution.ts";
import { REPO_ROOT } from "./support/repo_root.ts";

// ---------------------------------------------------------------------------
// Stable milestone stub used across the tests. The production helper hits the
// GitHub REST API; the tests always inject this stub so they never touch
// the network.
// ---------------------------------------------------------------------------

function makeMilestoneStub(number = 17) {
  const calls: { repo: string; template: string }[] = [];
  const fn = (opts: { repo: string; template: string }) => {
    calls.push({ ...opts });
    return Promise.resolve(
      { number, title: `idle-task: ${opts.template}` } as IdleTaskMilestone,
    );
  };
  return { fn, calls };
}

// ---------------------------------------------------------------------------
// Test template
// ---------------------------------------------------------------------------

const TEST_TEMPLATE_NAME = "maybe-file-test-template";

const testTemplate: IdleTaskTemplate = {
  name: TEST_TEMPLATE_NAME,
  description: "Test-only idle-task template for maybe-file tests.",
  buildIssueTitle: (repo) => `Run ${TEST_TEMPLATE_NAME} on ${repo}`,
  buildIssueBody: (opts) =>
    `# ${TEST_TEMPLATE_NAME} on ${opts.repo} (picked ${opts.pickedAt} by @${opts.workerUser})`,
  runTask: (_opts) =>
    Promise.resolve({ ok: true, summary: `${TEST_TEMPLATE_NAME} ran` }),
};

if (getTemplate(TEST_TEMPLATE_NAME) === undefined) {
  registerTemplate(testTemplate);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GhCall {
  args: string[];
}

function makeMockGh(opts: {
  createReturns?: string;
  createThrows?: boolean;
} = {}) {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    if (args[0] === "issue" && args[1] === "create") {
      if (opts.createThrows) {
        return Promise.reject(new Error("gh issue create exploded"));
      }
      return Promise.resolve(
        opts.createReturns ?? "https://github.com/org/monitored/issues/4242\n",
      );
    }
    return Promise.resolve("");
  };
  return { fn, calls };
}

function findCreateCall(calls: GhCall[]): GhCall | null {
  for (const c of calls) {
    if (c.args[0] === "issue" && c.args[1] === "create") return c;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

Deno.test(
  "maybe-file-idle-task - files an idle-task issue when all repos are idle and no dedup hit",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const labelCalls: string[] = [];
    const log: string[] = [];
    const milestone = makeMilestoneStub(17);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: (_o: { repo: string }) =>
            Promise.resolve(null as ExistingIdleTaskIssue | null),
          ensureLabelFn: (repo: string) => {
            labelCalls.push(repo);
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-14T01:02:03.000Z"),
          log: (line: string) => log.push(line),
          // Pin the shuffle order so the test reliably picks `org/idle-a`.
          // Fisher-Yates with rand >= 0.5 leaves a two-element array in
          // its original order (swap with self).
          randomFn: () => 0.99,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as
      | {
        action: string;
        template?: string;
        repo?: string;
        issueNumber?: number;
        milestoneNumber?: number;
      }
      | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.template, TEST_TEMPLATE_NAME);
    assertEquals(data?.repo, "org/idle-a");
    assertEquals(data?.issueNumber, 4242);
    assertEquals(data?.milestoneNumber, 17);

    // Label was ensured exactly once for the picked repo.
    assertEquals(labelCalls, ["org/idle-a"]);

    // Milestone helper was called once with the picked repo + template.
    assertEquals(milestone.calls, [
      { repo: "org/idle-a", template: TEST_TEMPLATE_NAME },
    ]);

    // gh issue create was called with the expected flags.
    const createCall = findCreateCall(gh.calls);
    assert(createCall !== null, "expected gh issue create call");
    assertEquals(createCall!.args[2], "--repo");
    assertEquals(createCall!.args[3], "org/idle-a");
    const labelIdx = createCall!.args.indexOf("--label");
    assertEquals(createCall!.args[labelIdx + 1], "idle-task");
    const milestoneIdx = createCall!.args.indexOf("--milestone");
    // gh issue create --milestone wants the milestone *title*, not its
    // numeric ID — see Issue #2050.
    assertEquals(
      createCall!.args[milestoneIdx + 1],
      `idle-task: ${TEST_TEMPLATE_NAME}`,
    );
    const titleIdx = createCall!.args.indexOf("--title");
    assertStringIncludes(
      createCall!.args[titleIdx + 1] ?? "",
      TEST_TEMPLATE_NAME,
    );
    const bodyIdx = createCall!.args.indexOf("--body");
    const body = createCall!.args[bodyIdx + 1] ?? "";
    // Issue #2077: body is the template's `buildIssueBody` output
    // verbatim — no hidden marker, no parameters block.
    assert(
      !body.includes("<!-- idle-task:"),
      "filed body must not embed the legacy idle-task marker (Issue #2077)",
    );
    assertStringIncludes(body, TEST_TEMPLATE_NAME);
    assertStringIncludes(body, "org/idle-a");
    assertStringIncludes(body, "2026-05-14T01:02:03.000Z");
    // Issue #2381: the filed wrapper carries a run-id metadata block so
    // it is traceable back to the worker run that created it.
    assertStringIncludes(body, "run-id:");
    // Issue #2438: the filed wrapper carries a visible attribution footer
    // naming the picked template and the run id from getRunId().
    const expectedRunId = getRunId();
    assertStringIncludes(body, "Filed by idle-task template:");
    assertStringIncludes(body, `\`${TEST_TEMPLATE_NAME}\``);
    assertStringIncludes(body, `\`${expectedRunId}\``);

    // Structured progress log emitted, including the milestone identifier.
    const filedLine = log.find((l) => l.includes("action=filed"));
    assert(filedLine !== undefined, "expected an action=filed log line");
    assertStringIncludes(filedLine!, `template=${TEST_TEMPLATE_NAME}`);
    assertStringIncludes(filedLine!, "repo=org/idle-a");
    assertStringIncludes(filedLine!, "issue=4242");
    assertStringIncludes(filedLine!, "milestone=17");
  },
);

// ---------------------------------------------------------------------------
// Dedup hit
// ---------------------------------------------------------------------------

Deno.test(
  "maybe-file-idle-task - skipped when matching idle-task issue is already open in every repo",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const labelCalls: string[] = [];
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: (o: { repo: string }) =>
            Promise.resolve({
              number: 999,
              url: `https://github.com/${o.repo}/issues/999`,
            } as ExistingIdleTaskIssue),
          ensureLabelFn: (repo: string) => {
            labelCalls.push(repo);
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-14T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "skipped");
    assertEquals(data?.reason, "duplicate");

    // No label create, no gh issue create, no milestone ensure.
    assertEquals(labelCalls.length, 0);
    assertEquals(milestone.calls.length, 0);
    assertEquals(findCreateCall(gh.calls), null);

    // Structured skip log emitted.
    const skipLine = log.find((l) =>
      l.includes("action=skipped") && l.includes("reason=duplicate")
    );
    assert(
      skipLine !== undefined,
      "expected an action=skipped reason=duplicate log line",
    );
    assertStringIncludes(skipLine!, `template=${TEST_TEMPLATE_NAME}`);
  },
);

// ---------------------------------------------------------------------------
// No `work_available` short-circuit (Issue #2026)
// ---------------------------------------------------------------------------
//
// The previous version of the command re-checked repo availability and
// skipped with `reason=work_available` whenever any monitored repo had
// any open issue not assigned to the worker user. Because most repos
// always have such issues (assigned to humans, labelled
// `failed`/`needs-human`, etc.), the filer skipped indefinitely and no
// idle-task issue was ever raised — see worker logs cited on issue
// #2026.
//
// Behaviour change: the caller (`run_core.ts`) already gates the filer
// on `tracker.scanHadSuccess === false`. The previous "short-circuits
// when any monitored repo has work" test asserted the broken behaviour
// and is replaced by this regression test. The `checkRepoFn` injection
// hook and the `work_available` reason were removed.
Deno.test(
  "maybe-file-idle-task - does not short-circuit; files even when caller would have reported work elsewhere",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(7);
    const dedupQueriedFor: string[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: (o: { repo: string }) => {
            dedupQueriedFor.push(o.repo);
            return Promise.resolve(null as ExistingIdleTaskIssue | null);
          },
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-14T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    // The filer files an idle-task issue.
    assertEquals(result.success, true);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "filed");
    // Dedup, label, milestone and create were all consulted — i.e. no
    // short-circuit occurred.
    assertEquals(dedupQueriedFor, ["org/idle-a"]);
    assertEquals(milestone.calls.length, 1);
    assert(findCreateCall(gh.calls) !== null);
    // No `work_available` line is emitted.
    const skipLine = log.find((l) => l.includes("reason=work_available"));
    assertEquals(skipLine, undefined);
  },
);

// ---------------------------------------------------------------------------
// gh issue create failure
// ---------------------------------------------------------------------------

Deno.test(
  "maybe-file-idle-task - gh issue create failure surfaces non-zero exit and logs error",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh({ createThrows: true });
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-14T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(
      result.success,
      false,
      "gh issue create failure must surface as non-zero exit (success: false)",
    );

    const errorLine = log.find((l) =>
      l.includes("action=error") || l.includes("action=failed")
    );
    assert(errorLine !== undefined, "expected an error log line");
    assertStringIncludes(errorLine!, "gh issue create exploded");

    // gh issue create was attempted on the picked repo.
    const createCall = findCreateCall(gh.calls);
    assert(createCall !== null, "expected gh issue create attempt");
  },
);

// ---------------------------------------------------------------------------
// Label-create failure
// ---------------------------------------------------------------------------

Deno.test(
  "maybe-file-idle-task - label create failure surfaces non-zero exit",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve(
              { ok: false, error: new Error("label API down") } as Result<void>,
            ),
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-14T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, false);
    // gh issue create must not have been attempted when label-ensure fails,
    // and the milestone helper must not have been consulted.
    assertEquals(findCreateCall(gh.calls), null);
    assertEquals(milestone.calls.length, 0);

    const errorLine = log.find((l) =>
      l.includes("action=error") || l.includes("action=failed")
    );
    assert(errorLine !== undefined, "expected an error log line");
    assertStringIncludes(errorLine!, "label");
  },
);

// ---------------------------------------------------------------------------
// Missing required args
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Random repo selection (Issue #1986)
// ---------------------------------------------------------------------------

Deno.test(
  "maybe-file-idle-task - random repo selection picks the shuffled-first available repo",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(42);
    const dedupQueriedFor: string[] = [];

    // Fisher-Yates over [a, b] with rand=0 swaps index 1 with index 0,
    // producing [b, a]. The shuffled-first repo (b) is therefore picked,
    // demonstrating that selection is no longer in declared order.
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: (o: { repo: string }) => {
            dedupQueriedFor.push(o.repo);
            return Promise.resolve(null as ExistingIdleTaskIssue | null);
          },
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-14T01:02:03.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; repo?: string } | undefined;
    assertEquals(data?.action, "filed");
    // First entry in the shuffled list is the original second entry.
    assertEquals(data?.repo, "org/idle-b");
    // Dedup was only consulted once — the very first shuffled repo
    // came up clean.
    assertEquals(dedupQueriedFor, ["org/idle-b"]);
  },
);

Deno.test(
  "maybe-file-idle-task - random selection skips occupied repos in shuffled order",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();
    const dedupQueriedFor: string[] = [];

    // Fisher-Yates over [a, b] with rand=0 yields [b, a]. With b occupied,
    // dedup falls through to a and files there.
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: (o: { repo: string }) => {
            dedupQueriedFor.push(o.repo);
            return Promise.resolve(
              o.repo === "org/idle-b"
                ? ({
                  number: 1,
                  url: `https://github.com/${o.repo}/issues/1`,
                } as ExistingIdleTaskIssue)
                : null,
            );
          },
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-14T01:02:03.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; repo?: string } | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.repo, "org/idle-a");
    assertEquals(dedupQueriedFor, ["org/idle-b", "org/idle-a"]);
  },
);

// ---------------------------------------------------------------------------
// Milestone wiring (Issue #1986)
// ---------------------------------------------------------------------------

Deno.test(
  "maybe-file-idle-task - milestone helper is called with chosen (repo, template) and number passed to gh create",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(99);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-14T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    // The milestone helper was called exactly once with the chosen
    // (repo, template) pair.
    assertEquals(milestone.calls, [
      { repo: "org/idle-a", template: TEST_TEMPLATE_NAME },
    ]);
    // The milestone *title* reaches gh issue create as --milestone <title>.
    // The flag wants the title, not the numeric ID — Issue #2050.
    const createCall = findCreateCall(gh.calls);
    assert(createCall !== null);
    const idx = createCall!.args.indexOf("--milestone");
    assert(idx !== -1, "expected --milestone flag");
    assertEquals(
      createCall!.args[idx + 1],
      `idle-task: ${TEST_TEMPLATE_NAME}`,
    );
    // Success log line carries the milestone identifier.
    const filedLine = log.find((l) => l.includes("action=filed"));
    assertStringIncludes(filedLine ?? "", "milestone=99");
  },
);

Deno.test(
  "maybe-file-idle-task - milestone helper failure surfaces reason=milestone_failed",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-14T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: () =>
            Promise.reject(new Error("milestone API exploded")),
        },
      },
      config,
    );

    assertEquals(result.success, false);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "error");
    assertEquals(data?.reason, "milestone_failed");
    // No issue was filed if the milestone could not be ensured.
    assertEquals(findCreateCall(gh.calls), null);
    // Structured error log emitted.
    const errLine = log.find((l) =>
      l.includes("action=error") && l.includes("reason=milestone_failed")
    );
    assert(errLine !== undefined, "expected milestone_failed log line");
    assertStringIncludes(errLine!, "milestone API exploded");
  },
);

// ---------------------------------------------------------------------------
// Regression — Issue #2050
// ---------------------------------------------------------------------------
//
// `gh issue create --milestone` wants the milestone *title*, not its
// numeric ID. The previous implementation passed `String(milestone.number)`,
// so gh tried to look up a milestone whose title was the literal digits
// and failed with `could not add to milestone '<n>': '<n>' not found`.
// This guard fails closed if the regression returns.
Deno.test(
  "maybe-file-idle-task - passes milestone title (not numeric ID) to gh issue create (Issue #2050)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(2);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-15T10:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const createCall = findCreateCall(gh.calls);
    assert(createCall !== null, "expected gh issue create call");

    const idx = createCall!.args.indexOf("--milestone");
    assert(idx !== -1, "expected --milestone flag");
    const milestoneArg = createCall!.args[idx + 1] ?? "";

    // The argument must be the human-readable title, not the numeric ID.
    assertEquals(milestoneArg, `idle-task: ${TEST_TEMPLATE_NAME}`);
    assert(
      !/^\d+$/.test(milestoneArg),
      `--milestone must not be a numeric string (got "${milestoneArg}"); ` +
        `gh would treat it as a title lookup and fail (Issue #2050)`,
    );
  },
);

Deno.test(
  "maybe-file-idle-task - missing github-user reports failure without invoking deps",
  async () => {
    const config = buildDefaultWorkerConfig();
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        __testDeps: {
          pickTemplateFn: () => {
            throw new Error("must not run when args invalid");
          },
        },
      },
      config,
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "github-user");
  },
);

// ---------------------------------------------------------------------------
// Pickup label (Issue #2077)
// ---------------------------------------------------------------------------
//
// Every filed wrapper carries the `idle-task` label and `label=idle-task`
// appears in the progress log. The previous `requiresApproval` /
// `idle-task-pending` branch was retired — `idle-task` is already the
// lowest priority in the queue, so a separate approval gate added no
// value.

Deno.test(
  "maybe-file-idle-task - every filed wrapper carries the idle-task label (Issue #2077)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () =>
            Promise.resolve(null as ExistingIdleTaskIssue | null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-17T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const createCall = findCreateCall(gh.calls);
    assert(createCall !== null);
    const labelIdx = createCall!.args.indexOf("--label");
    assertEquals(createCall!.args[labelIdx + 1], "idle-task");
    const filedLine = log.find((l) => l.includes("action=filed"));
    assert(filedLine !== undefined);
    assertStringIncludes(filedLine!, "label=idle-task");
  },
);

Deno.test(
  "maybe-file-idle-task - empty monitored-repos reports failure",
  async () => {
    const config = buildDefaultWorkerConfig();
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "",
        "github-user": "VibeBot",
      },
      config,
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "monitored-repos");
  },
);

// ---------------------------------------------------------------------------
// Template-vetoed filing — Issue #2056
// ---------------------------------------------------------------------------
//
// The template's optional `shouldFile` hook lets it block re-queuing when
// the previous batch of results is still being triaged (e.g. security-scan
// refuses to run again while open `security` findings remain).

Deno.test(
  "maybe-file-idle-task - skipped when template.shouldFile vetoes every repo (Issue #2056)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const labelCalls: string[] = [];
    const log: string[] = [];
    const milestone = makeMilestoneStub();
    const shouldFileQueriedFor: string[] = [];

    const vetoTemplate: IdleTaskTemplate = {
      ...testTemplate,
      name: "veto-template",
      shouldFile: (opts) => {
        shouldFileQueriedFor.push(opts.repo);
        return Promise.resolve(false);
      },
    };
    if (getTemplate("veto-template") === undefined) {
      registerTemplate(vetoTemplate);
    }

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (repo: string) => {
            labelCalls.push(repo);
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => vetoTemplate,
          nowFn: () => new Date("2026-05-14T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          // Pin the shuffle so repos are visited in declared order.
          randomFn: () => 0.99,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "skipped");
    assertEquals(data?.reason, "pending_results");

    // shouldFile was consulted for every repo — none were filed against.
    assertEquals(shouldFileQueriedFor.sort(), ["org/idle-a", "org/idle-b"]);
    // No label create, no milestone ensure, no gh issue create.
    assertEquals(labelCalls.length, 0);
    assertEquals(milestone.calls.length, 0);
    assertEquals(findCreateCall(gh.calls), null);

    // Structured per-repo skip lines emitted.
    const perRepoLines = log.filter((l) =>
      l.includes("action=skipped") && l.includes("reason=pending_results")
    );
    assert(
      perRepoLines.length >= 2,
      "expected per-repo pending_results skip log lines",
    );
  },
);

Deno.test(
  "maybe-file-idle-task - shouldFile veto on one repo falls through to next (Issue #2056)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(7);

    const partialVetoTemplate: IdleTaskTemplate = {
      ...testTemplate,
      name: "partial-veto-template",
      shouldFile: (opts) => Promise.resolve(opts.repo !== "org/idle-b"),
    };
    if (getTemplate("partial-veto-template") === undefined) {
      registerTemplate(partialVetoTemplate);
    }

    // Pin the shuffle so repos are visited in [b, a] order — `b` is
    // vetoed, so the filer must fall through to `a` and file there.
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => partialVetoTemplate,
          nowFn: () => new Date("2026-05-14T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; repo?: string } | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.repo, "org/idle-a");
  },
);

// ---------------------------------------------------------------------------
// Busy-repo skip (Issue #2054)
// ---------------------------------------------------------------------------
//
// When another Vibe Coder already has approved work queued in a repo
// (`top-priority`, `work-on`, `low-priority`, `idle-task`, or
// `idle-task-pending`), the filer must skip that repo. If every
// monitored repo is busy, the filer skips creation entirely for this
// round.

Deno.test(
  "maybe-file-idle-task - skips busy repo and files in idle alternative (Issue #2054)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(7);
    const busyCheckedFor: string[] = [];

    // Pin the shuffle so repos are visited in [b, a] order. `b` is
    // marked busy; the filer must fall through to `a` and file there.
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-17T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0,
          ensureMilestoneFn: milestone.fn,
          isRepoBusyFn: (opts: { repo: string }) => {
            busyCheckedFor.push(opts.repo);
            return Promise.resolve(opts.repo === "org/idle-b");
          },
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; repo?: string } | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.repo, "org/idle-a");

    // Busy check probed both repos in shuffled order.
    assertEquals(busyCheckedFor, ["org/idle-b", "org/idle-a"]);

    // Structured per-repo skip line emitted for the busy repo.
    const skipLine = log.find((l) =>
      l.includes("repo=org/idle-b") &&
      l.includes("action=skipped") &&
      l.includes("reason=approved_work_in_flight")
    );
    assert(
      skipLine !== undefined,
      "expected an approved_work_in_flight skip log line for the busy repo",
    );
  },
);

Deno.test(
  "maybe-file-idle-task - skips entirely when every monitored repo is busy (Issue #2054)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const labelCalls: string[] = [];
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/busy-a,org/busy-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (repo: string) => {
            labelCalls.push(repo);
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
          ghCommandFn: gh.fn,
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-17T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0.99,
          ensureMilestoneFn: milestone.fn,
          isRepoBusyFn: (_opts: { repo: string }) => Promise.resolve(true),
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "skipped");
    assertEquals(data?.reason, "approved_work_in_flight");

    // No label create, no milestone ensure, no gh issue create.
    assertEquals(labelCalls.length, 0);
    assertEquals(milestone.calls.length, 0);
    assertEquals(findCreateCall(gh.calls), null);

    // Per-repo skip lines were emitted for each busy repo.
    const perRepoLines = log.filter((l) =>
      l.includes("action=skipped") &&
      l.includes("reason=approved_work_in_flight")
    );
    assertEquals(perRepoLines.length, 2);
  },
);

Deno.test(
  "maybe-file-idle-task - busy-repo check exception does not block filing (Issue #2054)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-17T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
          isRepoBusyFn: (_opts: { repo: string }) =>
            Promise.reject(new Error("gh busy probe exploded")),
        },
      },
      config,
    );

    // Transient gh hiccups must not silently disable the filer.
    assertEquals(result.success, true);
    const data = result.data as { action: string } | undefined;
    assertEquals(data?.action, "filed");

    // A warn line records the lookup failure for visibility.
    const warnLine = log.find((l) =>
      l.includes("action=warn") && l.includes("reason=busy_check_failed")
    );
    assert(warnLine !== undefined, "expected busy_check_failed warn line");
    assertStringIncludes(warnLine!, "gh busy probe exploded");
  },
);

// ---------------------------------------------------------------------------
// Fleet-global existence gate (Issue #2813)
// ---------------------------------------------------------------------------

Deno.test(
  "maybe-file-idle-task - suppresses filing when an unblocked work-on issue exists anywhere in the monitored set (Issue #2813)",
  async () => {
    // Repo A holds a deferred (unclaimed) work-on issue; repo B is quiet.
    // The fleet-global existence gate must skip filing entirely — even
    // though repo B looks idle — because the fleet has real work. This is
    // the filing half of the #2806 inversion: deferral by
    // nice/rotation/cooldown must not be read as "no work".
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const labelCalls: string[] = [];
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/has-work,org/quiet",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (repo: string) => {
            labelCalls.push(repo);
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
          ghCommandFn: gh.fn,
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-06-15T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0.99,
          ensureMilestoneFn: milestone.fn,
          // One repo holds real work, and (Issue #1083) the default of one
          // idle slot means that one repo is enough to occupy the fleet.
          countStartableWorkReposFn: () => Promise.resolve(1),
          // Per-repo busy is off; the fleet gate must short-circuit before
          // the per-repo loop is ever reached.
          isRepoBusyFn: () => Promise.resolve(false),
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "skipped");
    assertEquals(data?.reason, "approved_work_in_flight");

    // Nothing was filed: no label create, no milestone, no gh issue create.
    assertEquals(labelCalls.length, 0);
    assertEquals(milestone.calls.length, 0);
    assertEquals(findCreateCall(gh.calls), null);

    // The fleet-scope skip line is emitted.
    const skipLine = log.find((l) =>
      l.includes("action=skipped") &&
      l.includes("reason=approved_work_in_flight") &&
      l.includes("scope=monitored_set")
    );
    assert(
      skipLine !== undefined,
      "expected a fleet-scope approved_work_in_flight skip line",
    );
  },
);

Deno.test(
  "maybe-file-idle-task - files normally when the monitored set has no unblocked real work (Issue #2813)",
  async () => {
    // Regression guard: the fleet gate must NOT suppress filing when there
    // is genuinely no unblocked real work anywhere.
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(21);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-06-15T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
          countStartableWorkReposFn: () => Promise.resolve(0),
          isRepoBusyFn: () => Promise.resolve(false),
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string } | undefined;
    assertEquals(data?.action, "filed");
    assert(findCreateCall(gh.calls) !== null, "expected gh issue create");
  },
);

Deno.test(
  "maybe-file-idle-task - fleet existence-check exception does not block filing (Issue #2813)",
  async () => {
    // A transient gh hiccup in the fleet existence gate must degrade to
    // "no work" so the filer is never silently disabled.
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-06-15T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
          countStartableWorkReposFn: () =>
            Promise.reject(new Error("gh fleet probe exploded")),
          isRepoBusyFn: () => Promise.resolve(false),
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string } | undefined;
    assertEquals(data?.action, "filed");

    const warnLine = log.find((l) =>
      l.includes("action=warn") && l.includes("reason=fleet_work_check_failed")
    );
    assert(
      warnLine !== undefined,
      "expected fleet_work_check_failed warn line",
    );
    assertStringIncludes(warnLine!, "gh fleet probe exploded");
  },
);

Deno.test(
  "maybe-file-idle-task - busy-check skip preferred over duplicate when both present (Issue #2054)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    // Two repos: one with a dedup hit, one busy. The fall-through
    // reason should reflect the most specific signal that fired —
    // approved_work_in_flight wins over duplicate.
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/dup,org/busy",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: (o: { repo: string }) =>
            Promise.resolve(
              o.repo === "org/dup"
                ? ({
                  number: 1,
                  url: `https://github.com/${o.repo}/issues/1`,
                } as ExistingIdleTaskIssue)
                : null,
            ),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-17T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          // Pin shuffle so repos visited in declared order.
          randomFn: () => 0.99,
          ensureMilestoneFn: milestone.fn,
          isRepoBusyFn: (opts: { repo: string }) =>
            Promise.resolve(opts.repo === "org/busy"),
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "skipped");
    assertEquals(data?.reason, "approved_work_in_flight");
    assertEquals(findCreateCall(gh.calls), null);
  },
);

// ---------------------------------------------------------------------------
// skipMilestone opt-out (Issue #2067)
// ---------------------------------------------------------------------------
//
// Templates that set `skipMilestone: true` must be filed without a
// per-template milestone — the framework neither calls
// `ensureMilestoneFn` nor passes `--milestone` to `gh issue create`,
// and `milestoneNumber` is omitted from the result data. The progress
// log carries `milestone=skipped` so operators can spot the opt-out.

const SKIP_MILESTONE_TEMPLATE_NAME = "maybe-file-skip-milestone-template";

const skipMilestoneTemplate: IdleTaskTemplate = {
  name: SKIP_MILESTONE_TEMPLATE_NAME,
  description:
    "Test-only template that opts out of the per-template milestone.",
  buildIssueTitle: (repo) => `Run ${SKIP_MILESTONE_TEMPLATE_NAME} on ${repo}`,
  buildIssueBody: (opts) =>
    `# ${SKIP_MILESTONE_TEMPLATE_NAME} on ${opts.repo} (picked ${opts.pickedAt} by @${opts.workerUser})`,
  runTask: (_opts) =>
    Promise.resolve({
      ok: true,
      summary: `${SKIP_MILESTONE_TEMPLATE_NAME} ran`,
    }),
  skipMilestone: true,
};

if (getTemplate(SKIP_MILESTONE_TEMPLATE_NAME) === undefined) {
  registerTemplate(skipMilestoneTemplate);
}

Deno.test(
  "maybe-file-idle-task - skipMilestone=true omits --milestone and skips ensureMilestoneFn (Issue #2067)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(99);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => skipMilestoneTemplate,
          nowFn: () => new Date("2026-05-17T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as
      | {
        action: string;
        template?: string;
        repo?: string;
        issueNumber?: number;
        milestoneNumber?: number;
      }
      | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.template, SKIP_MILESTONE_TEMPLATE_NAME);
    assertEquals(data?.repo, "org/idle-a");
    // `milestoneNumber` is omitted entirely when the template opts out.
    assertEquals(
      data?.milestoneNumber,
      undefined,
      "milestoneNumber must be absent when template.skipMilestone is true",
    );

    // The milestone helper must not have been consulted.
    assertEquals(
      milestone.calls.length,
      0,
      "ensureMilestoneFn must not be called when template.skipMilestone is true",
    );

    // gh issue create must omit --milestone entirely.
    const createCall = findCreateCall(gh.calls);
    assert(createCall !== null, "expected gh issue create call");
    assertEquals(
      createCall!.args.indexOf("--milestone"),
      -1,
      "--milestone must be absent from gh issue create when template.skipMilestone is true",
    );

    // Progress log reports `milestone=skipped` so operators can see why
    // no number is attached.
    const filedLine = log.find((l) => l.includes("action=filed"));
    assert(filedLine !== undefined, "expected an action=filed log line");
    assertStringIncludes(filedLine!, "milestone=skipped");
  },
);

Deno.test(
  "maybe-file-idle-task - skipMilestone=true still ensures the pickup label and parses the issue number (Issue #2067)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const labelCalls: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (repo: string) => {
            labelCalls.push(repo);
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => skipMilestoneTemplate,
          nowFn: () => new Date("2026-05-17T00:00:00.000Z"),
          log: () => {},
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    // Label is still ensured — the opt-out is only about the milestone.
    assertEquals(labelCalls, ["org/idle-a"]);
    // The parsed issue number is still surfaced.
    const data = result.data as { issueNumber?: number } | undefined;
    assertEquals(data?.issueNumber, 4242);
  },
);

Deno.test(
  "maybe-file-idle-task - skipMilestone=false (default) still calls ensureMilestoneFn and passes --milestone (Issue #2067)",
  async () => {
    // Regression guard — the default path must be unchanged. testTemplate
    // does not set skipMilestone, so the framework must keep ensuring +
    // assigning the per-template milestone exactly as before.
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(55);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-17T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    // Milestone helper called exactly once for the chosen (repo, template).
    assertEquals(milestone.calls, [
      { repo: "org/idle-a", template: TEST_TEMPLATE_NAME },
    ]);
    // gh issue create carries the --milestone flag with the title.
    const createCall = findCreateCall(gh.calls);
    assert(createCall !== null);
    const idx = createCall!.args.indexOf("--milestone");
    assert(idx !== -1, "--milestone must be present for skipMilestone=false");
    assertEquals(
      createCall!.args[idx + 1],
      `idle-task: ${TEST_TEMPLATE_NAME}`,
    );
    // Data carries the numeric milestone id.
    const data = result.data as { milestoneNumber?: number } | undefined;
    assertEquals(data?.milestoneNumber, 55);
    // Progress log reports the numeric milestone, not `skipped`.
    const filedLine = log.find((l) => l.includes("action=filed"));
    assert(filedLine !== undefined);
    assertStringIncludes(filedLine!, "milestone=55");
  },
);

Deno.test(
  "maybe-file-idle-task - shouldFile lookup failure does not block filing (Issue #2056)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const exploderTemplate: IdleTaskTemplate = {
      ...testTemplate,
      name: "exploder-template",
      shouldFile: () => Promise.reject(new Error("gh exploded")),
    };
    if (getTemplate("exploder-template") === undefined) {
      registerTemplate(exploderTemplate);
    }

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          // Issue #2054: stub the busy-repo check off — tests pin
          // their fixtures via findExistingFn / shouldFile.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => exploderTemplate,
          nowFn: () => new Date("2026-05-14T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    // Lookup failures are non-fatal — the filer still queues the run.
    assertEquals(result.success, true);
    const data = result.data as { action: string } | undefined;
    assertEquals(data?.action, "filed");

    // A warn line records the lookup failure for visibility.
    const warnLine = log.find((l) =>
      l.includes("action=warn") && l.includes("reason=should_file_failed")
    );
    assert(warnLine !== undefined, "expected should_file_failed warn line");
    assertStringIncludes(warnLine!, "gh exploded");
  },
);

// ---------------------------------------------------------------------------
// Queue-gate regression — Issue #2467
// ---------------------------------------------------------------------------
//
// The #2082 queue gate fired whenever the worker repo had any open
// `work-on` issue (the steady-state for normal operation), starving
// idle-task creation across every monitored repo. The gate was removed
// in #2467 — overcreation is bounded by the cross-repo wrapper dedup
// (#2092), the per-template cooldown (#2104), the per-repo busy check
// (#2054/#2440), and the runTask re-check (#2441). These tests lock the
// removal in:
//   1. With a `worker-repo` arg supplied and the monitored set quiet,
//      the filer still files (the gate no longer aborts the round).
//   2. The legacy `queue_occupied` skip reason is never emitted.
//   3. The legacy `--worker-repo` arg is accepted (back-compat) without
//      affecting the outcome.

Deno.test(
  "maybe-file-idle-task - files even when worker-repo arg is supplied (Issue #2467 regression)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(21);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        // The legacy queue-gate arg is still accepted but must no longer
        // suppress filing — that is the regression #2467 fixes.
        "worker-repo": "stSoftwareAU/VibeCoder",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          // The per-target busy check still applies; clean for this test.
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-31T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "filed");
    // The legacy reason must never appear again.
    assertEquals(data?.reason, undefined);

    // An issue was actually created on a monitored repo.
    const createCall = findCreateCall(gh.calls);
    assert(createCall !== null, "expected gh issue create call");
    const repoIdx = createCall!.args.indexOf("--repo");
    assert(repoIdx >= 0, "expected --repo in create args");
    const repo = createCall!.args[repoIdx + 1];
    assert(
      repo === "org/idle-a" || repo === "org/idle-b",
      `expected one of the monitored repos, got ${repo}`,
    );

    // No queue-gate log lines emitted.
    const queueLine = log.find((l) =>
      l.includes("reason=queue_occupied") ||
      l.includes("reason=queue_check_failed")
    );
    assertEquals(
      queueLine,
      undefined,
      "no queue-gate log lines should be emitted after #2467",
    );
  },
);

// ---------------------------------------------------------------------------
// Backlog gate — Issue #2082
// ---------------------------------------------------------------------------
//
// Before raising an idle-task wrapper for template T against target repo
// R, the filer counts open issues in R carrying T's `outputLabel`. If
// the count is ≥ BACKLOG_THRESHOLD (currently 6), the filer skips the
// repo: the previous batch is still un-triaged and adding more
// idle-task noise would only delay remediation.

const BACKLOG_THRESHOLD = 6;

const backlogTestTemplate: IdleTaskTemplate = {
  ...testTemplate,
  name: "backlog-test-template",
  outputLabel: "test-output",
};

if (getTemplate("backlog-test-template") === undefined) {
  registerTemplate(backlogTestTemplate);
}

Deno.test(
  "maybe-file-idle-task - backlog gate skips repo when output label count meets threshold (Issue #2082)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();
    const backlogCalls: { repo: string; label: string }[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          countOutputLabelOpenIssuesFn: (
            o: { repo: string; label: string },
          ) => {
            backlogCalls.push({ ...o });
            return Promise.resolve(BACKLOG_THRESHOLD);
          },
          pickTemplateFn: () => backlogTestTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "skipped");
    assertEquals(data?.reason, "output_backlog");

    // Backlog check was consulted with the template's output label
    // against the target repo.
    assertEquals(backlogCalls, [
      { repo: "org/idle-a", label: "test-output" },
    ]);
    // No filing happened.
    assertEquals(milestone.calls.length, 0);
    assertEquals(findCreateCall(gh.calls), null);

    const skipLine = log.find((l) =>
      l.includes("action=skipped") && l.includes("reason=output_backlog")
    );
    assert(skipLine !== undefined, "expected output_backlog log line");
    assertStringIncludes(skipLine!, "label=test-output");
    assertStringIncludes(skipLine!, `count=${BACKLOG_THRESHOLD}`);
  },
);

Deno.test(
  "maybe-file-idle-task - backlog gate passes through when below threshold (Issue #2082)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(13);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          countOutputLabelOpenIssuesFn: () =>
            Promise.resolve(BACKLOG_THRESHOLD - 1),
          pickTemplateFn: () => backlogTestTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string } | undefined;
    assertEquals(data?.action, "filed");
  },
);

Deno.test(
  "maybe-file-idle-task - backlog gate falls through to next repo when first exceeds threshold (Issue #2082)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(21);
    const backlogCallRepos: string[] = [];

    // Shuffle pinned: rand=0 over [a, b] yields [b, a]. b is backlogged,
    // a is clear.
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          countOutputLabelOpenIssuesFn: (
            o: { repo: string; label: string },
          ) => {
            backlogCallRepos.push(o.repo);
            if (o.repo === "org/idle-b") return Promise.resolve(20);
            return Promise.resolve(0);
          },
          pickTemplateFn: () => backlogTestTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; repo?: string } | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.repo, "org/idle-a");
    // Both repos consulted in shuffled order.
    assertEquals(backlogCallRepos, ["org/idle-b", "org/idle-a"]);
  },
);

Deno.test(
  "maybe-file-idle-task - backlog gate is bypassed for templates without outputLabel (Issue #2082)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(31);
    const backlogCalls: { repo: string; label: string }[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          countOutputLabelOpenIssuesFn: (
            o: { repo: string; label: string },
          ) => {
            backlogCalls.push({ ...o });
            return Promise.resolve(1000);
          },
          // `testTemplate` has no `outputLabel` declared.
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string } | undefined;
    assertEquals(data?.action, "filed");
    // Backlog count was never consulted because the template did not
    // declare an outputLabel.
    assertEquals(backlogCalls, []);
  },
);

Deno.test(
  "maybe-file-idle-task - backlog gate exhausting every repo reports reason=output_backlog (Issue #2082)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          countOutputLabelOpenIssuesFn: () =>
            Promise.resolve(BACKLOG_THRESHOLD),
          pickTemplateFn: () => backlogTestTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "skipped");
    assertEquals(data?.reason, "output_backlog");
    assertEquals(findCreateCall(gh.calls), null);
  },
);

// ---------------------------------------------------------------------------
// Per-repo wrapper exclusivity (Issues #2092, #1083)
// ---------------------------------------------------------------------------
//
// Documented business-logic change (Issue #1083): a wrapper open in ONE
// monitored repo no longer suppresses filing across the whole set. The gate is
// one wrapper per repository — the operator's "one issue in flight per work
// stream" rule applied to idle work — so the holder is skipped and a clean
// repo is filed instead. The whole-set refusal it replaces is the case below.

Deno.test(
  "maybe-file-idle-task - a repo holding a wrapper is skipped and a clean repo is filed (Issues #2092, #1083)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          // The census reports one holder; the other repo stays eligible.
          findOpenWrappersFn: (_repos: readonly string[]) =>
            Promise.resolve([{
              repo: "org/idle-b",
              number: 2724,
              url: "https://github.com/org/idle-b/issues/2724",
            }]),
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0.99,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as
      | { action: string; repo?: string; template?: string }
      | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.repo, "org/idle-a");
    assert(findCreateCall(gh.calls) !== null);

    // The refusal is logged, naming the repo and the issue that held it —
    // the line whose absence hid the fleet-wide cap for a week (#1083).
    const skipLine = log.find((l) =>
      l.includes("action=skipped") &&
      l.includes("reason=existing_wrapper_open")
    );
    assert(
      skipLine !== undefined,
      "expected an action=skipped reason=existing_wrapper_open log line",
    );
    assertStringIncludes(skipLine!, `template=${TEST_TEMPLATE_NAME}`);
    assertStringIncludes(skipLine!, "repo=org/idle-b");
    assertStringIncludes(skipLine!, "issue=2724");
    assertStringIncludes(skipLine!, "scope=repo");
  },
);

Deno.test(
  "maybe-file-idle-task - skipped with reason=existing_wrapper_open when EVERY monitored repo holds one (Issues #2092, #1083)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();
    const perRepoDedupCalls: string[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          findOpenWrappersFn: (_repos: readonly string[]) =>
            Promise.resolve([
              {
                repo: "org/idle-a",
                number: 2723,
                url: "https://github.com/org/idle-a/issues/2723",
              },
              {
                repo: "org/idle-b",
                number: 2724,
                url: "https://github.com/org/idle-b/issues/2724",
              },
            ]),
          // Per-repo dedup must NOT be consulted — no candidate survives.
          findExistingFn: (o: { repo: string }) => {
            perRepoDedupCalls.push(o.repo);
            return Promise.resolve(null);
          },
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as
      | { action: string; reason?: string; template?: string }
      | undefined;
    assertEquals(data?.action, "skipped");
    assertEquals(data?.reason, "existing_wrapper_open");
    assertEquals(data?.template, TEST_TEMPLATE_NAME);
    assertEquals(perRepoDedupCalls, []);
    assertEquals(milestone.calls.length, 0);
    assertEquals(findCreateCall(gh.calls), null);

    const summary = log.find((l) =>
      l.includes("reason=existing_wrapper_open") &&
      l.includes("scope=monitored_set")
    );
    assert(summary !== undefined, "expected a monitored_set summary line");
    assertStringIncludes(summary!, "held=2");
  },
);

Deno.test(
  "maybe-file-idle-task - cross-repo gate clean: existing shuffle + file path runs unchanged (Issue #2092)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(33);
    const perRepoDedupCalls: string[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          // The wrapper census reports the entire set clean.
          findOpenWrappersFn: () => Promise.resolve([]),
          findExistingFn: (o: { repo: string }) => {
            perRepoDedupCalls.push(o.repo);
            return Promise.resolve(null);
          },
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          // Pin shuffle so the first picked repo is org/idle-a (rand=0.99
          // leaves a two-element array in original order).
          randomFn: () => 0.99,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; repo?: string } | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.repo, "org/idle-a");
    // Per-repo dedup was consulted exactly once (first shuffled repo)
    // because the cross-repo gate cleared the way.
    assertEquals(perRepoDedupCalls, ["org/idle-a"]);
    assert(findCreateCall(gh.calls) !== null);
  },
);

// ---------------------------------------------------------------------------
// Per-repo cooldown gate (Issue #2105)
// ---------------------------------------------------------------------------
//
// Before raising an idle-task wrapper for template T against target
// repo R, the filer consults the cooldown gate: T fires at most once
// per `cooldownHours` per repo. Default window is 24 hours; templates
// may override via the optional `cooldownHours` field on
// `IdleTaskTemplate`.

Deno.test(
  "maybe-file-idle-task - skips repo inside cooldown window with reason=cooldown_active (Issue #2105)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(7);
    const cooldownCalls: { repo: string; template: string }[] = [];

    // Pin shuffle so repos are visited in [b, a] order — `b` is in
    // cooldown, so the filer must fall through to `a` and file there.
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          isRepoCooledDownFn: (
            opts: { repo: string; template: IdleTaskTemplate },
          ) => {
            cooldownCalls.push({
              repo: opts.repo,
              template: opts.template.name,
            });
            return Promise.resolve(opts.repo === "org/idle-b");
          },
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; repo?: string } | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.repo, "org/idle-a");

    // Cooldown check ran for both repos in shuffled order, with the
    // template threaded through.
    assertEquals(cooldownCalls, [
      { repo: "org/idle-b", template: TEST_TEMPLATE_NAME },
      { repo: "org/idle-a", template: TEST_TEMPLATE_NAME },
    ]);

    // Structured per-repo skip line emitted for the cooled-down repo.
    const skipLine = log.find((l) =>
      l.includes("repo=org/idle-b") &&
      l.includes("action=skipped") &&
      l.includes("reason=cooldown_active")
    );
    assert(
      skipLine !== undefined,
      "expected a cooldown_active skip log line for the cooled-down repo",
    );
    assertStringIncludes(skipLine!, `template=${TEST_TEMPLATE_NAME}`);
  },
);

Deno.test(
  "maybe-file-idle-task - files normally when repo is outside cooldown window (Issue #2105)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(11);
    const cooldownCalls: string[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          isRepoCooledDownFn: (opts: { repo: string }) => {
            cooldownCalls.push(opts.repo);
            return Promise.resolve(false);
          },
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; repo?: string } | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.repo, "org/idle-a");

    // Cooldown check ran exactly once against the picked repo.
    assertEquals(cooldownCalls, ["org/idle-a"]);
    // gh issue create was attempted.
    assert(findCreateCall(gh.calls) !== null);
  },
);

Deno.test(
  "maybe-file-idle-task - all monitored repos inside cooldown emit reason=all_repos_cooled_down (Issue #2105)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const labelCalls: string[] = [];
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/cool-a,org/cool-b",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (repo: string) => {
            labelCalls.push(repo);
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          isRepoCooledDownFn: () => Promise.resolve(true),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as
      | { action: string; reason?: string; template?: string; repo?: string }
      | undefined;
    assertEquals(data?.action, "skipped");
    assertEquals(data?.reason, "all_repos_cooled_down");
    assertEquals(data?.template, TEST_TEMPLATE_NAME);
    // The summary is about the whole set, not one repo — `repo` is
    // intentionally absent from the data shape.
    assertEquals(data?.repo, undefined);

    // No label create, no milestone ensure, no gh issue create.
    assertEquals(labelCalls.length, 0);
    assertEquals(milestone.calls.length, 0);
    assertEquals(findCreateCall(gh.calls), null);

    // Per-repo skip lines were emitted for each cooled-down repo.
    const perRepoLines = log.filter((l) =>
      l.includes("action=skipped") && l.includes("reason=cooldown_active")
    );
    assertEquals(perRepoLines.length, 2);

    // The dedicated all-repos summary line is also emitted, and omits
    // the `repo=` field.
    const summaryLine = log.find((l) =>
      l.includes("action=skipped") &&
      l.includes("reason=all_repos_cooled_down")
    );
    assert(
      summaryLine !== undefined,
      "expected an all_repos_cooled_down summary log line",
    );
    assertStringIncludes(summaryLine!, `template=${TEST_TEMPLATE_NAME}`);
    assert(
      !summaryLine!.includes("repo="),
      "all_repos_cooled_down summary line must not include a repo field",
    );
  },
);

Deno.test(
  "maybe-file-idle-task - per-template cooldownHours override is threaded through to the gate (Issue #2105)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();
    const cooldownTemplate: IdleTaskTemplate = {
      ...testTemplate,
      name: "cooldown-override-template",
      cooldownHours: 6,
    };
    if (getTemplate("cooldown-override-template") === undefined) {
      registerTemplate(cooldownTemplate);
    }
    const observed: { name: string; cooldownHours: number | undefined }[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          isRepoCooledDownFn: (
            opts: { repo: string; template: IdleTaskTemplate },
          ) => {
            observed.push({
              name: opts.template.name,
              cooldownHours: opts.template.cooldownHours,
            });
            return Promise.resolve(false);
          },
          pickTemplateFn: () => cooldownTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    // The exact template instance — with its override — reached the
    // cooldown gate. End-to-end: the gate consumes the override via
    // `template.cooldownHours`, so passing the template through is
    // sufficient to honour it.
    assertEquals(observed, [
      { name: "cooldown-override-template", cooldownHours: 6 },
    ]);
  },
);

Deno.test(
  "maybe-file-idle-task - cooldown helper throw is treated as not cooled down with warn line (Issue #2105)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          isRepoCooledDownFn: () =>
            Promise.reject(new Error("gh cooldown probe exploded")),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    // Transient gh failure must not stall the filer — the gate degrades
    // to "not cooled down" and filing proceeds.
    assertEquals(result.success, true);
    const data = result.data as { action: string } | undefined;
    assertEquals(data?.action, "filed");

    // A warn line records the lookup failure for visibility.
    const warnLine = log.find((l) =>
      l.includes("action=warn") && l.includes("reason=cooldown_check_failed")
    );
    assert(warnLine !== undefined, "expected cooldown_check_failed warn line");
    assertStringIncludes(warnLine!, "gh cooldown probe exploded");
  },
);

Deno.test(
  "maybe-file-idle-task - cooldown gate runs after dedup and before busy (Issue #2105)",
  async () => {
    // Order check: when a repo has an open wrapper, the cooldown gate
    // must NOT be consulted — dedup short-circuits first. And the busy
    // check must NOT be consulted when the cooldown gate vetoes —
    // cooldown short-circuits before busy.
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();
    const cooldownCalls: string[] = [];
    const busyCalls: string[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/dup,org/cool",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: (o: { repo: string }) =>
            Promise.resolve(
              o.repo === "org/dup"
                ? ({
                  number: 1,
                  url: `https://github.com/${o.repo}/issues/1`,
                } as ExistingIdleTaskIssue)
                : null,
            ),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: (opts: { repo: string }) => {
            busyCalls.push(opts.repo);
            return Promise.resolve(false);
          },
          isRepoCooledDownFn: (opts: { repo: string }) => {
            cooldownCalls.push(opts.repo);
            return Promise.resolve(opts.repo === "org/cool");
          },
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          // Pin shuffle so repos visited in declared order [dup, cool].
          randomFn: () => 0.99,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; reason?: string } | undefined;
    assertEquals(data?.action, "skipped");
    // Cooldown wins over duplicate in the fall-through specificity
    // order (output_backlog > pending_results > approved_work_in_flight
    // > cooldown_active > duplicate).
    assertEquals(data?.reason, "cooldown_active");

    // Cooldown was NEVER consulted for the duplicate repo — dedup
    // short-circuited it.
    assertEquals(cooldownCalls, ["org/cool"]);
    // Busy was NEVER consulted at all — the cool repo short-circuited
    // before busy, and the dup repo short-circuited before cooldown.
    assertEquals(busyCalls, []);
    // No issue filed.
    assertEquals(findCreateCall(gh.calls), null);
  },
);

// ---------------------------------------------------------------------------
// Post-create label verification (Issue #2130)
// ---------------------------------------------------------------------------
//
// Production observed wrappers landing without the `idle-task` label
// (e.g. private-repo-19#180). When the label is missing, the wrapper is
// invisible to the priority queue and the cross-repo dedup, so the
// worker keeps idling. After every successful `gh issue create`,
// `maybe-file-idle-task` now fetches the new issue's labels and
// re-applies `idle-task` via `addLabelToIssue` if missing. The outcome
// is reported on the existing structured progress log via a new
// `verification=ok|reapplied|failed` field.

Deno.test(
  "maybe-file-idle-task - verification re-applies idle-task label when post-create view reports empty labels (Issue #2130)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(11);
    const verifyCalls: { repo: string; issueNumber: number }[] = [];
    const addLabelCalls: {
      repo: string;
      issueNumber: number;
      label: string;
    }[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-20T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
          verifyLabelsFn: (repo: string, issueNumber: number) => {
            verifyCalls.push({ repo, issueNumber });
            // Simulate the broken-create symptom: gh issue create
            // returned, but the new issue has no labels.
            return Promise.resolve([] as string[]);
          },
          addLabelFn: (repo: string, issueNumber: number, label: string) => {
            addLabelCalls.push({ repo, issueNumber, label });
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; issueNumber?: number };
    assertEquals(data.action, "filed");
    assertEquals(data.issueNumber, 4242);

    // Verification fetched labels for the new issue and the re-apply
    // hook ran exactly once with the picked repo + parsed issue number
    // + canonical `idle-task` label.
    assertEquals(verifyCalls, [{ repo: "org/idle-a", issueNumber: 4242 }]);
    assertEquals(addLabelCalls, [
      { repo: "org/idle-a", issueNumber: 4242, label: "idle-task" },
    ]);

    // Structured progress log carries `verification=reapplied`.
    const filedLine = log.find((l) => l.includes("action=filed"));
    assert(filedLine !== undefined, "expected an action=filed log line");
    assertStringIncludes(filedLine!, "verification=reapplied");
  },
);

Deno.test(
  "maybe-file-idle-task - verification skips re-apply when post-create view confirms idle-task label is present (Issue #2130)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(12);
    const addLabelCalls: number[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-20T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
          // The post-create view sees the label — the happy path.
          verifyLabelsFn: (_repo: string, _issueNumber: number) =>
            Promise.resolve(["idle-task"] as string[]),
          addLabelFn: (
            _repo: string,
            issueNumber: number,
            _label: string,
          ) => {
            addLabelCalls.push(issueNumber);
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string };
    assertEquals(data.action, "filed");

    // No re-apply when the label is already present.
    assertEquals(addLabelCalls, []);

    // Structured progress log carries `verification=ok`.
    const filedLine = log.find((l) => l.includes("action=filed"));
    assert(filedLine !== undefined, "expected an action=filed log line");
    assertStringIncludes(filedLine!, "verification=ok");
  },
);

Deno.test(
  "maybe-file-idle-task - verification failure is logged but action=filed is still reported (Issue #2130)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(13);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-20T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
          // Label missing AND the re-apply itself fails.
          verifyLabelsFn: () => Promise.resolve([] as string[]),
          addLabelFn: (
            _repo: string,
            _issueNumber: number,
            _label: string,
          ) =>
            Promise.resolve(
              {
                ok: false,
                error: new Error("REST+CLI both refused"),
              } as Result<void>,
            ),
          // Issue #2137 — inject a no-op sleep so the retry backoff
          // does not slow this regression test down.
          sleepFn: () => Promise.resolve(),
        },
      },
      config,
    );

    // Issue still exists — action=filed must still be reported. The
    // label needs human attention but raising an error would lose the
    // filed wrapper, which is worse than a labelled-but-noisy success.
    assertEquals(result.success, true);
    const data = result.data as { action: string; issueNumber?: number };
    assertEquals(data.action, "filed");
    assertEquals(data.issueNumber, 4242);

    // Structured progress log carries `verification=failed
    // reason=<msg>`.
    const filedLine = log.find((l) => l.includes("action=filed"));
    assert(filedLine !== undefined, "expected an action=filed log line");
    assertStringIncludes(filedLine!, "verification=failed");
    assertStringIncludes(filedLine!, "REST+CLI both refused");
  },
);

// ---------------------------------------------------------------------------
// Retry-with-backoff for the re-apply hook (Issue #2137)
// ---------------------------------------------------------------------------
//
// Exhibit B: stSoftwareAU/private-repo-19#182 landed unlabelled after PR
// #2130's single-shot re-apply hit a transient REST+CLI failure. The
// fix retries `addLabelFn` up to REAPPLY_MAX_ATTEMPTS times with
// REAPPLY_BACKOFF_MS between attempts, and emits a loud
// `ALERT severity=error` line carrying the issue URL when every
// attempt fails so the regression is caught immediately.

Deno.test(
  "maybe-file-idle-task - retry succeeds on second attempt and emits verification=reapplied (Issue #2137)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(14);
    const sleepCalls: number[] = [];
    const addLabelCalls: number[] = [];

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-21T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
          verifyLabelsFn: () => Promise.resolve([] as string[]),
          addLabelFn: (
            _repo: string,
            _issueNumber: number,
            _label: string,
          ) => {
            addLabelCalls.push(addLabelCalls.length + 1);
            // First attempt: transient failure. Second attempt: success.
            if (addLabelCalls.length === 1) {
              return Promise.resolve(
                {
                  ok: false,
                  error: new Error("transient REST 503"),
                } as Result<void>,
              );
            }
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
          sleepFn: (ms: number) => {
            sleepCalls.push(ms);
            return Promise.resolve();
          },
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string; issueNumber?: number };
    assertEquals(data.action, "filed");
    assertEquals(data.issueNumber, 4242);

    // Two re-apply attempts, with a single sleep between them.
    assertEquals(addLabelCalls.length, 2);
    assertEquals(sleepCalls.length, 1);
    assert(sleepCalls[0]! > 0, "expected a positive backoff delay");

    // First-attempt failure was logged as a `warn` line so operators
    // can see the retry happened.
    const warnLine = log.find((l) =>
      l.includes("reason=reapply_attempt_failed") && l.includes("attempt=1")
    );
    assert(
      warnLine !== undefined,
      "expected a reapply_attempt_failed warn line",
    );
    assertStringIncludes(warnLine!, "transient REST 503");

    // Structured progress log reports the eventual success.
    const filedLine = log.find((l) => l.includes("action=filed"));
    assert(filedLine !== undefined, "expected an action=filed log line");
    assertStringIncludes(filedLine!, "verification=reapplied");

    // No ALERT line — the re-apply succeeded.
    assertEquals(
      log.find((l) => l.includes("ALERT")),
      undefined,
      "no ALERT line expected on eventual success",
    );
  },
);

Deno.test(
  "maybe-file-idle-task - retry exhausted emits a loud ALERT with the issue URL (Issue #2137)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(15);
    const sleepCalls: number[] = [];
    let addLabelCallCount = 0;

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-21T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
          verifyLabelsFn: () => Promise.resolve([] as string[]),
          addLabelFn: () => {
            addLabelCallCount++;
            return Promise.resolve(
              {
                ok: false,
                error: new Error("REST+CLI both refused"),
              } as Result<void>,
            );
          },
          sleepFn: (ms: number) => {
            sleepCalls.push(ms);
            return Promise.resolve();
          },
        },
      },
      config,
    );

    // The wrapper is still on GitHub, so the run must still succeed.
    assertEquals(result.success, true);
    const data = result.data as { action: string; issueNumber?: number };
    assertEquals(data.action, "filed");
    assertEquals(data.issueNumber, 4242);

    // All three attempts were tried, with two backoffs between them
    // (no leading sleep before attempt 1).
    assertEquals(addLabelCallCount, 3);
    assertEquals(sleepCalls.length, 2);

    // Structured progress log carries `verification=failed`.
    const filedLine = log.find((l) => l.includes("action=filed"));
    assert(filedLine !== undefined, "expected an action=filed log line");
    assertStringIncludes(filedLine!, "verification=failed");
    assertStringIncludes(filedLine!, "REST+CLI both refused");

    // Loud ALERT line carries the issue URL, severity=error, and the
    // explanatory tail so a regression is caught early.
    const alertLine = log.find((l) => l.includes("[idle-task] ALERT"));
    assert(
      alertLine !== undefined,
      "expected a loud ALERT line on terminal verification failure",
    );
    assertStringIncludes(alertLine!, "severity=error");
    assertStringIncludes(alertLine!, "action=verification_failed");
    assertStringIncludes(
      alertLine!,
      "url=https://github.com/org/idle-a/issues/4242",
    );
    assertStringIncludes(alertLine!, "attempts=3");
    assertStringIncludes(alertLine!, "REST+CLI both refused");
    assertStringIncludes(alertLine!, "will NOT be picked up");
  },
);

Deno.test(
  "maybe-file-idle-task - verify=ok skips the re-apply path entirely (Issue #2137 regression guard)",
  async () => {
    // Pinning the happy path with explicit sleep + addLabel injectors
    // to guard against any future change leaking a backoff into the
    // success path.
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(16);
    const sleepCalls: number[] = [];
    let addLabelCallCount = 0;

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => testTemplate,
          nowFn: () => new Date("2026-05-21T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          ensureMilestoneFn: milestone.fn,
          verifyLabelsFn: () => Promise.resolve(["idle-task"] as string[]),
          addLabelFn: () => {
            addLabelCallCount++;
            return Promise.resolve(
              { ok: true, value: undefined } as Result<void>,
            );
          },
          sleepFn: (ms: number) => {
            sleepCalls.push(ms);
            return Promise.resolve();
          },
        },
      },
      config,
    );

    assertEquals(result.success, true);
    assertEquals(addLabelCallCount, 0);
    assertEquals(sleepCalls, []);
    const filedLine = log.find((l) => l.includes("action=filed"));
    assert(filedLine !== undefined);
    assertStringIncludes(filedLine!, "verification=ok");
  },
);

// ---------------------------------------------------------------------------
// 50/50 random template dispatch (Issue #2149)
// ---------------------------------------------------------------------------
//
// With both `security-scan` and `best-practices` templates registered,
// the default picker must select uniformly at random between them. When
// only one template is registered the picker must always pick that one.

/**
 * Minimal LCG so the distribution test has a deterministic RNG without
 * pulling in an external dependency. Park-Miller-style parameters; the
 * absolute uniformity is not important — only that the seed pins the
 * draw sequence reproducibly across runs.
 */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function makeTemplate(name: string): IdleTaskTemplate {
  return {
    name,
    description: `Test template ${name}`,
    buildIssueTitle: () => `Run ${name}`,
    buildIssueBody: () => `# ${name}`,
    runTask: () => Promise.resolve({ ok: true, summary: `${name} ran` }),
  };
}

Deno.test(
  "defaultPickTemplate - uniform random over 10000 picks with two templates is ~50/50 within tolerance (Issue #2149)",
  () => {
    const a = makeTemplate("template-a");
    const b = makeTemplate("template-b");
    const rng = seededRng(42);

    let countA = 0;
    let countB = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const pick = defaultPickTemplate([a, b], rng);
      assert(
        pick !== null,
        "picker should never return null when templates exist",
      );
      if (pick === a) countA++;
      else if (pick === b) countB++;
      else throw new Error(`unexpected template returned: ${pick?.name}`);
    }

    // Both templates participate.
    assert(
      countA > 0 && countB > 0,
      "both templates must be picked at least once",
    );

    // Tolerance: ±2.5% of the expected 50% over 10 000 draws.
    // sqrt(N * 0.25) ≈ 50, so a 5σ band is ~250 draws → 2.5%.
    const ratioA = countA / N;
    const ratioB = countB / N;
    assert(
      Math.abs(ratioA - 0.5) < 0.025,
      `template-a ratio ${ratioA} drifted outside 50% ±2.5%`,
    );
    assert(
      Math.abs(ratioB - 0.5) < 0.025,
      `template-b ratio ${ratioB} drifted outside 50% ±2.5%`,
    );
  },
);

Deno.test(
  "defaultPickTemplate - single registered template is always picked (Issue #2149)",
  () => {
    const solo = makeTemplate("solo-template");
    const rng = seededRng(7);
    for (let i = 0; i < 100; i++) {
      assertEquals(
        defaultPickTemplate([solo], rng),
        solo,
        "lone template must always be picked",
      );
    }
  },
);

Deno.test(
  "defaultPickTemplate - empty registry returns null (Issue #2149)",
  () => {
    assertEquals(defaultPickTemplate([], () => 0.5), null);
  },
);

Deno.test(
  "defaultPickTemplate - clamps when rand() returns exactly 1.0 (Issue #2149)",
  () => {
    // Defensive: some injected RNG sources may return 1.0 inclusive.
    // The picker must clamp to a valid index rather than overflowing.
    const a = makeTemplate("a");
    const b = makeTemplate("b");
    const pick = defaultPickTemplate([a, b], () => 1.0);
    assert(pick !== null);
    assertEquals(pick.name, "b");
  },
);

// ---------------------------------------------------------------------------
// Weighted template draw (Issue #2401)
// ---------------------------------------------------------------------------

Deno.test(
  "weightedPickTemplate - empty registry returns null (Issue #2401)",
  () => {
    assertEquals(weightedPickTemplate([], { "a": 3 }, () => 0.5), null);
  },
);

Deno.test(
  "weightedPickTemplate - absent weights fall back to uniform (Issue #2401)",
  () => {
    // An empty weights map must behave exactly like the uniform picker,
    // including the same pinned-RNG index mapping (no behaviour change).
    const a = makeTemplate("template-a");
    const b = makeTemplate("template-b");
    const c = makeTemplate("template-c");
    for (let seed = 1; seed <= 20; seed++) {
      const weighted = weightedPickTemplate([a, b, c], {}, seededRng(seed));
      const uniform = defaultPickTemplate([a, b, c], seededRng(seed));
      assertEquals(
        weighted?.name,
        uniform?.name,
        `seed ${seed}: empty weights must match uniform pick`,
      );
    }
  },
);

Deno.test(
  "weightedPickTemplate - all-zero weights fall back to uniform (Issue #2401)",
  () => {
    const a = makeTemplate("template-a");
    const b = makeTemplate("template-b");
    const weights = { "template-a": 0, "template-b": 0 };
    for (let seed = 1; seed <= 20; seed++) {
      const weighted = weightedPickTemplate([a, b], weights, seededRng(seed));
      const uniform = defaultPickTemplate([a, b], seededRng(seed));
      assertEquals(
        weighted?.name,
        uniform?.name,
        `seed ${seed}: all-zero weights must match uniform pick`,
      );
    }
  },
);

Deno.test(
  "weightedPickTemplate - negative and non-finite weights fall back to uniform (Issue #2401)",
  () => {
    const a = makeTemplate("template-a");
    const b = makeTemplate("template-b");
    // -1, NaN, Infinity are all non-positive-or-non-finite → no positive
    // weight, so the picker must use the uniform path.
    const weights = { "template-a": -1, "template-b": Number.NaN };
    for (let seed = 1; seed <= 10; seed++) {
      const weighted = weightedPickTemplate([a, b], weights, seededRng(seed));
      const uniform = defaultPickTemplate([a, b], seededRng(seed));
      assertEquals(weighted?.name, uniform?.name, `seed ${seed}`);
    }
  },
);

Deno.test(
  "weightedPickTemplate - honours a 3:1 weighting within tolerance (Issue #2401)",
  () => {
    const a = makeTemplate("template-a");
    const b = makeTemplate("template-b");
    const weights = { "template-a": 3, "template-b": 1 };
    const rng = seededRng(42);

    let countA = 0;
    let countB = 0;
    const N = 10_000;
    for (let i = 0; i < N; i++) {
      const pick = weightedPickTemplate([a, b], weights, rng);
      assert(pick !== null);
      if (pick === a) countA++;
      else if (pick === b) countB++;
      else throw new Error(`unexpected template returned: ${pick?.name}`);
    }

    assert(countA > 0 && countB > 0, "both templates must be picked");
    // Expected 75% / 25%. Tolerance ±2.5%.
    const ratioA = countA / N;
    assert(
      Math.abs(ratioA - 0.75) < 0.025,
      `template-a ratio ${ratioA} drifted outside 75% ±2.5%`,
    );
  },
);

Deno.test(
  "weightedPickTemplate - templates absent from a partial map keep baseline weight 1 (Issue #2401)",
  () => {
    // Only `template-a` is boosted (weight 4); the other two are absent
    // and must each take the baseline weight of 1, giving a 4:1:1 split.
    const a = makeTemplate("template-a");
    const b = makeTemplate("template-b");
    const c = makeTemplate("template-c");
    const weights = { "template-a": 4 };
    const rng = seededRng(99);

    let countA = 0;
    let countB = 0;
    let countC = 0;
    const N = 12_000;
    for (let i = 0; i < N; i++) {
      const pick = weightedPickTemplate([a, b, c], weights, rng);
      assert(pick !== null);
      if (pick === a) countA++;
      else if (pick === b) countB++;
      else countC++;
    }

    // Absent templates must still participate (not be excluded).
    assert(countB > 0 && countC > 0, "baseline templates must be picked");
    // Expected a = 4/6 ≈ 0.667; b and c ≈ 1/6 ≈ 0.167 each.
    assert(
      Math.abs(countA / N - 4 / 6) < 0.025,
      `template-a ratio ${countA / N} drifted outside 66.7% ±2.5%`,
    );
  },
);

Deno.test(
  "weightedPickTemplate - a single registered template is always picked (Issue #2401)",
  () => {
    const solo = makeTemplate("solo");
    const rng = seededRng(5);
    for (let i = 0; i < 50; i++) {
      assertEquals(weightedPickTemplate([solo], { "solo": 9 }, rng), solo);
    }
  },
);

Deno.test(
  "maybe-file-idle-task - seeded randomFn drives a 50/50 split between two registered templates (Issue #2149)",
  async () => {
    // End-to-end check: with two registered templates, no override of
    // pickTemplateFn, and a seeded randomFn, the command picks each
    // template roughly 50% of the time.
    const config = buildDefaultWorkerConfig();
    const tplA = makeTemplate("dispatch-a");
    const tplB = makeTemplate("dispatch-b");
    // Override listTemplates indirectly via a custom pickTemplateFn that
    // delegates to defaultPickTemplate over a fixed pair — keeps the
    // test isolated from whatever production templates happen to be
    // registered.
    const rng = seededRng(1);
    const picks: string[] = [];

    const N = 200;
    for (let i = 0; i < N; i++) {
      const gh = makeMockGh();
      const milestone = makeMilestoneStub();
      const result = await maybeFileIdleTaskCommand.execute(
        {
          "monitored-repos": "org/idle-a",
          "github-user": "VibeBot",
          __testDeps: {
            findExistingFn: () => Promise.resolve(null),
            ensureLabelFn: () =>
              Promise.resolve({ ok: true, value: undefined } as Result<void>),
            ghCommandFn: gh.fn,
            isRepoBusyFn: () => Promise.resolve(false),
            // Use defaultPickTemplate against a fixed pair so this test
            // does not depend on the production registry.
            pickTemplateFn: (_templates: IdleTaskTemplate[]) => {
              // Ignore the registry input; pin the pair under test.
              return defaultPickTemplate([tplA, tplB], rng);
            },
            nowFn: () => new Date("2026-05-22T00:00:00.000Z"),
            log: () => {},
            ensureMilestoneFn: milestone.fn,
          },
        },
        config,
      );
      assertEquals(result.success, true);
      const data = result.data as { template?: string } | undefined;
      assert(data?.template !== undefined);
      picks.push(data.template);
    }

    const countA = picks.filter((p) => p === "dispatch-a").length;
    const countB = picks.filter((p) => p === "dispatch-b").length;
    assert(countA > 0 && countB > 0, "both templates must be picked");
    const ratioA = countA / N;
    // Looser tolerance for the smaller sample — ±15% from 50%.
    assert(
      Math.abs(ratioA - 0.5) < 0.15,
      `template-a end-to-end ratio ${ratioA} drifted outside 50% ±15%`,
    );
  },
);

Deno.test(
  "maybe-file-idle-task - existing security-scan-only behaviour preserved when only one template registered (Issue #2149)",
  async () => {
    // Regression guard: when the production code path runs and only a
    // single template is in the eligible set (e.g. an installation that
    // disabled best-practices, or the original security-scan-only
    // deployment), the picker must always return that template. We
    // simulate this by injecting a pickTemplateFn that constrains the
    // candidate set to one entry and uses defaultPickTemplate.
    const config = buildDefaultWorkerConfig();
    const onlySecurityScan = makeTemplate("security-scan-only-test");
    const rng = seededRng(99);

    for (let i = 0; i < 50; i++) {
      const gh = makeMockGh();
      const milestone = makeMilestoneStub();
      const result = await maybeFileIdleTaskCommand.execute(
        {
          "monitored-repos": "org/idle-a",
          "github-user": "VibeBot",
          __testDeps: {
            findExistingFn: () => Promise.resolve(null),
            ensureLabelFn: () =>
              Promise.resolve({ ok: true, value: undefined } as Result<void>),
            ghCommandFn: gh.fn,
            isRepoBusyFn: () => Promise.resolve(false),
            pickTemplateFn: () => defaultPickTemplate([onlySecurityScan], rng),
            nowFn: () => new Date("2026-05-22T00:00:00.000Z"),
            log: () => {},
            ensureMilestoneFn: milestone.fn,
          },
        },
        config,
      );
      assertEquals(result.success, true);
      const data = result.data as { template?: string } | undefined;
      assertEquals(data?.template, "security-scan-only-test");
    }
  },
);

Deno.test(
  "maybe-file-idle-task - config idleTaskTemplateWeights biases the draw toward the weighted template (Issue #2401)",
  async () => {
    // End-to-end: with NO pickTemplateFn override, the command's default
    // wiring uses `weightedPickTemplate(listTemplates(), config
    // .idleTaskTemplateWeights, randomFn)`. Heavily weight the registered
    // test template so it dominates the live registry; every other
    // registered template keeps its baseline weight of 1. The filed
    // template must be the boosted one in the overwhelming majority of
    // runs, proving the config weight reaches the picker.
    const config = buildDefaultWorkerConfig({
      idleTaskTemplateWeights: { [TEST_TEMPLATE_NAME]: 1000 },
    });
    const rng = seededRng(2401);
    const picks: string[] = [];

    const N = 60;
    for (let i = 0; i < N; i++) {
      const gh = makeMockGh();
      const milestone = makeMilestoneStub();
      const result = await maybeFileIdleTaskCommand.execute(
        {
          "monitored-repos": "org/idle-a",
          "github-user": "VibeBot",
          __testDeps: {
            findExistingFn: () => Promise.resolve(null),
            ensureLabelFn: () =>
              Promise.resolve({ ok: true, value: undefined } as Result<void>),
            ghCommandFn: gh.fn,
            isRepoBusyFn: () => Promise.resolve(false),
            // No pickTemplateFn — exercise the production default that
            // reads config.idleTaskTemplateWeights.
            randomFn: rng,
            nowFn: () => new Date("2026-05-22T00:00:00.000Z"),
            log: () => {},
            ensureMilestoneFn: milestone.fn,
            // No pickTemplateFn, so the draw can land on a production
            // template — name the checkout its body reads from (Issue #1024).
            rootDir: REPO_ROOT,
          },
        },
        config,
      );
      assertEquals(result.success, true);
      const data = result.data as { template?: string } | undefined;
      if (data?.template !== undefined) picks.push(data.template);
    }

    const weighted = picks.filter((p) => p === TEST_TEMPLATE_NAME).length;
    // Expected ratio ≈ 1000 / (1000 + baseline weights of the other
    // registered templates) — comfortably above 80% even with a handful
    // of production templates registered.
    assert(
      weighted >= Math.floor(N * 0.8),
      `weighted template picked ${weighted}/${N} times — expected the strong majority`,
    );
  },
);

// ---------------------------------------------------------------------------
// Per-gate distinct skip logging — Issue #2475
// ---------------------------------------------------------------------------
//
// Every skipped repo must show its single deciding gate in the structured
// log, so an operator can tell at a glance which gate (cooldown / busy /
// backlog / shouldFile) vetoed each repo. This template declares both an
// `outputLabel` (so the backlog gate applies) and a `shouldFile` veto (so
// the pending-results gate applies), letting one run exercise all four
// gates across four repos.

const MULTI_GATE_TEMPLATE_NAME = "multi-gate-test-template";

const multiGateTemplate: IdleTaskTemplate = {
  ...testTemplate,
  name: MULTI_GATE_TEMPLATE_NAME,
  outputLabel: "multi-gate-output",
  // Veto filing only for the dedicated pending-results repo.
  shouldFile: (opts: { repo: string }) =>
    Promise.resolve(opts.repo !== "org/pending"),
};

if (getTemplate(MULTI_GATE_TEMPLATE_NAME) === undefined) {
  registerTemplate(multiGateTemplate);
}

Deno.test(
  "maybe-file-idle-task - skipped repos each log their single deciding gate distinctly (Issue #2475)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub();

    // Four repos, each vetoed by a different gate: cooldown, busy,
    // backlog, and shouldFile (pending results). No repo is eligible, so
    // the command skips overall — but every repo must emit its own
    // distinct per-gate skip line.
    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/cool,org/busy,org/backlog,org/pending",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: () => Promise.resolve(null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoCooledDownFn: (opts: { repo: string }) =>
            Promise.resolve(opts.repo === "org/cool"),
          isRepoBusyFn: (opts: { repo: string }) =>
            Promise.resolve(opts.repo === "org/busy"),
          countOutputLabelOpenIssuesFn: (opts: { repo: string }) =>
            Promise.resolve(
              opts.repo === "org/backlog" ? BACKLOG_THRESHOLD : 0,
            ),
          pickTemplateFn: () => multiGateTemplate,
          nowFn: () => new Date("2026-05-18T00:00:00.000Z"),
          log: (line: string) => log.push(line),
          // Pin the shuffle so all four repos are visited (the order does
          // not matter for this assertion — each repo hits its own gate).
          randomFn: () => 0,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);
    const data = result.data as { action: string } | undefined;
    assertEquals(data?.action, "skipped");
    // Nothing was filed — every repo was vetoed.
    assertEquals(findCreateCall(gh.calls), null);

    // Each repo emitted exactly one per-gate skip line naming its repo
    // and its deciding reason — distinctly, not as an aggregate.
    const cooldownLine = log.find((l) =>
      l.includes("repo=org/cool") &&
      l.includes("action=skipped") &&
      l.includes("reason=cooldown_active")
    );
    const busyLine = log.find((l) =>
      l.includes("repo=org/busy") &&
      l.includes("action=skipped") &&
      l.includes("reason=approved_work_in_flight")
    );
    const backlogLine = log.find((l) =>
      l.includes("repo=org/backlog") &&
      l.includes("action=skipped") &&
      l.includes("reason=output_backlog")
    );
    const pendingLine = log.find((l) =>
      l.includes("repo=org/pending") &&
      l.includes("action=skipped") &&
      l.includes("reason=pending_results")
    );

    assert(
      cooldownLine !== undefined,
      "expected a cooldown_active line for org/cool",
    );
    assert(
      busyLine !== undefined,
      "expected an approved_work_in_flight line for org/busy",
    );
    assert(
      backlogLine !== undefined,
      "expected an output_backlog line for org/backlog",
    );
    assert(
      pendingLine !== undefined,
      "expected a pending_results line for org/pending",
    );

    // The four deciding reasons are genuinely distinct.
    const reasons = new Set([
      "cooldown_active",
      "approved_work_in_flight",
      "output_backlog",
      "pending_results",
    ]);
    assertEquals(reasons.size, 4);
  },
);

// ---------------------------------------------------------------------------
// GitHub issue-body limit (Issue #3634)
// ---------------------------------------------------------------------------

/**
 * Test-only template whose body exceeds GitHub's 65,536-character ceiling —
 * the shape the production `security-scan` preview grew into, which made
 * `gh issue create` fail with "Body is too long".
 */
const OVERSIZED_TEMPLATE_NAME = "maybe-file-oversized-template";

const oversizedTemplate: IdleTaskTemplate = {
  name: OVERSIZED_TEMPLATE_NAME,
  description: "Test-only template with an over-limit wrapper body.",
  buildIssueTitle: (repo) => `Run ${OVERSIZED_TEMPLATE_NAME} on ${repo}`,
  buildIssueBody: (opts) =>
    `# ${OVERSIZED_TEMPLATE_NAME} on ${opts.repo}\n\n` +
    "padding line to grow the body\n".repeat(4_000),
  runTask: (_opts) =>
    Promise.resolve({ ok: true, summary: `${OVERSIZED_TEMPLATE_NAME} ran` }),
};

if (getTemplate(OVERSIZED_TEMPLATE_NAME) === undefined) {
  registerTemplate(oversizedTemplate);
}

Deno.test(
  "maybe-file-idle-task - clamps an over-limit wrapper body and logs the drop (Issue #3634)",
  async () => {
    const config = buildDefaultWorkerConfig();
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(17);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a",
        "github-user": "VibeBot",
        __testDeps: {
          findExistingFn: (_o: { repo: string }) =>
            Promise.resolve(null as ExistingIdleTaskIssue | null),
          ensureLabelFn: (_repo: string) =>
            Promise.resolve({ ok: true, value: undefined } as Result<void>),
          ghCommandFn: gh.fn,
          isRepoBusyFn: () => Promise.resolve(false),
          pickTemplateFn: () => oversizedTemplate,
          nowFn: () => new Date("2026-05-14T01:02:03.000Z"),
          log: (line: string) => log.push(line),
          randomFn: () => 0.99,
          ensureMilestoneFn: milestone.fn,
        },
      },
      config,
    );

    assertEquals(result.success, true);

    const createCall = findCreateCall(gh.calls);
    assert(createCall !== null, "expected gh issue create call");
    const bodyIdx = createCall!.args.indexOf("--body");
    const body = createCall!.args[bodyIdx + 1] ?? "";

    assert(
      body.length <= GITHUB_ISSUE_BODY_MAX_CHARS,
      `filed body is ${body.length} characters, over GitHub's limit`,
    );
    // The clamp keeps the head and the run-id tail, and never hides the drop.
    assertStringIncludes(body, OVERSIZED_TEMPLATE_NAME);
    assertStringIncludes(body, "run-id:");
    assertStringIncludes(body, IDLE_TASK_BODY_TRUNCATION_MARKER);
    assert(
      log.some((l) => l.includes("action=truncated_body")),
      "expected a loud truncated_body log line",
    );
  },
);

// ---------------------------------------------------------------------------
// Cadence bias — Issue #4009
// ---------------------------------------------------------------------------
//
// The filer prefers an overdue (repo, template) pair over the random draw,
// but only when that pair clears every existing gate. These tests pin an RNG
// that would otherwise choose a different template *and* a different repo, so
// a biased pick is unambiguous.

const BIAS_TEMPLATE_NAME = "maybe-file-bias-template";
const BIAS_TEMPLATE_TWO_NAME = "maybe-file-bias-template-two";
const FALLBACK_TEMPLATE_NAME = "maybe-file-fallback-template";

function makeBiasTemplate(name: string): IdleTaskTemplate {
  return {
    name,
    description: `Test-only cadence-bias template (${name}).`,
    buildIssueTitle: (repo) => `Run ${name} on ${repo}`,
    buildIssueBody: (opts) => `# ${name} on ${opts.repo}`,
    runTask: (_opts) => Promise.resolve({ ok: true, summary: `${name} ran` }),
  };
}

const biasTemplate = makeBiasTemplate(BIAS_TEMPLATE_NAME);
const biasTemplateTwo = makeBiasTemplate(BIAS_TEMPLATE_TWO_NAME);
const fallbackTemplate = makeBiasTemplate(FALLBACK_TEMPLATE_NAME);

for (const t of [biasTemplate, biasTemplateTwo, fallbackTemplate]) {
  if (getTemplate(t.name) === undefined) registerTemplate(t);
}

/** Three repos; `randomFn: () => 0.99` leaves the order untouched. */
const BIAS_REPOS = "org/idle-a,org/idle-b,org/idle-c";

function biasDeps(overrides: Record<string, unknown>) {
  return {
    findExistingFn: (_o: { repo: string }) =>
      Promise.resolve(null as ExistingIdleTaskIssue | null),
    ensureLabelFn: (_repo: string) =>
      Promise.resolve({ ok: true, value: undefined } as Result<void>),
    isRepoBusyFn: () => Promise.resolve(false),
    isRepoCooledDownFn: () => Promise.resolve(false),
    // Without the bias the random path would file the fallback template into
    // the first repo — a different pair on both axes.
    pickTemplateFn: () => fallbackTemplate,
    nowFn: () => new Date("2026-06-15T00:00:00.000Z"),
    randomFn: () => 0.99,
    ...overrides,
  };
}

Deno.test(
  "maybe-file-idle-task - an overdue pair with green gates beats the pinned random pick (Issue #4009)",
  async () => {
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(21);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": BIAS_REPOS,
        "github-user": "VibeBot",
        __testDeps: biasDeps({
          ghCommandFn: gh.fn,
          ensureMilestoneFn: milestone.fn,
          log: (line: string) => log.push(line),
          dueScansFn: () =>
            Promise.resolve([{
              repo: "org/idle-c",
              template: BIAS_TEMPLATE_NAME,
              tier: "fable",
              overdueDays: 12.34,
            }] as DueScan[]),
        }),
      },
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true);
    const data = result.data as
      | {
        action?: string;
        template?: string;
        repo?: string;
        tier?: string;
        biased?: boolean;
      }
      | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.template, BIAS_TEMPLATE_NAME);
    assertEquals(data?.repo, "org/idle-c");
    assertEquals(data?.tier, "fable");
    assertEquals(data?.biased, true);

    const biasLine = log.find((l) => l.includes("action=bias "));
    assert(biasLine !== undefined, "expected an action=bias log line");
    assertStringIncludes(biasLine!, `template=${BIAS_TEMPLATE_NAME}`);
    assertStringIncludes(biasLine!, "repo=org/idle-c");
    assertStringIncludes(biasLine!, "tier=fable");
    assertStringIncludes(biasLine!, "overdue_days=12.3");
    assertStringIncludes(biasLine!, "source=cadence");

    // The wrapper really was filed for the biased pair, not just reported.
    const createCall = findCreateCall(gh.calls);
    assert(createCall !== null, "expected gh issue create call");
    const repoIdx = createCall!.args.indexOf("--repo");
    assertEquals(createCall!.args[repoIdx + 1], "org/idle-c");
  },
);

Deno.test(
  "maybe-file-idle-task - no overdue pairs leaves the pinned random pick untouched (Issue #4009)",
  async () => {
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(22);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": BIAS_REPOS,
        "github-user": "VibeBot",
        __testDeps: biasDeps({
          ghCommandFn: gh.fn,
          ensureMilestoneFn: milestone.fn,
          log: (line: string) => log.push(line),
          dueScansFn: () => Promise.resolve([] as DueScan[]),
        }),
      },
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true);
    const data = result.data as
      | { action?: string; template?: string; repo?: string; biased?: boolean }
      | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.template, FALLBACK_TEMPLATE_NAME);
    assertEquals(data?.repo, "org/idle-a");
    assertEquals(data?.biased, undefined);
    assert(
      log.some((l) => l.includes("action=bias_none reason=no_overdue_pairs")),
      "expected a bias_none line so an operator can tell a random tick from a biased one",
    );
  },
);

Deno.test(
  "maybe-file-idle-task - a throwing freshness lookup fails open to the random path (Issue #4009)",
  async () => {
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(23);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": BIAS_REPOS,
        "github-user": "VibeBot",
        __testDeps: biasDeps({
          ghCommandFn: gh.fn,
          ensureMilestoneFn: milestone.fn,
          log: (line: string) => log.push(line),
          dueScansFn: () => Promise.reject(new Error("gh history unreadable")),
        }),
      },
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true);
    const data = result.data as
      | { action?: string; template?: string; repo?: string }
      | undefined;
    assertEquals(
      data?.action,
      "filed",
      "a freshness failure must never surface as action=error",
    );
    assertEquals(data?.template, FALLBACK_TEMPLATE_NAME);
    assertEquals(data?.repo, "org/idle-a");
    const failLine = log.find((l) => l.includes("reason=freshness_failed"));
    assert(
      failLine !== undefined,
      "expected a bias_none freshness_failed line",
    );
    assertStringIncludes(failLine!, "action=bias_none");
    assertStringIncludes(failLine!, "gh history unreadable");
  },
);

Deno.test(
  "maybe-file-idle-task - gated overdue pairs are skipped in order, then the random path files (Issue #4009)",
  async () => {
    const gh = makeMockGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(24);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": BIAS_REPOS,
        "github-user": "VibeBot",
        __testDeps: biasDeps({
          ghCommandFn: gh.fn,
          ensureMilestoneFn: milestone.fn,
          log: (line: string) => log.push(line),
          // Repo B is inside its cooldown window; repo C already has
          // approved work queued. Repo A — the random path's pick — is free.
          isRepoCooledDownFn: (o: { repo: string }) =>
            Promise.resolve(o.repo === "org/idle-b"),
          isRepoBusyFn: (o: { repo: string }) =>
            Promise.resolve(o.repo === "org/idle-c"),
          dueScansFn: () =>
            Promise.resolve([
              {
                repo: "org/idle-b",
                template: BIAS_TEMPLATE_NAME,
                tier: "sonnet",
                overdueDays: 9,
              },
              {
                repo: "org/idle-c",
                template: BIAS_TEMPLATE_TWO_NAME,
                tier: "fable",
                overdueDays: 3,
              },
            ] as DueScan[]),
        }),
      },
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true);
    const data = result.data as
      | { action?: string; template?: string; repo?: string }
      | undefined;
    // Neither overdue pair was filed — the gates still hold — and the walk
    // fell through to the unchanged random path.
    assertEquals(data?.action, "filed");
    assertEquals(data?.template, FALLBACK_TEMPLATE_NAME);
    assertEquals(data?.repo, "org/idle-a");

    const skipped = log.filter((l) => l.includes("action=bias_skipped"));
    assertEquals(skipped.length, 2, "every gated pair must announce its gate");
    assertStringIncludes(skipped[0]!, "repo=org/idle-b");
    assertStringIncludes(skipped[0]!, "reason=cooldown_active");
    assertStringIncludes(skipped[1]!, "repo=org/idle-c");
    assertStringIncludes(skipped[1]!, "reason=approved_work_in_flight");
    assert(
      log.some((l) => l.includes("action=bias_none")),
      "expected a bias_none line once every overdue pair was gated out",
    );
  },
);

Deno.test(
  "maybe-file-idle-task - the freshness gh cost is bounded across consecutive ticks (Issue #4009)",
  async () => {
    resetDueScanCache();
    const repos = ["org/idle-a", "org/idle-b", "org/idle-c"];
    const historyCalls: string[][] = [];
    // Every important template scanned yesterday at the expensive tier, so
    // no pair is overdue and each tick falls through to the random path.
    const freshHistory = IMPORTANT_TEMPLATE_NAMES.map((name, i) => ({
      number: i + 1,
      title: `wrapper ${i + 1}`,
      body: buildAttributionFooter({
        template: name,
        runId: "vibe-test",
        model: "fable",
      }),
      closedAt: "2026-06-14T00:00:00.000Z",
    }));
    const ghFn = (args: string[]): Promise<string> => {
      if (args[0] === "issue" && args[1] === "list") {
        // Only the closed-wrapper history feeds the cadence lookup; the open
        // queries belong to the dedup and fleet gates.
        if (!args.includes("closed")) return Promise.resolve("[]");
        historyCalls.push([...args]);
        return Promise.resolve(JSON.stringify(freshHistory));
      }
      if (args[0] === "issue" && args[1] === "create") {
        return Promise.resolve("https://github.com/org/idle-a/issues/99");
      }
      return Promise.resolve("");
    };

    const TICKS = 4;
    for (let i = 0; i < TICKS; i++) {
      const milestone = makeMilestoneStub(25);
      const result = await maybeFileIdleTaskCommand.execute(
        {
          "monitored-repos": repos.join(","),
          "github-user": "VibeBot",
          __testDeps: biasDeps({
            ghCommandFn: ghFn,
            ensureMilestoneFn: milestone.fn,
            log: () => {},
            // No dueScansFn — exercise the production cached lookup.
          }),
        },
        buildDefaultWorkerConfig(),
      );
      assertEquals(result.success, true);
      const data = result.data as { template?: string } | undefined;
      assertEquals(
        data?.template,
        FALLBACK_TEMPLATE_NAME,
        "nothing is overdue, so every tick must file via the random path",
      );
    }

    assertEquals(
      historyCalls.length,
      repos.length,
      `${TICKS} ticks must cost one history read per repo, not ${TICKS} per repo`,
    );
  },
);
