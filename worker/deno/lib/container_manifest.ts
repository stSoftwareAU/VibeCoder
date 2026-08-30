/**
 * Pinned-tool manifest for the Vibe Coder container image (Issue #4061).
 *
 * `container/tools.json` is the single source of truth for every version the
 * image installs; `container/Containerfile` only restates those values as
 * build `ARG`s. This module parses the manifest and reports where the
 * Containerfile disagrees with it, so "the image is fully pinned" is a
 * checked invariant rather than a claim in a comment.
 *
 * Both functions are pure — callers read the files — and both fail loud:
 * `parseContainerManifest` throws with the offending field named, and
 * `findContainerfileViolations` returns every disagreement it finds rather
 * than stopping at the first.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

/** A container image pinned by immutable digest. */
export interface ContainerImagePin {
  /** Repository, e.g. `buildpack-deps` or `denoland/deno`. */
  name: string;
  /** Human-readable tag recorded alongside the digest. */
  tag: string;
  /** `sha256:<64 hex>` digest the build must resolve. */
  digest: string;
  /** Containerfile `ARG` carrying the full reference. */
  arg: string;
  /** Commands the image already ships, so the build installs nothing. */
  provides: string[];
  /**
   * Minimum acceptable version for a provided command, e.g. `git: "2.41"`
   * (Issue #4090). `.github/workflows/container-build.yml` asserts the built
   * image clears every floor recorded here.
   */
  minVersions: Record<string, string>;
}

/** A tool downloaded during the build, pinned by version and checksum. */
export interface ContainerToolPin {
  /** Command name, e.g. `gh`. */
  name: string;
  /** Exact release version, never a floating alias. */
  version: string;
  /** Containerfile `ARG` carrying the version, e.g. `GH_VERSION`. */
  versionArg: string;
  /** Architecture (`amd64`, `arm64`) to SHA-256 of the release asset. */
  sha256: Record<string, string>;
}

/**
 * A coding-agent provider installed by a per-provider fragment (Issue #4067).
 *
 * The provider layer is separable: the base Containerfile selects a *set* of
 * `container/providers/<id>.sh` fragments with the `AGENT_PROVIDERS` build
 * argument (Issue #4105), and each fragment reads its pins from here.
 */
export interface ContainerProviderPin {
  /** Provider id, matching the descriptor in `worker/deno/lib/agent_provider.ts`. */
  id: string;
  /** Command the fragment installs, e.g. `claude`. */
  binary: string;
  /** Fragment path relative to `container/`, e.g. `providers/claude.sh`. */
  fragment: string;
  /** Exact release version, never a floating alias. */
  version: string;
  /** Architecture (`amd64`, `arm64`) to SHA-256 of the release asset. */
  sha256: Record<string, string>;
}

/**
 * A build/test toolchain a monitored repository's quality gate needs
 * (Issue #4068).
 *
 * Same pinning rules as a tool, plus the commands it puts on the image PATH
 * and the monitored repositories it exists for — so a repository leaving the
 * fleet makes its toolchain removable rather than permanent image weight.
 */
export interface ContainerToolchainPin {
  /** Toolchain id, e.g. `rust`. */
  id: string;
  /** Exact release version, never a floating alias. */
  version: string;
  /** Containerfile `ARG` carrying the version, e.g. `RUST_VERSION`. */
  versionArg: string;
  /** Architecture (`amd64`, `arm64`, `noarch`) to SHA-256 of the asset. */
  sha256: Record<string, string>;
  /** Commands the toolchain puts on the image PATH. */
  commands: string[];
  /** The command whose `--version` must report {@link version}. */
  versionCommand: string;
  /** `owner/repo` slugs whose quality gate needs this toolchain. */
  repos: string[];
}

/** The parsed `container/tools.json`. */
export interface ContainerManifest {
  /** Absolute path the repository is mounted at inside the image. */
  workdir: string;
  /** The non-root account the image runs as. */
  user: { name: string; uid: number; gid: number };
  images: ContainerImagePin[];
  tools: ContainerToolPin[];
  /** Coding-agent providers pinned here, each with its own fragment. */
  providers: ContainerProviderPin[];
  /**
   * The provider ids a default image build installs (Issue #4105), in the
   * order the build installs them. A subset of {@link providers}: a provider
   * can be pinned and available without being in the default image.
   */
  installedProviders: string[];
  /** Monitored-repository build/test toolchains (Issue #4068). */
  toolchains: ContainerToolchainPin[];
}

