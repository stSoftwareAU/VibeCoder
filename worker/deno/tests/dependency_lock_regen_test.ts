/**
 * Tests for lock-file regeneration (Issue #465, part of #456).
 *
 * A conflicted lock file is never text-merged: the integrity hashes make a
 * textual merge meaningless even when it produces a marker-free file. Instead
 * the ecosystem's own tool regenerates the lock from the already-merged
 * manifest, and every way that can go wrong returns `unresolved` so the file
 * reaches the AI/human path.
 *
 * The command runner, the toolchain probe and the lock-file reader are all
 * injected, so nothing here shells out or touches the filesystem.
 *
 * The fixtures embed conflict markers at column 0, which is exactly what the
 * CI "Check for merge conflict markers" step looks for; that step honours the
 * sentinel below to exempt this file, and prints the exemption. Nothing here
 * is an unresolved conflict.
 *
 * vibe-allow-conflict-markers
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";
import {
  DEFAULT_LOCK_REGEN_TIMEOUT_MS,
  type LockRegenOptions,
  type LockRegenOutcome,
  lockSpecForPath,
  regenerateLockFile,
  regenerateLockFiles,
  type RunnerCall,
} from "../lib/dependency_lock_regen.ts";

// ---------------------------------------------------------------------------
// Fixtures and fakes
// ---------------------------------------------------------------------------

/** A conflicted `deno.lock`, the shape `git merge` leaves behind. */
const CONFLICTED_LOCK = [
  "{",
  '  "version": "5",',
  '  "specifiers": {',
  "<<<<<<< HEAD",
  '    "jsr:@std/assert@^1.0.18": "1.0.18"',
  "=======",
  '    "jsr:@std/assert@^1.0.17": "1.0.17"',
  ">>>>>>> origin/main",
  "  }",
  "}",
  "",
].join("\n");

/** What the ecosystem tool writes: a valid, marker-free lock. */
const REGENERATED_LOCK = [
  "{",
  '  "version": "5",',
  '  "specifiers": {',
  '    "jsr:@std/assert@^1.0.18": "1.0.18"',
  "  }",
  "}",
  "",
].join("\n");

/** Scripted outcome for one command, keyed by `bin` plus its first argument. */
interface ScriptedResult {
  code?: number;
  stdout?: string;
  stderr?: string;
  /** Content the command leaves in the lock file, when it writes one. */
  writes?: string;
}

interface HarnessOptions {
  /** Lock-file contents keyed on repository-relative path. */
  files?: Record<string, string>;
  /** Binaries the container has on `PATH`. */
  tools?: readonly string[];
  /** Scripted results keyed on `"bin arg0"` (e.g. `"deno install"`). */
  scripted?: Record<string, ScriptedResult>;
}

interface Harness {
  calls: RunnerCall[];
  files: Map<string, string>;
  options: Pick<
    LockRegenOptions,
    "workingDir" | "runner" | "hasTool" | "readLockFile"
  >;
}

/** Commands the harness answers with exit 0 unless scripted otherwise. */
function makeHarness(opts: HarnessOptions = {}): Harness {
  const calls: RunnerCall[] = [];
  const files = new Map(Object.entries(opts.files ?? {}));
  const tools = new Set(opts.tools ?? ["deno", "npm", "cargo", "git"]);
  const scripted = opts.scripted ?? {};

  return {
    calls,
    files,
    options: {
      workingDir: "/work/repo",
      runner: (call) => {
        calls.push(call);
        const key = `${call.bin} ${call.args[0] ?? ""}`.trim();
        const result = scripted[key] ?? {};
        if (result.writes !== undefined) {
          // The tool rewrites the lock file in place.
          files.set(lockPathOf(call), result.writes);
        }
        return Promise.resolve({
          code: result.code ?? 0,
          stdout: result.stdout ?? "",
          stderr: result.stderr ?? "",
        });
      },
      hasTool: (bin) => Promise.resolve(tools.has(bin)),
      readLockFile: (path) => Promise.resolve(files.get(path) ?? null),
    },
  };
}

/**
 * Which lock file a call acts on.
 *
 * `git` calls name the path explicitly; a regeneration command is identified
 * by the directory it runs in, which is the lock file's own directory.
 */
