/**
 * Tests for the opt-in filing gate on the filer and the wrapper sweep
 * (Issue #5096): the `test-audit` idle-task template is filed as automatic
 * idle work only when the owner's `.config.json` names it, or when an operator
 * names it through an explicit template allowlist.
 *
 * Covers:
 *   - maybe-file random pick — the picker is never offered `test-audit` under
 *     the default config, and is offered it once `idle_task_template_weights`
 *     or `idle_task_cadence.templates` names it;
 *   - maybe-file cadence bias — an overdue `test-audit` pair is not filed by
 *     the bias (`bias_skipped reason=opt_in_not_configured`), while an overdue
 *     `security-scan` pair is still biased and filed;
 *   - createAllIdleTaskWrappers — default deps exclude `test-audit` and log it
 *     as excluded; `authorisedOptInTemplates` seeds it without the requested
 *     marker; `templateNames` naming it seeds it with the marker as the final
 *     body line; an allowlist that does not name it leaves it out;
 *   - the `create-all-idle-task-wrappers` command, which passes the owner
 *     config into the sweep through the real default wiring.
 *
 * All dependencies are injected so the tests never touch the network.
 *
 * Australian English spelling used throughout (behaviour, authorise).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import { maybeFileIdleTaskCommand } from "../commands/maybe_file_idle_task.ts";
import { createAllIdleTaskWrappersCommand } from "../commands/create_all_idle_task_wrappers.ts";
import {
  createAllIdleTaskWrappers,
  type CreateAllIdleTaskWrappersDeps,
} from "../lib/create_all_idle_task_wrappers.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import type { DueScan } from "../lib/idle_task_cadence.ts";
import { GITHUB_ISSUE_BODY_MAX_CHARS } from "../lib/idle_task_body_limit.ts";
import type { ExistingIdleTaskIssue } from "../lib/idle_task_issue.ts";
import type { IdleTaskMilestone } from "../lib/idle_task_milestone.ts";
import {
  getTemplate,
  type IdleTaskTemplate,
  listTemplates,
  registerTemplate,
} from "../lib/idle_task_template.ts";
import {
  hasIdleTaskRequestedMarker,
  IDLE_TASK_REQUESTED_MARKER,
} from "../lib/idle_task_opt_in.ts";
import type { Result, WorkerConfig } from "../types.ts";
import { REPO_ROOT } from "./support/repo_root.ts";

const TEST_AUDIT_TITLE = "Run a test-audit scan";
const SECURITY_SCAN_TITLE = "Run a security scan";
const STABLE_NOW = new Date("2026-06-07T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GhCall {
  args: string[];
}

/** Collect every gh call; `issue create` answers with a URL, the rest with "". */
function makeGh() {
  const calls: GhCall[] = [];
  const fn = (args: string[]): Promise<string> => {
    calls.push({ args: [...args] });
    if (args[0] === "issue" && args[1] === "create") {
      return Promise.resolve("https://github.com/org/fresh/issues/5096\n");
    }
    // The open-wrapper census fails closed on anything but a JSON array.
    if (args[0] === "issue" && args[1] === "list") {
      return Promise.resolve("[]");
    }
    return Promise.resolve("");
  };
  return { fn, calls };
}

function makeMilestoneStub(number = 17) {
  const fn = (opts: { repo: string; template: string }) =>
    Promise.resolve(
      { number, title: `idle-task: ${opts.template}` } as IdleTaskMilestone,
    );
  return { fn };
}

function createCalls(calls: GhCall[]): GhCall[] {
  return calls.filter((c) => c.args[0] === "issue" && c.args[1] === "create");
}

function titleOf(call: GhCall): string {
  const i = call.args.indexOf("--title");
  return i >= 0 ? call.args[i + 1]! : "";
}

function bodyOf(call: GhCall): string {
  const i = call.args.indexOf("--body");
  return i >= 0 ? call.args[i + 1]! : "";
}

const labelOk = (): Promise<Result<void>> =>
  Promise.resolve({ ok: true, value: undefined } as Result<void>);

// ---------------------------------------------------------------------------
// Maybe-file fixtures
// ---------------------------------------------------------------------------

