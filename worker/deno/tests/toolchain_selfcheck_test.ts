/**
 * Tests for the container start-up toolchain self-check (Issue #1956).
 *
 * Every case drives the real {@link checkContainerToolchains} over a real
 * manifest and asserts on the verdict it returns — the probes themselves are
 * either genuine subprocesses (the end-to-end cases, which run stub commands
 * from a temporary directory) or an injected runner, never a source-text
 * inspection.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  checkContainerToolchains,
  TOOLCHAIN_SELFCHECK_EXIT_STATUS,
  TOOLCHAIN_SELFCHECK_FAILURE_MARKER,
  type ToolchainProbe,
  toolchainProbes,
} from "../lib/toolchain_selfcheck.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import { CONTAINER_IMAGE_STAMP_ENV } from "../lib/container_stamp.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** An environment that reports the worker is running inside the image. */
const IN_IMAGE = (name: string): string | undefined =>
  name === CONTAINER_IMAGE_STAMP_ENV ? "claude" : undefined;

/** An environment with no image stamp — a developer's own host. */
const ON_HOST = (_name: string): string | undefined => undefined;

/**
 * The committed manifest with its toolchain list replaced.
 *
 * Built from the real file rather than a hand-written stub so every fixture
 * goes through the same strict parser production does — a fixture the parser
 * would reject can never make this suite pass.
 */
const COMMITTED_MANIFEST = JSON.parse(
  await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
) as Record<string, unknown>;

/** A manifest carrying exactly the toolchains described. */
function manifestText(
  toolchains: Array<Record<string, unknown>>,
): string {
  return JSON.stringify({ ...COMMITTED_MANIFEST, toolchains });
}

/** Per-architecture digests a fixture entry carries — never fetched. */
const FIXTURE_SHA256 = {
  amd64: "a".repeat(64),
  arm64: "b".repeat(64),
};

/** A command toolchain entry the manifest parser accepts. */
function commandToolchain(
  id: string,
  version: string,
  command = id,
): Record<string, unknown> {
  return {
    id,
    version,
    versionArg: `${id.toUpperCase().replace(/-/g, "_")}_VERSION`,
    commands: [command],
    versionCommand: command,
    source: `https://example.invalid/${id}`,
    repos: ["stSoftwareAU/VibeCoder"],
    sha256: FIXTURE_SHA256,
  };
}

/** A library toolchain entry — a Python module, not a command. */
function moduleToolchain(
  id: string,
  version: string,
  module: string,
): Record<string, unknown> {
  return {
    id,
    version,
    versionArg: `${id.toUpperCase().replace(/-/g, "_")}_VERSION`,
    modules: [module],
    versionModule: module,
    source: `https://example.invalid/${id}`,
    repos: ["stSoftwareAU/VibeCoder"],
    sha256: FIXTURE_SHA256,
  };
}

/** Run the check over an inline manifest with an injected probe runner. */
function check(
  toolchains: Array<Record<string, unknown>>,
  runProbe: (probe: ToolchainProbe) => Promise<
    { code: number; stdout: string; stderr: string; timedOut?: boolean }
  >,
  env = IN_IMAGE,
) {
  return checkContainerToolchains({
    repoRoot: "/nowhere",
    env,
    readManifest: () => Promise.resolve(manifestText(toolchains)),
    runProbe,
  });
}

// ---------------------------------------------------------------------------
// Probe derivation — the probe list comes from the manifest, never a copy
// ---------------------------------------------------------------------------

Deno.test("toolchainProbes - the committed manifest yields one probe per toolchain", async () => {
  const manifest = parseContainerManifest(
    await Deno.readTextFile(`${REPO_ROOT}/container/tools.json`),
  );
  const probes = toolchainProbes(manifest);

  assert(probes.length > 0, "the committed manifest must pin toolchains");
  for (const toolchain of manifest.toolchains) {
    assert(
      probes.some((probe) => probe.id === toolchain.id),
      `${toolchain.id} is pinned but never probed`,
    );
  }
  for (const probe of probes) {
    assert(
      probe.argv.length > 0,
      `${probe.id} yielded no probe argv — the self-check would skip it`,
    );
    assert(probe.version !== "", `${probe.id} yielded no pinned version`);
  }

  // The two shapes the manifest carries, by the toolchains that carry them.
  const actionlint = probes.find((probe) => probe.id === "actionlint");
  assert(actionlint, "actionlint must be probed");
  assertEquals(actionlint.kind, "command");
  assertEquals(actionlint.argv, ["actionlint", "--version"]);

  const pyyaml = probes.find((probe) => probe.id === "pyyaml");
  assert(pyyaml, "pyyaml must be probed");
  assertEquals(pyyaml.kind, "module");
  assertEquals(pyyaml.argv[0], "python3");
  assertStringIncludes(pyyaml.argv.join(" "), "import yaml");
});

