/**
 * Tests for setup/container_runtime_install.ts — auto-installing Apple
 * `container` on macOS and starting its service in the same setup run
 * (Issue #4136).
 *
 * Every case injects the `ContainerRuntimeProbe` from
 * `lib/container_runtime.ts` plus a fake consent driver, step runner and
 * package-manager check, so the whole flow runs on a host with neither
 * Homebrew nor Apple `container` installed.
 *
 * The highest-severity case is `container system start` failing: a runtime
 * that is not answering must never be reported as ok (Issue #3234).
 *
 * The kernel cases (Issue #4217) cover the inverse trap: a runtime that *is*
 * answering but has no default kernel, which passes `container system status`
 * and then fails every image build. Those inject the kernel check too, so the
 * suite stays hermetic on a host with no `container` binary at all.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  candidatesForPlatform,
  type ContainerRuntimeProbe,
} from "../lib/container_runtime.ts";
import {
  type AppleKernelStatus,
  consentSuppressionReason,
  ensureContainerRuntime,
  repairContainerRuntime,
} from "../setup/container_runtime_install.ts";
import type { InstallStep } from "../setup/prerequisite_install_plan.ts";
import type { AllPrerequisitesResult } from "../setup/prerequisites.ts";

/** Probe answers, replayed one per call so a re-probe can differ. */
function scriptedProbe(
  answers: Array<{ available: boolean; path?: string; reason?: string }>,
  calls: string[] = [],
): ContainerRuntimeProbe {
  let index = 0;
  return (candidate) => {
    calls.push(candidate.kind);
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return Promise.resolve(answer!);
  };
}

/** The probe answer a host without the `container` binary produces. */
const BINARY_ABSENT = {
  available: false,
  reason: "`container` was not found on PATH",
};

/** The probe answer a host with the binary but a stopped service produces. */
const SERVICE_STOPPED = {
  available: false,
  path: "container",
  reason: "`container system status` exited 1: XPC connection error",
};

/** The kernel answer a host that can build images produces. */
const KERNEL_PRESENT: AppleKernelStatus = {
  configured: true,
  determined: true,
};

/**
 * The kernel answer a running-but-unusable host produces: the API server
 * answers, and no default kernel is configured for the architecture
 * (Issue #4217).
 */
const KERNEL_ABSENT: AppleKernelStatus = {
  configured: false,
  determined: true,
  reason: "no default kernel is configured for arm64",
};

/** Kernel answers, replayed one per call so a re-check can differ. */
function scriptedKernelStatus(
  answers: readonly AppleKernelStatus[],
): () => Promise<AppleKernelStatus> {
  let index = 0;
  return () => {
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    return Promise.resolve(answer!);
  };
}

/** A host whose kernel is configured, for the cases that are not about kernels. */
const kernelConfigured = () => Promise.resolve(KERNEL_PRESENT);

/** Records every step it is asked to run and reports them all successful. */
function recordingRunner(ran: string[][], fail?: string) {
  return (step: InstallStep) => {
    ran.push([...step.command]);
    const failed = fail !== undefined && step.command.join(" ").includes(fail);
    return Promise.resolve({
      success: !failed,
      output: failed ? "Error: failed to start the container service" : "",
    });
  };
}

const consentYes = () => Promise.resolve(true);
const consentNo = () => Promise.resolve(false);
const brewPresent = () => Promise.resolve(true);
const brewAbsent = () => Promise.resolve(false);

// ---------------------------------------------------------------------------
// Binary absent — install, start, re-probe
// ---------------------------------------------------------------------------

Deno.test("ensureContainerRuntime - binary absent + consent installs, starts and re-probes ok", async () => {
  const ran: string[][] = [];
  const probeCalls: string[] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([
      BINARY_ABSENT,
      { available: true, path: "container" },
    ], probeCalls),
    consent: consentYes,
    runStep: recordingRunner(ran),
    packageManagerAvailable: brewPresent,
    // This case is about the install, not the kernel: a fresh `system start`
    // with `--enable-kernel-install` leaves one configured.
    kernelStatus: kernelConfigured,
  });

  assert(outcome.ok, `install flow failed: ${outcome.messages.join(" | ")}`);
  assertEquals(outcome.status, "installed");
  // Install first, then the service start — order matters. The start must
  // carry `--enable-kernel-install`: the step runs with stdin closed, and
  // without the flag a first start prompts for the default kernel and dies
  // with "Error: failed to read user input", leaving a kernel-less runtime.
  assertEquals(ran, [
    ["brew", "install", "container"],
    ["container", "system", "start", "--enable-kernel-install"],
  ]);
  // The re-probe runs in the same call, so the operator sees a fresh ✓.
  assertEquals(probeCalls, ["apple-container", "apple-container"]);
  assertEquals(outcome.descriptor?.kind, "apple-container");
});

