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
const PRIVATE_A = ["private-repo-13", "-AI"].join("");
const PRIVATE_B = ["Migration", "_v21"].join("");

const REDACTIONS = `# comment
account: ${ACCOUNT} -> vibe-coder-bot
hostname: /\\b${HOST.split("-")[0]}-(\\d+)\\b/ -> host-$1
telemetry: /\\b${TELEMETRY.split("-")[0]}[- _]?health\\b/i -> fleet-health
private-repo: * -> private-repo-{n}
`;

Deno.test("parseRedactions - each rule is class, pattern and replacement; malformed lines are errors", () => {
  const parsed = parseRedactions(REDACTIONS);
  assertEquals(parsed.errors, []);
  assertEquals(parsed.rules.length, 3);
  assertEquals(parsed.privateRepoTemplate, "private-repo-{n}");
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
    privateRepoTemplate: "private-repo-{n}",
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
  // The name is replaced wherever it appears as a whole word — slug, work
  // dir, CI job path — so derived forms stay consistent; the organisation
  // stays (it is public), and so do public and placeholder repositories.
  const input =
    `${ORG}/${PRIVATE_B} then ${ORG}/${PRIVATE_A}.git and /work/${PRIVATE_A} and job/${ORG}/job/${PRIVATE_B} and ${ORG}/VibeCoder and ${ORG}/foo`;
  const out = redactText(input, [], {
    privateRepoTemplate: "private-repo-{n}",
    privateRepoIndex: index,
    // Declared private repositories are renamed tree-wide; an undeclared
    // (unknown) name would be hidden in slug form only.
    repoPolicy: {
      publicRepos: ["VibeCoder"],
      placeholderRepos: [],
      privatePatterns: [
        new RegExp(`^${PRIVATE_A}$`, "i"),
        new RegExp(`^${PRIVATE_B}$`, "i"),
      ],
    },
  });
  assertEquals(
    out.text,
    `${ORG}/private-repo-2 then ${ORG}/private-repo-1.git and /work/private-repo-1 and job/${ORG}/job/private-repo-2 and ${ORG}/VibeCoder and ${ORG}/foo`,
  );
  assertEquals(out.counts.get("private-repo"), 4);

  // Undeclared: slug form only, and the gate would still block it.
  const unknown = redactText(`${ORG}/${PRIVATE_A} in /work/${PRIVATE_A}`, [], {
    privateRepoTemplate: "private-repo-{n}",
    privateRepoIndex: index,
    publicRepos: ["VibeCoder"],
  });
  assertEquals(unknown.text, `${ORG}/private-repo-1 in /work/${PRIVATE_A}`);
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
      privateRepoTemplate: "private-repo-{n}",
      publicRepos: ["VibeCoder"],
    });
    // Alphabetical numbering: PRIVATE_B (2) sorts after PRIVATE_A (1),
    // regardless of which file is read first.
    assertEquals(
      await Deno.readTextFile(`${root}/docs/a.md`),
      `${ORG}/private-repo-1 and vibe-coder-bot\n`,
    );
    assertEquals(
      await Deno.readTextFile(`${root}/b.ts`),
      `const repo = "${ORG}/private-repo-2"; // host-23\n`,
    );
    assertEquals(report.filesRewritten, 2);
    assertEquals(report.filesSkippedBinary, 1);
    assertEquals(report.totals.get("private-repo"), 2);
    assertEquals(report.totals.get("account"), 1);
    assertEquals(
      report.privateRepoMap.get(PRIVATE_B.toLowerCase()),
      "private-repo-1",
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
      privateRepoTemplate: "private-repo-{n}",
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
  const input = `${TELEM}_metrics_dir report${TELEM.charAt(0).toUpperCase()}${
    TELEM.slice(1)
  }MetricsBeat VIBE_${TELEM.toUpperCase()}_METRICS_DIR ./${TELEM}_metrics.ts`;
  const out = redactText(input, [], {
    privateRepoTemplate: null,
    privateRepoIndex: new Map(),
    renames: [{ from: TELEM, to: "fleet" }],
  });
  assertEquals(
    out.text,
    "fleet_metrics_dir reportFleetMetricsBeat VIBE_FLEET_METRICS_DIR ./fleet_metrics.ts",
  );
  assertEquals(out.counts.get("rename"), 4);
});

Deno.test("redactTree - rename rules also rename files and directories whose path carries the substring, keeping imports consistent", async () => {
  const root = await Deno.makeTempDir({ prefix: "export_redact_" });
  try {
    await Deno.mkdir(`${root}/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/lib/${TELEM}_metrics.ts`,
      `export const ${TELEM}MetricsDir = "x";\n`,
    );
    await Deno.writeTextFile(
      `${root}/mod.ts`,
      `import { ${TELEM}MetricsDir } from "./lib/${TELEM}_metrics.ts";\nconsole.log(${TELEM}MetricsDir);\n`,
    );
    const report = await redactTree(root, {
      rules: [],
      privateRepoTemplate: null,
      renames: [{ from: TELEM, to: "fleet" }],
    });
    assertEquals(
      await Deno.readTextFile(`${root}/mod.ts`),
      `import { fleetMetricsDir } from "./lib/fleet_metrics.ts";\nconsole.log(fleetMetricsDir);\n`,
    );
    assertEquals(
      await Deno.readTextFile(`${root}/lib/fleet_metrics.ts`),
      `export const fleetMetricsDir = "x";\n`,
    );
    const stillThere = await Deno.stat(`${root}/lib/${TELEM}_metrics.ts`).then(
      () => true,
      () => false,
    );
    assertEquals(stillThere, false, "the old path must be gone");
    assertEquals(report.pathsRenamed, [
      { from: `lib/${TELEM}_metrics.ts`, to: "lib/fleet_metrics.ts" },
    ]);
    assertStringIncludes(renderRedactionReport(report), "lib/fleet_metrics.ts");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
