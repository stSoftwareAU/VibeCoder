/**
 * Tests for lib/codex_budget.ts — the bounded, read-only Codex budget adapter
 * (Issue #1697, parent #1694).
 *
 * Every test builds a real throwaway `CODEX_HOME` on disk and drives the real
 * adapter against it, so the rollout layout, the tail read and the caching are
 * all exercised rather than described. The clock is injected; nothing sleeps.
 *
 * Australian English spelling throughout (behaviour, organisation, utilise).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CodexBudgetAdapter,
  findRecentRolloutFiles,
  readFileTail,
} from "../lib/codex_budget.ts";

const FIXTURES = new URL("./fixtures/codex_budget/", import.meta.url);

/** A `CODEX_HOME` under a temp dir, with helpers to populate it. */
interface CodexHome {
  readonly path: string;
  /** Write a rollout file for a given day, returning its path. */
  writeRollout(day: string, name: string, body: string): string;
  /** Copy a fixture in as a rollout file. */
  writeFixture(day: string, name: string, fixture: string): string;
}

/** Run `body` against a throwaway CODEX_HOME, always cleaning up. */
async function withCodexHome(
  body: (home: CodexHome) => void | Promise<void>,
): Promise<void> {
  const path = await Deno.makeTempDir({ prefix: "codex-budget-" });
  const writeRollout = (day: string, name: string, contents: string) => {
    const [year, month, dayOfMonth] = day.split("-");
    const dir = `${path}/sessions/${year}/${month}/${dayOfMonth}`;
    Deno.mkdirSync(dir, { recursive: true });
    const file = `${dir}/${name}`;
    Deno.writeTextFileSync(file, contents);
    return file;
  };
  try {
    await body({
      path,
      writeRollout,
      writeFixture: (day, name, fixture) =>
        writeRollout(
          day,
          name,
          Deno.readTextFileSync(new URL(fixture, FIXTURES)),
        ),
    });
  } finally {
    await Deno.remove(path, { recursive: true });
  }
}

/** A clock the test advances by hand. */
function clock(start = 1_788_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance(ms: number) {
      value += ms;
    },
  };
}

const NO_ENV = (_name: string): string | undefined => undefined;

Deno.test("CodexBudgetAdapter - reads the newest rate limits from the rollout file", async () => {
  await withCodexHome(async (home) => {
    home.writeFixture(
      "2026-09-09",
      "rollout-2026-09-09T01-00-00-0199a0aa.jsonl",
      "rollout_chatgpt_subscription.jsonl",
    );
    const time = clock();
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      now: time.now,
      env: NO_ENV,
    });

    const snapshot = await adapter.refresh();
    assertEquals(snapshot.source, "rollout-token-count");
    assertEquals(snapshot.authMode, "unknown");
    assertEquals(snapshot.readAt, time.now());
    assertEquals(snapshot.capturedAt, Date.parse("2026-09-09T01:05:00.000Z"));
    assert(snapshot.budget.known);
    // The newest line, not the first: 92.5% of the secondary window used.
    assertEquals(snapshot.budget.window, "secondary");
    assertEquals(Number(snapshot.budget.remainingFraction.toFixed(4)), 0.075);
    assertEquals(adapter.readCount, 1);
  });
});

Deno.test("CodexBudgetAdapter - prefers the newest session file", async () => {
  await withCodexHome(async (home) => {
    home.writeFixture(
      "2026-09-08",
      "rollout-2026-09-08T01-00-00-aaaa.jsonl",
      "rollout_chatgpt_subscription.jsonl",
    );
    home.writeRollout(
      "2026-09-09",
      "rollout-2026-09-09T01-00-00-bbbb.jsonl",
      '{"timestamp":"2026-09-09T01:00:00.000Z","type":"event_msg","payload":' +
        '{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex",' +
        '"primary":{"used_percent":4,"window_minutes":300,' +
        '"resets_at":1788483600}}}}\n',
    );

    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      env: NO_ENV,
    });
    const snapshot = await adapter.refresh();
    assert(snapshot.budget.known);
    assertEquals(snapshot.budget.remainingFraction, 0.96);
  });
});

Deno.test("CodexBudgetAdapter - concurrent refreshes share one read", async () => {
  await withCodexHome(async (home) => {
    home.writeFixture(
      "2026-09-09",
      "rollout-2026-09-09T01-00-00-cccc.jsonl",
      "rollout_chatgpt_subscription.jsonl",
    );
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      env: NO_ENV,
    });

    const [a, b, c] = await Promise.all([
      adapter.refresh(),
      adapter.refresh(),
      adapter.refresh(),
    ]);
    assertEquals(adapter.readCount, 1);
    assertEquals(a, b);
    assertEquals(b, c);
  });
});

