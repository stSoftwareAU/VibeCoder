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

Deno.test("poolHasAnotherTokenWithBudget - a sliver of budget is not worth a restart loop", async () => {
  // Just under the floor: selecting it would exhaust almost immediately and
  // pause again, turning an hour's wait into a restart loop.
  const justUnder = 1 - (POOL_BUDGET_FLOOR / 2);
  const probe = fetchWith({
    "token-provider": 1.0,
    "token-provider-2": justUnder,
  });
  assertEquals(
    await poolHasAnotherTokenWithBudget(
      [tokenFile("provider"), tokenFile("provider-2")],
      "provider",
      { fetchFn: probe.fn },
    ),
    false,
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
