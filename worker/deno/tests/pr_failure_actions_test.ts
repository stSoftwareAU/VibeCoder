/**
 * Tests for the CI log provider dispatcher (Issues #1892, #3579).
 *
 * The dispatcher drives the provider registry; these tests exercise the
 * Jenkins provider through it.
 *
 * Covers:
 *   - Action runs successfully (status + log fetched)
 *   - No matching failing check
 *   - Build URL not parseable
 *   - Underlying fetcher returns an error
 *   - Multiple actions, mixed results
 */

import { assert, assertEquals } from "@std/assert";
import { runPrFailureActions } from "../lib/pr_failure_actions.ts";
import type { EnvReader } from "../lib/jenkins_access_check.ts";
import {
  extractJenkinsBuildNumber,
  extractJenkinsJobPath,
} from "../lib/ci_provider_jenkins.ts";
import type { FailedCiCheck } from "../lib/pr_ci_checks.ts";
import type { CiProviderConfig } from "../types.ts";

/**
 * Jenkins credentials handed to the dispatcher through its `readEnv` seam
 * (Issue #958), rather than written into the process environment where a
 * parallel worker would race on them.
 */
const jenkinsEnv: Record<string, string> = {
  JENKINS_URL: "https://jenkins.example.com",
  JENKINS_USER: "test-user",
  JENKINS_TOKEN: "not-a-real-token",
};

const readEnv: EnvReader = (name) => jenkinsEnv[name];