Deno.test("CodexBudgetAdapter - rechecks are bounded by the refresh interval", async () => {
  await withCodexHome(async (home) => {
    const file = home.writeFixture(
      "2026-09-09",
      "rollout-2026-09-09T01-00-00-dddd.jsonl",
      "rollout_chatgpt_subscription.jsonl",
    );
    const time = clock();
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      now: time.now,
      env: NO_ENV,
      minRefreshIntervalMs: 60_000,
    });

    await adapter.refresh();
    // The window changes on disk — a temporary quota change mid-run.
    Deno.writeTextFileSync(
      file,
      '{"timestamp":"2026-09-09T01:30:00.000Z","type":"event_msg","payload":' +
        '{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex",' +
        '"primary":{"used_percent":50,"window_minutes":60,' +
        '"resets_at":1788483600}}}}\n',
    );

    time.advance(59_000);
    const cached = await adapter.refresh();
    assertEquals(adapter.readCount, 1, "no second read inside the interval");
    assert(cached.budget.known);
    assertEquals(cached.budget.windows[0]?.windowMinutes, 300);

    time.advance(2_000);
    const fresh = await adapter.refresh();
    assertEquals(adapter.readCount, 2);
    assert(fresh.budget.known);
    // A shortened window is recorded as reported, not reconciled against the
    // previous one: window duration is the server's to change.
    assertEquals(fresh.budget.windows[0]?.windowMinutes, 60);
    assertEquals(fresh.budget.remainingFraction, 0.5);
  });
});

Deno.test("CodexBudgetAdapter - staleness is reported, not silently corrected", async () => {
  await withCodexHome(async (home) => {
    home.writeFixture(
      "2026-09-09",
      "rollout-2026-09-09T01-00-00-eeee.jsonl",
      "rollout_chatgpt_subscription.jsonl",
    );
    const time = clock();
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      now: time.now,
      env: NO_ENV,
      maxSnapshotAgeMs: 15 * 60_000,
    });

    assertEquals(adapter.isStale(), true, "no snapshot yet is stale");
    await adapter.refresh();
    assertEquals(adapter.isStale(), false);

    time.advance(15 * 60_000 + 1);
    assertEquals(adapter.isStale(), true);
    // Still a real reading — never downgraded to unknown by age alone.
    assert(adapter.latest()?.budget.known);
  });
});

Deno.test("CodexBudgetAdapter - an API-key account has no subscription window", async () => {
  await withCodexHome(async (home) => {
    home.writeFixture(
      "2026-09-09",
      "rollout-2026-09-09T01-00-00-ffff.jsonl",
      "rollout_chatgpt_subscription.jsonl",
    );
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      env: (name) => (name === "OPENAI_API_KEY" ? "sk-test" : undefined),
    });

    const snapshot = await adapter.refresh();
    assertEquals(snapshot.source, "auth-mode");
    assertEquals(snapshot.authMode, "api-key");
    assert(!snapshot.budget.known);
    assertEquals(snapshot.budget.reason, "api-key-account");
    assertEquals(JSON.stringify(snapshot).includes("sk-test"), false);
  });
});

Deno.test("CodexBudgetAdapter - missing and empty sources answer with reason codes", async () => {
  await withCodexHome(async (home) => {
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      env: NO_ENV,
    });
    const empty = await adapter.refresh();
    assert(!empty.budget.known);
    assertEquals(empty.budget.reason, "no-session-file");
    assertEquals(empty.source, "none");
  });

  await withCodexHome(async (home) => {
    home.writeFixture(
      "2026-09-09",
      "rollout-2026-09-09T02-00-00-1111.jsonl",
      "rollout_no_rate_limits.jsonl",
    );
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      env: NO_ENV,
    });
    const none = await adapter.refresh();
    assert(!none.budget.known);
    assertEquals(none.budget.reason, "no-rate-limit-event");
  });
});

Deno.test("CodexBudgetAdapter - a malformed snapshot is retained as unknown", async () => {
  await withCodexHome(async (home) => {
    home.writeFixture(
      "2026-09-09",
      "rollout-2026-09-09T03-00-00-2222.jsonl",
      "rollout_malformed.jsonl",
    );
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      env: NO_ENV,
    });
    const snapshot = await adapter.refresh();
    assertEquals(snapshot.source, "rollout-token-count");
    assert(!snapshot.budget.known);
    assertEquals(snapshot.budget.reason, "unrecognised-snapshot-shape");
  });
});

