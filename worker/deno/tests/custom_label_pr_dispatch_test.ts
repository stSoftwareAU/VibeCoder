/**
 * Tests for the PR-phase custom-label dispatcher (Issue #1011, part of #938).
 *
 * The one-shot rule is the property under test. Issue-phase custom dispatch
 * has none of the `work-on` eligibility gates, so a mapping that keeps
 * matching keeps re-dispatching; the PR-phase answer is to **consume** the
 * label, and to consume it *before* the agent runs so a crashed, killed or
 * container-death run cannot leave the trigger in place for the next cycle.
 * The ordering test and the agent-throws test are therefore the load-bearing
 * pair: together they pin that a failure half cannot re-form the loop.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildPriorityDispatchTable,
  type RunCoreDeps,
} from "../lib/run_core.ts";
import type { CustomLabelPrCandidate } from "../lib/custom_label_pr_finder.ts";
import {
  type CustomLabelPrDispatchDeps,
  dispatchCustomLabelPrPrompts,
} from "../lib/custom_label_pr_dispatch.ts";
import type { PromptParts } from "../lib/prompt_builder.ts";
import type { Logger, Result } from "../types.ts";

/** A recording logger. */
function recordingLogger(lines: string[]): Logger {
  const push = (level: string) => (message: string, context?: unknown) =>
    lines.push(
      `${level}: ${message}${context ? ` ${JSON.stringify(context)}` : ""}`,
    );
  return {
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("debug"),
    security: (event: string, details: string) =>
      lines.push(`security: ${event} ${details}`),
    skipReason: (code: string, details: string) =>
      lines.push(`skip: ${code} ${details}`),
  } as unknown as Logger;
}

const PROMPT_PATH = "/srv/private/secret-squirrel.md";

function candidate(
  overrides: Partial<CustomLabelPrCandidate> = {},
): CustomLabelPrCandidate {
  return {
    repo: "acme/widgets",
    prNumber: 42,
    headRefName: "feature/42",
    title: "Add the widget",
    url: "https://github.com/acme/widgets/pull/42",
    isDraft: false,
    author: "someone",
    updatedAt: "2026-01-01T00:00:00Z",
    mapping: {
      label: "secret-squirrel",
      promptPath: PROMPT_PATH,
      targetPhase: "pr",
    },
    ...overrides,
  };
}

const PROMPT_PARTS: PromptParts = {
  systemPrompt: "guidelines",
  prompt: "do the private thing",
  templateSource: PROMPT_PATH,
};

interface Harness {
  order: string[];
  ghCalls: string[][];
  comments: string[];
  deps: CustomLabelPrDispatchDeps;
}

/**
 * A dispatcher wired to recording seams.
 *
 * `labelled` models the label actually being on the PR, so a second pass can
 * be driven through the same fake and observe the consumption.
 */
function harness(
  overrides: Partial<CustomLabelPrDispatchDeps> = {},
  options: { labelled?: Set<number> } = {},
): Harness {
  const order: string[] = [];
  const ghCalls: string[][] = [];
  const comments: string[] = [];
  const labelled = options.labelled ?? new Set([42]);

  const deps: CustomLabelPrDispatchDeps = {
    logger: recordingLogger([]),
    ghCommandFn: (args: string[]) => {
      ghCalls.push(args);
      if (args.includes("DELETE")) {
        order.push("remove-label");
        labelled.delete(42);
      } else if (args[0] === "pr" && args[1] === "comment") {
        order.push("comment");
        comments.push(args[args.indexOf("--body") + 1] ?? "");
      }
      return Promise.resolve("");
    },
    findCandidates: () => {
      order.push("find");
      return Promise.resolve(labelled.has(42) ? [candidate()] : []);
    },
    checkout: () => {
      order.push("checkout");
      return Promise.resolve({ ok: true as const });
    },
    buildPrompt: () => {
      order.push("build-prompt");
      return Promise.resolve(
        { ok: true as const, value: PROMPT_PARTS } as Result<PromptParts>,
      );
    },
    runAgent: () => {
      order.push("run-agent");
      return Promise.resolve();
    },
    verifyPush: () => {
      order.push("verify-push");
      return Promise.resolve({
        landed: true,
        localSha: "abcdef1234",
        remoteSha: "abcdef1234",
        reason: "'feature/42' on the remote is at abcdef12 (ls-remote)",
      });
    },
    ...overrides,
  };

  return { order, ghCalls, comments, deps };
}

