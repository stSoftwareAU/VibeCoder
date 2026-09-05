/**
 * Tests for the CI log provider dispatcher (Issues #1892, #3579, #986).
 *
 * The dispatcher drives the provider registry. These tests exercise it
 * through a stub provider registered for the duration of each test — core
 * registers no vendor-specific provider, so a test that needed one would
 * be testing an extension rather than the dispatcher.
 *
 * Covers:
 *   - A configured provider runs and its excerpt is returned
 *   - No matching failing check
 *   - Provider-level fetch error, and a provider that throws
 *   - An empty excerpt reported as an explicit failure
 *   - An unregistered provider id
 *   - `checkNamePattern` validation (oversized, unsafe, custom match)
 *   - Multiple providers, mixed results
 */

import { assert, assertEquals } from "@std/assert";
import { runPrFailureActions } from "../lib/pr_failure_actions.ts";
import {
  type CiFailureContext,
  type CiLogExcerpt,
  type CiLogProvider,
  compileCheckNamePattern,
  registerCiLogProvider,
  unregisterCiLogProvider,
} from "../lib/ci_log_provider.ts";
import type { FailedCiCheck } from "../lib/pr_ci_checks.ts";
import type { CiProviderConfig, Result } from "../types.ts";

const STUB_PROVIDER_ID = "stub-ci";

/** How a stub provider should respond to `fetchLog`. */
type StubBehaviour =
  | { kind: "excerpt"; logText: string; buildId?: string; status?: string }
  | { kind: "error"; error: string }
  | { kind: "throw"; message: string };

/** Contexts a stub provider was asked to fetch, in call order. */
interface StubRecord {
  matched: CiFailureContext[];
  fetched: CiFailureContext[];
}

/**
 * Register a stub provider for the body of `run`, then unregister it.
 *
 * The registry rejects duplicate ids, so registration is always paired
 * with removal — a leaked stub would poison every later suite.
 */
async function withStubProvider(
  behaviour: StubBehaviour,
  run: (record: StubRecord) => Promise<void>,
  options: { id?: string; matches?: (ctx: CiFailureContext) => boolean } = {},
): Promise<void> {
  const id = options.id ?? STUB_PROVIDER_ID;
  const record: StubRecord = { matched: [], fetched: [] };
  const provider: CiLogProvider = {
    id,
    matches(ctx) {
      record.matched.push(ctx);
      if (options.matches) return options.matches(ctx);
      // Same contract every real provider follows: honour the operator's
      // `checkNamePattern` when one is configured, else match any check
      // that carries a build URL.
      const compiled = compileCheckNamePattern(
        ctx.providerConfig?.checkNamePattern,
        /.*/,
      );
      if (!compiled.ok) return false;
      return compiled.value.test(ctx.checkName) &&
        (ctx.targetUrl ?? "") !== "";
    },
    fetchLog(ctx): Promise<Result<CiLogExcerpt, string>> {
      record.fetched.push(ctx);
      if (behaviour.kind === "throw") throw new Error(behaviour.message);
      if (behaviour.kind === "error") {
        return Promise.resolve({ ok: false, error: behaviour.error });
      }
      return Promise.resolve({
        ok: true,
        value: {
          providerId: id,
          buildId: behaviour.buildId ?? "123",
          url: "https://ci.example.com/build/123",
          ...(behaviour.status !== undefined
            ? { status: behaviour.status }
            : {}),
          logText: behaviour.logText,
        },
      });
    },
  };

  registerCiLogProvider(provider);
  try {
    await run(record);
  } finally {
    unregisterCiLogProvider(id);
  }
}

function makeCheck(overrides: Partial<FailedCiCheck> = {}): FailedCiCheck {
  return {
    repo: "stSoftwareAU/example",
    prNumber: 42,
    branchName: "feature/test",
    checkId: "1",
    checkName: "stub-ci / build",
    encodedAnnotations: "",
    targetUrl: "https://ci.example.com/build/123",
    ...overrides,
  };
}

