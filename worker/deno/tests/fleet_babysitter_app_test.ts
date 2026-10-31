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
import { startBabysitterAgent } from "../commands/fleet_pr_babysitter.ts";

Deno.test("agent launch mints a scoped token and passes it to Codex", async () => {
  await withTestKey(async (privateKeyPath) => {
    const previous = Deno.env.get("GH_TOKEN");
    Deno.env.set("GH_TOKEN", "runner-write-token");
    const requests: Array<{ url: string; body: unknown }> = [];
    let env: Record<string, string> | undefined;
    try {
      await startBabysitterAgent(
        { appId: "123", installationId: "456", privateKeyPath },
        "owner/repo",
        { dir: "/clone", scratch: "/scratch", prompt: "repair" },
        () => Promise.resolve(true),
        fakeTokenExchange(
          { permissions: BABYSITTER_AGENT_PERMISSIONS },
          requests,
        ),
        (_executable, options) => {
          env = options.env as Record<string, string>;
          return {} as Deno.ChildProcess;
        },
      );
      assertEquals(requests[0]!.body, {
        repositories: ["repo"],
        permissions: BABYSITTER_AGENT_PERMISSIONS,
      });
      assertEquals(env?.GH_TOKEN, "ghs_agent_token");
      assertEquals(env?.GH_TOKEN === Deno.env.get("GH_TOKEN"), false);
    } finally {
      if (previous === undefined) Deno.env.delete("GH_TOKEN");
      else Deno.env.set("GH_TOKEN", previous);
    }
  });
});

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

/**
 * Generate a fresh 2048-bit RSA key at test time, as a PKCS#8 PEM string.
 *
 * Generated per call rather than committed, so no key material lives in source.
 * The PEM header and footer are concatenated so no literal PEM block appears.
 */
async function generateTestKeyPem(): Promise<string> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const der = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  const lines = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!;
  const header = "-----BEGIN " + "PRIVATE KEY-----";
  const footer = "-----END " + "PRIVATE KEY-----";
  return [header, ...lines, footer].join("\n") + "\n";
}

/** Run `run` with a generated test key written to a temp file, removed afterwards. */
async function withTestKey(
  run: (privateKeyPath: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    const privateKeyPath = `${dir}/app-key.pem`;
    await Deno.writeTextFile(privateKeyPath, await generateTestKeyPem());
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
