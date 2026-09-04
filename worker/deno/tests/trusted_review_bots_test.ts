/**
 * Tests for trusted_review_bots configuration (Issue #1856).
 *
 * Validates loading precedence (env var > .config.json > defaults),
 * shell export by load-config, and validator warnings for oversized
 * lists or non-bot-shaped names.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import { loadConfigCommand } from "../commands/load_config.ts";
import {
  buildDefaultWorkerConfig,
  DEFAULT_TRUSTED_REVIEW_BOTS,
} from "../lib/config_defaults.ts";
import {
  validateConfigFull,
  warnTrustedReviewBots,
} from "../lib/config_validator.ts";
import type { ConfigFile } from "../types.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

async function withTempConfig(
  config: ConfigFile,
  fn: (configPath: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  const configPath = `${tempDir}/.config.json`;
  await Deno.writeTextFile(configPath, JSON.stringify(config));
  try {
    await fn(configPath);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
}

// --- Defaults ---

Deno.test(
  "trustedReviewBots - default list contains the five canonical bots",
  () => {
    assert(
      DEFAULT_TRUSTED_REVIEW_BOTS.includes("github-code-quality[bot]"),
      "should include github-code-quality[bot]",
    );
    assert(
      DEFAULT_TRUSTED_REVIEW_BOTS.includes("coderabbitai[bot]"),
      "should include coderabbitai[bot]",
    );
    assert(
      DEFAULT_TRUSTED_REVIEW_BOTS.includes("sonarcloud[bot]"),
      "should include sonarcloud[bot]",
    );
    assert(
      DEFAULT_TRUSTED_REVIEW_BOTS.includes("deepsource-io[bot]"),
      "should include deepsource-io[bot]",
    );
    assert(
      DEFAULT_TRUSTED_REVIEW_BOTS.includes("codeclimate[bot]"),
      "should include codeclimate[bot]",
    );
    assert(
      DEFAULT_TRUSTED_REVIEW_BOTS.length >= 5,
      "default list should contain at least five bots",
    );
  },
);

Deno.test(
  "trustedReviewBots - loadConfig uses defaults when not configured",
  async () => {
    await withTempConfig(
      { allowed_authors: ["alice"], repos: ["org/repo"] },
      async (configPath) => {
        // No TRUSTED_REVIEW_BOTS anywhere — injected, so the real process
        // environment cannot decide this (Issue #956).
        const config = await loadConfig(configPath, { env: emptyEnv });
        assertEquals(
          config.trustedReviewBots,
          [...DEFAULT_TRUSTED_REVIEW_BOTS],
        );
      },
    );
  },
);

// --- Override via .config.json ---

Deno.test(
  "trustedReviewBots - loadConfig honours JSON override",
  async () => {
    await withTempConfig(
      {
        allowed_authors: ["alice"],
        repos: ["org/repo"],
        trusted_review_bots: ["custom-bot[bot]", "linter-x[bot]"],
      },
      async (configPath) => {
        const config = await loadConfig(configPath, { env: emptyEnv });
        assertEquals(
          config.trustedReviewBots,
          ["custom-bot[bot]", "linter-x[bot]"],
        );
      },
    );
  },
);

Deno.test(
  "trustedReviewBots - empty JSON array overrides defaults to empty",
  async () => {
    await withTempConfig(
      {
        allowed_authors: ["alice"],
        repos: ["org/repo"],
        trusted_review_bots: [],
      },
      async (configPath) => {
        const config = await loadConfig(configPath, { env: emptyEnv });
        assertEquals(config.trustedReviewBots, []);
      },
    );
  },
);

// --- Override via env var ---

Deno.test(
  "trustedReviewBots - TRUSTED_REVIEW_BOTS env var overrides JSON",
  async () => {
    await withTempConfig(
      {
        allowed_authors: ["alice"],
        repos: ["org/repo"],
        trusted_review_bots: ["json-bot[bot]"],
      },
      async (configPath) => {
        const config = await loadConfig(configPath, {
          env: envFrom({
            TRUSTED_REVIEW_BOTS: "env-bot[bot], another-bot[bot]",
          }),
        });
        assertEquals(
          config.trustedReviewBots,
          ["env-bot[bot]", "another-bot[bot]"],
        );
      },
    );
  },
);

Deno.test(
  "trustedReviewBots - a blank TRUSTED_REVIEW_BOTS defers to JSON (Issue #956)",
  async () => {
    // The env leg is "set and non-empty wins", not "set wins": an exported
    // but empty variable must not blank the list out. Only reachable now
    // that the lookup is injected — the previous spelling could not tell an
    // empty export from an absent one without touching the process.
    await withTempConfig(
      {
        allowed_authors: ["alice"],
        repos: ["org/repo"],
        trusted_review_bots: ["json-bot[bot]"],
      },
      async (configPath) => {
        const config = await loadConfig(configPath, {
          env: envFrom({ TRUSTED_REVIEW_BOTS: "" }),
        });
        assertEquals(config.trustedReviewBots, ["json-bot[bot]"]);
      },
    );
  },
);

// --- Shell export ---

Deno.test(
  "trustedReviewBots - load-config exports TRUSTED_REVIEW_BOTS bash array",
  async () => {
    // The command owns its own config load, so this one asserts the shell
    // formatting rather than the env precedence (covered above). Nothing in
    // the suite sets TRUSTED_REVIEW_BOTS any more (Issue #956), so there is
    // no longer a racing writer to guard against.
    await withTempConfig(
      {
        allowed_authors: ["alice"],
        repos: ["org/repo"],
        trusted_review_bots: ["abc[bot]", "def[bot]"],
      },
      async (configPath) => {
        const dummy = buildDefaultWorkerConfig();
        const result = await loadConfigCommand.execute(
          { "config-path": configPath },
          dummy,
        );
        assert(
          result.message.includes(
            'TRUSTED_REVIEW_BOTS=("abc[bot]" "def[bot]")',
          ),
          `expected TRUSTED_REVIEW_BOTS array in shell output, got:\n${result.message}`,
        );
      },
    );
  },
);

// --- Validator warnings ---

Deno.test(
  "trustedReviewBots - validator warns when list is unusually large",
  () => {
    const big = Array.from(
      { length: 25 },
      (_, i) => `bot-${i}[bot]`,
    );
    const warnings = warnTrustedReviewBots(big);
    assert(
      warnings.some((w) =>
        w.includes("TRUSTED_REVIEW_BOTS") && w.includes("25")
      ),
      `expected oversize warning, got: ${warnings.join(" | ")}`,
    );
  },
);

Deno.test(
  "trustedReviewBots - validator warns about non-bot-shaped names",
  () => {
    const warnings = warnTrustedReviewBots([
      "real-bot[bot]",
      "humanuser",
    ]);
    assert(
      warnings.some((w) => w.includes("humanuser")),
      `expected warning for 'humanuser', got: ${warnings.join(" | ")}`,
    );
    // The bot-shaped entry must not produce a warning.
    assert(
      !warnings.some((w) => w.includes("real-bot[bot]")),
      `unexpected warning for bot-shaped entry: ${warnings.join(" | ")}`,
    );
  },
);

Deno.test(
  "trustedReviewBots - validator allows known non-suffix bots",
  () => {
    const warnings = warnTrustedReviewBots([
      "dependabot",
      "renovate",
      "github-actions",
    ]);
    assertEquals(warnings, []);
  },
);

Deno.test(
  "trustedReviewBots - validateConfigFull surfaces the list size warning",
  () => {
    const config = buildDefaultWorkerConfig({
      allowedAuthors: ["alice"],
      allowedAuthor: "alice",
      repos: ["org/repo"],
      authorisedCommenters: ["alice"],
      trustedReviewBots: Array.from(
        { length: 30 },
        (_, i) => `bot-${i}[bot]`,
      ),
    });
    const result = validateConfigFull(config);
    assert(
      result.warnings.some((w) =>
        w.includes("TRUSTED_REVIEW_BOTS") && w.includes("30")
      ),
      `expected oversize warning, got: ${result.warnings.join(" | ")}`,
    );
  },
);
