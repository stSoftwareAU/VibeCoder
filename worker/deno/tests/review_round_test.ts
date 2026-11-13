/**
 * One headless review-fleet-prs round, run inside the worker container
 * (Issue #3293): the round's Claude subscription comes from the worker's own
 * credential pool, and a round the usage limit stopped is run once more on
 * the next subscription with budget. Issue #5083 adds the Codex link to the
 * chain, between the Claude subscriptions and DeepSeek.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CODEX_ROUND_NOTE,
  renderCodexStreamLine,
  renderStreamLine,
  type ReviewRoundDeps,
  type ReviewRunRecord,
  runCodexCli,
  runReviewRound,
} from "../lib/review_round.ts";

const USAGE_LIMIT = "You've hit your usage limit · resets 1:50pm (UTC)";

/** The Codex credential's child env, as `exportCodexCredential` returns it. */
const CODEX_CREDENTIAL = { env: { OPENAI_API_KEY: "codex-secret" } };

/** One attempt the fake runner was asked to make. */
interface Call {
  /** `claude` for every `claude -p` attempt (DeepSeek's included), `codex` for `runCodex`. */
  runner: "claude" | "codex";
  args: string[];
  env: Record<string, string>;
  stdin?: string;
  streamFile?: string;
}

/** A runner's answer. `usageLimited` is what a Codex runner classifies itself. */
interface Outcome {
  code: number;
  output: string;
  usageLimited?: boolean;
}

/** Options for {@link fakeDeps}. */
interface FakeOptions {
  held?: string;
  next?: string | null;
  fallback?: { providerId: string; env: Record<string, string> } | null;
  /** The Codex credential's child env, or null when none is provisioned (Issue #5083). */
  codex?: { env: Record<string, string> } | null;
}

// A pool of two subscriptions: start-up exports `provider`, and the retry
// asks for anything but the label it is handed. The fallback provider is
// `deepseek` unless the test opts it out, and there is no Codex credential
// unless the test supplies one.
function fakeDeps(
  outcomes: Outcome[],
  options: FakeOptions = {},
): { deps: ReviewRoundDeps; calls: Call[]; log: string[]; excluded: string[] } {
  const calls: Call[] = [];
  const log: string[] = [];
  const excluded: string[] = [];
  const held = "held" in options ? options.held : "provider";
  const next = "next" in options ? options.next : "provider-2";
  const fallback = "fallback" in options ? options.fallback : {
    providerId: "deepseek",
    env: {
      ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic",
      ANTHROPIC_AUTH_TOKEN: "deepseek-secret",
    },
  };
  const codex = options.codex ?? null;
  const deps: ReviewRoundDeps = {
    exportStartCredential: (setEnv) => {
      if (held === undefined) return Promise.resolve(undefined);
      setEnv("CLAUDE_CODE_OAUTH_TOKEN", `${held}-secret`);
      return Promise.resolve(held);
    },
    switchCredential: (exclude, setEnv) => {
      excluded.push(exclude);
      if (next === null || next === undefined) return Promise.resolve(null);
      setEnv("CLAUDE_CODE_OAUTH_TOKEN", `${next}-secret`);
      return Promise.resolve(next);
    },
    exportFallbackCredential: () => Promise.resolve(fallback ?? null),
    exportCodexCredential: () => Promise.resolve(codex),
    runClaude: (args, env, streamFile) => {
      calls.push({ runner: "claude", args, env: { ...env }, streamFile });
      return Promise.resolve(
        outcomes[calls.length - 1] ?? { code: 0, output: "" },
      );
    },
    runCodex: (args, stdin, env, streamFile) => {
      calls.push({ runner: "codex", args, env: { ...env }, stdin, streamFile });
      return Promise.resolve(
        outcomes[calls.length - 1] ?? { code: 0, output: "" },
      );
    },
    log: (message) => log.push(message),
  };
  return { deps, calls, log, excluded };
}

