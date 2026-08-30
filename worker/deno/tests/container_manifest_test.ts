/**
 * Tests for container_manifest.ts — the pinned-tool manifest validator for
 * the Vibe Coder container image (Issue #4061).
 *
 * Every test calls the real parser/scanner with literal manifest and
 * Containerfile text; the final block validates the committed
 * `container/` definition itself so a drifted pin fails the quality gate.
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  CONTAINER_TOOLS_ARG,
  findBrowserInstallViolations,
  findContainerfileViolations,
  findMissingRuntimeTools,
  findProviderInstallViolations,
  parseContainerManifest,
  REQUIRED_REPO_TOOLCHAIN_COMMANDS,
  REQUIRED_RUNTIME_TOOLS,
} from "../lib/container_manifest.ts";
import {
  CONTAINERFILE_SIZE_CAP_BYTES,
  stripContainerfile,
} from "../lib/containerfile_strip.ts";
import {
  CONTAINER_BROWSERS_PATH,
  PLAYWRIGHT_INSTALLER_VERSION,
  PLAYWRIGHT_MCP_VERSION,
} from "../setup/screenshot.ts";
import { SEMGREP_IMAGE_TAG } from "../lib/pinned_actions.ts";

const DIGEST_A =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_B =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const SHA_AMD64 =
  "aaaa111111111111111111111111111111111111111111111111111111111111";
const SHA_ARM64 =
  "bbbb222222222222222222222222222222222222222222222222222222222222";

/** A minimal, valid manifest object. */
function manifestObject(): Record<string, unknown> {
  return {
    workdir: "/workspace",
    user: { name: "vibe", uid: 1000, gid: 1000 },
    images: [
      {
        name: "ruby",
        tag: "3.4-trixie",
        digest: DIGEST_A,
        arg: "BASE_IMAGE",
        provides: ["bash", "coreutils", "git", "curl", "ruby"],
        minVersions: { git: "2.41", ruby: "3.1" },
      },
      {
        name: "denoland/deno",
        tag: "bin-2.9.5",
        digest: DIGEST_B,
        arg: "DENO_IMAGE",
        provides: ["deno"],
      },
    ],
    tools: [
      {
        name: "gh",
        version: "2.97.0",
        versionArg: "GH_VERSION",
        sha256: { amd64: SHA_AMD64, arm64: SHA_ARM64 },
      },
    ],
  };
}

function manifestText(
  mutate: (m: Record<string, unknown>) => void = () => {},
): string {
  const m = manifestObject();
  mutate(m);
  return JSON.stringify(m);
}

/** A Containerfile that agrees with `manifestObject()`. */
const GOOD_CONTAINERFILE = `
ARG DENO_IMAGE="denoland/deno:bin-2.9.5@${DIGEST_B}"
ARG BASE_IMAGE="ruby:3.4-trixie@${DIGEST_A}"

FROM \${DENO_IMAGE} AS deno
FROM \${BASE_IMAGE}

ARG GH_VERSION="2.97.0"
ARG GH_SHA256_AMD64="${SHA_AMD64}"
ARG GH_SHA256_ARM64="${SHA_ARM64}"

COPY --from=deno /deno /usr/local/bin/deno
RUN useradd --uid 1000 vibe
USER vibe
WORKDIR /workspace
`;

// ---------------------------------------------------------------------------
// parseContainerManifest
// ---------------------------------------------------------------------------

Deno.test("parseContainerManifest - parses a fully pinned manifest", () => {
  const manifest = parseContainerManifest(manifestText());

  assertEquals(manifest.workdir, "/workspace");
  assertEquals(manifest.user.name, "vibe");
  assertEquals(manifest.user.uid, 1000);
  assertEquals(manifest.images.length, 2);
  assertEquals(manifest.images[0]?.digest, DIGEST_A);
  assertEquals(manifest.tools[0]?.version, "2.97.0");
  assertEquals(manifest.tools[0]?.sha256.amd64, SHA_AMD64);
});

Deno.test("parseContainerManifest - rejects malformed JSON", () => {
  assertThrows(
    () => parseContainerManifest("{ not json"),
    Error,
    "not valid JSON",
  );
});

Deno.test("parseContainerManifest - rejects a root-owned default user", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        manifestText((m) => {
          m.user = { name: "root", uid: 0, gid: 0 };
        }),
      ),
    Error,
    "must not run as root",
  );
});

Deno.test("parseContainerManifest - rejects a floating image tag", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        manifestText((m) => {
          (m.images as Array<Record<string, unknown>>)[0]!.tag = "latest";
        }),
      ),
    Error,
    "latest",
  );
});

Deno.test("parseContainerManifest - rejects an image with no digest", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        manifestText((m) => {
          (m.images as Array<Record<string, unknown>>)[1]!.digest = "";
        }),
      ),
    Error,
    "digest",
  );
});

Deno.test("parseContainerManifest - rejects a truncated sha256", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        manifestText((m) => {
          (m.tools as Array<Record<string, unknown>>)[0]!.sha256 = {
            amd64: "abc123",
          };
        }),
      ),
    Error,
    "sha256",
  );
});

Deno.test("parseContainerManifest - rejects an unpinned tool version", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        manifestText((m) => {
          (m.tools as Array<Record<string, unknown>>)[0]!.version = "latest";
        }),
      ),
    Error,
    "latest",
  );
});

Deno.test("parseContainerManifest - rejects an empty tools list", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        manifestText((m) => {
          m.tools = [];
        }),
      ),
    Error,
    "at least one entry",
  );
});

Deno.test("parseContainerManifest - rejects a relative workdir", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        manifestText((m) => {
          m.workdir = "workspace";
        }),
      ),
    Error,
    "absolute",
  );
});

// ---------------------------------------------------------------------------
// provides / minVersions (Issue #4090)
// ---------------------------------------------------------------------------

Deno.test("parseContainerManifest - parses what an image provides and its floors", () => {
  const manifest = parseContainerManifest(manifestText());

  assertEquals(manifest.images[0]?.provides, [
    "bash",
    "coreutils",
    "git",
    "curl",
    "ruby",
  ]);
  assertEquals(manifest.images[0]?.minVersions, { git: "2.41", ruby: "3.1" });
  // Absent `provides`/`minVersions` normalise to empty, never undefined.
  assertEquals(manifest.tools[0]?.name, "gh");
  assertEquals(manifest.images[1]?.minVersions, {});
});

Deno.test("parseContainerManifest - rejects a non-string provides entry", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        manifestText((m) => {
          (m.images as Array<Record<string, unknown>>)[0]!.provides = [
            "git",
            7,
          ];
        }),
      ),
    Error,
    "provides[1]",
  );
});

Deno.test("parseContainerManifest - rejects an unparseable version floor", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        manifestText((m) => {
          (m.images as Array<Record<string, unknown>>)[0]!.minVersions = {
            git: "newest",
          };
        }),
      ),
    Error,
    "minVersions.git",
  );
});

Deno.test("parseContainerManifest - rejects a floor for a command the image does not provide", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        manifestText((m) => {
          (m.images as Array<Record<string, unknown>>)[0]!.minVersions = {
            python3: "3.11",
          };
        }),
      ),
    Error,
    "python3",
  );
});

