/**
 * Production wiring for the review round's provider fallbacks.
 *
 * The DeepSeek fallback export (Issue #3632) reads the DeepSeek credential the
 * way the worker's start-up reads every provider's — the `deepseek/provider.env`
 * file under the credential directory — and builds the child environment
 * DeepSeek's own policy pins (`deepseek_env.ts`): base URL and auth token
 * pinned, no Claude credential reaching the third-party endpoint, DeepSeek's
 * own config dir.
 *
 * The Codex fallback export (Issue #5083) reads `codex/provider.env` the same
 * way, and its child environment is Codex's own: no Claude credential, nor any
 * Anthropic variable, may reach the Codex child.
 *
 * These tests drive the real `createReviewRoundDeps` against a fixture
 * credential directory (the `credentialDir` seam), in both directions: a
 * provisioned file exports and pins, a missing file exports nothing.
 *
 * Issue #5127: the round's own persistent Codex home
 * (`VIBE_REVIEW_CODEX_HOME`) is offered when it holds a login of its own, and
 * never when it is empty or a copy of the worker's one-time login seed.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  createReviewRoundDeps,
  REVIEW_CODEX_HOME_ENV_VAR,
  runReviewRound,
} from "../lib/review_round.ts";

/** A provisioned provider credential file, the shape setup writes. */
async function withCredentialDir(
  files: Record<string, string>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "review-fallback-" });
  try {
    for (const [rel, content] of Object.entries(files)) {
      const path = `${dir}/${rel}`;
      await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(path, content);
    }
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test(
  "review round wiring - a provisioned DeepSeek credential exports the pinned child env (Issue #3632)",
  async () => {
    await withCredentialDir(
      {
        // The shape the worker's setup writes: an export line per variable.
        "deepseek/provider.env":
          "export DEEPSEEK_API_KEY=fixture-deepseek-key-3632\n", // gitleaks:allow fake fixture, not a real key
      },
      async (dir) => {
        const deps = createReviewRoundDeps(() => {}, { credentialDir: dir });
        const exported: Record<string, string> = {};
        const fallback = await deps.exportFallbackCredential(
          (name, value) => {
            exported[name] = value;
          },
        );

        assert(fallback !== null, "a provisioned file must export a fallback");
        assertEquals(fallback!.providerId, "deepseek");
        assertEquals(exported["DEEPSEEK_API_KEY"], "fixture-deepseek-key-3632");
        // The child env is DeepSeek's own.
        assertEquals(
          fallback!.env["ANTHROPIC_BASE_URL"],
          "https://api.deepseek.com/anthropic",
        );
        assertEquals(
          fallback!.env["ANTHROPIC_AUTH_TOKEN"],
          "fixture-deepseek-key-3632",
          "the key is mapped onto the variable the Anthropic CLI reads",
        );
        assertEquals(
          fallback!.env["CLAUDE_CODE_OAUTH_TOKEN"],
          undefined,
          "no Claude credential may reach the third-party endpoint",
        );
        assertEquals(
          fallback!.env["CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS"],
          "0",
        );
      },
    );
  },
);

Deno.test(
  "review round wiring - no DeepSeek credential means no fallback (Issue #3632)",
  async () => {
    await withCredentialDir({}, async (dir) => {
      const deps = createReviewRoundDeps(() => {}, { credentialDir: dir });
      assertEquals(
        await deps.exportFallbackCredential(() => {}),
        null,
        "an absent credential file defers nothing — the round stays failed",
      );
    });
  },
);

Deno.test(
  "review round wiring - a provisioned Codex credential exports a Codex-only child env (Issue #5083)",
  async () => {
    await withCredentialDir(
      {
        // The shape the worker's setup writes: an export line per variable.
        "codex/provider.env": "export OPENAI_API_KEY=fixture-codex-key-5083\n", // gitleaks:allow fake fixture, not a real key
      },
      async (dir) => {
        // The worker's own Claude subscription token and metered key are in
        // the process environment; neither may reach the Codex child.
        const deps = createReviewRoundDeps(() => {}, {
          credentialDir: dir,
          env: {
            CLAUDE_CODE_OAUTH_TOKEN: "fixture-claude-5083",
            ANTHROPIC_API_KEY: "fixture-anthropic-5083",
          },
        });
        const codex = await deps.exportCodexCredential();

        assert(
          codex !== null,
          "a provisioned file must export a credential",
        );
        assertEquals(
          codex!.env["OPENAI_API_KEY"],
          "fixture-codex-key-5083",
        );
        assertEquals(
          "CLAUDE_CODE_OAUTH_TOKEN" in codex!.env,
          false,
          "no Claude subscription token may reach the Codex child",
        );
        assertEquals(
          "ANTHROPIC_API_KEY" in codex!.env,
          false,
          "no Anthropic key may reach the Codex child",
        );
        assertEquals(
          "ANTHROPIC_AUTH_TOKEN" in codex!.env,
          false,
          "no Anthropic bearer may reach the Codex child",
        );
      },
    );
  },
);

Deno.test(
  "review round wiring - an ambient Codex credential keeps the Codex fallback (Issue #5083)",
  async () => {
    await withCredentialDir({}, async (dir) => {
      // The Codex key is already in the process environment, so no file
      // export happens; Codex must still be available with that key.
      const deps = createReviewRoundDeps(() => {}, {
        credentialDir: dir,
        env: {
          OPENAI_API_KEY: "fixture-ambient-codex-5083", // gitleaks:allow fake fixture, not a real key
          CLAUDE_CODE_OAUTH_TOKEN: "fixture-claude-5083",
        },
      });
      const codex = await deps.exportCodexCredential();

      assert(
        codex !== null,
        "an ambient Codex credential must keep the Codex fallback",
      );
      assertEquals(
        codex!.env["OPENAI_API_KEY"],
        "fixture-ambient-codex-5083",
      );
      assertEquals(
        "CLAUDE_CODE_OAUTH_TOKEN" in codex!.env,
        false,
        "no Claude subscription token may reach the Codex child",
      );
    });
  },
);

Deno.test(
  "review round wiring - no Codex credential means no Codex fallback (Issue #5083)",
  async () => {
    await withCredentialDir({}, async (dir) => {
      // No Codex credential anywhere: the API-key and state variables are unset.
      const deps = createReviewRoundDeps(() => {}, {
        credentialDir: dir,
        env: {},
      });
      assertEquals(
        await deps.exportCodexCredential(),
        null,
        "an absent credential file defers nothing to Codex",
      );
    });
  },
);

Deno.test(
  "review round wiring - a CODEX_HOME provider.env whose login is present offers Codex (Issue #5083)",
  async () => {
    const home = await Deno.makeTempDir({ prefix: "review-codex-home-" });
    try {
      await Deno.writeTextFile(
        `${home}/auth.json`,
        JSON.stringify({ tokens: { access_token: "fixture-5083" } }), // gitleaks:allow fake fixture
        { mode: 0o600 },
      );
      await withCredentialDir(
        { "codex/provider.env": `export CODEX_HOME=${home}\n` },
        async (dir) => {
          const deps = createReviewRoundDeps(() => {}, {
            credentialDir: dir,
            env: { DEEPSEEK_API_KEY: "fixture-deepseek-5083" }, // gitleaks:allow fake fixture
          });
          const codex = await deps.exportCodexCredential();
          assert(codex !== null, "a reachable login must offer Codex");
          assertEquals(codex!.env["CODEX_HOME"], home);
        },
      );
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  },
);

Deno.test(
  "review round wiring - a CODEX_HOME the round cannot reach skips Codex with a log line, so DeepSeek is still tried (Issue #5083)",
  async () => {
    // The documented subscription setup: CODEX_HOME on the agent-state
    // volume, which the round's container does not mount, so it is empty.
    const missing = `${await Deno.makeTempDir()}/not-mounted/codex`;
    await withCredentialDir(
      { "codex/provider.env": `export CODEX_HOME=${missing}\n` },
      async (dir) => {
        const lines: string[] = [];
        const deps = createReviewRoundDeps((line) => lines.push(line), {
          credentialDir: dir,
          env: {},
        });
        assertEquals(await deps.exportCodexCredential(), null);
        assert(
          lines.some((line) => line.includes("skipping the codex fallback")),
          `the skip is logged: ${lines.join(" | ")}`,
        );
      },
    );
  },
);

Deno.test(
  "review round wiring - a CODEX_HOME whose auth.json is not a login skips Codex at the login check (Issue #5083)",
  async () => {
    const home = await Deno.makeTempDir({ prefix: "review-codex-empty-" });
    try {
      // `{}` gets past the state initialiser (an auth.json exists) but is not a
      // login, so only `codexChildLoginMissing` can stop it.
      await Deno.writeTextFile(`${home}/auth.json`, "{}", { mode: 0o600 });
      await withCredentialDir({}, async (dir) => {
        const lines: string[] = [];
        const deps = createReviewRoundDeps((line) => lines.push(line), {
          credentialDir: dir,
          env: { CODEX_HOME: home },
        });
        assertEquals(await deps.exportCodexCredential(), null);
        assert(
          lines.some((line) =>
            line.includes(`no Codex login at ${home}/auth.json`) &&
            line.includes("skipping the codex fallback")
          ),
          `the login check's line is logged: ${lines.join(" | ")}`,
        );
      });
    } finally {
      await Deno.remove(home, { recursive: true });
    }
  },
);

Deno.test(
  "review round wiring - no Codex API key and no usable CODEX_HOME in the round skips Codex (Issue #5083)",
  async () => {
    // A blank CODEX_HOME counts as set to the "already provisioned" check but
    // names no home, so the child ends with neither a key nor a home.
    await withCredentialDir({}, async (dir) => {
      const lines: string[] = [];
      const deps = createReviewRoundDeps((line) => lines.push(line), {
        credentialDir: dir,
        env: { CODEX_HOME: "  " },
      });
      assertEquals(await deps.exportCodexCredential(), null);
      assert(
        lines.some((line) =>
          line.includes("no Codex API key and no CODEX_HOME in the round") &&
          line.includes("skipping the codex fallback")
        ),
        `the skip is logged: ${lines.join(" | ")}`,
      );
    });
  },
);

Deno.test(
  "review round wiring - a one-time login seed beside an unreachable CODEX_HOME is not copied into the round (Issue #5083)",
  async () => {
    // The documented subscription setup: provider.env names a CODEX_HOME on the
    // agent-state volume, which the round's container does not mount, and the
    // one-time ChatGPT auth.json seed sits beside it. The round must not seed a
    // throwaway home from it: Codex is skipped so DeepSeek is still tried.
    const missing = `${await Deno.makeTempDir()}/not-mounted/codex`;
    try {
      await withCredentialDir(
        { "codex/provider.env": `export CODEX_HOME=${missing}\n` },
        async (dir) => {
          await Deno.writeTextFile(
            `${dir}/codex/auth.json`,
            JSON.stringify({
              auth_mode: "chatgpt",
              tokens: { access_token: "fixture-seed-5083" }, // gitleaks:allow fake fixture
            }),
            { mode: 0o600 },
          );
          const lines: string[] = [];
          const deps = createReviewRoundDeps((line) => lines.push(line), {
            credentialDir: dir,
            env: {},
          });
          assertEquals(await deps.exportCodexCredential(), null);
          assert(
            lines.some((line) =>
              line.includes(`no Codex login at ${missing}/auth.json`) &&
              line.includes("skipping the codex fallback")
            ),
            `the skip is logged: ${lines.join(" | ")}`,
          );
          let created = true;
          try {
            await Deno.stat(missing);
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            created = false;
          }
          assertEquals(created, false, "no Codex home is created in the round");
        },
      );
    } finally {
      await Deno.remove(missing.replace(/\/not-mounted\/codex$/, ""), {
        recursive: true,
      });
    }
  },
);

/** A fake ChatGPT login file body with the given refresh token. */
function chatgptLogin(refresh: string, access = "fixture-access"): string {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: { access_token: access, refresh_token: refresh }, // gitleaks:allow fake fixture
  });
}