function makeCheck(overrides: Partial<FailedCiCheck>): FailedCiCheck {
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

// ---------------------------------------------------------------------------
// extractJenkinsBuildNumber
// ---------------------------------------------------------------------------

Deno.test("extractJenkinsBuildNumber - single-segment job path", () => {
  const result = extractJenkinsBuildNumber(
    "https://jenkins.example.com/job/MyJob/42/",
  );
  assert(result.ok);
  if (result.ok) assertEquals(result.value, 42);
});

Deno.test("extractJenkinsBuildNumber - nested job path", () => {
  const result = extractJenkinsBuildNumber(
    "https://jenkins.example.com/job/foo/job/Develop/123/",
  );
  assert(result.ok);
  if (result.ok) assertEquals(result.value, 123);
});

Deno.test("extractJenkinsBuildNumber - missing trailing slash", () => {
  const result = extractJenkinsBuildNumber(
    "https://jenkins.example.com/job/foo/job/Develop/7",
  );
  assert(result.ok);
  if (result.ok) assertEquals(result.value, 7);
});

Deno.test("extractJenkinsBuildNumber - empty URL is unparseable", () => {
  const result = extractJenkinsBuildNumber("");
  assert(!result.ok);
});

Deno.test("extractJenkinsBuildNumber - missing build segment is unparseable", () => {
  const result = extractJenkinsBuildNumber(
    "https://jenkins.example.com/job/foo/",
  );
  assert(!result.ok);
});

Deno.test("extractJenkinsBuildNumber - non-numeric tail is unparseable", () => {
  const result = extractJenkinsBuildNumber(
    "https://jenkins.example.com/job/foo/lastBuild/",
  );
  assert(!result.ok);
});

// The shape GitHub actually records in the `target_url` of a
// `continuous-integration/jenkins/pr-head` status: the build number is
// followed by a `/display/redirect` view suffix (stSoftwareAU/private-repo-12#585).
Deno.test("extractJenkinsBuildNumber - display/redirect suffix", () => {
  const result = extractJenkinsBuildNumber(
    "https://ci.example.invalid/job/stSoftwareAU/job/private-repo-12/job/PR-599/6/display/redirect",
  );
  assert(result.ok);
  if (result.ok) assertEquals(result.value, 6);
});

Deno.test("extractJenkinsBuildNumber - console view suffix", () => {
  const result = extractJenkinsBuildNumber(
    "https://jenkins.example.com/job/foo/job/Develop/123/console",
  );
  assert(result.ok);
  if (result.ok) assertEquals(result.value, 123);
});

// A numeric segment deeper in the URL must not be mistaken for the build:
// the build is always the segment right after the last `job/<name>` pair.
Deno.test("extractJenkinsBuildNumber - numeric view sub-path is not the build", () => {
  const result = extractJenkinsBuildNumber(
    "https://jenkins.example.com/job/foo/12/testReport/junit/3/",
  );
  assert(result.ok);
  if (result.ok) assertEquals(result.value, 12);
});

// A PR job name is non-numeric, so it can never be read as the build number.
Deno.test("extractJenkinsBuildNumber - PR job with no build segment is unparseable", () => {
  const result = extractJenkinsBuildNumber(
    "https://jenkins.example.com/job/stSoftwareAU/job/private-repo-12/job/PR-599/",
  );
  assert(!result.ok);
});

// ---------------------------------------------------------------------------
// extractJenkinsJobPath
// ---------------------------------------------------------------------------

Deno.test("extractJenkinsJobPath - nested PR job path", () => {
  const result = extractJenkinsJobPath(
    "https://ci.example.invalid/job/stSoftwareAU/job/private-repo-12/job/PR-599/6/display/redirect",
  );
  assert(result.ok);
  if (result.ok) {
    assertEquals(result.value, "stSoftwareAU/private-repo-12/PR-599");
  }
});

Deno.test("extractJenkinsJobPath - single-segment job path", () => {
  const result = extractJenkinsJobPath(
    "https://jenkins.example.com/job/MyJob/42/",
  );
  assert(result.ok);
  if (result.ok) assertEquals(result.value, "MyJob");
});

Deno.test("extractJenkinsJobPath - URL with no job segment is unparseable", () => {
  const result = extractJenkinsJobPath("https://jenkins.example.com/blue/42/");
  assert(!result.ok);
});

// A traversal segment must never reach the Jenkins URL builder.
Deno.test("extractJenkinsJobPath - rejects path traversal segments", () => {
  const result = extractJenkinsJobPath(
    "https://jenkins.example.com/job/foo/job/..%2F..%2Fadmin/3/",
  );
  assert(!result.ok);
});

// ---------------------------------------------------------------------------
// Per-PR job path resolution (Jenkins multibranch)
// ---------------------------------------------------------------------------

// The configured jobPath names the Develop job, but a PR check runs under a
// sibling PR-<n> job. Using the configured path with the PR's build number
// would fetch an unrelated (probably green) build and diagnose "no failure
// found" — the silent-wrong-job hazard. Prefer the job named by the check URL.
Deno.test("jenkins provider - uses the PR job named by the check target URL", async () => {
  const seen: string[] = [];
  const results = await runPrFailureActions({
    readEnv,
    repo: "stSoftwareAU/private-repo-12",
    prNumber: 599,
    failedChecks: [makeCheck({
      checkName: "continuous-integration/jenkins/pr-head",
      targetUrl:
        "https://jenkins.example.com/job/stSoftwareAU/job/private-repo-12/job/PR-599/6/display/redirect",
    })],
    providers: [{
      provider: "jenkins",
      jobPath: "stSoftwareAU/private-repo-12/Develop",
      checkNamePattern: "jenkins",
    }],
    fetchFn: (url: string | URL | Request) => {
      seen.push(String(url));
      return Promise.resolve(
        new Response(
          JSON.stringify({ number: 6, result: "FAILURE", url: "u" }),
          { status: 200 },
        ),
      );
    },
  });

  assertEquals(results[0]?.ok, true);
  assert(
    seen.every((u) => u.includes("/job/PR-599/6/")),
    `expected the PR-599 job to be fetched, saw: ${seen.join(", ")}`,
  );
  assert(
    !seen.some((u) => u.includes("/job/Develop/")),
    `must not fetch the configured Develop job, saw: ${seen.join(", ")}`,
  );
});

// Trusting the URL's job path must not let a foreign Jenkins job be fetched:
// the derived job has to live in the same folder as the configured one.
Deno.test("jenkins provider - refuses a job outside the configured folder", async () => {
  const results = await runPrFailureActions({
    readEnv,
    repo: "stSoftwareAU/private-repo-12",
    prNumber: 599,
    failedChecks: [makeCheck({
      checkName: "continuous-integration/jenkins/pr-head",
      targetUrl:
        "https://jenkins.example.com/job/evil/job/OtherRepo/job/PR-1/6/",
    })],
    providers: [{
      provider: "jenkins",
      jobPath: "stSoftwareAU/private-repo-12/Develop",
      checkNamePattern: "jenkins",
    }],
    fetchFn: () => {
      throw new Error("must not fetch a job outside the configured folder");
    },
  });

  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) {
    assert(
      r.error.includes("outside the configured folder"),
      `unexpected error: ${r.error}`,
    );
  }
});