function lockPathOf(call: RunnerCall): string {
  const explicit = call.args.find((arg) => arg.includes("lock"));
  if (call.bin === "git" && explicit) return explicit;
  return call.lockPath;
}

/** Only the non-git commands — the regeneration attempts themselves. */
function regenCalls(calls: readonly RunnerCall[]): RunnerCall[] {
  return calls.filter((call) => call.bin !== "git");
}

/** Assert the outcome deferred, and return its reason. */
function unresolvedReason(outcome: LockRegenOutcome): string {
  if (outcome.kind !== "unresolved") {
    throw new Error(`expected unresolved, got ${outcome.kind}`);
  }
  return outcome.reason;
}

// ---------------------------------------------------------------------------
// Spec lookup
// ---------------------------------------------------------------------------

Deno.test("lockSpecForPath - recognises each supported lock file", () => {
  assertEquals(lockSpecForPath("deno.lock")?.ecosystem, "deno");
  assertEquals(lockSpecForPath("worker/deno/deno.lock")?.ecosystem, "deno");
  assertEquals(lockSpecForPath("package-lock.json")?.ecosystem, "npm");
  assertEquals(lockSpecForPath("Cargo.lock")?.ecosystem, "cargo");
  assertEquals(lockSpecForPath("go.sum")?.ecosystem, "go");
});

Deno.test("lockSpecForPath - returns undefined for a non-lock file", () => {
  assertEquals(lockSpecForPath("src/main.ts"), undefined);
  assertEquals(lockSpecForPath("deno.json"), undefined);
  // A basename match only — not a path that merely contains the name.
  assertEquals(lockSpecForPath("docs/deno.lock.md"), undefined);
});

Deno.test("lockSpecForPath - pairs each lock with its manifests", () => {
  assertEquals(lockSpecForPath("deno.lock")?.manifests, [
    "deno.json",
    "deno.jsonc",
  ]);
  assertEquals(lockSpecForPath("package-lock.json")?.manifests, [
    "package.json",
  ]);
  assertEquals(lockSpecForPath("Cargo.lock")?.manifests, ["Cargo.toml"]);
  assertEquals(lockSpecForPath("go.sum")?.manifests, ["go.mod"]);
});

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

Deno.test("regenerateLockFile - runs exactly one regeneration command and stages a marker-free lock", async () => {
  const harness = makeHarness({
    files: { "worker/deno/deno.lock": CONFLICTED_LOCK },
    scripted: { "deno install": { writes: REGENERATED_LOCK } },
  });

  const outcome = await regenerateLockFile("worker/deno/deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["worker/deno/deno.json", "resolved"]]),
  });

  assertEquals(outcome.kind, "regenerated");
  if (outcome.kind !== "regenerated") throw new Error("unreachable");
  assertEquals(outcome.command.bin, "deno");
  assertEquals(outcome.command.args, ["install"]);

  const regens = regenCalls(harness.calls);
  assertEquals(regens.length, 1, "exactly one regeneration command");
  assertEquals(regens[0]?.bin, "deno");
  assertEquals(regens[0]?.args, ["install"]);
  // The tool runs beside its own manifest, not at the repository root.
  assertEquals(regens[0]?.cwd, "/work/repo/worker/deno");

  const written = harness.files.get("worker/deno/deno.lock") ?? "";
  assertEquals(/^(<{7}|={7}|>{7}|\|{7})/m.test(written), false);
  assertEquals(written, REGENERATED_LOCK);

  // Checked out to a known state first, then staged on success.
  const gitCalls = harness.calls.filter((c) => c.bin === "git");
  assertEquals(gitCalls[0]?.args, [
    "checkout",
    "--ours",
    "--",
    "worker/deno/deno.lock",
  ]);
  assertEquals(gitCalls.at(-1)?.args, ["add", "--", "worker/deno/deno.lock"]);
});

Deno.test("regenerateLockFile - regenerates when the manifest was not conflicted at all", async () => {
  const harness = makeHarness({
    files: { "deno.lock": CONFLICTED_LOCK },
    scripted: { "deno install": { writes: REGENERATED_LOCK } },
  });

  const outcome = await regenerateLockFile("deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map(),
  });

  assertEquals(outcome.kind, "regenerated");
  assertEquals(regenCalls(harness.calls).length, 1);
});

