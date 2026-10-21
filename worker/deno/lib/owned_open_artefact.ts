/**
 * Owned, open, fleet-authored artefact reuse (Issue #3854).
 *
 * A dedup hit may suppress a filing; only an owned, open match may be reused
 * or written to. An issue or PR is reusable only when the marker owns it, it is
 * open, and a fleet account authored it. Fails loud: a listing that cannot be
 * read throws rather than reading as "nothing to reuse", which would file a
 * duplicate. An unresolved fleet author set discards every row, so the failure
 * direction is toward filing, not reuse.
 *
 * Australian English spelling used throughout.
 */

import type { GhCommandFn } from "./issue_routing_github.ts";
import {
  type AlertDedupAuthorOptions,
  type AlertDedupRow,
  selectFleetAuthoredMatches,
} from "./alert_dedup_authors.ts";

/** One artefact the marker owns, that is open and was authored by the fleet. */
export interface OwnedOpenArtefact {
  number: number;
  url: string;
  title?: string;
  body?: string;
  headRefName?: string;
}

/** Inputs to {@link findOwnedOpenArtefact}. */
export interface FindOwnedOpenArtefactParams {
  /** Repository as `owner/name`. */
  repo: string;
  kind: "issue" | "pr";
  /** Issue: text the body must contain. PR: head-branch prefix. */
  marker: string;
  /** Runs one `gh` command and resolves to its stdout. */
  ghCommandFn: GhCommandFn;
  /** Issue only: passed to `gh issue list --search`. */
  search?: string;
  /** Issue only: extra predicate, for example title equality. */
  accept?: (row: { title?: string; body?: string }) => boolean;
  /** PR only: passed to `gh pr list --base`. */
  base?: string;
  /** Omitted means the configured fleet identity. */
  authors?: AlertDedupAuthorOptions;
  log?: (message: string) => void;
}

/** Inputs to {@link verifyOwnedOpenIssue}. */
export interface VerifyOwnedOpenIssueParams {
  /** Repository as `owner/name`. */
  repo: string;
  number: number;
  /** Text the body must contain. */
  marker: string;
  accept?: (body: string) => boolean;
  /** Runs one `gh` command and resolves to its stdout. */
  ghCommandFn: GhCommandFn;
  /** Omitted means the configured fleet identity. */
  authors?: AlertDedupAuthorOptions;
  log?: (message: string) => void;
}

/** Whether an existing issue may be reused, with the failed check named. */
export type OwnedIssueVerdict =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/** `gh issue list` page cap; a page that reaches it fails closed. */
const ISSUE_LIST_LIMIT = 200;

/** `gh pr list` page cap; a page that reaches it fails closed. */
const PR_LIST_LIMIT = 100;

const ISSUE_LIST_FIELDS = "number,title,body,author,url,state";
const PR_LIST_FIELDS = "number,url,headRefName,author,isCrossRepository,state";
const ISSUE_VIEW_FIELDS = "number,url,state,body,author";

/** A listed row that has passed the owned and open checks, ready for the author gate. */
interface Candidate extends AlertDedupRow {
  url: string;
  title?: string;
  headRefName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? "";
}

/** Reads the author as a `{ login }` object; anything else is no author. */
function authorOf(value: unknown): { login: string | null } | null {
  if (!isRecord(value)) return null;
  return {
    login: typeof value.login === "string" ? value.login : null,
  };
}

