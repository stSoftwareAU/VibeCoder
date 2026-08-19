/**
 * Tests for Issue #4073 — the operator documentation must describe the host as
 * an unattended containerised appliance whose normal remote control plane is
 * GitHub.
 *
 * The interesting assertions are tied back to the code that owns the boundary
 * rather than to hand-written prose: the mount table in `docs/CONTAINMENT.md`
 * is compared against the mounts `buildContainerLaunchPlan()` really produces,
 * the network claims are checked against the plan's own run arguments, and the
 * per-platform runtime requirement in `docs/DEPLOYMENT.md` is compared against
 * `candidatesForPlatform()`. A launcher change that broadens the boundary
 * therefore fails the documentation tests too.
 *
 * Issue #4151 adds the run-mode half of that contract: container is the
 * default, native is an explicit opt-in, and nothing auto-falls back between
 * them. Those assertions read their spelling from `lib/run_mode.ts`, so a
 * renamed setting fails the docs tests rather than leaving the pages stale.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildContainerLaunchPlan,
  type ContainerLaunchInputs,
} from "../lib/container_launch.ts";
import {
  candidatesForPlatform,
  CONTAINER_RUNTIMES,
  type ContainerRuntimeDescriptor,
  type ContainerRuntimeKind,
  type HostPlatform,
} from "../lib/container_runtime.ts";
import {
  type ContainerManifest,
  parseContainerManifest,
} from "../lib/container_manifest.ts";
import { activeAgentProvider } from "../lib/agent_provider.ts";
import {
  DEFAULT_RUN_MODE,
  RUN_MODE_CONFIG_KEY,
  RUN_MODE_ENV,
  RUN_MODES,
} from "../lib/run_mode.ts";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

function read(relative: string): string {
  return Deno.readTextFileSync(repoPath(relative));
}

const MANIFEST: ContainerManifest = parseContainerManifest(
  read("container/tools.json"),
);

function descriptorFor(kind: ContainerRuntimeKind): ContainerRuntimeDescriptor {
  const candidate = CONTAINER_RUNTIMES[kind];
  return {
    platform: kind === "apple-container" ? "darwin" : "linux",
    kind,
    executable: candidate.executable,
    displayName: candidate.displayName,
    dialect: candidate.dialect,
    probed: [kind],
  };
}

function launchInputs(): ContainerLaunchInputs {
  return {
    descriptor: descriptorFor("docker"),
    manifest: MANIFEST,
    image: "vibe-coder:0123456789ab",
    containerName: "vibe-coder-4073",
    watchdogSeconds: 11_400,
    hostPaths: {
      homeDir: "/home/operator",
      baseDir: "/opt/VibeCoder",
      workDir: "/home/operator/auto-issue-work",
      logDir: "/home/operator/logs",
      configFile: "/opt/VibeCoder/.config.json",
      configStageDir: "/home/operator/.vibe-coder/run-config",
      credentialDir: "/home/operator/.vibe-coder/credentials",
    },
  };
}

/**
 * The documented spelling of an in-container path.
 *
 * The active provider's credential sub-directory is written as `<provider>` in
 * the docs, because registering another provider changes it without changing
 * the boundary.
 */
function documentedTarget(target: string): string {
  const subdir = activeAgentProvider().credentials.subdir;
  return target.endsWith(`/${subdir}`)
    ? `${target.slice(0, -subdir.length)}<provider>`
    : target;
}

/** Section body between a heading containing `title` and the next heading of the same (or higher) level. */
function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) =>
    /^#{2,}\s/.test(line) && line.includes(title)
  );
  assert(start >= 0, `expected a section titled "${title}"`);
  const level = (lines[start]?.match(/^#+/)?.[0] ?? "##").length;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => {
    const hashes = line.match(/^#+(?=\s)/)?.[0];
    return hashes !== undefined && hashes.length <= level;
  });
  return (end >= 0 ? rest.slice(0, end) : rest).join("\n");
}

/** Rows of the first markdown table in `body`, as trimmed cell arrays. */
function tableRows(body: string): string[][] {
  return body
    .split("\n")
    .filter((line) => line.trimStart().startsWith("|"))
    .filter((line) => !/^\s*\|[\s|:-]+\|\s*$/.test(line))
    .map((line) =>
      line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) =>
        cell.trim()
      )
    );
}