// ---------------------------------------------------------------------------
// checkNamePattern validation (tested through runPrFailureActions)
// ---------------------------------------------------------------------------

Deno.test(
  "runPrFailureActions - checkNamePattern with nested quantifiers returns error",
  async () => {
    const checks: FailedCiCheck[] = [makeCheck({})];
    const providers: CiProviderConfig[] = [
      {
        provider: "jenkins",
        jobPath: "foo",
        checkNamePattern: "(a+)+",
      },
    ];

    const results = await runPrFailureActions({
      readEnv,
      repo: "stSoftwareAU/example",
      prNumber: 42,
      failedChecks: checks,
      providers,
    });

    assertEquals(results.length, 1);
    const r = results[0]!;
    assertEquals(r.ok, false);
    if (!r.ok) {
      assert(r.error.includes("nested quantifiers"), `got: ${r.error}`);
    }
  },
);

// ---------------------------------------------------------------------------
// runPrFailureActions - happy path
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - jenkins provider success", async () => {
  let statusCalls = 0;
  let logCalls = 0;
  const fetchFn = (url: string | URL | Request): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/api/json")) {
      statusCalls++;
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
    if (u.endsWith("/consoleText")) {
      logCalls++;
      return Promise.resolve(
        new Response("build failed\nfoo bar", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  const checks: FailedCiCheck[] = [makeCheck({})];
  const providers: CiProviderConfig[] = [
    { provider: "jenkins", jobPath: "foo/job/Develop" },
  ];

  const results = await runPrFailureActions({
    readEnv,
    repo: "stSoftwareAU/example",
    prNumber: 42,
    failedChecks: checks,
    providers,
    fetchFn,
  });

  assertEquals(results.length, 1);
  const r = results[0]!;
  assertEquals(r.providerId, "jenkins");
  assert(r.ok, `expected ok, got ${JSON.stringify(r)}`);
  if (r.ok) {
    assertEquals(r.excerpt.buildId, "123");
    assertEquals(r.excerpt.status, "FAILURE");
    assert(r.excerpt.logText.includes("build failed"));
  }
  assertEquals(statusCalls, 1);
  assertEquals(logCalls, 1);
});

// ---------------------------------------------------------------------------
// runPrFailureActions - no matching check
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - no failing check matches pattern", async () => {
  const checks: FailedCiCheck[] = [
    makeCheck({ checkName: "ESLint", targetUrl: "https://other/" }),
  ];
  const providers: CiProviderConfig[] = [
    { provider: "jenkins", jobPath: "foo/job/Develop" },
  ];

  const fetchFn = (): Promise<Response> => {
    throw new Error("should not be called");
  };

  const results = await runPrFailureActions({
    readEnv,
    repo: "stSoftwareAU/example",
    prNumber: 42,
    failedChecks: checks,
    providers,
    fetchFn,
  });

  assertEquals(results.length, 1);
  const r = results[0]!;
  assertEquals(r.providerId, "jenkins");
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes("no failing check matched provider"));
});

