/**
 * Tests for bash_script_refs_scanner.ts — the native missing-script
 * reference scanner (Issue #3228, parent #3224).
 *
 * Every test exercises the real functions against in-memory fixtures (the
 * pure core) or a temporary fixture repo on disk (the walk), never the
 * network. Australian English throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  ancestorDirs,
  type BashRef,
  defaultListTrackedFiles,
  dirOf,
  extractRefs,
  findMissingReferences,
  firstArgToken,
  isExcludedShellPath,
  joinRel,
  resolveCandidates,
  scanBashScriptRefs,
  type ShellFile,
} from "../lib/bash_script_refs_scanner.ts";

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

Deno.test("dirOf - returns directory or empty for a root file", () => {
  assertEquals(dirOf("worker/shared/foo.sh"), "worker/shared");
  assertEquals(dirOf("run.sh"), "");
});

Deno.test("joinRel - normalises . and .. and rejects escapes", () => {
  assertEquals(joinRel("worker/shared", "../lib/x.sh"), "worker/lib/x.sh");
  assertEquals(joinRel("worker", "./a/./b.sh"), "worker/a/b.sh");
  assertEquals(joinRel("", "a.sh"), "a.sh");
  assertEquals(joinRel("worker", "/etc/passwd"), null); // absolute
  assertEquals(joinRel("", "../escape.sh"), null); // above repo root
});

Deno.test("ancestorDirs - most-specific first, ending with root", () => {
  assertEquals(ancestorDirs("worker/shared"), ["worker/shared", "worker", ""]);
  assertEquals(ancestorDirs(""), [""]);
});

// ---------------------------------------------------------------------------
// firstArgToken
// ---------------------------------------------------------------------------

Deno.test("firstArgToken - handles quotes, bare words, and preserves vars", () => {
  assertEquals(firstArgToken('  "${BASE_DIR}/x.sh"'), "${BASE_DIR}/x.sh");
  assertEquals(firstArgToken(" './rel.sh' arg"), "./rel.sh");
  assertEquals(firstArgToken(" bare.sh extra"), "bare.sh");
  assertEquals(firstArgToken("   "), null);
});

// ---------------------------------------------------------------------------
// extractRefs
// ---------------------------------------------------------------------------

Deno.test("extractRefs - extracts source, ., fleet, bash, and ./ forms", () => {
  const text = [
    'source "${BASE_DIR}/shared/a.sh"',
    '. "./b.sh"',
    'fleet_source_or_fail "${SHARED_DIR}/c.sh"',
    'bash "${REPO_DIR}/tool.sh" --flag',
    "./d.sh run",
  ].join("\n");
  const refs = extractRefs(text, "worker/run.sh");
  assertEquals(refs.map((r) => r.rawRef), [
    "${BASE_DIR}/shared/a.sh",
    "./b.sh",
    "${SHARED_DIR}/c.sh",
    "${REPO_DIR}/tool.sh",
    "./d.sh",
  ]);
  assertEquals(refs.map((r) => r.kind), [
    "source",
    "source",
    "fleet_source_or_fail",
    "bash",
    "relative",
  ]);
  assertEquals(refs[0]!.line, 1);
  assertEquals(refs[4]!.line, 5);
});

Deno.test("extractRefs - attaches shellcheck source annotation to next ref", () => {
  const text = [
    "# shellcheck source=worker/shared/real.sh",
    'source "${BASE_DIR}/shared/real.sh"',
  ].join("\n");
  const refs = extractRefs(text, "worker/run.sh");
  assertEquals(refs.length, 1);
  assertEquals(refs[0]!.shellcheckSource, "worker/shared/real.sh");
});

// ---------------------------------------------------------------------------
// resolveCandidates
// ---------------------------------------------------------------------------

function ref(
  rawRef: string,
  sourceFile: string,
  extra: Partial<BashRef> = {},
): BashRef {
  return {
    sourceFile,
    line: 1,
    rawRef,
    kind: "source",
    shellcheckSource: null,
    ...extra,
  };
}

Deno.test("resolveCandidates - SCRIPT_DIR and REPO_DIR resolve unambiguously", () => {
  const s = resolveCandidates(ref("${SCRIPT_DIR}/a.sh", "worker/run.sh"));
  assertEquals(s, { skipped: false, candidates: ["worker/a.sh"] });
  const r = resolveCandidates(ref("${REPO_DIR}/a.sh", "worker/run.sh"));
  assertEquals(r, { skipped: false, candidates: ["a.sh"] });
});

Deno.test("resolveCandidates - BASE_DIR is tried against every ancestor + root", () => {
  const outcome = resolveCandidates(
    ref("${BASE_DIR}/shared/a.sh", "worker/sub/run.sh"),
  );
  assert(!outcome.skipped);
  assertEquals(outcome.candidates, [
    "worker/sub/shared/a.sh",
    "worker/shared/a.sh",
    "shared/a.sh",
  ]);
});

Deno.test("resolveCandidates - dynamic references are skipped", () => {
  assert(resolveCandidates(ref('$(dirname "$0")/a.sh', "run.sh")).skipped);
  assert(resolveCandidates(ref("${__FLEET_ROOT}/a.sh", "run.sh")).skipped);
  assert(resolveCandidates(ref("${HOME}/a.sh", "run.sh")).skipped);
  assert(resolveCandidates(ref("lib/*.sh", "run.sh")).skipped);
  assert(resolveCandidates(ref("/usr/local/lib/a.sh", "run.sh")).skipped);
});

Deno.test("resolveCandidates - shellcheck annotation adds authoritative candidates", () => {
  const outcome = resolveCandidates(
    ref("${__FLEET_ROOT}/a.sh", "worker/run.sh", {
      shellcheckSource: "worker/shared/a.sh",
    }),
  );
  // Unknown variable stays dynamic, but the annotation gives real candidates.
  assert(!outcome.skipped);
  assert(outcome.candidates.includes("worker/shared/a.sh"));
});

// ---------------------------------------------------------------------------
// isExcludedShellPath
// ---------------------------------------------------------------------------

Deno.test("isExcludedShellPath - excludes test_* and test/ dirs", () => {
  assert(isExcludedShellPath("worker/test_helper.sh"));
  assert(isExcludedShellPath("test/unit/foo.sh"));
  assert(isExcludedShellPath("worker/tests/bar.sh"));
  assert(!isExcludedShellPath("worker/shared/real.sh"));
});

// ---------------------------------------------------------------------------
// findMissingReferences (pure core)
// ---------------------------------------------------------------------------

Deno.test("findMissingReferences - reports a missing sourced target", async () => {
  const files: ShellFile[] = [
    { path: "worker/run.sh", rawText: 'source "${SCRIPT_DIR}/missing.sh"\n' },
  ];
  const { findings } = await findMissingReferences(files, () => false, "o/r");
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.missingPath, "worker/missing.sh");
  assert(findings[0]!.findingId.startsWith("BP-"));
  assertEquals(findings[0]!.references[0]!.line, 1);
});

Deno.test("findMissingReferences - zero FP when any interpretation resolves", async () => {
  const files: ShellFile[] = [
    { path: "worker/run.sh", rawText: 'source "${BASE_DIR}/shared/real.sh"\n' },
  ];
  // BASE_DIR ambiguous: only the repo-root interpretation exists.
  const exists = (p: string) => p === "shared/real.sh";
  const { findings } = await findMissingReferences(files, exists, "o/r");
  assertEquals(findings.length, 0);
});

Deno.test("findMissingReferences - no FP for ./x.sh that lives at the repo root (cd-first)", async () => {
  // `./quality.sh` is invoked from worker/issue_worker.sh after a runtime
  // `cd` to the repo root, where quality.sh actually lives. It must not be
  // flagged even though worker/quality.sh does not exist.
  const files: ShellFile[] = [
    { path: "worker/issue_worker.sh", rawText: "./quality.sh\n" },
  ];
  const exists = (p: string) => p === "quality.sh";
  const { findings } = await findMissingReferences(files, exists, "o/r");
  assertEquals(findings.length, 0);
});

Deno.test("findMissingReferences - clusters multiple sites for one missing path", async () => {
  const files: ShellFile[] = [
    { path: "worker/a.sh", rawText: 'source "${SCRIPT_DIR}/gone.sh"\n' },
    { path: "worker/b.sh", rawText: '. "./gone.sh"\n' },
  ];
  const { findings } = await findMissingReferences(files, () => false, "o/r");
  assertEquals(findings.length, 1);
  assertEquals(findings[0]!.missingPath, "worker/gone.sh");
  assertEquals(findings[0]!.references.length, 2);
});

Deno.test("findMissingReferences - excludes test harnesses and skips dynamic", async () => {
  const files: ShellFile[] = [
    { path: "test/unit/x.sh", rawText: 'source "${SCRIPT_DIR}/missing.sh"\n' },
    { path: "worker/run.sh", rawText: 'source "$(dirname "$0")/dyn.sh"\n' },
  ];
  const { findings, skippedDynamic } = await findMissingReferences(
    files,
    () => false,
    "o/r",
  );
  assertEquals(findings.length, 0);
  assertEquals(skippedDynamic.length, 1);
  assertEquals(skippedDynamic[0]!.sourceFile, "worker/run.sh");
});

// ---------------------------------------------------------------------------
// scanBashScriptRefs (disk walk + fail-loud)
// ---------------------------------------------------------------------------

Deno.test("scanBashScriptRefs - detects a deliberate missing source in a fixture repo", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bash_refs_" });
  try {
    await Deno.mkdir(`${dir}/worker/shared`, { recursive: true });
    // real.sh exists; missing.sh does not.
    await Deno.writeTextFile(`${dir}/worker/shared/real.sh`, "echo real\n");
    await Deno.writeTextFile(
      `${dir}/worker/run.sh`,
      [
        'source "${SCRIPT_DIR}/shared/real.sh"', // resolvable — zero FP
        'source "${SCRIPT_DIR}/shared/missing.sh"', // missing — detected
      ].join("\n") + "\n",
    );
    const result = await scanBashScriptRefs(dir, "org/repo");
    assert(result.ok);
    assertEquals(result.value.findings.length, 1);
    assertEquals(
      result.value.findings[0]!.missingPath,
      "worker/shared/missing.sh",
    );
    assertEquals(result.value.filesScanned, 2);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanBashScriptRefs - fail-loud when a directory cannot be read", async () => {
  const result = await scanBashScriptRefs("/does/not/exist", "org/repo", {
    readDirFn: () => {
      throw new Deno.errors.NotFound("boom");
    },
  });
  assert(!result.ok);
  assertEquals(result.error.kind, "walk");
});

Deno.test("scanBashScriptRefs - fail-loud when a shell file cannot be read", async () => {
  const result = await scanBashScriptRefs("/repo", "org/repo", {
    // deno-lint-ignore require-await
    readDirFn: async function* (_dir: string) {
      yield {
        name: "run.sh",
        isFile: true,
        isDirectory: false,
        isSymlink: false,
      } as Deno.DirEntry;
    },
    readTextFileFn: () => Promise.reject(new Error("read denied")),
  });
  assert(!result.ok);
  assertEquals(result.error.kind, "read");
});

// ---------------------------------------------------------------------------
// Issue #3292 — `cd`-preceded references are dynamic
// ---------------------------------------------------------------------------

Deno.test("extractRefs - flags a `cd <dir> && ./script.sh` reference as precededByCd", () => {
  // NEAT-AI quality.sh:240 shape — the runtime cwd is a sibling checkout.
  const refs = extractRefs(
    "(cd ../NEAT-AI-Discovery && ./scripts/runlib.sh)\n",
    "quality.sh",
  );
  assertEquals(refs.length, 1);
  assertEquals(refs[0]!.rawRef, "./scripts/runlib.sh");
  assertEquals(refs[0]!.precededByCd, true);
});

Deno.test("extractRefs - a plain `./script.sh` is not flagged precededByCd", () => {
  const refs = extractRefs("./scripts/runlib.sh\n", "run.sh");
  assertEquals(refs.length, 1);
  assertEquals(refs[0]!.precededByCd, false);
});

Deno.test("resolveCandidates - a precededByCd reference is skipped as dynamic", () => {
  const ref: BashRef = {
    sourceFile: "quality.sh",
    line: 240,
    rawRef: "./scripts/runlib.sh",
    kind: "relative",
    shellcheckSource: null,
    precededByCd: true,
  };
  const outcome = resolveCandidates(ref);
  assertEquals(outcome.skipped, true);
  assertEquals(outcome.candidates, []);
});

Deno.test("findMissingReferences - a `cd <sibling> && ./run.sh` line is skipped, never a finding", async () => {
  const files: ShellFile[] = [{
    path: "quality.sh",
    // The target does not exist under this repo — but the `cd` makes it
    // dynamic, so it must be reported as skipped, not missing.
    rawText: "(cd ../NEAT-AI-Discovery && ./scripts/runlib.sh)\n",
  }];
  const { findings, skippedDynamic } = await findMissingReferences(
    files,
    () => false,
    "org/repo",
  );
  assertEquals(findings.length, 0);
  assertEquals(skippedDynamic.length, 1);
  assertEquals(skippedDynamic[0]!.rawRef, "./scripts/runlib.sh");
});

// ---------------------------------------------------------------------------
// Issue #3292 — git-tracked confinement (defence in depth)
// ---------------------------------------------------------------------------

Deno.test("scanBashScriptRefs - confines the scan to git-tracked files (nested checkout excluded)", async () => {
  // The walk yields both a tracked repo script and a script inside a nested
  // checkout; the tracked set lists only the repo script, so the nested
  // reference can never leak a finding.
  const readDirFn = (dir: string): AsyncIterable<Deno.DirEntry> => {
    const entry = (
      name: string,
      isFile: boolean,
    ): Deno.DirEntry => ({
      name,
      isFile,
      isDirectory: !isFile,
      isSymlink: false,
    });
    // deno-lint-ignore require-await
    return (async function* () {
      if (dir === "/repo") {
        yield entry("run.sh", true);
        yield entry("nested", false);
      } else if (dir === "/repo/nested") {
        yield entry("foreign.sh", true);
      }
    })();
  };
  const contents: Record<string, string> = {
    "/repo/run.sh": 'source "${SCRIPT_DIR}/present.sh"\n',
    // Would resolve nowhere and file a finding IF it were scanned.
    "/repo/nested/foreign.sh": 'source "${SCRIPT_DIR}/ghost.sh"\n',
  };

  const result = await scanBashScriptRefs("/repo", "org/repo", {
    readDirFn,
    readTextFileFn: (p) => Promise.resolve(contents[p] ?? ""),
    // present.sh exists; nothing else does.
    fileExistsFn: (p) => p === "/repo/present.sh",
    // git tracks only the top-level repo script.
    listTrackedFilesFn: () => Promise.resolve(new Set(["run.sh"])),
  });

  assert(result.ok);
  assertEquals(result.value.filesScanned, 1);
  assertEquals(result.value.findings.length, 0);
});

Deno.test("scanBashScriptRefs - no confinement when the tracked set is unavailable", async () => {
  // A `null` tracked set (not a git repo root) leaves the walk unfiltered,
  // preserving the pre-#3292 behaviour for plain fixture directories.
  const dir = await Deno.makeTempDir({ prefix: "bash_refs_notrack_" });
  try {
    await Deno.writeTextFile(
      `${dir}/run.sh`,
      'source "${SCRIPT_DIR}/missing.sh"\n',
    );
    const result = await scanBashScriptRefs(dir, "org/repo", {
      listTrackedFilesFn: () => Promise.resolve(null),
    });
    assert(result.ok);
    assertEquals(result.value.filesScanned, 1);
    assertEquals(result.value.findings.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanBashScriptRefs - real git checkout confines to tracked files", async () => {
  // Exercises the default `listTrackedFiles`: a genuine git repo whose
  // untracked nested checkout must not contribute a finding.
  const dir = await Deno.makeTempDir({ prefix: "bash_refs_git_" });
  try {
    const git = async (...args: string[]) => {
      const cmd = new Deno.Command("git", {
        args: ["-C", dir, ...args],
        stdout: "null",
        stderr: "null",
        env: {
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@e",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@e",
        },
      });
      await cmd.output();
    };
    await git("init");
    // Tracked, resolvable script — zero findings expected from it.
    await Deno.mkdir(`${dir}/shared`, { recursive: true });
    await Deno.writeTextFile(`${dir}/shared/real.sh`, "echo real\n");
    await Deno.writeTextFile(
      `${dir}/run.sh`,
      'source "${SCRIPT_DIR}/shared/real.sh"\n',
    );
    await git("add", "run.sh", "shared/real.sh");
    await git("commit", "-m", "init");

    // Untracked nested checkout with a broken reference — must be ignored.
    await Deno.mkdir(`${dir}/nested`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/nested/foreign.sh`,
      'source "${SCRIPT_DIR}/ghost.sh"\n',
    );

    const result = await scanBashScriptRefs(dir, "org/repo");
    assert(result.ok);
    // Only the two tracked scripts (run.sh, shared/real.sh) are scanned;
    // the untracked nested foreign.sh is dropped — so its broken ghost.sh
    // reference yields no finding.
    assertEquals(result.value.filesScanned, 2);
    assertEquals(result.value.findings.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// defaultListTrackedFiles — direct WHAT-tests (Issue #3298)
//
// The production default wired into scanBashScriptRefs. These assert on its
// observable outcome (the returned Set / null), giving the #3292 root-gate a
// regression guard without pinning how it shells out to git.
// ---------------------------------------------------------------------------

/** Run `git -C <dir> <args...>` with a deterministic identity. */
async function runGit(dir: string, ...args: string[]): Promise<number> {
  const cmd = new Deno.Command("git", {
    args: ["-C", dir, ...args],
    stdout: "null",
    stderr: "null",
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e",
    },
  });
  const { code } = await cmd.output();
  return code;
}

