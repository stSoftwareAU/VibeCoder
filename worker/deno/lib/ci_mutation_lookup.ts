/**
 * The GitHub lookups behind the repository's CI mutation contract (Issue
 * #4617): the base branch's required checks, and the text of a remote reusable
 * workflow, so `findBlockingMutationJob` can use the real required-check
 * contract and follow `owner/repo/.github/workflows/x.yml@ref` calls.
 *
 * Every failure is logged and read as "unknown", never as "not blocking": a
 * missing required-check list leaves any PR-triggered job counting, and an
 * unreadable remote workflow is reported in `unreadable`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import type { FindBlockingMutationJobOptions } from "./ci_mutation_contract.ts";
import { readRequiredCheckNames } from "./required_branch_checks_4613.ts";

/** The `gh` runner the worker injects: arguments in, stdout out, throws on failure. */
export type RunGh = (args: string[]) => Promise<string>;

export interface CiMutationLookupInput {
  /** `owner/repo` of the repository being worked on. */
  repo: string;
  /** The branch the pull request targets. */
  base: string;
  runGh: RunGh;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
}

/** Lookup options for `findBlockingMutationJob`; never throws. */
export async function ciMutationLookupOptions(
  input: CiMutationLookupInput,
): Promise<FindBlockingMutationJobOptions> {
  const { repo, base, runGh, logger } = input;
  let requiredChecks: string[] | undefined;
  try {
    requiredChecks = await readRequiredCheckNames(repo, base, runGh);
  } catch (error) {
    logger.warn(
      "Could not read the base branch's required checks, so any PR-triggered mutation job counts (Issue #4617)",
      {
        repo,
        base,
        error: error instanceof Error ? error.message : String(error),
      },
    );
  }
  return {
    ...(requiredChecks === undefined ? {} : { requiredChecks }),
    fetchRemoteWorkflow: async (ref) => {
      try {
        return await runGh([
          "api",
          `repos/${ref.repo}/contents/${ref.path}?ref=${
            encodeURIComponent(ref.ref)
          }`,
          "-H",
          "Accept: application/vnd.github.raw",
        ]);
      } catch (error) {
        logger.warn(
          "Could not read a remote reusable workflow, so its mutation contract is unknown (Issue #4617)",
          {
            repo,
            workflow: `${ref.repo}/${ref.path}@${ref.ref}`,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return null;
      }
    },
  };
}
