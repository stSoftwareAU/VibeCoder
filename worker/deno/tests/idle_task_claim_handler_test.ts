/**
 * Tests for the idle-task claim handler.
 *
 * Issue #2077: dispatch is title-based. The handler iterates registered
 * templates and routes to the one whose `buildIssueTitle(repo)` matches
 * the claimed issue's title (or whose `matchesIdleTaskBody` matches).
 * Coverage:
 *   - Issues that match no template pass through with `{ handled: false }`
 *     so the caller works them through the standard issue→PR pipeline —
 *     `idle-task` is just the lowest work-trigger priority, not a
 *     scan-only marker.
 *   - Happy path — a registered template's runTask is invoked and its
 *     summary surfaces.
 *   - runTask returning `ok: false` surfaces its summary.
 *   - runTask throwing is caught and converted to a handled result.
 *   - Falls back to the production registry when listTemplatesFn is
 *     omitted.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Logger } from "../types.ts";
import {
  handleIdleTaskIssue,
  type HandleIdleTaskIssueDeps,
} from "../lib/idle_task_claim_handler.ts";
import { IDLE_TASK_LABEL } from "../lib/idle_task_issue.ts";
import type {
  IdleTaskRunOptions,
  IdleTaskRunResult,
  IdleTaskTemplate,
} from "../lib/idle_task_template.ts";
import { buildAttributionFooter } from "../lib/idle_task_attribution.ts";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface LogRecord {
  level: "info" | "warn" | "error" | "debug";
  message: string;
  context?: unknown;
}

function makeLogger(): { logger: Logger; records: LogRecord[] } {
  const records: LogRecord[] = [];
  const logger: Logger = {
    info: (message, context) =>
      records.push({ level: "info", message, context }),
    warn: (message, context) =>
      records.push({ level: "warn", message, context }),
    error: (message, context) =>
      records.push({ level: "error", message, context }),
    debug: (message, context) =>
      records.push({ level: "debug", message, context }),
    security: () => {},
    skipReason: () => {},
    timing: () => {},
    scanSummary: () => {},
    workerSummary: () => {},
  };
  return { logger, records };
}

function makeTemplate(
  name: string,
  title: string,
  runTask: (
    opts: { repo: string; workDir: string; idleTaskIssueNumber: number },
  ) => Promise<IdleTaskRunResult>,
  bodyFingerprint?: string,
): IdleTaskTemplate {
  return {
    name,
    description: `Test template ${name}`,
    buildIssueTitle: (_repo) => title,
    buildIssueBody: (opts) =>
      `Template: ${name} Repo: ${opts.repo} Picked: ${opts.pickedAt}`,
    runTask,
    matchesIdleTaskBody: bodyFingerprint
      ? (body: string) => body.includes(bodyFingerprint)
      : undefined,
  };
}

function makeDeps(
  templates: IdleTaskTemplate[] = [],
): { deps: HandleIdleTaskIssueDeps; records: LogRecord[] } {
  const { logger, records } = makeLogger();
  return {
    deps: {
      logger,
      listTemplatesFn: () => templates,
    },
    records,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  "handleIdleTaskIssue - passes through only when both label and title miss",
  async () => {
    // Issue #2083 behaviour change: title alone is now enough to route
    // an issue through the template runner. Confirm the pass-through
    // path still fires when neither the `idle-task` label nor a
    // matching title is present.
    const template = makeTemplate(
      "security-scan",
      "Run a security scan",
      () => Promise.resolve({ ok: true, summary: "ran" }),
    );
    const { deps } = makeDeps([template]);
    const result = await handleIdleTaskIssue(
      {
        repo: "acme/widget",
        issueNumber: 42,
        issueTitle: "Fix the date parser",
        issueLabels: ["enhancement"],
        issueBody: "doesn't matter",
        workDir: "/tmp/widget",
      },
      deps,
    );
    assertEquals(result.handled, false);
    assertEquals(result.summary, undefined);
    assertEquals(result.ok, undefined);
  },
);

Deno.test(
  "handleIdleTaskIssue - dispatches by title even when idle-task label missing (Issue #2083)",
  async () => {
    // Regression: a security-scan wrapper that has lost its
    // `idle-task` label must NOT fall through to the standard issue
    // worker — that path used to obediently run Claude as a normal
    // issue and raise a PR despite the prompt's "Must not modify the
    // codebase" constraint. Title-based dispatch closes that
    // loophole.
    const captures: Array<
      { repo: string; workDir: string; idleTaskIssueNumber: number }
    > = [];
    const template = makeTemplate(
      "security-scan",
      "Run a security scan",
      (opts) => {
        captures.push(opts);
        return Promise.resolve({ ok: true, summary: "No issues found." });
      },
    );
    const { deps } = makeDeps([template]);
    const result = await handleIdleTaskIssue(
      {
        repo: "acme/widget",
        issueNumber: 42,
        issueTitle: "Run a security scan",
        // No `idle-task` label — only the title signals the wrapper.
        issueLabels: ["failed-once"],
        issueBody: "doesn't matter",
        workDir: "/tmp/widget",
      },
      deps,
    );
    assertEquals(result.handled, true);
    assertEquals(result.ok, true);
    assertEquals(result.summary, "No issues found.");
    assertEquals(captures.length, 1);
    assertEquals(captures[0]?.repo, "acme/widget");
    assertEquals(captures[0]?.idleTaskIssueNumber, 42);
  },
);

Deno.test(
  "handleIdleTaskIssue - happy path invokes template.runTask matched by title (Issue #2077)",
  async () => {
    const captures: Array<
      { repo: string; workDir: string; idleTaskIssueNumber: number }
    > = [];
    const template = makeTemplate(
      "security-scan",
      "Run a security scan",
      (opts) => {
        captures.push(opts);
        return Promise.resolve({
          ok: true,
          summary: "scan complete — filed 3",
        });
      },
    );
    const { deps, records } = makeDeps([template]);

    const result = await handleIdleTaskIssue(
      {
        repo: "acme/widget",
        issueNumber: 42,
        issueTitle: "Run a security scan",
        issueLabels: [IDLE_TASK_LABEL, "enhancement"],
        issueBody:
          "the operator pasted the full prompt body here, no marker needed",
        workDir: "/tmp/widget",
      },
      deps,
    );

    assertEquals(result.handled, true);
    assertEquals(result.ok, true);
    assertEquals(result.summary, "scan complete — filed 3");
    assertEquals(captures.length, 1);
    assertEquals(captures[0]?.repo, "acme/widget");
    assertEquals(captures[0]?.workDir, "/tmp/widget");
    assertEquals(captures[0]?.idleTaskIssueNumber, 42);
    assert(records.some((r) => r.level === "info"));
    assert(!records.some((r) => r.level === "warn"));
  },
);

Deno.test(
  "handleIdleTaskIssue - tolerates surrounding whitespace in the issue title",
  async () => {
    const template = makeTemplate(
      "security-scan",
      "Run a security scan",
      () => Promise.resolve({ ok: true, summary: "ok" }),
    );
    const { deps } = makeDeps([template]);
    const result = await handleIdleTaskIssue(
      {
        repo: "acme/widget",
        issueNumber: 42,
        issueTitle: "  Run a security scan  ",
        issueLabels: [IDLE_TASK_LABEL],
        issueBody: "",
        workDir: "/tmp/widget",
      },
      deps,
    );
    assertEquals(result.handled, true);
    assertEquals(result.ok, true);
  },
);

Deno.test(
  "handleIdleTaskIssue - falls through (handled:false) for an idle-task issue that is not a scan wrapper",
  async () => {
    // `idle-task` is just the lowest work-trigger priority. An idle-task
    // issue whose title and body match no registered template is NOT a
    // scan wrapper — it is ordinary lowest-priority work, so the handler
    // passes through and the caller runs the standard issue→PR pipeline.
    const template = makeTemplate(
      "security-scan",
      "Run a security scan",
      () => Promise.resolve({ ok: true, summary: "should not run" }),
    );
    const { deps, records } = makeDeps([template]);
    const result = await handleIdleTaskIssue(
      {
        repo: "acme/widget",
        issueNumber: 99,
        issueTitle: "dead-code: unused export `foo` in src/bar.ts",
        issueLabels: [IDLE_TASK_LABEL],
        issueBody: "Remove the unused export.",
        workDir: "/tmp/widget",
      },
      deps,
    );
    assertEquals(result.handled, false);
    assertEquals(result.ok, undefined);
    assertEquals(result.summary, undefined);
    // Pass-through is not a warning condition.
    const warns = records.filter((r) => r.level === "warn");
    assertEquals(warns.length, 0);
  },
);

Deno.test("handleIdleTaskIssue - runTask ok:false surfaces summary", async () => {
  const template = makeTemplate(
    "security-scan",
    "Run a security scan",
    () => Promise.resolve({ ok: false, summary: "scanner failed: timeout" }),
  );
  const { deps, records } = makeDeps([template]);
  const result = await handleIdleTaskIssue(
    {
      repo: "acme/widget",
      issueNumber: 101,
      issueTitle: "Run a security scan",
      issueLabels: [IDLE_TASK_LABEL],
      issueBody: "",
      workDir: "/tmp/widget",
    },
    deps,
  );
  assertEquals(result.handled, true);
  assertEquals(result.ok, false);
  assertEquals(result.summary, "scanner failed: timeout");
  assert(
    records.some((r) => r.level === "warn" && r.message.includes("failed")),
  );
});

Deno.test("handleIdleTaskIssue - runTask thrown error is caught and reported", async () => {
  const template = makeTemplate("security-scan", "Run a security scan", () => {
    throw new Error("boom");
  });
  const { deps, records } = makeDeps([template]);
  const result = await handleIdleTaskIssue(
    {
      repo: "acme/widget",
      issueNumber: 102,
      issueTitle: "Run a security scan",
      issueLabels: [IDLE_TASK_LABEL],
      issueBody: "",
      workDir: "/tmp/widget",
    },
    deps,
  );
  assertEquals(result.handled, true);
  assertEquals(result.ok, false);
  assert(result.summary !== undefined);
  assertStringIncludes(result.summary!, "boom");
  assert(
    records.some((r) => r.level === "warn" && r.message.includes("threw")),
  );
});

Deno.test(
  "handleIdleTaskIssue - dispatches by body fingerprint when label and title both miss (Issue #2087)",
  async () => {
    // Regression: VibeCoder#2086 saw a security-scan wrapper drop
    // into the standard issue worker, which ran Claude on the prompt
    // body and posted a "Partial Answer" comment. The third dispatch
    // signal is the template body fingerprint — when both label and
    // title miss, an issue whose body contains the template's
    // identifying marker still routes to the template.
    const captures: Array<
      { repo: string; workDir: string; idleTaskIssueNumber: number }
    > = [];
    const template = makeTemplate(
      "security-scan",
      "Run a security scan",
      (opts) => {
        captures.push(opts);
        return Promise.resolve({ ok: true, summary: "scan complete" });
      },
      "MythOS-style Security Audit",
    );
    const { deps } = makeDeps([template]);
    const result = await handleIdleTaskIssue(
      {
        repo: "acme/widget",
        issueNumber: 42,
        // Both label and title miss — only the body fingerprint
        // identifies this as a wrapper.
        issueTitle: "Investigate dependency bloat",
        issueLabels: ["bug"],
        issueBody: "# MythOS-style Security Audit — Four-Phase Scan (v2)\n\n" +
          "You are a security auditor performing a static, evidence-backed " +
          "audit of `acme/widget`...",
        workDir: "/tmp/widget",
      },
      deps,
    );
    assertEquals(result.handled, true);
    assertEquals(result.ok, true);
    assertEquals(result.summary, "scan complete");
    assertEquals(captures.length, 1);
    assertEquals(captures[0]?.idleTaskIssueNumber, 42);
  },
);

Deno.test(
  "handleIdleTaskIssue - body fingerprint is ignored when not declared by any template",
  async () => {
    // A template without `matchesIdleTaskBody` must not claim any
    // arbitrary issue body. Sanity check: an unrelated issue with no
    // matching signals still falls through.
    const template = makeTemplate(
      "security-scan",
      "Run a security scan",
      () => Promise.resolve({ ok: true, summary: "n/a" }),
      // No body fingerprint declared.
    );
    const { deps } = makeDeps([template]);
    const result = await handleIdleTaskIssue(
      {
        repo: "acme/widget",
        issueNumber: 7,
        issueTitle: "Investigate dependency bloat",
        issueLabels: ["bug"],
        issueBody: "Dependencies are slow to install.",
        workDir: "/tmp/widget",
      },
      deps,
    );
    assertEquals(result.handled, false);
  },
);

Deno.test(
  "handleIdleTaskIssue - falls back to production registry when listTemplatesFn is omitted",
  async () => {
    // The real templates register themselves at module load. Use a
    // deliberately-unknown title and body so none match: the handler
    // passes through (`handled: false`) and the caller runs the issue
    // through the standard pipeline as lowest-priority work.
    const { logger } = makeLogger();
    const result = await handleIdleTaskIssue(
      {
        repo: "acme/widget",
        issueNumber: 103,
        issueTitle: "Definitely not a real template title",
        issueLabels: [IDLE_TASK_LABEL],
        issueBody: "",
        workDir: "/tmp/widget",
      },
      { logger },
    );
    assertEquals(result.handled, false);
    assertEquals(result.ok, undefined);
    assertEquals(result.summary, undefined);
  },
);

// ---------------------------------------------------------------------------
// Model tier threading (Issue #4010)
// ---------------------------------------------------------------------------

/** Body of a wrapper filed for `tier`, or an unstamped one when omitted. */
function wrapperBodyForTier(tier?: string): string {
  return [
    "Run a security scan",
    "",
    buildAttributionFooter({
      template: "security-scan",
      runId: "vibe-run-4010",
      ...(tier !== undefined ? { model: tier } : {}),
    }),
  ].join("\n");
}

