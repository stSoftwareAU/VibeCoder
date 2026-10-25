/**
 * Marker parsing and the tree walk for the SIMPLE-ON-PURPOSE ledger
 * (Issue #4027).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  parseSimpleOnPurposeLine,
  scanSimpleOnPurposeMarkers,
  SIMPLE_ON_PURPOSE_PREFIX,
} from "../lib/simple_on_purpose_scanner.ts";

const VALID =
  "// SIMPLE-ON-PURPOSE: linear scan, fine to 10,000 rows — upgrade when a table exceeds 10,000 rows";

Deno.test("parseSimpleOnPurposeLine - a complete marker yields ceiling and upgrade when", () => {
  assertEquals(parseSimpleOnPurposeLine(VALID), {
    ceiling: "linear scan, fine to 10,000 rows",
    upgradeWhen: "a table exceeds 10,000 rows",
    flag: "ok",
  });
});

Deno.test("parseSimpleOnPurposeLine - a marker without upgrade when is flagged", () => {
  assertEquals(
    parseSimpleOnPurposeLine(
      "// SIMPLE-ON-PURPOSE: one page of 100 results per owner",
    ),
    {
      ceiling: "one page of 100 results per owner",
      upgradeWhen: "",
      flag: "missing-upgrade-when",
    },
  );
});

Deno.test("parseSimpleOnPurposeLine - an empty marker is malformed", () => {
  assertEquals(parseSimpleOnPurposeLine(`${SIMPLE_ON_PURPOSE_PREFIX}   `), {
    ceiling: "",
    upgradeWhen: "",
    flag: "malformed",
  });
});

Deno.test("parseSimpleOnPurposeLine - upgrade when with no ceiling is malformed", () => {
  assertEquals(
    parseSimpleOnPurposeLine(
      "// SIMPLE-ON-PURPOSE: — upgrade when a table exceeds 10,000 rows",
    ),
    {
      ceiling: "",
      upgradeWhen: "a table exceeds 10,000 rows",
      flag: "malformed",
    },
  );
});

Deno.test("parseSimpleOnPurposeLine - upgrade when with no condition is malformed", () => {
  assertEquals(
    parseSimpleOnPurposeLine(
      "// SIMPLE-ON-PURPOSE: linear scan — upgrade when",
    ),
    {
      ceiling: "linear scan",
      upgradeWhen: "",
      flag: "malformed",
    },
  );
});

Deno.test("parseSimpleOnPurposeLine - a line without the marker is ignored", () => {
  assertEquals(
    parseSimpleOnPurposeLine("// SIMPLE-ON-PURPOSE is not a marker"),
    null,
  );
});

Deno.test("scanSimpleOnPurposeMarkers - lists path:line, ceiling and upgrade when, and flags a malformed marker", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ponytail-debt-scan-" });
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.mkdir(`${dir}/node_modules/pkg`, { recursive: true });
    await Deno.mkdir(`${dir}/.git`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/src/kept.ts`,
      [
        "const n = 1;",
        VALID,
        "// SIMPLE-ON-PURPOSE:",
        "// SIMPLE-ON-PURPOSE: one page, no condition",
        "",
      ].join("\n"),
    );
    await Deno.writeTextFile(
      `${dir}/node_modules/pkg/skip.ts`,
      `${VALID}\n`,
    );
    await Deno.writeTextFile(`${dir}/.git/skip.ts`, `${VALID}\n`);
    await Deno.writeFile(`${dir}/src/blob.bin`, new Uint8Array([0xff, 0xfe]));

    const result = await scanSimpleOnPurposeMarkers(dir);
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(
      result.value.map((marker) => ({
        path: marker.path,
        line: marker.line,
        flag: marker.flag,
        ceiling: marker.ceiling,
      })),
      [
        {
          path: "src/kept.ts",
          line: 2,
          flag: "ok",
          ceiling: "linear scan, fine to 10,000 rows",
        },
        {
          path: "src/kept.ts",
          line: 3,
          flag: "malformed",
          ceiling: "",
        },
        {
          path: "src/kept.ts",
          line: 4,
          flag: "missing-upgrade-when",
          ceiling: "one page, no condition",
        },
      ],
    );
    assertEquals(
      result.value[0]?.upgradeWhen,
      "a table exceeds 10,000 rows",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanSimpleOnPurposeMarkers - an unreadable tree fails loud", async () => {
  const dir = await Deno.makeTempDir({ prefix: "ponytail-debt-loud-" });
  const file = `${dir}/secret.ts`;
  await Deno.writeTextFile(file, `${VALID}\n`);
  await Deno.chmod(file, 0);
  try {
    const result = await scanSimpleOnPurposeMarkers(dir);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "secret.ts");
    }
  } finally {
    await Deno.chmod(file, 0o644);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanSimpleOnPurposeMarkers - a missing directory fails loud", async () => {
  const result = await scanSimpleOnPurposeMarkers(
    `/tmp/ponytail-debt-missing-${crypto.randomUUID()}`,
  );
  assertEquals(result.ok, false);
  if (!result.ok) assertStringIncludes(result.error.message, "cannot scan");
});
