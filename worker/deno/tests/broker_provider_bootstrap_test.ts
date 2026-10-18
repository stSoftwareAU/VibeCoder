/** Real policy and account files; no ambient credential access or network. */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { resolveAgentProvider } from "../lib/agent_provider.ts";
import {
  prepareTrustedBrokerProvider,
  type TrustedBrokerProviderSource,
} from "../lib/broker_provider_bootstrap.ts";
import { createClaudeCredentialPool } from "../lib/claude_credential_pool.ts";
import { createCodexSubscriptionPersistence } from "../lib/codex_subscription_persistence.ts";
import type { ProviderTokenFile } from "../lib/credential_preflight.ts";

function credential(label: string, name: string): ProviderTokenFile {
  const value = `synthetic-${label}-secret`;
  return {
    label,
    path: `/private/host/${label}.env`,
    name,
    value,
    primary: label === "provider",
    poolMember: name === "CLAUDE_CODE_OAUTH_TOKEN",
    entries: [{ name, value }],
  };
}
function options() {
  return { signal: new AbortController().signal };
}
const accountId = "selected-account";
function auth(account = accountId) {
  const jwt = `synthetic.${
    btoa(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: account },
    })).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_")
  }.synthetic`;
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: account,
      access_token: jwt,
      id_token: jwt,
      refresh_token: "synthetic-private-refresh",
    },
    last_refresh: "2026-10-18T00:00:00.000Z",
    operator_metadata: "keep",
  });
}
async function withAccount(run: (codexHome: string) => Promise<void>) {
  const codexHome = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "broker-bootstrap-account-" }),
  );
  try {
    await Deno.writeTextFile(`${codexHome}/auth.json`, auth(), { mode: 0o600 });
    await run(codexHome);
  } finally {
    await Deno.remove(codexHome, { recursive: true });
  }
}

Deno.test({
  name:
    "broker bootstrap uses existing Claude pool selection without exporting credentials",
  permissions: { env: false },
  async fn() {
    const token = credential("provider", "CLAUDE_CODE_OAUTH_TOKEN");
    const pool = createClaudeCredentialPool({
      provider: resolveAgentProvider("claude"),
      env: () => undefined,
      discover: () => Promise.resolve([token]),
      fetchFn: () => Promise.reject(new Error("no single-token probe")),
    });
    const selected = await prepareTrustedBrokerProvider({
      kind: "claude-pool",
      pool,
      candidates: [token],
      selection: { kind: "startup" },
    }, options());
    assert(selected.status === "selected");
    assertEquals(selected.trusted, {
      credentials: { claude: token.value! },
      claudeAuthentication: "bearer",
    });
    assertEquals(selected.public.quota.availability, "unknown");
    assertEquals(selected.public.billingMode, "fixed-subscription");
    assert(!JSON.stringify(selected.public).includes(token.value!));
  },
});

Deno.test({
  name:
    "broker bootstrap preserves selected Claude and Gemini modes and immutable lease values",
  permissions: { env: false },
  async fn() {
    for (
      const [provider, authentication, name] of [
        ["claude", "subscription", "CLAUDE_CODE_OAUTH_TOKEN"],
        ["claude", "api-key", "ANTHROPIC_API_KEY"],
        ["gemini", "api-key", "GEMINI_API_KEY"],
        ["gemini", "api-key", "GOOGLE_API_KEY"],
      ] as const
    ) {
      const token = credential("provider", name);
      const selected = await prepareTrustedBrokerProvider({
        kind: "credential",
        provider,
        authentication,
        credential: token,
      }, options());
      assert(selected.status === "selected");
      assertEquals(selected.public.provider, provider);
      assertEquals(selected.public.authentication, authentication);
      assertEquals(selected.trusted.credentials[provider], token.value!);
      token.value = "later-selection";
      token.entries[0]!.value = "later-selection";
      assertEquals(
        selected.trusted.credentials[provider],
        "synthetic-provider-secret",
      );
      assertEquals(
        Reflect.set(selected.trusted.credentials, provider, "changed"),
        false,
      );
      assertEquals(Object.isFrozen(selected), true);
      assertEquals(Object.isFrozen(selected.public.quota.windows), true);
    }
    const token = credential("api", "CODEX_API_KEY");
    const selected = await prepareTrustedBrokerProvider({
      kind: "codex-api-key",
      credential: token,
    }, options());
    assert(selected.status === "selected");
    token.value = "changed";
    assertEquals(selected.trusted.credentials.openai, "synthetic-api-secret");
    assertEquals(
      Reflect.set(selected.trusted.credentials, "openai", "changed"),
      false,
    );
  },
});

