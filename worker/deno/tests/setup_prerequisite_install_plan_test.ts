/**
 * Tests for setup/prerequisite_install_plan.ts
 *
 * Issue #4134: Model prerequisite installs as data — a per-platform
 * install-plan table.
 *
 * Issue #4185: Windows plans via winget, so a Windows host can be onboarded
 * without WSL.
 *
 * Every case injects `packageManagerAvailable`, so the suite never touches a
 * real `brew`, `apt-get` or `winget` and runs identically on a host with none
 * of them.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type InstallPlan,
  PLAN_TOOLS,
  resolveInstallPlan,
} from "../setup/prerequisite_install_plan.ts";
import type { HostPlatform } from "../lib/container_runtime.ts";

/** Availability probe that reports every package manager as present. */
const allAvailable = () => Promise.resolve(true);
/** Availability probe that reports every package manager as missing. */
const noneAvailable = () => Promise.resolve(false);

/** The argv a winget plan step is expected to carry for one package id. */
function winget(id: string): string[] {
  return [
    "winget",
    "install",
    "--exact",
    "--id",
    id,
    "--source",
    "winget",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--silent",
  ];
}

/** Expected `command` argv per tool and platform; `null` = not installable. */
const EXPECTED: Record<string, Record<HostPlatform, string[][] | null>> = {
  jq: {
    darwin: [["brew", "install", "jq"]],
    linux: [["sudo", "apt-get", "install", "-y", "jq"]],
    windows: [winget("jqlang.jq")],
  },
  timeout: {
    darwin: [["brew", "install", "coreutils"]],
    linux: [["sudo", "apt-get", "install", "-y", "coreutils"]],
    // No GNU coreutils package on winget, and Windows is container-only
    // (Issue #4145) so `timeout` is container-owned there — never host-fatal.
    windows: null,
  },
  deno: {
    darwin: [["brew", "install", "deno"]],
    // Not packaged for Debian/Ubuntu — piping a remote script into a shell is
    // not an acceptable substitute, so the caller keeps today's manual hint.
    linux: null,
    windows: [winget("DenoLand.Deno")],
  },
  gh: {
    darwin: [["brew", "install", "gh"]],
    linux: [["sudo", "apt-get", "install", "-y", "gh"]],
    windows: [winget("GitHub.cli")],
  },
  claude: {
    darwin: [["brew", "install", "--cask", "claude-code"]],
    linux: null,
    windows: null,
  },
  // Container runtimes on Linux (Issue #4137). Docker uses the distribution's
  // own `docker.io` — never a third-party apt source and signing key.
  // Windows takes Docker Desktop / Podman from winget (Issue #4185).
  docker: {
    darwin: null,
    linux: [["sudo", "apt-get", "install", "-y", "docker.io"]],
    windows: [winget("Docker.DockerDesktop")],
  },
  podman: {
    darwin: null,
    linux: [["sudo", "apt-get", "install", "-y", "podman"]],
    windows: [winget("RedHat.Podman")],
  },
  // Never auto-installed on macOS (Xcode command line tools) or Linux (a hard
  // bootstrap dependency). Windows has a clean, silent winget package and
  // neither of those reasons applies there (Issue #4185).
  git: { darwin: null, linux: null, windows: [winget("Git.Git")] },
  // Apple container: the Homebrew formula, then the service start the probe
  // needs before it will answer (Issue #4136). `--enable-kernel-install`
  // because the step runs with stdin closed — without it a first start
  // prompts for the default kernel and fails to read user input.
  "apple-container": {
    darwin: [
      ["brew", "install", "container"],
      ["container", "system", "start", "--enable-kernel-install"],
    ],
    linux: null,
    windows: null,
  },
  "container runtime": { darwin: null, linux: null, windows: null },
  "worker image": { darwin: null, linux: null, windows: null },
};

const PLATFORMS: HostPlatform[] = ["darwin", "linux", "windows"];

