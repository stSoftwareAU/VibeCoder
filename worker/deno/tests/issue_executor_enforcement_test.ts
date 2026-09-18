/**
 * Every `Edit`/`Write` in a split run stays inside an executor (Issue #2344).
 *
 * The denial branch is the one the container's Claude CLI (2.1.261) supports:
 * its `PreToolUse` payload carries `agent_id`, present only for a sub-agent
 * call. These tests drive the guard that reads it, the summariser that counts
 * what a run actually did, and the invocation both are wired onto — including
 * the key-off case, where none of it is configured.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildIssueExecutorHookSettings,
  decideIssueEditHook,
  formatIssueEditDenialLog,
  ISSUE_EXECUTOR_DENIAL_MARKER,
  renderIssueEditHookOutput,
  summariseIssueExecutorSplitRun,
} from "../lib/issue_executor_enforcement.ts";
import { runIssueEditGuard } from "../lib/issue_edit_guard_cli.ts";
import { buildExecutorSplitStatsLine } from "../lib/issue_run_stats_comment.ts";
import {
  DEEPSEEK_PROVIDER_ID,
  resolveAgentProvider,
  selectAgentProvider,
} from "../lib/agent_provider.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";
import { createAgentStub } from "./support/agent_stub.ts";
import { fakeClock } from "./support/fake_clock.ts";

/** One `PreToolUse` payload, as the CLI writes it to the hook's stdin. */
function payload(
  tool: string,
  agentId?: string,
): Record<string, unknown> {
  return {
    session_id: "s1",
    transcript_path: "/tmp/t.jsonl",
    cwd: "/repo",
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: { file_path: "/repo/lib/foo.ts" },
    tool_use_id: "toolu_1",
    ...(agentId ? { agent_id: agentId } : {}),
  };
}

/** Collect what the guard wrote to each stream. */
function captureGuard(raw: string): { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  runIssueEditGuard(raw, {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
  });
  return { out, err };
}

Deno.test("issue edit guard - denies an advisor Edit and allows an executor's (Issue #2344)", () => {
  const advisor = decideIssueEditHook(payload("Edit"));
  assert(advisor.deny, "an Edit with no agent_id is the advisor's own");
  assertEquals(advisor.tool, "Edit");
  assertStringIncludes(advisor.reason, "Edit denied");

  const executor = decideIssueEditHook(payload("Edit", "agent_7f3a"));
  assertEquals(
    executor.deny,
    false,
    "an Edit carrying agent_id came from a sub-agent and is allowed",
  );
});

Deno.test("issue edit guard - Write is guarded, other tools are not (Issue #2344)", () => {
  assert(decideIssueEditHook(payload("Write")).deny);
  assertEquals(decideIssueEditHook(payload("Bash")).deny, false);
  assertEquals(decideIssueEditHook(payload("Read")).deny, false);
  // Another event's payload is not ours to judge.
  assertEquals(
    decideIssueEditHook({ ...payload("Edit"), hook_event_name: "PostToolUse" })
      .deny,
    false,
  );
});

Deno.test("issue edit guard - the advisor still writes the run's own record (Issue #2344)", () => {
  // The prompt requires the advisor to write the PR summary itself, and
  // #2343's block reserves the run's own record to it. Denying that would
  // leave a split run unable to finish.
  const summary = {
    ...payload("Write"),
    tool_input: {
      file_path: "/repo/docs/archive/pr-summaries/pr-summary-2344.md",
    },
  };
  assertEquals(decideIssueEditHook(summary).deny, false);

  const reply = {
    ...payload("Write"),
    tool_input: { file_path: "/repo/.pr_response_message" },
  };
  assertEquals(decideIssueEditHook(reply).deny, false);

  // Anything else the advisor writes is still an executor's job.
  const source = {
    ...payload("Write"),
    tool_input: { file_path: "/repo/docs/archive/pr-summaries/../../x.ts" },
  };
  assert(decideIssueEditHook(source).deny, "only the run record is carved out");
  assert(decideIssueEditHook(payload("Edit")).deny);
});