Deno.test("findMissingRuntimeTools - none missing when images and tools cover the list", () => {
  const manifest = parseContainerManifest(manifestText());

  assertEquals(
    findMissingRuntimeTools(manifest, ["bash", "git", "ruby", "deno", "gh"]),
    [],
  );
});

Deno.test("findMissingRuntimeTools - reports a command nothing supplies", () => {
  const manifest = parseContainerManifest(
    manifestText((m) => {
      (m.images as Array<Record<string, unknown>>)[0]!.provides = [
        "bash",
        "git",
      ];
      (m.images as Array<Record<string, unknown>>)[0]!.minVersions = {
        git: "2.41",
      };
    }),
  );

  assertEquals(findMissingRuntimeTools(manifest, ["bash", "git", "ruby"]), [
    "ruby",
  ]);
});

Deno.test("findMissingRuntimeTools - defaults to the required runtime toolchain", () => {
  const manifest = parseContainerManifest(manifestText());

  // The fixture pins gh but not jq, so the default list reports jq alone.
  assertEquals(findMissingRuntimeTools(manifest), ["jq"]);
  assert(REQUIRED_RUNTIME_TOOLS.includes("ruby"));
});

// ---------------------------------------------------------------------------
// findContainerfileViolations
// ---------------------------------------------------------------------------

Deno.test("findContainerfileViolations - clean Containerfile has none", () => {
  const manifest = parseContainerManifest(manifestText());
  assertEquals(findContainerfileViolations(GOOD_CONTAINERFILE, manifest), []);
});

Deno.test("findContainerfileViolations - flags a drifted ARG version", () => {
  const manifest = parseContainerManifest(manifestText());
  const drifted = GOOD_CONTAINERFILE.replace(
    'ARG GH_VERSION="2.97.0"',
    'ARG GH_VERSION="2.90.0"',
  );

  const violations = findContainerfileViolations(drifted, manifest);
  assertEquals(violations.length, 1);
  assert(violations[0]!.includes("GH_VERSION"));
  assert(violations[0]!.includes("2.97.0"));
});

Deno.test("findContainerfileViolations - flags a missing sha256 ARG", () => {
  const manifest = parseContainerManifest(manifestText());
  const stripped = GOOD_CONTAINERFILE.replace(
    `ARG GH_SHA256_ARM64="${SHA_ARM64}"\n`,
    "",
  );

  const violations = findContainerfileViolations(stripped, manifest);
  assertEquals(violations.length, 1);
  assert(violations[0]!.includes("GH_SHA256_ARM64"));
});

Deno.test("findContainerfileViolations - flags an undigested FROM", () => {
  const manifest = parseContainerManifest(manifestText());
  const floating = GOOD_CONTAINERFILE.replace(
    `ARG BASE_IMAGE="ruby:3.4-trixie@${DIGEST_A}"`,
    'ARG BASE_IMAGE="ruby:3.4-trixie"',
  );

  const violations = findContainerfileViolations(floating, manifest);
  assert(violations.some((v) => v.includes("BASE_IMAGE")));
});

Deno.test("findContainerfileViolations - flags a literal FROM with no digest", () => {
  const manifest = parseContainerManifest(manifestText());
  const literal = GOOD_CONTAINERFILE.replace(
    "FROM ${BASE_IMAGE}",
    "FROM debian:bookworm-slim",
  );

  const violations = findContainerfileViolations(literal, manifest);
  assert(violations.some((v) => v.includes("debian:bookworm-slim")));
});

Deno.test("findContainerfileViolations - flags an unpinned apt install", () => {
  const manifest = parseContainerManifest(manifestText());
  const withApt = GOOD_CONTAINERFILE.replace(
    "USER vibe",
    "RUN apt-get install -y unzip\nUSER vibe",
  );

  const violations = findContainerfileViolations(withApt, manifest);
  assert(violations.some((v) => v.includes("unzip")));
});

Deno.test("findContainerfileViolations - accepts a version-pinned apt install", () => {
  const manifest = parseContainerManifest(manifestText());
  const withApt = GOOD_CONTAINERFILE.replace(
    "USER vibe",
    "RUN apt-get install -y unzip=6.0-28\nUSER vibe",
  );

  assertEquals(findContainerfileViolations(withApt, manifest), []);
});

Deno.test("findContainerfileViolations - flags a root default USER", () => {
  const manifest = parseContainerManifest(manifestText());
  const rooted = GOOD_CONTAINERFILE.replace("USER vibe", "USER root");

  const violations = findContainerfileViolations(rooted, manifest);
  assert(violations.some((v) => v.includes("USER")));
});

Deno.test("findContainerfileViolations - flags a missing USER instruction", () => {
  const manifest = parseContainerManifest(manifestText());
  const noUser = GOOD_CONTAINERFILE.replace("USER vibe\n", "");

  const violations = findContainerfileViolations(noUser, manifest);
  assert(violations.some((v) => v.includes("no USER instruction")));
});

Deno.test("findContainerfileViolations - flags a WORKDIR that contradicts the manifest", () => {
  const manifest = parseContainerManifest(manifestText());
  const moved = GOOD_CONTAINERFILE.replace(
    "WORKDIR /workspace",
    "WORKDIR /srv",
  );

  const violations = findContainerfileViolations(moved, manifest);
  assert(violations.some((v) => v.includes("WORKDIR")));
});

Deno.test("findContainerfileViolations - ignores comments", () => {
  const manifest = parseContainerManifest(manifestText());
  const commented = `# FROM debian:latest — an example, not an instruction\n` +
    `# RUN apt-get install -y unzip\n${GOOD_CONTAINERFILE}`;

  assertEquals(findContainerfileViolations(commented, manifest), []);
});

// ---------------------------------------------------------------------------
// The committed container/ definition must satisfy its own manifest
// ---------------------------------------------------------------------------

const REPO_ROOT = new URL("../../../", import.meta.url);

Deno.test("container/ - the committed definition matches its pinned manifest", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );
  const containerfile = await Deno.readTextFile(
    new URL("container/Containerfile", REPO_ROOT),
  );

  assertEquals(findContainerfileViolations(containerfile, manifest), []);
  assert(manifest.user.uid > 0, "container user must not be uid 0");
  // Every tool the issue requires the image to bake in is either pinned in
  // the manifest or provided by the digest-pinned base image.
  const pinned = manifest.tools.map((t) => t.name);
  for (const required of ["gh", "jq"]) {
    assert(pinned.includes(required), `${required} must be pinned`);
  }
  assert(
    manifest.images.some((i) => i.name === "denoland/deno"),
    "deno must come from a digest-pinned image",
  );
});

Deno.test("container/ - the image supplies every tool the quality gate runs", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );

  // Issue #4090: the gate shells out to ruby (the Pages scripts under
  // .github/scripts) and to git, so a base image without them fails
  // ./quality.sh inside the container.
  assertEquals(findMissingRuntimeTools(manifest), []);
});

