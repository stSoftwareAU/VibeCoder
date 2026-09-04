/**
 * Tests for service_account_env.ts — apply the operator's service-account
 * environment (GH_CONFIG_DIR / GIT_SSH_COMMAND) inside the Deno runtime.
 *
 * Following TDD: tests written first to define expected behaviour.
 *
 * Issue #3530: the pure-Deno driver (`run.sh` → `run-entrypoint`, #3504)
 * dropped the bash-era `eval "$(load-config)"` step, so `gh_config_dir` and
 * `ssh_key_path` from `.config.json` were never applied. The worker then
 * authenticated with the ambient (human) `gh` config, and the #3416
 * fleet-login trust gate silently rejected every label that human applied —
 * the host claimed no labelled work at all.
 */

import { assert, assertEquals } from "@std/assert";
import {
  applyServiceAccountEnv,
  resolveServiceAccountEnv,
} from "../lib/service_account_env.ts";
import { loadConfig } from "../lib/config.ts";
import type { ConfigFile } from "../types.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { canEnforceUnwritableDir } from "./support/environment_capability.ts";

// Test helper to create a temporary config file
async function withTempConfig(
  config: ConfigFile,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// resolveServiceAccountEnv — pure resolution with ~ expansion
// ---------------------------------------------------------------------------

Deno.test("resolveServiceAccountEnv - expands ~ in gh config dir and ssh key path", () => {
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "~/.config/gh-vibe", sshKeyPath: "~/.ssh/worker_ed25519" },
    "/Users/worker",
  );
  assertEquals(env.GH_CONFIG_DIR, "/Users/worker/.config/gh-vibe");
  assertEquals(
    env.GIT_SSH_COMMAND,
    "ssh -i '/Users/worker/.ssh/worker_ed25519' -o IdentitiesOnly=yes",
  );
});

Deno.test("resolveServiceAccountEnv - absolute paths pass through unchanged", () => {
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "/etc/gh-vibe", sshKeyPath: "/etc/keys/worker" },
    "/Users/worker",
  );
  assertEquals(env.GH_CONFIG_DIR, "/etc/gh-vibe");
  assertEquals(
    env.GIT_SSH_COMMAND,
    "ssh -i '/etc/keys/worker' -o IdentitiesOnly=yes",
  );
});

// Issue #3661 (SEC-a228ff008ed4): git hands GIT_SSH_COMMAND to /bin/sh, so an
// unquoted key path with a space silently authenticated with the wrong
// identity, and one containing shell metacharacters executed on every git
// call. The three expectations above were updated from the bare form to the
// quoted one for the same reason.

Deno.test("resolveServiceAccountEnv - a key path with spaces stays one argument", () => {
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "", sshKeyPath: "~/My Keys/worker id" },
    "/Users/worker",
  );
  assertEquals(
    env.GIT_SSH_COMMAND,
    "ssh -i '/Users/worker/My Keys/worker id' -o IdentitiesOnly=yes",
  );
});

Deno.test("resolveServiceAccountEnv - shell metacharacters in the key path are inert", () => {
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "", sshKeyPath: "/keys/a$(id);echo pwned/b" },
    "/Users/worker",
  );
  assertEquals(
    env.GIT_SSH_COMMAND,
    "ssh -i '/keys/a$(id);echo pwned/b' -o IdentitiesOnly=yes",
  );
});

Deno.test("resolveServiceAccountEnv - empty config yields no env entries", () => {
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "", sshKeyPath: "" },
    "/Users/worker",
  );
  assertEquals(env.GH_CONFIG_DIR, undefined);
  assertEquals(env.GIT_SSH_COMMAND, undefined);
});

Deno.test("resolveServiceAccountEnv - only mid-string ~ is not expanded", () => {
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "/opt/~gh", sshKeyPath: "" },
    "/Users/worker",
  );
  assertEquals(env.GH_CONFIG_DIR, "/opt/~gh");
});