// ---------------------------------------------------------------------------
// Binary present, service stopped — start only
// ---------------------------------------------------------------------------

Deno.test("ensureContainerRuntime - binary present but service stopped offers only the start", async () => {
  const ran: string[][] = [];
  const asked: string[] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([
      SERVICE_STOPPED,
      { available: true, path: "container" },
    ]),
    consent: (request) => {
      asked.push(request.question);
      return Promise.resolve(true);
    },
    runStep: recordingRunner(ran),
    // Homebrew is irrelevant here: a stopped service needs no reinstall.
    packageManagerAvailable: () => {
      throw new Error("the package manager must not be probed");
    },
    kernelStatus: kernelConfigured,
  });

  assert(outcome.ok);
  assertEquals(outcome.status, "started");
  assertEquals(ran, [[
    "container",
    "system",
    "start",
    "--enable-kernel-install",
  ]]);
  assertEquals(asked.length, 1);
  // The consent question names the exact argv, kernel download included.
  assertStringIncludes(
    asked[0]!,
    "container system start --enable-kernel-install",
  );
  assert(
    !asked[0]!.includes("brew install"),
    "a stopped service must not be offered a reinstall",
  );
});

// ---------------------------------------------------------------------------
// The start fails — never reported as ok (Issue #3234)
// ---------------------------------------------------------------------------

Deno.test("ensureContainerRuntime - a failed system start keeps the check failed", async () => {
  const ran: string[][] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([BINARY_ABSENT, {
      available: true,
      path: "container",
    }]),
    consent: consentYes,
    runStep: recordingRunner(ran, "system start"),
    packageManagerAvailable: brewPresent,
  });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.descriptor, undefined);
  // The runtime's own diagnostic output is surfaced, not swallowed.
  assertStringIncludes(outcome.messages.join("\n"), "failed to start");
  // The probe answers here, but an answering probe never masks a failed step:
  // a start that died half-way (e.g. on the kernel install) leaves a runtime
  // that cannot be trusted as configured. The hint says what to finish.
  assertStringIncludes(outcome.hint ?? "", "container system start");
  assertStringIncludes(outcome.hint ?? "", "failed");
});

Deno.test("ensureContainerRuntime - a failed start reports the host as it is now, not the pre-install probe", async () => {
  // `brew install` succeeds, the start fails, and the re-probe now finds the
  // binary with a stopped service. The hint must carry that fresh reason —
  // "`container` was not found on PATH" would describe a host the successful
  // install step just changed.
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([BINARY_ABSENT, SERVICE_STOPPED]),
    consent: consentYes,
    runStep: recordingRunner([], "system start"),
    packageManagerAvailable: brewPresent,
  });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, "failed");
  assertStringIncludes(outcome.hint ?? "", "XPC connection error");
  assert(
    !(outcome.hint ?? "").includes("not found on PATH"),
    `stale pre-install reason survived into the hint: ${outcome.hint}`,
  );
});

Deno.test("ensureContainerRuntime - a started-but-unhealthy runtime is not ok", async () => {
  // Every step succeeds, but the re-probe still says the runtime is not
  // answering: the outcome must follow the probe, never the steps.
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([SERVICE_STOPPED]),
    consent: consentYes,
    runStep: recordingRunner([]),
  });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, "failed");
  assertStringIncludes(outcome.hint ?? "", "container system start");
});

// ---------------------------------------------------------------------------
// No Homebrew — no install offered at all
// ---------------------------------------------------------------------------