Deno.test("regenerateLockFile - uses the npm package-lock-only refresh", async () => {
  const harness = makeHarness({
    files: { "package-lock.json": CONFLICTED_LOCK },
    scripted: {
      "npm install": { writes: REGENERATED_LOCK },
    },
  });

  const outcome = await regenerateLockFile("package-lock.json", {
    ...harness.options,
    manifestOutcomes: new Map([["package.json", "resolved"]]),
  });

  assertEquals(outcome.kind, "regenerated");
  assertEquals(regenCalls(harness.calls)[0]?.args, [
    "install",
    "--package-lock-only",
  ]);
});

// ---------------------------------------------------------------------------
// Never text-merge
// ---------------------------------------------------------------------------

Deno.test("regenerateLockFile - never writes content derived from the conflict hunks", async () => {
  const harness = makeHarness({
    files: { "deno.lock": CONFLICTED_LOCK },
    scripted: { "deno install": { writes: REGENERATED_LOCK } },
  });

  const outcome = await regenerateLockFile("deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["deno.json", "resolved"]]),
  });

  // The outcome carries no file text at all: the only writer of lock content
  // is the ecosystem tool, so there is no path that could text-merge hunks.
  assert(!Object.hasOwn(outcome, "text"), "outcome must carry no lock text");
  const onlyLockWrite = harness.files.get("deno.lock");
  assertEquals(onlyLockWrite, REGENERATED_LOCK);
  // The losing side's line is gone because the tool rewrote the file, not
  // because a hunk was picked.
  assertEquals(onlyLockWrite?.includes("1.0.17"), false);
  assertEquals(outcome.kind, "regenerated");
});

// ---------------------------------------------------------------------------
// Failure branches
// ---------------------------------------------------------------------------

Deno.test("regenerateLockFile - absent toolchain defers with no command run", async () => {
  const harness = makeHarness({
    files: { "go.sum": CONFLICTED_LOCK },
    tools: ["deno", "npm", "cargo", "git"], // container/tools.json has no Go
  });

  const outcome = await regenerateLockFile("go.sum", {
    ...harness.options,
    manifestOutcomes: new Map([["go.mod", "resolved"]]),
  });

  assertStringIncludes(unresolvedReason(outcome), "go");
  assertStringIncludes(unresolvedReason(outcome), "PATH");
  assertEquals(harness.calls.length, 0, "no command may run");
});

Deno.test("regenerateLockFile - non-zero exit defers and stages nothing", async () => {
  const harness = makeHarness({
    files: { "deno.lock": CONFLICTED_LOCK },
    scripted: {
      "deno install": {
        code: 1,
        stderr: "error: failed to resolve jsr:@std/fs",
      },
    },
  });

  const outcome = await regenerateLockFile("deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["deno.json", "resolved"]]),
  });

  assertStringIncludes(unresolvedReason(outcome), "exit 1");
  assertStringIncludes(unresolvedReason(outcome), "failed to resolve");

  const staged = harness.calls.filter((c) =>
    c.bin === "git" && c.args[0] === "add"
  );
  assertEquals(staged.length, 0, "a failed regeneration must stage nothing");
  // The conflicted state is restored so the AI fallback sees the real conflict.
  const restored = harness.calls.filter((c) =>
    c.bin === "git" && c.args[0] === "checkout" && c.args[1] === "--merge"
  );
  assertEquals(restored.length, 1);
});

Deno.test("regenerateLockFile - a zero exit that leaves markers behind defers", async () => {
  const harness = makeHarness({
    files: { "deno.lock": CONFLICTED_LOCK },
    // Exits zero but rewrites nothing, so the markers survive.
    scripted: { "deno install": { code: 0 } },
  });

  const outcome = await regenerateLockFile("deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["deno.json", "resolved"]]),
  });

  assertStringIncludes(unresolvedReason(outcome), "conflict markers");
  const staged = harness.calls.filter((c) =>
    c.bin === "git" && c.args[0] === "add"
  );
  assertEquals(staged.length, 0);
});

Deno.test("regenerateLockFile - a missing lock file after regeneration defers", async () => {
  const harness = makeHarness({
    files: {},
    scripted: { "deno install": { code: 0 } },
  });

  const outcome = await regenerateLockFile("deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["deno.json", "resolved"]]),
  });

  assertStringIncludes(unresolvedReason(outcome), "could not be read");
});

