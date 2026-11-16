/**
 * Unit tests for the model-scoped usage-limit detector and cooldown store
 * (Issue #5086).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { detectModelScopedUsageLimit } from "../lib/claude_executor.ts";
import {
  firstModelNotCooling,
  modelUsageCooldownPath,
  readActiveModelCooldown,
  recordModelUsageCooldown,
} from "../lib/model_usage_cooldown.ts";

const ACCEPTED: Array<[string, string]> = [
  [
    "You've reached your Fable limit. Switch to another model to continue.",
    "fable",
  ],
  ["You have reached your Fable limit", "fable"],
  ["You've hit your Fable weekly limit · resets Nov 20, 1am (UTC)", "fable"],
  ["You've reached your Claude Fable 5.2 limit", "fable"],
  ["Opus weekly limit reached ∙ resets Oct 9, 10am", "opus"],
  ["Fable limit reached", "fable"],
  [
    "API Error: You've reached your Fable limit. Switch to another model to continue.",
    "fable",
  ],
  [
    "Error: You've hit your Fable weekly limit · resets Nov 20, 1am (UTC)",
    "fable",
  ],
];

for (const [message, family] of ACCEPTED) {
  Deno.test(`detectModelScopedUsageLimit accepts: ${message}`, () => {
    assertEquals(detectModelScopedUsageLimit(message), family);
  });
}

const REJECTED = [
  "I see you've reached your Fable limit in the docs",
  "You've hit your usage limit · resets 1:50pm (UTC)",
  "You've hit your session limit · resets 1:50pm (UTC)",
  "You've hit your limit · resets 3am",
  "Claude AI usage limit reached|1700000000",
  "You've hit your weekly limit · resets 1am (UTC)",
  "You've hit your usage limit for gpt-5.2-codex-sonic. Switch to another model now, or try again at 3:45 PM.",
];

for (const message of REJECTED) {
  Deno.test(`detectModelScopedUsageLimit rejects account-wide: ${message}`, () => {
    assertEquals(detectModelScopedUsageLimit(message), null);
  });
}

Deno.test("detectModelScopedUsageLimit reads only the tail", () => {
  const output = "You've reached your Fable limit\n" +
    "filler\n".repeat(40);
  assertEquals(detectModelScopedUsageLimit(output), null);
  assertEquals(detectModelScopedUsageLimit(output, 100), "fable");
});

Deno.test("detectModelScopedUsageLimit handles a hostile long line", () => {
  // 100k+ characters the regex must actually walk; the trailing "x" is a
  // character the pattern rejects, so the exact result is null.
  const hostile = "You've reached your Fable ".repeat(4000) + "x";
  assert(hostile.length > 100_000);
  assertEquals(detectModelScopedUsageLimit(hostile), null);
  // The same long line ending in a genuine message still matches.
  assertEquals(
    detectModelScopedUsageLimit(
      "Fable ".repeat(20000) + "\nYou've reached your Fable limit",
    ),
    "fable",
  );
});

const cheaper = (m: string): string | null =>
  ({ fable: "opus", opus: "sonnet", sonnet: "haiku" } as Record<
    string,
    string
  >)[m] ??
    null;

Deno.test("cooldown store records and reads an active entry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "muc_" });
  try {
    const rec = await recordModelUsageCooldown(dir, {
      provider: "claude",
      model: "claude-fable-5-2",
      untilEpochMs: 2000,
      nowMs: 1000,
    });
    assert(rec.ok);
    const read = await readActiveModelCooldown(dir, "claude", "fable", 1500);
    assert(read.ok);
    assertEquals(read.value, { untilEpochMs: 2000 });
    // Other provider / family: none.
    const other = await readActiveModelCooldown(dir, "codex", "fable", 1500);
    assert(other.ok);
    assertEquals(other.value, undefined);
    const opus = await readActiveModelCooldown(dir, "claude", "opus", 1500);
    assert(opus.ok);
    assertEquals(opus.value, undefined);
    // Expired.
    const expired = await readActiveModelCooldown(dir, "claude", "fable", 2000);
    assert(expired.ok);
    assertEquals(expired.value, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cooldown store: missing file is no cooldown", async () => {
  const dir = await Deno.makeTempDir({ prefix: "muc_" });
  try {
    const read = await readActiveModelCooldown(dir, "claude", "fable", 1);
    assert(read.ok);
    assertEquals(read.value, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cooldown store: malformed file and unknown version fail loud", async () => {
  const dir = await Deno.makeTempDir({ prefix: "muc_" });
  try {
    const path = modelUsageCooldownPath(dir);
    await Deno.writeTextFile(path, "{not json");
    const bad = await readActiveModelCooldown(dir, "claude", "fable", 1);
    assert(!bad.ok);
    assertStringIncludes(bad.error.message, path);

    await Deno.writeTextFile(
      path,
      JSON.stringify({ version: 2, cooldowns: {} }),
    );
    const unknown = await readActiveModelCooldown(dir, "claude", "fable", 1);
    assert(!unknown.ok);
    assertStringIncludes(unknown.error.message, path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("firstModelNotCooling steps down over cooling rungs", async () => {
  const dir = await Deno.makeTempDir({ prefix: "muc_" });
  try {
    const none = await firstModelNotCooling(dir, "claude", "fable", 1, cheaper);
    assert(none.ok);
    assertEquals(none.value, { model: "fable", skipped: [] });

    await recordModelUsageCooldown(dir, {
      provider: "claude",
      model: "fable",
      untilEpochMs: 5000,
      nowMs: 1,
    });
    const one = await firstModelNotCooling(dir, "claude", "fable", 2, cheaper);
    assert(one.ok);
    assertEquals(one.value, { model: "opus", skipped: ["fable"] });

    await recordModelUsageCooldown(dir, {
      provider: "claude",
      model: "opus",
      untilEpochMs: 5000,
      nowMs: 1,
    });
    const two = await firstModelNotCooling(dir, "claude", "fable", 2, cheaper);
    assert(two.ok);
    assertEquals(two.value, { model: "sonnet", skipped: ["fable", "opus"] });

    for (const model of ["sonnet", "haiku"]) {
      await recordModelUsageCooldown(dir, {
        provider: "claude",
        model,
        untilEpochMs: 5000,
        nowMs: 1,
      });
    }
    const all = await firstModelNotCooling(dir, "claude", "fable", 2, cheaper);
    assert(all.ok);
    assertEquals(all.value.model, "haiku");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cooldown store refuses an escaping symlink and oversized content", async () => {
  const dir = await Deno.makeTempDir({ prefix: "muc_bounds_" });
  const outside = await Deno.makeTempFile();
  try {
    const content = JSON.stringify({
      version: 1,
      cooldowns: {
        "claude/fable": { untilEpochMs: 5000, recordedAtEpochMs: 1 },
      },
    });
    await Deno.writeTextFile(outside, content);
    const path = modelUsageCooldownPath(dir);
    await Deno.symlink(outside, path);
    const linked = await readActiveModelCooldown(dir, "claude", "fable", 2);
    assert(!linked.ok);
    assertStringIncludes(linked.error.message, "symlink");
    await Deno.remove(path);
    await Deno.writeTextFile(path, content + " ".repeat(1024 * 1024));
    const oversized = await readActiveModelCooldown(dir, "claude", "fable", 2);
    assert(!oversized.ok);
    assertStringIncludes(oversized.error.message, "exceeds");
    await Deno.writeTextFile(path, content);
    const valid = await readActiveModelCooldown(dir, "claude", "fable", 2);
    assert(valid.ok);
    assertEquals(valid.value, { untilEpochMs: 5000 });
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside);
  }
});
