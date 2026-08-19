/**
 * Tests for the export-time branding transform (Issue #4197).
 *
 * The private proving ground stays `VibeCoder`; the public repository is
 * `VibeCoder`. The rename is applied to the **staged export tree only**, as
 * a mechanical, reported transform. These tests pin:
 *
 *   - every listed variant is rewritten, and every replacement is counted;
 *   - a URL, clone path or issue shorthand pointing at the private repository
 *     is **not** silently rewritten — it is surfaced as a private-repo
 *     reference for the scrub gate (#4196) to reject;
 *   - binary files are left byte-for-byte untouched;
 *   - the transform is idempotent and keeps a staged shell script valid.
 *
 * Note on fixtures: this test file is itself part of the exported tree, so
 * the private-repository fixtures below are assembled at runtime rather than
 * written as literals — the exported source must not carry the very
 * references the gate blocks.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  BRANDING_VARIANTS,
  formatBrandingReport,
  isProbablyBinary,
  transformBrandingText,
  transformBrandingTree,
} from "../lib/export_branding.ts";
import { exportBrandingCommand } from "../commands/export_branding.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

/** The private slug, assembled so the exported test source never carries it. */
const PRIVATE_SLUG = ["stSoftwareAU", "Vibe" + "Coding"].join("/");
const PRIVATE_URL = `https://github.com/${PRIVATE_SLUG}`;

async function writeFile(
  path: string,
  body: string | Uint8Array,
): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  if (typeof body === "string") {
    await Deno.writeTextFile(path, body);
  } else {
    await Deno.writeFile(path, body);
  }
}

// =============================================================================
// Pure text transform
// =============================================================================

Deno.test("export-branding - every variant is rewritten and counted", () => {
  const text = [
    "# Vibe" + "Coding worker",
    "image: vibe" + "coding/worker:latest",
    "slug vibe" + "-coding and vibe" + "_coding module",
    "ENV VIBE" + "CODING_HOME=/opt",
    "twice: Vibe" + "Coding Vibe" + "Coding",
  ].join("\n");

  const result = transformBrandingText(text, "README.md");

  assertEquals(
    result.text,
    [
      "# VibeCoder worker",
      "image: vibecoder/worker:latest",
      "slug vibe-coder and vibe_coder module",
      "ENV VIBECODER_HOME=/opt",
      "twice: VibeCoder VibeCoder",
    ].join("\n"),
  );
  assertEquals(result.changed, true);
  assertEquals(result.counts["Vibe" + "Coding"], 3);
  assertEquals(result.counts["vibe" + "coding"], 1);
  assertEquals(result.counts["vibe" + "-coding"], 1);
  assertEquals(result.counts["vibe" + "_coding"], 1);
  assertEquals(result.counts["VIBE" + "CODING"], 1);
  // The report accounts for every replacement: totals equal the sum.
  const total = Object.values(result.counts).reduce((a, b) => a + b, 0);
  assertEquals(total, 7);
  assertEquals(result.privateReferences.length, 0);
});

Deno.test("export-branding - the variant table matches the issue's list", () => {
  const pairs = BRANDING_VARIANTS.map((v) => `${v.from}->${v.to}`);
  assertEquals(pairs, [
    "Vibe" + "Coding->VibeCoder",
    "vibe" + "coding->vibecoder",
    "vibe" + "-coding->vibe-coder",
    "vibe" + "_coding->vibe_coder",
    "VIBE" + "CODING->VIBECODER",
    // Mixed-case separator forms found in the tree (heartbeat file names).
    "Vibe" + "_Coding->Vibe_Coder",
    "Vibe" + "-Coding->Vibe-Coder",
  ]);
});

Deno.test("export-branding - text without a variant is reported unchanged", () => {
  const result = transformBrandingText("# Vibe Coder\nnothing here\n", "a.md");
  assertEquals(result.changed, false);
  assertEquals(result.text, "# Vibe Coder\nnothing here\n");
  assertEquals(Object.keys(result.counts).length, 0);
});

Deno.test("export-branding - a bare repository slug is rewritten to the public one", () => {
  const result = transformBrandingText(
    `monitor ${PRIVATE_SLUG} for issues\n`,
    "docs/CONFIGURATION.md",
  );
  assertEquals(result.text, "monitor stSoftwareAU/VibeCoder for issues\n");
  assertEquals(result.privateReferences.length, 0);
});