/**
 * Commands `./quality.sh` shells out to inside the image (Issue #4090).
 *
 * Each must be pinned as a downloaded tool or listed in an image's
 * `provides`; `ruby` is here because the Pages scripts under
 * `.github/scripts/*.rb` are spawned by the test suite.
 */
export const REQUIRED_RUNTIME_TOOLS: readonly string[] = [
  "bash",
  "coreutils",
  "curl",
  "deno",
  "gh",
  "git",
  "jq",
  "ruby",
];

/**
 * Commands the monitored repositories' own quality gates invoke (Issue #4068).
 *
 * Enumerated by reading each `repos` entry in `.config.json` at its own
 * `quality.sh`: the Rust crates (private-repo-5, private-repo-9, private-repo-10 and the
 * private-repo-14 crates) drive `cargo`/`cargo-clippy`/`rustfmt` and hard-fail without
 * `cargo-deny`, every gate carrying shell scripts runs `shellcheck`, private-repo-14-
 * scorer runs `actionlint`, and this repo's own gate drives `markdownlint-cli2`
 * against `.markdownlint-cli2.jsonc` and `semgrep` over the branch's changed
 * files (Issue #650 — without the binary that SAST stage SKIPs on every fleet
 * run and findings are met only in CI). Each must be supplied by a manifest
 * toolchain, so the image never falls back to a host-installed equivalent.
 */
export const REQUIRED_REPO_TOOLCHAIN_COMMANDS: readonly string[] = [
  "cargo",
  "rustc",
  "cargo-clippy",
  "rustfmt",
  "cargo-deny",
  "shellcheck",
  "actionlint",
  "markdownlint-cli2",
  "semgrep",
];

/** Aliases that resolve to "whatever upstream published most recently". */
const FLOATING_TAGS = new Set(["latest", "edge", "main", "master", "stable"]);

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ARG_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const VERSION_RE = /^\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?$/;

/** Throw a manifest error naming the offending field. */
function fail(field: string, detail: string): never {
  throw new Error(`container/tools.json: ${field} ${detail}`);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(field, "must be an object");
  }
  return value as Record<string, unknown>;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(field, "must be a non-empty string");
  }
  return value as string;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    fail(field, "must list at least one entry");
  }
  return value as unknown[];
}

function parseUser(value: unknown): ContainerManifest["user"] {
  const raw = asRecord(value, "user");
  const name = asString(raw.name, "user.name");
  const uid = raw.uid;
  const gid = raw.gid;
  if (!Number.isInteger(uid) || !Number.isInteger(gid)) {
    fail("user.uid/user.gid", "must be integers");
  }
  if (name === "root" || uid === 0 || gid === 0) {
    fail("user", "must not run as root (uid/gid 0)");
  }
  return { name, uid: uid as number, gid: gid as number };
}

function parseImage(value: unknown, index: number): ContainerImagePin {
  const field = `images[${index}]`;
  const raw = asRecord(value, field);
  const name = asString(raw.name, `${field}.name`);
  const tag = asString(raw.tag, `${field}.tag`);
  const digest = asString(raw.digest, `${field}.digest`);
  const arg = asString(raw.arg, `${field}.arg`);

  if (FLOATING_TAGS.has(tag)) {
    fail(`${field}.tag`, `must not be a floating alias such as "latest"`);
  }
  if (!DIGEST_RE.test(digest)) {
    fail(`${field}.digest`, "must be a sha256:<64 hex> digest");
  }
  if (!ARG_NAME_RE.test(arg)) {
    fail(`${field}.arg`, "must be an UPPER_SNAKE_CASE build argument name");
  }

  const provides = raw.provides === undefined
    ? []
    : (Array.isArray(raw.provides)
      ? raw.provides
      : fail(`${field}.provides`, "must be an array of command names"))
      .map((entry, i) => asString(entry, `${field}.provides[${i}]`));

  const minVersions: Record<string, string> = {};
  if (raw.minVersions !== undefined) {
    const floors = asRecord(raw.minVersions, `${field}.minVersions`);
    for (const [command, floor] of Object.entries(floors)) {
      const where = `${field}.minVersions.${command}`;
      const value = asString(floor, where);
      if (!VERSION_RE.test(value)) {
        fail(where, `must be a dotted version (got "${value}")`);
      }
      if (!provides.includes(command)) {
        fail(where, `records a floor for "${command}", which is not provided`);
      }
      minVersions[command] = value;
    }
  }

  return { name, tag, digest, arg, provides, minVersions };
}

