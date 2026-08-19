/**
 * Export-time identifier redaction (Issues #4196, #4197).
 *
 * The private tree keeps its operator identifiers (fixture account names,
 * hostnames, telemetry names, other private repositories); the STAGED tree
 * has them replaced deterministically by placeholders before the scrub gate
 * runs, so the gate judges only what the mapping could not express.
 *
 * Fixtures are assembled at runtime: this file is itself exported and must
 * not carry the shapes it tests.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  parseRedactions,
  redactText,
  redactTree,
  renderRedactionReport,
} from "../lib/export_redact.ts";

const ACCOUNT = ["Vibe", "CoderST"].join("");
const HOST = ["FLEET", "-23"].join("");
const TELEMETRY = ["FLEET", "-health"].join("");
const ORG = "stSoftwareAU";
const PRIVATE_A = ["NEAT", "-AI"].join("");
const PRIVATE_B = ["Migration", "_v21"].join("");

const REDACTIONS = `# comment
account: ${ACCOUNT} -> vibe-coder-bot
hostname: /\\b${HOST.split("-")[0]}-(\\d+)\\b/ -> host-$1
telemetry: /\\b${TELEMETRY.split("-")[0]}[- _]?health\\b/i -> fleet-health
private-repo: * -> example-org/private-repo-{n}
`;

Deno.test("parseRedactions - each rule is class, pattern and replacement; malformed lines are errors", () => {
  const parsed = parseRedactions(REDACTIONS);
  assertEquals(parsed.errors, []);
  assertEquals(parsed.rules.length, 3);
  assertEquals(parsed.privateRepoTemplate, "example-org/private-repo-{n}");
  const bad = parseRedactions(
    "account: x\nbogus: y -> z\nprivate-repo: * -> nope\n",
  );
  assertEquals(bad.errors.length, 3);
  assert(bad.errors[0]!.includes("->"));
  assert(bad.errors[1]!.includes("unknown class"));
  assert(bad.errors[2]!.includes("{n}"));
});

Deno.test("redactText - literal, regex-with-group and case-insensitive rules apply; replacements are stable", () => {
  const { rules } = parseRedactions(REDACTIONS);
  const input =
    `allowed: ${ACCOUNT}, ${ACCOUNT.toLowerCase()} on ${HOST} via ${TELEMETRY.toUpperCase()}`;
  const out = redactText(input, rules, {
    privateRepoTemplate: "example-org/private-repo-{n}",
    privateRepoIndex: new Map(),
  });
  assertEquals(
    out.text,
    "allowed: vibe-coder-bot, vibe-coder-bot on host-23 via fleet-health",
  );
  assertEquals(out.counts.get("account"), 2);
  assertEquals(out.counts.get("hostname"), 1);
  assertEquals(out.counts.get("telemetry"), 1);
});

Deno.test("redactText - private repositories map to numbered placeholders by a tree-wide index; public and placeholder names are left", () => {
  const index = new Map<string, number>([
    [PRIVATE_A.toLowerCase(), 1],
    [PRIVATE_B.toLowerCase(), 2],
  ]);
  const input =
    `${ORG}/${PRIVATE_B} then ${ORG}/${PRIVATE_A}.git and ${ORG}/VibeCoder and ${ORG}/foo`;
  const out = redactText(input, [], {
    privateRepoTemplate: "example-org/private-repo-{n}",
    privateRepoIndex: index,
    publicRepos: ["VibeCoder"],
  });
  assertEquals(
    out.text,
    `example-org/private-repo-2 then example-org/private-repo-1.git and ${ORG}/VibeCoder and ${ORG}/foo`,
  );
  assertEquals(out.counts.get("private-repo"), 2);
});

Deno.test("redactTree - rewrites text files in place, skips binaries, numbers private repos deterministically across the tree, and reports per class/file", async () => {
  const root = await Deno.makeTempDir({ prefix: "export_redact_" });
  try {
    await Deno.mkdir(`${root}/docs`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docs/a.md`,
      `${ORG}/${PRIVATE_B} and ${ACCOUNT}\n`,
    );
    await Deno.writeTextFile(
      `${root}/b.ts`,
      `const repo = "${ORG}/${PRIVATE_A}"; // ${HOST}\n`,
    );
    await Deno.writeFile(
      `${root}/img.png`,
      new Uint8Array([0x89, 0x50, 0, 1, 2, 0]),
    );
    const { rules } = parseRedactions(REDACTIONS);
    const report = await redactTree(root, {
      rules,
      privateRepoTemplate: "example-org/private-repo-{n}",
      publicRepos: ["VibeCoder"],
    });
    // Alphabetical numbering: migration_v21 (2) sorts after neat-ai (1),
    // regardless of which file is read first.
    assertEquals(
      await Deno.readTextFile(`${root}/docs/a.md`),
      "example-org/private-repo-1 and vibe-coder-bot\n",
    );
    assertEquals(
      await Deno.readTextFile(`${root}/b.ts`),
      `const repo = "example-org/private-repo-2"; // host-23\n`,
    );
    assertEquals(report.filesRewritten, 2);
    assertEquals(report.filesSkippedBinary, 1);
    assertEquals(report.totals.get("private-repo"), 2);
    assertEquals(report.totals.get("account"), 1);
    assertEquals(
      report.privateRepoMap.get(PRIVATE_B.toLowerCase()),
      "example-org/private-repo-1",
    );
    const rendered = renderRedactionReport(report);
    assertStringIncludes(rendered, "private-repo: 2");
    assertStringIncludes(rendered, "docs/a.md");
    // The map is only in the report (which is never exported), so the
    // report may name the private repositories it hid.
    assertStringIncludes(rendered, PRIVATE_B);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("redactTree - a second run is a no-op (idempotent)", async () => {
  const root = await Deno.makeTempDir({ prefix: "export_redact_" });
  try {
    await Deno.writeTextFile(
      `${root}/a.md`,
      `${ACCOUNT} ${ORG}/${PRIVATE_A}\n`,
    );
    const { rules } = parseRedactions(REDACTIONS);
    const opts = {
      rules,
      privateRepoTemplate: "example-org/private-repo-{n}",
      publicRepos: [] as string[],
    };
    await redactTree(root, opts);
    const once = await Deno.readTextFile(`${root}/a.md`);
    const second = await redactTree(root, opts);
    assertEquals(await Deno.readTextFile(`${root}/a.md`), once);
    assertEquals(second.filesRewritten, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// =============================================================================
// `rename:` rules — case-preserving substring rename of identifiers AND paths
// =============================================================================

const TELEM = ["gr", "q"].join(""); // the private substring, assembled

Deno.test("parseRedactions - a rename rule takes a bare lower-case word and replacement", () => {
  const parsed = parseRedactions(`rename: ${TELEM} -> fleet\n`);
  assertEquals(parsed.errors, []);
  assertEquals(parsed.renames, [{ from: TELEM, to: "fleet" }]);
  const bad = parseRedactions(`rename: /x/ -> y\nrename: ${TELEM} -> Fl-eet\n`);
  assertEquals(bad.errors.length, 2);
});

Deno.test("redactText - rename preserves case shape: lower, Capitalised, UPPER — inside identifiers too", () => {
  const input = `${TELEM}_health_dir report${TELEM.charAt(0).toUpperCase()}${
    TELEM.slice(1)
  }HealthHeartbeat VIBE_${TELEM.toUpperCase()}_HEALTH_DIR ./${TELEM}_health.ts`;
  const out = redactText(input, [], {
    privateRepoTemplate: null,
    privateRepoIndex: new Map(),
    renames: [{ from: TELEM, to: "fleet" }],
  });
  assertEquals(
    out.text,
    "fleet_health_dir reportFleetHealthHeartbeat VIBE_FLEET_HEALTH_DIR ./fleet_health.ts",
  );
  assertEquals(out.counts.get("rename"), 4);
});

Deno.test("redactTree - rename rules also rename files and directories whose path carries the substring, keeping imports consistent", async () => {
  const root = await Deno.makeTempDir({ prefix: "export_redact_" });
  try {
    await Deno.mkdir(`${root}/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/lib/${TELEM}_health.ts`,
      `export const ${TELEM}HealthDir = "x";\n`,
    );
    await Deno.writeTextFile(
      `${root}/mod.ts`,
      `import { ${TELEM}HealthDir } from "./lib/${TELEM}_health.ts";\nconsole.log(${TELEM}HealthDir);\n`,
    );
    const report = await redactTree(root, {
      rules: [],
      privateRepoTemplate: null,
      renames: [{ from: TELEM, to: "fleet" }],
    });
    assertEquals(
      await Deno.readTextFile(`${root}/mod.ts`),
      `import { fleetHealthDir } from "./lib/fleet_health.ts";\nconsole.log(fleetHealthDir);\n`,
    );
    assertEquals(
      await Deno.readTextFile(`${root}/lib/fleet_health.ts`),
      `export const fleetHealthDir = "x";\n`,
    );
    const stillThere = await Deno.stat(`${root}/lib/${TELEM}_health.ts`).then(
      () => true,
      () => false,
    );
    assertEquals(stillThere, false, "the old path must be gone");
    assertEquals(report.pathsRenamed, [
      { from: `lib/${TELEM}_health.ts`, to: "lib/fleet_health.ts" },
    ]);
    assertStringIncludes(renderRedactionReport(report), "lib/fleet_health.ts");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