Deno.test("container/ - the base image records the git and ruby version floors", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );
  const base = manifest.images.find((i) => i.arg === "BASE_IMAGE");
  assert(base, "the manifest must pin a BASE_IMAGE");

  // git < 2.41 mishandles `--end-of-options` (Issue #3714) and Psych 4
  // (`safe_load_file`, Issue #3661) needs ruby >= 3.1. The workflow asserts
  // the built image clears both floors; they are recorded here once.
  assertEquals(base.minVersions.git, "2.41");
  assertEquals(base.minVersions.ruby, "3.1");
});

// ---------------------------------------------------------------------------
// The coding-agent provider is a separable layer (Issue #4067)
// ---------------------------------------------------------------------------

/** A pinned provider entry for the given id. */
function providerPin(id: string, version: string): Record<string, unknown> {
  return {
    id,
    binary: id,
    fragment: `providers/${id}.sh`,
    version,
    sha256: { amd64: SHA_AMD64, arm64: SHA_ARM64 },
  };
}

/** A manifest object carrying one pinned, installed provider. */
function providerManifestObject(): Record<string, unknown> {
  return {
    ...manifestObject(),
    providers: [providerPin("claude", "2.1.223")],
    installedProviders: ["claude"],
  };
}

/** A manifest object whose image build installs three providers. */
function providerSetManifestObject(): Record<string, unknown> {
  return {
    ...manifestObject(),
    providers: [
      providerPin("claude", "2.1.223"),
      providerPin("codex", "0.55.0"),
      providerPin("gemini", "0.9.1"),
    ],
    installedProviders: ["claude", "codex", "gemini"],
  };
}

/** A fragment that pins nothing itself and verifies what it downloads. */
const GOOD_FRAGMENT = [
  "set -euo pipefail",
  'version="$(jq -er ... "${MANIFEST}")"',
  'curl -fsSL -o "${download}" "${url}"',
  'echo "${checksum}  ${download}" | sha256sum -c -',
].join("\n");

/** A Containerfile installing the given provider set (Issue #4105). */
function providerContainerfile(set: string): string {
  return [
    `ARG AGENT_PROVIDERS="${set}"`,
    "COPY providers /tmp/providers",
    "COPY install-providers.sh /tmp/install-providers.sh",
    'RUN bash /tmp/install-providers.sh "${AGENT_PROVIDERS}"',
  ].join("\n");
}

const PROVIDER_CONTAINERFILE = providerContainerfile("claude");

Deno.test("parseContainerManifest - accepts a pinned provider", () => {
  const manifest = parseContainerManifest(
    JSON.stringify(providerManifestObject()),
  );
  assertEquals(manifest.providers.length, 1);
  assertEquals(manifest.providers[0]?.id, "claude");
  assertEquals(manifest.providers[0]?.fragment, "providers/claude.sh");
  assertEquals(manifest.installedProviders, ["claude"]);
});

Deno.test("parseContainerManifest - accepts a set of installed providers", () => {
  const manifest = parseContainerManifest(
    JSON.stringify(providerSetManifestObject()),
  );
  assertEquals(manifest.installedProviders, ["claude", "codex", "gemini"]);
});

Deno.test("parseContainerManifest - rejects an empty, duplicated or unpinned installed set", () => {
  const empty = providerManifestObject();
  empty.installedProviders = [];
  assertThrows(
    () => parseContainerManifest(JSON.stringify(empty)),
    Error,
    "installedProviders",
  );

  const duplicated = providerSetManifestObject();
  duplicated.installedProviders = ["claude", "codex", "claude"];
  assertThrows(
    () => parseContainerManifest(JSON.stringify(duplicated)),
    Error,
    'installedProviders[2] lists "claude" twice',
  );

  const unpinned = providerManifestObject();
  unpinned.installedProviders = ["claude", "codex"];
  assertThrows(
    () => parseContainerManifest(JSON.stringify(unpinned)),
    Error,
    "not pinned in providers[]",
  );

  const malformed = providerManifestObject();
  malformed.installedProviders = ["Claude"];
  assertThrows(
    () => parseContainerManifest(JSON.stringify(malformed)),
    Error,
    "installedProviders[0]",
  );
});

Deno.test("parseContainerManifest - rejects a floating provider version", () => {
  const raw = providerManifestObject();
  (raw.providers as Record<string, unknown>[])[0]!.version = "latest";
  assertThrows(
    () => parseContainerManifest(JSON.stringify(raw)),
    Error,
    "providers[0].version",
  );
});

Deno.test("parseContainerManifest - rejects a fragment that the build argument cannot select", () => {
  const raw = providerManifestObject();
  (raw.providers as Record<string, unknown>[])[0]!.fragment =
    "providers/claude-code.sh";
  assertThrows(
    () => parseContainerManifest(JSON.stringify(raw)),
    Error,
    "providers[0].fragment",
  );
});

Deno.test("parseContainerManifest - rejects two providers installing the same command", () => {
  // The DeepSeek hazard (Issue #415): its artefact is the Claude CLI, so a
  // later edit "de-duplicating" the pin by pointing it at the claude binary
  // would produce an image where both ids are the same command.
  const raw = providerSetManifestObject();
  const providers = raw.providers as Record<string, unknown>[];
  providers.push({ ...providerPin("deepseek", "2.1.223"), binary: "claude" });

  assertThrows(
    () => parseContainerManifest(JSON.stringify(raw)),
    Error,
    "providers[3].binary",
  );
});

Deno.test("container/tools.json - pins deepseek as its own fragment, command and version", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );
  const pin = manifest.providers.find((p) => p.id === "deepseek");

  assert(pin, "container/tools.json must pin the deepseek provider");
  assertEquals(pin.fragment, "providers/deepseek.sh");
  assertEquals(
    pin.binary,
    "deepseek",
    "deepseek installs its own command, not claude's",
  );
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

  // A default image stays Claude-only: deepseek is selectable, not installed.
  assertEquals(manifest.installedProviders, ["claude"]);
});

Deno.test("container/tools.json - no two pinned providers install the same command", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );

  const binaries = manifest.providers.map((p) => p.binary);
  assertEquals(
    binaries.length,
    new Set(binaries).size,
    `two providers would install the same command: ${binaries.join(", ")}`,
  );
});

Deno.test("findProviderInstallViolations - accepts a build-argument-selected fragment", () => {
  const manifest = parseContainerManifest(
    JSON.stringify(providerManifestObject()),
  );
  assertEquals(
    findProviderInstallViolations(
      PROVIDER_CONTAINERFILE,
      manifest,
      new Map([["providers/claude.sh", GOOD_FRAGMENT]]),
    ),
    [],
  );
});

Deno.test("findProviderInstallViolations - accepts a build-argument-selected provider set", () => {
  const manifest = parseContainerManifest(
    JSON.stringify(providerSetManifestObject()),
  );
  assertEquals(
    findProviderInstallViolations(
      providerContainerfile("claude,codex,gemini"),
      manifest,
      new Map([
        ["providers/claude.sh", GOOD_FRAGMENT],
        ["providers/codex.sh", GOOD_FRAGMENT],
        ["providers/gemini.sh", GOOD_FRAGMENT],
      ]),
    ),
    [],
  );
});

