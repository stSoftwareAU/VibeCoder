/**
 * Tests for the `custom_label_prompts` config validator (Issue #846, part of
 * #843).
 *
 * The validator is the trust boundary for operator-supplied label → prompt
 * mappings: a later sub-issue of #843 (dispatch) assumes an already-validated
 * mapping, so a fault must be rejected **here**, loudly, naming the offending
 * entry and field. This suite is the rejection matrix from the issue:
 *
 *   1. a valid mapping parses (happy path);
 *   2. a non-array value is rejected;
 *   3. a non-object entry is rejected;
 *   4. a missing, empty, or non-string `label`/`prompt_path` is rejected;
 *   5. NUL or control characters in either field are rejected;
 *   6. a relative `prompt_path` is rejected;
 *   7. a `prompt_path` that does not exist or is not readable is rejected;
 *   8. a duplicate label is rejected;
 *   9. a label colliding with a reserved or discovery label is rejected; and
 *  10. an unknown key inside an entry is rejected.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  assertCustomLabelPrompts,
  customLabelPromptPath,
  parseCustomLabelPrompts,
} from "../lib/custom_label_prompts_config.ts";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
} from "../lib/config_unknown_keys.ts";
import { loadConfig } from "../lib/config.ts";
import { DISCOVERY_LABELS, RESERVED_LABELS } from "../lib/config_defaults.ts";

/** Write a scratch prompt file and return its absolute path. */
async function writePromptFile(
  dir: string,
  name: string,
  contents = "Do the thing.",
): Promise<string> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, contents);
  return path;
}

/** Assert the parse failed and the message names each fragment. */
function assertRejected(raw: unknown, ...fragments: string[]): string {
  const result = parseCustomLabelPrompts(raw);
  assertEquals(
    result.ok,
    false,
    `expected rejection, got ${JSON.stringify(result)}`,
  );
  const message = result.ok ? "" : result.error;
  for (const fragment of fragments) {
    assert(
      message.includes(fragment),
      `expected error to mention "${fragment}", got: ${message}`,
    );
  }
  return message;
}

