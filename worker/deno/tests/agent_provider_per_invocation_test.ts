/**
 * Per-invocation coding-agent provider selection (Issue #4109, parent #4102).
 *
 * Issue #4067 built the seam for *swapping* the provider — one config key, one
 * environment variable, resolved from process-wide state inside the spawn
 * path. Quorum needs two planners and a judge in a single run, so these tests
 * pin the per-call selection path instead:
 *
 *   - a named provider produces that provider's invocation while the active
 *     provider is a different one, and leaks nothing into global state;
 *   - two differently-named invocations run *concurrently* (proved by a
 *     rendezvous between the two stub CLIs) with their own binary, arguments
 *     and child environment;
 *   - naming a provider the running image did not install fails loudly,
 *     naming the installed set (Issue #3234);
 *   - the no-argument call is unchanged.
 *
 * The spawn tests put stub `claude` and `codex` scripts on PATH, so the real
 * agent CLIs are never invoked. Each stub records the argument list and the
 * two vendor credentials it was handed, which is what proves the per-invocation
 * environment did not cross-contaminate.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  AGENT_PROVIDER_ENV,
  IMAGE_AGENT_PROVIDERS_ENV,
  resolveAgentProvider,
  resolveAgentProviderId,
  selectAgentProvider,
} from "../lib/agent_provider.ts";
import { runClaudeWithTimeout } from "../lib/claude_runner.ts";

// ---------------------------------------------------------------------------
// Selection without spawning
// ---------------------------------------------------------------------------

/**
 * An environment carrying no image stamp.
 *
 * The container image stamps {@link IMAGE_AGENT_PROVIDERS_ENV} with the set it
 * installed, so a selection test that omits its own lookup inherits the
 * runner's stamp and can only ever select the providers that image carries.
 * These tests are about the selection precedence, not the installed-set guard
 * (which has its own test below), so they supply an unstamped environment —
 * matching `withStubProviders`, which clears the stamp for the same reason.
 */
const unstamped = (_name: string): string | undefined => undefined;

Deno.test("selectAgentProvider - no argument resolves the active provider", () => {
  const env = (name: string) =>
    name === AGENT_PROVIDER_ENV ? "codex" : undefined;

  assertEquals(selectAgentProvider(undefined, { env }).id, "codex");
  assertEquals(
    selectAgentProvider(undefined, { configured: "gemini", env: unstamped }).id,
    "gemini",
  );
  assertEquals(selectAgentProvider(undefined, { env: unstamped }).id, "claude");
});

Deno.test("selectAgentProvider - a named provider wins over the active one and leaks nothing", () => {
  const env = (name: string) =>
    name === AGENT_PROVIDER_ENV ? "claude" : undefined;

  const named = selectAgentProvider("gemini", { env });
  assertEquals(named.id, "gemini");
  assertEquals(named.binary, "gemini");

  // The active selection is untouched — naming a provider for one call must
  // never rewrite the process-wide choice.
  assertEquals(resolveAgentProviderId({ env }), "claude");
  assertEquals(selectAgentProvider(undefined, { env }).id, "claude");
});

Deno.test("selectAgentProvider - accepts a descriptor the caller already holds", () => {
  const descriptor = resolveAgentProvider("codex");
  assertEquals(selectAgentProvider(descriptor, { env: unstamped }).id, "codex");
});

Deno.test("selectAgentProvider - an unregistered id fails loudly, naming the supported ids", () => {
  let message = "";
  try {
    selectAgentProvider("not-a-provider");
  } catch (error) {
    message = (error as Error).message;
  }
  assertStringIncludes(message, "not-a-provider");
  assertStringIncludes(message, "claude");
  assertStringIncludes(message, "codex");
  assertStringIncludes(message, "gemini");
});

Deno.test("selectAgentProvider - a provider the image did not install fails loudly, naming the installed set", () => {
  const env = (name: string) =>
    name === IMAGE_AGENT_PROVIDERS_ENV ? "claude,gemini" : undefined;

  let message = "";
  try {
    selectAgentProvider("codex", { env });
  } catch (error) {
    message = (error as Error).message;
  }
  assertStringIncludes(message, '"codex"');
  assertStringIncludes(message, "Installed: claude, gemini");

  // An installed one still resolves — the check gates, it does not block.
  assertEquals(selectAgentProvider("gemini", { env }).id, "gemini");
});

