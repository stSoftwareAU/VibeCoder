/**
 * Tests for setup/prerequisites.ts
 *
 * Issue #923: Migrate setup scripts to Deno TypeScript.
 * Issue #993: Replace setup/prerequisites.sh with Deno module.
 * Issue #4117: Host-fatal vs container-owned split.
 * Issue #4149: The split follows the resolved run mode.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  aggregatePrerequisiteOk,
  checkAllPrerequisites,
  checkClaudeCli,
  checkContainerPrerequisites,
  checkDeno,
  checkGhAuth,
  checkGit,
  checkJq,
  checkTimeout,
  commandExists,
  configureGitIdentity,
  detectOs,
  isFatalInMode,
  recheckPrerequisite,
} from "../setup/prerequisites.ts";
import type { PrerequisiteOptions } from "../setup/prerequisites.ts";
import type { ContainerRuntimeProbe } from "../lib/container_runtime.ts";

// ── Mock command runner ─────────────────────────────────────────────────

/** Create a mock runner where specified commands succeed and others fail. */
function mockRunner(
  available: string[],
  overrides?: Record<
    string,
    { success: boolean; stdout: string; stderr: string }
  >,
): (
  cmd: string[],
) => Promise<{ success: boolean; stdout: string; stderr: string }> {
  return async (cmd: string[]) => {
    // Check overrides first (keyed by full command string)
    const cmdKey = cmd.join(" ");
    if (overrides && cmdKey in overrides) {
      return overrides[cmdKey]!;
    }

    const toolName = cmd[0]!;

    // For Deno.Command-based tool detection: the tool itself is cmd[0]
    // with "--version" as cmd[1]
    if (cmd[1] === "--version" || cmd[1] === "version") {
      const isAvailable = available.includes(toolName);
      return {
        success: isAvailable,
        stdout: isAvailable ? `${toolName} 1.0.0` : "",
        stderr: isAvailable ? "" : "command not found",
      };
    }

    // For gh auth status, gh api user, etc.
    if (toolName === "gh") {
      if (available.includes("gh")) {
        if (cmd[1] === "auth" && cmd[2] === "status") {
          return { success: true, stdout: "Logged in", stderr: "" };
        }
        if (cmd[1] === "api" && cmd[2] === "user") {
          return {
            success: true,
            stdout: JSON.stringify({
              login: "testuser",
              name: "Test User",
              email: "test@example.com",
            }),
            stderr: "",
          };
        }
      }
      return { success: false, stdout: "", stderr: "not authenticated" };
    }

    // For git config commands
    if (toolName === "git" && cmd[1] === "config") {
      if (cmd[2] === "--global" && cmd[3] === "--get") {
        // Simulate git config not set
        return { success: false, stdout: "", stderr: "" };
      }
      if (
        cmd[2] === "--global" &&
        (cmd[3] === "user.name" || cmd[3] === "user.email")
      ) {
        return { success: true, stdout: "", stderr: "" };
      }
    }

    return { success: false, stdout: "", stderr: "command not found" };
  };
}

// ── Container runtime fixtures (Issue #4117) ────────────────────────────

/** Repository root — the committed container definition lives under it. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/** A probe where only the named runtime kinds answer. */
function fakeProbe(availableKinds: string[]): ContainerRuntimeProbe {
  return (candidate) =>
    Promise.resolve(
      availableKinds.includes(candidate.kind)
        ? { available: true, path: candidate.executable }
        : {
          available: false,
          reason: `\`${candidate.executable}\` was not found on PATH`,
        },
    );
}

/** Options for a host with a healthy Docker and the image already built. */
function containerReadyOpts(
  tools: string[],
  imageBuilt = true,
): PrerequisiteOptions {
  const base = mockRunner(tools);
  return {
    os: "linux",
    repoRoot: REPO_ROOT,
    containerProbe: fakeProbe(["docker"]),
    runCommand: (cmd: string[]) =>
      cmd[0] === "docker" && cmd[1] === "image" && cmd[2] === "inspect"
        ? Promise.resolve({
          success: imageBuilt,
          stdout: imageBuilt ? "[]" : "",
          stderr: imageBuilt ? "" : "No such image",
        })
        : base(cmd),
  };
}

