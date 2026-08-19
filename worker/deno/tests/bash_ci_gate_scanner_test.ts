/**
 * Tests for the native bash CI-gate detector (Issue #3236, layer 1 of
 * #3223).
 *
 * Each test builds a real temporary repository on disk (workflows + bash
 * scripts) and exercises `checkBashCiGates` end-to-end — static file
 * inspection only, no subprocess, no network. Coverage:
 *
 *   - both gates present inline → `configured`;
 *   - missing `bash -n` → syntax gate reported missing, finding names it;
 *   - missing `shellcheck` → shellcheck gate reported missing;
 *   - gate satisfied via a committed `quality/*.sh` invoked from a
 *     workflow step → `configured` (committed-gate pattern, incl. the
 *     `./quality.sh` → sources gate scripts shape);
 *   - no bash scripts → not applicable, no finding;
 *   - vendored-only scripts excluded from discovery;
 *   - shebang-only scripts discovered;
 *   - zero workflows → gates unknown, not missing;
 *   - malformed workflow YAML → unknown, not missing.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type BashCiGateResult,
  checkBashCiGates,
  discoverBashScripts,
} from "../lib/bash_ci_gate_scanner.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** A file to write into the temporary repo. */
interface FixtureFile {
  path: string;
  content: string;
}

/** Build a temp repo from `files`, run `fn`, then always clean up. */
async function withRepo(
  files: FixtureFile[],
  fn: (repoPath: string) => Promise<void>,
): Promise<void> {
  const repoPath = await Deno.makeTempDir({ prefix: "bash_ci_gate_" });
  try {
    for (const f of files) {
      const abs = `${repoPath}/${f.path}`;
      const slash = abs.lastIndexOf("/");
      await Deno.mkdir(abs.slice(0, slash), { recursive: true });
      await Deno.writeTextFile(abs, f.content);
    }
    await fn(repoPath);
  } finally {
    await Deno.remove(repoPath, { recursive: true });
  }
}

/** A workflow YAML whose single run step is `runCmd`. */
function workflow(runCmd: string): string {
  return [
    "name: ci",
    "on: [pull_request]",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - name: gate",
    "        run: |",
    ...runCmd.split("\n").map((l) => `          ${l}`),
    "",
  ].join("\n");
}

const DUMMY_SCRIPT = "#!/bin/bash\necho hello\n";

// ---------------------------------------------------------------------------
// Both gates present
// ---------------------------------------------------------------------------

Deno.test("both gates inline → configured", async () => {
  await withRepo([
    { path: "build.sh", content: DUMMY_SCRIPT },
    {
      path: ".github/workflows/ci.yml",
      content: workflow("bash -n build.sh\nshellcheck build.sh"),
    },
  ], async (repo) => {
    const r = await checkBashCiGates(repo);
    assert(r.applicable);
    assertEquals(r.gates.syntax, "present");
    assertEquals(r.gates.shellcheck, "present");
    assert(r.configured);
    assert(r.workflowsLoaded);
  });
});

// ---------------------------------------------------------------------------
// Missing bash -n
// ---------------------------------------------------------------------------

Deno.test("missing bash -n → syntax gate missing and named", async () => {
  await withRepo([
    { path: "build.sh", content: DUMMY_SCRIPT },
    {
      path: ".github/workflows/ci.yml",
      content: workflow("shellcheck build.sh"),
    },
  ], async (repo) => {
    const r = await checkBashCiGates(repo);
    assert(r.applicable);
    assertEquals(r.gates.shellcheck, "present");
    assertEquals(r.gates.syntax, "missing");
    assert(!r.configured);
    assert(r.details.includes("bash -n"));
  });
});

// ---------------------------------------------------------------------------
// Missing shellcheck
// ---------------------------------------------------------------------------

Deno.test("missing shellcheck → shellcheck gate missing and named", async () => {
  await withRepo([
    { path: "build.sh", content: DUMMY_SCRIPT },
    {
      path: ".github/workflows/ci.yml",
      content: workflow("bash -n build.sh"),
    },
  ], async (repo) => {
    const r = await checkBashCiGates(repo);
    assert(r.applicable);
    assertEquals(r.gates.syntax, "present");
    assertEquals(r.gates.shellcheck, "missing");
    assert(!r.configured);
    assert(r.details.includes("shellcheck"));
  });
});

// ---------------------------------------------------------------------------
// Committed-gate pattern
// ---------------------------------------------------------------------------

Deno.test("committed quality/*.sh gate scripts → configured", async () => {
  await withRepo([
    { path: "build.sh", content: DUMMY_SCRIPT },
    {
      path: "quality/shellcheck.sh",
      content: "#!/bin/bash\nshellcheck ./*.sh\n",
    },
    {
      path: "quality/bash_syntax.sh",
      content: '#!/bin/bash\nfor f in *.sh; do bash -n "$f"; done\n',
    },
    {
      path: ".github/workflows/ci.yml",
      content: workflow("quality/shellcheck.sh\nquality/bash_syntax.sh"),
    },
  ], async (repo) => {
    const r = await checkBashCiGates(repo);
    assertEquals(r.gates.syntax, "present");
    assertEquals(r.gates.shellcheck, "present");
    assert(r.configured);
  });
});