// ---------------------------------------------------------------------------
// runPrFailureActions - build URL not parseable
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - target URL not parseable", async () => {
  const checks: FailedCiCheck[] = [
    makeCheck({ targetUrl: "https://jenkins.example.com/job/foo/" }),
  ];
  const providers: CiProviderConfig[] = [
    { provider: "jenkins", jobPath: "foo/job/Develop" },
  ];

  const fetchFn = (): Promise<Response> => {
    throw new Error("should not be called");
  };

  const results = await runPrFailureActions({
    readEnv,
    repo: "stSoftwareAU/example",
    prNumber: 42,
    failedChecks: checks,
    providers,
    fetchFn,
  });

  assertEquals(results.length, 1);
  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.toLowerCase().includes("build number"));
});

// ---------------------------------------------------------------------------
// runPrFailureActions - underlying fetcher fails
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - fetcher error captured, does not throw", async () => {
  const fetchFn = (url: string | URL | Request): Promise<Response> => {
    const u = typeof url === "string" ? url : url.toString();
    if (u.endsWith("/api/json")) {
      return Promise.resolve(
        new Response("server error", {
          status: 500,
          statusText: "Internal Server Error",
        }),
      );
    }
    return Promise.resolve(new Response("not found", { status: 404 }));
  };

  const checks: FailedCiCheck[] = [makeCheck({})];
  const providers: CiProviderConfig[] = [
    { provider: "jenkins", jobPath: "foo/job/Develop" },
  ];

  const results = await runPrFailureActions({
    readEnv,
    repo: "stSoftwareAU/example",
    prNumber: 42,
    failedChecks: checks,
    providers,
    fetchFn,
  });

  assertEquals(results.length, 1);
  const r = results[0]!;
  assertEquals(r.ok, false);
  if (!r.ok) assert(r.error.includes("HTTP 500"));
});

// ---------------------------------------------------------------------------
// runPrFailureActions - mixed results across multiple actions
// ---------------------------------------------------------------------------

Deno.test(
  "runPrFailureActions - multiple providers produce one result each",
  async () => {
    const fetchFn = (url: string | URL | Request): Promise<Response> => {
      const u = typeof url === "string" ? url : url.toString();
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
      if (u.endsWith("/consoleText")) {
        return Promise.resolve(new Response("log body", { status: 200 }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };

    const checks: FailedCiCheck[] = [
      makeCheck({ checkName: "Jenkins / build" }),
    ];
    const providers: CiProviderConfig[] = [
      { provider: "jenkins", jobPath: "foo/job/Develop" },
      {
        provider: "jenkins",
        jobPath: "other/job/Develop",
        checkNamePattern: "nonexistent-check",
      },
    ];

    const results = await runPrFailureActions({
      readEnv,
      repo: "stSoftwareAU/example",
      prNumber: 42,
      failedChecks: checks,
      providers,
      fetchFn,
    });

    assertEquals(results.length, 2);
    const first = results[0]!;
    const second = results[1]!;
    assertEquals(first.ok, true);
    assertEquals(second.ok, false);
    if (!second.ok) {
      assert(second.error.includes("no failing check matched provider"));
    }
  },
);

// ---------------------------------------------------------------------------
// runPrFailureActions - empty inputs
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - no providers returns empty array", async () => {
  const results = await runPrFailureActions({
    readEnv,
    repo: "stSoftwareAU/example",
    prNumber: 42,
    failedChecks: [],
    providers: [],
  });
  assertEquals(results, []);
});

// ---------------------------------------------------------------------------
// runPrFailureActions - checkNamePattern length guard
// ---------------------------------------------------------------------------

Deno.test(
  "runPrFailureActions - oversized checkNamePattern returns error",
  async () => {
    const checks: FailedCiCheck[] = [
      makeCheck({ checkName: "Jenkins / build" }),
    ];
    const oversizedPattern = "a".repeat(201);
    const providers: CiProviderConfig[] = [
      {
        provider: "jenkins",
        jobPath: "foo",
        checkNamePattern: oversizedPattern,
      },
    ];

    const results = await runPrFailureActions({
      readEnv,
      repo: "stSoftwareAU/example",
      prNumber: 42,
      failedChecks: checks,
      providers,
    });

    assertEquals(results.length, 1);
    const r = results[0]!;
    assertEquals(r.ok, false);
    if (!r.ok) {
      assert(r.error.includes("exceeds"), `got: ${r.error}`);
    }
  },
);

Deno.test(
  "runPrFailureActions - custom checkNamePattern matches",
  async () => {
    const fetchFn = (url: string | URL | Request): Promise<Response> => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.endsWith("/api/json")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              number: 9,
              result: "FAILURE",
              url: "https://jenkins.example.com/job/foo/9/",
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response("log", { status: 200 }));
    };

    const checks: FailedCiCheck[] = [
      makeCheck({
        checkName: "private-repo-25 build",
        targetUrl: "https://jenkins.example.com/job/foo/9/",
      }),
    ];
    const providers: CiProviderConfig[] = [
      {
        provider: "jenkins",
        jobPath: "foo",
        checkNamePattern: "private-repo-25",
      },
    ];

    const results = await runPrFailureActions({
      readEnv,
      repo: "stSoftwareAU/example",
      prNumber: 42,
      failedChecks: checks,
      providers,
      fetchFn,
    });

    assertEquals(results.length, 1);
    const r = results[0]!;
    assert(r.ok);
    if (r.ok) assertEquals(r.excerpt.buildId, "9");
  },
);