Deno.test("ensureContainerRuntime - brew absent runs nothing and keeps the manual hint", async () => {
  const ran: string[][] = [];
  const asked: string[] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([BINARY_ABSENT]),
    consent: (request) => {
      asked.push(request.question);
      return Promise.resolve(true);
    },
    runStep: recordingRunner(ran),
    packageManagerAvailable: brewAbsent,
  });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, "no-plan");
  assertEquals(ran, [], "no command may run without Homebrew");
  assertEquals(asked, [], "consent must not be sought with nothing to offer");
  assertStringIncludes(
    outcome.hint ?? "",
    "https://github.com/apple/container",
  );
});

// ---------------------------------------------------------------------------
// Decline
// ---------------------------------------------------------------------------

Deno.test("ensureContainerRuntime - declining leaves the failure and the hint unchanged", async () => {
  const ran: string[][] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([BINARY_ABSENT]),
    consent: consentNo,
    runStep: recordingRunner(ran),
    packageManagerAvailable: brewPresent,
  });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, "declined");
  assertEquals(ran, [], "a declined offer must run no command");
  assertStringIncludes(
    outcome.hint ?? "",
    "https://github.com/apple/container",
  );
});

// ---------------------------------------------------------------------------
// --auto-install and the withheld offer (Issue #33)
// ---------------------------------------------------------------------------

Deno.test("ensureContainerRuntime - --auto-install consents without a prompt and says so", async () => {
  const ran: string[][] = [];
  // No consent injected: --auto-install must supply the consent itself.
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    autoInstall: true,
    probe: scriptedProbe([
      BINARY_ABSENT,
      { available: true, path: "container" },
    ]),
    runStep: recordingRunner(ran),
    packageManagerAvailable: brewPresent,
    kernelStatus: kernelConfigured,
  });

  assert(outcome.ok, `auto-install failed: ${outcome.messages.join(" | ")}`);
  assertEquals(outcome.status, "installed");
  assertEquals(ran, [
    ["brew", "install", "container"],
    ["container", "system", "start", "--enable-kernel-install"],
  ]);
  // Pre-consent is never a silent yes: the approval is in the messages.
  assert(
    outcome.messages.some((m) => m.startsWith("--auto-install consented to:")),
    `no approval message in: ${outcome.messages.join(" | ")}`,
  );
});

Deno.test("ensureContainerRuntime - a withheld offer is reported, never silent", async () => {
  // Pin the suppression to the environment variable rather than the ambient
  // TTY, so the case is deterministic whether the suite runs under CI or an
  // interactive terminal (where the default consent would otherwise prompt).
  const original = Deno.env.get("VIBE_NO_AUTO_INSTALL");
  Deno.env.set("VIBE_NO_AUTO_INSTALL", "true");
  try {
    const outcome = await ensureContainerRuntime({
      platform: "darwin",
      probe: scriptedProbe([BINARY_ABSENT]),
      runStep: () => {
        throw new Error("no step may run without consent");
      },
      packageManagerAvailable: brewPresent,
    });

    assertEquals(outcome.ok, false);
    assertEquals(outcome.status, "declined");
    const withheld = outcome.messages.find((m) =>
      m.includes("offer was withheld")
    );
    assert(
      withheld,
      `no withheld-offer message in: ${outcome.messages.join(" | ")}`,
    );
    assertStringIncludes(withheld!, "Apple container");
    assertStringIncludes(withheld!, "VIBE_NO_AUTO_INSTALL=true is set");
    assertStringIncludes(withheld!, "--auto-install");
  } finally {
    if (original === undefined) Deno.env.delete("VIBE_NO_AUTO_INSTALL");
    else Deno.env.set("VIBE_NO_AUTO_INSTALL", original);
  }
});

Deno.test("consentSuppressionReason - names the environment opt-out", () => {
  const original = Deno.env.get("VIBE_NO_AUTO_INSTALL");
  Deno.env.set("VIBE_NO_AUTO_INSTALL", "true");
  try {
    assertEquals(
      consentSuppressionReason(),
      "VIBE_NO_AUTO_INSTALL=true is set",
    );
  } finally {
    if (original === undefined) Deno.env.delete("VIBE_NO_AUTO_INSTALL");
    else Deno.env.set("VIBE_NO_AUTO_INSTALL", original);
  }
});

// ---------------------------------------------------------------------------
// Already available
// ---------------------------------------------------------------------------

