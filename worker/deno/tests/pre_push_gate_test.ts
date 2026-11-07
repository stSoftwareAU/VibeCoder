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
  PrePushGateInfrastructureError,
  type PrePushGit,
  repoCiRunsCspell,
  runPrePushGate,
  workflowRunsCspell,
} from "../lib/pre_push_gate.ts";
import {
  type PreFlightCommandResult,
  PreFlightGateError,
  type PreFlightRunner,
  tokeniseCommand,
} from "../lib/pre_flight_gate.ts";
import {
  type CiCargoCheck,
  type CiCargoScan,
  scanWorkflowForCargoChecks,
} from "../lib/ci_cargo_checks.ts";
import { TIMEOUT_EXIT_CODE } from "../lib/git_timeout.ts";

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

Deno.test("listPushedFiles: baseRef lists pushed commits ahead of the base; an option-like baseRef is refused (#3689)", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    // Model a WIP checkpoint push: origin/main now holds the docs commit. A
    // ref update, not a real push, so an ambient pre-push hook cannot refuse it.
    await git(clone, "update-ref", "refs/remotes/origin/main", "HEAD");
    const initSha = await git(clone, "rev-parse", "HEAD~1");
    const refs = parsePrePushRefs(stdin);
    assert(refs.ok);
    const run: PrePushGit = async (a, c) => {
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
    };
    // Already on origin (a WIP checkpoint push): the default range is empty.
    const unpushedOnly = await listPushedFiles(refs.value, clone, run);
    assert(unpushedOnly.ok);
    assertEquals(unpushedOnly.value, []);
    // The whole-branch range still sees it.
    const ahead = await listPushedFiles(refs.value, clone, run, initSha);
    assert(ahead.ok);
    assertEquals(ahead.value, ["README.md"]);
    const unsafe = await listPushedFiles(refs.value, clone, run, "--all");
    assert(!unsafe.ok);
    assert(unsafe.error.includes("unsafe base ref"));
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
  // The lookup failed; nothing was decided about the branch (PR #3716 review).
  assertInstanceOf(result.error, PrePushGateInfrastructureError);
});

Deno.test("runPrePushGate: malformed hook input is not infrastructure (PR #3716 review)", async () => {
  const result = await runPrePushGate({
    cwd: "/x",
    stdin: "garbage",
    preFlightCommands: [],
  });
  assert(!result.ok);
  assert(!(result.error instanceof PrePushGateInfrastructureError));
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
  assertInstanceOf(failed.error, PrePushGateInfrastructureError);
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

// ---- cspell (Issue #3689) ---------------------------------------------------

Deno.test("planChangedFileChecks: cspell config and a changed .md plans cspell with the files", () => {
  const result = planChangedFileChecks(
    ["pr-summary-1.md", "x.rs"],
    ["cspell.json"],
    {
      repoRoot: "/r",
      markdownlintBinary: null,
      cspellBinary: "/r/bin/cspell",
      cspellInCi: true,
    },
  );
  assert(result.ok);
  const check = result.value.find((c) => c.label === "cspell");
  assert(check !== undefined);
  assertEquals(
    check.command,
    "'/r/bin/cspell' --no-progress --no-summary --no-must-find-files " +
      "'pr-summary-1.md'",
  );
  assertEquals(check.cwd, "/r");
});

Deno.test("planChangedFileChecks: a docs/cspell.json config is passed with --config", () => {
  const result = planChangedFileChecks(["CHANGELOG.md"], ["docs/cspell.json"], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: "/r/bin/cspell",
    cspellInCi: true,
  });
  assert(result.ok);
  assert(result.value[0]!.command.includes("--config docs/cspell.json "));
});

Deno.test("planChangedFileChecks: no cspell config means no cspell check", () => {
  const result = planChangedFileChecks(["a.md"], ["README.md"], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: null,
    cspellInCi: true,
  });
  assert(result.ok);
  assertEquals(result.value, []);
});

Deno.test("planChangedFileChecks: cspell configured but binary missing is an error naming cspell", () => {
  const result = planChangedFileChecks(["a.md"], ["cspell.json"], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: null,
    cspellInCi: true,
  });
  assert(!result.ok);
  assert(result.error.includes("cspell"));
});

Deno.test("planChangedFileChecks: only non-spellchecked extensions means no cspell check", () => {
  const result = planChangedFileChecks(["src/a.rs"], ["cspell.json"], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: null,
    cspellInCi: true,
  });
  assert(result.ok);
  assertEquals(result.value, []);
});

Deno.test("planChangedFileChecks: cspell config but repo CI does not run cspell plans no check and is not blocked", () => {
  const result = planChangedFileChecks(["notes.md"], ["cspell.json"], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: null,
    cspellInCi: false,
  });
  assert(result.ok);
  assertEquals(result.value.find((c) => c.label === "cspell"), undefined);
});

