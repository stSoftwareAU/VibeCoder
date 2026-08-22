/**
 * Tests for the `container_tools` config validator (Issue #69, parent #5).
 *
 * The validator is the trust boundary for deployer-supplied tool specs: every
 * later sub-issue of #5 (download, verify, extract, PATH exposure) assumes an
 * already-validated spec, so a fault must be rejected **here**, loudly, naming
 * the offending tool id and field. This suite is the rejection matrix from the
 * issue:
 *
 *   1. a valid spec parses (happy path, including `noarch` and a
 *      single-architecture deployment);
 *   2. a malformed or duplicate `id` is rejected;
 *   3. a missing `version` is rejected;
 *   4. an architecture key outside `amd64`/`arm64`/`noarch` is rejected;
 *   5. a `url` without a matching `sha256` — and the reverse — is rejected, so
 *      an unverified download cannot be expressed;
 *   6. a non-`https:` URL is rejected;
 *   7. a `sha256` that is not 64 hex characters is rejected;
 *   8. a `bin`/`env` value that is absolute or escapes the install prefix is
 *      rejected; and
 *   9. a non-integer or negative `stripComponents` is rejected.
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
  assertContainerTools,
  containerToolPrefix,
  parseContainerTools,
  readContainerToolsSelection,
} from "../lib/container_tools_config.ts";
import {
  detectUnknownConfigKeys,
  KNOWN_CONFIG_KEYS,
} from "../lib/config_unknown_keys.ts";
import { loadConfig } from "../lib/config.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** A minimal valid spec, cloned per case so tests never share state. */
function validSpec(): Record<string, unknown> {
  return {
    id: "java",
    version: "21.0.5+11",
    url: {
      amd64: "https://example.com/jdk-x64.tar.gz",
      arm64: "https://example.com/jdk-aarch64.tar.gz",
    },
    sha256: { amd64: SHA_A, arm64: SHA_B },
    stripComponents: 1,
    bin: ["bin"],
    env: { JAVA_HOME: "" },
  };
}