/** A temp directory for a round Codex home, removed after `fn`. */
async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "review-round-home-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test(
  "review round wiring - a round Codex home holding its own login offers Codex there, even when provider.env names the unmounted agent-state home (Issue #5127)",
  async () => {
    await withTempDir(async (roundHome) => {
      const missing = `${roundHome}/not-mounted/codex`;
      const own = chatgptLogin("round-refresh"); // gitleaks:allow fake fixture
      await Deno.writeTextFile(`${roundHome}/auth.json`, own);
      await withCredentialDir(
        { "codex/provider.env": `export CODEX_HOME=${missing}\n` },
        async (dir) => {
          await Deno.writeTextFile(
            `${dir}/codex/auth.json`,
            chatgptLogin("seed-refresh"), // gitleaks:allow fake fixture
            { mode: 0o600 },
          );
          const deps = createReviewRoundDeps(() => {}, {
            credentialDir: dir,
            env: {
              [REVIEW_CODEX_HOME_ENV_VAR]: roundHome,
              OPENAI_API_KEY: "fixture-key", // gitleaks:allow fake fixture
              CLAUDE_CODE_OAUTH_TOKEN: "fixture-claude", // gitleaks:allow fake fixture
            },
          });
          const codex = await deps.exportCodexCredential();
          assert(codex !== null, "the round's own login must offer Codex");
          assertEquals(codex!.env["CODEX_HOME"], roundHome);
          assertEquals("OPENAI_API_KEY" in codex!.env, false);
          assertEquals("CLAUDE_CODE_OAUTH_TOKEN" in codex!.env, false);
          assertEquals(await Deno.readTextFile(`${roundHome}/auth.json`), own);
          assertEquals(await exists(missing), false);
        },
      );
    });
  },
);

