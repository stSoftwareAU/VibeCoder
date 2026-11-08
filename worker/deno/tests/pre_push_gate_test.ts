/**
 * Tests for the pre-push gate (Issue #3394).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertInstanceOf } from "@std/assert";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import {
  defaultPrePushGit,
  gateStagedShellcheck,
  listPushedFiles,
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
  PreFlightGateError,
  type PreFlightRunner,
} from "../lib/pre_flight_gate.ts";
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
    const staged = await gateStagedShellcheck(clone);
    assert(staged.ok, staged.ok ? "" : staged.error.message);
    assertEquals(staged.value.checksRun, []);
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

Deno.test("runPrePushGate: an indirect repository ShellCheck gate is not silently skipped", async () => {
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
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("delegates ShellCheck"));
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
