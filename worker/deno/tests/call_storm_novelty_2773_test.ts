/**
 * Tests for the call-storm guard's novelty rule (Issue #2773).
 *
 * #2755, a security delta-sweep, was stopped eleven minutes in: it read and
 * grepped dozens of modules, every call different, and crossed the volume
 * line the #2230 guard draws. Repetition, not volume, is what marks a poll
 * loop, so a window is now a storm only when its novel share is low too.
 *
 * Both directions are pinned on real stream-json fed through the progress
 * tracker, so the count the guard reads and the rule it applies are tested
 * together: the #2230 poll loop is still a storm, a sweep is not, and a
 * window of mostly repeats is.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { AgentProgressTracker } from "../lib/agent_progress.ts";
import {
  type CallStormPolicy,
  type CallStormVerdict,
  decideCallStorm,
  DEFAULT_CALL_STORM_NOVEL_SHARE,
  normaliseToolCall,
} from "../lib/call_storm.ts";
import { loadConfig } from "../lib/config.ts";
import { detectUnknownConfigKeys } from "../lib/config_unknown_keys.ts";
import { buildCallStormPolicy } from "../lib/progress_extension_runtime.ts";
import type { ConfigFile } from "../types.ts";

/** The shipped defaults: 60 calls in five minutes, under a quarter novel. */
const POLICY: CallStormPolicy = {
  enabled: true,
  windowSeconds: 300,
  callThreshold: 60,
  novelShare: DEFAULT_CALL_STORM_NOVEL_SHARE,
};

const WINDOW_MS = 300_000;

interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

function toolUseLine(call: ToolCall): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", ...call }] },
  }) + "\n";
}

/**
 * Feed `calls` evenly across one window and ask the guard about it, the way
 * the runner does: total and novel from the tracker, the tree unchanged for
 * the whole window.
 */
function judgeWindow(calls: ToolCall[]): {
  total: number;
  novel: number;
  verdict: CallStormVerdict;
} {
  const clock = { ms: 10_000_000 };
  const tracker = new AgentProgressTracker({
    phase: "execute",
    intervalMs: 3_600_000,
    log: () => undefined,
    now: () => clock.ms,
  });
  const startMs = clock.ms;
  const stepMs = Math.floor(WINDOW_MS / calls.length);
  for (const call of calls) {
    tracker.feed(toolUseLine(call));
    clock.ms += stepMs;
  }
  const sinceMs = clock.ms - WINDOW_MS;
  assert(sinceMs <= startMs, "the fixture must fit inside one window");
  const total = tracker.toolCallsSince(sinceMs);
  const novel = tracker.novelToolCallsSince(sinceMs);
  const verdict = decideCallStorm({
    toolCalls: total,
    novelToolCalls: novel,
    treeState: "unchanged",
    treeUnchangedForMs: WINDOW_MS,
    lastToolSummary: tracker.snapshot().lastToolSummary,
  }, POLICY);
  return { total, novel, verdict };
}

/**
 * The #2230 incident, as a regression fixture: GRQ-23 slot s2 watched a
 * background `deno task test` turn by turn — `pgrep`, `tail`, `echo wN` —
 * about 25 calls a minute. Five minutes of it is 125 calls.
 */
function incident2230Window(): ToolCall[] {
  const calls: ToolCall[] = [];
  for (let i = 0; calls.length < 125; i++) {
    calls.push({
      name: "Bash",
      input: { command: "pgrep -f 'deno task test'" },
    });
    calls.push({ name: "Bash", input: { command: `echo w${i * 2 + 9}` } });
    calls.push({
      name: "Bash",
      input: { command: "tail -5 /tmp/test-out.txt" },
    });
    calls.push({
      name: "Bash",
      input: { command: `sleep  ${i % 3 + 1};  echo w${i * 2 + 10}` },
    });
    calls.push({
      name: "Bash",
      input: { command: "tail -n 40 /tmp/test-out.txt" },
    });
  }
  return calls.slice(0, 125);
}

/** A security sweep's shape (#2755): 130 distinct reads and greps. */
function sweepWindow(): ToolCall[] {
  const calls: ToolCall[] = [];
  for (let i = 0; calls.length < 130; i++) {
    calls.push({
      name: "Read",
      input: { file_path: `worker/deno/lib/module_${i}.ts` },
    });
    calls.push({
      name: "Grep",
      input: { pattern: `export function fn${i}`, path: "worker/deno/lib" },
    });
  }
  return calls.slice(0, 130);
}

Deno.test("call storm novelty - the #2230 poll loop is still a storm, naming its novel share", () => {
  const { total, novel, verdict } = judgeWindow(incident2230Window());
  assertEquals(total, 125);
  assert(novel <= 5, `a poll loop repeats itself, got ${novel} novel`);
  assert(verdict.stalled, "the #2230 poll loop must still be stopped");
  if (!verdict.stalled) return;
  assert(
    verdict.reason.includes(`125 calls in 5m, ${novel} novel (`),
    `the reason must carry the novel/total figures: ${verdict.reason}`,
  );
  assert(verdict.reason.includes("tree unchanged"), verdict.reason);
});

Deno.test("call storm novelty - a 130-call window of distinct Read/Grep calls with the tree unchanged is not a storm", () => {
  const { total, novel, verdict } = judgeWindow(sweepWindow());
  assertEquals(total, 130, "the sweep is over the volume threshold");
  assertEquals(novel, 130, "every call is new");
  assertEquals(verdict, { stalled: false });
});