Deno.test("selectAgentProvider - a descriptor without an id fails loudly", () => {
  const malformed = { ...resolveAgentProvider("claude"), id: "  " };
  let message = "";
  try {
    selectAgentProvider(malformed);
  } catch (error) {
    message = (error as Error).message;
  }
  assertStringIncludes(message, "no id");
});

// ---------------------------------------------------------------------------
// Model and effort routing stay per provider
// ---------------------------------------------------------------------------

Deno.test("per-provider invocation - phase routing applies to Claude and is ignored by providers without it", () => {
  const claudeArgs = resolveAgentProvider("claude").buildInvocation({
    prompt: "p",
    phase: "issue",
  });
  // Claude keeps its per-phase model/effort routing.
  assert(claudeArgs.includes("--model"));
  assert(claudeArgs.includes("--effort"));

  // Codex and Gemini have no Claude model tiers, so a phase alone must not
  // make them emit flags carrying a Claude model name.
  const codexArgs = resolveAgentProvider("codex").buildInvocation({
    prompt: "p",
    phase: "issue",
  });
  assertEquals(codexArgs.includes("--model"), false);
  assertEquals(codexArgs.includes("--effort"), false);

  const geminiArgs = resolveAgentProvider("gemini").buildInvocation({
    prompt: "p",
    phase: "issue",
  });
  assertEquals(geminiArgs.includes("--model"), false);
  assertEquals(geminiArgs.includes("--effort"), false);
});

Deno.test("per-provider invocation - effort uses each provider's own syntax, or none at all", () => {
  const codexArgs = resolveAgentProvider("codex").buildInvocation({
    prompt: "p",
    effort: "high",
  });
  assertEquals(codexArgs.includes("--effort"), false);
  assert(
    codexArgs.some((a) =>
      a.includes("model_reasoning_effort") && a.includes("high")
    ),
    `expected Codex reasoning-effort config, got ${codexArgs.join(" ")}`,
  );

  // Gemini's CLI has no reasoning-effort option — the request is dropped
  // rather than turned into a flag the CLI would reject.
  const geminiArgs = resolveAgentProvider("gemini").buildInvocation({
    prompt: "p",
    effort: "high",
  });
  assertEquals(geminiArgs.some((a) => a.includes("effort")), false);
});

// ---------------------------------------------------------------------------
// Spawning stubs: per-invocation binary, arguments and child environment
// ---------------------------------------------------------------------------

/** Argument list and vendor credentials one stub CLI recorded. */
interface StubRecord {
  args: string[];
  /** What the stub read from stdin — the prompt, for Claude (Issue #4385). */
  stdin: string;
  anthropicKey: string;
  openaiKey: string;
}

/**
 * Body of a stub agent CLI.
 *
 * Records its arguments and the two vendor credentials it inherited, then
 * waits for its peer to start before exiting. The rendezvous is what proves
 * genuine concurrency: run sequentially, the first stub would never see the
 * peer marker and would exit 9.
 */
function stubBody(peer: string, rendezvous: boolean): string {
  const wait = rendezvous
    ? `for _ in $(seq 1 100); do\n` +
      `  [ -e "$dir/${peer}.started" ] && break\n` +
      `  sleep 0.1\n` +
      `done\n` +
      `[ -e "$dir/${peer}.started" ] || { printf 'peer never started\\n' 1>&2; exit 9; }\n`
    : "";
  return `#!/usr/bin/env bash
dir="$(cd "$(dirname "$0")" && pwd)"
name="$(basename "$0")"
: > "$dir/$name.args"
for a in "$@"; do printf '%s\\n' "$a" >> "$dir/$name.args"; done
if [ ! -t 0 ]; then cat > "$dir/$name.stdin"; else : > "$dir/$name.stdin"; fi
{
  printf 'ANTHROPIC_API_KEY=%s\\n' "\${ANTHROPIC_API_KEY:-}"
  printf 'OPENAI_API_KEY=%s\\n' "\${OPENAI_API_KEY:-}"
} > "$dir/$name.creds"
touch "$dir/$name.started"
${wait}printf '%s\\n' '{"type":"result","result":"ran-'"$name"'"}'
exit 0
`;
}

