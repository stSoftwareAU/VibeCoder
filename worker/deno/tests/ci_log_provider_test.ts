/**
 * Tests for the CI log provider extension point (Issue #3579).
 *
 * Covers:
 *   - Registry registration, lookup, duplicate rejection and removal.
 *   - `resolveCiLogProvider` falls back to the built-in GitHub Actions
 *     provider when nothing external matches.
 *   - A third-party provider drives end-to-end through the dispatcher
 *     with no edit to `pr_failure_actions.ts`.
 *   - A provider returning an empty excerpt is reported as an explicit
 *     error, never as a hollow success.
 *   - The built-in registration is the GitHub Actions provider and nothing
 *     else (Issue #986). `ci_log_provider_core_only_test.ts` is the
 *     totality assertion; this is the local sanity check.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  type CiFailureContext,
  type CiLogExcerpt,
  type CiLogProvider,
  getCiLogProvider,
  listCiLogProviders,
  registerCiLogProvider,
  resolveCiLogProvider,
  unregisterCiLogProvider,
} from "../lib/ci_log_provider.ts";
import { runPrFailureActions } from "../lib/pr_failure_actions.ts";
import type { FailedCiCheck } from "../lib/pr_ci_checks.ts";
import type { Result } from "../types.ts";

function makeCheck(overrides: Partial<FailedCiCheck> = {}): FailedCiCheck {
  return {
    repo: "stSoftwareAU/example",
    prNumber: 42,
    branchName: "feature/test",
    checkId: "1",
    checkName: "example-ci / build",
    encodedAnnotations: "",
    targetUrl: "https://ci.example.com/job/foo/job/Develop/123/",
    ...overrides,
  };
}

/** A hypothetical third provider — the proof the dispatcher is generic. */
function makeFakeProvider(
  id: string,
  logText: string,
): CiLogProvider {
  return {
    id,
    matches: (ctx: CiFailureContext) => ctx.providerConfig?.provider === id,
    fetchLog: (ctx: CiFailureContext): Promise<Result<CiLogExcerpt, string>> =>
      Promise.resolve({
        ok: true,
        value: {
          providerId: id,
          buildId: "77",
          url: `https://ci.example.com/${ctx.repo}/77`,
          status: "failed",
          logText,
        },
      }),
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

Deno.test("ci_log_provider - the built-in registration is GitHub Actions alone", () => {
  const ids = listCiLogProviders().map((p) => p.id);
  assertEquals(ids, ["github-actions"]);
});

Deno.test("ci_log_provider - register, look up and unregister a provider", () => {
  const provider = makeFakeProvider("teamcity", "boom");
  registerCiLogProvider(provider);
  try {
    assertEquals(getCiLogProvider("teamcity")?.id, "teamcity");
  } finally {
    assertEquals(unregisterCiLogProvider("teamcity"), true);
  }
  assertEquals(getCiLogProvider("teamcity"), undefined);
});

Deno.test("ci_log_provider - duplicate registration fails loudly", () => {
  const provider = makeFakeProvider("duplicate-ci", "boom");
  registerCiLogProvider(provider);
  try {
    assertThrows(
      () => registerCiLogProvider(provider),
      Error,
      "already registered",
    );
  } finally {
    unregisterCiLogProvider("duplicate-ci");
  }
});

Deno.test("ci_log_provider - empty provider id is rejected", () => {
  assertThrows(
    () => registerCiLogProvider(makeFakeProvider("", "boom")),
    Error,
    "non-empty string",
  );
});

Deno.test("ci_log_provider - resolve falls back to GitHub Actions", () => {
  const provider = resolveCiLogProvider({
    repo: "stSoftwareAU/example",
    checkName: "some-unknown-check",
  });
  assertEquals(provider.id, "github-actions");
});

Deno.test("ci_log_provider - resolve picks the matching external provider", () => {
  // An extension's provider, registered exactly as a private extension
  // would register it. Core ships none, so the test brings its own.
  registerCiLogProvider(makeFakeProvider("example-ci", "boom"));
  try {
    const provider = resolveCiLogProvider({
      repo: "stSoftwareAU/example",
      checkName: "example-ci / build",
      targetUrl: "https://ci.example.com/job/foo/job/Develop/123/",
      providerConfig: { provider: "example-ci", jobPath: "foo/job/Develop" },
    });
    assertEquals(provider.id, "example-ci");
  } finally {
    unregisterCiLogProvider("example-ci");
  }
});

// ---------------------------------------------------------------------------
// A third provider needs no dispatcher edit
// ---------------------------------------------------------------------------

Deno.test("ci_log_provider - a registered third provider drives end-to-end", async () => {
  registerCiLogProvider(
    makeFakeProvider("teamcity", "TeamCity: step 3 failed"),
  );
  try {
    const results = await runPrFailureActions({
      repo: "stSoftwareAU/example",
      prNumber: 42,
      failedChecks: [makeCheck({ checkName: "TeamCity / build" })],
      providers: [{ provider: "teamcity" }],
    });

    assertEquals(results.length, 1);
    const result = results[0]!;
    assert(result.ok, `expected success, got ${JSON.stringify(result)}`);
    if (result.ok) {
      assertEquals(result.excerpt.providerId, "teamcity");
      assertEquals(result.excerpt.logText, "TeamCity: step 3 failed");
    }
  } finally {
    unregisterCiLogProvider("teamcity");
  }
});

Deno.test("ci_log_provider - unknown provider id is an explicit error", async () => {
  const results = await runPrFailureActions({
    repo: "stSoftwareAU/example",
    prNumber: 42,
    failedChecks: [makeCheck({})],
    providers: [{ provider: "not-registered" }],
  });

  assertEquals(results.length, 1);
  const result = results[0]!;
  assertEquals(result.ok, false);
  if (!result.ok) {
    assert(result.error.includes("no CI log provider registered"));
  }
});

Deno.test("ci_log_provider - an empty excerpt is an error, never a hollow success", async () => {
  registerCiLogProvider(makeFakeProvider("empty-ci", ""));
  try {
    const results = await runPrFailureActions({
      repo: "stSoftwareAU/example",
      prNumber: 42,
      failedChecks: [makeCheck({})],
      providers: [{ provider: "empty-ci" }],
    });

    assertEquals(results.length, 1);
    const result = results[0]!;
    assertEquals(result.ok, false);
    if (!result.ok) assert(result.error.includes("empty log excerpt"));
  } finally {
    unregisterCiLogProvider("empty-ci");
  }
});
