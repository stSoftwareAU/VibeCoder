/**
 * collect-security-batch command (Issue #2402).
 *
 * Part of the worker-throughput epic #2400. Collects a repo's open
 * `security` findings and groups them into batched-remediation candidates
 * via the grouping engine in `lib/security_remediation_grouping.ts`. The
 * output is the mechanism a batched security-remediation dispatch consumes:
 * each group is a set of findings that can be fixed in one branch/PR, with
 * a ready-made `Closes #N` block so every closed finding stays traceable.
 *
 * Arguments:
 *   --repo            Repository in "owner/repo" format (required)
 *   --strategy        Grouping strategy: file | class | dependency (default file)
 *   --max-group-size  PR-size cap per group (default 5)
 *
 * Output: JSON { strategy, maxGroupSize, totalFindings, groups: [...] }.
 *
 * Australian English throughout.
 */

import type { Command, CommandResult, WorkerConfig } from "../types.ts";
import { runGhCommand } from "../lib/github.ts";
import {
  buildClosesReferences,
  buildFindingIdList,
  DEFAULT_MAX_GROUP_SIZE,
  type GroupingStrategy,
  groupSecurityFindings,
  parseSecurityFinding,
  type RawFindingIssue,
} from "../lib/security_remediation_grouping.ts";

/** Label marking the security-scan overflow tracker — never a real finding. */
const OVERFLOW_LABEL = "security-scan-overflow";

const VALID_STRATEGIES: ReadonlySet<string> = new Set([
  "file",
  "class",
  "dependency",
]);

/** One grouped batch in the command output. */
export interface BatchGroupOutput {
  key: string;
  issueNumbers: number[];
  findingIds: string;
  /** GitHub auto-close block — one `Closes #N` line per finding. */
  closes: string;
}

/** Structured result data for the collect-security-batch command. */
export interface CollectSecurityBatchData {
  strategy: GroupingStrategy;
  maxGroupSize: number;
  totalFindings: number;
  groups: BatchGroupOutput[];
}

/** Parsed arguments for the command core. */
export interface CollectSecurityBatchArgs {
  repo: string;
  strategy: GroupingStrategy;
  maxGroupSize: number;
}

/**
 * Parse the gh `issue list --json number,title,body,labels` payload into
 * {@link RawFindingIssue} records. Label objects (`{ name }`) are flattened
 * to plain name strings, and the overflow tracker is filtered out. Any
 * malformed or non-array payload yields an empty list.
 */
export function parseRawFindingIssues(raw: string): RawFindingIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const issues: RawFindingIssue[] = [];
  for (const item of parsed) {
    if (item === null || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const number = obj["number"];
    if (typeof number !== "number" || !Number.isFinite(number)) continue;

    const labels = Array.isArray(obj["labels"])
      ? (obj["labels"] as unknown[])
        .map((l) =>
          l !== null && typeof l === "object"
            ? String((l as { name?: unknown }).name ?? "")
            : String(l)
        )
        .filter((name) => name.length > 0)
      : [];

    // Skip the overflow tracker — it is not a remediable finding.
    if (labels.includes(OVERFLOW_LABEL)) continue;

    issues.push({
      number,
      title: typeof obj["title"] === "string" ? obj["title"] : "",
      body: typeof obj["body"] === "string" ? obj["body"] : "",
      labels,
    });
  }
  return issues;
}

/**
 * Core logic — lists open `security` findings, parses them, and groups them.
 * Extracted so tests can inject a fake gh runner.
 */
export async function collectSecurityBatch(
  args: CollectSecurityBatchArgs,
  _config: WorkerConfig,
  ghCommandFn: (args: string[]) => Promise<string> = runGhCommand,
): Promise<CommandResult<CollectSecurityBatchData>> {
  let raw: string;
  try {
    raw = await ghCommandFn([
      "issue",
      "list",
      "--repo",
      args.repo,
      "--state",
      "open",
      "--label",
      "security",
      "--json",
      "number,title,body,labels",
      "--limit",
      "200",
    ]);
  } catch (err) {
    return {
      success: false,
      message: `Failed to list security issues for ${args.repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }

  const rawIssues = parseRawFindingIssues(raw);
  const findings = rawIssues.map(parseSecurityFinding);
  const groups = groupSecurityFindings(findings, {
    strategy: args.strategy,
    maxGroupSize: args.maxGroupSize,
  });

  const groupOutputs: BatchGroupOutput[] = groups.map((g) => ({
    key: g.key,
    issueNumbers: g.findings.map((f) => f.issueNumber),
    findingIds: buildFindingIdList(g),
    closes: buildClosesReferences(g),
  }));

  const data: CollectSecurityBatchData = {
    strategy: args.strategy,
    maxGroupSize: args.maxGroupSize,
    totalFindings: findings.length,
    groups: groupOutputs,
  };

  return {
    success: true,
    message: JSON.stringify(data),
    data,
  };
}

/** Parse and validate raw CLI arguments, or return an error string. */
export function parseCollectSecurityBatchArgs(
  args: Record<string, unknown>,
): CollectSecurityBatchArgs | string {
  const repo = String(args["repo"] ?? "");
  if (!repo) return "Missing required argument: --repo";

  const strategyRaw = String(args["strategy"] ?? "file");
  if (!VALID_STRATEGIES.has(strategyRaw)) {
    return `Invalid --strategy '${strategyRaw}' (expected file|class|dependency)`;
  }
  const strategy = strategyRaw as GroupingStrategy;

  const maxGroupSize = args["max-group-size"] !== undefined
    ? Number(args["max-group-size"])
    : DEFAULT_MAX_GROUP_SIZE;
  if (!Number.isInteger(maxGroupSize) || maxGroupSize < 1) {
    return `Invalid --max-group-size '${
      args["max-group-size"]
    }' (expected a positive integer)`;
  }

  return { repo, strategy, maxGroupSize };
}

export const collectSecurityBatchCommand: Command = {
  name: "collect-security-batch",
  description:
    "Collect a repo's open security findings and group them into batched-remediation candidates (Issue #2402)",

  async execute(
    args: Record<string, unknown>,
    config: WorkerConfig,
  ): Promise<CommandResult<CollectSecurityBatchData>> {
    const parsed = parseCollectSecurityBatchArgs(args);
    if (typeof parsed === "string") {
      return { success: false, message: parsed };
    }
    return await collectSecurityBatch(parsed, config);
  },
};
