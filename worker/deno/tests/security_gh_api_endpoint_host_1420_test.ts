/**
 * SEC-27c19f48454a — a `gh api` endpoint's HOST decides nothing (Issue #1420).
 *
 * `gh api` accepts a fully-qualified URL as well as a path, and Issue #3703
 * taught the classifier to strip the origin so
 * `https://api.github.com/repos/o/r/issues` resolves the same repo as
 * `repos/o/r/issues`. The strip took any scheme and any host, so the origin
 * was discarded without ever being looked at: an absolute URL whose PATH
 * names an allowed repository classified as an allowed on-repo write no
 * matter which host it actually addressed, while `gh` sent the request — and
 * any field or body data with it — to that host.
 *
 * That voids the write-repo allowlist for such a call. The allowlist's whole
 * job is to decide *where* a write may go, and the request never reaches
 * GitHub, so no server-side check stands behind it either.
 *
 * Both directions are asserted here: an endpoint naming a foreign host is
 * undeterminable and refused, and the legitimate absolute, relative and
 * placeholder forms keep classifying exactly as they did.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";
import {
  _resetWriteRepoAllowlistSinks,
  _resetWriteRepoPins,
  _setWriteRepoAllowlistSinks,
  enforceGhWriteAllowlist,
  resetWriteRepoAllowlist,
  seedWriteRepoAllowlist,
  WriteTargetUndeterminableError,
} from "../lib/write_repo_allowlist.ts";
import type { AuditMutation } from "../lib/audit_journal.ts";

const ALLOWED_REPO = "stSoftwareAU/VibeCoder";

/** Install capturing sinks so the tests stay hermetic. */
function captureSinks(): { audits: AuditMutation[]; logs: string[] } {
  const audits: AuditMutation[] = [];
  const logs: string[] = [];
  _setWriteRepoAllowlistSinks({
    record: (m) => {
      audits.push(m);
      return Promise.resolve({ ok: true, value: undefined as never });
    },
    log: (m) => logs.push(m),
  });
  return { audits, logs };
}

function cleanup(): void {
  resetWriteRepoAllowlist();
  _resetWriteRepoPins();
  _resetWriteRepoAllowlistSinks();
}

/** A POST `gh api` call against the given endpoint. */
function apiPost(endpoint: string): string[] {
  return ["api", endpoint, "-X", "POST", "-f", "body=data"];
}

// ---------------------------------------------------------------------------
// The refusal direction — a foreign host is never an allowed target
// ---------------------------------------------------------------------------

Deno.test("SEC-27c19f48454a - an off-GitHub host is undeterminable, not an explicit repo", () => {
  const info = classifyGhMutation(
    apiPost(`https://not-github.example/repos/${ALLOWED_REPO}/issues`),
  );
  assert(info, "a POST gh api call must classify as a mutation");
  assertEquals(
    info.scope,
    "unknown",
    "an endpoint addressed at a non-GitHub host must fail closed",
  );
  assertEquals(
    info.repo,
    undefined,
    "no repo may be derived from a path on a host that is not GitHub's API",
  );
});

Deno.test("SEC-27c19f48454a - the placeholder form on a foreign host is not cwd-scoped", () => {
  // The `repos/{owner}/{repo}/…` form is resolved by `gh` from the current
  // clone, so it classifies as `cwd` and is allowed without an allowlist
  // comparison. On a foreign host that reasoning does not hold: the request
  // goes to that host, not to the run's own repository.
  const info = classifyGhMutation(
    apiPost("https://not-github.example/repos/{owner}/{repo}/issues"),
  );
  assert(info);
  assertEquals(
    info.scope,
    "unknown",
    "a placeholder path on a foreign host must not inherit cwd trust",
  );
});