Deno.test("call storm novelty - a mixed window of mostly repeats is a storm", () => {
  // Fifteen fresh reads buried in seventy-five polls: 18 novel of 90.
  const polls = incident2230Window().slice(0, 75);
  const reads = sweepWindow().filter((c) => c.name === "Read").slice(0, 15);
  const mixed: ToolCall[] = [];
  for (let i = 0; i < polls.length; i++) {
    const poll = polls[i];
    if (poll) mixed.push(poll);
    const read = reads[Math.floor(i / 5)];
    if (i % 5 === 4 && read) mixed.push(read);
  }
  const { total, novel, verdict } = judgeWindow(mixed);
  assertEquals(total, 90);
  assert(novel / total < 0.25, `mostly repeats, got ${novel}/${total}`);
  assert(verdict.stalled, "a window of mostly repeats must be stopped");
});

Deno.test("call storm novelty - the novel share is a strict bound: a quarter novel is not a storm", () => {
  const input = {
    toolCalls: 60,
    treeState: "unchanged" as const,
    treeUnchangedForMs: WINDOW_MS,
  };
  assertEquals(
    decideCallStorm({ ...input, novelToolCalls: 15 }, POLICY),
    { stalled: false },
  );
  const verdict = decideCallStorm({ ...input, novelToolCalls: 14 }, POLICY);
  assert(verdict.stalled, "just under a quarter novel is a storm");
  if (!verdict.stalled) return;
  assert(verdict.reason.includes("14 novel (23%)"), verdict.reason);
});

Deno.test("normaliseToolCall - collapses the counter forms of one command", () => {
  const key = (command: string) => normaliseToolCall("Bash", { command });
  assertEquals(key("echo w9"), key("echo w252"));
  assertEquals(key("sleep 2;  echo w9"), key("sleep 30; echo   w252"));
  assertEquals(key("tail -5 /tmp/out"), key("tail -50 /tmp/out"));
  assertNotEquals(key("tail /tmp/out"), key("pgrep -f deno"));
});

Deno.test("normaliseToolCall - keys a file tool on its path and a search tool on pattern plus path", () => {
  assertEquals(
    normaliseToolCall("Read", { file_path: "lib/a.ts", offset: 1 }),
    normaliseToolCall("Read", { file_path: "lib/a.ts", offset: 200 }),
    "re-reading one file at another offset is a repeat",
  );
  assertNotEquals(
    normaliseToolCall("Read", { file_path: "lib/a_1.ts" }),
    normaliseToolCall("Read", { file_path: "lib/a_2.ts" }),
    "digits in a path are not a counter — a new file is novel",
  );
  assertNotEquals(
    normaliseToolCall("Read", { file_path: "lib/a.ts" }),
    normaliseToolCall("Edit", { file_path: "lib/a.ts" }),
  );
  assertNotEquals(
    normaliseToolCall("Grep", { pattern: "foo", path: "lib" }),
    normaliseToolCall("Grep", { pattern: "foo", path: "tests" }),
  );
  assertNotEquals(
    normaliseToolCall("Grep", { pattern: "foo", path: "lib" }),
    normaliseToolCall("Grep", { pattern: "bar", path: "lib" }),
  );
  assertEquals(
    normaliseToolCall("Glob", { pattern: "**/*.ts" }),
    normaliseToolCall("Glob", { pattern: "**/*.ts" }),
  );
});

Deno.test("novelToolCallsSince - counts distinct calls inside the window only", () => {
  const clock = { ms: 5_000_000 };
  const tracker = new AgentProgressTracker({
    phase: "execute",
    intervalMs: 3_600_000,
    log: () => undefined,
    now: () => clock.ms,
  });
  tracker.feed(toolUseLine({ name: "Read", input: { file_path: "old.ts" } }));
  clock.ms += 600_000;
  for (let i = 0; i < 10; i++) {
    tracker.feed(
      toolUseLine({ name: "Bash", input: { command: `echo w${i}` } }),
    );
  }
  tracker.feed(toolUseLine({ name: "Read", input: { file_path: "new.ts" } }));
  assertEquals(tracker.toolCallsSince(clock.ms - WINDOW_MS), 11);
  assertEquals(
    tracker.novelToolCallsSince(clock.ms - WINDOW_MS),
    2,
    "ten counter polls are one call; the aged-out read is not counted",
  );
});

async function withTempConfig(
  extra: ConfigFile,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(
    configPath,
    JSON.stringify({
      allowed_authors: ["testuser"],
      repos: ["org/repo1"],
      ...extra,
    }),
  );
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

Deno.test("call storm config - call_storm_novel_share defaults to a quarter and is read when set", async () => {
  await withTempConfig({}, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.callStormNovelShare, 0.25);
    assertEquals(buildCallStormPolicy(config)?.novelShare, 0.25);
  });
  await withTempConfig({ call_storm_novel_share: 0.1 }, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.callStormNovelShare, 0.1);
    assertEquals(buildCallStormPolicy(config)?.novelShare, 0.1);
  });
  assertEquals(detectUnknownConfigKeys({ call_storm_novel_share: 0.25 }), []);
});

Deno.test("call storm config - a novel share outside (0, 1] is refused", async () => {
  for (const share of [0, -0.1, 1.5]) {
    await withTempConfig(
      { call_storm_novel_share: share },
      async (configPath) => {
        let message = "";
        try {
          await loadConfig(configPath);
        } catch (err) {
          message = err instanceof Error ? err.message : String(err);
        }
        assert(
          message.includes("call_storm_novel_share must be above 0"),
          `share ${share} must be refused naming the key, got: ${message}`,
        );
      },
    );
  }
});