/** Options for a native host: no container runtime answers at all. */
function nativeOpts(tools: string[]): PrerequisiteOptions {
  return {
    os: "linux",
    repoRoot: REPO_ROOT,
    runMode: "native",
    containerProbe: fakeProbe([]),
    runCommand: mockRunner(tools),
  };
}

// ── detectOs ────────────────────────────────────────────────────────────

Deno.test("detectOs - returns darwin for macOS override", () => {
  assertEquals(detectOs("darwin"), "darwin");
});

Deno.test("detectOs - returns linux for linux override", () => {
  assertEquals(detectOs("linux"), "linux");
});

Deno.test("detectOs - returns windows for windows override", () => {
  assertEquals(detectOs("windows"), "windows");
});

Deno.test("detectOs - returns linux for unknown OS", () => {
  assertEquals(detectOs("freebsd"), "linux");
});

// ── commandExists ───────────────────────────────────────────────────────

Deno.test("commandExists - returns true for available command", async () => {
  const runner = mockRunner(["git"]);
  const result = await commandExists("git", runner);
  assertEquals(result, true);
});

Deno.test("commandExists - returns false for unavailable command", async () => {
  const runner = mockRunner([]);
  const result = await commandExists("nonexistent", runner);
  assertEquals(result, false);
});

// ── checkGit ────────────────────────────────────────────────────────────

Deno.test("checkGit - succeeds when git is available", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner(["git"]) };
  const result = await checkGit(opts);
  assertEquals(result.ok, true);
  assertEquals(result.tool, "git");
});

Deno.test("checkGit - fails when git is missing", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner([]) };
  const result = await checkGit(opts);
  assertEquals(result.ok, false);
  assertEquals(result.tool, "git");
  assertEquals(typeof result.hint, "string");
});

Deno.test("checkGit - skips when VIBE_SKIP_PREREQ_CHECK", async () => {
  const opts: PrerequisiteOptions = { skipPrereqCheck: true };
  const result = await checkGit(opts);
  assertEquals(result.ok, true);
});

// ── checkGhAuth ─────────────────────────────────────────────────────────

Deno.test("checkGhAuth - succeeds when gh is available and authenticated", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner(["gh"]) };
  const result = await checkGhAuth(opts);
  assertEquals(result.ok, true);
  assertEquals(result.tool, "gh");
});

Deno.test("checkGhAuth - fails when gh is not installed", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner([]) };
  const result = await checkGhAuth(opts);
  assertEquals(result.ok, false);
});

Deno.test("checkGhAuth - skips when skipAuthCheck", async () => {
  const opts: PrerequisiteOptions = { skipAuthCheck: true };
  const result = await checkGhAuth(opts);
  assertEquals(result.ok, true);
});

// ── checkClaudeCli ──────────────────────────────────────────────────────

Deno.test("checkClaudeCli - succeeds when claude is available", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner(["claude"]) };
  const result = await checkClaudeCli(opts);
  assertEquals(result.ok, true);
});

Deno.test("checkClaudeCli - fails when claude is missing", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner([]) };
  const result = await checkClaudeCli(opts);
  assertEquals(result.ok, false);
});

// ── checkDeno ───────────────────────────────────────────────────────────

Deno.test("checkDeno - succeeds when deno is available", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner(["deno"]) };
  const result = await checkDeno(opts);
  assertEquals(result.ok, true);
});

Deno.test("checkDeno - fails when deno is missing", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner([]) };
  const result = await checkDeno(opts);
  assertEquals(result.ok, false);
});

// ── checkJq ─────────────────────────────────────────────────────────────

Deno.test("checkJq - succeeds when jq is available", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner(["jq"]) };
  const result = await checkJq(opts);
  assertEquals(result.ok, true);
});