/**
 * Run `fn` with stub `claude` and `codex` scripts on PATH and dummy vendor
 * credentials in the environment, restoring both afterwards.
 */
async function withStubProviders<T>(
  rendezvous: boolean,
  fn: (readRecord: (binary: string) => Promise<StubRecord>) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "agent_provider_stub_" });
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ["claude", "codex"],
    ["codex", "claude"],
  ];
  for (const [binary, peer] of pairs) {
    const path = `${dir}/${binary}`;
    await Deno.writeTextFile(path, stubBody(peer, rendezvous));
    await Deno.chmod(path, 0o755);
  }

  const saved = new Map<string, string | undefined>();
  const setEnv = (name: string, value: string | undefined) => {
    if (!saved.has(name)) saved.set(name, Deno.env.get(name));
    if (value === undefined) Deno.env.delete(name);
    else Deno.env.set(name, value);
  };

  setEnv("PATH", `${dir}:${Deno.env.get("PATH") ?? ""}`);
  // Dummy credentials — one per vendor. Each provider's allowlist admits only
  // its own, which is what the per-invocation environment assertion turns on.
  setEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
  setEnv("OPENAI_API_KEY", "test-openai-key");
  // No image stamp: these stubs stand in for both installed CLIs.
  setEnv(IMAGE_AGENT_PROVIDERS_ENV, undefined);

  const readRecord = async (binary: string): Promise<StubRecord> => {
    const args = (await Deno.readTextFile(`${dir}/${binary}.args`))
      .split("\n").filter((line) => line !== "");
    const stdin = await Deno.readTextFile(`${dir}/${binary}.stdin`).catch(
      () => "",
    );
    const creds = await Deno.readTextFile(`${dir}/${binary}.creds`);
    const value = (name: string) =>
      creds.split("\n").find((l) => l.startsWith(`${name}=`))
        ?.slice(name.length + 1) ?? "";
    return {
      args,
      stdin,
      anthropicKey: value("ANTHROPIC_API_KEY"),
      openaiKey: value("OPENAI_API_KEY"),
    };
  };

  try {
    return await fn(readRecord);
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await Deno.remove(dir, { recursive: true }).catch(
      () => {/* best-effort */},
    );
  }
}