Deno.test("pr dispatch - a trusted label removes, checks out, runs, and comments once", async () => {
  const h = harness();
  const result = await dispatchCustomLabelPrPrompts(h.deps);

  assertEquals(result.processed, true);
  assertEquals(h.order, [
    "find",
    "remove-label",
    "build-prompt",
    "checkout",
    "run-agent",
    "verify-push",
    "comment",
  ]);
  assertEquals(h.comments.length, 1);
  assertStringIncludes(h.comments[0]!, "secret-squirrel");
});

Deno.test("pr dispatch - the label is removed before the agent is invoked", async () => {
  const h = harness();
  await dispatchCustomLabelPrPrompts(h.deps);

  const removedAt = h.order.indexOf("remove-label");
  const ranAt = h.order.indexOf("run-agent");
  assert(removedAt > -1, "the label must be consumed");
  assert(ranAt > -1, "the agent must run");
  assert(
    removedAt < ranAt,
    `label removal must precede the agent run, got ${h.order.join(" → ")}`,
  );
});

Deno.test("pr dispatch - label removal targets the PR through the issues labels endpoint", async () => {
  const h = harness();
  await dispatchCustomLabelPrPrompts(h.deps);

  const del = h.ghCalls.find((c) => c.includes("DELETE"));
  assert(del, "the label must be removed via the API");
  assertEquals(del[0], "api");
  assert(
    del.some((a) =>
      a === "repos/acme/widgets/issues/42/labels/secret-squirrel"
    ),
    `unexpected delete target: ${del.join(" ")}`,
  );
});

Deno.test("pr dispatch - an agent that throws still leaves the label consumed and comments the failure", async () => {
  const h = harness({
    runAgent: () => Promise.reject(new Error("agent exploded")),
  });

  const result = await dispatchCustomLabelPrPrompts(h.deps);

  assertEquals(result.processed, true);
  assert(h.order.indexOf("remove-label") > -1);
  assertEquals(h.comments.length, 1);
  const comment = h.comments[0]!;
  assertStringIncludes(comment, "secret-squirrel");
  assertStringIncludes(comment, "agent exploded");
  assertStringIncludes(comment, "re-apply");
});

Deno.test("pr dispatch - a second pass after a run finds nothing", async () => {
  const labelled = new Set([42]);
  const first = harness({}, { labelled });
  await dispatchCustomLabelPrPrompts(first.deps);

  const second = harness({}, { labelled });
  const result = await dispatchCustomLabelPrPrompts(second.deps);

  assertEquals(result.processed, false);
  assertEquals(second.order, ["find"]);
  assertEquals(second.comments.length, 0);
});

Deno.test("pr dispatch - a broken operator prompt refuses the run and says so on the PR", async () => {
  const h = harness({
    buildPrompt: () =>
      Promise.resolve({
        ok: false as const,
        error: new Error(
          `Custom prompt for label 'secret-squirrel' at ${PROMPT_PATH} is missing or unreadable: No such file`,
        ),
      } as Result<PromptParts>),
  });

  const result = await dispatchCustomLabelPrPrompts(h.deps);

  assertEquals(result.processed, true);
  assertEquals(
    h.order.includes("run-agent"),
    false,
    "no agent may run on a broken operator prompt",
  );
  assertEquals(h.comments.length, 1);
  const comment = h.comments[0]!;
  assertStringIncludes(comment, "secret-squirrel");
  assertStringIncludes(comment, PROMPT_PATH);
  assertStringIncludes(comment, "re-apply");
  assertEquals(
    comment.toLowerCase().includes("pr_feedback"),
    false,
    "the built-in template is never substituted",
  );
});