Deno.test("regenerateLockFile - an unresolved manifest defers the lock with no command run", async () => {
  const harness = makeHarness({
    files: { "worker/deno/deno.lock": CONFLICTED_LOCK },
  });

  const outcome = await regenerateLockFile("worker/deno/deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["worker/deno/deno.json", "unresolved"]]),
  });

  assertStringIncludes(unresolvedReason(outcome), "worker/deno/deno.json");
  assertEquals(harness.calls.length, 0, "no command may run");
});

Deno.test("regenerateLockFile - an unresolved deno.jsonc defers its deno.lock", async () => {
  const harness = makeHarness({ files: { "deno.lock": CONFLICTED_LOCK } });

  const outcome = await regenerateLockFile("deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["deno.jsonc", "unresolved"]]),
  });

  assertStringIncludes(unresolvedReason(outcome), "deno.jsonc");
  assertEquals(harness.calls.length, 0);
});

Deno.test("regenerateLockFile - an unrecognised path defers with no command run", async () => {
  const harness = makeHarness({ files: { "src/main.ts": CONFLICTED_LOCK } });

  const outcome = await regenerateLockFile("src/main.ts", {
    ...harness.options,
    manifestOutcomes: new Map(),
  });

  assertStringIncludes(unresolvedReason(outcome), "no lock-file rule");
  assertEquals(harness.calls.length, 0);
});

Deno.test("regenerateLockFile - a traversing or absolute path is refused", async () => {
  const harness = makeHarness({ files: {} });
  const base = { ...harness.options, manifestOutcomes: new Map() };

  for (const path of ["../other/deno.lock", "/etc/deno.lock"]) {
    const outcome = await regenerateLockFile(path, base);
    assertStringIncludes(unresolvedReason(outcome), "unsafe path");
  }
  assertEquals(harness.calls.length, 0);
});

Deno.test("regenerateLockFile - a failed checkout to a known state defers", async () => {
  const harness = makeHarness({
    files: { "deno.lock": CONFLICTED_LOCK },
    scripted: {
      "git checkout": { code: 128, stderr: "error: pathspec did not match" },
    },
  });

  const outcome = await regenerateLockFile("deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["deno.json", "resolved"]]),
  });

  assertStringIncludes(unresolvedReason(outcome), "checkout");
  assertEquals(regenCalls(harness.calls).length, 0, "no regeneration attempt");
});

// ---------------------------------------------------------------------------
// Cargo's offline-first fallback
// ---------------------------------------------------------------------------

Deno.test("regenerateLockFile - cargo tries offline first and stops when it succeeds", async () => {
  const harness = makeHarness({
    files: { "Cargo.lock": CONFLICTED_LOCK },
    scripted: { "cargo update": { writes: REGENERATED_LOCK } },
  });

  const outcome = await regenerateLockFile("Cargo.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["Cargo.toml", "resolved"]]),
  });

  assertEquals(outcome.kind, "regenerated");
  const regens = regenCalls(harness.calls);
  assertEquals(regens.length, 1);
  assertEquals(regens[0]?.args, ["update", "--workspace", "--offline"]);
});

Deno.test("regenerateLockFile - cargo falls back to a network refresh when offline fails", async () => {
  let attempt = 0;
  const files = new Map([["Cargo.lock", CONFLICTED_LOCK]]);
  const calls: RunnerCall[] = [];

  const outcome = await regenerateLockFile("Cargo.lock", {
    workingDir: "/work/repo",
    manifestOutcomes: new Map([["Cargo.toml", "resolved"]]),
    hasTool: () => Promise.resolve(true),
    readLockFile: (path) => Promise.resolve(files.get(path) ?? null),
    runner: (call) => {
      calls.push(call);
      if (call.bin !== "cargo") return Promise.resolve(zero());
      attempt++;
      if (attempt === 1) {
        return Promise.resolve({
          code: 101,
          stdout: "",
          stderr: "error: no matching package; try without --offline",
        });
      }
      files.set("Cargo.lock", REGENERATED_LOCK);
      return Promise.resolve(zero());
    },
  });

  assertEquals(outcome.kind, "regenerated");
  const regens = regenCalls(calls);
  assertEquals(regens.length, 2);
  assertEquals(regens[0]?.args, ["update", "--workspace", "--offline"]);
  assertEquals(regens[1]?.args, ["update", "--workspace"]);
  if (outcome.kind !== "regenerated") throw new Error("unreachable");
  assertEquals(outcome.command.args, ["update", "--workspace"]);
});

