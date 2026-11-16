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
    const allowedHosts = review.proxyRunArgs
      .filter((arg) => arg.startsWith("VIBE_EGRESS_ALLOW_HOSTS="))
      .flatMap((arg) =>
        arg.slice("VIBE_EGRESS_ALLOW_HOSTS=".length).split(",")
      );
    assert(
      new Set(allowedHosts).has("chatgpt.com"),
      "Astra subscription endpoints must be allowed",
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

/** A container runtime that models image state, not a scripted call order. */
function fakeImageRuntime(
  plan: {
    image: string;
    imageInspectArgs: string[];
    buildArgs: string[];
    extensionBuildArgs: string[];
  },
  options: {
    present?: boolean;
    buildsAllowed?: boolean;
    baseBuildExit?: number;
    extensionLeavesImage?: boolean;
    stderr?: string;
  } = {},
) {
  const state = { images: new Set<string>(), baseBuilt: false };
  if (options.present) state.images.add(plan.image);
  const result = (code: number, stderr = "") =>
    Promise.resolve({
      success: code === 0,
      code,
      stdout: new Uint8Array(),
      stderr: new TextEncoder().encode(stderr),
      signal: null,
    });
  const run = (args: string[]) => {
    if (args === plan.imageInspectArgs) {
      return result(state.images.has(plan.image) ? 0 : 1);
    }
    if (options.buildsAllowed === false) {
      return result(1, "image store is read-only");
    }
    if (args === plan.buildArgs) {
      if ((options.baseBuildExit ?? 0) !== 0) {
        return result(options.baseBuildExit!, options.stderr);
      }
      state.baseBuilt = true;
      return result(0);
    }
    // The extension can only be built from an existing base.
    if (!state.baseBuilt) return result(1, "base image missing");
    if (options.extensionLeavesImage !== false) state.images.add(plan.image);
    return result(0);
  };
  return { state, run };
}

const REVIEW_IMAGE_PLAN = {
  runtime: "fixture",
  image: "review:abc",
  imageInspectArgs: ["image", "inspect", "review:abc"],
  buildArgs: ["build", "base"],
  extensionBuildArgs: ["build", "extension"],
};

Deno.test("ensureReviewImage leaves a missing review image present and reuses an existing one (Issue #5164)", async () => {
  const missing = fakeImageRuntime(REVIEW_IMAGE_PLAN);
  await ensureReviewImage(REVIEW_IMAGE_PLAN, missing.run);
  assert(missing.state.images.has(REVIEW_IMAGE_PLAN.image));

  const cached = fakeImageRuntime(REVIEW_IMAGE_PLAN, {
    present: true,
    buildsAllowed: false,
  });
  await ensureReviewImage(REVIEW_IMAGE_PLAN, cached.run);
  assert(cached.state.images.has(REVIEW_IMAGE_PLAN.image));
});

Deno.test("ensureReviewImage reports a failed build and a build that leaves the image absent (Issue #5164)", async () => {
  const failing = fakeImageRuntime(REVIEW_IMAGE_PLAN, {
    baseBuildExit: 17,
    stderr: "download checksum mismatch",
  });
  await assertRejects(
    () => ensureReviewImage(REVIEW_IMAGE_PLAN, failing.run),
    Error,
    "download checksum mismatch",
  );
  assertEquals(failing.state.images.size, 0);

  const hollow = fakeImageRuntime(REVIEW_IMAGE_PLAN, {
    extensionLeavesImage: false,
  });
  await assertRejects(
    () => ensureReviewImage(REVIEW_IMAGE_PLAN, hollow.run),
    Error,
    "still missing",
  );
  assertEquals(hollow.state.images.size, 0);
});