/** The value after `flag` in a CLI argument list, or undefined when absent. */
function argAfter(args: readonly string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

Deno.test("runReviewRound runs claude -p on the pool's subscription and logs only its label", async () => {
  const { deps, calls, log } = fakeDeps([{ code: 0, output: "Round done" }]);
  const code = await runReviewRound("review ONE round", ["--model", "m"], deps);
  assertEquals(code, 0);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.args, ["-p", "review ONE round", "--model", "m"]);
  assertEquals(calls[0]!.env["CLAUDE_CODE_OAUTH_TOKEN"], "provider-secret");
  // Reviewer agents may outlast claude -p's 600s default background wait;
  // only the round's own alarm may cut them off.
  assertEquals(calls[0]!.env["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"], "0");
  assertStringIncludes(log.join("\n"), "round on Claude subscription provider");
  assertEquals(log.some((m) => m.includes("secret")), false);
});

Deno.test("runReviewRound retries a usage-limit round once on the next subscription", async () => {
  const { deps, calls, log, excluded } = fakeDeps([
    { code: 1, output: USAGE_LIMIT },
    { code: 0, output: "Round done" },
  ]);
  const code = await runReviewRound("p", [], deps);
  assertEquals(code, 0);
  assertEquals(
    calls.map((c) => c.env["CLAUDE_CODE_OAUTH_TOKEN"]),
    ["provider-secret", "provider-2-secret"],
  );
  assertEquals(excluded, ["provider"]);
  const text = log.join("\n");
  assertStringIncludes(
    text,
    "round hit the usage limit on subscription provider; selecting another",
  );
  assertStringIncludes(
    text,
    "retrying the round once on subscription provider-2",
  );
});

Deno.test("runReviewRound keeps a usage-limit round failed when no other subscription has budget", async () => {
  const { deps, calls, log } = fakeDeps([{ code: 1, output: USAGE_LIMIT }], {
    next: null,
    fallback: null,
  });
  assertEquals(await runReviewRound("p", [], deps), 1);
  assertEquals(calls.length, 1);
  assertStringIncludes(
    log.join("\n"),
    "no other subscription has budget; the round stays failed",
  );
});

Deno.test("runReviewRound does not retry a round that failed for another reason", async () => {
  const { deps, calls, excluded } = fakeDeps([
    { code: 3, output: "model overloaded" },
  ]);
  assertEquals(await runReviewRound("p", [], deps), 3);
  assertEquals(calls.length, 1);
  assertEquals(excluded, []);
});

Deno.test("runReviewRound does not rotate a token that came from no pool file", async () => {
  // No held label: the token came from the environment, so which one ran out
  // is unknown and rotating could hand the same one straight back.
  const { deps, calls, excluded } = fakeDeps(
    [{ code: 1, output: USAGE_LIMIT }],
    {
      held: undefined,
      fallback: null,
    },
  );
  assertEquals(await runReviewRound("p", [], deps), 1);
  assertEquals(calls.length, 1);
  assertEquals(excluded, []);
});

Deno.test("runReviewRound falls back to the fallback provider when no Claude subscription has budget (Issue #3632)", async () => {
  const { deps, calls, log } = fakeDeps(
    [
      { code: 1, output: USAGE_LIMIT },
      { code: 0, output: "Round done on the fallback" },
    ],
    { next: null },
  );
  assertEquals(
    await runReviewRound("p", ["--model", "claude-opus-5-5"], deps),
    0,
  );
  assertEquals(calls.length, 2);
  // The fallback attempt swaps the pinned Opus model for the fallback's.
  assertEquals(calls[1]!.args, ["-p", "p", "--model", "deepseek-v4-pro"]);
  // And runs in the fallback provider's own environment — no Claude token
  // may reach the third-party endpoint.
  assertEquals(
    calls[1]!.env["ANTHROPIC_BASE_URL"],
    "https://api.deepseek.com/anthropic",
  );
  assertEquals(calls[1]!.env["CLAUDE_CODE_OAUTH_TOKEN"], undefined);
  const text = log.join("\n");
  assertStringIncludes(text, "round fell back to provider deepseek");
  assertStringIncludes(text, "no other subscription has budget");
});

