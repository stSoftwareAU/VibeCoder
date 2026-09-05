/**
 * Tests for the CI log provider dispatcher (Issues #1892, #3579, #986).
 *
 * The dispatcher drives the provider registry. Every provider used here is
 * registered by the test itself, exactly as a private extension would
 * register one — core ships only the GitHub Actions default, so a suite
 * that reached for a built-in vendor would be asserting something core must
 * not know (Issue #986). The suite therefore proves what it should: the
 * dispatcher works for a provider it has never heard of.
 *
 * Covers:
 *   - A provider runs successfully and its excerpt is returned
 *   - No failing check matches the provider
 *   - The provider reports a failure, and it is captured rather than thrown
 *   - A provider that throws is captured too
 *   - An empty excerpt is an error, never a hollow success
 *   - An unregistered provider id is an explicit error
 *   - `checkNamePattern` validation: oversized, unsafe, and matching
 *   - Multiple providers produce one result each, in order
 *
 * Uses Australian English throughout (behaviour, organisation, colour).
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

const REPO = "stSoftwareAU/example";
const PROVIDER_ID = "example-ci";

function makeCheck(overrides: Partial<FailedCiCheck> = {}): FailedCiCheck {
  return {
    repo: REPO,
    prNumber: 42,
    branchName: "feature/test",
    checkId: "1",
    checkName: "example-ci / build",
    encodedAnnotations: "",
    targetUrl: "https://ci.example.com/job/foo/job/Develop/123/",
    ...overrides,
  };
}

/**
 * An extension's provider, shaped the way a real one is: it claims a check
 * only when the repo configured it *and* the check name matches its
 * pattern, defaulting to its own id. Without that second half the
 * dispatcher's selection behaviour is untestable.
 */
function makeProvider(
  id: string,
  fetchLog: (ctx: CiFailureContext) => Promise<Result<CiLogExcerpt, string>>,
): CiLogProvider {
  return {
    id,
    matches: (ctx) => {
      if (ctx.providerConfig?.provider !== id) return false;
      const pattern = compileCheckNamePattern(
        ctx.providerConfig.checkNamePattern,
        new RegExp(id, "i"),
      );
      return pattern.ok && pattern.value.test(ctx.checkName);
    },
    fetchLog,
  };
}

/** A provider that always resolves the same excerpt. */
function resolving(id: string, logText: string): CiLogProvider {
  return makeProvider(id, (ctx) =>
    Promise.resolve({
      ok: true,
      value: {
        providerId: id,
        buildId: "123",
        url: `https://ci.example.com/${ctx.repo}/123`,
        status: "FAILURE",
        logText,
      },
    }));
}

/** Register `provider`, run `body`, and always unregister again. */
async function withProvider<T>(
  provider: CiLogProvider,
  body: () => Promise<T>,
): Promise<T> {
  registerCiLogProvider(provider);
  try {
    return await body();
  } finally {
    unregisterCiLogProvider(provider.id);
  }
}

function run(
  providers: CiProviderConfig[],
  failedChecks: FailedCiCheck[] = [makeCheck()],
) {
  return runPrFailureActions({
    repo: REPO,
    prNumber: 42,
    failedChecks,
    providers,
  });
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - an extension's provider drives end to end", async () => {
  const results = await withProvider(
    resolving(PROVIDER_ID, "build failed\nfoo bar"),
    () => run([{ provider: PROVIDER_ID, jobPath: "foo/job/Develop" }]),
  );

  assertEquals(results.length, 1);
  const r = results[0]!;
  assertEquals(r.providerId, PROVIDER_ID);
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  if (r.ok) {
    assertEquals(r.excerpt.buildId, "123");
    assertEquals(r.excerpt.status, "FAILURE");
    assert(r.excerpt.logText.includes("build failed"));
  }
});