const OPT_IN_FALLBACK_NAME = "opt-in-filing-fallback-template";

const optInFallback: IdleTaskTemplate = {
  name: OPT_IN_FALLBACK_NAME,
  description: "Test-only fallback template for the Issue #5096 filer tests.",
  buildIssueTitle: (repo) => `Run ${OPT_IN_FALLBACK_NAME} on ${repo}`,
  buildIssueBody: (opts) => `# ${OPT_IN_FALLBACK_NAME} on ${opts.repo}`,
  runTask: (_opts) =>
    Promise.resolve({ ok: true, summary: `${OPT_IN_FALLBACK_NAME} ran` }),
};

if (getTemplate(OPT_IN_FALLBACK_NAME) === undefined) {
  registerTemplate(optInFallback);
}

/** Exercise the real weighted picker through the public filing command. */
async function filedTemplates(config: WorkerConfig): Promise<string[]> {
  const gh = makeGh();
  const result = await maybeFileIdleTaskCommand.execute({
    "monitored-repos": "org/idle-a,org/idle-b",
    "github-user": "VibeBot",
    __testDeps: {
      ghCommandFn: gh.fn,
      ensureLabelFn: labelOk,
      isRepoBusyFn: () => Promise.resolve(false),
      isRepoCooledDownFn: () => Promise.resolve(false),
      nowFn: () => STABLE_NOW,
      randomFn: () =>
        (listTemplates().findIndex((t) => t.name === "test-audit") + 0.5) /
        listTemplates().length,
      dueScansFn: () => Promise.resolve([]),
      log: (_line: string) => {},
    },
  }, config);
  assert(result.success, result.message);
  return createCalls(gh.calls).map(titleOf);
}

/** Gate stubs for the cadence-bias path; green everywhere, fallback random pick. */
function biasDeps(overrides: Record<string, unknown>) {
  return {
    findExistingFn: (_o: { repo: string }) =>
      Promise.resolve(null as ExistingIdleTaskIssue | null),
    ensureLabelFn: (_repo: string) => labelOk(),
    isRepoBusyFn: () => Promise.resolve(false),
    isRepoCooledDownFn: () => Promise.resolve(false),
    nowFn: () => new Date("2026-06-15T00:00:00.000Z"),
    randomFn: () => 0.99,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Maybe-file: random pick
// ---------------------------------------------------------------------------

Deno.test(
  "maybe-file-idle-task - default config never offers test-audit to the random picker (Issue #5096)",
  async () => {
    const offered = await filedTemplates(buildDefaultWorkerConfig());

    assertEquals(offered.length, 1);
    assert(!offered.includes("Run a test-audit scan"));
  },
);

Deno.test(
  "maybe-file-idle-task - a positive idle_task_template_weights entry offers test-audit (Issue #5096)",
  async () => {
    const base = buildDefaultWorkerConfig();
    const offered = await filedTemplates({
      ...base,
      idleTaskTemplateWeights: { "test-audit": 1 },
    });

    assertEquals(offered, ["Run a test-audit scan"]);
  },
);

Deno.test(
  "maybe-file-idle-task - an idle_task_cadence.templates entry offers test-audit (Issue #5096)",
  async () => {
    const base = buildDefaultWorkerConfig();
    const offered = await filedTemplates({
      ...base,
      idleTaskCadence: {
        ...base.idleTaskCadence,
        templates: {
          ...base.idleTaskCadence.templates,
          "test-audit": base.idleTaskCadence.templates["security-scan"]!,
        },
      },
    });

    assertEquals(offered, ["Run a test-audit scan"]);
  },
);

// ---------------------------------------------------------------------------
// Maybe-file: cadence bias
// ---------------------------------------------------------------------------

Deno.test(
  "maybe-file-idle-task - an overdue test-audit pair is not filed by the cadence bias under default config (Issue #5096)",
  async () => {
    const gh = makeGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(31);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: biasDeps({
          ghCommandFn: gh.fn,
          ensureMilestoneFn: milestone.fn,
          log: (line: string) => log.push(line),
          dueScansFn: () =>
            Promise.resolve([{
              repo: "org/idle-b",
              template: "test-audit",
              tier: "sonnet",
              overdueDays: 4,
            }] as DueScan[]),
        }),
      },
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true);
    assert(
      log.some((l) =>
        l.includes(
          "action=bias_skipped template=test-audit repo=org/idle-b reason=opt_in_not_configured",
        )
      ),
      "expected a bias_skipped opt_in_not_configured line",
    );
    const titles = createCalls(gh.calls).map(titleOf);
    assert(
      !titles.includes(TEST_AUDIT_TITLE),
      `no test-audit wrapper may be filed, titles: ${titles.join(" | ")}`,
    );
    // The random path still runs for the fallback template.
    const data = result.data as { template?: string } | undefined;
    assert(data?.template !== "test-audit");
    assertEquals(titles.length, 1);
  },
);

