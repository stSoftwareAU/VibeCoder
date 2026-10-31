/**
 * Tests for the `permissions` scope of getInstallationToken (Issue #4572).
 *
 * Kept in their own file so github_app_auth_test.ts stays untouched. These
 * tests pass a plain JWT string and a fake fetch, so no private key is needed.
 *
 * Australian English spelling throughout (behaviour, authorisation, etc.)
 */

import { assertEquals, assertRejects } from "@std/assert";
import { type FetchFn, getInstallationToken } from "../lib/github_app_auth.ts";

/** Record every fetch call's URL and parsed JSON body, answering 201 with a token. */
function recordingTokenFetch(
  response: Record<string, unknown> = {},
): {
  fetchFn: FetchFn;
  calls: Array<{ url: string; body: unknown; contentType: string | undefined }>;
} {
  const calls: Array<
    { url: string; body: unknown; contentType: string | undefined }
  > = [];
  const fetchFn: FetchFn = (url, init) => {
    const headers = init?.headers as Record<string, string> | undefined;
    calls.push({
      url: url.toString(),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      contentType: headers?.["Content-Type"],
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          token: "ghs_scoped",
          expires_at: "2026-04-07T12:00:00Z",
          ...response,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
  return { fetchFn, calls };
}

Deno.test("github_app_auth - getInstallationToken sends permissions and repositories in the body", async () => {
  const { fetchFn, calls } = recordingTokenFetch();

  await getInstallationToken("fake.jwt", "67890", fetchFn, ["owner/repo"], {
    contents: "read",
    pull_requests: "read",
  });

  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.body, {
    repositories: ["repo"],
    permissions: { contents: "read", pull_requests: "read" },
  });
  assertEquals(calls[0]!.contentType, "application/json");
});

Deno.test("github_app_auth - getInstallationToken sends permissions alone when no repositories are named", async () => {
  const { fetchFn, calls } = recordingTokenFetch();

  await getInstallationToken("fake.jwt", "67890", fetchFn, undefined, {
    issues: "read",
  });

  assertEquals(calls[0]!.body, { permissions: { issues: "read" } });
  assertEquals(calls[0]!.contentType, "application/json");
});

Deno.test("github_app_auth - getInstallationToken refuses an empty permission scope before calling GitHub", async () => {
  const { fetchFn, calls } = recordingTokenFetch();

  const error = await assertRejects(
    () => getInstallationToken("fake.jwt", "67890", fetchFn, undefined, {}),
    Error,
  );

  assertEquals(
    error.message,
    "Refusing to mint an installation token for an empty permission scope",
  );
  assertEquals(calls.length, 0, "an empty scope must never reach GitHub");
});

Deno.test("github_app_auth - getInstallationToken keeps the old body when permissions are omitted", async () => {
  const { fetchFn, calls } = recordingTokenFetch();

  await getInstallationToken("fake.jwt", "67890", fetchFn, ["owner/repo"]);
  await getInstallationToken("fake.jwt", "67890", fetchFn);

  assertEquals(calls[0]!.body, { repositories: ["repo"] });
  assertEquals(calls[0]!.contentType, "application/json");
  assertEquals(calls[1]!.body, undefined);
  assertEquals(calls[1]!.contentType, undefined);
});
