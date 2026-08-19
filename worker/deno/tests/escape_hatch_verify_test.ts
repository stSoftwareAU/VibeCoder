/**
 * Tests for lib/escape_hatch_verify.ts (Issue #3661, SEC-6287d379587c).
 *
 * `detectEscapeHatch` answers "did the work get handed off?" from model-written
 * prose alone. These tests pin the added evidence step: a follow-up issue the
 * API says does not exist rejects the hand-off, while an inconclusive lookup
 * still accepts it (so a transient API error cannot push the worker back into
 * the retry loop the escape hatch exists to prevent).
 *
 * Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import type { GitHubIssue, Logger } from "../types.ts";
import {
  isDefinitiveNotFound,
  verifyFollowUpIssueExists,
} from "../lib/escape_hatch_verify.ts";

/** A logger recording warn and error calls for assertions. */
function recordingLogger(): {
  logger: Logger;
  warnings: string[];
  errors: string[];
} {
  const warnings: string[] = [];
  const errors: string[] = [];
  const noop = () => {};
  const logger: Logger = {
    info: noop,
    warn: (msg: string) => warnings.push(msg),
    error: (msg: string) => errors.push(msg),
    debug: noop,
    security: noop,
    skipReason: noop,
    timing: noop,
    scanSummary: noop,
    workerSummary: noop,
  };
  return { logger, warnings, errors };
}

/** A client whose `getIssue` either resolves or throws a supplied error. */
function fakeClient(behaviour: { throws?: Error }) {
  const calls: Array<{ repo: string; issueNumber: number }> = [];
  return {
    calls,
    ghClient: {
      getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
        calls.push({ repo, issueNumber });
        if (behaviour.throws) return Promise.reject(behaviour.throws);
        return Promise.resolve({
          number: issueNumber,
          title: "Follow-up",
          body: "",
          labels: [],
          author: "bot",
          assignees: [],
          createdAt: "2026-08-02T00:00:00Z",
          updatedAt: "2026-08-02T00:00:00Z",
        });
      },
    },
  };
}

Deno.test("verifyFollowUpIssueExists - accepts when the issue exists", async () => {
  const { logger } = recordingLogger();
  const { ghClient, calls } = fakeClient({});
  const result = await verifyFollowUpIssueExists({
    issueRef: "#4321",
    currentRepo: "stSoftwareAU/VibeCoder",
    ghClient,
    logger,
  });
  assertEquals(result, { verified: true, reason: "exists" });
  assertEquals(calls, [{
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 4321,
  }]);
});

Deno.test("verifyFollowUpIssueExists - resolves a cross-repo ref against that repo", async () => {
  const { logger } = recordingLogger();
  const { ghClient, calls } = fakeClient({});
  await verifyFollowUpIssueExists({
    issueRef: "example-org/private-repo-13#99",
    currentRepo: "stSoftwareAU/VibeCoder",
    ghClient,
    logger,
  });
  assertEquals(calls, [{
    repo: "example-org/private-repo-13",
    issueNumber: 99,
  }]);
});

Deno.test("verifyFollowUpIssueExists - rejects a hallucinated issue number", async () => {
  const { logger, errors } = recordingLogger();
  const { ghClient } = fakeClient({
    throws: new Error("gh: Not Found (HTTP 404)"),
  });
  const result = await verifyFollowUpIssueExists({
    issueRef: "#999999",
    currentRepo: "stSoftwareAU/VibeCoder",
    ghClient,
    logger,
  });
  assertEquals(result.verified, false);
  assertEquals(result.reason, "not-found");
  assertEquals(errors.length, 1, "the rejection must be logged loudly");
});

Deno.test("verifyFollowUpIssueExists - a transient API error still accepts", async () => {
  const { logger, warnings, errors } = recordingLogger();
  const { ghClient } = fakeClient({
    throws: new Error("dial tcp: i/o timeout"),
  });
  const result = await verifyFollowUpIssueExists({
    issueRef: "#4321",
    currentRepo: "stSoftwareAU/VibeCoder",
    ghClient,
    logger,
  });
  assertEquals(result.verified, true);
  assertEquals(result.reason, "lookup-failed");
  assertEquals(errors.length, 0);
  assertEquals(warnings.length, 1);
});

Deno.test("verifyFollowUpIssueExists - an unparseable ref is not treated as absent", async () => {
  const { logger, warnings } = recordingLogger();
  const { ghClient, calls } = fakeClient({});
  const result = await verifyFollowUpIssueExists({
    issueRef: "not-a-ref",
    currentRepo: "stSoftwareAU/VibeCoder",
    ghClient,
    logger,
  });
  assertEquals(result, { verified: true, reason: "unparseable-ref" });
  assertEquals(calls.length, 0);
  assertEquals(warnings.length, 1);
});

Deno.test("verifyFollowUpIssueExists - no ref at all is not a hand-off", async () => {
  const { logger } = recordingLogger();
  const { ghClient, calls } = fakeClient({});
  const result = await verifyFollowUpIssueExists({
    issueRef: undefined,
    currentRepo: "stSoftwareAU/VibeCoder",
    ghClient,
    logger,
  });
  assertEquals(result, { verified: false, reason: "no-ref" });
  assertEquals(calls.length, 0);
});

Deno.test("isDefinitiveNotFound - distinguishes 404 from an inconclusive failure", () => {
  assert(isDefinitiveNotFound("gh: Not Found (HTTP 404)"));
  assert(isDefinitiveNotFound("HTTP 404"));
  assertEquals(isDefinitiveNotFound("HTTP 502 Bad Gateway"), false);
  assertEquals(isDefinitiveNotFound("API rate limit exceeded"), false);
  assertEquals(isDefinitiveNotFound("dial tcp: i/o timeout"), false);
});