Deno.test(
  "maybe-file-idle-task - an overdue security-scan pair is still biased and filed (Issue #5096)",
  async () => {
    const gh = makeGh();
    const log: string[] = [];
    const milestone = makeMilestoneStub(32);

    const result = await maybeFileIdleTaskCommand.execute(
      {
        "monitored-repos": "org/idle-a,org/idle-b",
        "github-user": "VibeBot",
        __testDeps: biasDeps({
          ghCommandFn: gh.fn,
          ensureMilestoneFn: milestone.fn,
          log: (line: string) => log.push(line),
          dueScansFn: () =>
            Promise.resolve([{
              repo: "org/idle-b",
              template: "security-scan",
              tier: "sonnet",
              overdueDays: 3,
            }] as DueScan[]),
        }),
      },
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true);
    assert(
      log.some((l) =>
        l.includes("action=bias template=security-scan repo=org/idle-b")
      ),
      "expected the security-scan pair to be biased",
    );
    const data = result.data as
      | { action?: string; template?: string; repo?: string }
      | undefined;
    assertEquals(data?.action, "filed");
    assertEquals(data?.template, "security-scan");
    assertEquals(data?.repo, "org/idle-b");
    const titles = createCalls(gh.calls).map(titleOf);
    assert(
      titles.includes(SECURITY_SCAN_TITLE),
      `titles: ${titles.join(" | ")}`,
    );
  },
);

// ---------------------------------------------------------------------------
// createAllIdleTaskWrappers: opt-in gate
// ---------------------------------------------------------------------------

/** One clean-repo sweep against `org/fresh` with the given deps overridden. */
async function sweep(
  overrides: Partial<CreateAllIdleTaskWrappersDeps> = {},
) {
  const gh = makeGh();
  const logs: string[] = [];
  const result = await createAllIdleTaskWrappers("org/fresh", {
    ghCommandFn: gh.fn,
    ensureLabelFn: labelOk,
    findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
    nowFn: () => STABLE_NOW,
    rootDir: REPO_ROOT,
    runId: "vibe-test-aaaaaa",
    workerUser: "vibe-bot",
    log: (line: string) => logs.push(line),
    ...overrides,
  });
  return { result, creates: createCalls(gh.calls), logs };
}

Deno.test(
  "createAllIdleTaskWrappers - default deps do not seed test-audit and log it as excluded (Issue #5096)",
  async () => {
    const { result, creates, logs } = await sweep();

    assert(result.ok, "expected ok result");
    if (!result.ok) return;
    const titles = creates.map(titleOf);
    assert(
      !titles.includes(TEST_AUDIT_TITLE),
      `test-audit must not be filed by default, titles: ${titles.join(" | ")}`,
    );
    assert(
      titles.includes(SECURITY_SCAN_TITLE),
      "security-scan must still be filed",
    );
    assert(!result.value.created.includes("test-audit"));
    // Excluded is not "already open", so it is not reported as skipped.
    assert(!result.value.skipped.includes("test-audit"));
    assert(
      logs.includes(
        "[create-all-idle-task] repo=org/fresh template=test-audit action=excluded reason=opt_in_not_configured",
      ),
      `expected an excluded line, logs: ${logs.join(" | ")}`,
    );
  },
);

