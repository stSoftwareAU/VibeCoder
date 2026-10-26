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
import {
  BUILTIN_EGRESS_RULES,
  IMGBB_EGRESS_RULES,
  PROVIDER_EGRESS_RULES,
} from "../lib/egress_allowlist.ts";
import { EGRESS_ALLOW_HOSTS_ENV } from "../commands/egress_proxy.ts";
import { formatEgressDenial } from "../lib/egress_proxy.ts";
import { EGRESS_MODE_LABELS } from "../lib/egress_controls.ts";
import {
  APPLE_EGRESS_MODE_ENV,
  APPLE_EGRESS_READY_INTERVAL_ENV,
  APPLE_EGRESS_READY_TRIES_ENV,
  APPLE_EGRESS_RECOVERY_ENV,
  APPLE_EGRESS_REPORT_FILE,
  APPLE_NETWORK_INTERNAL_FLAG,
} from "../lib/apple_egress.ts";
import {
  assertPins,
  flat,
  flatWholeFile,
  readRepoDoc,
  section as docSection,
} from "./support/markdown_docs.ts";

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
    // The build stamp the launch plan resolves from the checkout (Issue #1572).
    buildCommit: "0123456789abcdef0123456789abcdef01234567",
    watchdogSeconds: 11_400,
    planEpochSeconds: 1_700_000_000,
    hostPaths: {
      homeDir: "/home/operator",
      baseDir: "/opt/VibeCoder",
      workDir: "/home/operator/auto-issue-work",
      logDir: "/home/operator/logs",
      configFile: "/opt/VibeCoder/.config.json",
      configStageDir: "/home/operator/.vibe-coder/run-config",
      credentialDir: "/home/operator/.vibe-coder/credentials",
    },
    // One configured custom prompt (Issue #850), so the documented
    // `custom-prompts/<n>` row is checked against a plan that really carries
    // it. Unconfigured deployments get no such mount at all.
    customPromptPaths: ["/srv/vibe-prompts/private-label.md"],
  };
}

/**
 * The documented spelling of an in-container path.
 *
 * The active provider's credential sub-directory is written as `<provider>` in
 * the docs, because registering another provider changes it without changing
 * the boundary. A custom prompt directory is numbered per configured directory
 * and written as `<n>` for the same reason (Issue #850).
 */
function documentedTarget(target: string): string {
  const custom = target.match(/^(.*\/custom-prompts\/)\d+$/);
  if (custom) return `${custom[1]}<n>`;
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
// docs/CONTAINMENT.md — the egress allowlist (Issue #4045)
// ---------------------------------------------------------------------------

/** Hosts in the first column of the section's table rows: lines starting `| \`host\``. */
function documentedEgressHosts(body: string): Set<string> {
  const hosts = new Set<string>();
  for (const line of body.split("\n")) {
    const host = line.match(/^\| `([^`]+)`/)?.[1];
    if (host !== undefined) hosts.add(host);
  }
  return hosts;
}

Deno.test("CONTAINMENT.md's egress allowlist lists exactly the module's hosts", () => {
  const moduleHosts = new Set<string>([
    ...BUILTIN_EGRESS_RULES.map((rule) => rule.host),
    ...Object.values(PROVIDER_EGRESS_RULES).flat().map((rule) => rule.host),
    ...IMGBB_EGRESS_RULES.map((rule) => rule.host),
  ]);
  const docHosts = documentedEgressHosts(
    section(read("docs/CONTAINMENT.md"), "Egress allowlist"),
  );
  const missingFromDoc = [...moduleHosts].filter((host) => !docHosts.has(host))
    .sort();
  const missingFromModule = [...docHosts].filter((host) =>
    !moduleHosts.has(host)
  ).sort();
  assert(
    missingFromDoc.length === 0 && missingFromModule.length === 0,
    `egress allowlist drift — hosts missing from docs/CONTAINMENT.md: ` +
      `[${missingFromDoc.join(", ")}]; hosts missing from ` +
      `worker/deno/lib/egress_allowlist.ts: [${missingFromModule.join(", ")}]`,
  );
});

Deno.test("CONTAINMENT.md says the egress allowlist is not enforced for the container until #4047", () => {
  const body = section(read("docs/CONTAINMENT.md"), "Egress allowlist");
  assert(
    body.includes("nothing enforces it yet"),
    "the egress-allowlist section must say nothing enforces the list yet",
  );
  assert(
    body.includes("#4047"),
    "the egress-allowlist section must name #4047 as the issue that routes the container through the proxy",
  );
});

// ---------------------------------------------------------------------------
// docs/CONTAINMENT.md — the egress proxy (Issue #4046)
// ---------------------------------------------------------------------------

/** The egress proxy module the section names, as a repo-relative path. */
const EGRESS_PROXY_DOC_PATH = "worker/deno/lib/egress_proxy.ts";

/**
 * The denial marker the docs quote, taken from the module: everything before
 * the host in a denial line, which is `[EGRESS_DENIED] host=`.
 */
const EGRESS_DENIAL_MARKER = (() => {
  const sample = formatEgressDenial("docs.example", 443, "method");
  return sample.slice(0, sample.indexOf("docs.example"));
})();

Deno.test("CONTAINMENT.md documents the egress proxy as the one outbound proxy #3699 will extend", async () => {
  const body = docSection(
    await readRepoDoc("docs/CONTAINMENT.md"),
    "Egress proxy",
  );
  for (
    const phrase of [
      "#3699",
      "no second outbound proxy",
      EGRESS_DENIAL_MARKER,
      EGRESS_ALLOW_HOSTS_ENV,
      EGRESS_PROXY_DOC_PATH,
    ]
  ) {
    assert(
      body.includes(phrase),
      `the egress-proxy section must include "${phrase}"`,
    );
  }
});

Deno.test("CONTAINMENT.md's egress proxy section does not claim the container is routed through it yet", async () => {
  const body = docSection(
    await readRepoDoc("docs/CONTAINMENT.md"),
    "Egress proxy",
  );
  for (
    const phrase of ["#4047", "The container is not routed through it yet"]
  ) {
    assert(
      body.includes(phrase),
      `the egress-proxy section must say the container is not routed through the proxy until #4047 (missing "${phrase}")`,
    );
  }
});

