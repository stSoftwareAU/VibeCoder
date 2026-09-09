/**
 * Tests for commands/codex_budget.ts — the opt-in live budget diagnostic
 * (Issue #1697, parent #1694).
 *
 * The diagnostic's whole job is to print metadata and nothing else, so these
 * tests drive the real command against a real throwaway `CODEX_HOME` and
 * assert on what came out — including that no credential value did.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  codexBudgetCommand,
  defaultCodexHome,
  describeCodexBudgetSnapshot,
} from "../commands/codex_budget.ts";
import { containsSecret } from "../lib/secret_redaction.ts";
import type { WorkerConfig } from "../types.ts";

const FIXTURES = new URL("./fixtures/codex_budget/", import.meta.url);

/** The command ignores config entirely; this satisfies the signature. */
const CONFIG = {} as WorkerConfig;

/** Build a throwaway CODEX_HOME holding one rollout fixture. */
async function codexHomeWithFixture(fixture: string): Promise<string> {
  const home = await Deno.makeTempDir({ prefix: "codex-budget-cmd-" });
  const dir = `${home}/sessions/2026/09/09`;
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/rollout-2026-09-09T01-00-00-cmd.jsonl`,
    Deno.readTextFileSync(new URL(fixture, FIXTURES)),
  );
  return home;
}

Deno.test("codex-budget - prints redacted metadata for a known budget", async () => {
  const home = await codexHomeWithFixture("rollout_chatgpt_subscription.jsonl");
  try {
    const result = await codexBudgetCommand.execute(
      { "codex-home": home },
      CONFIG,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "source: rollout-token-count");
    assertStringIncludes(result.message, "remaining: 7.5% (secondary window)");
    assertStringIncludes(result.message, "plan: pro");
    assertStringIncludes(result.message, "primary: 82.0% remaining");
    assertStringIncludes(result.message, "window=300m");
    assertStringIncludes(result.message, "resets=2026-09-04T01:00:00.000Z");
    // The fixture's credit balance is never rendered.
    assertEquals(result.message.includes("12.34"), false);
    assertEquals(containsSecret(result.message), false);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("codex-budget - an unknown budget is a successful, honest report", async () => {
  const home = await codexHomeWithFixture("rollout_no_rate_limits.jsonl");
  try {
    const result = await codexBudgetCommand.execute(
      { "codex-home": home },
      CONFIG,
    );
    assertEquals(result.success, true);
    assertStringIncludes(result.message, "remaining: UNKNOWN");
    assertStringIncludes(result.message, "no-rate-limit-event");
    // Never a zero standing in for an unknown.
    assertEquals(result.message.includes("remaining: 0.0%"), false);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("codex-budget - renders no credential for an API-key account", async () => {
  const home = await codexHomeWithFixture("rollout_chatgpt_subscription.jsonl");
  try {
    await Deno.writeTextFile(
      `${home}/auth.json`,
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: "sk-proj-not-a-real-key-000000000000",
      }),
    );
    const result = await codexBudgetCommand.execute(
      { "codex-home": home },
      CONFIG,
    );
    assertStringIncludes(result.message, "auth mode: api-key");
    assertStringIncludes(result.message, "api-key-account");
    assertEquals(result.message.includes("sk-proj-not-a-real-key"), false);
    assertEquals(containsSecret(result.message), false);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("describeCodexBudgetSnapshot - renders exhaustion without a reset guess", () => {
  const text = describeCodexBudgetSnapshot({
    budget: {
      known: true,
      remainingFraction: 0,
      window: "primary",
      windows: [],
    },
    source: "exhaustion-event",
    readAt: 1_788_000_000_000,
    exhaustion: { kind: "rate_limit_reached" },
    authMode: "chatgpt",
  }, "/tmp/codex");

  assertStringIncludes(text, "exhausted: rate_limit_reached");
  assertStringIncludes(text, "reset: unknown");
  assertStringIncludes(text, "windows: none (exhaustion evidence only)");
});

Deno.test("defaultCodexHome - honours CODEX_HOME, else ~/.codex", () => {
  assertEquals(
    defaultCodexHome((
      name,
    ) => (name === "CODEX_HOME" ? "/opt/codex" : "/root")),
    "/opt/codex",
  );
  assertEquals(
    defaultCodexHome((name) => (name === "HOME" ? "/home/vibe" : undefined)),
    "/home/vibe/.codex",
  );
  assertEquals(defaultCodexHome(() => undefined), ".codex");
});

Deno.test("codex-budget - is registered with a read-only description", () => {
  assertEquals(codexBudgetCommand.name, "codex-budget");
  assert(codexBudgetCommand.description.includes("read-only"));
});
