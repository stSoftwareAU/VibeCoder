/**
 * Tests for dependency_conflict_apply.ts (Issue #466, part of #456).
 *
 * The deterministic pass runs before the AI agent: it applies the registered
 * manifest rules to the conflicted paths, regenerates the lock files whose
 * manifest it resolved, stages what it resolved, and hands everything else back
 * with a reason. Every deferral must stage nothing and leave the conflicted
 * file exactly as git wrote it, so the AI fallback still sees a real conflict.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 *
 * The fixtures embed conflict markers at column 0, which is exactly what the CI
 * "Check for merge conflict markers" step looks for; that step honours the
 * sentinel below to exempt this file, and prints the exemption. Nothing here is
 * an unresolved conflict.
 *
 * vibe-allow-conflict-markers
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  applyDependencyConflictRules,
  type ConflictGitRunner,
} from "../lib/dependency_conflict_apply.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface GitLog {
  args: string[][];
}

/** A git runner that succeeds, recording every call. */
function makeGit(
  log: GitLog,
  failOn?: (args: readonly string[]) => boolean,
): ConflictGitRunner {
  return (args) => {
    log.args.push([...args]);
    return Promise.resolve(
      failOn?.(args)
        ? { code: 1, stdout: "", stderr: "fatal: pathspec refused" }
        : { code: 0, stdout: "", stderr: "" },
    );
  };
}

async function makeWorkingDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-conflict-apply-" });
  for (const [path, content] of Object.entries(files)) {
    await Deno.writeTextFile(`${dir}/${path}`, content);
  }
  return dir;
}

const DENO_JSON_CONFLICT = `{
  "imports": {
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
    "@std/fs": "jsr:@std/fs@^1.2.0"
>>>>>>> origin/main
  }
}
`;

const UNDECIDABLE_DENO_JSON = `{
  "imports": {
<<<<<<< HEAD
    "@std/fs": "jsr:@std/fs@^1.0.0"
=======
    "@std/fs": "jsr:@std/fs@~1.0.0"
>>>>>>> origin/main
  }
}
`;

// ---------------------------------------------------------------------------
// Manifest rules
// ---------------------------------------------------------------------------

Deno.test("applyDependencyConflictRules - resolves and stages a deno.json bump", async () => {
  const workingDir = await makeWorkingDir({ "deno.json": DENO_JSON_CONFLICT });
  const log: GitLog = { args: [] };

  const report = await applyDependencyConflictRules({
    workingDir,
    conflictedFiles: ["deno.json"],
    git: makeGit(log),
  });

  assertEquals(report.deferred, []);
  assertEquals(report.resolved.length, 1);
  assertEquals(report.resolved[0]?.path, "deno.json");
  assertEquals(report.resolved[0]?.kind, "manifest");

  const written = await Deno.readTextFile(`${workingDir}/deno.json`);
  assertStringIncludes(written, '"@std/fs": "jsr:@std/fs@^1.2.0"');
  assertEquals(written.includes("<<<<<<<"), false);
  assert(
    log.args.some((a) => a[0] === "add" && a.includes("deno.json")),
    `the resolved path must be staged; got ${JSON.stringify(log.args)}`,
  );

  const decision = report.resolved[0]?.decisions[0];
  assertEquals(decision?.key, "@std/fs");
  assertEquals(decision?.ours, "jsr:@std/fs@^1.0.0");
  assertEquals(decision?.theirs, "jsr:@std/fs@^1.2.0");
  assertEquals(decision?.kept, "jsr:@std/fs@^1.2.0");
});

Deno.test("applyDependencyConflictRules - a file with no rule is deferred untouched", async () => {
  const workingDir = await makeWorkingDir({ "SECURITY.md": "conflicted\n" });
  const log: GitLog = { args: [] };

  const report = await applyDependencyConflictRules({
    workingDir,
    conflictedFiles: ["SECURITY.md"],
    git: makeGit(log),
  });

  assertEquals(report.resolved, []);
  assertEquals(report.deferred.length, 1);
  assertEquals(report.deferred[0]?.path, "SECURITY.md");
  assertStringIncludes(report.deferred[0]?.reason ?? "", "no deterministic");
  assertEquals(log.args.length, 0);
  assertEquals(
    await Deno.readTextFile(`${workingDir}/SECURITY.md`),
    "conflicted\n",
  );
});

Deno.test("applyDependencyConflictRules - an undecidable version defers the file", async () => {
  const workingDir = await makeWorkingDir({
    "deno.json": UNDECIDABLE_DENO_JSON,
  });
  const log: GitLog = { args: [] };

  const report = await applyDependencyConflictRules({
    workingDir,
    conflictedFiles: ["deno.json"],
    git: makeGit(log),
  });

  assertEquals(report.resolved, []);
  assertStringIncludes(report.deferred[0]?.reason ?? "", "range prefix");
  assertEquals(log.args.length, 0);
  // The conflict markers must survive for the AI fallback.
  assertEquals(
    await Deno.readTextFile(`${workingDir}/deno.json`),
    UNDECIDABLE_DENO_JSON,
  );
});

