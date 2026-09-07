/**
 * Tests for the export scrub gate (Issue #4196).
 *
 * The gate runs over the **staged export tree** and blocks the export on any
 * hit: operator account names, internal hostnames, telemetry identifiers,
 * e-mail addresses, API-key shapes, operator home paths, direct references
 * to private `stSoftwareAU` repositories, and branding residue the #4197
 * transform did not clear. Every finding reports path, line, class and a
 * **redacted** excerpt — never the matched value itself.
 *
 * Operator-specific identifiers come from a private-tree file
 * (`export/scrub-identifiers.txt`) so the gate's own source can be exported
 * without carrying them; the fixtures below therefore use invented
 * identifiers (`acme-ops-bot`, `HOST-42`, `TELEMETRY-HUB`). Generic-shape
 * fixtures (an e-mail, a home path, a key shape) are assembled at runtime
 * because this test file is itself exported and must not trip the gate.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyAllowlist,
  formatGateReport,
  gatePasses,
  maskMatch,
  parseAllowlist,
  parseIdentifiers,
  scanPath,
  scanText,
  scanTree,
} from "../lib/export_scrub_gate.ts";
import { exportScrubGateCommand } from "../commands/export_scrub_gate.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

/** Invented operator identifiers — nothing here names a real host or account. */
const IDENTIFIERS = `# Fixture identifiers
account: acme-ops-bot
hostname: /\\bHOST-\\d+\\b/
telemetry: /\\bTELEMETRY-HUB\\b/i
identifier: /\\bhub-widget-\\d+\\b/
public-repo: VibeCoder
`;

/** Runtime-assembled fixtures (see the header note). */
const FAKE_EMAIL = ["ops-person", "fixture.notreal"].join("@");
const HOME_PATH = ["/Users", "somebody", ".config.json"].join("/");
const LINUX_HOME = ["/home", "somebody", "work"].join("/");
// Assembled from short halves so neither this file nor the exported copy of
// it carries a 32-hex literal that a secret scanner would flag.
const IMGBB_KEY = ["01234567", "89abcdef"].join("").repeat(2);
const GITHUB_PAT = "ghp_" + "A".repeat(36);
const PRIVATE_SLUG = ["stSoftwareAU", "Vibe" + "Coding"].join("/");
const OTHER_PRIVATE = ["stSoftwareAU", "widget-internal"].join("/");

const parsed = parseIdentifiers(IDENTIFIERS);
const PATTERNS = parsed.patterns;
const PUBLIC = parsed.publicRepos;

function classes(text: string, path = "docs/x.md"): string[] {
  return scanText(text, path, PATTERNS, PUBLIC).map((f) => f.klass);
}

// =============================================================================
// Identifier file
// =============================================================================

Deno.test("scrub-gate - identifiers parse into classed patterns and public repos", () => {
  assertEquals(parsed.errors, []);
  assertEquals(PATTERNS.map((p) => p.klass), [
    "account",
    "hostname",
    "telemetry",
    "identifier",
  ]);
  assertEquals(PUBLIC, ["VibeCoder"]);
});

Deno.test("scrub-gate - an unknown class, a bad regex or an empty file is an error", () => {
  const unknown = parseIdentifiers("bogus: thing\n").errors;
  assert(unknown.some((e) => e.includes("bogus")), unknown.join("; "));
  assert(parseIdentifiers("hostname: /[unclosed/\n").errors.length >= 1);
  assert(parseIdentifiers("# only a comment\n").errors.length >= 1);
  assert(parseIdentifiers("public-repo: X\n").errors.length >= 1);
  assert(parseIdentifiers("account:\n").errors.length >= 1);
});

// =============================================================================
// Detection, one class at a time
// =============================================================================

Deno.test("scrub-gate - an operator account name is found (case-insensitive, whole word)", () => {
  assertEquals(classes("owned by acme-ops-bot today"), ["account"]);
  assertEquals(classes("owned by ACME-OPS-BOT today"), ["account"]);
  assertEquals(classes("acme-ops-bots is not it"), []);
});

Deno.test("scrub-gate - an internal hostname is found", () => {
  assertEquals(classes("deployed to HOST-42 overnight"), ["hostname"]);
  assertEquals(classes("HOSTNAME-42 is something else"), []);
});

Deno.test("scrub-gate - a telemetry identifier is found", () => {
  assertEquals(classes("push to telemetry-hub main"), ["telemetry"]);
  assertEquals(classes("hub-widget-7 wiring"), ["identifier"]);
});

