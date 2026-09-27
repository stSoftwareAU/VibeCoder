/**
 * The `copilot_code_review` host setting (Issue #2701).
 *
 * Copilot code review is billed per review, so the host says whether setup
 * turns it on, off, or leaves each repository as it is. Absent means
 * `leave`, so an existing host changes nothing; anything else that is not
 * one of the three values fails the config load, naming the field.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.).
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import {
  COPILOT_CODE_REVIEW_MODES,
  DEFAULT_COPILOT_CODE_REVIEW,
} from "../lib/config_defaults.ts";
import { parseCopilotCodeReview } from "../lib/config_validator.ts";
import { detectUnknownConfigKeys } from "../lib/config_unknown_keys.ts";

/** Write an arbitrary (possibly invalid) config object to a temp file. */
async function withTempConfig(
  config: Record<string, unknown>,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "vibe-copilot-config-" });
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

const BASE = { allowed_authors: ["testuser"], repos: ["org/repo"] };

Deno.test("copilot_code_review - absent means leave, so an existing host changes nothing (Issue #2701)", () => {
  assertEquals(DEFAULT_COPILOT_CODE_REVIEW, "leave");
  assertEquals(parseCopilotCodeReview(undefined), {
    ok: true,
    value: "leave",
  });
});

Deno.test("copilot_code_review - on, off and leave are the accepted values (Issue #2701)", () => {
  assertEquals([...COPILOT_CODE_REVIEW_MODES], ["on", "off", "leave"]);
  for (const mode of COPILOT_CODE_REVIEW_MODES) {
    assertEquals(parseCopilotCodeReview(mode), { ok: true, value: mode });
  }
});

Deno.test("copilot_code_review - anything else is refused, naming the field and the accepted values (Issue #2701)", () => {
  for (const raw of ["enabled", "OFF", "", true, 1, null, ["off"]]) {
    const parsed = parseCopilotCodeReview(raw);
    assertEquals(parsed.ok, false, `${JSON.stringify(raw)} must be refused`);
    if (parsed.ok) continue;
    assertStringIncludes(parsed.error, "copilot_code_review");
    assertStringIncludes(parsed.error, "on, off, leave");
  }
});

Deno.test("copilot_code_review - the key is known, so no unknown-key warning is raised (Issue #2701)", () => {
  const warnings = detectUnknownConfigKeys({
    ...BASE,
    copilot_code_review: "off",
  });
  assertEquals(warnings.map((w) => w.field), []);
});

Deno.test("copilot_code_review - a valid value loads (Issue #2701)", async () => {
  await withTempConfig(
    { ...BASE, copilot_code_review: "off" },
    async (configPath) => {
      await loadConfig(configPath);
    },
  );
});

Deno.test("copilot_code_review - an invalid value fails the load loudly (Issue #2701)", async () => {
  await withTempConfig(
    { ...BASE, copilot_code_review: "sometimes" },
    async (configPath) => {
      await assertRejects(
        () => loadConfig(configPath),
        Error,
        "copilot_code_review",
      );
    },
  );
});