Deno.test({
  name:
    "broker bootstrap denies unsupported billing and malformed or mixed API credentials",
  permissions: { env: false },
  async fn() {
    const invalid = [
      { kind: "unknown" },
      { kind: undefined },
      {
        kind: "credential",
        provider: "gemini",
        authentication: "subscription",
        credential: credential("provider", "GEMINI_API_KEY"),
      },
      {
        kind: "credential",
        provider: "gemini",
        authentication: "vertex",
        credential: credential("provider", "GOOGLE_API_KEY"),
      },
      {
        kind: "credential",
        provider: "claude",
        authentication: undefined,
        credential: credential("provider", "ANTHROPIC_API_KEY"),
      },
      {
        kind: "credential",
        provider: "claude",
        authentication: "subscription",
        credential: credential("provider", "ANTHROPIC_API_KEY"),
      },
      ...["ANTHROPIC_API_KEY", "CODEX_HOME", "GEMINI_API_KEY"].map((name) => ({
        kind: "codex-api-key",
        credential: credential("api", name),
      })),
      ...[
        { label: "private/path" },
        { value: "has space" },
        { value: "" },
        { value: "a".repeat(65_537) },
        { entries: [] },
        { entries: [{ name: "CODEX_API_KEY", value: "synthetic-api-secret" }] },
        { entries: [{ name: "OPENAI_API_KEY", value: "different" }] },
        {
          entries: [{ name: "OPENAI_API_KEY", value: "synthetic-api-secret" }, {
            name: "CODEX_API_KEY",
            value: "extra",
          }],
        },
      ].map((patch) => ({
        kind: "codex-api-key",
        credential: { ...credential("api", "OPENAI_API_KEY"), ...patch },
      })),
    ];
    for (const source of invalid) {
      await assertRejects(
        () =>
          prepareTrustedBrokerProvider(
            source as TrustedBrokerProviderSource,
            options(),
          ),
        Error,
        "Trusted provider bootstrap failed",
      );
    }
  },
});

Deno.test({
  name:
    "broker bootstrap preserves Claude exhausted rotation without an API fallback",
  permissions: { env: false },
  async fn() {
    const tokens = [
      credential("provider", "CLAUDE_CODE_OAUTH_TOKEN"),
      credential("provider-2", "CLAUDE_CODE_OAUTH_TOKEN"),
    ];
    const now = Date.UTC(2026, 9, 18);
    const pool = createClaudeCredentialPool({
      provider: resolveAgentProvider("claude"),
      env: () => undefined,
      discover: () => Promise.resolve(tokens),
      now: () => now,
      fetchFn: () => Promise.reject(new Error("unexpected probe")),
    });
    for (const token of tokens) {
      pool.recordBudget(token.label, {
        label: token.label,
        known: true,
        remainingFraction: 0.7,
        window: "five_hour",
        resetAt: now + 3_600_000,
        windows: [{
          window: "five_hour",
          remainingFraction: 0.7,
          resetAt: now + 3_600_000,
        }],
      }, now);
    }
    const first = await prepareTrustedBrokerProvider({
      kind: "claude-pool",
      pool,
      candidates: tokens,
      selection: { kind: "startup" },
    }, options());
    assert(first.status === "selected");
    assertEquals(first.public.credentialLabel, "provider");
    pool.recordExhaustion("provider", [{
      window: "five_hour",
      resetAt: now + 3_600_000,
    }]);
    const second = await prepareTrustedBrokerProvider({
      kind: "claude-pool",
      pool,
      candidates: tokens,
      selection: { kind: "rotation", excludeLabel: "provider" },
    }, options());
    assert(second.status === "selected");
    assertEquals(second.public.credentialLabel, "provider-2");
    assertEquals(first.trusted.credentials.claude, "synthetic-provider-secret");
    pool.recordExhaustion("provider-2", [{
      window: "five_hour",
      resetAt: now + 3_600_000,
    }]);
    const exhausted = await prepareTrustedBrokerProvider({
      kind: "claude-pool",
      pool,
      candidates: tokens,
      selection: { kind: "rotation", excludeLabel: "provider-2" },
    }, options());
    assertEquals(exhausted.status, "unavailable");
    assertEquals(exhausted.public.quota.availability, "unavailable");
    assertEquals("trusted" in exhausted, false);
  },
});

