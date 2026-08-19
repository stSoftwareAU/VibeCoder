/**
 * Tests for setup/prerequisite_installer.ts
 *
 * Issue #4135: Offer to install missing prerequisites when setup is
 * interactive, with per-tool consent.
 *
 * Every case injects the TTY check, the prompt, the step runner, the plan
 * lookup and the re-probe, so the suite never prompts, never spawns `brew`,
 * and never touches the host it runs on.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type InstallerReporter,
  type InstallOutcome,
  offerMissingPrerequisites,
  type PrerequisiteInstallerOptions,
} from "../setup/prerequisite_installer.ts";
import type {
  AllPrerequisitesResult,
  PrerequisiteResult,
} from "../setup/prerequisites.ts";
import { checkAllPrerequisites } from "../setup/prerequisites.ts";
import type { InstallPlan } from "../setup/prerequisite_install_plan.ts";
import type { ContainerRuntimeProbe } from "../lib/container_runtime.ts";

// ── Fixtures ────────────────────────────────────────────────────────────

function ok(tool: string, informational = false): PrerequisiteResult {
  return {
    ok: true,
    tool,
    message: `${tool} is installed`,
    ...(informational ? { informational: true } : {}),
  };
}

function failed(tool: string, informational = false): PrerequisiteResult {
  return {
    ok: false,
    tool,
    message: `${tool} is not installed`,
    hint: `Install with: brew install ${tool}`,
    ...(informational ? { informational: true } : {}),
  };
}

function probeOf(...results: PrerequisiteResult[]): AllPrerequisitesResult {
  return {
    ok: results.filter((r) => !r.informational).every((r) => r.ok),
    results,
  };
}

/** A two-step Homebrew plan, so step ordering is observable. */
function brewPlan(tool: string): InstallPlan {
  return {
    tool,
    platform: "darwin",
    packageManager: "brew",
    steps: [
      { command: ["brew", "update"], description: `Update Homebrew` },
      {
        command: ["brew", "install", tool],
        description: `Install ${tool} with Homebrew`,
      },
    ],
  };
}

/** Reporter that records every line it is handed, tagged by level. */
function recorder(): { lines: string[]; reporter: InstallerReporter } {
  const lines: string[] = [];
  return {
    lines,
    reporter: {
      info: (m) => lines.push(`info: ${m}`),
      success: (m) => lines.push(`success: ${m}`),
      error: (m) => lines.push(`error: ${m}`),
    },
  };
}

/** Options that make every injection loud if it is used unexpectedly. */
function baseOptions(
  overrides: Partial<PrerequisiteInstallerOptions> = {},
): PrerequisiteInstallerOptions {
  return {
    platform: "darwin",
    isTerminal: () => true,
    noAutoInstall: false,
    confirm: () => {
      throw new Error("confirm must not be called");
    },
    runStep: () => {
      throw new Error("runStep must not be called");
    },
    resolvePlan: (tool) => Promise.resolve(brewPlan(tool)),
    recheck: () => {
      throw new Error("recheck must not be called");
    },
    ...overrides,
  };
}

function outcomeFor(
  outcomes: readonly InstallOutcome[],
  tool: string,
): InstallOutcome {
  const found = outcomes.find((o) => o.tool === tool);
  assert(found, `no outcome recorded for ${tool}`);
  return found;
}

// ── Non-TTY parity — the highest-blast-radius guard ─────────────────────

Deno.test("offerMissingPrerequisites - non-TTY changes no check, and says the offer was withheld", async () => {
  const probe = probeOf(ok("git"), failed("deno"), failed("jq", true));
  const { lines, reporter } = recorder();

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({ isTerminal: () => false, reporter }),
  );

  assertEquals(result.offered, false);
  assertEquals(result.outcomes, []);
  assertEquals(result.ok, probe.ok);
  assertEquals(result.results, probe.results);
  // The report is never silent about a withheld offer (Issue #33): it names
  // every installable tool, the reason, and both remedies.
  assertEquals(lines.length, 1);
  assertStringIncludes(
    lines[0]!,
    "info: Auto-install is available for: deno, jq",
  );
  assertStringIncludes(lines[0]!, "stdin is not a terminal");
  assertStringIncludes(lines[0]!, "--auto-install");
});

