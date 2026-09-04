/**
 * Tests for the single-token budget probe (Issue #918, parent #902).
 *
 * Every test injects `fetchFn`, so nothing here touches the network or spawns
 * a process — a probe that made a real request would cost seconds per case and
 * would spend real budget measuring budget (Issue #906). Nothing here mutates
 * process state either, so the file stays out of `parallel_safety_cap_test.ts`
 * (Issue #880).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CLAUDE_BUDGET_PROBE_URL,
  type ClaudeBudgetFetch,
  type ClaudeTokenBudget,
  probeClaudeTokenBudget,
} from "../lib/claude_token_budget.ts";

/** A token value distinctive enough that a leak into any string is obvious. */
const TOKEN = "sk-ant-oat01-UNIQUE-PROBE-TOKEN-VALUE-918";

/** Headers as the live API returned them on 2026-09-04 (see the module doc). */
const LIVE_HEADERS: Record<string, string> = {
  "anthropic-ratelimit-unified-status": "allowed",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-reset": "1788483600",
  "anthropic-ratelimit-unified-5h-utilization": "0.28",
  "anthropic-ratelimit-unified-7d-status": "allowed",
  "anthropic-ratelimit-unified-7d-reset": "1788829200",
  "anthropic-ratelimit-unified-7d-utilization": "0.62",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
};

/** Record every call so a test can assert exactly one request was made. */
interface CountingFetch {
  fetchFn: ClaudeBudgetFetch;
  calls: () => number;
  lastUrl: () => string | undefined;
  lastInit: () => RequestInit | undefined;
}

function countingFetch(
  respond: (url: string, init: RequestInit) => Promise<Response>,
): CountingFetch {
  let calls = 0;
  let lastUrl: string | undefined;
  let lastInit: RequestInit | undefined;
  return {
    fetchFn: (url, init) => {
      calls += 1;
      lastUrl = url;
      lastInit = init;
      return respond(url, init);
    },
    calls: () => calls,
    lastUrl: () => lastUrl,
    lastInit: () => lastInit,
  };
}

/** A stub response carrying `headers` and a body the probe must not read. */
function stubResponse(
  headers: Record<string, string>,
  status = 200,
): Response {
  return new Response(JSON.stringify({ content: [] }), { status, headers });
}

/** Every string a result carries, so a leak anywhere in it is caught. */
function allStrings(result: ClaudeTokenBudget): string {
  return JSON.stringify(result);
}

Deno.test("probe reports the remaining budget from a well-formed response", async () => {
  const fetcher = countingFetch(() =>
    Promise.resolve(stubResponse(LIVE_HEADERS))
  );

  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider-2",
    fetchFn: fetcher.fetchFn,
  });

  assert(result.known, "a well-formed response must yield a known budget");
  assertEquals(result.label, "provider-2");
  // The seven-day window is the constrained one (0.62 used vs 0.28), so it is
  // the headline even though the API called five_hour representative.
  assertEquals(result.window, "seven_day");
  assertEquals(result.remainingFraction.toFixed(2), "0.38");
  assertEquals(result.resetAt, 1788829200 * 1000);
  assertEquals(result.representativeClaim, "five_hour");
  assertEquals(result.windows.length, 2);
  assert(
    result.remainingFraction >= 0 && result.remainingFraction <= 1,
    "remainingFraction must lie inside [0, 1]",
  );
});

Deno.test("probe issues exactly one request, to the confirmed endpoint", async () => {
  const fetcher = countingFetch(() =>
    Promise.resolve(stubResponse(LIVE_HEADERS))
  );

  await probeClaudeTokenBudget(TOKEN, {
    label: "provider",
    fetchFn: fetcher.fetchFn,
  });

  assertEquals(fetcher.calls(), 1);
  assertEquals(fetcher.lastUrl(), CLAUDE_BUDGET_PROBE_URL);
  const init = fetcher.lastInit();
  assertEquals(init?.method, "POST");
  assert(init?.signal instanceof AbortSignal, "the request must be bounded");
});

Deno.test("probe does not retry a failing request", async () => {
  const fetcher = countingFetch(() => Promise.resolve(stubResponse({}, 500)));

  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider-3",
    fetchFn: fetcher.fetchFn,
  });

  assertEquals(fetcher.calls(), 1);
  assert(!result.known);
  assertEquals(result.reason, "http-500");
});

Deno.test("an unauthorised response is unknown, not a budget of zero", async () => {
  const fetcher = countingFetch(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          error: { message: "OAuth access token is invalid." },
        }),
        { status: 401 },
      ),
    )
  );

  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider-2",
    fetchFn: fetcher.fetchFn,
  });

  assertEquals(fetcher.calls(), 1);
  assert(!result.known, "a 401 must never present as a known budget");
  assertEquals(result.reason, "http-401");
  assertEquals(result.label, "provider-2");
});

Deno.test("a timeout is reported as a timeout and never throws", async () => {
  const fetcher = countingFetch((_url, init) => {
    assert(init.signal instanceof AbortSignal, "timeout needs a signal");
    return Promise.reject(
      new DOMException("The signal has been aborted", "TimeoutError"),
    );
  });

  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider",
    fetchFn: fetcher.fetchFn,
    timeoutMs: 25,
  });

  assertEquals(fetcher.calls(), 1, "a timed-out probe must not try again");
  assert(!result.known);
  assertEquals(result.reason, "timeout");
  assertStringIncludes(result.detail ?? "", "25ms");
});