Deno.test("runPrFailureActions - the configured jobPath reaches the provider untouched", async () => {
  const seen: CiFailureContext[] = [];
  await withProvider(
    makeProvider(PROVIDER_ID, (ctx) => {
      seen.push(ctx);
      return Promise.resolve({ ok: false, error: "not today" });
    }),
    () =>
      run([{ provider: PROVIDER_ID, jobPath: "any/shape/the-provider/likes" }]),
  );

  assertEquals(
    seen[0]!.providerConfig?.jobPath,
    "any/shape/the-provider/likes",
  );
});

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - no failing check matches the provider", async () => {
  const results = await withProvider(
    resolving("other-ci", "unused"),
    () => run([{ provider: "other-ci" }], [makeCheck({ checkName: "ESLint" })]),
  );

  assertEquals(results.length, 1);
  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes("no failing check matched provider"));
});

Deno.test("runPrFailureActions - an unregistered provider id is an explicit error", async () => {
  const results = await run([{ provider: "never-registered" }]);

  assertEquals(results.length, 1);
  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes("no CI log provider registered"));
});

Deno.test("runPrFailureActions - no providers returns an empty array", async () => {
  assertEquals(
    await runPrFailureActions({
      repo: REPO,
      prNumber: 42,
      failedChecks: [],
      providers: [],
    }),
    [],
  );
});

// ---------------------------------------------------------------------------
// Failure capture — the dispatcher never unwinds the fix flow
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - a provider failure is captured, not thrown", async () => {
  const results = await withProvider(
    makeProvider(
      PROVIDER_ID,
      () =>
        Promise.resolve({ ok: false, error: "HTTP 500 Internal Server Error" }),
    ),
    () => run([{ provider: PROVIDER_ID }]),
  );

  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes("HTTP 500"));
});

Deno.test("runPrFailureActions - a provider that throws is captured too", async () => {
  const results = await withProvider(
    makeProvider(PROVIDER_ID, () => {
      throw new Error("provider bug");
    }),
    () => run([{ provider: PROVIDER_ID }]),
  );

  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) {
    assert(r.error.includes("threw"), `got: ${r.error}`);
    assert(r.error.includes("provider bug"));
  }
});

Deno.test("runPrFailureActions - an empty excerpt is an error, never a hollow success", async () => {
  const results = await withProvider(
    resolving(PROVIDER_ID, ""),
    () => run([{ provider: PROVIDER_ID }]),
  );

  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes("empty log excerpt"));
});

// ---------------------------------------------------------------------------
// checkNamePattern validation
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - checkNamePattern with nested quantifiers is rejected", async () => {
  const results = await withProvider(
    resolving(PROVIDER_ID, "unused"),
    () => run([{ provider: PROVIDER_ID, checkNamePattern: "(a+)+" }]),
  );

  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes("nested quantifiers"), `got: ${r.error}`);
});

Deno.test("runPrFailureActions - an oversized checkNamePattern is rejected", async () => {
  const results = await withProvider(
    resolving(PROVIDER_ID, "unused"),
    () => run([{ provider: PROVIDER_ID, checkNamePattern: "a".repeat(201) }]),
  );

  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes("exceeds"), `got: ${r.error}`);
});

Deno.test("runPrFailureActions - a valid custom checkNamePattern is accepted", async () => {
  const results = await withProvider(
    resolving(PROVIDER_ID, "log body"),
    () =>
      run(
        [{ provider: PROVIDER_ID, checkNamePattern: "private-repo-25" }],
        [makeCheck({ checkName: "private-repo-25 build" })],
      ),
  );

  assertEquals(results[0]!.ok, true);
});

// ---------------------------------------------------------------------------
// Multiple providers
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - one result per configured provider, in order", async () => {
  const results = await withProvider(
    resolving(PROVIDER_ID, "log body"),
    () =>
      run([
        { provider: PROVIDER_ID, jobPath: "foo/job/Develop" },
        { provider: "never-registered", jobPath: "other/job/Develop" },
      ]),
  );

  assertEquals(results.length, 2);
  assertEquals(results[0]!.ok, true);
  assertEquals(results[0]!.providerId, PROVIDER_ID);
  assertEquals(results[1]!.ok, false);
  assertEquals(results[1]!.providerId, "never-registered");
});