/** Dispatch a wrapper and return the `runTask` options it produced. */
async function captureRunOptions(
  body: string,
): Promise<
  { captured: IdleTaskRunOptions[]; records: LogRecord[] }
> {
  const captured: IdleTaskRunOptions[] = [];
  const template = makeTemplate(
    "security-scan",
    "Run a security scan",
    (opts) => {
      captured.push(opts as IdleTaskRunOptions);
      return Promise.resolve({ ok: true, summary: "scan complete" });
    },
  );
  const { deps, records } = makeDeps([template]);
  await handleIdleTaskIssue(
    {
      repo: "acme/widget",
      issueNumber: 4010,
      issueTitle: "Run a security scan",
      issueLabels: [IDLE_TASK_LABEL],
      issueBody: body,
      workDir: "/tmp/widget",
    },
    deps,
  );
  return { captured, records };
}

Deno.test(
  "handleIdleTaskIssue - threads a stamped sonnet tier into runTask",
  async () => {
    const { captured } = await captureRunOptions(wrapperBodyForTier("sonnet"));
    assertEquals(captured.length, 1);
    assertEquals(captured[0]!.modelTier, "sonnet");
  },
);

Deno.test(
  "handleIdleTaskIssue - threads a stamped fable tier into runTask",
  async () => {
    const { captured } = await captureRunOptions(wrapperBodyForTier("fable"));
    assertEquals(captured[0]!.modelTier, "fable");
  },
);

Deno.test(
  "handleIdleTaskIssue - an unstamped wrapper carries no modelTier key",
  async () => {
    const { captured, records } = await captureRunOptions(wrapperBodyForTier());
    assert(
      !Object.hasOwn(captured[0]!, "modelTier"),
      "expected no modelTier key on the runTask options",
    );
    assertEquals(records.filter((r) => r.level === "warn").length, 0);
  },
);

Deno.test(
  "handleIdleTaskIssue - an unknown tier is ignored and warned about",
  async () => {
    const { captured, records } = await captureRunOptions(
      wrapperBodyForTier("gpt-9"),
    );
    assert(
      !Object.hasOwn(captured[0]!, "modelTier"),
      "expected an unknown tier to be dropped",
    );
    const warnings = records.filter((r) => r.level === "warn");
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!.message, "model tier");
  },
);