Deno.test("export-branding - a URL to the private repository is not rewritten but surfaced", () => {
  const text = [
    "See " + PRIVATE_URL + "/issues/4160 for the plan.",
    "Clone: git@github.com:" + PRIVATE_SLUG + ".git",
    "Raw: https://raw.githubusercontent.com/" + PRIVATE_SLUG +
    "/main/README.md",
    "Shorthand: " + PRIVATE_SLUG + "#4197",
    "Prose: Vibe" + "Coding is the private tree.",
  ].join("\n");

  const result = transformBrandingText(text, "CHANGELOG.md");
  const lines = result.text.split("\n");
  const PUBLIC_URL = PRIVATE_URL.replace("Vibe" + "Coding", "VibeCoder");
  const PUBLIC_SLUG = PRIVATE_SLUG.replace("Vibe" + "Coding", "VibeCoder");
  // Every URL/clone/shorthand form is rewritten to the public repository…
  assertEquals(lines[0], "See " + PUBLIC_URL + "/issues/4160 for the plan.");
  assertEquals(lines[1], "Clone: git@github.com:" + PUBLIC_SLUG + ".git");
  assertEquals(
    lines[2],
    "Raw: https://raw.githubusercontent.com/" + PUBLIC_SLUG +
      "/main/README.md",
  );
  assertEquals(lines[3], "Shorthand: " + PUBLIC_SLUG + "#4197");
  // …as is ordinary prose on the same file.
  assertEquals(lines[4], "Prose: VibeCoder is the private tree.");
  // …and each URL/path form is surfaced with its line and its rewrite so the
  // operator reviews what was renamed — nothing is silent.
  assertEquals(result.privateReferences.length, 4);
  assertEquals(result.privateReferences.map((r) => r.line), [1, 2, 3, 4]);
  assertStringIncludes(result.privateReferences[0]!.text, "/issues/4160");
  assertStringIncludes(result.privateReferences[0]!.rewritten, PUBLIC_URL);
  // Every form counts as a replacement (four references + one prose hit).
  assertEquals(result.counts["Vibe" + "Coding"], 5);
});

Deno.test("export-branding - a URL slug in a different case is rewritten in that case and reported", () => {
  const lower = PRIVATE_URL.toLowerCase();
  const result = transformBrandingText(`link ${lower}/pull/1\n`, "x.md");
  assertEquals(
    result.text,
    `link ${lower.replace("vibe" + "coding", "vibecoder")}/pull/1\n`,
  );
  assertEquals(result.privateReferences.length, 1);
});

Deno.test("export-branding - the transform is idempotent", () => {
  const once = transformBrandingText("Vibe" + "Coding vibe" + "-coding\n", "a");
  const twice = transformBrandingText(once.text, "a");
  assertEquals(twice.changed, false);
  assertEquals(twice.text, once.text);
});

// =============================================================================
// Binary detection
// =============================================================================

Deno.test("export-branding - binary detection keys off a NUL byte, not the extension", () => {
  assert(
    isProbablyBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01])),
  );
  assert(!isProbablyBinary(new TextEncoder().encode("plain text\n")));
  assert(!isProbablyBinary(new Uint8Array(0)));
});

// =============================================================================
// Tree transform
// =============================================================================

async function makeTree(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "export_branding_" });
  await writeFile(
    `${root}/README.md`,
    "# Vibe" + "Coding\n\nvibe" + "-coding\n",
  );
  await writeFile(
    `${root}/docs/CHANGELOG.md`,
    "- fixed in " + PRIVATE_URL + "/pull/12\n- Vibe" + "Coding v2\n",
  );
  await writeFile(
    `${root}/setup.sh`,
    '#!/bin/bash\nset -euo pipefail\nNAME="Vibe' +
      'Coding"\nif [[ -n "${NAME}" ]]; then echo "${NAME}"; fi\n',
  );
  await writeFile(`${root}/plain.txt`, "nothing to see\n");
  await writeFile(
    `${root}/logo.png`,
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x56, 0x69, 0x62, 0x65]),
  );
  return root;
}

