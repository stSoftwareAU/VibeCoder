/** Actual host files/locks: no upstream credentials or mutable process state. */
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCodexSubscriptionPersistence } from "../lib/codex_subscription_persistence.ts";
import { createCodexSubscriptionTransport } from "../lib/codex_subscription_transport.ts";

const accountId = "fixture-account";
const now = Date.UTC(2026, 9, 18);
function jwt(expires: number): string {
  const payload = btoa(JSON.stringify({
    exp: expires,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId },
  })).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
  return `synthetic.${payload}.synthetic`;
}
function auth(expires = now / 1000 - 1, refresh = "synthetic-refresh-one") {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: accountId,
      access_token: jwt(expires),
      id_token: jwt(now / 1000 + 3600),
      refresh_token: refresh,
    },
    last_refresh: new Date(now).toISOString(),
  };
}
async function fixture(run: (path: string, initial: string) => Promise<void>) {
  const dir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "codex-auth-store-" }),
  );
  const path = `${dir}/auth.json`;
  const initial = JSON.stringify({
    ...auth(),
    operator_metadata: { keep: ["unrelated", "state"] },
    tokens: { ...auth().tokens, future_metadata: "preserve" },
  });
  try {
    await Deno.writeTextFile(path, initial, { mode: 0o644 });
    await run(path, initial);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
function request() {
  return new Request("https://chatgpt.com/backend-api/codex/responses", {
    method: "POST",
    body: "{}",
  });
}

Deno.test("Codex host CAS writes 0600 and preserves unrelated auth state across successive rotations", async () => {
  await fixture(async (path, initial) => {
    const store = createCodexSubscriptionPersistence({
      authFile: path,
      accountId,
    });
    const signal = new AbortController().signal;
    const next = await store.persist({
      expectedAuthJson: initial,
      authJson: JSON.stringify(auth(now / 1000 + 3600, "refresh-two")),
      signal,
    });
    assertEquals(next, await Deno.readTextFile(path));
    const saved = JSON.parse(next!);
    assertEquals(saved.operator_metadata, { keep: ["unrelated", "state"] });
    assertEquals(saved.tokens.future_metadata, "preserve");
    assertEquals(saved.tokens.refresh_token, "refresh-two");
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    await store.persist({
      expectedAuthJson: next!,
      authJson: JSON.stringify(auth(now / 1000 + 7200, "refresh-three")),
      signal,
    });
    assertEquals(
      JSON.parse(await Deno.readTextFile(path)).tokens.refresh_token,
      "refresh-three",
    );
    await assertRejects(
      () =>
        store.persist({
          expectedAuthJson: initial,
          authJson: JSON.stringify(auth()),
          signal,
        }),
      Error,
      "Codex auth snapshot changed",
    );
    assertEquals(
      JSON.parse(await Deno.readTextFile(path)).tokens.refresh_token,
      "refresh-three",
    );
  });
});

Deno.test("Codex two broker instances consume a shared refresh token once under the host account lock", async () => {
  await fixture(async (path, initial) => {
    const refreshStarted = Promise.withResolvers<void>();
    const allowRefresh = Promise.withResolvers<void>();
    let refreshes = 0;
    let inference = 0;
    const make = () =>
      createCodexSubscriptionTransport({
        authJson: initial,
        accountId,
        now: () => now,
        ...createCodexSubscriptionPersistence({ authFile: path, accountId }),
        async fetch(req) {
          if (req.url === "https://auth.openai.com/oauth/token") {
            refreshes++;
            refreshStarted.resolve();
            await allowRefresh.promise;
            return Response.json({
              access_token: jwt(now / 1000 + 7200),
              refresh_token: "refresh-two",
            });
          }
          inference++;
          assertEquals(
            req.headers.get("authorization"),
            `Bearer ${jwt(now / 1000 + 7200)}`,
          );
          return new Response("completed");
        },
      });
    const first = make()(request());
    await refreshStarted.promise;
    const second = make()(request());
    allowRefresh.resolve();
    for (const response of await Promise.all([first, second])) {
      assertEquals(response.status, 200);
      assertEquals(await response.text(), "completed");
    }
    assertEquals({ refreshes, inference }, { refreshes: 1, inference: 2 });
    const saved = JSON.parse(await Deno.readTextFile(path));
    assertEquals(saved.tokens.refresh_token, "refresh-two");
    assertEquals(saved.tokens.future_metadata, "preserve");
  });
});

Deno.test("Codex host competing CAS writers have one winner without losing other state", async () => {
  await fixture(async (path, initial) => {
    const signal = new AbortController().signal;
    const results = await Promise.allSettled(
      ["two", "three"].map((name) =>
        createCodexSubscriptionPersistence({ authFile: path, accountId })
          .persist({
            expectedAuthJson: initial,
            authJson: JSON.stringify(
              auth(now / 1000 + 7200, `refresh-${name}`),
            ),
            signal,
          })
      ),
    );
    assertEquals(
      results.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const refused = results.find((result) => result.status === "rejected");
    assertEquals(refused?.reason.message, "Codex auth snapshot changed");
    const winner = results.find((result) => result.status === "fulfilled");
    assertEquals(await Deno.readTextFile(path), winner?.value);
    assertEquals(JSON.parse(winner!.value!).tokens.future_metadata, "preserve");
  });
});

Deno.test("Codex host abort releases the transaction and forbids a late writer from publishing", async () => {
  await fixture(async (path, initial) => {
    const store = createCodexSubscriptionPersistence({
      authFile: path,
      accountId,
    });
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const proceed = Promise.withResolvers<void>();
    const late = Promise.withResolvers<void>();
    const pending = store.transaction({
      signal: controller.signal,
      async run(current, persist) {
        assertEquals(current, initial);
        entered.resolve();
        await proceed.promise;
        try {
          await assertRejects(
            () =>
              persist({
                expectedAuthJson: initial,
                authJson: JSON.stringify(auth(now / 1000 + 7200)),
                // A caller cannot replace the closed transaction's signal.
                signal: new AbortController().signal,
              }),
            Error,
            "Codex auth transaction is closed",
          );
          late.resolve();
        } catch (error) {
          late.reject(error);
        }
        return initial;
      },
    });
    const rejected = assertRejects(
      () => pending,
      DOMException,
      "closed fixture",
    );
    await entered.promise;
    controller.abort(new DOMException("closed fixture", "AbortError"));
    await rejected;
    assertEquals(await Deno.readTextFile(path), initial);
    // The lock is released, but the old callback must never regain write access.
    await store.persist({
      expectedAuthJson: initial,
      authJson: JSON.stringify(auth(now / 1000 + 7200, "new-owner")),
      signal: new AbortController().signal,
    });
    const committed = await Deno.readTextFile(path);
    proceed.resolve();
    await late.promise;
    assertEquals(await Deno.readTextFile(path), committed);
    assertEquals(JSON.parse(committed).tokens.refresh_token, "new-owner");
  });
});

Deno.test("Codex host abort before entry or commit leaves the auth file unchanged", async () => {
  await fixture(async (path, initial) => {
    const store = createCodexSubscriptionPersistence({
      authFile: path,
      accountId,
    });
    const controller = new AbortController();
    controller.abort();
    await assertRejects(() =>
      store.persist({
        expectedAuthJson: initial,
        authJson: JSON.stringify(auth()),
        signal: controller.signal,
      }), DOMException);
    let entered = false;
    await store.transaction({
      signal: new AbortController().signal,
      async run(current, persist) {
        entered = true;
        await assertRejects(() =>
          persist({
            expectedAuthJson: current,
            authJson: JSON.stringify(auth()),
            signal: controller.signal,
          }), DOMException);
        return current;
      },
    });
    assertEquals(entered, true);
    assertEquals(await Deno.readTextFile(path), initial);
  });
});

Deno.test("Codex host refuses linked, missing, oversized or malformed auth files and unsafe directories", async () => {
  for (
    const kind of [
      "symlink",
      "hardlink",
      "directory",
      "missing",
      "oversized",
      "malformed",
      "account",
      "mode",
      "parent",
      "ancestor",
      "lock",
      "permissions",
    ]
  ) {
    await fixture(async (path, initial) => {
      const directory = path.slice(0, path.lastIndexOf("/"));
      const other = `${directory}/other.json`;
      await Deno.writeTextFile(other, initial, { mode: 0o600 });
      let selected = path;
      if (["symlink", "hardlink", "directory", "missing"].includes(kind)) {
        await Deno.remove(path);
        if (kind === "symlink") await Deno.symlink(other, path);
        if (kind === "hardlink") await Deno.link(other, path);
        if (kind === "directory") await Deno.mkdir(path);
      }
      if (kind === "oversized") {
        await Deno.writeTextFile(path, "x".repeat(128 * 1024 + 1));
      }
      if (kind === "malformed") await Deno.writeTextFile(path, "{}");
      if (kind === "account") {
        const changed = auth();
        changed.tokens.account_id = "another-account";
        await Deno.writeTextFile(path, JSON.stringify(changed));
      }
      if (kind === "mode") {
        await Deno.writeTextFile(
          path,
          JSON.stringify({ ...auth(), OPENAI_API_KEY: "competing-key" }),
        );
      }
      if (kind === "parent") {
        await Deno.symlink(directory, `${directory}/alias`);
        selected = `${directory}/alias/auth.json`;
      }
      if (kind === "ancestor") {
        await Deno.mkdir(`${directory}/nested`, { mode: 0o700 });
        await Deno.writeTextFile(`${directory}/nested/auth.json`, initial);
        await Deno.symlink(directory, `${directory}/alias`);
        selected = `${directory}/alias/nested/auth.json`;
      }
      if (kind === "lock") await Deno.symlink(other, `${path}.broker-lock`);
      if (kind === "permissions") await Deno.chmod(directory, 0o755);
      let invoked = false;
      const cause = ["malformed", "account", "mode"].includes(kind)
        ? "Invalid selected Codex subscription snapshot"
        : ["parent", "ancestor", "permissions"].includes(kind)
        ? "Codex auth directory must be private and canonical"
        : kind === "lock"
        ? "Codex auth lock must not be a symlink"
        : kind === "missing"
        ? undefined
        : "Codex auth file must be a bounded singly linked regular file";
      await assertRejects(
        () =>
          createCodexSubscriptionPersistence({
            authFile: selected,
            accountId,
          }).transaction({
            signal: new AbortController().signal,
            run: () => {
              invoked = true;
              return Promise.resolve(initial);
            },
          }),
        Error,
        cause,
      );
      assertEquals(invoked, false, kind);
      assertEquals(await Deno.readTextFile(other), initial, kind);
    });
  }
  for (const authFile of ["relative/auth.json", "/tmp/a/../auth.json"]) {
    assertThrows(
      () => createCodexSubscriptionPersistence({ authFile, accountId }),
      Error,
      "canonical and absolute",
    );
  }
});

Deno.test("Codex host refuses malformed and cross-account replacements without writing", async () => {
  await fixture(async (path, initial) => {
    const changed = auth();
    changed.tokens.account_id = "another-account";
    for (const replacement of ["{}", JSON.stringify(changed)]) {
      await assertRejects(
        () =>
          createCodexSubscriptionPersistence({ authFile: path, accountId })
            .persist({
              expectedAuthJson: initial,
              authJson: replacement,
              signal: new AbortController().signal,
            }),
        Error,
        "Invalid selected Codex subscription snapshot",
      );
      assertEquals(await Deno.readTextFile(path), initial);
    }
  });
});

Deno.test("Codex transport uses exact merged disk state for successive rotations", async () => {
  await fixture(async (path, initial) => {
    let clock = now;
    let refreshes = 0;
    const forward = createCodexSubscriptionTransport({
      authJson: initial,
      accountId,
      now: () => clock,
      // Exercise the backward-compatible CAS callback as well as the host
      // transaction path covered by the two-instance test.
      persist: createCodexSubscriptionPersistence({ authFile: path, accountId })
        .persist,
      async fetch(req) {
        if (req.url === "https://auth.openai.com/oauth/token") {
          const body = await req.json();
          assertEquals(
            body.refresh_token,
            refreshes === 0 ? "synthetic-refresh-one" : "refresh-1",
          );
          refreshes++;
          return Response.json({
            access_token: jwt(clock / 1000 + 3600),
            refresh_token: `refresh-${refreshes}`,
          });
        }
        assertEquals(
          req.headers.get("authorization"),
          `Bearer ${jwt(clock / 1000 + 3600)}`,
        );
        return new Response("completed");
      },
    });
    for (let pass = 0; pass < 2; pass++) {
      const response = await forward(request());
      assertEquals(response.status, 200);
      assertEquals(await response.text(), "completed");
      clock += 3600_000;
    }
    assertEquals(refreshes, 2);
    const saved = JSON.parse(await Deno.readTextFile(path));
    assertEquals(saved.tokens.refresh_token, "refresh-2");
    assertEquals(saved.tokens.future_metadata, "preserve");
  });
});

Deno.test("Codex locked reload refuses account drift before refresh and latches closed", async () => {
  await fixture(async (path, initial) => {
    let calls = 0;
    const forward = createCodexSubscriptionTransport({
      authJson: initial,
      accountId,
      now: () => now,
      ...createCodexSubscriptionPersistence({ authFile: path, accountId }),
      fetch() {
        calls++;
        return Promise.resolve(new Response("unexpected"));
      },
    });
    const changed = auth();
    changed.tokens.account_id = "another-account";
    await Deno.writeTextFile(path, JSON.stringify(changed));
    const denied = await forward(request());
    assertEquals(denied.status, 502);
    assertEquals(
      await denied.text(),
      "Codex subscription account transaction failed\n",
    );
    // Repairing disk cannot revive a transport whose selected identity drifted.
    await Deno.writeTextFile(path, initial);
    const latched = await forward(request());
    assertEquals(latched.status, 503);
    assertEquals(
      await latched.text(),
      "Codex subscription account transaction failed\n",
    );
    assertEquals(calls, 0);
  });
});

Deno.test("Codex host abort during the commit read prevents the atomic replacement", async () => {
  await fixture(async (path, initial) => {
    const store = createCodexSubscriptionPersistence({
      authFile: path,
      accountId,
    });
    const controller = new AbortController();
    const finished = Promise.withResolvers<void>();
    await assertRejects(() =>
      store.transaction({
        signal: controller.signal,
        async run(current, persist) {
          const commit = persist({
            expectedAuthJson: current,
            authJson: JSON.stringify(auth(now / 1000 + 7200)),
            signal: controller.signal,
          });
          controller.abort();
          try {
            await assertRejects(() => commit, Error);
            finished.resolve();
          } catch (error) {
            finished.reject(error);
          }
          return current;
        },
      }), DOMException);
    await finished.promise;
    assertEquals(await Deno.readTextFile(path), initial);
  });
});

Deno.test("Codex host transaction cannot overlap two scoped CAS writes", async () => {
  await fixture(async (path, initial) => {
    const store = createCodexSubscriptionPersistence({
      authFile: path,
      accountId,
    });
    await store.transaction({
      signal: new AbortController().signal,
      async run(current, persist) {
        const results = await Promise.allSettled(
          ["two", "three"].map((name) =>
            persist({
              expectedAuthJson: current,
              authJson: JSON.stringify(
                auth(now / 1000 + 7200, `refresh-${name}`),
              ),
              signal: new AbortController().signal,
            })
          ),
        );
        assertEquals(
          results.filter((result) => result.status === "fulfilled").length,
          1,
        );
        const winner = results.find((result) => result.status === "fulfilled");
        assertEquals(await Deno.readTextFile(path), winner!.value);
        return winner!.value!;
      },
    });
    assertEquals(
      JSON.parse(await Deno.readTextFile(path)).operator_metadata,
      JSON.parse(initial).operator_metadata,
    );
  });
});

Deno.test("Codex brokers reuse a completed refresh even when the access token is unchanged", async () => {
  await fixture(async (path) => {
    const initial = JSON.stringify(auth(now / 1000 + 3600));
    await Deno.writeTextFile(path, initial);
    let refreshes = 0;
    let inference = 0;
    const refreshing = Promise.withResolvers<void>();
    const second401 = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const make = () =>
      createCodexSubscriptionTransport({
        authJson: initial,
        accountId,
        now: () => now,
        ...createCodexSubscriptionPersistence({ authFile: path, accountId }),
        async fetch(req) {
          if (req.url === "https://auth.openai.com/oauth/token") {
            refreshes++;
            refreshing.resolve();
            await release.promise;
            return Response.json({
              access_token: jwt(now / 1000 + 3600),
              refresh_token: "refresh-two",
            });
          }
          inference++;
          if (inference <= 2) {
            if (inference === 2) second401.resolve();
            return new Response(null, { status: 401 });
          }
          return new Response("completed");
        },
      });
    const first = make()(request());
    await refreshing.promise;
    const second = make()(request());
    await second401.promise;
    release.resolve();
    for (const result of await Promise.all([first, second])) {
      assertEquals(result.status, 200);
      assertEquals(await result.text(), "completed");
    }
    assertEquals({ refreshes, inference }, { refreshes: 1, inference: 4 });
    assertEquals(
      JSON.parse(await Deno.readTextFile(path)).tokens.refresh_token,
      "refresh-two",
    );
  });
});
