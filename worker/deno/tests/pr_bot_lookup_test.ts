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
/** A fleet host login shaped like a GitHub App — `isBotLogin` says "bot". */
const HOST = "vibecoderbot[bot]";
/** The log sink is required; cases that assert nothing about it discard. */
const DISCARD = (_message: string): void => {};

/** One `gh pr list --json …` entry, with sane defaults for the listing. */
function prJson(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    number: 1,
    title: "chore(deps): bump std",
    baseRefName: "main",
    headRefName: "dependabot/deno/std-1.2.3",
    body: "",
    url: "https://github.com/owner/repo/pull/1",
    // The shape `gh pr list --json author` really reports for a GitHub App.
    author: { is_bot: true, login: "app/dependabot" },
    isCrossRepository: false,
    headRefOid: "abc123",
    autoMergeRequest: null,
    mergeable: "MERGEABLE",
    ...overrides,
  };
}

/**
 * A `gh` stub answering `pr list` with `entries`, recording every call.
 *
 * It models the one API rule this lookup depends on: `--limit N` returns at
 * most the first N entries, so a listing asked for the wrong way round
 * cannot return a truthful-looking answer.
 */
function buildGh(
  entries: unknown,
  calls?: string[][],
): (args: string[]) => Promise<string> {
  return (args: string[]) => {
    calls?.push(args);
    const limitAt = args.indexOf("--limit");
    const limit = limitAt >= 0 ? Number(args[limitAt + 1]) : Number.NaN;
    const page = Array.isArray(entries) && Number.isFinite(limit)
      ? entries.slice(0, limit)
      : entries;
    return Promise.resolve(JSON.stringify(page));
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
    log: DISCARD,
  });

  assertEquals(admitted.length, 1);
  assertEquals(admitted[0], {
    number: 42,
    body: "",
    title: "chore(deps): bump std to 1.2.3",
    headRefName: "dependabot/deno/std-1.2.3",
    headRefOid: "deadbeef",
    baseRefName: "main",
    autoMergeRequest: { mergeMethod: "SQUASH" },
    mergeable: "CONFLICTING",
    author: { login: "dependabot[bot]" },
    isCrossRepository: false,
    // The needs-human hold reads labels off every admitted entry.
    labels: [],
  });
});

Deno.test("listBotPrs - a human login sharing a bot prefix is not admitted", async () => {
  // `isBotLogin` matches `cursor`, `snyk`, `copilot` and `codecov` by
  // prefix, so these humans read as bots to it (Issue #1872). Admission
  // means the worker claims the PR and pushes to its head branch, so it
  // must use the narrower predicate instead.
  const lines: string[] = [];
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({ number: 20, author: { login: "cursorjoe" } }),
      prJson({ number: 21, author: { login: "snyked" } }),
      prJson({ number: 22, author: { login: "copilotjoe" } }),
      prJson({ number: 23, author: { login: "codecoverage-nerd" } }),
      prJson({ number: 24, author: { login: "dependabotanist" } }),
      prJson({ number: 25, author: { login: "dependabot[bot]" } }),
    ]),
    log: (message) => lines.push(message),
  });

  assertEquals(admitted.map((pr) => pr.number), [25]);
  // Not admitted and not logged as an exclusion either: a human PR is never
  // this door's business, so it leaves no trace of having been considered.
  assertEquals(lines, [
    `[pr-bot] admitted repo=${REPO} prNumber=25 author=dependabot[bot]`,
  ]);
});

Deno.test("listBotPrs - a human PR and the host's own bot-shaped PR are not admitted", async () => {
  // The host login here ends in `[bot]`, so `isBotLogin` alone would admit
  // it. The fleet set is what keeps the maintenance listing's own PR out.
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({ number: 10, author: { login: "courtyen" } }),
      prJson({ number: 11, author: { login: HOST } }),
      prJson({ number: 12 }),
    ]),
    githubUser: HOST,
    log: DISCARD,
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

Deno.test("listBotPrs - a non-array gh payload is logged, admits nothing, caches nothing", async () => {
  await withCache(async (cache) => {
    const lines: string[] = [];
    const admitted = await listBotPrs({
      repo: REPO,
      // gh answered with an API error object rather than a PR array. It is
      // valid JSON, so only an explicit array check catches it.
      ghCommandFn: () => Promise.resolve('{"message":"Not Found"}'),
      cache,
      log: (message) => lines.push(message),
    });

    assertEquals(admitted, []);
    assertEquals(lines.length, 1);
    assert(lines[0]!.includes("not a JSON array"), lines[0]);
    assertEquals(await cache.read(REPO, "prs_open_all"), null);
  });
});

Deno.test("listBotPrs - a sibling fleet login's bot PR is not admitted", async () => {
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({ number: 20, author: { login: "stsvcbot[bot]" } }),
      prJson({ number: 21 }),
    ]),
    fleetPrAuthors: ["stsvcbot[bot]"],
    log: DISCARD,
  });

  assertEquals(admitted.map((pr) => pr.number), [21]);
});

Deno.test("listBotPrs - a second call in the cycle issues no second gh pr list", async () => {
  await withCache(async (cache) => {
    const calls: string[][] = [];
    const ghCommandFn = buildGh([prJson({ number: 3 })], calls);

    const opts = { repo: REPO, ghCommandFn, cache, log: DISCARD };
    const first = await listBotPrs(opts);
    const second = await listBotPrs(opts);

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
    log: DISCARD,
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
    log: DISCARD,
  });

  assertEquals(admitted, []);
});