Deno.test("runReviewRound falls back after the rotated retry also hit the limit (Issue #3632)", async () => {
  const { deps, calls, log } = fakeDeps(
    [
      { code: 1, output: USAGE_LIMIT },
      { code: 1, output: USAGE_LIMIT },
      { code: 0, output: "Round done on the fallback" },
    ],
  );
  assertEquals(
    await runReviewRound("p", ["--model", "claude-opus-5-5"], deps),
    0,
  );
  assertEquals(calls.length, 3);
  assertEquals(calls[2]!.args[3], "deepseek-v4-pro");
  const text = log.join("\n");
  assertStringIncludes(
    text,
    "retrying the round once on subscription provider-2",
  );
  assertStringIncludes(text, "round fell back to provider deepseek");
});

Deno.test("runReviewRound falls back when the token came from no pool file (Issue #3632)", async () => {
  // No held label: nothing to rotate, but the provider switch needs no
  // exclusion — it replaces the endpoint entirely.
  const { deps, calls, log } = fakeDeps(
    [
      { code: 1, output: USAGE_LIMIT },
      { code: 0, output: "Round done on the fallback" },
    ],
    { held: undefined },
  );
  assertEquals(await runReviewRound("p", [], deps), 0);
  assertEquals(calls.length, 2);
  assertStringIncludes(log.join("\n"), "round fell back to provider deepseek");
});

Deno.test("runReviewRound keeps the round failed when there is no fallback credential (Issue #3632)", async () => {
  const { deps, calls, log } = fakeDeps([{ code: 1, output: USAGE_LIMIT }], {
    next: null,
    fallback: null,
  });
  assertEquals(await runReviewRound("p", [], deps), 1);
  assertEquals(calls.length, 1);
  assertStringIncludes(
    log.join("\n"),
    "no other subscription has budget; the round stays failed",
  );
});

Deno.test("runReviewRound never engages the fallback for a non-usage-limit failure (Issue #3632)", async () => {
  const { deps, calls } = fakeDeps([{ code: 3, output: "model overloaded" }]);
  assertEquals(await runReviewRound("p", [], deps), 3);
  assertEquals(calls.length, 1);
});

// ---------------------------------------------------------------------------
// Which provider and model wrote each review, and what it cost: a round given
// its directory records each attempt there before it starts and its exit
// status when it ends, and streams that attempt's CLI output to its own file,
// so post.ts names the attempt posting and the runner prices it afterwards.
// ---------------------------------------------------------------------------

function recordingDeps(outcomes: Outcome[], options: FakeOptions = {}) {
  const base = fakeDeps(outcomes, options);
  const records: ReviewRunRecord[] = [];
  const streams: (string | undefined)[] = [];
  const deps: ReviewRoundDeps = {
    ...base.deps,
    runClaude: (args, env, streamFile) => {
      streams.push(streamFile);
      // What post.ts would read mid-attempt: the attempt has no status yet.
      records.push(structuredClone(lastRecord));
      return base.deps.runClaude(args, env, streamFile);
    },
    recordRun: (_dir, record) => {
      lastRecord = structuredClone(record);
      return Promise.resolve();
    },
  };
  let lastRecord: ReviewRunRecord = { round: "", attempts: [] };
  return { deps, records, streams, final: () => lastRecord, calls: base.calls };
}

const ROUND_ARGS = [
  "--model",
  "claude-opus-5-5",
  "--effort",
  "xhigh",
  "--output-format",
  "stream-json",
  "--verbose",
];

Deno.test("runReviewRound records the attempt it is running, with provider, model and effort", async () => {
  const { deps, records, streams, final } = recordingDeps([
    { code: 0, output: "Round done" },
  ]);
  const code = await runReviewRound("p", ROUND_ARGS, deps, {
    roundDir: "/logs/review-fleet-prs/rounds/20261016-101500",
  });
  assertEquals(code, 0);
  assertEquals(records[0]!.round, "20261016-101500");
  assertEquals(records[0]!.attempts, [{
    attempt: 1,
    provider: "claude",
    model: "claude-opus-5-5",
    effort: "xhigh",
    stream: "stream-1.jsonl",
  }]);
  assertEquals(streams, [
    "/logs/review-fleet-prs/rounds/20261016-101500/stream-1.jsonl",
  ]);
  assertEquals(final().attempts[0]!.code, 0);
});

