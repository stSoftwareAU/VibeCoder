/**
 * Tests for provider-scoped usage cooldowns (Issue #1696).
 *
 * Uses Australian English spelling (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  isHostRateLimitPauseActive,
  usageSignalBlocksProvider,
  usageSignalIsForAnotherCredential,
  usageSignalPausesHost,
} from "../lib/provider_quota_scope.ts";
import {
  type RateLimitSignalData,
  writeRateLimitSignal,
} from "../lib/rate_limit_signal.ts";

function signal(
  kind: RateLimitSignalData["kind"],
  provider?: string,
): RateLimitSignalData {
  return {
    timestamp: 1,
    waitSeconds: 60,
    kind,
    ...(provider ? { provider } : {}),
  };
}

Deno.test("usageSignalBlocksProvider - GitHub blocks every provider", () => {
  const s = signal("github");
  assertEquals(usageSignalBlocksProvider(s, "claude"), true);
  assertEquals(usageSignalBlocksProvider(s, "codex"), true);
});

Deno.test("usageSignalBlocksProvider - Claude usage does not block Codex", () => {
  const s = signal("usage", "claude");
  assertEquals(usageSignalBlocksProvider(s, "claude"), true);
  assertEquals(usageSignalBlocksProvider(s, "codex"), false);
});

Deno.test("usageSignalBlocksProvider - a legacy usage signal is Claude", () => {
  const s = signal("usage");
  assertEquals(usageSignalBlocksProvider(s, "claude"), true);
  assertEquals(usageSignalBlocksProvider(s, "codex"), false);
});

Deno.test("usageSignalPausesHost - GitHub always pauses the host", () => {
  assertEquals(
    usageSignalPausesHost(signal("github"), ["claude", "codex"]),
    true,
  );
});

Deno.test("usageSignalPausesHost - Claude-only host pauses on Claude usage", () => {
  assertEquals(
    usageSignalPausesHost(signal("usage", "claude"), ["claude"]),
    true,
  );
});

Deno.test("usageSignalPausesHost - mixed host keeps going when Codex is healthy", () => {
  assertEquals(
    usageSignalPausesHost(signal("usage", "claude"), ["claude", "codex"]),
    false,
  );
});

Deno.test("usageSignalPausesHost - Codex usage does not pause a Claude-only host", () => {
  assertEquals(
    usageSignalPausesHost(signal("usage", "codex"), ["claude"]),
    false,
  );
});

// ---------------------------------------------------------------------------
// Credential-scoped usage signals (Issue #2002)
// ---------------------------------------------------------------------------

function labelled(
  provider: string,
  credentialLabel: string,
): RateLimitSignalData {
  return { ...signal("usage", provider), credentialLabel };
}

Deno.test("usageSignalPausesHost - a signal naming another credential of the held provider does not pause (Issue #2002)", () => {
  assertEquals(
    usageSignalPausesHost(
      labelled("claude", "provider"),
      ["claude"],
      "provider-3",
    ),
    false,
  );
});

Deno.test("usageSignalPausesHost - a signal naming the held credential still pauses (Issue #2002)", () => {
  assertEquals(
    usageSignalPausesHost(
      labelled("claude", "provider"),
      ["claude"],
      "provider",
    ),
    true,
  );
});

Deno.test("usageSignalPausesHost - an unlabelled signal keeps the host-wide pause whatever the run holds (Issue #2002)", () => {
  assertEquals(
    usageSignalPausesHost(signal("usage", "claude"), ["claude"], "provider-3"),
    true,
  );
});

Deno.test("usageSignalPausesHost - a labelled signal pauses a run whose own credential is unknown (Issue #2002)", () => {
  assertEquals(
    usageSignalPausesHost(
      labelled("claude", "provider"),
      ["claude"],
      undefined,
    ),
    true,
  );
});

Deno.test("usageSignalPausesHost - a GitHub signal pauses regardless of credentials (Issue #2002)", () => {
  assertEquals(
    usageSignalPausesHost(
      { ...signal("github"), credentialLabel: "provider" },
      ["claude"],
      "provider-3",
    ),
    true,
  );
});

Deno.test("usageSignalIsForAnotherCredential - both sides known and different, and nothing else", () => {
  assertEquals(
    usageSignalIsForAnotherCredential(
      labelled("claude", "provider"),
      "provider-3",
    ),
    true,
  );
  assertEquals(
    usageSignalIsForAnotherCredential(
      labelled("claude", "provider"),
      "provider",
    ),
    false,
  );
  assertEquals(
    usageSignalIsForAnotherCredential(labelled("claude", " "), "provider-3"),
    false,
  );
  assertEquals(
    usageSignalIsForAnotherCredential(signal("usage", "claude"), "provider-3"),
    false,
  );
  assertEquals(
    usageSignalIsForAnotherCredential(labelled("claude", "provider"), ""),
    false,
  );
});

Deno.test("isHostRateLimitPauseActive - a restart holding a fresh subscription is not paused by the spent one's signal, and says so once (Issue #2002)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "quota_scope_2002_" });
  try {
    const written = await writeRateLimitSignal(
      workDir,
      289_493,
      Date.now() + 289_493_000,
      "usage",
      { provider: "claude", credentialLabel: "provider" },
    );
    assertEquals(written.ok, true);
    const lines: string[] = [];
    const options = {
      heldCredentialLabel: () => "provider-3",
      log: (line: string) => lines.push(line),
    };

    assertEquals(
      await isHostRateLimitPauseActive(workDir, ["claude"], undefined, options),
      false,
      "the run holds provider-3; the signal names provider",
    );
    assertEquals(
      await isHostRateLimitPauseActive(workDir, ["claude"], undefined, options),
      false,
    );
    assertEquals(lines.length, 1, "explained once, not on every poll");
    assertEquals(lines[0]?.includes("claude/provider as spent"), true);
    assertEquals(lines[0]?.includes("holds claude/provider-3"), true);

    // The run that still holds the spent subscription is paused as before.
    assertEquals(
      await isHostRateLimitPauseActive(workDir, ["claude"], undefined, {
        heldCredentialLabel: () => "provider",
        log: (line: string) => lines.push(line),
      }),
      true,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("isHostRateLimitPauseActive - an honoured usage pause says which credential the signal names, which the run holds and why it pauses, once (Issue #2024)", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "quota_scope_2024_" });
  try {
    // Unlabelled, as a pre-#2002 worker wrote it.
    assertEquals(
      (await writeRateLimitSignal(workDir, 286_110, undefined, "usage")).ok,
      true,
    );
    const lines: string[] = [];
    const options = {
      heldCredentialLabel: () => "provider-3",
      log: (line: string) => lines.push(line),
    };
    assertEquals(
      await isHostRateLimitPauseActive(workDir, ["claude"], undefined, options),
      true,
    );
    assertEquals(
      await isHostRateLimitPauseActive(workDir, ["claude"], undefined, options),
      true,
    );
    assertEquals(lines.length, 1, "explained once, not on every poll");
    assertEquals(
      lines[0]?.includes("names claude as spent but no credential"),
      true,
      lines[0],
    );
    assertEquals(lines[0]?.includes("holds claude/provider-3"), true, lines[0]);
    assertEquals(lines[0]?.includes("pausing the host"), true, lines[0]);
    assertEquals(lines[0]?.includes("names no credential"), true, lines[0]);

    // The run that holds the spent subscription itself.
    assertEquals(
      (await writeRateLimitSignal(workDir, 286_110, undefined, "usage", {
        provider: "claude",
        credentialLabel: "provider-3",
      })).ok,
      true,
    );
    assertEquals(
      await isHostRateLimitPauseActive(workDir, ["claude"], undefined, options),
      true,
    );
    assertEquals(lines.length, 2);
    assertEquals(
      lines[1]?.includes("names claude/provider-3 as spent"),
      true,
      lines[1],
    );
    assertEquals(
      lines[1]?.includes("holds the spent subscription"),
      true,
      lines[1],
    );

    // A run that recorded no credential of its own.
    assertEquals(
      await isHostRateLimitPauseActive(workDir, ["claude"], undefined, {
        heldCredentialLabel: () => undefined,
        log: options.log,
      }),
      true,
    );
    assertEquals(lines.length, 3);
    assertEquals(
      lines[2]?.includes("recorded no claude credential"),
      true,
      lines[2],
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
