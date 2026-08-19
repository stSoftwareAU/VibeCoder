/**
 * Documentation-drift tests for Issue #3597 — the SARIF code-scanning
 * publishing surface (Issue #3538) must be captured in the security-scan
 * operator manual, not only in the pr-summaries archive.
 *
 * These tests drive the real emitter/builder with injected stubs and assert
 * that the values the manual quotes (status lines, tool driver name, SARIF
 * version, CWE tag shape, severity mapping, upload endpoint) match what the
 * code actually produces — so a code change and its manual must move
 * together. They assert against real outputs rather than grepping prose
 * wording, so a harmless reword never reddens the suite (Issue #3264).
 *
 * Australian English spelling used throughout (behaviour, normalise).
 */

import { assert } from "@std/assert";
import { emitSecuritySarif } from "../lib/security_sarif_emit.ts";
import {
  buildSecuritySarif,
  extractCwe,
  SARIF_TOOL_NAME,
  type SecuritySarifFinding,
  type SecuritySeverity,
  severityToLevel,
  severityToScore,
} from "../lib/security_sarif.ts";

// tests/ → worker/deno/ → worker/ → repo root
const REPO_ROOT = new URL("../../../", import.meta.url);
const MANUAL_PATH = "docs/SECURITY-SCAN.md";

async function readManual(): Promise<string> {
  return await Deno.readTextFile(new URL(MANUAL_PATH, REPO_ROOT));
}

/** One filed issue carrying both markers, enough to build a real finding. */
const FILED_ISSUE = {
  number: 42,
  title: "🟠 injection:SQL in src/api/orders.ts:47",
  body: "<!-- finding-id: SEC-abc123 -->\n<!-- cwe: CWE-89 -->\nprose",
  labels: [{ name: "security" }, { name: "severity:high" }],
};

const GIT_OK = (args: string[]) =>
  Promise.resolve({
    code: 0,
    stdout: args[0] === "rev-parse" ? "a".repeat(40) : "refs/heads/main",
    stderr: "",
  });

const LIST_ONE = () => Promise.resolve(JSON.stringify([FILED_ISSUE]));

Deno.test("SECURITY-SCAN.md documents the SARIF status lines the emitter produces", async () => {
  const manual = await readManual();

  const uploaded = await emitSecuritySarif(
    { repo: "o/r", checkoutDir: "/tmp/r", newlyFiled: [42] },
    {
      ghListFn: LIST_ONE,
      ghExecFn: () => Promise.resolve(JSON.stringify({ id: "sarif-1" })),
      runGitFn: GIT_OK,
    },
  );
  const unavailable = await emitSecuritySarif(
    { repo: "o/r", checkoutDir: "/tmp/r", newlyFiled: [42] },
    {
      ghListFn: LIST_ONE,
      ghExecFn: () => Promise.reject(new Error("gh: HTTP 403 forbidden")),
      runGitFn: GIT_OK,
    },
  );
  const skipped = await emitSecuritySarif(
    { repo: "o/r", checkoutDir: "/tmp/r", newlyFiled: [] },
    { ghListFn: LIST_ONE },
  );

  // The uploaded line carries a run-specific count; document its stable stem.
  assert(
    uploaded.summary.startsWith("SARIF: uploaded "),
    `emitter changed its uploaded status line: ${uploaded.summary}`,
  );
  assert(
    manual.includes("SARIF: uploaded "),
    `${MANUAL_PATH} must document the "SARIF: uploaded …" status line`,
  );
  assert(
    manual.includes(unavailable.summary.split(" (HTTP")[0] ?? ""),
    `${MANUAL_PATH} must document "${unavailable.summary}"`,
  );
  assert(
    manual.includes(skipped.summary),
    `${MANUAL_PATH} must document "${skipped.summary}"`,
  );
  assert(
    manual.includes("SARIF: upload failed"),
    `${MANUAL_PATH} must document the hard-failure status line`,
  );
});

