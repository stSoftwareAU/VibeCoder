/**
 * Tests for lib/codex_auth_mode.ts — subscription login versus API-key
 * billing (Issue #1697, parent #1694).
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { resolveCodexAuthMode } from "../lib/codex_auth_mode.ts";

/** An env lookup over a fixed map, so no test touches the real environment. */
function envOf(vars: Record<string, string>) {
  return (name: string): string | undefined => vars[name];
}

const NO_ENV = envOf({});

/** Run `body` against a throwaway CODEX_HOME containing `authJson`. */
async function withCodexHome(
  authJson: string | undefined,
  body: (home: string) => void | Promise<void>,
): Promise<void> {
  const home = await Deno.makeTempDir({ prefix: "codex-auth-mode-" });
  try {
    if (authJson !== undefined) {
      await Deno.writeTextFile(`${home}/auth.json`, authJson);
    }
    await body(home);
  } finally {
    await Deno.remove(home, { recursive: true });
  }
}

Deno.test("resolveCodexAuthMode - an API key in the environment wins", async () => {
  await withCodexHome(
    JSON.stringify({ tokens: { account_id: "acc" } }),
    (home) => {
      const result = resolveCodexAuthMode(
        home,
        envOf({ OPENAI_API_KEY: "sk-secret-value" }),
      );
      assertEquals(result.mode, "api-key");
      assertEquals(result.source, "env");
      // The detail names the variable, never its value.
      assertEquals(result.detail, "OPENAI_API_KEY is set");
      assertEquals(JSON.stringify(result).includes("sk-secret-value"), false);
    },
  );
});

Deno.test("resolveCodexAuthMode - CODEX_API_KEY is recognised too", async () => {
  await withCodexHome(undefined, (home) => {
    const result = resolveCodexAuthMode(home, envOf({ CODEX_API_KEY: "k" }));
    assertEquals(result.mode, "api-key");
    assertEquals(result.source, "env");
  });
});

Deno.test("resolveCodexAuthMode - an empty variable is not a credential", async () => {
  await withCodexHome(undefined, (home) => {
    const result = resolveCodexAuthMode(home, envOf({ OPENAI_API_KEY: "  " }));
    assertEquals(result.mode, "unknown");
    assertEquals(result.source, "absent");
  });
});

Deno.test("resolveCodexAuthMode - auth.json auth_mode is authoritative", async () => {
  const cases: ReadonlyArray<[string, string]> = [
    ["chatgpt", "chatgpt"],
    ["apikey", "api-key"],
    ["bedrockApiKey", "api-key"],
    ["chatgptAuthTokens", "chatgpt"],
  ];
  for (const [declared, expected] of cases) {
    await withCodexHome(
      JSON.stringify({ auth_mode: declared, OPENAI_API_KEY: null }),
      (home) => {
        const result = resolveCodexAuthMode(home, NO_ENV);
        assertEquals(result.mode, expected, declared);
        assertEquals(result.source, "auth-json-field");
      },
    );
  }
});

Deno.test("resolveCodexAuthMode - falls back to the file's shape", async () => {
  await withCodexHome(
    JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: { id_token: "jwt", access_token: "at", refresh_token: "rt" },
    }),
    (home) => {
      const result = resolveCodexAuthMode(home, NO_ENV);
      assertEquals(result.mode, "chatgpt");
      assertEquals(result.source, "auth-json-shape");
      // No token value is carried out of the file.
      assertEquals(JSON.stringify(result).includes("jwt"), false);
    },
  );

  await withCodexHome(
    JSON.stringify({ OPENAI_API_KEY: "sk-file-value" }),
    (home) => {
      const result = resolveCodexAuthMode(home, NO_ENV);
      assertEquals(result.mode, "api-key");
      assertEquals(result.source, "auth-json-shape");
      assertEquals(JSON.stringify(result).includes("sk-file-value"), false);
    },
  );
});

Deno.test("resolveCodexAuthMode - an unrecognised auth_mode is unknown, not guessed", async () => {
  await withCodexHome(
    JSON.stringify({ auth_mode: "agentIdentity" }),
    (home) => {
      const result = resolveCodexAuthMode(home, NO_ENV);
      assertEquals(result.mode, "unknown");
      assert(result.detail?.includes("agentidentity"));
    },
  );
});

Deno.test("resolveCodexAuthMode - a missing file is absent, a broken file is a read error", async () => {
  await withCodexHome(undefined, (home) => {
    const result = resolveCodexAuthMode(home, NO_ENV);
    assertEquals(result.mode, "unknown");
    assertEquals(result.source, "absent");
  });

  await withCodexHome("{ not json", (home) => {
    const result = resolveCodexAuthMode(home, NO_ENV);
    assertEquals(result.mode, "unknown");
    assertEquals(result.source, "read-error");
  });

  await withCodexHome("[]", (home) => {
    const result = resolveCodexAuthMode(home, NO_ENV);
    assertEquals(result.mode, "unknown");
    assertEquals(result.source, "read-error");
  });
});
