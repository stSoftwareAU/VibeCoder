/**
 * Tests for the `container_extension` config validator (Issue #978, parent
 * #933).
 *
 * The validator is the trust boundary for a deployment's private environment
 * extension: every later sub-issue of #933 (the extension digest, the
 * two-stage build, running the start script) assumes an already-validated
 * declaration, so a fault must be rejected **here**, loudly, naming the
 * offending field. This suite is the rejection matrix from the issue:
 *
 *   1. a valid block parses, with `containerfile` defaulting and `start`
 *      optional (happy path), and an absent key installs nothing;
 *   2. a non-object block, or an unknown key inside it, is rejected;
 *   3. a missing, empty, relative or `~`-prefixed `path` is rejected;
 *   4. a NUL or control character in any field is rejected;
 *   5. an absolute or `..`-escaping `containerfile`/`start` is rejected;
 *   6. a `path` that is the host home directory, an ancestor of it, or a
 *      filesystem root is rejected (the #850 containment rule).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  assertContainerExtension,
  DEFAULT_EXTENSION_CONTAINERFILE,
  parseContainerExtension,
  readContainerExtensionSelection,
} from "../lib/container_extension_config.ts";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
  suggestSimilarKey,
} from "../lib/config_unknown_keys.ts";
import { loadConfig } from "../lib/config.ts";
import type { EnvLookup } from "../lib/env_lookup.ts";

/** The host home directory every case validates against. */
const HOME = "/home/operator";

/** An environment with a fixed home directory and nothing else set. */
const ENV: EnvLookup = (name) => (name === "HOME" ? HOME : undefined);

/** A minimal valid block, cloned per case so tests never share state. */
function validExtension(): Record<string, unknown> {
  return {
    path: "/srv/vibe-extension",
    containerfile: "Containerfile",
    start: "start.sh",
  };
}

