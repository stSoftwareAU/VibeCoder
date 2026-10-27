/**
 * The review-fleet-prs PR claim (Issue #4398).
 *
 * Several hosts run the review-fleet-prs round against the same PRs. A host
 * claims a PR with a hidden claim comment and reviews it only when its claim
 * is the lowest-id live claim at the PR's head. These tests pin the marker
 * format, the expiry rules (including the MAX_CLAIM_SECONDS clamp), the
 * lowest-id race (two and three hosts, both interleavings), the cleanup and
 * release paths, and the loud failures.
 *
 * The fake `gh` mirrors the real calls: a GET list that prints one JSON array
 * per page, a POST that returns the created comment, and a DELETE that answers
 * 404 for a missing comment. It yields once per call so concurrent claimants
 * interleave.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  claimBody,
  type ClaimComment,
  claimedElsewhere,
  claimPr,
  fetchClaimComments,
  type Gh,
  liveClaimsAt,
  MAX_CLAIM_SECONDS,
  parseClaim,
  releaseClaims,
} from "../../../.claude/skills/review-fleet-prs/scripts/claim.ts";

const REPO = "acme/app";
const NUMBER = 7;
const LIST_PATH = `repos/${REPO}/issues/${NUMBER}/comments`;
const SHA = "abc123";
const OTHER_SHA = "def456";
const T0 = Date.parse("2026-10-26T12:00:00.000Z");
const MIN = 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();

const comment = (
  id: number,
  body: string | null,
  createdMs = T0,
  author: string | null = "fleet-bot",
): ClaimComment => ({ id, body, createdAt: iso(createdMs), author });

interface Stored {
  id: number;
  body: string;
  created_at: string;
  user: { login: string };
}

class FakeGithub {
  stored = new Map<number, Stored>();
  ops: string[] = [];
  nowMs = T0;
  /** The next POST is stored but hidden from list reads (eventual consistency). */
  hideNextPost = false;
  failPost = false;
  /** DELETE answers 403 for these ids. */
  forbidDelete = new Set<number>();
  /** DELETE answers 404 for these ids, and the comment stays listed. */
  alreadyGone = new Set<number>();
  /** Lists print one JSON array per page of this many comments; 0 = one array. */
  pageSize = 0;
  #hidden = new Set<number>();
  #nextId = 1;

  readonly gh: Gh = async (args) => {
    // Yield once per call, so concurrent claimants interleave.
    await Promise.resolve();
    return this.#handle(args);
  };

  add(body: string, createdMs = this.nowMs): number {
    const id = this.#nextId++;
    this.stored.set(id, {
      id,
      body,
      created_at: iso(createdMs),
      user: { login: "fleet-bot" },
    });
    return id;
  }

  /** Ids of every comment still on the thread, in creation order. */
  remaining(): number[] {
    return [...this.stored.keys()];
  }

  #handle(args: string[]): string {
    const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
    const endpoint = args.find((a) => a.startsWith("repos/")) ?? "";

    if (method === "GET" && endpoint === LIST_PATH) {
      this.ops.push("list");
      const visible = [...this.stored.values()].filter((c) =>
        !this.#hidden.has(c.id)
      );
      if (visible.length === 0) return "[]";
      if (this.pageSize === 0) return JSON.stringify(visible);
      // gh --paginate prints one array per page, back to back.
      let out = "";
      for (let i = 0; i < visible.length; i += this.pageSize) {
        out += JSON.stringify(visible.slice(i, i + this.pageSize));
      }
      return out;
    }

    if (method === "POST" && endpoint === LIST_PATH) {
      if (this.failPost) {
        throw new Error(`gh ${endpoint}: gh: Server Error (HTTP 500)`);
      }
      const field = args[args.indexOf("-f") + 1] ?? "";
      if (!field.startsWith("body=")) throw new Error(`bad field ${field}`);
      const id = this.add(field.slice("body=".length), this.nowMs);
      this.ops.push(`post:${id}`);
      if (this.hideNextPost) {
        this.#hidden.add(id);
        this.hideNextPost = false;
      }
      return JSON.stringify(this.stored.get(id));
    }

    const del = /^repos\/[^/]+\/[^/]+\/issues\/comments\/(\d+)$/.exec(endpoint);
    if (method === "DELETE" && del) {
      const id = Number(del[1]);
      this.ops.push(`delete:${id}`);
      if (this.forbidDelete.has(id)) {
        throw new Error(
          `gh ${endpoint}: gh: Resource not accessible by integration (HTTP 403)`,
        );
      }
      if (this.alreadyGone.has(id) || !this.stored.has(id)) {
        throw new Error(`gh ${endpoint}: gh: Not Found (HTTP 404)`);
      }
      this.stored.delete(id);
      return "";
    }

    throw new Error(`fake gh: unhandled ${args.join(" ")}`);
  }
}

