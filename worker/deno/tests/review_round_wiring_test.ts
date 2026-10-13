/**
 * Production wiring for the review round's DeepSeek fallback (Issue #3632).
 *
 * The fallback export reads the DeepSeek credential the way the worker's
 * start-up reads every provider's — the `deepseek/provider.env` file under
 * the credential directory — and builds the child environment DeepSeek's own
 * policy pins (`deepseek_env.ts`): base URL and auth token pinned, no Claude
 * credential reaching the third-party endpoint, DeepSeek's own config dir.
 *
 * These tests drive the real `createReviewRoundDeps` against a fixture
 * credential directory (the `credentialDir` seam), in both directions: a
 * provisioned file exports and pins, a missing file exports nothing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { createReviewRoundDeps } from "../lib/review_round.ts";

/** A provisioned DeepSeek credential file, the shape setup writes. */
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
