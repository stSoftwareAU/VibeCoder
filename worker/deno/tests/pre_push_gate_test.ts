/**
 * Tests for the pre-push gate (Issue #3394).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import {
  defaultPrePushGit,
  listPushedFiles,
  parsePrePushRefs,
  planChangedFileChecks,
  type PrePushGit,
  runPrePushGate,
} from "../lib/pre_push_gate.ts";
import {
  PreFlightGateError,
  type PreFlightRunner,
} from "../lib/pre_flight_gate.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);

Deno.test("parsePrePushRefs: valid line, blank lines ignored", () => {
  const result = parsePrePushRefs(
    `\nrefs/heads/m ${SHA_A} refs/heads/m ${SHA_B}\n\n`,
  );
  assert(result.ok);
  assertEquals(result.value, [{
    localRef: "refs/heads/m",
    localSha: SHA_A,
    remoteRef: "refs/heads/m",
    remoteSha: SHA_B,
  }]);
});

Deno.test("parsePrePushRefs: deletes are dropped", () => {
  const result = parsePrePushRefs(
    `(delete) ${ZERO} refs/heads/gone ${SHA_B}\n`,
  );
  assert(result.ok);
  assertEquals(result.value, []);
});

Deno.test("parsePrePushRefs: malformed input fails closed", () => {
  assert(!parsePrePushRefs("refs/heads/m abc refs/heads/m def").ok);
  assert(!parsePrePushRefs(`refs/heads/m ${SHA_A} refs/heads/m`).ok);
  assert(!parsePrePushRefs(`a ${SHA_A} b ${SHA_B} extra`).ok);
});

Deno.test("planChangedFileChecks: doc-only change plans fmt and markdownlint, no lint", () => {
  const result = planChangedFileChecks(
    ["README.md"],
    ["deno.json", ".markdownlint-cli2.jsonc", "README.md"],
    { repoRoot: "/r", markdownlintBinary: "/r/node_modules/.bin/mdl" },
  );
  assert(result.ok);
  const commands = result.value.map((c) => c.command);
  assertEquals(commands, [
    "deno fmt --check --permit-no-files 'README.md'",
    "'/r/node_modules/.bin/mdl' 'README.md'",
  ]);
  assert(result.value.every((c) => c.cwd === "/r"));
});

Deno.test("planChangedFileChecks: nested deno root uses its own cwd and relative paths", () => {
  const result = planChangedFileChecks(
    ["sub/a.ts", "top.md"],
    ["sub/deno.json", "sub/a.ts"],
    { repoRoot: "/r", markdownlintBinary: null },
  );
  assert(result.ok);
  assertEquals(result.value.map((c) => [c.cwd, c.command]), [
    ["/r/sub", "deno fmt --check --permit-no-files 'a.ts'"],
    ["/r/sub", "deno lint --permit-no-files 'a.ts'"],
  ]);
});

Deno.test("planChangedFileChecks: cargo fmt when a .rs file changes", () => {
  const result = planChangedFileChecks(["crate/src/lib.rs"], [
    "crate/Cargo.toml",
  ], { repoRoot: "/r", markdownlintBinary: null });
  assert(result.ok);
  assertEquals(result.value.map((c) => [c.cwd, c.command]), [
    ["/r/crate", "cargo fmt --all --check"],
  ]);
});

Deno.test("planChangedFileChecks: a Cargo root with no changed .rs file gets no cargo fmt", () => {
  const tracked = ["Cargo.toml", "src/lib.rs", "README.md"];
  const opts = { repoRoot: "/r", markdownlintBinary: null };
  const untouched = planChangedFileChecks(["README.md"], tracked, opts);
  assert(untouched.ok);
  assert(untouched.value.every((c) => !c.command.includes("cargo")));
  const touched = planChangedFileChecks(["src/lib.rs"], tracked, opts);
  assert(touched.ok);
  assert(touched.value.some((c) => c.command === "cargo fmt --all --check"));
});

Deno.test("planChangedFileChecks: markdownlint configured but binary missing is an error", () => {
  const result = planChangedFileChecks(["a.md"], [".markdownlint-cli2.jsonc"], {
    repoRoot: "/r",
    markdownlintBinary: null,
  });
  assert(!result.ok);
  assert(result.error.includes("could not be found"));
});

Deno.test("planChangedFileChecks: no markdownlint config means no markdownlint check", () => {
  const result = planChangedFileChecks(["a.md"], ["deno.json"], {
    repoRoot: "/r",
    markdownlintBinary: null,
  });
  assert(result.ok);
  assertEquals(result.value.length, 1);
  assert(result.value[0]!.command.startsWith("deno fmt"));
});

Deno.test("planChangedFileChecks: unquotable path is an error naming the file", () => {
  const name = `we'ird"name.ts`;
  const result = planChangedFileChecks([name], ["deno.json"], {
    repoRoot: "/r",
    markdownlintBinary: null,
  });
  assert(!result.ok);
  assert(result.error.includes("we'ird"));
});

Deno.test("planChangedFileChecks: files outside the deno fmt/lint include are not checked", () => {
  const denoScopes = {
    ".": { fmt: { include: ["src/"] }, lint: { include: ["src/"] } },
  };
  const opts = { repoRoot: "/r", markdownlintBinary: null, denoScopes };
  const outOfScope = planChangedFileChecks(
    ["README.md", "scripts/x.ts"],
    ["deno.json", "README.md"],
    opts,
  );
  assert(outOfScope.ok);
  assertEquals(outOfScope.value, []);

  const mixed = planChangedFileChecks(
    ["README.md", "src/a.ts"],
    ["deno.json"],
    opts,
  );
  assert(mixed.ok);
  assertEquals(mixed.value.map((c) => c.command), [
    "deno fmt --check --permit-no-files 'src/a.ts'",
    "deno lint --permit-no-files 'src/a.ts'",
  ]);
});

Deno.test("planChangedFileChecks: an include of the config directory still plans deno fmt and lint", () => {
  for (const entry of [".", "./"]) {
    const result = planChangedFileChecks(
      ["README.md", "src/a.ts"],
      ["deno.json"],
      {
        repoRoot: "/r",
        markdownlintBinary: null,
        denoScopes: {
          ".": { fmt: { include: [entry] }, lint: { include: [entry] } },
        },
      },
    );
    assert(result.ok);
    assertEquals(result.value.map((c) => c.command), [
      "deno fmt --check --permit-no-files 'README.md' 'src/a.ts'",
      "deno lint --permit-no-files 'src/a.ts'",
    ]);
  }
});

Deno.test("planChangedFileChecks: a nested root filters against its own scope, relative to it", () => {
  const result = planChangedFileChecks(
    ["worker/deno/lib/a.ts", "worker/deno/README.md"],
    ["worker/deno/deno.json"],
    {
      repoRoot: "/r",
      markdownlintBinary: null,
      denoScopes: { "worker/deno": { fmt: { include: ["lib/"] } } },
    },
  );
  assert(result.ok);
  assertEquals(result.value.map((c) => c.command), [
    "deno fmt --check --permit-no-files 'lib/a.ts'",
    "deno lint --permit-no-files 'lib/a.ts'",
  ]);
});

// ---- runPrePushGate against a real git repo --------------------------------

const GIT_ENV = ["-c", "user.email=t@e", "-c", "user.name=t"];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args: [...GIT_ENV, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (out.code !== 0) {
    throw new Error(new TextDecoder().decode(out.stderr));
  }
  return new TextDecoder().decode(out.stdout).trim();
}

/** Bare remote + clone with a pushed initial commit, then one local doc commit. */
async function makeRepoWithDocCommit(): Promise<
  { root: string; clone: string; stdin: string }