// ---------------------------------------------------------------------------
// loadConfig — carries the raw operator values onto WorkerConfig
// ---------------------------------------------------------------------------

Deno.test("loadConfig - populates ghConfigDir and sshKeyPath from the config file", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
    gh_config_dir: "~/.config/gh-vibe",
    ssh_key_path: "~/.ssh/worker_ed25519",
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.ghConfigDir, "~/.config/gh-vibe");
    assertEquals(config.sshKeyPath, "~/.ssh/worker_ed25519");
  });
});

Deno.test("loadConfig - ghConfigDir and sshKeyPath default to empty strings", async () => {
  const testConfig: ConfigFile = {
    allowed_authors: ["testuser"],
    repos: ["org/repo1"],
  };

  await withTempConfig(testConfig, async (configPath) => {
    const config = await loadConfig(configPath);
    assertEquals(config.ghConfigDir, "");
    assertEquals(config.sshKeyPath, "");
  });
});

Deno.test("buildDefaultWorkerConfig - includes empty service-account fields", () => {
  const config = buildDefaultWorkerConfig();
  assertEquals(config.ghConfigDir, "");
  assertEquals(config.sshKeyPath, "");
});

// ---------------------------------------------------------------------------
// applyServiceAccountEnv — sets the process environment (config wins,
// matching the bash-era `eval "$(load-config)"` behaviour)
// ---------------------------------------------------------------------------

Deno.test("applyServiceAccountEnv - sets GH_CONFIG_DIR and GIT_SSH_COMMAND", () => {
  const previousGh = Deno.env.get("GH_CONFIG_DIR");
  const previousSsh = Deno.env.get("GIT_SSH_COMMAND");
  // The quality gate runs this suite INSIDE the worker image, where the
  // container stamp is set and the fixture paths do not exist — host
  // semantics are what this test pins, so the stamp is cleared for it.
  const previousStamp = Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS");
  try {
    Deno.env.delete("VIBE_IMAGE_AGENT_PROVIDERS");
    Deno.env.delete("GH_CONFIG_DIR");
    Deno.env.delete("GIT_SSH_COMMAND");
    const config = buildDefaultWorkerConfig({
      ghConfigDir: "~/.config/gh-vibe",
      sshKeyPath: "~/.ssh/worker_ed25519",
    });
    applyServiceAccountEnv(config, "/Users/worker");
    assertEquals(
      Deno.env.get("GH_CONFIG_DIR"),
      "/Users/worker/.config/gh-vibe",
    );
    assertEquals(
      Deno.env.get("GIT_SSH_COMMAND"),
      "ssh -i '/Users/worker/.ssh/worker_ed25519' -o IdentitiesOnly=yes",
    );
  } finally {
    restoreEnv("GH_CONFIG_DIR", previousGh);
    restoreEnv("GIT_SSH_COMMAND", previousSsh);
    restoreEnv("VIBE_IMAGE_AGENT_PROVIDERS", previousStamp);
  }
});

