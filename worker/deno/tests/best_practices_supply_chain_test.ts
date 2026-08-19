/**
 * Tests for the supply-chain hardening added to the best-practices
 * prompt and bucket guides (Issue #2184).
 *
 * The orchestrator (`prompts/best_practices/v1.md`) names each
 * supply-chain rule once. Per-language buckets carry the language-
 * specific detection — TypeScript/npm and the repo-level `general`
 * bucket.
 *
 * Australian English spelling used throughout.
 */

import { assert } from "@std/assert";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function readPrompt(rel: string): Promise<string> {
  return await Deno.readTextFile(`${PROMPTS_DIR}/${rel}`);
}

// --- best_practices/v2.md (orchestrator) ---

Deno.test(
  "best_practices/v2.md - orchestrator references the supply-chain hardening checks",
  async () => {
    const body = (await readPrompt("best_practices/v2.md")).toLowerCase();
    for (
      const needle of [
        "supply-chain",
        "quarantine",
        "provenance",
      ]
    ) {
      assert(
        body.includes(needle),
        `best_practices/v2.md must mention '${needle}'`,
      );
    }
  },
);

// --- buckets/typescript.md (npm / JSR ecosystem) ---

const TYPESCRIPT_NEEDLES = [
  "ignore-scripts",
  "lockfile",
  "phantom",
  "dormant",
  "typosquat",
  "dependency confusion",
  "provenance",
];

for (const needle of TYPESCRIPT_NEEDLES) {
  Deno.test(
    `buckets/typescript.md - mentions '${needle}'`,
    async () => {
      const body = (await readPrompt("best_practices/buckets/typescript.md"))
        .toLowerCase();
      assert(
        body.includes(needle),
        `typescript bucket must mention '${needle}'`,
      );
    },
  );
}

// --- buckets/general.md (repo-level hygiene) ---

const GENERAL_NEEDLES = [
  "sbom",
  "quarantine",
  "lockfile",
];

for (const needle of GENERAL_NEEDLES) {
  Deno.test(
    `buckets/general.md - mentions '${needle}'`,
    async () => {
      const body = (await readPrompt("best_practices/buckets/general.md"))
        .toLowerCase();
      assert(
        body.includes(needle),
        `general bucket must mention '${needle}'`,
      );
    },
  );
}
