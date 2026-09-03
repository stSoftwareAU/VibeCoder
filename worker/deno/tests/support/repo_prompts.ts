/**
 * Run a test body against *this* checkout's `prompts/` tree (Issue #844).
 *
 * The idle-task body builders load their templates through the real
 * `loadPrompt`, which resolves the directory in this order: `PROMPTS_DIR`,
 * then `VIBE_BASE_DIR`, then a path relative to `worker/deno/lib/`. A worker
 * host exports the first two pointing at the *worker's own* checkout, so a
 * test that leaves them set reads that tree's templates instead of the ones
 * under test — green or red depending on what the other checkout happens to
 * hold, which is no gate at all.
 *
 * {@link withRepoRootCwd} clears both for the duration (pinning resolution to
 * this repo) and runs with cwd at the repo root, which the builders' own
 * cwd-relative reads need.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

import { withEnv } from "./env.ts";

/** Repo root — `worker/deno/tests/support/` is four levels down. */
export const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;

/** Directory overrides `getPromptsDir` honours ahead of the module path. */
const PROMPT_DIR_ENV_VARS = ["PROMPTS_DIR", "VIBE_BASE_DIR"] as const;

/**
 * Run `body` with cwd at the repo root and the prompt-directory overrides
 * cleared, restoring both afterwards.
 *
 * @param body - The test body to run
 * @returns Whatever `body` returns
 */
export async function withRepoRootCwd<T>(body: () => Promise<T>): Promise<T> {
  const cleared: Record<string, string | undefined> = {};
  for (const name of PROMPT_DIR_ENV_VARS) cleared[name] = undefined;

  return await withEnv(cleared, async () => {
    const original = Deno.cwd();
    Deno.chdir(REPO_ROOT);
    try {
      return await body();
    } finally {
      Deno.chdir(original);
    }
  });
}
