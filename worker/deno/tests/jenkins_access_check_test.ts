/**
 * Tests for the Jenkins credentials preflight (Issue #3583).
 *
 * Covers every branch the preflight classifies — missing environment
 * variables, 401, 403, 404, other HTTP errors and connection errors —
 * plus the guarantee that the token never appears in any message or
 * thrown error. No live Jenkins: `fetchFn` and `readEnv` are injected.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildJenkinsUrl,
  checkJenkinsAccess,
  classifyJenkinsFetchError,
  classifyJenkinsHttpStatus,
  type EnvReader,
  formatJenkinsAccessDiagnosis,
  missingJenkinsEnvVars,
} from "../lib/jenkins_access_check.ts";

const TEST_TOKEN = "super-secret-jenkins-token-XYZ123";

const goodEnv: Record<string, string> = {
  JENKINS_URL: "https://jenkins.example.com/",
  JENKINS_USER: "ci-bot",
  JENKINS_TOKEN: TEST_TOKEN,
};

function envReader(values: Record<string, string>): EnvReader {
  return (name) => values[name];
}

function respondWith(status: number): typeof globalThis.fetch {
  return () => Promise.resolve(new Response("body", { status }));
}

Deno.test("missingJenkinsEnvVars - names every unset variable in order", () => {
  const missing = missingJenkinsEnvVars(
    envReader({ JENKINS_USER: "   " }),
  );
  assertEquals(missing, ["JENKINS_URL", "JENKINS_USER", "JENKINS_TOKEN"]);
});

Deno.test("checkJenkinsAccess - missing env vars are reported by name", async () => {
  let fetched = false;
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    readEnv: envReader({ JENKINS_URL: "https://jenkins.example.com" }),
    fetchFn: () => {
      fetched = true;
      return Promise.resolve(new Response("", { status: 200 }));
    },
  });

  assertEquals(diagnosis.ok, false);
  assertEquals(diagnosis.status, "missing-env");
  assertStringIncludes(diagnosis.summary, "JENKINS_USER");
  assertStringIncludes(diagnosis.summary, "JENKINS_TOKEN");
  assertStringIncludes(diagnosis.remediation, "Export");
  assert(!fetched, "no probe request should be made without credentials");
});

Deno.test("checkJenkinsAccess - 2xx is a successful preflight", async () => {
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    readEnv: envReader(goodEnv),
    fetchFn: respondWith(200),
  });

  assertEquals(diagnosis.ok, true);
  assertEquals(diagnosis.status, "ok");
  assertEquals(diagnosis.httpStatus, 200);
});

Deno.test("checkJenkinsAccess - 401 blames the user/token pair", async () => {
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    readEnv: envReader(goodEnv),
    fetchFn: respondWith(401),
  });

  assertEquals(diagnosis.ok, false);
  assertEquals(diagnosis.status, "unauthorised");
  assertEquals(diagnosis.httpStatus, 401);
  assertStringIncludes(diagnosis.summary, "JENKINS_TOKEN");
  assertStringIncludes(diagnosis.remediation, "API Token");
});

Deno.test("checkJenkinsAccess - 403 blames the Job/Read permission", async () => {
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyFolder/job/MyJob",
    readEnv: envReader(goodEnv),
    fetchFn: respondWith(403),
  });

  assertEquals(diagnosis.status, "forbidden");
  assertEquals(diagnosis.httpStatus, 403);
  assertStringIncludes(diagnosis.summary, "Job/Read");
  assertStringIncludes(diagnosis.summary, "MyFolder/job/MyJob");
  assertStringIncludes(diagnosis.remediation, "Job/Read");
});

Deno.test("checkJenkinsAccess - 404 blames the job path", async () => {
  const diagnosis = await checkJenkinsAccess({
    jobPath: "WrongJob",
    readEnv: envReader(goodEnv),
    fetchFn: respondWith(404),
  });

  assertEquals(diagnosis.status, "not-found");
  assertEquals(diagnosis.httpStatus, 404);
  assertStringIncludes(diagnosis.summary, "WrongJob");
  assertStringIncludes(diagnosis.remediation, "job path");
});

Deno.test("checkJenkinsAccess - other non-2xx is a generic HTTP error", async () => {
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    readEnv: envReader(goodEnv),
    fetchFn: respondWith(500),
  });

  assertEquals(diagnosis.status, "http-error");
  assertEquals(diagnosis.httpStatus, 500);
  assertStringIncludes(diagnosis.summary, "500");
});

Deno.test("checkJenkinsAccess - connection failure is a network error", async () => {
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    readEnv: envReader(goodEnv),
    fetchFn: () => Promise.reject(new TypeError("dns error: no such host")),
  });

  assertEquals(diagnosis.ok, false);
  assertEquals(diagnosis.status, "network-error");
  assertEquals(diagnosis.httpStatus, undefined);
  assertStringIncludes(diagnosis.summary, "dns error");
  assertStringIncludes(diagnosis.remediation, "JENKINS_URL");
});

Deno.test("checkJenkinsAccess - probes the job path with basic auth, trimming the base URL", async () => {
  let seenUrl = "";
  let seenAuth = "";
  await checkJenkinsAccess({
    jobPath: "MyJob",
    build: 42,
    readEnv: envReader(goodEnv),
    fetchFn: (url, init) => {
      seenUrl = String(url);
      seenAuth = String(
        (init?.headers as Record<string, string>)["Authorization"],
      );
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });

  assertEquals(
    seenUrl,
    "https://jenkins.example.com/job/MyJob/42/api/json",
  );
  assertEquals(seenAuth, `Basic ${btoa(`ci-bot:${TEST_TOKEN}`)}`);
});

// Jenkins nests folders as /job/<a>/job/<b>/job/<c>, matching the reference
// implementation in stSoftwareAU/private-repo-12 scripts/fetch-jenkins-build.sh.
// A folder path must not collapse to /job/<a>/<b>/<c>, which 404s.
Deno.test("buildJenkinsUrl - expands each folder segment into /job/", () => {
  assertEquals(
    buildJenkinsUrl(
      "https://jenkins.example.com",
      "stSoftwareAU/private-repo-12/Develop",
      42,
      "api/json",
    ),
    "https://jenkins.example.com/job/stSoftwareAU/job/private-repo-12/job/Develop/42/api/json",
  );
});

Deno.test("buildJenkinsUrl - single-segment path is unchanged", () => {
  assertEquals(
    buildJenkinsUrl("https://jenkins.example.com", "MyJob", 42, "api/json"),
    "https://jenkins.example.com/job/MyJob/42/api/json",
  );
});

// Operators may already have written the /job/ separators by hand; both
// spellings must produce the same URL.
Deno.test("buildJenkinsUrl - pre-expanded path is not double-expanded", () => {
  assertEquals(
    buildJenkinsUrl(
      "https://jenkins.example.com",
      "MyFolder/job/MyJob",
      7,
      "consoleText",
    ),
    "https://jenkins.example.com/job/MyFolder/job/MyJob/7/consoleText",
  );
});

Deno.test("checkJenkinsAccess - defaults to lastBuild when no build is given", async () => {
  let seenUrl = "";
  await checkJenkinsAccess({
    jobPath: "MyJob",
    readEnv: envReader(goodEnv),
    fetchFn: (url) => {
      seenUrl = String(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  });

  assertStringIncludes(seenUrl, "/job/MyJob/lastBuild/api/json");
});

Deno.test("checkJenkinsAccess - token never appears in any diagnosis", async () => {
  const statuses = [200, 401, 403, 404, 500];
  for (const status of statuses) {
    const diagnosis = await checkJenkinsAccess({
      jobPath: "MyJob",
      readEnv: envReader(goodEnv),
      fetchFn: respondWith(status),
    });
    const rendered = `${diagnosis.summary} ${diagnosis.remediation} ${
      formatJenkinsAccessDiagnosis(diagnosis)
    } ${JSON.stringify(diagnosis)}`;
    assert(
      !rendered.includes(TEST_TOKEN),
      `token leaked for HTTP ${status}: ${rendered}`,
    );
  }
});

Deno.test("checkJenkinsAccess - token never appears when the fetch throws it back", async () => {
  // Worst case: the transport echoes the whole request (including the
  // auth header) into its exception text.
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    readEnv: envReader(goodEnv),
    fetchFn: (_url, init) =>
      Promise.reject(
        new Error(
          `connection reset ${
            JSON.stringify((init?.headers as Record<string, string>) ?? {})
          }`,
        ),
      ),
  });

  const rendered = `${diagnosis.summary} ${diagnosis.remediation}`;
  assertEquals(diagnosis.status, "network-error");
  assert(
    !rendered.includes(TEST_TOKEN),
    `token leaked in network-error path: ${rendered}`,
  );
  assert(
    !rendered.includes(btoa(`ci-bot:${TEST_TOKEN}`)),
    "encoded credential leaked in network-error path",
  );
});

Deno.test("classifyJenkinsHttpStatus - 2xx range is ok", () => {
  assertEquals(classifyJenkinsHttpStatus(204, "MyJob").ok, true);
  assertEquals(classifyJenkinsHttpStatus(299, "MyJob").status, "ok");
});

Deno.test("classifyJenkinsFetchError - recovers auth classes from fetcher errors", () => {
  const forbidden = classifyJenkinsFetchError(
    "Jenkins log request failed with HTTP 403 Forbidden — denied",
    "MyJob",
  );
  assertEquals(forbidden?.status, "forbidden");

  const unauthorised = classifyJenkinsFetchError(
    "Jenkins status request failed with HTTP 401 Unauthorized",
  );
  assertEquals(unauthorised?.status, "unauthorised");

  const notFound = classifyJenkinsFetchError(
    "Jenkins log request failed with HTTP 404 Not Found",
  );
  assertEquals(notFound?.status, "not-found");
});

Deno.test("classifyJenkinsFetchError - recovers the missing-env class", () => {
  const diagnosis = classifyJenkinsFetchError(
    "Jenkins credentials are not configured: JENKINS_TOKEN is not set",
  );
  assertEquals(diagnosis?.status, "missing-env");
  assertStringIncludes(diagnosis?.summary ?? "", "JENKINS_TOKEN");
});

Deno.test("classifyJenkinsFetchError - unrelated failures stay unclassified", () => {
  assertEquals(
    classifyJenkinsFetchError("Jenkins status response was not valid JSON"),
    undefined,
  );
  assertEquals(
    classifyJenkinsFetchError(
      "Jenkins status request failed with HTTP 500 Server Error",
    ),
    undefined,
  );
  assertEquals(
    classifyJenkinsFetchError("Jenkins request failed (network): timed out"),
    undefined,
  );
});

Deno.test("formatJenkinsAccessDiagnosis - renders status, summary and remediation", () => {
  const rendered = formatJenkinsAccessDiagnosis(
    classifyJenkinsHttpStatus(403, "MyJob"),
  );
  assertStringIncludes(rendered, "forbidden (HTTP 403)");
  assertStringIncludes(rendered, "Job/Read");
  assertStringIncludes(rendered, "**What to do:**");
});

// --- Issue #3710: bounded outbound fetches -------------------------------

Deno.test("checkJenkinsAccess - a hung Jenkins aborts on the timeout", async () => {
  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    readEnv: envReader(goodEnv),
    timeoutMs: 30,
    fetchFn: (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  });

  assertEquals(diagnosis.ok, false);
  assertEquals(diagnosis.status, "network-error");
  assert(!diagnosis.summary.includes(TEST_TOKEN));
  assert(!diagnosis.remediation.includes(TEST_TOKEN));
});

Deno.test("checkJenkinsAccess - an error page body is cancelled, not buffered", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(4096)));
    },
    cancel() {
      cancelled = true;
    },
  });

  const diagnosis = await checkJenkinsAccess({
    jobPath: "MyJob",
    readEnv: envReader(goodEnv),
    fetchFn: () => Promise.resolve(new Response(body, { status: 403 })),
  });

  assertEquals(diagnosis.status, "forbidden");
  assert(cancelled, "the error-page body must be cancelled, never drained");
});