/** Parse a `sha256` map, requiring a 64-hex digest per architecture. */
function parseSha256(value: unknown, field: string): Record<string, string> {
  const shaRaw = asRecord(value, field);
  const sha256: Record<string, string> = {};
  const arches = Object.keys(shaRaw);
  if (arches.length === 0) {
    fail(field, "must pin at least one architecture");
  }
  for (const arch of arches) {
    const digest = asString(shaRaw[arch], `${field}.${arch}`);
    if (!SHA256_RE.test(digest)) {
      fail(`${field}.${arch}`, "must be a 64-character hex sha256");
    }
    sha256[arch] = digest;
  }
  return sha256;
}

/** Reject a version that is missing, malformed, or a floating alias. */
function parseExactVersion(value: unknown, field: string): string {
  const version = asString(value, field);
  if (FLOATING_TAGS.has(version) || !VERSION_RE.test(version)) {
    fail(
      field,
      `must be an exact version, never "latest" (got "${version}")`,
    );
  }
  return version;
}

function parseTool(value: unknown, index: number): ContainerToolPin {
  const field = `tools[${index}]`;
  const raw = asRecord(value, field);
  const name = asString(raw.name, `${field}.name`);
  const version = parseExactVersion(raw.version, `${field}.version`);
  const versionArg = asString(raw.versionArg, `${field}.versionArg`);

  if (!ARG_NAME_RE.test(versionArg) || !versionArg.endsWith("_VERSION")) {
    fail(`${field}.versionArg`, "must be named <TOOL>_VERSION");
  }

  return {
    name,
    version,
    versionArg,
    sha256: parseSha256(raw.sha256, `${field}.sha256`),
  };
}

/** `owner/repo`, as `.config.json` records a monitored repository. */
const REPO_SLUG_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function parseToolchain(value: unknown, index: number): ContainerToolchainPin {
  const field = `toolchains[${index}]`;
  const raw = asRecord(value, field);
  const id = asString(raw.id, `${field}.id`);
  const version = parseExactVersion(raw.version, `${field}.version`);
  const versionArg = asString(raw.versionArg, `${field}.versionArg`);

  if (!PROVIDER_ID_RE.test(id)) {
    fail(`${field}.id`, 'must be a lower-case toolchain id (e.g. "rust")');
  }
  if (!ARG_NAME_RE.test(versionArg) || !versionArg.endsWith("_VERSION")) {
    fail(`${field}.versionArg`, "must be named <TOOLCHAIN>_VERSION");
  }

  const commands = asArray(raw.commands, `${field}.commands`)
    .map((entry, i) => asString(entry, `${field}.commands[${i}]`));

  const versionCommand = asString(
    raw.versionCommand,
    `${field}.versionCommand`,
  );
  if (!commands.includes(versionCommand)) {
    fail(
      `${field}.versionCommand`,
      `must be one of the commands the toolchain installs (got "${versionCommand}")`,
    );
  }

  // A toolchain exists for named monitored repositories: without that the
  // image accumulates weight nobody can prove is still needed.
  const repos = asArray(raw.repos, `${field}.repos`)
    .map((entry, i) => {
      const slug = asString(entry, `${field}.repos[${i}]`);
      if (!REPO_SLUG_RE.test(slug)) {
        fail(
          `${field}.repos[${i}]`,
          `must be an owner/repo slug (got "${slug}")`,
        );
      }
      return slug;
    });

  return {
    id,
    version,
    versionArg,
    sha256: parseSha256(raw.sha256, `${field}.sha256`),
    commands,
    versionCommand,
    repos,
  };
}

const PROVIDER_ID_RE = /^[a-z][a-z0-9-]*$/;

function parseProvider(value: unknown, index: number): ContainerProviderPin {
  const field = `providers[${index}]`;
  const raw = asRecord(value, field);
  const id = asString(raw.id, `${field}.id`);
  const binary = asString(raw.binary, `${field}.binary`);
  const fragment = asString(raw.fragment, `${field}.fragment`);
  const version = parseExactVersion(raw.version, `${field}.version`);

  if (!PROVIDER_ID_RE.test(id)) {
    fail(`${field}.id`, 'must be a lower-case provider id (e.g. "claude")');
  }
  if (fragment !== `providers/${id}.sh`) {
    fail(
      `${field}.fragment`,
      `must be "providers/${id}.sh" so the build argument selects it`,
    );
  }

  return {
    id,
    binary,
    fragment,
    version,
    sha256: parseSha256(raw.sha256, `${field}.sha256`),
  };
}