/** Convenience: a successful command outcome. */
function zero() {
  return { code: 0, stdout: "", stderr: "" };
}

// ---------------------------------------------------------------------------
// Bounding and redaction
// ---------------------------------------------------------------------------

Deno.test("regenerateLockFile - passes a timeout to every command", async () => {
  const harness = makeHarness({
    files: { "deno.lock": CONFLICTED_LOCK },
    scripted: { "deno install": { writes: REGENERATED_LOCK } },
  });

  await regenerateLockFile("deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["deno.json", "resolved"]]),
  });

  assert(harness.calls.length > 0);
  for (const call of harness.calls) {
    assertEquals(call.timeoutMs, DEFAULT_LOCK_REGEN_TIMEOUT_MS);
  }

  const custom = makeHarness({
    files: { "deno.lock": CONFLICTED_LOCK },
    scripted: { "deno install": { writes: REGENERATED_LOCK } },
  });
  await regenerateLockFile("deno.lock", {
    ...custom.options,
    manifestOutcomes: new Map(),
    timeoutMs: 1234,
  });
  for (const call of custom.calls) assertEquals(call.timeoutMs, 1234);
});

Deno.test("regenerateLockFile - redacts and truncates captured output before it is reported", async () => {
  const secret = `ghp_${"A".repeat(36)}`;
  const noise = Array.from(
    { length: 200 },
    (_, i) => `line ${i} of padding output`,
  ).join("\n");

  const logged: string[] = [];
  const harness = makeHarness({
    files: { "deno.lock": CONFLICTED_LOCK },
    scripted: {
      "deno install": {
        code: 1,
        stdout: `${secret}\n${noise}`,
        stderr: `token=${secret}\nfinal failure line`,
      },
    },
  });

  const outcome = await regenerateLockFile("deno.lock", {
    ...harness.options,
    manifestOutcomes: new Map([["deno.json", "resolved"]]),
    logger: {
      warn: (message: string) => logged.push(message),
    },
  });

  const reason = unresolvedReason(outcome);
  assertEquals(reason.includes(secret), false, "the secret must not survive");
  assertStringIncludes(reason, REDACTION_PLACEHOLDER);
  assertStringIncludes(reason, "final failure line");
  assertStringIncludes(reason, "truncated");
  assert(
    reason.split("\n").length < 60,
    `reason should be a bounded tail, got ${reason.split("\n").length} lines`,
  );

  assert(logged.length > 0, "the failure must be logged");
  assertEquals(logged.some((line) => line.includes(secret)), false);
});

// ---------------------------------------------------------------------------
// Batch behaviour
// ---------------------------------------------------------------------------

Deno.test("regenerateLockFiles - handles each lock file independently and in order", async () => {
  const harness = makeHarness({
    files: {
      "deno.lock": CONFLICTED_LOCK,
      "Cargo.lock": CONFLICTED_LOCK,
      "go.sum": CONFLICTED_LOCK,
    },
    tools: ["deno", "cargo", "git"],
    scripted: {
      "deno install": { writes: REGENERATED_LOCK },
      "cargo update": { writes: REGENERATED_LOCK },
    },
  });

  const outcomes = await regenerateLockFiles({
    ...harness.options,
    lockFiles: ["deno.lock", "go.sum", "Cargo.lock"],
    manifestOutcomes: new Map([["deno.json", "resolved"]]),
  });

  assertEquals(outcomes.map((o) => o.path), [
    "deno.lock",
    "go.sum",
    "Cargo.lock",
  ]);
  assertEquals(outcomes.map((o) => o.kind), [
    "regenerated",
    "unresolved",
    "regenerated",
  ]);
});

Deno.test("regenerateLockFiles - returns an empty list for no lock files", async () => {
  const harness = makeHarness();
  const outcomes = await regenerateLockFiles({
    ...harness.options,
    lockFiles: [],
    manifestOutcomes: new Map(),
  });
  assertEquals(outcomes, []);
  assertEquals(harness.calls.length, 0);
});