Deno.test("listBotPrs - sanitises a hostile bot login in the admission log", async () => {
  // The hostile login carries the `[bot]` suffix so it still reaches the
  // admission log under the narrowed predicate (Issue #1872) — the payload,
  // not the prefix, is what this case is about.
  const lines: string[] = [];
  await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([prJson({
      number: 4,
      author: { login: 'dependabot"\ninjected=line[bot]' },
    })]),
    log: (message) => lines.push(message),
  });

  assertEquals(lines.length, 1);
  assertEquals(lines[0]!.includes("\n"), false);
  assertEquals(lines[0]!.includes('"'), false);
});

Deno.test("listBotPrs - the caller's limit bounds what the listing returns", async () => {
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({ number: 1 }),
      prJson({ number: 2 }),
      prJson({ number: 3 }),
    ]),
    limit: 2,
    log: DISCARD,
  });

  // The stub honours `--limit`, so a limit that never reached gh would show
  // up here as a third admitted PR.
  assertEquals(admitted.map((pr) => pr.number), [1, 2]);
});

Deno.test("listBotPrs - admits a GitHub App author reported as app/<slug> (Issue #4719)", async () => {
  const lines: string[] = [];
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({ number: 30, author: { is_bot: true, login: "app/renovate" } }),
    ]),
    log: (message) => lines.push(message),
  });

  assertEquals(admitted.map((pr) => pr.number), [30]);
  assertEquals(admitted[0]?.author, { login: "renovate[bot]" });
  assertEquals(lines, [
    `[pr-bot] admitted repo=${REPO} prNumber=30 author=renovate[bot]`,
  ]);
});

Deno.test("listBotPrs - a non-bot author is never admitted", async () => {
  // These ordinary user logins are not App-shaped, so neither is re-spelled,
  // admitted or logged: they are not this door's business.
  const lines: string[] = [];
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({ number: 31, author: { is_bot: false, login: "alice" } }),
      prJson({
        number: 32,
        author: { is_bot: false, login: "someone-unknown" },
      }),
    ]),
    log: (message) => lines.push(message),
  });

  assertEquals(admitted, []);
  assertEquals(lines, []);
});

Deno.test("listBotPrs - a cross-repository App-authored PR is still excluded (Issue #4719)", async () => {
  const lines: string[] = [];
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({
        number: 34,
        isCrossRepository: true,
        author: { is_bot: true, login: "app/dependabot" },
      }),
    ]),
    log: (message) => lines.push(message),
  });

  assertEquals(admitted, []);
  assertEquals(lines, [
    `[pr-bot] excluded repo=${REPO} prNumber=34 author=dependabot[bot] reason=cross-repository-head`,
  ]);
});

Deno.test("listBotPrs - the host's own App-authored PR is still skipped (Issue #4719)", async () => {
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({
        number: 35,
        author: { is_bot: true, login: "app/vibecoderbot" },
      }),
      prJson({ number: 36 }),
    ]),
    githubUser: HOST,
    log: DISCARD,
  });

  assertEquals(admitted.map((pr) => pr.number), [36]);
});

Deno.test("listBotPrs - admits a row cached in the previous app/<slug> shape (Issue #4719)", async () => {
  await withCache(async (cache) => {
    // Written by the previous release, before listings re-spelled App
    // authors. It is still inside the cache TTL, so it must be handled.
    await cache.write(REPO, "prs_open_all", [{
      number: 50,
      title: "chore(deps): bump std",
      baseRefName: "main",
      headRefName: "dependabot/deno/std-1.2.3",
      body: "",
      url: "https://github.com/owner/repo/pull/50",
      authorLogin: "app/dependabot",
      isCrossRepository: false,
      headRefOid: "abc123",
      autoMergeRequest: null,
      mergeable: "MERGEABLE",
      labels: [],
    }]);
    const lines: string[] = [];
    const admitted = await listBotPrs({
      repo: REPO,
      ghCommandFn: () => Promise.reject(new Error("gh must not be called")),
      cache,
      log: (message) => lines.push(message),
    });

    assertEquals(admitted.map((pr) => pr.number), [50]);
    assertEquals(admitted[0]?.author, { login: "dependabot[bot]" });
    assertEquals(lines, [
      `[pr-bot] admitted repo=${REPO} prNumber=50 author=dependabot[bot]`,
    ]);
  });
});

Deno.test("listBotPrs - asks for isDraft and carries it onto the entry (Issue #4951)", async () => {
  const calls: string[][] = [];
  const admitted = await listBotPrs({
    repo: REPO,
    ghCommandFn: buildGh([
      prJson({ number: 1, isDraft: true }),
      prJson({ number: 2, isDraft: false }),
      prJson({ number: 3 }),
    ], calls),
    log: DISCARD,
  });

  const json = calls[0]![calls[0]!.indexOf("--json") + 1]!;
  assert(json.split(",").includes("isDraft"), `--json ${json} lacks isDraft`);
  assertEquals(admitted.map((pr) => [pr.number, pr.isDraft]), [
    [1, true],
    [2, false],
    // A listing that did not report it leaves it unknown, not false.
    [3, undefined],
  ]);
});
