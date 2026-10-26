// Claims a fleet PR for one host before it is reviewed (Issue #4398).
//
// Several hosts run .claude/skills/review-fleet-prs/scripts/run.sh against the
// same PRs. A host claims a PR by posting a hidden PR comment whose whole body
// is one marker line:
//   <!-- vibe-review-claim sha=<head> host=<host> expires=<iso> -->
// It then re-reads the thread and reviews the PR only when its claim is the
// lowest-id live claim at that head. A claim lives until `expires=`, but never
// longer than MAX_CLAIM_SECONDS after its comment was created, so a forged
// far-future expiry cannot hold a PR off.
//
// Usage: deno run --allow-run=gh claim.ts claim --repo=<owner/name>
//          --number=<n> --sha=<head> --host=<host> --ttl=<seconds>
//        deno run --allow-run=gh claim.ts release --repo=<owner/name>
//          --number=<n> [--host=<host>] [--sha=<head>]
// `claim` prints {"won":true|false,"id":<n>} and exits 0 for either outcome;
// `release` prints {"released":<n>}. Any error goes to stderr, exit 1.

export const CLAIM_MARKER = "vibe-review-claim";
/** A claim never lives longer than this after its comment was created, whatever `expires=` says (a forged far-future expiry cannot hold a PR off). */
export const MAX_CLAIM_SECONDS = 7200;
export type Gh = (args: string[]) => Promise<string>;
export interface ClaimComment {
  id: number;
  body: string | null;
  createdAt: string;
  author: string | null;
}
export interface ReviewClaim {
  id: number;
  sha: string;
  host: string;
  expiresAtMs: number;
  author: string | null;
}

const TOKEN = /^[A-Za-z0-9._-]+$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const POSITIVE_INT = /^[1-9]\d*$/;
const MARKER_OPEN = `<!-- ${CLAIM_MARKER}`;
// Anchored over the whole trimmed body: a marker quoted in prose or a code
// fence is not a claim.
const CLAIM_LINE = new RegExp(
  `^<!-- ${CLAIM_MARKER} sha=([A-Za-z0-9._-]+) host=([A-Za-z0-9._-]+) expires=(\\S+) -->$`,
);

function assertToken(label: string, value: string): void {
  if (!TOKEN.test(value)) {
    throw new Error(
      `claim ${label} must match [A-Za-z0-9._-]+: ${JSON.stringify(value)}`,
    );
  }
}

/** The body of a claim comment for `sha`, held by `host`, until `expiresAtMs`. */
export function claimBody(
  sha: string,
  host: string,
  expiresAtMs: number,
): string {
  assertToken("sha", sha);
  assertToken("host", host);
  return `${MARKER_OPEN} sha=${sha} host=${host} expires=${
    new Date(expiresAtMs).toISOString()
  } -->`;
}

/**
 * The claim a comment carries, or null when it is not exactly one claim
 * marker. The effective expiry is clamped to MAX_CLAIM_SECONDS after the
 * comment's creation.
 */
export function parseClaim(c: ClaimComment): ReviewClaim | null {
  if (typeof c.body !== "string") return null;
  const body = c.body.trim();
  if (body.split(MARKER_OPEN).length !== 2) return null;
  const m = CLAIM_LINE.exec(body);
  if (m === null) return null;
  const [, sha, host, expires] = m;
  if (sha === undefined || host === undefined || expires === undefined) {
    return null;
  }
  const createdMs = Date.parse(c.createdAt);
  const expiresMs = Date.parse(expires);
  if (!Number.isFinite(createdMs) || !Number.isFinite(expiresMs)) return null;
  return {
    id: c.id,
    sha,
    host,
    expiresAtMs: Math.min(expiresMs, createdMs + MAX_CLAIM_SECONDS * 1000),
    author: c.author,
  };
}

/** Claims live at `sha` (expiry strictly after `nowMs`), lowest comment id first. */
export function liveClaimsAt(
  comments: ClaimComment[],
  sha: string,
  nowMs: number,
): ReviewClaim[] {
  const live: ReviewClaim[] = [];
  for (const c of comments) {
    const claim = parseClaim(c);
    if (claim && claim.sha === sha && claim.expiresAtMs > nowMs) {
      live.push(claim);
    }
  }
  return live.sort((a, b) => a.id - b.id);
}

/** True when a live claim at `sha` is held by a host other than `host`. */
export function claimedElsewhere(
  comments: ClaimComment[],
  sha: string,
  host: string,
  nowMs: number,
): boolean {
  return liveClaimsAt(comments, sha, nowMs).some((c) => c.host !== host);
}

/**
 * Splits a `gh api --paginate` payload into its top-level JSON arrays. gh
 * prints each page's array in turn (`[...][...]`), so the payload is not one
 * JSON value once a PR has more than one page. Throws on empty output or any
 * character outside an array, so a blind read never passes as no comments.
 */
