/**
 * Which model wrote each fleet review, and what it cost.
 *
 * Every review the review-fleet-prs skill posts carries a footer line naming
 * the provider, the model(s) and the effort of the round that wrote it, plus a
 * hidden `vibe-review-run` marker a report can sum. The round's cost comes from
 * the CLI's own stream-json result (`modelUsage`, priced by the worker's own
 * table) and is split equally across the PRs the round was given; a review
 * whose cost is not known says "cost unknown", never $0.
 *
 * The fixtures are a real `claude -p --output-format stream-json --verbose`
 * transcript of a main session launching two background sub-agents (CLI
 * 2.1.301), with the model ids and prompts renamed to a review round's.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  amendRound,
  attemptCost,
  postRunInfo,
  recordPosted,
  runFooter,
  type RunInfo,
  withRunFooter,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_cost.ts";
import {
  type FableReview,
  REVIEW_MARKER,
  reviewBody,
} from "../../../.claude/skills/review-fleet-prs/scripts/review_log.ts";
import { REVIEW_RUN_FILE, type ReviewRunRecord } from "../lib/review_round.ts";

const fixture = (name: string) =>
  Deno.readTextFile(
    new URL(`./fixtures/review_round/${name}`, import.meta.url),
  );

const OPUS_ATTEMPT = {
  attempt: 1,
  provider: "claude",
  model: "claude-opus-5-5",
  effort: "xhigh",
  stream: "stream-1.jsonl",
  code: 0,
};
const DEEPSEEK_ATTEMPT = {
  attempt: 2,
  provider: "deepseek",
  model: "deepseek-v4-pro",
  effort: "xhigh",
  stream: "stream-2.jsonl",
  code: 0,
};

const review = (over: Partial<FableReview> = {}): FableReview => ({
  summary: "Looks right.",
  findings: [],
  testChanges: "none",
  testChangeNotes: [],
  unrelatedIssues: [],
  checklist: [],
  ...over,
});

const marker = (body: string) =>
  body.match(/<!-- vibe-review-run ([^>]*) -->/)?.[1] ?? "";
const attr = (m: string, name: string) =>
  m.match(new RegExp(`${name}="([^"]*)"`))?.[1];

Deno.test("attemptCost prices an Opus round from the CLI's cumulative modelUsage", async () => {
  const cost = attemptCost(await fixture("opus-round.jsonl"), OPUS_ATTEMPT);
  assertEquals(cost.models, ["claude-opus-5-5"]);
  // 58 in × $4 + 2,296 out × $20 + 35,486 cache write × $5 + 86,052 cache
  // read × $0.20, per million: the whole session, sub-agents included — not
  // the last result line's main-loop `usage` alone.
  assert(cost.usd !== null);
  assertEquals(cost.usd.toFixed(7), "0.2407924");
  assertEquals(cost.apiEquivalent, false);
});

Deno.test("attemptCost prices a DeepSeek fallback round at DeepSeek's rate, never Opus's", async () => {
  const cost = attemptCost(
    await fixture("deepseek-round.jsonl"),
    DEEPSEEK_ATTEMPT,
  );
  // The sub-agents keep the agent definition's claude-opus-5-5 pin, but a
  // third-party endpoint cannot serve a Claude model: those tokens are
  // DeepSeek's and are named and priced as deepseek-v4-pro.
  assertEquals(cost.models, ["deepseek-v4-pro"]);
  assert(cost.usd !== null);
  assertEquals(cost.usd.toFixed(9), "0.012955008");
  assertEquals(cost.apiEquivalent, true);
});

Deno.test("attemptCost reports no cost when the stream has no result line", () => {
  const cost = attemptCost(
    '{"type":"system","subtype":"init","model":"claude-opus-5-5"}\n',
    OPUS_ATTEMPT,
  );
  assertEquals(cost.usd, null);
  assertEquals(cost.models, ["claude-opus-5-5"]);
});

Deno.test("runFooter names provider, model, effort and the PR's USD share when the cost is known", () => {
  const footer = runFooter({
    kind: "round",
    round: "20261016-101500",
    attempt: 1,
    provider: "claude",
    models: ["claude-opus-5-5"],
    effort: "xhigh",
    usd: 0.1203962,
    apiEquivalent: false,
    share: 2,
  });
  assertStringIncludes(footer, "provider claude");
  assertStringIncludes(footer, "model claude-opus-5-5");
  assertStringIncludes(footer, "effort xhigh");
  assertStringIncludes(footer, "$0.1204");
  assertStringIncludes(footer, "estimate only");
  assertStringIncludes(footer, "1/2");
  const m = marker(footer);
  assertEquals(attr(m, "provider"), "claude");
  assertEquals(attr(m, "models"), "claude-opus-5-5");
  assertEquals(attr(m, "effort"), "xhigh");
  assertEquals(attr(m, "usd"), "0.1204");
  assertEquals(attr(m, "round"), "20261016-101500");
  assertEquals(footer.includes("cost unknown"), false);
});

Deno.test("runFooter says cost unknown, never $0, when the cost is not known", () => {
  for (
    const info of [
      {
        kind: "round",
        round: "r",
        attempt: 1,
        provider: "claude",
        models: ["claude-opus-5-5"],
        effort: "xhigh",
        usd: null,
        apiEquivalent: false,
      },
      { kind: "interactive" },
    ] satisfies RunInfo[]
  ) {
    const footer = runFooter(info);
    assertStringIncludes(footer, "cost unknown");
    assertEquals(footer.includes("$0"), false, footer);
    assertEquals(attr(marker(footer), "usd"), "unknown");
  }
});

Deno.test("runFooter labels a DeepSeek review's cost as an API-equivalent estimate", () => {
  const footer = runFooter({
    kind: "round",
    round: "r",
    attempt: 2,
    provider: "deepseek",
    models: ["deepseek-v4-pro"],
    effort: "xhigh",
    usd: 0.006477504,
    apiEquivalent: true,
    share: 2,
  });
  assertStringIncludes(footer, "provider deepseek");
  assertStringIncludes(footer, "model deepseek-v4-pro");
  assertStringIncludes(footer, "API-equivalent");
  assertEquals(attr(marker(footer), "provider"), "deepseek");
  assertEquals(attr(marker(footer), "usd"), "0.0065");
});

Deno.test("reviewBody keeps the existing marker line and adds the run footer after it", () => {
  const body = reviewBody("approved", review(), [], [], {
    run: { kind: "interactive" },
  });
  const lines = body.split("\n");
  const at = lines.indexOf(`_${REVIEW_MARKER}._`);
  assert(at >= 0, body);
  assertStringIncludes(lines.slice(at + 1).join("\n"), "_Review run: ");
  assertStringIncludes(lines.slice(at + 1).join("\n"), "<!-- vibe-review-run ");
});

Deno.test("withRunFooter replaces an earlier run footer rather than adding a second", () => {
  const first = reviewBody(
    "changes_requested",
    review({
      findings: [{ file: "a.ts", line: 1, problem: "p" }],
    }),
    [],
    [],
    {
      run: {
        kind: "round",
        round: "r",
        attempt: 1,
        provider: "claude",
        models: ["claude-opus-5-5"],
        effort: "xhigh",
        usd: null,
        apiEquivalent: false,
      },
    },
  );
  const amended = withRunFooter(first, {
    kind: "round",
    round: "r",
    attempt: 1,
    provider: "claude",
    models: ["claude-opus-5-5"],
    effort: "xhigh",
    usd: 0.5,
    apiEquivalent: false,
    share: 2,
  });
  assertEquals(amended.match(/vibe-review-run/g)?.length, 1, amended);
  assertEquals(amended.match(/_Review run: /g)?.length, 1, amended);
  assertStringIncludes(amended, "$0.5000");
  assertStringIncludes(amended, "**`a.ts:1`**: p");
  assertStringIncludes(amended, `_${REVIEW_MARKER}._`);
});

Deno.test("postRunInfo: a round names its current attempt, a post without one is an interactive session", async () => {
  const dir = await Deno.makeTempDir();
  assertEquals(await postRunInfo(dir), { kind: "interactive" });
  assertEquals(await postRunInfo(undefined), { kind: "interactive" });
  assertEquals((await postRunInfo(dir, { noModel: true })).kind, "no-model");
  const record: ReviewRunRecord = {
    round: "20261016-101500",
    attempts: [{ ...OPUS_ATTEMPT, code: 1 }, {
      ...DEEPSEEK_ATTEMPT,
      code: undefined,
    }],
  };
  await Deno.writeTextFile(`${dir}/${REVIEW_RUN_FILE}`, JSON.stringify(record));
  const info = await postRunInfo(dir);
  assertEquals(info.kind, "round");
  if (info.kind !== "round") return;
  // The attempt still running is the one posting: the DeepSeek fallback.
  assertEquals(info.provider, "deepseek");
  assertEquals(info.models, ["deepseek-v4-pro"]);
  assertEquals(info.attempt, 2);
  assertEquals(info.usd, null);
});

Deno.test("a no-model post (dependency-audit send-back) costs a known $0", () => {
  const footer = runFooter({ kind: "no-model" });
  assertStringIncludes(footer, "no model run");
  assertEquals(attr(marker(footer), "provider"), "none");
  assertEquals(attr(marker(footer), "usd"), "0.0000");
});

// A fake `gh`: lists each PR's reviews and records each PUT of a body.
function fakeGh(reviews: Record<string, { id: number; body: string }[]>) {
  const puts: { path: string; body: string }[] = [];
  const gh = async (args: string[]) => {
    const path = args.find((a) => a.startsWith("repos/"))!;
    if (args.includes("PUT")) {
      const input = args[args.indexOf("--input") + 1]!;
      puts.push({
        path,
        body: JSON.parse(await Deno.readTextFile(input)).body,
      });
      return "{}";
    }
    const key = path.replace(/^repos\//, "").replace(/\/reviews.*$/, "");
    // `gh api --paginate --jq '.[] | {id, body}'`: one object per line.
    return (reviews[key] ?? []).map((r) => JSON.stringify(r)).join("\n");
  };
  return { gh, puts };
}

async function roundDir(stream: string, attempts: ReviewRunRecord["attempts"]) {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    `${dir}/gate.json`,
    JSON.stringify({
      ready: [{ repo: "owner/repo", number: 7 }, {
        repo: "owner/other",
        number: 9,
      }],
    }),
  );
  await Deno.writeTextFile(
    `${dir}/${REVIEW_RUN_FILE}`,
    JSON.stringify({ round: "20261016-101500", attempts }),
  );
  for (const a of attempts) {
    await Deno.writeTextFile(`${dir}/${a.stream}`, await fixture(stream));
  }
  return dir;
}

Deno.test("amendRound adds each posted review's half of the round's cost once the round ends", async () => {
  const dir = await roundDir("opus-round.jsonl", [OPUS_ATTEMPT]);
  const posted = () =>
    reviewBody("approved", review(), [], [], {
      run: {
        kind: "round",
        round: "20261016-101500",
        attempt: 1,
        provider: "claude",
        models: ["claude-opus-5-5"],
        effort: "xhigh",
        usd: null,
        apiEquivalent: false,
      },
    });
  await recordPosted(dir, { repo: "owner/repo", number: 7, attempt: 1 });
  await recordPosted(dir, { repo: "owner/other", number: 9, attempt: 1 });
  const { gh, puts } = fakeGh({
    "owner/repo/pulls/7": [
      { id: 1, body: "an older review, another round" },
      { id: 11, body: posted() },
    ],
    "owner/other/pulls/9": [{ id: 22, body: posted() }],
  });
  const summary = await amendRound(dir, gh);
  assertEquals(summary.amended, 2);
  assertEquals(puts.map((p) => p.path).sort(), [
    "repos/owner/other/pulls/9/reviews/22",
    "repos/owner/repo/pulls/7/reviews/11",
  ]);
  for (const put of puts) {
    const m = marker(put.body);
    // $0.2407924 split across the two PRs the round was given.
    assertEquals(attr(m, "usd"), "0.1204", put.body);
    assertEquals(attr(m, "provider"), "claude");
    assertEquals(attr(m, "models"), "claude-opus-5-5");
    assertStringIncludes(put.body, "1/2");
    assertEquals(put.body.includes("cost unknown"), false);
  }
});

Deno.test("amendRound names deepseek on a fallback round's reviews", async () => {
  const dir = await roundDir("deepseek-round.jsonl", [DEEPSEEK_ATTEMPT]);
  await recordPosted(dir, { repo: "owner/repo", number: 7, attempt: 2 });
  const body = reviewBody(
    "changes_requested",
    review({
      findings: [{ file: "a.ts", line: 1, problem: "p" }],
    }),
    [],
    [],
    {
      run: {
        kind: "round",
        round: "20261016-101500",
        attempt: 2,
        provider: "deepseek",
        models: ["deepseek-v4-pro"],
        effort: "xhigh",
        usd: null,
        apiEquivalent: true,
      },
    },
  );
  const { gh, puts } = fakeGh({
    "owner/repo/pulls/7": [{ id: 11, body }],
  });
  assertEquals((await amendRound(dir, gh)).amended, 1);
  const m = marker(puts[0]!.body);
  assertEquals(attr(m, "provider"), "deepseek");
  assertEquals(attr(m, "models"), "deepseek-v4-pro");
  assertEquals(attr(m, "usd"), "0.0065");
  assertStringIncludes(puts[0]!.body, "API-equivalent");
});

Deno.test("amendRound leaves an unfinished attempt's reviews at cost unknown", async () => {
  // The alarm killed the round: its attempt never recorded an exit status,
  // so the stream's last result is not the whole round.
  const dir = await roundDir("opus-round.jsonl", [{
    ...OPUS_ATTEMPT,
    code: undefined,
  }]);
  await recordPosted(dir, { repo: "owner/repo", number: 7, attempt: 1 });
  const { gh, puts } = fakeGh({ "owner/repo/pulls/7": [] });
  assertEquals((await amendRound(dir, gh)).amended, 0);
  assertEquals(puts, []);
});