// ---------------------------------------------------------------------------
// The two run modes (Issue #4151) — container by default, native by opt-in
// ---------------------------------------------------------------------------

/** Operator-facing pages that must carry the two-mode story. */
const RUN_MODE_SURFACES = [
  "README.md",
  "docs/CONTAINER.md",
  "docs/CONTAINMENT.md",
  "docs/CONFIGURATION.md",
  "docs/DEPLOYMENT.md",
  "docs/TROUBLESHOOTING.md",
];

/**
 * Accepted spellings of the no-auto-fallback rule.
 *
 * The rule itself is the invariant `lib/run_mode.ts` enforces: nothing may
 * select `native` because a container runtime is absent. The pages are free to
 * word it, but they may not omit it.
 */
const NO_AUTO_FALLBACK =
  /never (?:silently )?(?:selects?|switch(?:es)?(?: to)?|falls back)|no auto-fallback|not a fallback|never a fallback/i;

/**
 * The default stated near the mode that carries it — "container by default",
 * "the default `container` run mode", "container (the default)" and so on.
 */
const DEFAULT_STATED = new RegExp(
  `(default[^.\\n]{0,40}\\b${DEFAULT_RUN_MODE}\\b|\\b${DEFAULT_RUN_MODE}\\b[^.\\n]{0,40}default)`,
  "i",
);

/**
 * Claims the milestone's earlier container-only wording made, which #4145
 * falsified. Any page reintroducing one of these fails.
 */
const RETIRED_CLAIMS = [
  "and nowhere else",
  "no native fallback",
  "no native execution path",
  "no host fallback to run instead",
];

/** Every markdown file under `docs/`, excluding the immutable PR archive. */
function liveDocs(directory = "docs"): string[] {
  const found: string[] = [];
  for (const entry of Deno.readDirSync(repoPath(directory))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory) {
      if (path === "docs/archive") continue; // historical records, not claims
      found.push(...liveDocs(path));
    } else if (entry.name.endsWith(".md")) {
      found.push(path);
    }
  }
  return found;
}

Deno.test("no live document claims the worker runs in a container and nowhere else", () => {
  const offenders: string[] = [];
  for (const surface of ["README.md", ...liveDocs()]) {
    const text = read(surface).toLowerCase();
    for (const claim of RETIRED_CLAIMS) {
      if (text.includes(claim)) offenders.push(`${surface}: "${claim}"`);
    }
  }
  assertEquals(
    offenders,
    [],
    "native is a supported run mode (Issue #4145), so no page may deny it",
  );
});

for (const surface of RUN_MODE_SURFACES) {
  Deno.test(`${surface} tells the two-mode story`, () => {
    const text = read(surface).toLowerCase();
    for (const mode of RUN_MODES) {
      assert(text.includes(mode), `${surface} must name the ${mode} run mode`);
    }
    assert(
      DEFAULT_STATED.test(text),
      `${surface} must state that ${DEFAULT_RUN_MODE} is the default`,
    );
    assert(
      text.includes(RUN_MODE_CONFIG_KEY) ||
        text.includes(RUN_MODE_ENV.toLowerCase()),
      `${surface} must name the setting that opts a host into native`,
    );
    assert(
      NO_AUTO_FALLBACK.test(text),
      `${surface} must state that a missing runtime never selects native`,
    );
  });
}

Deno.test("CONFIGURATION.md documents the run-mode setting as the code spells it", () => {
  const text = read("docs/CONFIGURATION.md");
  for (
    const token of [
      RUN_MODE_CONFIG_KEY,
      RUN_MODE_ENV,
      DEFAULT_RUN_MODE,
      ...RUN_MODES,
    ]
  ) {
    assert(
      text.includes(token),
      `CONFIGURATION.md must document ${token}`,
    );
  }
});