Deno.test("resolveInstallPlan - tool x platform matrix", async () => {
  for (const [tool, byPlatform] of Object.entries(EXPECTED)) {
    for (const platform of PLATFORMS) {
      const plan = await resolveInstallPlan(tool, platform, {
        packageManagerAvailable: allAvailable,
      });
      const expected = byPlatform[platform];
      if (expected === null) {
        assertEquals(plan, null, `${tool} on ${platform} must not be a plan`);
        continue;
      }
      assert(plan, `${tool} on ${platform} should resolve to a plan`);
      assertEquals(plan.tool, tool);
      assertEquals(plan.platform, platform);
      assertEquals(plan.steps.map((s) => [...s.command]), expected);
    }
  }
});

Deno.test("resolveInstallPlan - names the package manager it depends on", async () => {
  const mac = await resolveInstallPlan("jq", "darwin", {
    packageManagerAvailable: allAvailable,
  });
  assertEquals(mac?.packageManager, "brew");

  const linux = await resolveInstallPlan("jq", "linux", {
    packageManagerAvailable: allAvailable,
  });
  assertEquals(linux?.packageManager, "apt-get");

  const windows = await resolveInstallPlan("jq", "windows", {
    packageManagerAvailable: allAvailable,
  });
  assertEquals(windows?.packageManager, "winget");
});

Deno.test("resolveInstallPlan - only probes the plan's own package manager", async () => {
  const probed: string[] = [];
  await resolveInstallPlan("jq", "linux", {
    packageManagerAvailable: (name) => {
      probed.push(name);
      return Promise.resolve(true);
    },
  });
  assertEquals(probed, ["apt-get"]);
});

Deno.test("resolveInstallPlan - brew absent on macOS yields null for every tool", async () => {
  for (const tool of Object.keys(EXPECTED)) {
    const plan = await resolveInstallPlan(tool, "darwin", {
      packageManagerAvailable: noneAvailable,
    });
    assertEquals(plan, null, `${tool} must be null when brew is absent`);
  }
});

Deno.test("resolveInstallPlan - apt absent on Linux yields null for every tool", async () => {
  for (const tool of Object.keys(EXPECTED)) {
    const plan = await resolveInstallPlan(tool, "linux", {
      packageManagerAvailable: noneAvailable,
    });
    assertEquals(plan, null, `${tool} must be null when apt-get is absent`);
  }
});

Deno.test("resolveInstallPlan - winget absent on Windows yields null for every tool", async () => {
  for (const tool of Object.keys(EXPECTED)) {
    const plan = await resolveInstallPlan(tool, "windows", {
      packageManagerAvailable: noneAvailable,
    });
    assertEquals(plan, null, `${tool} must be null when winget is absent`);
  }
});

Deno.test("resolveInstallPlan - git is auto-installed only where a clean package exists", async () => {
  // macOS routes git through the Xcode command line tools (a large, separate,
  // interactive download) and Linux treats it as a hard bootstrap dependency,
  // so neither is auto-installed. winget's Git.Git is a silent, self-contained
  // package and neither reason applies on Windows (Issue #4185).
  for (const platform of ["darwin", "linux"] as HostPlatform[]) {
    assertEquals(
      await resolveInstallPlan("git", platform, {
        packageManagerAvailable: allAvailable,
      }),
      null,
    );
  }
  const windows = await resolveInstallPlan("git", "windows", {
    packageManagerAvailable: allAvailable,
  });
  assertEquals(windows?.steps[0]?.command, winget("Git.Git"));
});

Deno.test("resolveInstallPlan - unknown tools resolve to null", async () => {
  for (const platform of PLATFORMS) {
    assertEquals(
      await resolveInstallPlan("definitely-not-a-tool", platform, {
        packageManagerAvailable: allAvailable,
      }),
      null,
    );
  }
});

