import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import {
  accessibleBabysitterRepositories,
  appConfigPath,
  BABYSITTER_AGENT_PERMISSIONS,
  configureBabysitterLockTrust,
  mintBabysitterAgentToken,
  parseBabysitterAppConfig,
  readBabysitterAppConfig,
  startBabysitterAppAuth,
  writeBabysitterAppConfig,
} from "../lib/fleet_babysitter_app.ts";
import type { FetchFn } from "../lib/github_app_auth.ts";
import {
  babysitterVerifierCredentials,
  startBabysitterAgent,
} from "../commands/fleet_pr_babysitter.ts";
import { BabysitterFailure } from "../lib/babysitter_retry_state.ts";
import { runWithTimeout } from "../lib/subprocess_timeout.ts";
import {
  fakeContainer,
  fakeTokenExchange,
  repairDirs,
  type RuntimeSpawn,
  withTestKey,
} from "./fixtures/babysitter_container_fakes_4770.ts";

Deno.test("the non-watch container repair exits non-zero after cleanup despite a pending special-file open", async () => {
  const info = await runWithTimeout(Deno.execPath(), ["info", "--json"], {
    timeoutMs: 10_000,
  });
  assert(info.ok);
  assertEquals(info.value.success, true, info.value.stderr);
  const { denoDir } = JSON.parse(info.value.stdout);
  assertEquals(typeof denoDir, "string");
  // The repair below runs with --cached-only, so cache the babysitter's whole
  // graph first: a shard's cache may hold only what its own tests loaded.
  const entry = new URL("../commands/fleet_pr_babysitter.ts", import.meta.url)
    .pathname;
  const configFile = new URL("../deno.json", import.meta.url).pathname;
  const warm = await runWithTimeout(Deno.execPath(), [
    "cache",
    "--config",
    configFile,
    entry,
  ], { timeoutMs: 120_000, env: { DENO_DIR: denoDir } });
  assert(warm.ok);
  assertEquals(warm.value.success, true, warm.value.stderr);
  await withTestKey(async (privateKeyPath) => {
    const home = await Deno.makeTempDir();
    try {
      await Deno.chmod(privateKeyPath, 0o600);
      await writeBabysitterAppConfig(home, {
        appId: "123",
        installationId: "456",
        privateKeyPath,
      });
      await Deno.mkdir(`${home}/tmp`);
      await Deno.mkdir(`${home}/bin`);
      // A runtime on PATH; the preload answers every call to it.
      await Deno.writeTextFile(`${home}/bin/docker`, "#!/bin/sh\n");
      await Deno.chmod(`${home}/bin/docker`, 0o755);
      for (const provider of ["claude", "gh"]) {
        await Deno.mkdir(`${home}/.vibe-coder/credentials/${provider}`, {
          recursive: true,
        });
      }
      const configPath = `${home}/operator-config.json`;
      await Deno.writeTextFile(
        configPath,
        JSON.stringify({
          repos: ["owner/repo"],
          fleet_pr_authors: ["babysitter[bot]"],
        }),
      );
      const checkout = new URL("../../..", import.meta.url).pathname
        .replace(/\/$/, "");
      const cliArgs = [
        "run",
        "--allow-all",
        "--cached-only",
        "--config",
        configFile,
        "--preload",
        new URL(
          "./fixtures/fleet_babysitter_container_preload.ts",
          import.meta.url,
        ).pathname,
        entry,
        "--repo=owner/repo",
        "--pr=1",
      ];
      const childEnv = {
        HOME: home,
        PATH: `${home}/bin:/usr/bin:/bin`,
        CONFIG_PATH: configPath,
        TMPDIR: `${home}/tmp`,
        VIBE_CREDENTIAL_DIR: `${home}/.vibe-coder/credentials`,
        BABYSITTER_REPAIR_FIXTURE: home,
        BABYSITTER_REAL_CHECKOUT: checkout,
        DENO_DIR: denoDir,
      };
      const fifo = await new Deno.Command("mkfifo", {
        args: [`${home}/blocked-fifo`],
      }).output();
      assert(fifo.success);
      // The in-container agent leaves a FIFO as its PR description, so the
      // runner's read of it never completes.
      const blocked = await runWithTimeout(Deno.execPath(), cliArgs, {
        cwd: home,
        timeoutMs: 25_000,
        clearEnv: true,
        env: { ...childEnv, BABYSITTER_BLOCK_OPEN: "1" },
      });
      assert(blocked.ok, "non-watch pass exits despite a pending open");
      assertEquals(blocked.value.timedOut, false, blocked.value.stderr);
      assertEquals(blocked.value.success, false);
      assertStringIncludes(blocked.value.stderr, "timed out opening");
      // The container ran, so the failure is the pending open and not setup.
      assertStringIncludes(
        await Deno.readTextFile(`${home}/runtime-run.json`),
        "babysitter-repair",
      );
      // Positive control: with the open not blocked, the same pass succeeds
      // and applies the description the container's agent proposed.
      await Deno.remove(`${home}/.local/state/vibe-coder/fleet-pr-babysitter`, {
        recursive: true,
      });
      await Deno.remove(`${home}/runtime-run.json`);
      const completed = await runWithTimeout(Deno.execPath(), cliArgs, {
        cwd: home,
        timeoutMs: 40_000,
        clearEnv: true,
        env: childEnv,
      });
      assert(completed.ok);
      assertEquals(completed.value.success, true, completed.value.stderr);
      assertEquals(
        await Deno.readTextFile(`${home}/applied-body`),
        "Reviewed PR description",
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });
});

Deno.test("agent launch mints a scoped token and hands the container only that token", async () => {
  if (Deno.env.get("BABYSITTER_TOKEN_TEST_CHILD") !== "1") {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--allow-all",
        "--filter",
        "agent launch mints a scoped token",
        new URL(import.meta.url).pathname,
      ],
      clearEnv: true,
      env: {
        ...Deno.env.toObject(),
        GH_TOKEN: "runner-write-token",
        BABYSITTER_TOKEN_TEST_CHILD: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      result.success,
      true,
      new TextDecoder().decode(result.stdout) +
        new TextDecoder().decode(result.stderr),
    );
    return;
  }
  await withTestKey(async (privateKeyPath) => {
    const dirs = await repairDirs();
    try {
      const requests: Array<{ url: string; body: unknown }> = [];
      const spawns: RuntimeSpawn[] = [];
      const started = await startBabysitterAgent(
        { appId: "123", installationId: "456", privateKeyPath },
        "owner/repo",
        {
          ...dirs,
          prompt: "repair",
          fetchFn: fakeTokenExchange(
            { permissions: BABYSITTER_AGENT_PERMISSIONS },
            requests,
          ),
          container: fakeContainer(spawns),
        },
        () => Promise.resolve(true),
      );
      assertEquals(started, true);
      assertEquals(requests[0]!.body, {
        repositories: ["repo"],
        permissions: BABYSITTER_AGENT_PERMISSIONS,
      });
      assertEquals(spawns.length, 1);
      const [spawn] = spawns;
      assertEquals(spawn!.runtime, "podman");
      assertEquals(spawn!.env.GH_TOKEN, "ghs_agent_token");
      assertEquals(Deno.env.get("GH_TOKEN"), "runner-write-token");
      assert(spawn!.env.GH_TOKEN !== Deno.env.get("GH_TOKEN"));
      assert(spawn!.args.includes("babysitter-repair"));
    } finally {
      await Deno.remove(dirs.root, { recursive: true });
    }
  });
});

Deno.test("agent launch does not record an attempt when token minting fails", async () => {
  await withTestKey(async (privateKeyPath) => {
    const dirs = await repairDirs();
    try {
      let guarded = false;
      const spawns: RuntimeSpawn[] = [];
      await assertRejects(() =>
        startBabysitterAgent(
          { appId: "123", installationId: "456", privateKeyPath },
          "owner/repo",
          {
            ...dirs,
            prompt: "repair",
            fetchFn: () =>
              Promise.resolve(new Response("exchange failed", { status: 500 })),
            container: fakeContainer(spawns),
          },
          () => {
            guarded = true;
            return Promise.resolve(true);
          },
        )
      );
      assertEquals(guarded, false);
      assertEquals(spawns.length, 0);
    } finally {
      await Deno.remove(dirs.root, { recursive: true });
    }
  });
});

Deno.test("agent session ends before the read token expires and reports its expiry", async () => {
  await withTestKey(async (privateKeyPath) => {
    const dirs = await repairDirs();
    try {
      const expiry = new Date(Date.now() + 10 * 60_000);
      let observedExpiry: Date | undefined;
      const spawns: RuntimeSpawn[] = [];
      await startBabysitterAgent(
        { appId: "123", installationId: "456", privateKeyPath },
        "owner/repo",
        {
          ...dirs,
          prompt: "repair",
          maxSessionMs: 9 * 60_000,
          onTokenExpiry: (value) => observedExpiry = value,
          fetchFn: fakeTokenExchange({
            permissions: BABYSITTER_AGENT_PERMISSIONS,
            expires_at: expiry.toISOString(),
          }, []),
          container: fakeContainer(spawns),
        },
        () => Promise.resolve(true),
      );
      assertEquals(observedExpiry?.toISOString(), expiry.toISOString());
      const sessionMs = spawns[0]!.timeoutMs;
      assert(sessionMs > 7 * 60_000 && sessionMs < 8 * 60_000);
    } finally {
      await Deno.remove(dirs.root, { recursive: true });
    }
  });
});

Deno.test("agent launch refuses a token that expires too soon for a safe session, before any container", async () => {
  await withTestKey(async (privateKeyPath) => {
    const dirs = await repairDirs();
    try {
      let guarded = false;
      const spawns: RuntimeSpawn[] = [];
      const error = await assertRejects(
        () =>
          startBabysitterAgent(
            { appId: "123", installationId: "456", privateKeyPath },
            "owner/repo",
            {
              ...dirs,
              prompt: "repair",
              fetchFn: fakeTokenExchange({
                permissions: BABYSITTER_AGENT_PERMISSIONS,
                expires_at: new Date(Date.now() + 60_000).toISOString(),
              }, []),
              container: fakeContainer(spawns),
            },
            () => {
              guarded = true;
              return Promise.resolve(true);
            },
          ),
        BabysitterFailure,
        "expires before a safe session can start",
      );
      assertEquals(error.blockerClass, "infrastructure");
      assertEquals(guarded, false);
      assertEquals(spawns.length, 0);
    } finally {
      await Deno.remove(dirs.root, { recursive: true });
    }
  });
});

Deno.test("agent launch does not start a container for an already attempted head", async () => {
  await withTestKey(async (privateKeyPath) => {
    const dirs = await repairDirs();
    try {
      const requests: Array<{ url: string; body: unknown }> = [];
      const spawns: RuntimeSpawn[] = [];
      const started = await startBabysitterAgent(
        { appId: "123", installationId: "456", privateKeyPath },
        "owner/repo",
        {
          ...dirs,
          prompt: "repair",
          fetchFn: fakeTokenExchange(
            { permissions: BABYSITTER_AGENT_PERMISSIONS },
            requests,
          ),
          container: fakeContainer(spawns),
        },
        () => Promise.resolve(false),
      );
      assertEquals(requests.length, 1);
      assertEquals(started, false);
      assertEquals(spawns.length, 0);
      // The prompt is written only once the session is allowed to start.
      await assertRejects(() => Deno.stat(`${dirs.scratch}/prompt.md`));
    } finally {
      await Deno.remove(dirs.root, { recursive: true });
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
        repos: ["TitlePage/private", "stSoftwareAU/repo"],
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
    assertEquals(value.repos, ["TitlePage/private", "stSoftwareAU/repo"]);
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

    assertEquals(token.token, "ghs_agent_token");
    assert(token.expiresAt.getTime() > Date.now());
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

Deno.test("access discovery uses metadata-only credentials and rechecks changed access", async () => {
  await withTestKey(async (privateKeyPath) => {
    const config = { appId: "123", installationId: "456", privateKeyPath };
    const requests: Array<{ url: string; body: unknown }> = [];
    let visible = "stSoftwareAU/one";
    const fetchFn: FetchFn = (url, init) => {
      if (String(url).endsWith("/access_tokens")) {
        return fakeTokenExchange(
          { permissions: { metadata: "read" } },
          requests,
        )(url, init);
      }
      assertEquals(
        new Headers(init?.headers).get("Authorization"),
        "Bearer ghs_agent_token",
      );
      return Promise.resolve(
        Response.json({
          total_count: 1,
          repositories: [{ full_name: visible }],
        }),
      );
    };
    assertEquals([...await accessibleBabysitterRepositories(config, fetchFn)], [
      "stsoftwareau/one",
    ]);
    visible = "stSoftwareAU/two";
    assertEquals([...await accessibleBabysitterRepositories(config, fetchFn)], [
      "stsoftwareau/two",
    ]);
    assertEquals(requests.map((request) => request.body), [
      { permissions: { metadata: "read" } },
      { permissions: { metadata: "read" } },
    ]);
  });
});

Deno.test("review verifier credentials carry the read-only token, never the runner's, and deny Bash and the protected paths (PR #4849 review)", async () => {
  await withTestKey(async (privateKeyPath) => {
    const home = await Deno.makeTempDir();
    try {
      const requests: Array<{ url: string; body: unknown }> = [];
      const credentials = await babysitterVerifierCredentials(
        { appId: "123", installationId: "456", privateKeyPath },
        "owner/repo",
        {
          home,
          configPath: `${home}/.config.json`,
          env: () => undefined,
          parentEnv: {
            GH_TOKEN: "ghs_RUNNER_WRITE_TOKEN",
            GITHUB_TOKEN: "ghs_RUNNER_WRITE_TOKEN",
            GITHUB_APP_PRIVATE_KEY_PATH: privateKeyPath,
            PATH: "/usr/bin",
          },
          fetchFn: fakeTokenExchange(
            { permissions: { ...BABYSITTER_AGENT_PERMISSIONS } },
            requests,
          ),
        },
      );
      assertEquals(credentials.parentEnv.GH_TOKEN, "ghs_agent_token");
      assertEquals(credentials.parentEnv.GITHUB_TOKEN, undefined);
      assertEquals(
        credentials.parentEnv.GITHUB_APP_PRIVATE_KEY_PATH,
        undefined,
      );
      assertEquals(credentials.parentEnv.PATH, "/usr/bin");
      assert(!JSON.stringify(credentials).includes("RUNNER_WRITE_TOKEN"));
      assertEquals(requests[0]!.body, {
        repositories: ["repo"],
        permissions: BABYSITTER_AGENT_PERMISSIONS,
      });
      assert(credentials.disallowedTools.includes("Bash"));
      assert(credentials.disallowedTools.includes(`Read(/${privateKeyPath})`));
      assert(credentials.disallowedTools.includes(`Edit(/${privateKeyPath})`));
      assert(credentials.disallowedTools.includes("Read(//proc/**)"));
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });
});

Deno.test("review verifier credentials fail when GitHub grants a write permission (PR #4849 review)", async () => {
  await withTestKey(async (privateKeyPath) => {
    const home = await Deno.makeTempDir();
    try {
      await assertRejects(
        () =>
          babysitterVerifierCredentials(
            { appId: "123", installationId: "456", privateKeyPath },
            "owner/repo",
            {
              home,
              configPath: `${home}/.config.json`,
              env: () => undefined,
              parentEnv: {},
              fetchFn: fakeTokenExchange({
                permissions: {
                  ...BABYSITTER_AGENT_PERMISSIONS,
                  contents: "write",
                },
              }, []),
            },
          ),
        Error,
        "must be read-only",
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  });
});