Deno.test("CONTAINMENT.md places native mode outside the boundary", () => {
  const text = read("docs/CONTAINMENT.md").toLowerCase();
  assert(
    /native mode.*(outside|not covered by|no containment)|(outside|beyond) (the |this )?(#4060 )?containment boundary/s
      .test(text),
    "CONTAINMENT.md must say native mode is outside the containment boundary",
  );
  assert(
    text.includes("host access"),
    "CONTAINMENT.md must state that native mode runs with host access",
  );
});

// ---------------------------------------------------------------------------
// docs/CONTAINMENT.md — the mount set
// ---------------------------------------------------------------------------

/** Documented in-container path → mode, from the CONTAINMENT.md mount table. */
function documentedMounts(): Map<string, string> {
  const body = section(read("docs/CONTAINMENT.md"), "mount set");
  const mounts = new Map<string, string>();
  for (const cells of tableRows(body)) {
    const target = cells[1]?.match(/^`([^`]+)`$/)?.[1];
    const mode = cells[2]?.match(/^`?(rw|ro)`?$/)?.[1];
    if (target && mode) mounts.set(target, mode);
  }
  return mounts;
}

Deno.test("CONTAINMENT.md documents exactly the mounts the launcher creates", () => {
  const plan = buildContainerLaunchPlan(launchInputs());
  const expected = new Map(
    plan.mounts.map((
      mount,
    ) => [documentedTarget(mount.target), mount.readOnly ? "ro" : "rw"]),
  );

  assertEquals(
    [...documentedMounts()].sort(),
    [...expected].sort(),
    "docs/CONTAINMENT.md's mount table must match buildContainerLaunchPlan()",
  );
});

Deno.test("CONTAINMENT.md names the host resources kept outside the boundary", () => {
  const text = read("docs/CONTAINMENT.md");
  // The resources the containment integration tests (Issue #4071) prove
  // unreachable from inside the container.
  const excluded = [
    "the host home directory",
    "~/Documents",
    "~/Desktop",
    "~/Pictures",
    "~/.ssh",
    "~/Library",
    "Keychain",
    "/var/run/docker.sock",
    "/run/podman/podman.sock",
  ];
  const missing = excluded.filter((item) => !text.includes(item));
  assertEquals(missing, [], "CONTAINMENT.md must name every excluded resource");
});

Deno.test("CONTAINMENT.md's network boundary matches the launch plan", () => {
  const plan = buildContainerLaunchPlan(launchInputs());
  // The claims the document makes, verified against the real arguments.
  const publishes = plan.runArgs.some((arg) =>
    arg === "-p" || arg === "--publish" || arg.startsWith("--publish=")
  );
  assert(!publishes, "the plan must publish no ports");
  assert(
    !plan.runArgs.some((arg) => arg.toLowerCase().endsWith("host")),
    "the plan must never request host networking",
  );

  const body = section(read("docs/CONTAINMENT.md"), "network boundary");
  for (const claim of ["outbound", "no inbound", "host networking"]) {
    assert(
      body.toLowerCase().includes(claim),
      `the network-boundary section must cover "${claim}"`,
    );
  }
});

Deno.test("CONTAINMENT.md documents the disposable container root filesystem", () => {
  const text = read("docs/CONTAINMENT.md").toLowerCase();
  assert(text.includes("disposable"), "must describe disposable state");
  assert(text.includes("--rm"), "must state the container is removed on exit");
  assert(text.includes("tmpfs"), "must state /tmp is a tmpfs");
});

// ---------------------------------------------------------------------------
// docs/DEPLOYMENT.md — host requirements
// ---------------------------------------------------------------------------

Deno.test("DEPLOYMENT.md requires the container runtime each platform probes", () => {
  const body = section(read("docs/DEPLOYMENT.md"), "Requirements");
  const platforms: HostPlatform[] = ["darwin", "linux", "windows"];
  for (const platform of platforms) {
    for (const candidate of candidatesForPlatform(platform)) {
      assert(
        body.includes(candidate.displayName),
        `the Requirements section must name ${candidate.displayName} ` +
          `(probed on ${platform})`,
      );
    }
  }
});

Deno.test("DEPLOYMENT.md no longer requires the worker's tools on the host", () => {
  // Only the section's list items and table rows state a requirement; prose
  // may (and does) name these tools to say they ship in the image instead.
  const required = section(read("docs/DEPLOYMENT.md"), "Requirements")
    .split("\n")
    .filter((line) => /^\s*([-*]\s|\|)/.test(line))
    .join("\n");
  // These ship inside the image (Issue #4061 onwards); requiring them on the
  // host is exactly the leakage containment exists to end.
  const containerOwned = [
    "`gh`",
    "`jq`",
    "`claude`",
    "`timeout`",
    "`gtimeout`",
  ];
  const stillRequired = containerOwned.filter((tool) =>
    required.includes(tool)
  );
  assertEquals(
    stillRequired,
    [],
    "the Requirements section must not list container-owned tools",
  );
});

Deno.test("DEPLOYMENT.md states the hard-cutover rollout requirement", () => {
  const text = read("docs/DEPLOYMENT.md").toLowerCase();
  assert(
    text.includes("hard cutover"),
    "an operator upgrading an existing host must see the hard cutover",
  );
  // Issue #4151: the cutover is into the *default* mode, not the only one. An
  // operator reading the rollout note must see both modes and the rule that
  // links them — a missing runtime never selects native for them.
  for (const mode of RUN_MODES) {
    assert(
      text.includes(mode),
      `the rollout note must name the ${mode} run mode`,
    );
  }
  assert(
    text.includes(RUN_MODE_CONFIG_KEY) || text.includes(
      RUN_MODE_ENV.toLowerCase(),
    ),
    "the rollout note must name the setting that selects the run mode",
  );
  assert(
    NO_AUTO_FALLBACK.test(text),
    "the rollout note must state that container mode never auto-selects native",
  );
});

Deno.test("DEPLOYMENT.md's screenshot section stops installing a host browser", () => {
  const body = section(read("docs/DEPLOYMENT.md"), "Screenshot Support");
  assert(
    body.includes("CONTAINER.md") || body.includes("CONTAINMENT.md"),
    "the screenshot section must point at the container documentation",
  );
  assert(
    !/sudo apt-get install/.test(body),
    "the screenshot section must not tell operators to install browser " +
      "libraries on the host",
  );
});

// ---------------------------------------------------------------------------
// README.md / docs/OVERVIEW.md — appliance and control plane
// ---------------------------------------------------------------------------

const CONTROL_PLANE_SURFACES = ["README.md", "docs/OVERVIEW.md"];

for (const surface of CONTROL_PLANE_SURFACES) {
  Deno.test(`${surface} describes the host as an unattended appliance`, () => {
    const text = read(surface).toLowerCase();
    assert(
      text.includes("appliance"),
      `${surface} must call the host an appliance`,
    );
    assert(
      text.includes("control plane"),
      `${surface} must name GitHub as the control plane`,
    );
    for (
      const excluded of ["ssh", "remote desktop", "screen sharing", "terminal"]
    ) {
      assert(
        text.includes(excluded),
        `${surface} must state ${excluded} is not required for normal operation`,
      );
    }
  });

  Deno.test(`${surface} states the clone → configure → run deployment story`, () => {
    const text = read(surface);
    assert(text.includes("run.sh"), `${surface} must name ./run.sh`);
    assert(text.includes("run.ps1"), `${surface} must name run.ps1`);
    assert(
      /git clone|repo clone/.test(text),
      `${surface} must start the story at cloning the repository`,
    );
  });
}

Deno.test("README's Documentation table links docs/CONTAINMENT.md", () => {
  const lines = read("README.md").split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("## 📖 Documentation")
  );
  assert(start >= 0, "README must have a '📖 Documentation' section");
  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("|")) rows.push(line);
  }
  const row = rows.find((line) => line.includes("(docs/CONTAINMENT.md)"));
  assert(row, "no Documentation-table row links docs/CONTAINMENT.md");
  assert(
    row.split("|").map((cell) => cell.trim()).filter((cell) => cell !== "")
      .length >= 2,
    "the CONTAINMENT.md row needs a description cell",
  );
});

// ---------------------------------------------------------------------------
// docs/TROUBLESHOOTING.md — the container-era diagnosis path
// ---------------------------------------------------------------------------

Deno.test("TROUBLESHOOTING.md covers the container diagnosis path", () => {
  const text = read("docs/TROUBLESHOOTING.md");
  for (
    const marker of [
      "container-image-hash", // reading the image reference
      "container-runtime-detect", // runtime-detection failure
      "~/logs", // where logs land on the host
    ]
  ) {
    assert(text.includes(marker), `TROUBLESHOOTING.md must mention ${marker}`);
  }
  assert(
    /rebuild/i.test(text),
    "TROUBLESHOOTING.md must explain how to force an image rebuild",
  );
});