/**
 * Reject two providers that would install the same command (Issue #415).
 *
 * Providers are installed into one image as `/usr/local/bin/<binary>`, so two
 * entries sharing a `binary` means the second fragment silently overwrites the
 * first and the image carries one CLI under two provider ids. That is a real
 * hazard for a provider like `deepseek`, whose artefact *is* the Claude CLI:
 * setting its binary to `claude` would look like sensible de-duplication and
 * produce an image where both providers are the same command.
 *
 * @param providers - The parsed provider pins, in manifest order.
 */
function assertDistinctProviderBinaries(
  providers: ContainerProviderPin[],
): void {
  const owner = new Map<string, string>();
  providers.forEach((provider, index) => {
    const first = owner.get(provider.binary);
    if (first !== undefined) {
      fail(
        `providers[${index}].binary`,
        `installs "${provider.binary}", which "${first}" already installs: ` +
          "one provider would overwrite the other",
      );
    }
    owner.set(provider.binary, provider.id);
  });
}

/**
 * Parse the installed provider set (Issue #4105).
 *
 * The set is what a default image build installs, so an empty list, a
 * malformed or duplicated id, or an id with no pinned provider is rejected
 * here rather than producing an image that carries no agent — or one whose
 * manifest claims a provider it never installed.
 */
function parseInstalledProviders(
  value: unknown,
  providers: ContainerProviderPin[],
): string[] {
  const field = "installedProviders";
  const raw = asArray(value, field);
  const pinned = new Set(providers.map((p) => p.id));
  const installed: string[] = [];

  raw.forEach((entry, index) => {
    const where = `${field}[${index}]`;
    const id = asString(entry, where);
    if (!PROVIDER_ID_RE.test(id)) {
      fail(where, `must be a lower-case provider id (got "${id}")`);
    }
    if (installed.includes(id)) {
      fail(where, `lists "${id}" twice`);
    }
    if (!pinned.has(id)) {
      fail(where, `names "${id}", which is not pinned in providers[]`);
    }
    installed.push(id);
  });

  return installed;
}

/**
 * Parse and validate `container/tools.json`.
 *
 * @param text - Raw manifest JSON.
 * @returns The validated manifest.
 * @throws Error naming the offending field when anything is unpinned,
 *   malformed, or would run the image as root.
 */