Deno.test("toolchainProbes - a toolchain declaring both surfaces is probed through both", () => {
  // The manifest allows an entry to supply commands AND importable modules.
  // Probing only the first would leave the PyYAML fault this check exists for
  // unverified on exactly such an entry.
  const manifest = parseContainerManifest(manifestText([{
    id: "both",
    version: "2.0.0",
    versionArg: "BOTH_VERSION",
    commands: ["both"],
    versionCommand: "both",
    modules: ["both_mod"],
    versionModule: "both_mod",
    source: "https://example.invalid/both",
    repos: ["stSoftwareAU/VibeCoder"],
    sha256: FIXTURE_SHA256,
  }]));

  const probes = toolchainProbes(manifest);
  assertEquals(probes.length, 2);
  assertEquals(probes.map((probe) => probe.kind), ["command", "module"]);
});

Deno.test("checkContainerToolchains - a pin that is a prefix of the installed version fails", () => {
  // `1.7.1` appears inside `1.7.12`, so a plain substring test would report
  // the one version mismatch this check exists to catch as healthy.
  return check(
    [commandToolchain("actionlint", "1.7.1")],
    () => Promise.resolve({ code: 0, stdout: "1.7.12\n", stderr: "" }),
  ).then((verdict) => {
    assertEquals(verdict.ok, false);
    assertEquals(verdict.failed, ["actionlint"]);
  });
});

Deno.test("checkContainerToolchains - the pinned version is matched as a whole token", async () => {
  // …and the same rule must not reject a version that really is reported,
  // whatever punctuation surrounds it.
  const verdict = await check(
    [commandToolchain("gitleaks", "8.30.1")],
    () =>
      Promise.resolve({
        code: 0,
        stdout: "gitleaks version 8.30.1\n",
        stderr: "",
      }),
  );
  assertEquals(verdict.ok, true);
});

Deno.test("checkContainerToolchains - a manifest with no toolchains key blames the manifest, not the image", async () => {
  // The parser rejects `"toolchains": []` but takes an ABSENT key as none, so
  // this is the shape that would otherwise report "0 toolchains verified" as
  // a pass.
  const { toolchains: _dropped, ...withoutToolchains } = COMMITTED_MANIFEST;
  const verdict = await checkContainerToolchains({
    repoRoot: "/nowhere",
    env: IN_IMAGE,
    readManifest: () => Promise.resolve(JSON.stringify(withoutToolchains)),
    runProbe: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
  });

  assertEquals(verdict.ok, false);
  assertEquals(verdict.fault, "manifest");
  // No marker: the launchers rebuild on the failing ids, and a rebuilt image
  // would meet exactly the same manifest.
  assertEquals(verdict.marker, undefined);
  assertStringIncludes(verdict.reason ?? "", "pins no toolchain");
});

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

Deno.test("checkContainerToolchains - a healthy image passes and names every toolchain", async () => {
  const verdict = await check(
    [
      commandToolchain("actionlint", "1.7.12"),
      moduleToolchain("pyyaml", "6.0.3", "yaml"),
    ],
    (probe) =>
      Promise.resolve(
        probe.kind === "command"
          ? { code: 0, stdout: `${probe.id} ${probe.version}\n`, stderr: "" }
          : { code: 0, stdout: `${probe.version}\n`, stderr: "" },
      ),
  );

  assertEquals(verdict.ok, true);
  assertEquals(verdict.failed, []);
  assertEquals(verdict.results.length, 2);
  assertStringIncludes(verdict.lines.join("\n"), "ok actionlint 1.7.12");
  assertStringIncludes(verdict.lines.join("\n"), "ok pyyaml 6.0.3");
});

