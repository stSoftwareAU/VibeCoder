/**
 * Shared scaffolding for tests that drive `runPrFeedbackDriftCheck` against a
 * real temporary git repo with fake `runGh` / `runAgent` seams (Issue #3983).
 * The verdict markers come from the module under test, not typed in.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  DRIFT_VERDICT_CLOSE,
  DRIFT_VERDICT_OPEN,
  type DriftCheckDeps,
  type DriftFinding,
} from "../../lib/pr_feedback_drift_check.ts";

export interface GitRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run git in `dir`, returning its exit code and streams. */
export async function git(dir: string, args: string[]): Promise<GitRunResult> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: {
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  const out = await cmd.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

export async function writeFile(dir: string, path: string, content: string) {
  const full = `${dir}/${path}`;
  await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(full, content);
}

export async function commitAll(dir: string, message: string) {
  assertEquals((await git(dir, ["add", "."])).code, 0);
  assertEquals((await git(dir, ["commit", "-m", message])).code, 0);
}

/** A fresh temporary git repo on `main`, with a throwaway identity. */
export async function initRepo(prefix: string): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix });
  assertEquals((await git(dir, ["init", "-b", "main"])).code, 0);
  await git(dir, ["config", "user.name", "test"]);
  await git(dir, ["config", "user.email", "test@example.com"]);
  await git(dir, ["config", "commit.gpgsign", "false"]);
  return dir;
}

/** Fake `runGit` that shells out to real git in `dir`. */
export function makeRunGit(dir: string): DriftCheckDeps["runGit"] {
  return async (args: string[]) => await git(dir, args);
}

/** Fake `runGh` that always answers the `baseRefName` read with `main`. */
export function makeRunGh(): DriftCheckDeps["runGh"] {
  return async () => "main\n";
}

/** Fake `runMutationCheck` for tests not about the mutation gate (Issue #3750). */
export const notMutationChecked: DriftCheckDeps["runMutationCheck"] =
  async () => ({ kind: "not_applicable", reason: "not under test" });

export type AgentResponse =
  | { ok: true; output: string }
  | { ok: false; error: Error };
export type AgentCall = { prompt: string; readOnly: boolean };

/** Fake `runAgent` replaying `responses` in order and recording each call. */
export function makeRunAgent(
  responses: readonly (AgentResponse | ((call: AgentCall) => AgentResponse))[],
  calls: AgentCall[],
): DriftCheckDeps["runAgent"] {
  let i = 0;
  return async (req) => {
    calls.push(req);
    const resp = responses[i++];
    if (!resp) {
      throw new Error(`runAgent called more times (${i}) than expected`);
    }
    return typeof resp === "function" ? resp(req) : resp;
  };
}

export function noopLogger(): DriftCheckDeps["logger"] {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

/** A drift-verdict reply block the drift check parses. */
export function verdictBlock(findings: DriftFinding[]): string {
  return [
    DRIFT_VERDICT_OPEN,
    "```json",
    JSON.stringify({ findings }, null, 2),
    "```",
    DRIFT_VERDICT_CLOSE,
  ].join("\n");
}
