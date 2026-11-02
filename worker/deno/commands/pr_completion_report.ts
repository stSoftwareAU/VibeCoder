/**
 * Read-only report over a dated GitHub and trusted-fleet evidence snapshot
 * (Issue #4658).
 *
 * `--input <snapshot.json>` reads a snapshot someone else produced.
 * `--collect` builds the snapshot itself: GitHub is read through `gh api`
 * GETs only, and audit journals, review-run records, lifecycle ledgers and
 * babysitter heartbeats are read from local or exported directories. The
 * review-fleet-prs skill's own `log.jsonl` files are read from
 * `--review-log <log.jsonl,...>` as a lower-trust source (docs/INTERNALS.md).
 * Nothing is written to GitHub or host configuration. `--collect` writes only
 * the optional `--write-snapshot <path>`, which holds the collected input so a
 * later `--input` run can reproduce the report, and whatever `verifyAllChains`
 * settles in an audit directory it sweeps (an interrupted append, Issue #1074).
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { resolveBaseDir } from "../lib/audit_journal.ts";
import { atomicWrite } from "../lib/file_utils.ts";
import {
  buildPrCompletionReport,
  fingerprintWorkerReviewPolicy,
  formatPrCompletionReport,
  type PrCompletionInput,
  type PrCompletionReport,
} from "../lib/pr_completion_report.ts";
import {
  type CollectedSnapshot,
  collectPrCompletionSnapshot,
  ghApiJson,
  type GhJson,
} from "../lib/pr_completion_snapshot.ts";
import { splitList } from "./audit_chain_verify.ts";

const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_DAYS = 14;
const DEFAULT_EXPECTED_COMPONENTS = ["worker", "reviewer", "babysitter"];
const DEFAULT_HEARTBEAT_HOURS = 24;

/** Data returned by `--collect`: the report plus everything it could not see. */
export interface PrCompletionCollectData {
  report: PrCompletionReport;
  coverageNotes: string[];
  truncatedRepos: string[];
}

