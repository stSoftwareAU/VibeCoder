/**
 * Tests for the VibeCoder repository-readiness artefacts (Issue #4199, with
 * the public document set of Issue #4198).
 *
 * Phase 3 of #4160 ends with everything the public repository needs checked
 * in as reviewable configuration: the CI workflows the export ships, the
 * repository-settings checklist, the branding assets and the licence. These
 * tests are the failure detection the issue asks for:
 *
 *   1. `LICENSE` is byte-identical to the intended Apache-2.0 text — its
 *      SHA-256 equals the constant recorded in the readiness checklist.
 *   2. Every `uses:` in every exported workflow is a 40-character commit SHA.
 *   3. No exported workflow names a secret outside the small, documented set
 *      the public repository will actually have.
 *   4. The social preview is exactly 1280×640 and its SVG source shares that
 *      frame; the README's logo path is staged.
 *   5. The readiness checklist itself stays private (excluded from the export)
 *      and records the licence checksum and every optional secret.
 *
 * Every assertion runs against the STAGED tree produced by the real
 * `export-public.sh` over this repository's own manifest, not the private
 * tree — the export is what ships.
 *
 * Uses Australian English throughout (behaviour, licence, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  findUnpinnedUses,
  parseExclusionList,
  parsePublicManifest,
  pngDimensions,
  referencedSecrets,
  svgViewBox,
} from "../lib/public_export_manifest.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const SCRIPT_PATH = `${REPO_ROOT}export-public.sh`;
const READINESS_DOC = "docs/PUBLIC-REPO-READINESS.md";
const SOCIAL_PREVIEW = "docs/social/vibe-coder-social-preview";

/**
 * SHA-256 of the Apache License 2.0 text as GitHub's licence template ships
 * it (the placeholder already in the public repository). Recorded in the
 * readiness checklist; the two must agree.
 */
const LICENSE_SHA256 =
  "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4";

/**
 * Secrets an exported workflow may name. `GITHUB_TOKEN` always exists; the
 * other two are optional licences/tokens whose absence each workflow already
 * tolerates (gitleaks falls back to the free CLI, semgrep runs its bundled
 * ruleset). Anything else is private infrastructure and must not ship.
 */
const PUBLIC_SECRETS = [
  "GITHUB_TOKEN",
  "GITLEAKS_LICENSE",
  "SEMGREP_APP_TOKEN",
];

/** Workflows that must never be exported: private-site or operator wiring. */
const PRIVATE_ONLY_WORKFLOWS = [".github/workflows/pages.yml"];

const COMMIT_DATE = "2026-01-02T03:04:05+00:00";
const COMMIT_AUTHOR = "Vibe Coder <vibe-coder@example.invalid>";

interface RepoExport {
  staging: string;
  files: string[];
  output: string;
  code: number;
}

let repoExport: Promise<RepoExport> | null = null;

/** Stage this repository once with its committed manifest. */
function exportRepo(): Promise<RepoExport> {
  repoExport ??= (async () => {
    const staging = await Deno.makeTempDir({ prefix: "public_readiness_" });
    const command = new Deno.Command("bash", {
      args: [
        SCRIPT_PATH,
        "--staging",
        staging,
        "--commit-date",
        COMMIT_DATE,
        "--author",
        COMMIT_AUTHOR,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stdout, stderr } = await command.output();
    const output = new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr);
    let files: string[] = [];
    if (code === 0) {
      const ls = new Deno.Command("git", {
        args: ["-C", staging, "ls-files"],
        stdout: "piped",
        stderr: "piped",
      });
      files = new TextDecoder().decode((await ls.output()).stdout)
        .split("\n")
        .filter((line) => line.length > 0);
    } else if (
      output.includes("Scrub gate blocked the export") &&
      output.includes("verdict: BLOCKED")
    ) {
      // Until the private tree is scrubbed (later work under #4160) the
      // mandatory scrub gate (Issue #4196) blocks the real export. The staged
      // tree is left on disk unpublished, so the readiness checks read it
      // directly; any other failure is a real one and stays fatal.
      files = await walkTree(staging);
    }
    return { staging, files, output, code };
  })();
  return repoExport;
}

/** Every regular file beneath `root`, repo-relative, sorted. */
async function walkTree(root: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const item of Deno.readDir(`${root}/${prefix}`)) {
    const rel = prefix === "" ? item.name : `${prefix}/${item.name}`;
    if (item.isDirectory) out.push(...await walkTree(root, rel));
    else if (item.isFile) out.push(rel);
  }
  return out.sort();
}