> {
  const root = await Deno.makeTempDir({ prefix: "vibe-pp-gate-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  await git(root, "clone", "-q", remote, clone);
  await Deno.writeTextFile(`${clone}/deno.json`, "{}\n");
  await Deno.writeTextFile(`${clone}/.markdownlint-cli2.jsonc`, "{}\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "init");
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await Deno.writeTextFile(`${clone}/README.md`, "#Bad\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "docs");
  const sha = await git(clone, "rev-parse", "HEAD");
  return {
    root,
    clone,
    stdin: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
  };
}

function recordingRunner(
  failWhen: (command: string) => boolean,
  seen: string[],
): PreFlightRunner {
  return (command) => {
    seen.push(command);
    return Promise.resolve({
      started: true,
      code: failWhen(command) ? 1 : 0,
      stdout: "",
      stderr: failWhen(command) ? "boom" : "",
    });
  };
}

Deno.test("listPushedFiles: only files introduced by unpushed commits", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    const refs = parsePrePushRefs(stdin);
    assert(refs.ok);
    const files = await listPushedFiles(refs.value, clone, async (a, c) => {
      const out = await new Deno.Command("git", {
        args: a,
        cwd: c,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      return {
        code: out.code,
        stdout: d.decode(out.stdout),
        stderr: d.decode(out.stderr),
      };
    });
    assert(files.ok);
    assertEquals(files.value, ["README.md"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("listPushedFiles: a committed symlink is not a regular file and is skipped", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await Deno.writeTextFile(`${clone}/target.md`, "# Target\n");
    await Deno.symlink("target.md", `${clone}/link.md`);
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "symlink");
    const sha = await git(clone, "rev-parse", "HEAD");
    const refs = parsePrePushRefs(
      `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
    );
    assert(refs.ok);
    const files = await listPushedFiles(refs.value, clone, async (a, c) => {
      const out = await new Deno.Command("git", {
        args: a,
        cwd: c,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      return {
        code: out.code,
        stdout: d.decode(out.stdout),
        stderr: d.decode(out.stderr),
      };
    });
    assert(files.ok);
    assert(files.value.includes("target.md"));
    assert(!files.value.includes("link.md"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: doc-only push blocked by failing markdownlint", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    const seen: string[] = [];
    const run = (fail: boolean) =>
      runPrePushGate({
        cwd: clone,
        stdin,
        preFlightCommands: [],
        runner: recordingRunner(
          (c) => fail && c.includes("/fake/mdl"),
          seen,
        ),
        findMarkdownlint: () => Promise.resolve("/fake/mdl"),
      });

    const blocked = await run(true);
    assert(!blocked.ok);
    assertInstanceOf(blocked.error, PreFlightGateError);
    assertEquals(blocked.error.reason, "non-zero-exit");
    assert(blocked.error.command.includes("/fake/mdl"));

    const accepted = await run(false);
    assert(accepted.ok);
    assertEquals(accepted.value.checksRun.length, 2);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a doc outside the repo's deno fmt include is not deno-checked", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    await Deno.writeTextFile(
      `${clone}/deno.json`,
      '{ // scoped\n "fmt": {"include": ["src/"]}, "lint": {"include": ["src/"]} }\n',
    );
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(() => false, seen),
      findMarkdownlint: () => Promise.resolve("/fake/mdl"),
    });
    assert(result.ok);
    // Only markdownlint ran: README.md is outside fmt.include.
    assertEquals(result.value.checksRun.length, 1);
    assert(result.value.checksRun[0]?.includes("/fake/mdl"));
    assert(!seen.some((c) => c.startsWith("deno ")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const SCOPED =
  '{ "fmt": {"include": ["src/"]}, "lint": {"include": ["src/"]} }';

/** Run the gate over the doc-commit repo and return the deno commands run. */
async function denoCommandsRun(
  setup: (clone: string) => Promise<void>,
): Promise<string[]> {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    await setup(clone);
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(() => false, seen),
      findMarkdownlint: () => Promise.resolve("/fake/mdl"),
    });
    assert(result.ok);
    return seen.filter((c) => c.startsWith("deno "));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("runPrePushGate: an unparseable deno.json leaves the push unfiltered", async () => {
  const ran = await denoCommandsRun((clone) =>
    Deno.writeTextFile(`${clone}/deno.json`, "{ not json")
  );
  assertEquals(ran, ["deno fmt --check --permit-no-files 'README.md'"]);
});

Deno.test("runPrePushGate: a deno.jsonc alone supplies the scope", async () => {
  const ran = await denoCommandsRun(async (clone) => {
    await Deno.remove(`${clone}/deno.json`);
    await Deno.writeTextFile(`${clone}/deno.jsonc`, SCOPED);
  });
  assertEquals(ran, []);
});

Deno.test("runPrePushGate: deno.json wins over a deno.jsonc beside it", async () => {
  const ran = await denoCommandsRun(async (clone) => {
    await Deno.writeTextFile(`${clone}/deno.json`, SCOPED);
    await Deno.writeTextFile(`${clone}/deno.jsonc`, "{}");
  });
  assertEquals(ran, []);
  const unscoped = await denoCommandsRun(async (clone) => {
    await Deno.writeTextFile(`${clone}/deno.json`, "{}");
    await Deno.writeTextFile(`${clone}/deno.jsonc`, SCOPED);
  });
  assertEquals(unscoped, ["deno fmt --check --permit-no-files 'README.md'"]);
});

Deno.test("runPrePushGate: pre-flight failure blocks after changed-file checks ran", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: ["make-it-fail"],
      runner: recordingRunner((c) => c === "make-it-fail", seen),
      findMarkdownlint: () => Promise.resolve("/fake/mdl"),
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PreFlightGateError);
    assertEquals(result.error.reason, "non-zero-exit");
    assertEquals(result.error.command, "make-it-fail");
    assertEquals(seen.length, 3);
    assertEquals(seen[2], "make-it-fail");
    assert(seen[0]!.startsWith("deno fmt"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: git log failure is an error", async () => {
  const failing: PrePushGit = () =>
    Promise.resolve({ code: 128, stdout: "", stderr: "fatal: nope" });
  const result = await runPrePushGate({
    cwd: "/nonexistent",
    stdin: `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}\n`,
    preFlightCommands: [],
    git: failing,
  });
  assert(!result.ok);
  assert(result.error.message.includes("git log failed"));
});

Deno.test("runPrePushGate: malformed hook input is an error", async () => {
  const result = await runPrePushGate({
    cwd: "/x",
    stdin: "garbage",
    preFlightCommands: [],
  });
  assert(!result.ok);
});

Deno.test("runPrePushGate: git ls-files failure is an error", async () => {
  const calls: string[] = [];
  const makeGit = (lsFilesCode: number): PrePushGit => (args) => {
    calls.push(args[0]!);
    if (args[0] === "ls-files") {
      return Promise.resolve({
        code: lsFilesCode,
        stdout: "",
        stderr: lsFilesCode === 0 ? "" : "fatal: index corrupt",
      });
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const input = {
    cwd: "/nonexistent",
    stdin: `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}\n`,
    preFlightCommands: [],
  };
  const failed = await runPrePushGate({ ...input, git: makeGit(128) });
  assert(!failed.ok);
  assert(failed.error.message.includes("ls-files"));
  assert(failed.error.message.includes("index corrupt"));
  assertEquals(calls, ["log", "ls-files"]);

  const accepted = await runPrePushGate({ ...input, git: makeGit(0) });
  assert(accepted.ok);
});

Deno.test("defaultPrePushGit: a nonexistent working directory fails closed", async () => {
  const result = await defaultPrePushGit(
    ["status"],
    "/nonexistent/vibe-pre-push-dir",
  );
  assert(result.code !== 0);
  assert(result.stderr.trim().length > 0);

  const dir = await Deno.makeTempDir({ prefix: "pre_push_default_git_" });
  try {
    const ok = await defaultPrePushGit(["--version"], dir);
    assertEquals(ok.code, 0);
    assert(ok.stdout.startsWith("git version"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
