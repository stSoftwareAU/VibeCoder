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
 * Issue #4151 added the run-mode half of that contract and Issue #4 settled
 * it: container is the only run mode, the removed `native` / `seatbelt` modes
 * fail loud, and nothing ever falls back to the host. Those assertions read
 * their spelling from `lib/run_mode.ts`, so a renamed setting fails the docs
 * tests rather than leaving the pages stale.
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
  REMOVED_RUN_MODES,
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
// The run mode (Issues #4151, #4) — container, and only container
// ---------------------------------------------------------------------------

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
  // The removed modes are named as removed, so an operator carrying one in
  // an old config learns why it now fails (Issue #4).
  for (const removed of REMOVED_RUN_MODES) {
    assert(
      text.includes(removed),
      `CONFIGURATION.md must name the removed ${removed} mode as removed`,
    );
  }
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

// ---------------------------------------------------------------------------
// README.md / docs/OVERVIEW.md — appliance and control plane
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// docs/TROUBLESHOOTING.md — the container-era diagnosis path
// ---------------------------------------------------------------------------