export function parseContainerManifest(text: string): ContainerManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `container/tools.json is not valid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const root = asRecord(raw, "manifest");
  const workdir = asString(root.workdir, "workdir");
  if (!workdir.startsWith("/")) {
    fail("workdir", "must be an absolute path");
  }

  const images = asArray(root.images, "images").map(parseImage);
  const tools = asArray(root.tools, "tools").map(parseTool);
  // Optional so a manifest for an image without an agent layer still parses;
  // findProviderInstallViolations is what requires the committed manifest to
  // pin the provider the Containerfile selects.
  const providers = root.providers === undefined
    ? []
    : asArray(root.providers, "providers").map(parseProvider);
  assertDistinctProviderBinaries(providers);
  // Optional for the same reason; findProviderInstallViolations is what
  // requires the committed manifest to record the set the image installs.
  const installedProviders = root.installedProviders === undefined
    ? []
    : parseInstalledProviders(root.installedProviders, providers);
  // Optional for the same reason: an image built without monitored-repo
  // toolchains still parses; the committed manifest's coverage is asserted by
  // findMissingRuntimeTools against REQUIRED_REPO_TOOLCHAIN_COMMANDS.
  const toolchains = root.toolchains === undefined
    ? []
    : asArray(root.toolchains, "toolchains").map(parseToolchain);

  return {
    workdir,
    user: parseUser(root.user),
    images,
    tools,
    providers,
    installedProviders,
    toolchains,
  };
}

/**
 * Report the commands the image would not supply (Issue #4090).
 *
 * A command is supplied when it is pinned as a downloaded tool, installed by
 * a manifest toolchain (Issue #4068), or listed in a digest-pinned image's
 * `provides`. Anything else would only resolve at runtime by accident, which
 * is how a base image without `ruby` reached CI.
 *
 * @param manifest - The parsed manifest.
 * @param required - Commands the image must supply; defaults to the
 *   toolchain `./quality.sh` needs.
 * @returns The missing command names, in the order given; empty when covered.
 */
export function findMissingRuntimeTools(
  manifest: ContainerManifest,
  required: readonly string[] = REQUIRED_RUNTIME_TOOLS,
): string[] {
  const supplied = new Set<string>(manifest.tools.map((t) => t.name));
  for (const image of manifest.images) {
    for (const command of image.provides) supplied.add(command);
  }
  for (const toolchain of manifest.toolchains) {
    for (const command of toolchain.commands) supplied.add(command);
  }
  return required.filter((command) => !supplied.has(command));
}

/** Build argument carrying the set of providers the image installs. */
export const PROVIDER_SET_ARG = "AGENT_PROVIDERS";

/** `ARG AGENT_PROVIDERS="a,b"`, capturing the (maybe quoted) set. */
const PROVIDER_SET_ARG_RE = new RegExp(
  `^ARG\\s+${PROVIDER_SET_ARG}="?([A-Za-z0-9_,-]*)"?\\s*$`,
  "m",
);

/** A build step that runs the set installer with the build argument. */
const PROVIDER_SET_INSTALL_RE =
  /install-providers\.sh"?\s+"?\$\{?AGENT_PROVIDERS\}?"?/;

/**
 * Report every place the provider layer is not separable (Issue #4067) or
 * not set-valued (Issue #4105).
 *
 * The coding-agent providers must be installed by per-provider fragments the
 * base definition merely selects, so adding the next provider is a new
 * fragment rather than an edit to the Containerfile. Checks that the
 * Containerfile declares the set-valued `AGENT_PROVIDERS` build argument,
 * defaults it to exactly the manifest's `installedProviders`, runs one
 * fragment per requested id, and installs no provider binary of its own; and
 * that every pinned provider ships a fragment which verifies its download
 * against a checksum and pipes nothing into a shell.
 *
 * @param containerfile - Raw Containerfile text.
 * @param manifest - The parsed manifest.
 * @param fragments - Fragment path (as recorded in the manifest) to its text.
 * @returns Human-readable violations; empty when the layer is separable.
 */
export function findProviderInstallViolations(
  containerfile: string,
  manifest: ContainerManifest,
  fragments: Map<string, string>,
): string[] {
  const violations: string[] = [];

  if (manifest.providers.length === 0) {
    violations.push(
      "container/tools.json pins no coding-agent provider: the image would " +
        "ship without an agent binary",
    );
  }

  if (manifest.installedProviders.length === 0) {
    violations.push(
      "container/tools.json records no installedProviders: nothing would say " +
        "which providers an image build carries",
    );
  }

  const defaultArg = PROVIDER_SET_ARG_RE.exec(containerfile);
  const expected = manifest.installedProviders.join(",");
  if (!defaultArg) {
    violations.push(
      `Containerfile does not declare ARG ${PROVIDER_SET_ARG}: the provider ` +
        "set would not be selectable at build time",
    );
  } else if (defaultArg[1] !== expected) {
    violations.push(
      `ARG ${PROVIDER_SET_ARG} defaults to "${defaultArg[1]}" but ` +
        `container/tools.json installs "${expected}"`,
    );
  }

  if (!PROVIDER_SET_INSTALL_RE.test(containerfile)) {
    violations.push(
      `Containerfile never runs install-providers.sh "\${${PROVIDER_SET_ARG}}": ` +
        "the requested fragments would be ignored",
    );
  }

  for (const provider of manifest.providers) {
    const fragment = fragments.get(provider.fragment);
    if (fragment === undefined) {
      violations.push(`${provider.fragment} is missing`);
      continue;
    }
    if (!fragment.includes("sha256sum -c")) {
      violations.push(
        `${provider.fragment} installs without verifying a checksum`,
      );
    }
    if (/curl[^\n]*\|\s*(ba)?sh/.test(fragment)) {
      violations.push(
        `${provider.fragment} pipes a download into a shell`,
      );
    }
    // The pins belong to the manifest; a fragment that restates the version
    // is a second source of truth that will drift.
    if (fragment.includes(provider.version)) {
      violations.push(
        `${provider.fragment} restates version ${provider.version} instead of ` +
          `reading it from container/tools.json`,
      );
    }
  }

  return violations;
}

/**
 * Report every reason the image would not supply a working headless browser
 * (Issue #4069).
 *
 * The worker captures PR evidence with Playwright MCP, and the host has no
 * browser to borrow — so Chromium must be baked in at build time, resolvable
 * by the non-root worker user, with nothing left to download at run time.
 *
 * @param containerfile - Raw Containerfile text.
 * @param manifest - The parsed manifest.
 * @param browsersPath - Path the image must bake the browsers into, as
 *   `CONTAINER_BROWSERS_PATH` in `worker/deno/setup/screenshot.ts` declares it.
 * @returns Human-readable violations; empty when the browser is baked in.
 */
export function findBrowserInstallViolations(
  containerfile: string,
  manifest: ContainerManifest,
  browsersPath: string,
): string[] {
  const violations: string[] = [];

  const browser = manifest.tools.find((t) => t.name === BROWSER_TOOL_NAME);
  if (!browser) {
    violations.push(
      `container/tools.json pins no "${BROWSER_TOOL_NAME}": the browser ` +
        "version would not be pinned anywhere",
    );
  } else {
    // Issue #274: the npm tarball pin does not cover the Chromium zip
    // `playwright-core install` then fetches. Those blobs need their own
    // committed checksums, restated as PLAYWRIGHT_SHA256_CHROMIUM_* ARGs.
    for (const key of CHROMIUM_SHA_KEYS) {
      if (!browser.sha256[key]) {
        violations.push(
          `container/tools.json "${BROWSER_TOOL_NAME}" sha256 omits ${key}: ` +
            "the Chromium browser blob would be fetched without a committed checksum",
        );
      }
    }
  }

  const code = containerfile
    .split("\n")
    .map(codeOf)
    .filter((line) => line !== "" && !line.startsWith("#"));

  const bakesPath = code.some((line) => {
    const match = BROWSERS_PATH_ENV_RE.exec(line);
    return match !== null &&
      match[1]!.replace(/^["']|["']$/g, "") === browsersPath;
  });
  if (!bakesPath) {
    violations.push(
      `Containerfile does not bake ENV PLAYWRIGHT_BROWSERS_PATH=${browsersPath}: ` +
        "the browser would be looked for in the worker user's home cache",
    );
  }

  if (!code.some((line) => CHROMIUM_INSTALL_RE.test(line))) {
    violations.push(
      "Containerfile never installs Chromium: the first screenshot would " +
        "download a browser mid-run",
    );
  }

  if (
    browser &&
    CHROMIUM_SHA_KEYS.every((key) => browser.sha256[key]) &&
    !code.some((line) =>
      line.includes("PLAYWRIGHT_SHA256_CHROMIUM") && !/^ARG\b/.test(line)
    )
  ) {
    violations.push(
      "Containerfile never verifies a PLAYWRIGHT_SHA256_CHROMIUM checksum: " +
        "the Chromium blob would be fetched without checking the committed digest",
    );
  }

  // The build runs as root; the worker does not. Without a readability fix
  // the baked browser is present but unusable. Plain substring tests, not a
  // regex built from the path — a caller-supplied pattern is a ReDoS seam.
  const readable = code.some((line) =>
    (line.includes("chmod") || line.includes("chown")) &&
    (line.includes("PLAYWRIGHT_BROWSERS_PATH") || line.includes(browsersPath))
  );
  if (!readable) {
    violations.push(
      `Containerfile never makes ${browsersPath} readable to the non-root ` +
        `"${manifest.user.name}" user`,
    );
  }

  return violations;
}

/** Manifest tool name carrying the pinned Playwright browser install. */
const BROWSER_TOOL_NAME = "playwright-core";

/**
 * Extra `sha256` keys on playwright-core for the Chromium zip (Issue #274).
 * Named like rust's rustfmt_/clippy_ extras so they become
 * `PLAYWRIGHT_SHA256_CHROMIUM_AMD64` / `_ARM64` build ARGs.
 */
const CHROMIUM_SHA_KEYS = ["chromium_amd64", "chromium_arm64"] as const;

/** `ENV PLAYWRIGHT_BROWSERS_PATH=<value>`, capturing the (maybe quoted) value. */
const BROWSERS_PATH_ENV_RE = /^ENV\s+PLAYWRIGHT_BROWSERS_PATH=(\S+)$/;

/** A build step that installs the Chromium browser. */
const CHROMIUM_INSTALL_RE = /\binstall\b.*\bchromium\b/;

/** Strip a trailing comment and surrounding whitespace from a line. */
function codeOf(line: string): string {
  return line.replace(/\s+#.*$/, "").trim();
}

/** Value of an `ARG NAME="value"` line, or undefined when absent. */
function argValue(line: string): { name: string; value: string } | undefined {
  const match = /^ARG\s+([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
  if (!match) return undefined;
  return {
    name: match[1]!,
    value: match[2]!.trim().replace(/^["']|["']$/g, ""),
  };
}

/** Expected `ARG` name for a pin's per-architecture checksum. */
function shaArgName(pin: { versionArg: string }, arch: string): string {
  return `${
    pin.versionArg.replace(/_VERSION$/, "")
  }_SHA256_${arch.toUpperCase()}`;
}

/** Package tokens on an install command that carry no version pin. */
function unpinnedPackages(command: string): string[] {
  const installers = [
    /\bapt(?:-get)?\s+(?:[^\n]*\s)?install\b(.*)$/,
    /\bapk\s+add\b(.*)$/,
    /\bnpm\s+(?:install|i|add)\b(.*)$/,
    /\bpip3?\s+install\b(.*)$/,
  ];
  for (const re of installers) {
    const match = re.exec(command);
    if (!match) continue;
    return match[1]!
      .split(/\s+/)
      .filter((token) => token !== "" && token !== "\\")
      .filter((token) => !token.startsWith("-"))
      .filter((token) => !token.includes("$"))
      .filter((token) => !/[=@]/.test(token));
  }
  return [];
}

/** Build argument carrying the deployer-selected extra tools (Issue #71). */
export const CONTAINER_TOOLS_ARG = "VIBE_CONTAINER_TOOLS";

/** The generic install step that argument drives, as the build invokes it. */
const TOOLS_INSTALLER = "install-tools.sh";

/** A step that fetches its payload over the network. */
const FETCH_RE = /\b(?:curl|wget)\b/;

/** A checksum verification in the same build step as the fetch. */
const CHECKSUM_RE = /\bsha256sum\s+-c\b/;

/** A download piped straight into a shell, verified by nothing. */
const PIPE_TO_SHELL_RE = /\b(?:curl|wget)\b[^|]*\|\s*(?:ba)?sh\b/;

/** `ARG VIBE_CONTAINER_TOOLS`, with or without a default. */
const TOOLS_ARG_RE = new RegExp(`^ARG\\s+${CONTAINER_TOOLS_ARG}(?:=|$)`);

/** `RUN` bodies with `\` continuations joined and comment lines dropped. */
function runInstructions(containerfile: string): string[] {
  const runs: string[] = [];
  let current: string | undefined;

  for (const rawLine of containerfile.split("\n")) {
    const line = codeOf(rawLine);
    if (line === "" || line.startsWith("#")) continue;

    const continues = line.endsWith("\\");
    const body = continues ? line.slice(0, -1).trim() : line;

    if (current !== undefined) {
      current = `${current} ${body}`;
      if (!continues) {
        runs.push(current);
        current = undefined;
      }
      continue;
    }

    const run = /^RUN\s+(.*)$/i.exec(body);
    if (!run) continue;
    if (continues) current = run[1]!;
    else runs.push(run[1]!);
  }

  // An unterminated continuation is still a step; report on what it does.
  if (current !== undefined) runs.push(current);
  return runs;
}

/**
 * Report every build step that installs something nothing verifies
 * (Issue #71, parent #5).
 *
 * Every download in the image is checksum-verified against a pin: the tools
 * and toolchains verify inline, and the provider fragments are checked by
 * {@link findProviderInstallViolations}. The deployer-supplied tool step is
 * the single allowance — it installs archives that are deliberately *not* in
 * `container/tools.json`, verified inside `container/install-tools.sh`
 * against the digests the deployment declared. The allowance is exactly that
 * step: `install-tools.sh` driven by the `VIBE_CONTAINER_TOOLS` build
 * argument, defaulting to empty so a default build installs nothing. An
 * unpinned download added anywhere else is still reported.
 *
 * @param containerfile - Raw Containerfile text.
 * @returns Human-readable violations; empty when every install is accounted
 *   for.
 */
function findInstallStepViolations(containerfile: string): string[] {
  const violations: string[] = [];

  const argLine = containerfile
    .split("\n")
    .map(codeOf)
    .find((line) => TOOLS_ARG_RE.test(line));
  const argDefault = argLine === undefined
    ? undefined
    : argValue(argLine)?.value ?? "";

  let runsTools = false;

  for (const run of runInstructions(containerfile)) {
    if (PIPE_TO_SHELL_RE.test(run)) {
      violations.push(`build step pipes a download into a shell: ${run}`);
    }

    if (run.includes(TOOLS_INSTALLER)) {
      runsTools = true;
      // The spec must come from the build argument: any other source would
      // install from content the deployment never validated.
      if (!run.includes(`\${${CONTAINER_TOOLS_ARG}}`)) {
        violations.push(
          `build step runs ${TOOLS_INSTALLER} on a spec that does not come ` +
            `from \${${CONTAINER_TOOLS_ARG}}: ${run}`,
        );
      }
    }

    // The allowed step delegates its downloads to install-tools.sh, which
    // verifies them; a fetch written into the step itself is not excused.
    if (FETCH_RE.test(run) && !CHECKSUM_RE.test(run)) {
      violations.push(
        `build step downloads without verifying a checksum: ${run}`,
      );
    }
  }

  if (argLine === undefined) {
    if (runsTools) {
      violations.push(
        `Containerfile runs ${TOOLS_INSTALLER} but does not declare ARG ` +
          `${CONTAINER_TOOLS_ARG}: the tool set would not be selectable at ` +
          "build time",
      );
    }
    return violations;
  }

  if (argDefault !== "") {
    violations.push(
      `ARG ${CONTAINER_TOOLS_ARG} must default to empty so a default build ` +
        `installs no extra tools (got "${argDefault}")`,
    );
  }

  if (!runsTools) {
    violations.push(
      `Containerfile declares ARG ${CONTAINER_TOOLS_ARG} but never runs ` +
        `${TOOLS_INSTALLER}: the selected tools would be silently ignored`,
    );
  }

  return violations;
}

/**
 * Report every place `container/Containerfile` disagrees with the manifest.
 *
 * Checks that each `FROM` resolves to a digest-pinned manifest image, that
 * every manifest version and checksum is restated verbatim as a build
 * `ARG`, that no package is installed without a version pin, that no build
 * step downloads without verifying a checksum (Issue #71), and that the
 * image's default `USER` and `WORKDIR` are the manifest's.
 *
 * @param containerfile - Raw Containerfile text.
 * @param manifest - The parsed manifest.
 * @returns Human-readable violations; empty when the definition agrees.
 */
export function findContainerfileViolations(
  containerfile: string,
  manifest: ContainerManifest,
): string[] {
  const violations: string[] = findInstallStepViolations(containerfile);
  const lines = containerfile.split("\n");

  const args = new Map<string, string>();
  const stages = new Set<string>();
  let user: string | undefined;
  let workdir: string | undefined;

  for (const rawLine of lines) {
    const line = codeOf(rawLine);
    if (line === "" || line.startsWith("#")) continue;

    const arg = argValue(line);
    if (arg) {
      args.set(arg.name, arg.value);
      continue;
    }

    const from = /^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) {
      const ref = from[1]!;
      const alias = from[2];
      const varRef = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(ref);
      const resolved = varRef ? args.get(varRef[1]!) ?? "" : ref;
      if (!stages.has(ref) && !DIGEST_RE.test(resolved.split("@")[1] ?? "")) {
        violations.push(
          `FROM ${ref}: image reference is not pinned to a sha256 digest` +
            (varRef ? ` (via ARG ${varRef[1]})` : ""),
        );
      }
      if (alias) stages.add(alias);
      continue;
    }

    const userMatch = /^USER\s+(\S+)/i.exec(line);
    if (userMatch) {
      user = userMatch[1];
      continue;
    }

    const workdirMatch = /^WORKDIR\s+(\S+)/i.exec(line);
    if (workdirMatch) {
      workdir = workdirMatch[1];
      continue;
    }

    for (const pkg of unpinnedPackages(line)) {
      violations.push(`unpinned package install: "${pkg}" in: ${line}`);
    }
  }

  for (const image of manifest.images) {
    const expected = `${image.name}:${image.tag}@${image.digest}`;
    const actual = args.get(image.arg);
    if (actual === undefined) {
      violations.push(`ARG ${image.arg} is missing (expected ${expected})`);
    } else if (actual !== expected) {
      violations.push(
        `ARG ${image.arg} is "${actual}" but the manifest pins ${expected}`,
      );
    }
  }

  // Toolchains pin exactly as tools do, so the same ARG checks apply.
  const pins: Array<
    Pick<ContainerToolPin, "version" | "versionArg" | "sha256">
  > = [...manifest.tools, ...manifest.toolchains];

  for (const tool of pins) {
    const actual = args.get(tool.versionArg);
    if (actual === undefined) {
      violations.push(
        `ARG ${tool.versionArg} is missing (expected ${tool.version})`,
      );
    } else if (actual !== tool.version) {
      violations.push(
        `ARG ${tool.versionArg} is "${actual}" but the manifest pins ${tool.version}`,
      );
    }

    for (const [arch, sha] of Object.entries(tool.sha256)) {
      const name = shaArgName(tool, arch);
      const value = args.get(name);
      if (value === undefined) {
        violations.push(`ARG ${name} is missing (expected ${sha})`);
      } else if (value !== sha) {
        violations.push(`ARG ${name} does not match the manifest sha256`);
      }
    }
  }

  if (user === undefined) {
    violations.push("no USER instruction: the image would default to root");
  } else if (user !== manifest.user.name) {
    violations.push(
      `USER is "${user}" but the manifest requires "${manifest.user.name}"`,
    );
  }

  if (workdir !== manifest.workdir) {
    violations.push(
      `WORKDIR is "${
        workdir ?? "unset"
      }" but the manifest requires "${manifest.workdir}"`,
    );
  }

  return violations;
}
