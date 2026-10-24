/**
 * Tests for Codex quota mapping and isolated child env (Issues #1696, #1698).
 *
 * Uses Australian English spelling (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  type CodexQuotaProcess,
  probeCodexSubscriptionQuota,
  quotaCandidateFromCodexBudget,
} from "../lib/codex_quota.ts";
import { buildIsolatedCodexChildEnv } from "../lib/codex_env.ts";
import type { CodexBudget } from "../lib/codex_budget_source.ts";

Deno.test("quotaCandidateFromCodexBudget - API-key stays unknown, never zero", () => {
  const budget: CodexBudget = { known: false, reason: "api-key-account" };
  const candidate = quotaCandidateFromCodexBudget("provider", budget);
  assertEquals(candidate.budget.known, false);
  if (!candidate.budget.known) {
    assertEquals(candidate.budget.reason, "api-key-account");
  }
});

Deno.test("quotaCandidateFromCodexBudget - maps primary remaining fraction", () => {
  const budget: CodexBudget = {
    known: true,
    remainingFraction: 0.4,
    window: "primary",
    windows: [{
      window: "primary",
      usedPercent: 60,
      remainingFraction: 0.4,
      windowMinutes: 10080,
      resetAt: 1_800_000_000_000,
    }],
  };
  const candidate = quotaCandidateFromCodexBudget("provider-2", budget);
  assertEquals(candidate.providerId, "codex");
  assertEquals(candidate.credentialLabel, "provider-2");
  assertEquals(candidate.budget.known, true);
  if (candidate.budget.known) {
    assertEquals(candidate.budget.windows[0]?.nominalHours, 168);
    assertEquals(candidate.budget.windows[0]?.remainingFraction, 0.4);
  }
});

Deno.test("buildIsolatedCodexChildEnv - subscription home excludes API keys", () => {
  const child = buildIsolatedCodexChildEnv({
    OPENAI_API_KEY: "other-account",
    CODEX_API_KEY: "other-codex",
    CODEX_HOME: "/tmp/other-home",
    ANTHROPIC_API_KEY: "claude-secret",
    PATH: "/usr/bin",
    HOME: "/tmp/worker-home",
  }, {
    openaiApiKey: "selected-account",
    codexHome: "/tmp/selected-home",
  });
  assertEquals(child.OPENAI_API_KEY, undefined);
  assertEquals(child.CODEX_API_KEY, undefined);
  assertEquals(child.CODEX_HOME, "/tmp/selected-home");
  assertEquals(child.ANTHROPIC_API_KEY, undefined);
  assertEquals(child.PATH, "/usr/bin");
});

/** A protocol peer which only answers quota reads, never starts a model turn. */
function quotaPeer(
  result: unknown,
  mode: "normal" | "timeout" | "rpc-error" | "oversize" = "normal",
) {
  const messages: Array<Record<string, unknown>> = [];
  let killed = false;
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let finish!: (status: Deno.CommandStatus) => void;
  const encoder = new TextEncoder();
  const child: CodexQuotaProcess = {
    stdout: new ReadableStream({
      start(controller) {
        output = controller;
      },
    }),
    stdin: new WritableStream({
      write(bytes) {
        const message = JSON.parse(new TextDecoder().decode(bytes));
        messages.push(message);
        if (mode === "timeout" || message.id === undefined) return;
        const response = message.id === 1
          ? { id: 1, result: {} }
          : mode === "rpc-error"
          ? { id: 2, error: { message: "sensitive server output" } }
          : { id: 2, result };
        output.enqueue(encoder.encode(
          mode === "oversize"
            ? "x".repeat(600_000)
            : JSON.stringify(response) + "\n",
        ));
      },
    }),
    status: new Promise((resolve) => {
      finish = resolve;
    }),
    kill() {
      killed = true;
      finish({ success: false, code: 137, signal: "SIGKILL" });
    },
  };
  return { child, messages, killed: () => killed };
}

Deno.test("Codex live quota reads the codex bucket, strips credentials and cleans up its child", async () => {
  const peer = quotaPeer({
    rateLimits: { primary: { usedPercent: 99 } },
    rateLimitsByLimitId: {
      other: { primary: { usedPercent: 1 } },
      codex: {
        primary: {
          usedPercent: 20,
          windowDurationMins: 300,
          resetsAt: 1_800_000_000,
        },
      },
    },
  });
  let command: Deno.CommandOptions | undefined;
  const budget = await probeCodexSubscriptionQuota({
    codexHome: "/selected/home",
    parentEnv: {
      CODEX_HOME: "/wrong/home",
      OPENAI_API_KEY: "must-not-bill",
      CODEX_API_KEY: "must-not-bill",
      CLAUDE_CODE_OAUTH_TOKEN: "not-for-codex",
      GITHUB_TOKEN: "not-for-quota",
      PATH: "/usr/bin",
    },
    spawn: (options) => {
      command = options;
      return peer.child;
    },
  });
  assert(budget.known);
  assertEquals(budget.remainingFraction, 0.8);
  assertEquals(peer.messages.map((message) => message.method), [
    "initialize",
    "initialized",
    "account/rateLimits/read",
  ]);
  assertEquals(command?.clearEnv, true);
  assertEquals(command?.env?.CODEX_HOME, "/selected/home");
  for (
    const key of [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
    ]
  ) assertEquals(command?.env?.[key], undefined);
  assertEquals(peer.killed(), true);
});

Deno.test("Codex live quota accepts the single bucket response", async () => {
  const peer = quotaPeer({ rateLimits: { primary: { usedPercent: 100 } } });
  const budget = await probeCodexSubscriptionQuota({
    codexHome: "/home",
    spawn: () => peer.child,
  });
  assert(budget.known);
  assertEquals(budget.remainingFraction, 0);
});

Deno.test("Codex live quota never substitutes another model's bucket", async () => {
  const peer = quotaPeer({
    rateLimitsByLimitId: { other: { primary: { usedPercent: 1 } } },
  });
  assertEquals(
    await probeCodexSubscriptionQuota({
      codexHome: "/home",
      spawn: () => peer.child,
    }),
    { known: false, reason: "no-rate-limit-data" },
  );
});

Deno.test("Codex live quota errors, timeouts and oversized responses remain unknown and close the child", async () => {
  for (const mode of ["timeout", "rpc-error", "oversize"] as const) {
    const peer = quotaPeer({}, mode);
    const budget = await probeCodexSubscriptionQuota({
      codexHome: "/home",
      timeoutMs: 20,
      spawn: () => peer.child,
    });
    assertEquals(budget, { known: false, reason: "read-error" });
    assertEquals(peer.killed(), true, mode);
  }
});