Deno.test("resolveInstallPlan - tool names are matched case-insensitively", async () => {
  const plan = await resolveInstallPlan("  JQ  ", "darwin", {
    packageManagerAvailable: allAvailable,
  });
  assertEquals(plan?.steps[0]?.command, ["brew", "install", "jq"]);
});

Deno.test("resolveInstallPlan - only apt steps may prompt for sudo", async () => {
  for (const tool of Object.keys(EXPECTED)) {
    const mac = await resolveInstallPlan(tool, "darwin", {
      packageManagerAvailable: allAvailable,
    });
    for (const step of mac?.steps ?? []) {
      assertEquals(step.mayPromptForSudo ?? false, false, `${tool} on darwin`);
    }
    const linux = await resolveInstallPlan(tool, "linux", {
      packageManagerAvailable: allAvailable,
    });
    for (const step of linux?.steps ?? []) {
      assertEquals(step.mayPromptForSudo, true, `${tool} on linux`);
    }
    // Windows has no sudo — winget elevates through UAC when it needs to, and
    // the step's description says so rather than the flag claiming a password
    // prompt that never appears.
    const windows = await resolveInstallPlan(tool, "windows", {
      packageManagerAvailable: allAvailable,
    });
    for (const step of windows?.steps ?? []) {
      assertEquals(step.mayPromptForSudo ?? false, false, `${tool} on windows`);
    }
  }
});

Deno.test("resolveInstallPlan - every step carries an operator-facing description", async () => {
  for (const tool of Object.keys(EXPECTED)) {
    for (const platform of PLATFORMS) {
      const plan = await resolveInstallPlan(tool, platform, {
        packageManagerAvailable: allAvailable,
      });
      for (const step of plan?.steps ?? []) {
        assert(
          step.description.trim().length > 0,
          `${tool} on ${platform} has a step with no description`,
        );
      }
    }
  }
});

