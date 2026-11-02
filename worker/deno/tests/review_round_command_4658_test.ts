/**
 * The review-round command records its reviewer build and policy in the
 * round's review-run.json (Issue #4658).
 *
 * `reviewRoundCommand.execute` takes no injected seams: it builds the real
 * credential pool and spawns the real `claude`. So the command runs in a child
 * Deno process with its own environment (`clearEnv`), the way the worker
 * container runs it. That environment has an empty PATH (no `claude` to spawn),
 * an empty credential directory (no subscription to export) and a fixed build
 * commit. The test process's own environment is never mutated, which keeps the
 * file eligible for the parallel pass. The attempt cannot start, and the round
 * records that like any other attempt, so nothing real runs and no credential
 * is read.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertMatch } from "@std/assert";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { fingerprintWorkerReviewPolicy } from "../lib/pr_completion_report.ts";
import { REVIEW_RUN_FILE } from "../lib/review_round.ts";

const BUILD_COMMIT = "abcdef0123456789";

Deno.test("review-round command records reviewer build and policy in review-run.json (Issue #4658)", async () => {
  const base = await Deno.makeTempDir({ prefix: "review_round_command_4658_" });
  try {
    const root = new URL("../", import.meta.url);
    const emptyBin = `${base}/bin`;
    const emptyCreds = `${base}/credentials`;
    const roundDir = `${base}/rounds/20261102-000000`;
    const promptFile = `${roundDir}/prompt.md`;
    await Deno.mkdir(emptyBin, { recursive: true });
    await Deno.mkdir(emptyCreds, { recursive: true });
    await Deno.mkdir(roundDir, { recursive: true });
    await Deno.writeTextFile(promptFile, "review the fleet\n");

    // The child script lives outside the round directory and imports the
    // command by absolute URL, so it runs the real command module.
    const commandUrl = new URL("../commands/review_round.ts", import.meta.url)
      .href;
    const configUrl = new URL("../lib/config_defaults.ts", import.meta.url)
      .href;
    const script = `${base}/drive_review_round.ts`;
    await Deno.writeTextFile(
      script,
      [
        `import { reviewRoundCommand } from ${JSON.stringify(commandUrl)};`,
        `import { buildDefaultWorkerConfig } from ${
          JSON.stringify(configUrl)
        };`,
        `const [promptFile] = Deno.args;`,
        `const result = await reviewRoundCommand.execute(`,
        `  { "prompt-file": promptFile, "claude-args": "[]" },`,
        `  buildDefaultWorkerConfig(),`,
        `);`,
        `console.log(JSON.stringify(result));`,
      ].join("\n") + "\n",
    );

    const home = Deno.env.get("HOME") ?? "";
    const denoDir = Deno.env.get("DENO_DIR");
    const childEnv: Record<string, string> = {
      PATH: emptyBin,
      HOME: home,
      VIBE_CREDENTIAL_DIR: emptyCreds,
      VIBE_BUILD_COMMIT: BUILD_COMMIT,
    };
    if (denoDir) childEnv["DENO_DIR"] = denoDir;

    const rootPath = root.pathname;
    const output = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-check",
        "--config",
        `${rootPath}deno.json`,
        "--allow-env",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        script,
        promptFile,
      ],
      cwd: rootPath,
      env: childEnv,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(output.stdout);
    const stderr = new TextDecoder().decode(output.stderr);
    assertEquals(output.code, 0, `child process failed: ${stderr}`);

    const result = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    assertEquals(
      result.exitCode,
      127,
      "no claude on the narrowed PATH, so the attempt cannot start",
    );

    const record = JSON.parse(
      await Deno.readTextFile(`${roundDir}/${REVIEW_RUN_FILE}`),
    );
    assert(record.deployment, "review-run.json carries a deployment block");
    assertEquals(record.deployment.component, "reviewer");
    assertEquals(record.deployment.codeRevision, BUILD_COMMIT);
    assertMatch(record.deployment.policyFingerprint, /^[0-9a-f]{64}$/);
    assertEquals(
      record.deployment.policyFingerprint,
      await fingerprintWorkerReviewPolicy(buildDefaultWorkerConfig()),
      "the round records the fingerprint of the run's resolved review policy",
    );
    assert(
      Number.isFinite(Date.parse(record.deployment.observedAt)),
      "the round records when it observed its deployment",
    );
  } finally {
    await Deno.remove(base, { recursive: true });
  }
});