Deno.test("issue edit guard - a denied advisor Edit produces the CLI deny shape and a log line naming the tool (Issue #2344)", () => {
  const { out, err } = captureGuard(JSON.stringify(payload("Edit")));
  assertEquals(out.length, 1, "exactly one decision is written");
  const decision = JSON.parse(out[0]!);
  assertEquals(decision.hookSpecificOutput.hookEventName, "PreToolUse");
  assertEquals(decision.hookSpecificOutput.permissionDecision, "deny");
  assertStringIncludes(
    decision.hookSpecificOutput.permissionDecisionReason,
    ISSUE_EXECUTOR_DENIAL_MARKER,
  );
  assertEquals(err.length, 1, "the denial is logged once");
  assertStringIncludes(err[0]!, "Edit");
  assertStringIncludes(err[0]!, "denied");
});

Deno.test("issue edit guard - an executor Edit in the same run writes nothing at all (Issue #2344)", () => {
  const { out, err } = captureGuard(
    JSON.stringify(payload("Edit", "agent_7f3a")),
  );
  assertEquals(out, [], "silence is the CLI's allow");
  assertEquals(err, []);
});

Deno.test("issue edit guard - an unreadable payload is allowed loudly, never silently (Issue #2344)", () => {
  const { out, err } = captureGuard("not json at all");
  assertEquals(out, [], "a payload we cannot attribute does not block the run");
  assertEquals(err.length, 1);
  assertStringIncludes(err[0]!, ISSUE_EXECUTOR_DENIAL_MARKER);
});

Deno.test("issue edit guard - renders nothing for an allow (Issue #2344)", () => {
  assertEquals(renderIssueEditHookOutput({ deny: false }), "");
  assertStringIncludes(formatIssueEditDenialLog("Write"), "Write");
});

Deno.test("issue edit guard CLI - runs as a child process, denies the advisor and exits 0 (Issue #2344)", async () => {
  const module = new URL("../lib/issue_edit_guard_cli.ts", import.meta.url)
    .pathname;
  const run = async (body: Record<string, unknown>) => {
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "--quiet", "--no-config", "--no-lock", module],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(JSON.stringify(body)));
    await writer.close();
    const { code, stdout, stderr } = await child.output();
    return {
      code,
      out: new TextDecoder().decode(stdout),
      err: new TextDecoder().decode(stderr),
    };
  };

  const denied = await run(payload("Edit"));
  assertEquals(denied.code, 0, "a denial must not fail the run");
  assertEquals(
    JSON.parse(denied.out).hookSpecificOutput.permissionDecision,
    "deny",
  );
  assertStringIncludes(denied.err, "Edit");

  const allowed = await run(payload("Edit", "agent_7f3a"));
  assertEquals(allowed.code, 0);
  assertEquals(allowed.out.trim(), "", "an executor's edit is allowed");
});

Deno.test("issue executor hook settings - registers a PreToolUse command hook for Edit and Write (Issue #2344)", () => {
  const settings = buildIssueExecutorHookSettings({
    denoPath: "/usr/bin/deno",
    guardModulePath: "/checkout/worker/deno/lib/issue_edit_guard_cli.ts",
  }) as {
    hooks: {
      PreToolUse: {
        matcher: string;
        hooks: { type: string; command: string }[];
      }[];
    };
  };
  const entry = settings.hooks.PreToolUse[0]!;
  assertEquals(entry.matcher, "Edit|Write");
  assertEquals(entry.hooks[0]!.type, "command");
  assertStringIncludes(entry.hooks[0]!.command, "/usr/bin/deno");
  assertStringIncludes(entry.hooks[0]!.command, "issue_edit_guard_cli.ts");
  assertEquals(
    entry.hooks[0]!.command.includes("DENO_DIR="),
    false,
    "no cache is pinned when the caller named none",
  );

  // The guard constrains the agent, so where the image bakes a read-only Deno
  // seed the child is pinned to it — the agent's own environment cannot point
  // the cache at code it prepared (Issue #1448's finding).
  const pinned = buildIssueExecutorHookSettings({
    denoPath: "/usr/bin/deno",
    guardModulePath: "/checkout/worker/deno/lib/issue_edit_guard_cli.ts",
    denoDir: "/opt/deno-seed",
  }) as { hooks: { PreToolUse: { hooks: { command: string }[] }[] } };
  assertStringIncludes(
    pinned.hooks.PreToolUse[0]!.hooks[0]!.command,
    "DENO_DIR='/opt/deno-seed'",
  );
});