Deno.test("findProviderInstallViolations - reports a build set that disagrees with the manifest", () => {
  const manifest = parseContainerManifest(
    JSON.stringify(providerSetManifestObject()),
  );
  const fragments = new Map([
    ["providers/claude.sh", GOOD_FRAGMENT],
    ["providers/codex.sh", GOOD_FRAGMENT],
    ["providers/gemini.sh", GOOD_FRAGMENT],
  ]);

  // A dropped provider, a reordered set and an absent argument are all drift.
  for (const set of ["claude,codex", "codex,claude,gemini"]) {
    const violations = findProviderInstallViolations(
      providerContainerfile(set),
      manifest,
      fragments,
    );
    assert(
      violations.some((v) => v.includes("ARG AGENT_PROVIDERS defaults to")),
      `the set "${set}" must be reported as disagreeing with the manifest`,
    );
  }

  const missingArg = findProviderInstallViolations(
    'RUN bash /tmp/install-providers.sh "${AGENT_PROVIDERS}"',
    manifest,
    fragments,
  );
  assert(
    missingArg.some((v) => v.includes("does not declare ARG AGENT_PROVIDERS")),
    "a Containerfile without the set argument is reported",
  );
});

Deno.test("findProviderInstallViolations - reports a manifest that records no installed set", () => {
  const raw = providerSetManifestObject();
  delete raw.installedProviders;
  const manifest = parseContainerManifest(JSON.stringify(raw));

  const violations = findProviderInstallViolations(
    providerContainerfile("claude,codex,gemini"),
    manifest,
    new Map([
      ["providers/claude.sh", GOOD_FRAGMENT],
      ["providers/codex.sh", GOOD_FRAGMENT],
      ["providers/gemini.sh", GOOD_FRAGMENT],
    ]),
  );

  assert(
    violations.some((v) => v.includes("records no installedProviders")),
    "a manifest that does not say what the image installs is reported",
  );
});

Deno.test("findProviderInstallViolations - reports a Containerfile that never runs the set installer", () => {
  const manifest = parseContainerManifest(
    JSON.stringify(providerManifestObject()),
  );
  const violations = findProviderInstallViolations(
    [
      'ARG AGENT_PROVIDERS="claude"',
      "COPY providers /tmp/providers",
      'RUN bash "/tmp/providers/claude.sh"',
    ].join("\n"),
    manifest,
    new Map([["providers/claude.sh", GOOD_FRAGMENT]]),
  );

  assert(
    violations.some((v) => v.includes("never runs install-providers.sh")),
    "hard-coding one fragment instead of installing the set is reported",
  );
});

Deno.test("findProviderInstallViolations - reports an inline, unselectable provider install", () => {
  const manifest = parseContainerManifest(
    JSON.stringify(providerManifestObject()),
  );
  const violations = findProviderInstallViolations(
    "RUN curl -fsSL https://example.invalid/install.sh | bash",
    manifest,
    new Map(),
  );

  assert(
    violations.some((v) => v.includes("ARG AGENT_PROVIDERS")),
    "a Containerfile without the build argument is reported",
  );
  assert(
    violations.some((v) => v.includes("providers/claude.sh is missing")),
    "a pinned provider without a fragment is reported",
  );
});

Deno.test("findProviderInstallViolations - reports an unverified or self-pinned fragment", () => {
  const manifest = parseContainerManifest(
    JSON.stringify(providerManifestObject()),
  );
  const violations = findProviderInstallViolations(
    PROVIDER_CONTAINERFILE,
    manifest,
    new Map([[
      "providers/claude.sh",
      "curl -fsSL https://example.invalid/2.1.223/claude | bash",
    ]]),
  );

  assert(
    violations.some((v) => v.includes("without verifying a checksum")),
    "an unverified download is reported",
  );
  assert(
    violations.some((v) => v.includes("pipes a download into a shell")),
    "piping a download into a shell is reported",
  );
  assert(
    violations.some((v) => v.includes("restates version")),
    "a fragment that re-pins the version is reported",
  );
});

Deno.test("container/ - the committed provider layer is selectable and pinned", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );
  const containerfile = await Deno.readTextFile(
    new URL("container/Containerfile", REPO_ROOT),
  );

  const fragments = new Map<string, string>();
  for (const provider of manifest.providers) {
    fragments.set(
      provider.fragment,
      await Deno.readTextFile(
        new URL(`container/${provider.fragment}`, REPO_ROOT),
      ),
    );
  }

  assertEquals(
    findProviderInstallViolations(containerfile, manifest, fragments),
    [],
  );
});

// ---------------------------------------------------------------------------
// Deployer-supplied build-time tools (Issue #71, parent #5)
// ---------------------------------------------------------------------------

/**
 * The one generic, build-argument-driven install step the gate allows.
 *
 * Fixed size whatever the tool count: the spec is written from the build
 * argument and `install-tools.sh` loops over it, so no tool adds a `RUN`.
 */
const TOOLS_STEP = [
  'ARG VIBE_CONTAINER_TOOLS=""',
  "COPY install-tools.sh /tmp/install-tools.sh",
  "RUN set -eu; \\",
  "    spec=/tmp/container-tools.json; \\",
  `    printf '%s' "\${VIBE_CONTAINER_TOOLS}" > "\${spec}"; \\`,
  '    if [ -s "${spec}" ]; then bash /tmp/install-tools.sh "${spec}"; fi; \\',
  '    rm -f /tmp/install-tools.sh "${spec}"',
].join("\n");

Deno.test("findContainerfileViolations - accepts the build-argument-driven tools step", () => {
  const violations = findContainerfileViolations(
    `${GOOD_CONTAINERFILE}\n${TOOLS_STEP}\n`,
    parseContainerManifest(manifestText()),
  );

  assertEquals(violations, []);
});

Deno.test("findContainerfileViolations - the allowance does not excuse an arbitrary unpinned download", () => {
  const violations = findContainerfileViolations(
    `${GOOD_CONTAINERFILE}\n${TOOLS_STEP}\n` +
      "RUN curl -fsSL https://example.invalid/install.sh | bash\n",
    parseContainerManifest(manifestText()),
  );

  assert(
    violations.some((v) => v.includes("pipes a download into a shell")),
    `piping a download into a shell is reported: ${violations.join("; ")}`,
  );
  assert(
    violations.some((v) => v.includes("without verifying a checksum")),
    `an unverified download is reported: ${violations.join("; ")}`,
  );
});

Deno.test("findContainerfileViolations - a checksum-verified download is not reported", () => {
  const violations = findContainerfileViolations(
    `${GOOD_CONTAINERFILE}\n` +
      "RUN set -eu; \\\n" +
      '    curl -fsSL -o /tmp/tool.tgz "https://example.invalid/tool.tgz"; \\\n' +
      '    echo "${GH_SHA256_AMD64}  /tmp/tool.tgz" | sha256sum -c -\n',
    parseContainerManifest(manifestText()),
  );

  assertEquals(violations, []);
});

