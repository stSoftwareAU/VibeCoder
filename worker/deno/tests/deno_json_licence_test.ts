/**
 * Tests for the SPDX licence declaration in worker/deno/deno.json.
 *
 * Issue #2172 — The repository ships under Apache-2.0 (see LICENSE), so the
 * worker package manifest must declare the matching SPDX short code so that
 * downstream tooling (JSR, SBOM generators, supply-chain scanners) sees a
 * machine-readable licence.
 */

import { assertEquals } from "@std/assert";

const denoJsonUrl = new URL("../deno.json", import.meta.url);
const licenceUrl = new URL("../../../LICENSE", import.meta.url);

async function readDenoJson(): Promise<Record<string, unknown>> {
  const text = await Deno.readTextFile(denoJsonUrl);
  return JSON.parse(text) as Record<string, unknown>;
}

Deno.test("deno.json declares an SPDX licence field (Issue #2172)", async () => {
  const manifest = await readDenoJson();
  assertEquals(
    typeof manifest.license,
    "string",
    "worker/deno/deno.json must declare a string `license` field",
  );
});

Deno.test("deno.json licence is Apache-2.0 (matches LICENSE file)", async () => {
  const manifest = await readDenoJson();
  assertEquals(
    manifest.license,
    "Apache-2.0",
    "worker/deno/deno.json `license` must be the SPDX short code Apache-2.0",
  );
});

Deno.test("LICENSE file exists at the repository root (structural guard)", async () => {
  // WHAT-test on a structural fact: the repository-root LICENSE the manifest
  // claims to match must exist. The prose of the file is boilerplate — grepping
  // it (Issue #3266) asserted nothing about behaviour, only that a checked-in
  // file contained a substring, so it is replaced by this existence check.
  const info = await Deno.stat(licenceUrl);
  assertEquals(
    info.isFile,
    true,
    "the repository-root LICENSE file the manifest claims to match must exist",
  );
});
