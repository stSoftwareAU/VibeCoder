/**
 * Tests for collaborator_permissions.ts (Issue #250).
 *
 * Fetches write/maintain/admin collaborators from GitHub and fails loud
 * on every error mode — never an empty or partial success. Tests inject
 * the `gh` runner via `_setGhSpawnRunner` so every invocation is asserted
 * to go through `spawnGh` (no network, no `Deno.Command`).
 *
 * Australian English throughout (authorised, behaviour, normalise).
 */

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import {
  _resetGhSpawnRunner,
  _setGhSpawnRunner,
  type GhSpawnResult,
} from "../lib/gh_spawn.ts";
import {
  type CollaboratorFetchResult,
  type CollaboratorSet,
  fetchRepoCollaborators,
  GITHUB_PUSH_MEANS_WRITE,
} from "../lib/collaborator_permissions.ts";

const REPO = "owner/repo";
const COLLABORATORS_PATH =
  `repos/${REPO}/collaborators?affiliation=all&per_page=100`;

/** GitHub REST collaborator entry. The deprecated `permission` string is
 *  optional and must never drive the role — only `permissions.*`. */
function rawCollaborator(
  login: string,
  permissions: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    triage?: boolean;
    pull?: boolean;
  },
  deprecatedPermission?: string,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    login,
    permissions: {
      admin: permissions.admin ?? false,
      maintain: permissions.maintain ?? false,
      push: permissions.push ?? false,
      triage: permissions.triage ?? false,
      pull: permissions.pull ?? false,
    },
  };
  if (deprecatedPermission !== undefined) {
    entry.permission = deprecatedPermission;
  }
  return entry;
}

function okResult(
  code = 0,
  stdout = "",
  stderr = "",
): GhSpawnResult {
  return { code, success: code === 0, stdout, stderr };
}

function installRunner(
  handler: (
    args: readonly string[],
  ) => GhSpawnResult | Promise<GhSpawnResult>,
): { calls: string[][] } {
  const calls: string[][] = [];
  _setGhSpawnRunner((args) => {
    calls.push([...args]);
    return Promise.resolve(handler(args));
  });
  return { calls };
}

function restore(): void {
  _resetGhSpawnRunner();
}

function assertError(
  result: CollaboratorFetchResult,
  reason: Extract<CollaboratorFetchResult, { ok: false }>["reason"],
): Extract<CollaboratorFetchResult, { ok: false }> {
  assertEquals(result.ok, false, `expected error ${reason}, got success`);
  if (result.ok) {
    throw new Error("unreachable");
  }
  assertEquals(result.reason, reason);
  return result;
}

function assertSuccess(
  result: CollaboratorFetchResult,
): CollaboratorSet {
  assertEquals(
    result.ok,
    true,
    `expected success, got ${JSON.stringify(result)}`,
  );
  if (!result.ok) {
    throw new Error("unreachable");
  }
  return result.value;
}

function assertSpawnedCollaboratorsQuery(calls: string[][]): void {
  assertEquals(calls.length, 1, "exactly one paginated call chain per repo");
  const args = calls[0] ?? [];
  assertEquals(args[0], "api");
  assert(
    args.includes("--paginate"),
    `expected --paginate in ${JSON.stringify(args)}`,
  );
  assert(
    args.includes(COLLABORATORS_PATH),
    `expected ${COLLABORATORS_PATH} in ${JSON.stringify(args)}`,
  );
}