function splitJsonArrays(payload: string): string[] {
  const chunks: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = -1;
  for (let i = 0; i < payload.length; i++) {
    const ch = payload.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (depth === 0) {
      if (/\s/.test(ch)) continue;
      if (ch !== "[") {
        throw new Error(
          `unexpected character ${JSON.stringify(ch)} at offset ${i}`,
        );
      }
      start = i;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) chunks.push(payload.slice(start, i + 1));
    }
  }
  if (depth !== 0 || inString) throw new Error("truncated JSON output");
  if (chunks.length === 0) throw new Error("empty output");
  return chunks;
}

function parseCommentPages(payload: string): unknown[] {
  const rows: unknown[] = [];
  for (const page of splitJsonArrays(payload)) {
    const parsed: unknown = JSON.parse(page);
    if (!Array.isArray(parsed)) throw new Error("a page is not a JSON array");
    for (const row of parsed) rows.push(row);
  }
  return rows;
}

function toClaimComment(row: unknown, where: string): ClaimComment {
  if (typeof row !== "object" || row === null) {
    throw new Error(`${where}: malformed comment row`);
  }
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "number") {
    throw new Error(`${where}: comment row has no numeric id`);
  }
  const user = r.user as { login?: unknown } | null | undefined;
  return {
    id: r.id,
    body: typeof r.body === "string" ? r.body : null,
    createdAt: typeof r.created_at === "string" ? r.created_at : "",
    author: typeof user?.login === "string" ? user.login : null,
  };
}

/** Every comment on the PR, across every page. Throws rather than read as empty. */
export async function fetchClaimComments(
  gh: Gh,
  repo: string,
  number: number,
): Promise<ClaimComment[]> {
  const where = `${repo}#${number}`;
  let payload: string;
  try {
    payload = await gh([
      "api",
      `repos/${repo}/issues/${number}/comments`,
      "--paginate",
    ]);
  } catch (e) {
    throw new Error(
      `${where}: listing comments failed: ${(e as Error).message}`,
    );
  }
  let rows: unknown[];
  try {
    rows = parseCommentPages(payload);
  } catch (e) {
    throw new Error(
      `${where}: could not parse the comment list: ${(e as Error).message}`,
    );
  }
  return rows.map((row) => toClaimComment(row, where));
}

async function postClaim(
  gh: Gh,
  repo: string,
  number: number,
  body: string,
): Promise<number> {
  const endpoint = `repos/${repo}/issues/${number}/comments`;
  let reply: unknown;
  try {
    reply = JSON.parse(
      await gh(["api", "-X", "POST", endpoint, "-f", `body=${body}`]),
    );
  } catch (e) {
    throw new Error(
      `${repo}#${number}: posting the claim to ${endpoint} failed: ${
        (e as Error).message
      }`,
    );
  }
  const id = (reply as { id?: unknown } | null)?.id;
  if (typeof id !== "number") {
    throw new Error(
      `${repo}#${number}: the reply from ${endpoint} has no comment id`,
    );
  }
  return id;
}

/**
 * Deletes one comment. Returns false when GitHub says it is already gone
 * (404); any other failure throws, naming the id.
 */
async function deleteComment(
  gh: Gh,
  repo: string,
  id: number,
): Promise<boolean> {
  try {
    await gh(["api", "-X", "DELETE", `repos/${repo}/issues/comments/${id}`]);
    return true;
  } catch (e) {
    const message = (e as Error).message;
    if (/HTTP 404|Not Found/.test(message)) return false;
    throw new Error(
      `deleting claim comment ${id} on ${repo} failed: ${message}`,
    );
  }
}

/**
 * Claims the PR for `host` at `sha` and reports whether this host is the
 * winner. Posts a claim, re-reads the thread, and the lowest-id live claim at
 * `sha` wins. A losing claim is deleted (loudly, if the delete fails). Any
 * failure after the post deletes this host's claim best effort and throws.
 */
export async function claimPr(o: {
  gh: Gh;
  repo: string;
  number: number;
  sha: string;
  host: string;
  ttlSeconds: number;
  now?: () => number;
}): Promise<{ won: boolean; id: number }> {
  const where = `${o.repo}#${o.number}`;
  const now = o.now ?? (() => Date.now());
  if (
    !Number.isInteger(o.ttlSeconds) || o.ttlSeconds < 1 ||
    o.ttlSeconds > MAX_CLAIM_SECONDS
  ) {
    throw new Error(
      `ttlSeconds must be an integer from 1 to ${MAX_CLAIM_SECONDS}: ${o.ttlSeconds}`,
    );
  }

  // 1. Drop this host's own earlier claims (any sha) so a crashed round cannot linger.
  for (const c of await fetchClaimComments(o.gh, o.repo, o.number)) {
    const claim = parseClaim(c);
    if (claim && claim.host === o.host) {
      await deleteComment(o.gh, o.repo, c.id);
    }
  }

  // 2. Post this host's claim.
  const body = claimBody(o.sha, o.host, now() + o.ttlSeconds * 1000);
  const id = await postClaim(o.gh, o.repo, o.number, body);

  // 3. Re-read and decide. Any failure removes this claim best effort.
  let won: boolean;
  try {
    const after = await fetchClaimComments(o.gh, o.repo, o.number);
    if (!after.some((c) => c.id === id)) {
      throw new Error(
        `${where}: claim comment ${id} is missing from the re-read`,
      );
    }
    const live = liveClaimsAt(after, o.sha, now());
    won = live.length > 0 && live[0]?.id === id;
  } catch (e) {
    await deleteComment(o.gh, o.repo, id).catch(() => {});
    throw e;
  }

  // 4. A loser removes its own claim, and that delete must succeed.
  if (!won) await deleteComment(o.gh, o.repo, id);
  return { won, id };
}