Deno.test("findContainerfileViolations - reports a tools step that ignores the build argument", () => {
  const violations = findContainerfileViolations(
    `${GOOD_CONTAINERFILE}\n` +
      'ARG VIBE_CONTAINER_TOOLS=""\n' +
      "RUN bash /tmp/install-tools.sh /tmp/attacker-supplied.json\n",
    parseContainerManifest(manifestText()),
  );

  assert(
    violations.some((v) => v.includes("VIBE_CONTAINER_TOOLS")),
    `a spec that does not come from the build argument is reported: ${
      violations.join("; ")
    }`,
  );
});

Deno.test("findContainerfileViolations - the allowance does not excuse a download inside the tools step", () => {
  const violations = findContainerfileViolations(
    `${GOOD_CONTAINERFILE}\n` +
      TOOLS_STEP.replace(
        `printf '%s' "\${VIBE_CONTAINER_TOOLS}" > "\${spec}"; \\`,
        'curl -fsSL -o "${spec}" https://example.invalid/spec.json; \\',
      ) + "\n",
    parseContainerManifest(manifestText()),
  );

  assert(
    violations.some((v) => v.includes("does not come from")),
    `a spec fetched from elsewhere is reported: ${violations.join("; ")}`,
  );
  assert(
    violations.some((v) => v.includes("without verifying a checksum")),
    `a download written into the allowed step is reported: ${
      violations.join("; ")
    }`,
  );
});

Deno.test("findContainerfileViolations - reports a tools build argument with a non-empty default", () => {
  const violations = findContainerfileViolations(
    `${GOOD_CONTAINERFILE}\n` +
      `ARG VIBE_CONTAINER_TOOLS="[{\\"id\\":\\"java\\"}]"\n` +
      TOOLS_STEP.split("\n").slice(1).join("\n") + "\n",
    parseContainerManifest(manifestText()),
  );

  assert(
    violations.some((v) => v.includes("must default to empty")),
    `a default build that installs tools is reported: ${violations.join("; ")}`,
  );
});

Deno.test("findContainerfileViolations - reports a declared tools argument the build never uses", () => {
  const violations = findContainerfileViolations(
    `${GOOD_CONTAINERFILE}\nARG VIBE_CONTAINER_TOOLS=""\n`,
    parseContainerManifest(manifestText()),
  );

  assert(
    violations.some((v) => v.includes("never runs install-tools.sh")),
    `a build argument nothing acts on is reported: ${violations.join("; ")}`,
  );
});

Deno.test("findContainerfileViolations - reports install-tools.sh run without the build argument declared", () => {
  const violations = findContainerfileViolations(
    `${GOOD_CONTAINERFILE}\n` +
      TOOLS_STEP.split("\n").slice(1).join("\n") + "\n",
    parseContainerManifest(manifestText()),
  );

  assert(
    violations.some((v) =>
      v.includes("does not declare ARG VIBE_CONTAINER_TOOLS")
    ),
    `an undeclared build argument is reported: ${violations.join("; ")}`,
  );
});

Deno.test("findContainerfileViolations - ignores a commented-out unpinned download", () => {
  const violations = findContainerfileViolations(
    `${GOOD_CONTAINERFILE}\n# RUN curl -fsSL https://example.invalid/x.sh | bash\n`,
    parseContainerManifest(manifestText()),
  );

  assertEquals(violations, []);
});

Deno.test("container/ - the committed definition drives install-tools.sh from the build argument", async () => {
  const containerfile = await Deno.readTextFile(
    new URL("container/Containerfile", REPO_ROOT),
  );

  assertStringIncludes(containerfile, `ARG ${CONTAINER_TOOLS_ARG}=""`);
  assertStringIncludes(containerfile, "install-tools.sh");
  assertEquals(
    findContainerfileViolations(
      containerfile,
      parseContainerManifest(
        await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
      ),
    ),
    [],
  );
});

// ---------------------------------------------------------------------------
// Monitored-repository toolchains (Issue #4068)
// ---------------------------------------------------------------------------

/** A manifest object carrying one documented, pinned toolchain. */
function toolchainManifestObject(): Record<string, unknown> {
  return {
    ...manifestObject(),
    toolchains: [
      {
        id: "rust",
        version: "1.95.0",
        versionArg: "RUST_VERSION",
        commands: ["cargo", "rustc", "cargo-clippy", "rustfmt"],
        versionCommand: "cargo",
        sha256: { amd64: SHA_AMD64, arm64: SHA_ARM64 },
        repos: ["stSoftwareAU/private-repo-17"],
      },
    ],
  };
}

function toolchainManifestText(
  mutate: (t: Record<string, unknown>) => void = () => {},
): string {
  const raw = toolchainManifestObject();
  mutate((raw.toolchains as Record<string, unknown>[])[0]!);
  return JSON.stringify(raw);
}

/** A Containerfile that agrees with `toolchainManifestObject()`. */
const TOOLCHAIN_CONTAINERFILE = GOOD_CONTAINERFILE.replace(
  "COPY --from=deno",
  `ARG RUST_VERSION="1.95.0"\n` +
    `ARG RUST_SHA256_AMD64="${SHA_AMD64}"\n` +
    `ARG RUST_SHA256_ARM64="${SHA_ARM64}"\n` +
    "COPY --from=deno",
);

Deno.test("parseContainerManifest - parses a documented toolchain", () => {
  const manifest = parseContainerManifest(toolchainManifestText());

  assertEquals(manifest.toolchains.length, 1);
  assertEquals(manifest.toolchains[0]?.id, "rust");
  assertEquals(manifest.toolchains[0]?.version, "1.95.0");
  assertEquals(manifest.toolchains[0]?.versionCommand, "cargo");
  assertEquals(manifest.toolchains[0]?.commands, [
    "cargo",
    "rustc",
    "cargo-clippy",
    "rustfmt",
  ]);
  assertEquals(manifest.toolchains[0]?.repos, [
    "stSoftwareAU/private-repo-17",
  ]);
});

Deno.test("parseContainerManifest - a manifest with no toolchains still parses", () => {
  assertEquals(parseContainerManifest(manifestText()).toolchains, []);
});

Deno.test("parseContainerManifest - rejects a floating toolchain version", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        toolchainManifestText((t) => {
          t.version = "stable";
        }),
      ),
    Error,
    "toolchains[0].version",
  );
});

Deno.test("parseContainerManifest - rejects a toolchain that documents no repository", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        toolchainManifestText((t) => {
          t.repos = [];
        }),
      ),
    Error,
    "toolchains[0].repos",
  );
});

Deno.test("parseContainerManifest - rejects a repos entry that is not owner/repo", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        toolchainManifestText((t) => {
          t.repos = ["private-repo-17"];
        }),
      ),
    Error,
    "toolchains[0].repos[0]",
  );
});

Deno.test("parseContainerManifest - rejects an empty toolchain command list", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        toolchainManifestText((t) => {
          t.commands = [];
        }),
      ),
    Error,
    "toolchains[0].commands",
  );
});

Deno.test("parseContainerManifest - rejects a versionCommand the toolchain does not install", () => {
  assertThrows(
    () =>
      parseContainerManifest(
        toolchainManifestText((t) => {
          t.versionCommand = "rustup";
        }),
      ),
    Error,
    "toolchains[0].versionCommand",
  );
});

