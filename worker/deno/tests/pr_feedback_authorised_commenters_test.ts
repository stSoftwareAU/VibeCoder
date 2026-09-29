/**
 * The PR-feedback lane acts on reviews from the resolved **commenter** set —
 * collaborators plus the operator's `authorized_commenters` (Copilot,
 * Actions, the fleet reviewer App) — not only on the directing set.
 *
 * It used to check review and comment authors against `allowedAuthors`, the
 * directing set, which excludes every bot by design. So a CHANGES_REQUESTED
 * review from `stsoftware-pr-reviewer[bot]` was skipped as "not an authorised
 * commenter" on every host even with the bot named in `authorized_commenters`
 * (VibeCoder#2866, GRQ-AutoTrader#1824, 2026-09-29).
 *
 * Composition test, both directions: it drives the real production wiring
 * and only stubs the trust resolver and the scan it hands the check to.
 *
 * Uses Australian English throughout (behaviour, authorised, normalise).
 */

import { assert, assertEquals } from "@std/assert";
import type { TrustedAuthors } from "../lib/derived_authors.ts";
import { createProductionRunCoreDeps } from "../lib/run_core_production_deps.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";
import { createLogger } from "../lib/logger.ts";
import type { findPrCommentsToFix } from "../lib/pr_maintenance.ts";

const REVIEWER = "stsoftware-pr-reviewer[bot]";

/** Each repo: `writers` direct work; `commenters` adds the known-input bots. */
function resolved(
  writers: string[],
  commenters: string[],
): Map<string, TrustedAuthors> {
  const sets = { allowedAuthors: writers, authorisedCommenters: commenters };
  return new Map([["org/a", sets], ["org/b", sets]]);
}

/** The author check the PR-feedback scan is handed, after one refresh. */
async function feedbackAuthorCheck(
  sets: Map<string, TrustedAuthors>,
): Promise<(author: string) => boolean> {
  let check: ((author: string) => boolean) | undefined;
  const scan: typeof findPrCommentsToFix = (options) => {
    check = options.isAuthorisedCommenter;
    return Promise.resolve({ ok: true, value: null });
  };
  const { deps, cleanup } = await createProductionRunCoreDeps({
    repoDir: "/tmp/test-repo-pr-feedback-trust",
    workDir: "/tmp/test-work-pr-feedback-trust",
    githubUser: "host-bot",
    logger: createLogger({ write: () => {} }),
    config: buildDefaultWorkerConfig({
      repos: ["org/a", "org/b"],
      serviceAccounts: ["host-bot"],
    }),
    resolveTrustedAuthors: () => Promise.resolve({ ok: true, byRepo: sets }),
    findPrCommentsToFix: scan,
  });
  try {
    assertEquals((await deps.refreshTrustedAuthors!()).ok, true);
    await deps.findAndProcessPrFeedback!();
  } finally {
    cleanup();
  }
  assert(check, "the PR-feedback scan was never run");
  return check;
}

Deno.test("PR feedback - a bot named in authorized_commenters is an authorised reviewer", async () => {
  const check = await feedbackAuthorCheck(
    resolved(["alice"], ["alice", REVIEWER, "github-copilot[bot]"]),
  );
  assert(check(REVIEWER), "the fleet reviewer App's change request is input");
  assert(check("github-copilot[bot]"), "so is Copilot's, as documented");
  assert(check("alice"), "a collaborator stays authorised");
});

Deno.test("PR feedback - an author in neither set is still refused", async () => {
  const check = await feedbackAuthorCheck(
    resolved(["alice"], ["alice", REVIEWER]),
  );
  assert(!check("mallory"), "an unknown author is not authorised");
  assert(!check("random-app[bot]"), "an unnamed bot is not authorised");
});