Deno.test("ensureContainerRuntime - an answering runtime installs nothing", async () => {
  const ran: string[][] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([{ available: true, path: "container" }]),
    consent: () => {
      throw new Error("consent must not be sought when the runtime answers");
    },
    runStep: recordingRunner(ran),
    kernelStatus: kernelConfigured,
  });

  assert(outcome.ok);
  assertEquals(outcome.status, "already-available");
  assertEquals(ran, []);
});

// ---------------------------------------------------------------------------
// A running service is not a usable runtime without a kernel (Issue #4217)
// ---------------------------------------------------------------------------

Deno.test("ensureContainerRuntime - an answering runtime with no default kernel configures one", async () => {
  const ran: string[][] = [];
  const asked: string[] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    // `container system status` passes: the API server is up. It reports
    // nothing about the kernel, which is how a host stays green in setup and
    // then dies at image_build on every single run.
    probe: scriptedProbe([{ available: true, path: "container" }]),
    kernelStatus: scriptedKernelStatus([KERNEL_ABSENT, KERNEL_PRESENT]),
    consent: (request) => {
      asked.push(request.question);
      return Promise.resolve(true);
    },
    runStep: recordingRunner(ran),
    // A missing kernel is not an install problem — brew must stay untouched.
    packageManagerAvailable: () => {
      throw new Error("the package manager must not be probed");
    },
  });

  assert(outcome.ok, `kernel flow failed: ${outcome.messages.join(" | ")}`);
  assertEquals(outcome.status, "kernel-configured");
  assertEquals(ran, [[
    "container",
    "system",
    "kernel",
    "set",
    "--recommended",
  ]]);
  assertEquals(asked.length, 1);
  assertStringIncludes(asked[0]!, "container system kernel set --recommended");
  assert(
    !asked[0]!.includes("brew install"),
    "a kernel-less runtime must not be offered a reinstall",
  );
});

Deno.test("ensureContainerRuntime - a service start is followed by the kernel check", async () => {
  const ran: string[][] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([
      SERVICE_STOPPED,
      { available: true, path: "container" },
    ]),
    // `--enable-kernel-install` covers a *first* start; a service that was
    // already initialised without a kernel still needs the explicit set.
    kernelStatus: scriptedKernelStatus([KERNEL_ABSENT, KERNEL_PRESENT]),
    consent: consentYes,
    runStep: recordingRunner(ran),
  });

  assert(outcome.ok, `kernel flow failed: ${outcome.messages.join(" | ")}`);
  assertEquals(ran, [
    ["container", "system", "start", "--enable-kernel-install"],
    ["container", "system", "kernel", "set", "--recommended"],
  ]);
});

Deno.test("ensureContainerRuntime - a failed kernel set is never reported ok", async () => {
  const ran: string[][] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([{ available: true, path: "container" }]),
    kernelStatus: scriptedKernelStatus([KERNEL_ABSENT]),
    consent: consentYes,
    runStep: recordingRunner(ran, "kernel set"),
  });

  // The step exited non-zero and the kernel is still absent: a runtime that
  // cannot build an image must not carry a green tick (Issue #3234).
  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, "failed");
  assertStringIncludes(outcome.hint ?? "", "container system kernel set");
});

Deno.test("ensureContainerRuntime - a kernel set that leaves no kernel is not ok", async () => {
  // The step exits zero and the kernel is still absent — the re-check, not the
  // exit status, decides (Issue #3234).
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([{ available: true, path: "container" }]),
    kernelStatus: scriptedKernelStatus([KERNEL_ABSENT]),
    consent: consentYes,
    runStep: recordingRunner([]),
  });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, "failed");
  assertEquals(outcome.descriptor, undefined);
});

Deno.test("ensureContainerRuntime - declining the kernel leaves the check failed", async () => {
  const ran: string[][] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([{ available: true, path: "container" }]),
    kernelStatus: scriptedKernelStatus([KERNEL_ABSENT]),
    consent: consentNo,
    runStep: recordingRunner(ran),
  });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, "declined");
  assertEquals(ran, []);
  assertStringIncludes(outcome.hint ?? "", "container system kernel set");
});