Deno.test("checkJq - fails when jq is missing", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner([]) };
  const result = await checkJq(opts);
  assertEquals(result.ok, false);
});

// ── checkTimeout ────────────────────────────────────────────────────────

Deno.test("checkTimeout - succeeds when timeout is available", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner(["timeout"]) };
  const result = await checkTimeout(opts);
  assertEquals(result.ok, true);
});

Deno.test("checkTimeout - succeeds when gtimeout is available (macOS)", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner(["gtimeout"]) };
  const result = await checkTimeout(opts);
  assertEquals(result.ok, true);
});

Deno.test("checkTimeout - fails when neither timeout nor gtimeout is available", async () => {
  const opts: PrerequisiteOptions = { runCommand: mockRunner([]) };
  const result = await checkTimeout(opts);
  assertEquals(result.ok, false);
});

// ── checkContainerPrerequisites (Issue #4117) ───────────────────────────

Deno.test("checkContainerPrerequisites - reports the runtime and a built image", async () => {
  const results = await checkContainerPrerequisites(
    containerReadyOpts(["git", "gh", "deno"]),
  );
  assertEquals(results.length, 2);
  assertEquals(results[0]!.ok, true);
  assertStringIncludes(results[0]!.message, "Docker");
  assertEquals(results[1]!.ok, true);
  assertStringIncludes(results[1]!.message, "vibe-coder:");
  assertStringIncludes(results[1]!.message, "built");
});

Deno.test("checkContainerPrerequisites - image not built yet is still ok (buildable)", async () => {
  const results = await checkContainerPrerequisites(
    containerReadyOpts(["git", "gh", "deno"], false),
  );
  assertEquals(results[1]!.ok, true);
  assertStringIncludes(results[1]!.message, "not built yet");
});

Deno.test("checkContainerPrerequisites - fails loudly when no runtime answers", async () => {
  const results = await checkContainerPrerequisites({
    os: "linux",
    repoRoot: REPO_ROOT,
    containerProbe: fakeProbe([]),
    runCommand: mockRunner(["git", "gh", "deno"]),
  });
  assertEquals(results[0]!.ok, false);
  assertEquals(results[0]!.informational, undefined);
  assertStringIncludes(results[0]!.message, "container runtime");
  assertStringIncludes(String(results[0]!.hint), "Docker");
});

Deno.test("checkContainerPrerequisites - fails when the image is not buildable", async () => {
  const emptyRoot = await Deno.makeTempDir();
  try {
    const results = await checkContainerPrerequisites({
      os: "linux",
      repoRoot: emptyRoot,
      containerProbe: fakeProbe(["docker"]),
      runCommand: mockRunner([]),
    });
    assertEquals(results[0]!.ok, true);
    assertEquals(results[1]!.ok, false);
    assertStringIncludes(results[1]!.message, "Containerfile");
  } finally {
    await Deno.remove(emptyRoot, { recursive: true });
  }
});

Deno.test("checkContainerPrerequisites - skips when VIBE_SKIP_PREREQ_CHECK", async () => {
  const results = await checkContainerPrerequisites({ skipPrereqCheck: true });
  assertEquals(results.every((r) => r.ok), true);
});

// ── checkAllPrerequisites ───────────────────────────────────────────────

Deno.test("checkAllPrerequisites - skips when VIBE_SKIP_PREREQ_CHECK", async () => {
  const result = await checkAllPrerequisites({ skipPrereqCheck: true });
  assertEquals(result.ok, true);
});

Deno.test("checkAllPrerequisites - returns ok when all tools available", async () => {
  // Host tools, container runtime + image, and the container-owned tools.
  const allTools = [
    "git",
    "gh",
    "claude",
    "deno",
    "jq",
    "timeout",
  ];
  const result = await checkAllPrerequisites(containerReadyOpts(allTools));
  assertEquals(result.ok, true);
  // git, gh, deno, container runtime, worker image, claude, jq, timeout
  assertEquals(result.results.length, 8);
});