/** A CLI value as text; numbers are accepted, flags without a value are not. */
function asText(value: unknown): string | undefined {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A CLI value as a positive integer, or `undefined` when it is not one. */
function asPositiveInteger(value: unknown): number | undefined {
  const text = asText(value) ?? "";
  if (!/^\d{1,9}$/.test(text)) return undefined;
  const number = Number(text);
  return number >= 1 ? number : undefined;
}

function asList(value: unknown): string[] | undefined {
  const text = asText(value);
  if (text === undefined) return undefined;
  const items = splitList(text);
  return items.length > 0 ? items : undefined;
}

/**
 * Run `--collect` with the given args and injected GitHub and environment
 * seams. The environment is read only for `VIBE_BUILD_COMMIT`.
 */
export async function runPrCompletionCollect(
  args: Record<string, unknown>,
  config: WorkerConfig,
  gh: GhJson,
  env: (name: string) => string | undefined = (name) => Deno.env.get(name),
): Promise<CommandResult<PrCompletionCollectData>> {
  const repos = asList(args.repos) ?? (Array.isArray(config.repos) &&
      config.repos.length > 0
    ? config.repos
    : undefined);
  if (repos === undefined) {
    return {
      success: false,
      message:
        "pr-completion-report failed: --repos <owner/name,...> is required when config.repos is empty",
    };
  }
  const expectedRevision = asText(args["expected-revision"]) ??
    asText(env("VIBE_BUILD_COMMIT"));
  if (expectedRevision === undefined) {
    return {
      success: false,
      message:
        "pr-completion-report failed: --expected-revision <sha> is required (or set VIBE_BUILD_COMMIT)",
    };
  }
  const hours = args["max-heartbeat-age-hours"] === undefined
    ? DEFAULT_HEARTBEAT_HOURS
    : Number(args["max-heartbeat-age-hours"]);
  if (!Number.isFinite(hours) || hours <= 0) {
    return {
      success: false,
      message:
        "pr-completion-report failed: --max-heartbeat-age-hours must be a positive number",
    };
  }

  const maxPrsRaw = args["max-prs-per-repo"];
  const maxPrsPerRepo = maxPrsRaw === undefined
    ? undefined
    : asPositiveInteger(maxPrsRaw);
  if (maxPrsRaw !== undefined && maxPrsPerRepo === undefined) {
    return {
      success: false,
      message:
        "pr-completion-report failed: --max-prs-per-repo must be a positive integer",
    };
  }

  const observedAt = new Date().toISOString();
  const end = asText(args.end) ?? observedAt;
  if (!/^\d{4}-\d\d-\d\dT.*Z$/.test(end) || !Number.isFinite(Date.parse(end))) {
    return {
      success: false,
      message:
        "pr-completion-report failed: --end must be a UTC (Z) ISO timestamp",
    };
  }
  const start = asText(args.start) ??
    new Date(Date.parse(end) - DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
  const reviewLogArg = args["review-log"];
  const reviewLogs = asList(reviewLogArg);
  if (reviewLogArg !== undefined && reviewLogs === undefined) {
    return {
      success: false,
      message:
        "pr-completion-report failed: --review-log <log.jsonl,...> must name at least one file",
    };
  }
  const rolloutVerifiedAt = asText(args["rollout-verified-at"]);
  const writeSnapshot = asText(args["write-snapshot"]);

  try {
    const policyFingerprint = await fingerprintWorkerReviewPolicy(config);
    const snapshot: CollectedSnapshot = await collectPrCompletionSnapshot({
      repos,
      cohort: { start, end, observedAt },
      auditDirs: asList(args["audit-dir"]) ?? [resolveBaseDir()],
      reviewRunDirs: asList(args["review-run-dir"]),
      reviewLogs,
      lifecycleLedgers: asList(args["lifecycle-ledger"]),
      babysitterStateDirs: asList(args["babysitter-state-dir"]),
      expected: {
        components: asList(args["expected-components"]) ??
          DEFAULT_EXPECTED_COMPONENTS,
        revision: expectedRevision,
        policyFingerprint,
        maxHeartbeatAgeHours: hours,
      },
      ...(rolloutVerifiedAt !== undefined ? { rolloutVerifiedAt } : {}),
      ...(maxPrsPerRepo !== undefined ? { maxPrsPerRepo } : {}),
      gh,
    });
    const report = buildPrCompletionReport(snapshot.input);
    if (writeSnapshot !== undefined) {
      const written = await atomicWrite({
        targetFile: writeSnapshot,
        content: JSON.stringify(snapshot.input, null, 2) + "\n",
      });
      if (!written.ok) {
        return {
          success: false,
          message:
            `pr-completion-report failed: could not write snapshot ${writeSnapshot}: ${written.error.message}`,
        };
      }
    }
    const notices = [
      ...snapshot.coverageNotes.map((note) => `coverage: ${note}`),
      ...snapshot.truncatedRepos.map((repo) =>
        `TRUNCATED: ${repo} exceeded the PR cap; the report is incomplete for this repository`
      ),
    ];
    return {
      success: true,
      message: [...notices, formatPrCompletionReport(report)].join("\n"),
      data: {
        report,
        coverageNotes: snapshot.coverageNotes,
        truncatedRepos: snapshot.truncatedRepos,
      },
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      message: `pr-completion-report failed: ${reason}`,
    };
  }
}

export const prCompletionReportCommand: Command = {
  name: "pr-completion-report",
  description:
    "Report unattended PR completion from an evidence snapshot or live collection (Issue #4658)",
  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult> {
    const inputGiven = args.input !== undefined;
    const collectGiven = args.collect === true;
    if (inputGiven && collectGiven) {
      return {
        success: false,
        message:
          "--input <path> and --collect are mutually exclusive; pass exactly one",
      };
    }
    if (!inputGiven && !collectGiven) {
      return {
        success: false,
        message: "one of --input <path> or --collect is required",
      };
    }
    if (collectGiven) {
      return await runPrCompletionCollect(args, config, ghApiJson);
    }

    const path = args.input;
    if (typeof path !== "string" || path.trim() === "") {
      return { success: false, message: "--input <path> is required" };
    }
    try {
      const input = JSON.parse(
        await Deno.readTextFile(path),
      ) as PrCompletionInput;
      const report = buildPrCompletionReport(input);
      return {
        success: true,
        message: formatPrCompletionReport(report),
        data: report,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: `pr-completion-report failed: ${reason}`,
      };
    }
  },
};
