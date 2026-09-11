/**
 * Tests for credential-scoped usage signals (Issue #2002).
 *
 * The fault these pin: a spent subscription's usage signal was read as a
 * host-wide fact. On GRQ-25 the health check wrote an 80-hour usage signal
 * for the token the run happened to hold, and every subsequent restart — each
 * having selected a *different* subscription with a full window — was paused
 * by that same signal in the GitHub pre-flight, 25 times, with zero issues
 * worked.
 *
 * Each test below pins one link of that chain:
 *
 * - the GitHub pre-flight honours a GitHub signal and ignores a usage one;
 * - a usage signal names the credential that ran out;
 * - the host pause is not applied to a run holding a different credential;
 * - the spent label can be read back, so the restart question can exclude it;
 * - start-up ranking excludes a credential the active signal names spent,
 *   even when every budget probe failed.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  activeCredentialLabel,
  clearActiveCredentialLabels,
  usageSignalScope,
} from "../lib/active_credential.ts";
import {
  activeUsageSignalScope,
  activeUsageSignalSpentLabel,
  isHostRateLimitPauseActive,
  quotaPauseSpentLabel,
  usageSignalPausesHost,
} from "../lib/provider_quota_scope.ts";
import {
  type RateLimitSignalData,
  writeRateLimitSignal,
} from "../lib/rate_limit_signal.ts";
import { preflightGitHubRateLimit } from "../lib/github_rate_limit_preflight.ts";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import { applyProviderCredentialEnv } from "../lib/credential_preflight.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";
import {
  type AgentProviderDescriptor,
  CLAUDE_PROVIDER_ID,
  resolveAgentProvider,
} from "../lib/agent_provider.ts";

const CLAUDE: AgentProviderDescriptor = resolveAgentProvider(
  CLAUDE_PROVIDER_ID,
);

/** A usage signal naming a provider and, optionally, the spent credential. */
function usageSignal(
  provider: string | undefined,
  credentialLabel?: string,
): RateLimitSignalData {
  return {
    timestamp: 1,
    waitSeconds: 289_493,
    kind: "usage",
    ...(provider ? { provider } : {}),
    ...(credentialLabel ? { credentialLabel } : {}),
  };
}

// ===========================================================================
// 1. The GitHub pre-flight is about GitHub quota, not model quota
// ===========================================================================

