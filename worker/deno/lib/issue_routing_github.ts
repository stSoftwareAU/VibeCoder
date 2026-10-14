import { sameRepo } from "./issue_routing_classifier.ts";
import { IssueRoutingPermissionError } from "./issue_routing_types.ts";
import type {
  Gh,
  IssueRoutingContext,
  RoutedIssueRef,
} from "./issue_routing_types.ts";

const WRITE_PERMISSIONS: ReadonlySet<string> = new Set([
  "WRITE",
  "MAINTAIN",
  "ADMIN",
  "TRIAGE",
]);
const MS_PER_DAY = 86_400_000;

interface SearchRow {
  number: number;
  title: string;
  state: string;
  closedAt?: string | null;
  url?: string | null;
  author?: { login?: string | null } | null;
}

function normaliseTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseRows(raw: string, what: string): SearchRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Malformed JSON from ${what}: ${err}`, { cause: err });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Unexpected (non-array) JSON from ${what}`);
  }
  return parsed.filter((r): r is SearchRow =>
    typeof r === "object" && r !== null &&
    typeof (r as SearchRow).number === "number" &&
    typeof (r as SearchRow).title === "string"
  );
}

/** A reusable existing issue or PR with this exact title, lowest first. */
export async function findMatches(
  repo: string,
  title: string,
  ctx: IssueRoutingContext,
  gh: Gh,
): Promise<RoutedIssueRef[]> {
  const search = `${title} in:title`;
  const issues = parseRows(
    await gh([
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--search",
      search,
      "--json",
      "number,title,state,closedAt,url,author",
      "--limit",
      "50",
    ]),
    `gh issue list (${repo})`,
  );
  const prs = parseRows(
    await gh([
      "pr",
      "list",
      "--repo",
      repo,
      "--state",
      "all",
      "--search",
      search,
      "--json",
      "number,title,state,closedAt,url,author",
    ]),
    `gh pr list (${repo})`,
  );
  const want = normaliseTitle(title);
  const windowMs = ctx.recentlyClosedDays * MS_PER_DAY;
  const matches: RoutedIssueRef[] = [];
  const consider = (row: SearchRow): void => {
    if (normaliseTitle(row.title) !== want) return;
    const open = row.state.toUpperCase() === "OPEN";
    if (!open) {
      const closedMs = Date.parse(row.closedAt ?? "");
      if (!Number.isFinite(closedMs) || ctx.nowMs - closedMs > windowMs) {
        return;
      }
    }
    matches.push({
      repo,
      number: row.number,
      url: row.url ?? null,
      state: open ? "open" : "closed",
    });
  };
  issues.forEach(consider);
  prs.forEach(consider);
  return matches.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
}

/** Require the write permission needed to file in `repo`. */
export async function requireWriteAccess(
  repo: string,
  ctx: IssueRoutingContext,
  gh: Gh,
): Promise<void> {
  if (!ctx.allowedRepos.some((r) => sameRepo(r, repo))) {
    throw new IssueRoutingPermissionError(
      `Refusing to write to ${repo}: not in the allowed repositories`,
    );
  }
  let observed: string;
  try {
    observed = (await gh([
      "repo",
      "view",
      repo,
      "--json",
      "viewerPermission",
      "--jq",
      ".viewerPermission",
    ])).trim();
  } catch (err) {
    throw new IssueRoutingPermissionError(
      `Could not verify permission on ${repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      { cause: err },
    );
  }
  if (!WRITE_PERMISSIONS.has(observed.toUpperCase())) {
    throw new IssueRoutingPermissionError(
      `Refusing to write to ${repo}: viewer permission is '${observed}'`,
    );
  }
}