// ---------------------------------------------------------------------------
// The credentials seam (Issue #958)
// ---------------------------------------------------------------------------

Deno.test("runPrFailureActions - the injected lookup reaches the Jenkins fetch (Issue #958)", async () => {
  // A host and user that exist in no real environment, so a dispatcher that
  // dropped `readEnv` on the way to the fetcher fails here rather than
  // passing on whatever the process happens to carry.
  const token = "dispatcher-seam-token-GHI789";
  const requested: string[] = [];
  const auths: string[] = [];

  const results = await runPrFailureActions({
    repo: "stSoftwareAU/example",
    prNumber: 42,
    failedChecks: [makeCheck({
      targetUrl:
        "https://only-injected-958.jenkins.invalid/job/foo/job/Develop/123/",
    })],
    providers: [{
      provider: "jenkins",
      jobPath: "foo/job/Develop",
      checkNamePattern: "Jenkins",
    }],
    readEnv: (name) =>
      ({
        JENKINS_URL: "https://only-injected-958.jenkins.invalid",
        JENKINS_USER: "seam-user-958",
        JENKINS_TOKEN: token,
      })[name],
    fetchFn: (url, init) => {
      const u = String(url);
      requested.push(u);
      auths.push(
        (init?.headers as Record<string, string> | undefined)
          ?.["Authorization"] ?? "",
      );
      if (u.endsWith("api/json")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ number: 123, result: "FAILURE", url: u }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response("BUILD FAILURE\n", { status: 200 }));
    },
  });

  const result = results[0]!;
  assert(result.ok, `expected success, got ${JSON.stringify(result)}`);
  assertEquals(requested, [
    "https://only-injected-958.jenkins.invalid/job/foo/job/Develop/123/api/json",
    "https://only-injected-958.jenkins.invalid/job/foo/job/Develop/123/consoleText",
  ]);
  const expectedAuth = `Basic ${btoa(`seam-user-958:${token}`)}`;
  assertEquals(auths, [expectedAuth, expectedAuth]);
  assert(
    !JSON.stringify(results).includes(token),
    "token leaked into the dispatcher result",
  );
});
