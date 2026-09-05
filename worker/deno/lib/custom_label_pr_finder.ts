/**
 * Discovery for PR-phase custom label mappings (Issue #1009, part of #938).
 *
 * Every other custom-label discovery path is issue-shaped: `findIssuesByLabel`
 * and the collectors in `collect_label_candidates.ts` fetch *issues* by label
 * and gate them with `wasLabelAddedByAllowedAuthor`. A `pr`-phase mapping
 * needs the PR-shaped equivalent, and this is it: list **open** PRs carrying a
 * configured `pr`-phase label, keep only those whose label was applied by an
 * account that may direct work, and return the candidates. Nothing here
 * mutates anything.
 *
 * ## Trust — the whole of this module's risk
 *
 * A custom label dispatches a privileged phase with an operator-supplied
 * prompt against a real checkout, so the label **adder** must be trusted; a
 * trusted PR *author* is not sufficient (Issue #847). The gate is
 * `wasLabelAddedByAllowedAuthor` — the same timeline verification the issue
 * collectors use, unchanged in substance — reading
 * `repos/{repo}/issues/{n}/timeline`, which serves pull requests because a PR
 * *is* an issue to that endpoint.
 *
 * Two exclusions ride with it:
 *
 * - `allowedAuthors` is the per-cycle collaborator-derived set (Issue #1066),
 *   not a hand-maintained allowlist. It starts empty, so an unresolved cycle
 *   dispatches nothing.
 * - `fleetWorkerLogins` — this host plus its siblings — is treated as
 *   untrusted, so the worker cannot self-dispatch by labelling its own PR
 *   (Issues #3225, #3416).
 *
 * **Fail closed.** A label add that cannot be attributed — no `labeled`
 * event, a null actor, or a timeline read that failed — skips the PR, with
 * the reason logged.
 *
 * `--state open` is the whole of the closed/merged exclusion: a merged PR is
 * never listed, so a stale label on it can never dispatch.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import type { CustomLabelPromptMapping, Logger } from "../types.ts";
import { customDispatchMappings } from "./custom_label_prompts_config.ts";
import { wasLabelAddedByAllowedAuthor } from "./issue_query.ts";
import type { TimelineCache } from "./timeline_cache.ts";

/** An open PR that a trusted account labelled with a `pr`-phase mapping. */
export interface CustomLabelPrCandidate {
  /** Repository in `owner/repo` form. */
  repo: string;
  /** The pull request number. */
  prNumber: number;
  /** Head branch, which the dispatcher checks out. */
  headRefName: string;
  /** PR title — untrusted text, fenced by the prompt builder. */
  title: string;
  /** PR URL, for logs and comments. */
  url: string;
  /** Whether the PR is a draft. */
  isDraft: boolean;
  /** The PR author's login. */
  author: string;
  /** ISO timestamp of the PR's last update; the within-label sort key. */
  updatedAt: string;
  /** The mapping whose label matched. */
  mapping: CustomLabelPromptMapping;
}

/** What the finder needs; `ghCommandFn` is the seam the suite drives. */
export interface FindCustomLabelPrsOptions {
  /** Monitored repositories, `owner/repo`. */
  repos: readonly string[];
  /** The validated `custom_label_prompts` list; filtered to `pr` here. */
  mappings: readonly CustomLabelPromptMapping[];
  /** Per-cycle collaborator-derived logins that may direct work (#1066). */
  allowedAuthors: readonly string[];
  /** This host and its siblings — never trusted to apply a custom label. */
  fleetWorkerLogins?: readonly string[];
  /** `gh` runner. Injected so the suite drives the finder without a network. */
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
  /** Optional read-through timeline cache, as the issue collectors use. */
  timelineCache?: TimelineCache;
}

/** The `gh pr list --json` fields the finder asks for. */
const PR_LIST_FIELDS =
  "number,headRefName,title,url,isDraft,author,updatedAt" as const;

/** One PR as `gh pr list --json` renders it. */
interface PrListEntry {
  number: number;
  headRefName?: string;
  title?: string;
  url?: string;
  isDraft?: boolean;
  author?: { login?: string } | null;
  updatedAt?: string;
}

/**
 * Find the open PRs a `pr`-phase custom label was trustedly applied to.
 *
 * Candidates come back in **configuration order** of the mappings and
 * oldest-updated first within a label, so the caller taking the first entry
 * takes the operator's highest-priority mapping and the longest-waiting PR
 * under it. A PR carrying two configured `pr` labels yields one candidate per
 * label.
 *
 * With no `pr`-phase mapping configured this issues **zero** `gh` calls — the
 * scan costs an operator who never opted in nothing at all.
 *
 * @param options - Repos, mappings, trust inputs and the `gh` seam
 * @returns The trusted candidates, in dispatch order
 */