Deno.test("offerMissingPrerequisites - non-TTY with no plan for any failure stays silent", async () => {
  const probe = probeOf(failed("deno"));
  const { lines, reporter } = recorder();

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      isTerminal: () => false,
      resolvePlan: () => Promise.resolve(null),
      reporter,
    }),
  );

  assertEquals(result.offered, false);
  assertEquals(result.results, probe.results);
  assertEquals(
    lines,
    [],
    "nothing was installable, so there is nothing to say",
  );
});

Deno.test("offerMissingPrerequisites - VIBE_NO_AUTO_INSTALL opts out of the offer, visibly", async () => {
  const probe = probeOf(failed("deno"));
  const { lines, reporter } = recorder();

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({ noAutoInstall: true, reporter }),
  );

  assertEquals(result.offered, false);
  assertEquals(result.results, probe.results);
  assertEquals(result.ok, false);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "VIBE_NO_AUTO_INSTALL=true is set");
});

Deno.test("offerMissingPrerequisites - reads VIBE_NO_AUTO_INSTALL from the environment", async () => {
  const original = Deno.env.get("VIBE_NO_AUTO_INSTALL");
  Deno.env.set("VIBE_NO_AUTO_INSTALL", "true");
  try {
    const probe = probeOf(failed("deno"));
    const { lines, reporter } = recorder();
    const opts = baseOptions({ reporter });
    delete opts.noAutoInstall;
    const result = await offerMissingPrerequisites(probe, opts);
    assertEquals(result.offered, false);
    assertEquals(result.results, probe.results);
    assertEquals(lines.length, 1);
    assertStringIncludes(lines[0]!, "VIBE_NO_AUTO_INSTALL=true is set");
  } finally {
    if (original === undefined) Deno.env.delete("VIBE_NO_AUTO_INSTALL");
    else Deno.env.set("VIBE_NO_AUTO_INSTALL", original);
  }
});

// ── --auto-install: the one sanctioned pre-consent (Issue #33) ──────────

Deno.test("offerMissingPrerequisites - --auto-install installs without a terminal and reports each approval", async () => {
  const probe = probeOf(failed("deno"));
  const { lines, reporter } = recorder();
  const commands: string[][] = [];

  const opts = baseOptions({
    isTerminal: () => false,
    autoInstall: true,
    runStep: (step) => {
      commands.push([...step.command]);
      return Promise.resolve({ ok: true, code: 0 });
    },
    recheck: (tool) =>
      Promise.resolve({ ok: true, tool, message: `${tool} is installed` }),
    reporter,
  });
  // No injected confirm: --auto-install must supply the consent itself.
  delete opts.confirm;
  const result = await offerMissingPrerequisites(probe, opts);

  assertEquals(result.offered, true);
  assertEquals(commands, [["brew", "update"], ["brew", "install", "deno"]]);
  assertEquals(outcomeFor(result.outcomes, "deno").status, "installed");
  assertEquals(result.ok, true);
  // Each approval is visible — pre-consent is never a silent yes.
  assert(
    lines.some((line) => line.startsWith("info: --auto-install consented to:")),
    `no approval line in: ${JSON.stringify(lines)}`,
  );
});

Deno.test("offerMissingPrerequisites - --auto-install outranks VIBE_NO_AUTO_INSTALL", async () => {
  const probe = probeOf(failed("deno"));
  const { reporter } = recorder();

  const opts = baseOptions({
    isTerminal: () => false,
    noAutoInstall: true,
    autoInstall: true,
    runStep: () => Promise.resolve({ ok: true, code: 0 }),
    recheck: (tool) =>
      Promise.resolve({ ok: true, tool, message: `${tool} is installed` }),
    reporter,
  });
  delete opts.confirm;
  const result = await offerMissingPrerequisites(probe, opts);

  assertEquals(result.offered, true);
  assertEquals(result.ok, true);
});