Deno.test("CodexBudgetAdapter - exhaustion is recorded immediately and overrides the cache", async () => {
  await withCodexHome(async (home) => {
    home.writeFixture(
      "2026-09-09",
      "rollout-2026-09-09T01-00-00-3333.jsonl",
      "rollout_chatgpt_subscription.jsonl",
    );
    const time = clock();
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      now: time.now,
      env: NO_ENV,
    });
    await adapter.refresh();

    time.advance(1_000);
    const recorded = adapter.recordExhaustion(
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:45 PM.",
    );
    assert(recorded);
    assertEquals(recorded.source, "exhaustion-event");
    assert(recorded.budget.known);
    assertEquals(recorded.budget.remainingFraction, 0);
    assertEquals(recorded.exhaustion?.kind, "rate_limit_reached");
    // The local-time reset in the message is never converted to an instant.
    assertEquals(recorded.exhaustion?.resetAt, undefined);
    assertEquals(adapter.latest(), recorded);

    // And the recheck after exhaustion stays bounded — no immediate re-read.
    const next = await adapter.refresh();
    assertEquals(next, recorded);
    assertEquals(adapter.readCount, 1);
  });
});

Deno.test("CodexBudgetAdapter - an ordinary failure is not exhaustion", async () => {
  await withCodexHome(async (home) => {
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      env: NO_ENV,
    });
    assertEquals(
      adapter.recordExhaustion("stream disconnected before completion"),
      null,
    );
    assertEquals(adapter.latest(), undefined);
  });
});

Deno.test("CodexBudgetAdapter - a rejected credential is auth-rejected, not zero budget", async () => {
  await withCodexHome(async (home) => {
    const time = clock();
    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      now: time.now,
      env: NO_ENV,
    });
    adapter.recordAuthRejected("unexpected status 401 Unauthorized");
    const snapshot = adapter.latest();
    assert(snapshot && !snapshot.budget.known);
    assertEquals(snapshot.budget.reason, "auth-rejected");
    assertEquals(snapshot.budget.detail, "unexpected status 401 Unauthorized");
  });
});

Deno.test("findRecentRolloutFiles - newest first, bounded, ignoring other files", async () => {
  await withCodexHome(async (home) => {
    home.writeRollout("2026-09-07", "rollout-2026-09-07T01-00-00-a.jsonl", "");
    home.writeRollout("2026-09-08", "rollout-2026-09-08T01-00-00-b.jsonl", "");
    home.writeRollout("2026-09-09", "rollout-2026-09-09T01-00-00-c.jsonl", "");
    home.writeRollout("2026-09-09", "notes.txt", "not a rollout");

    const files = findRecentRolloutFiles(home.path, 2);
    assertEquals(files.length, 2);
    assert(files[0]?.endsWith("rollout-2026-09-09T01-00-00-c.jsonl"));
    assert(files[1]?.endsWith("rollout-2026-09-08T01-00-00-b.jsonl"));

    assertEquals(findRecentRolloutFiles(`${home.path}/nowhere`, 3), []);
    await Promise.resolve();
  });
});

Deno.test("readFileTail - keeps the tail and drops the partial first line", async () => {
  await withCodexHome(async (home) => {
    const file = home.writeRollout(
      "2026-09-09",
      "rollout-2026-09-09T01-00-00-tail.jsonl",
      "first-line-is-long-and-will-be-cut\nsecond\nthird\n",
    );
    assertEquals(
      readFileTail(file, 4096),
      "first-line-is-long-and-will-be-cut\nsecond\nthird\n",
    );
    assertEquals(readFileTail(file, 20), "second\nthird\n");
    assertEquals(readFileTail(`${file}.missing`, 4096), null);
    await Promise.resolve();
  });
});

Deno.test("CodexBudgetAdapter - the tail bound still finds the newest snapshot in a huge file", async () => {
  await withCodexHome(async (home) => {
    const filler = Array.from(
      { length: 400 },
      (_, index) =>
        `{"timestamp":"2026-09-09T01:00:00.000Z","ordinal":${index},"type":"response_item","payload":{"type":"message","role":"assistant","content":"${
          "x".repeat(200)
        }"}}`,
    ).join("\n");
    const newest =
      '{"timestamp":"2026-09-09T04:00:00.000Z","type":"event_msg","payload":' +
      '{"type":"token_count","info":null,"rate_limits":{"limit_id":"codex",' +
      '"primary":{"used_percent":77,"window_minutes":300,' +
      '"resets_at":1788483600}}}}';
    home.writeRollout(
      "2026-09-09",
      "rollout-2026-09-09T04-00-00-big.jsonl",
      `${filler}\n${newest}\n`,
    );

    const adapter = new CodexBudgetAdapter({
      codexHome: home.path,
      env: NO_ENV,
      tailBytes: 4096,
    });
    const snapshot = await adapter.refresh();
    assert(snapshot.budget.known);
    assertEquals(snapshot.budget.remainingFraction, 0.23);
  });
});