/** Assert the parse failed and the message names each fragment. */
function assertRejected(raw: unknown, ...fragments: string[]): string {
  const result = parseContainerExtension(raw, { env: ENV });
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

/** Assert the parse succeeded, returning the validated spec. */
function assertParsed(raw: unknown) {
  const result = parseContainerExtension(raw, { env: ENV });
  assert(result.ok, result.ok ? "" : result.error);
  return result.value;
}

// ---------------------------------------------------------------------------
// Happy path and the unconfigured default
// ---------------------------------------------------------------------------

Deno.test("parseContainerExtension - a valid block parses", () => {
  const spec = assertParsed(validExtension());
  assertEquals(spec, {
    path: "/srv/vibe-extension",
    containerfile: "Containerfile",
    start: "start.sh",
  });
});

Deno.test("parseContainerExtension - containerfile defaults, start stays absent", () => {
  const spec = assertParsed({ path: "/srv/vibe-extension" });
  assertEquals(spec?.containerfile, DEFAULT_EXTENSION_CONTAINERFILE);
  assertEquals(spec?.start, undefined);
});

Deno.test("parseContainerExtension - a nested containerfile and start are kept", () => {
  const spec = assertParsed({
    path: "/srv/vibe-extension",
    containerfile: "build/Containerfile",
    start: "./bin/start.sh",
  });
  assertEquals(spec?.containerfile, "build/Containerfile");
  assertEquals(spec?.start, "./bin/start.sh");
});

Deno.test("parseContainerExtension - an absent key selects no extension", () => {
  assertEquals(assertParsed(undefined), undefined);
  assertEquals(assertParsed(null), undefined);
});

// ---------------------------------------------------------------------------
// Shape of the block itself
// ---------------------------------------------------------------------------

Deno.test("parseContainerExtension - rejects a non-object block", () => {
  assertRejected(
    "/srv/vibe-extension",
    "container_extension",
    "must be an object",
  );
  assertRejected([{ path: "/srv/vibe-extension" }], "must be an object");
  assertRejected(42, "must be an object");
});

Deno.test("parseContainerExtension - rejects an unknown key inside the block", () => {
  const extension = validExtension();
  extension.commmand = "start.sh";
  assertRejected(extension, "commmand", "unknown key");
});

// ---------------------------------------------------------------------------
// path — absolute, clean, and contained
// ---------------------------------------------------------------------------

Deno.test("parseContainerExtension - rejects a missing or empty path", () => {
  assertRejected({ containerfile: "Containerfile" }, "path", "non-empty");
  assertRejected({ path: "" }, "path", "non-empty");
  assertRejected({ path: 7 }, "path", "non-empty");
});

Deno.test("parseContainerExtension - rejects a relative or ~-prefixed path", () => {
  assertRejected({ path: "srv/vibe-extension" }, "path", "absolute");
  assertRejected({ path: "./vibe-extension" }, "path", "absolute");
  assertRejected({ path: "~/vibe-extension" }, "path", "absolute");
});

Deno.test("parseContainerExtension - rejects a path with a traversal segment", () => {
  // "/srv/../home/operator" IS the home directory once resolved, and a
  // string comparison alone would never see it (Issue #850).
  assertRejected({ path: "/srv/../home/operator" }, "path", "segment");
  assertRejected({ path: "/srv/./vibe-extension" }, "path", "segment");
});

Deno.test("parseContainerExtension - rejects the home directory or an ancestor", () => {
  assertRejected({ path: HOME }, "path", "home directory");
  assertRejected({ path: "/home" }, "path", "home directory");
  assertRejected({ path: `${HOME}/` }, "path", "home directory");
});

Deno.test("parseContainerExtension - a Windows path is judged in its own spelling", () => {
  const result = parseContainerExtension({
    path: "C:\\srv\\vibe-extension",
    containerfile: "build\\Containerfile",
  }, { env: () => "C:\\Users\\operator" });
  assert(result.ok, result.ok ? "" : result.error);
  assertEquals(result.value?.containerfile, "build\\Containerfile");

  for (const value of ["..\\..\\Containerfile", "D:\\evil\\Containerfile"]) {
    const rejected = parseContainerExtension({
      path: "C:\\srv\\vibe-extension",
      containerfile: value,
    }, { env: () => "C:\\Users\\operator" });
    assertEquals(
      rejected.ok,
      false,
      `expected ${value} to be refused, got ${JSON.stringify(rejected)}`,
    );
  }

  const home = parseContainerExtension({ path: "C:\\Users\\Operator" }, {
    env: () => "C:\\Users\\operator",
  });
  assertEquals(home.ok, false, "a Windows home directory must be refused");
});

Deno.test("parseContainerExtension - rejects the filesystem root", () => {
  assertRejected({ path: "/" }, "path", "filesystem root");
});

Deno.test("parseContainerExtension - a directory below the home directory is fine", () => {
  const spec = assertParsed({ path: `${HOME}/vibe-extension` });
  assertEquals(spec?.path, `${HOME}/vibe-extension`);
});

Deno.test("parseContainerExtension - an unknown home directory is refused, not skipped", () => {
  // A containment rule that cannot be evaluated has not passed: with neither
  // HOME nor USERPROFILE set there is nothing to check the path against.
  const result = parseContainerExtension({ path: "/srv/vibe-extension" }, {
    env: () => undefined,
  });
  assertEquals(result.ok, false);
  assertStringIncludes(result.ok ? "" : result.error, "HOME");
});

// ---------------------------------------------------------------------------
// Control characters
// ---------------------------------------------------------------------------

Deno.test("parseContainerExtension - rejects NUL or control characters", () => {
  assertRejected({ path: "/srv/vibe\0extension" }, "path", "control");
  assertRejected(
    { path: "/srv/vibe-extension", containerfile: "Container\nfile" },
    "containerfile",
    "control",
  );
  assertRejected(
    { path: "/srv/vibe-extension", start: "start\u007F.sh" },
    "start",
    "control",
  );
});

// ---------------------------------------------------------------------------
// containerfile / start — confined to the extension directory
// ---------------------------------------------------------------------------

Deno.test("parseContainerExtension - rejects an absolute containerfile or start", () => {
  assertRejected(
    { path: "/srv/vibe-extension", containerfile: "/etc/Containerfile" },
    "containerfile",
    "/srv/vibe-extension",
  );
  assertRejected(
    { path: "/srv/vibe-extension", start: "/usr/bin/start.sh" },
    "start",
    "/srv/vibe-extension",
  );
});

Deno.test("parseContainerExtension - rejects a containerfile or start escaping the path", () => {
  assertRejected(
    { path: "/srv/vibe-extension", containerfile: "../Containerfile" },
    "containerfile",
    "escapes",
  );
  assertRejected(
    { path: "/srv/vibe-extension", start: "bin/../../start.sh" },
    "start",
    "escapes",
  );
  assertRejected(
    { path: "/srv/vibe-extension", start: "~/start.sh" },
    "start",
    "escapes",
  );
});

Deno.test("parseContainerExtension - rejects an empty or non-string containerfile or start", () => {
  assertRejected(
    { path: "/srv/vibe-extension", containerfile: "" },
    "containerfile",
    "non-empty",
  );
  assertRejected(
    { path: "/srv/vibe-extension", start: 1 },
    "start",
    "non-empty",
  );
});

// ---------------------------------------------------------------------------
// The throwing entry point
// ---------------------------------------------------------------------------

Deno.test("assertContainerExtension - returns the spec or throws loudly", () => {
  const spec = assertContainerExtension(validExtension(), { env: ENV });
  assertEquals(spec?.path, "/srv/vibe-extension");
  assertEquals(assertContainerExtension(undefined, { env: ENV }), undefined);

  const error = assertThrows(
    () => assertContainerExtension({ path: "relative" }, { env: ENV }),
    Error,
    "container_extension",
  );
  assertStringIncludes(error.message, "path");
});

// ---------------------------------------------------------------------------
// Known-key registration
// ---------------------------------------------------------------------------

Deno.test("container_extension is a known config key", () => {
  assert(KNOWN_CONFIG_KEYS.has("container_extension"));
  assertEquals(
    detectUnknownConfigKeys({ container_extension: validExtension() }),
    [],
  );
});

Deno.test("container_extensions is suggested against container_extension", () => {
  assertEquals(
    suggestSimilarKey("container_extensions"),
    "container_extension",
  );
  const [warning] = detectUnknownConfigKeys({ container_extensions: {} });
  assertEquals(warning?.suggestion, "container_extension");
});

// ---------------------------------------------------------------------------
// Config load
// ---------------------------------------------------------------------------

/** Run `fn` against a temporary `.config.json`, cleaning up afterwards. */
async function withConfig(
  body: Record<string, unknown>,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "container-extension-" });
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(path, JSON.stringify(body));
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadConfig - a valid container_extension block loads", async () => {
  await withConfig(
    {
      repos: ["stSoftwareAU/VibeCoder"],
      container_extension: validExtension(),
    },
    async (path) => {
      const config = await loadConfig(path, { env: ENV });
      assertEquals(config.repos, ["stSoftwareAU/VibeCoder"]);
    },
  );
});