Deno.test("defaultListTrackedFiles - returns null outside a repo root (#3292 gate)", async () => {
  // A plain fixture directory with no .git entry must never be trusted.
  const dir = await Deno.makeTempDir({ prefix: "bash_refs_default_norepo_" });
  try {
    await Deno.writeTextFile(`${dir}/run.sh`, "echo hi\n");
    const tracked = await defaultListTrackedFiles(dir);
    assertEquals(tracked, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("defaultListTrackedFiles - returns the tracked set at a real repo root", async () => {
  const dir = await Deno.makeTempDir({ prefix: "bash_refs_default_repo_" });
  try {
    assertEquals(await runGit(dir, "init"), 0);
    await Deno.mkdir(`${dir}/shared`, { recursive: true });
    await Deno.writeTextFile(`${dir}/shared/real.sh`, "echo real\n");
    await Deno.writeTextFile(`${dir}/run.sh`, "echo run\n");
    // An untracked file that must be excluded from the returned set.
    await Deno.writeTextFile(`${dir}/scratch.sh`, "echo scratch\n");
    assertEquals(await runGit(dir, "add", "run.sh", "shared/real.sh"), 0);
    assertEquals(await runGit(dir, "commit", "-m", "init"), 0);

    const tracked = await defaultListTrackedFiles(dir);
    assert(tracked !== null, "expected a tracked set at a real repo root");
    assert(tracked.has("run.sh"), "tracked set should include run.sh");
    assert(
      tracked.has("shared/real.sh"),
      "tracked set should include shared/real.sh",
    );
    assert(
      !tracked.has("scratch.sh"),
      "tracked set must exclude the untracked scratch.sh",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("defaultListTrackedFiles - returns null when git ls-files exits non-zero", async () => {
  // A .git that is a file (a broken/partial checkout, not a real repo) makes
  // `git ls-files` fail — the code !== 0 branch must return null, not throw.
  const dir = await Deno.makeTempDir({ prefix: "bash_refs_default_badgit_" });
  try {
    // Satisfy the `.git` stat gate with a non-directory .git entry so the
    // subsequent `git ls-files` invocation fails rather than being skipped.
    await Deno.writeTextFile(`${dir}/.git`, "not a real gitdir\n");
    const tracked = await defaultListTrackedFiles(dir);
    assertEquals(tracked, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