Deno.test(
  "createAllIdleTaskWrappers - authorisedOptInTemplates seeds test-audit without the requested marker (Issue #5096)",
  async () => {
    const { result, creates } = await sweep({
      authorisedOptInTemplates: new Set(["test-audit"]),
    });

    assert(result.ok, "expected ok result");
    if (!result.ok) return;
    assert(result.value.created.includes("test-audit"));
    const call = creates.find((c) => titleOf(c) === TEST_AUDIT_TITLE);
    assert(call !== undefined, "expected a test-audit create call");
    assertEquals(hasIdleTaskRequestedMarker(bodyOf(call!)), false);
  },
);

Deno.test(
  "createAllIdleTaskWrappers - templateNames naming test-audit seeds it with the requested marker last (Issue #5096)",
  async () => {
    const { result, creates, logs } = await sweep({
      templateNames: new Set(["test-audit"]),
    });

    assert(result.ok, "expected ok result");
    if (!result.ok) return;
    assertEquals(result.value.created, ["test-audit"]);
    const call = creates.find((c) => titleOf(c) === TEST_AUDIT_TITLE);
    assert(call !== undefined, "expected a test-audit create call");
    const body = bodyOf(call!);
    assert(hasIdleTaskRequestedMarker(body), "marker must be the final line");
    assertStringIncludes(body, IDLE_TASK_REQUESTED_MARKER);
    assert(
      body.length <= GITHUB_ISSUE_BODY_MAX_CHARS,
      `body length ${body.length} exceeds the limit`,
    );
    // An explicit allowlist is not a default sweep, so nothing is logged as
    // excluded.
    assert(!logs.some((l) => l.includes("action=excluded")));
  },
);

Deno.test(
  "createAllIdleTaskWrappers - an allowlist that does not name test-audit leaves it out (Issue #5096)",
  async () => {
    const { result, creates } = await sweep({
      templateNames: new Set(["security-scan", "best-practices"]),
    });

    assert(result.ok, "expected ok result");
    if (!result.ok) return;
    const titles = creates.map(titleOf);
    assert(!titles.includes(TEST_AUDIT_TITLE), `titles: ${titles.join(" | ")}`);
    assert(!result.value.created.includes("test-audit"));
    assert(!result.value.skipped.includes("test-audit"));
  },
);

// ---------------------------------------------------------------------------
// create-all-idle-task-wrappers command: the owner config reaches the sweep
// ---------------------------------------------------------------------------

async function runSeedCommand(config: WorkerConfig) {
  const gh = makeGh();
  const result = await createAllIdleTaskWrappersCommand.execute(
    {
      repo: "org/fresh",
      __testDeps: {
        ghCommandFn: gh.fn,
        ensureLabelFn: labelOk,
        findOpenIdleTaskIssuesFn: () => Promise.resolve([]),
        nowFn: () => STABLE_NOW,
        rootDir: REPO_ROOT,
        log: (_line: string) => {},
      },
    },
    config,
  );
  return { result, creates: createCalls(gh.calls) };
}

Deno.test(
  "create-all-idle-task-wrappers command - default config does not file test-audit (Issue #5096)",
  async () => {
    const { result, creates } = await runSeedCommand(
      buildDefaultWorkerConfig(),
    );

    assertEquals(result.success, true);
    const titles = creates.map(titleOf);
    assert(!titles.includes(TEST_AUDIT_TITLE), `titles: ${titles.join(" | ")}`);
    assert(titles.includes(SECURITY_SCAN_TITLE));
  },
);

Deno.test(
  "create-all-idle-task-wrappers command - config naming test-audit files it without the requested marker (Issue #5096)",
  async () => {
    const base = buildDefaultWorkerConfig();
    const { result, creates } = await runSeedCommand({
      ...base,
      idleTaskTemplateWeights: { "test-audit": 1 },
    });

    assertEquals(result.success, true);
    const call = creates.find((c) => titleOf(c) === TEST_AUDIT_TITLE);
    assert(call !== undefined, "expected a test-audit create call");
    assertEquals(hasIdleTaskRequestedMarker(bodyOf(call!)), false);
  },
);