Deno.test("scrub-gate - an e-mail address is found; reserved and noreply addresses are not", () => {
  assertEquals(classes(`contact ${FAKE_EMAIL} now`), ["email"]);
  assertEquals(classes("Co-Authored-By: Claude <noreply@anthropic.com>"), []);
  assertEquals(classes("git@github.com:owner/repo.git"), []);
  assertEquals(classes("user@example.com and root@localhost"), []);
  assertEquals(classes("Vibe Coder <vibe-coder@example.invalid>"), []);
  assertEquals(
    classes("uses actions/checkout@v4 and jsr:@std/assert@^1.0.18"),
    [],
  );
});

Deno.test("scrub-gate - an operator home path is found; placeholders are not", () => {
  assertEquals(classes(`cat ${HOME_PATH}`), ["home-path"]);
  assertEquals(classes(`cd ${LINUX_HOME}`), ["home-path"]);
  assertEquals(classes("/home/vibe/.vibe-coder and /Users/operator/x"), []);
  assertEquals(
    classes("/Users/<you>/src and /home/${USER}/x and /home/runner"),
    [],
  );
  assertEquals(classes("/Users/USERNAME/Library"), []);
});

Deno.test("scrub-gate - an imgbb-shaped key or a known token prefix is found", () => {
  assertEquals(classes(`IMGBB_API_KEY=${IMGBB_KEY}`), ["api-key"]);
  assertEquals(classes(`token: ${GITHUB_PAT}`), ["api-key"]);
  // A 40-hex git sha and a 64-hex digest are not 32-hex keys.
  assertEquals(
    classes("commit " + "a".repeat(40) + " sha256:" + "b".repeat(64)),
    [],
  );
});

Deno.test("scrub-gate - a private stSoftwareAU repository reference is found; the public one is not", () => {
  assertEquals(classes(`see https://github.com/${PRIVATE_SLUG}/issues/1`), [
    "private-repo",
  ]);
  assertEquals(classes(`clone ${OTHER_PRIVATE}`), ["private-repo"]);
  assertEquals(classes("see https://github.com/stSoftwareAU/VibeCoder"), []);
  assertEquals(classes("stSoftwareAU/VibeCoder#4160"), []);
  // Documentation placeholders name no repository.
  assertEquals(
    classes("e.g. `stSoftwareAU/foo#NNN` or stSoftwareAU/<repo>"),
    [],
  );
});

Deno.test("scrub-gate - branding residue the transform missed is found", () => {
  assertEquals(classes("still says Vibe" + "coding here"), [
    "branding-residue",
  ]);
  assertEquals(classes("VIBE_" + "CODING too"), ["branding-residue"]);
  // The generic phrase with a space is not the product name.
  assertEquals(classes("vibe coding is a way of working"), []);
});

Deno.test("scrub-gate - overlapping matches on one line are reported once, by the earlier class", () => {
  // The URL contains the private slug, which contains branding residue.
  const findings = scanText(
    `x https://github.com/${PRIVATE_SLUG}/pull/2 y`,
    "a.md",
    PATTERNS,
    PUBLIC,
  );
  assertEquals(findings.map((f) => f.klass), ["private-repo"]);
});

Deno.test("scrub-gate - concept-level mentions and clean text pass with zero findings", () => {
  assertEquals(
    classes(
      "The worker posts a heartbeat to a private telemetry repository owned by " +
        "the operator; the exported tree never names it.",
    ),
    [],
  );
  assertEquals(classes("# Vibe Coder\n\nRuns on your own machine.\n"), []);
});

Deno.test("scrub-gate - a staged path is scanned as well as its content", () => {
  const findings = scanPath("docs/acme-ops-bot-notes.md", PATTERNS, PUBLIC);
  assertEquals(findings.map((f) => f.klass), ["account"]);
  assertEquals(findings[0]?.line, 0);
});

// =============================================================================
// Redaction
// =============================================================================

Deno.test("scrub-gate - the mask never reproduces the matched value", () => {
  assertEquals(maskMatch("acme-ops-bot"), "ac…ot");
  assertEquals(maskMatch("HOST-42"), "HO…42");
  assertEquals(maskMatch("ab"), "a…");
  assertEquals(maskMatch(IMGBB_KEY).length, 5);
});

