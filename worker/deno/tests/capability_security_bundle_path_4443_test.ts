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
import { buildIssuePrompt } from "../lib/prompt_builder.ts";

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

Deno.test("a named prompts directory supplies the bundle, never the environment (PR #4463 review)", () => {
  const env = (name: string) =>
    name === "PROMPTS_DIR" || name === "VIBE_BASE_DIR" ? "/host" : undefined;
  assertEquals(
    capabilityBundlePath(env, "/checkout/prompts"),
    "/checkout/prompts/coding_guidelines/capability-security.json",
  );
});

/** Copy one prompts/ subdirectory of this checkout into `promptsRoot`. */
async function copyPromptDir(promptsRoot: string, name: string) {
  const from = new URL(`../../../prompts/${name}/`, import.meta.url);
  await Deno.mkdir(`${promptsRoot}/${name}`, { recursive: true });
  for await (const entry of Deno.readDir(from)) {
    if (!entry.isFile) continue;
    await Deno.copyFile(
      new URL(entry.name, from),
      `${promptsRoot}/${name}/${entry.name}`,
    );
  }
}

Deno.test("buildIssuePrompt reads the bundle from its promptsDir, not the host's (PR #4463 review)", async () => {
  await withTempDir(async (tmp) => {
    for (const name of ["issue", "coding_guidelines"]) {
      await copyPromptDir(tmp, name);
    }
    const shipped = JSON.parse(await Deno.readTextFile(SHIPPED_BUNDLE));
    await Deno.writeTextFile(
      `${tmp}/coding_guidelines/capability-security.json`,
      JSON.stringify({ ...shipped, revision: "pr-4463-own-copy" }),
    );
    const result = await buildIssuePrompt({
      repo: "owner/repo",
      issueNumber: "4463",
      issueTitle: "Rename a helper",
      issueBody: "No capability here.",
      issueLabels: "",
      qualityInstructions: "Run ./quality.sh",
      promptsDir: tmp,
    });
    if (!result.ok) throw result.error;
    assertStringIncludes(
      result.value.capabilitySecurityRecord ?? "",
      "revision=pr-4463-own-copy",
    );
  });
});