Deno.test(
  "review round wiring - a round whose Claude side is spent runs on Codex from the round's own home and never reaches DeepSeek (Issue #5127)",
  async () => {
    await withTempDir(async (roundHome) => {
      await Deno.writeTextFile(
        `${roundHome}/auth.json`,
        chatgptLogin("round-refresh"), // gitleaks:allow fake fixture
      );
      await withCredentialDir(
        {
          "deepseek/provider.env": "export DEEPSEEK_API_KEY=fixture-deepseek\n", // gitleaks:allow fake fixture
        },
        async (credentialDir) => {
          const lines: string[] = [];
          const log = (line: string) => lines.push(line);
          const real = createReviewRoundDeps(log, {
            credentialDir,
            env: {
              [REVIEW_CODEX_HOME_ENV_VAR]: roundHome,
              DEEPSEEK_API_KEY: "fixture-deepseek", // gitleaks:allow fake fixture
            },
          });
          let claudeCalls = 0;
          let fallbackCalls = 0;
          const codexEnvs: Record<string, string>[] = [];
          const code = await runReviewRound(
            "p",
            ["--model", "claude-opus-5-5"],
            {
              ...real,
              exportStartCredential: (setEnv) => {
                setEnv("CLAUDE_CODE_OAUTH_TOKEN", "x");
                return Promise.resolve("provider");
              },
              switchCredential: () => Promise.resolve(null),
              runClaude: () => {
                claudeCalls++;
                return Promise.resolve({
                  code: 1,
                  output: "You've hit your usage limit · resets 1:50pm (UTC)",
                });
              },
              runCodex: (_args, _stdin, env) => {
                codexEnvs.push(env);
                return Promise.resolve({ code: 0, output: "Round done" });
              },
              exportFallbackCredential: (setEnv) => {
                fallbackCalls++;
                return real.exportFallbackCredential(setEnv);
              },
            },
          );
          assertEquals(code, 0);
          assertEquals(codexEnvs.length, 1);
          assertEquals(codexEnvs[0]!["CODEX_HOME"], roundHome);
          assertEquals(fallbackCalls, 0);
          assertEquals(claudeCalls, 1);
          assert(
            lines.some((l) =>
              l.includes("INFO: round fell back to provider codex")
            ),
            `the switch is logged: ${lines.join(" | ")}`,
          );
        },
      );
    });
  },
);