Deno.test("preflight - an active usage signal does not stop the run before init", async () => {
  const dir = await Deno.makeTempDir();
  try {
    // The exact GRQ-25 shape: a Claude weekly-limit signal with 80 hours left.
    await writeRateLimitSignal(dir, 289_493, undefined, "usage", {
      provider: "claude",
      credentialLabel: "provider",
    });
    let ghCalls = 0;
    const outcome = await preflightGitHubRateLimit({
      workDir: dir,
      nowSeconds: () => 1000,
      noCache: true,
      runGhRateLimit: () => {
        ghCalls++;
        return Promise.resolve(
          JSON.stringify({
            resources: {
              graphql: { limit: 5000, used: 200, remaining: 4800, reset: 9999 },
            },
          }),
        );
      },
      log: () => {},
    });

    assertEquals(
      outcome.rateLimited,
      false,
      "a Claude usage limit is not a GitHub quota fact",
    );
    assertEquals(ghCalls, 1, "the real GitHub quota is what decides");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preflight - an active GitHub signal still short-circuits", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeRateLimitSignal(dir, 600, undefined, "github");
    let ghCalls = 0;
    const outcome = await preflightGitHubRateLimit({
      workDir: dir,
      nowSeconds: () => Math.floor(Date.now() / 1000),
      runGhRateLimit: () => {
        ghCalls++;
        return Promise.resolve("{}");
      },
      log: () => {},
    });

    assertEquals(outcome.rateLimited, true);
    assertEquals(ghCalls, 0, "a GitHub block needs no further call");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ===========================================================================
// 2. A usage signal names the credential that ran out
// ===========================================================================

Deno.test("active credential - the exported token's label is what a usage signal carries", async () => {
  clearActiveCredentialLabels();
  const dir = await Deno.makeTempDir();
  try {
    const claudeDir = `${dir}/${CLAUDE.credentials.subdir}`;
    await Deno.mkdir(claudeDir, { recursive: true });
    await Deno.writeTextFile(
      `${claudeDir}/provider-2.env`,
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-second\n",
    );

    const env = new Map<string, string>();
    const exported = await applyProviderCredentialEnv({
      dir,
      env: (name) => env.get(name),
      setEnv: (name, value) => {
        env.set(name, value);
      },
      providers: [CLAUDE],
    });

    assert(exported.length > 0, "the token file must actually be exported");
    assertEquals(activeCredentialLabel(CLAUDE_PROVIDER_ID), "provider-2");
    assertEquals(usageSignalScope(CLAUDE_PROVIDER_ID), {
      provider: "claude",
      credentialLabel: "provider-2",
    });
  } finally {
    clearActiveCredentialLabels();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("active credential - an unrecorded label leaves the signal host-wide, as before", () => {
  clearActiveCredentialLabels();
  assertEquals(usageSignalScope("claude"), { provider: "claude" });
});

// ===========================================================================
// 3. The host pause is scoped to the credential the signal names
// ===========================================================================

Deno.test("usageSignalPausesHost - a run holding a different credential is not paused", () => {
  assertEquals(
    usageSignalPausesHost(
      usageSignal("claude", "provider"),
      ["claude"],
      "provider-3",
    ),
    false,
  );
});

Deno.test("usageSignalPausesHost - the credential the signal names is paused", () => {
  assertEquals(
    usageSignalPausesHost(
      usageSignal("claude", "provider"),
      ["claude"],
      "provider",
    ),
    true,
  );
});

Deno.test("usageSignalPausesHost - a legacy signal with no label keeps today's behaviour", () => {
  assertEquals(
    usageSignalPausesHost(usageSignal("claude"), ["claude"], "provider-3"),
    true,
  );
  assertEquals(
    usageSignalPausesHost(usageSignal("claude", "provider"), ["claude"]),
    true,
  );
});

Deno.test("usageSignalPausesHost - a GitHub signal pauses whatever credential is held", () => {
  assertEquals(
    usageSignalPausesHost(
      { timestamp: 1, waitSeconds: 60, kind: "github" },
      ["claude"],
      "provider-3",
    ),
    true,
  );
});

// ===========================================================================
// 4. The spent label is readable, so the restart question can exclude it
// ===========================================================================

Deno.test("activeUsageSignalSpentLabel - names the spent credential of an active usage signal", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeRateLimitSignal(dir, 289_493, undefined, "usage", {
      provider: "claude",
      credentialLabel: "provider",
    });
    assertEquals(
      await activeUsageSignalSpentLabel(dir, CLAUDE_PROVIDER_ID),
      "provider",
    );
    assertEquals(
      await activeUsageSignalSpentLabel(dir, "codex"),
      undefined,
      "another vendor's pool is not named by a Claude signal",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("activeUsageSignalSpentLabel - an expired, GitHub or absent signal names nobody", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(
      await activeUsageSignalSpentLabel(dir, CLAUDE_PROVIDER_ID),
      undefined,
      "no signal file",
    );
    await writeRateLimitSignal(dir, 600, undefined, "github", {
      credentialLabel: "provider",
    });
    assertEquals(
      await activeUsageSignalSpentLabel(dir, CLAUDE_PROVIDER_ID),
      undefined,
      "a GitHub block is not a credential's exhaustion",
    );
    await writeRateLimitSignal(dir, 60, undefined, "usage", {
      provider: "claude",
      credentialLabel: "provider",
    });
    assertEquals(
      await activeUsageSignalSpentLabel(
        dir,
        CLAUDE_PROVIDER_ID,
        () => Math.floor(Date.now() / 1000) + 600,
      ),
      undefined,
      "an expired signal names nobody",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ===========================================================================
// 5. Start-up never re-picks the credential the active signal calls spent
// ===========================================================================

/** A discovered pool token file. */
function tokenFile(label: string): ProviderTokenFile {
  const name = "CLAUDE_CODE_OAUTH_TOKEN";
  const value = `token-${label}`;
  return {
    label,
    path: `/creds/claude/${label}.env`,
    name,
    value,
    primary: label === "provider",
    poolMember: true,
    entries: [{ name, value }],
  };
}

Deno.test("pool start-up - a bad-probe start cannot re-pick the credential the signal named", async () => {
  // The GRQ-25 start: every probe answered http-429, so ranking fell back to
  // discovery order and exported the weekly-spent primary. The active signal
  // already knew that token was spent.
  const lines: string[] = [];
  const tokens = [tokenFile("provider"), tokenFile("provider-2")];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () => Promise.resolve(tokens),
    fetchFn: () => Promise.resolve(new Response("slow down", { status: 429 })),
    now: () => Date.now(),
    log: (line) => lines.push(line),
    spentCredentialLabel: () => Promise.resolve("provider"),
  });

  const started = await pool.selectToken(tokens, CLAUDE);
  assertEquals(started?.label, "provider-2");
  assert(
    lines.some((line) => line.includes("provider") && line.includes("spent")),
    `the exclusion must be on the record: ${lines.join(" | ")}`,
  );
});

Deno.test("pool start-up - a signal naming a token outside the pool changes nothing", async () => {
  const tokens = [tokenFile("provider"), tokenFile("provider-2")];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () => Promise.resolve(tokens),
    fetchFn: () => Promise.resolve(new Response("slow down", { status: 429 })),
    now: () => Date.now(),
    spentCredentialLabel: () => Promise.resolve("provider-9"),
  });

  const started = await pool.selectToken(tokens, CLAUDE);
  assertEquals(started?.label, "provider", "discovery order still decides");
});

Deno.test("pool start-up - the last candidate is still started on when the signal names it", async () => {
  // Refusing to start is never an option: a host whose only remaining token
  // is the spent one starts on it rather than not starting at all.
  const tokens = [tokenFile("provider"), tokenFile("provider-2")];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () => Promise.resolve(tokens),
    fetchFn: () => Promise.resolve(new Response("slow down", { status: 429 })),
    now: () => Date.now(),
    spentCredentialLabel: () => Promise.resolve("provider-2"),
  });
  assertEquals((await pool.selectToken(tokens, CLAUDE))?.label, "provider");

  const single = [tokenFile("provider")];
  const onlyOne = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () => Promise.resolve(single),
    fetchFn: () => Promise.resolve(new Response("slow down", { status: 429 })),
    now: () => Date.now(),
    spentCredentialLabel: () => Promise.resolve("provider"),
  });
  assertEquals((await onlyOne.selectToken(single, CLAUDE))?.label, "provider");
});

Deno.test("pool start-up - the spent label is asked for the provider being ranked", async () => {
  // A label is a file stem every vendor reproduces, so the pool must name the
  // provider it is ranking or a Claude exhaustion would exclude a healthy
  // Codex credential of the same name.
  const asked: string[] = [];
  const tokens = [tokenFile("provider"), tokenFile("provider-2")];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () => Promise.resolve(tokens),
    fetchFn: () => Promise.resolve(new Response("slow down", { status: 429 })),
    now: () => Date.now(),
    spentCredentialLabel: (providerId) => {
      asked.push(providerId);
      return Promise.resolve(undefined);
    },
  });

  await pool.selectToken(tokens, CLAUDE);
  assertEquals(asked, [CLAUDE_PROVIDER_ID]);
});