Deno.test("checkAllPrerequisites - container-only host without jq/timeout is ok", async () => {
  const result = await checkAllPrerequisites(
    containerReadyOpts(["git", "gh", "deno", "claude"]),
  );
  assertEquals(result.ok, true);

  const containerOwned = result.results.filter((r) => r.informational);
  assertEquals(containerOwned.length, 2);
  assertEquals(containerOwned.every((r) => !r.ok), true);
  for (const r of containerOwned) {
    assertStringIncludes(r.message, "container image");
  }
});

Deno.test("checkAllPrerequisites - container mode still requires the host claude CLI", async () => {
  // The host claude mints the worker's OAuth token (`claude setup-token`,
  // Issue #4161) — there is no point continuing setup without it, and the
  // auto-install driver offers the Homebrew cask when it is missing.
  const result = await checkAllPrerequisites(
    containerReadyOpts(["git", "gh", "deno"]),
  );
  assertEquals(result.ok, false);

  const claude = result.results.find((r) => r.tool === "claude");
  assertEquals(claude?.ok, false);
  assertEquals(claude?.informational, undefined);
  assertStringIncludes(claude?.hint ?? "", "setup-token");
});

Deno.test("checkAllPrerequisites - fails when the container runtime is unavailable", async () => {
  const result = await checkAllPrerequisites({
    os: "linux",
    repoRoot: REPO_ROOT,
    containerProbe: fakeProbe([]),
    runCommand: mockRunner(["git", "gh", "deno", "claude", "jq", "timeout"]),
  });
  assertEquals(result.ok, false);
});

Deno.test("checkAllPrerequisites - fails when a host tool is missing", async () => {
  const result = await checkAllPrerequisites(containerReadyOpts(["git"]));
  assertEquals(result.ok, false);
});

// ── Native run mode (Issue #4149) ───────────────────────────────────────

Deno.test("checkAllPrerequisites - native mode makes claude, jq and timeout host-fatal", async () => {
  const result = await checkAllPrerequisites(nativeOpts(["git", "gh", "deno"]));

  assertEquals(result.ok, false, "a native host without the agent tools fails");
  for (const tool of ["claude", "jq", "timeout"]) {
    const entry = result.results.find((r) => r.tool === tool)!;
    assertEquals(entry.ok, false, `${tool} must fail`);
    assertEquals(
      entry.informational,
      undefined,
      `${tool} must be host-fatal in native mode`,
    );
    assert(
      !entry.message.includes("container image"),
      `${tool} must not be described as container-owned: ${entry.message}`,
    );
    assert(
      !(entry.hint ?? "").includes("container-only"),
      `${tool} must not keep the container-only hint: ${entry.hint}`,
    );
  }
});

Deno.test("checkAllPrerequisites - native mode passes on a host with no container runtime", async () => {
  const result = await checkAllPrerequisites(
    nativeOpts(["git", "gh", "deno", "claude", "jq", "timeout"]),
  );

  assertEquals(result.ok, true, "a native host needs no container runtime");
  const runtime = result.results.find((r) => r.tool === "container runtime")!;
  assertEquals(runtime.ok, false);
  assertEquals(runtime.informational, true);
  assertStringIncludes(runtime.message, "native run mode does not need one");
  assertStringIncludes(String(runtime.hint), "container mode");
  // The image is never resolved for a mode that will not run it.
  assertEquals(
    result.results.some((r) => r.tool === "worker image"),
    false,
  );
});

Deno.test("checkAllPrerequisites - native mode reports an available runtime informationally", async () => {
  const result = await checkAllPrerequisites({
    ...nativeOpts(["git", "gh", "deno", "claude", "jq", "timeout"]),
    containerProbe: fakeProbe(["docker"]),
  });

  assertEquals(result.ok, true);
  const runtime = result.results.find((r) => r.tool === "container runtime")!;
  assertEquals(runtime.ok, true);
  assertEquals(runtime.informational, true);
  assertStringIncludes(runtime.message, "container mode is available");
});

