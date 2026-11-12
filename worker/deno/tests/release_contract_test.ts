/**
 * Tests for the release contract record, `docs/audits/release-contract.txt`.
 *
 * `.github/scripts/next-release-tag.sh` decides the major and minor of every
 * release from this file alone: a line removed since the last release is a
 * major, a line added a minor. That only works while the file states exactly
 * the surface the code enforces, so these tests pin it to the code — the
 * config keys `detectUnknownConfigKeys` accepts and `CALLBACK_SCHEMA_VERSION`
 * — and fail with the one command that regenerates it.
 *
 * Uses Australian English throughout (behaviour, recognised).
 */

import { assert, assertEquals } from "@std/assert";
import {
  readCommittedReleaseContract,
  RELEASE_CONTRACT_PATH,
  releaseContractEntries,
  renderReleaseContract,
} from "./support/release_contract.ts";
import {
  detectUnknownConfigKeys,
  detectUnknownNestedKeys,
  KNOWN_CONFIG_KEYS,
  knownNestedConfigKeys,
} from "../lib/config_unknown_keys.ts";
import { CALLBACK_SCHEMA_VERSION } from "../lib/run_callbacks.ts";

Deno.test("release contract - the committed record matches the code", async () => {
  assertEquals(
    await readCommittedReleaseContract(),
    renderReleaseContract(),
    `${RELEASE_CONTRACT_PATH} is out of date: run \`deno task release-contract\` ` +
      `in worker/deno/ and commit the result. A removed line releases as a ` +
      `major, an added line as a minor.`,
  );
});

Deno.test("release contract - every accepted top-level config key is an entry", () => {
  const entries = new Set(releaseContractEntries());
  for (const key of KNOWN_CONFIG_KEYS) {
    assert(entries.has(`config ${key}`), `missing config ${key}`);
  }
  // And the record names nothing the loader would warn about.
  const configured = Object.fromEntries(
    [...KNOWN_CONFIG_KEYS].map((key) => [key, null]),
  );
  assertEquals(detectUnknownConfigKeys(configured), []);
});

Deno.test("release contract - every fixed-vocabulary nested key is an entry", () => {
  const entries = new Set(releaseContractEntries());
  for (const [block, keys] of knownNestedConfigKeys()) {
    for (const key of keys) {
      assert(entries.has(`config ${block}.${key}`), `missing ${block}.${key}`);
    }
    const configured = Object.fromEntries([...keys].map((k) => [k, null]));
    assertEquals(detectUnknownNestedKeys(configured, block, keys), []);
  }
});

Deno.test("release contract - the callback schema version is an entry", () => {
  const schema = releaseContractEntries().filter((e) =>
    e.startsWith("callback-schema ")
  );
  assertEquals(schema, [`callback-schema ${CALLBACK_SCHEMA_VERSION}`]);
});

Deno.test("release contract - entries are unique and in byte order, as the tagger compares them", () => {
  const entries = releaseContractEntries();
  assertEquals(new Set(entries).size, entries.length);
  const sorted = [...entries].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  assertEquals(entries, sorted);
  for (const entry of entries) {
    assert(!entry.startsWith("#"), `an entry reads as a comment: ${entry}`);
    assert(entry.trim() === entry && entry !== "", `blank or padded: ${entry}`);
  }
});

Deno.test("release contract - every non-entry line is a comment the tagger ignores", () => {
  const entries = new Set(releaseContractEntries());
  for (const line of renderReleaseContract().split("\n")) {
    if (line === "" || entries.has(line)) continue;
    assert(line.startsWith("#"), `not an entry and not a comment: ${line}`);
  }
});
