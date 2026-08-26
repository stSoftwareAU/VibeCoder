/**
 * Tests for the per-model coding-guidelines overlay (Issue #374).
 *
 * The overlay is the seam that lets a genuinely model-specific working-style
 * note ride on top of the model-agnostic `coding_guidelines` baseline
 * (Issue #373). These tests cover the identity → prompt-name mapping, the
 * loader's precedence (model-specific before provider-wide), and the two
 * failure boundaries: an absent overlay is not an error, a present but
 * version-less overlay directory is.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  codingGuidelinesOverlayNames,
  loadCodingGuidelinesOverlay,
} from "../lib/coding_guidelines_overlay.ts";
import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
} from "../lib/agent_provider.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

/** Build a throwaway prompts directory carrying the given overlay files. */
async function withPromptsDir(
  files: Record<string, string>,
  run: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "cg_overlay_" });
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const abs = `${dir}/${relPath}`;
      await Deno.mkdir(abs.slice(0, abs.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(abs, content);
    }
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

// --- codingGuidelinesOverlayNames ---

Deno.test("overlay names - no identity yields no candidates", () => {
  assertEquals(codingGuidelinesOverlayNames(), []);
  assertEquals(codingGuidelinesOverlayNames({}), []);
  assertEquals(codingGuidelinesOverlayNames({ provider: "   " }), []);
});

Deno.test("overlay names - a provider alone keys one candidate", () => {
  assertEquals(codingGuidelinesOverlayNames({ provider: CLAUDE_PROVIDER_ID }), [
    "coding_guidelines_claude",
  ]);
});

Deno.test("overlay names - the model-specific candidate is preferred", () => {
  assertEquals(
    codingGuidelinesOverlayNames({
      provider: CLAUDE_PROVIDER_ID,
      model: "opus",
    }),
    ["coding_guidelines_claude_opus", "coding_guidelines_claude"],
  );
});

Deno.test("overlay names - a model without a provider keys nothing", () => {
  // Overlays are keyed off the provider identity; a bare model id is not an
  // identity this seam recognises, and must not be guessed at.
  assertEquals(codingGuidelinesOverlayNames({ model: "opus" }), []);
});

Deno.test("overlay names - identities are slugged into a single path segment", () => {
  const names = codingGuidelinesOverlayNames({
    provider: "../../etc",
    model: "Claude Opus 4.5",
  });
  for (const name of names) {
    assert(!name.includes("/"), `candidate must not contain a slash: ${name}`);
    assert(!name.includes(".."), `candidate must not traverse: ${name}`);
    assert(
      /^coding_guidelines_[a-z0-9][a-z0-9_-]*$/.test(name),
      `candidate must be a plain prompt-type name: ${name}`,
    );
  }
  assertEquals(names[0], "coding_guidelines_etc_claude-opus-4-5");
});

// --- loadCodingGuidelinesOverlay ---

Deno.test("overlay load - absent overlay resolves to undefined, not an error", async () => {
  await withPromptsDir({}, async (dir) => {
    const result = await loadCodingGuidelinesOverlay(
      { provider: CODEX_PROVIDER_ID },
      dir,
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, undefined);
  });
});

Deno.test("overlay load - unknown identity resolves to undefined, not a throw", async () => {
  await withPromptsDir(
    { "coding_guidelines_claude/v1.md": "Claude overlay" },
    async (dir) => {
      const result = await loadCodingGuidelinesOverlay(
        { provider: "no-such-agent-9000" },
        dir,
      );
      assertEquals(result.ok, true);
      if (result.ok) assertEquals(result.value, undefined);
    },
  );
});

Deno.test("overlay load - loads the latest version of the provider overlay", async () => {
  await withPromptsDir({
    "coding_guidelines_claude/v1.md": "old overlay",
    "coding_guidelines_claude/v2.md": "new overlay",
  }, async (dir) => {
    const result = await loadCodingGuidelinesOverlay(
      { provider: CLAUDE_PROVIDER_ID },
      dir,
    );
    assertEquals(result.ok, true);
    if (result.ok) assertEquals(result.value, "new overlay");
  });
});

Deno.test("overlay load - a model overlay wins over the provider overlay", async () => {
  await withPromptsDir({
    "coding_guidelines_claude/v1.md": "provider overlay",
    "coding_guidelines_claude_opus/v1.md": "model overlay",
  }, async (dir) => {
    const model = await loadCodingGuidelinesOverlay(
      { provider: CLAUDE_PROVIDER_ID, model: "opus" },
      dir,
    );
    assertEquals(model.ok, true);
    if (model.ok) assertEquals(model.value, "model overlay");

    // A model with no overlay of its own falls back to the provider's.
    const fallback = await loadCodingGuidelinesOverlay(
      { provider: CLAUDE_PROVIDER_ID, model: "haiku" },
      dir,
    );
    assertEquals(fallback.ok, true);
    if (fallback.ok) assertEquals(fallback.value, "provider overlay");
  });
});

Deno.test("overlay load - one provider's overlay never leaks into another's run", async () => {
  await withPromptsDir(
    { "coding_guidelines_claude/v1.md": "CLAUDE ONLY" },
    async (dir) => {
      for (const provider of [CODEX_PROVIDER_ID, GEMINI_PROVIDER_ID]) {
        const result = await loadCodingGuidelinesOverlay({ provider }, dir);
        assertEquals(result.ok, true);
        if (result.ok) assertEquals(result.value, undefined);
      }
    },
  );
});

Deno.test("overlay load - a version-less overlay directory fails loud", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cg_overlay_" });
  try {
    // The directory exists (so it was authored deliberately) but carries no
    // vN.md: reporting "no overlay" here would mask the authoring mistake.
    await Deno.mkdir(`${dir}/coding_guidelines_claude`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/coding_guidelines_claude/draft.md`,
      "not a version",
    );

    const result = await loadCodingGuidelinesOverlay(
      { provider: CLAUDE_PROVIDER_ID },
      dir,
    );
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "coding_guidelines_claude");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- the shipped worked example ---

Deno.test("overlay - the shipped Claude overlay loads and is Playwright-free", async () => {
  const result = await loadCodingGuidelinesOverlay(
    { provider: CLAUDE_PROVIDER_ID },
    PROMPTS_DIR,
  );
  assertEquals(result.ok, true);
  if (result.ok) {
    assert(result.value !== undefined, "the worked example must be shipped");
    assertEquals(result.value!.includes("Playwright"), false);
  }
});
