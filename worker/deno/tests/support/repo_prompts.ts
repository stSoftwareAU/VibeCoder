/**
 * Pin prompt-template resolution to *this* checkout (Issue #844).
 *
 * `getPromptsDir` resolves in this order: `PROMPTS_DIR`, then `VIBE_BASE_DIR`,
 * then a path relative to `worker/deno/lib/`. A worker host exports the first
 * two pointing at the *worker's own* checkout, so any test that reaches the
 * real `loadPrompt` without naming a directory reads that tree's `prompts/`
 * instead of the one under test — green or red depending on what some other
 * clone happens to hold, which is no gate at all. It is the same hazard
 * `tests/support/env.ts` was written for.
 *
 * {@link pinPromptsToThisCheckout} removes both overrides so resolution falls
 * through to the module-relative path, which always names this checkout.
 * `deno test` imports every test module before running any test, so calling it
 * at module scope pins the whole process deterministically, whatever order the
 * files run in.
 *
 * {@link withRepoRootCwd} adds the cwd the idle-task body builders need for
 * their own cwd-relative reads.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

/** Repo root — `worker/deno/tests/support/` is four levels down. */
export const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;

/** Directory overrides `getPromptsDir` honours ahead of the module path. */
const PROMPT_DIR_ENV_VARS = ["PROMPTS_DIR", "VIBE_BASE_DIR"] as const;

/**
 * Drop the prompt-directory overrides for this process, so prompts resolve
 * against this checkout. Idempotent — safe to call from every test file that
 * touches a real template.
 */
export function pinPromptsToThisCheckout(): void {
  for (const name of PROMPT_DIR_ENV_VARS) Deno.env.delete(name);
}

// Importing this module is itself the pin: a test process must never read
// another checkout's prompts/.
pinPromptsToThisCheckout();

/**
 * Run `body` with cwd at the repo root and the prompt-directory overrides
 * cleared, restoring the original cwd afterwards.
 *
 * @param body - The test body to run
 * @returns Whatever `body` returns
 */
export async function withRepoRootCwd<T>(body: () => Promise<T>): Promise<T> {
  // Re-pin: a test that set an override of its own must not leak it here.
  pinPromptsToThisCheckout();
  const original = Deno.cwd();
  Deno.chdir(REPO_ROOT);
  try {
    return await body();
  } finally {
    Deno.chdir(original);
  }
}
