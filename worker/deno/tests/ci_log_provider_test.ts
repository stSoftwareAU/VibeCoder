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
 *   - Back-compat: a legacy `prFailureActions` config issues exactly the
 *     same Jenkins fetches as the equivalent `ciProviders` config.
 *
 * Jenkins credentials reach the dispatcher through its injected `readEnv`
 * lookup (Issue #944), so nothing here mutates the process environment and
 * the file runs in the parallel pass.
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
import { getCiProviders } from "../lib/repo_config.ts";
import type { FailedCiCheck } from "../lib/pr_ci_checks.ts";
import type { CiProviderConfig, RepoConfig, Result } from "../types.ts";
import { envFrom } from "./support/env_lookup.ts";

/** The Jenkins credentials the dispatcher is handed. */
const jenkinsEnv = envFrom({
  JENKINS_URL: "https://jenkins.example.com",
  JENKINS_USER: "test-user",
  JENKINS_TOKEN: "test-token",
});

function makeCheck(overrides: Partial<FailedCiCheck> = {}): FailedCiCheck {
  return {
    repo: "stSoftwareAU/example",
    prNumber: 42,
    branchName: "feature/test",
    checkId: "1",
    checkName: "Jenkins / build",
    encodedAnnotations: "",
    targetUrl: "https://jenkins.example.com/job/foo/job/Develop/123/",
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

Deno.test("ci_log_provider - built-in providers are registered", () => {
  const ids = listCiLogProviders().map((p) => p.id);
  assert(ids.includes("jenkins"), `jenkins missing from ${ids.join(", ")}`);
  assert(ids.includes("github-actions"), "github-actions missing");
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
  const provider = resolveCiLogProvider({
    repo: "stSoftwareAU/example",
    checkName: "Jenkins / build",
    targetUrl: "https://jenkins.example.com/job/foo/job/Develop/123/",
    providerConfig: { provider: "jenkins", jobPath: "foo/job/Develop" },
  });
  assertEquals(provider.id, "jenkins");
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

// ---------------------------------------------------------------------------
// Back-compat: legacy prFailureActions === equivalent ciProviders
// ---------------------------------------------------------------------------

/**
 * Drive the dispatcher for one repo config and record every Jenkins URL
 * requested plus the rendered excerpt, so two configurations can be
 * compared for identical fetch behaviour.
 */
async function runForConfig(
  repoConfigs: Record<string, RepoConfig>,
): Promise<{ urls: string[]; providers: CiProviderConfig[]; excerpt: string }> {
  const urls: string[] = [];
  const fetchFn = (url: string | URL | Request): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    urls.push(u);
    if (u.endsWith("/api/json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            number: 123,
            result: "FAILURE",
            url: "https://jenkins.example.com/job/foo/job/Develop/123/",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("console output", { status: 200 }));
  };

  const providers = getCiProviders(repoConfigs, "stSoftwareAU/example");
  const results = await runPrFailureActions({
    repo: "stSoftwareAU/example",
    prNumber: 42,
    failedChecks: [makeCheck({})],
    providers,
    fetchFn,
    readEnv: jenkinsEnv,
  });

  const first = results[0]!;
  assert(first.ok, `expected success, got ${JSON.stringify(first)}`);
  return {
    urls,
    providers,
    excerpt: first.ok ? JSON.stringify(first.excerpt) : "",
  };
}

Deno.test("ci_log_provider - legacy prFailureActions fetches identically to ciProviders", async () => {
  const legacy = await runForConfig({
    "stSoftwareAU/example": {
      prFailureActions: [
        {
          type: "fetch-jenkins-log",
          jobPath: "foo/job/Develop",
          checkNamePattern: "Jenkins",
        },
      ],
    },
  });

  const modern = await runForConfig({
    "stSoftwareAU/example": {
      ciProviders: [
        {
          provider: "jenkins",
          jobPath: "foo/job/Develop",
          checkNamePattern: "Jenkins",
        },
      ],
    },
  });

  assertEquals(legacy.providers, modern.providers);
  assertEquals(legacy.urls, modern.urls);
  assertEquals(legacy.excerpt, modern.excerpt);
  assertEquals(legacy.urls.length, 2, "status + console fetch expected");
});