Deno.test("scrub-gate - findings carry line, class and a redacted excerpt only", () => {
  const line = `IMGBB_API_KEY=${IMGBB_KEY} # for acme-ops-bot`;
  const findings = scanText(`first\n${line}\n`, "setup.sh", PATTERNS, PUBLIC);
  assertEquals(findings.length, 2);
  for (const f of findings) {
    assertEquals(f.line, 2);
    assertEquals(f.path, "setup.sh");
    assert(
      !f.excerpt.includes(IMGBB_KEY),
      `excerpt leaks the key: ${f.excerpt}`,
    );
    assert(!f.excerpt.includes("acme-ops-bot"), `excerpt leaks: ${f.excerpt}`);
    assert(!f.masked.includes(IMGBB_KEY));
  }
  // The excerpt still shows enough context to locate the hit.
  assertStringIncludes(findings[0]!.excerpt, "IMGBB_API_KEY=");
});

// =============================================================================
// Allowlist
// =============================================================================

Deno.test("scrub-gate - an allowlist entry needs a justifying comment directly above it", () => {
  const good = parseAllowlist(
    "# The example operator handle in the usage doc is a placeholder\n" +
      "account docs/USAGE.md acme-ops-bot\n\n" +
      "# Whole fixture directory: gate self-tests\n" +
      "hostname worker/deno/tests/fixtures/ *\n",
  );
  assertEquals(good.errors, []);
  assertEquals(good.entries.length, 2);
  assertEquals(good.entries[0]?.klass, "account");
  assertEquals(good.entries[0]?.path, "docs/USAGE.md");
  assertEquals(good.entries[0]?.match, "acme-ops-bot");
  assertEquals(good.entries[1]?.match, "*");

  const bare = parseAllowlist("account docs/USAGE.md acme-ops-bot\n");
  assertEquals(bare.errors.length, 1);
  assertStringIncludes(bare.errors[0]!, "comment");

  // A comment separated from its entry by a blank line does not count.
  const gap = parseAllowlist(
    "# reason\n\naccount docs/USAGE.md acme-ops-bot\n",
  );
  assertEquals(gap.errors.length, 1);

  // Two entries under one comment: the second is unjustified.
  const shared = parseAllowlist(
    "# reason\naccount docs/A.md acme-ops-bot\naccount docs/B.md acme-ops-bot\n",
  );
  assertEquals(shared.errors.length, 1);
  assertStringIncludes(shared.errors[0]!, "line 3");
});

Deno.test("scrub-gate - malformed allowlist entries are errors, not silent exemptions", () => {
  assert(parseAllowlist("# r\nbogus-class docs/A.md x\n").errors.length >= 1);
  assert(parseAllowlist("# r\naccount docs/A.md\n").errors.length >= 1);
  assert(parseAllowlist("# r\naccount /abs/path.md x\n").errors.length >= 1);
  assert(parseAllowlist("# r\naccount docs/../x.md x\n").errors.length >= 1);
});

Deno.test("scrub-gate - the allowlist matches by class, path and value; unused entries are reported", () => {
  const findings = scanText(
    "acme-ops-bot and HOST-42\n",
    "docs/USAGE.md",
    PATTERNS,
    PUBLIC,
  );
  const { entries } = parseAllowlist(
    "# a\naccount docs/USAGE.md acme-ops-bot\n\n" +
      "# b: masked form is accepted too\nhostname docs/ HO…42\n\n" +
      "# c: never matches\naccount docs/OTHER.md acme-ops-bot\n",
  );
  const applied = applyAllowlist(findings, entries);
  assertEquals(applied.findings.map((f) => f.allowlisted), [true, true]);
  assertEquals(applied.unused.length, 1);
  assertEquals(applied.unused[0]?.path, "docs/OTHER.md");

  // A different class or path is not covered by the same entry.
  const other = scanText("acme-ops-bot\n", "docs/OTHER2.md", PATTERNS, PUBLIC);
  assertEquals(applyAllowlist(other, entries).findings[0]?.allowlisted, false);
});

// =============================================================================
// Tree scan and report
// =============================================================================

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

async function makeTree(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "export_scrub_gate_" });
  for (const [rel, body] of Object.entries(files)) {
    await writeFile(`${root}/${rel}`, body);
  }
  await writeFile(
    `${root}/img/logo.png`,
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x48, 0x4f, 0x53, 0x54]),
  );
  return root;
}

/**
 * Covers the synthetic PNG `makeTree` plants in every fixture tree. Since a
 * file the gate cannot decode is a blocking `binary-unscanned` finding, a
 * fixture that wants to exercise some *other* behaviour has to account for it
 * the same way a real export would: a reviewed allowlist entry naming it.
 */