Deno.test("repoCiRunsCspell: a workflow run step naming cspell counts", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/workflows/spell.yml`,
      'jobs:\n  spell:\n    steps:\n      - run: npx cspell "**/*.md"\n',
    );
    assertEquals(
      await repoCiRunsCspell(dir, [".github/workflows/spell.yml"]),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repoCiRunsCspell: a commented-out cspell step does not count", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/workflows/ci.yml`,
      "jobs:\n  test:\n    steps:\n      # - run: cspell .\n      - run: deno test\n",
    );
    assertEquals(
      await repoCiRunsCspell(dir, [".github/workflows/ci.yml"]),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repoCiRunsCspell: a tracked file outside .github/workflows/ or not YAML does not count", async () => {
  const dir = await Deno.makeTempDir();
  const body = "jobs:\n  spell:\n    steps:\n      - run: npx cspell .\n";
  try {
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.mkdir(`${dir}/ci`, { recursive: true });
    await Deno.writeTextFile(`${dir}/.github/workflows/real.yml`, body);
    await Deno.writeTextFile(`${dir}/ci/spell.yml`, body);
    await Deno.writeTextFile(`${dir}/.github/workflows/notes.md`, body);
    // Positive control: the same text in a tracked workflow YAML counts.
    assertEquals(
      await repoCiRunsCspell(dir, [".github/workflows/real.yml"]),
      true,
    );
    // Prefix filter: a YAML outside .github/workflows/ is another CI system's.
    assertEquals(await repoCiRunsCspell(dir, ["ci/spell.yml"]), false);
    // Extension filter: a non-YAML file under .github/workflows/ is not a workflow.
    assertEquals(
      await repoCiRunsCspell(dir, [".github/workflows/notes.md"]),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("repoCiRunsCspell: a tracked workflow that cannot be read is skipped", async () => {
  assertEquals(
    await repoCiRunsCspell("/nonexistent", [".github/workflows/x.yml"]),
    false,
  );
});

Deno.test("workflowRunsCspell: a block-scalar run step that calls cspell counts", () => {
  const yml =
    'jobs:\n  spell:\n    steps:\n      - name: Spell\n        run: |\n          npm ci\n          npx cspell --config docs/cspell.json "**/*.md"\n';
  assert(workflowRunsCspell(yml));
});

Deno.test("workflowRunsCspell: GRQ's cspell-action uses step counts", () => {
  const yml =
    "jobs:\n  spell:\n    steps:\n      - uses: streetsidesoftware/cspell-action@v6\n";
  assert(workflowRunsCspell(yml));
});

Deno.test("workflowRunsCspell: block-scalar and single-line steps without cspell do not count", () => {
  assert(
    !workflowRunsCspell(
      "jobs:\n  test:\n    steps:\n      - run: |\n          deno test\n          deno lint\n      - run: deno fmt --check\n",
    ),
  );
});

Deno.test("workflowRunsCspell: a commented-out cspell step inside a block does not count", () => {
  assert(
    !workflowRunsCspell(
      "jobs:\n  test:\n    steps:\n      - run: |\n          deno test\n          # npx cspell .\n",
    ),
  );
});

// Each test below goes red when one branch of workflowRunsCspell is broken
// (PR #3716 review): the block end, the blank-line skip, and the block header.
Deno.test("workflowRunsCspell: a single-line cspell step after a block-scalar step counts", () => {
  assert(
    workflowRunsCspell(
      'jobs:\n  test:\n    steps:\n      - run: |\n          npm ci\n      - run: npx cspell "**/*.md"\n',
    ),
  );
});

Deno.test("workflowRunsCspell: a blank line inside a block does not end it", () => {
  assert(
    workflowRunsCspell(
      'jobs:\n  test:\n    steps:\n      - run: |\n          npm ci\n\n          npx cspell "**/*.md"\n',
    ),
  );
});

Deno.test("workflowRunsCspell: block headers with chomping or indent indicators are blocks", () => {
  for (const header of ["|-", ">", ">-", "|+", "|2"]) {
    assert(
      workflowRunsCspell(
        `jobs:\n  test:\n    steps:\n      - run: ${header}\n          npx cspell "**/*.md"\n`,
      ),
      `header ${header}`,
    );
  }
});

Deno.test("runPrePushGate: a cspell config with no CI cspell step is not blocked and never looks for cspell", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${clone}/docs`, { recursive: true });
    await Deno.writeTextFile(`${clone}/docs/cspell.json`, "{}\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "nested cspell config");
    const tip = await git(clone, "rev-parse", "HEAD");
    let looked = false;
    const result = await runPrePushGate({
      cwd: clone,
      stdin: stdin.replace(
        / [0-9a-f]{40} refs\/heads\/main/,
        ` ${tip} refs/heads/main`,
      ),
      preFlightCommands: [],
      runner: recordingRunner(() => false, []),
      findMarkdownlint: () => Promise.resolve("/fake/mdl"),
      findCspell: () => {
        looked = true;
        return Promise.resolve(null);
      },
    });
    assert(!looked, "cspell must not be looked up when CI does not run it");
    assert(
      result.ok,
      `the push must not be blocked on cspell: ${
        result.ok ? "" : result.error.message
      }`,
    );
    assert(
      !result.value.checksRun.some((c) => c.includes("--no-must-find-files")),
      `no cspell check may be planned: ${
        JSON.stringify(result.value.checksRun)
      }`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a cspell config with a GRQ-style cspell-action step is blocked when cspell is missing", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${clone}/docs`, { recursive: true });
    await Deno.writeTextFile(`${clone}/docs/cspell.json`, "{}\n");
    await Deno.mkdir(`${clone}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/.github/workflows/spell.yml`,
      "jobs:\n  spell:\n    steps:\n      - uses: streetsidesoftware/cspell-action@v6\n",
    );
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "cspell config and CI");
    const tip = await git(clone, "rev-parse", "HEAD");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: stdin.replace(
        / [0-9a-f]{40} refs\/heads\/main/,
        ` ${tip} refs/heads/main`,
      ),
      preFlightCommands: [],
      runner: recordingRunner(() => false, []),
      findMarkdownlint: () => Promise.resolve("/fake/mdl"),
      findCspell: () => Promise.resolve(null),
    });
    assert(!result.ok, "CI runs cspell, so a missing binary must block");
    assert(result.error.message.includes("cspell"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a failing cspell blocks the push", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    await Deno.writeTextFile(`${clone}/cspell.json`, "{}\n");
    // The repo's own CI runs cspell, so the gate must run it too.
    await Deno.mkdir(`${clone}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/.github/workflows/spell.yml`,
      'jobs:\n  spell:\n    steps:\n      - run: npx cspell "**/*.md"\n',
    );
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "cspell config and CI");
    const tip = await git(clone, "rev-parse", "HEAD");
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: stdin.replace(
        / [0-9a-f]{40} refs\/heads\/main/,
        ` ${tip} refs/heads/main`,
      ),
      preFlightCommands: [],
      runner: recordingRunner((c) => c.includes("/fake/cspell"), seen),
      findMarkdownlint: () => Promise.resolve("/fake/mdl"),
      findCspell: () => Promise.resolve("/fake/cspell"),
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PreFlightGateError);
    assert(result.error.command.includes("/fake/cspell"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---- Floci CloudFormation deploy test (Issue #3727) ----------------------------

const FLOCI_CHECK = "floci cloudformation";
const FLOCI_COMMAND = "bash infra/cloudformation/test-floci.sh";

Deno.test("planChangedFileChecks: a changed template plans the Floci deploy test once", () => {
  const result = planChangedFileChecks(
    [
      "infra/cloudformation/linux-verification-host.yaml",
      "infra/cloudformation/other.yaml",
    ],
    [
      "infra/cloudformation/test-floci.sh",
      "infra/cloudformation/linux-verification-host.yaml",
    ],
    { repoRoot: "/repo", markdownlintBinary: null },
  );
  assert(result.ok);
  assertEquals(
    result.value.filter((c) => c.label === FLOCI_CHECK),
    [{ label: FLOCI_CHECK, cwd: "/repo", command: FLOCI_COMMAND }],
  );
});

Deno.test("planChangedFileChecks: a change to test-floci.sh itself plans the Floci deploy test", () => {
  const result = planChangedFileChecks(
    ["infra/cloudformation/test-floci.sh"],
    ["infra/cloudformation/test-floci.sh"],
    { repoRoot: "/repo", markdownlintBinary: null },
  );
  assert(result.ok);
  assertEquals(
    result.value.filter((c) => c.label === FLOCI_CHECK),
    [{ label: FLOCI_CHECK, cwd: "/repo", command: FLOCI_COMMAND }],
  );
});

Deno.test("planChangedFileChecks: no Floci deploy test outside infra/cloudformation/", () => {
  const result = planChangedFileChecks(
    [
      "infra/host/install-deno.sh",
      "infra/cloudformation-old/x.yaml",
      "docs/a.md",
    ],
    ["infra/cloudformation/test-floci.sh", "docs/a.md"],
    { repoRoot: "/repo", markdownlintBinary: null },
  );
  assert(result.ok);
  assertEquals(result.value.filter((c) => c.label === FLOCI_CHECK), []);
});

Deno.test("planChangedFileChecks: no Floci deploy test when the repo does not track the script", () => {
  const result = planChangedFileChecks(
    ["infra/cloudformation/linux-verification-host.yaml"],
    ["infra/cloudformation/linux-verification-host.yaml"],
    { repoRoot: "/repo", markdownlintBinary: null },
  );
  assert(result.ok);
  assertEquals(result.value.filter((c) => c.label === FLOCI_CHECK), []);
});

/**
 * Like {@link makeRepoWithDocCommit}, but the one local commit adds the Floci
 * script and a CloudFormation template under `infra/cloudformation/`.
 */
async function makeRepoWithFlociCommit(): Promise<
  { root: string; clone: string; stdin: string }
> {
  const root = await Deno.makeTempDir({ prefix: "vibe-pp-floci-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  await git(root, "clone", "-q", remote, clone);
  await Deno.writeTextFile(`${clone}/deno.json`, "{}\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "init");
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await Deno.mkdir(`${clone}/infra/cloudformation`, { recursive: true });
  await Deno.writeTextFile(
    `${clone}/infra/cloudformation/test-floci.sh`,
    "#!/usr/bin/env bash\n",
  );
  await Deno.writeTextFile(
    `${clone}/infra/cloudformation/t.yaml`,
    "AWSTemplateFormatVersion: '2010-09-09'\n",
  );
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "floci");
  const sha = await git(clone, "rev-parse", "HEAD");
  return {
    root,
    clone,
    stdin: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
  };
}

Deno.test("runPrePushGate: a failing Floci deploy test blocks the push", async () => {
  const { root, clone, stdin } = await makeRepoWithFlociCommit();
  try {
    const seen: string[] = [];
    const run = (fail: boolean) =>
      runPrePushGate({
        cwd: clone,
        stdin,
        preFlightCommands: [],
        runner: recordingRunner(
          (c) => fail && c.includes("test-floci.sh"),
          seen,
        ),
      });

    const blocked = await run(true);
    assert(!blocked.ok);
    assertInstanceOf(blocked.error, PreFlightGateError);
    assertEquals(blocked.error.reason, "non-zero-exit");
    assertEquals(blocked.error.command, FLOCI_COMMAND);

    const accepted = await run(false);
    assert(accepted.ok);
    assert(accepted.value.checksRun.includes(FLOCI_COMMAND));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---- CI cargo checks (Issue #4630) ------------------------------------------

const CLIPPY_ARGV = [
  "cargo",
  "clippy",
  "--all-targets",
  "--locked",
  "--",
  "-D",
  "warnings",
];
const CLIPPY_CMD = "cargo clippy --all-targets --locked -- -D warnings";
const CLIPPY_CHECK: CiCargoCheck = {
  kind: "clippy",
  workingDirectory: "rust",
  argv: CLIPPY_ARGV,
  env: { RUSTFLAGS: "-D warnings" },
  source: "ci.yml",
};

function scanOf(...checks: CiCargoCheck[]): CiCargoScan {
  return { checks, unverifiable: [] };
}

/** A workflow whose lint job runs clippy and a covered test build in `rust`. */
const RUST_WORKFLOW = [
  "on:",
  "  pull_request:",
  "env:",
  '  RUSTFLAGS: "-D warnings"',
  "jobs:",
  "  lint:",
  "    defaults:",
  "      run:",
  "        working-directory: rust",
  "    steps:",
  `      - run: ${CLIPPY_CMD}`,
  "      - run: cargo test --workspace --locked",
  "",
].join("\n");

/** Two crate directories: clippy covers `rust`, a test build covers `tools`. */
const LINT_WORKFLOW = [
  "on:",
  "  pull_request:",
  "jobs:",
  "  lint:",
  "    defaults:",
  "      run:",
  "        working-directory: rust",
  "    steps:",
  `      - run: ${CLIPPY_CMD}`,
  "      - run: cargo test --workspace --locked",
  "  tools:",
  "    defaults:",
  "      run:",
  "        working-directory: tools",
  "    steps:",
  "      - run: cargo nextest run -p core",
  "",
].join("\n");

Deno.test("planChangedFileChecks: a changed .rs plans the CI clippy with its argv, env and working directory", () => {
  const result = planChangedFileChecks(
    ["rust/src/lib.rs"],
    ["rust/Cargo.toml", "rust/src/lib.rs"],
    { repoRoot: "/r", markdownlintBinary: null, ciCargo: scanOf(CLIPPY_CHECK) },
  );
  assert(result.ok);
  assertEquals(result.value.filter((c) => c.cargo !== undefined), [{
    label: "cargo clippy (rust)",
    cwd: "/r/rust",
    command: CLIPPY_CMD,
    env: { RUSTFLAGS: "-D warnings" },
    cargo: { kind: "clippy" },
  }]);
  // The planned command is the CI argv, token for token.
  assertEquals(tokeniseCommand(CLIPPY_CMD), CLIPPY_ARGV);
});

Deno.test("planChangedFileChecks: the CI cargo checks come after cargo fmt", () => {
  const result = planChangedFileChecks(
    ["rust/src/lib.rs"],
    ["rust/Cargo.toml", "rust/src/lib.rs"],
    { repoRoot: "/r", markdownlintBinary: null, ciCargo: scanOf(CLIPPY_CHECK) },
  );
  assert(result.ok);
  assertEquals(result.value.map((c) => c.label), [
    "cargo fmt (rust)",
    "cargo clippy (rust)",
  ]);
});

Deno.test("planChangedFileChecks: a changed Cargo.lock plans the CI clippy at the root", () => {
  const scan = scanOf({ ...CLIPPY_CHECK, workingDirectory: "." });
  const result = planChangedFileChecks(["Cargo.lock"], ["Cargo.lock"], {
    repoRoot: "/r",
    markdownlintBinary: null,
    ciCargo: scan,
  });
  assert(result.ok);
  assertEquals(result.value.map((c) => [c.label, c.cwd]), [
    ["cargo clippy (.)", "/r"],
  ]);
});

Deno.test("planChangedFileChecks: a changed README.md plans no CI cargo check", () => {
  const result = planChangedFileChecks(
    ["README.md"],
    ["rust/Cargo.toml", "README.md"],
    { repoRoot: "/r", markdownlintBinary: null, ciCargo: scanOf(CLIPPY_CHECK) },
  );
  assert(result.ok);
  assertEquals(result.value, []);
});

Deno.test("planChangedFileChecks: a .rs outside the CI working directory plans no CI cargo check", () => {
  const result = planChangedFileChecks(
    ["docs/x.rs"],
    ["rust/Cargo.toml", "docs/x.rs"],
    { repoRoot: "/r", markdownlintBinary: null, ciCargo: scanOf(CLIPPY_CHECK) },
  );
  assert(result.ok);
  assertEquals(result.value, []);
});

Deno.test("planChangedFileChecks: no ciCargo option plans no CI cargo check", () => {
  const result = planChangedFileChecks(
    ["rust/src/lib.rs"],
    ["rust/Cargo.toml"],
    { repoRoot: "/r", markdownlintBinary: null },
  );
  assert(result.ok);
  assertEquals(result.value.map((c) => c.command), ["cargo fmt --all --check"]);
});

Deno.test("planChangedFileChecks: clippy is planned before the test-target compile, and an identical check once", () => {
  const testBuild: CiCargoCheck = {
    kind: "test-build",
    workingDirectory: "rust",
    argv: ["cargo", "test", "--no-run", "--locked"],
    env: {},
    source: "ci.yml",
  };
  const result = planChangedFileChecks(
    ["rust/src/lib.rs"],
    ["rust/Cargo.toml"],
    {
      repoRoot: "/r",
      markdownlintBinary: null,
      ciCargo: scanOf(testBuild, CLIPPY_CHECK, CLIPPY_CHECK),
    },
  );
  assert(result.ok);
  assertEquals(
    result.value.filter((c) => c.cargo !== undefined).map((c) => c.label),
    ["cargo clippy (rust)", "cargo test --no-run (rust)"],
  );
});

Deno.test("planChangedFileChecks: a CI +toolchain is kept as the cargo toolchain", () => {
  const check: CiCargoCheck = {
    ...CLIPPY_CHECK,
    argv: ["cargo", "+1.80.0", "clippy", "--", "-D", "warnings"],
  };
  const result = planChangedFileChecks(
    ["rust/src/lib.rs"],
    ["rust/Cargo.toml"],
    { repoRoot: "/r", markdownlintBinary: null, ciCargo: scanOf(check) },
  );
  assert(result.ok);
  const planned = result.value.find((c) => c.cargo !== undefined);
  assertEquals(planned?.command, "cargo +1.80.0 clippy -- -D warnings");
  assertEquals(planned?.cargo, { kind: "clippy", toolchain: "1.80.0" });
});

Deno.test("planChangedFileChecks: a CI argument with a space is quoted and round-trips; one with both quote kinds is an error", () => {
  const spaced: CiCargoCheck = {
    ...CLIPPY_CHECK,
    argv: ["cargo", "clippy", "--features", "serde json"],
  };
  const planned = planChangedFileChecks(
    ["rust/src/lib.rs"],
    ["rust/Cargo.toml"],
    { repoRoot: "/r", markdownlintBinary: null, ciCargo: scanOf(spaced) },
  );
  assert(planned.ok);
  const check = planned.value.find((c) => c.cargo !== undefined);
  assertEquals(check?.command, "cargo clippy --features 'serde json'");
  assertEquals(tokeniseCommand(check!.command), spaced.argv);

  const unquotable: CiCargoCheck = {
    ...CLIPPY_CHECK,
    argv: ["cargo", "clippy", "--", "-A", `it's "x"`],
  };
  const refused = planChangedFileChecks(
    ["rust/src/lib.rs"],
    ["rust/Cargo.toml"],
    { repoRoot: "/r", markdownlintBinary: null, ciCargo: scanOf(unquotable) },
  );
  assert(!refused.ok);
  assert(refused.error.includes("cannot safely quote"));
});

Deno.test("planChangedFileChecks: a real workflow scan plans the clippy and test-target commands its lint job names", () => {
  const scan = scanWorkflowForCargoChecks("ci.yml", LINT_WORKFLOW);
  assertEquals(scan.unverifiable, []);
  const result = planChangedFileChecks(
    ["rust/src/lib.rs", "tools/src/main.rs"],
    ["rust/Cargo.toml", "tools/Cargo.toml"],
    { repoRoot: "/r", markdownlintBinary: null, ciCargo: scan },
  );
  assert(result.ok);
  // `cargo test --workspace` in `rust` is covered by the clippy --all-targets
  // run, so only the `tools` test build is planned as a compile.
  assertEquals(
    result.value.filter((c) => c.cargo !== undefined).map((c) => [
      c.cwd,
      c.command,
    ]),
    [
      ["/r/rust", CLIPPY_CMD],
      ["/r/tools", "cargo test --no-run -p core"],
    ],
  );
});

/** What a CI cargo run was asked to do. */
interface RanCall {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
}

/** A runner that answers each command from `answer` (default: exit 0) and records it. */
function scriptedRunner(
  answer: (command: string) => Partial<PreFlightCommandResult>,
  calls: RanCall[],
): PreFlightRunner {
  return (command, options) => {
    calls.push({ command, cwd: options.cwd, env: options.env });
    return Promise.resolve({
      started: true,
      code: 0,
      stdout: "",
      stderr: "",
      ...answer(command),
    });
  };
}

/** The CI clippy and test-build runs, without the toolchain probes. */
function ciRuns(calls: RanCall[]): RanCall[] {
  return calls.filter((c) =>
    /^cargo (\+\S+ )?(clippy|test --no-run)/.test(c.command) &&
    !c.command.endsWith("--version")
  );
}

const RUST_FILES = {
  "rust/Cargo.toml": '[package]\nname = "demo"\n',
  "rust/src/lib.rs": "pub fn f() {}\n",
};

/**
 * Like {@link makeRepoWithDocCommit}, but the one local commit writes `files`
 * (repo-relative path to text).
 */
async function makeRepoWithFiles(files: Record<string, string>): Promise<
  { root: string; clone: string; stdin: string }
> {
  const root = await Deno.makeTempDir({ prefix: "vibe-pp-cargo-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  await git(root, "clone", "-q", remote, clone);
  await Deno.writeTextFile(`${clone}/deno.json`, "{}\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "init");
  await git(clone, "push", "-q", "origin", "HEAD:main");
  for (const [path, text] of Object.entries(files)) {
    await Deno.mkdir(`${clone}/${path.slice(0, path.lastIndexOf("/"))}`, {
      recursive: true,
    });
    await Deno.writeTextFile(`${clone}/${path}`, text);
  }
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "rust");
  const sha = await git(clone, "rev-parse", "HEAD");
  return {
    root,
    clone,
    stdin: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
  };
}

/** Gate a push in `clone` with a fixed CI scan (default: the clippy check). */
function gateRust(
  clone: string,
  stdin: string,
  runner: PreFlightRunner,
  scan: CiCargoScan = scanOf(CLIPPY_CHECK),
) {
  return runPrePushGate({
    cwd: clone,
    stdin,
    preFlightCommands: [],
    runner,
    findCiCargo: () => Promise.resolve(scan),
  });
}

Deno.test("runPrePushGate: CI clippy runs exactly as the workflow wrote it, in its directory with its env, after a toolchain probe", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles({
    ...RUST_FILES,
    ".github/workflows/ci.yml": RUST_WORKFLOW,
  });
  try {
    const calls: RanCall[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: scriptedRunner(() => ({}), calls),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(ciRuns(calls).map((c) => c.command), [CLIPPY_CMD]);
    assertEquals(ciRuns(calls)[0]?.cwd, `${clone}/rust`);
    assertEquals(ciRuns(calls)[0]?.env, { RUSTFLAGS: "-D warnings" });
    const probeAt = calls.findIndex((c) => c.command === "cargo --version");
    const clippyAt = calls.findIndex((c) => c.command === CLIPPY_CMD);
    assert(probeAt >= 0 && probeAt < clippyAt, "probe must run first");
    assert(result.value.checksRun.includes(CLIPPY_CMD));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a CI +toolchain runs its probes and clippy with that toolchain", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const calls: RanCall[] = [];
    const scan = scanOf({
      ...CLIPPY_CHECK,
      argv: ["cargo", "+1.80.0", "clippy", "--", "-D", "warnings"],
    });
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner(() => ({}), calls),
      scan,
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    const commands = calls.map((c) => c.command);
    assert(commands.includes("cargo +1.80.0 --version"));
    assert(commands.includes("cargo +1.80.0 clippy --version"));
    assert(commands.includes("cargo +1.80.0 clippy -- -D warnings"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** The lint classes CI denies with `-D warnings`, as clippy reports them. */
const DENIED_LINTS = [
  "clippy::must_use_candidate",
  "clippy::assert_is_empty",
];

Deno.test("runPrePushGate: a clippy lint denied by -D warnings blocks the push, and is not infrastructure", async () => {
  for (const lint of DENIED_LINTS) {
    const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
    try {
      const result = await gateRust(
        clone,
        stdin,
        scriptedRunner(
          (c) =>
            c === CLIPPY_CMD
              ? {
                code: 101,
                stderr:
                  `error: this lint is denied\n  = note: \`-D ${lint}\` implied by \`-D warnings\`\n`,
              }
              : {},
          [],
        ),
      );
      assert(!result.ok, lint);
      assertInstanceOf(result.error, PreFlightGateError);
      assert(!(result.error instanceof PrePushGateInfrastructureError), lint);
      assertEquals(result.error.reason, "non-zero-exit");
      assertEquals(result.error.command, CLIPPY_CMD);
      assert(result.error.message.includes(lint), lint);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("runPrePushGate: a compile failure in a test target from CI's test build blocks the push with its output", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const testBuild: CiCargoCheck = {
      kind: "test-build",
      workingDirectory: "rust",
      argv: ["cargo", "test", "--no-run", "--locked"],
      env: {},
      source: "ci.yml",
    };
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner(
        (c) =>
          c === "cargo test --no-run --locked"
            ? {
              code: 101,
              stderr:
                "error[E0432]: unresolved import `demo::missing`\n --> rust/tests/foo.rs:1:5\n",
            }
            : {},
        [],
      ),
      scanOf(testBuild),
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PreFlightGateError);
    assert(!(result.error instanceof PrePushGateInfrastructureError));
    assertEquals(result.error.command, "cargo test --no-run --locked");
    assert(result.error.message.includes("error[E0432]"));
    assert(result.error.message.includes("tests/foo.rs"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a cargo probe that cannot start is infrastructure, and clippy never runs", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const calls: RanCall[] = [];
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner(
        (c) => c === "cargo --version" ? { started: false, code: -1 } : {},
        calls,
      ),
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.startsWith("Rust toolchain unavailable here"));
    assert(result.error.message.includes("cargo --version"));
    assert(!calls.some((c) => c.command.includes("clippy")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: cargo clippy --version failing is infrastructure, and clippy never runs", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const calls: RanCall[] = [];
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner(
        (c) =>
          c === "cargo clippy --version"
            ? { code: 101, stderr: "error: no such command: `clippy`" }
            : {},
        calls,
      ),
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("cargo clippy --version"));
    assert(result.error.message.includes("no such command"));
    assert(!calls.some((c) => c.command === CLIPPY_CMD));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: host disk-full output from a failing CI clippy is infrastructure, not a block", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner(
        (c) =>
          c === CLIPPY_CMD
            ? {
              code: 101,
              stderr:
                "error: failed to write target: No space left on device (os error 28)\n",
            }
            : {},
        [],
      ),
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("No space left on device"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a denied lint whose output quotes disk-full text in a source excerpt still blocks", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    // The disk-full words appear only in the gutter source line; the tool's
    // own error is the denied lint.
    const stderr = [
      "error: this could be a `const fn` (clippy::must_use_candidate)",
      "  --> rust/src/lib.rs:1:1",
      "   |",
      '12 |     let x = "No space left on device";',
      "   |             ^^^^^^^^^^^^^^^^^^^^^^^^^^",
      "   = note: `-D clippy::must_use_candidate` implied by `-D warnings`",
      "",
    ].join("\n");
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner((c) => c === CLIPPY_CMD ? { code: 101, stderr } : {}, []),
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PreFlightGateError);
    assert(!(result.error instanceof PrePushGateInfrastructureError));
    assertEquals(result.error.reason, "non-zero-exit");
    assert(result.error.message.includes("clippy::must_use_candidate"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a CI clippy that times out or cannot start is infrastructure", async () => {
  const faults: Partial<PreFlightCommandResult>[] = [
    { code: TIMEOUT_EXIT_CODE, timedOut: true },
    { started: false, code: -1 },
  ];
  for (const fault of faults) {
    const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
    try {
      const result = await gateRust(
        clone,
        stdin,
        scriptedRunner((c) => c === CLIPPY_CMD ? fault : {}, []),
      );
      assert(!result.ok, JSON.stringify(fault));
      assertInstanceOf(result.error, PrePushGateInfrastructureError);
      assert(result.error.message.includes(CLIPPY_CMD));
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("runPrePushGate: an unverifiable CI cargo scan with a changed .rs is infrastructure, and no cargo check runs", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const calls: RanCall[] = [];
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner(() => ({}), calls),
      {
        checks: [],
        unverifiable: [
          'ci.yml: "cargo clippy | tee out" cannot be reproduced faithfully: it contains a pipe',
        ],
      },
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(
      result.error.message.startsWith(
        "CI's cargo checks cannot be reproduced locally: ",
      ),
    );
    assert(result.error.message.includes("contains a pipe"));
    assertEquals(calls, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: an unverifiable CI cargo scan does not block a docs-only push, and is not read", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    let read = false;
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: scriptedRunner(() => ({}), []),
      findMarkdownlint: () => Promise.resolve("/fake/mdl"),
      findCiCargo: () => {
        read = true;
        return Promise.resolve({ checks: [], unverifiable: ["ci.yml: x"] });
      },
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(!read, "the CI cargo scan is read only for a Rust-relevant change");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a CI cargo working directory that is a symlink outside the repository is infrastructure", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  const outside = await Deno.makeTempDir({ prefix: "vibe-pp-outside-" });
  try {
    // The committed crate is replaced by a symlink to a directory outside the
    // repository that also holds the changed file.
    await Deno.mkdir(`${outside}/src`, { recursive: true });
    await Deno.writeTextFile(`${outside}/src/lib.rs`, "pub fn f() {}\n");
    await Deno.remove(`${clone}/rust`, { recursive: true });
    await Deno.symlink(outside, `${clone}/rust`);
    const calls: RanCall[] = [];
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner(() => ({}), calls),
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("resolves outside the repository"));
    assertEquals(ciRuns(calls), []);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("runPrePushGate: a CI cargo working directory that is missing is infrastructure, naming the directory", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const calls: RanCall[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: scriptedRunner(() => ({}), calls),
      // Removes the crate after the changed files are listed and before any
      // CI cargo command would run in it.
      findCiCargo: async () => {
        await Deno.remove(`${clone}/rust`, { recursive: true });
        return scanOf(CLIPPY_CHECK);
      },
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes(`${clone}/rust`));
    assert(result.error.message.includes("missing"));
    assert(!calls.some((c) => c.command.includes("clippy")));
    assert(!calls.some((c) => c.command.endsWith("--version")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: the real workflow scan drives the CI clippy run end to end", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles({
    ...RUST_FILES,
    ".github/workflows/ci.yml": LINT_WORKFLOW,
  });
  try {
    const calls: RanCall[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: scriptedRunner(() => ({}), calls),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    // The tools test build is not in this push, so only the rust clippy and no
    // tools compile run.
    assertEquals(ciRuns(calls).map((c) => c.command), [CLIPPY_CMD]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---- ciCargoOnly (repair pushes with no pre-flight configuration) -----------

const BAD_TS = "const x   =1\n";

Deno.test("runPrePushGate: ciCargoOnly runs only the CI cargo commands for a .rs and badly formatted .ts push", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles({
    ...RUST_FILES,
    "src/bad.ts": BAD_TS,
  });
  try {
    const calls: RanCall[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: ["pre-flight-cmd"],
      runner: scriptedRunner(() => ({}), calls),
      findCiCargo: () => Promise.resolve(scanOf(CLIPPY_CHECK)),
      ciCargoOnly: true,
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    const commands = calls.map((c) => c.command);
    assert(commands.includes(CLIPPY_CMD), JSON.stringify(commands));
    assert(
      commands.every((c) =>
        c.startsWith("cargo ") && !c.startsWith("cargo fmt")
      ),
      JSON.stringify(commands),
    );
    assertEquals(result.value.checksRun, [CLIPPY_CMD]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: without ciCargoOnly the same push still runs deno fmt, cargo fmt and the pre-flight commands", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles({
    ...RUST_FILES,
    "src/bad.ts": BAD_TS,
  });
  try {
    const calls: RanCall[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: ["pre-flight-cmd"],
      runner: scriptedRunner(() => ({}), calls),
      findCiCargo: () => Promise.resolve(scanOf(CLIPPY_CHECK)),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    const commands = calls.map((c) => c.command);
    assert(
      commands.some((c) => c.startsWith("deno fmt")),
      JSON.stringify(commands),
    );
    assert(commands.includes("cargo fmt --all --check"));
    assert(commands.includes(CLIPPY_CMD));
    assert(commands.includes("pre-flight-cmd"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: ciCargoOnly on a docs-only push runs nothing, does not look up markdownlint and does not read the CI cargo scan", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    const calls: RanCall[] = [];
    let read = false;
    let looked = false;
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: ["pre-flight-cmd"],
      runner: scriptedRunner(() => ({}), calls),
      // A missing markdownlint would block a full run; ciCargoOnly must not look
      // for it at all.
      findMarkdownlint: () => {
        looked = true;
        return Promise.resolve(null);
      },
      findCiCargo: () => {
        read = true;
        return Promise.resolve(scanOf(CLIPPY_CHECK));
      },
      ciCargoOnly: true,
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(calls, []);
    assertEquals(result.value.checksRun, []);
    assert(!read, "the CI cargo scan is read only for a Rust-relevant change");
    assert(!looked, "markdownlint must not be looked up in ciCargoOnly mode");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: ciCargoOnly skips the repo's pre-flight commands, so a failing one does not block", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const calls: RanCall[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: ["make-it-fail"],
      runner: scriptedRunner(
        (c) => c === "make-it-fail" ? { code: 1, stderr: "boom" } : {},
        calls,
      ),
      findCiCargo: () => Promise.resolve(scanOf(CLIPPY_CHECK)),
      ciCargoOnly: true,
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(!calls.some((c) => c.command === "make-it-fail"));
    assertEquals(result.value.checksRun, [CLIPPY_CMD]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