Deno.test("applyServiceAccountEnv - the container stamp switches on the credential fallback", async () => {
  // With the stamp set and a staged runtime copy on disk, apply() must point
  // GH_CONFIG_DIR at the writable copy and omit GIT_SSH_COMMAND — the full
  // production path of the in-container resolution.
  const previousGh = Deno.env.get("GH_CONFIG_DIR");
  const previousSsh = Deno.env.get("GIT_SSH_COMMAND");
  const previousStamp = Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS");
  const home = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${home}/.config/gh-runtime`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.config/gh-runtime/hosts.yml`,
      "github.com:\n",
    );
    Deno.env.set("VIBE_IMAGE_AGENT_PROVIDERS", "claude");
    Deno.env.delete("GH_CONFIG_DIR");
    Deno.env.delete("GIT_SSH_COMMAND");
    const config = buildDefaultWorkerConfig({
      ghConfigDir: "~/.config/gh-vibe",
      sshKeyPath: "~/.ssh/worker_ed25519",
    });
    applyServiceAccountEnv(config, home);
    assertEquals(Deno.env.get("GH_CONFIG_DIR"), `${home}/.config/gh-runtime`);
    assertEquals(Deno.env.get("GIT_SSH_COMMAND"), undefined);
  } finally {
    restoreEnv("GH_CONFIG_DIR", previousGh);
    restoreEnv("GIT_SSH_COMMAND", previousSsh);
    restoreEnv("VIBE_IMAGE_AGENT_PROVIDERS", previousStamp);
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("applyServiceAccountEnv - configured value overrides ambient env (config wins)", () => {
  const previousGh = Deno.env.get("GH_CONFIG_DIR");
  try {
    Deno.env.set("GH_CONFIG_DIR", "/ambient/gh");
    const config = buildDefaultWorkerConfig({
      ghConfigDir: "/operator/gh-vibe",
    });
    applyServiceAccountEnv(config, "/Users/worker");
    assertEquals(Deno.env.get("GH_CONFIG_DIR"), "/operator/gh-vibe");
  } finally {
    restoreEnv("GH_CONFIG_DIR", previousGh);
  }
});

Deno.test("applyServiceAccountEnv - unconfigured fields leave ambient env untouched", () => {
  const previousGh = Deno.env.get("GH_CONFIG_DIR");
  const previousSsh = Deno.env.get("GIT_SSH_COMMAND");
  try {
    Deno.env.set("GH_CONFIG_DIR", "/ambient/gh");
    Deno.env.set("GIT_SSH_COMMAND", "ssh -i /ambient/key");
    const config = buildDefaultWorkerConfig();
    applyServiceAccountEnv(config, "/Users/worker");
    assertEquals(Deno.env.get("GH_CONFIG_DIR"), "/ambient/gh");
    assertEquals(Deno.env.get("GIT_SSH_COMMAND"), "ssh -i /ambient/key");
  } finally {
    restoreEnv("GH_CONFIG_DIR", previousGh);
    restoreEnv("GIT_SSH_COMMAND", previousSsh);
  }
});

// ---------------------------------------------------------------------------
// mod.ts wiring — the env application must sit on the shared command path so
// every command (including run-entrypoint) authenticates as the service
// account before its first `gh` call.
// ---------------------------------------------------------------------------

Deno.test("mod.ts - applies the service-account env after loading config", async () => {
  const source = await Deno.readTextFile(
    new URL("../mod.ts", import.meta.url),
  );
  const loadIndex = source.indexOf("config = await loadConfig(configPath)");
  const applyIndex = source.indexOf("applyServiceAccountEnv(");
  if (loadIndex === -1) {
    throw new Error("mod.ts no longer calls loadConfig(configPath)");
  }
  if (applyIndex === -1) {
    throw new Error(
      "mod.ts must call applyServiceAccountEnv so gh_config_dir/ssh_key_path " +
        "from .config.json are applied before any gh/git call (Issue #3530)",
    );
  }
  if (applyIndex < loadIndex) {
    throw new Error(
      "applyServiceAccountEnv must run after loadConfig succeeds",
    );
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    Deno.env.delete(name);
  } else {
    Deno.env.set(name, value);
  }
}

// ---------------------------------------------------------------------------
// Container-aware fallback (Issue #4060): the configured paths are host
// paths that are deliberately never mounted into the container.
// ---------------------------------------------------------------------------

Deno.test("resolveServiceAccountEnv - absent gh dir falls back to the mounted credential material", () => {
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "~/.config/gh-vibe", sshKeyPath: "~/.ssh/worker_ed25519" },
    "/home/vibe",
    {
      inContainer: true,
      probe: {
        exists: (path) =>
          path === "/home/vibe/.vibe-coder/credentials/gh/hosts.yml",
      },
    },
  );
  assertEquals(env.GH_CONFIG_DIR, "/home/vibe/.vibe-coder/credentials/gh");
  // No SSH key inside the container: the variable is omitted so git uses
  // the entrypoint's HTTPS+token transport.
  assertEquals(env.GIT_SSH_COMMAND, undefined);
});