Deno.test("checkAllPrerequisites - native mode still fails on a missing setup tool", async () => {
  const result = await checkAllPrerequisites(
    nativeOpts(["gh", "deno", "claude", "jq", "timeout"]),
  );
  assertEquals(result.ok, false);
  assertEquals(result.results.find((r) => r.tool === "git")!.ok, false);
});

Deno.test("checkAllPrerequisites - VIBE_SKIP_PREREQ_CHECK skips both modes alike", async () => {
  const original = Deno.env.get("VIBE_SKIP_PREREQ_CHECK");
  try {
    Deno.env.set("VIBE_SKIP_PREREQ_CHECK", "true");
    for (const runMode of ["container", "native"] as const) {
      // A bare host — nothing installed, no runtime — passes on the flag alone.
      const result = await checkAllPrerequisites({
        ...nativeOpts([]),
        runMode,
      });
      assertEquals(result.ok, true, `${runMode} must honour the skip flag`);
    }
  } finally {
    if (original) Deno.env.set("VIBE_SKIP_PREREQ_CHECK", original);
    else Deno.env.delete("VIBE_SKIP_PREREQ_CHECK");
  }
});

Deno.test("checkAllPrerequisites - VIBE_SKIP_AUTH_CHECK skips gh in native mode too", async () => {
  const result = await checkAllPrerequisites({
    ...nativeOpts(["git", "deno", "claude", "jq", "timeout"]),
    skipAuthCheck: true,
  });
  assertEquals(result.ok, true);
  assertEquals(result.results.find((r) => r.tool === "gh")!.ok, true);
});

Deno.test("recheckPrerequisite - jq is informational in container mode, fatal in native", async () => {
  const missing = { runCommand: mockRunner([]), os: "linux" };

  const container = await recheckPrerequisite("jq", {
    ...missing,
    runMode: "container",
  });
  assertEquals(container!.ok, false);
  assertEquals(container!.informational, true);

  const native = await recheckPrerequisite("jq", {
    ...missing,
    runMode: "native",
  });
  assertEquals(native!.ok, false);
  assertEquals(native!.informational, undefined);
  assertStringIncludes(String(native!.hint), "jq");
});

Deno.test("recheckPrerequisite - installing a tool never reclassifies it", async () => {
  // The same tool, now present: it stays informational in container mode and
  // host-fatal in native mode. Classification follows the mode, not the state.
  const present = { runCommand: mockRunner(["jq"]), os: "linux" };

  const container = await recheckPrerequisite("jq", {
    ...present,
    runMode: "container",
  });
  assertEquals(container!.ok, true);
  assertEquals(container!.informational, true);

  const native = await recheckPrerequisite("jq", {
    ...present,
    runMode: "native",
  });
  assertEquals(native!.ok, true);
  assertEquals(native!.informational, undefined);
});

Deno.test("aggregatePrerequisiteOk - the mode decides which failures are fatal", () => {
  const jqMissing = [
    { ok: true, tool: "git", message: "git is installed" },
    { ok: false, tool: "jq", message: "jq is not installed" },
  ];
  assertEquals(aggregatePrerequisiteOk(jqMissing, "container"), true);
  assertEquals(aggregatePrerequisiteOk(jqMissing, "native"), false);

  const noRuntime = [
    { ok: true, tool: "git", message: "git is installed" },
    { ok: false, tool: "container runtime", message: "no runtime" },
  ];
  assertEquals(aggregatePrerequisiteOk(noRuntime, "container"), false);
  assertEquals(aggregatePrerequisiteOk(noRuntime, "native"), true);
});

Deno.test("isFatalInMode - swaps the two tool groups over between modes", () => {
  const result = (tool: string) => ({ ok: false, tool, message: "missing" });

  for (const tool of ["jq", "timeout"]) {
    assertEquals(isFatalInMode(result(tool), "container"), false);
    assertEquals(isFatalInMode(result(tool), "native"), true);
  }
  for (const tool of ["container runtime", "worker image"]) {
    assertEquals(isFatalInMode(result(tool), "container"), true);
    assertEquals(isFatalInMode(result(tool), "native"), false);
  }
  // claude is host-fatal in BOTH modes: setup mints and validates the
  // worker's OAuth token with the host CLI (Issue #4161).
  for (const tool of ["git", "gh", "deno", "claude"]) {
    assertEquals(isFatalInMode(result(tool), "container"), true);
    assertEquals(isFatalInMode(result(tool), "native"), true);
  }
  // An explicit informational flag is never fatal, in either mode.
  assertEquals(
    isFatalInMode({ ...result("git"), informational: true }, "native"),
    false,
  );
});