Deno.test(
  "review round wiring - an empty round Codex home is never seeded from the worker's login seed (Issue #5127)",
  async () => {
    await withTempDir(async (roundHome) => {
      await withCredentialDir(
        {
          "codex/provider.env": `export CODEX_HOME=${roundHome}/not-mounted\n`,
        },
        async (dir) => {
          await Deno.writeTextFile(
            `${dir}/codex/auth.json`,
            chatgptLogin("seed-refresh"), // gitleaks:allow fake fixture
            { mode: 0o600 },
          );
          const lines: string[] = [];
          const deps = createReviewRoundDeps((l) => lines.push(l), {
            credentialDir: dir,
            env: { [REVIEW_CODEX_HOME_ENV_VAR]: roundHome },
          });
          assertEquals(await deps.exportCodexCredential(), null);
          assertEquals(await exists(`${roundHome}/auth.json`), false);
          assert(
            lines.some((l) =>
              l.includes(
                `no Codex login in the round's Codex home ${roundHome}`,
              )
            ),
            `the empty home is logged: ${lines.join(" | ")}`,
          );
          assert(lines.some((l) => l.includes("skipping the codex fallback")));
        },
      );
    });
  },
);

Deno.test(
  "review round wiring - a round Codex home holding a copy of the seed is refused (Issue #5127)",
  async () => {
    await withTempDir(async (roundHome) => {
      await withCredentialDir({ "codex/provider.env": "" }, async (dir) => {
        const seed = chatgptLogin("seed-refresh"); // gitleaks:allow fake fixture
        await Deno.writeTextFile(`${dir}/codex/auth.json`, seed, {
          mode: 0o600,
        });
        const offer = async (body: string) => {
          await Deno.writeTextFile(`${roundHome}/auth.json`, body);
          const lines: string[] = [];
          const deps = createReviewRoundDeps((l) => lines.push(l), {
            credentialDir: dir,
            env: { [REVIEW_CODEX_HOME_ENV_VAR]: roundHome },
          });
          return { codex: await deps.exportCodexCredential(), lines };
        };
        const marker = "holds a copy of the worker's one-time login seed";

        const identical = await offer(seed);
        assertEquals(identical.codex, null);
        assert(identical.lines.some((l) => l.includes(marker)));

        // Same refresh token, different formatting and access token.
        const rotated = await offer(
          JSON.stringify(
            {
              auth_mode: "chatgpt",
              tokens: {
                access_token: "fixture-other-access", // gitleaks:allow fake fixture
                refresh_token: "seed-refresh", // gitleaks:allow fake fixture
              },
            },
            null,
            2,
          ) + "\n",
        );
        assertEquals(rotated.codex, null);
        assert(rotated.lines.some((l) => l.includes(marker)));

        // Positive control: a different refresh token is accepted.
        const own = await offer(chatgptLogin("round-refresh")); // gitleaks:allow fake fixture
        assert(own.codex !== null, "only the copy rule refuses");
        assertEquals(own.codex!.env["CODEX_HOME"], roundHome);
      });
    });
  },
);