/** Assert the parse failed and the message names each fragment. */
function assertRejected(raw: unknown, ...fragments: string[]): string {
  const result = parseContainerTools(raw);
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

Deno.test("parseContainerTools - valid spec parses", () => {
  const result = parseContainerTools([validSpec()]);
  assert(result.ok, result.ok ? "" : result.error);
  assertEquals(result.value.length, 1);
  const tool = result.value[0]!;
  assertEquals(tool.id, "java");
  assertEquals(tool.version, "21.0.5+11");
  assertEquals(tool.url.amd64, "https://example.com/jdk-x64.tar.gz");
  assertEquals(tool.sha256.arm64, SHA_B);
  assertEquals(tool.stripComponents, 1);
  assertEquals(tool.bin, ["bin"]);
  assertEquals(tool.env, { JAVA_HOME: "" });
});

Deno.test("parseContainerTools - absent or empty array yields no tools", () => {
  for (const raw of [undefined, null, []]) {
    const result = parseContainerTools(raw);
    assert(result.ok, result.ok ? "" : result.error);
    assertEquals(result.value, []);
  }
});

Deno.test("parseContainerTools - optional fields default", () => {
  const result = parseContainerTools([{
    id: "maven",
    version: "3.9.9",
    url: { noarch: "https://example.com/maven.tar.gz" },
    sha256: { noarch: SHA_A },
  }]);
  assert(result.ok, result.ok ? "" : result.error);
  const tool = result.value[0]!;
  assertEquals(tool.stripComponents, 0);
  assertEquals(tool.bin, []);
  assertEquals(tool.env, {});
});

Deno.test("parseContainerTools - single architecture is allowed", () => {
  const result = parseContainerTools([{
    id: "java",
    version: "21",
    url: { arm64: "https://example.com/jdk.tar.gz" },
    sha256: { arm64: SHA_A },
  }]);
  assert(result.ok, result.ok ? "" : result.error);
  assertEquals(Object.keys(result.value[0]!.url), ["arm64"]);
});

Deno.test("parseContainerTools - sha256 is normalised to lower case", () => {
  const spec = validSpec();
  spec.sha256 = { amd64: SHA_A.toUpperCase(), arm64: SHA_B };
  const result = parseContainerTools([spec]);
  assert(result.ok, result.ok ? "" : result.error);
  assertEquals(result.value[0]!.sha256.amd64, SHA_A);
});

Deno.test("parseContainerTools - rejects a non-array block", () => {
  assertRejected({ id: "java" }, "container_tools", "array");
});

Deno.test("parseContainerTools - rejects a non-object entry", () => {
  assertRejected(["java"], "container_tools[0]", "object");
});

Deno.test("parseContainerTools - rejects a malformed id", () => {
  for (const id of ["Java", "java_21", "1java", "", "../etc", "java 21"]) {
    const spec = validSpec();
    spec.id = id;
    assertRejected([spec], "container_tools[0]", "id");
  }
});

Deno.test("parseContainerTools - rejects a duplicate id", () => {
  const message = assertRejected(
    [validSpec(), validSpec()],
    "container_tools[1]",
    "id",
    "java",
  );
  assert(
    /duplicate/i.test(message),
    `expected a duplicate-id message, got: ${message}`,
  );
});

Deno.test("parseContainerTools - rejects a missing version", () => {
  for (const version of [undefined, "", 21]) {
    const spec = validSpec();
    if (version === undefined) delete spec.version;
    else spec.version = version;
    assertRejected([spec], "java", "version");
  }
});

Deno.test("parseContainerTools - rejects an unknown architecture key", () => {
  const spec = validSpec();
  spec.url = { ...(spec.url as object), riscv64: "https://example.com/a.tgz" };
  assertRejected([spec], "java", "url", "riscv64");

  const other = validSpec();
  other.sha256 = { ...(other.sha256 as object), x86: SHA_A };
  assertRejected([other], "java", "sha256", "x86");
});

Deno.test("parseContainerTools - rejects a url with no matching sha256", () => {
  const spec = validSpec();
  spec.sha256 = { amd64: SHA_A };
  assertRejected([spec], "java", "arm64", "sha256");
});

Deno.test("parseContainerTools - rejects a sha256 with no matching url", () => {
  const spec = validSpec();
  spec.url = { amd64: "https://example.com/jdk-x64.tar.gz" };
  assertRejected([spec], "java", "arm64", "url");
});

Deno.test("parseContainerTools - rejects a missing url or sha256 block", () => {
  const noUrl = validSpec();
  delete noUrl.url;
  assertRejected([noUrl], "java", "url");

  const noSha = validSpec();
  delete noSha.sha256;
  assertRejected([noSha], "java", "sha256");

  const empty = validSpec();
  empty.url = {};
  empty.sha256 = {};
  assertRejected([empty], "java", "url");
});

Deno.test("parseContainerTools - rejects a non-https url", () => {
  for (
    const url of [
      "http://example.com/jdk.tar.gz",
      "file:///etc/passwd",
      "ftp://example.com/jdk.tar.gz",
      "not-a-url",
    ]
  ) {
    const spec = validSpec();
    spec.url = { amd64: url };
    spec.sha256 = { amd64: SHA_A };
    assertRejected([spec], "java", "url.amd64");
  }
});

Deno.test("parseContainerTools - rejects a malformed sha256", () => {
  for (const sha of ["abc", SHA_A + "a", "z".repeat(64), 1234, ""]) {
    const spec = validSpec();
    spec.url = { amd64: "https://example.com/jdk.tar.gz" };
    spec.sha256 = { amd64: sha };
    assertRejected([spec], "java", "sha256.amd64");
  }
});

Deno.test("parseContainerTools - rejects a bin path escaping the prefix", () => {
  for (const bin of ["/usr/bin", "../../usr/bin", "bin/../../..", "~/bin"]) {
    const spec = validSpec();
    spec.bin = [bin];
    assertRejected([spec], "java", "bin[0]");
  }
});

Deno.test("parseContainerTools - rejects a non-string bin entry", () => {
  const spec = validSpec();
  spec.bin = [1];
  assertRejected([spec], "java", "bin[0]");

  const notArray = validSpec();
  notArray.bin = "bin";
  assertRejected([notArray], "java", "bin");
});

Deno.test("parseContainerTools - rejects an env value escaping the prefix", () => {
  for (const value of ["/opt/other", "../../etc", "a/../../b"]) {
    const spec = validSpec();
    spec.env = { JAVA_HOME: value };
    assertRejected([spec], "java", "env.JAVA_HOME");
  }
});

Deno.test("parseContainerTools - rejects a malformed env variable name", () => {
  const spec = validSpec();
  spec.env = { "JAVA HOME": "" };
  assertRejected([spec], "java", "env");
});

Deno.test("parseContainerTools - rejects an invalid stripComponents", () => {
  for (const value of [-1, 1.5, "1", Number.NaN]) {
    const spec = validSpec();
    spec.stripComponents = value;
    assertRejected([spec], "java", "stripComponents");
  }
});

Deno.test("parseContainerTools - rejects an unknown key inside a spec", () => {
  const spec = validSpec();
  spec.install = "apt-get install java";
  assertRejected([spec], "java", "install");
});

Deno.test("assertContainerTools - returns tools or throws loudly", () => {
  assertEquals(assertContainerTools([validSpec()])[0]?.id, "java");

  const spec = validSpec();
  spec.sha256 = { amd64: "nope", arm64: SHA_B };
  const error = assertThrows(
    () => assertContainerTools([spec]),
    Error,
    "sha256.amd64",
  );
  assert(
    error.message.includes("java"),
    `expected the tool id in the thrown message, got: ${error.message}`,
  );
});

Deno.test("containerToolPrefix - install prefix is fixed per tool id", () => {
  assertEquals(containerToolPrefix("java"), "/opt/vibe-tools/java");
});

Deno.test("container_tools is a known config key", () => {
  assert(KNOWN_CONFIG_KEYS.has("container_tools"));
  assertEquals(
    detectUnknownConfigKeys({ container_tools: [validSpec()] }),
    [],
  );
});

/** Run `fn` against a temporary `.config.json`, cleaning up afterwards. */
async function withConfig(
  body: Record<string, unknown>,
  fn: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "container-tools-" });
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(path, JSON.stringify(body));
    await fn(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("loadConfig - a valid container_tools block loads", async () => {
  await withConfig(
    { repos: ["stSoftwareAU/VibeCoder"], container_tools: [validSpec()] },
    async (path) => {
      const config = await loadConfig(path);
      assertEquals(config.repos, ["stSoftwareAU/VibeCoder"]);
    },
  );
});

Deno.test("loadConfig - a malformed container_tools block fails loud", async () => {
  const spec = validSpec();
  spec.url = {
    amd64: "http://example.com/jdk-x64.tar.gz",
    arm64: "https://example.com/jdk-aarch64.tar.gz",
  };

  await withConfig({ container_tools: [spec] }, async (path) => {
    const error = await assertRejects(
      () => loadConfig(path),
      Error,
      "url.amd64",
    );
    assert(
      error.message.includes("java"),
      `expected the tool id in the thrown message, got: ${error.message}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Reading the selection off disk (Issues #72, #73)
// ---------------------------------------------------------------------------

Deno.test("readContainerToolsSelection - returns the validated spec and the verbatim JSON", async () => {
  await withConfig(
    { repos: ["stSoftwareAU/VibeCoder"], container_tools: [validSpec()] },
    async (path) => {
      const selection = await readContainerToolsSelection(path);

      assertEquals(selection.tools.map((tool) => tool.id), ["java"]);
      assertEquals(selection.tools[0]?.version, "21.0.5+11");
      // Verbatim: what install-tools.sh parses is what the deployer wrote.
      assertEquals(selection.specJson, JSON.stringify([validSpec()]));
    },
  );
});

Deno.test("readContainerToolsSelection - no selection reads as empty", async () => {
  await withConfig({ repos: ["stSoftwareAU/VibeCoder"] }, async (path) => {
    assertEquals(await readContainerToolsSelection(path), { tools: [] });
  });

  await withConfig({ container_tools: [] }, async (path) => {
    assertEquals(await readContainerToolsSelection(path), { tools: [] });
  });
});

Deno.test("readContainerToolsSelection - an absent config selects no tools", async () => {
  const dir = await Deno.makeTempDir({ prefix: "container-tools-" });
  try {
    assertEquals(
      await readContainerToolsSelection(`${dir}/nowhere/.config.json`),
      { tools: [] },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readContainerToolsSelection - a malformed spec fails loud, naming the field", async () => {
  const spec = validSpec();
  spec.stripComponents = -1;

  await withConfig({ container_tools: [spec] }, async (path) => {
    const error = await assertRejects(
      () => readContainerToolsSelection(path),
      Error,
      "stripComponents",
    );
    assert(
      error.message.includes("java"),
      `expected the tool id in the thrown message, got: ${error.message}`,
    );
  });
});

Deno.test("readContainerToolsSelection - unreadable JSON fails loud, naming the file", async () => {
  const dir = await Deno.makeTempDir({ prefix: "container-tools-" });
  try {
    const path = `${dir}/.config.json`;
    await Deno.writeTextFile(path, "{ not json");
    const error = await assertRejects(
      () => readContainerToolsSelection(path),
      Error,
      path,
    );
    assertStringIncludes(error.message, "not readable JSON");

    await Deno.writeTextFile(path, '["an array, not an object"]');
    await assertRejects(
      () => readContainerToolsSelection(path),
      Error,
      "does not hold a JSON object",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