Deno.test("SEC-27c19f48454a - a userinfo prefix does not make a foreign host GitHub's", () => {
  // `https://api.github.com@elsewhere.example/…` has userinfo
  // `api.github.com` and host `elsewhere.example`. A host check written as a
  // substring or prefix test on the raw URL would be fooled by it.
  const info = classifyGhMutation(
    apiPost(
      `https://api.github.com@elsewhere.example/repos/${ALLOWED_REPO}/issues`,
    ),
  );
  assert(info);
  assertEquals(info.scope, "unknown");
  assertEquals(info.repo, undefined);
});

Deno.test("SEC-27c19f48454a - a host merely ending in the API host is not the API host", () => {
  const info = classifyGhMutation(
    apiPost(
      `https://evil-api.github.com.attacker.example/repos/${ALLOWED_REPO}/issues`,
    ),
  );
  assert(info);
  assertEquals(info.scope, "unknown");
  assertEquals(info.repo, undefined);
});

Deno.test("SEC-27c19f48454a - the allowlist refuses the redirected write", async () => {
  try {
    const { logs } = captureSinks();
    seedWriteRepoAllowlist(ALLOWED_REPO);
    // The path names the run's OWN allowed repository; only the host differs.
    await assertRejects(
      () =>
        enforceGhWriteAllowlist(
          apiPost(`https://not-github.example/repos/${ALLOWED_REPO}/issues`),
        ),
      WriteTargetUndeterminableError,
    );
    assert(
      logs.some((l) => l.includes("WRITE_TARGET_UNDETERMINABLE")),
      `expected a fail-closed security log line, got: ${logs.join(" | ")}`,
    );
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// The permit direction — every legitimate endpoint form still works
// ---------------------------------------------------------------------------

Deno.test("SEC-27c19f48454a - an absolute api.github.com endpoint still resolves its repo (Issue #3703)", () => {
  const info = classifyGhMutation(
    apiPost(`https://api.github.com/repos/${ALLOWED_REPO}/issues`),
  );
  assert(info);
  assertEquals(info.scope, "explicit");
  assertEquals(info.repo, ALLOWED_REPO);
});

Deno.test("SEC-27c19f48454a - the API host is matched case-insensitively", () => {
  const info = classifyGhMutation(
    apiPost(`https://API.GitHub.COM/repos/${ALLOWED_REPO}/issues`),
  );
  assert(info);
  assertEquals(info.scope, "explicit");
  assertEquals(info.repo, ALLOWED_REPO);
});

Deno.test("SEC-27c19f48454a - a relative endpoint is untouched", () => {
  const info = classifyGhMutation(apiPost(`repos/${ALLOWED_REPO}/issues`));
  assert(info);
  assertEquals(info.scope, "explicit");
  assertEquals(info.repo, ALLOWED_REPO);
});

Deno.test("SEC-27c19f48454a - the relative placeholder form stays cwd-scoped", () => {
  const info = classifyGhMutation(apiPost("repos/{owner}/{repo}/issues"));
  assert(info);
  assertEquals(info.scope, "cwd");
  assertEquals(info.repo, undefined);
});

Deno.test("SEC-27c19f48454a - an absolute api.github.com write to the allowed repo is permitted", async () => {
  try {
    captureSinks();
    seedWriteRepoAllowlist(ALLOWED_REPO);
    await enforceGhWriteAllowlist(
      apiPost(`https://api.github.com/repos/${ALLOWED_REPO}/issues`),
    );
  } finally {
    cleanup();
  }
});

Deno.test("SEC-27c19f48454a - an absolute api.github.com write to another repo is still blocked by repo, not host", async () => {
  try {
    const { logs } = captureSinks();
    seedWriteRepoAllowlist(ALLOWED_REPO);
    await assertRejects(
      () =>
        enforceGhWriteAllowlist(
          apiPost("https://api.github.com/repos/other-owner/other-repo/issues"),
        ),
    );
    assert(
      logs.some((l) => l.includes("WRITE_REPO_BLOCKED")),
      `expected the repo-allowlist refusal, got: ${logs.join(" | ")}`,
    );
  } finally {
    cleanup();
  }
});
