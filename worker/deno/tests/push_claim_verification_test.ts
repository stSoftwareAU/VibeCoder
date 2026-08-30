/**
 * Tests for push_claim_verification.ts (Issue #579).
 *
 * The incident: PR #549's agent posted "fixed and pushed" at 00:40:26Z when
 * the branch's last commit was 21:23:04Z and nothing had been pushed. Git
 * auth had failed silently. The work was later destroyed by a workspace
 * reset, and it took a human comparing the comment against `git log` to
 * notice.
 *
 * Every case below is a way of being wrong about "did it land?". The module
 * has one job: never answer yes without evidence from the remote.
 *
 * Australian English spelling throughout (behaviour, recognise).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  formatVerifiedPushSuffix,
  type PushVerificationDeps,
  verifyPushLanded,
} from "../lib/push_claim_verification.ts";
import type { RemoteBranchHead } from "../lib/git_remote_head.ts";
import type { Result } from "../types.ts";

const LOCAL = "1".repeat(40);
const OTHER = "2".repeat(40);

function deps(
  local: Result<string>,
  remote: Result<RemoteBranchHead>,
): PushVerificationDeps {
  return {
    captureBranchHead: () => Promise.resolve(local),
    resolveRemoteBranchHead: () => Promise.resolve(remote),
  };
}

const okLocal: Result<string> = { ok: true, value: LOCAL };

Deno.test("verifyPushLanded - landed when the remote head equals the local head", async () => {
  const result = await verifyPushLanded(
    "fix/x",
    {},
    deps(okLocal, {
      ok: true,
      value: { sha: LOCAL, source: "ls-remote" },
    }),
  );

  assert(result.landed);
  assertEquals(result.remoteSha, LOCAL);
});

Deno.test("verifyPushLanded - an unreachable remote is never a success", async () => {
  // The incident's exact condition: git auth broken, so the remote cannot be
  // consulted. Claiming success here is the bug this module exists to stop.
  const result = await verifyPushLanded(
    "fix/x",
    {},
    deps(okLocal, {
      ok: false,
      error: new Error("could not read Username for 'https://github.com'"),
    }),
  );

  assertEquals(result.landed, false);
  assertStringIncludes(result.reason, "could not reach the remote");
  // The cause survives into the reason, so the next reader is not left with
  // "please check the branch status".
  assertStringIncludes(result.reason, "could not read Username");
});

Deno.test("verifyPushLanded - a branch absent from the remote has not landed", async () => {
  const result = await verifyPushLanded(
    "fix/x",
    {},
    deps(okLocal, {
      ok: true,
      value: { sha: null, source: "absent" },
    }),
  );

  assertEquals(result.landed, false);
  assertStringIncludes(result.reason, "does not exist on the remote");
});

Deno.test("verifyPushLanded - a remote behind the local head has not landed", async () => {
  // The PR #549 shape exactly: commits exist locally, the remote is at an
  // older SHA, and nothing about the local state says so.
  const result = await verifyPushLanded(
    "fix/x",
    {},
    deps(okLocal, {
      ok: true,
      value: { sha: OTHER, source: "tracking-ref" },
    }),
  );

  assertEquals(result.landed, false);
  assertEquals(result.remoteSha, OTHER);
  assertStringIncludes(result.reason, "the push did not land");
});

Deno.test("verifyPushLanded - an unreadable local head is not a success either", async () => {
  const result = await verifyPushLanded(
    "fix/x",
    {},
    deps({
      ok: false,
      error: new Error("not a git repository"),
    }, { ok: true, value: { sha: LOCAL, source: "ls-remote" } }),
  );

  assertEquals(result.landed, false);
  assertStringIncludes(result.reason, "could not read the local head");
});

Deno.test("formatVerifiedPushSuffix - a verified claim carries the SHA", () => {
  const suffix = formatVerifiedPushSuffix({
    landed: true,
    localSha: LOCAL,
    remoteSha: LOCAL,
    reason: "ok",
  });
  // Falsifiable at a glance — the point of the issue's third ask.
  assertStringIncludes(suffix, LOCAL.slice(0, 8));
});

Deno.test("formatVerifiedPushSuffix - an unverified claim carries nothing", () => {
  // A suffix on an unverified claim would be worse than none: it would look
  // like evidence.
  assertEquals(
    formatVerifiedPushSuffix({ landed: false, reason: "no remote" }),
    "",
  );
});
