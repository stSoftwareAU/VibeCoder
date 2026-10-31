import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  appConfigPath,
  BABYSITTER_AGENT_PERMISSIONS,
  babysitterAgentEnv,
  configureBabysitterLockTrust,
  mintBabysitterAgentToken,
  parseBabysitterAppConfig,
  readBabysitterAppConfig,
  startBabysitterAppAuth,
  writeBabysitterAppConfig,
} from "../lib/fleet_babysitter_app.ts";
import type { FetchFn } from "../lib/github_app_auth.ts";

Deno.test("setup adds bot lock trust without losing existing fleet identities", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/config.json`;
  try {
    await Deno.writeTextFile(
      path,
      JSON.stringify({
        service_accounts: ["worker"],
        fleet_pr_authors: ["author"],
        untouched: true,
      }),
    );
    assertEquals(
      await configureBabysitterLockTrust(path, "fleet-pr-babysitter[bot]"),
      true,
    );
    const value = JSON.parse(await Deno.readTextFile(path));
    assertEquals(value.service_accounts, [
      "worker",
      "fleet-pr-babysitter[bot]",
    ]);
    assertEquals(value.fleet_pr_authors, [
      "author",
      "fleet-pr-babysitter[bot]",
    ]);
    assertEquals(value.untouched, true);
    assertEquals(
      await configureBabysitterLockTrust(path, "FLEET-PR-BABYSITTER[BOT]"),
      false,
    );
    await Deno.writeTextFile(path, "{}\n");
    await configureBabysitterLockTrust(path, "bot[bot]");
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      fleet_pr_authors: ["bot[bot]"],
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("App settings round-trip without storing a token", async () => {
  const home = await Deno.makeTempDir();
  const config = {
    appId: "123",
    installationId: "456",
    privateKeyPath: "/tmp/key.pem",
  };
  try {
    await writeBabysitterAppConfig(home, config);
    assertEquals(await readBabysitterAppConfig(home), config);
    assertEquals((await Deno.stat(appConfigPath(home))).mode! & 0o077, 0);
    assertEquals(parseBabysitterAppConfig(config), config);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("App authentication replaces ambient user tokens and fails closed", async () => {
  const values = new Map([["GH_TOKEN", "ambient-user-token"], [
    "GITHUB_TOKEN",
    "ambient-alternative",
  ]]);
  const env = {
    set: (key: string, value: string) => {
      values.set(key, value);
    },
    delete: (key: string) => {
      values.delete(key);
    },
  };
  const config = {
    appId: "123",
    installationId: "456",
    privateKeyPath: "/tmp/key.pem",
  };
  {
    const stop = await startBabysitterAppAuth(
      config,
      () => Promise.resolve("app-token"),
      undefined,
      undefined,
      env,
    );
    try {
      assertEquals(values.get("GH_TOKEN"), "app-token");
      assertEquals(values.get("GITHUB_TOKEN"), undefined);
    } finally {
      stop();
    }
    await assertRejects(
      () =>
        startBabysitterAppAuth(
          config,
          () => Promise.reject(new Error("mint failed")),
          undefined,
          undefined,
          env,
        ),
      Error,
      "mint failed",
    );
    assertEquals(values.get("GH_TOKEN"), "babysitter-app-auth-unavailable");
  }
});

Deno.test("App token refresh recovers after a transient failure", async () => {
  const values = new Map<string, string>();
  const env = {
    set: (key: string, value: string) => {
      values.set(key, value);
    },
    delete: (key: string) => {
      values.delete(key);
    },
  };
  const config = {
    appId: "123",
    installationId: "456",
    privateKeyPath: "/tmp/key.pem",
  };
  let calls = 0;
  let release!: (token: string) => void;
  const resumed = new Promise<string>((resolve) => {
    release = resolve;
  });
  let sawFailure!: () => void;
  const failed = new Promise<void>((resolve) => {
    sawFailure = resolve;
  });
  {
    const stop = await startBabysitterAppAuth(
      config,
      () => {
        calls++;
        if (calls === 2) {
          sawFailure();
          return Promise.reject(new Error("temporary outage"));
        }
        return calls === 1 ? Promise.resolve("first-app-token") : resumed;
      },
      20,
      undefined,
      env,
    );
    try {
      await failed;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(values.get("GH_TOKEN"), "babysitter-app-auth-unavailable");
      release("renewed-app-token");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assertEquals(values.get("GH_TOKEN"), "renewed-app-token");
    } finally {
      stop();
    }
  }
});

// =============================================================================
// Read-only agent token (Issue #4572) — the Codex session never inherits the
// runner's write token; it gets its own single-repo, read-only installation token.
// =============================================================================

// Test RSA key (2048-bit, generated for testing only — not a real secret).
// Same key as tests/github_app_auth_test.ts; copied because that module's
// constants are not exported.
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDGqkt46j7Fr/zi
UWl7LQB7z8vPqGA+2V9LKsqW0uGDbTJsm5GEWaaFKaLAhaTIY0GEIINMIGIhgO4N
HMAiHRZ7+yw6sEP/bm1LY3Owg8yH7u7YhrpJ3WSocNqBQ32gQsxgt1V5XwHH2KfN
DqZyCnew+9P0c8kjTTdaXLd4ZGKUw+g+6efPi2zyqO1igu9mSuJOn4mNoP9LEvRi
pe/QHF07uOxW8lAbc5Qby+lPJs/sEqXZDVu6VQIoRKKacYjlRZ1Vi0vVW4HQKJVD
5ZdIpMSi55tfL6MHvfH70cLxCZUxBO5rJjfQQ/XVi0RD+cyv3S52i8MjDkemA4LD
dBtN+AXXAgMBAAECggEADQ7NN/AqZ0ZlmF9b6Ya2gDmf3p3lXy9c17OP7h3qSLMs
T0svMCqcV8BToqFy7uDnQehixbKTM9SMaqKeVlLguXSm6yybkfYPvpbI2EWxc3XW
9eoISinNH4bBz4em6DO7yNedowUFnvC0oGiU51LQAmGeN6d5a8j75gQvr8my8q6L
Rwu8vbgzwMnesf/QN1dIrNfIBkAneaIolhc0EfGQpY7oxcVhsUSeMF3yTkAZncFw
Bgw2bfAO1/BfCK4IWLBqlsJX0lPP5JUiRdPpVKPlNvfkZQA22yZADBEiAf2deV+o
a/31N9XZUtrlkjtI1E9gYzO5pC5+C5mieDKEgK7xsQKBgQDteS7h2wbZh3funMfB
smENdu/NC4MsKfVp6ZT/9oNpOxcdIUQZy21fMw3MK3749CnQiVWRte9fxiVAOa43
B0TWYNLUfDyeNj+miajDwEReCUcBAARi/S367fHN4CiXkfEOQ77atsRy/ObXloZR
4pmDq84w2TY5TjR2kxgM/GIQQwKBgQDWKgkOMFHOewvAYPqvMPWxUdjbmZ3IFojt
8ZQf64T5MHa9IFkRtnZ9czraTf48IGbchWeaD2wHsxCu1l7kyE0s8GLgYVf//DeX
MIoiltQPVFyIxmXnbvsIuL+rqajln9GQZWb1fXF23vPYUjYJmaSpqf/2wRN47k3d
5CK5VX5U3QKBgGvzirxhNNvuGTb/Tk9fJ39XcetkMF0DNezPokw5Y8OSeQ9k7/BJ
6Y49RyhpHW9OjzOdOqjia8695HEtx2R8iW5q1WyCjYveXVD3gyB5ZprY3M43k8bs
ENrhD+rm240LaulxInGKZANhtA6M/sJ6oA6bK0BJfbzPMEo209gTYwDBAoGBAL76
mTyn5iulGmOhl6rmlBJeFG4v3L3zKoRVa2vTkK7OgvRAhmz/M0bHnPHTnyVrF48K
/8ooeoObMQNYcyK9Y+TxMJs680h5V/Fg/a2+prhM2H+3vGPXWdD7PyELmGu8Sxri
8h90j9wbEYQUO8/vzSDnUjRvFLhAefunVzfCf3eZAoGAcEtTt0UfyrQLQVNRu4d9
TkNx4bMoIg7iIRD2Hw7nllhL8WVS4G622MinPoe4O3haL2EF0cyv84wnTF7Xb1ns
I6FIlFPYaHl3OQczlTCpqnGDWJXSoFYHAcvQbg8NOF4fX1vjqBUlQSpxs3ImdjOi
EueUFZ2YucK5tRacK+eBAvU=
-----END PRIVATE KEY-----`;

/** Run `run` with the test key written to a temp file, removed afterwards. */
async function withTestKey(
  run: (privateKeyPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const privateKeyPath = `${dir}/app-key.pem`;
    await Deno.writeTextFile(privateKeyPath, TEST_PRIVATE_KEY_PEM);
    await run(privateKeyPath);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/**
 * Fake GitHub token exchange: records each request, answers 201 with a token
 * and the given extra response fields (e.g. the granted `permissions`).
 */
function fakeTokenExchange(
  response: Record<string, unknown>,
  requests: Array<{ url: string; body: unknown }>,
): FetchFn {
  return (url, init) => {
    requests.push({
      url: url.toString(),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Promise.resolve(
      new Response(
        JSON.stringify({
          token: "ghs_agent_token",
          expires_at: "2026-04-07T12:00:00Z",
          ...response,
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
    );
  };
}

Deno.test("babysitter agent token - scope is frozen read-only permissions", () => {
  assertEquals(Object.isFrozen(BABYSITTER_AGENT_PERMISSIONS), true);
  assertEquals(BABYSITTER_AGENT_PERMISSIONS, {
    contents: "read",
    pull_requests: "read",
    issues: "read",
    checks: "read",
    actions: "read",
  });
});

Deno.test("babysitter agent token - mint requests one bare repository and the read-only scope", async () => {
  await withTestKey(async (privateKeyPath) => {
    const requests: Array<{ url: string; body: unknown }> = [];
    // Positive control: GitHub grants exactly the read-only scope requested.
    const token = await mintBabysitterAgentToken(
      { appId: "123", installationId: "456", privateKeyPath },
      "owner/repo",
      fakeTokenExchange(
        { permissions: { ...BABYSITTER_AGENT_PERMISSIONS } },
        requests,
      ),
    );

    assertEquals(token, "ghs_agent_token");
    assertEquals(requests.length, 1);
    assertStringIncludes(
      requests[0]!.url,
      "/app/installations/456/access_tokens",
    );
    assertEquals(requests[0]!.body, {
      repositories: ["repo"],
      permissions: BABYSITTER_AGENT_PERMISSIONS,
    });
  });
});

Deno.test("babysitter agent token - rejects a token GitHub grants a write permission", async () => {
  await withTestKey(async (privateKeyPath) => {
    const error = await assertRejects(
      () =>
        mintBabysitterAgentToken(
          { appId: "123", installationId: "456", privateKeyPath },
          "owner/repo",
          fakeTokenExchange({
            permissions: { ...BABYSITTER_AGENT_PERMISSIONS, contents: "write" },
          }, []),
        ),
      Error,
    );

    assertStringIncludes(error.message, "contents");
    assertStringIncludes(error.message, "write");
  });
});

Deno.test("babysitter agent token - rejects when GitHub reports no permissions", async () => {
  await withTestKey(async (privateKeyPath) => {
    const error = await assertRejects(
      () =>
        mintBabysitterAgentToken(
          { appId: "123", installationId: "456", privateKeyPath },
          "owner/repo",
          fakeTokenExchange({}, []),
        ),
      Error,
    );

    assertStringIncludes(error.message, "read-only");
  });
});

Deno.test("babysitter agent env - gives the agent its token and scratch directories only", () => {
  assertEquals(babysitterAgentEnv("/scratch/agent", "ghs_agent_token"), {
    TMPDIR: "/scratch/agent",
    XDG_CACHE_HOME: "/scratch/agent",
    GH_TOKEN: "ghs_agent_token",
  });
});

Deno.test("babysitter agent env - rejects an empty token", () => {
  assertThrows(() => babysitterAgentEnv("/scratch/agent", ""), Error, "token");
});