Deno.test("findMissingRuntimeTools - a toolchain command counts as supplied", () => {
  const manifest = parseContainerManifest(toolchainManifestText());

  assertEquals(
    findMissingRuntimeTools(manifest, ["cargo", "rustfmt", "cargo-clippy"]),
    [],
  );
  assertEquals(findMissingRuntimeTools(manifest, ["cargo", "shellcheck"]), [
    "shellcheck",
  ]);
});

Deno.test("findContainerfileViolations - a toolchain-pinned Containerfile has none", () => {
  const manifest = parseContainerManifest(toolchainManifestText());
  assertEquals(
    findContainerfileViolations(TOOLCHAIN_CONTAINERFILE, manifest),
    [],
  );
});

Deno.test("findContainerfileViolations - flags a drifted toolchain ARG version", () => {
  const manifest = parseContainerManifest(toolchainManifestText());
  const drifted = TOOLCHAIN_CONTAINERFILE.replace(
    'ARG RUST_VERSION="1.95.0"',
    'ARG RUST_VERSION="1.90.0"',
  );

  const violations = findContainerfileViolations(drifted, manifest);
  assertEquals(violations.length, 1);
  assert(violations[0]!.includes("RUST_VERSION"));
  assert(violations[0]!.includes("1.95.0"));
});

Deno.test("findContainerfileViolations - flags a missing toolchain sha256 ARG", () => {
  const manifest = parseContainerManifest(toolchainManifestText());
  const stripped = TOOLCHAIN_CONTAINERFILE.replace(
    `ARG RUST_SHA256_ARM64="${SHA_ARM64}"\n`,
    "",
  );

  const violations = findContainerfileViolations(stripped, manifest);
  assertEquals(violations.length, 1);
  assert(violations[0]!.includes("RUST_SHA256_ARM64"));
});

Deno.test("container/ - the image supplies every monitored-repo toolchain command", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );

  // Enumerated from the `repos` in .config.json by reading each monitored
  // repository's own quality gate: the Rust crates need cargo/clippy/rustfmt
  // and cargo-deny, every gate with shell scripts needs shellcheck, and the
  // markdownlint tooling backs .markdownlint-cli2.jsonc.
  assertEquals(
    findMissingRuntimeTools(manifest, REQUIRED_REPO_TOOLCHAIN_COMMANDS),
    [],
  );
  assert(REQUIRED_REPO_TOOLCHAIN_COMMANDS.includes("cargo"));
  assert(REQUIRED_REPO_TOOLCHAIN_COMMANDS.includes("shellcheck"));
  assert(REQUIRED_REPO_TOOLCHAIN_COMMANDS.includes("markdownlint-cli2"));
  // Issue #650: the local SAST gate stage needs the binary in the image, or
  // it SKIPs on every fleet run and findings are met only in CI.
  assert(REQUIRED_REPO_TOOLCHAIN_COMMANDS.includes("semgrep"));
});

Deno.test("container/ - every committed toolchain names the repositories it exists for", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );

  assert(manifest.toolchains.length > 0, "the manifest must pin toolchains");
  for (const toolchain of manifest.toolchains) {
    assert(
      toolchain.repos.length > 0,
      `${toolchain.id} must name the monitored repositories it exists for`,
    );
    assert(
      toolchain.commands.includes(toolchain.versionCommand),
      `${toolchain.id} must report its version from a command it installs`,
    );
  }
});

// ---------------------------------------------------------------------------
// Issue #475 — npm is pinned in its own right, not inherited from Node
// ---------------------------------------------------------------------------

Deno.test("container/ - npm is pinned at 12.x and owned by exactly one toolchain (Issue #475)", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );

  // Two toolchains claiming `npm` means one silently overwrites the other and
  // nothing says which pin the image actually carries.
  const owners = manifest.toolchains.filter((t) => t.commands.includes("npm"));
  assertEquals(
    owners.map((t) => t.id),
    ["npm"],
    "exactly one toolchain may install the npm command",
  );

  const npm = owners[0]!;
  assertEquals(npm.versionCommand, "npm");
  assertEquals(
    npm.version.split(".")[0],
    "12",
    `npm must be pinned on the 12.x line (got ${npm.version})`,
  );
  // Pure JavaScript, so one noarch digest covers both architectures.
  assertEquals(Object.keys(npm.sha256), ["noarch"]);
  assertEquals(npm.sha256.noarch?.length, 64);

  // Node still supplies the runtime; neither command may fall back to a host
  // installation.
  assertEquals(findMissingRuntimeTools(manifest, ["node", "npm"]), []);
});

Deno.test("container/Containerfile - installs the pinned npm from a checksum-verified tarball (Issue #475)", async () => {
  const containerfile = await Deno.readTextFile(
    new URL("container/Containerfile", REPO_ROOT),
  );
  const steps = containerfile
    .split("\n")
    .filter((line) =>
      !line.trim().startsWith("#") && !/^ARG\b/.test(line.trim())
    )
    .join("\n");

  // The ARG restatement is checked by findContainerfileViolations; this is the
  // other half — a declared pin the build never applies would leave the image
  // on Node's bundled npm while the manifest claimed otherwise.
  assertStringIncludes(steps, "npm/-/npm-${NPM_VERSION}.tgz");
  assertStringIncludes(steps, "${NPM_SHA256_NOARCH}");
});

// ---------------------------------------------------------------------------
// Issue #650 — semgrep is in the image, so the SAST gate stage scans rather
// than SKIPs on a fleet run
// ---------------------------------------------------------------------------

Deno.test("findMissingRuntimeTools - reports semgrep when no toolchain installs it (Issue #650)", () => {
  const manifest = parseContainerManifest(toolchainManifestText());

  // The manifest that pins only Rust supplies no semgrep, which is the state
  // that made the gate stage SKIP on every fleet run.
  assertEquals(findMissingRuntimeTools(manifest, ["semgrep"]), ["semgrep"]);
});

Deno.test("container/ - semgrep is pinned at the version CI runs (Issue #650)", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );

  const owners = manifest.toolchains.filter((t) =>
    t.commands.includes("semgrep")
  );
  assertEquals(
    owners.map((t) => t.id),
    ["semgrep"],
    "exactly one toolchain may install the semgrep command",
  );

  const semgrep = owners[0]!;
  assertEquals(semgrep.versionCommand, "semgrep");
  // A local scan only predicts the CI result when both run the same semgrep:
  // the gate compares `semgrep --version` against this same constant and
  // names the drift in its output.
  assertEquals(semgrep.version, SEMGREP_IMAGE_TAG);
  // The wheels are architecture-specific (each bundles its own semgrep-core).
  assertEquals(semgrep.sha256.amd64?.length, 64);
  assertEquals(semgrep.sha256.arm64?.length, 64);
  // pip is a second artefact: Debian ships no ensurepip, so the installer
  // itself is downloaded, and it is pinned like everything else.
  const pip = manifest.tools.find((t) => t.name === "pip");
  assert(pip, "container/tools.json must pin the pip that installs the wheel");
  assertEquals(pip.versionArg, "PIP_VERSION");
  assertEquals(Object.keys(pip.sha256), ["noarch"]);
  assertEquals(pip.sha256.noarch?.length, 64);

  assertEquals(findMissingRuntimeTools(manifest, ["semgrep"]), []);
});