export async function findCustomLabelPrCandidates(
  options: FindCustomLabelPrsOptions,
): Promise<CustomLabelPrCandidate[]> {
  const { logger, ghCommandFn } = options;
  const prMappings = customDispatchMappings(
    { customLabelPrompts: [...options.mappings] },
    "pr",
  );
  if (prMappings.length === 0) return [];

  const fleetWorkerLogins = [...(options.fleetWorkerLogins ?? [])];
  const allowedAuthors = [...options.allowedAuthors];
  const candidates: CustomLabelPrCandidate[] = [];

  for (const mapping of prMappings) {
    for (const repo of options.repos) {
      const listed = await listOpenLabelledPrs(
        repo,
        mapping.label,
        ghCommandFn,
        logger,
      );
      // Oldest-updated first, so a PR that has been waiting is taken first.
      listed.sort((a, b) =>
        (a.updatedAt ?? "").localeCompare(b.updatedAt ?? "")
      );

      for (const pr of listed) {
        const trusted = await labelAddedByTrustedAccount({
          repo,
          prNumber: pr.number,
          label: mapping.label,
          allowedAuthors,
          fleetWorkerLogins,
          ghCommandFn,
          logger,
          ...(options.timelineCache !== undefined
            ? { timelineCache: options.timelineCache }
            : {}),
        });
        if (!trusted) continue;

        candidates.push({
          repo,
          prNumber: pr.number,
          headRefName: pr.headRefName ?? "",
          title: pr.title ?? "",
          url: pr.url ?? "",
          isDraft: pr.isDraft ?? false,
          author: pr.author?.login ?? "",
          updatedAt: pr.updatedAt ?? "",
          mapping,
        });
      }
    }
  }

  return candidates;
}

/**
 * List the open PRs in `repo` carrying `label`.
 *
 * A `gh` fault on one repository is logged as an error and skipped rather
 * than aborting the scan of the rest — the failure is surfaced, never
 * swallowed, but one unreachable repository does not starve the others.
 */
async function listOpenLabelledPrs(
  repo: string,
  label: string,
  ghCommandFn: (args: string[]) => Promise<string>,
  logger: Logger,
): Promise<PrListEntry[]> {
  let raw: string;
  try {
    raw = await ghCommandFn([
      "pr",
      "list",
      "--repo",
      repo,
      // The whole of the closed/merged exclusion (Issue #1009): a stale label
      // on a merged PR is never listed, so it can never dispatch.
      "--state",
      "open",
      "--label",
      label,
      "--json",
      PR_LIST_FIELDS,
    ]);
  } catch (error) {
    logger.error("Could not list PRs for a custom label", {
      repo,
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed.filter((entry): entry is PrListEntry =>
      typeof entry === "object" && entry !== null &&
      typeof (entry as PrListEntry).number === "number"
    );
  } catch (error) {
    logger.error("Could not parse the PR list for a custom label", {
      repo,
      label,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** Whether `label` on this PR was applied by an account that may direct work. */
async function labelAddedByTrustedAccount(input: {
  repo: string;
  prNumber: number;
  label: string;
  allowedAuthors: string[];
  fleetWorkerLogins: string[];
  ghCommandFn: (args: string[]) => Promise<string>;
  logger: Logger;
  timelineCache?: TimelineCache;
}): Promise<boolean> {
  const { repo, prNumber, label, logger } = input;
  try {
    const added = await wasLabelAddedByAllowedAuthor(
      repo,
      prNumber,
      label,
      input.allowedAuthors,
      input.ghCommandFn,
      input.timelineCache,
      input.fleetWorkerLogins,
    );
    if (!added) {
      logger.warn(
        `[SECURITY] [UNTRUSTED_LABEL_CHANGE] label-adder-not-allowed: ` +
          `'${label}' on ${repo}#${prNumber} was not applied by an account ` +
          `that may direct work — not dispatching`,
      );
      return false;
    }
    return true;
  } catch (error) {
    // Fail closed: without the timeline we cannot say who applied the label,
    // and a privileged agent run is not something to grant on no evidence.
    logger.warn(
      `[SECURITY] [UNTRUSTED_LABEL_CHANGE] label-adder-unverifiable: ` +
        `could not read the timeline of ${repo}#${prNumber} to attribute ` +
        `'${label}' (${
          error instanceof Error ? error.message : String(error)
        }) — not dispatching`,
    );
    return false;
  }
}
