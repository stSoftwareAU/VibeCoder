/**
 * The base branch a PR repair pass merges in before it pushes its fix
 * (owner rule 2026-11-03: the fix and the branch update go out in one push).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/**
 * The PR's base branch: the one the caller already knows, otherwise read from
 * GitHub. `undefined` when it cannot be read, so the fix is pushed as before
 * rather than failing the pass.
 */
export async function prBaseForSync(
  known: string | undefined,
  repo: string,
  prNumber: number,
  gh: (args: string[]) => Promise<string>,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<string | undefined> {
  if (known !== undefined && known.trim() !== "") return known.trim();
  try {
    const base = (await gh([
      "pr",
      "view",
      String(prNumber),
      "--repo",
      repo,
      "--json",
      "baseRefName",
      "--jq",
      ".baseRefName",
    ])).trim();
    if (base !== "") return base;
    warn(`PR #${prNumber} reported no base branch; fix pushed without it`);
  } catch (error) {
    warn(
      `Could not read the base branch of PR #${prNumber}; fix pushed without it: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  return undefined;
}