Deno.test("runReviewRound refreshes reviewer build and policy metadata with its attempt log", async () => {
  const { deps, final } = recordingDeps([{ code: 0, output: "Round done" }]);
  await runReviewRound("p", ROUND_ARGS, deps, {
    roundDir: "/logs/review-fleet-prs/rounds/20261016-101500",
    deployment: {
      component: "reviewer",
      hostId: "host-a",
      codeRevision: "abcdef0123456789",
      policyFingerprint: "a".repeat(64),
    },
  });
  assertEquals(final().deployment?.component, "reviewer");
  assertEquals(final().deployment?.hostId, "host-a");
  assertEquals(final().deployment?.codeRevision, "abcdef0123456789");
  assertEquals(final().deployment?.policyFingerprint, "a".repeat(64));
  assert(Number.isFinite(Date.parse(final().deployment?.observedAt ?? "")));
});

Deno.test("runReviewRound records a DeepSeek fallback attempt as deepseek, not claude (Issue #3632)", async () => {
  const { deps, records, final } = recordingDeps(
    [
      { code: 1, output: USAGE_LIMIT },
      { code: 0, output: "Round done on the fallback" },
    ],
    { next: null },
  );
  assertEquals(
    await runReviewRound("p", ROUND_ARGS, deps, { roundDir: "/r/x" }),
    0,
  );
  const fallback = records[1]!.attempts[1]!;
  assertEquals(fallback.provider, "deepseek");
  assertEquals(fallback.model, "deepseek-v4-pro");
  assertEquals(fallback.effort, "xhigh");
  assertEquals(fallback.stream, "stream-2.jsonl");
  assertEquals(final().attempts.map((a) => [a.provider, a.code]), [
    ["claude", 1],
    ["deepseek", 0],
  ]);
});

Deno.test("runReviewRound without a round directory records nothing and streams to no file", async () => {
  const { deps, streams, final } = recordingDeps([{ code: 0, output: "" }]);
  assertEquals(await runReviewRound("p", ROUND_ARGS, deps), 0);
  assertEquals(streams, [undefined]);
  assertEquals(final().attempts, []);
});

Deno.test("runReviewRound records the Codex attempt as codex, gpt-6-astra at high effort (Issue #5083)", async () => {
  const { deps, final, calls } = recordingDeps(
    [
      { code: 1, output: USAGE_LIMIT },
      { code: 0, output: "Round done on Codex" },
    ],
    { next: null, codex: CODEX_CREDENTIAL },
  );
  assertEquals(
    await runReviewRound("p", ROUND_ARGS, deps, { roundDir: "/r/x" }),
    0,
  );
  assertEquals(
    final().attempts.map((a) => [a.provider, a.model, a.effort, a.code]),
    [
      ["claude", "claude-opus-5-5", "xhigh", 1],
      ["codex", "gpt-6-astra", "high", 0],
    ],
  );
  assertEquals(final().attempts[1]!.stream, "stream-2.jsonl");
  assertEquals(calls[1]!.streamFile, "/r/x/stream-2.jsonl");
});

Deno.test("renderStreamLine keeps the round's log readable: result text and non-JSON lines only", () => {
  assertEquals(
    renderStreamLine(
      '{"type":"result","subtype":"success","result":"Approved owner/repo#7"}',
    ),
    "Approved owner/repo#7",
  );
  assertEquals(
    renderStreamLine('{"type":"assistant","message":{"content":[]}}'),
    null,
  );
  assertEquals(
    renderStreamLine("cannot run claude: boom"),
    "cannot run claude: boom",
  );
  assertEquals(renderStreamLine(""), null);
});