// ── configureGitIdentity ───────────────────────────────────────────────

Deno.test("configureGitIdentity - configures git user from gh api user", async () => {
  const commands: string[][] = [];
  const runner = (
    cmd: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }> => {
    commands.push(cmd);
    // gh api user returns user info
    if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify({
          login: "testuser",
          name: "Test User",
          email: "test@example.com",
        }),
        stderr: "",
      });
    }
    // git config --global --get returns empty (not set)
    if (
      cmd[0] === "git" && cmd[1] === "config" && cmd[2] === "--global" &&
      cmd[3] === "--get"
    ) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    // git config --global user.name/email set succeeds
    if (cmd[0] === "git" && cmd[1] === "config" && cmd[2] === "--global") {
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    }
    return Promise.resolve({ success: false, stdout: "", stderr: "" });
  };

  const result = await configureGitIdentity({ runCommand: runner });
  assertEquals(result.ok, true);
  assertStringIncludes(result.message, "Test User");

  // Should have called git config --global user.name and user.email
  const setNameCmd = commands.find(
    (c) =>
      c[0] === "git" && c[1] === "config" && c[2] === "--global" &&
      c[3] === "user.name",
  );
  const setEmailCmd = commands.find(
    (c) =>
      c[0] === "git" && c[1] === "config" && c[2] === "--global" &&
      c[3] === "user.email",
  );
  assertEquals(setNameCmd !== undefined, true);
  assertEquals(setEmailCmd !== undefined, true);
});

Deno.test("configureGitIdentity - skips when git identity already set", async () => {
  const commands: string[][] = [];
  const runner = (
    cmd: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }> => {
    commands.push(cmd);
    // git config --global --get returns existing values
    if (
      cmd[0] === "git" && cmd[1] === "config" && cmd[2] === "--global" &&
      cmd[3] === "--get"
    ) {
      if (cmd[4] === "user.name") {
        return Promise.resolve({
          success: true,
          stdout: "Existing User",
          stderr: "",
        });
      }
      if (cmd[4] === "user.email") {
        return Promise.resolve({
          success: true,
          stdout: "existing@example.com",
          stderr: "",
        });
      }
    }
    return Promise.resolve({ success: false, stdout: "", stderr: "" });
  };

  const result = await configureGitIdentity({ runCommand: runner });
  assertEquals(result.ok, true);
  assertStringIncludes(result.message, "already configured");

  // Should NOT have called gh api user or set git config
  const ghApiCall = commands.find((c) => c[0] === "gh" && c[1] === "api");
  assertEquals(ghApiCall, undefined);
});

Deno.test("configureGitIdentity - skips when skipPrereqCheck is true", async () => {
  const result = await configureGitIdentity({ skipPrereqCheck: true });
  assertEquals(result.ok, true);
  assertStringIncludes(result.message, "Skipped");
});

Deno.test("configureGitIdentity - returns error when gh api user fails", async () => {
  const runner = (
    cmd: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }> => {
    // git config --global --get returns not set
    if (
      cmd[0] === "git" && cmd[1] === "config" && cmd[2] === "--global" &&
      cmd[3] === "--get"
    ) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    // gh api user fails
    if (cmd[0] === "gh") {
      return Promise.resolve({
        success: false,
        stdout: "",
        stderr: "not authenticated",
      });
    }
    return Promise.resolve({ success: false, stdout: "", stderr: "" });
  };

  const result = await configureGitIdentity({ runCommand: runner });
  assertEquals(result.ok, false);
  assertStringIncludes(result.message, "Failed");
});