Deno.test("container/ - the base image supplies the Python semgrep needs (Issue #650)", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );

  // The wheel is installed into a virtualenv built on the base image's own
  // interpreter, and semgrep 1.x requires Python >= 3.10 — a base bump that
  // dropped python3 would otherwise surface as a puzzling build failure.
  const base = manifest.images.find((i) => i.arg === "BASE_IMAGE");
  assert(base, "the manifest must pin a base image");
  assert(
    base.provides.includes("python3"),
    `base image provides ${base.provides.join(", ")} — python3 is missing`,
  );
  const floor = base.minVersions.python3;
  assert(floor, "the base image must record a python3 version floor");
  const [major, minor] = floor.split(".").map(Number);
  assert(
    major === 3 && minor !== undefined && minor >= 10,
    `python3 floor ${floor} is below semgrep's requires-python of 3.10`,
  );
});

Deno.test("container/Containerfile - installs the pinned semgrep wheel and proves the version (Issue #650)", async () => {
  const containerfile = await Deno.readTextFile(
    new URL("container/Containerfile", REPO_ROOT),
  );
  const steps = containerfile
    .split("\n")
    .filter((line) =>
      !line.trim().startsWith("#") && !/^ARG\b/.test(line.trim())
    )
    .join("\n");

  // The ARG restatement is checked by findContainerfileViolations; this is
  // the other half — a declared pin the build never applies would leave the
  // image without semgrep while the manifest claimed otherwise.
  assertStringIncludes(steps, "pip-${PIP_VERSION}-py3-none-any.whl");
  assertStringIncludes(steps, "${PIP_SHA256_NOARCH}");
  assertStringIncludes(steps, "semgrep==${SEMGREP_VERSION}");
  // The resolved wheel is checked against the per-architecture pin before it
  // is installed, so the index's word for the bytes is never taken.
  assert(
    /sg_sha=\"\$\{SEMGREP_SHA256_(AMD64|ARM64)\}\"/.test(steps),
    "the build must select the per-architecture semgrep checksum",
  );
  assertStringIncludes(steps, '"${sg_sha}  ${whl}" | sha256sum -c -');
  // On PATH for the gate's `semgrep --version` probe, at the pinned version.
  assertStringIncludes(steps, "/usr/local/bin/semgrep");
  assertStringIncludes(
    steps,
    'semgrep --version | grep -qxF "${SEMGREP_VERSION}"',
  );
});

// ---------------------------------------------------------------------------
// Playwright + headless Chromium baked into the image (Issue #4069)
// ---------------------------------------------------------------------------

const BROWSERS_PATH = "/opt/playwright-browsers";

/** A manifest object pinning the Playwright browser installer. */
function browserManifestText(): string {
  const raw = manifestObject();
  (raw.tools as Record<string, unknown>[]).push({
    name: "playwright-core",
    version: "1.61.0-alpha-1778188671000",
    versionArg: "PLAYWRIGHT_VERSION",
    sha256: {
      noarch: SHA_AMD64,
      chromium_amd64: SHA_AMD64,
      chromium_arm64: SHA_ARM64,
    },
    browsersPath: BROWSERS_PATH,
  });
  return JSON.stringify(raw);
}

/** A Containerfile that bakes the browser the way the image must. */
const BROWSER_CONTAINERFILE = [
  `ENV PLAYWRIGHT_BROWSERS_PATH="${BROWSERS_PATH}"`,
  "RUN set -eu; \\",
  '    npm install -g --ignore-scripts "${tarball}"; \\',
  '    echo "${PLAYWRIGHT_SHA256_CHROMIUM_AMD64}  /tmp/chromium.zip" | sha256sum -c -; \\',
  "    playwright-core install --with-deps chromium chromium-headless-shell; \\",
  '    chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"',
].join("\n");

Deno.test("findBrowserInstallViolations - a baked browser has none", () => {
  const manifest = parseContainerManifest(browserManifestText());
  assertEquals(
    findBrowserInstallViolations(
      BROWSER_CONTAINERFILE,
      manifest,
      BROWSERS_PATH,
    ),
    [],
  );
});

Deno.test("findBrowserInstallViolations - reports an unpinned browser version", () => {
  const manifest = parseContainerManifest(manifestText());
  const violations = findBrowserInstallViolations(
    BROWSER_CONTAINERFILE,
    manifest,
    BROWSERS_PATH,
  );

  assert(violations.some((v) => v.includes("playwright-core")));
});

Deno.test("findBrowserInstallViolations - reports a browsers path the image never bakes", () => {
  const manifest = parseContainerManifest(browserManifestText());
  const moved = BROWSER_CONTAINERFILE.replace(BROWSERS_PATH, "/srv/browsers");

  const violations = findBrowserInstallViolations(
    moved,
    manifest,
    BROWSERS_PATH,
  );
  assert(violations.some((v) => v.includes("PLAYWRIGHT_BROWSERS_PATH")));
});

Deno.test("findBrowserInstallViolations - reports a build that installs no Chromium", () => {
  const manifest = parseContainerManifest(browserManifestText());
  const stripped = BROWSER_CONTAINERFILE.split("\n")
    .filter((line) => !line.includes("chromium"))
    .join("\n");

  const violations = findBrowserInstallViolations(
    stripped,
    manifest,
    BROWSERS_PATH,
  );
  assert(violations.some((v) => v.includes("download a browser mid-run")));
});

Deno.test("findBrowserInstallViolations - reports a browser the worker user cannot read", () => {
  const manifest = parseContainerManifest(browserManifestText());
  const unreadable = BROWSER_CONTAINERFILE.split("\n")
    .filter((line) => !line.includes("chmod"))
    .join("\n");

  const violations = findBrowserInstallViolations(
    unreadable,
    manifest,
    BROWSERS_PATH,
  );
  assert(violations.some((v) => v.includes("readable")));
});

Deno.test("findBrowserInstallViolations - ignores a commented-out install", () => {
  const manifest = parseContainerManifest(browserManifestText());
  const commented = BROWSER_CONTAINERFILE.split("\n")
    .map((line) => line.includes("chromium") ? `# ${line}` : line)
    .join("\n");

  const violations = findBrowserInstallViolations(
    commented,
    manifest,
    BROWSERS_PATH,
  );
  assert(violations.some((v) => v.includes("download a browser mid-run")));
});

Deno.test("findBrowserInstallViolations - reports a playwright-core pin without Chromium checksums (Issue #274)", () => {
  const raw = JSON.parse(browserManifestText()) as {
    tools: Array<{ name: string; sha256: Record<string, string> }>;
  };
  const pin = raw.tools.find((t) => t.name === "playwright-core")!;
  delete pin.sha256.chromium_amd64;
  delete pin.sha256.chromium_arm64;

  const violations = findBrowserInstallViolations(
    BROWSER_CONTAINERFILE,
    parseContainerManifest(JSON.stringify(raw)),
    BROWSERS_PATH,
  );
  assert(violations.some((v) => v.includes("chromium_amd64")));
  assert(violations.some((v) => v.includes("chromium_arm64")));
});