Deno.test("offerMissingPrerequisites - the withheld notice judges the runtime through its candidates", async () => {
  const probe = probeOf(failed("container runtime"));
  const { lines, reporter } = recorder();

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      platform: "linux",
      isTerminal: () => false,
      // Docker has a plan on this host; Podman does not — one is enough.
      resolvePlan: (tool) =>
        Promise.resolve(tool === "docker" ? brewPlan(tool) : null),
      reporter,
    }),
  );

  assertEquals(result.offered, false);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!, "container runtime");
});

// ── Consent ─────────────────────────────────────────────────────────────

Deno.test("offerMissingPrerequisites - consent runs the steps in order and re-probes", async () => {
  const probe = probeOf(ok("git"), failed("deno"));
  const commands: string[][] = [];
  const rechecked: string[] = [];
  const questions: string[] = [];

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      confirm: (question) => {
        questions.push(question);
        return Promise.resolve(true);
      },
      runStep: (step) => {
        commands.push([...step.command]);
        return Promise.resolve({ ok: true, code: 0 });
      },
      recheck: (tool) => {
        rechecked.push(tool);
        return Promise.resolve({
          ok: true,
          tool,
          message: `${tool} is installed`,
        });
      },
    }),
  );

  assertEquals(commands, [["brew", "update"], ["brew", "install", "deno"]]);
  assertEquals(rechecked, ["deno"]);
  assertEquals(questions.length, 1);
  assertStringIncludes(questions[0]!, "deno is not installed");
  assertStringIncludes(questions[0]!, "Homebrew");
  assertStringIncludes(questions[0]!, "[y/N]");

  assertEquals(result.offered, true);
  assertEquals(outcomeFor(result.outcomes, "deno").status, "installed");
  // The freshly-probed result replaces the stale failure in the same run.
  const deno = result.results.find((r) => r.tool === "deno")!;
  assertEquals(deno.ok, true);
  assertEquals(deno.hint, undefined);
  assertEquals(result.ok, true);
});

Deno.test("offerMissingPrerequisites - satisfied checks are never offered", async () => {
  const probe = probeOf(ok("git"), ok("deno"), ok("jq", true));

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      resolvePlan: () => {
        throw new Error("resolvePlan must not be called for a passing check");
      },
    }),
  );

  assertEquals(result.outcomes, []);
  assertEquals(result.results, probe.results);
  assertEquals(result.ok, true);
});

// ── Decline ─────────────────────────────────────────────────────────────

Deno.test("offerMissingPrerequisites - decline runs nothing and leaves the check failed", async () => {
  const probe = probeOf(failed("deno"));
  const { lines, reporter } = recorder();

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({ confirm: () => Promise.resolve(false), reporter }),
  );

  assertEquals(outcomeFor(result.outcomes, "deno").status, "declined");
  const deno = result.results.find((r) => r.tool === "deno")!;
  assertEquals(deno.ok, false);
  assertEquals(deno.hint, "Install with: brew install deno");
  assertEquals(result.ok, false);
  assert(
    lines.some((l) => l.includes("Declined")),
    `decline must be reported, got: ${lines.join(" | ")}`,
  );
});

// ── Failure is never masked as success (Issue #3234) ────────────────────