const LOGO_ALLOWLIST =
  "# Reviewed: synthetic 9-byte PNG fixture, no shipped content\n" +
  "binary-unscanned img/logo.png *\n";

const CLEAN_TREE: Record<string, string> = {
  "README.md": "# Vibe Coder\n\nRuns on your own machine.\n",
  "docs/USAGE.md": "Run ./run.sh and watch the log.\n",
  "worker/deno/mod.ts": "export const version = 1;\n",
};

Deno.test("scrub-gate - a clean tree passes with zero blocking findings", async () => {
  const root = await makeTree(CLEAN_TREE);
  try {
    const report = await scanTree({
      tree: root,
      identifiersText: IDENTIFIERS,
      allowlistText: LOGO_ALLOWLIST,
    });
    assertEquals(report.errors, []);
    assertEquals(report.blocking, 0);
    assertEquals(report.filesScanned, 3);
    assertEquals(report.filesSkippedBinary, 1);
    assert(gatePasses(report));
    assertStringIncludes(formatGateReport(report), "0 blocking");
    assertStringIncludes(formatGateReport(report), "verdict: PASS");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// =============================================================================
// Coverage is part of the verdict (Issue #1265)
// =============================================================================

/**
 * A file the gate cannot decode, carrying a fixture identifier so the test can
 * prove the gate never saw it. The leading NUL is what makes the bytes
 * undecodable — the same heuristic git uses.
 */
const UNDECODABLE_BYTES = new TextEncoder().encode(
  `\u0000 host HOST-42 owner acme-ops-bot\n`,
);

/** Valid latin-1, invalid UTF-8, no NUL: undecodable for a different reason. */
const LATIN1_BYTES = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);

async function treeWithBlob(bytes: Uint8Array): Promise<string> {
  const root = await makeTree(CLEAN_TREE);
  await writeFile(`${root}/assets/blob.bin`, bytes);
  return root;
}

Deno.test("scrub-gate - a file the gate could not decode blocks, and the report names it", async () => {
  const root = await treeWithBlob(UNDECODABLE_BYTES);
  try {
    const report = await scanTree({
      tree: root,
      identifiersText: IDENTIFIERS,
      allowlistText: LOGO_ALLOWLIST,
    });
    assertEquals(report.errors, []);
    assertEquals(report.filesSkippedBinary, 2);
    assertEquals(report.perClass["binary-unscanned"], 1);
    assertEquals(report.blocking, 1);
    assert(!gatePasses(report), "an unscanned file must never pass the gate");

    const text = formatGateReport(report);
    assertStringIncludes(text, "verdict: BLOCKED");
    assertStringIncludes(text, "[binary-unscanned] assets/blob.bin");
    // The gate never opened the file, so nothing inside it reaches the report.
    assert(!text.includes("HOST-42"));
    assert(!text.includes("acme-ops-bot"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scrub-gate - non-UTF-8 text blocks the same way a binary file does", async () => {
  const root = await treeWithBlob(LATIN1_BYTES);
  try {
    const report = await scanTree({
      tree: root,
      identifiersText: IDENTIFIERS,
      allowlistText: LOGO_ALLOWLIST,
    });
    assertEquals(report.perClass["binary-unscanned"], 1);
    assert(!gatePasses(report));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scrub-gate - a reviewed allowlist entry is the only way an unscanned file passes", async () => {
  const root = await treeWithBlob(UNDECODABLE_BYTES);
  try {
    const allowed = await scanTree({
      tree: root,
      identifiersText: IDENTIFIERS,
      allowlistText: LOGO_ALLOWLIST +
        "# Reviewed: synthetic fixture blob, reviewed byte by byte\n" +
        "binary-unscanned assets/blob.bin *\n",
    });
    assertEquals(allowed.errors, []);
    assertEquals(allowed.blocking, 0);
    assertEquals(allowed.allowlisted, 2);
    assert(gatePasses(allowed));
    assertStringIncludes(formatGateReport(allowed), "verdict: PASS");

    // An entry for a different path does not cover it.
    const elsewhere = await scanTree({
      tree: root,
      identifiersText: IDENTIFIERS,
      allowlistText: LOGO_ALLOWLIST +
        "# Reviewed: names a path that is not the blob\n" +
        "binary-unscanned assets/other.bin *\n",
    });
    assertEquals(elsewhere.blocking, 1);
    assert(!gatePasses(elsewhere));

    // An entry without a justifying comment is a gate error, not an exemption.
    const unjustified = await scanTree({
      tree: root,
      identifiersText: IDENTIFIERS,
      allowlistText: LOGO_ALLOWLIST + "binary-unscanned assets/blob.bin *\n",
    });
    assert(unjustified.errors.length >= 1);
    assert(!gatePasses(unjustified));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scrub-gate - a skipped file that raised no finding cannot report PASS", () => {
  // Defends the invariant directly: even a report assembled with the counter
  // set and no matching finding must not read as a pass.
  const report = {
    tree: "/staged",
    filesScanned: 3,
    filesSkippedBinary: 1,
    findings: [],
    blocking: 0,
    allowlisted: 0,
    errors: [],
    allowlistEntries: 0,
    unusedAllowlist: [],
    perClass: {},
    perTopDir: {},
  };
  assert(!gatePasses(report), "unaccounted coverage must not read as a pass");
});

Deno.test("scrub-gate - one planted value per class blocks with a distinct class label", async () => {
  const root = await makeTree({
    ...CLEAN_TREE,
    "docs/A.md": "owner acme-ops-bot\n",
    "docs/B.md": "host HOST-42\n",
    "docs/C.md": `mail ${FAKE_EMAIL}\n`,
    "docs/D.md": `key ${IMGBB_KEY}\n`,
    "docs/E.md": `path ${HOME_PATH}\n`,
    "worker/F.ts": `// see https://github.com/${OTHER_PRIVATE}\n`,
  });
  try {
    const report = await scanTree({
      tree: root,
      identifiersText: IDENTIFIERS,
      allowlistText: LOGO_ALLOWLIST,
    });
    assertEquals(report.blocking, 6);
    assertEquals(report.perClass["account"], 1);
    assertEquals(report.perClass["hostname"], 1);
    assertEquals(report.perClass["email"], 1);
    assertEquals(report.perClass["api-key"], 1);
    assertEquals(report.perClass["home-path"], 1);
    assertEquals(report.perClass["private-repo"], 1);
    // Per top-level directory, per class — for the operator's summary.
    assertEquals(report.perTopDir["docs"]?.["email"], 1);
    assertEquals(report.perTopDir["worker"]?.["private-repo"], 1);

    const text = formatGateReport(report);
    assertStringIncludes(text, "[account] docs/A.md:1");
    assertStringIncludes(text, "[hostname] docs/B.md:1");
    assertStringIncludes(text, "[email] docs/C.md:1");
    assertStringIncludes(text, "[api-key] docs/D.md:1");
    assertStringIncludes(text, "[home-path] docs/E.md:1");
    assertStringIncludes(text, "[private-repo] worker/F.ts:1");
    // The report never reproduces a matched value.
    for (
      const raw of [
        FAKE_EMAIL,
        IMGBB_KEY,
        HOME_PATH,
        OTHER_PRIVATE,
        "HOST-42",
        "acme-ops-bot",
      ]
    ) {
      assert(!text.includes(raw), `report leaks ${raw}`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scrub-gate - an allowlisted finding does not block; an unjustified entry fails the gate", async () => {
  const root = await makeTree({
    ...CLEAN_TREE,
    "docs/A.md": "owner acme-ops-bot\n",
  });
  try {
    const ok = await scanTree({
      tree: root,
      identifiersText: IDENTIFIERS,
      allowlistText: LOGO_ALLOWLIST +
        "# Reviewed: illustrative handle in the usage example\n" +
        "account docs/A.md acme-ops-bot\n",
    });
    assertEquals(ok.errors, []);
    assertEquals(ok.blocking, 0);
    assertEquals(ok.allowlisted, 2);
    assertStringIncludes(formatGateReport(ok), "allowlisted");

    const bad = await scanTree({
      tree: root,
      identifiersText: IDENTIFIERS,
      allowlistText: "account docs/A.md acme-ops-bot\n",
    });
    assert(bad.errors.length >= 1);
    assertStringIncludes(bad.errors[0]!, "comment");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scrub-gate - an empty identifiers file is a gate error, never a weaker gate", async () => {
  const root = await makeTree(CLEAN_TREE);
  try {
    const report = await scanTree({
      tree: root,
      identifiersText: "# nothing\n",
    });
    assert(report.errors.length >= 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// =============================================================================
// Command
// =============================================================================

Deno.test("scrub-gate command - exits non-zero on a finding and writes the report", async () => {
  const root = await makeTree({ ...CLEAN_TREE, "docs/B.md": "host HOST-42\n" });
  const identifiers = `${root}.identifiers.txt`;
  const reportPath = `${root}.report.txt`;
  await Deno.writeTextFile(identifiers, IDENTIFIERS);
  try {
    const result = await exportScrubGateCommand.execute(
      { tree: root, identifiers, report: reportPath },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    assertStringIncludes(result.message, "[hostname] docs/B.md:1");
    assert(!result.message.includes("HOST-42"));
    assertStringIncludes(await Deno.readTextFile(reportPath), "[hostname]");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(identifiers);
    await Deno.remove(reportPath).catch(() => {});
  }
});

Deno.test("scrub-gate command - a clean tree passes; missing inputs fail loud", async () => {
  const root = await makeTree(CLEAN_TREE);
  const identifiers = `${root}.identifiers.txt`;
  const allowlist = `${root}.allowlist.txt`;
  await Deno.writeTextFile(identifiers, IDENTIFIERS);
  await Deno.writeTextFile(allowlist, LOGO_ALLOWLIST);
  try {
    const ok = await exportScrubGateCommand.execute(
      { tree: root, identifiers, allowlist },
      buildDefaultWorkerConfig(),
    );
    assertEquals(ok.success, true, ok.message);

    const noTree = await exportScrubGateCommand.execute(
      { identifiers },
      buildDefaultWorkerConfig(),
    );
    assertEquals(noTree.success, false);
    assertStringIncludes(noTree.message, "--tree");

    const noIdentifiers = await exportScrubGateCommand.execute(
      { tree: root },
      buildDefaultWorkerConfig(),
    );
    assertEquals(noIdentifiers.success, false);
    assertStringIncludes(noIdentifiers.message, "--identifiers");

    const missingAllowlist = await exportScrubGateCommand.execute(
      { tree: root, identifiers, allowlist: `${root}/no-such-allowlist.txt` },
      buildDefaultWorkerConfig(),
    );
    assertEquals(missingAllowlist.success, false);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(identifiers);
    await Deno.remove(allowlist);
  }
});

Deno.test("scrub-gate command - an undecodable staged file fails the run, and passes only once allowlisted", async () => {
  const root = await treeWithBlob(UNDECODABLE_BYTES);
  const identifiers = `${root}.identifiers.txt`;
  const allowlist = `${root}.allowlist.txt`;
  const reportPath = `${root}.report.txt`;
  await Deno.writeTextFile(identifiers, IDENTIFIERS);
  await Deno.writeTextFile(allowlist, LOGO_ALLOWLIST);
  try {
    const blocked = await exportScrubGateCommand.execute(
      { tree: root, identifiers, allowlist, report: reportPath },
      buildDefaultWorkerConfig(),
    );
    assertEquals(blocked.success, false);
    assertStringIncludes(blocked.message, "[binary-unscanned] assets/blob.bin");
    assert(!blocked.message.includes("HOST-42"));
    assertStringIncludes(
      await Deno.readTextFile(reportPath),
      "binary-unscanned",
    );

    await Deno.writeTextFile(
      allowlist,
      LOGO_ALLOWLIST +
        "# Reviewed: synthetic fixture blob, reviewed byte by byte\n" +
        "binary-unscanned assets/blob.bin *\n",
    );
    const passed = await exportScrubGateCommand.execute(
      { tree: root, identifiers, allowlist },
      buildDefaultWorkerConfig(),
    );
    assertEquals(passed.success, true, passed.message);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(identifiers);
    await Deno.remove(allowlist);
    await Deno.remove(reportPath).catch(() => {});
  }
});

Deno.test("scrub-gate command - there is no bypass flag", async () => {
  const root = await makeTree({ ...CLEAN_TREE, "docs/B.md": "host HOST-42\n" });
  const identifiers = `${root}.identifiers.txt`;
  await Deno.writeTextFile(identifiers, IDENTIFIERS);
  try {
    for (
      const flag of [
        "force",
        "skip",
        "no-fail",
        "bypass",
        "allow-findings",
        "warn-only",
      ]
    ) {
      const result = await exportScrubGateCommand.execute(
        { tree: root, identifiers, [flag]: true },
        buildDefaultWorkerConfig(),
      );
      assertEquals(result.success, false, `--${flag} bypassed the gate`);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(identifiers);
  }
});