Deno.test("checkContainerToolchains - a binary that cannot execute fails, naming it", async () => {
  const verdict = await check(
    [
      commandToolchain("actionlint", "1.7.12"),
      commandToolchain("shellcheck", "0.11.0"),
    ],
    (probe) =>
      Promise.resolve(
        probe.id === "actionlint"
          ? {
            code: 126,
            stdout: "",
            stderr: "cannot execute binary file: Exec format error",
          }
          : { code: 0, stdout: "version: 0.11.0\n", stderr: "" },
      ),
  );

  assertEquals(verdict.ok, false);
  assertEquals(verdict.fault, "image");
  assertEquals(verdict.failed, ["actionlint"]);
  assertStringIncludes(verdict.reason ?? "", "actionlint");
  assertStringIncludes(
    verdict.lines.join("\n"),
    "Exec format error",
  );
  // The healthy toolchain is still reported, so the log is a full account.
  assertStringIncludes(verdict.lines.join("\n"), "ok shellcheck 0.11.0");
});

Deno.test("checkContainerToolchains - a module python3 cannot import fails, naming it", async () => {
  const verdict = await check(
    [moduleToolchain("pyyaml", "6.0.3", "yaml")],
    () =>
      Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "ModuleNotFoundError: No module named 'yaml'",
      }),
  );

  assertEquals(verdict.ok, false);
  assertEquals(verdict.failed, ["pyyaml"]);
  assertStringIncludes(verdict.reason ?? "", "pyyaml");
});

Deno.test("checkContainerToolchains - a toolchain reporting the wrong version fails", async () => {
  const verdict = await check(
    [commandToolchain("bats-core", "1.14.0", "bats")],
    () => Promise.resolve({ code: 0, stdout: "Bats 1.11.0\n", stderr: "" }),
  );

  assertEquals(verdict.ok, false);
  assertEquals(verdict.failed, ["bats-core"]);
  assertStringIncludes(verdict.lines.join("\n"), "1.11.0");
});

Deno.test("checkContainerToolchains - a module reporting the wrong version fails", async () => {
  const verdict = await check(
    [moduleToolchain("pyyaml", "6.0.3", "yaml")],
    () => Promise.resolve({ code: 0, stdout: "5.4.1\n", stderr: "" }),
  );

  assertEquals(verdict.ok, false);
  assertEquals(verdict.failed, ["pyyaml"]);
});

Deno.test("checkContainerToolchains - a probe that times out fails rather than hanging the run", async () => {
  const verdict = await check(
    [commandToolchain("pwsh", "7.6.5")],
    () =>
      Promise.resolve({ code: 124, stdout: "", stderr: "", timedOut: true }),
  );

  assertEquals(verdict.ok, false);
  assertEquals(verdict.failed, ["pwsh"]);
  assertStringIncludes(verdict.lines.join("\n"), "timed out");
});

Deno.test("checkContainerToolchains - the version match is on the whole output, not an exact line", async () => {
  // shellcheck prints a banner first and the version on a later line.
  const verdict = await check(
    [commandToolchain("shellcheck", "0.11.0")],
    () =>
      Promise.resolve({
        code: 0,
        stdout:
          "ShellCheck - shell script analysis tool\nversion: 0.11.0\nlicense: GPLv3\n",
        stderr: "",
      }),
  );

  assertEquals(verdict.ok, true);
});

Deno.test("checkContainerToolchains - every failing toolchain is named, not just the first", async () => {
  const verdict = await check(
    [
      commandToolchain("actionlint", "1.7.12"),
      commandToolchain("gitleaks", "8.30.1"),
      moduleToolchain("pyyaml", "6.0.3", "yaml"),
    ],
    (probe) =>
      Promise.resolve(
        probe.id === "gitleaks"
          ? { code: 0, stdout: "gitleaks version 8.30.1\n", stderr: "" }
          : { code: 127, stdout: "", stderr: "not found" },
      ),
  );

  assertEquals(verdict.ok, false);
  assertEquals(verdict.failed, ["actionlint", "pyyaml"]);
  assertStringIncludes(
    verdict.marker ?? "",
    `${TOOLCHAIN_SELFCHECK_FAILURE_MARKER} actionlint pyyaml`,
  );
});