// Issue #5081: the reviewer runs on Fable 5.2, whose limit can be capped apart
// from the rest of the subscription. A Fable round that hits a usage limit
// steps down to Opus on the same subscription before any rotation or provider
// switch; only when Opus is spent too does the chain move on.
Deno.test("runReviewRound steps a Fable round down to Opus xhigh on the same subscription first (Issue #5081)", async () => {
  const { deps, calls, excluded, log } = fakeDeps([
    { code: 1, output: USAGE_LIMIT },
    { code: 0, output: "Round done on Opus" },
  ]);
  assertEquals(
    await runReviewRound(
      "p",
      ["--model", "claude-fable-5-2", "--effort", "high"],
      deps,
    ),
    0,
  );
  assertEquals(calls.length, 2);
  assertEquals(calls[1]!.args, [
    "-p",
    "p",
    "--model",
    "claude-opus-5-5",
    "--effort",
    "xhigh",
  ]);
  assertEquals(excluded, [], "no rotation while Opus has budget");
  assertStringIncludes(log.join("\n"), "stepping down to claude-opus-5-5");
});

Deno.test("runReviewRound rotates once the Opus step-down hits the limit too (Issue #5081)", async () => {
  const { deps, calls } = fakeDeps([
    { code: 1, output: USAGE_LIMIT },
    { code: 1, output: USAGE_LIMIT },
    { code: 0, output: "Round done on the next subscription" },
  ]);
  assertEquals(
    await runReviewRound(
      "p",
      ["--model", "claude-fable-5-2", "--effort", "high"],
      deps,
    ),
    0,
  );
  assertEquals(calls.length, 3);
  // The rotated subscription gets the configured Fable round again.
  assertEquals(calls[2]!.args[3], "claude-fable-5-2");
});

Deno.test("runReviewRound does not step down a round that is not on Fable (Issue #5081)", async () => {
  const { deps, calls } = fakeDeps([
    { code: 1, output: USAGE_LIMIT },
    { code: 0, output: "Round done on the next subscription" },
  ]);
  await runReviewRound("p", ["--model", "claude-opus-5-5"], deps);
  assertEquals(calls[1]!.args[3], "claude-opus-5-5");
});

// ---------------------------------------------------------------------------
// Issue #5083: the chain Fable -> Opus -> rotation -> Codex -> DeepSeek. Each
// link runs only once the one before it is exhausted, and a Codex attempt
// that fails for another reason stops the chain before DeepSeek.
// ---------------------------------------------------------------------------

Deno.test("runReviewRound runs the chain Fable, Opus, rotation, then Codex, and stops before DeepSeek (Issue #5083)", async () => {
  const { deps, calls } = fakeDeps(
    [
      { code: 1, output: USAGE_LIMIT }, // Fable
      { code: 1, output: USAGE_LIMIT }, // Opus step-down
      { code: 1, output: USAGE_LIMIT }, // rotated Fable
      { code: 0, output: "Round done on Codex" },
    ],
    { codex: CODEX_CREDENTIAL },
  );
  assertEquals(
    await runReviewRound(
      "review ONE round",
      ["--model", "claude-fable-5-2", "--effort", "high"],
      deps,
    ),
    0,
  );
  assertEquals(calls.map((c) => c.runner), [
    "claude",
    "claude",
    "claude",
    "codex",
  ]);
  const codex = calls[3]!;
  assertEquals(argAfter(codex.args, "--model"), "gpt-6-astra");
  assert(codex.args.includes('model_reasoning_effort="high"'));
  assertEquals(codex.args.at(-1), "-", "the prompt is read from stdin");
  assertStringIncludes(codex.stdin ?? "", "review ONE round");
  assertStringIncludes(codex.stdin ?? "", CODEX_ROUND_NOTE);
  // The Codex attempt runs in the Codex credential's own environment: the
  // Claude subscription token set earlier in the round never reaches it.
  assertEquals(codex.env, CODEX_CREDENTIAL.env);
  assertEquals(
    "CLAUDE_CODE_OAUTH_TOKEN" in codex.env,
    false,
  );
  assertEquals(calls.length, 4, "DeepSeek is not reached once Codex succeeds");
});

