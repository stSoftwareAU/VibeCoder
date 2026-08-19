/**
 * Tests for `export-public.sh` (Issue #4195).
 *
 * Phase 3 of the clean-publish plan (#4160) needs a repeatable export: the
 * publishable subset of this private tree materialised into a staging
 * directory with brand-new history, one initial commit, no remote, and no
 * push — so the export can be scanned before it ever leaves the machine.
 *
 * Every test drives the real script over a fixture tree and asserts on the
 * observable outcome: the exit code, the summary printed for the operator,
 * and the state of the staged git repository (`git ls-files`, `git remote`,
 * `git rev-list --count HEAD`). Nothing here inspects the script's source.
 *
 * The script's mandatory branding transform (Issue #4197) and scrub gate
 * (Issue #4196) are Deno worker commands, so every run points `--worker-dir`
 * at this checkout's worker while sourcing the fixture tree; the fixture
 * carries its own invented `export/scrub-identifiers.txt`. Fixtures that must
 * trip the gate are assembled at runtime because this test file is itself
 * exported and must not carry those shapes.
 *
 * The tests over the repository's own manifest (Issues #4198, #4199) stage
 * the real tree once and assert on what landed: the public document set from
 * `docs/public/` at the published root, and none of the operator documents
 * named in `export/operator-docs-exclusions.txt`. Until the private tree is
 * scrubbed (later work under #4160) the mandatory gate blocks that export;
 * the staged tree is still on disk, so those tests read it directly and only
 * accept "clean" or "blocked by the scrub gate alone" — never a staging,
 * branding or commit failure.
 *
 * Uses Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { anchorSet } from "../lib/markdown_anchors.ts";
import {
  isExcludedPath,
  parseExclusionList,
  parsePublicManifest,
  relativeLinkTargets,
  stagedPathFor,
} from "../lib/public_export_manifest.ts";

const SCRIPT_PATH = new URL("../../../export-public.sh", import.meta.url)
  .pathname;
/** This checkout's worker, used to run the branding and scrub-gate stages. */
const WORKER_DIR = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

/** Invented scrub-gate identifiers for the fixture tree. */
const FIXTURE_IDENTIFIERS = `# fixture identifiers
account: acme-ops-bot
hostname: /\\bHOST-\\d+\\b/
public-repo: VibeCoder
`;

/** Invented redaction rules for the fixture tree (Issues #4196, #4197). */
const FIXTURE_REDACTIONS = `# fixture redactions
account: acme-legacy-bot -> acme-bot
hostname: /\\bLEGACY-(\\d+)\\b/ -> host-$1
private-repo: * -> example-org/private-repo-{n}
rename: fleet -> fleet
`;

/** Runtime-assembled values that must trip the gate (see the header note). */
const FAKE_EMAIL = ["ops-person", "fixture.notreal"].join("@");
const HOME_PATH = ["/Users", "somebody", ".config.json"].join("/");
// Assembled from short halves so neither this file nor the exported copy of
// it carries a 32-hex literal that a secret scanner would flag.
const IMGBB_KEY = ["01234567", "89abcdef"].join("").repeat(2);
const PRIVATE_URL = "https://github.com/" +
  ["stSoftwareAU", "Vibe" + "Coding"].join("/");

/** Fixed commit metadata — the export must never read the clock. */
const COMMIT_DATE = "2026-01-02T03:04:05+00:00";
const COMMIT_AUTHOR = "Vibe Coder <vibe-coder@example.invalid>";

interface Harness {
  root: string;
  source: string;
  manifest: string;
  staging: string;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Files every fixture tree starts with, keyed by repo-relative path. */
const FIXTURE_FILES: Record<string, string> = {
  "README.md": "# Fixture\n",
  "LICENSE": "Apache-2.0\n",
  "worker/deno/mod.ts": "export const version = 1;\n",
  "worker/deno/lib/fleet_health.ts": "export const fleetHealth = true;\n",
  "docs/OVERVIEW.md": "# Overview\n",
  "docs/FLEET-HEALTH.md": "# FLEET health\n",
  "docs/FLEET-HOSTS.md": "# Fleet hosts\n",
  "docs/archive/pr-summaries/pr-summary-1.md": "# PR summary\n",
  "docs/evidence/screenshot.txt": "evidence\n",
  "docs/audits/audit-1.md": "# Audit\n",
  ".config.json": '{"repos":["example-org/private-repo-45"]}\n',
  "internal-notes.md": "operator only\n",
  "export/scrub-identifiers.txt": FIXTURE_IDENTIFIERS,
  "export/scrub-redactions.txt": FIXTURE_REDACTIONS,
};

/**
 * A manifest that deliberately lists two hard-denied paths (`docs/` pulls in
 * `pr-summaries`/`evidence`/`audits`, and `.config.json` is listed outright)
 * so the hard-deny gate is exercised, not assumed.
 */
const FIXTURE_MANIFEST = `# version: 1
# Fixture manifest.
README.md
LICENSE
worker/
docs/
.config.json
`;

async function makeHarness(
  files: Record<string, string> = FIXTURE_FILES,
  manifest: string = FIXTURE_MANIFEST,
): Promise<Harness> {
  const root = await Deno.makeTempDir({ prefix: "export_public_" });
  const source = `${root}/source`;
  for (const [rel, body] of Object.entries(files)) {
    await writeFile(`${source}/${rel}`, body);
  }
  const manifestPath = `${root}/manifest.txt`;
  await Deno.writeTextFile(manifestPath, manifest);
  return { root, source, manifest: manifestPath, staging: `${root}/staging` };
}

async function writeFile(path: string, body: string): Promise<void> {
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, body);
}