// ---------------------------------------------------------------------------
// Boundaries — what the check refuses to judge
// ---------------------------------------------------------------------------

Deno.test("checkContainerToolchains - outside the image there is no image to verify", async () => {
  let probed = 0;
  const verdict = await check(
    [commandToolchain("actionlint", "1.7.12")],
    () => {
      probed += 1;
      return Promise.resolve({ code: 127, stdout: "", stderr: "not found" });
    },
    ON_HOST,
  );

  assertEquals(verdict.ok, true);
  assertEquals(probed, 0, "a host run must not probe the image's toolchains");
  assert(verdict.skipped, "the verdict must say why nothing was probed");
});

Deno.test("checkContainerToolchains - an unreadable manifest fails loud rather than passing", async () => {
  const verdict = await checkContainerToolchains({
    repoRoot: "/nowhere",
    env: IN_IMAGE,
    readManifest: () => Promise.reject(new Error("no such file")),
    runProbe: () => Promise.resolve({ code: 0, stdout: "", stderr: "" }),
  });

  assertEquals(verdict.ok, false);
  assertEquals(verdict.fault, "manifest");
  assertStringIncludes(verdict.reason ?? "", "no such file");
});

Deno.test("checkContainerToolchains - a manifest pinning no toolchain fails loud", async () => {
  let probed = 0;
  const verdict = await check([], () => {
    probed += 1;
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  });

  assertEquals(verdict.ok, false);
  assertEquals(probed, 0);
  // The manifest parser is the one that refuses it — a manifest that pins
  // nothing is not a manifest this check quietly passes.
  assertStringIncludes(
    verdict.reason ?? "",
    "toolchains must list at least one entry",
  );
  assertEquals(verdict.fault, "manifest");
});

// ---------------------------------------------------------------------------
// End to end — real subprocesses, no injected runner
// ---------------------------------------------------------------------------

/** Write an executable stub command into `dir`. */
async function stubCommand(
  dir: string,
  name: string,
  body: string,
): Promise<void> {
  const path = `${dir}/${name}`;
  await Deno.writeTextFile(path, `#!/bin/bash\n${body}\n`);
  await Deno.chmod(path, 0o755);
}

Deno.test("checkContainerToolchains - runs the real probes against real commands", async () => {
  const dir = await Deno.makeTempDir({ prefix: "toolchain-selfcheck-" });
  try {
    await stubCommand(dir, "vibe-good", 'echo "vibe-good 9.9.9"');
    await stubCommand(dir, "vibe-bad", 'echo "vibe-bad 1.0.0"');

    const env = (name: string): string | undefined => {
      if (name === CONTAINER_IMAGE_STAMP_ENV) return "claude";
      if (name === "PATH") return `${dir}:${Deno.env.get("PATH") ?? ""}`;
      return undefined;
    };

    const verdict = await checkContainerToolchains({
      repoRoot: "/nowhere",
      env,
      readManifest: () =>
        Promise.resolve(manifestText([
          commandToolchain("vibe-good", "9.9.9"),
          commandToolchain("vibe-bad", "9.9.9"),
        ])),
      probeEnv: { PATH: `${dir}:${Deno.env.get("PATH") ?? ""}` },
    });

    assertEquals(verdict.ok, false);
    assertEquals(verdict.failed, ["vibe-bad"]);
    assertStringIncludes(verdict.lines.join("\n"), "ok vibe-good 9.9.9");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("checkContainerToolchains - a missing command is a failure, not a skip", async () => {
  const verdict = await checkContainerToolchains({
    repoRoot: "/nowhere",
    env: IN_IMAGE,
    readManifest: () =>
      Promise.resolve(
        manifestText([commandToolchain("vibe-absent", "1.0.0")]),
      ),
  });

  assertEquals(verdict.ok, false);
  assertEquals(verdict.failed, ["vibe-absent"]);
});

Deno.test("TOOLCHAIN_SELFCHECK_EXIT_STATUS - is outside the runtime CLI's own range", () => {
  assertEquals(TOOLCHAIN_SELFCHECK_EXIT_STATUS, 89);
  assert(
    ![0, 1, 76, 87, 88, 125, 126, 127].includes(
      TOOLCHAIN_SELFCHECK_EXIT_STATUS,
    ),
    "the self-check status must not collide with a status already in use",
  );
});