Deno.test("findBrowserInstallViolations - reports a bake that never verifies the Chromium checksum (Issue #274)", () => {
  const manifest = parseContainerManifest(browserManifestText());
  const unverified = BROWSER_CONTAINERFILE.split("\n")
    .filter((line) => !line.includes("PLAYWRIGHT_SHA256_CHROMIUM"))
    .join("\n");

  const violations = findBrowserInstallViolations(
    unverified,
    manifest,
    BROWSERS_PATH,
  );
  assert(violations.some((v) => v.includes("PLAYWRIGHT_SHA256_CHROMIUM")));
});

Deno.test("container/ - the committed image bakes Playwright's headless Chromium", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT)),
  );
  const containerfile = await Deno.readTextFile(
    new URL("container/Containerfile", REPO_ROOT),
  );

  assertEquals(
    findBrowserInstallViolations(
      containerfile,
      manifest,
      CONTAINER_BROWSERS_PATH,
    ),
    [],
  );
});

Deno.test("container/ - the baked browser matches the version the MCP server uses", async () => {
  const raw = await Deno.readTextFile(
    new URL("container/tools.json", REPO_ROOT),
  );
  const manifest = parseContainerManifest(raw);
  const pinned = manifest.tools.find((t) => t.name === "playwright-core");
  assert(pinned, "container/tools.json must pin playwright-core");

  // Playwright stores browsers as `chromium-<revision>` and every release
  // pins its own revision, so a near-miss version bakes a browser the MCP
  // server ignores and then downloads the right one mid-run.
  assertEquals(pinned.version, PLAYWRIGHT_INSTALLER_VERSION);

  // Issue #274: the Chromium zip is a second artefact — the noarch tarball
  // checksum does not cover it.
  assertEquals(pinned.sha256.chromium_amd64?.length, 64);
  assertEquals(pinned.sha256.chromium_arm64?.length, 64);

  // The path the image bakes is the one screenshot.ts resolves.
  const browsersPath = (JSON.parse(raw).tools as Array<Record<string, unknown>>)
    .find((t) => t.name === "playwright-core")?.browsersPath;
  assertEquals(browsersPath, CONTAINER_BROWSERS_PATH);
});

Deno.test("Containerfile - the copy the image is built from stays under Apple container's cap (Issue #4393)", async () => {
  // Apple `container` rejects Dockerfiles larger than 16384 bytes
  // (apple/container#735) — and a file within a few bytes of the cap has
  // been seen failing the build with an unexplained "Stream unexpectedly
  // closed" instead of the named error. Since Issue #4393 the launcher and
  // CI build from a comment-stripped copy, so the cap applies to THAT text
  // and the committed file may carry its comments; `tests/
  // containerfile_strip_test.ts` holds the byte assertion. This test keeps
  // the committed file honest about being mostly comments: an instruction
  // set that no longer fits even stripped is a real problem.
  const path = new URL("../../../container/Containerfile", import.meta.url);
  const text = await Deno.readTextFile(path);
  const stripped = new TextEncoder().encode(stripContainerfile(text)).length;
  if (stripped > CONTAINERFILE_SIZE_CAP_BYTES) {
    throw new Error(
      `container/Containerfile strips to ${stripped} bytes (limit ${CONTAINERFILE_SIZE_CAP_BYTES}); ` +
        "Apple container refuses Dockerfiles over 16384 bytes " +
        "(apple/container#735) - trim instructions",
    );
  }
});

// ---------------------------------------------------------------------------
// Issue #4392 — the pre-warmed Deno cache is built from the same pins
// ---------------------------------------------------------------------------

Deno.test("container/deno-seed - pins agree with screenshot.ts, the Containerfile ARG and the worker lockfile (Issue #4392)", async () => {
  const seedConfig = JSON.parse(
    await Deno.readTextFile(
      new URL("container/deno-seed/deno.json", REPO_ROOT),
    ),
  ) as { imports: Record<string, string> };
  const seedLock = JSON.parse(
    await Deno.readTextFile(
      new URL("container/deno-seed/deno.lock", REPO_ROOT),
    ),
  ) as {
    specifiers: Record<string, string>;
    npm: Record<string, { integrity: string }>;
    jsr: Record<string, { integrity: string }>;
  };
  const containerfile = await Deno.readTextFile(
    new URL("container/Containerfile", REPO_ROOT),
  );
  const workerLock = JSON.parse(
    await Deno.readTextFile(new URL("worker/deno/deno.lock", REPO_ROOT)),
  ) as { specifiers: Record<string, string> };

  // The MCP the seed warms is the one the worker launches...
  assertEquals(
    seedConfig.imports["@playwright/mcp"],
    `npm:@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
  );
  // ...and the Containerfile ARG that guards the build names the same pin.
  const arg = containerfile.match(/^ARG PLAYWRIGHT_MCP_VERSION="([^"]+)"/m);
  assertEquals(arg?.[1], PLAYWRIGHT_MCP_VERSION);
  // The lock resolves it, with integrity, to exactly that version...
  assertEquals(
    seedLock.specifiers[`npm:@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`],
    PLAYWRIGHT_MCP_VERSION,
  );
  assert(
    seedLock.npm[`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`]?.integrity
      .startsWith("sha512-"),
  );
  // ...and its playwright-core is the version whose browser the image bakes.
  assert(
    seedLock.npm[`playwright-core@${PLAYWRIGHT_INSTALLER_VERSION}`]?.integrity
      .startsWith("sha512-"),
    `seed lock must pin playwright-core@${PLAYWRIGHT_INSTALLER_VERSION}: ${
      Object.keys(seedLock.npm).join(", ")
    }`,
  );

  // The worker's JSR deps in the seed are the versions the worker lock pins.
  for (const [spec, version] of Object.entries(workerLock.specifiers)) {
    if (!spec.startsWith("jsr:")) continue;
    const name = spec.slice("jsr:".length).replace(/@[^@]*$/, "");
    const seeded = Object.entries(seedLock.specifiers).find(([k]) =>
      k.startsWith(`jsr:${name}@`)
    );
    assert(seeded, `seed must pre-cache ${name} (worker lock has ${spec})`);
    assertEquals(
      seeded[1],
      version,
      `${name}: seed ${seeded[1]} vs worker ${version}`,
    );
  }
  // The build fails loud on lock drift and proves the seed runs offline.
  assert(/cmp -s \$s\/deno\.lock/.test(containerfile), "lock drift guard");
  assert(/deno run --cached-only/.test(containerfile), "offline proof");
  // The entrypoint seeds from the same directory the image exports.
  const seedDir = containerfile.match(/^ENV VIBE_DENO_SEED_DIR="([^"]+)"/m)
    ?.[1];
  assertEquals(seedDir, "/opt/deno-seed");
  const entrypoint = await Deno.readTextFile(
    new URL("container/entrypoint.sh", REPO_ROOT),
  );
  assert(entrypoint.includes("VIBE_DENO_SEED_DIR:-/opt/deno-seed"));
});