Deno.test("parseCustomLabelPrompts - a valid mapping parses", async () => {
  const dir = await Deno.makeTempDir({ prefix: "custom-label-prompts-" });
  try {
    const promptPath = await writePromptFile(dir, "my-label.md");
    const result = parseCustomLabelPrompts([
      { label: "my-custom-label", prompt_path: promptPath },
    ]);
    assert(result.ok, result.ok ? "" : result.error);
    assertEquals(result.value, [
      { label: "my-custom-label", promptPath },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseCustomLabelPrompts - absent or empty array yields no mappings", () => {
  for (const raw of [undefined, null, []]) {
    const result = parseCustomLabelPrompts(raw);
    assert(result.ok, result.ok ? "" : result.error);
    assertEquals(result.value, []);
  }
});

Deno.test("parseCustomLabelPrompts - rejects a non-array block", () => {
  assertRejected(
    { label: "x", prompt_path: "/tmp/x.md" },
    "custom_label_prompts",
    "array",
  );
  assertRejected("nope", "custom_label_prompts", "array");
});

Deno.test("parseCustomLabelPrompts - rejects a non-object entry", () => {
  assertRejected(["not-an-object"], "custom_label_prompts[0]", "object");
  assertRejected([42], "custom_label_prompts[0]", "object");
});

Deno.test("parseCustomLabelPrompts - rejects a missing, empty, or non-string label", async () => {
  const dir = await Deno.makeTempDir({ prefix: "custom-label-prompts-" });
  try {
    const promptPath = await writePromptFile(dir, "a.md");
    for (const label of [undefined, "", 42, null]) {
      const entry: Record<string, unknown> = { prompt_path: promptPath };
      if (label !== undefined) entry.label = label;
      assertRejected([entry], "custom_label_prompts[0].label");
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseCustomLabelPrompts - rejects a missing, empty, or non-string prompt_path", () => {
  for (const promptPath of [undefined, "", 42, null]) {
    const entry: Record<string, unknown> = { label: "custom-label" };
    if (promptPath !== undefined) entry.prompt_path = promptPath;
    assertRejected([entry], "custom_label_prompts[0].prompt_path");
  }
});

Deno.test("parseCustomLabelPrompts - rejects NUL or control characters", async () => {
  const dir = await Deno.makeTempDir({ prefix: "custom-label-prompts-" });
  try {
    const promptPath = await writePromptFile(dir, "a.md");
    assertRejected(
      [{ label: "bad\0label", prompt_path: promptPath }],
      "custom_label_prompts[0].label",
      "control",
    );
    assertRejected(
      [{ label: "custom-label", prompt_path: `${promptPath}\n` }],
      "custom_label_prompts[0].prompt_path",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseCustomLabelPrompts - rejects a relative prompt_path", () => {
  assertRejected(
    [{ label: "custom-label", prompt_path: "relative/path.md" }],
    "custom_label_prompts[0].prompt_path",
    "absolute",
  );
});

Deno.test("parseCustomLabelPrompts - rejects a missing or unreadable prompt file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "custom-label-prompts-" });
  try {
    assertRejected(
      [{ label: "custom-label", prompt_path: `${dir}/does-not-exist.md` }],
      "custom_label_prompts[0].prompt_path",
    );

    // A directory is not a readable prompt file.
    assertRejected(
      [{ label: "custom-label", prompt_path: dir }],
      "custom_label_prompts[0].prompt_path",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseCustomLabelPrompts - rejects a duplicate label", async () => {
  const dir = await Deno.makeTempDir({ prefix: "custom-label-prompts-" });
  try {
    const first = await writePromptFile(dir, "a.md");
    const second = await writePromptFile(dir, "b.md");
    const message = assertRejected(
      [
        { label: "custom-label", prompt_path: first },
        { label: "custom-label", prompt_path: second },
      ],
      "custom_label_prompts[1]",
      "label",
    );
    assert(
      /duplicate/i.test(message),
      `expected a duplicate-label message, got: ${message}`,
    );

    // Case-insensitive, matching GitHub's own label comparison.
    assertRejected(
      [
        { label: "Custom-Label", prompt_path: first },
        { label: "custom-label", prompt_path: second },
      ],
      "custom_label_prompts[1]",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseCustomLabelPrompts - rejects a reserved or discovery label", async () => {
  const dir = await Deno.makeTempDir({ prefix: "custom-label-prompts-" });
  try {
    const promptPath = await writePromptFile(dir, "a.md");
    for (const label of [RESERVED_LABELS[0]!, DISCOVERY_LABELS[0]!]) {
      assertRejected(
        [{ label, prompt_path: promptPath }],
        "custom_label_prompts[0].label",
        "reserved",
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("parseCustomLabelPrompts - rejects an unknown key inside an entry", async () => {
  const dir = await Deno.makeTempDir({ prefix: "custom-label-prompts-" });
  try {
    const promptPath = await writePromptFile(dir, "a.md");
    assertRejected(
      [{ label: "custom-label", prompt_path: promptPath, extra: true }],
      "custom_label_prompts[0]",
      "extra",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("assertCustomLabelPrompts - returns mappings or throws loudly", async () => {
  const dir = await Deno.makeTempDir({ prefix: "custom-label-prompts-" });
  try {
    const promptPath = await writePromptFile(dir, "a.md");
    assertEquals(
      assertCustomLabelPrompts([{
        label: "custom-label",
        prompt_path: promptPath,
      }]),
      [{ label: "custom-label", promptPath }],
    );

    const error = assertThrows(
      () => assertCustomLabelPrompts([{ label: "", prompt_path: promptPath }]),
      Error,
      "label",
    );
    assert(
      error.message.includes("custom_label_prompts"),
      `expected the key name in the thrown message, got: ${error.message}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("custom_label_prompts is a known config key", async () => {
  assert(KNOWN_CONFIG_KEYS.has("custom_label_prompts"));
  const dir = await Deno.makeTempDir({ prefix: "custom-label-prompts-" });
  try {
    const promptPath = await writePromptFile(dir, "a.md");
    assertEquals(
      detectUnknownConfigKeys({
        custom_label_prompts: [{
          label: "custom-label",
          prompt_path: promptPath,
        }],
      }),
      [],
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("customLabelPromptPath - resolves a configured label, case-insensitively", () => {
  const config = {
    customLabelPrompts: [
      { label: "my-custom-label", promptPath: "/opt/prompts/a.md" },
    ],
  };
  assertEquals(
    customLabelPromptPath(config, "my-custom-label"),
    "/opt/prompts/a.md",
  );
  assertEquals(
    customLabelPromptPath(config, "My-Custom-Label"),
    "/opt/prompts/a.md",
  );
});

Deno.test("customLabelPromptPath - returns undefined for an unmapped label", () => {
  assertEquals(
    customLabelPromptPath({ customLabelPrompts: [] }, "no-such-label"),
    undefined,
  );
  assertEquals(
    customLabelPromptPath(
      {
        customLabelPrompts: [
          { label: "other-label", promptPath: "/opt/prompts/a.md" },
        ],
      },
      "no-such-label",
    ),
    undefined,
  );
});

// ---------------------------------------------------------------------------
// End-to-end through loadConfig
// ---------------------------------------------------------------------------

/** Run `fn` against a temporary `.config.json`, cleaning up afterwards. */
async function withConfig(
  body: Record<string, unknown>,
  fn: (path: string, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "custom-label-prompts-cfg-" });
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(path, JSON.stringify(body));
    await fn(path, dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadConfig - a valid custom_label_prompts block loads and exposes camelCase", async () => {
  await withConfig({}, async (path, dir) => {
    const promptPath = await writePromptFile(dir, "a.md");
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        repos: ["stSoftwareAU/VibeCoder"],
        custom_label_prompts: [
          { label: "my-custom-label", prompt_path: promptPath },
        ],
      }),
    );
    const config = await loadConfig(path);
    assertEquals(config.customLabelPrompts, [
      { label: "my-custom-label", promptPath },
    ]);
  });
});

Deno.test("loadConfig - an absent custom_label_prompts key yields an empty list", async () => {
  await withConfig({ repos: ["stSoftwareAU/VibeCoder"] }, async (path) => {
    const config = await loadConfig(path);
    assertEquals(config.customLabelPrompts, []);
  });
});

Deno.test("loadConfig - a malformed custom_label_prompts block fails loud, naming the field", async () => {
  await withConfig(
    { custom_label_prompts: [{ label: "custom-label" }] },
    async (path) => {
      const error = await assertRejects(
        () => loadConfig(path),
        Error,
        "prompt_path",
      );
      assert(
        error.message.includes("custom_label_prompts"),
        `expected the key name in the thrown message, got: ${error.message}`,
      );
    },
  );
});

Deno.test("loadConfig - an unreadable prompt file fails config load", async () => {
  await withConfig({}, async (path, dir) => {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        custom_label_prompts: [
          { label: "custom-label", prompt_path: `${dir}/missing.md` },
        ],
      }),
    );
    await assertRejects(() => loadConfig(path), Error, "custom_label_prompts");
  });
});