Deno.test("resolveInstallPlan - no step is a shell pipeline or curl | sh", async () => {
  // Metacharacters that only mean anything to a shell: their presence in an
  // argv element proves the step is being handed to a shell rather than
  // executed directly.
  const shellMetacharacters = /[|;&><`$(){}\n]/;
  const shells = ["sh", "bash", "zsh", "dash", "cmd", "cmd.exe", "powershell"];

  const plans: InstallPlan[] = [];
  for (const tool of Object.keys(EXPECTED)) {
    for (const platform of PLATFORMS) {
      const plan = await resolveInstallPlan(tool, platform, {
        packageManagerAvailable: allAvailable,
      });
      if (plan) plans.push(plan);
    }
  }
  assert(plans.length > 0, "the matrix must produce at least one plan");

  for (const plan of plans) {
    for (const step of plan.steps) {
      assert(step.command.length > 0, `${plan.tool}: empty command`);
      const argv = [...step.command];
      const executable = argv[0]!;
      const label = `${plan.tool} on ${plan.platform}`;
      assert(
        !shells.includes(executable),
        `${label}: step invokes a shell (${executable})`,
      );
      assert(
        !argv.includes("-c"),
        `${label}: step looks like a shell -c invocation`,
      );
      assert(
        !argv.some((arg) => arg === "curl" || arg === "wget"),
        `${label}: step downloads and runs a remote script`,
      );
      for (const arg of argv) {
        assert(
          !shellMetacharacters.test(arg),
          `${label}: argument "${arg}" contains a shell metacharacter`,
        );
      }
    }
  }
});

Deno.test("resolveInstallPlan - Docker never adds a third-party apt source", async () => {
  const plan = await resolveInstallPlan("docker", "linux", {
    packageManagerAvailable: allAvailable,
  });
  assert(plan, "Docker must be installable from the distribution's packages");
  const argv = plan.steps.flatMap((step) => [...step.command]);
  for (
    const forbidden of [
      "add-apt-repository",
      "gpg",
      "tee",
      "download.docker.com",
    ]
  ) {
    assert(
      !argv.some((arg) => arg.includes(forbidden)),
      `the Docker plan must not touch ${forbidden}`,
    );
  }
});

Deno.test("resolveInstallPlan - every winget step pins the official source", async () => {
  // Supply chain: winget resolves an id against every configured source, so a
  // plan that does not pin `--source winget` could install a same-named
  // package from a private source the operator added for something else.
  let checked = 0;
  for (const tool of Object.keys(EXPECTED)) {
    const plan = await resolveInstallPlan(tool, "windows", {
      packageManagerAvailable: allAvailable,
    });
    for (const step of plan?.steps ?? []) {
      const argv = [...step.command];
      const source = argv.indexOf("--source");
      assert(source >= 0, `${tool}: winget step does not pin a source`);
      assertEquals(argv[source + 1], "winget", `${tool}: unexpected source`);
      assert(argv.includes("--exact"), `${tool}: id is not matched exactly`);
      checked += 1;
    }
  }
  assert(checked > 0, "the Windows table must produce at least one step");
});

Deno.test("resolveInstallPlan - only probes winget on Windows", async () => {
  const probed: string[] = [];
  await resolveInstallPlan("deno", "windows", {
    packageManagerAvailable: (name) => {
      probed.push(name);
      return Promise.resolve(true);
    },
  });
  assertEquals(probed, ["winget"]);
});

// ── Run mode (Issues #4149, #4): container, and only container ───────────

/** Every container runtime the table knows how to install. */
const RUNTIME_TOOLS = ["apple-container", "docker", "podman"];

Deno.test("resolveInstallPlan - the container runtimes are always offered: containment is mandatory (Issue #4)", async () => {
  for (const tool of RUNTIME_TOOLS) {
    const offered = await Promise.all(
      PLATFORMS.map((platform) =>
        resolveInstallPlan(tool, platform, {
          packageManagerAvailable: allAvailable,
          runMode: "container",
        })
      ),
    );
    assert(
      offered.some((plan) => plan !== null),
      `${tool} must be offered on at least one platform`,
    );
  }

  const mac = await resolveInstallPlan("apple-container", "darwin", {
    packageManagerAvailable: allAvailable,
    runMode: "container",
  });
  assertEquals(mac?.steps[0]?.command, ["brew", "install", "container"]);

  const docker = await resolveInstallPlan("docker", "linux", {
    packageManagerAvailable: allAvailable,
    runMode: "container",
  });
  assertEquals(docker?.steps[0]?.command, [
    "sudo",
    "apt-get",
    "install",
    "-y",
    "docker.io",
  ]);
});

Deno.test("resolveInstallPlan - the host tools keep their own plans", async () => {
  const expected: [string, HostPlatform, string[]][] = [
    ["jq", "darwin", ["brew", "install", "jq"]],
    ["jq", "linux", ["sudo", "apt-get", "install", "-y", "jq"]],
    ["timeout", "darwin", ["brew", "install", "coreutils"]],
    ["timeout", "linux", ["sudo", "apt-get", "install", "-y", "coreutils"]],
    ["claude", "darwin", ["brew", "install", "--cask", "claude-code"]],
  ];
  for (const [tool, platform, command] of expected) {
    const plan = await resolveInstallPlan(tool, platform, {
      packageManagerAvailable: allAvailable,
      runMode: "container",
    });
    assert(plan, `${tool} on ${platform} must resolve`);
    assertEquals(plan.steps[0]?.command, command);
  }
});

Deno.test("PLAN_TOOLS - covers every tool the prerequisite probe reports", () => {
  // The probe's tool names (setup/prerequisites.ts) must all be answerable,
  // even when the answer is "not auto-installable".
  for (const tool of ["git", "gh", "deno", "claude", "jq", "timeout"]) {
    assert(
      PLAN_TOOLS.includes(tool),
      `${tool} is missing from the install-plan table`,
    );
  }
});