Deno.test("resolveServiceAccountEnv - the writable runtime copy wins over the read-only mount", () => {
  // gh performs a config-migration write on first use in every fresh VM, so
  // the entrypoint stages a writable copy; GH_CONFIG_DIR must point there.
  const present = new Set([
    "/home/vibe/.config/gh-runtime/hosts.yml",
    "/home/vibe/.vibe-coder/credentials/gh/hosts.yml",
  ]);
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "~/.config/gh-vibe", sshKeyPath: "" },
    "/home/vibe",
    { inContainer: true, probe: { exists: (path) => present.has(path) } },
  );
  assertEquals(env.GH_CONFIG_DIR, "/home/vibe/.config/gh-runtime");
});

Deno.test("resolveServiceAccountEnv - present configured paths win over the fallback", () => {
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "~/.config/gh-vibe", sshKeyPath: "~/.ssh/worker_ed25519" },
    "/Users/worker",
    { inContainer: true, probe: { exists: () => true } },
  );
  assertEquals(env.GH_CONFIG_DIR, "/Users/worker/.config/gh-vibe");
  assertEquals(
    env.GIT_SSH_COMMAND,
    "ssh -i '/Users/worker/.ssh/worker_ed25519' -o IdentitiesOnly=yes",
  );
});

Deno.test("resolveServiceAccountEnv - nothing mounted keeps the configured dir so failures stay loud", () => {
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "~/.config/gh-vibe", sshKeyPath: "" },
    "/home/vibe",
    { inContainer: true, probe: { exists: () => false } },
  );
  assertEquals(env.GH_CONFIG_DIR, "/home/vibe/.config/gh-vibe");
});

// ---------------------------------------------------------------------------
// The staged copy this launch actually made (Issue #509 / #515). The
// read-only-root milestone moved the entrypoint's writable gh copy from
// ${HOME}/.config/gh-runtime to ${VIBE_SCRATCH_DIR}/gh. A resolver that knew
// only the legacy path fell through to the READ-ONLY credential mount, and
// every fleet run then died at startup: "failed to write config after
// migration: open …/credentials/gh/hosts.yml: read-only file system", surfaced
// only as "could not resolve authenticated GitHub user".
// ---------------------------------------------------------------------------

Deno.test("resolveServiceAccountEnv - the entrypoint's staged copy wins over the read-only mount", () => {
  const present = new Set([
    "/tmp/vibe-scratch/gh/hosts.yml",
    "/home/vibe/.vibe-coder/credentials/gh/hosts.yml",
  ]);
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "~/.config/gh-vibe", sshKeyPath: "" },
    "/home/vibe",
    {
      inContainer: true,
      probe: { exists: (path) => present.has(path) },
      stagedGhConfigDirs: ["/tmp/vibe-scratch/gh"],
    },
  );
  assertEquals(env.GH_CONFIG_DIR, "/tmp/vibe-scratch/gh");
});

Deno.test("resolveServiceAccountEnv - a staged candidate without hosts.yml is skipped", () => {
  const present = new Set(["/home/vibe/.config/gh-runtime/hosts.yml"]);
  const env = resolveServiceAccountEnv(
    { ghConfigDir: "~/.config/gh-vibe", sshKeyPath: "" },
    "/home/vibe",
    {
      inContainer: true,
      probe: { exists: (path) => present.has(path) },
      stagedGhConfigDirs: ["/tmp/vibe-scratch/gh"],
    },
  );
  assertEquals(env.GH_CONFIG_DIR, "/home/vibe/.config/gh-runtime");
});