Deno.test("runReviewRound does not step a Fable round down unless it was usage-limited (Issue #5083)", async () => {
  const { deps, calls, log } = fakeDeps(
    [{ code: 3, output: "model overloaded" }],
    { codex: CODEX_CREDENTIAL },
  );
  assertEquals(
    await runReviewRound("p", ["--model", "claude-fable-5-2"], deps),
    3,
  );
  assertEquals(calls.map((c) => c.runner), ["claude"]);
  assertEquals(log.some((m) => m.includes("stepping down")), false);
});

Deno.test("runReviewRound does not reach Codex when the rotated retry failed for another reason (Issue #5083)", async () => {
  const { deps, calls } = fakeDeps(
    [
      { code: 1, output: USAGE_LIMIT },
      { code: 3, output: "model overloaded" },
    ],
    { codex: CODEX_CREDENTIAL },
  );
  assertEquals(
    await runReviewRound("p", ["--model", "claude-opus-5-5"], deps),
    3,
  );
  assertEquals(calls.map((c) => c.runner), ["claude", "claude"]);
});

Deno.test("runReviewRound does not reach DeepSeek when the Codex attempt failed for another reason (Issue #5083)", async () => {
  const { deps, calls, log } = fakeDeps(
    [
      { code: 1, output: USAGE_LIMIT },
      { code: 1, output: USAGE_LIMIT },
      // The text reads like a limit, but the runner classified it: not one.
      { code: 2, output: USAGE_LIMIT, usageLimited: false },
    ],
    { codex: CODEX_CREDENTIAL },
  );
  assertEquals(
    await runReviewRound("p", ["--model", "claude-opus-5-5"], deps),
    2,
  );
  assertEquals(calls.map((c) => c.runner), ["claude", "claude", "codex"]);
  assertEquals(
    log.some((m) => m.includes("round fell back to provider deepseek")),
    false,
  );
});

Deno.test("runReviewRound runs DeepSeek when the Codex attempt is itself usage-limited (Issue #5083)", async () => {
  const { deps, calls, log } = fakeDeps(
    [
      { code: 1, output: USAGE_LIMIT },
      { code: 1, output: USAGE_LIMIT },
      { code: 1, output: "codex refused", usageLimited: true },
      { code: 0, output: "Round done on the fallback" },
    ],
    { codex: CODEX_CREDENTIAL },
  );
  assertEquals(
    await runReviewRound("p", ["--model", "claude-opus-5-5"], deps),
    0,
  );
  assertEquals(calls.map((c) => c.runner), [
    "claude",
    "claude",
    "codex",
    "claude",
  ]);
  assertEquals(calls[3]!.args, ["-p", "p", "--model", "deepseek-v4-pro"]);
  assertStringIncludes(
    log.join("\n"),
    "round fell back to provider deepseek",
  );
});

Deno.test("runReviewRound skips Codex with a plain log line and runs DeepSeek when there is no Codex credential (Issue #5083)", async () => {
  const { deps, calls, log } = fakeDeps([
    { code: 1, output: USAGE_LIMIT },
    { code: 1, output: USAGE_LIMIT },
    { code: 0, output: "Round done on the fallback" },
  ]);
  assertEquals(
    await runReviewRound("p", ["--model", "claude-opus-5-5"], deps),
    0,
  );
  assertEquals(calls.map((c) => c.runner), ["claude", "claude", "claude"]);
  assertEquals(calls[2]!.args, ["-p", "p", "--model", "deepseek-v4-pro"]);
  const skipped = log.filter((m) =>
    m === "no Codex credential; skipping the codex fallback"
  );
  assertEquals(skipped.length, 1);
  assertEquals(
    log.some((m) => m.startsWith("INFO: ") && m.includes("codex")),
    false,
    "a missing credential is not a provider switch",
  );
  assertStringIncludes(
    log.join("\n"),
    "INFO: round fell back to provider deepseek",
  );
});