Deno.test({
  name: "broker bootstrap cancellation cannot publish an awaited Claude choice",
  permissions: { env: false },
  async fn() {
    const token = credential("provider", "CLAUDE_CODE_OAUTH_TOKEN");
    const pool = createClaudeCredentialPool({
      provider: resolveAgentProvider("claude"),
      env: () => undefined,
    });
    const selected = Promise.withResolvers<ProviderTokenFile>();
    let calls = 0;
    let delay = false;
    const delayed = {
      ...pool,
      selectToken: () => {
        calls++;
        return delay ? selected.promise : Promise.resolve(token);
      },
      readPoolBudgets: () => Promise.resolve(null),
    };
    const source: TrustedBrokerProviderSource = {
      kind: "claude-pool",
      pool: delayed,
      candidates: [token],
      selection: { kind: "startup" },
    };
    const closed = new AbortController();
    closed.abort("synthetic-private-abort-reason");
    await assertRejects(
      () => prepareTrustedBrokerProvider(source, { signal: closed.signal }),
      Error,
      "Trusted provider bootstrap cancelled",
    );
    assertEquals(calls, 0);
    delay = true;
    const controller = new AbortController();
    const pending = prepareTrustedBrokerProvider(source, {
      signal: controller.signal,
    });
    controller.abort("synthetic-private-abort-reason");
    selected.resolve(token);
    await assertRejects(
      () => pending,
      Error,
      "Trusted provider bootstrap cancelled",
    );
    assertEquals(calls, 1);
  },
});

Deno.test({
  name:
    "broker bootstrap refuses missing malformed or different ChatGPT accounts without fallback",
  permissions: { env: false, read: true, write: true },
  async fn() {
    await withAccount(async (codexHome) => {
      const source: TrustedBrokerProviderSource = {
        kind: "codex-chatgpt",
        codexHome,
        accountId,
        credentialLabel: "subscription",
      };
      for (
        const patch of [
          { codexHome: "" },
          { codexHome: "relative" },
          { codexHome: `${codexHome}/absent-private-name` },
          { credentialLabel: "/private" },
          { accountId: "other-account" },
        ]
      ) {
        const error = await assertRejects(
          () =>
            prepareTrustedBrokerProvider({ ...source, ...patch }, options()),
          Error,
          "Trusted provider bootstrap failed",
        );
        assertEquals(error.message, "Trusted provider bootstrap failed");
      }
      for (
        const text of [
          "malformed-private-data",
          JSON.stringify({
            auth_mode: "apikey",
            OPENAI_API_KEY: "must-not-fallback",
          }),
          auth("other-account"),
        ]
      ) {
        await Deno.writeTextFile(`${codexHome}/auth.json`, text);
        await assertRejects(
          () => prepareTrustedBrokerProvider(source, options()),
          Error,
          "Trusted provider bootstrap failed",
        );
      }
      await Deno.remove(`${codexHome}/auth.json`);
      await assertRejects(
        () => prepareTrustedBrokerProvider(source, options()),
        Error,
        "Trusted provider bootstrap failed",
      );
    });
  },
});