const claimFor = (fake: FakeGithub, host: string, sha = SHA) => ({
  gh: fake.gh,
  repo: REPO,
  number: NUMBER,
  sha,
  host,
  ttlSeconds: 600,
  now: () => fake.nowMs,
});

/** The ops between the first POST and the first re-read must show every POST first. */
function allPostsBeforeFirstReread(ops: string[], posts: number): boolean {
  const first = ops.findIndex((o) => o.startsWith("post:"));
  const lastPost = ops.findLastIndex((o) => o.startsWith("post:"));
  const firstRead = ops.findIndex((o, i) => i > first && o === "list");
  const postCount = ops.filter((o) => o.startsWith("post:")).length;
  return postCount === posts && firstRead > lastPost;
}

// ---------- marker format ----------

Deno.test("claimBody round-trips through parseClaim", () => {
  const body = claimBody(SHA, "A", T0 + 10 * MIN);
  assertEquals(
    parseClaim(comment(5, body)),
    {
      id: 5,
      sha: SHA,
      host: "A",
      expiresAtMs: T0 + 10 * MIN,
      author: "fleet-bot",
    },
  );
});

Deno.test("claimBody refuses a sha outside [A-Za-z0-9._-]", () => {
  let threw = false;
  try {
    claimBody("ab/cd", "A", T0);
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("parseClaim rejects the marker quoted inside prose", () => {
  const body = `Note: ${claimBody(SHA, "A", T0 + MIN)} is the claim format.`;
  assertEquals(parseClaim(comment(1, body)), null);
});

Deno.test("parseClaim rejects the marker inside a code fence", () => {
  const body = "```\n" + claimBody(SHA, "A", T0 + MIN) + "\n```";
  assertEquals(parseClaim(comment(1, body)), null);
});

Deno.test("parseClaim rejects two markers in one body", () => {
  const body = claimBody(SHA, "A", T0 + MIN) + "\n" +
    claimBody(SHA, "B", T0 + MIN);
  assertEquals(parseClaim(comment(1, body)), null);
});

Deno.test("parseClaim rejects a sha with characters outside the allowed set", () => {
  const body = `<!-- vibe-review-claim sha=ab/cd host=A expires=${
    iso(T0 + MIN)
  } -->`;
  assertEquals(parseClaim(comment(1, body)), null);
});

Deno.test("parseClaim rejects an unparseable expiry and a null body", () => {
  const badExpiry =
    `<!-- vibe-review-claim sha=${SHA} host=A expires=next-tuesday -->`;
  assertEquals(parseClaim(comment(1, badExpiry)), null);
  assertEquals(parseClaim(comment(2, null)), null);
});

Deno.test("parseClaim clamps a 2999 expiry to MAX_CLAIM_SECONDS after creation", () => {
  const body =
    `<!-- vibe-review-claim sha=${SHA} host=A expires=2999-01-01T00:00:00.000Z -->`;
  const comments = [comment(1, body, T0)];
  assertEquals(
    parseClaim(comment(1, body, T0))?.expiresAtMs,
    T0 + MAX_CLAIM_SECONDS * 1000,
  );
  const justPast = T0 + MAX_CLAIM_SECONDS * 1000 + 1;
  assertEquals(liveClaimsAt(comments, SHA, justPast), []);
  assertEquals(liveClaimsAt(comments, SHA, justPast - 2).length, 1);
});

// ---------- liveClaimsAt / claimedElsewhere ----------

Deno.test("liveClaimsAt ignores an expired claim, another sha, and sorts by id", () => {
  const comments = [
    comment(9, claimBody(SHA, "C", T0 + 10 * MIN)),
    comment(3, claimBody(SHA, "A", T0 + 10 * MIN)),
    comment(4, claimBody(SHA, "B", T0 + MIN)),
    comment(5, claimBody(OTHER_SHA, "D", T0 + 10 * MIN)),
  ];
  const live = liveClaimsAt(comments, SHA, T0 + 2 * MIN);
  assertEquals(live.map((c) => c.id), [3, 9]);
});

Deno.test("liveClaimsAt treats an expiry equal to now as expired", () => {
  const comments = [comment(1, claimBody(SHA, "A", T0 + MIN))];
  assertEquals(liveClaimsAt(comments, SHA, T0 + MIN), []);
});

Deno.test("claimedElsewhere is true for another host's live claim", () => {
  const comments = [comment(1, claimBody(SHA, "B", T0 + 10 * MIN))];
  assertEquals(claimedElsewhere(comments, SHA, "A", T0), true);
});

Deno.test("claimedElsewhere is false for this host's own live claim", () => {
  const comments = [comment(1, claimBody(SHA, "A", T0 + 10 * MIN))];
  assertEquals(claimedElsewhere(comments, SHA, "A", T0), false);
});

Deno.test("claimedElsewhere is false for another host's expired claim", () => {
  const comments = [comment(1, claimBody(SHA, "B", T0 + MIN))];
  assertEquals(claimedElsewhere(comments, SHA, "A", T0 + 2 * MIN), false);
});

Deno.test("claimedElsewhere is false for another host's claim at another sha", () => {
  const comments = [comment(1, claimBody(OTHER_SHA, "B", T0 + 10 * MIN))];
  assertEquals(claimedElsewhere(comments, SHA, "A", T0), false);
});

// ---------- the race ----------

Deno.test("race: A and B post before either re-reads; exactly one wins, the lowest id", async () => {
  const fake = new FakeGithub();
  const [a, b] = await Promise.all([
    claimPr(claimFor(fake, "A")),
    claimPr(claimFor(fake, "B")),
  ]);
  assertEquals(allPostsBeforeFirstReread(fake.ops, 2), true);
  assertEquals([a.won, b.won].filter(Boolean).length, 1);
  const winner = a.won ? a : b;
  const loser = a.won ? b : a;
  assertEquals(winner.id, Math.min(a.id, b.id));
  assertEquals(fake.stored.get(winner.id)?.body.includes("host=A"), a.won);
  assertEquals(fake.stored.has(loser.id), false);
  assertEquals(fake.remaining(), [winner.id]);
});

Deno.test("race reversed: B posts first, so B wins", async () => {
  const fake = new FakeGithub();
  const [b, a] = await Promise.all([
    claimPr(claimFor(fake, "B")),
    claimPr(claimFor(fake, "A")),
  ]);
  assertEquals(allPostsBeforeFirstReread(fake.ops, 2), true);
  assertEquals(b.won, true);
  assertEquals(a.won, false);
  assertEquals(b.id, Math.min(a.id, b.id));
  assertEquals(fake.remaining(), [b.id]);
});

Deno.test("race with three hosts: exactly one winner, the lowest id", async () => {
  const fake = new FakeGithub();
  const results = await Promise.all([
    claimPr(claimFor(fake, "A")),
    claimPr(claimFor(fake, "B")),
    claimPr(claimFor(fake, "C")),
  ]);
  assertEquals(allPostsBeforeFirstReread(fake.ops, 3), true);
  const winners = results.filter((r) => r.won);
  assertEquals(winners.length, 1);
  const winnerId = winners[0]?.id;
  assertEquals(winnerId, Math.min(...results.map((r) => r.id)));
  assertEquals(fake.remaining(), [winnerId]);
});

Deno.test("a host that reads a live lower-id claim loses and deletes only its own comment", async () => {
  const fake = new FakeGithub();
  const held = fake.add(claimBody(SHA, "B", T0 + 10 * MIN));
  const result = await claimPr(claimFor(fake, "A"));
  assertEquals(result.won, false);
  assertEquals(fake.remaining(), [held]);
});

Deno.test("a losing host whose own delete is refused throws", async () => {
  const fake = new FakeGithub();
  fake.add(claimBody(SHA, "B", T0 + 10 * MIN));
  fake.forbidDelete.add(2);
  await assertRejects(
    () => claimPr(claimFor(fake, "A")),
    Error,
    "deleting claim comment 2",
  );
});

// ---------- claimPr cleanup and failures ----------

Deno.test("claimPr deletes this host's own stale claim at another sha, never another host's", async () => {
  const fake = new FakeGithub();
  const stale = fake.add(claimBody(OTHER_SHA, "A", T0 + 10 * MIN));
  const others = fake.add(claimBody(OTHER_SHA, "B", T0 + 10 * MIN));
  const result = await claimPr(claimFor(fake, "A"));
  assertEquals(result.won, true);
  assertEquals(fake.stored.has(stale), false);
  assertEquals(fake.stored.has(others), true);
  assertEquals(fake.remaining(), [others, result.id]);
});

Deno.test("claimPr throws when the re-read lacks its own comment, and removes it best effort", async () => {
  const fake = new FakeGithub();
  fake.hideNextPost = true;
  await assertRejects(
    () => claimPr(claimFor(fake, "A")),
    Error,
    "missing from the re-read",
  );
  assertEquals(fake.remaining(), []);
});

Deno.test("claimPr throws when the POST fails, and the message names the endpoint", async () => {
  const fake = new FakeGithub();
  fake.failPost = true;
  await assertRejects(
    () => claimPr(claimFor(fake, "A")),
    Error,
    LIST_PATH,
  );
});

// ---------- release ----------

Deno.test("releaseClaims filters by host and by sha, counts deletions", async () => {
  const fake = new FakeGithub();
  fake.add(claimBody(SHA, "A", T0 + 10 * MIN));
  fake.add(claimBody(SHA, "B", T0 + 10 * MIN));
  fake.add(claimBody(OTHER_SHA, "A", T0 + 10 * MIN));
  fake.add(
    "A human comment that quotes the marker in prose: <!-- vibe-review-claim -->",
  );
  assertEquals(
    await releaseClaims(fake.gh, REPO, NUMBER, { host: "A" }),
    2,
  );
  assertEquals(fake.remaining(), [2, 4]);
  assertEquals(
    await releaseClaims(fake.gh, REPO, NUMBER, { sha: SHA }),
    1,
  );
  assertEquals(fake.remaining(), [4]);
});

Deno.test("releaseClaims deletes an expired claim and leaves a human comment alone", async () => {
  const fake = new FakeGithub();
  fake.add(claimBody(SHA, "A", T0 - MIN)); // already expired
  fake.add(
    "Please see `<!-- vibe-review-claim sha=x host=y expires=z -->` in the docs.",
  );
  assertEquals(await releaseClaims(fake.gh, REPO, NUMBER, {}), 1);
  assertEquals(fake.remaining(), [2]);
});

Deno.test("releaseClaims tolerates a 404 on delete and does not count it", async () => {
  const fake = new FakeGithub();
  fake.add(claimBody(SHA, "A", T0 + 10 * MIN));
  fake.add(claimBody(SHA, "B", T0 + 10 * MIN));
  fake.alreadyGone.add(1);
  assertEquals(await releaseClaims(fake.gh, REPO, NUMBER, {}), 1);
});

Deno.test("releaseClaims throws on a 403 naming the id, after trying every claim", async () => {
  const fake = new FakeGithub();
  fake.add(claimBody(SHA, "A", T0 + 10 * MIN));
  fake.add(claimBody(SHA, "B", T0 + 10 * MIN));
  fake.forbidDelete.add(1);
  const error = await assertRejects(
    () => releaseClaims(fake.gh, REPO, NUMBER, {}),
    Error,
    "comment 1",
  );
  assertEquals(error.message.includes("HTTP 403"), true);
  // The second claim was still attempted and deleted.
  assertEquals(fake.remaining(), [1]);
});

// ---------- reading the thread ----------

Deno.test("fetchClaimComments throws on empty output and names repo#number", async () => {
  const gh: Gh = () => Promise.resolve("");
  await assertRejects(
    () => fetchClaimComments(gh, REPO, NUMBER),
    Error,
    "acme/app#7",
  );
});

Deno.test("fetchClaimComments joins every page and keeps bodies containing ][ intact", async () => {
  const fake = new FakeGithub();
  fake.pageSize = 2;
  fake.add("first ][ page");
  fake.add("second");
  fake.add("third ][ [ page");
  fake.add("fourth");
  fake.add("fifth");
  const comments = await fetchClaimComments(fake.gh, REPO, NUMBER);
  assertEquals(comments.map((c) => c.id), [1, 2, 3, 4, 5]);
  assertEquals(comments[0]?.body, "first ][ page");
  assertEquals(comments[2]?.body, "third ][ [ page");
});

Deno.test("fetchClaimComments throws on a payload that is not JSON", async () => {
  const gh: Gh = () => Promise.resolve("[{");
  await assertRejects(
    () => fetchClaimComments(gh, REPO, NUMBER),
    Error,
    "acme/app#7",
  );
});