Deno.test("runReviewRound logs exactly one INFO line per provider or model switch, and no ERROR (Issue #5083)", async () => {
  const { deps, log } = fakeDeps(
    [
      { code: 1, output: USAGE_LIMIT }, // Fable
      { code: 1, output: USAGE_LIMIT }, // Opus step-down
      { code: 1, output: USAGE_LIMIT }, // rotated Fable
      { code: 1, output: "codex refused", usageLimited: true }, // Codex
      { code: 0, output: "Round done on the fallback" }, // DeepSeek
    ],
    { codex: CODEX_CREDENTIAL },
  );
  assertEquals(
    await runReviewRound(
      "p",
      ["--model", "claude-fable-5-2", "--effort", "high"],
      deps,
    ),
    0,
  );
  const info = log.filter((m) => m.startsWith("INFO: "));
  assertEquals(info.length, 4, info.join("\n"));
  assertStringIncludes(info[0]!, "stepping down to claude-opus-5-5");
  assertStringIncludes(
    info[1]!,
    "retrying the round once on subscription provider-2",
  );
  assertStringIncludes(info[2]!, "round fell back to provider codex");
  assertStringIncludes(info[2]!, "gpt-6-astra");
  assertStringIncludes(info[3]!, "round fell back to provider deepseek");
  assertEquals(log.some((m) => m.includes("ERROR")), false);
});

Deno.test("renderCodexStreamLine shows the agent's message or its errors, and leaves out other events (Issue #5083)", () => {
  assertEquals(
    renderCodexStreamLine(JSON.stringify({
      type: "item.completed",
      item: { id: "i1", type: "agent_message", text: "Approved owner/repo#7" },
    })),
    "Approved owner/repo#7",
  );
  assertEquals(
    renderCodexStreamLine(JSON.stringify({
      type: "turn.failed",
      error: { message: "You have hit your limit." },
    })),
    "You have hit your limit.",
  );
  assertEquals(
    renderCodexStreamLine(JSON.stringify({
      type: "item.started",
      item: { id: "i2", type: "command_execution", command: "ls" },
    })),
    null,
  );
  assertEquals(
    renderCodexStreamLine("cannot run codex: boom"),
    "cannot run codex: boom",
  );
  assertEquals(renderCodexStreamLine(""), null);
});

/** A stub `codex` binary in its own directory, running `body` as shell. */
async function withStubCodex(
  body: (dir: string) => string,
  fn: (binary: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "review-codex-stub-" });
  try {
    const binary = `${dir}/codex`;
    await Deno.writeTextFile(binary, `#!/bin/sh\n${body(dir)}\n`);
    await Deno.chmod(binary, 0o755);
    await fn(binary, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("runCodexCli reports a usage-limit refusal as usageLimited and sends the prompt on stdin (Issue #5083)", async () => {
  await withStubCodex(
    (dir) =>
      [
        `cat > '${dir}/stdin.txt'`,
        `echo '{"type":"turn.failed","error":{"message":"You have hit your limit."}}'`,
        "exit 1",
      ].join("\n"),
    async (binary, dir) => {
      const streamFile = `${dir}/stream-1.jsonl`;
      const attempt = await runCodexCli(
        ["exec", "-"],
        "the round prompt",
        {},
        streamFile,
        undefined,
        binary,
      );
      assertEquals(attempt.code, 1);
      assertEquals(attempt.usageLimited, true);
      assertStringIncludes(attempt.output, "You have hit your limit.");
      assertEquals(
        await Deno.readTextFile(`${dir}/stdin.txt`),
        "the round prompt",
      );
      assertStringIncludes(
        await Deno.readTextFile(streamFile),
        "turn.failed",
      );
    },
  );
});

Deno.test("runCodexCli returns a successful run with its message and no usage limit (Issue #5083)", async () => {
  await withStubCodex(
    (dir) =>
      [
        `cat > '${dir}/stdin.txt'`,
        `echo '{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"Round done"}}'`,
        "exit 0",
      ].join("\n"),
    async (binary, dir) => {
      const attempt = await runCodexCli(
        ["exec", "-"],
        "the round prompt",
        {},
        undefined,
        undefined,
        binary,
      );
      assertEquals(attempt.code, 0);
      assertEquals(attempt.usageLimited, false);
      assertStringIncludes(attempt.output, "Round done");
      assertEquals(
        await Deno.readTextFile(`${dir}/stdin.txt`),
        "the round prompt",
      );
    },
  );
});
