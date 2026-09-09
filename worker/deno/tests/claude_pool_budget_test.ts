/**
 * Tests for lib/claude_pool_budget.ts — is another subscription worth
 * restarting for? (Issue #919 follow-up.)
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import {
  POOL_BUDGET_FLOOR,
  poolHasAnotherTokenWithBudget,
} from "../lib/claude_pool_budget.ts";
import { CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING } from "../lib/claude_token_selection.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";

function tokenFile(
  label: string,
  overrides: Partial<ProviderTokenFile> = {},
): ProviderTokenFile {
  return {
    label,
    path: `/creds/claude/${label}.env`,
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    value: `token-${label}`,
    primary: label === "provider",
    poolMember: true,
    entries: [],
    ...overrides,
  } as ProviderTokenFile;
}

/** A fetch that answers each token with a fixed utilisation. */
function fetchWith(byToken: Record<string, number>) {
  let calls = 0;
  const fn = (_url: string, init: RequestInit) => {
    calls++;
    const auth = String(
      (init.headers as Record<string, string>)["authorization"] ?? "",
    );
    const token = auth.replace("Bearer ", "");
    const util = byToken[token];
    if (util === undefined) {
      return Promise.resolve(new Response("nope", { status: 401 }));
    }
    return Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": String(util),
          "anthropic-ratelimit-unified-5h-reset": "1788660000",
          "anthropic-ratelimit-unified-7d-utilization": String(util),
          "anthropic-ratelimit-unified-7d-reset": "1788660000",
          "anthropic-ratelimit-unified-representative-claim": "five_hour",
        },
      }),
    );
  };
  return { fn, calls: () => calls };
}

Deno.test("poolHasAnotherTokenWithBudget - one subscription asks nothing and answers no", async () => {
  // Every single-token host. The promise is that it makes no request at all.
  const probe = fetchWith({ "token-provider": 0.0 });
  assertEquals(
    await poolHasAnotherTokenWithBudget([tokenFile("provider")], undefined, {
      fetchFn: probe.fn,
    }),
    false,
  );
  assertEquals(probe.calls(), 0, "a single-token host makes no probe");
});

Deno.test("poolHasAnotherTokenWithBudget - a second subscription with budget is worth restarting for", async () => {
  const probe = fetchWith({ "token-provider": 1.0, "token-provider-2": 0.2 });
  const lines: string[] = [];
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: probe.fn, log: (m) => lines.push(m) },
    ),
    true,
  );
  // The spent token is excluded, so exactly one probe is made.
  assertEquals(probe.calls(), 1);
  assertEquals(lines.length, 1);
  // The label is named; the value never is.
  const line = lines[0] ?? "";
  assertEquals(line.includes("provider-2"), true);
  assertEquals(line.includes("token-provider-2"), false);
});

Deno.test("poolHasAnotherTokenWithBudget - a pool that is also spent is not worth restarting for", async () => {
  const probe = fetchWith({ "token-provider": 1.0, "token-provider-2": 1.0 });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: probe.fn },
    ),
    false,
  );
});

Deno.test("poolHasAnotherTokenWithBudget - a low but usable window is worth restarting for (Issue #1685)", async () => {
  // Under the 20% five-hour guard and nowhere near spent. Until Issue #1685
  // the host waited the window out; a pool holding usable quota must never
  // idle, so the restart happens and the guard only shapes which credential
  // the selection then prefers.
  const probe = fetchWith({
    "token-provider": 1.0,
    "token-provider-2": 0.9,
  });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: probe.fn },
    ),
    true,
  );
});

Deno.test("poolHasAnotherTokenWithBudget - a failed probe is never an assumed budget", async () => {
  // A 401, and a fetch that throws outright. Both answer "no": an unshortened
  // pause is what the host has always done, while a wrong yes spends a restart
  // on a token that cannot serve.
  const revoked = fetchWith({ "token-provider": 1.0 });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: revoked.fn },
    ),
    false,
  );
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      {
        fetchFn: () => {
          throw new Error("network down");
        },
      },
    ),
    false,
  );
});

