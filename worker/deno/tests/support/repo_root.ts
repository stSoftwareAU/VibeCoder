/**
 * The repo root of *this* checkout, with no process-wide side effects.
 *
 * `tests/support/repo_prompts.ts` also exports {@link REPO_ROOT}, but importing
 * that module deletes the prompt-directory environment variables and its
 * {@link withRepoRootCwd} moves the working directory — process-wide mutations
 * that race under `deno test --parallel`, so every suite reaching it is pushed
 * into the gate's slow serial pass (Issues #880, #940).
 *
 * A test that names its prompts directory explicitly —
 * `loadPrompt(name, `${REPO_ROOT}prompts`)` — is already pinned to this
 * checkout by that parameter and needs none of the mutation. It imports the
 * constant from here instead, which is the "take the value as a parameter"
 * seam the manifest asks for.
 *
 * Australian English throughout (behaviour, colour, organisation).
 */

/** Repo root — `worker/deno/tests/support/` is four levels down. */
export const REPO_ROOT = new URL("../../../../", import.meta.url).pathname;
