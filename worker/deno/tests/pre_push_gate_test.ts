/**
 * Tests for the pre-push gate (Issue #3394).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import { MAX_REPO_FILE_BYTES } from "../lib/repo_file_read.ts";
import {
  createRepoFormatterDeps,
  formatBranchChanges,
} from "../lib/repo_formatters.ts";
import {
  defaultPrePushGit,
  listPushedFiles,
  loadDenoScopes,
  loadDenoUnitTestRoots,
  loadReferencedUnitTests,
  needsFullUnitSuite,
  parsePrePushRefs,
  planChangedFileChecks,
  PrePushGateInfrastructureError,
  type PrePushGit,
  repoCiRunsCspell,
  repoShellcheckPolicy,
  runAffectedShellcheckChecks,
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
  repoCiCargoChecks,
  scanWorkflowForCargoChecks,
} from "../lib/ci_cargo_checks.ts";
import { TIMEOUT_EXIT_CODE } from "../lib/git_timeout.ts";
import {
  STUB_SHELLCHECK_VERSION,
  stubShellcheck,
} from "./support/shellcheck_support.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);

Deno.test("ShellCheck policy bounds workflow and delegated script reads", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  try {
    await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(`${root}/outside`, SHELLCHECK_WORKFLOW(""));
    await Deno.symlink(`${root}/outside`, `${root}/${path}`);
    assertEquals(await repoShellcheckPolicy(root, [path]), {
      ok: true,
      value: null,
    });
    await Deno.remove(`${root}/${path}`);
    await Deno.writeTextFile(`${root}/${path}`, "x".repeat(1024 * 1024 + 1));
    assert(!(await repoShellcheckPolicy(root, [path])).ok);
    await Deno.writeTextFile(
      `${root}/${path}`,
      "jobs:\n  lint:\n    steps:\n      - run: ./check.sh\n",
    );
    await Deno.symlink(`${root}/outside`, `${root}/check.sh`);
    assert(!(await repoShellcheckPolicy(root, [path, "check.sh"])).ok);
    await Deno.remove(`${root}/check.sh`);
    await Deno.writeTextFile(`${root}/check.sh`, "x".repeat(1024 * 1024 + 1));
    assert(!(await repoShellcheckPolicy(root, [path, "check.sh"])).ok);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("unsupported ShellCheck policy ignores Dockerfile but blocks executable shell shebang", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  try {
    await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/${path}`,
      "jobs:\n  lint:\n    steps:\n      - uses: unknown/shellcheck@v1\n",
    );
    await Deno.writeTextFile(`${root}/Dockerfile`, "FROM alpine\n");
    await Deno.writeTextFile(`${root}/script`, "#!/bin/bash\necho $1\n", {
      mode: 0o755,
    });
    const tracked = [path, "Dockerfile", "script"];
    assert(
      (await runAffectedShellcheckChecks({
        cwd: root,
        changed: ["Dockerfile"],
        tracked,
      })).ok,
    );
    assert(
      !(await runAffectedShellcheckChecks({
        cwd: root,
        changed: ["script"],
        tracked,
      })).ok,
    );
    await Deno.remove(`${root}/script`);
    assert(
      (await runAffectedShellcheckChecks({
        cwd: root,
        changed: ["script"],
        tracked,
      })).ok,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

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

const SHELLCHECK_WORKFLOW = (
  flags: string,
  version = STUB_SHELLCHECK_VERSION,
) =>
  `jobs:\n  lint:\n    env:\n      SHELLCHECK_VERSION: "${version}"\n    steps:\n      - run: |\n          find . -name "*.sh" -type f -exec shellcheck ${flags} {} +\n`;

const SYNCED_SHELLCHECK_WORKFLOW =
  WORKFLOW_SPECS.find((spec) => spec.id === "shellcheck")!.template;

Deno.test("ShellCheck discovers continued commands and refuses indirect invocations", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  try {
    await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
    const continued = SHELLCHECK_WORKFLOW("-e SC1091").replace(
      "-type f -exec",
      "-type f \\\n          -exec",
    );
    await Deno.writeTextFile(`${root}/${path}`, continued);
    const supported = await repoShellcheckPolicy(root, [path]);
    assert(supported.ok && supported.value !== null);
    assertEquals(supported.value.flags, ["-e", "SC1091"]);
    for (
      const command of [
        "docker run --rm koalaman/shellcheck:stable scripts/*.sh",
        "docker run --rm docker.io/koalaman/shellcheck:stable scripts/x.sh",
        "docker run --rm koalaman/shellcheck@sha256:abcdef scripts/x.sh",
        "docker container run --rm koalaman/shellcheck:stable scripts/x.sh",
        "bash -ec 'shellcheck scripts/x.sh'",
        "bash -e -c 'shellcheck scripts/x.sh'",
        "bash -c 'shellcheck scripts/*.sh'",
      ]
    ) {
      await Deno.writeTextFile(
        `${root}/${path}`,
        SHELLCHECK_WORKFLOW("").replace(/find .*$/m, command),
      );
      const result = await repoShellcheckPolicy(root, [path]);
      assert(!result.ok, command);
    }
    await Deno.writeTextFile(
      `${root}/check.sh`,
      "find . -name '*.sh' -type f \\\n -exec shellcheck {} +\n",
    );
    await Deno.writeTextFile(
      `${root}/${path}`,
      "jobs:\n  lint:\n    steps:\n      - run: ./check.sh\n",
    );
    const delegated = await repoShellcheckPolicy(root, [path, "check.sh"]);
    assert(!delegated.ok);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ShellCheck skips scripts under symlinked parents and missing directory paths", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${clone}/h`);
    await commitShellcheckFiles(clone, { "h/x.sh": "echo ok\n" });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.remove(`${clone}/h`, { recursive: true });
    await Deno.mkdir(`${root}/outside`);
    await Deno.writeTextFile(`${root}/outside/x.sh`, "echo $1\n");
    await Deno.symlink(`${root}/outside`, `${clone}/h`);
    const seen: string[] = [];
    const opts = {
      cwd: clone,
      changed: ["h/x.sh"],
      tracked: [".github/workflows/validate-scripts.yml", "h/x.sh"],
      ...stubShellcheck(),
      runner: recordingRunner(() => false, seen),
    };
    const checked = await runAffectedShellcheckChecks(opts);
    assert(checked.ok);
    assertEquals(seen, []);
    const rechecked = await runAffectedShellcheckChecks({
      ...opts,
      changed: [".shellcheckrc"],
    });
    assert(rechecked.ok);
    assertEquals(seen, []);
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "replace directory with symlink");
    const pushed = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner(() => false, seen),
    });
    assert(pushed.ok, pushed.ok ? "" : pushed.error.message);
    assertEquals(seen, []);
    await Deno.remove(`${clone}/h`);
    await Deno.writeTextFile(`${clone}/h`, "replacement");
    const missing = await runAffectedShellcheckChecks(opts);
    assert(missing.ok);
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "replace directory with file");
    const replaced = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner(() => false, seen),
    });
    assert(replaced.ok, replaced.ok ? "" : replaced.error.message);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ShellCheck policy rejects inherited options for action and find", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  try {
    await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
    for (
      const body of [
        SYNCED_SHELLCHECK_WORKFLOW + "\nenv:\n  SHELLCHECK_OPTS: -e SC2086\n",
        SHELLCHECK_WORKFLOW("").replace(
          "- run: |",
          "- env:\n          SHELLCHECK_OPTS: -e SC2086\n        run: |",
        ),
      ]
    ) {
      await Deno.writeTextFile(`${root}/${path}`, body);
      const result = await repoShellcheckPolicy(root, [path]);
      assert(!result.ok);
      assert(result.error.includes("SHELLCHECK_OPTS"));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ShellCheck action checks its scripts and skips symlinks on change and recheck", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.mkdir(`${clone}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/.github/workflows/check.yml`,
      SYNCED_SHELLCHECK_WORKFLOW,
    );
    await Deno.writeTextFile(`${clone}/util.bash`, "echo $1\n");
    await Deno.writeTextFile(
      `${clone}/deploy`,
      "#!/usr/bin/env bash\necho $1\n",
      { mode: 0o755 },
    );
    await Deno.chmod(`${clone}/deploy`, 0o755);
    await Deno.writeTextFile(`${root}/outside`, "echo $1\n");
    await Deno.symlink(`${root}/outside`, `${clone}/x.sh`);
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "scripts");
    const tracked = [
      ".github/workflows/check.yml",
      "util.bash",
      "deploy",
      "x.sh",
    ];
    for (
      const changed of [["util.bash", "deploy", "x.sh"], [".shellcheckrc"]]
    ) {
      const seen: string[] = [];
      const result = await runAffectedShellcheckChecks({
        cwd: clone,
        changed,
        tracked,
        ...stubShellcheck(),
        runner: recordingRunner(() => false, seen),
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      assert(seen.some((c) => c.includes("util.bash")));
      assert(seen.some((c) => c.includes("deploy")));
      assert(!seen.some((c) => c.includes("x.sh")));
    }
    const seen: string[] = [];
    const pushed = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner(() => false, seen),
    });
    assert(pushed.ok, pushed.ok ? "" : pushed.error.message);
    assert(seen.some((c) => c.includes("util.bash")));
    assert(seen.some((c) => c.includes("deploy")));
    assert(!seen.some((c) => c.includes("x.sh")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate skips committed script symlinks on change and config recheck", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, { "real.sh": "#!/bin/sh\necho ok\n" });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.writeTextFile(`${root}/outside`, "echo $1\n");
    await Deno.symlink(`${root}/outside`, `${clone}/x.sh`);
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "symlink");
    for (const recheck of [false, true]) {
      if (recheck) {
        await git(clone, "push", "-q", "origin", "HEAD:main");
        await Deno.writeTextFile(`${clone}/.shellcheckrc`, "disable=SC2086\n");
        await git(clone, "add", "-A");
        await git(clone, "commit", "-qm", "config");
      }
      const seen: string[] = [];
      const result = await runPrePushGate({
        cwd: clone,
        stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
        preFlightCommands: [],
        ...stubShellcheck(),
        runner: recordingRunner(() => false, seen),
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      assert(!seen.some((c) => c.includes("x.sh")));
      if (recheck) assert(seen.some((c) => c.includes("real.sh")));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("listPushedFiles: a merge lists the paths it resolved, never the files it brings in from the base (PR #4898 review)", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-pp-merge-" });
  try {
    await git(root, "init", "-q", "-b", "main");
    await Deno.writeTextFile(`${root}/c.txt`, "1\n");
    await Deno.writeTextFile(`${root}/deno.json`, "{}\n");
    await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${root}/.github/workflows/check.yml`,
      SYNCED_SHELLCHECK_WORKFLOW,
    );
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "init");
    await git(root, "checkout", "-q", "-b", "feat");
    await Deno.writeTextFile(`${root}/c.txt`, "feat\n");
    await Deno.writeTextFile(`${root}/own.sh`, "#!/bin/sh\necho ok\n");
    await Deno.writeTextFile(`${root}/own.ts`, "export const own = 1;\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "own change");
    await git(root, "checkout", "-q", "main");
    await Deno.writeTextFile(`${root}/c.txt`, "main\n");
    await Deno.writeTextFile(`${root}/base_bad.sh`, "#!/bin/sh\necho $1\n");
    await Deno.writeTextFile(`${root}/base_bad.ts`, "export const bad=1\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "base moves on");
    await git(root, "checkout", "-q", "feat");
    // The merge conflicts on c.txt; the resolution is the merge's own change.
    let conflicted = false;
    try {
      await git(root, "merge", "--no-commit", "main");
    } catch {
      conflicted = true;
    }
    assert(conflicted, "the fixture must conflict on c.txt");
    await Deno.writeTextFile(`${root}/c.txt`, "resolved\n");
    // A file only the merge commit introduces: no ordinary commit lists it, so
    // it appears solely when the merge's own diff is requested.
    await Deno.writeTextFile(`${root}/merge_only.sh`, "#!/bin/sh\necho ok\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "merge main");
    const files = await listPushedFiles(
      [{ localRef: "HEAD", localSha: "HEAD", remoteRef: "x", remoteSha: "0" }],
      root,
      defaultPrePushGit,
      "main",
    );
    assert(files.ok);
    assertEquals(files.value, ["c.txt", "merge_only.sh", "own.sh", "own.ts"]);
    const seen: string[] = [];
    const gate = await runPrePushGate({
      cwd: root,
      stdin: prePushInput(await git(root, "rev-parse", "HEAD")),
      baseRef: "main",
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner((command) => command.includes("base_bad"), seen),
    });
    assert(gate.ok, gate.ok ? "" : gate.error.message);
    assert(seen.some((command) => command.includes("own.sh")));
    assert(!seen.some((command) => command.includes("base_bad")));
    const formatted: string[] = [];
    const deps = createRepoFormatterDeps();
    deps.runCommand = (command) => {
      formatted.push(command.join(" "));
      return Promise.resolve({ exitCode: 0, output: "" });
    };
    const result = await formatBranchChanges(root, "main", deps);
    assertEquals(result.gitError, undefined);
    assert(formatted.some((command) => command.includes("own.ts")));
    assert(!formatted.some((command) => command.includes("base_bad")));
    assertEquals(
      await Deno.readTextFile(`${root}/base_bad.ts`),
      "export const bad=1\n",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ShellCheck refuses an oversized configuration without reading it", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, { "real.sh": "#!/bin/sh\necho ok\n" });
    const config = await Deno.open(`${clone}/.shellcheckrc`, {
      write: true,
      create: true,
    });
    try {
      await config.truncate(1024 * 1024 + 1);
    } finally {
      config.close();
    }
    const seen: string[] = [];
    const result = await runAffectedShellcheckChecks({
      cwd: clone,
      changed: ["real.sh"],
      tracked: [
        ".github/workflows/validate-scripts.yml",
        "real.sh",
        ".shellcheckrc",
      ],
      ...stubShellcheck(),
      runner: recordingRunner(() => false, seen),
    });
    assert(!result.ok);
    assertStringIncludes(result.error.message, "exceeds policy size limit");
    assertEquals(seen, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ShellCheck refuses a symlinked configuration without reading its target", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, { "real.sh": "#!/bin/sh\necho ok\n" });
    await Deno.writeTextFile(`${root}/outside`, "disable=SC2086\n");
    await Deno.symlink(`${root}/outside`, `${clone}/.shellcheckrc`);
    const seen: string[] = [];
    const result = await runAffectedShellcheckChecks({
      cwd: clone,
      changed: ["real.sh"],
      tracked: [
        ".github/workflows/validate-scripts.yml",
        "real.sh",
        ".shellcheckrc",
      ],
      ...stubShellcheck(),
      runner: recordingRunner(() => false, seen),
    });
    assert(!result.ok);
    assert(result.error.message.includes("not a regular file"));
    assertEquals(seen, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("ShellCheck refuses a configuration below a symlinked directory", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(
      clone,
      { "real.sh": "echo ok\n" },
      "--rcfile h/shellcheckrc",
    );
    await Deno.mkdir(`${root}/outside`);
    await Deno.writeTextFile(
      `${root}/outside/shellcheckrc`,
      "disable=SC2086\n",
    );
    await Deno.symlink(`${root}/outside`, `${clone}/h`);
    const seen: string[] = [];
    const result = await runAffectedShellcheckChecks({
      cwd: clone,
      changed: ["real.sh"],
      tracked: [
        ".github/workflows/validate-scripts.yml",
        "real.sh",
        "h/shellcheckrc",
      ],
      ...stubShellcheck(),
      runner: recordingRunner(() => false, seen),
    });
    assert(!result.ok);
    assert(result.error.message.includes("not a regular file"));
    assertEquals(seen, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function commitShellcheckFiles(
  clone: string,
  files: Record<string, string>,
  flags = "-e SC1091 -e SC2034",
  version = STUB_SHELLCHECK_VERSION,
): Promise<string> {
  // Keep the unrelated doc commit on the remote so these fixtures need only
  // ShellCheck, as in the CI test shard which does not install markdownlint.
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await Deno.mkdir(`${clone}/.github/workflows`, { recursive: true });
  await Deno.writeTextFile(
    `${clone}/.github/workflows/validate-scripts.yml`,
    SHELLCHECK_WORKFLOW(flags, version),
  );
  for (const [path, contents] of Object.entries(files)) {
    await Deno.writeTextFile(`${clone}/${path}`, contents);
  }
  await git(clone, "add", "-A");
  await git(clone, "commit", "-qm", "add ShellCheck policy and scripts");
  return await git(clone, "rev-parse", "HEAD");
}

function prePushInput(tip: string): string {
  return `refs/heads/main ${tip} refs/heads/main ${ZERO}\n`;
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

Deno.test("listPushedFiles: a file behind a directory later replaced by a symlink is skipped (#4909)", async () => {
  const outside = await Deno.makeTempDir({ prefix: "vibe-pp-outside-" });
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await Deno.writeTextFile(`${outside}/file.json`, "{}\n");
    await Deno.mkdir(`${clone}/dir`);
    await Deno.writeTextFile(`${clone}/dir/file.json`, "{}\n");
    await Deno.mkdir(`${clone}/keep`);
    await Deno.writeTextFile(`${clone}/keep/ok.md`, "# Ok\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "nested");
    await git(clone, "rm", "-rq", "dir");
    await Deno.symlink(outside, `${clone}/dir`);
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "replace dir with symlink");
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
    assertEquals(files.value, ["README.md", "keep/ok.md"]);
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("runPrePushGate excludes files behind a replaced directory symlink (#4909)", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${root}/outside`);
    await Deno.writeTextFile(`${root}/outside/notes.md`, "# Outside\n");
    await Deno.mkdir(`${clone}/dir`);
    await Deno.writeTextFile(`${clone}/dir/notes.md`, "# Inside\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "nested");
    await git(clone, "rm", "-rq", "dir");
    await Deno.symlink(`${root}/outside`, `${clone}/dir`);
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "replace directory");
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      findMarkdownlint: () => Promise.resolve("/fake/markdownlint"),
      findCspell: () => Promise.resolve("/fake/cspell"),
      runner: recordingRunner(() => false, seen),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(seen.some((command) => command.includes("README.md")));
    assert(!seen.some((command) => command.includes("dir/notes.md")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("listPushedFiles: a symlinked checkout retains real files and skips escaping paths (#4909)", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-pp-linked-" });
  try {
    const clone = `${root}/clone`;
    const outside = `${root}/outside`;
    const link = `${root}/link`;
    await Deno.mkdir(`${clone}/keep`, { recursive: true });
    await Deno.mkdir(outside);
    await Deno.writeTextFile(`${clone}/README.md`, "# Readme\n");
    await Deno.writeTextFile(`${clone}/keep/ok.md`, "# Ok\n");
    await Deno.writeTextFile(`${outside}/file.json`, "{}\n");
    await Deno.symlink(outside, `${clone}/dir`);
    await Deno.symlink(clone, link);
    const refs = parsePrePushRefs(
      `refs/heads/main ${SHA_A} refs/heads/main ${ZERO}\n`,
    );
    assert(refs.ok);
    const files = await listPushedFiles(
      refs.value,
      link,
      () =>
        Promise.resolve({
          code: 0,
          stdout: "README.md\0keep/ok.md\0dir/file.json\0",
          stderr: "",
        }),
    );
    assert(files.ok);
    assertEquals(files.value, ["README.md", "keep/ok.md"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("listPushedFiles: an unresolvable checkout returns an Err naming the cause (#4909)", async () => {
  const missing = `${await Deno.makeTempDir({ prefix: "vibe-pp-gone-" })}/gone`;
  let expected = "";
  try {
    await Deno.realPath(missing);
  } catch (err) {
    assertInstanceOf(err, Error);
    expected = err.message;
  }
  assert(expected !== "");
  const sha = "a".repeat(40);
  const refs = parsePrePushRefs(
    `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`,
  );
  assert(refs.ok);
  const files = await listPushedFiles(
    refs.value,
    missing,
    () => Promise.resolve({ code: 0, stdout: "README.md\0", stderr: "" }),
  );
  assert(!files.ok);
  assertEquals(
    files.error,
    `could not resolve checkout ${JSON.stringify(missing)}: ${expected}`,
  );
  await Deno.remove(missing.slice(0, -"/gone".length), { recursive: true });
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

Deno.test("runPrePushGate: deleted scripts are not passed to ShellCheck", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, { "gone.sh": "#!/bin/sh\ntrue\n" });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.remove(`${clone}/gone.sh`);
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "delete shell script");
    const tip = await git(clone, "rev-parse", "HEAD");
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      runner: recordingRunner(() => false, seen),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value.checksRun, []);
    assert(!seen.some((command) => command.includes("shellcheck")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: paths outside CI's .sh selection are excluded", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, { "baseline.sh": "#!/bin/sh\ntrue\n" });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.writeTextFile(`${clone}/notes.txt`, "not a shell script\n");
    await git(clone, "add", "notes.txt");
    await git(clone, "commit", "-qm", "change a non-shell path");
    const tip = await git(clone, "rev-parse", "HEAD");
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      runner: recordingRunner(() => false, seen),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value.checksRun, []);
    assert(!seen.some((command) => command.includes("shellcheck")));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate selects nearest tracked config and respects explicit rcfile", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${clone}/scripts/deep`, { recursive: true });
    let tip = await commitShellcheckFiles(clone, {
      "a.sh": "#!/bin/sh\ntrue\n",
      "scripts/b.sh": "#!/bin/sh\ntrue\n",
      "scripts/deep/c.sh": "#!/bin/sh\ntrue\n",
      ".shellcheckrc": "disable=SC2086\n",
      "scripts/.shellcheckrc": "disable=SC2034\n",
    });
    const run = (sha: string) =>
      runPrePushGate({
        cwd: clone,
        stdin: prePushInput(sha),
        preFlightCommands: [],
        ...stubShellcheck(),
        runner: recordingRunner(() => false, []),
      });
    const result = await run(tip);
    assert(result.ok, result.ok ? "" : result.error.message);
    const commands = result.value.checksRun.filter((c) =>
      c.includes("shellcheck")
    );
    for (
      const [script, config] of [["a.sh", ".shellcheckrc"], [
        "scripts/b.sh",
        "scripts/.shellcheckrc",
      ], ["scripts/deep/c.sh", "scripts/.shellcheckrc"]]
    ) {
      assert(
        commands.some((c) =>
          c.includes(`'${script}'`) && c.includes(`'--rcfile' '${config}'`)
        ),
        commands.join("\n"),
      );
    }
    await Deno.writeTextFile(
      `${clone}/.github/workflows/validate-scripts.yml`,
      SHELLCHECK_WORKFLOW("--rcfile .shellcheckrc"),
    );
    await git(clone, "add", ".github/workflows/validate-scripts.yml");
    await git(clone, "commit", "-qm", "explicit config");
    tip = await git(clone, "rev-parse", "HEAD");
    const explicit = await run(tip);
    assert(explicit.ok, explicit.ok ? "" : explicit.error.message);
    for (
      const command of explicit.value.checksRun.filter((c) =>
        c.includes("shellcheck")
      )
    ) {
      assertEquals(command.match(/--rcfile/g)?.length, 1);
      assert(!command.includes("--norc"));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a changed ShellCheck config rechecks every tracked script", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "one.sh": "#!/bin/sh\necho $1\n",
      "two scripts.sh": "#!/bin/sh\ntrue\n",
    });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.writeTextFile(`${clone}/.shellcheckrc`, "disable=SC2086\n");
    await git(clone, "add", ".shellcheckrc");
    await git(clone, "commit", "-qm", "change ShellCheck config");
    const tip = await git(clone, "rev-parse", "HEAD");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner(() => false, []),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    const command = result.value.checksRun.filter((value) =>
      value.includes("shellcheck")
    ).join("\n");
    assert(command);
    assert(command.includes("one.sh"), command);
    assert(command.includes("two scripts.sh"), command);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: nested ShellCheck config changes recheck tracked scripts", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${clone}/scripts`, { recursive: true });
    await Deno.mkdir(`${clone}/other`, { recursive: true });
    await commitShellcheckFiles(clone, {
      "scripts/one.sh": "#!/bin/sh\necho $1\n",
      "other/two.sh": "#!/bin/sh\ntrue\n",
    });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.mkdir(`${clone}/scripts`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/scripts/.shellcheckrc`,
      "disable=SC2086\n",
    );
    await git(clone, "add", "scripts/.shellcheckrc");
    await git(clone, "commit", "-qm", "change nested ShellCheck config");
    const tip = await git(clone, "rev-parse", "HEAD");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner(() => false, []),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    const command = result.value.checksRun.filter((value) =>
      value.includes("shellcheck")
    ).join("\n");
    assert(command);
    assert(command.includes("scripts/one.sh"), command);
    assert(command.includes("other/two.sh"), command);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: unsupported ShellCheck workflow is an incomplete infrastructure result", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    const tip = await commitShellcheckFiles(
      clone,
      { "script.sh": "#!/bin/sh\ntrue\n" },
      "*.sh",
    );
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("unsupported"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: an indirect repository ShellCheck gate is run, not silently skipped (Issue #5046)", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "script.sh": "#!/bin/sh\ntrue\n",
    });
    await Deno.writeTextFile(
      `${clone}/.github/workflows/validate-scripts.yml`,
      "jobs:\n  lint:\n    steps:\n      - run: ./quality.sh\n",
    );
    await Deno.writeTextFile(
      `${clone}/quality.sh`,
      "#!/bin/bash\nshellcheck -e SC1091 *.sh\n",
    );
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "delegate shellcheck to gate script");
    const tip = await git(clone, "rev-parse", "HEAD");
    // Issue #5046: the delegated script is run as CI runs it, not refused.
    const seen: string[] = [];
    const stepRun = "bash --noprofile --norc -eo pipefail ";
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner((command) => command.startsWith(stepRun), seen),
    });
    assert(seen.some((c) => c.startsWith(stepRun)), JSON.stringify(seen));
    assert(!result.ok);
    assert(!(result.error instanceof PrePushGateInfrastructureError));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a missing rcfile is an incomplete infrastructure result", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    const tip = await commitShellcheckFiles(
      clone,
      { "script.sh": "#!/bin/sh\ntrue\n" },
      "--rcfile missing-shellcheckrc",
    );
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(
      result.error.message.includes("cannot read ShellCheck configuration"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a missing ShellCheck tool recovers and revalidates", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    const tip = await commitShellcheckFiles(clone, {
      "clean.sh": "#!/bin/sh\ntrue\n",
    });
    const stub = stubShellcheck();
    const missing = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stub,
      findShellcheck: () => Promise.resolve(null),
    });
    assert(!missing.ok);
    assertInstanceOf(missing.error, PrePushGateInfrastructureError);
    assert(missing.error.message.includes("could not be found"));

    const seen: string[] = [];
    const recovered = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stub,
      runner: recordingRunner(() => false, seen),
    });
    assert(recovered.ok, recovered.ok ? "" : recovered.error.message);
    assert(
      seen.some((command) =>
        command.includes("/stub/shellcheck") && command.includes("clean.sh")
      ),
      seen.join("\n"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a CI and worker ShellCheck version mismatch is incomplete", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    const tip = await commitShellcheckFiles(
      clone,
      { "clean.sh": "#!/bin/sh\ntrue\n" },
    );
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stubShellcheck("9.9.9"),
      runner: recordingRunner(() => false, seen),
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("version mismatch"));
    assert(
      result.error.message.includes(`CI requires ${STUB_SHELLCHECK_VERSION}`),
    );
    assert(result.error.message.includes("worker has 9.9.9"));
    assertEquals(seen, []);
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

for (const mode of [{}, { shellcheckOnly: true }, { ciCargoOnly: true }]) {
  Deno.test(`runPrePushGate: an unparseable deno.json blocks validation in mode ${JSON.stringify(mode)}`, async () => {
    const { root, clone, stdin } = await makeRepoWithDocCommit();
    try {
      const runGate = () => runPrePushGate({
        cwd: clone,
        stdin,
        preFlightCommands: [],
        runner: recordingRunner(() => false, []),
        findMarkdownlint: () => Promise.resolve("/fake/mdl"),
        ...mode,
      });
      assert((await runGate()).ok);
      await Deno.writeTextFile(`${clone}/deno.json`, "{ not json");
      // Scope discovery keeps its unfiltered fallback; validation cannot.
      assertEquals(await loadDenoScopes(clone, ["deno.json"]), {});
      const result = await runGate();
      assert(!result.ok);
      assertEquals(
        result.error.message,
        "cannot parse deno.json; unit tests were not checked",
      );
      assert(!(result.error instanceof PrePushGateInfrastructureError));
      await Deno.writeTextFile(`${clone}/deno.json`, "{}");
      assert((await runGate()).ok);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

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
  const makeGit = (lsFilesCode: number): PrePushGit => (args) => {
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

const CSPELL_STEP = "jobs:\n  spell:\n    steps:\n      - run: npx cspell .\n";

Deno.test("repoCiRunsCspell: a symlinked workflow outside the checkout does not count", async () => {
  const outside = await Deno.makeTempDir();
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${outside}/ci.yml`, CSPELL_STEP);
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.symlink(`${outside}/ci.yml`, `${dir}/.github/workflows/ci.yml`);
    assertEquals(
      await repoCiRunsCspell(dir, [".github/workflows/ci.yml"]),
      false,
    );
    // Positive control: the same text as a regular file counts.
    await Deno.writeTextFile(`${dir}/.github/workflows/real.yml`, CSPELL_STEP);
    assertEquals(
      await repoCiRunsCspell(dir, [".github/workflows/real.yml"]),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("repoCiRunsCspell: a backslash-named symlink beside a decoy directory does not count", async () => {
  const outside = await Deno.makeTempDir();
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${outside}/ci.yml`, CSPELL_STEP);
    // Decoy regular file at the path a backslash-splitting reader would lstat.
    await Deno.mkdir(`${dir}/.github/workflows/x`, { recursive: true });
    await Deno.writeTextFile(`${dir}/.github/workflows/x/y.yml`, CSPELL_STEP);
    // The tracked name is one backslash-containing filename, symlinked out.
    await Deno.symlink(
      `${outside}/ci.yml`,
      `${dir}/.github/workflows/x\\y.yml`,
    );
    assertEquals(
      await repoCiRunsCspell(dir, [".github/workflows/x\\y.yml"]),
      false,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("repoCiRunsCspell: a workflow over the size cap does not count", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    // Comment padding after the cspell step, so only the size cap refuses it.
    const padding = "#\n".repeat(MAX_REPO_FILE_BYTES / 2 + 1);
    await Deno.writeTextFile(
      `${dir}/.github/workflows/big.yml`,
      CSPELL_STEP + padding,
    );
    assertEquals(
      await repoCiRunsCspell(dir, [".github/workflows/big.yml"]),
      false,
    );
    // Positive control: without the padding the cspell step counts.
    await Deno.writeTextFile(`${dir}/.github/workflows/small.yml`, CSPELL_STEP);
    assertEquals(
      await repoCiRunsCspell(dir, [".github/workflows/small.yml"]),
      true,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("loadDenoScopes: a symlinked deno.json outside the checkout is ignored", async () => {
  const outside = await Deno.makeTempDir();
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${outside}/deno.json`, '{"exclude":["src/"]}');
    await Deno.symlink(`${outside}/deno.json`, `${dir}/deno.json`);
    assertEquals(await loadDenoScopes(dir, ["deno.json"]), {});
    // Positive control: the same text as a regular file supplies the scope.
    await Deno.remove(`${dir}/deno.json`);
    await Deno.writeTextFile(`${dir}/deno.json`, '{"exclude":["src/"]}');
    assertEquals(await loadDenoScopes(dir, ["deno.json"]), {
      ".": { exclude: ["src/"], fmt: undefined, lint: undefined },
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("loadDenoScopes: an oversized deno.json is ignored", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const pad = "x".repeat(MAX_REPO_FILE_BYTES);
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      `{"exclude":["src/"],"pad":"${pad}"}`,
    );
    assertEquals(await loadDenoScopes(dir, ["deno.json"]), {});
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
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
  "      - run: cargo test --locked",
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
  "      - run: cargo test --locked",
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
  // `cargo test --locked` in `rust` is covered by the clippy --all-targets
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
      findCiCargo: repoCiCargoChecks,
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

Deno.test("repoShellcheckPolicy: repository workflows distinguish execution from logging and script data", async () => {
  const repo = new URL("../../../", import.meta.url).pathname;
  const tracked = (await git(repo, "ls-files", "-z")).split("\0").filter(
    Boolean,
  );
  const result = await repoShellcheckPolicy(repo, tracked);
  assert(result.ok, result.ok ? "" : result.error);
  assert(result.value);
  // Derive the expectation from the workflow text itself, not typed-in copies.
  const workflow = await Deno.readTextFile(
    new URL("../../../.github/workflows/validate-scripts.yml", import.meta.url),
  );
  assertEquals(
    result.value.version,
    /^\s*SHELLCHECK_VERSION:\s*["']?(\d+\.\d+\.\d+)/m.exec(workflow)?.[1],
  );
  const exec = /-exec\s+shellcheck\s+(.+?)\s+\{\}\s+\+/.exec(workflow);
  assert(exec, "the repository workflow runs ShellCheck through find -exec");
  assertEquals(result.value.flags, exec[1]!.split(/\s+/));
  const container = await repoShellcheckPolicy(
    repo,
    tracked.filter((p) =>
      !p.startsWith(".github/workflows/") || p.endsWith("/container-build.yml")
    ),
  );
  assertEquals(container, { ok: true, value: null });
});

Deno.test("repoShellcheckPolicy: invalid policies return explicit errors", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
  try {
    const cases: [string, string][] = [
      [
        SHELLCHECK_WORKFLOW("--rcfile /tmp/config"),
        "unsafe ShellCheck rcfile path",
      ],
      [
        SHELLCHECK_WORKFLOW("--rcfile config/../rc"),
        "unsafe ShellCheck rcfile path",
      ],
      [SHELLCHECK_WORKFLOW("--rcfile ./rc"), "unsafe ShellCheck rcfile path"],
      [SHELLCHECK_WORKFLOW("--rcfile="), "missing ShellCheck rcfile"],
      [SHELLCHECK_WORKFLOW("--rcfile"), "missing ShellCheck rcfile"],
      [SHELLCHECK_WORKFLOW("--rcfile --norc"), "missing ShellCheck rcfile"],
      [
        SHELLCHECK_WORKFLOW("--rcfile=/tmp/config"),
        "unsafe ShellCheck rcfile path",
      ],
      [
        SHELLCHECK_WORKFLOW("--rcfile=config/../rc"),
        "unsafe ShellCheck rcfile path",
      ],
      [SHELLCHECK_WORKFLOW("-e"), "missing value for ShellCheck option -e"],
      [SHELLCHECK_WORKFLOW("-abc"), "unsupported ShellCheck option -abc"],
      [
        SHELLCHECK_WORKFLOW("-s --norc"),
        "missing value for ShellCheck option -s",
      ],
      [
        SHELLCHECK_WORKFLOW("scripts.sh"),
        "unsupported positional ShellCheck argument",
      ],
      [
        SHELLCHECK_WORKFLOW("-e SC2086").replace(
          'find . -name "*.sh" -type f -exec ',
          "",
        ).replace(" {} +", " *.sh"),
        "unsupported ShellCheck command",
      ],
      [
        SHELLCHECK_WORKFLOW("-e SC2086").replace(
          `"${STUB_SHELLCHECK_VERSION}"`,
          '"latest"',
        ),
        "does not declare one supported pinned version",
      ],
      [
        SHELLCHECK_WORKFLOW("-e SC2086") +
        "    defaults:\n      run:\n        working-directory: scripts\n",
        "unsupported working-directory",
      ],
      [
        "jobs:\n  lint:\n    steps:\n      - uses: example/shellcheck-action@v1\n",
        "unsupported ShellCheck action in workflow",
      ],
      [
        SYNCED_SHELLCHECK_WORKFLOW.replace(
          "severity: warning",
          "severity: warning\n          ignore_paths: vendor",
        ),
        "unsupported ShellCheck action option ignore_paths",
      ],
      [
        SYNCED_SHELLCHECK_WORKFLOW.replace("scandir: .", "scandir: scripts"),
        "unsupported ShellCheck action option scandir",
      ],
      [
        SYNCED_SHELLCHECK_WORKFLOW.replace("warning", "loud"),
        "unsupported ShellCheck action option severity",
      ],
      [
        SYNCED_SHELLCHECK_WORKFLOW.replace(
          "        with:\n          scandir: .",
          "        env:\n          SHELLCHECK_OPTS: -e SC2086\n        with:\n          scandir: .",
        ),
        "unsupported ShellCheck action option SHELLCHECK_OPTS",
      ],
    ];
    for (const [body, error] of cases) {
      await Deno.writeTextFile(`${root}/${path}`, body);
      const result = await repoShellcheckPolicy(root, [path]);
      assertEquals(result.ok, false, body);
      if (!result.ok) {
        assert(result.error.includes(error), `${body}: ${result.error}`);
      }
    }
    await Deno.remove(`${root}/${path}`);
    let readError: Error | undefined;
    try {
      await Deno.lstat(`${root}/${path}`);
    } catch (error) {
      readError = error as Error;
    }
    assert(readError);
    assertEquals(await repoShellcheckPolicy(root, [path]), {
      ok: false,
      error: `cannot read tracked workflow ${path}: ${readError.message}`,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("repoShellcheckPolicy: non-workflow paths, comments, probes and short rcfile option", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yaml";
  await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
  try {
    const ignored = ["check.yml", ".github/workflows/check.txt"];
    assertEquals(await repoShellcheckPolicy(root, ignored), {
      ok: true,
      value: null,
    });
    await Deno.writeTextFile(
      `${root}/${path}`,
      SHELLCHECK_WORKFLOW("-rc config/rc").replace(
        "          find .",
        '          # shellcheck ignored.sh\n\n          shellcheck --version\n          echo "installing shellcheck"\n          sudo apt-get install shellcheck\n          find .',
      ),
    );
    const result = await repoShellcheckPolicy(root, [path, "config/rc"]);
    assertEquals(result, {
      ok: true,
      value: {
        version: STUB_SHELLCHECK_VERSION,
        flags: ["-rc", "config/rc"],
        configFiles: ["config/rc"],
        workflowFiles: [path],
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a commented YAML block header still plans the ShellCheck check", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    const tip = await commitShellcheckFiles(clone, {
      "bad.sh": "#!/bin/sh\necho $1\n",
    });
    const path = `${clone}/.github/workflows/validate-scripts.yml`;
    await Deno.writeTextFile(
      path,
      (await Deno.readTextFile(path)).replace(
        "run: |",
        "run: | # Check scripts",
      ),
    );
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner((command) => command.includes("bad.sh"), seen),
    });
    assertEquals(result.ok, false);
    assert(seen.some((command) => command.includes("bad.sh")), seen.join("\n"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: without findCiCargo a Rust push runs no CI cargo command (a hook spec with no ciCargo), and with it the same push runs clippy", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles({
    ...RUST_FILES,
    ".github/workflows/ci.yml": RUST_WORKFLOW,
  });
  try {
    const hookCalls: RanCall[] = [];
    const hook = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: scriptedRunner(() => ({}), hookCalls),
    });
    assert(hook.ok, hook.ok ? "" : hook.error.message);
    assertEquals(ciRuns(hookCalls), []);
    assertEquals(hook.value.checksRun.filter((c) => c.includes("clippy")), []);

    const workerCalls: RanCall[] = [];
    const worker = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: scriptedRunner(() => ({}), workerCalls),
      findCiCargo: repoCiCargoChecks,
    });
    assert(worker.ok, worker.ok ? "" : worker.error.message);
    assertEquals(ciRuns(workerCalls).map((c) => c.command), [CLIPPY_CMD]);
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

for (const config of [".shellcheckrc", "scripts/.shellcheckrc"]) {
  Deno.test(`runPrePushGate: deleting ${config} revalidates unchanged scripts without it`, async () => {
    const { root, clone } = await makeRepoWithDocCommit();
    try {
      await Deno.mkdir(`${clone}/scripts`, { recursive: true });
      await commitShellcheckFiles(clone, {
        "scripts/bad.sh": "#!/bin/sh\necho $1\n",
        [config]: "disable=SC2086\n",
      });
      await git(clone, "push", "-q", "origin", "HEAD:main");
      await Deno.remove(`${clone}/${config}`);
      await git(clone, "add", "-A");
      await git(clone, "commit", "-qm", "remove config");
      const seen: string[] = [];
      const result = await runPrePushGate({
        cwd: clone,
        stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
        preFlightCommands: [],
        ...stubShellcheck(),
        runner: recordingRunner(() => false, seen),
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      const command = seen.find((value) => value.includes("scripts/bad.sh"));
      assert(command, seen.join("\n"));
      assert(command.includes("--norc"), command);
      assert(!command.includes("--rcfile"), command);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("repoShellcheckPolicy: delegated execution has an explicit false verdict", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
  try {
    await Deno.writeTextFile(
      `${root}/${path}`,
      "jobs:\n  lint:\n    steps:\n      - run: bash check.sh\n",
    );
    await Deno.writeTextFile(
      `${root}/check.sh`,
      "#!/bin/sh\n# shellcheck disable=SC2086\necho 'shellcheck logs'\nIMAGE_PATHS=(\n  'data.sh'\n)\n",
    );
    await Deno.writeTextFile(
      `${root}/data.sh`,
      "#!/bin/sh\nshellcheck script.sh\n",
    );
    assertEquals(
      await repoShellcheckPolicy(root, [path, "check.sh", "data.sh"]),
      {
        ok: true,
        value: null,
      },
    );
    await Deno.writeTextFile(
      `${root}/check.sh`,
      "#!/bin/sh\nshellcheck script.sh\n",
    );
    assertEquals(await repoShellcheckPolicy(root, [path, "check.sh"]), {
      ok: false,
      error:
        `repository CI delegates ShellCheck through a script in workflow ${path}`,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("repoShellcheckPolicy: comments and version probes do not become checks", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
  try {
    for (
      const line of ["", "# shellcheck ignored.sh", "shellcheck --version"]
    ) {
      await Deno.writeTextFile(
        `${root}/${path}`,
        SHELLCHECK_WORKFLOW("-e SC2086").replace(
          "          find .",
          `${line ? `          ${line}\n` : "\n"}          find .`,
        ),
      );
      const result = await repoShellcheckPolicy(root, [path]);
      assertEquals(result.ok, true, line);
      if (result.ok) assertEquals(result.value?.flags, ["-e", "SC2086"]);
    }
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

Deno.test("repoShellcheckPolicy: the worker's synced ludeeus template is a supported policy", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/shellcheck.yml";
  await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
  try {
    await Deno.writeTextFile(`${root}/${path}`, SYNCED_SHELLCHECK_WORKFLOW);
    assertEquals(await repoShellcheckPolicy(root, [path, ".shellcheckrc"]), {
      ok: true,
      value: {
        version: null,
        flags: ["--severity=warning"],
        configFiles: [".shellcheckrc"],
        workflowFiles: [path],
      },
    });
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

Deno.test("repoShellcheckPolicy: value-taking options consume their value", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
  try {
    const accepted: [string, string[]][] = [
      ["-S warning", ["-S", "warning"]],
      ["--severity warning", ["--severity", "warning"]],
      ["--severity=warning", ["--severity=warning"]],
      ["-Swarning", ["-Swarning"]],
      ["--enable all", ["--enable", "all"]],
      ["-o all", ["-o", "all"]],
      ["-i SC2086", ["-i", "SC2086"]],
      ["--include=SC2086", ["--include=SC2086"]],
      ["-P SCRIPTDIR", ["-P", "SCRIPTDIR"]],
      ["--source-path=SCRIPTDIR", ["--source-path=SCRIPTDIR"]],
      ["-f gcc", ["-f", "gcc"]],
      ["--format gcc", ["--format", "gcc"]],
      ["-W 0", ["-W", "0"]],
      ["--wiki-link-count 0", ["--wiki-link-count", "0"]],
      ["-x -a", ["-x", "-a"]],
    ];
    for (const [flags, expected] of accepted) {
      await Deno.writeTextFile(`${root}/${path}`, SHELLCHECK_WORKFLOW(flags));
      const result = await repoShellcheckPolicy(root, [path]);
      assert(result.ok, `${flags}: ${result.ok ? "" : result.error}`);
      assertEquals(result.value?.flags, expected, flags);
    }
    const rejected: [string, string][] = [
      ["-S", "missing value for ShellCheck option -S"],
      ["--severity", "missing value for ShellCheck option --severity"],
      ["--severity=", "missing value for ShellCheck option --severity"],
      ["--enable --norc", "missing value for ShellCheck option --enable"],
      ["-S warning stray", "unsupported positional ShellCheck argument"],
    ];
    for (const [flags, error] of rejected) {
      await Deno.writeTextFile(`${root}/${path}`, SHELLCHECK_WORKFLOW(flags));
      const result = await repoShellcheckPolicy(root, [path]);
      assertEquals(result.ok, false, flags);
      if (!result.ok) assert(result.error.includes(error), result.error);
    }
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
      findCiCargo: repoCiCargoChecks,
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

Deno.test("runPrePushGate: ciCargoOnly on a docs-only push runs only markdownlint for the pushed Markdown and does not read the CI cargo scan (Issue #4930)", async () => {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    const run = async (markdownlintCode: number) => {
      const calls: RanCall[] = [];
      let read = false;
      const result = await runPrePushGate({
        cwd: clone,
        stdin,
        preFlightCommands: ["pre-flight-cmd"],
        runner: scriptedRunner(
          (c) =>
            c.includes("markdownlint-cli2")
              ? { code: markdownlintCode, stdout: "README.md:1 MD018" }
              : {},
          calls,
        ),
        findMarkdownlint: () => Promise.resolve("markdownlint-cli2"),
        findCiCargo: () => {
          read = true;
          return Promise.resolve(scanOf(CLIPPY_CHECK));
        },
        ciCargoOnly: true,
      });
      assert(
        !read,
        "the CI cargo scan is read only for a Rust-relevant change",
      );
      return { result, calls };
    };
    // A repair push that breaks the pushed Markdown is blocked, as CI would.
    const blocked = await run(1);
    assert(!blocked.result.ok, "markdownlint must gate a ciCargoOnly push");
    assertStringIncludes(blocked.result.error.message, "MD018");
    // Control: clean Markdown passes, and nothing but markdownlint ran (no
    // deno fmt, no pre-flight command).
    const passed = await run(0);
    assert(
      passed.result.ok,
      passed.result.ok ? "" : passed.result.error.message,
    );
    assertEquals(passed.result.value.checksRun.length, 1);
    assertStringIncludes(
      passed.result.value.checksRun[0]!,
      "markdownlint-cli2",
    );
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

Deno.test("repoShellcheckPolicy: flagless find and wrapped invocations", async () => {
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  await Deno.mkdir(`${root}/.github/workflows`, { recursive: true });
  try {
    await Deno.writeTextFile(`${root}/${path}`, SHELLCHECK_WORKFLOW(""));
    const plain = await repoShellcheckPolicy(root, [path]);
    assert(plain.ok);
    assertEquals(plain.value?.flags, []);
    for (
      const command of [
        "git ls-files '*.sh' | xargs shellcheck",
        "find . -print0 | xargs -0 shellcheck",
        'for f in *.sh; do shellcheck "$f"; done',
        "time shellcheck x.sh",
        "exec shellcheck x.sh",
        "nice shellcheck x.sh",
        "timeout 10 shellcheck x.sh",
        "parallel shellcheck ::: x.sh",
      ]
    ) {
      await Deno.writeTextFile(
        `${root}/${path}`,
        SHELLCHECK_WORKFLOW("").replace(
          'find . -name "*.sh" -type f -exec shellcheck  {} +',
          command,
        ),
      );
      const result = await repoShellcheckPolicy(root, [path]);
      assert(!result.ok, command);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: flagless find checks a changed script", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, { "run.sh": "#!/bin/sh\ntrue\n" }, "");
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner(() => false, seen),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(
      seen.some((command) =>
        command.includes("shellcheck") && command.includes("run.sh")
      ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: unrelated workflow changes do not trigger an unsupported policy", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.mkdir(`${clone}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/.github/workflows/shellcheck.yml`,
      "jobs:\n  lint:\n    steps:\n      - uses: example/shellcheck-action@v1\n",
    );
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "unsupported policy");
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.writeTextFile(
      `${clone}/.github/workflows/rust.yml`,
      "name: Rust\n",
    );
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "unrelated workflow");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      findShellcheck: () => Promise.resolve(null),
      runner: recordingRunner(() => false, []),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a synced ludeeus workflow plans --severity for a changed script", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.mkdir(`${clone}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/.github/workflows/shellcheck.yml`,
      SYNCED_SHELLCHECK_WORKFLOW,
    );
    await Deno.writeTextFile(`${clone}/run.sh`, "#!/bin/sh\ntrue\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "synced workflow and a script");
    const seen: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      // A host ShellCheck of any version satisfies an action-managed policy.
      ...stubShellcheck("7.7.7"),
      runner: recordingRunner(() => false, seen),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(
      seen.some((command) =>
        command.includes("--severity=warning") && command.includes("run.sh")
      ),
      seen.join("\n"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

for (
  const [label, workflow] of [
    ["the worker's synced ludeeus template", SYNCED_SHELLCHECK_WORKFLOW],
    [
      "an unsupported ShellCheck action",
      "jobs:\n  lint:\n    steps:\n      - uses: example/shellcheck-action@v1\n",
    ],
    [
      "a delegating script",
      "jobs:\n  lint:\n    steps:\n      - run: ./quality.sh\n",
    ],
  ] as const
) {
  Deno.test(`runPrePushGate: a non-shell push is not refused in a repo with ${label}`, async () => {
    const { root, clone } = await makeRepoWithDocCommit();
    try {
      await git(clone, "push", "-q", "origin", "HEAD:main");
      await Deno.mkdir(`${clone}/.github/workflows`, { recursive: true });
      await Deno.writeTextFile(
        `${clone}/.github/workflows/shellcheck.yml`,
        workflow,
      );
      await Deno.writeTextFile(
        `${clone}/quality.sh`,
        "#!/bin/bash\nshellcheck *.sh\n",
      );
      await git(clone, "add", "-A");
      await git(clone, "commit", "-qm", "add the workflow");
      await git(clone, "push", "-q", "origin", "HEAD:main");
      await Deno.writeTextFile(`${clone}/notes.txt`, "not a script\n");
      await Deno.writeTextFile(`${clone}/lib.rs`, "fn main() {}\n");
      await Deno.writeTextFile(`${clone}/Dockerfile`, "FROM alpine\n");
      await git(clone, "add", "-A");
      await git(clone, "commit", "-qm", "non-shell change");
      const seen: string[] = [];
      const result = await runPrePushGate({
        cwd: clone,
        stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
        preFlightCommands: [],
        // No ShellCheck on the host: a non-shell push must not look for it.
        findShellcheck: () => Promise.resolve(null),
        runner: recordingRunner(() => false, seen),
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      assert(!seen.some((command) => command.includes("shellcheck")));
      await git(clone, "push", "-q", "origin", "HEAD:main");
      await Deno.writeTextFile(`${clone}/script`, "#!/bin/bash\necho $1\n", {
        mode: 0o755,
      });
      await git(clone, "add", "script");
      await git(clone, "commit", "-qm", "shell script");
      const shellResult = await runPrePushGate({
        cwd: clone,
        stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
        preFlightCommands: [],
        findShellcheck: () => Promise.resolve(null),
        runner: recordingRunner(() => false, []),
      });
      assert(!shellResult.ok);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("runPrePushGate: an unsupported ShellCheck workflow still refuses a script push", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.mkdir(`${clone}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/.github/workflows/shellcheck.yml`,
      "jobs:\n  lint:\n    steps:\n      - uses: example/shellcheck-action@v1\n",
    );
    await Deno.writeTextFile(`${clone}/run.sh`, "#!/bin/sh\ntrue\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "script");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      ...stubShellcheck(),
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("unsupported ShellCheck action"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---- CI cargo: every toolchain probed, missing capability, base failures ----
// (PR #4896 review)

const STABLE_CLIPPY: CiCargoCheck = {
  ...CLIPPY_CHECK,
  env: {},
  argv: ["cargo", "+stable", "clippy", "--all-targets"],
};
const MSRV_TEST_BUILD: CiCargoCheck = {
  kind: "test-build",
  workingDirectory: "rust",
  argv: ["cargo", "+1.74.0", "test", "--no-run"],
  env: {},
  source: "ci.yml",
};
const MISSING_TOOLCHAIN =
  "error: toolchain '1.74.0-x86_64-unknown-linux-gnu' is not installed";

Deno.test("runPrePushGate: a second toolchain that is missing is infrastructure, and no CI cargo command runs", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const calls: RanCall[] = [];
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner(
        (c) =>
          c === "cargo +1.74.0 --version"
            ? { code: 1, stderr: MISSING_TOOLCHAIN }
            : {},
        calls,
      ),
      scanOf(STABLE_CLIPPY, MSRV_TEST_BUILD),
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("cargo +1.74.0 --version"));
    assert(result.error.message.includes("is not installed"));
    // The stable toolchain was probed too, so the probe covered both.
    assert(calls.some((c) => c.command === "cargo +stable --version"));
    assertEquals(ciRuns(calls), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a clippy component missing from a second toolchain is probed and is infrastructure", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const calls: RanCall[] = [];
    const beta: CiCargoCheck = {
      ...STABLE_CLIPPY,
      argv: ["cargo", "+beta", "clippy", "--all-targets"],
    };
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner(
        (c) =>
          c === "cargo +beta clippy --version"
            ? {
              code: 1,
              stderr:
                "error: 'cargo-clippy' is not installed for the toolchain 'beta'",
            }
            : {},
        calls,
      ),
      scanOf(STABLE_CLIPPY, beta),
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("cargo +beta clippy --version"));
    assertEquals(ciRuns(calls), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: rustup and rustc output for a missing toolchain, component or target is infrastructure, not a block", async () => {
  const outputs = [
    MISSING_TOOLCHAIN,
    "error: 'cargo-clippy' is not installed for the toolchain 'stable'",
    "error[E0463]: can't find crate for `core`\n  |\n  = note: the `wasm32-unknown-unknown` target may not be installed\n",
  ];
  for (const stderr of outputs) {
    const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
    try {
      const result = await gateRust(
        clone,
        stdin,
        scriptedRunner(
          (c) => c === CLIPPY_CMD ? { code: 101, stderr } : {},
          [],
        ),
      );
      assert(!result.ok, stderr);
      assertInstanceOf(result.error, PrePushGateInfrastructureError, stderr);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("runPrePushGate: a lint whose source excerpt quotes 'is not installed' still blocks", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const stderr = [
      "error: this could be a `const fn` (clippy::must_use_candidate)",
      "  --> rust/src/lib.rs:1:1",
      '12 |     let x = "error: toolchain is not installed";',
      "   = note: the lint is denied by `-D warnings`",
      "",
    ].join("\n");
    const result = await gateRust(
      clone,
      stdin,
      scriptedRunner((c) => c === CLIPPY_CMD ? { code: 101, stderr } : {}, []),
    );
    assert(!result.ok);
    assert(!(result.error instanceof PrePushGateInfrastructureError));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const LINT_A =
  "error: this could be a `const fn`\n  --> src/a.rs:4:1\n   = note: `-D clippy::must_use_candidate` implied by `-D warnings`\n";
const LINT_B = "error: unused variable: `x`\n  --> src/b.rs:9:5\n";

Deno.test("runPrePushGate: an unreachable registry is infrastructure", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const result = await gateAgainstBase(clone, stdin, () => ({
      code: 101,
      stderr:
        "error: failed to get `serde` as a dependency\nCaused by:\n  Could not resolve host: index.crates.io\n",
    }), []);
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assertStringIncludes(result.error.message, "Could not resolve host");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** A real existing crate on the base, followed by a Rust repair commit. */
async function makeRepoWithCargoBase() {
  const repo = await makeRepoWithFiles(RUST_FILES);
  await git(repo.clone, "push", "-q", "origin", "HEAD:main");
  await Deno.writeTextFile(
    `${repo.clone}/rust/src/lib.rs`,
    "// unrelated repair\n",
  );
  await git(repo.clone, "commit", "-qam", "repair");
  const sha = await git(repo.clone, "rev-parse", "HEAD");
  return {
    ...repo,
    stdin: `refs/heads/repair ${sha} refs/heads/repair ${"0".repeat(40)}\n`,
  };
}

