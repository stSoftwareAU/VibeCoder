/**
 * Tests that every WorkerConfig field is consumed by at least one
 * library or command file — not just defined in config plumbing.
 *
 * Issue #1180: Detect dead config fields that are defined but never read.
 */

import { assertEquals } from "@std/assert";
import {
  detectUnusedConfigFields,
  extractWorkerConfigFields,
} from "../lib/unused_config_detector.ts";

const DENO_ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

Deno.test("unused_config - extractWorkerConfigFields parses fields from interface", () => {
  const source = `
export interface WorkerConfig {
  /** doc */
  repos: string[];
  /** doc */
  claudeTimeout: number;
  /** doc */
  shuffleRepos: boolean;
}
`;
  const fields = extractWorkerConfigFields(source);
  assertEquals(fields, ["repos", "claudeTimeout", "shuffleRepos"]);
});

Deno.test("unused_config - extractWorkerConfigFields returns empty for missing interface", () => {
  const fields = extractWorkerConfigFields("const x = 1;");
  assertEquals(fields, []);
});

Deno.test({
  name:
    "unused_config - every WorkerConfig field is consumed outside config plumbing",
  fn: async () => {
    const unused = await detectUnusedConfigFields(DENO_ROOT);
    if (unused.length > 0) {
      const names = unused.map((u) => u.field).join(", ");
      throw new Error(
        `WorkerConfig has unused fields: ${names}. ` +
          "These fields are defined but never consumed by any library or command file. " +
          "Remove them from WorkerConfig and config loading, or wire them up.",
      );
    }
  },
});