/** Parses a list response, failing loud on bad JSON, a bad shape or a full page. */
function parseListing(
  context: string,
  raw: string,
  limit: number,
): Record<string, unknown>[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${firstLine(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${context} returned an unexpected response`);
  }
  // A full page may hide matches beyond it, so reaching the limit fails closed.
  if (parsed.length >= limit) {
    throw new Error(
      `${context} returned the limit of ${limit} results, so matches beyond it would be missed`,
    );
  }
  for (const row of parsed) {
    if (
      !isRecord(row) || !isPositiveInteger(row.number) ||
      typeof row.state !== "string" || typeof row.url !== "string"
    ) {
      throw new Error(`${context} returned a row with an unexpected shape`);
    }
  }
  return parsed as Record<string, unknown>[];
}

/** Whether an issue row carries the marker and passes the caller's predicate. */
function isOwnedIssue(
  row: Record<string, unknown>,
  marker: string,
  accept: FindOwnedOpenArtefactParams["accept"],
): boolean {
  const body = typeof row.body === "string" ? row.body : "";
  const title = typeof row.title === "string" ? row.title : undefined;
  if (!body.includes(marker)) return false;
  return accept ? accept({ title, body }) : true;
}

/** Whether a PR row sits on the marker prefix and is a same-repository head. */
function isOwnedPr(row: Record<string, unknown>, marker: string): boolean {
  return typeof row.headRefName === "string" &&
    row.headRefName.startsWith(marker) && row.isCrossRepository === false;
}

/**
 * Finds the lowest-numbered issue or PR this fleet owns, that is open.
 *
 * @returns The match, or `null` when nothing owned, open and fleet-authored
 *   exists (including when the fleet author set is unresolved)
 * @throws Error on a failed `gh` call, invalid JSON, a bad row shape or a
 *   listing that reaches its limit
 */
export async function findOwnedOpenArtefact(
  p: FindOwnedOpenArtefactParams,
): Promise<OwnedOpenArtefact | null> {
  const log = p.log ?? ((message: string) => console.warn(message));
  const context = `Owned ${p.kind} lookup in ${p.repo}`;
  const isIssue = p.kind === "issue";
  const args = isIssue
    ? [
      "issue",
      "list",
      "--repo",
      p.repo,
      "--state",
      "open",
      ...(p.search !== undefined ? ["--search", p.search] : []),
      "--json",
      ISSUE_LIST_FIELDS,
      "--limit",
      String(ISSUE_LIST_LIMIT),
    ]
    : [
      "pr",
      "list",
      "--repo",
      p.repo,
      "--state",
      "open",
      ...(p.base !== undefined ? ["--base", p.base] : []),
      "--json",
      PR_LIST_FIELDS,
      "--limit",
      String(PR_LIST_LIMIT),
    ];

  let raw: string;
  try {
    raw = await p.ghCommandFn(args);
  } catch (error) {
    throw new Error(`${context} failed: ${firstLine(error)}`, { cause: error });
  }
  const rows = parseListing(
    context,
    raw,
    isIssue ? ISSUE_LIST_LIMIT : PR_LIST_LIMIT,
  );

  const owned: Candidate[] = [];
  for (const row of rows) {
    // Only an open artefact is reusable; a closed match is history, not a live item.
    if (row.state !== "OPEN") continue;
    if (isIssue) {
      if (!isOwnedIssue(row, p.marker, p.accept)) continue;
      owned.push({
        number: row.number as number,
        url: row.url as string,
        title: typeof row.title === "string" ? row.title : undefined,
        body: typeof row.body === "string" ? row.body : "",
        author: authorOf(row.author),
      });
    } else {
      if (!isOwnedPr(row, p.marker)) continue;
      owned.push({
        number: row.number as number,
        url: row.url as string,
        headRefName: row.headRefName as string,
        author: authorOf(row.author),
      });
    }
  }

  const matches = await selectFleetAuthoredMatches(
    owned,
    context,
    p.authors ?? {},
    log,
    "none is reused or written to",
  );
  if (matches.length === 0) return null;
  const lowest = matches.reduce((a, b) => (b.number < a.number ? b : a));
  if (isIssue) {
    return {
      number: lowest.number,
      url: lowest.url,
      title: lowest.title,
      body: lowest.body,
    };
  }
  return {
    number: lowest.number,
    url: lowest.url,
    headRefName: lowest.headRefName,
  };
}

/**
 * Decides whether an existing issue may be reused, naming the failed check.
 *
 * @returns `{ ok: true, url }` only when the issue is open, carries the marker,
 *   passes `accept` and was authored by the fleet
 * @throws Error on a failed `gh` call, invalid JSON or a bad response shape
 */
export async function verifyOwnedOpenIssue(
  p: VerifyOwnedOpenIssueParams,
): Promise<OwnedIssueVerdict> {
  const log = p.log ?? ((message: string) => console.warn(message));
  const context = `Owned issue check in ${p.repo} for #${p.number}`;
  let raw: string;
  try {
    raw = await p.ghCommandFn([
      "issue",
      "view",
      String(p.number),
      "--repo",
      p.repo,
      "--json",
      ISSUE_VIEW_FIELDS,
    ]);
  } catch (error) {
    throw new Error(`${context} failed: ${firstLine(error)}`, { cause: error });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${context} returned invalid JSON: ${firstLine(error)}`, {
      cause: error,
    });
  }
  if (
    !isRecord(parsed) || !isPositiveInteger(parsed.number) ||
    parsed.number !== p.number || typeof parsed.url !== "string" ||
    typeof parsed.state !== "string"
  ) {
    throw new Error(`${context} returned an unexpected response`);
  }
  const url = parsed.url;

  // Each check below is named in the verdict so a refusal says which one failed.
  if (parsed.state !== "OPEN") {
    return { ok: false, reason: `state is ${parsed.state}, not OPEN` };
  }
  const body = typeof parsed.body === "string" ? parsed.body : "";
  if (!body.includes(p.marker)) {
    return { ok: false, reason: "body does not contain the marker" };
  }
  if (p.accept && !p.accept(body)) {
    return { ok: false, reason: "body was rejected by the accept check" };
  }
  const kept = await selectFleetAuthoredMatches(
    [{ number: p.number, url, author: authorOf(parsed.author) }],
    context,
    p.authors ?? {},
    log,
    "it is not reused or written to",
  );
  if (kept.length === 0) {
    return { ok: false, reason: "author is not a fleet account" };
  }
  return { ok: true, url };
}