Deno.test("committed ./quality.sh that sources gate scripts → configured", async () => {
  await withRepo([
    { path: "build.sh", content: DUMMY_SCRIPT },
    {
      // quality.sh delegates to the two gate scripts by name; the detector
      // must follow the reference one level and find the inline gates.
      path: "quality.sh",
      content:
        "#!/bin/bash\n./quality/shellcheck.sh\n./quality/bash_syntax.sh\n",
    },
    {
      path: "quality/shellcheck.sh",
      content: "#!/bin/bash\nshellcheck ./*.sh\n",
    },
    {
      path: "quality/bash_syntax.sh",
      content: "#!/bin/bash\nbash -n build.sh\n",
    },
    {
      path: ".github/workflows/ci.yml",
      content: workflow("./quality.sh"),
    },
  ], async (repo) => {
    const r = await checkBashCiGates(repo);
    assertEquals(r.gates.syntax, "present");
    assertEquals(r.gates.shellcheck, "present");
    assert(r.configured);
  });
});

// ---------------------------------------------------------------------------
// No bash scripts → not applicable
// ---------------------------------------------------------------------------

Deno.test("no bash scripts → not applicable, no finding", async () => {
  await withRepo([
    { path: "README.md", content: "# hi\n" },
    { path: "main.ts", content: "export const x = 1;\n" },
    {
      path: ".github/workflows/ci.yml",
      content: workflow("deno test"),
    },
  ], async (repo) => {
    const r = await checkBashCiGates(repo);
    assert(!r.applicable);
    assertEquals(r.scriptCount, 0);
    assert(!r.configured);
    assert(r.details.toLowerCase().includes("not applicable"));
  });
});

// ---------------------------------------------------------------------------
// Vendored exclusion
// ---------------------------------------------------------------------------

Deno.test("vendored-only scripts excluded from discovery", async () => {
  await withRepo([
    { path: "node_modules/pkg/install.sh", content: DUMMY_SCRIPT },
    { path: "vendor/tool/run.sh", content: DUMMY_SCRIPT },
    { path: "third_party/x/build.bash", content: DUMMY_SCRIPT },
    { path: ".git/hooks/pre-commit.sh", content: DUMMY_SCRIPT },
  ], async (repo) => {
    const scripts = await discoverBashScripts(repo);
    assertEquals(scripts, []);
    const r = await checkBashCiGates(repo);
    assert(!r.applicable);
  });
});

// ---------------------------------------------------------------------------
// Shebang discovery
// ---------------------------------------------------------------------------

Deno.test("shebang-only scripts (no extension) are discovered", async () => {
  await withRepo([
    // No extension, but a bash shebang → discovered.
    { path: "quality", content: "#!/usr/bin/env bash\necho gate\n" },
    { path: "run", content: "#!/bin/sh\necho run\n" },
    // A non-shell shebang and a plain text file → not discovered.
    { path: "setup.py", content: "#!/usr/bin/env python3\nprint('x')\n" },
    { path: "notes", content: "just some notes\n" },
  ], async (repo) => {
    const scripts = await discoverBashScripts(repo);
    assertEquals(scripts, ["quality", "run"]);
  });
});

// ---------------------------------------------------------------------------
// Zero workflows → unknown
// ---------------------------------------------------------------------------

Deno.test("bash scripts but zero workflows → gates unknown, not missing", async () => {
  await withRepo([
    { path: "build.sh", content: DUMMY_SCRIPT },
  ], async (repo) => {
    const r = await checkBashCiGates(repo);
    assert(r.applicable);
    assert(!r.workflowsLoaded);
    assertEquals(r.gates.syntax, "unknown");
    assertEquals(r.gates.shellcheck, "unknown");
    assert(!r.configured);
  });
});

// ---------------------------------------------------------------------------
// Malformed workflow YAML → unknown
// ---------------------------------------------------------------------------

Deno.test("malformed workflow YAML → unknown, not missing", async () => {
  await withRepo([
    { path: "build.sh", content: DUMMY_SCRIPT },
    {
      path: ".github/workflows/ci.yml",
      // Broken YAML: unbalanced brackets / bad indentation.
      content: "jobs: [ this: is: not: valid: yaml\n  - : :\n",
    },
  ], async (repo) => {
    const r = await checkBashCiGates(repo);
    assert(r.applicable);
    assert(r.workflowsLoaded);
    assertEquals(r.gates.syntax, "unknown");
    assertEquals(r.gates.shellcheck, "unknown");
    assert(!r.configured);
  });
});

// ---------------------------------------------------------------------------
// Result shape sanity
// ---------------------------------------------------------------------------

Deno.test("result shape is stable", async () => {
  await withRepo([
    { path: "build.sh", content: DUMMY_SCRIPT },
    {
      path: ".github/workflows/ci.yml",
      content: workflow("bash -n build.sh\nshellcheck build.sh"),
    },
  ], async (repo) => {
    const r: BashCiGateResult = await checkBashCiGates(repo);
    assertEquals(typeof r.applicable, "boolean");
    assertEquals(typeof r.scriptCount, "number");
    assertEquals(typeof r.configured, "boolean");
    assertEquals(typeof r.workflowsLoaded, "boolean");
    assertEquals(typeof r.details, "string");
    assert("syntax" in r.gates);
    assert("shellcheck" in r.gates);
  });
});
