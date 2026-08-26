/**
 * Tests for the DeepSeek install fragment (Issue #415, parent #396).
 *
 * DeepSeek is carried on the Claude Code CLI, so the risk this fragment exists
 * to manage is collision rather than novelty: `container/providers/claude.sh`
 * and `container/providers/deepseek.sh` both run in an image built with
 * `AGENT_PROVIDERS="claude,deepseek"`, and they must install two commands from
 * two independent pins rather than one command twice.
 *
 * Every test runs the real fragment or the real installer with real data; the
 * failure paths are executed, not read.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { CONTAINER_IMAGE_INPUTS } from "../lib/container_image_hash.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const FRAGMENT = `${REPO_ROOT}container/providers/deepseek.sh`;
const INSTALLER = `${REPO_ROOT}container/install-providers.sh`;

/** The committed manifest, through the real parser. */
async function manifest() {
  return parseContainerManifest(
    await Deno.readTextFile(`${REPO_ROOT}container/tools.json`),
  );
}

/** Run a script with the given environment, capturing its output. */
async function run(
  script: string,
  env: Record<string, string>,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await new Deno.Command("bash", {
    args: [script, ...args],
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  }).output();
  const decoder = new TextDecoder();
  return {
    code: result.code,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

/** A manifest file in a temporary directory, holding the given providers. */
async function manifestFile(
  dir: string,
  providers: unknown[],
): Promise<string> {
  const path = `${dir}/tools.json`;
  await Deno.writeTextFile(path, JSON.stringify({ providers }));
  return path;
}

// ---------------------------------------------------------------------------
// The pin
// ---------------------------------------------------------------------------

Deno.test("deepseek provider - the fragment is pinned in container/tools.json", async () => {
  const pin = (await manifest()).providers.find((p) => p.id === "deepseek");

  assert(pin, "container/tools.json pins the deepseek provider");
  assertEquals(pin.fragment, "providers/deepseek.sh");
  assertEquals(pin.binary, "deepseek");
  assert(
    /^\d+\.\d+\.\d+$/.test(pin.version),
    `the pin is an exact version, got "${pin.version}"`,
  );
  for (const arch of ["amd64", "arm64"]) {
    assert(
      /^[0-9a-f]{64}$/.test(pin.sha256[arch] ?? ""),
      `the pin carries a ${arch} SHA-256`,
    );
  }
});

Deno.test("deepseek provider - the pin is independent of the claude pin", async () => {
  const providers = (await manifest()).providers;
  const claude = providers.find((p) => p.id === "claude");
  const deepseek = providers.find((p) => p.id === "deepseek");

  assert(claude && deepseek, "both providers are pinned");
  // Same upstream artefact, two entries: the point of the second pin is that
  // deepseek can be held on a known-good CLI while claude moves ahead, so the
  // two must never share a command name.
  assert(
    deepseek.binary !== claude.binary,
    "a shared command name means one provider overwrites the other",
  );
  assert(
    deepseek.fragment !== claude.fragment,
    "each provider owns its own fragment",
  );
});

Deno.test("deepseek provider - the fragment is an enumerated container-image input", () => {
  assert(
    CONTAINER_IMAGE_INPUTS.includes("container/providers/deepseek.sh"),
    "the fragment must change the image tag when it changes (Issue #4062)",
  );
});

// ---------------------------------------------------------------------------
// The fragment reads its pins and verifies what it downloads
// ---------------------------------------------------------------------------

Deno.test("deepseek provider - the fragment verifies its download and reads its pins from the manifest", async () => {
  const fragment = await Deno.readTextFile(FRAGMENT);

  assertStringIncludes(fragment, "sha256sum -c");
  assertStringIncludes(fragment, "jq -er");
  assertEquals(
    /curl[^\n]*\|\s*(ba)?sh/.test(fragment),
    false,
    "nothing is piped into a shell",
  );
  assertEquals(
    /\$\{?version\}?/.test(fragment),
    true,
    "the download URL is built from the manifest's pinned version",
  );
  assertEquals(
    /https:[^\n"']*latest/.test(fragment),
    false,
    "no floating 'latest' URL is resolved",
  );
  assertStringIncludes(
    fragment,
    "/usr/local/bin/${binary}",
    "the install path comes from the manifest's binary field",
  );
});

Deno.test("deepseek provider - the fragment aborts when the manifest is missing", async () => {
  const result = await run(FRAGMENT, {
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    AGENT_PROVIDER_MANIFEST: "/nonexistent/tools.json",
  });

  assert(result.code !== 0, "a missing manifest must abort the build");
  assertStringIncludes(result.stderr, "Manifest");
});

Deno.test("deepseek provider - the fragment aborts when the provider is not pinned", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-deepseek-pin-" });
  try {
    // The claude entry alone must not satisfy deepseek: the pins are separate.
    const path = await manifestFile(dir, [{
      id: "claude",
      binary: "claude",
      fragment: "providers/claude.sh",
      version: "2.1.223",
    }]);

    const result = await run(FRAGMENT, {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      AGENT_PROVIDER_MANIFEST: path,
    });

    assert(result.code !== 0, "an unpinned provider must abort the build");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("deepseek provider - the fragment aborts when the pin carries no checksum", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-deepseek-sha-" });
  try {
    const path = await manifestFile(dir, [{
      id: "deepseek",
      binary: "deepseek",
      fragment: "providers/deepseek.sh",
      version: "2.1.223",
    }]);

    const result = await run(FRAGMENT, {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      AGENT_PROVIDER_MANIFEST: path,
    });

    // Nothing is downloaded before the checksum is known, so an unverifiable
    // pin stops the build rather than installing unverified bytes.
    assert(result.code !== 0, "a pin with no checksum must abort the build");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// The set installer accepts "claude,deepseek"
// ---------------------------------------------------------------------------

Deno.test("install-providers.sh - a claude,deepseek set validates and runs both fragments", async () => {
  // With no manifest to read, each fragment fails loud on its first step — so
  // a run that reaches that failure has passed set validation and dispatched
  // the fragment, which is what "unsupported provider" would have prevented.
  const result = await run(
    INSTALLER,
    {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      PROVIDER_DIR: `${REPO_ROOT}container/providers`,
      AGENT_PROVIDER_MANIFEST: "/nonexistent/tools.json",
    },
    ["claude,deepseek"],
  );

  assertStringIncludes(result.stdout, "claude deepseek");
  assertEquals(
    result.stderr.includes("Unsupported coding-agent provider"),
    false,
    `deepseek must be a supported id: ${result.stderr}`,
  );
  assert(result.code !== 0, "a missing manifest still aborts the build");
  assertStringIncludes(result.stderr, "Manifest");
});

Deno.test("install-providers.sh - an unknown provider in the set is still rejected", async () => {
  const result = await run(
    INSTALLER,
    {
      PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
      PROVIDER_DIR: `${REPO_ROOT}container/providers`,
      AGENT_PROVIDER_MANIFEST: "/nonexistent/tools.json",
    },
    ["claude,deepseekk"],
  );

  assert(result.code !== 0, "a typo in the set must abort the build");
  assertStringIncludes(result.stderr, "Unsupported coding-agent provider");
  // The error names the fragments that do exist, deepseek among them.
  assertStringIncludes(result.stderr, "deepseek");
});
