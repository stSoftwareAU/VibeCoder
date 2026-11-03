/**
 * The review-round command records its reviewer build and policy in the
 * round's review-run.json (Issue #4658).
 *
 * The test drives `runReviewRoundCommand` in-process through its seams: the
 * round's deps and the environment lookup. The deps are the production ones
 * with only the Claude-facing seams replaced, so the real run-record writer
 * (`recordRun`) writes the file on disk. Nothing spawns, no credential is read
 * and the process environment is never mutated.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertNotEquals,
} from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { sanitiseHostname } from "../lib/fleet_telemetry_sidecar.ts";
import { fingerprintWorkerReviewPolicy } from "../lib/pr_completion_report.ts";
import { getHostname } from "../lib/worker_identity.ts";
import {
  createReviewRoundDeps,
  REVIEW_RUN_FILE,
  type ReviewRoundDeps,
} from "../lib/review_round.ts";
import { runReviewRoundCommand } from "../commands/review_round.ts";

const BUILD_COMMIT = "abcdef0123456789";

Deno.test("review-round command records reviewer build and policy in review-run.json (Issue #4658)", async () => {
  const base = await Deno.makeTempDir({ prefix: "review_round_command_4658_" });
  try {
    const roundDir = `${base}/rounds/20261102-000000`;
    const promptFile = `${roundDir}/prompt.md`;
    await Deno.mkdir(roundDir, { recursive: true });
    await Deno.writeTextFile(promptFile, "review the fleet\n");

    // A config whose resolved review policy differs from the default's.
    const config = { ...buildDefaultWorkerConfig(), issueExecutorSplit: false };
    assertNotEquals(
      await fingerprintWorkerReviewPolicy(config),
      await fingerprintWorkerReviewPolicy(buildDefaultWorkerConfig()),
      "the candidate config must fingerprint differently from the default",
    );

    // Production deps keep the real recordRun writer; only the Claude-facing
    // seams are replaced, so no subscription is read and nothing is spawned.
    const production = createReviewRoundDeps(() => {});
    const deps: ReviewRoundDeps = {
      ...production,
      exportStartCredential: () => Promise.resolve(undefined),
      switchCredential: () => Promise.resolve(null),
      exportFallbackCredential: () => Promise.resolve(null),
      runClaude: () => Promise.resolve({ code: 0, output: "Round done" }),
      log: () => {},
    };
    const env = (name: string) =>
      name === "VIBE_BUILD_COMMIT" ? BUILD_COMMIT : undefined;

    const result = await runReviewRoundCommand(
      { "prompt-file": promptFile, "claude-args": "[]" },
      config,
      deps,
      env,
    );
    assertEquals(result.exitCode, 0);

    const record = JSON.parse(
      await Deno.readTextFile(`${roundDir}/${REVIEW_RUN_FILE}`),
    );
    assert(record.deployment, "review-run.json carries a deployment block");
    assertEquals(record.deployment.component, "reviewer");
    assertEquals(record.deployment.codeRevision, BUILD_COMMIT);
    assertMatch(record.deployment.policyFingerprint, /^[0-9a-f]{64}$/);
    assertEquals(
      record.deployment.policyFingerprint,
      await fingerprintWorkerReviewPolicy(config),
      "the round records the fingerprint of the run's resolved review policy",
    );
    assert(
      Number.isFinite(Date.parse(record.deployment.observedAt)),
      "the round records when it observed its deployment",
    );
    assertEquals(
      record.deployment.host,
      sanitiseHostname(getHostname()),
      "the round records the sanitised hostname of the machine it ran on",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