Deno.test("pool mid-run - a switch never lands on the credential the signal named", async () => {
  // The same defect one call later: selectEligible chooses what the run
  // switches to, and switching onto the spent token is exactly the loop the
  // exclusion exists to stop.
  const tokens = [tokenFile("provider"), tokenFile("provider-2")];
  const pool = createClaudeCredentialPool({
    provider: CLAUDE,
    discover: () => Promise.resolve(tokens),
    fetchFn: (_url: string, init: RequestInit) => {
      const auth = String(
        (init.headers as Record<string, string>)["authorization"] ?? "",
      );
      // Both tokens probe as healthy; only the signal separates them.
      return Promise.resolve(
        new Response(auth.length > 0 ? "{}" : "no auth", {
          status: 200,
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": "0.1",
            "anthropic-ratelimit-unified-5h-reset": String(
              Math.round((Date.now() + 3_600_000) / 1000),
            ),
            "anthropic-ratelimit-unified-7d-utilization": "0.2",
            "anthropic-ratelimit-unified-7d-reset": String(
              Math.round((Date.now() + 360_000_000) / 1000),
            ),
            "anthropic-ratelimit-unified-representative-claim": "five_hour",
          },
        }),
      );
    },
    now: () => Date.now(),
    spentCredentialLabel: () => Promise.resolve("provider"),
  });

  assertEquals((await pool.selectEligible())?.label, "provider-2");
});

// ===========================================================================
// 6. The host pause, end to end through the signal file
// ===========================================================================

