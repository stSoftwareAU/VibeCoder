/**
 * One headless review-fleet-prs round, run inside the worker container
 * (Issue #3293): the round's Claude subscription comes from the worker's own
 * credential pool, and a round the usage limit stopped is run once more on
 * the next subscription with budget.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { type ReviewRoundDeps, runReviewRound } from "../lib/review_round.ts";

const USAGE_LIMIT = "You've hit your usage limit · resets 1:50pm (UTC)";

interface Call {
  args: string[];
  env: Record<string, string>;
}

// A pool of two subscriptions: start-up exports `provider`, and the retry
// asks for anything but the label it is handed.
function fakeDeps(
  outcomes: { code: number; output: string }[],
  options: { held?: string; next?: string | null } = {},
): { deps: ReviewRoundDeps; calls: Call[]; log: string[]; excluded: string[] } {
  const calls: Call[] = [];
  const log: string[] = [];
  const excluded: string[] = [];
  const held = "held" in options ? options.held : "provider";
  const next = "next" in options ? options.next : "provider-2";
  const deps: ReviewRoundDeps = {
    exportStartCredential: (setEnv) => {
      if (held === undefined) return Promise.resolve(undefined);
      setEnv("CLAUDE_CODE_OAUTH_TOKEN", `${held}-secret`);
      return Promise.resolve(held);
    },
    switchCredential: (exclude, setEnv) => {
      excluded.push(exclude);
      if (next === null || next === undefined) return Promise.resolve(null);
      setEnv("CLAUDE_CODE_OAUTH_TOKEN", `${next}-secret`);
      return Promise.resolve(next);
    },
    runClaude: (args, env) => {
      calls.push({ args, env: { ...env } });
      return Promise.resolve(
        outcomes[calls.length - 1] ?? { code: 0, output: "" },
      );
    },
    log: (message) => log.push(message),
  };
  return { deps, calls, log, excluded };
}

Deno.test("runReviewRound runs claude -p on the pool's subscription and logs only its label", async () => {
  const { deps, calls, log } = fakeDeps([{ code: 0, output: "Round done" }]);
  const code = await runReviewRound("review ONE round", ["--model", "m"], deps);
  assertEquals(code, 0);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.args, ["-p", "review ONE round", "--model", "m"]);
  assertEquals(calls[0]!.env["CLAUDE_CODE_OAUTH_TOKEN"], "provider-secret");
  // Reviewer agents may outlast claude -p's 600s default background wait;
  // only the round's own alarm may cut them off.
  assertEquals(calls[0]!.env["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"], "0");
  assertStringIncludes(log.join("\n"), "round on Claude subscription provider");
  assertEquals(log.some((m) => m.includes("secret")), false);
});

Deno.test("runReviewRound retries a usage-limit round once on the next subscription", async () => {
  const { deps, calls, log, excluded } = fakeDeps([
    { code: 1, output: USAGE_LIMIT },
    { code: 0, output: "Round done" },
  ]);
  const code = await runReviewRound("p", [], deps);
  assertEquals(code, 0);
  assertEquals(
    calls.map((c) => c.env["CLAUDE_CODE_OAUTH_TOKEN"]),
    ["provider-secret", "provider-2-secret"],
  );
  assertEquals(excluded, ["provider"]);
  const text = log.join("\n");
  assertStringIncludes(
    text,
    "round hit the usage limit on subscription provider; selecting another",
  );
  assertStringIncludes(
    text,
    "retrying the round once on subscription provider-2",
  );
});

Deno.test("runReviewRound keeps a usage-limit round failed when no other subscription has budget", async () => {
  const { deps, calls, log } = fakeDeps([{ code: 1, output: USAGE_LIMIT }], {
    next: null,
  });
  assertEquals(await runReviewRound("p", [], deps), 1);
  assertEquals(calls.length, 1);
  assertStringIncludes(
    log.join("\n"),
    "no other subscription has budget; the round stays failed",
  );
});

Deno.test("runReviewRound does not retry a round that failed for another reason", async () => {
  const { deps, calls, excluded } = fakeDeps([
    { code: 3, output: "model overloaded" },
  ]);
  assertEquals(await runReviewRound("p", [], deps), 3);
  assertEquals(calls.length, 1);
  assertEquals(excluded, []);
});

Deno.test("runReviewRound does not rotate a token that came from no pool file", async () => {
  // No held label: the token came from the environment, so which one ran out
  // is unknown and rotating could hand the same one straight back.
  const { deps, calls, excluded } = fakeDeps(
    [{ code: 1, output: USAGE_LIMIT }],
    {
      held: undefined,
    },
  );
  assertEquals(await runReviewRound("p", [], deps), 1);
  assertEquals(calls.length, 1);
  assertEquals(excluded, []);
});
