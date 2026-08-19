/**
 * Tests for the Linux container-runtime install offer (Issue #4137).
 *
 * Every case drives the real driver (`offerMissingPrerequisites`) against a
 * fake Linux host: the container-runtime probe, the apt availability check and
 * the step runner are all injected, so the suite never spawns `apt-get`,
 * `systemctl` or `podman` and runs identically on macOS.
 *
 * The fake host lives in `fixtures/container_runtime_host.ts` — it is state,
 * not a script, so a test fails when the offer order, the absent/stopped split
 * or the re-probe honesty regresses, not merely when a string moves. The
 * Windows half of the same offer is exercised in
 * `container_runtime_install_windows_test.ts` (Issue #4185).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  host,
  offer,
  ran,
  runtimeFailure,
  runtimeOutcome,
} from "./fixtures/container_runtime_host.ts";

// ── Offer order follows the probe order ─────────────────────────────────

Deno.test("linux runtime offer - both absent: Docker is installed first and Podman is never offered", async () => {
  const state = host();

  const result = await offer(state, { answer: () => true });

  assertEquals(ran(state), ["sudo apt-get install -y docker.io"]);
  assertEquals(state.questions.length, 1, "Podman must not be offered too");
  assertStringIncludes(state.questions[0]!, "Docker");
  assertEquals(runtimeOutcome(result.outcomes).status, "installed");

  // The re-probe, not the exit code, is what flips the check in this same run.
  const runtime = result.results.find((r) => r.tool === "container runtime")!;
  assertEquals(runtime.ok, true);
  assertStringIncludes(runtime.message, "Docker");
  assertEquals(result.ok, true);
});

Deno.test("linux runtime offer - Docker declined falls through to Podman", async () => {
  const state = host();

  const result = await offer(state, { answer: (q) => !q.includes("Docker") });

  assertEquals(ran(state), ["sudo apt-get install -y podman"]);
  assertEquals(state.questions.length, 2);
  assertStringIncludes(state.questions[0]!, "Docker");
  assertStringIncludes(state.questions[1]!, "Podman");
  assertEquals(runtimeOutcome(result.outcomes).status, "installed");
  assertEquals(result.ok, true);
});

Deno.test("linux runtime offer - both declined keeps today's failure and exits non-zero", async () => {
  const state = host();

  const result = await offer(state);

  assertEquals(ran(state), [], "a decline must run nothing");
  assertEquals(state.questions.length, 2);
  assertEquals(runtimeOutcome(result.outcomes).status, "declined");

  const runtime = result.results.find((r) => r.tool === "container runtime")!;
  assertEquals(runtime.ok, false);
  assertEquals(runtime.message, runtimeFailure().message);
  assertEquals(runtime.hint, runtimeFailure().hint);
  assertEquals(result.ok, false, "a declined install is never masked as ok");
});

// ── Absent vs stopped ───────────────────────────────────────────────────

Deno.test("linux runtime offer - Docker present but stopped is started, not installed", async () => {
  const state = host({ docker: { installed: true, answering: false } });

  const result = await offer(state, { answer: () => true });

  assertEquals(ran(state), ["sudo systemctl start docker"]);
  assertEquals(runtimeOutcome(result.outcomes).status, "started");
  assertEquals(result.results[0]!.ok, true);
  assertEquals(result.ok, true);
});

Deno.test("linux runtime offer - Podman present but not answering starts its machine", async () => {
  // Docker absent with no apt package available, so the offer reaches Podman.
  const state = host({
    packageManager: false,
    podman: { installed: true, answering: false },
  });

  const result = await offer(state, { answer: () => true });

  assertEquals(ran(state), ["podman machine start"]);
  assertEquals(runtimeOutcome(result.outcomes).status, "started");
  assertEquals(result.ok, true);
});

// ── Sudo transparency ───────────────────────────────────────────────────

Deno.test("linux runtime offer - the prompt shows the exact sudo command before it runs", async () => {
  const state = host();

  await offer(state, { answer: () => true });

  const question = state.questions[0]!;
  assertStringIncludes(question, "sudo apt-get install -y docker.io");
  assertStringIncludes(question.toLowerCase(), "sudo");
  assertStringIncludes(question.toLowerCase(), "password");
  assertStringIncludes(question, "[y/N]");

  // Nothing may run that the operator was not shown.
  for (const argv of state.commands) {
    assertStringIncludes(question, argv.join(" "));
  }
});

Deno.test("linux runtime offer - the start prompt shows its sudo command too", async () => {
  const state = host({ docker: { installed: true, answering: false } });

  await offer(state, { answer: () => true });

  const question = state.questions[0]!;
  assertStringIncludes(question, "sudo systemctl start docker");
  assertStringIncludes(question.toLowerCase(), "password");
});

// ── Permission-error honesty (Issue #3234) ──────────────────────────────

Deno.test("linux runtime offer - an install that leaves a permission error stays failed", async () => {
  const state = host();

  const result = await offer(state, {
    answer: () => true,
    // The package installs and the daemon runs, but the invoking user is
    // outside the docker group — exactly what a fresh `docker.io` leaves.
    run: (target) => {
      target.docker = {
        installed: true,
        answering: true,
        permissionDenied: true,
      };
      return { ok: true };
    },
  });

  assertEquals(ran(state), ["sudo apt-get install -y docker.io"]);
  assertEquals(runtimeOutcome(result.outcomes).status, "failed");
  assertEquals(result.results[0]!.ok, false, "a permission gap is not success");
  assertEquals(result.ok, false);

  // The operator is told exactly how to fix it — and that setup did not.
  const guidance = `${state.lines.join("\n")}\n${
    result.results[0]!.hint ?? ""
  }`;
  assertStringIncludes(guidance, "usermod -aG docker");
  assertStringIncludes(guidance.toLowerCase(), "log");

  // Group membership is never changed as a side effect of the check.
  assert(
    !ran(state).some((line) => line.includes("usermod")),
    `setup must not run usermod itself, got: ${ran(state).join(" | ")}`,
  );
});

Deno.test("linux runtime offer - a failing install command leaves the check failed", async () => {
  const state = host();

  // apt-get exits non-zero: the package is not installed.
  const result = await offer(state, {
    answer: () => true,
    run: () => ({ ok: false }),
  });

  // A failed Docker install never cascades into installing Podman as well.
  assertEquals(ran(state), ["sudo apt-get install -y docker.io"]);
  const outcome = runtimeOutcome(result.outcomes);
  assertEquals(outcome.status, "failed");
  assertStringIncludes(String(outcome.detail), "100");
  assertEquals(result.ok, false);
});

// ── No apt ⇒ no offer ───────────────────────────────────────────────────

Deno.test("linux runtime offer - a non-apt distribution runs nothing and keeps the hints", async () => {
  const state = host({ packageManager: false });

  const result = await offer(state, { answer: () => true });

  assertEquals(ran(state), [], "no package manager means no command");
  assertEquals(state.questions, [], "nothing may be offered without a plan");
  assertEquals(runtimeOutcome(result.outcomes).status, "no-plan");
  assertEquals(result.results, [runtimeFailure()]);
  assertEquals(result.ok, false);
  assert(
    state.lines.some((l) => l.includes("no install plan")),
    `the manual hint must be summarised, got: ${state.lines.join(" | ")}`,
  );
});

// ── Other platforms are untouched ───────────────────────────────────────
//
// Windows now has its own offer (Issue #4185) — see
// container_runtime_install_windows_test.ts. macOS never gets one: Apple
// `container` is its only runtime (Issue #4060) and is repaired by its own
// flow before this driver runs.

Deno.test("linux runtime offer - macOS is not offered a Docker install", async () => {
  const state = host();

  const result = await offer(state, { answer: () => true, platform: "darwin" });

  assertEquals(ran(state), []);
  assertEquals(state.questions, []);
  assertEquals(runtimeOutcome(result.outcomes).status, "no-plan");
});