Deno.test(
  "review round wiring - a seed the round cannot read refuses the round Codex home rather than passing it (Issue #5127)",
  async () => {
    await withTempDir(async (roundHome) => {
      await Deno.writeTextFile(
        `${roundHome}/auth.json`,
        chatgptLogin("round-refresh"), // gitleaks:allow fake fixture
        { mode: 0o600 },
      );
      const env = { [REVIEW_CODEX_HOME_ENV_VAR]: roundHome };

      // A seed path that is a directory fails with a non-NotFound read error.
      await withCredentialDir({ "codex/provider.env": "" }, async (dir) => {
        await Deno.mkdir(`${dir}/codex/auth.json`);
        const lines: string[] = [];
        const deps = createReviewRoundDeps((l) => lines.push(l), {
          credentialDir: dir,
          env,
        });
        assertEquals(await deps.exportCodexCredential(), null);
        assert(
          lines.some((l) =>
            l.includes(
              `cannot compare the round's Codex home ${roundHome} with the worker's login seed`,
            )
          ),
          `the unreadable seed is logged: ${lines.join(" | ")}`,
        );
      });

      // Positive control: an absent seed is simply not a copy.
      await withCredentialDir({ "codex/provider.env": "" }, async (dir) => {
        const deps = createReviewRoundDeps(() => {}, {
          credentialDir: dir,
          env,
        });
        const codex = await deps.exportCodexCredential();
        assert(codex !== null, "an absent seed does not refuse the round home");
        assertEquals(codex!.env["CODEX_HOME"], roundHome);
      });
    });
  },
);

Deno.test(
  "review round wiring - an empty round Codex home still leaves the API-key credential usable (Issue #5127)",
  async () => {
    await withTempDir(async (roundHome) => {
      await withCredentialDir(
        {
          "codex/provider.env":
            "export OPENAI_API_KEY=fixture-codex-key-5127\n", // gitleaks:allow fake fixture
        },
        async (dir) => {
          const deps = createReviewRoundDeps(() => {}, {
            credentialDir: dir,
            env: { [REVIEW_CODEX_HOME_ENV_VAR]: roundHome },
          });
          const codex = await deps.exportCodexCredential();
          assert(codex !== null, "the API key keeps Codex available");
          assertEquals(
            codex!.env["OPENAI_API_KEY"],
            "fixture-codex-key-5127",
          );
        },
      );
    });
  },
);