/** A split run's stream: two advisor edits, three dispatches, one re-task. */
function splitRunStream(): string {
  const assistant = (
    blocks: Record<string, unknown>[],
    parent: string | null = null,
  ) =>
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: parent,
      message: { model: "claude-opus-4", content: blocks },
    });
  const toolUse = (
    id: string,
    name: string,
    input: Record<string, unknown> = {},
  ) => ({ type: "tool_use", id, name, input });

  return [
    assistant([toolUse("t1", "Edit", { file_path: "/repo/a.ts" })]),
    assistant([toolUse("t2", "Write", { file_path: "/repo/b.ts" })]),
    assistant([
      toolUse("t3", "Task", { subagent_type: "executor", prompt: "edit c" }),
      toolUse("t4", "Task", { subagent_type: "executor", prompt: "edit d" }),
    ]),
    assistant([toolUse("t5", "Task", { subagent_type: "executor" })]),
    assistant([toolUse("t6", "SendMessage", { to: "executor" })]),
    // An executor's own edits, attributed to the Task that started it.
    assistant([toolUse("t7", "Edit", { file_path: "/repo/c.ts" })], "t3"),
    // A sub-agent that is not an executor, dispatched for review work.
    assistant([toolUse("t8", "Task", { subagent_type: "Explore" })]),
    JSON.stringify({ type: "result", subtype: "success", result: "done" }),
  ].join("\n");
}

Deno.test("split run summary - counts advisor edits, executor dispatches and re-tasks (Issue #2344)", () => {
  const stats = summariseIssueExecutorSplitRun(splitRunStream());
  assertEquals(stats.advisorEditCalls, 2);
  assertEquals(stats.executorDispatches, 3);
  assertEquals(stats.executorRetasks, 1);
  assertEquals(stats.deniedAdvisorEdits, []);
});

Deno.test("split run summary - a guard-denied advisor edit counts as a denial, not an edit (Issue #2344)", () => {
  const stream = [
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Edit", input: {} }],
      },
    }),
    JSON.stringify({
      type: "user",
      parent_tool_use_id: null,
      message: {
        content: [{
          type: "tool_result",
          tool_use_id: "t1",
          is_error: true,
          content: [{
            type: "text",
            text: `${ISSUE_EXECUTOR_DENIAL_MARKER} Edit denied: …`,
          }],
        }],
      },
    }),
  ].join("\n");

  const stats = summariseIssueExecutorSplitRun(stream);
  assertEquals(stats.advisorEditCalls, 0, "a denied call made no edit");
  assertEquals(stats.deniedAdvisorEdits, ["Edit"]);
});

Deno.test("split run summary - the CLI's own permission_denials record counts a denial (Issue #2344)", () => {
  // The first-class record, which does not depend on the denial reason
  // surviving into the tool result's prose.
  const stream = [
    JSON.stringify({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_use", id: "t1", name: "Write", input: {} }],
      },
    }),
    JSON.stringify({
      type: "result",
      subtype: "success",
      permission_denials: [{
        tool_name: "Write",
        tool_use_id: "t1",
        tool_input: {},
      }],
    }),
  ].join("\n");

  const stats = summariseIssueExecutorSplitRun(stream);
  assertEquals(stats.advisorEditCalls, 0);
  assertEquals(stats.deniedAdvisorEdits, ["Write"]);
});

Deno.test("split run summary - a re-task addressed to a numbered executor instance counts (Issue #2344)", () => {
  const stream = JSON.stringify({
    type: "assistant",
    parent_tool_use_id: null,
    message: {
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "SendMessage",
          input: { to: "executor-2" },
        },
        {
          type: "tool_use",
          id: "t2",
          name: "SendMessage",
          input: { to: "Explore" },
        },
      ],
    },
  });

  const stats = summariseIssueExecutorSplitRun(stream);
  assertEquals(stats.executorRetasks, 1, "only the executor's continuation");
});

Deno.test("split run summary - malformed and empty streams count nothing rather than throwing (Issue #2344)", () => {
  const stats = summariseIssueExecutorSplitRun('{not json\n\n{"type":"x"}');
  assertEquals(stats.advisorEditCalls, 0);
  assertEquals(stats.executorDispatches, 0);
  assertEquals(stats.executorRetasks, 0);
  assertEquals(stats.deniedAdvisorEdits, []);
});

