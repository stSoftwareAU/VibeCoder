/**
 * Tests for the bot-authored PR listing (Issue #1846).
 *
 * `listBotPrs` is the third door into the maintenance scans: it reads the
 * one un-filtered open-PR listing a cycle already fetches and admits only
 * the bot-authored PRs whose head branch lives in the target repository.
 * Every failure path here must fail **closed** — an unreadable listing, a
 * fork-headed head branch, or an unattributable author admits nothing.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { listBotPrs } from "../lib/pr_bot_lookup.ts";
import { IssueCache } from "../lib/issue_cache.ts";

const REPO = "owner/repo";
const HOST = "Vibecoderbot-host";

/** One `gh pr list --json …` entry, with sane defaults for the listing. */
function prJson(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 1,
    title: "chore(deps): bump std",
    baseRefName: "main",
    headRefName: "dependabot/deno/std-1.2.3",
    body: "",
    url: "https://github.com/owner/repo/pull/1",
    author: { login: "dependabot[bot]" },
    isCrossRepository: false,
    headRefOid: "abc123",
    autoMergeRequest: null,
    mergeable: "MERGEABLE",
    ...overrides,
  };
}

/** A `gh` stub answering `pr list` with `entries`, recording every call. */
function buildGh(
  entries: unknown,
  calls?: string[][],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls?.push(args);
    return Promise.resolve(JSON.stringify(entries));
  };
}

async function withCache<T>(fn: (cache: IssueCache) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "pr_bot_lookup_" });
  try {
    return await fn(new IssueCache(dir));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => undefined);
  }
}

Deno.test("listBotPrs - admits same-repository bot PRs and logs each admission", async () => {
  const lines: string[] = [];
  const bots = [
    "dependabot[bot]",
    "renovate[bot]",
    "github-actions",
    "copilot-swe-agent[bot]",
  ];
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh(
      bots.map((login, index) =>
        prJson({ number: index + 1, author: { login } })
      ),
    ),
    log: (message) => lines.push(message),
  });

  assertEquals(admitted.map((pr) => pr.number), [1, 2, 3, 4]);
  assertEquals(
    lines,
    bots.map((login, index) =>
      `[pr-bot] admitted repo=${REPO} prNumber=${index + 1} author=${login}`
    ),
  );
});

Deno.test("listBotPrs - carries the maintenance PrEntry fields through", async () => {
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([prJson({
      number: 42,
      title: "chore(deps): bump std to 1.2.3",
      headRefOid: "deadbeef",
      autoMergeRequest: { mergeMethod: "SQUASH" },
      mergeable: "CONFLICTING",
    })]),
  });

  assertEquals(admitted.length, 1);
  assertEquals(admitted[0], {
    number: 42,
    title: "chore(deps): bump std to 1.2.3",
    headRefName: "dependabot/deno/std-1.2.3",
    headRefOid: "deadbeef",
    baseRefName: "main",
    autoMergeRequest: { mergeMethod: "SQUASH" },
    mergeable: "CONFLICTING",
    author: { login: "dependabot[bot]" },
    isCrossRepository: false,
  });
});

Deno.test("listBotPrs - a human PR and the host's own PR are not admitted", async () => {
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({ number: 10, author: { login: "courtyen" } }),
      prJson({ number: 11, author: { login: HOST } }),
      prJson({ number: 12 }),
    ]),
  });

  assertEquals(admitted.map((pr) => pr.number), [12]);
});

Deno.test("listBotPrs - a fork-headed bot PR is excluded and the exclusion logged", async () => {
  const lines: string[] = [];
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([prJson({ number: 77, isCrossRepository: true })]),
    log: (message) => lines.push(message),
  });

  assertEquals(admitted, []);
  assertEquals(lines.length, 1);
  assert(lines[0]!.includes("prNumber=77"), lines[0]);
  assert(lines[0]!.includes("cross-repository"), lines[0]);
});

