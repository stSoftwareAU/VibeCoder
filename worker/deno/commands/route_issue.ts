/**
 * `route-issue` — file an issue in the repository that owns the work
 * (Issues #3744, #3747, #3748; part of #3691).
 *
 * Usage (run from `worker/deno`):
 *
 *   deno run --allow-all mod.ts route-issue --repo owner/name \
 *     --title "..." --body-file body.md [--label a,b] [--dry-run] [--json]
 *   deno run --allow-all mod.ts route-issue \
 *     --resolve-duplicate owner/name#N [--correct owner/name#M] \
 *     [--dry-run] [--json]
 *   deno run --allow-all mod.ts route-issue --repo owner/name \
 *     --body-file body.md --part '["owner/a=Title A","owner/b=Title B"]' \
 *     [--label a,b] [--dry-run] [--json]
 *
 * The create mode files through `fileRoutedIssue`, which classifies the
 * draft, reuses an existing match, checks permission and files in the owner
 * repository. `--resolve-duplicate` retires an issue filed in the wrong
 * repository (`resolveWrongRepoDuplicate`). `--part` files one linked issue
 * per codebase (`fileSplitIssues`). `--dry-run` makes no write call in any
 * mode; `--json` prints the result as JSON instead of a summary line.
 *
 * `--label` takes a comma-separated list or a JSON array; `--part` takes one
 * `owner/name=Title` or a JSON array of them. `mod.ts::parseArgs` keeps only
 * the last value of a repeated flag, so several parts go in one JSON array
 * (a lone part is refused: a split needs two). An unknown option, a missing required
 * argument, an ambiguous owner, a refusal or any failed step exits non-zero.
 *
 * Australian English spelling used throughout.
 */

import type { Command, CommandResult, Logger, WorkerConfig } from "../types.ts";
import {
  coerceBooleanFlag,
  coerceStringListFlag,
  findUnknownOptions,
} from "../lib/command_args.ts";
import { customLabelPromptLabels } from "../lib/custom_label_prompts_config.ts";
import type { IssueRoutingContext } from "../lib/issue_routing_classifier.ts";
import {
  fileRoutedIssue,
  type RoutedIssueResult,
} from "../lib/issue_routing_filing.ts";
import type { GhCommandFn } from "../lib/issue_routing_github.ts";
import {
  formatIssueRef,
  parseIssueRef,
  type ResolveDuplicateResult,
  resolveWrongRepoDuplicate,
} from "../lib/issue_routing_resolve.ts";
import {
  fileSplitIssues,
  type SplitPart,
  type SplitResult,
} from "../lib/issue_routing_split.ts";
import { defaultLogger } from "../lib/logger.ts";
import { isValidRepoSlug } from "../lib/repo_slug.ts";

/** The worker's own repository: owner of worker, prompt and fleet work. */
export const ROUTE_ISSUE_VIBECODER_REPO = "stSoftwareAU/VibeCoder";

/** Injection points; tests pass these through `__testDeps`. */
export interface RouteIssueDeps {
  ghCommandFn?: GhCommandFn;
  readTextFile?: (path: string) => Promise<string>;
  now?: () => Date;
  logger?: Logger;
}

const KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  "repo",
  "title",
  "body-file",
  "label",
  "part",
  "dry-run",
  "json",
  "resolve-duplicate",
  "correct",
  "__testDeps",
]);

/** Create mode's result: the four audit fields plus what was done. */
export interface RouteIssueCreateData {
  mode: "create";
  owner_repository: string;
  subject_repository: string;
  issue_kind: string;
  reason: string;
  action: RoutedIssueResult["action"];
  issue: string | null;
  labels_not_migrated: string[];
  closed_duplicate?: string;
}

/** `--resolve-duplicate` mode's result. */
export type RouteIssueResolveData =
  & { mode: "resolve-duplicate" }
  & Omit<
    ResolveDuplicateResult,
    "decision"
  >
  & {
    owner_repository: string | null;
    issue_kind: string | null;
  };

/** `--part` mode's result. */
export type RouteIssueSplitData = { mode: "split" } & SplitResult;