async function runExport(
  harness: Harness,
  extraArgs: string[] = [],
): Promise<Run> {
  const command = new Deno.Command("bash", {
    args: [
      SCRIPT_PATH,
      "--source",
      harness.source,
      "--manifest",
      harness.manifest,
      "--staging",
      harness.staging,
      "--commit-date",
      COMMIT_DATE,
      "--author",
      COMMIT_AUTHOR,
      "--worker-dir",
      WORKER_DIR,
      ...extraArgs,
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  return {
    code,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
  };
}

/** Run a git command inside the staged repository. */
async function git(staging: string, ...args: string[]): Promise<string> {
  const command = new Deno.Command("git", {
    args: ["-C", staging, ...args],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout);
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${code}): ${
        new TextDecoder().decode(stderr)
      }`,
    );
  }
  return out;
}

async function stagedFiles(staging: string): Promise<string[]> {
  const out = await git(staging, "ls-files");
  return out.split("\n").filter((line) => line.length > 0);
}

async function cleanUp(harness: Harness): Promise<void> {
  await Deno.remove(harness.root, { recursive: true });
}

// =============================================================================
// Allowlist behaviour
// =============================================================================

Deno.test("export-public - listed files are exported, unlisted ones are not", async () => {
  const harness = await makeHarness();
  try {
    const run = await runExport(harness);
    assertEquals(run.code, 0, run.stdout + run.stderr);

    const files = await stagedFiles(harness.staging);
    assert(files.includes("README.md"), `README.md missing from ${files}`);
    assert(files.includes("LICENSE"));
    assert(files.includes("worker/deno/mod.ts"));
    assert(files.includes("docs/OVERVIEW.md"));
    // Unlisted: present in the source tree, absent from the export.
    assert(
      !files.includes("internal-notes.md"),
      "an unlisted file reached the export",
    );
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - adding a new unlisted file does not change the export", async () => {
  const harness = await makeHarness();
  try {
    const first = await runExport(harness);
    assertEquals(first.code, 0, first.stdout + first.stderr);
    const before = await git(harness.staging, "rev-parse", "HEAD");

    await writeFile(`${harness.source}/brand-new-secret.md`, "leak me\n");
    await writeFile(`${harness.source}/nested/also-new.md`, "leak me too\n");

    const second = await runExport(harness);
    assertEquals(second.code, 0, second.stdout + second.stderr);
    const after = await git(harness.staging, "rev-parse", "HEAD");

    assertEquals(after, before, "an unlisted file changed the exported tree");
    const files = await stagedFiles(harness.staging);
    assert(!files.includes("brand-new-secret.md"));
    assert(!files.includes("nested/also-new.md"));
  } finally {
    await cleanUp(harness);
  }
});

// =============================================================================
// Hard-deny gate
// =============================================================================

Deno.test("export-public - hard-denied paths are excluded even when the manifest lists them", async () => {
  const harness = await makeHarness();
  try {
    const run = await runExport(harness);
    assertEquals(run.code, 0, run.stdout + run.stderr);

    const files = await stagedFiles(harness.staging);
    for (
      const denied of [
        "docs/archive/pr-summaries/pr-summary-1.md",
        "docs/evidence/screenshot.txt",
        "docs/audits/audit-1.md",
        "docs/FLEET-HEALTH.md",
        "docs/FLEET-HOSTS.md",
        ".config.json",
      ]
    ) {
      assert(
        !files.includes(denied),
        `hard-denied path reached the export: ${denied}`,
      );
    }
    // The fleet-health *module* is exported under its public name — the
    // redaction stage's rename rule renames the file and every reference —
    // so the published worker still builds; only the FLEET *documents* are
    // hard-denied (they are operator runbooks).
    assert(
      !files.includes("worker/deno/lib/fleet_health.ts"),
      "the private module name must not survive",
    );
    assert(
      files.includes("worker/deno/lib/fleet_health.ts"),
      `renamed module missing from ${files}`,
    );
    // The operator is told what was withheld rather than it happening silently.
    assertStringIncludes(run.stdout, "Hard-denied:");
    assertStringIncludes(run.stdout, "docs/evidence/screenshot.txt");
  } finally {
    await cleanUp(harness);
  }
});

// =============================================================================
// Idempotency
// =============================================================================

Deno.test("export-public - two consecutive runs produce an identical tree", async () => {
  const harness = await makeHarness();
  try {
    const first = await runExport(harness);
    assertEquals(first.code, 0, first.stdout + first.stderr);
    const firstCommit = await git(harness.staging, "rev-parse", "HEAD");
    const firstTree = await git(harness.staging, "ls-tree", "-r", "HEAD");

    const second = await runExport(harness);
    assertEquals(second.code, 0, second.stdout + second.stderr);
    const secondCommit = await git(harness.staging, "rev-parse", "HEAD");
    const secondTree = await git(harness.staging, "ls-tree", "-r", "HEAD");

    assertEquals(secondCommit, firstCommit, "commit id was not reproducible");
    assertEquals(secondTree, firstTree);
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - the commit date comes from the argument, not the clock", async () => {
  const harness = await makeHarness();
  try {
    assertEquals((await runExport(harness)).code, 0);
    const expected = String(Date.parse(COMMIT_DATE) / 1000);
    const author = await git(harness.staging, "log", "-1", "--format=%at");
    assertEquals(author.trim(), expected);
    const committer = await git(harness.staging, "log", "-1", "--format=%ct");
    assertEquals(committer.trim(), expected);
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - a missing commit date fails loud", async () => {
  const harness = await makeHarness();
  try {
    const command = new Deno.Command("bash", {
      args: [
        SCRIPT_PATH,
        "--source",
        harness.source,
        "--manifest",
        harness.manifest,
        "--staging",
        harness.staging,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await command.output();
    assert(code !== 0, "a missing --commit-date must not succeed");
    assertStringIncludes(new TextDecoder().decode(stderr), "--commit-date");
  } finally {
    await cleanUp(harness);
  }
});

// =============================================================================
// Staged repository invariants
// =============================================================================

Deno.test("export-public - the staged repository has no remote and a single commit", async () => {
  const harness = await makeHarness();
  try {
    assertEquals((await runExport(harness)).code, 0);

    const remotes = await git(harness.staging, "remote");
    assertEquals(remotes.trim(), "", "the export configured a remote");

    const count = await git(harness.staging, "rev-list", "--count", "HEAD");
    assertEquals(
      count.trim(),
      "1",
      "the staged history is not a single commit",
    );

    const branch = await git(
      harness.staging,
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    );
    assertEquals(branch.trim(), "main");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - the staged working tree is clean after the commit", async () => {
  const harness = await makeHarness();
  try {
    assertEquals((await runExport(harness)).code, 0);
    const status = await git(harness.staging, "status", "--porcelain");
    assertEquals(status.trim(), "", "the staged tree has uncommitted changes");
  } finally {
    await cleanUp(harness);
  }
});

// =============================================================================
// Summary output
// =============================================================================

Deno.test("export-public - the summary reports the file count, total size and every path", async () => {
  const harness = await makeHarness();
  try {
    const run = await runExport(harness);
    assertEquals(run.code, 0, run.stdout + run.stderr);

    const files = await stagedFiles(harness.staging);
    assertStringIncludes(run.stdout, `Files:      ${files.length}`);

    let expectedBytes = 0;
    for (const rel of files) {
      expectedBytes += (await Deno.stat(`${harness.staging}/${rel}`)).size;
    }
    assertStringIncludes(run.stdout, `Total size: ${expectedBytes} bytes`);

    for (const rel of files) {
      assertStringIncludes(run.stdout, rel);
    }
  } finally {
    await cleanUp(harness);
  }
});

// =============================================================================
// Fail-loud guards
// =============================================================================

Deno.test("export-public - a manifest entry that does not exist fails loud", async () => {
  const harness = await makeHarness(
    FIXTURE_FILES,
    "README.md\ndocs/NOT-THERE.md\n",
  );
  try {
    const run = await runExport(harness);
    assert(run.code !== 0, "a stale manifest entry must not pass silently");
    assertStringIncludes(run.stderr, "docs/NOT-THERE.md");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - an escaping manifest entry is rejected", async () => {
  const harness = await makeHarness(FIXTURE_FILES, "../outside.md\n");
  try {
    const run = await runExport(harness);
    assert(run.code !== 0, "a path escaping the source tree must be rejected");
    assertStringIncludes(run.stderr, "..");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - a symlink in the allowlisted set fails loud", async () => {
  const harness = await makeHarness();
  try {
    await Deno.symlink(
      "/etc/passwd",
      `${harness.source}/worker/deno/passwd-link.ts`,
    );
    const run = await runExport(harness);
    assert(run.code !== 0, "a symlink must not be exported silently");
    assertStringIncludes(run.stderr, "symlink");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - a manifest listing nothing exportable fails loud", async () => {
  const harness = await makeHarness(FIXTURE_FILES, "# nothing here\n");
  try {
    const run = await runExport(harness);
    assert(run.code !== 0, "an empty export must not be reported as success");
    assertStringIncludes(run.stderr, "no files");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - a foreign non-empty staging directory is never clobbered", async () => {
  const harness = await makeHarness();
  try {
    await writeFile(`${harness.staging}/someone-elses-work.md`, "keep me\n");
    const run = await runExport(harness);
    assert(
      run.code !== 0,
      "the export overwrote a directory it did not create",
    );
    assertStringIncludes(run.stderr, "staging directory");
    const kept = await Deno.readTextFile(
      `${harness.staging}/someone-elses-work.md`,
    );
    assertEquals(kept, "keep me\n");
  } finally {
    await cleanUp(harness);
  }
});

// =============================================================================
// The repository's own manifest
// =============================================================================

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

interface RepoExport {
  staging: string;
  files: string[];
  run: Run;
  /** True when the run failed only because the scrub gate blocked it. */
  blockedOnlyByGate: boolean;
}

let repoExport: Promise<RepoExport> | null = null;

/**
 * Stage this repository with its committed manifest once per test run. The
 * staging directory is left for the OS temp cleaner: several tests share it,
 * so no single test owns its removal.
 */
function exportRepo(): Promise<RepoExport> {
  repoExport ??= (async () => {
    const staging = await Deno.makeTempDir({ prefix: "export_public_repo_" });
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
    const run = {
      code,
      stdout: new TextDecoder().decode(stdout),
      stderr: new TextDecoder().decode(stderr),
    };
    // Clean export: read the committed tree. Blocked only by the scrub gate:
    // the staged tree is on disk, unpublished — read it directly. Anything
    // else is a real failure and surfaces through `blockedOnlyByGate`.
    const blockedOnlyByGate = code !== 0 &&
      run.stderr.includes("Scrub gate blocked the export") &&
      run.stdout.includes("verdict: BLOCKED");
    const files = code === 0
      ? await stagedFiles(staging)
      : blockedOnlyByGate
      ? await walkTree(staging)
      : [];
    return { staging, files, run, blockedOnlyByGate };
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

/** The real export must be clean, or blocked by the scrub gate alone. */
function assertExportUsable(x: RepoExport): void {
  assert(
    x.run.code === 0 || x.blockedOnlyByGate,
    `real export failed for a reason other than the scrub gate (exit ${x.run.code})\n` +
      x.run.stdout + x.run.stderr,
  );
}

function repoFile(rel: string): string {
  return Deno.readTextFileSync(`${REPO_ROOT}${rel}`);
}

Deno.test("export-public - the committed manifest exports this repository, or is blocked only by the scrub gate", async () => {
  const exported = await exportRepo();
  assertExportUsable(exported);
  const { staging, files, run } = exported;

  assert(files.includes("README.md"));
  assert(files.includes("LICENSE"));
  // No private artefact from the real tree may appear in the export.
  for (const rel of files) {
    assert(
      !rel.startsWith("docs/archive/"),
      `PR summaries reached the export: ${rel}`,
    );
    assert(!rel.startsWith("docs/evidence/"), `evidence reached: ${rel}`);
    assert(!rel.startsWith("docs/audits/"), `audits reached: ${rel}`);
    assert(
      !rel.toLowerCase().includes("fleet"),
      `FLEET-health wiring reached the export: ${rel}`,
    );
    assert(!rel.includes(".config"), `config sample reached: ${rel}`);
  }
  if (run.code === 0) {
    assertEquals((await git(staging, "remote")).trim(), "");
    assertEquals(
      (await git(staging, "rev-list", "--count", "HEAD")).trim(),
      "1",
    );
    assertStringIncludes(run.stdout, "verdict: PASS");
  } else {
    // Blocked: no repository may have been created in the staging tree.
    const committed = await Deno.stat(`${staging}/.git`).then(() => true)
      .catch(() => false);
    assertEquals(committed, false, "a blocked export must not commit");
  }
});

Deno.test("export-public - the staged root carries the public document set, not the private one (Issue #4198)", async () => {
  const exported = await exportRepo();
  assertExportUsable(exported);
  const { staging, files } = exported;

  // The public README, SECURITY and CONTRIBUTING land at the root …
  for (const name of ["README.md", "SECURITY.md", "CONTRIBUTING.md"]) {
    assert(files.includes(name), `${name} missing from the staged root`);
    const staged = await Deno.readTextFile(`${staging}/${name}`);
    const source = repoFile(`docs/public/${name}`);
    assertEquals(
      staged,
      source,
      `${name} at the root is not docs/public/${name}`,
    );
    assert(
      staged !== repoFile(name),
      `${name} at the root is the private document, not the public one`,
    );
  }
  // … the README's first heading is the public brand in its human-facing
  // form (Issue #4197: `Vibe Coder` in prose, `VibeCoder` for identifiers) …
  const readme = await Deno.readTextFile(`${staging}/README.md`);
  const heading = readme.split("\n").find((line) => line.startsWith("# ")) ??
    "";
  assertStringIncludes(heading, "Vibe Coder");
  assert(
    !/\bVibeCoder\b/.test(readme),
    "the private product name must not survive in the public README",
  );
  // … and the source location is not staged alongside.
  for (const rel of files) {
    assert(!rel.startsWith("docs/public/"), `docs/public/ was staged: ${rel}`);
  }
});

Deno.test("export-public - no operator document on the exclusion list reaches the staged tree (Issue #4198)", async () => {
  const exported = await exportRepo();
  assertExportUsable(exported);
  const { files } = exported;

  const exclusions = parseExclusionList(
    repoFile("export/operator-docs-exclusions.txt"),
  );
  assert(exclusions.length > 0, "the exclusion list must name something");
  // The list is a contract: each entry the issue names must be on it.
  for (
    const named of [
      "docs/DEPLOYMENT.md",
      "docs/TROUBLESHOOTING.md",
      "docs/SWITCHING-IDENTITY.md",
      "docs/SECURITY-SCAN.md",
      "docs/evidence",
      "docs/EXPORT-PUBLIC.md",
      "docs/PUBLIC-REPO-READINESS.md",
      "switch-worker-identity.sh",
    ]
  ) {
    assert(exclusions.includes(named), `${named} is not on the exclusion list`);
  }
  const leaked = files.filter((rel) => isExcludedPath(rel, exclusions));
  assertEquals(leaked, [], "excluded operator documents reached the export");
});

Deno.test("export-public - every in-repo link in the public document set resolves in the staged tree (Issue #4198)", async () => {
  const exported = await exportRepo();
  assertExportUsable(exported);
  const { staging, files } = exported;

  const entries = parsePublicManifest(repoFile("export/public-manifest.txt"));
  const staged = new Set(files);
  const broken: string[] = [];

  for await (const item of Deno.readDir(`${REPO_ROOT}docs/public`)) {
    if (!item.isFile || !item.name.endsWith(".md")) continue;
    const sourcePath = `docs/public/${item.name}`;
    const stagedPath = stagedPathFor(sourcePath, entries);
    assert(stagedPath !== null, `${sourcePath} is not mapped by the manifest`);
    const body = repoFile(sourcePath);
    const baseDir = stagedPath.includes("/")
      ? stagedPath.slice(0, stagedPath.lastIndexOf("/") + 1)
      : "";
    for (const target of relativeLinkTargets(body)) {
      const [pathPart, fragment] = target.split("#");
      const resolved = new URL(pathPart ?? "", `file:///${baseDir}`).pathname
        .replace(/^\//, "");
      if (!staged.has(resolved)) {
        broken.push(`${sourcePath}: ${target} → ${resolved} (not staged)`);
        continue;
      }
      if (fragment && resolved.endsWith(".md")) {
        const anchors = anchorSet(
          await Deno.readTextFile(`${staging}/${resolved}`),
        );
        if (!anchors.has(fragment)) {
          broken.push(`${sourcePath}: ${target} (no such heading)`);
        }
      }
    }
  }
  assertEquals(broken, [], "the public document set links outside the export");
});

// =============================================================================
// Operator-document exclusion list (Issue #4198)
// =============================================================================

Deno.test("export-public - the exclusion list withholds listed files and directories and reports them", async () => {
  const harness = await makeHarness(
    {
      ...FIXTURE_FILES,
      "docs/DEPLOYMENT.md": "# Deployment (operator)\n",
      "docs/scans/one.md": "# Scan manual\n",
      "docs/USAGE.md": "# Usage\n",
    },
    `# version: 1
README.md
docs/
`,
  );
  try {
    const exclusions = `${harness.root}/exclusions.txt`;
    await Deno.writeTextFile(
      exclusions,
      "# operator docs\ndocs/DEPLOYMENT.md\ndocs/scans/\n",
    );
    const run = await runExport(harness, ["--exclusions", exclusions]);
    assertEquals(run.code, 0, run.stdout + run.stderr);
    const files = await stagedFiles(harness.staging);
    assert(files.includes("docs/USAGE.md"), `${files}`);
    assert(!files.includes("docs/DEPLOYMENT.md"), `${files}`);
    assert(!files.includes("docs/scans/one.md"), `${files}`);
    assertStringIncludes(run.stdout, "docs/DEPLOYMENT.md");
    assertStringIncludes(run.stdout, "docs/scans/one.md");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - a manifest entry that names an excluded document fails loud", async () => {
  const harness = await makeHarness(
    { ...FIXTURE_FILES, "docs/DEPLOYMENT.md": "# Deployment (operator)\n" },
    `# version: 1
README.md
docs/DEPLOYMENT.md
`,
  );
  try {
    const exclusions = `${harness.root}/exclusions.txt`;
    await Deno.writeTextFile(exclusions, "docs/DEPLOYMENT.md\n");
    const run = await runExport(harness, ["--exclusions", exclusions]);
    assert(run.code !== 0, "an excluded document listed by name must not pass");
    assertStringIncludes(run.stderr, "docs/DEPLOYMENT.md");
    assertStringIncludes(run.stderr, "exclu");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - a mapping cannot rename an excluded document into the export", async () => {
  const harness = await makeHarness(
    { ...FIXTURE_FILES, "docs/DEPLOYMENT.md": "# Deployment (operator)\n" },
    `# version: 1
README.md
docs/DEPLOYMENT.md -> docs/INSTALL.md
`,
  );
  try {
    const exclusions = `${harness.root}/exclusions.txt`;
    await Deno.writeTextFile(exclusions, "docs/DEPLOYMENT.md\n");
    const run = await runExport(harness, ["--exclusions", exclusions]);
    assert(
      run.code !== 0,
      "an excluded document mapped elsewhere must not pass",
    );
    assertStringIncludes(run.stderr, "docs/DEPLOYMENT.md");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - an explicitly named exclusion file that is missing fails loud", async () => {
  const harness = await makeHarness();
  try {
    const run = await runExport(harness, [
      "--exclusions",
      `${harness.root}/not-there.txt`,
    ]);
    assert(run.code !== 0);
    assertStringIncludes(run.stderr, "not-there.txt");
  } finally {
    await cleanUp(harness);
  }
});

// =============================================================================
// Destination mapping (`SRC -> DEST`, Issue #4198)
// =============================================================================

Deno.test("export-public - a `SRC -> DEST` entry stages the file at DEST", async () => {
  const harness = await makeHarness(
    {
      ...FIXTURE_FILES,
      "docs/public/README.md": "# Public readme\n",
      "docs/public/SECURITY.md": "# Public security\n",
      "docs/public/CONTRIBUTING.md": "# Contributing\n",
    },
    `# version: 1
LICENSE
worker/
docs/public/README.md -> README.md
docs/public/SECURITY.md   ->   SECURITY.md
docs/public/ -> docs/site
`,
  );
  try {
    const run = await runExport(harness);
    assertEquals(run.code, 0, run.stdout + run.stderr);

    const files = await stagedFiles(harness.staging);
    assert(files.includes("README.md"), `README.md missing from ${files}`);
    assert(files.includes("SECURITY.md"), `SECURITY.md missing from ${files}`);
    // Directory mapping applies to every file beneath the source directory.
    assert(files.includes("docs/site/CONTRIBUTING.md"), `${files}`);
    // The mapped source path itself is NOT staged.
    assert(!files.includes("docs/public/README.md"), `${files}`);
    assertEquals(
      await Deno.readTextFile(`${harness.staging}/README.md`),
      "# Public readme\n",
      "the private README must not win over the mapped public one",
    );
    // The summary shows the mapping so the operator can see what landed where.
    assertStringIncludes(run.stdout, "docs/public/README.md -> README.md");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - two entries staging the same path fail loud", async () => {
  const harness = await makeHarness(
    { ...FIXTURE_FILES, "docs/public/README.md": "# Public readme\n" },
    `# version: 1
README.md
docs/public/README.md -> README.md
`,
  );
  try {
    const run = await runExport(harness);
    assert(run.code !== 0, "a destination collision was silently resolved");
    assertStringIncludes(run.stderr, "stage the same path: README.md");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - a mapping cannot smuggle a hard-denied file under a permitted name", async () => {
  const harness = await makeHarness(
    FIXTURE_FILES,
    `# version: 1
README.md
.config.json -> settings-example.json
docs/OVERVIEW.md -> docs/evidence/OVERVIEW.md
`,
  );
  try {
    const run = await runExport(harness);
    assertEquals(run.code, 0, run.stdout + run.stderr);
    const files = await stagedFiles(harness.staging);
    assert(!files.includes("settings-example.json"), `${files}`);
    assert(!files.includes("docs/evidence/OVERVIEW.md"), `${files}`);
    assertStringIncludes(run.stdout, "Hard-denied: 2 path(s)");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - a mapping destination that escapes the staging tree is refused", async () => {
  const harness = await makeHarness(
    FIXTURE_FILES,
    `# version: 1
README.md -> ../escaped.md
`,
  );
  try {
    const run = await runExport(harness);
    assert(run.code !== 0);
    assertStringIncludes(run.stderr, "must not escape");
  } finally {
    await cleanUp(harness);
  }
});

// =============================================================================
// Branding transform (Issue #4197) and scrub gate (Issue #4196)
// =============================================================================

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("export-public - a staged tree containing an operator e-mail fails the gate and no commit is made", async () => {
  const harness = await makeHarness({
    ...FIXTURE_FILES,
    "docs/CONTACT.md": `Questions: ${FAKE_EMAIL}\n`,
  });
  try {
    const run = await runExport(harness);
    assert(run.code !== 0, "an e-mail in the staged tree must fail the export");
    assertStringIncludes(run.stderr, "Scrub gate blocked the export");
    assertStringIncludes(run.stderr, "scrub-gate-report.txt");
    assertStringIncludes(run.stdout, "[email] docs/CONTACT.md:1");
    // The value itself is never printed — only a mask.
    assert(!run.stdout.includes(FAKE_EMAIL), "the report leaked the e-mail");
    // The staged tree is left on disk, unpublished: no repository, no commit.
    assert(await exists(`${harness.staging}/docs/CONTACT.md`));
    assert(!(await exists(`${harness.staging}/.git`)), "a commit was made");
    // The report is on disk beside the staging directory.
    const report = await Deno.readTextFile(
      `${harness.staging}.reports/scrub-gate-report.txt`,
    );
    assertStringIncludes(report, "verdict: BLOCKED");
  } finally {
    await cleanUp(harness);
    await Deno.remove(`${harness.staging}.reports`, { recursive: true })
      .catch(() => {});
  }
});

Deno.test("export-public - a hostname, a home path and a key shape each fail with their own class", async () => {
  const harness = await makeHarness({
    ...FIXTURE_FILES,
    "docs/A.md": "runs on HOST-23\n",
    "docs/B.md": `see ${HOME_PATH}\n`,
    "docs/C.md": `IMGBB_API_KEY=${IMGBB_KEY}\n`,
    "docs/D.md": "maintained by acme-ops-bot\n",
  });
  try {
    const run = await runExport(harness);
    assert(run.code !== 0);
    assertStringIncludes(run.stdout, "[hostname] docs/A.md:1");
    assertStringIncludes(run.stdout, "[home-path] docs/B.md:1");
    assertStringIncludes(run.stdout, "[api-key] docs/C.md:1");
    assertStringIncludes(run.stdout, "[account] docs/D.md:1");
    for (const raw of ["HOST-23", HOME_PATH, IMGBB_KEY, "acme-ops-bot"]) {
      assert(!run.stdout.includes(raw), `output leaked ${raw}`);
    }
  } finally {
    await cleanUp(harness);
    await Deno.remove(`${harness.staging}.reports`, { recursive: true })
      .catch(() => {});
  }
});

Deno.test("export-public - an allowlisted finding with a justifying comment passes", async () => {
  const harness = await makeHarness({
    ...FIXTURE_FILES,
    "docs/CONTACT.md": `Questions: ${FAKE_EMAIL}\n`,
    "export/scrub-allowlist.txt":
      "# Reviewed: the contact address in the fixture doc is a placeholder\n" +
      "email docs/CONTACT.md *\n",
  });
  try {
    const run = await runExport(harness);
    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertStringIncludes(run.stdout, "verdict: PASS");
    assertStringIncludes(run.stdout, "1 allowlisted");
    const files = await stagedFiles(harness.staging);
    assert(files.includes("docs/CONTACT.md"));
  } finally {
    await cleanUp(harness);
    await Deno.remove(`${harness.staging}.reports`, { recursive: true })
      .catch(() => {});
  }
});

Deno.test("export-public - an allowlist entry without a comment fails the gate", async () => {
  const harness = await makeHarness({
    ...FIXTURE_FILES,
    "docs/CONTACT.md": `Questions: ${FAKE_EMAIL}\n`,
    "export/scrub-allowlist.txt": "email docs/CONTACT.md *\n",
  });
  try {
    const run = await runExport(harness);
    assert(run.code !== 0, "an unjustified allowlist entry must not pass");
    assertStringIncludes(run.stdout, "no justifying comment");
    assert(!(await exists(`${harness.staging}/.git`)));
  } finally {
    await cleanUp(harness);
    await Deno.remove(`${harness.staging}.reports`, { recursive: true })
      .catch(() => {});
  }
});

Deno.test("export-public - branding rewrites README text and the repository's own URL, and lists the URL in the report", async () => {
  const harness = await makeHarness({
    ...FIXTURE_FILES,
    "README.md": "# Vibe" + "Coding\n\nHistory: " + PRIVATE_URL +
      "/issues/1\n",
  });
  try {
    const run = await runExport(harness);
    // Issue #4197 as re-scoped: after the cut-over the public repository is
    // the canonical project, so a reference to its own tracker is rewritten
    // — and listed, line by line, in the branding report so the operator
    // reviews every URL that changed. Nothing is silent, nothing blocks.
    assertEquals(run.code, 0, run.stdout + run.stderr);
    const staged = await Deno.readTextFile(`${harness.staging}/README.md`);
    assertEquals(
      staged,
      "# VibeCoder\n\nHistory: " +
        PRIVATE_URL.replace("Vibe" + "Coding", "VibeCoder") + "/issues/1\n",
    );
    const branding = await Deno.readTextFile(
      `${harness.staging}.reports/branding-report.txt`,
    );
    assertStringIncludes(branding, "README.md:3");
    assertStringIncludes(
      branding,
      "URL/path references rewritten (review below): 1",
    );
    assertStringIncludes(branding, "Vibe" + "Coding -> VibeCoder: 2");
  } finally {
    await cleanUp(harness);
    await Deno.remove(`${harness.staging}.reports`, { recursive: true })
      .catch(() => {});
  }
});

Deno.test("export-public - the summary shows per-variant branding counts and the committed tree is rebranded", async () => {
  const harness = await makeHarness({
    ...FIXTURE_FILES,
    "README.md": "# Vibe" + "Coding\n\nVibe" + "Coding runs vibe-" + "coding\n",
    "worker/deno/mod.ts": 'export const name = "vibe' + '_coding";\n',
  });
  try {
    const run = await runExport(harness);
    assertEquals(run.code, 0, run.stdout + run.stderr);
    assertStringIncludes(run.stdout, "Vibe" + "Coding -> VibeCoder: 2");
    assertStringIncludes(run.stdout, "vibe-" + "coding -> vibe-coder: 1");
    assertStringIncludes(run.stdout, "vibe" + "_coding -> vibe_coder: 1");
    assertStringIncludes(run.stdout, "replacements-total: 4");
    assertStringIncludes(run.stdout, "verdict: PASS");
    const committed = await git(harness.staging, "show", "HEAD:README.md");
    assertEquals(committed, "# VibeCoder\n\nVibeCoder runs vibe-coder\n");
    assertEquals(
      await git(harness.staging, "show", "HEAD:worker/deno/mod.ts"),
      'export const name = "vibe_coder";\n',
    );
  } finally {
    await cleanUp(harness);
    await Deno.remove(`${harness.staging}.reports`, { recursive: true })
      .catch(() => {});
  }
});

Deno.test("export-public - there is no flag that skips the branding transform or the scrub gate", async () => {
  const harness = await makeHarness({
    ...FIXTURE_FILES,
    "docs/CONTACT.md": `Questions: ${FAKE_EMAIL}\n`,
  });
  try {
    for (
      const flag of [
        "--skip-scrub-gate",
        "--no-scrub",
        "--force",
        "--skip-branding",
        "--allow-findings",
      ]
    ) {
      const run = await runExport(harness, [flag]);
      assert(run.code !== 0, `${flag} was accepted`);
      assertStringIncludes(run.stderr, "Unknown argument");
      assert(!(await exists(`${harness.staging}/.git`)), `${flag} committed`);
    }
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - a missing identifiers file fails before anything is staged", async () => {
  const files = { ...FIXTURE_FILES };
  delete files["export/scrub-identifiers.txt"];
  const harness = await makeHarness(files);
  try {
    const run = await runExport(harness);
    assert(run.code !== 0);
    assertStringIncludes(run.stderr, "identifiers");
    assert(!(await exists(harness.staging)), "the tree was staged anyway");
  } finally {
    await cleanUp(harness);
  }
});

Deno.test("export-public - a missing deno fails loud instead of skipping the stages", async () => {
  // Only meaningful when deno is not on the minimal PATH used below.
  if (await exists("/usr/bin/deno") || await exists("/bin/deno")) return;
  const harness = await makeHarness();
  try {
    const command = new Deno.Command("bash", {
      args: [
        SCRIPT_PATH,
        "--source",
        harness.source,
        "--manifest",
        harness.manifest,
        "--staging",
        harness.staging,
        "--commit-date",
        COMMIT_DATE,
        "--author",
        COMMIT_AUTHOR,
        "--worker-dir",
        WORKER_DIR,
      ],
      env: { PATH: "/usr/bin:/bin" },
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const { code, stderr } = await command.output();
    assert(code !== 0, "a missing deno must not succeed");
    assertStringIncludes(new TextDecoder().decode(stderr), "deno is required");
    assert(!(await exists(`${harness.staging}/.git`)));
  } finally {
    await cleanUp(harness);
  }
});

// =============================================================================
// Redaction stage (Issues #4196, #4197)
// =============================================================================

Deno.test("export-public - the redaction stage maps operator identifiers and private repositories before the gate; the gate then passes", async () => {
  const harness = await makeHarness(
    {
      ...FIXTURE_FILES,
      "docs/OVERVIEW.md":
        "# Overview\n\nRun by acme-legacy-bot on LEGACY-7 for " +
        ["stSoftwareAU", "Secret-Project"].join("/") +
        " and stSoftwareAU/foo\n",
    },
    `# version: 1
README.md
docs/OVERVIEW.md
`,
  );
  try {
    // acme-legacy-bot is not a gate identifier in the fixture, so this
    // proves the mapping ran (the text changed) rather than the gate
    // tolerating it; the private repository would have been a finding.
    const run = await runExport(harness);
    assertEquals(run.code, 0, run.stdout + run.stderr);
    const staged = await Deno.readTextFile(
      `${harness.staging}/docs/OVERVIEW.md`,
    );
    assertEquals(
      staged,
      "# Overview\n\nRun by acme-bot on host-7 for example-org/private-repo-1 and stSoftwareAU/foo\n",
    );
    const report = await Deno.readTextFile(
      `${harness.staging}.reports/redaction-report.txt`,
    );
    assertStringIncludes(report, "private-repo: 1");
    assertStringIncludes(
      report,
      "Secret-Project -> example-org/private-repo-1",
    );
    assertStringIncludes(run.stdout, "Redaction (Issues #4196, #4197)");
  } finally {
    await cleanUp(harness);
    await Deno.remove(`${harness.staging}.reports`, { recursive: true })
      .catch(() => {});
  }
});

Deno.test("export-public - a missing redactions file fails before anything is staged", async () => {
  const files = { ...FIXTURE_FILES };
  delete files["export/scrub-redactions.txt"];
  const harness = await makeHarness(files);
  try {
    const run = await runExport(harness);
    assert(run.code !== 0);
    assertStringIncludes(run.stderr, "redactions");
    assert(!(await exists(harness.staging)), "the tree was staged anyway");
  } finally {
    await cleanUp(harness);
  }
});

// =============================================================================
// Self-contained links over the real manifest (Issues #4197, #4198)
// =============================================================================

Deno.test("export-public - over the real manifest no staged page links to a document the export withheld", async () => {
  const exported = await exportRepo();
  assertExportUsable(exported);
  const { staging, files } = exported;
  const inTree = new Set(files);
  for (const rel of files) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      inTree.add(parts.slice(0, i).join("/"));
    }
  }
  const offenders: string[] = [];
  for (const rel of files.filter((f) => f.endsWith(".md"))) {
    const text = await Deno.readTextFile(`${staging}/${rel}`);
    for (const m of text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)) {
      const target = m[1] ?? "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) {
        continue;
      }
      const base = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      const parts = base === "" ? [] : base.split("/");
      for (const seg of target.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      const resolved = parts.join("/");
      if (inTree.has(resolved)) continue;
      // Withheld = it exists in this (source) tree. A target that exists in
      // neither is a source-tree defect or a template placeholder, not a
      // leak, and is the link report's business.
      const inSource = await Deno.stat(`${REPO_ROOT}${resolved}`).then(
        () => true,
        () => false,
      );
      if (inSource) offenders.push(`${rel} -> ${target}`);
    }
  }
  assertEquals(offenders, [], "links to withheld documents survived");
});