Deno.test({
  name:
    "applyServiceAccountEnv - an unwritable gh config dir is restaged writable",
  // Issue #891: the container runs with privileges under which a chmod-ed
  // unwritable directory is still writable, so the branch this drives is
  // never taken and the assertion fails on every branch. Skipped explicitly
  // — reported as ignored — rather than passing silently.
  ignore: !(await canEnforceUnwritableDir()),
  fn: async () => {
    // The end of the live failure: the only hosts.yml the container can see is
    // on the read-only mount. gh migrates its config on first use, so handing
    // that directory over is a startup failure — a writable copy must be made.
    const previousGh = Deno.env.get("GH_CONFIG_DIR");
    const previousStamp = Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS");
    const previousTmp = Deno.env.get("TMPDIR");
    const previousScratch = Deno.env.get("VIBE_SCRATCH_DIR");
    const home = await Deno.makeTempDir();
    const tmp = await Deno.makeTempDir();
    const mounted = `${home}/.vibe-coder/credentials/gh`;
    try {
      await Deno.mkdir(mounted, { recursive: true });
      await Deno.writeTextFile(`${mounted}/hosts.yml`, "github.com:\n");
      // Read-only directory: writing the probe file inside it must fail.
      await Deno.chmod(mounted, 0o500);
      Deno.env.set("VIBE_IMAGE_AGENT_PROVIDERS", "claude");
      Deno.env.set("TMPDIR", tmp);
      Deno.env.delete("VIBE_SCRATCH_DIR");
      Deno.env.delete("GH_CONFIG_DIR");
      applyServiceAccountEnv(
        buildDefaultWorkerConfig({ ghConfigDir: "~/.config/gh-vibe" }),
        home,
      );
      const applied = Deno.env.get("GH_CONFIG_DIR");
      // The outcome, not the scratch root it landed in: on a host that
      // exports WORK_DIR the copy is staged under the container-state
      // directory rather than TMPDIR, and pinning one spelling made this
      // assertion fail wherever the worker's own environment is present.
      // What must hold either way is that gh is pointed at a writable copy
      // carrying the credential, never at the read-only mount.
      assert(applied !== undefined && applied !== mounted, "restaged copy");
      assertEquals(
        await Deno.readTextFile(`${applied}/hosts.yml`),
        "github.com:\n",
      );
      const probe = `${applied}/.writable-probe`;
      await Deno.writeTextFile(probe, "");
      await Deno.remove(probe);
    } finally {
      restoreEnv("GH_CONFIG_DIR", previousGh);
      restoreEnv("VIBE_IMAGE_AGENT_PROVIDERS", previousStamp);
      restoreEnv("TMPDIR", previousTmp);
      restoreEnv("VIBE_SCRATCH_DIR", previousScratch);
      await Deno.chmod(mounted, 0o700);
      await Deno.remove(home, { recursive: true });
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

Deno.test("applyServiceAccountEnv - a writable gh config dir is left alone", async () => {
  const previousGh = Deno.env.get("GH_CONFIG_DIR");
  const previousStamp = Deno.env.get("VIBE_IMAGE_AGENT_PROVIDERS");
  const home = await Deno.makeTempDir();
  try {
    const staged = `${home}/scratch/gh`;
    await Deno.mkdir(staged, { recursive: true });
    await Deno.writeTextFile(`${staged}/hosts.yml`, "github.com:\n");
    Deno.env.set("VIBE_IMAGE_AGENT_PROVIDERS", "claude");
    // What the entrypoint exports: the staged copy it made this launch.
    Deno.env.set("GH_CONFIG_DIR", staged);
    applyServiceAccountEnv(
      buildDefaultWorkerConfig({ ghConfigDir: "~/.config/gh-vibe" }),
      home,
    );
    assertEquals(Deno.env.get("GH_CONFIG_DIR"), staged);
  } finally {
    restoreEnv("GH_CONFIG_DIR", previousGh);
    restoreEnv("VIBE_IMAGE_AGENT_PROVIDERS", previousStamp);
    await Deno.remove(home, { recursive: true });
  }
});