type RouteIssueData =
  | RouteIssueCreateData
  | RouteIssueResolveData
  | RouteIssueSplitData;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(message: string): CommandResult<RouteIssueData> {
  return { success: false, message };
}

/** A required string flag, or an error naming it. */
function requireString(
  args: Record<string, unknown>,
  flag: string,
): string | CommandResult<RouteIssueData> {
  const value = args[flag];
  if (value === undefined) {
    return fail(`Missing required argument --${flag}`);
  }
  if (typeof value !== "string" || value.trim() === "") {
    return fail(`Argument --${flag} needs a non-empty value`);
  }
  return value.trim();
}

/** Options that may not appear in a mode. */
function refuseOptions(
  args: Record<string, unknown>,
  flags: readonly string[],
  mode: string,
): CommandResult<RouteIssueData> | null {
  const present = flags.filter((f) => args[f] !== undefined);
  return present.length === 0 ? null : fail(
    `${
      present.map((f) => `--${f}`).join(", ")
    } cannot be combined with ${mode}`,
  );
}

/** Parse `--part owner/name=Title` values (one string or a list). */
function parseParts(value: unknown): SplitPart[] | string {
  const list = Array.isArray(value) ? value : [value];
  const parts: SplitPart[] = [];
  for (const entry of list) {
    const text = typeof entry === "string" ? entry : "";
    const eq = text.indexOf("=");
    if (eq <= 0) {
      return `Invalid --part ${
        JSON.stringify(entry)
      }: expected owner/name=Title`;
    }
    parts.push({
      repo: text.slice(0, eq).trim(),
      title: text.slice(eq + 1).trim(),
    });
  }
  return parts;
}

/** One summary line for a create result. */
function createSummary(data: RouteIssueCreateData): string {
  const where = data.issue ?? data.owner_repository;
  return `route-issue ${data.action}: ${where} (owner ` +
    `${data.owner_repository}, kind ${data.issue_kind}) — ${data.reason}`;
}