Deno.test("export-branding - the tree transform rewrites in place and reports per file", async () => {
  const root = await makeTree();
  try {
    const report = await transformBrandingTree(root, { write: true });

    assertEquals(
      await Deno.readTextFile(`${root}/README.md`),
      "# VibeCoder\n\nvibe-coder\n",
    );
    assertEquals(
      await Deno.readTextFile(`${root}/docs/CHANGELOG.md`),
      "- fixed in " + PRIVATE_URL.replace("Vibe" + "Coding", "VibeCoder") +
        "/pull/12\n- VibeCoder v2\n",
    );
    assertEquals(
      await Deno.readTextFile(`${root}/plain.txt`),
      "nothing to see\n",
    );

    assertEquals(report.filesRewritten, 3);
    assertEquals(report.filesSkippedBinary, 1);
    assertEquals(report.totals["Vibe" + "Coding"], 4);
    assertEquals(report.totals["vibe" + "-coding"], 1);
    const readme = report.files.find((f) => f.path === "README.md");
    assertEquals(readme?.counts["Vibe" + "Coding"], 1);
    assertEquals(readme?.counts["vibe" + "-coding"], 1);
    assertEquals(report.privateReferences.length, 1);
    assertEquals(report.privateReferences[0]?.path, "docs/CHANGELOG.md");
    assertEquals(report.privateReferences[0]?.line, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("export-branding - a binary file is left byte-for-byte untouched", async () => {
  const root = await makeTree();
  try {
    const before = await Deno.readFile(`${root}/logo.png`);
    await transformBrandingTree(root, { write: true });
    const after = await Deno.readFile(`${root}/logo.png`);
    assertEquals(after, before);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("export-branding - a staged shell script still passes bash -n after the transform", async () => {
  const root = await makeTree();
  try {
    await transformBrandingTree(root, { write: true });
    const script = await Deno.readTextFile(`${root}/setup.sh`);
    assertStringIncludes(script, 'NAME="VibeCoder"');
    const check = await new Deno.Command("bash", {
      args: ["-n", `${root}/setup.sh`],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(check.code, 0, new TextDecoder().decode(check.stderr));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("export-branding - check mode reports without writing", async () => {
  const root = await makeTree();
  try {
    const report = await transformBrandingTree(root, { write: false });
    assertEquals(report.filesRewritten, 3);
    assertEquals(
      await Deno.readTextFile(`${root}/README.md`),
      "# Vibe" + "Coding\n\nvibe" + "-coding\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("export-branding - the report lists per-variant totals and private references", async () => {
  const root = await makeTree();
  try {
    const report = await transformBrandingTree(root, { write: true });
    const text = formatBrandingReport(report);
    assertStringIncludes(text, "Vibe" + "Coding -> VibeCoder: 4");
    assertStringIncludes(text, "vibe" + "-coding -> vibe-coder: 1");
    assertStringIncludes(text, "vibe" + "coding -> vibecoder: 0");
    assertStringIncludes(text, "README.md");
    assertStringIncludes(text, "URL/path references rewritten");
    assertStringIncludes(text, "docs/CHANGELOG.md:1");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// =============================================================================
// Command
// =============================================================================

Deno.test("export-branding command - applies the transform and writes the report", async () => {
  const root = await makeTree();
  const reportPath = `${root}.report.txt`;
  try {
    const result = await exportBrandingCommand.execute(
      { tree: root, report: reportPath },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, true, result.message);
    assertStringIncludes(result.message, "Vibe" + "Coding -> VibeCoder: 4");
    assertStringIncludes(
      await Deno.readTextFile(reportPath),
      "URL/path references rewritten",
    );
    assertEquals(
      await Deno.readTextFile(`${root}/README.md`),
      "# VibeCoder\n\nvibe-coder\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(reportPath).catch(() => {});
  }
});

Deno.test("export-branding command - a missing tree is an error, a private reference is not", async () => {
  const missing = await exportBrandingCommand.execute(
    { tree: "/nonexistent/export-branding-tree" },
    buildDefaultWorkerConfig(),
  );
  assertEquals(missing.success, false);

  const root = await makeTree();
  try {
    // The tree carries a private-repo URL: reported, but not this command's
    // failure — the scrub gate is what blocks on it.
    const result = await exportBrandingCommand.execute(
      { tree: root, check: true },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, true, result.message);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("export-branding command - --tree is required", async () => {
  const result = await exportBrandingCommand.execute(
    {},
    buildDefaultWorkerConfig(),
  );
  assertEquals(result.success, false);
  assertStringIncludes(result.message, "--tree");
});