Deno.test("SECURITY-SCAN.md documents the SARIF document shape actually built", async () => {
  const manual = await readManual();
  const finding: SecuritySarifFinding = {
    findingId: "SEC-abc123",
    cwe: "CWE-89",
    severity: "high",
    message: "injection:SQL in src/api/orders.ts:47",
    file: "src/api/orders.ts",
    startLine: 47,
  };
  const sarif = buildSecuritySarif([finding]);
  const run = sarif.runs[0] as {
    tool: {
      driver: {
        name: string;
        rules: Array<{ properties: { tags: string[] } }>;
      };
    };
  };
  const driver = run.tool.driver;
  const cweTag =
    driver.rules[0]?.properties.tags.find((t) => t.startsWith("external/")) ??
      "";

  assert(cweTag, "builder must emit an external/cwe tag when a CWE is present");
  assert(
    manual.includes(sarif.version),
    `${MANUAL_PATH} must document SARIF version ${sarif.version}`,
  );
  assert(
    manual.includes(driver.name) && driver.name === SARIF_TOOL_NAME,
    `${MANUAL_PATH} must name the tool driver ${SARIF_TOOL_NAME}`,
  );
  // The manual documents the tag family (`…cwe-<n>`), not one concrete CWE.
  const cweTagPrefix = cweTag.replace(/\d+$/, "");
  assert(
    manual.includes(cweTagPrefix),
    `${MANUAL_PATH} must document the CWE tag shape ${cweTagPrefix}<n>`,
  );
  assert(
    manual.includes("security-severity"),
    `${MANUAL_PATH} must document the GHAS security-severity property`,
  );
});

Deno.test("SECURITY-SCAN.md's CWE-marker claim matches the security_scan prompts", async () => {
  const manual = await readManual();

  // The manual must name the first prompt version that emits the marker
  // (Issue #3619 replaced the "no version emits it yet" caveat with a claim).
  const claim = /`security_scan`[^.]{0,160}?\bv(\d+)\b[^.]{0,160}?onward/i
    .exec(manual);
  assert(
    claim,
    `${MANUAL_PATH} must name the security_scan version from which the CWE marker is emitted`,
  );
  const firstEmitting = Number(claim[1]);

  const versions: number[] = [];
  const promptDir = new URL("prompts/security_scan/", REPO_ROOT);
  for await (const entry of Deno.readDir(promptDir)) {
    const match = /^v(\d+)\.md$/.exec(entry.name);
    if (match) versions.push(Number(match[1]));
  }
  assert(
    versions.includes(firstEmitting),
    `prompts/security_scan/v${firstEmitting}.md must exist to back the manual's claim`,
  );

  // Every version from the claimed one onward must show a concrete marker
  // that the real parser reads back as a CWE id — otherwise the claim is false.
  for (const version of versions.filter((n) => n >= firstEmitting)) {
    const prompt = await Deno.readTextFile(
      new URL(`v${version}.md`, promptDir),
    );
    const example = /<!--\s*cwe:\s*CWE-\d+\s*-->/i.exec(prompt);
    assert(
      example,
      `prompts/security_scan/v${version}.md must show a concrete <!-- cwe: CWE-<n> --> marker`,
    );
    assert(
      extractCwe(example[0]),
      `the v${version} marker example must parse back to a CWE id`,
    );
  }
});

Deno.test("SECURITY-SCAN.md severity mapping matches severityToLevel/Score", async () => {
  const manual = await readManual();
  const severities: SecuritySeverity[] = ["critical", "high", "medium", "low"];
  for (const severity of severities) {
    const row = new RegExp(
      `\\|\\s*\`?${severity}\`?\\s*\\|[^|]*\`?${
        severityToLevel(severity)
      }\`?[^|]*\\|[^|]*${severityToScore(severity)}`,
      "i",
    );
    assert(
      row.test(manual),
      `${MANUAL_PATH} must map ${severity} → ${severityToLevel(severity)} / ${
        severityToScore(severity)
      }`,
    );
  }
});

Deno.test("SECURITY-SCAN.md documents the per-repo upload endpoint and modules", async () => {
  const manual = await readManual();
  for (
    const module of [
      "security_sarif.ts",
      "security_sarif_upload.ts",
      "security_sarif_emit.ts",
    ]
  ) {
    assert(
      manual.includes(module),
      `${MANUAL_PATH} must reference ${module}`,
    );
    // The linked module must actually exist.
    const stat = await Deno.stat(
      new URL(`worker/deno/lib/${module}`, REPO_ROOT),
    );
    assert(stat.isFile, `worker/deno/lib/${module} must exist`);
  }
  assert(
    manual.includes("code-scanning/sarifs"),
    `${MANUAL_PATH} must document the per-repo code-scanning/sarifs endpoint`,
  );
  assert(
    manual.includes("alert-feed"),
    `${MANUAL_PATH} must document the dedup interaction with the alert-feed idle task`,
  );
});

Deno.test("pr-summary-3538 learnings are absorbed, so the archived summary is gone", async () => {
  await assertMissing("docs/archive/pr-summaries/pr-summary-3538.md");
});

async function assertMissing(relative: string): Promise<void> {
  try {
    await Deno.stat(new URL(relative, REPO_ROOT));
  } catch (err) {
    assert(err instanceof Deno.errors.NotFound, `unexpected error: ${err}`);
    return;
  }
  throw new Error(`${relative} must be removed once absorbed into the manual`);
}