export const routeIssueCommand: Command = {
  name: "route-issue",
  description:
    "File an issue in the repository that owns the work (--dry-run, " +
    "--resolve-duplicate, --part)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<RouteIssueData>> {
    const deps = (args["__testDeps"] as RouteIssueDeps | undefined) ?? {};
    const logger = deps.logger ?? defaultLogger;

    const unknown = findUnknownOptions(args, KNOWN_OPTIONS);
    if (unknown.length > 0) {
      return fail(
        `Unknown option(s) ${unknown.map((k) => `--${k}`).join(", ")}; ` +
          "refused rather than ignored, so a mistyped --dry-run cannot " +
          "become a live run",
      );
    }
    const dryRun = coerceBooleanFlag(args["dry-run"], "dry-run", false);
    if (!dryRun.ok) return fail(dryRun.error.message);
    const json = coerceBooleanFlag(args["json"], "json", false);
    if (!json.ok) return fail(json.error.message);

    const context: IssueRoutingContext = {
      vibeCoderRepo: ROUTE_ISSUE_VIBECODER_REPO,
      productRepos: (config.repos ?? []).filter((r) => isValidRepoSlug(r)),
    };
    const gh = { ghCommandFn: deps.ghCommandFn, now: deps.now };
    const finish = (
      success: boolean,
      summary: string,
      data: RouteIssueData,
    ): CommandResult<RouteIssueData> => ({
      success,
      message: json.value ? JSON.stringify(data, null, 2) : summary,
      data,
    });

    // --resolve-duplicate mode.
    if (args["resolve-duplicate"] !== undefined) {
      const refused = refuseOptions(
        args,
        ["repo", "title", "body-file", "label", "part"],
        "--resolve-duplicate",
      );
      if (refused) return refused;
      const raw = args["resolve-duplicate"];
      const wrong = typeof raw === "string" ? parseIssueRef(raw) : null;
      if (wrong === null) {
        return fail(
          "Argument --resolve-duplicate must be owner/name#N, got " +
            JSON.stringify(raw),
        );
      }
      let correct;
      if (args["correct"] !== undefined) {
        const c = args["correct"];
        correct = typeof c === "string" ? parseIssueRef(c) : null;
        if (correct === null) {
          return fail(
            `Argument --correct must be owner/name#N, got ${JSON.stringify(c)}`,
          );
        }
      }
      try {
        const result = await resolveWrongRepoDuplicate({
          wrong,
          correct: correct ?? undefined,
          context,
          dryRun: dryRun.value,
          logger,
          ...gh,
        });
        const { decision, ...rest } = result;
        const data: RouteIssueResolveData = {
          mode: "resolve-duplicate",
          ...rest,
          owner_repository: decision?.owner_repository ?? null,
          issue_kind: decision?.issue_kind ?? null,
        };
        return finish(
          result.outcome !== "refused",
          `route-issue ${result.outcome}: ${result.reason}`,
          data,
        );
      } catch (error) {
        return fail(
          `route-issue --resolve-duplicate failed: ${errorText(error)}`,
        );
      }
    }
    if (args["correct"] !== undefined) {
      return fail("--correct needs --resolve-duplicate");
    }

    // Create and split modes share --repo, --body-file and --label.
    const repo = requireString(args, "repo");
    if (typeof repo !== "string") return repo;
    if (!isValidRepoSlug(repo)) {
      return fail(
        `Argument --repo must be owner/name, got ${JSON.stringify(repo)}`,
      );
    }
    const bodyFile = requireString(args, "body-file");
    if (typeof bodyFile !== "string") return bodyFile;
    const labels = coerceStringListFlag(args["label"], "label");
    if (!labels.ok) return fail(labels.error.message);
    let body: string;
    try {
      body = await (deps.readTextFile ?? Deno.readTextFile)(bodyFile);
    } catch (error) {
      return fail(
        `Could not read --body-file ${bodyFile}: ${errorText(error)}`,
      );
    }
    const extraReservedLabels = customLabelPromptLabels(config);

    // --part mode.
    if (args["part"] !== undefined) {
      const refused = refuseOptions(args, ["title"], "--part");
      if (refused) return refused;
      const parts = parseParts(args["part"]);
      if (typeof parts === "string") return fail(parts);
      try {
        const result = await fileSplitIssues(parts, {
          targetRepo: repo,
          body,
          labels: labels.value,
          context,
          dryRun: dryRun.value,
          extraReservedLabels,
          logger,
          ...gh,
        });
        const list = result.parts.map((p) =>
          p.number === null
            ? `${p.repo} (${p.action})`
            : `${p.repo}#${p.number} (${p.action})`
        ).join(", ");
        const summary = result.complete
          ? `route-issue split${dryRun.value ? " (dry-run)" : ""}: ${list}`
          : `route-issue split incomplete; missing ${
            result.missing.join(", ")
          }: ${list}`;
        return finish(result.complete, summary, { mode: "split", ...result });
      } catch (error) {
        return fail(`route-issue --part failed: ${errorText(error)}`);
      }
    }

    // Create mode.
    const title = requireString(args, "title");
    if (typeof title !== "string") return title;
    try {
      const result = await fileRoutedIssue(
        { title, body, labels: labels.value },
        {
          targetRepo: repo,
          context,
          dryRun: dryRun.value,
          extraReservedLabels,
          logger,
          ...gh,
        },
      );
      const d = result.decision;
      const data: RouteIssueCreateData = {
        mode: "create",
        owner_repository: d.owner_repository,
        subject_repository: d.subject_repository,
        issue_kind: d.issue_kind,
        reason: d.reason,
        action: result.action,
        issue: result.number === null
          ? null
          : formatIssueRef({ repo: result.repository, number: result.number }),
        labels_not_migrated: result.labels_not_migrated,
        ...(result.closed_duplicate === undefined ? {} : {
          closed_duplicate: formatIssueRef({
            repo: result.repository,
            number: result.closed_duplicate,
          }),
        }),
      };
      // An ambiguous owner files nothing: that is not a success.
      return finish(result.action !== "ambiguous", createSummary(data), data);
    } catch (error) {
      return fail(`route-issue failed: ${errorText(error)}`);
    }
  },
};