Deno.test({
  name:
    "broker bootstrap snapshots ChatGPT choice under the refresh lock and closes persistence with its lease",
  permissions: { env: false, read: true, write: true },
  async fn() {
    await withAccount(async (codexHome) => {
      const store = createCodexSubscriptionPersistence({
        authFile: `${codexHome}/auth.json`,
        accountId,
      });
      const locked = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const writer = store.transaction({
        signal: options().signal,
        async run(current, persist) {
          locked.resolve();
          await release.promise;
          const next = JSON.parse(current);
          next.tokens.refresh_token = "rotated-before-selection";
          return (await persist({
            expectedAuthJson: current,
            authJson: JSON.stringify(next),
            signal: options().signal,
          }))!;
        },
      });
      await locked.promise;
      const controller = new AbortController();
      const source = {
        kind: "codex-chatgpt" as const,
        codexHome,
        accountId,
        credentialLabel: "chosen",
      };
      const pending = prepareTrustedBrokerProvider(source, {
        signal: controller.signal,
      });
      source.codexHome = "/another-host-account";
      source.accountId = "another-account";
      source.credentialLabel = "changed-label";
      release.resolve();
      await writer;
      const selected = await pending;
      assert(selected.status === "selected");
      const subscription = selected.trusted.codexSubscription;
      assert(subscription);
      assertEquals(
        JSON.parse(subscription.authJson).tokens.refresh_token,
        "rotated-before-selection",
      );
      assertEquals(selected.public.credentialLabel, "chosen");
      assertEquals(subscription.accountId, accountId);
      controller.abort();
      await assertRejects(() =>
        subscription.persist({
          expectedAuthJson: subscription.authJson,
          authJson: auth(),
          signal: options().signal,
        })
      );
      let ran = false;
      await assertRejects(() =>
        subscription.transaction({
          signal: options().signal,
          run: () => {
            ran = true;
            return Promise.resolve(auth());
          },
        })
      );
      assertEquals(ran, false);
      assertEquals(
        await Deno.readTextFile(`${codexHome}/auth.json`),
        subscription.authJson,
      );
    });
  },
});

Deno.test({
  name: "broker bootstrap projects only explicitly selected API billing",
  permissions: { env: false },
  async fn() {
    const key = credential("api-account", "OPENAI_API_KEY");
    const selected = await prepareTrustedBrokerProvider({
      kind: "codex-api-key",
      credential: key,
    }, options());
    assert(selected.status === "selected");
    assertEquals(selected.trusted, { credentials: { openai: key.value! } });
    assertEquals(selected.public.authentication, "api-key");
    assertEquals(selected.public.billingMode, "metered");
    assertEquals(selected.public.quota.availability, "unknown");
    assert(!JSON.stringify(selected.public).includes(key.path));
  },
});

Deno.test({
  name:
    "broker bootstrap binds selected ChatGPT home and durable transaction privately",
  permissions: { env: false, read: true, write: true },
  async fn() {
    await withAccount(async (codexHome) => {
      const selected = await prepareTrustedBrokerProvider({
        kind: "codex-chatgpt",
        codexHome,
        accountId,
        credentialLabel: "subscription-one",
      }, options());
      assert(selected.status === "selected");
      assertEquals(selected.trusted.credentials, {});
      const subscription = selected.trusted.codexSubscription;
      assert(subscription);
      assertEquals(subscription.accountId, accountId);
      assertEquals(subscription.authJson, auth());
      const publicText = JSON.stringify(selected.public);
      for (
        const privateValue of [
          codexHome,
          accountId,
          "synthetic-private-refresh",
        ]
      ) {
        assert(!publicText.includes(privateValue));
      }
      assertEquals(selected.public.authentication, "chatgpt");
      assertEquals(selected.public.billingMode, "fixed-subscription");
      assertEquals(selected.public.quota.availability, "unknown");
      const replacement = JSON.parse(auth());
      replacement.tokens.refresh_token = "synthetic-rotation";
      const committed = await subscription.persist({
        expectedAuthJson: subscription.authJson,
        authJson: JSON.stringify(replacement),
        signal: options().signal,
      });
      assertEquals(
        committed,
        await Deno.readTextFile(`${codexHome}/auth.json`),
      );
      assertEquals(
        JSON.parse(committed!).tokens.refresh_token,
        "synthetic-rotation",
      );
      assertEquals(JSON.parse(committed!).operator_metadata, "keep");
      assertEquals(Object.isFrozen(subscription), true);
    });
  },
});
