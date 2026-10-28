/**
 * The trusted capability bundle resolves like prompt templates (Issue #4443).
 *
 * The container runs from a staged copy of worker/deno with no prompts/
 * directory, so the bundle is found through PROMPTS_DIR, then VIBE_BASE_DIR,
 * then the module-relative path, as prompt templates are (Issue #4302). The
 * environment is injected and the process environment is never mutated.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  capabilityBundlePath,
  loadTrustedCapabilityBundle,
} from "../lib/capability_security_guidance.ts";

const SHIPPED_BUNDLE = new URL(
  "../../../prompts/coding_guidelines/capability-security.json",
  import.meta.url,
);

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "capsec-bundle-4443-" });
  try {
    await run(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Write the shipped bundle to `<promptsRoot>/coding_guidelines/`. */
async function writeShippedBundle(promptsRoot: string): Promise<void> {
  const text = await Deno.readTextFile(SHIPPED_BUNDLE);
  await Deno.mkdir(`${promptsRoot}/coding_guidelines`, { recursive: true });
  await Deno.writeTextFile(
    `${promptsRoot}/coding_guidelines/capability-security.json`,
    text,
  );
}

Deno.test("PROMPTS_DIR supplies the trusted bundle (Issue #4443)", async () => {
  await withTempDir(async (tmp) => {
    await writeShippedBundle(tmp);
    const env = (name: string) => name === "PROMPTS_DIR" ? tmp : undefined;
    const load = await loadTrustedCapabilityBundle(env);
    assertEquals(load.kind, "loaded");
    assert(
      capabilityBundlePath(env).startsWith(tmp),
      "the bundle path is under PROMPTS_DIR",
    );
  });
});

Deno.test("VIBE_BASE_DIR supplies the trusted bundle through its prompts/ directory (Issue #4443)", async () => {
  await withTempDir(async (tmp) => {
    await writeShippedBundle(`${tmp}/prompts`);
    const env = (name: string) => name === "VIBE_BASE_DIR" ? tmp : undefined;
    const load = await loadTrustedCapabilityBundle(env);
    assertEquals(load.kind, "loaded");
    assertEquals(
      capabilityBundlePath(env),
      `${tmp}/prompts/coding_guidelines/capability-security.json`,
    );
  });
});

Deno.test("an empty PROMPTS_DIR reports the bundle as missing (Issue #4443)", async () => {
  await withTempDir(async (tmp) => {
    const env = (name: string) => name === "PROMPTS_DIR" ? tmp : undefined;
    const load = await loadTrustedCapabilityBundle(env);
    assert(load.kind === "unreadable", `expected unreadable, got ${load.kind}`);
    assertStringIncludes(load.reason, "is missing");
  });
});
