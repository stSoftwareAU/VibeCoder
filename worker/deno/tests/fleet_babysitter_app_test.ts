import { assertEquals, assertRejects } from "@std/assert";
import {
  appConfigPath,
  parseBabysitterAppConfig,
  readBabysitterAppConfig,
  startBabysitterAppAuth,
  writeBabysitterAppConfig,
} from "../lib/fleet_babysitter_app.ts";

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
  const names = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY_PATH",
  ];
  const old = new Map(names.map((name) => [name, Deno.env.get(name)]));
  const config = {
    appId: "123",
    installationId: "456",
    privateKeyPath: "/tmp/key.pem",
  };
  try {
    Deno.env.set("GH_TOKEN", "ambient-user-token");
    Deno.env.set("GITHUB_TOKEN", "ambient-alternative");
    const stop = await startBabysitterAppAuth(
      config,
      () => Promise.resolve("app-token"),
    );
    try {
      assertEquals(Deno.env.get("GH_TOKEN"), "app-token");
      assertEquals(Deno.env.get("GITHUB_TOKEN"), undefined);
    } finally {
      stop();
    }
    await assertRejects(
      () =>
        startBabysitterAppAuth(
          config,
          () => Promise.reject(new Error("mint failed")),
        ),
      Error,
      "mint failed",
    );
    assertEquals(Deno.env.get("GH_TOKEN"), "babysitter-app-auth-unavailable");
  } finally {
    for (const [name, value] of old) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("App token refresh recovers after a transient failure", async () => {
  const names = [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_APP_ID",
    "GITHUB_APP_INSTALLATION_ID",
    "GITHUB_APP_PRIVATE_KEY_PATH",
  ];
  const old = new Map(names.map((name) => [name, Deno.env.get(name)]));
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
  try {
    const stop = await startBabysitterAppAuth(config, () => {
      calls++;
      if (calls === 2) {
        sawFailure();
        return Promise.reject(new Error("temporary outage"));
      }
      return calls === 1 ? Promise.resolve("first-app-token") : resumed;
    }, 20);
    try {
      await failed;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(Deno.env.get("GH_TOKEN"), "babysitter-app-auth-unavailable");
      release("renewed-app-token");
      await new Promise((resolve) => setTimeout(resolve, 30));
      assertEquals(Deno.env.get("GH_TOKEN"), "renewed-app-token");
    } finally {
      stop();
    }
  } finally {
    for (const [name, value] of old) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});
