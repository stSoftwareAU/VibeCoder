/**
 * Jenkins provider `target_url` fallback behaviour
 * (stSoftwareAU/private-repo-12#585).
 *
 * The job-path-from-URL and view-suffix parsing are covered by
 * `pr_failure_actions_test.ts`. This file covers the two boundaries that
 * decide whether a *wrong* log reaches the fix prompt:
 *
 *   1. a `target_url` that names no job falls back to the configured path;
 *   2. a `target_url` that cannot be parsed fails loudly and fetches nothing.
 */

import { assert, assertStringIncludes } from "@std/assert";
// Imported first on purpose: this module owns the registry and registers the
// Jenkins provider at load time, so it must evaluate ahead of the provider
// module it imports back.
import { getCiLogProvider } from "../lib/ci_log_provider.ts";
import { JENKINS_PROVIDER_ID } from "../lib/ci_provider_jenkins.ts";

const jenkinsCiLogProvider = getCiLogProvider(JENKINS_PROVIDER_ID)!;

const ENV_KEYS = ["JENKINS_URL", "JENKINS_USER", "JENKINS_TOKEN"] as const;

async function withJenkinsEnv<T>(run: () => Promise<T>): Promise<T> {
  const snapshot = ENV_KEYS.map((k) => [k, Deno.env.get(k)] as const);
  Deno.env.set("JENKINS_URL", "https://ci.example.invalid");
  Deno.env.set("JENKINS_USER", "ci-bot");
  Deno.env.set("JENKINS_TOKEN", "test-token");
  try {
    return await run();
  } finally {
    for (const [k, v] of snapshot) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
  }
}

Deno.test("jenkins provider - falls back to the configured job path when the URL has none", async () => {
  const requested: string[] = [];
  const fetchFn = (url: string | URL | Request): Promise<Response> => {
    const href = String(url);
    requested.push(href);
    if (href.endsWith("/api/json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({ number: 6, result: "FAILURE", url: href }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    return Promise.resolve(new Response("BUILD FAILURE", { status: 200 }));
  };

  await withJenkinsEnv(async () => {
    const result = await jenkinsCiLogProvider.fetchLog({
      repo: "stSoftwareAU/private-repo-12",
      checkName: "continuous-integration/jenkins/pr-head",
      // No /job/ segment: build number only.
      targetUrl: "https://ci.example.invalid/6/",
      providerConfig: {
        provider: "jenkins",
        jobPath: "stSoftwareAU/job/private-repo-12/job/Develop",
      },
      fetchFn,
    });
    assert(
      result.ok,
      `expected fetch to succeed, got: ${!result.ok && result.error}`,
    );
  });

  assert(requested.length > 0, "no Jenkins request was made");
  assertStringIncludes(
    requested[0]!,
    "/job/stSoftwareAU/job/private-repo-12/job/Develop/6/",
  );
});

Deno.test("jenkins provider - unparseable target_url fails loudly, never fetches", async () => {
  let called = false;
  const fetchFn = (): Promise<Response> => {
    called = true;
    return Promise.resolve(new Response("", { status: 200 }));
  };

  const result = await withJenkinsEnv(() =>
    jenkinsCiLogProvider.fetchLog({
      repo: "stSoftwareAU/private-repo-12",
      checkName: "continuous-integration/jenkins/pr-head",
      targetUrl: "https://ci.example.invalid/job/Develop/lastBuild/",
      providerConfig: { provider: "jenkins", jobPath: "Develop" },
      fetchFn,
    })
  );

  assert(!result.ok);
  assertStringIncludes(result.error, "could not extract Jenkins build number");
  assert(
    !called,
    "no Jenkins request may be made when the URL cannot be parsed",
  );
});