Deno.test({
  name:
    "runClaudeWithTimeout - a named provider runs that provider while the active one differs (Issue #4109)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    await withStubProviders(false, async (readRecord) => {
      Deno.env.set(AGENT_PROVIDER_ENV, "claude");
      try {
        const result = await runClaudeWithTimeout({
          prompt: "draft the plan",
          agentProvider: "codex",
          timeoutSeconds: 30,
          killAfterSeconds: 2,
        });

        assert(result.ok, !result.ok ? result.error.message : "");
        if (!result.ok) return;
        assertEquals(result.value.exitCode, 0);
        // Attribution: the result names the agent that produced it.
        assertEquals(result.value.provider, "codex");
        assertEquals(result.value.runStats?.provider, "codex");
        assertStringIncludes(result.value.output, "ran-codex");

        const codex = await readRecord("codex");
        assertEquals(codex.args[0], "exec");
        assert(codex.args.some((a) => a.includes("draft the plan")));
        // Codex sees its own credential and never Anthropic's.
        assertEquals(codex.openaiKey, "test-openai-key");
        assertEquals(codex.anthropicKey, "");

        // The active provider never ran, and is still Claude afterwards.
        await Deno.stat(`${Deno.env.get("PATH")!.split(":")[0]}/claude.args`)
          .then(
            () =>
              assert(false, "the active provider must not have been spawned"),
            () => {/* expected: no record */},
          );
        assertEquals(resolveAgentProviderId(), "claude");
      } finally {
        Deno.env.delete(AGENT_PROVIDER_ENV);
      }
    });
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - concurrent invocations of different providers do not interfere (Issue #4109)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    await withStubProviders(true, async (readRecord) => {
      const [claudeResult, codexResult] = await Promise.all([
        runClaudeWithTimeout({
          prompt: "claude draft",
          agentProvider: "claude",
          phase: "issue",
          timeoutSeconds: 60,
          killAfterSeconds: 2,
        }),
        runClaudeWithTimeout({
          prompt: "codex draft",
          agentProvider: "codex",
          timeoutSeconds: 60,
          killAfterSeconds: 2,
        }),
      ]);

      assert(
        claudeResult.ok,
        !claudeResult.ok ? claudeResult.error.message : "",
      );
      assert(codexResult.ok, !codexResult.ok ? codexResult.error.message : "");
      if (!claudeResult.ok || !codexResult.ok) return;

      // Exit 0 from both only happens when each stub saw the other running —
      // a sequential run exits 9 from the first.
      assertEquals(claudeResult.value.exitCode, 0);
      assertEquals(codexResult.value.exitCode, 0);
      assertEquals(claudeResult.value.provider, "claude");
      assertEquals(codexResult.value.provider, "codex");
      assertStringIncludes(claudeResult.value.output, "ran-claude");
      assertStringIncludes(codexResult.value.output, "ran-codex");

      const claude = await readRecord("claude");
      const codex = await readRecord("codex");

      // Per-invocation arguments: each CLI got its own dialect and its own
      // prompt, with nothing from the other.
      assert(claude.args.includes("--dangerously-skip-permissions"));
      // Claude's prompt travels on stdin behind a bare `-p` (Issue #4385);
      // Codex's stays on argv.
      assertEquals(claude.args.at(-1), "-p");
      assertEquals(claude.stdin, "claude draft");
      assertEquals(claude.args[0], "--model");
      assertEquals(codex.args[0], "exec");
      assertEquals(
        codex.args.includes("--dangerously-skip-permissions"),
        false,
      );
      assert(codex.args.some((a) => a.includes("codex draft")));
      assertEquals(codex.args.some((a) => a.includes("claude draft")), false);
      assertEquals(claude.args.some((a) => a.includes("codex draft")), false);

      // Per-invocation environment: neither child saw the other vendor's key.
      assertEquals(claude.anthropicKey, "test-anthropic-key");
      assertEquals(claude.openaiKey, "");
      assertEquals(codex.openaiKey, "test-openai-key");
      assertEquals(codex.anthropicKey, "");
    });
  },
});

Deno.test({
  name:
    "runClaudeWithTimeout - omitting the provider is unchanged, and the credit log records it (Issue #4109)",
  permissions: { run: true, read: true, write: true, env: true },
  ignore: Deno.build.os === "windows",
  async fn() {
    await withStubProviders(false, async (readRecord) => {
      const creditLogDir = await Deno.makeTempDir({ prefix: "credit_log_" });
      try {
        const result = await runClaudeWithTimeout({
          prompt: "default run",
          phase: "issue",
          timeoutSeconds: 30,
          killAfterSeconds: 2,
          creditLogDir,
          workerName: "worker-test",
          repo: "stSoftwareAU/VibeCoder",
        });

        assert(result.ok, !result.ok ? result.error.message : "");
        if (!result.ok) return;
        assertEquals(result.value.exitCode, 0);
        assertEquals(result.value.provider, "claude");

        const claude = await readRecord("claude");
        assertEquals(claude.args[0], "--model");
        assert(claude.args.includes("--dangerously-skip-permissions"));
        assertEquals(claude.args.at(-1), "-p");
        assertEquals(claude.stdin, "default run");
        assertEquals(claude.anthropicKey, "test-anthropic-key");

        // Credit-log attribution (fire-and-forget write — poll briefly).
        let entry: Record<string, unknown> | undefined;
        for (let attempt = 0; attempt < 50 && !entry; attempt++) {
          for await (const file of Deno.readDir(creditLogDir)) {
            const text = await Deno.readTextFile(
              `${creditLogDir}/${file.name}`,
            );
            const line = text.split("\n").find((l) => l.trim() !== "");
            if (line) entry = JSON.parse(line);
          }
          if (!entry) await new Promise((r) => setTimeout(r, 20));
        }
        assertEquals(entry?.provider, "claude");
        assertEquals(entry?.phase, "issue");
      } finally {
        await Deno.remove(creditLogDir, { recursive: true }).catch(
          () => {/* best-effort */},
        );
      }
    });
  },
});