Deno.test("offerMissingPrerequisites - a step exiting non-zero leaves the check failed", async () => {
  const probe = probeOf(failed("deno"));
  const commands: string[][] = [];
  const { lines, reporter } = recorder();

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      confirm: () => Promise.resolve(true),
      runStep: (step) => {
        commands.push([...step.command]);
        return Promise.resolve({ ok: false, code: 3 });
      },
      // The re-probe is the only thing that decides the outcome.
      recheck: (tool) => Promise.resolve(failed(tool)),
      reporter,
    }),
  );

  // The failing step aborts the plan — later steps never run.
  assertEquals(commands, [["brew", "update"]]);
  const outcome = outcomeFor(result.outcomes, "deno");
  assertEquals(outcome.status, "failed");
  assertStringIncludes(String(outcome.detail), "3");
  assertEquals(result.results.find((r) => r.tool === "deno")!.ok, false);
  assertEquals(result.ok, false);
  assert(
    lines.some((l) => l.startsWith("error:") && l.includes("brew update")),
    `the failing command must be reported, got: ${lines.join(" | ")}`,
  );
});

Deno.test("offerMissingPrerequisites - a re-probe that still fails is not called installed", async () => {
  const probe = probeOf(failed("deno"));

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      confirm: () => Promise.resolve(true),
      runStep: () => Promise.resolve({ ok: true, code: 0 }),
      // Every step reported success, yet the tool is still absent.
      recheck: (tool) => Promise.resolve(failed(tool)),
    }),
  );

  assertEquals(outcomeFor(result.outcomes, "deno").status, "failed");
  assertEquals(result.ok, false);
});

// ── No plan ─────────────────────────────────────────────────────────────

Deno.test("offerMissingPrerequisites - no plan means no prompt and today's hint stands", async () => {
  const probe = probeOf(failed("git"));
  const { lines, reporter } = recorder();

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({ resolvePlan: () => Promise.resolve(null), reporter }),
  );

  assertEquals(outcomeFor(result.outcomes, "git").status, "no-plan");
  assertEquals(result.results, probe.results);
  assertEquals(result.ok, false);
  assert(
    lines.some((l) => l.includes("no install plan")),
    `a tool with no plan must be summarised, got: ${lines.join(" | ")}`,
  );
});

// ── The host-fatal / container-owned split (Issue #4117) ────────────────

Deno.test("offerMissingPrerequisites - a declined informational tool does not fail setup", async () => {
  const probe = probeOf(ok("git"), failed("jq", true));

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({ confirm: () => Promise.resolve(false) }),
  );

  assertEquals(outcomeFor(result.outcomes, "jq").status, "declined");
  assertEquals(result.results.find((r) => r.tool === "jq")!.ok, false);
  assertEquals(result.ok, true, "an informational failure is never fatal");
});

Deno.test("offerMissingPrerequisites - an installed informational tool keeps its flag", async () => {
  const probe = probeOf(failed("jq", true));

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      confirm: () => Promise.resolve(true),
      runStep: () => Promise.resolve({ ok: true, code: 0 }),
      recheck: (tool) => Promise.resolve(ok(tool, true)),
    }),
  );

  const jq = result.results.find((r) => r.tool === "jq")!;
  assertEquals(jq.ok, true);
  assertEquals(jq.informational, true);
});

Deno.test("checkAllPrerequisites - a failed informational jq keeps the aggregate ok", async () => {
  // Everything host-fatal present, jq (container-owned) absent.
  const available = ["git", "gh", "deno", "claude", "timeout"];
  const runner = (cmd: string[]) =>
    Promise.resolve(
      cmd[0] === "docker" && cmd[1] === "image"
        ? { success: true, stdout: "[]", stderr: "" }
        : cmd[0] === "gh" && cmd[1] === "auth"
        ? { success: true, stdout: "Logged in", stderr: "" }
        : cmd[0] === "gh" && cmd[1] === "api"
        ? { success: true, stdout: "worker", stderr: "" }
        : {
          success: available.includes(cmd[0]!),
          stdout: "",
          stderr: "",
        },
    );
  const probe: ContainerRuntimeProbe = (candidate) =>
    Promise.resolve(
      candidate.kind === "docker"
        ? { available: true, path: candidate.executable }
        : { available: false, reason: "not found" },
    );

  const result = await checkAllPrerequisites({
    os: "linux",
    repoRoot: new URL("../../../", import.meta.url).pathname,
    containerProbe: probe,
    runCommand: runner,
  });

  const jq = result.results.find((r) => r.tool === "jq")!;
  assertEquals(jq.ok, false);
  assertEquals(jq.informational, true);
  assertEquals(result.ok, true);
});