Deno.test("configureGitIdentity - uses login as fallback name when name is empty", async () => {
  const commands: string[][] = [];
  const runner = (
    cmd: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }> => {
    commands.push(cmd);
    if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify({
          login: "testuser",
          name: "",
          email: "test@example.com",
        }),
        stderr: "",
      });
    }
    if (
      cmd[0] === "git" && cmd[1] === "config" && cmd[2] === "--global" &&
      cmd[3] === "--get"
    ) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    if (cmd[0] === "git" && cmd[1] === "config" && cmd[2] === "--global") {
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    }
    return Promise.resolve({ success: false, stdout: "", stderr: "" });
  };

  const result = await configureGitIdentity({ runCommand: runner });
  assertEquals(result.ok, true);

  // Should use login as fallback for name
  const setNameCmd = commands.find(
    (c) =>
      c[0] === "git" && c[1] === "config" && c[2] === "--global" &&
      c[3] === "user.name",
  );
  assertEquals(setNameCmd?.[4], "testuser");
});

Deno.test("configureGitIdentity - generates noreply email when email is empty", async () => {
  const commands: string[][] = [];
  const runner = (
    cmd: string[],
  ): Promise<{ success: boolean; stdout: string; stderr: string }> => {
    commands.push(cmd);
    if (cmd[0] === "gh" && cmd[1] === "api" && cmd[2] === "user") {
      return Promise.resolve({
        success: true,
        stdout: JSON.stringify({
          login: "testuser",
          name: "Test User",
          email: "",
        }),
        stderr: "",
      });
    }
    if (
      cmd[0] === "git" && cmd[1] === "config" && cmd[2] === "--global" &&
      cmd[3] === "--get"
    ) {
      return Promise.resolve({ success: false, stdout: "", stderr: "" });
    }
    if (cmd[0] === "git" && cmd[1] === "config" && cmd[2] === "--global") {
      return Promise.resolve({ success: true, stdout: "", stderr: "" });
    }
    return Promise.resolve({ success: false, stdout: "", stderr: "" });
  };

  const result = await configureGitIdentity({ runCommand: runner });
  assertEquals(result.ok, true);

  // Should use noreply email
  const setEmailCmd = commands.find(
    (c) =>
      c[0] === "git" && c[1] === "config" && c[2] === "--global" &&
      c[3] === "user.email",
  );
  assertEquals(setEmailCmd?.[4], "testuser@users.noreply.github.com");
});

// ── Environment variable integration ──────────────────────────────────

Deno.test("checkAllPrerequisites - reads VIBE_SKIP_PREREQ_CHECK from env", async () => {
  const original = Deno.env.get("VIBE_SKIP_PREREQ_CHECK");
  try {
    Deno.env.set("VIBE_SKIP_PREREQ_CHECK", "true");
    // Call without explicit skipPrereqCheck — should read from env
    const result = await checkAllPrerequisites({});
    assertEquals(result.ok, true);
  } finally {
    if (original) {
      Deno.env.set("VIBE_SKIP_PREREQ_CHECK", original);
    } else {
      Deno.env.delete("VIBE_SKIP_PREREQ_CHECK");
    }
  }
});

Deno.test("checkAllPrerequisites - reads VIBE_SKIP_AUTH_CHECK from env", async () => {
  const original = Deno.env.get("VIBE_SKIP_AUTH_CHECK");
  try {
    Deno.env.set("VIBE_SKIP_AUTH_CHECK", "true");
    // With all tools available but auth would fail without skip
    const allTools = ["git", "deno", "jq", "timeout"];
    // gh is in the list but won't pass auth without the skip flag
    const result = await checkAllPrerequisites(
      containerReadyOpts([...allTools, "gh", "claude"]),
    );
    assertEquals(result.ok, true);
  } finally {
    if (original) {
      Deno.env.set("VIBE_SKIP_AUTH_CHECK", original);
    } else {
      Deno.env.delete("VIBE_SKIP_AUTH_CHECK");
    }
  }
});
