/**
 * The review-fleet-prs runner picks the Claude subscription for a headless
 * round the way the worker does (Issue #3289): the host's credential pool is
 * ranked by remaining budget, a spent subscription is left out of the retry,
 * and a round's output is read for the usage-limit refusal.
 */
import { assertEquals } from "@std/assert";
import {
  roundHitUsageLimit,
  selectRunnerCredential,
} from "../../../.claude/skills/review-fleet-prs/claude_credential.ts";

function budgetHeaders(utilisation: number): Response {
  return new Response("{}", {
    status: 200,
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": String(utilisation),
      "anthropic-ratelimit-unified-5h-reset": "1788483600",
      "anthropic-ratelimit-unified-representative-claim": "five_hour",
    },
  });
}

// A fake Anthropic endpoint: each bearer token answers with its own
// five-hour utilisation. Records which tokens were probed.
function poolFetch(utilisation: Record<string, number>) {
  const probed: string[] = [];
  const fetchFn = (_url: string, init: RequestInit) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const bearer = (headers["authorization"] ?? "").replace("Bearer ", "");
    probed.push(bearer);
    return Promise.resolve(budgetHeaders(utilisation[bearer] ?? 1));
  };
  return { fetchFn, probed };
}

async function credentialDir(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(`${dir}/claude`, { recursive: true });
  for (const [name, token] of Object.entries(files)) {
    await Deno.writeTextFile(
      `${dir}/claude/${name}`,
      `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`,
    );
  }
  return dir;
}

Deno.test("selectRunnerCredential: the subscription with the most budget left wins, and the choice is logged by label only", async () => {
  const dir = await credentialDir({
    "provider.env": "tok-1",
    "provider-2.env": "tok-2",
  });
  const fetcher = poolFetch({ "tok-1": 0.9, "tok-2": 0.2 });
  const log: string[] = [];
  try {
    const chosen = await selectRunnerCredential({
      dir,
      fetchFn: fetcher.fetchFn,
      log: (m) => log.push(m),
      now: () => 1788480000_000,
    });
    assertEquals(chosen, {
      label: "provider-2",
      name: "CLAUDE_CODE_OAUTH_TOKEN",
      value: "tok-2",
    });
    assertEquals(fetcher.probed.sort(), ["tok-1", "tok-2"]);
    assertEquals(log.length > 0, true, "the ranking is logged");
    assertEquals(
      log.some((m) => m.includes("tok-")),
      false,
      "no token value reaches the log",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("selectRunnerCredential: an excluded (spent) subscription is left out, so the retry runs on the next one", async () => {
  const dir = await credentialDir({
    "provider.env": "tok-1",
    "provider-2.env": "tok-2",
    "provider-3.env": "tok-3",
  });
  const fetcher = poolFetch({ "tok-1": 0.1, "tok-2": 0.5, "tok-3": 0.3 });
  try {
    const chosen = await selectRunnerCredential({
      dir,
      exclude: ["provider"],
      fetchFn: fetcher.fetchFn,
      now: () => 1788480000_000,
    });
    assertEquals(chosen?.label, "provider-3");
    assertEquals(fetcher.probed.includes("tok-1"), false, "not even probed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("selectRunnerCredential: a single subscription is used without a probe; an empty pool yields null", async () => {
  const single = await credentialDir({ "provider.env": "tok-only" });
  const fetcher = poolFetch({});
  try {
    const chosen = await selectRunnerCredential({
      dir: single,
      fetchFn: fetcher.fetchFn,
    });
    assertEquals(chosen?.label, "provider");
    assertEquals(chosen?.value, "tok-only");
    assertEquals(fetcher.probed, [], "nothing to rank, nothing probed");
    assertEquals(
      await selectRunnerCredential({
        dir: single,
        exclude: ["provider"],
        fetchFn: fetcher.fetchFn,
      }),
      null,
    );
  } finally {
    await Deno.remove(single, { recursive: true });
  }
  assertEquals(
    await selectRunnerCredential({
      dir: `${single}-missing`,
      fetchFn: fetcher.fetchFn,
    }),
    null,
  );
});

Deno.test("roundHitUsageLimit: the CLI's usage-limit refusals are recognised, other failures are not", () => {
  for (
    const text of [
      "You've hit your usage limit · resets 1:50pm (UTC)",
      "Claude AI usage limit reached|1788483600",
      "You have reached your session limit",
      "error: out of extra usage",
    ]
  ) assertEquals(roundHitUsageLimit(text), true, text);
  for (
    const text of [
      "model overloaded",
      "Error: 529 overloaded_error",
      "Round done: approved GRQ#1",
      "",
    ]
  ) assertEquals(roundHitUsageLimit(text), false, text);
});