Deno.test("ensureContainerRuntime - a kernel check that cannot answer is not a pass", async () => {
  const ran: string[][] = [];
  const outcome = await ensureContainerRuntime({
    platform: "darwin",
    probe: scriptedProbe([{ available: true, path: "container" }]),
    // Neither "configured" nor "absent" — `container system status` could not
    // be parsed. Guessing "configured" is what puts a kernel-less host into
    // production, so an unknown answer stays a failure.
    kernelStatus: scriptedKernelStatus([{
      configured: false,
      determined: false,
      reason: "`container system status --format json` exited 1",
    }]),
    consent: consentNo,
    runStep: recordingRunner(ran),
  });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, "failed");
  assertEquals(ran, []);
});

// ---------------------------------------------------------------------------
// Only macOS has a kernel to configure
// ---------------------------------------------------------------------------

Deno.test("ensureContainerRuntime - Linux never runs the Apple kernel check", async () => {
  const outcome = await ensureContainerRuntime({
    platform: "linux",
    probe: scriptedProbe([{ available: true, path: "docker" }]),
    kernelStatus: () => {
      throw new Error("the Apple kernel check must not run off macOS");
    },
    consent: consentNo,
    runStep: recordingRunner([]),
  });

  assertEquals(outcome.status, "no-plan");
});

// ---------------------------------------------------------------------------
// Platforms with no runtime plan
// ---------------------------------------------------------------------------

Deno.test("ensureContainerRuntime - Linux has no auto-install and keeps its hints", async () => {
  const ran: string[][] = [];
  const outcome = await ensureContainerRuntime({
    platform: "linux",
    probe: scriptedProbe([BINARY_ABSENT]),
    consent: consentYes,
    runStep: recordingRunner(ran),
    packageManagerAvailable: brewPresent,
  });

  assertEquals(outcome.ok, false);
  assertEquals(outcome.status, "no-plan");
  assertEquals(ran, []);
});

// ---------------------------------------------------------------------------
// The boundary must not widen (Issue #4060)
// ---------------------------------------------------------------------------

Deno.test("candidatesForPlatform - macOS still lists only Apple container", () => {
  assertEquals(candidatesForPlatform("darwin").map((c) => c.kind), [
    "apple-container",
  ]);
});

// ---------------------------------------------------------------------------
// Wiring into the prerequisite report
// ---------------------------------------------------------------------------

/** The aggregate report a fresh macOS host produces today. */
function failedReport(): AllPrerequisitesResult {
  return {
    ok: false,
    results: [
      { ok: true, tool: "git", message: "git is installed" },
      {
        ok: false,
        tool: "container runtime",
        message: "No supported container runtime is available on darwin.",
        hint: "install Apple container from https://github.com/apple/container",
      },
    ],
  };
}

Deno.test("repairContainerRuntime - a successful install flips the report to ok", async () => {
  const repaired = await repairContainerRuntime(failedReport(), {
    platform: "darwin",
    probe: scriptedProbe([
      BINARY_ABSENT,
      { available: true, path: "container" },
    ]),
    consent: consentYes,
    runStep: recordingRunner([]),
    packageManagerAvailable: brewPresent,
    kernelStatus: kernelConfigured,
  });

  assertEquals(repaired.ok, true);
  const runtime = repaired.results.find((r) => r.tool === "container runtime");
  assertEquals(runtime?.ok, true);
  assertStringIncludes(runtime?.message ?? "", "Apple container");
  assertStringIncludes(runtime?.message ?? "", "answering");
});

Deno.test("repairContainerRuntime - a failed install leaves the report failed", async () => {
  const repaired = await repairContainerRuntime(failedReport(), {
    platform: "darwin",
    probe: scriptedProbe([BINARY_ABSENT]),
    consent: consentNo,
    runStep: recordingRunner([]),
    packageManagerAvailable: brewPresent,
  });

  assertEquals(repaired.ok, false);
  const runtime = repaired.results.find((r) => r.tool === "container runtime");
  assertEquals(runtime?.ok, false);
  assertStringIncludes(runtime?.hint ?? "", "github.com/apple/container");
});

Deno.test("repairContainerRuntime - a passing report is returned untouched", async () => {
  const passing: AllPrerequisitesResult = {
    ok: true,
    results: [{
      ok: true,
      tool: "container runtime",
      message: "Apple container is installed and answering (container)",
    }],
  };

  const repaired = await repairContainerRuntime(passing, {
    platform: "darwin",
    probe: () => {
      throw new Error("a passing report must not be re-probed");
    },
    consent: consentYes,
  });

  assertEquals(repaired, passing);
});