Deno.test("applyDependencyConflictRules - a malformed conflict is deferred", async () => {
  const workingDir = await makeWorkingDir({
    "deno.json": '{\n  "imports": {\n<<<<<<< HEAD\n    "a": "b"\n',
  });
  const report = await applyDependencyConflictRules({
    workingDir,
    conflictedFiles: ["deno.json"],
    git: makeGit({ args: [] }),
  });

  assertEquals(report.resolved, []);
  assertStringIncludes(report.deferred[0]?.reason ?? "", "unterminated");
});

Deno.test("applyDependencyConflictRules - an unreadable file is deferred loudly", async () => {
  const workingDir = await makeWorkingDir({});
  const report = await applyDependencyConflictRules({
    workingDir,
    conflictedFiles: ["deno.json"],
    git: makeGit({ args: [] }),
  });

  assertEquals(report.resolved, []);
  assertStringIncludes(report.deferred[0]?.reason ?? "", "could not be read");
});

Deno.test("applyDependencyConflictRules - a path escaping the working directory is refused", async () => {
  const workingDir = await makeWorkingDir({});
  const report = await applyDependencyConflictRules({
    workingDir,
    conflictedFiles: ["../deno.json"],
    git: makeGit({ args: [] }),
  });

  assertEquals(report.resolved, []);
  assertStringIncludes(report.deferred[0]?.reason ?? "", "unsafe path");
});

Deno.test("applyDependencyConflictRules - a failed stage restores the conflict and defers", async () => {
  const workingDir = await makeWorkingDir({ "deno.json": DENO_JSON_CONFLICT });
  const log: GitLog = { args: [] };

  const report = await applyDependencyConflictRules({
    workingDir,
    conflictedFiles: ["deno.json"],
    git: makeGit(log, (args) => args[0] === "add"),
  });

  assertEquals(report.resolved, []);
  assertStringIncludes(report.deferred[0]?.reason ?? "", "staging");
  assert(
    log.args.some((a) => a[0] === "checkout" && a.includes("--merge")),
    `the conflicted file must be restored; got ${JSON.stringify(log.args)}`,
  );
});

// ---------------------------------------------------------------------------
// Lock files
// ---------------------------------------------------------------------------

Deno.test("applyDependencyConflictRules - regenerates a lock whose manifest resolved", async () => {
  const workingDir = await makeWorkingDir({
    "deno.json": DENO_JSON_CONFLICT,
    "deno.lock": "conflicted lock\n",
  });
  const log: GitLog = { args: [] };
  const ran: string[] = [];

  const report = await applyDependencyConflictRules({
    workingDir,
    conflictedFiles: ["deno.json", "deno.lock"],
    git: makeGit(log),
    lockRegen: {
      hasTool: () => Promise.resolve(true),
      runner: (call) => {
        ran.push([call.bin, ...call.args].join(" "));
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
      readLockFile: () => Promise.resolve('{"version":"5"}\n'),
    },
  });

  assertEquals(report.deferred, []);
  assertEquals(report.resolved.map((r) => r.path), ["deno.json", "deno.lock"]);
  const lock = report.resolved.find((r) => r.path === "deno.lock");
  assertEquals(lock?.kind, "lock");
  assertEquals(lock?.resolvedBy, "deno install");
  assert(
    ran.includes("deno install"),
    `the lock must be regenerated by its own toolchain; ran ${ran.join(", ")}`,
  );
});

Deno.test("applyDependencyConflictRules - a lock is deferred when its manifest is not resolved", async () => {
  const workingDir = await makeWorkingDir({
    "deno.json": UNDECIDABLE_DENO_JSON,
    "deno.lock": "conflicted lock\n",
  });
  const ran: string[] = [];

  const report = await applyDependencyConflictRules({
    workingDir,
    conflictedFiles: ["deno.json", "deno.lock"],
    git: makeGit({ args: [] }),
    lockRegen: {
      hasTool: () => Promise.resolve(true),
      runner: (call) => {
        ran.push(call.bin);
        return Promise.resolve({ code: 0, stdout: "", stderr: "" });
      },
    },
  });

  assertEquals(report.resolved, []);
  assertEquals(report.deferred.map((d) => d.path), ["deno.json", "deno.lock"]);
  assertStringIncludes(
    report.deferred[1]?.reason ?? "",
    "deno.json is unresolved",
  );
  assertEquals(ran, []);
});

Deno.test("applyDependencyConflictRules - no conflicted files is an empty report", async () => {
  const workingDir = await makeWorkingDir({});
  const report = await applyDependencyConflictRules({
    workingDir,
    conflictedFiles: [],
    git: makeGit({ args: [] }),
  });

  assertEquals(report.resolved, []);
  assertEquals(report.deferred, []);
});
