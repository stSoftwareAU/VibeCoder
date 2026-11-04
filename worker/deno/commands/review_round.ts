/**
 * review-round command (Issue #3293).
 *
 * One headless review-fleet-prs round, inside the worker container. The
 * skill's runner starts it as `container run <image> review-round …`; the
 * entrypoint does its usual staging and then runs this instead of the
 * worker loop (container/entrypoint.sh).
 *
 * Usage (inside the container):
 *   mod.ts review-round --prompt-file <path> --claude-args '<JSON array>'
 *
 * The prompt is read from a file the runner writes into the round's own
 * directory; the CLI arguments come as a JSON array of strings. The exit
 * status is the round's, so the runner can tell a failed round, and its own
 * alarm a hung one, from a finished one.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import {
  createReviewRoundDeps,
  type ReviewRoundDeps,
  runReviewRound,
} from "../lib/review_round.ts";
import { fingerprintWorkerReviewPolicy } from "../lib/pr_completion_report.ts";
import { escalationHostId } from "../lib/host_escalation.ts";

/** The CLI arguments, given as a JSON array of strings (parsed or not). */
export function parseClaudeArgs(value: unknown): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (
    !Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")
  ) {
    throw new Error("--claude-args must be a JSON array of strings");
  }
  return parsed;
}

export const reviewRoundCommand: Command = {
  name: "review-round",
  description:
    "Run one headless review-fleet-prs round on the worker's Claude credential pool (Issue #3293)",

  execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    return runReviewRoundCommand(args, config);
  },
};

/**
 * The review-round command's body, with its seams injected: `deps` are the
 * round's seams (production: {@link createReviewRoundDeps}) and `env` reads the
 * build commit from the environment (production: `Deno.env.get`).
 */
export async function runReviewRoundCommand(
  args: Record<string, unknown>,
  config: WorkerConfig,
  deps: ReviewRoundDeps = createReviewRoundDeps((message) =>
    console.error(message)
  ),
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Promise<CommandResult> {
  const promptFile = String(args["prompt-file"] ?? "");
  if (promptFile === "" || promptFile === "true") {
    return { success: false, message: "--prompt-file <path> is required" };
  }
  let claudeArgs: string[];
  try {
    claudeArgs = parseClaudeArgs(args["claude-args"] ?? []);
  } catch (error) {
    return { success: false, message: (error as Error).message };
  }
  const prompt = await Deno.readTextFile(promptFile);
  const code = await runReviewRound(
    prompt,
    claudeArgs,
    deps,
    // The prompt sits in the round's own directory, which also holds the
    // round's attempt log and each attempt's stream.
    {
      roundDir: promptFile.includes("/")
        ? promptFile.replace(/\/[^/]*$/, "") || "/"
        : ".",
      deployment: {
        component: "reviewer",
        hostId: escalationHostId(),
        codeRevision: env("VIBE_BUILD_COMMIT") ?? "unknown",
        policyFingerprint: await fingerprintWorkerReviewPolicy(config),
      },
    },
  );
  return {
    success: code === 0,
    message: `review round exited ${code}`,
    exitCode: code,
  };
}