Deno.test("pr dispatch - a failed checkout is reported and no agent runs", async () => {
  const h = harness({
    checkout: () =>
      Promise.resolve({
        ok: false as const,
        reason: "branch_missing" as const,
        detail: "couldn't find remote ref feature/42",
      }),
  });

  const result = await dispatchCustomLabelPrPrompts(h.deps);

  assertEquals(result.processed, true);
  assertEquals(h.order.includes("run-agent"), false);
  assertStringIncludes(h.comments[0]!, "couldn't find remote ref");
});

Deno.test("pr dispatch - a claimed push that did not land is reported as a failure", async () => {
  const h = harness({
    verifyPush: () =>
      Promise.resolve({
        landed: false,
        localSha: "aaaaaaaa11",
        reason: "could not reach the remote to confirm 'feature/42' landed",
      }),
  });

  const result = await dispatchCustomLabelPrPrompts(h.deps);

  assertEquals(result.processed, true);
  const comment = h.comments[0]!;
  assertStringIncludes(comment, "could not reach the remote");
  assertEquals(
    comment.includes("✅"),
    false,
    "an unverified push must never be reported as success",
  );
});

Deno.test("pr dispatch - no candidates means no gh calls and nothing processed", async () => {
  const h = harness({}, { labelled: new Set<number>() });
  const result = await dispatchCustomLabelPrPrompts(h.deps);

  assertEquals(result.processed, false);
  assertEquals(h.ghCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Priority ladder (Issue #1011)
// ---------------------------------------------------------------------------

/** A deps object carrying just enough for the dispatch table. */
function tableDeps(extra: Partial<RunCoreDeps> = {}): RunCoreDeps {
  const nothing = () =>
    Promise.resolve({ ok: true as const, value: { processed: false } });
  return {
    ...({} as RunCoreDeps),
    findAndProcessPrFeedback: nothing,
    findAndProcessSpellingFailure: nothing,
    findAndProcessCiFailure: nothing,
    findAndProcessRefinement: nothing,
    findAndProcessGrillMe: nothing,
    findAndProcessPlanning: nothing,
    findAndProcessQuestion: nothing,
    ...extra,
  } as RunCoreDeps;
}

Deno.test("priority table - 1.87 is absent when no pr mapping is configured", () => {
  const table = buildPriorityDispatchTable(tableDeps());
  assertEquals(table.some((h) => h.priority === 1.87), false);
  assertEquals(
    table.some((h) => h.name === "Custom Label PR Prompts"),
    false,
  );
});

Deno.test("priority table - 1.87 follows 1.86 and is agent-backed", async () => {
  let ran = 0;
  const table = buildPriorityDispatchTable(tableDeps({
    findAndProcessCustomLabelPrompts: () =>
      Promise.resolve({ ok: true, value: { processed: false } }),
    findAndProcessCustomLabelPrPrompts: () => {
      ran++;
      return Promise.resolve({ ok: true, value: { processed: true } });
    },
  }));

  const row = table.find((h) => h.name === "Custom Label PR Prompts");
  assert(row, "the row must exist once a pr mapping is configured");
  assertEquals(row.priority, 1.87);
  assertEquals(row.agentBacked, true);

  const priorities = table.map((h) => h.priority);
  assert(
    priorities.indexOf(1.87) > priorities.indexOf(1.86),
    "1.87 must follow the issue-phase row",
  );
  assert(
    priorities.indexOf(1.87) < priorities.indexOf(2),
    "1.87 must precede the generic issue scan",
  );

  const result = await row.execute();
  assertEquals(result.ok, true);
  assertEquals(ran, 1);
});