Deno.test("run stats comment - reports the split counts, and nothing at all with the key off (Issue #2344)", () => {
  const line = buildExecutorSplitStatsLine([
    {
      runStats: {
        servedModels: ["claude-opus-4"],
        requestedModel: "opus",
        wallClockMs: 1000,
        executorSplit: {
          advisorEditCalls: 0,
          deniedAdvisorEdits: ["Edit"],
          executorDispatches: 3,
          executorRetasks: 1,
        },
      },
    },
  ]);
  assertStringIncludes(line, "executor split:");
  assertStringIncludes(line, "0 advisor edit calls");
  assertStringIncludes(line, "1 denied");
  assertStringIncludes(line, "3 executors dispatched");
  assertStringIncludes(line, "1 re-tasks");

  assertEquals(
    buildExecutorSplitStatsLine([
      {
        runStats: {
          servedModels: ["claude-opus-4"],
          requestedModel: "opus",
          wallClockMs: 1000,
        },
      },
    ]),
    "",
    "a key-off run renders no split line",
  );
});

Deno.test({
  name:
    "claude runner - a split run installs the guard and tallies the stream; a key-off run does neither (Issue #2344)",
  ignore: Deno.build.os === "windows",
  async fn() {
    const fixture = splitRunStream().split("\n").join("\\n");
    const run = async (split: boolean) => {
      const stub = await createAgentStub(
        `printf '%s\\n' "$@" > "$(dirname "$0")/argv.txt"\n` +
          `printf '${fixture}\\n'\nexit 0\n`,
        { prefix: "claude_stub_2344_" },
      );
      try {
        const result = await runClaudeWithTimeout({
          clock: fakeClock(),
          prompt: "P",
          model: "m",
          agentBinaryPath: stub.path,
          timeoutSeconds: 30,
          killAfterSeconds: 2,
          ...(split ? { issueExecutorSplit: true } : {}),
        });
        const argv = (await Deno.readTextFile(`${stub.dir}/argv.txt`)).split(
          "\n",
        );
        return { result, argv };
      } finally {
        await stub.dispose();
      }
    };

    const on = await run(true);
    assert(
      on.argv.includes("--settings"),
      `a split run installs the guard: ${on.argv.join(" ")}`,
    );
    assertStringIncludes(
      on.argv[on.argv.indexOf("--settings") + 1]!,
      "issue_edit_guard_cli.ts",
    );
    assert(on.result.ok);
    const stats = on.result.value.runStats?.executorSplit;
    assert(stats, "a split run carries the split counts");
    assertEquals(stats.advisorEditCalls, 2);
    assertEquals(stats.executorDispatches, 3);
    assertEquals(stats.executorRetasks, 1);

    const off = await run(false);
    assertEquals(
      off.argv.includes("--settings"),
      false,
      "a key-off run configures no hook",
    );
    assert(off.result.ok);
    assertEquals(
      off.result.value.runStats?.executorSplit,
      undefined,
      "a key-off run carries no split counts",
    );
  },
});

Deno.test("claude invocation - carries --settings only when the split asked for it (Issue #2344)", () => {
  const provider = selectAgentProvider("claude");
  const withGuard = provider.buildInvocation({
    prompt: "P",
    model: "opus",
    settingsJson: JSON.stringify(
      buildIssueExecutorHookSettings({
        denoPath: "/usr/bin/deno",
        guardModulePath: "/checkout/worker/deno/lib/issue_edit_guard_cli.ts",
      }),
    ),
  });
  const index = withGuard.indexOf("--settings");
  assert(index >= 0, `expected --settings in ${withGuard.join(" ")}`);
  assertStringIncludes(withGuard[index + 1]!, "PreToolUse");

  const withoutGuard = provider.buildInvocation({ prompt: "P", model: "opus" });
  assertEquals(
    withoutGuard.includes("--settings"),
    false,
    "a key-off run's argv is exactly today's",
  );

  // DeepSeek drops the executor definitions, so the guard goes with them: a
  // guard with no executors denies the advisor's edits and strands the run.
  const deepSeek = resolveAgentProvider(DEEPSEEK_PROVIDER_ID).buildInvocation({
    prompt: "P",
    model: "deepseek-flash",
    settingsJson: '{"hooks":{}}',
  });
  assertEquals(deepSeek.includes("--settings"), false);
});