/** The export must be clean, or blocked by the scrub gate alone. */
async function stagedExport(): Promise<RepoExport> {
  const result = await exportRepo();
  assert(
    result.code === 0 || result.files.length > 0,
    `real export failed for a reason other than the scrub gate (exit ${result.code})\n` +
      result.output,
  );
  return result;
}

function repoText(rel: string): string {
  return Deno.readTextFileSync(`${REPO_ROOT}${rel}`);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: `Deno.readFile` may hand back
  // an `ArrayBufferLike`, which `subtle.digest` does not accept.
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The exported workflow files, as staged paths. */
function exportedWorkflows(files: readonly string[]): string[] {
  return files.filter((rel) =>
    rel.startsWith(".github/workflows/") &&
    (rel.endsWith(".yml") || rel.endsWith(".yaml"))
  );
}

// =============================================================================
// Licence
// =============================================================================

Deno.test("readiness - the staged LICENSE is the intended Apache-2.0 text, byte for byte", async () => {
  const { staging, files } = await stagedExport();
  assert(files.includes("LICENSE"), "LICENSE is not staged");
  const bytes = await Deno.readFile(`${staging}/LICENSE`);
  assertEquals(
    await sha256Hex(bytes),
    LICENSE_SHA256,
    "LICENSE differs from the recorded Apache-2.0 checksum",
  );
  const text = new TextDecoder().decode(bytes);
  assertStringIncludes(text, "Apache License");
  assertStringIncludes(text, "Version 2.0");
  // The staged copy is the source copy — no transform touches the licence.
  assertEquals(text, repoText("LICENSE"));
});

Deno.test("readiness - the checklist records the LICENSE checksum the test pins", () => {
  const doc = repoText(READINESS_DOC);
  assertStringIncludes(doc, LICENSE_SHA256);
  assertStringIncludes(doc, "Apache-2.0");
});

// =============================================================================
// Exported workflows
// =============================================================================

Deno.test("readiness - the manifest ships the public CI workflows and withholds the private-only ones", async () => {
  const { files } = await stagedExport();
  const workflows = exportedWorkflows(files);
  for (
    const expected of [
      ".github/workflows/validate-scripts.yml",
      ".github/workflows/markdown-lint.yml",
      ".github/workflows/gitleaks.yml",
      ".github/workflows/semgrep.yml",
      ".github/workflows/dependency-audit.yml",
      ".github/workflows/container-build.yml",
      ".github/workflows/security-tabletop.yml",
    ]
  ) {
    assert(workflows.includes(expected), `${expected} is not exported`);
  }
  for (const withheld of PRIVATE_ONLY_WORKFLOWS) {
    assert(!workflows.includes(withheld), `${withheld} must not be exported`);
  }
  assert(
    !files.includes(".github/CODEOWNERS"),
    "CODEOWNERS names operator accounts and must not be exported",
  );
});

Deno.test("readiness - every uses: in every exported workflow is pinned to a 40-character commit SHA", async () => {
  const { staging, files } = await stagedExport();
  const workflows = exportedWorkflows(files);
  assert(workflows.length > 0, "no workflows are exported");
  const unpinned: string[] = [];
  for (const rel of workflows) {
    const text = await Deno.readTextFile(`${staging}/${rel}`);
    for (const hit of findUnpinnedUses(text)) {
      unpinned.push(`${rel}:${hit.line} ${hit.value}`);
    }
  }
  assertEquals(unpinned, [], "unpinned uses: in an exported workflow");
});

Deno.test("readiness - no exported workflow names a secret the public repository will not have", async () => {
  const { staging, files } = await stagedExport();
  const foreign: string[] = [];
  const optionalNamed = new Set<string>();
  for (const rel of exportedWorkflows(files)) {
    const text = await Deno.readTextFile(`${staging}/${rel}`);
    for (const name of referencedSecrets(text)) {
      if (!PUBLIC_SECRETS.includes(name)) foreign.push(`${rel}: ${name}`);
      if (name !== "GITHUB_TOKEN") optionalNamed.add(name);
    }
  }
  assertEquals(foreign, [], "an exported workflow names a private-only secret");
  // Every optional secret a shipped workflow can use is listed in the
  // checklist so the operator decides, knowingly, whether to provision it.
  const doc = repoText(READINESS_DOC);
  for (const name of optionalNamed) {
    assertStringIncludes(doc, name);
  }
});

Deno.test("readiness - the files the exported workflows run against are staged too", async () => {
  const { files } = await stagedExport();
  const staged = new Set(files);
  for (
    const needed of [
      ".github/scripts/deno-test-shard.sh",
      ".github/zizmor.yml",
      ".github/gitleaks.toml",
      ".github/dependabot.yml",
      ".github/security-tree-sweep-baseline.json",
      ".gitignore",
      ".deno-version",
      ".node-version",
      ".markdownlint-cli2.jsonc",
      "renovate.json",
      "quality.sh",
      "worker/deno/deno.json",
      "worker/deno/deno.lock",
      "worker/deno/mod.ts",
      "container/tools.json",
    ]
  ) {
    assert(staged.has(needed), `${needed} is referenced by CI but not staged`);
  }
});

// =============================================================================
// Branding assets
// =============================================================================

Deno.test("readiness - the social preview is exactly 1280x640 and its SVG source shares the frame", async () => {
  const { staging, files } = await stagedExport();
  assert(
    files.includes(`${SOCIAL_PREVIEW}.png`),
    "social preview PNG not staged",
  );
  assert(
    files.includes(`${SOCIAL_PREVIEW}.svg`),
    "social preview SVG not staged",
  );
  const png = pngDimensions(
    await Deno.readFile(`${staging}/${SOCIAL_PREVIEW}.png`),
  );
  assertEquals(png, { width: 1280, height: 640 });
  const svg = svgViewBox(
    await Deno.readTextFile(`${staging}/${SOCIAL_PREVIEW}.svg`),
  );
  assertEquals(svg, { width: 1280, height: 640 });
});

Deno.test("readiness - the public README's logo is staged with the README", async () => {
  const { staging, files } = await stagedExport();
  const readme = await Deno.readTextFile(`${staging}/README.md`);
  const src = readme.match(/<img[^>]*\ssrc="([^"]+)"/)?.[1];
  assert(src, "the public README must open with a logo <img>");
  assert(files.includes(src), `README logo ${src} is not staged`);
  const bytes = await Deno.readFile(`${staging}/${src}`);
  assert(pngDimensions(bytes) !== null, `${src} is not a PNG`);
});

