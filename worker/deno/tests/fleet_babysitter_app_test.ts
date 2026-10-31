import { assertEquals, assertRejects } from "@std/assert";
import {
  appConfigPath,
  configureBabysitterLockTrust,
  parseBabysitterAppConfig,
  readBabysitterAppConfig,
  startBabysitterAppAuth,
  writeBabysitterAppConfig,
} from "../lib/fleet_babysitter_app.ts";

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