/** Gate `clone` with the base-comparison ref set to its parent commit. */
async function gateAgainstBase(
  clone: string,
  stdin: string,
  answer: (onBase: boolean) => Partial<PreFlightCommandResult>,
  calls: RanCall[],
  compareRef?: string,
) {
  const ref = compareRef ?? await git(clone, "rev-parse", "HEAD~1");
  const runner: PreFlightRunner = (command, options) => {
    calls.push({ command, cwd: options.cwd, env: options.env });
    const onBase = (options.cwd ?? "").includes("vibe-base-check-");
    return Promise.resolve({
      started: true,
      code: 0,
      stdout: "",
      stderr: "",
      ...(command === CLIPPY_CMD ? answer(onBase) : {}),
    });
  };
  return await runPrePushGate({
    cwd: clone,
    stdin,
    preFlightCommands: [],
    runner,
    findCiCargo: () => Promise.resolve(scanOf(CLIPPY_CHECK)),
    compareRef: ref,
  });
}

Deno.test("runPrePushGate: a clippy failure the PR base already has is no verdict on the push", async () => {
  const { root, clone, stdin } = await makeRepoWithCargoBase();
  try {
    const calls: RanCall[] = [];
    const result = await gateAgainstBase(
      clone,
      stdin,
      () => ({ code: 101, stderr: LINT_A }),
      calls,
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(!result.value.checksRun.includes(CLIPPY_CMD));
    // The base run was CI's own command, in the same directory of the base tree.
    const baseRun = calls.find((c) =>
      c.command === CLIPPY_CMD && c.cwd?.includes("vibe-base-check-")
    );
    assert(baseRun, "clippy must run on the base tree");
    assert(baseRun.cwd?.endsWith("/tree/rust"), baseRun.cwd);
    assertEquals(baseRun.env, { RUSTFLAGS: "-D warnings" });
    // The scratch worktree is gone afterwards.
    const worktrees = await git(clone, "worktree", "list");
    assertEquals(worktrees.split("\n").length, 1, worktrees);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a warning the push adds does not turn a base-only failure into a verdict (Issue #4630 review)", async () => {
  // A warning never fails a CI cargo command, so it is no evidence that the
  // push caused the failure: only error-level diagnostics are compared.
  const cases: [string, string][] = [
    [
      "a plain rustc warning",
      "warning: unused import: `std::fmt`\n  --> src/lib.rs:1:5\n",
    ],
    [
      "cargo's build-failed notice",
      "warning: build failed, waiting for other jobs to finish...\n",
    ],
  ];
  for (const [name, warning] of cases) {
    const { root, clone, stdin } = await makeRepoWithCargoBase();
    try {
      const result = await gateAgainstBase(
        clone,
        stdin,
        (onBase) => ({
          code: 101,
          stderr: onBase ? LINT_A : LINT_A + warning,
        }),
        [],
      );
      assert(result.ok, `${name}: ${result.ok ? "" : result.error.message}`);
      assert(!result.value.checksRun.includes(CLIPPY_CMD), name);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("runPrePushGate: a clippy failure that is new on the push blocks, whatever the base shows", async () => {
  const cases: [
    string,
    (onBase: boolean) => Partial<PreFlightCommandResult>,
  ][] = [
    [
      "the base passes",
      (onBase) => onBase ? {} : { code: 101, stderr: LINT_A },
    ],
    [
      "the push adds a diagnostic the base lacks",
      (onBase) => ({ code: 101, stderr: onBase ? LINT_A : LINT_A + LINT_B }),
    ],
    [
      "the push repeats a diagnostic the base shows once, in the same file",
      (onBase) => ({ code: 101, stderr: onBase ? LINT_A : LINT_A + LINT_A }),
    ],
  ];
  for (const [name, answer] of cases) {
    const { root, clone, stdin } = await makeRepoWithCargoBase();
    try {
      const result = await gateAgainstBase(clone, stdin, answer, []);
      assert(!result.ok, name);
      assertInstanceOf(result.error, PreFlightGateError, name);
      assert(!(result.error instanceof PrePushGateInfrastructureError), name);
      assertEquals(result.error.command, CLIPPY_CMD, name);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("runPrePushGate: an unavailable base comparison is infrastructure", async () => {
  const { root, clone, stdin } = await makeRepoWithCargoBase();
  try {
    for (const ref of ["origin/no-such-branch", "--upload-pack=x", "a..b"]) {
      const calls: RanCall[] = [];
      const result = await gateAgainstBase(
        clone,
        stdin,
        () => ({ code: 101, stderr: LINT_A }),
        calls,
        ref,
      );
      assert(!result.ok, ref);
      assertInstanceOf(result.error, PrePushGateInfrastructureError, ref);
      assert(
        !calls.some((c) => c.cwd?.includes("vibe-base-check-")),
        `${ref}: nothing may run on a base tree that was not made`,
      );
    }
    const noDiagnostic = await gateAgainstBase(
      clone,
      stdin,
      () => ({ code: 101, stderr: `error[${"A".repeat(200_000)}` }),
      [],
    );
    assert(!noDiagnostic.ok);
    assertInstanceOf(noDiagnostic.error, PrePushGateInfrastructureError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a base host fault is infrastructure", async () => {
  const { root, clone, stdin } = await makeRepoWithCargoBase();
  try {
    for (
      const failure of [
        { code: 101, stderr: "error: No space left on device (os error 28)" },
        { code: TIMEOUT_EXIT_CODE, timedOut: true },
        {
          code: 101,
          stderr: "warning: spurious network error: Could not resolve host",
        },
      ]
    ) {
      const result = await gateAgainstBase(
        clone,
        stdin,
        (onBase) => onBase ? failure : { code: 101, stderr: LINT_A },
        [],
      );
      assert(!result.ok);
      assertInstanceOf(result.error, PrePushGateInfrastructureError);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("review 4896: a new crate's failure is a verdict with its diagnostic", async () => {
  const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
  try {
    const calls: RanCall[] = [];
    const result = await gateAgainstBase(
      clone,
      stdin,
      () => ({ code: 101, stderr: LINT_A }),
      calls,
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PreFlightGateError);
    assert(!(result.error instanceof PrePushGateInfrastructureError));
    assertStringIncludes(result.error.output, LINT_A.trim());
    assert(
      !calls.some((c) => c.cwd?.includes("vibe-base-check-")),
      "the absent crate cannot be run on the base",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("review 4896: compare against fresh remote main when its local ref is stale or absent", async () => {
  for (const absent of [false, true]) {
    const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
    try {
      const green = await git(clone, "rev-parse", "HEAD");
      await git(clone, "push", "-q", "origin", "HEAD:main");
      await Deno.writeTextFile(`${clone}/rust/src/lib.rs`, "// base failure\n");
      await git(clone, "commit", "-qam", "base failure");
      const red = await git(clone, "rev-parse", "HEAD");
      await git(clone, "push", "-q", "origin", "HEAD:main");
      if (absent) {
        await git(clone, "update-ref", "-d", "refs/remotes/origin/main");
      } else await git(clone, "update-ref", "refs/remotes/origin/main", green);
      await Deno.writeTextFile(
        `${clone}/rust/src/lib.rs`,
        "// base failure\n// unrelated repair\n",
      );
      await git(clone, "commit", "-qam", "unrelated repair");
      const head = await git(clone, "rev-parse", "HEAD");
      const runner: PreFlightRunner = async (command, options) => {
        const source = command === CLIPPY_CMD
          ? await Deno.readTextFile(`${options.cwd}/src/lib.rs`)
          : "";
        return {
          started: true,
          code: source.includes("base failure") ? 101 : 0,
          stdout: "",
          stderr: source.includes("base failure") ? LINT_A : "",
        };
      };
      const result = await runPrePushGate({
        cwd: clone,
        stdin: stdin.replaceAll(green, head),
        preFlightCommands: [],
        runner,
        findCiCargo: () => Promise.resolve(scanOf(CLIPPY_CHECK)),
        compareRef: absent ? "refs/remotes/origin/main" : "origin/main",
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      assert(!result.value.checksRun.includes(CLIPPY_CMD));
      assertEquals(await git(clone, "rev-parse", "origin/main"), red);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("review 4896: a lint the head inherited from an older base that the tip has since fixed is no verdict", async () => {
  // M0 has the lint in lib.rs; M1 (the refreshed tip) fixes it; the head is M0
  // plus an edit to b.rs. Only the fork point (M0) shows the head's diagnostic.
  for (const newLint of [false, true]) {
    const { root, clone, stdin } = await makeRepoWithFiles(RUST_FILES);
    try {
      const green = await git(clone, "rev-parse", "HEAD");
      await Deno.writeTextFile(`${clone}/rust/src/lib.rs`, "// base failure\n");
      await git(clone, "commit", "-qam", "M0: the lint");
      const m0 = await git(clone, "rev-parse", "HEAD");
      await git(clone, "push", "-q", "origin", "HEAD:main");
      await Deno.writeTextFile(`${clone}/rust/src/lib.rs`, "// fixed\n");
      await git(clone, "commit", "-qam", "M1: the fix");
      await git(clone, "push", "-q", "origin", "HEAD:main");
      const m1 = await git(clone, "rev-parse", "HEAD");
      await git(clone, "reset", "-q", "--hard", m0);
      await git(clone, "update-ref", "refs/remotes/origin/main", green);
      await Deno.writeTextFile(
        `${clone}/rust/src/b.rs`,
        newLint ? "// new lint\n" : "// unrelated repair\n",
      );
      await git(clone, "add", ".");
      await git(clone, "commit", "-qm", "repair b.rs");
      const head = await git(clone, "rev-parse", "HEAD");
      const runner: PreFlightRunner = async (command, options) => {
        const read = async (file: string) =>
          await Deno.readTextFile(`${options.cwd}/src/${file}`).catch(() => "");
        const lib = command === CLIPPY_CMD ? await read("lib.rs") : "";
        const b = command === CLIPPY_CMD ? await read("b.rs") : "";
        const stderr = (lib.includes("base failure") ? LINT_A : "") +
          (b.includes("new lint") ? LINT_B : "");
        return {
          started: true,
          code: stderr === "" ? 0 : 101,
          stdout: "",
          stderr,
        };
      };
      const result = await runPrePushGate({
        cwd: clone,
        stdin: stdin.replaceAll(green, head),
        preFlightCommands: [],
        runner,
        findCiCargo: () => Promise.resolve(scanOf(CLIPPY_CHECK)),
        compareRef: "origin/main",
      });
      assertEquals(await git(clone, "rev-parse", "origin/main"), m1);
      if (newLint) {
        assert(!result.ok, "a diagnostic neither base shows still blocks");
        assertInstanceOf(result.error, PreFlightGateError);
        assert(!(result.error instanceof PrePushGateInfrastructureError));
      } else {
        assert(result.ok, result.ok ? "" : result.error.message);
        assert(!result.value.checksRun.includes(CLIPPY_CMD));
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("review 4896: a head with no fork point on the base cannot be told from its base, so it is infrastructure", async () => {
  const { root, clone } = await makeRepoWithCargoBase();
  try {
    await git(clone, "checkout", "-q", "--orphan", "alt");
    await Deno.writeTextFile(`${clone}/rust/src/lib.rs`, "// orphan\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "orphan");
    const head = await git(clone, "rev-parse", "HEAD");
    const result = await gateAgainstBase(
      clone,
      `refs/heads/alt ${head} refs/heads/alt ${"0".repeat(40)}\n`,
      (onBase) => onBase ? {} : { code: 101, stderr: LINT_A },
      [],
      "origin/main",
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("review 4896: a failed base fetch retains capped redacted head diagnostics as infrastructure", async () => {
  const { root, clone, stdin } = await makeRepoWithCargoBase();
  try {
    await git(clone, "remote", "set-url", "origin", `${root}/missing.git`);
    const secret = "ghp_" + "x".repeat(36);
    const result = await gateAgainstBase(
      clone,
      stdin,
      () => ({ code: 101, stderr: LINT_A + secret + "\n" + "x".repeat(10000) }),
      [],
      "origin/main",
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assertStringIncludes(result.error.message, LINT_A.trim());
    assert(!result.error.message.includes(secret));
    assert(result.error.message.length < 2200);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** A runner failing clippy with LINT_A on the head, and `onBase` answering the base worktrees. */
function lintRunner(
  base: { code: number; stderr: string },
  seen: { baseCwds: string[] },
): PreFlightRunner {
  return (command, options) => {
    const onBase = (options.cwd ?? "").includes("vibe-base-check-");
    if (onBase && command === CLIPPY_CMD) {
      seen.baseCwds.push(options.cwd ?? "");
    }
    const answer = command !== CLIPPY_CMD
      ? { code: 0, stderr: "" }
      : onBase
      ? base
      : { code: 101, stderr: LINT_A };
    return Promise.resolve({ started: true, stdout: "", ...answer });
  };
}

/** The scratch directory a base worktree path (`<scratch>/tree[/...]`) lives in. */
function scratchOf(baseCwd: string): string {
  return baseCwd.slice(0, baseCwd.indexOf("/tree"));
}

/** Run the gate with the real git, except for the commands `override` answers. */
async function gateWithGit(
  clone: string,
  stdin: string,
  runner: PreFlightRunner,
  override: (args: string[]) => Awaited<ReturnType<PrePushGit>> | undefined,
  timeoutSeconds?: number,
) {
  const warnings: string[] = [];
  const realWarn = console.warn;
  // Only the cleanup warning: the "fails the same way on the base" one is expected.
  console.warn = (...parts: unknown[]) => {
    const line = parts.join(" ");
    if (line.includes("could not remove the base worktree")) {
      warnings.push(line);
    }
  };
  try {
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner,
      findCiCargo: () => Promise.resolve(scanOf(CLIPPY_CHECK)),
      compareRef: "origin/main",
      timeoutSeconds,
      git: (args, cwd) => {
        const answer = override(args);
        return answer === undefined
          ? defaultPrePushGit(args, cwd)
          : Promise.resolve(answer);
      },
    });
    return { result, warnings };
  } finally {
    console.warn = realWarn;
  }
}

/** `override` that answers nothing, so the real git runs. */
const realGit = () => undefined;

Deno.test("review 4896: a base run that outlasts the PR timeout is infrastructure, not a verdict", async () => {
  const BASE_RUN_SECONDS = 100;
  const MESSAGE =
    "Could not compare the failed CI cargo check against the PR base";
  // Models the timeout rule: the base clippy run takes BASE_RUN_SECONDS and is
  // cut off when the deadline it is given is shorter; otherwise it fails like the head.
  const runner: PreFlightRunner = (command, options) => {
    const onBase = (options.cwd ?? "").includes("vibe-base-check-");
    if (command !== CLIPPY_CMD) {
      return Promise.resolve({
        started: true,
        code: 0,
        stdout: "",
        stderr: "",
      });
    }
    if (onBase && options.timeoutSeconds < BASE_RUN_SECONDS) {
      return Promise.resolve({
        started: true,
        code: TIMEOUT_EXIT_CODE,
        timedOut: true,
        stdout: "",
        stderr: "",
      });
    }
    return Promise.resolve({
      started: true,
      code: 101,
      stdout: "",
      stderr: LINT_A,
    });
  };
  for (const [timeoutSeconds, cutOff] of [[77, true], [200, false]] as const) {
    const { root, clone, stdin } = await makeRepoWithCargoBase();
    try {
      const { result } = await gateWithGit(
        clone,
        stdin,
        runner,
        realGit,
        timeoutSeconds,
      );
      if (cutOff) {
        assert(!result.ok, "a base run cut off at 77s must not pass the gate");
        assertInstanceOf(result.error, PrePushGateInfrastructureError);
        assertStringIncludes(result.error.message, MESSAGE);
      } else {
        // Positive control: given enough time the base fails the same way, so the push proceeds.
        assert(result.ok, result.ok ? "" : result.error.message);
      }
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});

Deno.test("review 4896: a base worktree and its scratch directory are removed without a warning", async () => {
  const { root, clone, stdin } = await makeRepoWithCargoBase();
  try {
    const seen = { baseCwds: [] as string[] };
    const { result, warnings } = await gateWithGit(
      clone,
      stdin,
      lintRunner({ code: 101, stderr: LINT_A }, seen),
      realGit,
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(seen.baseCwds.length, 1);
    const scratch = scratchOf(seen.baseCwds[0]!);
    await assertRejects(() => Deno.stat(scratch), Deno.errors.NotFound);
    assertEquals(warnings, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("review 4896: a worktree remove that fails warns and still deletes the non-empty scratch directory", async () => {
  const { root, clone, stdin } = await makeRepoWithCargoBase();
  try {
    const seen = { baseCwds: [] as string[] };
    const { result, warnings } = await gateWithGit(
      clone,
      stdin,
      lintRunner({ code: 101, stderr: LINT_A }, seen),
      (args) =>
        args[0] === "worktree" && args[1] === "remove"
          ? { code: 1, stdout: "", stderr: "remove refused" }
          : undefined,
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "[PRE_PUSH_WARNING]");
    assertStringIncludes(warnings[0]!, "remove refused");
    await assertRejects(
      () => Deno.stat(scratchOf(seen.baseCwds[0]!)),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("review 4896: a worktree that cannot be added is infrastructure and is not removed", async () => {
  const { root, clone, stdin } = await makeRepoWithCargoBase();
  try {
    const seen = { baseCwds: [] as string[] };
    const { result, warnings } = await gateWithGit(
      clone,
      stdin,
      lintRunner({ code: 101, stderr: LINT_A }, seen),
      (args) =>
        args[0] === "worktree" && args[1] === "add"
          ? { code: 1, stdout: "", stderr: "add refused" }
          : undefined,
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assertEquals(warnings, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("review 4896: a merge-base that fails is no fork point, whatever it printed", async () => {
  const { root, clone, stdin } = await makeRepoWithCargoBase();
  try {
    const head = await git(clone, "rev-parse", "HEAD");
    const seen = { baseCwds: [] as string[] };
    // The base passes, so only the fork point could excuse the failure.
    const { result } = await gateWithGit(
      clone,
      stdin,
      lintRunner({ code: 0, stderr: "" }, seen),
      (args) =>
        args[0] === "merge-base"
          ? { code: 1, stdout: `${head}\n`, stderr: "no merge base" }
          : undefined,
    );
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("review 4896: a base directory that cannot be read as a directory is infrastructure, not a verdict", async () => {
  // The check runs in rust/crate. The tip replaces rust/ with a file, so
  // stat(<tree>/rust/crate) fails with ENOTDIR, not NotFound; the head's fork
  // point (M0) has the directory and passes.
  const nested: CiCargoCheck = {
    ...CLIPPY_CHECK,
    workingDirectory: "rust/crate",
  };
  const { root, clone, stdin } = await makeRepoWithFiles({
    "rust/crate/Cargo.toml": '[package]\nname = "demo"\n',
    "rust/crate/src/lib.rs": "pub fn f() {}\n",
  });
  try {
    const green = await git(clone, "rev-parse", "HEAD");
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await git(clone, "rm", "-rq", "rust");
    await Deno.writeTextFile(`${clone}/rust`, "now a file\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "M1: rust is a file");
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await git(clone, "reset", "-q", "--hard", green);
    await Deno.writeTextFile(`${clone}/rust/crate/src/b.rs`, "// repair\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "repair");
    const head = await git(clone, "rev-parse", "HEAD");
    await git(clone, "update-ref", "refs/remotes/origin/main", green);
    const seen = { baseCwds: [] as string[] };
    const result = await runPrePushGate({
      cwd: clone,
      stdin: stdin.replaceAll(green, head),
      preFlightCommands: [],
      runner: lintRunner({ code: 0, stderr: "" }, seen),
      findCiCargo: () => Promise.resolve(scanOf(nested)),
      compareRef: "origin/main",
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---- deno test: targeted unit tests of changed files (Issue #4930) ---------

const UNIT_TRACKED = [
  "worker/deno/deno.json",
  "worker/deno/lib/foo.ts",
  "worker/deno/tests/foo_test.ts",
];

/** The `deno test` commands planned for a change, with no other checks. */
function denoTestCommands(
  changed: string[],
  tracked: string[],
  denoUnitTestRoots?: string[],
): string[] {
  const result = planChangedFileChecks(changed, tracked, {
    repoRoot: "/r",
    markdownlintBinary: null,
    denoUnitTestRoots,
  });
  assert(result.ok);
  return result.value
    .filter((c) => c.label.startsWith("deno test"))
    .map((c) => c.command);
}

Deno.test("planChangedFileChecks: a changed source runs its same-named tracked test via test:unit (#4930)", () => {
  const result = planChangedFileChecks(
    ["worker/deno/lib/foo.ts"],
    UNIT_TRACKED,
    {
      repoRoot: "/r",
      markdownlintBinary: null,
      denoUnitTestRoots: ["worker/deno"],
    },
  );
  assert(result.ok);
  assertEquals(result.value.map((c) => c.label), [
    "deno fmt (worker/deno)",
    "deno lint (worker/deno)",
    "deno test (worker/deno)",
  ]);
  assertEquals(result.value[2], {
    label: "deno test (worker/deno)",
    cwd: "/r/worker/deno",
    command: "deno task test:unit 'tests/foo_test.ts'",
    denoTestRoot: "worker/deno",
  });
});

Deno.test("planChangedFileChecks: a full-suite root runs test:unit with no file list (PR #5034 review)", () => {
  const result = planChangedFileChecks(
    ["worker/deno/lib/foo.ts"],
    UNIT_TRACKED,
    {
      repoRoot: "/r",
      markdownlintBinary: null,
      denoUnitTestRoots: ["worker/deno"],
      denoFullUnitRoots: ["worker/deno"],
    },
  );
  assert(result.ok);
  assertEquals(result.value.filter((c) => c.label.startsWith("deno test")), [{
    label: "deno test (worker/deno)",
    cwd: "/r/worker/deno",
    command: "deno task test:unit",
    denoTestRoot: "worker/deno",
  }]);
  // A root not marked full keeps its selected list.
  const selected = planChangedFileChecks(
    ["worker/deno/lib/foo.ts"],
    UNIT_TRACKED,
    {
      repoRoot: "/r",
      markdownlintBinary: null,
      denoUnitTestRoots: ["worker/deno"],
      denoFullUnitRoots: ["other"],
    },
  );
  assert(selected.ok);
  assertEquals(
    selected.value.filter((c) => c.label.startsWith("deno test")).map((c) =>
      c.command
    ),
    ["deno task test:unit 'tests/foo_test.ts'"],
  );
});

Deno.test("planChangedFileChecks: changed tests and sources map to one sorted, deduplicated test:unit list (#4930)", () => {
  const tracked = [...UNIT_TRACKED, "worker/deno/tests/bar_test.ts"];
  assertEquals(
    denoTestCommands(
      [
        "worker/deno/lib/foo.ts",
        "worker/deno/tests/foo_test.ts",
        "worker/deno/tests/bar_test.ts",
      ],
      tracked,
      ["worker/deno"],
    ),
    ["deno task test:unit 'tests/bar_test.ts' 'tests/foo_test.ts'"],
  );
  assertEquals(
    denoTestCommands(["worker/deno/tests/foo_test.ts"], UNIT_TRACKED, [
      "worker/deno",
    ]),
    ["deno task test:unit 'tests/foo_test.ts'"],
  );
});

Deno.test("planChangedFileChecks: no deno test check for an unlisted root, an untested source, a deleted test or docs (#4930)", () => {
  // Root not in denoUnitTestRoots (and none passed at all).
  assertEquals(denoTestCommands(["worker/deno/lib/foo.ts"], UNIT_TRACKED), []);
  assertEquals(
    denoTestCommands(["worker/deno/lib/foo.ts"], UNIT_TRACKED, ["other"]),
    [],
  );
  // Changed source with no tracked same-named test.
  assertEquals(
    denoTestCommands(["worker/deno/lib/bar.ts"], UNIT_TRACKED, ["worker/deno"]),
    [],
  );
  // Changed test that is no longer tracked (deleted).
  assertEquals(
    denoTestCommands(
      ["worker/deno/tests/foo_test.ts"],
      ["worker/deno/deno.json", "worker/deno/lib/foo.ts"],
      ["worker/deno"],
    ),
    [],
  );
  // Markdown-only change.
  assertEquals(
    denoTestCommands(["worker/deno/README.md"], UNIT_TRACKED, ["worker/deno"]),
    [],
  );
});

Deno.test("loadDenoUnitTestRoots: a root counts only when its config defines test:unit (#4930)", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-unit-roots-" });
  try {
    const write = async (dir: string, name: string, text: string) => {
      await Deno.mkdir(`${root}/${dir}`, { recursive: true });
      await Deno.writeTextFile(`${root}/${dir}/${name}`, text);
    };
    await write(
      "runs",
      "deno.json",
      JSON.stringify({ tasks: { "test:unit": "x" } }),
    );
    await write(
      "no-task",
      "deno.json",
      JSON.stringify({ tasks: { test: "x" } }),
    );
    await write("broken", "deno.json", "{ not json");
    // Valid JSON that is not a config object with a `tasks` object holding it.
    await write("null-doc", "deno.json", "null");
    await write("array-doc", "deno.json", "[]");
    await write("no-tasks", "deno.json", "{}");
    await write("null-tasks", "deno.json", '{ "tasks": null }');
    await write("array-tasks", "deno.json", '{ "tasks": [] }');
    await write("string-tasks", "deno.json", '{ "tasks": "test:unit" }');
    await write(
      "jsonc",
      "deno.jsonc",
      '{\n  // JSONC comment\n  "tasks": { "test:unit": "x" }\n}\n',
    );
    // deno.json is preferred, so a test:unit only in deno.jsonc does not count.
    await write("prefers-json", "deno.json", JSON.stringify({ tasks: {} }));
    await write(
      "prefers-json",
      "deno.jsonc",
      '{ "tasks": { "test:unit": "x" } }\n',
    );
    const tracked = [
      "runs/deno.json",
      "no-task/deno.json",
      "null-doc/deno.json",
      "no-tasks/deno.json",
      "null-tasks/deno.json",
      "jsonc/deno.jsonc",
      "prefers-json/deno.json",
      "prefers-json/deno.jsonc",
      "unreadable/deno.json",
    ];
    assertEquals(await loadDenoUnitTestRoots(root, tracked), ["jsonc", "runs"]);
    for (const dir of ["broken", "array-doc", "array-tasks", "string-tasks"]) {
      await assertRejects(
        () => loadDenoUnitTestRoots(root, [`${dir}/deno.json`]),
        Error,
        dir.endsWith("tasks")
          ? `cannot read task definitions in ${dir}/deno.json; unit tests were not checked`
          : `cannot parse ${dir}/deno.json; unit tests were not checked`,
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a changed test runs the repo's test:unit task, and its failure blocks the push (#4930)", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    // Drop the root deno.json so the nested worker/deno root is the outermost.
    await git(clone, "rm", "-q", "deno.json");
    await Deno.mkdir(`${clone}/worker/deno/lib`, { recursive: true });
    await Deno.mkdir(`${clone}/worker/deno/tests`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/worker/deno/deno.json`,
      JSON.stringify({
        tasks: { "test:unit": "deno run unit_test_runner.ts" },
      }) +
        "\n",
    );
    // The config is already on the remote, so only the tests below are pushed.
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "test:unit task");
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.writeTextFile(
      `${clone}/worker/deno/lib/foo.ts`,
      "export const x = 1;\n",
    );
    await Deno.writeTextFile(
      `${clone}/worker/deno/tests/foo_test.ts`,
      "export {};\n",
    );
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "source, test and test:unit task");
    const stdin = prePushInput(await git(clone, "rev-parse", "HEAD"));
    const command = "deno task test:unit 'tests/foo_test.ts'";
    const ran: Array<{ command: string; cwd: string | undefined }> = [];
    const runnerFor =
      (failUnit: boolean): PreFlightRunner => (cmd, options) => {
        ran.push({ command: cmd, cwd: options.cwd });
        const failed = failUnit && cmd === command;
        return Promise.resolve({
          started: true,
          code: failed ? 1 : 0,
          stdout: "",
          stderr: failed ? "boom" : "",
        });
      };

    const passed = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: runnerFor(false),
    });
    assert(passed.ok, passed.ok ? "" : passed.error.message);
    assert(passed.value.checksRun.includes(command));
    assertEquals(
      ran.find((r) => r.command === command)?.cwd,
      `${clone}/worker/deno`,
    );

    const blocked = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: runnerFor(true),
    });
    assert(!blocked.ok);
    assertInstanceOf(blocked.error, PreFlightGateError);
    assertEquals(blocked.error.command, command);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("planChangedFileChecks: only a tests/ file ending _test.ts is a test, and only a non-test .ts source outside tests/ maps to a sibling (#4930)", () => {
  const tracked = [
    ...UNIT_TRACKED,
    "worker/deno/lib/x_test.ts",
    "worker/deno/tests/x_test_test.ts",
    "worker/deno/tests/helper.ts",
    "worker/deno/tests/helper_test.ts",
  ];
  const roots = ["worker/deno"];
  // `_test.ts` outside tests/ is not a test to run, nor a source for a sibling.
  assertEquals(
    denoTestCommands(["worker/deno/lib/x_test.ts"], tracked, roots),
    [],
  );
  // A tests/ helper is not a test, and tests/ files map to no sibling.
  assertEquals(
    denoTestCommands(["worker/deno/tests/helper.ts"], tracked, roots),
    [],
  );
  // A non-.ts file maps to no sibling.
  assertEquals(
    denoTestCommands(["worker/deno/lib/foo.md"], tracked, roots),
    [],
  );
  assertEquals(
    denoTestCommands(["worker/deno/lib/foo.js"], tracked, roots),
    [],
  );
});

Deno.test("planChangedFileChecks: referenced tests run beside the changed ones, only while tracked (#4930)", () => {
  const tracked = [...UNIT_TRACKED, "worker/deno/tests/docs_test.ts"];
  const plan = (referenced: Record<string, string[]>, changed: string[]) => {
    const result = planChangedFileChecks(changed, tracked, {
      repoRoot: "/r",
      markdownlintBinary: null,
      denoUnitTestRoots: ["worker/deno"],
      denoReferencedTests: referenced,
    });
    assert(result.ok);
    return result.value.filter((c) => c.label.startsWith("deno test"))
      .map((c) => c.command);
  };
  // A docs-only change still runs the test that reads it.
  assertEquals(
    plan({ "worker/deno": ["tests/docs_test.ts"] }, ["docs/A.md"]),
    ["deno task test:unit 'tests/docs_test.ts'"],
  );
  // Merged, sorted and deduplicated with the same-named sibling.
  assertEquals(
    plan({ "worker/deno": ["tests/foo_test.ts", "tests/docs_test.ts"] }, [
      "worker/deno/lib/foo.ts",
    ]),
    ["deno task test:unit 'tests/docs_test.ts' 'tests/foo_test.ts'"],
  );
  // An untracked referenced test is not run; other roots' lists are ignored.
  assertEquals(
    plan({ "worker/deno": ["tests/gone_test.ts"] }, ["docs/A.md"]),
    [],
  );
  assertEquals(plan({ other: ["tests/docs_test.ts"] }, ["docs/A.md"]), []);
});

Deno.test("loadReferencedUnitTests: a test naming a changed source, doc or prompt is selected whatever its file name (#4930)", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-unit-refs-" });
  try {
    const write = async (path: string, text: string) => {
      await Deno.mkdir(`${root}/${path.slice(0, path.lastIndexOf("/"))}`, {
        recursive: true,
      });
      await Deno.writeTextFile(`${root}/${path}`, text);
    };
    const tests = {
      importsSource: 'import "../lib/pre_gate.ts";',
      readsDoc: 'await readRepoDoc("docs/CONFIG.md");',
      readsPromptByTemplate: "await read(`prompts/${family}/prompt.md`);",
      readsAmbiguousByPath: 'read("prompts/a/prompt.md")',
      unrelated: 'import "../lib/other.ts"; // a/prompt.md is not this one',
      alsoChanged: 'import "../lib/pre_gate.ts";',
      // Only the bare base name, which is unique among the tracked files.
      namesBareBase: 'const file = "pre_gate.ts";',
      // Reaches pre_gate.ts only through lib/wrapper.ts, and a doc only through
      // a tests/support helper that names it.
      viaWrapper: 'import "../lib/wrapper.ts";',
      readsDeleted: 'import "../lib/deleted_gate.ts";',
      listsDocs: 'for await (const e of Deno.readDir("docs/")) e;',
      viaHelper: 'import "./support/docs.ts";',
      // The source only quotes the doc in a message; it does not read it.
      viaQuotingSource: 'import "../lib/quotes.ts";',
      // A directory template names no one source: only non-.ts files get it.
      readsLibByTemplate: "read(`worker/deno/lib/${name}`)",
    };
    const tracked = [
      "worker/deno/deno.json",
      "worker/deno/lib/pre_gate.ts",
      "worker/deno/lib/other.ts",
      "docs/CONFIG.md",
      "prompts/a/prompt.md",
      "prompts/b/prompt.md",
      "worker/deno/tests/gone_test.ts",
      "worker/deno/tests/notes.md",
      "elsewhere/tests/outside_test.ts",
    ];
    for (const [name, text] of Object.entries(tests)) {
      tracked.push(`worker/deno/tests/${name}_test.ts`);
      await write(`worker/deno/tests/${name}_test.ts`, text);
    }
    await write("worker/deno/lib/wrapper.ts", 'export * from "./pre_gate.ts";');
    await write(
      "worker/deno/lib/pre_gate.ts",
      'import "./wrapper.ts"; // cycle',
    );
    await write("worker/deno/tests/support/docs.ts", 'read("docs/CONFIG.md");');
    await write("worker/deno/lib/quotes.ts", 'msg("see docs/CONFIG.md");');
    tracked.push(
      "worker/deno/lib/quotes.ts",
      "worker/deno/lib/wrapper.ts",
      "worker/deno/tests/support/docs.ts",
    );
    await write(
      "elsewhere/tests/outside_test.ts",
      'import "../lib/pre_gate.ts";',
    );
    const load = async (changed: string[]) => {
      const found = await loadReferencedUnitTests(
        root,
        tracked,
        changed,
        ["worker/deno"],
      );
      return Object.fromEntries(
        Object.entries(found).map(([dir, files]) => [dir, files.sort()]),
      );
    };

    assertEquals(await load(["worker/deno/lib/pre_gate.ts"]), {
      "worker/deno": [
        "tests/alsoChanged_test.ts",
        "tests/importsSource_test.ts",
        "tests/namesBareBase_test.ts",
        "tests/viaWrapper_test.ts",
      ],
    });
    assertEquals(await load(["docs/CONFIG.md"]), {
      "worker/deno": [
        "tests/listsDocs_test.ts",
        "tests/readsDoc_test.ts",
        "tests/viaHelper_test.ts",
      ],
    });
    // `prompt.md` is not unique: a path or a templated prompts/ dir names it.
    assertEquals(await load(["prompts/b/prompt.md"]), {
      "worker/deno": ["tests/readsPromptByTemplate_test.ts"],
    });
    assertEquals(await load(["prompts/a/prompt.md"]), {
      "worker/deno": [
        "tests/readsAmbiguousByPath_test.ts",
        "tests/readsPromptByTemplate_test.ts",
        "tests/unrelated_test.ts",
      ],
    });
    // A changed test is not listed again; a changed test alone selects none.
    assertEquals(
      await load([
        "worker/deno/lib/pre_gate.ts",
        "worker/deno/tests/alsoChanged_test.ts",
      ]),
      {
        "worker/deno": [
          "tests/importsSource_test.ts",
          "tests/namesBareBase_test.ts",
          "tests/viaWrapper_test.ts",
        ],
      },
    );
    assertEquals(await load(["worker/deno/tests/readsDoc_test.ts"]), {});
    assertEquals(await load([]), {});
    // A deleted source still selects the tests that name it.
    assertEquals(await load(["worker/deno/lib/deleted_gate.ts"]), {
      "worker/deno": ["tests/readsDeleted_test.ts"],
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a changed doc runs the differently named test that reads it (#4930)", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await git(clone, "rm", "-q", "deno.json");
    await Deno.mkdir(`${clone}/worker/deno/tests`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/worker/deno/deno.json`,
      JSON.stringify({ tasks: { "test:unit": "x" } }) + "\n",
    );
    await Deno.writeTextFile(
      `${clone}/worker/deno/tests/doc_drift_test.ts`,
      'await Deno.readTextFile("../../docs/GUIDE.md");\n',
    );
    await Deno.writeTextFile(
      `${clone}/worker/deno/tests/other_test.ts`,
      "export {};\n",
    );
    await Deno.mkdir(`${clone}/docs`, { recursive: true });
    await Deno.writeTextFile(`${clone}/docs/GUIDE.md`, "# Guide\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "base docs and tests");
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.writeTextFile(`${clone}/docs/GUIDE.md`, "# Guide\n\nMore.\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "edit the guide");
    const stdin = prePushInput(await git(clone, "rev-parse", "HEAD"));
    const ran: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      ...stubShellcheck(),
      findMarkdownlint: () => Promise.resolve("/fake/mdl"),
      runner: (cmd) => {
        ran.push(cmd);
        return Promise.resolve({
          started: true,
          code: 0,
          stdout: "",
          stderr: "",
        });
      },
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(
      ran.includes("deno task test:unit 'tests/doc_drift_test.ts'"),
      ran.join("\n"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("planChangedFileChecks: a changed integration suite is not passed to the unit runner (#4930)", () => {
  const integration = "tests/shellcheck_gate_integration_test.ts";
  const tracked = [
    ...UNIT_TRACKED,
    `worker/deno/${integration}`,
  ];
  assertEquals(
    denoTestCommands([`worker/deno/${integration}`], tracked, ["worker/deno"]),
    [],
  );
  assertEquals(
    denoTestCommands(
      [`worker/deno/${integration}`, "worker/deno/tests/foo_test.ts"],
      tracked,
      ["worker/deno"],
    ),
    ["deno task test:unit 'tests/foo_test.ts'"],
  );
});

Deno.test("runPrePushGate: a deleted source runs the differently named test that imports it (#4930)", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await git(clone, "rm", "-q", "deno.json");
    await Deno.mkdir(`${clone}/worker/deno/tests`, { recursive: true });
    await Deno.mkdir(`${clone}/worker/deno/lib`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/worker/deno/deno.json`,
      JSON.stringify({ tasks: { "test:unit": "x" } }) + "\n",
    );
    await Deno.writeTextFile(`${clone}/worker/deno/lib/old.ts`, "export {};\n");
    await Deno.writeTextFile(
      `${clone}/worker/deno/tests/uses_old_test.ts`,
      'import "../lib/old.ts";\n',
    );
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "base source and test");
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await git(clone, "rm", "-q", "worker/deno/lib/old.ts");
    await git(clone, "commit", "-qm", "delete the source");
    const stdin = prePushInput(await git(clone, "rev-parse", "HEAD"));
    const ran: string[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: (cmd) => {
        ran.push(cmd);
        return Promise.resolve({
          started: true,
          code: 0,
          stdout: "",
          stderr: "",
        });
      },
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(
      ran.includes("deno task test:unit 'tests/uses_old_test.ts'"),
      ran.join("\n"),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("loadReferencedUnitTests: literal prompt loaders select their tests (PR #5034 review)", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/worker/deno/tests`, { recursive: true });
    const tracked = [
      "worker/deno/deno.json",
      "prompts/issue/prompt.md",
      "prompts/quorum_judge/prompt.md",
    ];
    for (
      const [name, source] of Object.entries({
        issue:
          'await loadPrompt("issue", new URL("../../../prompts", import.meta.url).pathname);',
        judge: "await loadPrompt(\n  'quorum_judge', PROMPTS_DIR);",
        other: 'await loadPrompt("coding_guidelines", PROMPTS_DIR);',
      })
    ) {
      const path = `worker/deno/tests/${name}_test.ts`;
      tracked.push(path);
      await Deno.writeTextFile(`${root}/${path}`, source);
    }
    for (
      const [type, name] of [["issue", "issue"], ["quorum_judge", "judge"]]
    ) {
      assertEquals(
        await loadReferencedUnitTests(root, tracked, [
          `prompts/${type}/prompt.md`,
        ], ["worker/deno"]),
        { "worker/deno": [`tests/${name}_test.ts`] },
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: repair pushes enforce unit tests and markdownlint (PR #5034 review)", async () => {
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "rm", "-q", "deno.json");
    await Deno.mkdir(`${clone}/worker/deno/lib`, { recursive: true });
    await Deno.mkdir(`${clone}/worker/deno/tests`, { recursive: true });
    await Deno.writeTextFile(
      `${clone}/worker/deno/deno.json`,
      JSON.stringify({ tasks: { "test:unit": "x" } }),
    );
    await Deno.writeTextFile(
      `${clone}/worker/deno/lib/foo.ts`,
      "export const foo = 1;\n",
    );
    await Deno.writeTextFile(
      `${clone}/worker/deno/tests/foo_test.ts`,
      "export {};\n",
    );
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "test baseline");
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.writeTextFile(
      `${clone}/worker/deno/lib/foo.ts`,
      "export const foo = 2;\n",
    );
    await Deno.writeTextFile(`${clone}/README.md`, "# Changed\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "repair source and docs");
    const stdin = prePushInput(await git(clone, "rev-parse", "HEAD"));
    const unit = "deno task test:unit 'tests/foo_test.ts'";
    // Both repair specs: shellcheckOnly, and the CI-fix and PR-feedback
    // repairs' ciCargoOnly (PR #5034, merged with Issue #4630).
    const modes = [{ shellcheckOnly: true }, { ciCargoOnly: true }];
    for (const mode of modes) {
      for (const failure of ["unit", "markdown", "none"]) {
        const ran: string[] = [];
        const result = await runPrePushGate({
          cwd: clone,
          stdin,
          preFlightCommands: [],
          ...mode,
          ...stubShellcheck(),
          findMarkdownlint: () => Promise.resolve("/fake/mdl"),
          runner: (command) => {
            ran.push(command);
            const fails = failure === "unit"
              ? command === unit
              : failure === "markdown" && command.includes("/fake/mdl");
            return Promise.resolve({
              started: true,
              code: fails ? 1 : 0,
              stdout: "",
              stderr: fails ? "regression" : "",
            });
          },
        });
        assertEquals(result.ok, failure === "none", ran.join("\n"));
        assert(ran.includes(unit), "repair must run affected unit tests");
        if (failure !== "unit") {
          assert(
            ran.some((c) => c.includes("/fake/mdl")),
            "repair must run markdownlint",
          );
        }
        assertEquals(
          ran.some((c) =>
            c.startsWith("deno fmt") || c.startsWith("deno lint")
          ),
          false,
          "retain the repair formatter policy",
        );
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const UNIT_CMD = "deno task test:unit 'tests/foo_test.ts'";
const FOO_FAILURE =
  "FAILURES\n\nfoo works => ./tests/foo_test.ts:3:6\n\nFAILED | 0 passed | 1 failed\n";

/**
 * A repo whose pushed base holds a deno root at worker/deno with a `foo`
 * source and test, then one local commit made by `edit`.
 */
async function makeUnitTestRepo(
  edit: (clone: string) => Promise<void>,
): Promise<{ root: string; clone: string; stdin: string }> {
  const { root, clone } = await makeRepoWithDocCommit();
  await git(clone, "rm", "-q", "deno.json");
  await Deno.mkdir(`${clone}/worker/deno/lib`, { recursive: true });
  await Deno.mkdir(`${clone}/worker/deno/tests`, { recursive: true });
  await Deno.writeTextFile(
    `${clone}/worker/deno/deno.json`,
    JSON.stringify({ tasks: { "test:unit": "x" } }),
  );
  await Deno.writeTextFile(
    `${clone}/worker/deno/lib/foo.ts`,
    "export const foo = 1;\n",
  );
  await Deno.writeTextFile(
    `${clone}/worker/deno/tests/foo_test.ts`,
    "export {};\n",
  );
  await git(clone, "add", "-A");
  await git(clone, "commit", "-qm", "unit-test base");
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await edit(clone);
  await git(clone, "add", "-A");
  await git(clone, "commit", "-qm", "push under test");
  return {
    root,
    clone,
    stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
  };
}

const editFoo = (clone: string) =>
  Deno.writeTextFile(
    `${clone}/worker/deno/lib/foo.ts`,
    "export const foo = 2;\n",
  );

/**
 * Whether a checkout is the pushed head (`editFoo` writes `foo = 2`, a repair `foo = 3`) rather
 * than the commit the push forked from (`foo = 1`): a runner answers by what
 * the checkout holds, not by where it sits.
 */
const atHead = (cwd: string | undefined) =>
  !Deno.readTextFileSync(`${cwd}/lib/foo.ts`).includes("= 1");

/** Run the gate; `unit` answers the deno test command in the checkout it is given. */
async function gateWithUnitRunner(
  clone: string,
  stdin: string,
  unit: (cwd: string | undefined, command: string) => {
    code: number;
    stdout?: string;
    stderr?: string;
  },
  extra: { baselineBranch?: string } = {},
) {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
  try {
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      ...extra,
      ...stubShellcheck(),
      runner: (command, options) => {
        if (!command.startsWith("deno task test:unit")) {
          return Promise.resolve({
            started: true,
            code: 0,
            stdout: "",
            stderr: "",
          });
        }
        const answer = unit(options.cwd, command);
        return Promise.resolve({
          started: true,
          stdout: "",
          stderr: "",
          ...answer,
        });
      },
    });
    return { result, warnings };
  } finally {
    console.warn = realWarn;
  }
}

Deno.test("runPrePushGate: a test red the same way at the fork is a warning, not a block (PR #5034 review)", async () => {
  const { root, clone, stdin } = await makeUnitTestRepo(editFoo);
  try {
    // Red at the head and red at the fork (foo = 1) alike.
    const { result, warnings } = await gateWithUnitRunner(
      clone,
      stdin,
      () => ({ code: 1, stderr: FOO_FAILURE }),
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value.checksRun.includes(UNIT_CMD), false);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "[PRE_PUSH_WARNING] deno test");
    assertStringIncludes(warnings[0]!, "foo works => ./tests/foo_test.ts");
    // The throwaway worktree is gone.
    assertEquals(
      (await git(clone, "worktree", "list")).split("\n").length,
      1,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a failure the fork does not share still blocks (PR #5034 review)", async () => {
  const { root, clone, stdin } = await makeUnitTestRepo(editFoo);
  try {
    // Control: the test is red at the base too and the push is waved through.
    const control = await gateWithUnitRunner(
      clone,
      stdin,
      () => ({ code: 1, stderr: FOO_FAILURE }),
    );
    assert(control.result.ok);
    // The base passes, so the push broke the test.
    const fixedAtBase = await gateWithUnitRunner(
      clone,
      stdin,
      (cwd) => atHead(cwd) ? { code: 1, stderr: FOO_FAILURE } : { code: 0 },
    );
    assert(!fixedAtBase.result.ok);
    assertInstanceOf(fixedAtBase.result.error, PreFlightGateError);
    assertEquals(fixedAtBase.warnings, []);
    // The base fails a different test of the same file: the push's own
    // failure is not covered by it.
    const otherTest = await gateWithUnitRunner(
      clone,
      stdin,
      (cwd) =>
        atHead(cwd)
          ? {
            code: 1,
            stderr: FOO_FAILURE + "foo also works => ./tests/foo_test.ts:9:6\n",
          }
          : { code: 1, stderr: FOO_FAILURE },
    );
    assert(!otherTest.result.ok);
    assertInstanceOf(otherTest.result.error, PreFlightGateError);
    // A failure that names no test cannot be compared with the base.
    const unnamed = await gateWithUnitRunner(
      clone,
      stdin,
      () => ({ code: 1, stderr: "boom" }),
    );
    assert(!unnamed.result.ok);
    assertInstanceOf(unnamed.result.error, PreFlightGateError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a module that fails outside a test blocks even when every named failure is red at the fork (PR #5034 review)", async () => {
  const { root, clone, stdin } = await makeUnitTestRepo(editFoo);
  try {
    // Control: the named failure alone is red at the fork and waved through.
    const control = await gateWithUnitRunner(
      clone,
      stdin,
      () => ({ code: 1, stderr: FOO_FAILURE }),
    );
    assert(control.result.ok);
    assertEquals(control.warnings.length, 1);
    // The push also broke a module's link, which deno reports unnamed.
    const mixed = await gateWithUnitRunner(clone, stdin, (cwd) => ({
      code: 1,
      stderr: atHead(cwd)
        ? FOO_FAILURE + "./tests/b_test.ts (uncaught error)\n"
        : FOO_FAILURE,
    }));
    assert(!mixed.result.ok);
    assertInstanceOf(mixed.result.error, PreFlightGateError);
    assertEquals(mixed.warnings, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a serial pass the runner skipped after a base-red parallel failure is still run and judged (PR #5034 review)", async () => {
  const { root, clone, stdin } = await makeUnitTestRepo(editFoo);
  try {
    const parallelFailed = FOO_FAILURE + "=== parallel pass: FAILED in 1s\n";
    const serialRun =
      (serial: { code: number; stderr?: string }) =>
      (cwd: string | undefined, command: string) => {
        if (!atHead(cwd)) return { code: 1, stderr: FOO_FAILURE };
        return command.endsWith(" --serial-only")
          ? serial
          : { code: 1, stderr: parallelFailed };
      };
    // The serial pass passes: the base-red failure is only a warning.
    const clean = await gateWithUnitRunner(
      clone,
      stdin,
      serialRun({ code: 0 }),
    );
    assert(clean.result.ok, clean.result.ok ? "" : clean.result.error.message);
    assertEquals(clean.warnings.length, 1);
    // The serial pass fails a test the fork does not: the push is blocked.
    const broken = await gateWithUnitRunner(
      clone,
      stdin,
      serialRun({
        code: 1,
        stderr:
          "serial one => ./tests/foo_test.ts:9:6\n=== serial pass: FAILED in 1s\n",
      }),
    );
    assert(!broken.result.ok);
    assertInstanceOf(broken.result.error, PreFlightGateError);
    assertStringIncludes(broken.result.error.message, "serial one");
    assertEquals(broken.warnings, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a repair push compares a failing test at the PR's base, not at the PR's own previous head (PR #5034 review)", async () => {
  // The PR's previous head (foo = 2) is on origin and breaks foo's test; the
  // repair (foo = 3) leaves it red. The PR's base (foo = 1) is green.
  const { root, clone, stdin } = await makeUnitTestRepo(async (c) => {
    await Deno.writeTextFile(
      `${c}/worker/deno/lib/foo.ts`,
      "export const foo = 2;\n",
    );
    await git(c, "add", "-A");
    await git(c, "commit", "-qm", "the PR's previous head");
    await git(c, "push", "-q", "origin", "HEAD:refs/heads/pr");
    await Deno.writeTextFile(
      `${c}/worker/deno/lib/foo.ts`,
      "export const foo = 3;\n",
    );
  });
  try {
    const red = (cwd: string | undefined) =>
      Deno.readTextFileSync(`${cwd}/lib/foo.ts`).includes("= 1")
        ? { code: 0 }
        : { code: 1, stderr: FOO_FAILURE };
    // Without the PR's base the comparison is the previous head, where the
    // test is red too: the old behaviour waves the repair through.
    const wavedThrough = await gateWithUnitRunner(clone, stdin, red);
    assert(wavedThrough.result.ok);
    assertEquals(wavedThrough.warnings.length, 1);
    // With it the base is green, so the repair is blocked.
    const blocked = await gateWithUnitRunner(clone, stdin, red, {
      baselineBranch: "main",
    });
    assert(!blocked.result.ok);
    assertInstanceOf(blocked.result.error, PreFlightGateError);
    assertEquals(blocked.warnings, []);
    // A base ref that is not a ref makes the comparison unavailable: blocked.
    const unknown = await gateWithUnitRunner(clone, stdin, red, {
      baselineBranch: "no-such-branch",
    });
    assert(!unknown.result.ok);
    assertInstanceOf(unknown.result.error, PreFlightGateError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a repair push on a --depth=1 clone is deepened to find the PR's base, so a base-red test is a warning (PR #5034 review)", async () => {
  const { root, clone } = await makeUnitTestRepo(editFoo);
  try {
    // The PR branch is on origin; then the base moves on, so the shallow
    // clone's two tips share no commit it holds.
    await git(clone, "push", "-q", "origin", "HEAD:refs/heads/pr");
    const other = `${root}/other`;
    await git(root, "clone", "-q", `${root}/remote.git`, other);
    await Deno.writeTextFile(`${other}/NEWS.md`, "base moved on\n");
    await git(other, "add", "-A");
    await git(other, "commit", "-qm", "base moves on");
    await git(other, "push", "-q", "origin", "HEAD:main");
    const shallow = `${root}/shallow`;
    await git(
      root,
      "clone",
      "-q",
      "--depth=1",
      "--no-single-branch",
      "--branch",
      "pr",
      `file://${root}/remote.git`,
      shallow,
    );
    // Positive control: the clone is shallow and cannot find the merge-base yet.
    assertEquals(
      await git(shallow, "rev-parse", "--is-shallow-repository"),
      "true",
    );
    await assertRejects(() =>
      git(shallow, "merge-base", "origin/main", "HEAD")
    );
    // The repair itself: one new local commit on top of the PR's pushed head.
    await Deno.writeTextFile(
      `${shallow}/worker/deno/lib/foo.ts`,
      "export const foo = 3;\n",
    );
    await git(shallow, "add", "-A");
    await git(shallow, "commit", "-qm", "repair");
    const stdin = prePushInput(await git(shallow, "rev-parse", "HEAD"));
    const { result, warnings } = await gateWithUnitRunner(
      shallow,
      stdin,
      () => ({ code: 1, stderr: FOO_FAILURE }),
      { baselineBranch: "main" },
    );
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(warnings.length, 1);
    assertStringIncludes(warnings[0]!, "[PRE_PUSH_WARNING] deno test");
    assertEquals(
      (await git(shallow, "worktree", "list")).split("\n").length,
      1,
    );
    // The same clone with a base that passes still blocks: the deepened
    // fork is compared, not skipped.
    const fixedAtBase = await gateWithUnitRunner(
      shallow,
      stdin,
      (cwd) => atHead(cwd) ? { code: 1, stderr: FOO_FAILURE } : { code: 0 },
      { baselineBranch: "main" },
    );
    assert(!fixedAtBase.result.ok);
    assertInstanceOf(fixedAtBase.result.error, PreFlightGateError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a test file the push adds that fails is a block even when named like a base failure (PR #5034 review)", async () => {
  const { root, clone, stdin } = await makeUnitTestRepo(async (c) => {
    await Deno.writeTextFile(
      `${c}/worker/deno/tests/new_test.ts`,
      "export {};\n",
    );
  });
  try {
    const { result } = await gateWithUnitRunner(clone, stdin, (cwd) => ({
      code: 1,
      stderr: "new works => ./tests/new_test.ts:3:6\n",
      stdout: cwd ?? "",
    }));
    assert(!result.ok);
    assertInstanceOf(result.error, PreFlightGateError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("runPrePushGate: a module-fetch outage is infrastructure, a 404 and a test failure are verdicts (PR #5034 review)", async () => {
  const { root, clone, stdin } = await makeUnitTestRepo(editFoo);
  try {
    const outage =
      "error: JSR package manifest for '@std/assert' failed to load. Import 'https://jsr.io/@std/assert/meta.json' failed.\n    at file:///x/tests/foo_test.ts:1:8\n";
    const down = await gateWithUnitRunner(
      clone,
      stdin,
      () => ({ code: 1, stderr: outage }),
    );
    assert(!down.result.ok);
    assertInstanceOf(down.result.error, PrePushGateInfrastructureError);
    assertStringIncludes(down.result.error.message, "JSR package manifest");

    const transport = await gateWithUnitRunner(clone, stdin, () => ({
      code: 1,
      stderr:
        "error: Import 'https://example.com/x.ts' failed.\n    0: error sending request for url (https://example.com/x.ts)\n",
    }));
    assert(!transport.result.ok);
    assertInstanceOf(transport.result.error, PrePushGateInfrastructureError);

    // A missing package (404) is a real regression, not an outage.
    const missing = await gateWithUnitRunner(clone, stdin, () => ({
      code: 1,
      stderr: "error: JSR package not found: @std/nonexistent\n",
    }));
    assert(!missing.result.ok);
    assertInstanceOf(missing.result.error, PreFlightGateError);

    // A named test failure wins over a fetch line in the same output.
    const mixed = await gateWithUnitRunner(clone, stdin, (cwd) => ({
      code: 1,
      stderr: atHead(cwd) ? outage + FOO_FAILURE : "error: Test failed\n",
    }));
    assert(!mixed.result.ok);
    assertInstanceOf(mixed.result.error, PreFlightGateError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("needsFullUnitSuite: prompts, deno.json, deno.jsonc and deno.lock of the root only (PR #5034 review)", () => {
  assert(needsFullUnitSuite(["prompts/issue/prompt.md"], "worker/deno"));
  assert(needsFullUnitSuite(["worker/deno/prompts/x/prompt.md"], "."));
  assert(needsFullUnitSuite(["worker/deno/deno.lock"], "worker/deno"));
  assert(needsFullUnitSuite(["worker/deno/deno.json"], "worker/deno"));
  assert(needsFullUnitSuite(["worker/deno/deno.jsonc"], "worker/deno"));
  assert(needsFullUnitSuite(["deno.lock"], "."));
  assertEquals(needsFullUnitSuite(["web/deno.lock"], "worker/deno"), false);
  assertEquals(
    needsFullUnitSuite(["worker/deno/lib/deno.lock.ts"], "worker/deno"),
    false,
  );
  assertEquals(needsFullUnitSuite(["docs/prompts.md"], "worker/deno"), false);
  assertEquals(needsFullUnitSuite([], "worker/deno"), false);
});

Deno.test("runPrePushGate: a prompt or lock change runs the whole unit suite, reaching a builder-based reader (PR #5034 review)", async () => {
  for (
    const changed of [
      "prompts/issue/prompt.md",
      "worker/deno/deno.lock",
    ]
  ) {
    const { root, clone, stdin } = await makeUnitTestRepo(async (c) => {
      // The reader reaches the prompt through a builder: no token names it.
      await Deno.writeTextFile(
        `${c}/worker/deno/tests/builder_test.ts`,
        'import { buildIssuePrompt } from "../lib/foo.ts";\nbuildIssuePrompt();\n',
      );
      await git(c, "add", "-A");
      await git(c, "commit", "-qm", "builder reader");
      await git(c, "push", "-q", "origin", "HEAD:main");
      await Deno.mkdir(`${c}/${changed.replace(/\/[^/]+$/, "")}`, {
        recursive: true,
      });
      await Deno.writeTextFile(`${c}/${changed}`, "changed\n");
    });
    try {
      const ran: string[] = [];
      const result = await runPrePushGate({
        cwd: clone,
        stdin,
        preFlightCommands: [],
        ...stubShellcheck(),
        // The prompt change is Markdown: do not depend on the host's install.
        findMarkdownlint: () => Promise.resolve("/fake/mdl"),
        runner: (command) => {
          ran.push(command);
          return Promise.resolve({
            started: true,
            code: 0,
            stdout: "",
            stderr: "",
          });
        },
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      assert(
        result.value.checksRun.includes("deno task test:unit"),
        `${changed}: ${ran.join(" | ")}`,
      );
      assertEquals(
        ran.filter((c) => c.startsWith("deno task test:unit")),
        ["deno task test:unit"],
        "the whole suite replaces the selected list",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  }
});