/**
 * Deletes every claim comment on the PR that matches the optional `host` and
 * `sha` filters, expired ones included. Returns how many this call deleted; a
 * comment already gone (404) is not counted. Every failure is collected and
 * thrown together, naming each id.
 */
export async function releaseClaims(
  gh: Gh,
  repo: string,
  number: number,
  o: { host?: string; sha?: string },
): Promise<number> {
  let released = 0;
  const failures: string[] = [];
  for (const c of await fetchClaimComments(gh, repo, number)) {
    const claim = parseClaim(c);
    if (!claim) continue;
    if (o.host !== undefined && claim.host !== o.host) continue;
    if (o.sha !== undefined && claim.sha !== o.sha) continue;
    try {
      if (await deleteComment(gh, repo, c.id)) released++;
    } catch (e) {
      failures.push((e as Error).message);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `${repo}#${number}: ${failures.length} claim comment(s) could not be deleted: ${
        failures.join("; ")
      }`,
    );
  }
  return released;
}

async function runGh(args: string[]): Promise<string> {
  const out = await new Deno.Command("gh", {
    args,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  if (!out.success) {
    const endpoint = args.find((a) => a.startsWith("repos/")) ??
      args.join(" ");
    const err = decoder.decode(out.stderr).trim();
    throw new Error(`gh ${endpoint}: ${err}`);
  }
  return decoder.decode(out.stdout).trim();
}

function parseFlags(
  args: string[],
  allowed: readonly string[],
): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    const m = /^--([a-z]+)=(.*)$/.exec(arg);
    const key = m?.[1];
    const value = m?.[2];
    if (key === undefined || value === undefined || !allowed.includes(key)) {
      throw new Error(`unknown or malformed argument ${JSON.stringify(arg)}`);
    }
    if (Object.hasOwn(flags, key)) {
      throw new Error(`--${key} given more than once`);
    }
    flags[key] = value;
  }
  return flags;
}

function checked(
  flags: Record<string, string>,
  key: string,
  pattern: RegExp,
  what: string,
  optional = false,
): string | undefined {
  const value = flags[key];
  if (value === undefined) {
    if (optional) return undefined;
    throw new Error(`--${key}=<${what}> is required`);
  }
  if (!pattern.test(value)) {
    throw new Error(`--${key}=${value} is not a valid ${what}`);
  }
  return value;
}

export async function main(
  argv: string[] = Deno.args,
  gh: Gh = runGh,
): Promise<void> {
  try {
    const [command, ...rest] = argv;
    if (command === "claim") {
      const flags = parseFlags(rest, ["repo", "number", "sha", "host", "ttl"]);
      const repo = checked(flags, "repo", REPO, "owner/name")!;
      const number = Number(
        checked(flags, "number", POSITIVE_INT, "PR number")!,
      );
      const sha = checked(flags, "sha", TOKEN, "head sha")!;
      const host = checked(flags, "host", TOKEN, "host")!;
      const ttl = Number(checked(flags, "ttl", POSITIVE_INT, "ttl seconds")!);
      if (ttl > MAX_CLAIM_SECONDS) {
        throw new Error(`--ttl must be at most ${MAX_CLAIM_SECONDS}`);
      }
      const result = await claimPr({
        gh,
        repo,
        number,
        sha,
        host,
        ttlSeconds: ttl,
      });
      console.log(JSON.stringify(result));
    } else if (command === "release") {
      const flags = parseFlags(rest, ["repo", "number", "host", "sha"]);
      const repo = checked(flags, "repo", REPO, "owner/name")!;
      const number = Number(
        checked(flags, "number", POSITIVE_INT, "PR number")!,
      );
      const host = checked(flags, "host", TOKEN, "host", true);
      const sha = checked(flags, "sha", TOKEN, "head sha", true);
      const released = await releaseClaims(gh, repo, number, { host, sha });
      console.log(JSON.stringify({ released }));
    } else {
      throw new Error(
        "usage: claim.ts claim|release --repo=<owner/name> --number=<n> ...",
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(message.split("\n")[0]);
    Deno.exit(1);
  }
}

if (import.meta.main) await main();