Deno.test("CONTAINMENT.md's egress proxy section states the proxy opens no files, keeps no cache and needs --allow-read --allow-env --allow-net", async () => {
  const body = docSection(
    await readRepoDoc("docs/CONTAINMENT.md"),
    "Egress proxy",
  );
  for (
    const phrase of [
      "opens no files and keeps no cache",
      "--allow-read --allow-env --allow-net",
    ]
  ) {
    assert(
      body.includes(phrase),
      `the egress-proxy section must state "${phrase}" (missing from the section)`,
    );
  }
});

Deno.test("CONTAINMENT.md's egress proxy section names a module that exists", async () => {
  const body = docSection(
    await readRepoDoc("docs/CONTAINMENT.md"),
    "Egress proxy",
  );
  assert(
    body.includes(EGRESS_PROXY_DOC_PATH),
    `the egress-proxy section must name "${EGRESS_PROXY_DOC_PATH}"`,
  );
  const info = await Deno.stat(repoPath(EGRESS_PROXY_DOC_PATH));
  assert(info.isFile, `"${EGRESS_PROXY_DOC_PATH}" must be a file`);
});

Deno.test("CONTAINMENT.md describes #3699 as planned, not delivered", async () => {
  const body = docSection(
    await readRepoDoc("docs/CONTAINMENT.md"),
    "Egress proxy",
  );
  assertPins(body, [
    "#3699 will extend this proxy through this seam",
    "not yet delivered",
    "no second outbound proxy",
    "seam #3699's credential broker will attach to",
  ]);
  assert(
    !flat(body).includes("#3699 extends this proxy"),
    "the egress-proxy section must not present #3699 as having extended the proxy",
  );
});

Deno.test("CONTAINMENT.md's egress proxy section says which refusals get a 403 and how idle connections close", async () => {
  const body = docSection(
    await readRepoDoc("docs/CONTAINMENT.md"),
    "Egress proxy",
  );
  assertPins(body, [
    "Every refusal except `idle-timeout` is also answered with HTTP `403`",
    "An `idle-timeout` refusal closes the socket without a 403",
    "Idle before the upstream is dialled gets the `idle-timeout` line and no 403",
    "An idle established tunnel is closed on both ends with no log line",
    "A route that takes a client after `200` owns that connection, so this idle guard does not bound it",
    "the proxy dials nothing for a route",
  ]);
  const rows = tableRows(body).filter((cells) => cells[0] !== "Reason class");
  assert(rows.length > 0, "the egress-proxy section must carry a reason table");
  for (const cells of rows) {
    const expected = cells[0] === "`idle-timeout`"
      ? "no, the socket is closed"
      : "yes";
    assertEquals(
      cells[2],
      expected,
      `the 403 column for ${cells[0]} must read "${expected}"`,
    );
  }
});

// ---------------------------------------------------------------------------
// docs/CONTAINMENT.md — Apple container partial egress containment (Issue #4051)
// ---------------------------------------------------------------------------

/** The Apple section's heading, which the Apple pins below are scoped to. */
const APPLE_SECTION = "Apple container: partial egress containment";

Deno.test("CONTAINMENT.md's Apple section names the internal network flag and both mode labels (Issue #4051)", async () => {
  const body = docSection(
    await readRepoDoc("docs/CONTAINMENT.md"),
    APPLE_SECTION,
  );
  assertPins(body, [
    APPLE_NETWORK_INTERNAL_FLAG,
    EGRESS_MODE_LABELS["internal-network"],
    EGRESS_MODE_LABELS["advisory-proxy"],
  ]);
});

Deno.test("CONTAINMENT.md's Apple section names the report file and the four Apple egress variables (Issue #4051)", async () => {
  const body = docSection(
    await readRepoDoc("docs/CONTAINMENT.md"),
    APPLE_SECTION,
  );
  assertPins(body, [
    APPLE_EGRESS_REPORT_FILE,
    APPLE_EGRESS_MODE_ENV,
    APPLE_EGRESS_RECOVERY_ENV,
    APPLE_EGRESS_READY_TRIES_ENV,
    APPLE_EGRESS_READY_INTERVAL_ENV,
  ]);
});

Deno.test("CONTAINMENT.md's Apple section says the behaviour is not yet observed on a real host (Issue #4051)", async () => {
  const body = docSection(
    await readRepoDoc("docs/CONTAINMENT.md"),
    APPLE_SECTION,
  );
  assertPins(body, [
    "measured at each launch, not yet observed by the author on a real host",
  ]);
});

Deno.test("CONTAINMENT.md never calls containment default-deny or fully enforced (Issue #4051)", async () => {
  const text = flatWholeFile(await readRepoDoc("docs/CONTAINMENT.md"))
    .toLowerCase();
  for (const phrase of ["default-deny", "default deny", "fully enforced"]) {
    assert(
      !text.includes(phrase),
      `docs/CONTAINMENT.md must not describe containment as "${phrase}"; the Apple claim is partial containment`,
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
