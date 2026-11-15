/**
 * The launch-plan command hands the worker the watchdog's kill instant
 * (Issue #4242).
 *
 * `buildLaunchPlanForCommand` reads the clock where the plan is built and
 * passes it on as `planEpochSeconds`. Dropping that input would leave
 * `VIBE_HARD_KILL_AT_EPOCH` off the run arguments, so this drives the real
 * function with an injected environment, clock and runtime probe and reads the
 * variable off the plan it returns.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  buildLaunchPlanForCommand,
  ensureReviewImage,
} from "../commands/container_launch_plan.ts";
import { DEFAULT_MAX_RUN_SECONDS } from "../lib/run_entrypoint.ts";
import { resolveWatchdogSeconds } from "../lib/container_watchdog.ts";
import { REPO_ROOT } from "./fixtures/launcher_harness.ts";

Deno.test("buildLaunchPlanForCommand - the run carries the plan clock plus the watchdog as the hard kill (Issue #4242)", async () => {
  const home = await Deno.makeTempDir({ prefix: "vibe-launch-plan-" });
  try {
    const credentialDir = `${home}/credentials`;
    for (const sub of ["gh", "claude", "codex", "deepseek"]) {
      await Deno.mkdir(`${credentialDir}/${sub}`, { recursive: true });
    }
    const configFile = `${home}/config.json`;
    await Deno.writeTextFile(configFile, "{}");

    const environment: Record<string, string> = {
      HOME: home,
      VIBE_CREDENTIAL_DIR: credentialDir,
      CONFIG_PATH: configFile,
      WORK_DIR: `${home}/work`,
    };
    const env = (name: string) => environment[name];
    const planEpochSeconds = 1_900_000_000;

    const plan = await buildLaunchPlanForCommand(REPO_ROOT, "vibe-test", {
      env,
      now: () => planEpochSeconds * 1000 + 999,
      probe: (candidate) =>
        Promise.resolve({
          available: true,
          path: `/usr/bin/${candidate.executable}`,
        }),
    });

    const watchdogSeconds = resolveWatchdogSeconds({
      env,
      maxRunSeconds: DEFAULT_MAX_RUN_SECONDS,
    });
    assertEquals(
      plan.runArgs.filter((arg) => arg.startsWith("VIBE_HARD_KILL_AT_EPOCH=")),
      [`VIBE_HARD_KILL_AT_EPOCH=${planEpochSeconds + watchdogSeconds}`],
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("review launch plan installs Claude and Codex without mounting worker Codex credentials (Issue #5164)", async () => {
  const home = await Deno.makeTempDir({ prefix: "review-image-" });
  try {
    const credentialDir = `${home}/credentials`;
    for (const sub of ["gh", "claude"]) {
      await Deno.mkdir(`${credentialDir}/${sub}`, { recursive: true });
    }
    const configFile = `${home}/config.json`;
    await Deno.writeTextFile(
      configFile,
      JSON.stringify({ agent_providers: ["claude"] }),
    );
    const environment: Record<string, string> = {
      HOME: home,
      VIBE_CREDENTIAL_DIR: credentialDir,
      CONFIG_PATH: configFile,
      WORK_DIR: `${home}/work`,
    };
    const options = {
      env: (name: string) => environment[name],
      probe: (candidate: { executable: string }) =>
        Promise.resolve({
          available: true,
          path: `/usr/bin/${candidate.executable}`,
        }),
    };
    const worker = await buildLaunchPlanForCommand(
      REPO_ROOT,
      "worker",
      options,
    );
    const review = await buildLaunchPlanForCommand(REPO_ROOT, "review", {
      ...options,
      reviewRound: true,
    });
    assert(review.buildArgs.includes("AGENT_PROVIDERS=claude,codex"));
    assert(
      review.image !== worker.image,
      "a Claude-only cache must not satisfy a review image",
    );
    assertEquals(review.mounts, worker.mounts);
    assert(!review.mounts.some((m) => m.source.endsWith("/codex")));
    assert(
      review.proxyRunArgs.some((arg) => arg.includes("chatgpt.com")),
      "Astra subscription endpoints must be allowed",
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("review image preparation builds base and extension once and checks the resulting image (Issue #5164)", async () => {
  const plan = {
    runtime: "fixture",
    image: "review:abc",
    imageInspectArgs: ["image", "inspect", "review:abc"],
    buildArgs: ["build", "base"],
    extensionBuildArgs: ["build", "extension"],
  };
  const calls: string[][] = [];
  await ensureReviewImage(plan, (args) => {
    calls.push(args);
    return Promise.resolve({
      success: calls.length !== 1,
      code: calls.length === 1 ? 1 : 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      signal: null,
    });
  });
  assertEquals(calls, [
    plan.imageInspectArgs,
    plan.buildArgs,
    plan.extensionBuildArgs,
    plan.imageInspectArgs,
  ]);
  calls.length = 0;
  await ensureReviewImage(plan, (args) => {
    calls.push(args);
    return Promise.resolve({
      success: true,
      code: 0,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      signal: null,
    });
  });
  assertEquals(calls, [plan.imageInspectArgs]);
  await assertRejects(
    () =>
      ensureReviewImage(plan, () =>
        Promise.resolve({
          success: false,
          code: 17,
          stdout: new Uint8Array(),
          stderr: new TextEncoder().encode("download checksum mismatch"),
          signal: null,
        })),
    Error,
    "download checksum mismatch",
  );
});