// =============================================================================
// The readiness checklist itself
// =============================================================================

Deno.test("readiness - the checklist is operator-facing: excluded from the export and never staged", async () => {
  const { files } = await stagedExport();
  const exclusions = parseExclusionList(
    repoText("export/operator-docs-exclusions.txt"),
  );
  assert(exclusions.includes(READINESS_DOC), `${READINESS_DOC} not excluded`);
  assert(!files.includes(READINESS_DOC), `${READINESS_DOC} was staged`);
  // And it is not quietly listed in the manifest either.
  const listed = parsePublicManifest(repoText("export/public-manifest.txt"))
    .some((entry) => entry.source === READINESS_DOC);
  assert(!listed, `${READINESS_DOC} is listed in the manifest`);
});

Deno.test("readiness - the checklist covers every setting the issue names, with the command to apply it", () => {
  const doc = repoText(READINESS_DOC);
  for (
    const marker of [
      "default_branch",
      "sha_pinning_required",
      "allowed_actions",
      "default_workflow_permissions",
      "secret_scanning_push_protection",
      "private-vulnerability-reporting",
      "rulesets",
      "non_fast_forward",
      "required_status_checks",
      "has_wiki",
      "has_discussions",
      "topics",
      "Social preview",
      "vibe-coder-social-preview.png",
      "gh api",
    ]
  ) {
    assertStringIncludes(doc, marker);
  }
});