Deno.test("the probe returns within its configured timeout", async () => {
  // A fetch that never settles on its own: only the injected signal ends it,
  // which is what guarantees startup cannot stall behind this probe.
  const fetcher = countingFetch((_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      assert(signal instanceof AbortSignal);
      signal.addEventListener("abort", () => {
        reject(new DOMException("The signal has been aborted", "TimeoutError"));
      });
    })
  );

  const started = Date.now();
  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider",
    fetchFn: fetcher.fetchFn,
    timeoutMs: 50,
  });
  const elapsed = Date.now() - started;

  assert(!result.known);
  assertEquals(result.reason, "timeout");
  assert(elapsed < 2000, `probe took ${elapsed}ms, well past its 50ms bound`);
});

Deno.test("a network failure is unknown, distinct from a timeout", async () => {
  const fetcher = countingFetch(() =>
    Promise.reject(new TypeError("error sending request for url"))
  );

  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider",
    fetchFn: fetcher.fetchFn,
  });

  // Counted here too: a retry on the throw path would double both the delay
  // at startup and the spend, which is exactly what #918 forbids.
  assertEquals(fetcher.calls(), 1);
  assert(!result.known);
  assertEquals(result.reason, "network-error");
});

Deno.test("a 200 without the rate-limit headers is an unrecognised shape", async () => {
  const fetcher = countingFetch(() =>
    Promise.resolve(stubResponse({ "content-type": "application/json" }))
  );

  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider",
    fetchFn: fetcher.fetchFn,
  });

  assertEquals(fetcher.calls(), 1);
  assert(!result.known, "missing headers must never be read as full budget");
  assertEquals(result.reason, "unrecognised-response-shape");
});

Deno.test("a half-reported window is unrecognised, not half-believed", async () => {
  // Utilisation present, reset absent: guessing the missing half would produce
  // a number that looks authoritative, which is the failure #918 forbids.
  const fetcher = countingFetch(() =>
    Promise.resolve(
      stubResponse({ "anthropic-ratelimit-unified-5h-utilization": "0.10" }),
    )
  );

  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider",
    fetchFn: fetcher.fetchFn,
  });

  assert(!result.known);
  assertEquals(result.reason, "unrecognised-response-shape");
});

Deno.test("an out-of-range utilisation is rejected rather than clamped", async () => {
  const fetcher = countingFetch(() =>
    Promise.resolve(stubResponse({
      "anthropic-ratelimit-unified-5h-utilization": "not-a-number",
      "anthropic-ratelimit-unified-5h-reset": "1788483600",
      "anthropic-ratelimit-unified-7d-utilization": "1.7",
      "anthropic-ratelimit-unified-7d-reset": "1788829200",
    }))
  );

  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider",
    fetchFn: fetcher.fetchFn,
  });

  assert(!result.known);
  assertEquals(result.reason, "unrecognised-response-shape");
});

Deno.test("one usable window is enough, even when the other is malformed", async () => {
  const fetcher = countingFetch(() =>
    Promise.resolve(stubResponse({
      "anthropic-ratelimit-unified-5h-utilization": "0.25",
      "anthropic-ratelimit-unified-5h-reset": "1788483600",
      "anthropic-ratelimit-unified-7d-reset": "1788829200",
    }))
  );

  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider",
    fetchFn: fetcher.fetchFn,
  });

  assert(result.known);
  assertEquals(result.window, "five_hour");
  assertEquals(result.remainingFraction, 0.75);
  assertEquals(result.windows.length, 1);
});

Deno.test("an empty token is a named fault, and costs no request", async () => {
  const fetcher = countingFetch(() =>
    Promise.resolve(stubResponse(LIVE_HEADERS))
  );

  const result = await probeClaudeTokenBudget("   ", {
    label: "provider-4",
    fetchFn: fetcher.fetchFn,
  });

  assertEquals(fetcher.calls(), 0);
  assert(!result.known);
  assertEquals(result.reason, "missing-token");
});

Deno.test("the token value reaches no returned value on any path", async () => {
  const paths: ReadonlyArray<{ name: string; fetchFn: ClaudeBudgetFetch }> = [
    {
      name: "success",
      fetchFn: () => Promise.resolve(stubResponse(LIVE_HEADERS)),
    },
    {
      name: "unauthorised",
      fetchFn: () => Promise.resolve(stubResponse({}, 401)),
    },
    {
      name: "timeout",
      fetchFn: () =>
        Promise.reject(
          new DOMException("The signal has been aborted", "TimeoutError"),
        ),
    },
    {
      name: "unrecognised",
      fetchFn: () => Promise.resolve(stubResponse({})),
    },
    {
      // The worst case: a transport whose error message quotes the request,
      // token and all. The module must strip it before returning.
      name: "error message quoting the token",
      fetchFn: () =>
        Promise.reject(
          new TypeError(`failed to send Bearer ${TOKEN} to the API`),
        ),
    },
  ];

  for (const path of paths) {
    const result = await probeClaudeTokenBudget(TOKEN, {
      label: "provider-2",
      fetchFn: path.fetchFn,
    });
    const serialised = allStrings(result);
    assert(
      !serialised.includes(TOKEN),
      `${path.name}: token value leaked into the result: ${serialised}`,
    );
    assert(
      !serialised.includes("UNIQUE-PROBE-TOKEN-VALUE"),
      `${path.name}: a fragment of the token leaked: ${serialised}`,
    );
  }
});

Deno.test("a Response whose headers throw yields unknown, not an exception", async () => {
  const hostile = new Response(null, { status: 200 });
  Object.defineProperty(hostile, "headers", {
    get() {
      throw new Error(`header bag exploded holding ${TOKEN}`);
    },
  });

  const result = await probeClaudeTokenBudget(TOKEN, {
    label: "provider",
    fetchFn: () => Promise.resolve(hostile),
  });

  assert(!result.known, "no exception may escape the module");
  assertEquals(result.reason, "unrecognised-response-shape");
  assert(!allStrings(result).includes(TOKEN));
});
