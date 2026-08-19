/**
 * Tests for the Windows container-runtime install offer (Issue #4185).
 *
 * Windows is container-only (Issue #4145), so the runtime is the one
 * prerequisite a Windows host cannot do without. Every case drives the real
 * driver (`offerMissingPrerequisites`) against the shared fake host: the probe,
 * the winget availability check and the step runner are injected, so nothing
 * here spawns `winget` and the suite runs identically on Linux and macOS.
 *
 * The Windows flow differs from the Linux one in exactly one behaviour: a
 * runtime that is installed but not answering has no start argv here — Docker
 * Desktop and the Podman machine are started by the operator — so setup offers
 * nothing rather than proposing a reinstall that would not fix it.
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

/** Drive the shared fake host as a Windows machine. */
function windowsOffer(
  state: ReturnType<typeof host>,
  answer?: (question: string) => boolean,
) {
  return offer(state, {
    platform: "windows",
    ...(answer ? { answer } : {}),
  });
}

// ── Offer order follows the probe order ─────────────────────────────────

Deno.test("windows runtime offer - both absent: Docker Desktop is offered first", async () => {
  const state = host();

  const result = await windowsOffer(state, () => true);

  assertEquals(ran(state), [
    "winget install --exact --id Docker.DockerDesktop --source winget " +
    "--accept-package-agreements --accept-source-agreements --silent",
  ]);
  assertEquals(state.questions.length, 1, "Podman must not be offered too");
  assertStringIncludes(state.questions[0]!, "Docker");
  assertStringIncludes(state.questions[0]!, "[y/N]");

  // The installer leaves Docker Desktop present but not running, so the
  // re-probe — never the winget exit code — keeps the check failed
  // (Issue #3234).
  assertEquals(runtimeOutcome(result.outcomes).status, "failed");
  assertEquals(result.results[0]!.ok, false);
  assertEquals(result.ok, false);
});

Deno.test("windows runtime offer - Docker declined falls through to Podman", async () => {
  const state = host();

  await windowsOffer(state, (q) => !q.includes("Docker"));

  assertEquals(ran(state), [
    "winget install --exact --id RedHat.Podman --source winget " +
    "--accept-package-agreements --accept-source-agreements --silent",
  ]);
  assertEquals(state.questions.length, 2);
  assertStringIncludes(state.questions[0]!, "Docker");
  assertStringIncludes(state.questions[1]!, "Podman");
});

Deno.test("windows runtime offer - both declined keeps today's failure", async () => {
  const state = host();

  const result = await windowsOffer(state);

  assertEquals(ran(state), [], "a decline must run nothing");
  assertEquals(state.questions.length, 2);
  assertEquals(runtimeOutcome(result.outcomes).status, "declined");
  assertEquals(result.results, [runtimeFailure("windows")]);
  assertEquals(result.ok, false, "a declined install is never masked as ok");
});

// ── A runtime that installs and answers flips the check ─────────────────

Deno.test("windows runtime offer - a runtime that answers after the install passes", async () => {
  const state = host();

  const result = await offer(state, {
    platform: "windows",
    answer: () => true,
    // Docker Desktop configured to start with Windows: the install leaves it
    // both present and answering, and the re-probe says so.
    run: (target) => {
      target.docker = { installed: true, answering: true };
      return { ok: true };
    },
  });

  assertEquals(runtimeOutcome(result.outcomes).status, "installed");
  assertEquals(result.results[0]!.ok, true);
  assertStringIncludes(result.results[0]!.message, "Docker");
  assertEquals(result.ok, true);
});

// ── Installed but not running: no reinstall is proposed ─────────────────

Deno.test("windows runtime offer - a stopped Docker Desktop is never reinstalled", async () => {
  const state = host({ docker: { installed: true, answering: false } });

  const result = await windowsOffer(state, () => true);

  // Podman is absent, so the offer moves on to it; Docker itself must not be
  // offered a reinstall, which would not start the Desktop app anyway.
  assert(
    !state.questions.some((q) => q.includes("Docker")),
    `a stopped Docker Desktop must not be offered a reinstall, asked: ${
      state.questions.join(" | ")
    }`,
  );
  assert(
    !ran(state).some((line) => line.includes("Docker.DockerDesktop")),
    `nothing may reinstall a present Docker Desktop, ran: ${
      ran(state).join(" | ")
    }`,
  );
  assertEquals(result.ok, false);
});

Deno.test("windows runtime offer - with both present but stopped nothing is offered", async () => {
  const state = host({
    docker: { installed: true, answering: false },
    podman: { installed: true, answering: false },
  });

  const result = await windowsOffer(state, () => true);

  assertEquals(ran(state), []);
  assertEquals(state.questions, []);
  assertEquals(runtimeOutcome(result.outcomes).status, "no-plan");
  // The probe's own hint survives, so the operator is told to start the app.
  assertEquals(result.results, [runtimeFailure("windows")]);
  assertEquals(result.ok, false);
});

// ── No winget ⇒ no offer ────────────────────────────────────────────────

Deno.test("windows runtime offer - a host without winget runs nothing", async () => {
  const state = host({ packageManager: false });

  const result = await windowsOffer(state, () => true);

  assertEquals(ran(state), [], "no package manager means no command");
  assertEquals(state.questions, [], "nothing may be offered without a plan");
  assertEquals(runtimeOutcome(result.outcomes).status, "no-plan");
  assertEquals(result.ok, false);
  assert(
    state.lines.some((l) => l.includes("no install plan")),
    `the manual hint must be summarised, got: ${state.lines.join(" | ")}`,
  );
});

// ── Nothing runs that the operator was not shown ────────────────────────

Deno.test("windows runtime offer - the prompt spells out the exact winget argv", async () => {
  const state = host();

  await windowsOffer(state, () => true);

  const question = state.questions[0]!;
  for (const argv of state.commands) {
    assertStringIncludes(question, argv.join(" "));
  }
  // There is no sudo on Windows, so the prompt must not promise a password
  // prompt that never appears.
  assert(
    !question.toLowerCase().includes("password"),
    `a winget prompt must not mention a password: ${question}`,
  );
});