// ── Run mode (Issues #4149, #4): container is the only one ───────────────

Deno.test("offerMissingPrerequisites - container mode still offers the runtime", async () => {
  const probe = probeOf(failed("container runtime"));
  let offered = 0;

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      runMode: "container",
      platform: "linux",
      // The Linux offer walks the candidates itself; declining every one
      // leaves the check failed, which is the point being pinned here.
      confirm: () => {
        offered += 1;
        return Promise.resolve(false);
      },
      resolvePlan: (tool) => Promise.resolve(brewPlan(tool)),
      probeOptions: {
        containerProbe: () =>
          Promise.resolve({ available: false, reason: "not found" }),
      },
    }),
  );

  assert(offered > 0, "container mode must ask about the runtime");
  assertEquals(
    outcomeFor(result.outcomes, "container runtime").status,
    "declined",
  );
  assertEquals(result.ok, false);
});

Deno.test("offerMissingPrerequisites - the install offer follows the mode, not the plan table", async () => {
  // jq failed informationally (container mode) — the re-probe keeps that
  // classification, so installing it never makes it host-fatal, and declining
  // it never fails setup.
  const probe = probeOf(failed("jq", true));
  const asked: string[] = [];

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      runMode: "container",
      confirm: (question) => {
        asked.push(question);
        return Promise.resolve(false);
      },
    }),
  );

  assertEquals(asked.length, 1);
  assertEquals(outcomeFor(result.outcomes, "jq").status, "declined");
  assertEquals(result.ok, true);
});

Deno.test("offerMissingPrerequisites - the re-probe still decides: an image-owned tool that stays missing is failed but not fatal", async () => {
  // The #4135 invariant: every step exited zero, yet the fresh probe says the
  // tool is still missing, so the check stays failed; jq is image-owned in
  // container mode, so setup still passes.
  const probe = probeOf(failed("jq"));

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      runMode: "container",
      confirm: () => Promise.resolve(true),
      runStep: () => Promise.resolve({ ok: true, code: 0 }),
      recheck: (tool) =>
        Promise.resolve({ ...failed(tool), informational: true }),
    }),
  );

  assertEquals(outcomeFor(result.outcomes, "jq").status, "failed");
  assertEquals(result.ok, true, "an image-owned tool never fails setup");
});

// ── Multiple tools ──────────────────────────────────────────────────────

Deno.test("offerMissingPrerequisites - each failed tool gets its own prompt", async () => {
  const probe = probeOf(failed("deno"), failed("gh"), ok("git"));
  const answers: Record<string, boolean> = { deno: true, gh: false };
  const installed: string[] = [];
  const { lines, reporter } = recorder();

  const result = await offerMissingPrerequisites(
    probe,
    baseOptions({
      confirm: (question) =>
        Promise.resolve(
          Object.entries(answers).some(([tool, yes]) =>
            yes && question.startsWith(tool)
          ),
        ),
      runStep: (step) => {
        installed.push(step.command.join(" "));
        return Promise.resolve({ ok: true, code: 0 });
      },
      recheck: (tool) =>
        Promise.resolve({ ok: true, tool, message: `${tool} is installed` }),
      reporter,
    }),
  );

  assertEquals(installed, ["brew update", "brew install deno"]);
  assertEquals(outcomeFor(result.outcomes, "deno").status, "installed");
  assertEquals(outcomeFor(result.outcomes, "gh").status, "declined");
  assertEquals(result.ok, false, "the declined gh still fails setup");
  assert(
    lines.some((l) => l.includes("Installed") && l.includes("deno")),
    `the summary must name what was installed, got: ${lines.join(" | ")}`,
  );
});