Deno.test("poolHasAnotherTokenWithBudget - a metered key is not a pool member and is never probed", async () => {
  // Only a subscription token has a budget to compare (Issue #918).
  const probe = fetchWith({ "token-provider-2": 0.1 });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [
        tokenFile("provider"),
        tokenFile("provider-2", { poolMember: false }),
      ],
      "provider",
      { fetchFn: probe.fn },
    ),
    false,
  );
  assertEquals(probe.calls(), 0, "a non-pool file is never probed");
});

/** A fetch that answers each token with per-window utilisations. */
function fetchWindows(
  byToken: Record<string, { fiveHour: number; sevenDay: number }>,
) {
  return (_url: string, init: RequestInit) => {
    const auth = String(
      (init.headers as Record<string, string>)["authorization"] ?? "",
    );
    const util = byToken[auth.replace("Bearer ", "")];
    if (util === undefined) {
      return Promise.resolve(new Response("nope", { status: 401 }));
    }
    return Promise.resolve(
      new Response("{}", {
        status: 200,
        headers: {
          "anthropic-ratelimit-unified-5h-utilization": String(util.fiveHour),
          "anthropic-ratelimit-unified-5h-reset": "1788660000",
          "anthropic-ratelimit-unified-7d-utilization": String(util.sevenDay),
          "anthropic-ratelimit-unified-7d-reset": "1789260000",
        },
      }),
    );
  };
}

Deno.test("poolHasAnotherTokenWithBudget - the restart floor is exhaustion, not the five-hour guard (Issue #1685)", async () => {
  // One question, "can it serve a call?", and exhaustion is the only answer
  // that says no. The 20% five-hour figure is a selection *preference*
  // (`CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING`), so reading it here would idle a
  // host whose other subscription still has quota to spend.
  assertEquals(POOL_BUDGET_FLOOR, 0);
  assertEquals(POOL_BUDGET_FLOOR < CLAUDE_FIVE_HOUR_GUARD_MIN_REMAINING, true);

  // 15% left is under the guard and still worth going back for.
  const belowGuard = fetchWith({
    "token-provider": 1.0,
    "token-provider-2": 0.85,
  });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: belowGuard.fn },
    ),
    true,
  );

  // 25% left clears the guard, and is worth going back for too.
  const aboveGuard = fetchWith({
    "token-provider": 1.0,
    "token-provider-2": 0.75,
  });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: aboveGuard.fn },
    ),
    true,
  );
});

Deno.test("poolHasAnotherTokenWithBudget - the floor is read on the five-hour window, not the most constrained one (Issue #1668)", async () => {
  // A fresh five hours and a nearly spent week: selection would run against
  // this token, so refusing the restart on the seven-day figure would idle
  // the host for nothing.
  const freshHoursSpentWeek = fetchWindows({
    "token-provider": { fiveHour: 1, sevenDay: 1 },
    "token-provider-2": { fiveHour: 0.1, sevenDay: 0.85 },
  });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: freshHoursSpentWeek },
    ),
    true,
  );

  // The mirror image: the five hours are nearly gone but not spent, so under
  // Issue #1685 the restart still happens — 15% of a five-hour window is
  // quota, and waiting it out is the idling this pool exists to avoid.
  const nearlySpentHours = fetchWindows({
    "token-provider": { fiveHour: 1, sevenDay: 1 },
    "token-provider-2": { fiveHour: 0.85, sevenDay: 0.1 },
  });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: nearlySpentHours },
    ),
    true,
  );

  // Spent, though, is spent: a five-hour window with nothing left cannot
  // serve the next call whatever the week holds, so the wait stands.
  const spentHoursFreshWeek = fetchWindows({
    "token-provider": { fiveHour: 1, sevenDay: 1 },
    "token-provider-2": { fiveHour: 1, sevenDay: 0 },
  });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: spentHoursFreshWeek },
    ),
    false,
  );
});

Deno.test("poolHasAnotherTokenWithBudget - exactly at the floor is not worth restarting for (Issue #1668)", async () => {
  // The floor's own boundary: a five-hour window with exactly nothing left
  // cannot serve a call, so the restart check refuses it rather than going
  // back for a token that would stall on its first request.
  const atTheBoundary = fetchWindows({
    "token-provider": { fiveHour: 1, sevenDay: 1 },
    "token-provider-2": { fiveHour: 1 - POOL_BUDGET_FLOOR, sevenDay: 0 },
  });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: atTheBoundary },
    ),
    false,
  );
});