Deno.test("listBotPrs - an unknown head repository fails closed", async () => {
  const lines: string[] = [];
  const admitted = await listBotPrs({
    repo: REPO,
    // A cache entry written before Issue #1846 carries no
    // `isCrossRepository`: ownership is unknown, so nothing is admitted.
    ghCommandFn: buildGh([
      prJson({ number: 78, isCrossRepository: undefined }),
    ]),
    log: (message) => lines.push(message),
  });

  assertEquals(admitted, []);
  assertEquals(lines.length, 1);
  assert(lines[0]!.includes("prNumber=78"), lines[0]);
});

Deno.test("listBotPrs - an unreadable listing admits nothing, logs, and caches nothing", async () => {
  await withCache(async (cache) => {
    const lines: string[] = [];
    const admitted = await listBotPrs({
      repo: REPO,
      ghCommandFn: () => Promise.reject(new Error("gh list boom")),
      cache,
      log: (message) => lines.push(message),
    });

    assertEquals(admitted, []);
    assertEquals(lines.length, 1);
    assert(lines[0]!.includes("gh list boom"), lines[0]);
    assertEquals(await cache.read(REPO, "prs_open_all"), null);
  });
});

Deno.test("listBotPrs - a non-array listing admits nothing and logs the failure", async () => {
  await withCache(async (cache) => {
    // The cached listing is read back untyped, so a garbled entry reaches
    // the lookup as a non-array. It is a failure, not an empty repo.
    await cache.write(REPO, "prs_open_all", { message: "Not Found" });
    const lines: string[] = [];
    const admitted = await listBotPrs({
      repo: REPO,
      ghCommandFn: () => Promise.reject(new Error("gh must not be called")),
      cache,
      log: (message) => lines.push(message),
    });

    assertEquals(admitted, []);
    assertEquals(lines.length, 1);
    assert(lines[0]!.includes("no bot PR admitted"), lines[0]);
  });
});

Deno.test("listBotPrs - a non-array gh payload admits nothing and caches nothing", async () => {
  await withCache(async (cache) => {
    const admitted = await listBotPrs({
      repo: REPO,
      // gh answered with an API error object rather than a PR array.
      ghCommandFn: () => Promise.resolve('{"message":"Not Found"}'),
      cache,
    });

    assertEquals(admitted, []);
    assertEquals(await cache.read(REPO, "prs_open_all"), null);
  });
});

Deno.test("listBotPrs - a second call in the cycle issues no second gh pr list", async () => {
  await withCache(async (cache) => {
    const calls: string[][] = [];
    const ghCommandFn = buildGh([prJson({ number: 3 })], calls);

    const first = await listBotPrs({ repo: REPO, ghCommandFn, cache });
    const second = await listBotPrs({ repo: REPO, ghCommandFn, cache });

    assertEquals(first.map((pr) => pr.number), [3]);
    assertEquals(second.map((pr) => pr.number), [3]);
    assertEquals(calls.length, 1, "second call must be served from the cache");
  });
});

Deno.test("listBotPrs - de-duplicates by PR number", async () => {
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({ number: 5 }),
      prJson({ number: 5, title: "duplicate page entry" }),
      prJson({ number: 6 }),
    ]),
  });

  assertEquals(admitted.map((pr) => pr.number), [5, 6]);
});

Deno.test("listBotPrs - an entry with no author login is not admitted", async () => {
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({ number: 8, author: null }),
      prJson({ number: 9, author: {} }),
      prJson({ number: 10, author: { login: "   " } }),
    ]),
  });

  assertEquals(admitted, []);
});

Deno.test("listBotPrs - sanitises a hostile bot login in the admission log", async () => {
  const lines: string[] = [];
  await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([prJson({
      number: 4,
      author: { login: 'dependabot"\ninjected=line' },
    })]),
    log: (message) => lines.push(message),
  });

  assertEquals(lines.length, 1);
  assertEquals(lines[0]!.includes("\n"), false);
  assertEquals(lines[0]!.includes('"'), false);
});

Deno.test("listBotPrs - passes the caller's limit to the listing", async () => {
  const calls: string[][] = [];
  await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([], calls),
    limit: 25,
  });

  const list = calls.find((c) => c[0] === "pr" && c[1] === "list")!;
  assertEquals(list[list.indexOf("--limit") + 1], "25");
});