Deno.test("fetchRepoCollaborators - keeps admin, maintain and write; drops triage and pull", async () => {
  const payload = [
    rawCollaborator("AdminUser", { admin: true, maintain: true, push: true }),
    rawCollaborator("Maintainer", { maintain: true, push: true }),
    rawCollaborator("Writer", { push: true, triage: true, pull: true }),
    rawCollaborator("TriageOnly", { triage: true, pull: true }),
    rawCollaborator("PullOnly", { pull: true }),
  ];
  const { calls } = installRunner(() => okResult(0, JSON.stringify(payload)));
  try {
    const set = assertSuccess(await fetchRepoCollaborators(REPO, {}));
    assertEquals(set.repo, REPO);
    assertEquals(set.collaborators, [
      { login: "adminuser", permission: "admin" },
      { login: "maintainer", permission: "maintain" },
      { login: "writer", permission: "write" },
    ]);
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - maps GitHub's push permission to the write role by name", async () => {
  assertEquals(GITHUB_PUSH_MEANS_WRITE, "write");

  const payload = [
    rawCollaborator("pusher", {
      admin: false,
      maintain: false,
      push: true,
      triage: true,
      pull: true,
    }, "admin"),
  ];
  const { calls } = installRunner(() => okResult(0, JSON.stringify(payload)));
  try {
    const set = assertSuccess(await fetchRepoCollaborators(REPO, {}));
    assertEquals(set.collaborators, [{
      login: "pusher",
      permission: GITHUB_PUSH_MEANS_WRITE,
    }]);
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - ignores the deprecated permission string when push is false", async () => {
  const payload = [
    rawCollaborator("lurker", {
      admin: false,
      maintain: false,
      push: false,
      triage: false,
      pull: true,
    }, "write"),
  ];
  const { calls } = installRunner(() => okResult(0, JSON.stringify(payload)));
  try {
    const result = await fetchRepoCollaborators(REPO, {});
    assertError(result, "empty-list");
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - concatenates two paginated JSON pages", async () => {
  const page1 = [
    rawCollaborator("alice", { admin: true, maintain: true, push: true }),
  ];
  const page2 = [
    rawCollaborator("bob", { push: true, triage: true, pull: true }),
  ];
  const concatenated = `${JSON.stringify(page1)}\n${JSON.stringify(page2)}`;
  const { calls } = installRunner(() => okResult(0, concatenated));
  try {
    const set = assertSuccess(await fetchRepoCollaborators(REPO, {}));
    assertEquals(set.collaborators.map((c) => c.login), ["alice", "bob"]);
    assertEquals(set.collaborators.map((c) => c.permission), [
      "admin",
      "write",
    ]);
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - non-zero gh exit is an error, not an empty set", async () => {
  const { calls } = installRunner(() =>
    okResult(1, "", "connection reset by peer")
  );
  try {
    const result = await fetchRepoCollaborators(REPO, {});
    const failure = assertError(result, "gh-failed");
    assert(
      failure.detail.includes("connection reset"),
      `detail should carry stderr: ${failure.detail}`,
    );
    assertNotEquals(result, {
      ok: true,
      value: { repo: REPO, collaborators: [] },
    });
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - malformed JSON is an error, not an empty set", async () => {
  const { calls } = installRunner(() => okResult(0, "{not-json"));
  try {
    const result = await fetchRepoCollaborators(REPO, {});
    assertError(result, "malformed-json");
    assertNotEquals(result.ok, true);
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - HTTP 403 is an error, never 'no collaborators'", async () => {
  const { calls } = installRunner(() =>
    okResult(
      1,
      "",
      "HTTP 403: Must have push access to view repository collaborators.",
    )
  );
  try {
    const result = await fetchRepoCollaborators(REPO, {});
    assertError(result, "http-403");
    // Regression: swallowing 403 into an empty authorised set must fail.
    assertNotEquals<CollaboratorFetchResult>(result, {
      ok: true,
      value: { repo: REPO, collaborators: [] },
    });
    if (result.ok) {
      throw new Error("403 must not become a successful empty set");
    }
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - HTTP 404 is an error, never an empty set", async () => {
  const { calls } = installRunner(() =>
    okResult(1, "", "gh: Not Found (HTTP 404)")
  );
  try {
    const result = await fetchRepoCollaborators(REPO, {});
    assertError(result, "http-404");
    assertNotEquals<CollaboratorFetchResult>(result, {
      ok: true,
      value: { repo: REPO, collaborators: [] },
    });
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - a legitimate empty list is still an error", async () => {
  const { calls } = installRunner(() => okResult(0, "[]"));
  try {
    const result = await fetchRepoCollaborators(REPO, {});
    assertError(result, "empty-list");
    assertEquals(result.ok, false);
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - blank gh stdout is an empty-list error", async () => {
  const { calls } = installRunner(() => okResult(0, ""));
  try {
    assertError(await fetchRepoCollaborators(REPO, {}), "empty-list");
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - an invalid login fails the fetch, not a skip", async () => {
  const payload = [
    rawCollaborator("good-user", { push: true }),
    rawCollaborator("bad login!", { admin: true }),
  ];
  const { calls } = installRunner(() => okResult(0, JSON.stringify(payload)));
  try {
    const result = await fetchRepoCollaborators(REPO, {});
    const failure = assertError(result, "invalid-login");
    assert(
      failure.detail.includes("bad login!"),
      `detail should name the bad login: ${failure.detail}`,
    );
    assertEquals(result.ok, false);
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - accepts a [bot] login that matches the username pattern", async () => {
  const payload = [
    rawCollaborator("dependabot[bot]", { push: true, pull: true }),
  ];
  const { calls } = installRunner(() => okResult(0, JSON.stringify(payload)));
  try {
    const set = assertSuccess(await fetchRepoCollaborators(REPO, {}));
    assertEquals(set.collaborators, [{
      login: "dependabot[bot]",
      permission: "write",
    }]);
    assertSpawnedCollaboratorsQuery(calls);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - rejects an untrusted repo slug before spawning gh", async () => {
  const { calls } = installRunner(() => {
    throw new Error("gh must not run for an invalid slug");
  });
  try {
    const result = await fetchRepoCollaborators("owner/../etc", {});
    const failure = assertError(result, "invalid-repo-slug");
    assert(
      failure.detail.includes("owner/../etc"),
      `detail should name the slug: ${failure.detail}`,
    );
    assertEquals(calls, []);
  } finally {
    restore();
  }
});

Deno.test("fetchRepoCollaborators - rejects a slug that is not owner/repo", async () => {
  const { calls } = installRunner(() => okResult(0, "[]"));
  try {
    assertError(
      await fetchRepoCollaborators("not-a-slug", {}),
      "invalid-repo-slug",
    );
    assertEquals(calls, []);
  } finally {
    restore();
  }
});