Deno.test("loadConfig - a malformed container_extension block fails loud", async () => {
  await withConfig(
    { container_extension: { path: "vibe-extension" } },
    async (path) => {
      const error = await assertRejects(
        () => loadConfig(path, { env: ENV }),
        Error,
        "container_extension",
      );
      assertStringIncludes(error.message, "path");
    },
  );
});

Deno.test("loadConfig - an extension in the home directory fails the load", async () => {
  await withConfig(
    { container_extension: { path: HOME } },
    async (path) => {
      const error = await assertRejects(
        () => loadConfig(path, { env: ENV }),
        Error,
        "home directory",
      );
      assertStringIncludes(error.message, "container_extension");
    },
  );
});

Deno.test("loadConfig - no container_extension key parses as today", async () => {
  await withConfig({ repos: ["stSoftwareAU/VibeCoder"] }, async (path) => {
    const config = await loadConfig(path, { env: ENV });
    assertEquals(config.repos, ["stSoftwareAU/VibeCoder"]);
  });
});

// ---------------------------------------------------------------------------
// Reading the selection off disk (the launcher's reader)
// ---------------------------------------------------------------------------

Deno.test("readContainerExtensionSelection - returns the validated declaration", async () => {
  await withConfig(
    {
      repos: ["stSoftwareAU/VibeCoder"],
      container_extension: validExtension(),
    },
    async (path) => {
      const extension = await readContainerExtensionSelection(path, {
        env: ENV,
      });
      assertEquals(extension?.path, "/srv/vibe-extension");
      assertEquals(extension?.containerfile, "Containerfile");
      assertEquals(extension?.start, "start.sh");
    },
  );
});

Deno.test("readContainerExtensionSelection - no declaration reads as none", async () => {
  await withConfig({ repos: ["stSoftwareAU/VibeCoder"] }, async (path) => {
    assertEquals(
      await readContainerExtensionSelection(path, { env: ENV }),
      undefined,
    );
  });
});

Deno.test("readContainerExtensionSelection - an absent config selects no extension", async () => {
  const dir = await Deno.makeTempDir({ prefix: "container-extension-" });
  try {
    assertEquals(
      await readContainerExtensionSelection(`${dir}/nowhere/.config.json`, {
        env: ENV,
      }),
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readContainerExtensionSelection - a malformed block fails loud, naming the field", async () => {
  await withConfig(
    { container_extension: { path: "/srv/vibe-extension", start: "/abs.sh" } },
    async (path) => {
      const error = await assertRejects(
        () => readContainerExtensionSelection(path, { env: ENV }),
        Error,
        "start",
      );
      assertStringIncludes(error.message, "container_extension");
    },
  );
});

Deno.test("readContainerExtensionSelection - unreadable JSON fails loud, naming the file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "container-extension-" });
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(path, "{ not json");
    const error = await assertRejects(
      () => readContainerExtensionSelection(path, { env: ENV }),
      Error,
      path,
    );
    assertStringIncludes(error.message, "not readable JSON");

    await Deno.writeTextFile(path, '["an array, not an object"]');
    await assertRejects(
      () => readContainerExtensionSelection(path, { env: ENV }),
      Error,
      "does not hold a JSON object",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