function dispatch(
  providers: CiProviderConfig[],
  failedChecks: FailedCiCheck[] = [makeCheck()],
) {
  return runPrFailureActions({
    repo: "stSoftwareAU/example",
    prNumber: 42,
    failedChecks,
    providers,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - a configured provider returns its excerpt", async () => {
  await withStubProvider(
    { kind: "excerpt", logText: "build failed\nfoo bar", status: "FAILURE" },
    async (record) => {
      const results = await dispatch([{ provider: STUB_PROVIDER_ID }]);

      assertEquals(results.length, 1);
      const r = results[0]!;
      assertEquals(r.providerId, STUB_PROVIDER_ID);
      assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
      if (r.ok) {
        assertEquals(r.excerpt.buildId, "123");
        assertEquals(r.excerpt.status, "FAILURE");
        assert(r.excerpt.logText.includes("build failed"));
      }
      assertEquals(record.fetched.length, 1);
      assertEquals(record.fetched[0]?.repo, "stSoftwareAU/example");
      assertEquals(record.fetched[0]?.prNumber, 42);
    },
  );
});

Deno.test("runPrFailureActions - the provider config reaches the provider", async () => {
  await withStubProvider(
    { kind: "excerpt", logText: "log" },
    async (record) => {
      await dispatch([{ provider: STUB_PROVIDER_ID, jobPath: "foo/Develop" }]);
      assertEquals(record.fetched[0]?.providerConfig?.jobPath, "foo/Develop");
    },
  );
});

// ---------------------------------------------------------------------------
// No matching check
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - no failing check matches the pattern", async () => {
  await withStubProvider(
    { kind: "excerpt", logText: "log" },
    async (record) => {
      const results = await dispatch(
        [{ provider: STUB_PROVIDER_ID, checkNamePattern: "nonexistent" }],
      );

      assertEquals(results.length, 1);
      const r = results[0]!;
      assertEquals(r.ok, false);
      if (!r.ok) assert(r.error.includes("no failing check matched provider"));
      assertEquals(record.fetched.length, 0);
    },
  );
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - provider error captured, does not throw", async () => {
  await withStubProvider({ kind: "error", error: "HTTP 500" }, async () => {
    const results = await dispatch([{ provider: STUB_PROVIDER_ID }]);
    const r = results[0]!;
    assertEquals(r.ok, false);
    if (!r.ok) assert(r.error.includes("HTTP 500"));
  });
});

Deno.test("runPrFailureActions - a provider that throws is captured, not propagated", async () => {
  await withStubProvider({ kind: "throw", message: "boom" }, async () => {
    const results = await dispatch([{ provider: STUB_PROVIDER_ID }]);
    const r = results[0]!;
    assertEquals(r.ok, false);
    if (!r.ok) {
      assert(r.error.includes("threw"), `got: ${r.error}`);
      assert(r.error.includes("boom"), `got: ${r.error}`);
    }
  });
});

Deno.test("runPrFailureActions - an empty excerpt is an explicit failure", async () => {
  await withStubProvider({ kind: "excerpt", logText: "" }, async () => {
    const results = await dispatch([{ provider: STUB_PROVIDER_ID }]);
    const r = results[0]!;
    assertEquals(r.ok, false);
    if (!r.ok) assert(r.error.includes("empty log excerpt"), r.error);
  });
});

Deno.test("runPrFailureActions - an unregistered provider id fails loudly", async () => {
  const results = await dispatch([{ provider: "not-registered" }]);
  assertEquals(results.length, 1);
  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes("no CI log provider registered"));
});

// ---------------------------------------------------------------------------
// checkNamePattern validation
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - checkNamePattern with nested quantifiers returns error", async () => {
  await withStubProvider({ kind: "excerpt", logText: "log" }, async () => {
    const results = await dispatch(
      [{ provider: STUB_PROVIDER_ID, checkNamePattern: "(a+)+" }],
    );
    const r = results[0]!;
    assertEquals(r.ok, false);
    if (!r.ok) assert(r.error.includes("nested quantifiers"), r.error);
  });
});

Deno.test("runPrFailureActions - oversized checkNamePattern returns error", async () => {
  await withStubProvider({ kind: "excerpt", logText: "log" }, async () => {
    const results = await dispatch(
      [{ provider: STUB_PROVIDER_ID, checkNamePattern: "a".repeat(201) }],
    );
    const r = results[0]!;
    assertEquals(r.ok, false);
    if (!r.ok) assert(r.error.includes("exceeds"), r.error);
  });
});

Deno.test("runPrFailureActions - custom checkNamePattern matches", async () => {
  await withStubProvider(
    { kind: "excerpt", logText: "log", buildId: "9" },
    async () => {
      const results = await dispatch(
        [{ provider: STUB_PROVIDER_ID, checkNamePattern: "private-repo-25" }],
        [makeCheck({ checkName: "private-repo-25 build" })],
      );
      const r = results[0]!;
      assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
      if (r.ok) assertEquals(r.excerpt.buildId, "9");
    },
  );
});

// ---------------------------------------------------------------------------
// Multiple providers and empty inputs
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - multiple providers produce one result each", async () => {
  await withStubProvider({ kind: "excerpt", logText: "log body" }, async () => {
    const results = await dispatch([
      { provider: STUB_PROVIDER_ID },
      { provider: STUB_PROVIDER_ID, checkNamePattern: "nonexistent-check" },
    ]);

    assertEquals(results.length, 2);
    assertEquals(results[0]!.ok, true);
    const second = results[1]!;
    assertEquals(second.ok, false);
    if (!second.ok) {
      assert(second.error.includes("no failing check matched provider"));
    }
  });
});

Deno.test("runPrFailureActions - no providers returns empty array", async () => {
  const results = await runPrFailureActions({
    repo: "stSoftwareAU/example",
    prNumber: 42,
    failedChecks: [],
    providers: [],
  });
  assertEquals(results, []);
});