Deno.test("isHostRateLimitPauseActive - a different held credential keeps the host working", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeRateLimitSignal(dir, 289_493, undefined, "usage", {
      provider: "claude",
      credentialLabel: "provider",
    });
    assertEquals(
      await isHostRateLimitPauseActive(
        dir,
        ["claude"],
        undefined,
        () => "provider-3",
      ),
      false,
      "this run holds a subscription the signal says nothing about",
    );
    assertEquals(
      await isHostRateLimitPauseActive(
        dir,
        ["claude"],
        undefined,
        () => "provider",
      ),
      true,
      "the run holding the spent subscription still pauses",
    );
    assertEquals(
      await isHostRateLimitPauseActive(
        dir,
        ["claude"],
        undefined,
        () => undefined,
      ),
      true,
      "a run that recorded no credential keeps the host-wide behaviour",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("isHostRateLimitPauseActive - a GitHub block still drains the host", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeRateLimitSignal(dir, 600, undefined, "github");
    assertEquals(
      await isHostRateLimitPauseActive(
        dir,
        ["claude"],
        undefined,
        () => "provider-3",
      ),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ===========================================================================
// 7. Across the container boundary, and not destroying the evidence
// ===========================================================================

Deno.test("quotaPauseSpentLabel - the marker carries the spent credential to the host", () => {
  // The signal file lives on the work volume the host cannot read, so the
  // restart question learns the label from the quota-pause marker instead.
  assertEquals(
    quotaPauseSpentLabel(
      { provider: "claude", credentialLabel: "provider" },
      CLAUDE_PROVIDER_ID,
    ),
    "provider",
  );
  assertEquals(
    quotaPauseSpentLabel({ credentialLabel: "provider" }, CLAUDE_PROVIDER_ID),
    "provider",
    "a marker with no provider reads as Claude",
  );
  assertEquals(
    quotaPauseSpentLabel(
      { provider: "codex", credentialLabel: "provider" },
      CLAUDE_PROVIDER_ID,
    ),
    undefined,
    "another vendor's exhaustion names no Claude credential",
  );
  assertEquals(quotaPauseSpentLabel(null, CLAUDE_PROVIDER_ID), undefined);
});

Deno.test("activeUsageSignalScope - reports the provider and credential for the marker", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await writeRateLimitSignal(dir, 289_493, undefined, "usage", {
      provider: "claude",
      credentialLabel: "provider",
    });
    assertEquals(await activeUsageSignalScope(dir), {
      provider: "claude",
      credentialLabel: "provider",
    });
    await writeRateLimitSignal(dir, 600, undefined, "github");
    assertEquals(await activeUsageSignalScope(dir), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("preflight - a GitHub block does not overwrite a live usage signal", async () => {
  // One signal file, two blocks. Overwriting the 80-hour usage signal with a
  // one-hour GitHub one would discard the spent credential's name, leaving
  // nothing on disk to scope the model quota by once the GitHub wait expires.
  const dir = await Deno.makeTempDir();
  try {
    await writeRateLimitSignal(dir, 289_493, undefined, "usage", {
      provider: "claude",
      credentialLabel: "provider",
    });
    const outcome = await preflightGitHubRateLimit({
      workDir: dir,
      nowSeconds: () => Math.floor(Date.now() / 1000),
      noCache: true,
      runGhRateLimit: () =>
        Promise.resolve(
          JSON.stringify({
            resources: {
              graphql: {
                limit: 5000,
                used: 4999,
                remaining: 1,
                reset: Math.floor(Date.now() / 1000) + 600,
              },
            },
          }),
        ),
      log: () => {},
    });

    assertEquals(outcome.rateLimited, true, "the GitHub block is still real");
    const signal = JSON.parse(
      await Deno.readTextFile(`${dir}/.rate_limit_signal`),
    );
    assertEquals(signal.kind, "usage");
    assertEquals(signal.credentialLabel, "provider");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("active credential - an environment-provided credential records no label", async () => {
  // Nothing was established from the file, so the run may be holding an
  // operator's env credential; claiming the file's label would scope a signal
  // to the wrong subscription.
  clearActiveCredentialLabels();
  const dir = await Deno.makeTempDir();
  try {
    const claudeDir = `${dir}/${CLAUDE.credentials.subdir}`;
    await Deno.mkdir(claudeDir, { recursive: true });
    await Deno.writeTextFile(
      `${claudeDir}/provider.env`,
      "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-file\n",
    );
    const env = new Map<string, string>([[
      "CLAUDE_CODE_OAUTH_TOKEN",
      "sk-ant-oat-from-the-environment",
    ]]);
    const exported = await applyProviderCredentialEnv({
      dir,
      env: (name) => env.get(name),
      setEnv: (name, value) => {
        env.set(name, value);
      },
      providers: [CLAUDE],
    });

    assertEquals(exported, [], "an existing variable is never clobbered");
    assertEquals(activeCredentialLabel(CLAUDE_PROVIDER_ID), undefined);
  } finally {
    clearActiveCredentialLabels();
    await Deno.remove(dir, { recursive: true });
  }
});
