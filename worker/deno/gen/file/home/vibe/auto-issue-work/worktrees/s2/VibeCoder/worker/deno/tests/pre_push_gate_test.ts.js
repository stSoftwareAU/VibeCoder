/**
 * Tests for the pre-push gate (Issue #3394).
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */ import { assert, assertEquals, assertInstanceOf, assertStringIncludes } from "@std/assert";
import { WORKFLOW_SPECS } from "../lib/workflow_definitions.ts";
import { createRepoFormatterDeps, formatBranchChanges } from "../lib/repo_formatters.ts";
import { defaultPrePushGit, listPushedFiles, loadDenoUnitTestRoots, parsePrePushRefs, planChangedFileChecks, PrePushGateInfrastructureError, repoCiRunsCspell, repoShellcheckPolicy, runAffectedShellcheckChecks, runPrePushGate, workflowRunsCspell } from "../lib/pre_push_gate.ts";
import { PreFlightGateError } from "../lib/pre_flight_gate.ts";
import { STUB_SHELLCHECK_VERSION, stubShellcheck } from "./support/shellcheck_support.ts";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);
Deno.test("ShellCheck policy bounds workflow and delegated script reads", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  try {
    await Deno.mkdir(`${root}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${root}/outside`, SHELLCHECK_WORKFLOW(""));
    await Deno.symlink(`${root}/outside`, `${root}/${path}`);
    assertEquals(await repoShellcheckPolicy(root, [
      path
    ]), {
      ok: true,
      value: null
    });
    await Deno.remove(`${root}/${path}`);
    await Deno.writeTextFile(`${root}/${path}`, "x".repeat(1024 * 1024 + 1));
    assert(!(await repoShellcheckPolicy(root, [
      path
    ])).ok);
    await Deno.writeTextFile(`${root}/${path}`, "jobs:\n  lint:\n    steps:\n      - run: ./check.sh\n");
    await Deno.symlink(`${root}/outside`, `${root}/check.sh`);
    assert(!(await repoShellcheckPolicy(root, [
      path,
      "check.sh"
    ])).ok);
    await Deno.remove(`${root}/check.sh`);
    await Deno.writeTextFile(`${root}/check.sh`, "x".repeat(1024 * 1024 + 1));
    assert(!(await repoShellcheckPolicy(root, [
      path,
      "check.sh"
    ])).ok);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("unsupported ShellCheck policy ignores Dockerfile but blocks executable shell shebang", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  try {
    await Deno.mkdir(`${root}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${root}/${path}`, "jobs:\n  lint:\n    steps:\n      - uses: unknown/shellcheck@v1\n");
    await Deno.writeTextFile(`${root}/Dockerfile`, "FROM alpine\n");
    await Deno.writeTextFile(`${root}/script`, "#!/bin/bash\necho $1\n", {
      mode: 0o755
    });
    const tracked = [
      path,
      "Dockerfile",
      "script"
    ];
    assert((await runAffectedShellcheckChecks({
      cwd: root,
      changed: [
        "Dockerfile"
      ],
      tracked
    })).ok);
    assert(!(await runAffectedShellcheckChecks({
      cwd: root,
      changed: [
        "script"
      ],
      tracked
    })).ok);
    await Deno.remove(`${root}/script`);
    assert((await runAffectedShellcheckChecks({
      cwd: root,
      changed: [
        "script"
      ],
      tracked
    })).ok);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("parsePrePushRefs: valid line, blank lines ignored", ()=>{
  const result = parsePrePushRefs(`\nrefs/heads/m ${SHA_A} refs/heads/m ${SHA_B}\n\n`);
  assert(result.ok);
  assertEquals(result.value, [
    {
      localRef: "refs/heads/m",
      localSha: SHA_A,
      remoteRef: "refs/heads/m",
      remoteSha: SHA_B
    }
  ]);
});
Deno.test("parsePrePushRefs: deletes are dropped", ()=>{
  const result = parsePrePushRefs(`(delete) ${ZERO} refs/heads/gone ${SHA_B}\n`);
  assert(result.ok);
  assertEquals(result.value, []);
});
Deno.test("parsePrePushRefs: malformed input fails closed", ()=>{
  assert(!parsePrePushRefs("refs/heads/m abc refs/heads/m def").ok);
  assert(!parsePrePushRefs(`refs/heads/m ${SHA_A} refs/heads/m`).ok);
  assert(!parsePrePushRefs(`a ${SHA_A} b ${SHA_B} extra`).ok);
});
Deno.test("planChangedFileChecks: doc-only change plans fmt and markdownlint, no lint", ()=>{
  const result = planChangedFileChecks([
    "README.md"
  ], [
    "deno.json",
    ".markdownlint-cli2.jsonc",
    "README.md"
  ], {
    repoRoot: "/r",
    markdownlintBinary: "/r/node_modules/.bin/mdl"
  });
  assert(result.ok);
  const commands = result.value.map((c)=>c.command);
  assertEquals(commands, [
    "deno fmt --check --permit-no-files 'README.md'",
    "'/r/node_modules/.bin/mdl' 'README.md'"
  ]);
  assert(result.value.every((c)=>c.cwd === "/r"));
});
Deno.test("planChangedFileChecks: nested deno root uses its own cwd and relative paths", ()=>{
  const result = planChangedFileChecks([
    "sub/a.ts",
    "top.md"
  ], [
    "sub/deno.json",
    "sub/a.ts"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null
  });
  assert(result.ok);
  assertEquals(result.value.map((c)=>[
      c.cwd,
      c.command
    ]), [
    [
      "/r/sub",
      "deno fmt --check --permit-no-files 'a.ts'"
    ],
    [
      "/r/sub",
      "deno lint --permit-no-files 'a.ts'"
    ]
  ]);
});
Deno.test("planChangedFileChecks: cargo fmt when a .rs file changes", ()=>{
  const result = planChangedFileChecks([
    "crate/src/lib.rs"
  ], [
    "crate/Cargo.toml"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null
  });
  assert(result.ok);
  assertEquals(result.value.map((c)=>[
      c.cwd,
      c.command
    ]), [
    [
      "/r/crate",
      "cargo fmt --all --check"
    ]
  ]);
});
Deno.test("planChangedFileChecks: a Cargo root with no changed .rs file gets no cargo fmt", ()=>{
  const tracked = [
    "Cargo.toml",
    "src/lib.rs",
    "README.md"
  ];
  const opts = {
    repoRoot: "/r",
    markdownlintBinary: null
  };
  const untouched = planChangedFileChecks([
    "README.md"
  ], tracked, opts);
  assert(untouched.ok);
  assert(untouched.value.every((c)=>!c.command.includes("cargo")));
  const touched = planChangedFileChecks([
    "src/lib.rs"
  ], tracked, opts);
  assert(touched.ok);
  assert(touched.value.some((c)=>c.command === "cargo fmt --all --check"));
});
Deno.test("planChangedFileChecks: markdownlint configured but binary missing is an error", ()=>{
  const result = planChangedFileChecks([
    "a.md"
  ], [
    ".markdownlint-cli2.jsonc"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null
  });
  assert(!result.ok);
  assert(result.error.includes("could not be found"));
});
Deno.test("planChangedFileChecks: no markdownlint config means no markdownlint check", ()=>{
  const result = planChangedFileChecks([
    "a.md"
  ], [
    "deno.json"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null
  });
  assert(result.ok);
  assertEquals(result.value.length, 1);
  assert(result.value[0].command.startsWith("deno fmt"));
});
Deno.test("planChangedFileChecks: unquotable path is an error naming the file", ()=>{
  const name = `we'ird"name.ts`;
  const result = planChangedFileChecks([
    name
  ], [
    "deno.json"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null
  });
  assert(!result.ok);
  assert(result.error.includes("we'ird"));
});
Deno.test("planChangedFileChecks: files outside the deno fmt/lint include are not checked", ()=>{
  const denoScopes = {
    ".": {
      fmt: {
        include: [
          "src/"
        ]
      },
      lint: {
        include: [
          "src/"
        ]
      }
    }
  };
  const opts = {
    repoRoot: "/r",
    markdownlintBinary: null,
    denoScopes
  };
  const outOfScope = planChangedFileChecks([
    "README.md",
    "scripts/x.ts"
  ], [
    "deno.json",
    "README.md"
  ], opts);
  assert(outOfScope.ok);
  assertEquals(outOfScope.value, []);
  const mixed = planChangedFileChecks([
    "README.md",
    "src/a.ts"
  ], [
    "deno.json"
  ], opts);
  assert(mixed.ok);
  assertEquals(mixed.value.map((c)=>c.command), [
    "deno fmt --check --permit-no-files 'src/a.ts'",
    "deno lint --permit-no-files 'src/a.ts'"
  ]);
});
Deno.test("planChangedFileChecks: an include of the config directory still plans deno fmt and lint", ()=>{
  for (const entry of [
    ".",
    "./"
  ]){
    const result = planChangedFileChecks([
      "README.md",
      "src/a.ts"
    ], [
      "deno.json"
    ], {
      repoRoot: "/r",
      markdownlintBinary: null,
      denoScopes: {
        ".": {
          fmt: {
            include: [
              entry
            ]
          },
          lint: {
            include: [
              entry
            ]
          }
        }
      }
    });
    assert(result.ok);
    assertEquals(result.value.map((c)=>c.command), [
      "deno fmt --check --permit-no-files 'README.md' 'src/a.ts'",
      "deno lint --permit-no-files 'src/a.ts'"
    ]);
  }
});
Deno.test("planChangedFileChecks: a nested root filters against its own scope, relative to it", ()=>{
  const result = planChangedFileChecks([
    "worker/deno/lib/a.ts",
    "worker/deno/README.md"
  ], [
    "worker/deno/deno.json"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null,
    denoScopes: {
      "worker/deno": {
        fmt: {
          include: [
            "lib/"
          ]
        }
      }
    }
  });
  assert(result.ok);
  assertEquals(result.value.map((c)=>c.command), [
    "deno fmt --check --permit-no-files 'lib/a.ts'",
    "deno lint --permit-no-files 'lib/a.ts'"
  ]);
});
// ---- runPrePushGate against a real git repo --------------------------------
const GIT_ENV = [
  "-c",
  "user.email=t@e",
  "-c",
  "user.name=t"
];
async function git(cwd, ...args) {
  const out = await new Deno.Command("git", {
    args: [
      ...GIT_ENV,
      ...args
    ],
    cwd,
    stdout: "piped",
    stderr: "piped"
  }).output();
  if (out.code !== 0) {
    throw new Error(new TextDecoder().decode(out.stderr));
  }
  return new TextDecoder().decode(out.stdout).trim();
}
/** Bare remote + clone with a pushed initial commit, then one local doc commit. */ async function makeRepoWithDocCommit() {
  const root = await Deno.makeTempDir({
    prefix: "vibe-pp-gate-"
  });
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
    stdin: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`
  };
}
const SHELLCHECK_WORKFLOW = (flags, version = STUB_SHELLCHECK_VERSION)=>`jobs:\n  lint:\n    env:\n      SHELLCHECK_VERSION: "${version}"\n    steps:\n      - run: |\n          find . -name "*.sh" -type f -exec shellcheck ${flags} {} +\n`;
const SYNCED_SHELLCHECK_WORKFLOW = WORKFLOW_SPECS.find((spec)=>spec.id === "shellcheck").template;
Deno.test("ShellCheck discovers continued commands and refuses indirect invocations", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  try {
    await Deno.mkdir(`${root}/.github/workflows`, {
      recursive: true
    });
    const continued = SHELLCHECK_WORKFLOW("-e SC1091").replace("-type f -exec", "-type f \\\n          -exec");
    await Deno.writeTextFile(`${root}/${path}`, continued);
    const supported = await repoShellcheckPolicy(root, [
      path
    ]);
    assert(supported.ok && supported.value !== null);
    assertEquals(supported.value.flags, [
      "-e",
      "SC1091"
    ]);
    for (const command of [
      "docker run --rm koalaman/shellcheck:stable scripts/*.sh",
      "docker run --rm docker.io/koalaman/shellcheck:stable scripts/x.sh",
      "docker run --rm koalaman/shellcheck@sha256:abcdef scripts/x.sh",
      "docker container run --rm koalaman/shellcheck:stable scripts/x.sh",
      "bash -ec 'shellcheck scripts/x.sh'",
      "bash -e -c 'shellcheck scripts/x.sh'",
      "bash -c 'shellcheck scripts/*.sh'"
    ]){
      await Deno.writeTextFile(`${root}/${path}`, SHELLCHECK_WORKFLOW("").replace(/find .*$/m, command));
      const result = await repoShellcheckPolicy(root, [
        path
      ]);
      assert(!result.ok, command);
    }
    await Deno.writeTextFile(`${root}/check.sh`, "find . -name '*.sh' -type f \\\n -exec shellcheck {} +\n");
    await Deno.writeTextFile(`${root}/${path}`, "jobs:\n  lint:\n    steps:\n      - run: ./check.sh\n");
    const delegated = await repoShellcheckPolicy(root, [
      path,
      "check.sh"
    ]);
    assert(!delegated.ok);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("ShellCheck skips scripts under symlinked parents and missing directory paths", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${clone}/h`);
    await commitShellcheckFiles(clone, {
      "h/x.sh": "echo ok\n"
    });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.remove(`${clone}/h`, {
      recursive: true
    });
    await Deno.mkdir(`${root}/outside`);
    await Deno.writeTextFile(`${root}/outside/x.sh`, "echo $1\n");
    await Deno.symlink(`${root}/outside`, `${clone}/h`);
    const seen = [];
    const opts = {
      cwd: clone,
      changed: [
        "h/x.sh"
      ],
      tracked: [
        ".github/workflows/validate-scripts.yml",
        "h/x.sh"
      ],
      ...stubShellcheck(),
      runner: recordingRunner(()=>false, seen)
    };
    const checked = await runAffectedShellcheckChecks(opts);
    assert(checked.ok);
    assertEquals(seen, []);
    const rechecked = await runAffectedShellcheckChecks({
      ...opts,
      changed: [
        ".shellcheckrc"
      ]
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
      runner: recordingRunner(()=>false, seen)
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
      runner: recordingRunner(()=>false, seen)
    });
    assert(replaced.ok, replaced.ok ? "" : replaced.error.message);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("ShellCheck policy rejects inherited options for action and find", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  try {
    await Deno.mkdir(`${root}/.github/workflows`, {
      recursive: true
    });
    for (const body of [
      SYNCED_SHELLCHECK_WORKFLOW + "\nenv:\n  SHELLCHECK_OPTS: -e SC2086\n",
      SHELLCHECK_WORKFLOW("").replace("- run: |", "- env:\n          SHELLCHECK_OPTS: -e SC2086\n        run: |")
    ]){
      await Deno.writeTextFile(`${root}/${path}`, body);
      const result = await repoShellcheckPolicy(root, [
        path
      ]);
      assert(!result.ok);
      assert(result.error.includes("SHELLCHECK_OPTS"));
    }
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("ShellCheck action checks its scripts and skips symlinks on change and recheck", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.mkdir(`${clone}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${clone}/.github/workflows/check.yml`, SYNCED_SHELLCHECK_WORKFLOW);
    await Deno.writeTextFile(`${clone}/util.bash`, "echo $1\n");
    await Deno.writeTextFile(`${clone}/deploy`, "#!/usr/bin/env bash\necho $1\n", {
      mode: 0o755
    });
    await Deno.chmod(`${clone}/deploy`, 0o755);
    await Deno.writeTextFile(`${root}/outside`, "echo $1\n");
    await Deno.symlink(`${root}/outside`, `${clone}/x.sh`);
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "scripts");
    const tracked = [
      ".github/workflows/check.yml",
      "util.bash",
      "deploy",
      "x.sh"
    ];
    for (const changed of [
      [
        "util.bash",
        "deploy",
        "x.sh"
      ],
      [
        ".shellcheckrc"
      ]
    ]){
      const seen = [];
      const result = await runAffectedShellcheckChecks({
        cwd: clone,
        changed,
        tracked,
        ...stubShellcheck(),
        runner: recordingRunner(()=>false, seen)
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      assert(seen.some((c)=>c.includes("util.bash")));
      assert(seen.some((c)=>c.includes("deploy")));
      assert(!seen.some((c)=>c.includes("x.sh")));
    }
    const seen = [];
    const pushed = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner(()=>false, seen)
    });
    assert(pushed.ok, pushed.ok ? "" : pushed.error.message);
    assert(seen.some((c)=>c.includes("util.bash")));
    assert(seen.some((c)=>c.includes("deploy")));
    assert(!seen.some((c)=>c.includes("x.sh")));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate skips committed script symlinks on change and config recheck", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "real.sh": "#!/bin/sh\necho ok\n"
    });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.writeTextFile(`${root}/outside`, "echo $1\n");
    await Deno.symlink(`${root}/outside`, `${clone}/x.sh`);
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "symlink");
    for (const recheck of [
      false,
      true
    ]){
      if (recheck) {
        await git(clone, "push", "-q", "origin", "HEAD:main");
        await Deno.writeTextFile(`${clone}/.shellcheckrc`, "disable=SC2086\n");
        await git(clone, "add", "-A");
        await git(clone, "commit", "-qm", "config");
      }
      const seen = [];
      const result = await runPrePushGate({
        cwd: clone,
        stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
        preFlightCommands: [],
        ...stubShellcheck(),
        runner: recordingRunner(()=>false, seen)
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      assert(!seen.some((c)=>c.includes("x.sh")));
      if (recheck) assert(seen.some((c)=>c.includes("real.sh")));
    }
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("listPushedFiles: a merge lists the paths it resolved, never the files it brings in from the base (PR #4898 review)", async ()=>{
  const root = await Deno.makeTempDir({
    prefix: "vibe-pp-merge-"
  });
  try {
    await git(root, "init", "-q", "-b", "main");
    await Deno.writeTextFile(`${root}/c.txt`, "1\n");
    await Deno.writeTextFile(`${root}/deno.json`, "{}\n");
    await Deno.mkdir(`${root}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${root}/.github/workflows/check.yml`, SYNCED_SHELLCHECK_WORKFLOW);
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
    } catch  {
      conflicted = true;
    }
    assert(conflicted, "the fixture must conflict on c.txt");
    await Deno.writeTextFile(`${root}/c.txt`, "resolved\n");
    // A file only the merge commit introduces: no ordinary commit lists it, so
    // it appears solely when the merge's own diff is requested.
    await Deno.writeTextFile(`${root}/merge_only.sh`, "#!/bin/sh\necho ok\n");
    await git(root, "add", "-A");
    await git(root, "commit", "-qm", "merge main");
    const files = await listPushedFiles([
      {
        localRef: "HEAD",
        localSha: "HEAD",
        remoteRef: "x",
        remoteSha: "0"
      }
    ], root, defaultPrePushGit, "main");
    assert(files.ok);
    assertEquals(files.value, [
      "c.txt",
      "merge_only.sh",
      "own.sh",
      "own.ts"
    ]);
    const seen = [];
    const gate = await runPrePushGate({
      cwd: root,
      stdin: prePushInput(await git(root, "rev-parse", "HEAD")),
      baseRef: "main",
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner((command)=>command.includes("base_bad"), seen)
    });
    assert(gate.ok, gate.ok ? "" : gate.error.message);
    assert(seen.some((command)=>command.includes("own.sh")));
    assert(!seen.some((command)=>command.includes("base_bad")));
    const formatted = [];
    const deps = createRepoFormatterDeps();
    deps.runCommand = (command)=>{
      formatted.push(command.join(" "));
      return Promise.resolve({
        exitCode: 0,
        output: ""
      });
    };
    const result = await formatBranchChanges(root, "main", deps);
    assertEquals(result.gitError, undefined);
    assert(formatted.some((command)=>command.includes("own.ts")));
    assert(!formatted.some((command)=>command.includes("base_bad")));
    assertEquals(await Deno.readTextFile(`${root}/base_bad.ts`), "export const bad=1\n");
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("ShellCheck refuses an oversized configuration without reading it", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "real.sh": "#!/bin/sh\necho ok\n"
    });
    const config = await Deno.open(`${clone}/.shellcheckrc`, {
      write: true,
      create: true
    });
    try {
      await config.truncate(1024 * 1024 + 1);
    } finally{
      config.close();
    }
    const seen = [];
    const result = await runAffectedShellcheckChecks({
      cwd: clone,
      changed: [
        "real.sh"
      ],
      tracked: [
        ".github/workflows/validate-scripts.yml",
        "real.sh",
        ".shellcheckrc"
      ],
      ...stubShellcheck(),
      runner: recordingRunner(()=>false, seen)
    });
    assert(!result.ok);
    assertStringIncludes(result.error.message, "exceeds policy size limit");
    assertEquals(seen, []);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("ShellCheck refuses a symlinked configuration without reading its target", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "real.sh": "#!/bin/sh\necho ok\n"
    });
    await Deno.writeTextFile(`${root}/outside`, "disable=SC2086\n");
    await Deno.symlink(`${root}/outside`, `${clone}/.shellcheckrc`);
    const seen = [];
    const result = await runAffectedShellcheckChecks({
      cwd: clone,
      changed: [
        "real.sh"
      ],
      tracked: [
        ".github/workflows/validate-scripts.yml",
        "real.sh",
        ".shellcheckrc"
      ],
      ...stubShellcheck(),
      runner: recordingRunner(()=>false, seen)
    });
    assert(!result.ok);
    assert(result.error.message.includes("not a regular file"));
    assertEquals(seen, []);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("ShellCheck refuses a configuration below a symlinked directory", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "real.sh": "echo ok\n"
    }, "--rcfile h/shellcheckrc");
    await Deno.mkdir(`${root}/outside`);
    await Deno.writeTextFile(`${root}/outside/shellcheckrc`, "disable=SC2086\n");
    await Deno.symlink(`${root}/outside`, `${clone}/h`);
    const seen = [];
    const result = await runAffectedShellcheckChecks({
      cwd: clone,
      changed: [
        "real.sh"
      ],
      tracked: [
        ".github/workflows/validate-scripts.yml",
        "real.sh",
        "h/shellcheckrc"
      ],
      ...stubShellcheck(),
      runner: recordingRunner(()=>false, seen)
    });
    assert(!result.ok);
    assert(result.error.message.includes("not a regular file"));
    assertEquals(seen, []);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
async function commitShellcheckFiles(clone, files, flags = "-e SC1091 -e SC2034", version = STUB_SHELLCHECK_VERSION) {
  // Keep the unrelated doc commit on the remote so these fixtures need only
  // ShellCheck, as in the CI test shard which does not install markdownlint.
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await Deno.mkdir(`${clone}/.github/workflows`, {
    recursive: true
  });
  await Deno.writeTextFile(`${clone}/.github/workflows/validate-scripts.yml`, SHELLCHECK_WORKFLOW(flags, version));
  for (const [path, contents] of Object.entries(files)){
    await Deno.writeTextFile(`${clone}/${path}`, contents);
  }
  await git(clone, "add", "-A");
  await git(clone, "commit", "-qm", "add ShellCheck policy and scripts");
  return await git(clone, "rev-parse", "HEAD");
}
function prePushInput(tip) {
  return `refs/heads/main ${tip} refs/heads/main ${ZERO}\n`;
}
function recordingRunner(failWhen, seen) {
  return (command)=>{
    seen.push(command);
    return Promise.resolve({
      started: true,
      code: failWhen(command) ? 1 : 0,
      stdout: "",
      stderr: failWhen(command) ? "boom" : ""
    });
  };
}
Deno.test("listPushedFiles: only files introduced by unpushed commits", async ()=>{
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    const refs = parsePrePushRefs(stdin);
    assert(refs.ok);
    const files = await listPushedFiles(refs.value, clone, async (a, c)=>{
      const out = await new Deno.Command("git", {
        args: a,
        cwd: c,
        stdout: "piped",
        stderr: "piped"
      }).output();
      const d = new TextDecoder();
      return {
        code: out.code,
        stdout: d.decode(out.stdout),
        stderr: d.decode(out.stderr)
      };
    });
    assert(files.ok);
    assertEquals(files.value, [
      "README.md"
    ]);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("listPushedFiles: baseRef lists pushed commits ahead of the base; an option-like baseRef is refused (#3689)", async ()=>{
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    // Model a WIP checkpoint push: origin/main now holds the docs commit. A
    // ref update, not a real push, so an ambient pre-push hook cannot refuse it.
    await git(clone, "update-ref", "refs/remotes/origin/main", "HEAD");
    const initSha = await git(clone, "rev-parse", "HEAD~1");
    const refs = parsePrePushRefs(stdin);
    assert(refs.ok);
    const run = async (a, c)=>{
      const out = await new Deno.Command("git", {
        args: a,
        cwd: c,
        stdout: "piped",
        stderr: "piped"
      }).output();
      const d = new TextDecoder();
      return {
        code: out.code,
        stdout: d.decode(out.stdout),
        stderr: d.decode(out.stderr)
      };
    };
    // Already on origin (a WIP checkpoint push): the default range is empty.
    const unpushedOnly = await listPushedFiles(refs.value, clone, run);
    assert(unpushedOnly.ok);
    assertEquals(unpushedOnly.value, []);
    // The whole-branch range still sees it.
    const ahead = await listPushedFiles(refs.value, clone, run, initSha);
    assert(ahead.ok);
    assertEquals(ahead.value, [
      "README.md"
    ]);
    const unsafe = await listPushedFiles(refs.value, clone, run, "--all");
    assert(!unsafe.ok);
    assert(unsafe.error.includes("unsafe base ref"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("listPushedFiles: a committed symlink is not a regular file and is skipped", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await Deno.writeTextFile(`${clone}/target.md`, "# Target\n");
    await Deno.symlink("target.md", `${clone}/link.md`);
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "symlink");
    const sha = await git(clone, "rev-parse", "HEAD");
    const refs = parsePrePushRefs(`refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`);
    assert(refs.ok);
    const files = await listPushedFiles(refs.value, clone, async (a, c)=>{
      const out = await new Deno.Command("git", {
        args: a,
        cwd: c,
        stdout: "piped",
        stderr: "piped"
      }).output();
      const d = new TextDecoder();
      return {
        code: out.code,
        stdout: d.decode(out.stdout),
        stderr: d.decode(out.stderr)
      };
    });
    assert(files.ok);
    assert(files.value.includes("target.md"));
    assert(!files.value.includes("link.md"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("listPushedFiles: a file behind a directory later replaced by a symlink is skipped (#4909)", async ()=>{
  const outside = await Deno.makeTempDir({
    prefix: "vibe-pp-outside-"
  });
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
    const refs = parsePrePushRefs(`refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`);
    assert(refs.ok);
    const files = await listPushedFiles(refs.value, clone, async (a, c)=>{
      const out = await new Deno.Command("git", {
        args: a,
        cwd: c,
        stdout: "piped",
        stderr: "piped"
      }).output();
      const d = new TextDecoder();
      return {
        code: out.code,
        stdout: d.decode(out.stdout),
        stderr: d.decode(out.stderr)
      };
    });
    assert(files.ok);
    assertEquals(files.value, [
      "README.md",
      "keep/ok.md"
    ]);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
    await Deno.remove(outside, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate excludes files behind a replaced directory symlink (#4909)", async ()=>{
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
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      findMarkdownlint: ()=>Promise.resolve("/fake/markdownlint"),
      findCspell: ()=>Promise.resolve("/fake/cspell"),
      runner: recordingRunner(()=>false, seen)
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(seen.some((command)=>command.includes("README.md")));
    assert(!seen.some((command)=>command.includes("dir/notes.md")));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("listPushedFiles: a symlinked checkout retains real files and skips escaping paths (#4909)", async ()=>{
  const root = await Deno.makeTempDir({
    prefix: "vibe-pp-linked-"
  });
  try {
    const clone = `${root}/clone`;
    const outside = `${root}/outside`;
    const link = `${root}/link`;
    await Deno.mkdir(`${clone}/keep`, {
      recursive: true
    });
    await Deno.mkdir(outside);
    await Deno.writeTextFile(`${clone}/README.md`, "# Readme\n");
    await Deno.writeTextFile(`${clone}/keep/ok.md`, "# Ok\n");
    await Deno.writeTextFile(`${outside}/file.json`, "{}\n");
    await Deno.symlink(outside, `${clone}/dir`);
    await Deno.symlink(clone, link);
    const refs = parsePrePushRefs(`refs/heads/main ${SHA_A} refs/heads/main ${ZERO}\n`);
    assert(refs.ok);
    const files = await listPushedFiles(refs.value, link, ()=>Promise.resolve({
        code: 0,
        stdout: "README.md\0keep/ok.md\0dir/file.json\0",
        stderr: ""
      }));
    assert(files.ok);
    assertEquals(files.value, [
      "README.md",
      "keep/ok.md"
    ]);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("listPushedFiles: an unresolvable checkout returns an Err naming the cause (#4909)", async ()=>{
  const missing = `${await Deno.makeTempDir({
    prefix: "vibe-pp-gone-"
  })}/gone`;
  let expected = "";
  try {
    await Deno.realPath(missing);
  } catch (err) {
    assertInstanceOf(err, Error);
    expected = err.message;
  }
  assert(expected !== "");
  const sha = "a".repeat(40);
  const refs = parsePrePushRefs(`refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`);
  assert(refs.ok);
  const files = await listPushedFiles(refs.value, missing, ()=>Promise.resolve({
      code: 0,
      stdout: "README.md\0",
      stderr: ""
    }));
  assert(!files.ok);
  assertEquals(files.error, `could not resolve checkout ${JSON.stringify(missing)}: ${expected}`);
  await Deno.remove(missing.slice(0, -"/gone".length), {
    recursive: true
  });
});
Deno.test("runPrePushGate: doc-only push blocked by failing markdownlint", async ()=>{
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    const seen = [];
    const run = (fail)=>runPrePushGate({
        cwd: clone,
        stdin,
        preFlightCommands: [],
        runner: recordingRunner((c)=>fail && c.includes("/fake/mdl"), seen),
        findMarkdownlint: ()=>Promise.resolve("/fake/mdl")
      });
    const blocked = await run(true);
    assert(!blocked.ok);
    assertInstanceOf(blocked.error, PreFlightGateError);
    assertEquals(blocked.error.reason, "non-zero-exit");
    assert(blocked.error.command.includes("/fake/mdl"));
    const accepted = await run(false);
    assert(accepted.ok);
    assertEquals(accepted.value.checksRun.length, 2);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: deleted scripts are not passed to ShellCheck", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "gone.sh": "#!/bin/sh\ntrue\n"
    });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.remove(`${clone}/gone.sh`);
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "delete shell script");
    const tip = await git(clone, "rev-parse", "HEAD");
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      runner: recordingRunner(()=>false, seen)
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value.checksRun, []);
    assert(!seen.some((command)=>command.includes("shellcheck")));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: paths outside CI's .sh selection are excluded", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "baseline.sh": "#!/bin/sh\ntrue\n"
    });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.writeTextFile(`${clone}/notes.txt`, "not a shell script\n");
    await git(clone, "add", "notes.txt");
    await git(clone, "commit", "-qm", "change a non-shell path");
    const tip = await git(clone, "rev-parse", "HEAD");
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      runner: recordingRunner(()=>false, seen)
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(result.value.checksRun, []);
    assert(!seen.some((command)=>command.includes("shellcheck")));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate selects nearest tracked config and respects explicit rcfile", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${clone}/scripts/deep`, {
      recursive: true
    });
    let tip = await commitShellcheckFiles(clone, {
      "a.sh": "#!/bin/sh\ntrue\n",
      "scripts/b.sh": "#!/bin/sh\ntrue\n",
      "scripts/deep/c.sh": "#!/bin/sh\ntrue\n",
      ".shellcheckrc": "disable=SC2086\n",
      "scripts/.shellcheckrc": "disable=SC2034\n"
    });
    const run = (sha)=>runPrePushGate({
        cwd: clone,
        stdin: prePushInput(sha),
        preFlightCommands: [],
        ...stubShellcheck(),
        runner: recordingRunner(()=>false, [])
      });
    const result = await run(tip);
    assert(result.ok, result.ok ? "" : result.error.message);
    const commands = result.value.checksRun.filter((c)=>c.includes("shellcheck"));
    for (const [script, config] of [
      [
        "a.sh",
        ".shellcheckrc"
      ],
      [
        "scripts/b.sh",
        "scripts/.shellcheckrc"
      ],
      [
        "scripts/deep/c.sh",
        "scripts/.shellcheckrc"
      ]
    ]){
      assert(commands.some((c)=>c.includes(`'${script}'`) && c.includes(`'--rcfile' '${config}'`)), commands.join("\n"));
    }
    await Deno.writeTextFile(`${clone}/.github/workflows/validate-scripts.yml`, SHELLCHECK_WORKFLOW("--rcfile .shellcheckrc"));
    await git(clone, "add", ".github/workflows/validate-scripts.yml");
    await git(clone, "commit", "-qm", "explicit config");
    tip = await git(clone, "rev-parse", "HEAD");
    const explicit = await run(tip);
    assert(explicit.ok, explicit.ok ? "" : explicit.error.message);
    for (const command of explicit.value.checksRun.filter((c)=>c.includes("shellcheck"))){
      assertEquals(command.match(/--rcfile/g)?.length, 1);
      assert(!command.includes("--norc"));
    }
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: a changed ShellCheck config rechecks every tracked script", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "one.sh": "#!/bin/sh\necho $1\n",
      "two scripts.sh": "#!/bin/sh\ntrue\n"
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
      runner: recordingRunner(()=>false, [])
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    const command = result.value.checksRun.filter((value)=>value.includes("shellcheck")).join("\n");
    assert(command);
    assert(command.includes("one.sh"), command);
    assert(command.includes("two scripts.sh"), command);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: nested ShellCheck config changes recheck tracked scripts", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${clone}/scripts`, {
      recursive: true
    });
    await Deno.mkdir(`${clone}/other`, {
      recursive: true
    });
    await commitShellcheckFiles(clone, {
      "scripts/one.sh": "#!/bin/sh\necho $1\n",
      "other/two.sh": "#!/bin/sh\ntrue\n"
    });
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.mkdir(`${clone}/scripts`, {
      recursive: true
    });
    await Deno.writeTextFile(`${clone}/scripts/.shellcheckrc`, "disable=SC2086\n");
    await git(clone, "add", "scripts/.shellcheckrc");
    await git(clone, "commit", "-qm", "change nested ShellCheck config");
    const tip = await git(clone, "rev-parse", "HEAD");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner(()=>false, [])
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    const command = result.value.checksRun.filter((value)=>value.includes("shellcheck")).join("\n");
    assert(command);
    assert(command.includes("scripts/one.sh"), command);
    assert(command.includes("other/two.sh"), command);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: unsupported ShellCheck workflow is an incomplete infrastructure result", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    const tip = await commitShellcheckFiles(clone, {
      "script.sh": "#!/bin/sh\ntrue\n"
    }, "*.sh");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: []
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("unsupported"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: an indirect repository ShellCheck gate is not silently skipped", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "script.sh": "#!/bin/sh\ntrue\n"
    });
    await Deno.writeTextFile(`${clone}/.github/workflows/validate-scripts.yml`, "jobs:\n  lint:\n    steps:\n      - run: ./quality.sh\n");
    await Deno.writeTextFile(`${clone}/quality.sh`, "#!/bin/bash\nshellcheck -e SC1091 *.sh\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "delegate shellcheck to gate script");
    const tip = await git(clone, "rev-parse", "HEAD");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: []
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("delegates ShellCheck"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: a missing rcfile is an incomplete infrastructure result", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    const tip = await commitShellcheckFiles(clone, {
      "script.sh": "#!/bin/sh\ntrue\n"
    }, "--rcfile missing-shellcheckrc");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: []
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("cannot read ShellCheck configuration"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: a missing ShellCheck tool recovers and revalidates", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    const tip = await commitShellcheckFiles(clone, {
      "clean.sh": "#!/bin/sh\ntrue\n"
    });
    const stub = stubShellcheck();
    const missing = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stub,
      findShellcheck: ()=>Promise.resolve(null)
    });
    assert(!missing.ok);
    assertInstanceOf(missing.error, PrePushGateInfrastructureError);
    assert(missing.error.message.includes("could not be found"));
    const seen = [];
    const recovered = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stub,
      runner: recordingRunner(()=>false, seen)
    });
    assert(recovered.ok, recovered.ok ? "" : recovered.error.message);
    assert(seen.some((command)=>command.includes("/stub/shellcheck") && command.includes("clean.sh")), seen.join("\n"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: a CI and worker ShellCheck version mismatch is incomplete", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    const tip = await commitShellcheckFiles(clone, {
      "clean.sh": "#!/bin/sh\ntrue\n"
    });
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stubShellcheck("9.9.9"),
      runner: recordingRunner(()=>false, seen)
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("version mismatch"));
    assert(result.error.message.includes(`CI requires ${STUB_SHELLCHECK_VERSION}`));
    assert(result.error.message.includes("worker has 9.9.9"));
    assertEquals(seen, []);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: a doc outside the repo's deno fmt include is not deno-checked", async ()=>{
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    await Deno.writeTextFile(`${clone}/deno.json`, '{ // scoped\n "fmt": {"include": ["src/"]}, "lint": {"include": ["src/"]} }\n');
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(()=>false, seen),
      findMarkdownlint: ()=>Promise.resolve("/fake/mdl")
    });
    assert(result.ok);
    // Only markdownlint ran: README.md is outside fmt.include.
    assertEquals(result.value.checksRun.length, 1);
    assert(result.value.checksRun[0]?.includes("/fake/mdl"));
    assert(!seen.some((c)=>c.startsWith("deno ")));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
const SCOPED = '{ "fmt": {"include": ["src/"]}, "lint": {"include": ["src/"]} }';
/** Run the gate over the doc-commit repo and return the deno commands run. */ async function denoCommandsRun(setup) {
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    await setup(clone);
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(()=>false, seen),
      findMarkdownlint: ()=>Promise.resolve("/fake/mdl")
    });
    assert(result.ok);
    return seen.filter((c)=>c.startsWith("deno "));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
}
Deno.test("runPrePushGate: an unparseable deno.json leaves the push unfiltered", async ()=>{
  const ran = await denoCommandsRun((clone)=>Deno.writeTextFile(`${clone}/deno.json`, "{ not json"));
  assertEquals(ran, [
    "deno fmt --check --permit-no-files 'README.md'"
  ]);
});
Deno.test("runPrePushGate: a deno.jsonc alone supplies the scope", async ()=>{
  const ran = await denoCommandsRun(async (clone)=>{
    await Deno.remove(`${clone}/deno.json`);
    await Deno.writeTextFile(`${clone}/deno.jsonc`, SCOPED);
  });
  assertEquals(ran, []);
});
Deno.test("runPrePushGate: deno.json wins over a deno.jsonc beside it", async ()=>{
  const ran = await denoCommandsRun(async (clone)=>{
    await Deno.writeTextFile(`${clone}/deno.json`, SCOPED);
    await Deno.writeTextFile(`${clone}/deno.jsonc`, "{}");
  });
  assertEquals(ran, []);
  const unscoped = await denoCommandsRun(async (clone)=>{
    await Deno.writeTextFile(`${clone}/deno.json`, "{}");
    await Deno.writeTextFile(`${clone}/deno.jsonc`, SCOPED);
  });
  assertEquals(unscoped, [
    "deno fmt --check --permit-no-files 'README.md'"
  ]);
});
Deno.test("runPrePushGate: pre-flight failure blocks after changed-file checks ran", async ()=>{
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [
        "make-it-fail"
      ],
      runner: recordingRunner((c)=>c === "make-it-fail", seen),
      findMarkdownlint: ()=>Promise.resolve("/fake/mdl")
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PreFlightGateError);
    assertEquals(result.error.reason, "non-zero-exit");
    assertEquals(result.error.command, "make-it-fail");
    assertEquals(seen.length, 3);
    assertEquals(seen[2], "make-it-fail");
    assert(seen[0].startsWith("deno fmt"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: git log failure is an error", async ()=>{
  const failing = ()=>Promise.resolve({
      code: 128,
      stdout: "",
      stderr: "fatal: nope"
    });
  const result = await runPrePushGate({
    cwd: "/nonexistent",
    stdin: `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}\n`,
    preFlightCommands: [],
    git: failing
  });
  assert(!result.ok);
  assert(result.error.message.includes("git log failed"));
  // The lookup failed; nothing was decided about the branch (PR #3716 review).
  assertInstanceOf(result.error, PrePushGateInfrastructureError);
});
Deno.test("runPrePushGate: malformed hook input is not infrastructure (PR #3716 review)", async ()=>{
  const result = await runPrePushGate({
    cwd: "/x",
    stdin: "garbage",
    preFlightCommands: []
  });
  assert(!result.ok);
  assert(!(result.error instanceof PrePushGateInfrastructureError));
});
Deno.test("runPrePushGate: malformed hook input is an error", async ()=>{
  const result = await runPrePushGate({
    cwd: "/x",
    stdin: "garbage",
    preFlightCommands: []
  });
  assert(!result.ok);
});
Deno.test("runPrePushGate: git ls-files failure is an error", async ()=>{
  const calls = [];
  const makeGit = (lsFilesCode)=>(args)=>{
      calls.push(args[0]);
      if (args[0] === "ls-files") {
        return Promise.resolve({
          code: lsFilesCode,
          stdout: "",
          stderr: lsFilesCode === 0 ? "" : "fatal: index corrupt"
        });
      }
      return Promise.resolve({
        code: 0,
        stdout: "",
        stderr: ""
      });
    };
  const input = {
    cwd: "/nonexistent",
    stdin: `refs/heads/main ${SHA_A} refs/heads/main ${SHA_B}\n`,
    preFlightCommands: []
  };
  const failed = await runPrePushGate({
    ...input,
    git: makeGit(128)
  });
  assert(!failed.ok);
  assert(failed.error.message.includes("ls-files"));
  assert(failed.error.message.includes("index corrupt"));
  assertInstanceOf(failed.error, PrePushGateInfrastructureError);
  assertEquals(calls, [
    "log",
    "log",
    "ls-files"
  ]);
  const accepted = await runPrePushGate({
    ...input,
    git: makeGit(0)
  });
  assert(accepted.ok);
});
Deno.test("defaultPrePushGit: a nonexistent working directory fails closed", async ()=>{
  const result = await defaultPrePushGit([
    "status"
  ], "/nonexistent/vibe-pre-push-dir");
  assert(result.code !== 0);
  assert(result.stderr.trim().length > 0);
  const dir = await Deno.makeTempDir({
    prefix: "pre_push_default_git_"
  });
  try {
    const ok = await defaultPrePushGit([
      "--version"
    ], dir);
    assertEquals(ok.code, 0);
    assert(ok.stdout.startsWith("git version"));
  } finally{
    await Deno.remove(dir, {
      recursive: true
    });
  }
});
// ---- cspell (Issue #3689) ---------------------------------------------------
Deno.test("planChangedFileChecks: cspell config and a changed .md plans cspell with the files", ()=>{
  const result = planChangedFileChecks([
    "pr-summary-1.md",
    "x.rs"
  ], [
    "cspell.json"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: "/r/bin/cspell",
    cspellInCi: true
  });
  assert(result.ok);
  const check = result.value.find((c)=>c.label === "cspell");
  assert(check !== undefined);
  assertEquals(check.command, "'/r/bin/cspell' --no-progress --no-summary --no-must-find-files " + "'pr-summary-1.md'");
  assertEquals(check.cwd, "/r");
});
Deno.test("planChangedFileChecks: a docs/cspell.json config is passed with --config", ()=>{
  const result = planChangedFileChecks([
    "CHANGELOG.md"
  ], [
    "docs/cspell.json"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: "/r/bin/cspell",
    cspellInCi: true
  });
  assert(result.ok);
  assert(result.value[0].command.includes("--config docs/cspell.json "));
});
Deno.test("planChangedFileChecks: no cspell config means no cspell check", ()=>{
  const result = planChangedFileChecks([
    "a.md"
  ], [
    "README.md"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: null,
    cspellInCi: true
  });
  assert(result.ok);
  assertEquals(result.value, []);
});
Deno.test("planChangedFileChecks: cspell configured but binary missing is an error naming cspell", ()=>{
  const result = planChangedFileChecks([
    "a.md"
  ], [
    "cspell.json"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: null,
    cspellInCi: true
  });
  assert(!result.ok);
  assert(result.error.includes("cspell"));
});
Deno.test("planChangedFileChecks: only non-spellchecked extensions means no cspell check", ()=>{
  const result = planChangedFileChecks([
    "src/a.rs"
  ], [
    "cspell.json"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: null,
    cspellInCi: true
  });
  assert(result.ok);
  assertEquals(result.value, []);
});
Deno.test("planChangedFileChecks: cspell config but repo CI does not run cspell plans no check and is not blocked", ()=>{
  const result = planChangedFileChecks([
    "notes.md"
  ], [
    "cspell.json"
  ], {
    repoRoot: "/r",
    markdownlintBinary: null,
    cspellBinary: null,
    cspellInCi: false
  });
  assert(result.ok);
  assertEquals(result.value.find((c)=>c.label === "cspell"), undefined);
});
Deno.test("repoCiRunsCspell: a workflow run step naming cspell counts", async ()=>{
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${dir}/.github/workflows/spell.yml`, 'jobs:\n  spell:\n    steps:\n      - run: npx cspell "**/*.md"\n');
    assertEquals(await repoCiRunsCspell(dir, [
      ".github/workflows/spell.yml"
    ]), true);
  } finally{
    await Deno.remove(dir, {
      recursive: true
    });
  }
});
Deno.test("repoCiRunsCspell: a commented-out cspell step does not count", async ()=>{
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${dir}/.github/workflows/ci.yml`, "jobs:\n  test:\n    steps:\n      # - run: cspell .\n      - run: deno test\n");
    assertEquals(await repoCiRunsCspell(dir, [
      ".github/workflows/ci.yml"
    ]), false);
  } finally{
    await Deno.remove(dir, {
      recursive: true
    });
  }
});
Deno.test("repoCiRunsCspell: a tracked file outside .github/workflows/ or not YAML does not count", async ()=>{
  const dir = await Deno.makeTempDir();
  const body = "jobs:\n  spell:\n    steps:\n      - run: npx cspell .\n";
  try {
    await Deno.mkdir(`${dir}/.github/workflows`, {
      recursive: true
    });
    await Deno.mkdir(`${dir}/ci`, {
      recursive: true
    });
    await Deno.writeTextFile(`${dir}/.github/workflows/real.yml`, body);
    await Deno.writeTextFile(`${dir}/ci/spell.yml`, body);
    await Deno.writeTextFile(`${dir}/.github/workflows/notes.md`, body);
    // Positive control: the same text in a tracked workflow YAML counts.
    assertEquals(await repoCiRunsCspell(dir, [
      ".github/workflows/real.yml"
    ]), true);
    // Prefix filter: a YAML outside .github/workflows/ is another CI system's.
    assertEquals(await repoCiRunsCspell(dir, [
      "ci/spell.yml"
    ]), false);
    // Extension filter: a non-YAML file under .github/workflows/ is not a workflow.
    assertEquals(await repoCiRunsCspell(dir, [
      ".github/workflows/notes.md"
    ]), false);
  } finally{
    await Deno.remove(dir, {
      recursive: true
    });
  }
});
Deno.test("repoCiRunsCspell: a tracked workflow that cannot be read is skipped", async ()=>{
  assertEquals(await repoCiRunsCspell("/nonexistent", [
    ".github/workflows/x.yml"
  ]), false);
});
Deno.test("workflowRunsCspell: a block-scalar run step that calls cspell counts", ()=>{
  const yml = 'jobs:\n  spell:\n    steps:\n      - name: Spell\n        run: |\n          npm ci\n          npx cspell --config docs/cspell.json "**/*.md"\n';
  assert(workflowRunsCspell(yml));
});
Deno.test("workflowRunsCspell: GRQ's cspell-action uses step counts", ()=>{
  const yml = "jobs:\n  spell:\n    steps:\n      - uses: streetsidesoftware/cspell-action@v6\n";
  assert(workflowRunsCspell(yml));
});
Deno.test("workflowRunsCspell: block-scalar and single-line steps without cspell do not count", ()=>{
  assert(!workflowRunsCspell("jobs:\n  test:\n    steps:\n      - run: |\n          deno test\n          deno lint\n      - run: deno fmt --check\n"));
});
Deno.test("workflowRunsCspell: a commented-out cspell step inside a block does not count", ()=>{
  assert(!workflowRunsCspell("jobs:\n  test:\n    steps:\n      - run: |\n          deno test\n          # npx cspell .\n"));
});
// Each test below goes red when one branch of workflowRunsCspell is broken
// (PR #3716 review): the block end, the blank-line skip, and the block header.
Deno.test("workflowRunsCspell: a single-line cspell step after a block-scalar step counts", ()=>{
  assert(workflowRunsCspell('jobs:\n  test:\n    steps:\n      - run: |\n          npm ci\n      - run: npx cspell "**/*.md"\n'));
});
Deno.test("workflowRunsCspell: a blank line inside a block does not end it", ()=>{
  assert(workflowRunsCspell('jobs:\n  test:\n    steps:\n      - run: |\n          npm ci\n\n          npx cspell "**/*.md"\n'));
});
Deno.test("workflowRunsCspell: block headers with chomping or indent indicators are blocks", ()=>{
  for (const header of [
    "|-",
    ">",
    ">-",
    "|+",
    "|2"
  ]){
    assert(workflowRunsCspell(`jobs:\n  test:\n    steps:\n      - run: ${header}\n          npx cspell "**/*.md"\n`), `header ${header}`);
  }
});
Deno.test("runPrePushGate: a cspell config with no CI cspell step is not blocked and never looks for cspell", async ()=>{
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${clone}/docs`, {
      recursive: true
    });
    await Deno.writeTextFile(`${clone}/docs/cspell.json`, "{}\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "nested cspell config");
    const tip = await git(clone, "rev-parse", "HEAD");
    let looked = false;
    const result = await runPrePushGate({
      cwd: clone,
      stdin: stdin.replace(/ [0-9a-f]{40} refs\/heads\/main/, ` ${tip} refs/heads/main`),
      preFlightCommands: [],
      runner: recordingRunner(()=>false, []),
      findMarkdownlint: ()=>Promise.resolve("/fake/mdl"),
      findCspell: ()=>{
        looked = true;
        return Promise.resolve(null);
      }
    });
    assert(!looked, "cspell must not be looked up when CI does not run it");
    assert(result.ok, `the push must not be blocked on cspell: ${result.ok ? "" : result.error.message}`);
    assert(!result.value.checksRun.some((c)=>c.includes("--no-must-find-files")), `no cspell check may be planned: ${JSON.stringify(result.value.checksRun)}`);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: a cspell config with a GRQ-style cspell-action step is blocked when cspell is missing", async ()=>{
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    await Deno.mkdir(`${clone}/docs`, {
      recursive: true
    });
    await Deno.writeTextFile(`${clone}/docs/cspell.json`, "{}\n");
    await Deno.mkdir(`${clone}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${clone}/.github/workflows/spell.yml`, "jobs:\n  spell:\n    steps:\n      - uses: streetsidesoftware/cspell-action@v6\n");
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "cspell config and CI");
    const tip = await git(clone, "rev-parse", "HEAD");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: stdin.replace(/ [0-9a-f]{40} refs\/heads\/main/, ` ${tip} refs/heads/main`),
      preFlightCommands: [],
      runner: recordingRunner(()=>false, []),
      findMarkdownlint: ()=>Promise.resolve("/fake/mdl"),
      findCspell: ()=>Promise.resolve(null)
    });
    assert(!result.ok, "CI runs cspell, so a missing binary must block");
    assert(result.error.message.includes("cspell"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: a failing cspell blocks the push", async ()=>{
  const { root, clone, stdin } = await makeRepoWithDocCommit();
  try {
    await Deno.writeTextFile(`${clone}/cspell.json`, "{}\n");
    // The repo's own CI runs cspell, so the gate must run it too.
    await Deno.mkdir(`${clone}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${clone}/.github/workflows/spell.yml`, 'jobs:\n  spell:\n    steps:\n      - run: npx cspell "**/*.md"\n');
    await git(clone, "add", ".");
    await git(clone, "commit", "-qm", "cspell config and CI");
    const tip = await git(clone, "rev-parse", "HEAD");
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: stdin.replace(/ [0-9a-f]{40} refs\/heads\/main/, ` ${tip} refs/heads/main`),
      preFlightCommands: [],
      runner: recordingRunner((c)=>c.includes("/fake/cspell"), seen),
      findMarkdownlint: ()=>Promise.resolve("/fake/mdl"),
      findCspell: ()=>Promise.resolve("/fake/cspell")
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PreFlightGateError);
    assert(result.error.command.includes("/fake/cspell"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
// ---- Floci CloudFormation deploy test (Issue #3727) ----------------------------
const FLOCI_CHECK = "floci cloudformation";
const FLOCI_COMMAND = "bash infra/cloudformation/test-floci.sh";
Deno.test("planChangedFileChecks: a changed template plans the Floci deploy test once", ()=>{
  const result = planChangedFileChecks([
    "infra/cloudformation/linux-verification-host.yaml",
    "infra/cloudformation/other.yaml"
  ], [
    "infra/cloudformation/test-floci.sh",
    "infra/cloudformation/linux-verification-host.yaml"
  ], {
    repoRoot: "/repo",
    markdownlintBinary: null
  });
  assert(result.ok);
  assertEquals(result.value.filter((c)=>c.label === FLOCI_CHECK), [
    {
      label: FLOCI_CHECK,
      cwd: "/repo",
      command: FLOCI_COMMAND
    }
  ]);
});
Deno.test("planChangedFileChecks: a change to test-floci.sh itself plans the Floci deploy test", ()=>{
  const result = planChangedFileChecks([
    "infra/cloudformation/test-floci.sh"
  ], [
    "infra/cloudformation/test-floci.sh"
  ], {
    repoRoot: "/repo",
    markdownlintBinary: null
  });
  assert(result.ok);
  assertEquals(result.value.filter((c)=>c.label === FLOCI_CHECK), [
    {
      label: FLOCI_CHECK,
      cwd: "/repo",
      command: FLOCI_COMMAND
    }
  ]);
});
Deno.test("planChangedFileChecks: no Floci deploy test outside infra/cloudformation/", ()=>{
  const result = planChangedFileChecks([
    "infra/host/install-deno.sh",
    "infra/cloudformation-old/x.yaml",
    "docs/a.md"
  ], [
    "infra/cloudformation/test-floci.sh",
    "docs/a.md"
  ], {
    repoRoot: "/repo",
    markdownlintBinary: null
  });
  assert(result.ok);
  assertEquals(result.value.filter((c)=>c.label === FLOCI_CHECK), []);
});
Deno.test("planChangedFileChecks: no Floci deploy test when the repo does not track the script", ()=>{
  const result = planChangedFileChecks([
    "infra/cloudformation/linux-verification-host.yaml"
  ], [
    "infra/cloudformation/linux-verification-host.yaml"
  ], {
    repoRoot: "/repo",
    markdownlintBinary: null
  });
  assert(result.ok);
  assertEquals(result.value.filter((c)=>c.label === FLOCI_CHECK), []);
});
/**
 * Like {@link makeRepoWithDocCommit}, but the one local commit adds the Floci
 * script and a CloudFormation template under `infra/cloudformation/`.
 */ async function makeRepoWithFlociCommit() {
  const root = await Deno.makeTempDir({
    prefix: "vibe-pp-floci-"
  });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  await git(root, "clone", "-q", remote, clone);
  await Deno.writeTextFile(`${clone}/deno.json`, "{}\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "init");
  await git(clone, "push", "-q", "origin", "HEAD:main");
  await Deno.mkdir(`${clone}/infra/cloudformation`, {
    recursive: true
  });
  await Deno.writeTextFile(`${clone}/infra/cloudformation/test-floci.sh`, "#!/usr/bin/env bash\n");
  await Deno.writeTextFile(`${clone}/infra/cloudformation/t.yaml`, "AWSTemplateFormatVersion: '2010-09-09'\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "floci");
  const sha = await git(clone, "rev-parse", "HEAD");
  return {
    root,
    clone,
    stdin: `refs/heads/main ${sha} refs/heads/main ${"0".repeat(40)}\n`
  };
}
Deno.test("runPrePushGate: a failing Floci deploy test blocks the push", async ()=>{
  const { root, clone, stdin } = await makeRepoWithFlociCommit();
  try {
    const seen = [];
    const run = (fail)=>runPrePushGate({
        cwd: clone,
        stdin,
        preFlightCommands: [],
        runner: recordingRunner((c)=>fail && c.includes("test-floci.sh"), seen)
      });
    const blocked = await run(true);
    assert(!blocked.ok);
    assertInstanceOf(blocked.error, PreFlightGateError);
    assertEquals(blocked.error.reason, "non-zero-exit");
    assertEquals(blocked.error.command, FLOCI_COMMAND);
    const accepted = await run(false);
    assert(accepted.ok);
    assert(accepted.value.checksRun.includes(FLOCI_COMMAND));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("repoShellcheckPolicy: repository workflows distinguish execution from logging and script data", async ()=>{
  const repo = new URL("../../../", import.meta.url).pathname;
  const tracked = (await git(repo, "ls-files", "-z")).split("\0").filter(Boolean);
  const result = await repoShellcheckPolicy(repo, tracked);
  assert(result.ok, result.ok ? "" : result.error);
  assert(result.value);
  // Derive the expectation from the workflow text itself, not typed-in copies.
  const workflow = await Deno.readTextFile(new URL("../../../.github/workflows/validate-scripts.yml", import.meta.url));
  assertEquals(result.value.version, /^\s*SHELLCHECK_VERSION:\s*["']?(\d+\.\d+\.\d+)/m.exec(workflow)?.[1]);
  const exec = /-exec\s+shellcheck\s+(.+?)\s+\{\}\s+\+/.exec(workflow);
  assert(exec, "the repository workflow runs ShellCheck through find -exec");
  assertEquals(result.value.flags, exec[1].split(/\s+/));
  const container = await repoShellcheckPolicy(repo, tracked.filter((p)=>!p.startsWith(".github/workflows/") || p.endsWith("/container-build.yml")));
  assertEquals(container, {
    ok: true,
    value: null
  });
});
Deno.test("repoShellcheckPolicy: invalid policies return explicit errors", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  await Deno.mkdir(`${root}/.github/workflows`, {
    recursive: true
  });
  try {
    const cases = [
      [
        SHELLCHECK_WORKFLOW("--rcfile /tmp/config"),
        "unsafe ShellCheck rcfile path"
      ],
      [
        SHELLCHECK_WORKFLOW("--rcfile config/../rc"),
        "unsafe ShellCheck rcfile path"
      ],
      [
        SHELLCHECK_WORKFLOW("--rcfile ./rc"),
        "unsafe ShellCheck rcfile path"
      ],
      [
        SHELLCHECK_WORKFLOW("--rcfile="),
        "missing ShellCheck rcfile"
      ],
      [
        SHELLCHECK_WORKFLOW("--rcfile"),
        "missing ShellCheck rcfile"
      ],
      [
        SHELLCHECK_WORKFLOW("--rcfile --norc"),
        "missing ShellCheck rcfile"
      ],
      [
        SHELLCHECK_WORKFLOW("--rcfile=/tmp/config"),
        "unsafe ShellCheck rcfile path"
      ],
      [
        SHELLCHECK_WORKFLOW("--rcfile=config/../rc"),
        "unsafe ShellCheck rcfile path"
      ],
      [
        SHELLCHECK_WORKFLOW("-e"),
        "missing value for ShellCheck option -e"
      ],
      [
        SHELLCHECK_WORKFLOW("-abc"),
        "unsupported ShellCheck option -abc"
      ],
      [
        SHELLCHECK_WORKFLOW("-s --norc"),
        "missing value for ShellCheck option -s"
      ],
      [
        SHELLCHECK_WORKFLOW("scripts.sh"),
        "unsupported positional ShellCheck argument"
      ],
      [
        SHELLCHECK_WORKFLOW("-e SC2086").replace('find . -name "*.sh" -type f -exec ', "").replace(" {} +", " *.sh"),
        "unsupported ShellCheck command"
      ],
      [
        SHELLCHECK_WORKFLOW("-e SC2086").replace(`"${STUB_SHELLCHECK_VERSION}"`, '"latest"'),
        "does not declare one supported pinned version"
      ],
      [
        SHELLCHECK_WORKFLOW("-e SC2086") + "    defaults:\n      run:\n        working-directory: scripts\n",
        "unsupported working-directory"
      ],
      [
        "jobs:\n  lint:\n    steps:\n      - uses: example/shellcheck-action@v1\n",
        "unsupported ShellCheck action in workflow"
      ],
      [
        SYNCED_SHELLCHECK_WORKFLOW.replace("severity: warning", "severity: warning\n          ignore_paths: vendor"),
        "unsupported ShellCheck action option ignore_paths"
      ],
      [
        SYNCED_SHELLCHECK_WORKFLOW.replace("scandir: .", "scandir: scripts"),
        "unsupported ShellCheck action option scandir"
      ],
      [
        SYNCED_SHELLCHECK_WORKFLOW.replace("warning", "loud"),
        "unsupported ShellCheck action option severity"
      ],
      [
        SYNCED_SHELLCHECK_WORKFLOW.replace("        with:\n          scandir: .", "        env:\n          SHELLCHECK_OPTS: -e SC2086\n        with:\n          scandir: ."),
        "unsupported ShellCheck action option SHELLCHECK_OPTS"
      ]
    ];
    for (const [body, error] of cases){
      await Deno.writeTextFile(`${root}/${path}`, body);
      const result = await repoShellcheckPolicy(root, [
        path
      ]);
      assertEquals(result.ok, false, body);
      if (!result.ok) {
        assert(result.error.includes(error), `${body}: ${result.error}`);
      }
    }
    await Deno.remove(`${root}/${path}`);
    let readError;
    try {
      await Deno.lstat(`${root}/${path}`);
    } catch (error) {
      readError = error;
    }
    assert(readError);
    assertEquals(await repoShellcheckPolicy(root, [
      path
    ]), {
      ok: false,
      error: `cannot read tracked workflow ${path}: ${readError.message}`
    });
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("repoShellcheckPolicy: non-workflow paths, comments, probes and short rcfile option", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yaml";
  await Deno.mkdir(`${root}/.github/workflows`, {
    recursive: true
  });
  try {
    const ignored = [
      "check.yml",
      ".github/workflows/check.txt"
    ];
    assertEquals(await repoShellcheckPolicy(root, ignored), {
      ok: true,
      value: null
    });
    await Deno.writeTextFile(`${root}/${path}`, SHELLCHECK_WORKFLOW("-rc config/rc").replace("          find .", '          # shellcheck ignored.sh\n\n          shellcheck --version\n          echo "installing shellcheck"\n          sudo apt-get install shellcheck\n          find .'));
    const result = await repoShellcheckPolicy(root, [
      path,
      "config/rc"
    ]);
    assertEquals(result, {
      ok: true,
      value: {
        version: STUB_SHELLCHECK_VERSION,
        flags: [
          "-rc",
          "config/rc"
        ],
        configFiles: [
          "config/rc"
        ],
        workflowFiles: [
          path
        ]
      }
    });
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: a commented YAML block header still plans the ShellCheck check", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    const tip = await commitShellcheckFiles(clone, {
      "bad.sh": "#!/bin/sh\necho $1\n"
    });
    const path = `${clone}/.github/workflows/validate-scripts.yml`;
    await Deno.writeTextFile(path, (await Deno.readTextFile(path)).replace("run: |", "run: | # Check scripts"));
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(tip),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner((command)=>command.includes("bad.sh"), seen)
    });
    assertEquals(result.ok, false);
    assert(seen.some((command)=>command.includes("bad.sh")), seen.join("\n"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
for (const config of [
  ".shellcheckrc",
  "scripts/.shellcheckrc"
]){
  Deno.test(`runPrePushGate: deleting ${config} revalidates unchanged scripts without it`, async ()=>{
    const { root, clone } = await makeRepoWithDocCommit();
    try {
      await Deno.mkdir(`${clone}/scripts`, {
        recursive: true
      });
      await commitShellcheckFiles(clone, {
        "scripts/bad.sh": "#!/bin/sh\necho $1\n",
        [config]: "disable=SC2086\n"
      });
      await git(clone, "push", "-q", "origin", "HEAD:main");
      await Deno.remove(`${clone}/${config}`);
      await git(clone, "add", "-A");
      await git(clone, "commit", "-qm", "remove config");
      const seen = [];
      const result = await runPrePushGate({
        cwd: clone,
        stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
        preFlightCommands: [],
        ...stubShellcheck(),
        runner: recordingRunner(()=>false, seen)
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      const command = seen.find((value)=>value.includes("scripts/bad.sh"));
      assert(command, seen.join("\n"));
      assert(command.includes("--norc"), command);
      assert(!command.includes("--rcfile"), command);
    } finally{
      await Deno.remove(root, {
        recursive: true
      });
    }
  });
}
Deno.test("repoShellcheckPolicy: delegated execution has an explicit false verdict", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  await Deno.mkdir(`${root}/.github/workflows`, {
    recursive: true
  });
  try {
    await Deno.writeTextFile(`${root}/${path}`, "jobs:\n  lint:\n    steps:\n      - run: bash check.sh\n");
    await Deno.writeTextFile(`${root}/check.sh`, "#!/bin/sh\n# shellcheck disable=SC2086\necho 'shellcheck logs'\nIMAGE_PATHS=(\n  'data.sh'\n)\n");
    await Deno.writeTextFile(`${root}/data.sh`, "#!/bin/sh\nshellcheck script.sh\n");
    assertEquals(await repoShellcheckPolicy(root, [
      path,
      "check.sh",
      "data.sh"
    ]), {
      ok: true,
      value: null
    });
    await Deno.writeTextFile(`${root}/check.sh`, "#!/bin/sh\nshellcheck script.sh\n");
    assertEquals(await repoShellcheckPolicy(root, [
      path,
      "check.sh"
    ]), {
      ok: false,
      error: `repository CI delegates ShellCheck through a script in workflow ${path}`
    });
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("repoShellcheckPolicy: comments and version probes do not become checks", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  await Deno.mkdir(`${root}/.github/workflows`, {
    recursive: true
  });
  try {
    for (const line of [
      "",
      "# shellcheck ignored.sh",
      "shellcheck --version"
    ]){
      await Deno.writeTextFile(`${root}/${path}`, SHELLCHECK_WORKFLOW("-e SC2086").replace("          find .", `${line ? `          ${line}\n` : "\n"}          find .`));
      const result = await repoShellcheckPolicy(root, [
        path
      ]);
      assertEquals(result.ok, true, line);
      if (result.ok) assertEquals(result.value?.flags, [
        "-e",
        "SC2086"
      ]);
    }
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("repoShellcheckPolicy: the worker's synced ludeeus template is a supported policy", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/shellcheck.yml";
  await Deno.mkdir(`${root}/.github/workflows`, {
    recursive: true
  });
  try {
    await Deno.writeTextFile(`${root}/${path}`, SYNCED_SHELLCHECK_WORKFLOW);
    assertEquals(await repoShellcheckPolicy(root, [
      path,
      ".shellcheckrc"
    ]), {
      ok: true,
      value: {
        version: null,
        flags: [
          "--severity=warning"
        ],
        configFiles: [
          ".shellcheckrc"
        ],
        workflowFiles: [
          path
        ]
      }
    });
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("repoShellcheckPolicy: value-taking options consume their value", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  await Deno.mkdir(`${root}/.github/workflows`, {
    recursive: true
  });
  try {
    const accepted = [
      [
        "-S warning",
        [
          "-S",
          "warning"
        ]
      ],
      [
        "--severity warning",
        [
          "--severity",
          "warning"
        ]
      ],
      [
        "--severity=warning",
        [
          "--severity=warning"
        ]
      ],
      [
        "-Swarning",
        [
          "-Swarning"
        ]
      ],
      [
        "--enable all",
        [
          "--enable",
          "all"
        ]
      ],
      [
        "-o all",
        [
          "-o",
          "all"
        ]
      ],
      [
        "-i SC2086",
        [
          "-i",
          "SC2086"
        ]
      ],
      [
        "--include=SC2086",
        [
          "--include=SC2086"
        ]
      ],
      [
        "-P SCRIPTDIR",
        [
          "-P",
          "SCRIPTDIR"
        ]
      ],
      [
        "--source-path=SCRIPTDIR",
        [
          "--source-path=SCRIPTDIR"
        ]
      ],
      [
        "-f gcc",
        [
          "-f",
          "gcc"
        ]
      ],
      [
        "--format gcc",
        [
          "--format",
          "gcc"
        ]
      ],
      [
        "-W 0",
        [
          "-W",
          "0"
        ]
      ],
      [
        "--wiki-link-count 0",
        [
          "--wiki-link-count",
          "0"
        ]
      ],
      [
        "-x -a",
        [
          "-x",
          "-a"
        ]
      ]
    ];
    for (const [flags, expected] of accepted){
      await Deno.writeTextFile(`${root}/${path}`, SHELLCHECK_WORKFLOW(flags));
      const result = await repoShellcheckPolicy(root, [
        path
      ]);
      assert(result.ok, `${flags}: ${result.ok ? "" : result.error}`);
      assertEquals(result.value?.flags, expected, flags);
    }
    const rejected = [
      [
        "-S",
        "missing value for ShellCheck option -S"
      ],
      [
        "--severity",
        "missing value for ShellCheck option --severity"
      ],
      [
        "--severity=",
        "missing value for ShellCheck option --severity"
      ],
      [
        "--enable --norc",
        "missing value for ShellCheck option --enable"
      ],
      [
        "-S warning stray",
        "unsupported positional ShellCheck argument"
      ]
    ];
    for (const [flags, error] of rejected){
      await Deno.writeTextFile(`${root}/${path}`, SHELLCHECK_WORKFLOW(flags));
      const result = await repoShellcheckPolicy(root, [
        path
      ]);
      assertEquals(result.ok, false, flags);
      if (!result.ok) assert(result.error.includes(error), result.error);
    }
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("repoShellcheckPolicy: flagless find and wrapped invocations", async ()=>{
  const root = await Deno.makeTempDir();
  const path = ".github/workflows/check.yml";
  await Deno.mkdir(`${root}/.github/workflows`, {
    recursive: true
  });
  try {
    await Deno.writeTextFile(`${root}/${path}`, SHELLCHECK_WORKFLOW(""));
    const plain = await repoShellcheckPolicy(root, [
      path
    ]);
    assert(plain.ok);
    assertEquals(plain.value?.flags, []);
    for (const command of [
      "git ls-files '*.sh' | xargs shellcheck",
      "find . -print0 | xargs -0 shellcheck",
      'for f in *.sh; do shellcheck "$f"; done',
      "time shellcheck x.sh",
      "exec shellcheck x.sh",
      "nice shellcheck x.sh",
      "timeout 10 shellcheck x.sh",
      "parallel shellcheck ::: x.sh"
    ]){
      await Deno.writeTextFile(`${root}/${path}`, SHELLCHECK_WORKFLOW("").replace('find . -name "*.sh" -type f -exec shellcheck  {} +', command));
      const result = await repoShellcheckPolicy(root, [
        path
      ]);
      assert(!result.ok, command);
    }
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: flagless find checks a changed script", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await commitShellcheckFiles(clone, {
      "run.sh": "#!/bin/sh\ntrue\n"
    }, "");
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: recordingRunner(()=>false, seen)
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(seen.some((command)=>command.includes("shellcheck") && command.includes("run.sh")));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: unrelated workflow changes do not trigger an unsupported policy", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.mkdir(`${clone}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${clone}/.github/workflows/shellcheck.yml`, "jobs:\n  lint:\n    steps:\n      - uses: example/shellcheck-action@v1\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "unsupported policy");
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.writeTextFile(`${clone}/.github/workflows/rust.yml`, "name: Rust\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "unrelated workflow");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      findShellcheck: ()=>Promise.resolve(null),
      runner: recordingRunner(()=>false, [])
    });
    assert(result.ok, result.ok ? "" : result.error.message);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: a synced ludeeus workflow plans --severity for a changed script", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.mkdir(`${clone}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${clone}/.github/workflows/shellcheck.yml`, SYNCED_SHELLCHECK_WORKFLOW);
    await Deno.writeTextFile(`${clone}/run.sh`, "#!/bin/sh\ntrue\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "synced workflow and a script");
    const seen = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      // A host ShellCheck of any version satisfies an action-managed policy.
      ...stubShellcheck("7.7.7"),
      runner: recordingRunner(()=>false, seen)
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assert(seen.some((command)=>command.includes("--severity=warning") && command.includes("run.sh")), seen.join("\n"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
for (const [label, workflow] of [
  [
    "the worker's synced ludeeus template",
    SYNCED_SHELLCHECK_WORKFLOW
  ],
  [
    "an unsupported ShellCheck action",
    "jobs:\n  lint:\n    steps:\n      - uses: example/shellcheck-action@v1\n"
  ],
  [
    "a delegating script",
    "jobs:\n  lint:\n    steps:\n      - run: ./quality.sh\n"
  ]
]){
  Deno.test(`runPrePushGate: a non-shell push is not refused in a repo with ${label}`, async ()=>{
    const { root, clone } = await makeRepoWithDocCommit();
    try {
      await git(clone, "push", "-q", "origin", "HEAD:main");
      await Deno.mkdir(`${clone}/.github/workflows`, {
        recursive: true
      });
      await Deno.writeTextFile(`${clone}/.github/workflows/shellcheck.yml`, workflow);
      await Deno.writeTextFile(`${clone}/quality.sh`, "#!/bin/bash\nshellcheck *.sh\n");
      await git(clone, "add", "-A");
      await git(clone, "commit", "-qm", "add the workflow");
      await git(clone, "push", "-q", "origin", "HEAD:main");
      await Deno.writeTextFile(`${clone}/notes.txt`, "not a script\n");
      await Deno.writeTextFile(`${clone}/lib.rs`, "fn main() {}\n");
      await Deno.writeTextFile(`${clone}/Dockerfile`, "FROM alpine\n");
      await git(clone, "add", "-A");
      await git(clone, "commit", "-qm", "non-shell change");
      const seen = [];
      const result = await runPrePushGate({
        cwd: clone,
        stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
        preFlightCommands: [],
        // No ShellCheck on the host: a non-shell push must not look for it.
        findShellcheck: ()=>Promise.resolve(null),
        runner: recordingRunner(()=>false, seen)
      });
      assert(result.ok, result.ok ? "" : result.error.message);
      assert(!seen.some((command)=>command.includes("shellcheck")));
      await git(clone, "push", "-q", "origin", "HEAD:main");
      await Deno.writeTextFile(`${clone}/script`, "#!/bin/bash\necho $1\n", {
        mode: 0o755
      });
      await git(clone, "add", "script");
      await git(clone, "commit", "-qm", "shell script");
      const shellResult = await runPrePushGate({
        cwd: clone,
        stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
        preFlightCommands: [],
        findShellcheck: ()=>Promise.resolve(null),
        runner: recordingRunner(()=>false, [])
      });
      assert(!shellResult.ok);
    } finally{
      await Deno.remove(root, {
        recursive: true
      });
    }
  });
}
Deno.test("runPrePushGate: an unsupported ShellCheck workflow still refuses a script push", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    await Deno.mkdir(`${clone}/.github/workflows`, {
      recursive: true
    });
    await Deno.writeTextFile(`${clone}/.github/workflows/shellcheck.yml`, "jobs:\n  lint:\n    steps:\n      - uses: example/shellcheck-action@v1\n");
    await Deno.writeTextFile(`${clone}/run.sh`, "#!/bin/sh\ntrue\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "script");
    const result = await runPrePushGate({
      cwd: clone,
      stdin: prePushInput(await git(clone, "rev-parse", "HEAD")),
      preFlightCommands: [],
      ...stubShellcheck()
    });
    assert(!result.ok);
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assert(result.error.message.includes("unsupported ShellCheck action"));
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
// ---- deno test: targeted unit tests of changed files (Issue #4930) ---------
const UNIT_TRACKED = [
  "worker/deno/deno.json",
  "worker/deno/lib/foo.ts",
  "worker/deno/tests/foo_test.ts"
];
/** The `deno test` commands planned for a change, with no other checks. */ function denoTestCommands(changed, tracked, denoUnitTestRoots) {
  const result = planChangedFileChecks(changed, tracked, {
    repoRoot: "/r",
    markdownlintBinary: null,
    denoUnitTestRoots
  });
  assert(result.ok);
  return result.value.filter((c)=>c.label.startsWith("deno test")).map((c)=>c.command);
}
Deno.test("planChangedFileChecks: a changed source runs its same-named tracked test via test:unit (#4930)", ()=>{
  const result = planChangedFileChecks([
    "worker/deno/lib/foo.ts"
  ], UNIT_TRACKED, {
    repoRoot: "/r",
    markdownlintBinary: null,
    denoUnitTestRoots: [
      "worker/deno"
    ]
  });
  assert(result.ok);
  assertEquals(result.value.map((c)=>c.label), [
    "deno fmt (worker/deno)",
    "deno lint (worker/deno)",
    "deno test (worker/deno)"
  ]);
  assertEquals(result.value[2], {
    label: "deno test (worker/deno)",
    cwd: "/r/worker/deno",
    command: "deno task test:unit 'tests/foo_test.ts'"
  });
});
Deno.test("planChangedFileChecks: changed tests and sources map to one sorted, deduplicated test:unit list (#4930)", ()=>{
  const tracked = [
    ...UNIT_TRACKED,
    "worker/deno/tests/bar_test.ts"
  ];
  assertEquals(denoTestCommands([
    "worker/deno/lib/foo.ts",
    "worker/deno/tests/foo_test.ts",
    "worker/deno/tests/bar_test.ts"
  ], tracked, [
    "worker/deno"
  ]), [
    "deno task test:unit 'tests/bar_test.ts' 'tests/foo_test.ts'"
  ]);
  assertEquals(denoTestCommands([
    "worker/deno/tests/foo_test.ts"
  ], UNIT_TRACKED, [
    "worker/deno"
  ]), [
    "deno task test:unit 'tests/foo_test.ts'"
  ]);
});
Deno.test("planChangedFileChecks: no deno test check for an unlisted root, an untested source, a deleted test or docs (#4930)", ()=>{
  // Root not in denoUnitTestRoots (and none passed at all).
  assertEquals(denoTestCommands([
    "worker/deno/lib/foo.ts"
  ], UNIT_TRACKED), []);
  assertEquals(denoTestCommands([
    "worker/deno/lib/foo.ts"
  ], UNIT_TRACKED, [
    "other"
  ]), []);
  // Changed source with no tracked same-named test.
  assertEquals(denoTestCommands([
    "worker/deno/lib/bar.ts"
  ], UNIT_TRACKED, [
    "worker/deno"
  ]), []);
  // Changed test that is no longer tracked (deleted).
  assertEquals(denoTestCommands([
    "worker/deno/tests/foo_test.ts"
  ], [
    "worker/deno/deno.json",
    "worker/deno/lib/foo.ts"
  ], [
    "worker/deno"
  ]), []);
  // Markdown-only change.
  assertEquals(denoTestCommands([
    "worker/deno/README.md"
  ], UNIT_TRACKED, [
    "worker/deno"
  ]), []);
});
Deno.test("loadDenoUnitTestRoots: a root counts only when its config defines test:unit (#4930)", async ()=>{
  const root = await Deno.makeTempDir({
    prefix: "vibe-unit-roots-"
  });
  try {
    const write = async (dir, name, text)=>{
      await Deno.mkdir(`${root}/${dir}`, {
        recursive: true
      });
      await Deno.writeTextFile(`${root}/${dir}/${name}`, text);
    };
    await write("runs", "deno.json", JSON.stringify({
      tasks: {
        "test:unit": "x"
      }
    }));
    await write("no-task", "deno.json", JSON.stringify({
      tasks: {
        test: "x"
      }
    }));
    await write("broken", "deno.json", "{ not json");
    await write("jsonc", "deno.jsonc", '{\n  // JSONC comment\n  "tasks": { "test:unit": "x" }\n}\n');
    // deno.json is preferred, so a test:unit only in deno.jsonc does not count.
    await write("prefers-json", "deno.json", JSON.stringify({
      tasks: {}
    }));
    await write("prefers-json", "deno.jsonc", '{ "tasks": { "test:unit": "x" } }\n');
    const tracked = [
      "runs/deno.json",
      "no-task/deno.json",
      "broken/deno.json",
      "jsonc/deno.jsonc",
      "prefers-json/deno.json",
      "prefers-json/deno.jsonc",
      "unreadable/deno.json"
    ];
    assertEquals(await loadDenoUnitTestRoots(root, tracked), [
      "jsonc",
      "runs"
    ]);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
Deno.test("runPrePushGate: a changed test runs the repo's test:unit task, and its failure blocks the push (#4930)", async ()=>{
  const { root, clone } = await makeRepoWithDocCommit();
  try {
    await git(clone, "push", "-q", "origin", "HEAD:main");
    // Drop the root deno.json so the nested worker/deno root is the outermost.
    await git(clone, "rm", "-q", "deno.json");
    await Deno.mkdir(`${clone}/worker/deno/lib`, {
      recursive: true
    });
    await Deno.mkdir(`${clone}/worker/deno/tests`, {
      recursive: true
    });
    await Deno.writeTextFile(`${clone}/worker/deno/deno.json`, JSON.stringify({
      tasks: {
        "test:unit": "deno run unit_test_runner.ts"
      }
    }) + "\n");
    await Deno.writeTextFile(`${clone}/worker/deno/lib/foo.ts`, "export const x = 1;\n");
    await Deno.writeTextFile(`${clone}/worker/deno/tests/foo_test.ts`, "export {};\n");
    await git(clone, "add", "-A");
    await git(clone, "commit", "-qm", "source, test and test:unit task");
    const stdin = prePushInput(await git(clone, "rev-parse", "HEAD"));
    const command = "deno task test:unit 'tests/foo_test.ts'";
    const ran = [];
    const runnerFor = (failUnit)=>(cmd, options)=>{
        ran.push({
          command: cmd,
          cwd: options.cwd
        });
        const failed = failUnit && cmd === command;
        return Promise.resolve({
          started: true,
          code: failed ? 1 : 0,
          stdout: "",
          stderr: failed ? "boom" : ""
        });
      };
    const passed = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: runnerFor(false)
    });
    assert(passed.ok, passed.ok ? "" : passed.error.message);
    assert(passed.value.checksRun.includes(command));
    assertEquals(ran.find((r)=>r.command === command)?.cwd, `${clone}/worker/deno`);
    const blocked = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      ...stubShellcheck(),
      runner: runnerFor(true)
    });
    assert(!blocked.ok);
    assertInstanceOf(blocked.error, PreFlightGateError);
    assertEquals(blocked.error.command, command);
  } finally{
    await Deno.remove(root, {
      recursive: true
    });
  }
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL3Rlc3RzL3ByZV9wdXNoX2dhdGVfdGVzdC50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFRlc3RzIGZvciB0aGUgcHJlLXB1c2ggZ2F0ZSAoSXNzdWUgIzMzOTQpLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQge1xuICBhc3NlcnQsXG4gIGFzc2VydEVxdWFscyxcbiAgYXNzZXJ0SW5zdGFuY2VPZixcbiAgYXNzZXJ0U3RyaW5nSW5jbHVkZXMsXG59IGZyb20gXCJAc3RkL2Fzc2VydFwiO1xuaW1wb3J0IHsgV09SS0ZMT1dfU1BFQ1MgfSBmcm9tIFwiLi4vbGliL3dvcmtmbG93X2RlZmluaXRpb25zLnRzXCI7XG5pbXBvcnQge1xuICBjcmVhdGVSZXBvRm9ybWF0dGVyRGVwcyxcbiAgZm9ybWF0QnJhbmNoQ2hhbmdlcyxcbn0gZnJvbSBcIi4uL2xpYi9yZXBvX2Zvcm1hdHRlcnMudHNcIjtcbmltcG9ydCB7XG4gIGRlZmF1bHRQcmVQdXNoR2l0LFxuICBsaXN0UHVzaGVkRmlsZXMsXG4gIGxvYWREZW5vVW5pdFRlc3RSb290cyxcbiAgcGFyc2VQcmVQdXNoUmVmcyxcbiAgcGxhbkNoYW5nZWRGaWxlQ2hlY2tzLFxuICBQcmVQdXNoR2F0ZUluZnJhc3RydWN0dXJlRXJyb3IsXG4gIHR5cGUgUHJlUHVzaEdpdCxcbiAgcmVwb0NpUnVuc0NzcGVsbCxcbiAgcmVwb1NoZWxsY2hlY2tQb2xpY3ksXG4gIHJ1bkFmZmVjdGVkU2hlbGxjaGVja0NoZWNrcyxcbiAgcnVuUHJlUHVzaEdhdGUsXG4gIHdvcmtmbG93UnVuc0NzcGVsbCxcbn0gZnJvbSBcIi4uL2xpYi9wcmVfcHVzaF9nYXRlLnRzXCI7XG5pbXBvcnQge1xuICBQcmVGbGlnaHRHYXRlRXJyb3IsXG4gIHR5cGUgUHJlRmxpZ2h0UnVubmVyLFxufSBmcm9tIFwiLi4vbGliL3ByZV9mbGlnaHRfZ2F0ZS50c1wiO1xuaW1wb3J0IHtcbiAgU1RVQl9TSEVMTENIRUNLX1ZFUlNJT04sXG4gIHN0dWJTaGVsbGNoZWNrLFxufSBmcm9tIFwiLi9zdXBwb3J0L3NoZWxsY2hlY2tfc3VwcG9ydC50c1wiO1xuXG5jb25zdCBTSEFfQSA9IFwiYVwiLnJlcGVhdCg0MCk7XG5jb25zdCBTSEFfQiA9IFwiYlwiLnJlcGVhdCg0MCk7XG5jb25zdCBaRVJPID0gXCIwXCIucmVwZWF0KDQwKTtcblxuRGVuby50ZXN0KFwiU2hlbGxDaGVjayBwb2xpY3kgYm91bmRzIHdvcmtmbG93IGFuZCBkZWxlZ2F0ZWQgc2NyaXB0IHJlYWRzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdCA9IGF3YWl0IERlbm8ubWFrZVRlbXBEaXIoKTtcbiAgY29uc3QgcGF0aCA9IFwiLmdpdGh1Yi93b3JrZmxvd3MvY2hlY2sueW1sXCI7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtyb290fS8uZ2l0aHViL3dvcmtmbG93c2AsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtyb290fS9vdXRzaWRlYCwgU0hFTExDSEVDS19XT1JLRkxPVyhcIlwiKSk7XG4gICAgYXdhaXQgRGVuby5zeW1saW5rKGAke3Jvb3R9L291dHNpZGVgLCBgJHtyb290fS8ke3BhdGh9YCk7XG4gICAgYXNzZXJ0RXF1YWxzKGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoXSksIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IG51bGwsXG4gICAgfSk7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUoYCR7cm9vdH0vJHtwYXRofWApO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtyb290fS8ke3BhdGh9YCwgXCJ4XCIucmVwZWF0KDEwMjQgKiAxMDI0ICsgMSkpO1xuICAgIGFzc2VydCghKGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoXSkpLm9rKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtyb290fS8ke3BhdGh9YCxcbiAgICAgIFwiam9iczpcXG4gIGxpbnQ6XFxuICAgIHN0ZXBzOlxcbiAgICAgIC0gcnVuOiAuL2NoZWNrLnNoXFxuXCIsXG4gICAgKTtcbiAgICBhd2FpdCBEZW5vLnN5bWxpbmsoYCR7cm9vdH0vb3V0c2lkZWAsIGAke3Jvb3R9L2NoZWNrLnNoYCk7XG4gICAgYXNzZXJ0KCEoYXdhaXQgcmVwb1NoZWxsY2hlY2tQb2xpY3kocm9vdCwgW3BhdGgsIFwiY2hlY2suc2hcIl0pKS5vayk7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUoYCR7cm9vdH0vY2hlY2suc2hgKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7cm9vdH0vY2hlY2suc2hgLCBcInhcIi5yZXBlYXQoMTAyNCAqIDEwMjQgKyAxKSk7XG4gICAgYXNzZXJ0KCEoYXdhaXQgcmVwb1NoZWxsY2hlY2tQb2xpY3kocm9vdCwgW3BhdGgsIFwiY2hlY2suc2hcIl0pKS5vayk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJ1bnN1cHBvcnRlZCBTaGVsbENoZWNrIHBvbGljeSBpZ25vcmVzIERvY2tlcmZpbGUgYnV0IGJsb2NrcyBleGVjdXRhYmxlIHNoZWxsIHNoZWJhbmdcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByb290ID0gYXdhaXQgRGVuby5tYWtlVGVtcERpcigpO1xuICBjb25zdCBwYXRoID0gXCIuZ2l0aHViL3dvcmtmbG93cy9jaGVjay55bWxcIjtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLm1rZGlyKGAke3Jvb3R9Ly5naXRodWIvd29ya2Zsb3dzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7cm9vdH0vJHtwYXRofWAsXG4gICAgICBcImpvYnM6XFxuICBsaW50OlxcbiAgICBzdGVwczpcXG4gICAgICAtIHVzZXM6IHVua25vd24vc2hlbGxjaGVja0B2MVxcblwiLFxuICAgICk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3Jvb3R9L0RvY2tlcmZpbGVgLCBcIkZST00gYWxwaW5lXFxuXCIpO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtyb290fS9zY3JpcHRgLCBcIiMhL2Jpbi9iYXNoXFxuZWNobyAkMVxcblwiLCB7XG4gICAgICBtb2RlOiAwbzc1NSxcbiAgICB9KTtcbiAgICBjb25zdCB0cmFja2VkID0gW3BhdGgsIFwiRG9ja2VyZmlsZVwiLCBcInNjcmlwdFwiXTtcbiAgICBhc3NlcnQoXG4gICAgICAoYXdhaXQgcnVuQWZmZWN0ZWRTaGVsbGNoZWNrQ2hlY2tzKHtcbiAgICAgICAgY3dkOiByb290LFxuICAgICAgICBjaGFuZ2VkOiBbXCJEb2NrZXJmaWxlXCJdLFxuICAgICAgICB0cmFja2VkLFxuICAgICAgfSkpLm9rLFxuICAgICk7XG4gICAgYXNzZXJ0KFxuICAgICAgIShhd2FpdCBydW5BZmZlY3RlZFNoZWxsY2hlY2tDaGVja3Moe1xuICAgICAgICBjd2Q6IHJvb3QsXG4gICAgICAgIGNoYW5nZWQ6IFtcInNjcmlwdFwiXSxcbiAgICAgICAgdHJhY2tlZCxcbiAgICAgIH0pKS5vayxcbiAgICApO1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKGAke3Jvb3R9L3NjcmlwdGApO1xuICAgIGFzc2VydChcbiAgICAgIChhd2FpdCBydW5BZmZlY3RlZFNoZWxsY2hlY2tDaGVja3Moe1xuICAgICAgICBjd2Q6IHJvb3QsXG4gICAgICAgIGNoYW5nZWQ6IFtcInNjcmlwdFwiXSxcbiAgICAgICAgdHJhY2tlZCxcbiAgICAgIH0pKS5vayxcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwicGFyc2VQcmVQdXNoUmVmczogdmFsaWQgbGluZSwgYmxhbmsgbGluZXMgaWdub3JlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHBhcnNlUHJlUHVzaFJlZnMoXG4gICAgYFxcbnJlZnMvaGVhZHMvbSAke1NIQV9BfSByZWZzL2hlYWRzL20gJHtTSEFfQn1cXG5cXG5gLFxuICApO1xuICBhc3NlcnQocmVzdWx0Lm9rKTtcbiAgYXNzZXJ0RXF1YWxzKHJlc3VsdC52YWx1ZSwgW3tcbiAgICBsb2NhbFJlZjogXCJyZWZzL2hlYWRzL21cIixcbiAgICBsb2NhbFNoYTogU0hBX0EsXG4gICAgcmVtb3RlUmVmOiBcInJlZnMvaGVhZHMvbVwiLFxuICAgIHJlbW90ZVNoYTogU0hBX0IsXG4gIH1dKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJwYXJzZVByZVB1c2hSZWZzOiBkZWxldGVzIGFyZSBkcm9wcGVkXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcGFyc2VQcmVQdXNoUmVmcyhcbiAgICBgKGRlbGV0ZSkgJHtaRVJPfSByZWZzL2hlYWRzL2dvbmUgJHtTSEFfQn1cXG5gLFxuICApO1xuICBhc3NlcnQocmVzdWx0Lm9rKTtcbiAgYXNzZXJ0RXF1YWxzKHJlc3VsdC52YWx1ZSwgW10pO1xufSk7XG5cbkRlbm8udGVzdChcInBhcnNlUHJlUHVzaFJlZnM6IG1hbGZvcm1lZCBpbnB1dCBmYWlscyBjbG9zZWRcIiwgKCkgPT4ge1xuICBhc3NlcnQoIXBhcnNlUHJlUHVzaFJlZnMoXCJyZWZzL2hlYWRzL20gYWJjIHJlZnMvaGVhZHMvbSBkZWZcIikub2spO1xuICBhc3NlcnQoIXBhcnNlUHJlUHVzaFJlZnMoYHJlZnMvaGVhZHMvbSAke1NIQV9BfSByZWZzL2hlYWRzL21gKS5vayk7XG4gIGFzc2VydCghcGFyc2VQcmVQdXNoUmVmcyhgYSAke1NIQV9BfSBiICR7U0hBX0J9IGV4dHJhYCkub2spO1xufSk7XG5cbkRlbm8udGVzdChcInBsYW5DaGFuZ2VkRmlsZUNoZWNrczogZG9jLW9ubHkgY2hhbmdlIHBsYW5zIGZtdCBhbmQgbWFya2Rvd25saW50LCBubyBsaW50XCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcGxhbkNoYW5nZWRGaWxlQ2hlY2tzKFxuICAgIFtcIlJFQURNRS5tZFwiXSxcbiAgICBbXCJkZW5vLmpzb25cIiwgXCIubWFya2Rvd25saW50LWNsaTIuanNvbmNcIiwgXCJSRUFETUUubWRcIl0sXG4gICAgeyByZXBvUm9vdDogXCIvclwiLCBtYXJrZG93bmxpbnRCaW5hcnk6IFwiL3Ivbm9kZV9tb2R1bGVzLy5iaW4vbWRsXCIgfSxcbiAgKTtcbiAgYXNzZXJ0KHJlc3VsdC5vayk7XG4gIGNvbnN0IGNvbW1hbmRzID0gcmVzdWx0LnZhbHVlLm1hcCgoYykgPT4gYy5jb21tYW5kKTtcbiAgYXNzZXJ0RXF1YWxzKGNvbW1hbmRzLCBbXG4gICAgXCJkZW5vIGZtdCAtLWNoZWNrIC0tcGVybWl0LW5vLWZpbGVzICdSRUFETUUubWQnXCIsXG4gICAgXCInL3Ivbm9kZV9tb2R1bGVzLy5iaW4vbWRsJyAnUkVBRE1FLm1kJ1wiLFxuICBdKTtcbiAgYXNzZXJ0KHJlc3VsdC52YWx1ZS5ldmVyeSgoYykgPT4gYy5jd2QgPT09IFwiL3JcIikpO1xufSk7XG5cbkRlbm8udGVzdChcInBsYW5DaGFuZ2VkRmlsZUNoZWNrczogbmVzdGVkIGRlbm8gcm9vdCB1c2VzIGl0cyBvd24gY3dkIGFuZCByZWxhdGl2ZSBwYXRoc1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHBsYW5DaGFuZ2VkRmlsZUNoZWNrcyhcbiAgICBbXCJzdWIvYS50c1wiLCBcInRvcC5tZFwiXSxcbiAgICBbXCJzdWIvZGVuby5qc29uXCIsIFwic3ViL2EudHNcIl0sXG4gICAgeyByZXBvUm9vdDogXCIvclwiLCBtYXJrZG93bmxpbnRCaW5hcnk6IG51bGwgfSxcbiAgKTtcbiAgYXNzZXJ0KHJlc3VsdC5vayk7XG4gIGFzc2VydEVxdWFscyhyZXN1bHQudmFsdWUubWFwKChjKSA9PiBbYy5jd2QsIGMuY29tbWFuZF0pLCBbXG4gICAgW1wiL3Ivc3ViXCIsIFwiZGVubyBmbXQgLS1jaGVjayAtLXBlcm1pdC1uby1maWxlcyAnYS50cydcIl0sXG4gICAgW1wiL3Ivc3ViXCIsIFwiZGVubyBsaW50IC0tcGVybWl0LW5vLWZpbGVzICdhLnRzJ1wiXSxcbiAgXSk7XG59KTtcblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBjYXJnbyBmbXQgd2hlbiBhIC5ycyBmaWxlIGNoYW5nZXNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoW1wiY3JhdGUvc3JjL2xpYi5yc1wiXSwgW1xuICAgIFwiY3JhdGUvQ2FyZ28udG9tbFwiLFxuICBdLCB7IHJlcG9Sb290OiBcIi9yXCIsIG1hcmtkb3dubGludEJpbmFyeTogbnVsbCB9KTtcbiAgYXNzZXJ0KHJlc3VsdC5vayk7XG4gIGFzc2VydEVxdWFscyhyZXN1bHQudmFsdWUubWFwKChjKSA9PiBbYy5jd2QsIGMuY29tbWFuZF0pLCBbXG4gICAgW1wiL3IvY3JhdGVcIiwgXCJjYXJnbyBmbXQgLS1hbGwgLS1jaGVja1wiXSxcbiAgXSk7XG59KTtcblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBhIENhcmdvIHJvb3Qgd2l0aCBubyBjaGFuZ2VkIC5ycyBmaWxlIGdldHMgbm8gY2FyZ28gZm10XCIsICgpID0+IHtcbiAgY29uc3QgdHJhY2tlZCA9IFtcIkNhcmdvLnRvbWxcIiwgXCJzcmMvbGliLnJzXCIsIFwiUkVBRE1FLm1kXCJdO1xuICBjb25zdCBvcHRzID0geyByZXBvUm9vdDogXCIvclwiLCBtYXJrZG93bmxpbnRCaW5hcnk6IG51bGwgfTtcbiAgY29uc3QgdW50b3VjaGVkID0gcGxhbkNoYW5nZWRGaWxlQ2hlY2tzKFtcIlJFQURNRS5tZFwiXSwgdHJhY2tlZCwgb3B0cyk7XG4gIGFzc2VydCh1bnRvdWNoZWQub2spO1xuICBhc3NlcnQodW50b3VjaGVkLnZhbHVlLmV2ZXJ5KChjKSA9PiAhYy5jb21tYW5kLmluY2x1ZGVzKFwiY2FyZ29cIikpKTtcbiAgY29uc3QgdG91Y2hlZCA9IHBsYW5DaGFuZ2VkRmlsZUNoZWNrcyhbXCJzcmMvbGliLnJzXCJdLCB0cmFja2VkLCBvcHRzKTtcbiAgYXNzZXJ0KHRvdWNoZWQub2spO1xuICBhc3NlcnQodG91Y2hlZC52YWx1ZS5zb21lKChjKSA9PiBjLmNvbW1hbmQgPT09IFwiY2FyZ28gZm10IC0tYWxsIC0tY2hlY2tcIikpO1xufSk7XG5cbkRlbm8udGVzdChcInBsYW5DaGFuZ2VkRmlsZUNoZWNrczogbWFya2Rvd25saW50IGNvbmZpZ3VyZWQgYnV0IGJpbmFyeSBtaXNzaW5nIGlzIGFuIGVycm9yXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcGxhbkNoYW5nZWRGaWxlQ2hlY2tzKFtcImEubWRcIl0sIFtcIi5tYXJrZG93bmxpbnQtY2xpMi5qc29uY1wiXSwge1xuICAgIHJlcG9Sb290OiBcIi9yXCIsXG4gICAgbWFya2Rvd25saW50QmluYXJ5OiBudWxsLFxuICB9KTtcbiAgYXNzZXJ0KCFyZXN1bHQub2spO1xuICBhc3NlcnQocmVzdWx0LmVycm9yLmluY2x1ZGVzKFwiY291bGQgbm90IGJlIGZvdW5kXCIpKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJwbGFuQ2hhbmdlZEZpbGVDaGVja3M6IG5vIG1hcmtkb3dubGludCBjb25maWcgbWVhbnMgbm8gbWFya2Rvd25saW50IGNoZWNrXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcGxhbkNoYW5nZWRGaWxlQ2hlY2tzKFtcImEubWRcIl0sIFtcImRlbm8uanNvblwiXSwge1xuICAgIHJlcG9Sb290OiBcIi9yXCIsXG4gICAgbWFya2Rvd25saW50QmluYXJ5OiBudWxsLFxuICB9KTtcbiAgYXNzZXJ0KHJlc3VsdC5vayk7XG4gIGFzc2VydEVxdWFscyhyZXN1bHQudmFsdWUubGVuZ3RoLCAxKTtcbiAgYXNzZXJ0KHJlc3VsdC52YWx1ZVswXSEuY29tbWFuZC5zdGFydHNXaXRoKFwiZGVubyBmbXRcIikpO1xufSk7XG5cbkRlbm8udGVzdChcInBsYW5DaGFuZ2VkRmlsZUNoZWNrczogdW5xdW90YWJsZSBwYXRoIGlzIGFuIGVycm9yIG5hbWluZyB0aGUgZmlsZVwiLCAoKSA9PiB7XG4gIGNvbnN0IG5hbWUgPSBgd2UnaXJkXCJuYW1lLnRzYDtcbiAgY29uc3QgcmVzdWx0ID0gcGxhbkNoYW5nZWRGaWxlQ2hlY2tzKFtuYW1lXSwgW1wiZGVuby5qc29uXCJdLCB7XG4gICAgcmVwb1Jvb3Q6IFwiL3JcIixcbiAgICBtYXJrZG93bmxpbnRCaW5hcnk6IG51bGwsXG4gIH0pO1xuICBhc3NlcnQoIXJlc3VsdC5vayk7XG4gIGFzc2VydChyZXN1bHQuZXJyb3IuaW5jbHVkZXMoXCJ3ZSdpcmRcIikpO1xufSk7XG5cbkRlbm8udGVzdChcInBsYW5DaGFuZ2VkRmlsZUNoZWNrczogZmlsZXMgb3V0c2lkZSB0aGUgZGVubyBmbXQvbGludCBpbmNsdWRlIGFyZSBub3QgY2hlY2tlZFwiLCAoKSA9PiB7XG4gIGNvbnN0IGRlbm9TY29wZXMgPSB7XG4gICAgXCIuXCI6IHsgZm10OiB7IGluY2x1ZGU6IFtcInNyYy9cIl0gfSwgbGludDogeyBpbmNsdWRlOiBbXCJzcmMvXCJdIH0gfSxcbiAgfTtcbiAgY29uc3Qgb3B0cyA9IHsgcmVwb1Jvb3Q6IFwiL3JcIiwgbWFya2Rvd25saW50QmluYXJ5OiBudWxsLCBkZW5vU2NvcGVzIH07XG4gIGNvbnN0IG91dE9mU2NvcGUgPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoXG4gICAgW1wiUkVBRE1FLm1kXCIsIFwic2NyaXB0cy94LnRzXCJdLFxuICAgIFtcImRlbm8uanNvblwiLCBcIlJFQURNRS5tZFwiXSxcbiAgICBvcHRzLFxuICApO1xuICBhc3NlcnQob3V0T2ZTY29wZS5vayk7XG4gIGFzc2VydEVxdWFscyhvdXRPZlNjb3BlLnZhbHVlLCBbXSk7XG5cbiAgY29uc3QgbWl4ZWQgPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoXG4gICAgW1wiUkVBRE1FLm1kXCIsIFwic3JjL2EudHNcIl0sXG4gICAgW1wiZGVuby5qc29uXCJdLFxuICAgIG9wdHMsXG4gICk7XG4gIGFzc2VydChtaXhlZC5vayk7XG4gIGFzc2VydEVxdWFscyhtaXhlZC52YWx1ZS5tYXAoKGMpID0+IGMuY29tbWFuZCksIFtcbiAgICBcImRlbm8gZm10IC0tY2hlY2sgLS1wZXJtaXQtbm8tZmlsZXMgJ3NyYy9hLnRzJ1wiLFxuICAgIFwiZGVubyBsaW50IC0tcGVybWl0LW5vLWZpbGVzICdzcmMvYS50cydcIixcbiAgXSk7XG59KTtcblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBhbiBpbmNsdWRlIG9mIHRoZSBjb25maWcgZGlyZWN0b3J5IHN0aWxsIHBsYW5zIGRlbm8gZm10IGFuZCBsaW50XCIsICgpID0+IHtcbiAgZm9yIChjb25zdCBlbnRyeSBvZiBbXCIuXCIsIFwiLi9cIl0pIHtcbiAgICBjb25zdCByZXN1bHQgPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoXG4gICAgICBbXCJSRUFETUUubWRcIiwgXCJzcmMvYS50c1wiXSxcbiAgICAgIFtcImRlbm8uanNvblwiXSxcbiAgICAgIHtcbiAgICAgICAgcmVwb1Jvb3Q6IFwiL3JcIixcbiAgICAgICAgbWFya2Rvd25saW50QmluYXJ5OiBudWxsLFxuICAgICAgICBkZW5vU2NvcGVzOiB7XG4gICAgICAgICAgXCIuXCI6IHsgZm10OiB7IGluY2x1ZGU6IFtlbnRyeV0gfSwgbGludDogeyBpbmNsdWRlOiBbZW50cnldIH0gfSxcbiAgICAgICAgfSxcbiAgICAgIH0sXG4gICAgKTtcbiAgICBhc3NlcnQocmVzdWx0Lm9rKTtcbiAgICBhc3NlcnRFcXVhbHMocmVzdWx0LnZhbHVlLm1hcCgoYykgPT4gYy5jb21tYW5kKSwgW1xuICAgICAgXCJkZW5vIGZtdCAtLWNoZWNrIC0tcGVybWl0LW5vLWZpbGVzICdSRUFETUUubWQnICdzcmMvYS50cydcIixcbiAgICAgIFwiZGVubyBsaW50IC0tcGVybWl0LW5vLWZpbGVzICdzcmMvYS50cydcIixcbiAgICBdKTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInBsYW5DaGFuZ2VkRmlsZUNoZWNrczogYSBuZXN0ZWQgcm9vdCBmaWx0ZXJzIGFnYWluc3QgaXRzIG93biBzY29wZSwgcmVsYXRpdmUgdG8gaXRcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoXG4gICAgW1wid29ya2VyL2Rlbm8vbGliL2EudHNcIiwgXCJ3b3JrZXIvZGVuby9SRUFETUUubWRcIl0sXG4gICAgW1wid29ya2VyL2Rlbm8vZGVuby5qc29uXCJdLFxuICAgIHtcbiAgICAgIHJlcG9Sb290OiBcIi9yXCIsXG4gICAgICBtYXJrZG93bmxpbnRCaW5hcnk6IG51bGwsXG4gICAgICBkZW5vU2NvcGVzOiB7IFwid29ya2VyL2Rlbm9cIjogeyBmbXQ6IHsgaW5jbHVkZTogW1wibGliL1wiXSB9IH0gfSxcbiAgICB9LFxuICApO1xuICBhc3NlcnQocmVzdWx0Lm9rKTtcbiAgYXNzZXJ0RXF1YWxzKHJlc3VsdC52YWx1ZS5tYXAoKGMpID0+IGMuY29tbWFuZCksIFtcbiAgICBcImRlbm8gZm10IC0tY2hlY2sgLS1wZXJtaXQtbm8tZmlsZXMgJ2xpYi9hLnRzJ1wiLFxuICAgIFwiZGVubyBsaW50IC0tcGVybWl0LW5vLWZpbGVzICdsaWIvYS50cydcIixcbiAgXSk7XG59KTtcblxuLy8gLS0tLSBydW5QcmVQdXNoR2F0ZSBhZ2FpbnN0IGEgcmVhbCBnaXQgcmVwbyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5jb25zdCBHSVRfRU5WID0gW1wiLWNcIiwgXCJ1c2VyLmVtYWlsPXRAZVwiLCBcIi1jXCIsIFwidXNlci5uYW1lPXRcIl07XG5cbmFzeW5jIGZ1bmN0aW9uIGdpdChjd2Q6IHN0cmluZywgLi4uYXJnczogc3RyaW5nW10pOiBQcm9taXNlPHN0cmluZz4ge1xuICBjb25zdCBvdXQgPSBhd2FpdCBuZXcgRGVuby5Db21tYW5kKFwiZ2l0XCIsIHtcbiAgICBhcmdzOiBbLi4uR0lUX0VOViwgLi4uYXJnc10sXG4gICAgY3dkLFxuICAgIHN0ZG91dDogXCJwaXBlZFwiLFxuICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICB9KS5vdXRwdXQoKTtcbiAgaWYgKG91dC5jb2RlICE9PSAwKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShvdXQuc3RkZXJyKSk7XG4gIH1cbiAgcmV0dXJuIG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShvdXQuc3Rkb3V0KS50cmltKCk7XG59XG5cbi8qKiBCYXJlIHJlbW90ZSArIGNsb25lIHdpdGggYSBwdXNoZWQgaW5pdGlhbCBjb21taXQsIHRoZW4gb25lIGxvY2FsIGRvYyBjb21taXQuICovXG5hc3luYyBmdW5jdGlvbiBtYWtlUmVwb1dpdGhEb2NDb21taXQoKTogUHJvbWlzZTxcbiAgeyByb290OiBzdHJpbmc7IGNsb25lOiBzdHJpbmc7IHN0ZGluOiBzdHJpbmcgfVxuPiB7XG4gIGNvbnN0IHJvb3QgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRGlyKHsgcHJlZml4OiBcInZpYmUtcHAtZ2F0ZS1cIiB9KTtcbiAgY29uc3QgcmVtb3RlID0gYCR7cm9vdH0vcmVtb3RlLmdpdGA7XG4gIGNvbnN0IGNsb25lID0gYCR7cm9vdH0vY2xvbmVgO1xuICBhd2FpdCBnaXQocm9vdCwgXCJpbml0XCIsIFwiLXFcIiwgXCItLWJhcmVcIiwgXCItYlwiLCBcIm1haW5cIiwgcmVtb3RlKTtcbiAgYXdhaXQgZ2l0KHJvb3QsIFwiY2xvbmVcIiwgXCItcVwiLCByZW1vdGUsIGNsb25lKTtcbiAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Nsb25lfS9kZW5vLmpzb25gLCBcInt9XFxuXCIpO1xuICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9Ly5tYXJrZG93bmxpbnQtY2xpMi5qc29uY2AsIFwie31cXG5cIik7XG4gIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCIuXCIpO1xuICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwiaW5pdFwiKTtcbiAgYXdhaXQgZ2l0KGNsb25lLCBcInB1c2hcIiwgXCItcVwiLCBcIm9yaWdpblwiLCBcIkhFQUQ6bWFpblwiKTtcbiAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Nsb25lfS9SRUFETUUubWRgLCBcIiNCYWRcXG5cIik7XG4gIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCIuXCIpO1xuICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwiZG9jc1wiKTtcbiAgY29uc3Qgc2hhID0gYXdhaXQgZ2l0KGNsb25lLCBcInJldi1wYXJzZVwiLCBcIkhFQURcIik7XG4gIHJldHVybiB7XG4gICAgcm9vdCxcbiAgICBjbG9uZSxcbiAgICBzdGRpbjogYHJlZnMvaGVhZHMvbWFpbiAke3NoYX0gcmVmcy9oZWFkcy9tYWluICR7XCIwXCIucmVwZWF0KDQwKX1cXG5gLFxuICB9O1xufVxuXG5jb25zdCBTSEVMTENIRUNLX1dPUktGTE9XID0gKFxuICBmbGFnczogc3RyaW5nLFxuICB2ZXJzaW9uID0gU1RVQl9TSEVMTENIRUNLX1ZFUlNJT04sXG4pID0+XG4gIGBqb2JzOlxcbiAgbGludDpcXG4gICAgZW52OlxcbiAgICAgIFNIRUxMQ0hFQ0tfVkVSU0lPTjogXCIke3ZlcnNpb259XCJcXG4gICAgc3RlcHM6XFxuICAgICAgLSBydW46IHxcXG4gICAgICAgICAgZmluZCAuIC1uYW1lIFwiKi5zaFwiIC10eXBlIGYgLWV4ZWMgc2hlbGxjaGVjayAke2ZsYWdzfSB7fSArXFxuYDtcblxuY29uc3QgU1lOQ0VEX1NIRUxMQ0hFQ0tfV09SS0ZMT1cgPVxuICBXT1JLRkxPV19TUEVDUy5maW5kKChzcGVjKSA9PiBzcGVjLmlkID09PSBcInNoZWxsY2hlY2tcIikhLnRlbXBsYXRlO1xuXG5EZW5vLnRlc3QoXCJTaGVsbENoZWNrIGRpc2NvdmVycyBjb250aW51ZWQgY29tbWFuZHMgYW5kIHJlZnVzZXMgaW5kaXJlY3QgaW52b2NhdGlvbnNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByb290ID0gYXdhaXQgRGVuby5tYWtlVGVtcERpcigpO1xuICBjb25zdCBwYXRoID0gXCIuZ2l0aHViL3dvcmtmbG93cy9jaGVjay55bWxcIjtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLm1rZGlyKGAke3Jvb3R9Ly5naXRodWIvd29ya2Zsb3dzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgY29uc3QgY29udGludWVkID0gU0hFTExDSEVDS19XT1JLRkxPVyhcIi1lIFNDMTA5MVwiKS5yZXBsYWNlKFxuICAgICAgXCItdHlwZSBmIC1leGVjXCIsXG4gICAgICBcIi10eXBlIGYgXFxcXFxcbiAgICAgICAgICAtZXhlY1wiLFxuICAgICk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3Jvb3R9LyR7cGF0aH1gLCBjb250aW51ZWQpO1xuICAgIGNvbnN0IHN1cHBvcnRlZCA9IGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoXSk7XG4gICAgYXNzZXJ0KHN1cHBvcnRlZC5vayAmJiBzdXBwb3J0ZWQudmFsdWUgIT09IG51bGwpO1xuICAgIGFzc2VydEVxdWFscyhzdXBwb3J0ZWQudmFsdWUuZmxhZ3MsIFtcIi1lXCIsIFwiU0MxMDkxXCJdKTtcbiAgICBmb3IgKFxuICAgICAgY29uc3QgY29tbWFuZCBvZiBbXG4gICAgICAgIFwiZG9ja2VyIHJ1biAtLXJtIGtvYWxhbWFuL3NoZWxsY2hlY2s6c3RhYmxlIHNjcmlwdHMvKi5zaFwiLFxuICAgICAgICBcImRvY2tlciBydW4gLS1ybSBkb2NrZXIuaW8va29hbGFtYW4vc2hlbGxjaGVjazpzdGFibGUgc2NyaXB0cy94LnNoXCIsXG4gICAgICAgIFwiZG9ja2VyIHJ1biAtLXJtIGtvYWxhbWFuL3NoZWxsY2hlY2tAc2hhMjU2OmFiY2RlZiBzY3JpcHRzL3guc2hcIixcbiAgICAgICAgXCJkb2NrZXIgY29udGFpbmVyIHJ1biAtLXJtIGtvYWxhbWFuL3NoZWxsY2hlY2s6c3RhYmxlIHNjcmlwdHMveC5zaFwiLFxuICAgICAgICBcImJhc2ggLWVjICdzaGVsbGNoZWNrIHNjcmlwdHMveC5zaCdcIixcbiAgICAgICAgXCJiYXNoIC1lIC1jICdzaGVsbGNoZWNrIHNjcmlwdHMveC5zaCdcIixcbiAgICAgICAgXCJiYXNoIC1jICdzaGVsbGNoZWNrIHNjcmlwdHMvKi5zaCdcIixcbiAgICAgIF1cbiAgICApIHtcbiAgICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgICAgYCR7cm9vdH0vJHtwYXRofWAsXG4gICAgICAgIFNIRUxMQ0hFQ0tfV09SS0ZMT1coXCJcIikucmVwbGFjZSgvZmluZCAuKiQvbSwgY29tbWFuZCksXG4gICAgICApO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVwb1NoZWxsY2hlY2tQb2xpY3kocm9vdCwgW3BhdGhdKTtcbiAgICAgIGFzc2VydCghcmVzdWx0Lm9rLCBjb21tYW5kKTtcbiAgICB9XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7cm9vdH0vY2hlY2suc2hgLFxuICAgICAgXCJmaW5kIC4gLW5hbWUgJyouc2gnIC10eXBlIGYgXFxcXFxcbiAtZXhlYyBzaGVsbGNoZWNrIHt9ICtcXG5cIixcbiAgICApO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgIGAke3Jvb3R9LyR7cGF0aH1gLFxuICAgICAgXCJqb2JzOlxcbiAgbGludDpcXG4gICAgc3RlcHM6XFxuICAgICAgLSBydW46IC4vY2hlY2suc2hcXG5cIixcbiAgICApO1xuICAgIGNvbnN0IGRlbGVnYXRlZCA9IGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoLCBcImNoZWNrLnNoXCJdKTtcbiAgICBhc3NlcnQoIWRlbGVnYXRlZC5vayk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJTaGVsbENoZWNrIHNraXBzIHNjcmlwdHMgdW5kZXIgc3ltbGlua2VkIHBhcmVudHMgYW5kIG1pc3NpbmcgZGlyZWN0b3J5IHBhdGhzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtjbG9uZX0vaGApO1xuICAgIGF3YWl0IGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhjbG9uZSwgeyBcImgveC5zaFwiOiBcImVjaG8gb2tcXG5cIiB9KTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwicHVzaFwiLCBcIi1xXCIsIFwib3JpZ2luXCIsIFwiSEVBRDptYWluXCIpO1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKGAke2Nsb25lfS9oYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtyb290fS9vdXRzaWRlYCk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3Jvb3R9L291dHNpZGUveC5zaGAsIFwiZWNobyAkMVxcblwiKTtcbiAgICBhd2FpdCBEZW5vLnN5bWxpbmsoYCR7cm9vdH0vb3V0c2lkZWAsIGAke2Nsb25lfS9oYCk7XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBvcHRzID0ge1xuICAgICAgY3dkOiBjbG9uZSxcbiAgICAgIGNoYW5nZWQ6IFtcImgveC5zaFwiXSxcbiAgICAgIHRyYWNrZWQ6IFtcIi5naXRodWIvd29ya2Zsb3dzL3ZhbGlkYXRlLXNjcmlwdHMueW1sXCIsIFwiaC94LnNoXCJdLFxuICAgICAgLi4uc3R1YlNoZWxsY2hlY2soKSxcbiAgICAgIHJ1bm5lcjogcmVjb3JkaW5nUnVubmVyKCgpID0+IGZhbHNlLCBzZWVuKSxcbiAgICB9O1xuICAgIGNvbnN0IGNoZWNrZWQgPSBhd2FpdCBydW5BZmZlY3RlZFNoZWxsY2hlY2tDaGVja3Mob3B0cyk7XG4gICAgYXNzZXJ0KGNoZWNrZWQub2spO1xuICAgIGFzc2VydEVxdWFscyhzZWVuLCBbXSk7XG4gICAgY29uc3QgcmVjaGVja2VkID0gYXdhaXQgcnVuQWZmZWN0ZWRTaGVsbGNoZWNrQ2hlY2tzKHtcbiAgICAgIC4uLm9wdHMsXG4gICAgICBjaGFuZ2VkOiBbXCIuc2hlbGxjaGVja3JjXCJdLFxuICAgIH0pO1xuICAgIGFzc2VydChyZWNoZWNrZWQub2spO1xuICAgIGFzc2VydEVxdWFscyhzZWVuLCBbXSk7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImFkZFwiLCBcIi1BXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJyZXBsYWNlIGRpcmVjdG9yeSB3aXRoIHN5bWxpbmtcIik7XG4gICAgY29uc3QgcHVzaGVkID0gYXdhaXQgcnVuUHJlUHVzaEdhdGUoe1xuICAgICAgY3dkOiBjbG9uZSxcbiAgICAgIHN0ZGluOiBwcmVQdXNoSW5wdXQoYXdhaXQgZ2l0KGNsb25lLCBcInJldi1wYXJzZVwiLCBcIkhFQURcIikpLFxuICAgICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgICAgLi4uc3R1YlNoZWxsY2hlY2soKSxcbiAgICAgIHJ1bm5lcjogcmVjb3JkaW5nUnVubmVyKCgpID0+IGZhbHNlLCBzZWVuKSxcbiAgICB9KTtcbiAgICBhc3NlcnQocHVzaGVkLm9rLCBwdXNoZWQub2sgPyBcIlwiIDogcHVzaGVkLmVycm9yLm1lc3NhZ2UpO1xuICAgIGFzc2VydEVxdWFscyhzZWVuLCBbXSk7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUoYCR7Y2xvbmV9L2hgKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L2hgLCBcInJlcGxhY2VtZW50XCIpO1xuICAgIGNvbnN0IG1pc3NpbmcgPSBhd2FpdCBydW5BZmZlY3RlZFNoZWxsY2hlY2tDaGVja3Mob3B0cyk7XG4gICAgYXNzZXJ0KG1pc3Npbmcub2spO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCItQVwiKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwicmVwbGFjZSBkaXJlY3Rvcnkgd2l0aCBmaWxlXCIpO1xuICAgIGNvbnN0IHJlcGxhY2VkID0gYXdhaXQgcnVuUHJlUHVzaEdhdGUoe1xuICAgICAgY3dkOiBjbG9uZSxcbiAgICAgIHN0ZGluOiBwcmVQdXNoSW5wdXQoYXdhaXQgZ2l0KGNsb25lLCBcInJldi1wYXJzZVwiLCBcIkhFQURcIikpLFxuICAgICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgICAgLi4uc3R1YlNoZWxsY2hlY2soKSxcbiAgICAgIHJ1bm5lcjogcmVjb3JkaW5nUnVubmVyKCgpID0+IGZhbHNlLCBzZWVuKSxcbiAgICB9KTtcbiAgICBhc3NlcnQocmVwbGFjZWQub2ssIHJlcGxhY2VkLm9rID8gXCJcIiA6IHJlcGxhY2VkLmVycm9yLm1lc3NhZ2UpO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwiU2hlbGxDaGVjayBwb2xpY3kgcmVqZWN0cyBpbmhlcml0ZWQgb3B0aW9ucyBmb3IgYWN0aW9uIGFuZCBmaW5kXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdCA9IGF3YWl0IERlbm8ubWFrZVRlbXBEaXIoKTtcbiAgY29uc3QgcGF0aCA9IFwiLmdpdGh1Yi93b3JrZmxvd3MvY2hlY2sueW1sXCI7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtyb290fS8uZ2l0aHViL3dvcmtmbG93c2AsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGZvciAoXG4gICAgICBjb25zdCBib2R5IG9mIFtcbiAgICAgICAgU1lOQ0VEX1NIRUxMQ0hFQ0tfV09SS0ZMT1cgKyBcIlxcbmVudjpcXG4gIFNIRUxMQ0hFQ0tfT1BUUzogLWUgU0MyMDg2XFxuXCIsXG4gICAgICAgIFNIRUxMQ0hFQ0tfV09SS0ZMT1coXCJcIikucmVwbGFjZShcbiAgICAgICAgICBcIi0gcnVuOiB8XCIsXG4gICAgICAgICAgXCItIGVudjpcXG4gICAgICAgICAgU0hFTExDSEVDS19PUFRTOiAtZSBTQzIwODZcXG4gICAgICAgIHJ1bjogfFwiLFxuICAgICAgICApLFxuICAgICAgXVxuICAgICkge1xuICAgICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3Jvb3R9LyR7cGF0aH1gLCBib2R5KTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoXSk7XG4gICAgICBhc3NlcnQoIXJlc3VsdC5vayk7XG4gICAgICBhc3NlcnQocmVzdWx0LmVycm9yLmluY2x1ZGVzKFwiU0hFTExDSEVDS19PUFRTXCIpKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJTaGVsbENoZWNrIGFjdGlvbiBjaGVja3MgaXRzIHNjcmlwdHMgYW5kIHNraXBzIHN5bWxpbmtzIG9uIGNoYW5nZSBhbmQgcmVjaGVja1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJwdXNoXCIsIFwiLXFcIiwgXCJvcmlnaW5cIiwgXCJIRUFEOm1haW5cIik7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtjbG9uZX0vLmdpdGh1Yi93b3JrZmxvd3NgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtjbG9uZX0vLmdpdGh1Yi93b3JrZmxvd3MvY2hlY2sueW1sYCxcbiAgICAgIFNZTkNFRF9TSEVMTENIRUNLX1dPUktGTE9XLFxuICAgICk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Nsb25lfS91dGlsLmJhc2hgLCBcImVjaG8gJDFcXG5cIik7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7Y2xvbmV9L2RlcGxveWAsXG4gICAgICBcIiMhL3Vzci9iaW4vZW52IGJhc2hcXG5lY2hvICQxXFxuXCIsXG4gICAgICB7IG1vZGU6IDBvNzU1IH0sXG4gICAgKTtcbiAgICBhd2FpdCBEZW5vLmNobW9kKGAke2Nsb25lfS9kZXBsb3lgLCAwbzc1NSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3Jvb3R9L291dHNpZGVgLCBcImVjaG8gJDFcXG5cIik7XG4gICAgYXdhaXQgRGVuby5zeW1saW5rKGAke3Jvb3R9L291dHNpZGVgLCBgJHtjbG9uZX0veC5zaGApO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCItQVwiKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwic2NyaXB0c1wiKTtcbiAgICBjb25zdCB0cmFja2VkID0gW1xuICAgICAgXCIuZ2l0aHViL3dvcmtmbG93cy9jaGVjay55bWxcIixcbiAgICAgIFwidXRpbC5iYXNoXCIsXG4gICAgICBcImRlcGxveVwiLFxuICAgICAgXCJ4LnNoXCIsXG4gICAgXTtcbiAgICBmb3IgKFxuICAgICAgY29uc3QgY2hhbmdlZCBvZiBbW1widXRpbC5iYXNoXCIsIFwiZGVwbG95XCIsIFwieC5zaFwiXSwgW1wiLnNoZWxsY2hlY2tyY1wiXV1cbiAgICApIHtcbiAgICAgIGNvbnN0IHNlZW46IHN0cmluZ1tdID0gW107XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5BZmZlY3RlZFNoZWxsY2hlY2tDaGVja3Moe1xuICAgICAgICBjd2Q6IGNsb25lLFxuICAgICAgICBjaGFuZ2VkLFxuICAgICAgICB0cmFja2VkLFxuICAgICAgICAuLi5zdHViU2hlbGxjaGVjaygpLFxuICAgICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoKSA9PiBmYWxzZSwgc2VlbiksXG4gICAgICB9KTtcbiAgICAgIGFzc2VydChyZXN1bHQub2ssIHJlc3VsdC5vayA/IFwiXCIgOiByZXN1bHQuZXJyb3IubWVzc2FnZSk7XG4gICAgICBhc3NlcnQoc2Vlbi5zb21lKChjKSA9PiBjLmluY2x1ZGVzKFwidXRpbC5iYXNoXCIpKSk7XG4gICAgICBhc3NlcnQoc2Vlbi5zb21lKChjKSA9PiBjLmluY2x1ZGVzKFwiZGVwbG95XCIpKSk7XG4gICAgICBhc3NlcnQoIXNlZW4uc29tZSgoYykgPT4gYy5pbmNsdWRlcyhcInguc2hcIikpKTtcbiAgICB9XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBwdXNoZWQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW46IHByZVB1c2hJbnB1dChhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKSksXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgICAuLi5zdHViU2hlbGxjaGVjaygpLFxuICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoKCkgPT4gZmFsc2UsIHNlZW4pLFxuICAgIH0pO1xuICAgIGFzc2VydChwdXNoZWQub2ssIHB1c2hlZC5vayA/IFwiXCIgOiBwdXNoZWQuZXJyb3IubWVzc2FnZSk7XG4gICAgYXNzZXJ0KHNlZW4uc29tZSgoYykgPT4gYy5pbmNsdWRlcyhcInV0aWwuYmFzaFwiKSkpO1xuICAgIGFzc2VydChzZWVuLnNvbWUoKGMpID0+IGMuaW5jbHVkZXMoXCJkZXBsb3lcIikpKTtcbiAgICBhc3NlcnQoIXNlZW4uc29tZSgoYykgPT4gYy5pbmNsdWRlcyhcInguc2hcIikpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlIHNraXBzIGNvbW1pdHRlZCBzY3JpcHQgc3ltbGlua3Mgb24gY2hhbmdlIGFuZCBjb25maWcgcmVjaGVja1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhjbG9uZSwgeyBcInJlYWwuc2hcIjogXCIjIS9iaW4vc2hcXG5lY2hvIG9rXFxuXCIgfSk7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcInB1c2hcIiwgXCItcVwiLCBcIm9yaWdpblwiLCBcIkhFQUQ6bWFpblwiKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7cm9vdH0vb3V0c2lkZWAsIFwiZWNobyAkMVxcblwiKTtcbiAgICBhd2FpdCBEZW5vLnN5bWxpbmsoYCR7cm9vdH0vb3V0c2lkZWAsIGAke2Nsb25lfS94LnNoYCk7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImFkZFwiLCBcIi1BXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJzeW1saW5rXCIpO1xuICAgIGZvciAoY29uc3QgcmVjaGVjayBvZiBbZmFsc2UsIHRydWVdKSB7XG4gICAgICBpZiAocmVjaGVjaykge1xuICAgICAgICBhd2FpdCBnaXQoY2xvbmUsIFwicHVzaFwiLCBcIi1xXCIsIFwib3JpZ2luXCIsIFwiSEVBRDptYWluXCIpO1xuICAgICAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9Ly5zaGVsbGNoZWNrcmNgLCBcImRpc2FibGU9U0MyMDg2XFxuXCIpO1xuICAgICAgICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLUFcIik7XG4gICAgICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJjb25maWdcIik7XG4gICAgICB9XG4gICAgICBjb25zdCBzZWVuOiBzdHJpbmdbXSA9IFtdO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlUHVzaEdhdGUoe1xuICAgICAgICBjd2Q6IGNsb25lLFxuICAgICAgICBzdGRpbjogcHJlUHVzaElucHV0KGF3YWl0IGdpdChjbG9uZSwgXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCIpKSxcbiAgICAgICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgICAgICAuLi5zdHViU2hlbGxjaGVjaygpLFxuICAgICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoKSA9PiBmYWxzZSwgc2VlbiksXG4gICAgICB9KTtcbiAgICAgIGFzc2VydChyZXN1bHQub2ssIHJlc3VsdC5vayA/IFwiXCIgOiByZXN1bHQuZXJyb3IubWVzc2FnZSk7XG4gICAgICBhc3NlcnQoIXNlZW4uc29tZSgoYykgPT4gYy5pbmNsdWRlcyhcInguc2hcIikpKTtcbiAgICAgIGlmIChyZWNoZWNrKSBhc3NlcnQoc2Vlbi5zb21lKChjKSA9PiBjLmluY2x1ZGVzKFwicmVhbC5zaFwiKSkpO1xuICAgIH1cbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcImxpc3RQdXNoZWRGaWxlczogYSBtZXJnZSBsaXN0cyB0aGUgcGF0aHMgaXQgcmVzb2x2ZWQsIG5ldmVyIHRoZSBmaWxlcyBpdCBicmluZ3MgaW4gZnJvbSB0aGUgYmFzZSAoUFIgIzQ4OTggcmV2aWV3KVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJvb3QgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRGlyKHsgcHJlZml4OiBcInZpYmUtcHAtbWVyZ2UtXCIgfSk7XG4gIHRyeSB7XG4gICAgYXdhaXQgZ2l0KHJvb3QsIFwiaW5pdFwiLCBcIi1xXCIsIFwiLWJcIiwgXCJtYWluXCIpO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtyb290fS9jLnR4dGAsIFwiMVxcblwiKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7cm9vdH0vZGVuby5qc29uYCwgXCJ7fVxcblwiKTtcbiAgICBhd2FpdCBEZW5vLm1rZGlyKGAke3Jvb3R9Ly5naXRodWIvd29ya2Zsb3dzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7cm9vdH0vLmdpdGh1Yi93b3JrZmxvd3MvY2hlY2sueW1sYCxcbiAgICAgIFNZTkNFRF9TSEVMTENIRUNLX1dPUktGTE9XLFxuICAgICk7XG4gICAgYXdhaXQgZ2l0KHJvb3QsIFwiYWRkXCIsIFwiLUFcIik7XG4gICAgYXdhaXQgZ2l0KHJvb3QsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwiaW5pdFwiKTtcbiAgICBhd2FpdCBnaXQocm9vdCwgXCJjaGVja291dFwiLCBcIi1xXCIsIFwiLWJcIiwgXCJmZWF0XCIpO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtyb290fS9jLnR4dGAsIFwiZmVhdFxcblwiKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7cm9vdH0vb3duLnNoYCwgXCIjIS9iaW4vc2hcXG5lY2hvIG9rXFxuXCIpO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtyb290fS9vd24udHNgLCBcImV4cG9ydCBjb25zdCBvd24gPSAxO1xcblwiKTtcbiAgICBhd2FpdCBnaXQocm9vdCwgXCJhZGRcIiwgXCItQVwiKTtcbiAgICBhd2FpdCBnaXQocm9vdCwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJvd24gY2hhbmdlXCIpO1xuICAgIGF3YWl0IGdpdChyb290LCBcImNoZWNrb3V0XCIsIFwiLXFcIiwgXCJtYWluXCIpO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtyb290fS9jLnR4dGAsIFwibWFpblxcblwiKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7cm9vdH0vYmFzZV9iYWQuc2hgLCBcIiMhL2Jpbi9zaFxcbmVjaG8gJDFcXG5cIik7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3Jvb3R9L2Jhc2VfYmFkLnRzYCwgXCJleHBvcnQgY29uc3QgYmFkPTFcXG5cIik7XG4gICAgYXdhaXQgZ2l0KHJvb3QsIFwiYWRkXCIsIFwiLUFcIik7XG4gICAgYXdhaXQgZ2l0KHJvb3QsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwiYmFzZSBtb3ZlcyBvblwiKTtcbiAgICBhd2FpdCBnaXQocm9vdCwgXCJjaGVja291dFwiLCBcIi1xXCIsIFwiZmVhdFwiKTtcbiAgICAvLyBUaGUgbWVyZ2UgY29uZmxpY3RzIG9uIGMudHh0OyB0aGUgcmVzb2x1dGlvbiBpcyB0aGUgbWVyZ2UncyBvd24gY2hhbmdlLlxuICAgIGxldCBjb25mbGljdGVkID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGdpdChyb290LCBcIm1lcmdlXCIsIFwiLS1uby1jb21taXRcIiwgXCJtYWluXCIpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgY29uZmxpY3RlZCA9IHRydWU7XG4gICAgfVxuICAgIGFzc2VydChjb25mbGljdGVkLCBcInRoZSBmaXh0dXJlIG11c3QgY29uZmxpY3Qgb24gYy50eHRcIik7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3Jvb3R9L2MudHh0YCwgXCJyZXNvbHZlZFxcblwiKTtcbiAgICAvLyBBIGZpbGUgb25seSB0aGUgbWVyZ2UgY29tbWl0IGludHJvZHVjZXM6IG5vIG9yZGluYXJ5IGNvbW1pdCBsaXN0cyBpdCwgc29cbiAgICAvLyBpdCBhcHBlYXJzIHNvbGVseSB3aGVuIHRoZSBtZXJnZSdzIG93biBkaWZmIGlzIHJlcXVlc3RlZC5cbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7cm9vdH0vbWVyZ2Vfb25seS5zaGAsIFwiIyEvYmluL3NoXFxuZWNobyBva1xcblwiKTtcbiAgICBhd2FpdCBnaXQocm9vdCwgXCJhZGRcIiwgXCItQVwiKTtcbiAgICBhd2FpdCBnaXQocm9vdCwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJtZXJnZSBtYWluXCIpO1xuICAgIGNvbnN0IGZpbGVzID0gYXdhaXQgbGlzdFB1c2hlZEZpbGVzKFxuICAgICAgW3sgbG9jYWxSZWY6IFwiSEVBRFwiLCBsb2NhbFNoYTogXCJIRUFEXCIsIHJlbW90ZVJlZjogXCJ4XCIsIHJlbW90ZVNoYTogXCIwXCIgfV0sXG4gICAgICByb290LFxuICAgICAgZGVmYXVsdFByZVB1c2hHaXQsXG4gICAgICBcIm1haW5cIixcbiAgICApO1xuICAgIGFzc2VydChmaWxlcy5vayk7XG4gICAgYXNzZXJ0RXF1YWxzKGZpbGVzLnZhbHVlLCBbXCJjLnR4dFwiLCBcIm1lcmdlX29ubHkuc2hcIiwgXCJvd24uc2hcIiwgXCJvd24udHNcIl0pO1xuICAgIGNvbnN0IHNlZW46IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgZ2F0ZSA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICAgIGN3ZDogcm9vdCxcbiAgICAgIHN0ZGluOiBwcmVQdXNoSW5wdXQoYXdhaXQgZ2l0KHJvb3QsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKSksXG4gICAgICBiYXNlUmVmOiBcIm1haW5cIixcbiAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgIC4uLnN0dWJTaGVsbGNoZWNrKCksXG4gICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoY29tbWFuZCkgPT4gY29tbWFuZC5pbmNsdWRlcyhcImJhc2VfYmFkXCIpLCBzZWVuKSxcbiAgICB9KTtcbiAgICBhc3NlcnQoZ2F0ZS5vaywgZ2F0ZS5vayA/IFwiXCIgOiBnYXRlLmVycm9yLm1lc3NhZ2UpO1xuICAgIGFzc2VydChzZWVuLnNvbWUoKGNvbW1hbmQpID0+IGNvbW1hbmQuaW5jbHVkZXMoXCJvd24uc2hcIikpKTtcbiAgICBhc3NlcnQoIXNlZW4uc29tZSgoY29tbWFuZCkgPT4gY29tbWFuZC5pbmNsdWRlcyhcImJhc2VfYmFkXCIpKSk7XG4gICAgY29uc3QgZm9ybWF0dGVkOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IGRlcHMgPSBjcmVhdGVSZXBvRm9ybWF0dGVyRGVwcygpO1xuICAgIGRlcHMucnVuQ29tbWFuZCA9IChjb21tYW5kKSA9PiB7XG4gICAgICBmb3JtYXR0ZWQucHVzaChjb21tYW5kLmpvaW4oXCIgXCIpKTtcbiAgICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBleGl0Q29kZTogMCwgb3V0cHV0OiBcIlwiIH0pO1xuICAgIH07XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZm9ybWF0QnJhbmNoQ2hhbmdlcyhyb290LCBcIm1haW5cIiwgZGVwcyk7XG4gICAgYXNzZXJ0RXF1YWxzKHJlc3VsdC5naXRFcnJvciwgdW5kZWZpbmVkKTtcbiAgICBhc3NlcnQoZm9ybWF0dGVkLnNvbWUoKGNvbW1hbmQpID0+IGNvbW1hbmQuaW5jbHVkZXMoXCJvd24udHNcIikpKTtcbiAgICBhc3NlcnQoIWZvcm1hdHRlZC5zb21lKChjb21tYW5kKSA9PiBjb21tYW5kLmluY2x1ZGVzKFwiYmFzZV9iYWRcIikpKTtcbiAgICBhc3NlcnRFcXVhbHMoXG4gICAgICBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShgJHtyb290fS9iYXNlX2JhZC50c2ApLFxuICAgICAgXCJleHBvcnQgY29uc3QgYmFkPTFcXG5cIixcbiAgICApO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwiU2hlbGxDaGVjayByZWZ1c2VzIGFuIG92ZXJzaXplZCBjb25maWd1cmF0aW9uIHdpdGhvdXQgcmVhZGluZyBpdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhjbG9uZSwgeyBcInJlYWwuc2hcIjogXCIjIS9iaW4vc2hcXG5lY2hvIG9rXFxuXCIgfSk7XG4gICAgY29uc3QgY29uZmlnID0gYXdhaXQgRGVuby5vcGVuKGAke2Nsb25lfS8uc2hlbGxjaGVja3JjYCwge1xuICAgICAgd3JpdGU6IHRydWUsXG4gICAgICBjcmVhdGU6IHRydWUsXG4gICAgfSk7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IGNvbmZpZy50cnVuY2F0ZSgxMDI0ICogMTAyNCArIDEpO1xuICAgIH0gZmluYWxseSB7XG4gICAgICBjb25maWcuY2xvc2UoKTtcbiAgICB9XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5BZmZlY3RlZFNoZWxsY2hlY2tDaGVja3Moe1xuICAgICAgY3dkOiBjbG9uZSxcbiAgICAgIGNoYW5nZWQ6IFtcInJlYWwuc2hcIl0sXG4gICAgICB0cmFja2VkOiBbXG4gICAgICAgIFwiLmdpdGh1Yi93b3JrZmxvd3MvdmFsaWRhdGUtc2NyaXB0cy55bWxcIixcbiAgICAgICAgXCJyZWFsLnNoXCIsXG4gICAgICAgIFwiLnNoZWxsY2hlY2tyY1wiLFxuICAgICAgXSxcbiAgICAgIC4uLnN0dWJTaGVsbGNoZWNrKCksXG4gICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoKSA9PiBmYWxzZSwgc2VlbiksXG4gICAgfSk7XG4gICAgYXNzZXJ0KCFyZXN1bHQub2spO1xuICAgIGFzc2VydFN0cmluZ0luY2x1ZGVzKHJlc3VsdC5lcnJvci5tZXNzYWdlLCBcImV4Y2VlZHMgcG9saWN5IHNpemUgbGltaXRcIik7XG4gICAgYXNzZXJ0RXF1YWxzKHNlZW4sIFtdKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcIlNoZWxsQ2hlY2sgcmVmdXNlcyBhIHN5bWxpbmtlZCBjb25maWd1cmF0aW9uIHdpdGhvdXQgcmVhZGluZyBpdHMgdGFyZ2V0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgY29tbWl0U2hlbGxjaGVja0ZpbGVzKGNsb25lLCB7IFwicmVhbC5zaFwiOiBcIiMhL2Jpbi9zaFxcbmVjaG8gb2tcXG5cIiB9KTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7cm9vdH0vb3V0c2lkZWAsIFwiZGlzYWJsZT1TQzIwODZcXG5cIik7XG4gICAgYXdhaXQgRGVuby5zeW1saW5rKGAke3Jvb3R9L291dHNpZGVgLCBgJHtjbG9uZX0vLnNoZWxsY2hlY2tyY2ApO1xuICAgIGNvbnN0IHNlZW46IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuQWZmZWN0ZWRTaGVsbGNoZWNrQ2hlY2tzKHtcbiAgICAgIGN3ZDogY2xvbmUsXG4gICAgICBjaGFuZ2VkOiBbXCJyZWFsLnNoXCJdLFxuICAgICAgdHJhY2tlZDogW1xuICAgICAgICBcIi5naXRodWIvd29ya2Zsb3dzL3ZhbGlkYXRlLXNjcmlwdHMueW1sXCIsXG4gICAgICAgIFwicmVhbC5zaFwiLFxuICAgICAgICBcIi5zaGVsbGNoZWNrcmNcIixcbiAgICAgIF0sXG4gICAgICAuLi5zdHViU2hlbGxjaGVjaygpLFxuICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoKCkgPT4gZmFsc2UsIHNlZW4pLFxuICAgIH0pO1xuICAgIGFzc2VydCghcmVzdWx0Lm9rKTtcbiAgICBhc3NlcnQocmVzdWx0LmVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoXCJub3QgYSByZWd1bGFyIGZpbGVcIikpO1xuICAgIGFzc2VydEVxdWFscyhzZWVuLCBbXSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJTaGVsbENoZWNrIHJlZnVzZXMgYSBjb25maWd1cmF0aW9uIGJlbG93IGEgc3ltbGlua2VkIGRpcmVjdG9yeVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhcbiAgICAgIGNsb25lLFxuICAgICAgeyBcInJlYWwuc2hcIjogXCJlY2hvIG9rXFxuXCIgfSxcbiAgICAgIFwiLS1yY2ZpbGUgaC9zaGVsbGNoZWNrcmNcIixcbiAgICApO1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7cm9vdH0vb3V0c2lkZWApO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgIGAke3Jvb3R9L291dHNpZGUvc2hlbGxjaGVja3JjYCxcbiAgICAgIFwiZGlzYWJsZT1TQzIwODZcXG5cIixcbiAgICApO1xuICAgIGF3YWl0IERlbm8uc3ltbGluayhgJHtyb290fS9vdXRzaWRlYCwgYCR7Y2xvbmV9L2hgKTtcbiAgICBjb25zdCBzZWVuOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1bkFmZmVjdGVkU2hlbGxjaGVja0NoZWNrcyh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgY2hhbmdlZDogW1wicmVhbC5zaFwiXSxcbiAgICAgIHRyYWNrZWQ6IFtcbiAgICAgICAgXCIuZ2l0aHViL3dvcmtmbG93cy92YWxpZGF0ZS1zY3JpcHRzLnltbFwiLFxuICAgICAgICBcInJlYWwuc2hcIixcbiAgICAgICAgXCJoL3NoZWxsY2hlY2tyY1wiLFxuICAgICAgXSxcbiAgICAgIC4uLnN0dWJTaGVsbGNoZWNrKCksXG4gICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoKSA9PiBmYWxzZSwgc2VlbiksXG4gICAgfSk7XG4gICAgYXNzZXJ0KCFyZXN1bHQub2spO1xuICAgIGFzc2VydChyZXN1bHQuZXJyb3IubWVzc2FnZS5pbmNsdWRlcyhcIm5vdCBhIHJlZ3VsYXIgZmlsZVwiKSk7XG4gICAgYXNzZXJ0RXF1YWxzKHNlZW4sIFtdKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbmFzeW5jIGZ1bmN0aW9uIGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhcbiAgY2xvbmU6IHN0cmluZyxcbiAgZmlsZXM6IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4gIGZsYWdzID0gXCItZSBTQzEwOTEgLWUgU0MyMDM0XCIsXG4gIHZlcnNpb24gPSBTVFVCX1NIRUxMQ0hFQ0tfVkVSU0lPTixcbik6IFByb21pc2U8c3RyaW5nPiB7XG4gIC8vIEtlZXAgdGhlIHVucmVsYXRlZCBkb2MgY29tbWl0IG9uIHRoZSByZW1vdGUgc28gdGhlc2UgZml4dHVyZXMgbmVlZCBvbmx5XG4gIC8vIFNoZWxsQ2hlY2ssIGFzIGluIHRoZSBDSSB0ZXN0IHNoYXJkIHdoaWNoIGRvZXMgbm90IGluc3RhbGwgbWFya2Rvd25saW50LlxuICBhd2FpdCBnaXQoY2xvbmUsIFwicHVzaFwiLCBcIi1xXCIsIFwib3JpZ2luXCIsIFwiSEVBRDptYWluXCIpO1xuICBhd2FpdCBEZW5vLm1rZGlyKGAke2Nsb25lfS8uZ2l0aHViL3dvcmtmbG93c2AsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgYCR7Y2xvbmV9Ly5naXRodWIvd29ya2Zsb3dzL3ZhbGlkYXRlLXNjcmlwdHMueW1sYCxcbiAgICBTSEVMTENIRUNLX1dPUktGTE9XKGZsYWdzLCB2ZXJzaW9uKSxcbiAgKTtcbiAgZm9yIChjb25zdCBbcGF0aCwgY29udGVudHNdIG9mIE9iamVjdC5lbnRyaWVzKGZpbGVzKSkge1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtjbG9uZX0vJHtwYXRofWAsIGNvbnRlbnRzKTtcbiAgfVxuICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLUFcIik7XG4gIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJhZGQgU2hlbGxDaGVjayBwb2xpY3kgYW5kIHNjcmlwdHNcIik7XG4gIHJldHVybiBhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKTtcbn1cblxuZnVuY3Rpb24gcHJlUHVzaElucHV0KHRpcDogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGByZWZzL2hlYWRzL21haW4gJHt0aXB9IHJlZnMvaGVhZHMvbWFpbiAke1pFUk99XFxuYDtcbn1cblxuZnVuY3Rpb24gcmVjb3JkaW5nUnVubmVyKFxuICBmYWlsV2hlbjogKGNvbW1hbmQ6IHN0cmluZykgPT4gYm9vbGVhbixcbiAgc2Vlbjogc3RyaW5nW10sXG4pOiBQcmVGbGlnaHRSdW5uZXIge1xuICByZXR1cm4gKGNvbW1hbmQpID0+IHtcbiAgICBzZWVuLnB1c2goY29tbWFuZCk7XG4gICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7XG4gICAgICBzdGFydGVkOiB0cnVlLFxuICAgICAgY29kZTogZmFpbFdoZW4oY29tbWFuZCkgPyAxIDogMCxcbiAgICAgIHN0ZG91dDogXCJcIixcbiAgICAgIHN0ZGVycjogZmFpbFdoZW4oY29tbWFuZCkgPyBcImJvb21cIiA6IFwiXCIsXG4gICAgfSk7XG4gIH07XG59XG5cbkRlbm8udGVzdChcImxpc3RQdXNoZWRGaWxlczogb25seSBmaWxlcyBpbnRyb2R1Y2VkIGJ5IHVucHVzaGVkIGNvbW1pdHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJvb3QsIGNsb25lLCBzdGRpbiB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgY29uc3QgcmVmcyA9IHBhcnNlUHJlUHVzaFJlZnMoc3RkaW4pO1xuICAgIGFzc2VydChyZWZzLm9rKTtcbiAgICBjb25zdCBmaWxlcyA9IGF3YWl0IGxpc3RQdXNoZWRGaWxlcyhyZWZzLnZhbHVlLCBjbG9uZSwgYXN5bmMgKGEsIGMpID0+IHtcbiAgICAgIGNvbnN0IG91dCA9IGF3YWl0IG5ldyBEZW5vLkNvbW1hbmQoXCJnaXRcIiwge1xuICAgICAgICBhcmdzOiBhLFxuICAgICAgICBjd2Q6IGMsXG4gICAgICAgIHN0ZG91dDogXCJwaXBlZFwiLFxuICAgICAgICBzdGRlcnI6IFwicGlwZWRcIixcbiAgICAgIH0pLm91dHB1dCgpO1xuICAgICAgY29uc3QgZCA9IG5ldyBUZXh0RGVjb2RlcigpO1xuICAgICAgcmV0dXJuIHtcbiAgICAgICAgY29kZTogb3V0LmNvZGUsXG4gICAgICAgIHN0ZG91dDogZC5kZWNvZGUob3V0LnN0ZG91dCksXG4gICAgICAgIHN0ZGVycjogZC5kZWNvZGUob3V0LnN0ZGVyciksXG4gICAgICB9O1xuICAgIH0pO1xuICAgIGFzc2VydChmaWxlcy5vayk7XG4gICAgYXNzZXJ0RXF1YWxzKGZpbGVzLnZhbHVlLCBbXCJSRUFETUUubWRcIl0pO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwibGlzdFB1c2hlZEZpbGVzOiBiYXNlUmVmIGxpc3RzIHB1c2hlZCBjb21taXRzIGFoZWFkIG9mIHRoZSBiYXNlOyBhbiBvcHRpb24tbGlrZSBiYXNlUmVmIGlzIHJlZnVzZWQgKCMzNjg5KVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUsIHN0ZGluIH0gPSBhd2FpdCBtYWtlUmVwb1dpdGhEb2NDb21taXQoKTtcbiAgdHJ5IHtcbiAgICAvLyBNb2RlbCBhIFdJUCBjaGVja3BvaW50IHB1c2g6IG9yaWdpbi9tYWluIG5vdyBob2xkcyB0aGUgZG9jcyBjb21taXQuIEFcbiAgICAvLyByZWYgdXBkYXRlLCBub3QgYSByZWFsIHB1c2gsIHNvIGFuIGFtYmllbnQgcHJlLXB1c2ggaG9vayBjYW5ub3QgcmVmdXNlIGl0LlxuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJ1cGRhdGUtcmVmXCIsIFwicmVmcy9yZW1vdGVzL29yaWdpbi9tYWluXCIsIFwiSEVBRFwiKTtcbiAgICBjb25zdCBpbml0U2hhID0gYXdhaXQgZ2l0KGNsb25lLCBcInJldi1wYXJzZVwiLCBcIkhFQUR+MVwiKTtcbiAgICBjb25zdCByZWZzID0gcGFyc2VQcmVQdXNoUmVmcyhzdGRpbik7XG4gICAgYXNzZXJ0KHJlZnMub2spO1xuICAgIGNvbnN0IHJ1bjogUHJlUHVzaEdpdCA9IGFzeW5jIChhLCBjKSA9PiB7XG4gICAgICBjb25zdCBvdXQgPSBhd2FpdCBuZXcgRGVuby5Db21tYW5kKFwiZ2l0XCIsIHtcbiAgICAgICAgYXJnczogYSxcbiAgICAgICAgY3dkOiBjLFxuICAgICAgICBzdGRvdXQ6IFwicGlwZWRcIixcbiAgICAgICAgc3RkZXJyOiBcInBpcGVkXCIsXG4gICAgICB9KS5vdXRwdXQoKTtcbiAgICAgIGNvbnN0IGQgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIGNvZGU6IG91dC5jb2RlLFxuICAgICAgICBzdGRvdXQ6IGQuZGVjb2RlKG91dC5zdGRvdXQpLFxuICAgICAgICBzdGRlcnI6IGQuZGVjb2RlKG91dC5zdGRlcnIpLFxuICAgICAgfTtcbiAgICB9O1xuICAgIC8vIEFscmVhZHkgb24gb3JpZ2luIChhIFdJUCBjaGVja3BvaW50IHB1c2gpOiB0aGUgZGVmYXVsdCByYW5nZSBpcyBlbXB0eS5cbiAgICBjb25zdCB1bnB1c2hlZE9ubHkgPSBhd2FpdCBsaXN0UHVzaGVkRmlsZXMocmVmcy52YWx1ZSwgY2xvbmUsIHJ1bik7XG4gICAgYXNzZXJ0KHVucHVzaGVkT25seS5vayk7XG4gICAgYXNzZXJ0RXF1YWxzKHVucHVzaGVkT25seS52YWx1ZSwgW10pO1xuICAgIC8vIFRoZSB3aG9sZS1icmFuY2ggcmFuZ2Ugc3RpbGwgc2VlcyBpdC5cbiAgICBjb25zdCBhaGVhZCA9IGF3YWl0IGxpc3RQdXNoZWRGaWxlcyhyZWZzLnZhbHVlLCBjbG9uZSwgcnVuLCBpbml0U2hhKTtcbiAgICBhc3NlcnQoYWhlYWQub2spO1xuICAgIGFzc2VydEVxdWFscyhhaGVhZC52YWx1ZSwgW1wiUkVBRE1FLm1kXCJdKTtcbiAgICBjb25zdCB1bnNhZmUgPSBhd2FpdCBsaXN0UHVzaGVkRmlsZXMocmVmcy52YWx1ZSwgY2xvbmUsIHJ1biwgXCItLWFsbFwiKTtcbiAgICBhc3NlcnQoIXVuc2FmZS5vayk7XG4gICAgYXNzZXJ0KHVuc2FmZS5lcnJvci5pbmNsdWRlcyhcInVuc2FmZSBiYXNlIHJlZlwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJsaXN0UHVzaGVkRmlsZXM6IGEgY29tbWl0dGVkIHN5bWxpbmsgaXMgbm90IGEgcmVndWxhciBmaWxlIGFuZCBpcyBza2lwcGVkXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Nsb25lfS90YXJnZXQubWRgLCBcIiMgVGFyZ2V0XFxuXCIpO1xuICAgIGF3YWl0IERlbm8uc3ltbGluayhcInRhcmdldC5tZFwiLCBgJHtjbG9uZX0vbGluay5tZGApO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCIuXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJzeW1saW5rXCIpO1xuICAgIGNvbnN0IHNoYSA9IGF3YWl0IGdpdChjbG9uZSwgXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCIpO1xuICAgIGNvbnN0IHJlZnMgPSBwYXJzZVByZVB1c2hSZWZzKFxuICAgICAgYHJlZnMvaGVhZHMvbWFpbiAke3NoYX0gcmVmcy9oZWFkcy9tYWluICR7XCIwXCIucmVwZWF0KDQwKX1cXG5gLFxuICAgICk7XG4gICAgYXNzZXJ0KHJlZnMub2spO1xuICAgIGNvbnN0IGZpbGVzID0gYXdhaXQgbGlzdFB1c2hlZEZpbGVzKHJlZnMudmFsdWUsIGNsb25lLCBhc3luYyAoYSwgYykgPT4ge1xuICAgICAgY29uc3Qgb3V0ID0gYXdhaXQgbmV3IERlbm8uQ29tbWFuZChcImdpdFwiLCB7XG4gICAgICAgIGFyZ3M6IGEsXG4gICAgICAgIGN3ZDogYyxcbiAgICAgICAgc3Rkb3V0OiBcInBpcGVkXCIsXG4gICAgICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICAgICAgfSkub3V0cHV0KCk7XG4gICAgICBjb25zdCBkID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb2RlOiBvdXQuY29kZSxcbiAgICAgICAgc3Rkb3V0OiBkLmRlY29kZShvdXQuc3Rkb3V0KSxcbiAgICAgICAgc3RkZXJyOiBkLmRlY29kZShvdXQuc3RkZXJyKSxcbiAgICAgIH07XG4gICAgfSk7XG4gICAgYXNzZXJ0KGZpbGVzLm9rKTtcbiAgICBhc3NlcnQoZmlsZXMudmFsdWUuaW5jbHVkZXMoXCJ0YXJnZXQubWRcIikpO1xuICAgIGFzc2VydCghZmlsZXMudmFsdWUuaW5jbHVkZXMoXCJsaW5rLm1kXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcImxpc3RQdXNoZWRGaWxlczogYSBmaWxlIGJlaGluZCBhIGRpcmVjdG9yeSBsYXRlciByZXBsYWNlZCBieSBhIHN5bWxpbmsgaXMgc2tpcHBlZCAoIzQ5MDkpXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgb3V0c2lkZSA9IGF3YWl0IERlbm8ubWFrZVRlbXBEaXIoeyBwcmVmaXg6IFwidmliZS1wcC1vdXRzaWRlLVwiIH0pO1xuICBjb25zdCB7IHJvb3QsIGNsb25lIH0gPSBhd2FpdCBtYWtlUmVwb1dpdGhEb2NDb21taXQoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7b3V0c2lkZX0vZmlsZS5qc29uYCwgXCJ7fVxcblwiKTtcbiAgICBhd2FpdCBEZW5vLm1rZGlyKGAke2Nsb25lfS9kaXJgKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L2Rpci9maWxlLmpzb25gLCBcInt9XFxuXCIpO1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7Y2xvbmV9L2tlZXBgKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L2tlZXAvb2subWRgLCBcIiMgT2tcXG5cIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImFkZFwiLCBcIi5cIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImNvbW1pdFwiLCBcIi1xbVwiLCBcIm5lc3RlZFwiKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwicm1cIiwgXCItcnFcIiwgXCJkaXJcIik7XG4gICAgYXdhaXQgRGVuby5zeW1saW5rKG91dHNpZGUsIGAke2Nsb25lfS9kaXJgKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLlwiKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwicmVwbGFjZSBkaXIgd2l0aCBzeW1saW5rXCIpO1xuICAgIGNvbnN0IHNoYSA9IGF3YWl0IGdpdChjbG9uZSwgXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCIpO1xuICAgIGNvbnN0IHJlZnMgPSBwYXJzZVByZVB1c2hSZWZzKFxuICAgICAgYHJlZnMvaGVhZHMvbWFpbiAke3NoYX0gcmVmcy9oZWFkcy9tYWluICR7XCIwXCIucmVwZWF0KDQwKX1cXG5gLFxuICAgICk7XG4gICAgYXNzZXJ0KHJlZnMub2spO1xuICAgIGNvbnN0IGZpbGVzID0gYXdhaXQgbGlzdFB1c2hlZEZpbGVzKHJlZnMudmFsdWUsIGNsb25lLCBhc3luYyAoYSwgYykgPT4ge1xuICAgICAgY29uc3Qgb3V0ID0gYXdhaXQgbmV3IERlbm8uQ29tbWFuZChcImdpdFwiLCB7XG4gICAgICAgIGFyZ3M6IGEsXG4gICAgICAgIGN3ZDogYyxcbiAgICAgICAgc3Rkb3V0OiBcInBpcGVkXCIsXG4gICAgICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICAgICAgfSkub3V0cHV0KCk7XG4gICAgICBjb25zdCBkID0gbmV3IFRleHREZWNvZGVyKCk7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBjb2RlOiBvdXQuY29kZSxcbiAgICAgICAgc3Rkb3V0OiBkLmRlY29kZShvdXQuc3Rkb3V0KSxcbiAgICAgICAgc3RkZXJyOiBkLmRlY29kZShvdXQuc3RkZXJyKSxcbiAgICAgIH07XG4gICAgfSk7XG4gICAgYXNzZXJ0KGZpbGVzLm9rKTtcbiAgICBhc3NlcnRFcXVhbHMoZmlsZXMudmFsdWUsIFtcIlJFQURNRS5tZFwiLCBcImtlZXAvb2subWRcIl0pO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKG91dHNpZGUsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwicnVuUHJlUHVzaEdhdGUgZXhjbHVkZXMgZmlsZXMgYmVoaW5kIGEgcmVwbGFjZWQgZGlyZWN0b3J5IHN5bWxpbmsgKCM0OTA5KVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7cm9vdH0vb3V0c2lkZWApO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtyb290fS9vdXRzaWRlL25vdGVzLm1kYCwgXCIjIE91dHNpZGVcXG5cIik7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtjbG9uZX0vZGlyYCk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Nsb25lfS9kaXIvbm90ZXMubWRgLCBcIiMgSW5zaWRlXFxuXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCIuXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJuZXN0ZWRcIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcInJtXCIsIFwiLXJxXCIsIFwiZGlyXCIpO1xuICAgIGF3YWl0IERlbm8uc3ltbGluayhgJHtyb290fS9vdXRzaWRlYCwgYCR7Y2xvbmV9L2RpcmApO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCIuXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJyZXBsYWNlIGRpcmVjdG9yeVwiKTtcbiAgICBjb25zdCBzZWVuOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICAgIGN3ZDogY2xvbmUsXG4gICAgICBzdGRpbjogcHJlUHVzaElucHV0KGF3YWl0IGdpdChjbG9uZSwgXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCIpKSxcbiAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgIGZpbmRNYXJrZG93bmxpbnQ6ICgpID0+IFByb21pc2UucmVzb2x2ZShcIi9mYWtlL21hcmtkb3dubGludFwiKSxcbiAgICAgIGZpbmRDc3BlbGw6ICgpID0+IFByb21pc2UucmVzb2x2ZShcIi9mYWtlL2NzcGVsbFwiKSxcbiAgICAgIHJ1bm5lcjogcmVjb3JkaW5nUnVubmVyKCgpID0+IGZhbHNlLCBzZWVuKSxcbiAgICB9KTtcbiAgICBhc3NlcnQocmVzdWx0Lm9rLCByZXN1bHQub2sgPyBcIlwiIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UpO1xuICAgIGFzc2VydChzZWVuLnNvbWUoKGNvbW1hbmQpID0+IGNvbW1hbmQuaW5jbHVkZXMoXCJSRUFETUUubWRcIikpKTtcbiAgICBhc3NlcnQoIXNlZW4uc29tZSgoY29tbWFuZCkgPT4gY29tbWFuZC5pbmNsdWRlcyhcImRpci9ub3Rlcy5tZFwiKSkpO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwibGlzdFB1c2hlZEZpbGVzOiBhIHN5bWxpbmtlZCBjaGVja291dCByZXRhaW5zIHJlYWwgZmlsZXMgYW5kIHNraXBzIGVzY2FwaW5nIHBhdGhzICgjNDkwOSlcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByb290ID0gYXdhaXQgRGVuby5tYWtlVGVtcERpcih7IHByZWZpeDogXCJ2aWJlLXBwLWxpbmtlZC1cIiB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCBjbG9uZSA9IGAke3Jvb3R9L2Nsb25lYDtcbiAgICBjb25zdCBvdXRzaWRlID0gYCR7cm9vdH0vb3V0c2lkZWA7XG4gICAgY29uc3QgbGluayA9IGAke3Jvb3R9L2xpbmtgO1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7Y2xvbmV9L2tlZXBgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhd2FpdCBEZW5vLm1rZGlyKG91dHNpZGUpO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtjbG9uZX0vUkVBRE1FLm1kYCwgXCIjIFJlYWRtZVxcblwiKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L2tlZXAvb2subWRgLCBcIiMgT2tcXG5cIik7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke291dHNpZGV9L2ZpbGUuanNvbmAsIFwie31cXG5cIik7XG4gICAgYXdhaXQgRGVuby5zeW1saW5rKG91dHNpZGUsIGAke2Nsb25lfS9kaXJgKTtcbiAgICBhd2FpdCBEZW5vLnN5bWxpbmsoY2xvbmUsIGxpbmspO1xuICAgIGNvbnN0IHJlZnMgPSBwYXJzZVByZVB1c2hSZWZzKFxuICAgICAgYHJlZnMvaGVhZHMvbWFpbiAke1NIQV9BfSByZWZzL2hlYWRzL21haW4gJHtaRVJPfVxcbmAsXG4gICAgKTtcbiAgICBhc3NlcnQocmVmcy5vayk7XG4gICAgY29uc3QgZmlsZXMgPSBhd2FpdCBsaXN0UHVzaGVkRmlsZXMoXG4gICAgICByZWZzLnZhbHVlLFxuICAgICAgbGluayxcbiAgICAgICgpID0+XG4gICAgICAgIFByb21pc2UucmVzb2x2ZSh7XG4gICAgICAgICAgY29kZTogMCxcbiAgICAgICAgICBzdGRvdXQ6IFwiUkVBRE1FLm1kXFwwa2VlcC9vay5tZFxcMGRpci9maWxlLmpzb25cXDBcIixcbiAgICAgICAgICBzdGRlcnI6IFwiXCIsXG4gICAgICAgIH0pLFxuICAgICk7XG4gICAgYXNzZXJ0KGZpbGVzLm9rKTtcbiAgICBhc3NlcnRFcXVhbHMoZmlsZXMudmFsdWUsIFtcIlJFQURNRS5tZFwiLCBcImtlZXAvb2subWRcIl0pO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwibGlzdFB1c2hlZEZpbGVzOiBhbiB1bnJlc29sdmFibGUgY2hlY2tvdXQgcmV0dXJucyBhbiBFcnIgbmFtaW5nIHRoZSBjYXVzZSAoIzQ5MDkpXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgbWlzc2luZyA9IGAke2F3YWl0IERlbm8ubWFrZVRlbXBEaXIoeyBwcmVmaXg6IFwidmliZS1wcC1nb25lLVwiIH0pfS9nb25lYDtcbiAgbGV0IGV4cGVjdGVkID0gXCJcIjtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLnJlYWxQYXRoKG1pc3NpbmcpO1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBhc3NlcnRJbnN0YW5jZU9mKGVyciwgRXJyb3IpO1xuICAgIGV4cGVjdGVkID0gZXJyLm1lc3NhZ2U7XG4gIH1cbiAgYXNzZXJ0KGV4cGVjdGVkICE9PSBcIlwiKTtcbiAgY29uc3Qgc2hhID0gXCJhXCIucmVwZWF0KDQwKTtcbiAgY29uc3QgcmVmcyA9IHBhcnNlUHJlUHVzaFJlZnMoXG4gICAgYHJlZnMvaGVhZHMvbWFpbiAke3NoYX0gcmVmcy9oZWFkcy9tYWluICR7XCIwXCIucmVwZWF0KDQwKX1cXG5gLFxuICApO1xuICBhc3NlcnQocmVmcy5vayk7XG4gIGNvbnN0IGZpbGVzID0gYXdhaXQgbGlzdFB1c2hlZEZpbGVzKFxuICAgIHJlZnMudmFsdWUsXG4gICAgbWlzc2luZyxcbiAgICAoKSA9PiBQcm9taXNlLnJlc29sdmUoeyBjb2RlOiAwLCBzdGRvdXQ6IFwiUkVBRE1FLm1kXFwwXCIsIHN0ZGVycjogXCJcIiB9KSxcbiAgKTtcbiAgYXNzZXJ0KCFmaWxlcy5vayk7XG4gIGFzc2VydEVxdWFscyhcbiAgICBmaWxlcy5lcnJvcixcbiAgICBgY291bGQgbm90IHJlc29sdmUgY2hlY2tvdXQgJHtKU09OLnN0cmluZ2lmeShtaXNzaW5nKX06ICR7ZXhwZWN0ZWR9YCxcbiAgKTtcbiAgYXdhaXQgRGVuby5yZW1vdmUobWlzc2luZy5zbGljZSgwLCAtXCIvZ29uZVwiLmxlbmd0aCksIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBkb2Mtb25seSBwdXNoIGJsb2NrZWQgYnkgZmFpbGluZyBtYXJrZG93bmxpbnRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJvb3QsIGNsb25lLCBzdGRpbiB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBydW4gPSAoZmFpbDogYm9vbGVhbikgPT5cbiAgICAgIHJ1blByZVB1c2hHYXRlKHtcbiAgICAgICAgY3dkOiBjbG9uZSxcbiAgICAgICAgc3RkaW4sXG4gICAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoXG4gICAgICAgICAgKGMpID0+IGZhaWwgJiYgYy5pbmNsdWRlcyhcIi9mYWtlL21kbFwiKSxcbiAgICAgICAgICBzZWVuLFxuICAgICAgICApLFxuICAgICAgICBmaW5kTWFya2Rvd25saW50OiAoKSA9PiBQcm9taXNlLnJlc29sdmUoXCIvZmFrZS9tZGxcIiksXG4gICAgICB9KTtcblxuICAgIGNvbnN0IGJsb2NrZWQgPSBhd2FpdCBydW4odHJ1ZSk7XG4gICAgYXNzZXJ0KCFibG9ja2VkLm9rKTtcbiAgICBhc3NlcnRJbnN0YW5jZU9mKGJsb2NrZWQuZXJyb3IsIFByZUZsaWdodEdhdGVFcnJvcik7XG4gICAgYXNzZXJ0RXF1YWxzKGJsb2NrZWQuZXJyb3IucmVhc29uLCBcIm5vbi16ZXJvLWV4aXRcIik7XG4gICAgYXNzZXJ0KGJsb2NrZWQuZXJyb3IuY29tbWFuZC5pbmNsdWRlcyhcIi9mYWtlL21kbFwiKSk7XG5cbiAgICBjb25zdCBhY2NlcHRlZCA9IGF3YWl0IHJ1bihmYWxzZSk7XG4gICAgYXNzZXJ0KGFjY2VwdGVkLm9rKTtcbiAgICBhc3NlcnRFcXVhbHMoYWNjZXB0ZWQudmFsdWUuY2hlY2tzUnVuLmxlbmd0aCwgMik7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogZGVsZXRlZCBzY3JpcHRzIGFyZSBub3QgcGFzc2VkIHRvIFNoZWxsQ2hlY2tcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJvb3QsIGNsb25lIH0gPSBhd2FpdCBtYWtlUmVwb1dpdGhEb2NDb21taXQoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBjb21taXRTaGVsbGNoZWNrRmlsZXMoY2xvbmUsIHsgXCJnb25lLnNoXCI6IFwiIyEvYmluL3NoXFxudHJ1ZVxcblwiIH0pO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJwdXNoXCIsIFwiLXFcIiwgXCJvcmlnaW5cIiwgXCJIRUFEOm1haW5cIik7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUoYCR7Y2xvbmV9L2dvbmUuc2hgKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLUFcIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImNvbW1pdFwiLCBcIi1xbVwiLCBcImRlbGV0ZSBzaGVsbCBzY3JpcHRcIik7XG4gICAgY29uc3QgdGlwID0gYXdhaXQgZ2l0KGNsb25lLCBcInJldi1wYXJzZVwiLCBcIkhFQURcIik7XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW46IHByZVB1c2hJbnB1dCh0aXApLFxuICAgICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoKCkgPT4gZmFsc2UsIHNlZW4pLFxuICAgIH0pO1xuICAgIGFzc2VydChyZXN1bHQub2ssIHJlc3VsdC5vayA/IFwiXCIgOiByZXN1bHQuZXJyb3IubWVzc2FnZSk7XG4gICAgYXNzZXJ0RXF1YWxzKHJlc3VsdC52YWx1ZS5jaGVja3NSdW4sIFtdKTtcbiAgICBhc3NlcnQoIXNlZW4uc29tZSgoY29tbWFuZCkgPT4gY29tbWFuZC5pbmNsdWRlcyhcInNoZWxsY2hlY2tcIikpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBwYXRocyBvdXRzaWRlIENJJ3MgLnNoIHNlbGVjdGlvbiBhcmUgZXhjbHVkZWRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJvb3QsIGNsb25lIH0gPSBhd2FpdCBtYWtlUmVwb1dpdGhEb2NDb21taXQoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBjb21taXRTaGVsbGNoZWNrRmlsZXMoY2xvbmUsIHsgXCJiYXNlbGluZS5zaFwiOiBcIiMhL2Jpbi9zaFxcbnRydWVcXG5cIiB9KTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwicHVzaFwiLCBcIi1xXCIsIFwib3JpZ2luXCIsIFwiSEVBRDptYWluXCIpO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtjbG9uZX0vbm90ZXMudHh0YCwgXCJub3QgYSBzaGVsbCBzY3JpcHRcXG5cIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImFkZFwiLCBcIm5vdGVzLnR4dFwiKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwiY2hhbmdlIGEgbm9uLXNoZWxsIHBhdGhcIik7XG4gICAgY29uc3QgdGlwID0gYXdhaXQgZ2l0KGNsb25lLCBcInJldi1wYXJzZVwiLCBcIkhFQURcIik7XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW46IHByZVB1c2hJbnB1dCh0aXApLFxuICAgICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoKCkgPT4gZmFsc2UsIHNlZW4pLFxuICAgIH0pO1xuICAgIGFzc2VydChyZXN1bHQub2ssIHJlc3VsdC5vayA/IFwiXCIgOiByZXN1bHQuZXJyb3IubWVzc2FnZSk7XG4gICAgYXNzZXJ0RXF1YWxzKHJlc3VsdC52YWx1ZS5jaGVja3NSdW4sIFtdKTtcbiAgICBhc3NlcnQoIXNlZW4uc29tZSgoY29tbWFuZCkgPT4gY29tbWFuZC5pbmNsdWRlcyhcInNoZWxsY2hlY2tcIikpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlIHNlbGVjdHMgbmVhcmVzdCB0cmFja2VkIGNvbmZpZyBhbmQgcmVzcGVjdHMgZXhwbGljaXQgcmNmaWxlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtjbG9uZX0vc2NyaXB0cy9kZWVwYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgbGV0IHRpcCA9IGF3YWl0IGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhjbG9uZSwge1xuICAgICAgXCJhLnNoXCI6IFwiIyEvYmluL3NoXFxudHJ1ZVxcblwiLFxuICAgICAgXCJzY3JpcHRzL2Iuc2hcIjogXCIjIS9iaW4vc2hcXG50cnVlXFxuXCIsXG4gICAgICBcInNjcmlwdHMvZGVlcC9jLnNoXCI6IFwiIyEvYmluL3NoXFxudHJ1ZVxcblwiLFxuICAgICAgXCIuc2hlbGxjaGVja3JjXCI6IFwiZGlzYWJsZT1TQzIwODZcXG5cIixcbiAgICAgIFwic2NyaXB0cy8uc2hlbGxjaGVja3JjXCI6IFwiZGlzYWJsZT1TQzIwMzRcXG5cIixcbiAgICB9KTtcbiAgICBjb25zdCBydW4gPSAoc2hhOiBzdHJpbmcpID0+XG4gICAgICBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICAgIGN3ZDogY2xvbmUsXG4gICAgICAgIHN0ZGluOiBwcmVQdXNoSW5wdXQoc2hhKSxcbiAgICAgICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgICAgICAuLi5zdHViU2hlbGxjaGVjaygpLFxuICAgICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoKSA9PiBmYWxzZSwgW10pLFxuICAgICAgfSk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuKHRpcCk7XG4gICAgYXNzZXJ0KHJlc3VsdC5vaywgcmVzdWx0Lm9rID8gXCJcIiA6IHJlc3VsdC5lcnJvci5tZXNzYWdlKTtcbiAgICBjb25zdCBjb21tYW5kcyA9IHJlc3VsdC52YWx1ZS5jaGVja3NSdW4uZmlsdGVyKChjKSA9PlxuICAgICAgYy5pbmNsdWRlcyhcInNoZWxsY2hlY2tcIilcbiAgICApO1xuICAgIGZvciAoXG4gICAgICBjb25zdCBbc2NyaXB0LCBjb25maWddIG9mIFtbXCJhLnNoXCIsIFwiLnNoZWxsY2hlY2tyY1wiXSwgW1xuICAgICAgICBcInNjcmlwdHMvYi5zaFwiLFxuICAgICAgICBcInNjcmlwdHMvLnNoZWxsY2hlY2tyY1wiLFxuICAgICAgXSwgW1wic2NyaXB0cy9kZWVwL2Muc2hcIiwgXCJzY3JpcHRzLy5zaGVsbGNoZWNrcmNcIl1dXG4gICAgKSB7XG4gICAgICBhc3NlcnQoXG4gICAgICAgIGNvbW1hbmRzLnNvbWUoKGMpID0+XG4gICAgICAgICAgYy5pbmNsdWRlcyhgJyR7c2NyaXB0fSdgKSAmJiBjLmluY2x1ZGVzKGAnLS1yY2ZpbGUnICcke2NvbmZpZ30nYClcbiAgICAgICAgKSxcbiAgICAgICAgY29tbWFuZHMuam9pbihcIlxcblwiKSxcbiAgICAgICk7XG4gICAgfVxuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgIGAke2Nsb25lfS8uZ2l0aHViL3dvcmtmbG93cy92YWxpZGF0ZS1zY3JpcHRzLnltbGAsXG4gICAgICBTSEVMTENIRUNLX1dPUktGTE9XKFwiLS1yY2ZpbGUgLnNoZWxsY2hlY2tyY1wiKSxcbiAgICApO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCIuZ2l0aHViL3dvcmtmbG93cy92YWxpZGF0ZS1zY3JpcHRzLnltbFwiKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwiZXhwbGljaXQgY29uZmlnXCIpO1xuICAgIHRpcCA9IGF3YWl0IGdpdChjbG9uZSwgXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCIpO1xuICAgIGNvbnN0IGV4cGxpY2l0ID0gYXdhaXQgcnVuKHRpcCk7XG4gICAgYXNzZXJ0KGV4cGxpY2l0Lm9rLCBleHBsaWNpdC5vayA/IFwiXCIgOiBleHBsaWNpdC5lcnJvci5tZXNzYWdlKTtcbiAgICBmb3IgKFxuICAgICAgY29uc3QgY29tbWFuZCBvZiBleHBsaWNpdC52YWx1ZS5jaGVja3NSdW4uZmlsdGVyKChjKSA9PlxuICAgICAgICBjLmluY2x1ZGVzKFwic2hlbGxjaGVja1wiKVxuICAgICAgKVxuICAgICkge1xuICAgICAgYXNzZXJ0RXF1YWxzKGNvbW1hbmQubWF0Y2goLy0tcmNmaWxlL2cpPy5sZW5ndGgsIDEpO1xuICAgICAgYXNzZXJ0KCFjb21tYW5kLmluY2x1ZGVzKFwiLS1ub3JjXCIpKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogYSBjaGFuZ2VkIFNoZWxsQ2hlY2sgY29uZmlnIHJlY2hlY2tzIGV2ZXJ5IHRyYWNrZWQgc2NyaXB0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgY29tbWl0U2hlbGxjaGVja0ZpbGVzKGNsb25lLCB7XG4gICAgICBcIm9uZS5zaFwiOiBcIiMhL2Jpbi9zaFxcbmVjaG8gJDFcXG5cIixcbiAgICAgIFwidHdvIHNjcmlwdHMuc2hcIjogXCIjIS9iaW4vc2hcXG50cnVlXFxuXCIsXG4gICAgfSk7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcInB1c2hcIiwgXCItcVwiLCBcIm9yaWdpblwiLCBcIkhFQUQ6bWFpblwiKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9Ly5zaGVsbGNoZWNrcmNgLCBcImRpc2FibGU9U0MyMDg2XFxuXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCIuc2hlbGxjaGVja3JjXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJjaGFuZ2UgU2hlbGxDaGVjayBjb25maWdcIik7XG4gICAgY29uc3QgdGlwID0gYXdhaXQgZ2l0KGNsb25lLCBcInJldi1wYXJzZVwiLCBcIkhFQURcIik7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlUHVzaEdhdGUoe1xuICAgICAgY3dkOiBjbG9uZSxcbiAgICAgIHN0ZGluOiBwcmVQdXNoSW5wdXQodGlwKSxcbiAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgIC4uLnN0dWJTaGVsbGNoZWNrKCksXG4gICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoKSA9PiBmYWxzZSwgW10pLFxuICAgIH0pO1xuICAgIGFzc2VydChyZXN1bHQub2ssIHJlc3VsdC5vayA/IFwiXCIgOiByZXN1bHQuZXJyb3IubWVzc2FnZSk7XG4gICAgY29uc3QgY29tbWFuZCA9IHJlc3VsdC52YWx1ZS5jaGVja3NSdW4uZmlsdGVyKCh2YWx1ZSkgPT5cbiAgICAgIHZhbHVlLmluY2x1ZGVzKFwic2hlbGxjaGVja1wiKVxuICAgICkuam9pbihcIlxcblwiKTtcbiAgICBhc3NlcnQoY29tbWFuZCk7XG4gICAgYXNzZXJ0KGNvbW1hbmQuaW5jbHVkZXMoXCJvbmUuc2hcIiksIGNvbW1hbmQpO1xuICAgIGFzc2VydChjb21tYW5kLmluY2x1ZGVzKFwidHdvIHNjcmlwdHMuc2hcIiksIGNvbW1hbmQpO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwicnVuUHJlUHVzaEdhdGU6IG5lc3RlZCBTaGVsbENoZWNrIGNvbmZpZyBjaGFuZ2VzIHJlY2hlY2sgdHJhY2tlZCBzY3JpcHRzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtjbG9uZX0vc2NyaXB0c2AsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7Y2xvbmV9L290aGVyYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgY29tbWl0U2hlbGxjaGVja0ZpbGVzKGNsb25lLCB7XG4gICAgICBcInNjcmlwdHMvb25lLnNoXCI6IFwiIyEvYmluL3NoXFxuZWNobyAkMVxcblwiLFxuICAgICAgXCJvdGhlci90d28uc2hcIjogXCIjIS9iaW4vc2hcXG50cnVlXFxuXCIsXG4gICAgfSk7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcInB1c2hcIiwgXCItcVwiLCBcIm9yaWdpblwiLCBcIkhFQUQ6bWFpblwiKTtcbiAgICBhd2FpdCBEZW5vLm1rZGlyKGAke2Nsb25lfS9zY3JpcHRzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7Y2xvbmV9L3NjcmlwdHMvLnNoZWxsY2hlY2tyY2AsXG4gICAgICBcImRpc2FibGU9U0MyMDg2XFxuXCIsXG4gICAgKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwic2NyaXB0cy8uc2hlbGxjaGVja3JjXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJjaGFuZ2UgbmVzdGVkIFNoZWxsQ2hlY2sgY29uZmlnXCIpO1xuICAgIGNvbnN0IHRpcCA9IGF3YWl0IGdpdChjbG9uZSwgXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICAgIGN3ZDogY2xvbmUsXG4gICAgICBzdGRpbjogcHJlUHVzaElucHV0KHRpcCksXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgICAuLi5zdHViU2hlbGxjaGVjaygpLFxuICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoKCkgPT4gZmFsc2UsIFtdKSxcbiAgICB9KTtcbiAgICBhc3NlcnQocmVzdWx0Lm9rLCByZXN1bHQub2sgPyBcIlwiIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UpO1xuICAgIGNvbnN0IGNvbW1hbmQgPSByZXN1bHQudmFsdWUuY2hlY2tzUnVuLmZpbHRlcigodmFsdWUpID0+XG4gICAgICB2YWx1ZS5pbmNsdWRlcyhcInNoZWxsY2hlY2tcIilcbiAgICApLmpvaW4oXCJcXG5cIik7XG4gICAgYXNzZXJ0KGNvbW1hbmQpO1xuICAgIGFzc2VydChjb21tYW5kLmluY2x1ZGVzKFwic2NyaXB0cy9vbmUuc2hcIiksIGNvbW1hbmQpO1xuICAgIGFzc2VydChjb21tYW5kLmluY2x1ZGVzKFwib3RoZXIvdHdvLnNoXCIpLCBjb21tYW5kKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiB1bnN1cHBvcnRlZCBTaGVsbENoZWNrIHdvcmtmbG93IGlzIGFuIGluY29tcGxldGUgaW5mcmFzdHJ1Y3R1cmUgcmVzdWx0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgY29uc3QgdGlwID0gYXdhaXQgY29tbWl0U2hlbGxjaGVja0ZpbGVzKFxuICAgICAgY2xvbmUsXG4gICAgICB7IFwic2NyaXB0LnNoXCI6IFwiIyEvYmluL3NoXFxudHJ1ZVxcblwiIH0sXG4gICAgICBcIiouc2hcIixcbiAgICApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICAgIGN3ZDogY2xvbmUsXG4gICAgICBzdGRpbjogcHJlUHVzaElucHV0KHRpcCksXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgfSk7XG4gICAgYXNzZXJ0KCFyZXN1bHQub2spO1xuICAgIGFzc2VydEluc3RhbmNlT2YocmVzdWx0LmVycm9yLCBQcmVQdXNoR2F0ZUluZnJhc3RydWN0dXJlRXJyb3IpO1xuICAgIGFzc2VydChyZXN1bHQuZXJyb3IubWVzc2FnZS5pbmNsdWRlcyhcInVuc3VwcG9ydGVkXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBhbiBpbmRpcmVjdCByZXBvc2l0b3J5IFNoZWxsQ2hlY2sgZ2F0ZSBpcyBub3Qgc2lsZW50bHkgc2tpcHBlZFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhjbG9uZSwge1xuICAgICAgXCJzY3JpcHQuc2hcIjogXCIjIS9iaW4vc2hcXG50cnVlXFxuXCIsXG4gICAgfSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7Y2xvbmV9Ly5naXRodWIvd29ya2Zsb3dzL3ZhbGlkYXRlLXNjcmlwdHMueW1sYCxcbiAgICAgIFwiam9iczpcXG4gIGxpbnQ6XFxuICAgIHN0ZXBzOlxcbiAgICAgIC0gcnVuOiAuL3F1YWxpdHkuc2hcXG5cIixcbiAgICApO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgIGAke2Nsb25lfS9xdWFsaXR5LnNoYCxcbiAgICAgIFwiIyEvYmluL2Jhc2hcXG5zaGVsbGNoZWNrIC1lIFNDMTA5MSAqLnNoXFxuXCIsXG4gICAgKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLlwiKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwiZGVsZWdhdGUgc2hlbGxjaGVjayB0byBnYXRlIHNjcmlwdFwiKTtcbiAgICBjb25zdCB0aXAgPSBhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW46IHByZVB1c2hJbnB1dCh0aXApLFxuICAgICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgIH0pO1xuICAgIGFzc2VydCghcmVzdWx0Lm9rKTtcbiAgICBhc3NlcnRJbnN0YW5jZU9mKHJlc3VsdC5lcnJvciwgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yKTtcbiAgICBhc3NlcnQocmVzdWx0LmVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoXCJkZWxlZ2F0ZXMgU2hlbGxDaGVja1wiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogYSBtaXNzaW5nIHJjZmlsZSBpcyBhbiBpbmNvbXBsZXRlIGluZnJhc3RydWN0dXJlIHJlc3VsdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGNvbnN0IHRpcCA9IGF3YWl0IGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhcbiAgICAgIGNsb25lLFxuICAgICAgeyBcInNjcmlwdC5zaFwiOiBcIiMhL2Jpbi9zaFxcbnRydWVcXG5cIiB9LFxuICAgICAgXCItLXJjZmlsZSBtaXNzaW5nLXNoZWxsY2hlY2tyY1wiLFxuICAgICk7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlUHVzaEdhdGUoe1xuICAgICAgY3dkOiBjbG9uZSxcbiAgICAgIHN0ZGluOiBwcmVQdXNoSW5wdXQodGlwKSxcbiAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICB9KTtcbiAgICBhc3NlcnQoIXJlc3VsdC5vayk7XG4gICAgYXNzZXJ0SW5zdGFuY2VPZihyZXN1bHQuZXJyb3IsIFByZVB1c2hHYXRlSW5mcmFzdHJ1Y3R1cmVFcnJvcik7XG4gICAgYXNzZXJ0KFxuICAgICAgcmVzdWx0LmVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoXCJjYW5ub3QgcmVhZCBTaGVsbENoZWNrIGNvbmZpZ3VyYXRpb25cIiksXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBhIG1pc3NpbmcgU2hlbGxDaGVjayB0b29sIHJlY292ZXJzIGFuZCByZXZhbGlkYXRlc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGNvbnN0IHRpcCA9IGF3YWl0IGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhjbG9uZSwge1xuICAgICAgXCJjbGVhbi5zaFwiOiBcIiMhL2Jpbi9zaFxcbnRydWVcXG5cIixcbiAgICB9KTtcbiAgICBjb25zdCBzdHViID0gc3R1YlNoZWxsY2hlY2soKTtcbiAgICBjb25zdCBtaXNzaW5nID0gYXdhaXQgcnVuUHJlUHVzaEdhdGUoe1xuICAgICAgY3dkOiBjbG9uZSxcbiAgICAgIHN0ZGluOiBwcmVQdXNoSW5wdXQodGlwKSxcbiAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgIC4uLnN0dWIsXG4gICAgICBmaW5kU2hlbGxjaGVjazogKCkgPT4gUHJvbWlzZS5yZXNvbHZlKG51bGwpLFxuICAgIH0pO1xuICAgIGFzc2VydCghbWlzc2luZy5vayk7XG4gICAgYXNzZXJ0SW5zdGFuY2VPZihtaXNzaW5nLmVycm9yLCBQcmVQdXNoR2F0ZUluZnJhc3RydWN0dXJlRXJyb3IpO1xuICAgIGFzc2VydChtaXNzaW5nLmVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoXCJjb3VsZCBub3QgYmUgZm91bmRcIikpO1xuXG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByZWNvdmVyZWQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW46IHByZVB1c2hJbnB1dCh0aXApLFxuICAgICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgICAgLi4uc3R1YixcbiAgICAgIHJ1bm5lcjogcmVjb3JkaW5nUnVubmVyKCgpID0+IGZhbHNlLCBzZWVuKSxcbiAgICB9KTtcbiAgICBhc3NlcnQocmVjb3ZlcmVkLm9rLCByZWNvdmVyZWQub2sgPyBcIlwiIDogcmVjb3ZlcmVkLmVycm9yLm1lc3NhZ2UpO1xuICAgIGFzc2VydChcbiAgICAgIHNlZW4uc29tZSgoY29tbWFuZCkgPT5cbiAgICAgICAgY29tbWFuZC5pbmNsdWRlcyhcIi9zdHViL3NoZWxsY2hlY2tcIikgJiYgY29tbWFuZC5pbmNsdWRlcyhcImNsZWFuLnNoXCIpXG4gICAgICApLFxuICAgICAgc2Vlbi5qb2luKFwiXFxuXCIpLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogYSBDSSBhbmQgd29ya2VyIFNoZWxsQ2hlY2sgdmVyc2lvbiBtaXNtYXRjaCBpcyBpbmNvbXBsZXRlXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgY29uc3QgdGlwID0gYXdhaXQgY29tbWl0U2hlbGxjaGVja0ZpbGVzKFxuICAgICAgY2xvbmUsXG4gICAgICB7IFwiY2xlYW4uc2hcIjogXCIjIS9iaW4vc2hcXG50cnVlXFxuXCIgfSxcbiAgICApO1xuICAgIGNvbnN0IHNlZW46IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlUHVzaEdhdGUoe1xuICAgICAgY3dkOiBjbG9uZSxcbiAgICAgIHN0ZGluOiBwcmVQdXNoSW5wdXQodGlwKSxcbiAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgIC4uLnN0dWJTaGVsbGNoZWNrKFwiOS45LjlcIiksXG4gICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoKSA9PiBmYWxzZSwgc2VlbiksXG4gICAgfSk7XG4gICAgYXNzZXJ0KCFyZXN1bHQub2spO1xuICAgIGFzc2VydEluc3RhbmNlT2YocmVzdWx0LmVycm9yLCBQcmVQdXNoR2F0ZUluZnJhc3RydWN0dXJlRXJyb3IpO1xuICAgIGFzc2VydChyZXN1bHQuZXJyb3IubWVzc2FnZS5pbmNsdWRlcyhcInZlcnNpb24gbWlzbWF0Y2hcIikpO1xuICAgIGFzc2VydChcbiAgICAgIHJlc3VsdC5lcnJvci5tZXNzYWdlLmluY2x1ZGVzKGBDSSByZXF1aXJlcyAke1NUVUJfU0hFTExDSEVDS19WRVJTSU9OfWApLFxuICAgICk7XG4gICAgYXNzZXJ0KHJlc3VsdC5lcnJvci5tZXNzYWdlLmluY2x1ZGVzKFwid29ya2VyIGhhcyA5LjkuOVwiKSk7XG4gICAgYXNzZXJ0RXF1YWxzKHNlZW4sIFtdKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBhIGRvYyBvdXRzaWRlIHRoZSByZXBvJ3MgZGVubyBmbXQgaW5jbHVkZSBpcyBub3QgZGVuby1jaGVja2VkXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSwgc3RkaW4gfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgIGAke2Nsb25lfS9kZW5vLmpzb25gLFxuICAgICAgJ3sgLy8gc2NvcGVkXFxuIFwiZm10XCI6IHtcImluY2x1ZGVcIjogW1wic3JjL1wiXX0sIFwibGludFwiOiB7XCJpbmNsdWRlXCI6IFtcInNyYy9cIl19IH1cXG4nLFxuICAgICk7XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW4sXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoKSA9PiBmYWxzZSwgc2VlbiksXG4gICAgICBmaW5kTWFya2Rvd25saW50OiAoKSA9PiBQcm9taXNlLnJlc29sdmUoXCIvZmFrZS9tZGxcIiksXG4gICAgfSk7XG4gICAgYXNzZXJ0KHJlc3VsdC5vayk7XG4gICAgLy8gT25seSBtYXJrZG93bmxpbnQgcmFuOiBSRUFETUUubWQgaXMgb3V0c2lkZSBmbXQuaW5jbHVkZS5cbiAgICBhc3NlcnRFcXVhbHMocmVzdWx0LnZhbHVlLmNoZWNrc1J1bi5sZW5ndGgsIDEpO1xuICAgIGFzc2VydChyZXN1bHQudmFsdWUuY2hlY2tzUnVuWzBdPy5pbmNsdWRlcyhcIi9mYWtlL21kbFwiKSk7XG4gICAgYXNzZXJ0KCFzZWVuLnNvbWUoKGMpID0+IGMuc3RhcnRzV2l0aChcImRlbm8gXCIpKSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5jb25zdCBTQ09QRUQgPVxuICAneyBcImZtdFwiOiB7XCJpbmNsdWRlXCI6IFtcInNyYy9cIl19LCBcImxpbnRcIjoge1wiaW5jbHVkZVwiOiBbXCJzcmMvXCJdfSB9JztcblxuLyoqIFJ1biB0aGUgZ2F0ZSBvdmVyIHRoZSBkb2MtY29tbWl0IHJlcG8gYW5kIHJldHVybiB0aGUgZGVubyBjb21tYW5kcyBydW4uICovXG5hc3luYyBmdW5jdGlvbiBkZW5vQ29tbWFuZHNSdW4oXG4gIHNldHVwOiAoY2xvbmU6IHN0cmluZykgPT4gUHJvbWlzZTx2b2lkPixcbik6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSwgc3RkaW4gfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IHNldHVwKGNsb25lKTtcbiAgICBjb25zdCBzZWVuOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICAgIGN3ZDogY2xvbmUsXG4gICAgICBzdGRpbixcbiAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgIHJ1bm5lcjogcmVjb3JkaW5nUnVubmVyKCgpID0+IGZhbHNlLCBzZWVuKSxcbiAgICAgIGZpbmRNYXJrZG93bmxpbnQ6ICgpID0+IFByb21pc2UucmVzb2x2ZShcIi9mYWtlL21kbFwiKSxcbiAgICB9KTtcbiAgICBhc3NlcnQocmVzdWx0Lm9rKTtcbiAgICByZXR1cm4gc2Vlbi5maWx0ZXIoKGMpID0+IGMuc3RhcnRzV2l0aChcImRlbm8gXCIpKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufVxuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogYW4gdW5wYXJzZWFibGUgZGVuby5qc29uIGxlYXZlcyB0aGUgcHVzaCB1bmZpbHRlcmVkXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcmFuID0gYXdhaXQgZGVub0NvbW1hbmRzUnVuKChjbG9uZSkgPT5cbiAgICBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L2Rlbm8uanNvbmAsIFwieyBub3QganNvblwiKVxuICApO1xuICBhc3NlcnRFcXVhbHMocmFuLCBbXCJkZW5vIGZtdCAtLWNoZWNrIC0tcGVybWl0LW5vLWZpbGVzICdSRUFETUUubWQnXCJdKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogYSBkZW5vLmpzb25jIGFsb25lIHN1cHBsaWVzIHRoZSBzY29wZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJhbiA9IGF3YWl0IGRlbm9Db21tYW5kc1J1bihhc3luYyAoY2xvbmUpID0+IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShgJHtjbG9uZX0vZGVuby5qc29uYCk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Nsb25lfS9kZW5vLmpzb25jYCwgU0NPUEVEKTtcbiAgfSk7XG4gIGFzc2VydEVxdWFscyhyYW4sIFtdKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogZGVuby5qc29uIHdpbnMgb3ZlciBhIGRlbm8uanNvbmMgYmVzaWRlIGl0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcmFuID0gYXdhaXQgZGVub0NvbW1hbmRzUnVuKGFzeW5jIChjbG9uZSkgPT4ge1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtjbG9uZX0vZGVuby5qc29uYCwgU0NPUEVEKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L2Rlbm8uanNvbmNgLCBcInt9XCIpO1xuICB9KTtcbiAgYXNzZXJ0RXF1YWxzKHJhbiwgW10pO1xuICBjb25zdCB1bnNjb3BlZCA9IGF3YWl0IGRlbm9Db21tYW5kc1J1bihhc3luYyAoY2xvbmUpID0+IHtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L2Rlbm8uanNvbmAsIFwie31cIik7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Nsb25lfS9kZW5vLmpzb25jYCwgU0NPUEVEKTtcbiAgfSk7XG4gIGFzc2VydEVxdWFscyh1bnNjb3BlZCwgW1wiZGVubyBmbXQgLS1jaGVjayAtLXBlcm1pdC1uby1maWxlcyAnUkVBRE1FLm1kJ1wiXSk7XG59KTtcblxuRGVuby50ZXN0KFwicnVuUHJlUHVzaEdhdGU6IHByZS1mbGlnaHQgZmFpbHVyZSBibG9ja3MgYWZ0ZXIgY2hhbmdlZC1maWxlIGNoZWNrcyByYW5cIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJvb3QsIGNsb25lLCBzdGRpbiB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW4sXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW1wibWFrZS1pdC1mYWlsXCJdLFxuICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoKGMpID0+IGMgPT09IFwibWFrZS1pdC1mYWlsXCIsIHNlZW4pLFxuICAgICAgZmluZE1hcmtkb3dubGludDogKCkgPT4gUHJvbWlzZS5yZXNvbHZlKFwiL2Zha2UvbWRsXCIpLFxuICAgIH0pO1xuICAgIGFzc2VydCghcmVzdWx0Lm9rKTtcbiAgICBhc3NlcnRJbnN0YW5jZU9mKHJlc3VsdC5lcnJvciwgUHJlRmxpZ2h0R2F0ZUVycm9yKTtcbiAgICBhc3NlcnRFcXVhbHMocmVzdWx0LmVycm9yLnJlYXNvbiwgXCJub24temVyby1leGl0XCIpO1xuICAgIGFzc2VydEVxdWFscyhyZXN1bHQuZXJyb3IuY29tbWFuZCwgXCJtYWtlLWl0LWZhaWxcIik7XG4gICAgYXNzZXJ0RXF1YWxzKHNlZW4ubGVuZ3RoLCAzKTtcbiAgICBhc3NlcnRFcXVhbHMoc2VlblsyXSwgXCJtYWtlLWl0LWZhaWxcIik7XG4gICAgYXNzZXJ0KHNlZW5bMF0hLnN0YXJ0c1dpdGgoXCJkZW5vIGZtdFwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogZ2l0IGxvZyBmYWlsdXJlIGlzIGFuIGVycm9yXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgZmFpbGluZzogUHJlUHVzaEdpdCA9ICgpID0+XG4gICAgUHJvbWlzZS5yZXNvbHZlKHsgY29kZTogMTI4LCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJmYXRhbDogbm9wZVwiIH0pO1xuICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgY3dkOiBcIi9ub25leGlzdGVudFwiLFxuICAgIHN0ZGluOiBgcmVmcy9oZWFkcy9tYWluICR7U0hBX0F9IHJlZnMvaGVhZHMvbWFpbiAke1NIQV9CfVxcbmAsXG4gICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgIGdpdDogZmFpbGluZyxcbiAgfSk7XG4gIGFzc2VydCghcmVzdWx0Lm9rKTtcbiAgYXNzZXJ0KHJlc3VsdC5lcnJvci5tZXNzYWdlLmluY2x1ZGVzKFwiZ2l0IGxvZyBmYWlsZWRcIikpO1xuICAvLyBUaGUgbG9va3VwIGZhaWxlZDsgbm90aGluZyB3YXMgZGVjaWRlZCBhYm91dCB0aGUgYnJhbmNoIChQUiAjMzcxNiByZXZpZXcpLlxuICBhc3NlcnRJbnN0YW5jZU9mKHJlc3VsdC5lcnJvciwgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogbWFsZm9ybWVkIGhvb2sgaW5wdXQgaXMgbm90IGluZnJhc3RydWN0dXJlIChQUiAjMzcxNiByZXZpZXcpXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlUHVzaEdhdGUoe1xuICAgIGN3ZDogXCIveFwiLFxuICAgIHN0ZGluOiBcImdhcmJhZ2VcIixcbiAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gIH0pO1xuICBhc3NlcnQoIXJlc3VsdC5vayk7XG4gIGFzc2VydCghKHJlc3VsdC5lcnJvciBpbnN0YW5jZW9mIFByZVB1c2hHYXRlSW5mcmFzdHJ1Y3R1cmVFcnJvcikpO1xufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBtYWxmb3JtZWQgaG9vayBpbnB1dCBpcyBhbiBlcnJvclwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICBjd2Q6IFwiL3hcIixcbiAgICBzdGRpbjogXCJnYXJiYWdlXCIsXG4gICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICB9KTtcbiAgYXNzZXJ0KCFyZXN1bHQub2spO1xufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBnaXQgbHMtZmlsZXMgZmFpbHVyZSBpcyBhbiBlcnJvclwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGNhbGxzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBtYWtlR2l0ID0gKGxzRmlsZXNDb2RlOiBudW1iZXIpOiBQcmVQdXNoR2l0ID0+IChhcmdzKSA9PiB7XG4gICAgY2FsbHMucHVzaChhcmdzWzBdISk7XG4gICAgaWYgKGFyZ3NbMF0gPT09IFwibHMtZmlsZXNcIikge1xuICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7XG4gICAgICAgIGNvZGU6IGxzRmlsZXNDb2RlLFxuICAgICAgICBzdGRvdXQ6IFwiXCIsXG4gICAgICAgIHN0ZGVycjogbHNGaWxlc0NvZGUgPT09IDAgPyBcIlwiIDogXCJmYXRhbDogaW5kZXggY29ycnVwdFwiLFxuICAgICAgfSk7XG4gICAgfVxuICAgIHJldHVybiBQcm9taXNlLnJlc29sdmUoeyBjb2RlOiAwLCBzdGRvdXQ6IFwiXCIsIHN0ZGVycjogXCJcIiB9KTtcbiAgfTtcbiAgY29uc3QgaW5wdXQgPSB7XG4gICAgY3dkOiBcIi9ub25leGlzdGVudFwiLFxuICAgIHN0ZGluOiBgcmVmcy9oZWFkcy9tYWluICR7U0hBX0F9IHJlZnMvaGVhZHMvbWFpbiAke1NIQV9CfVxcbmAsXG4gICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICB9O1xuICBjb25zdCBmYWlsZWQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7IC4uLmlucHV0LCBnaXQ6IG1ha2VHaXQoMTI4KSB9KTtcbiAgYXNzZXJ0KCFmYWlsZWQub2spO1xuICBhc3NlcnQoZmFpbGVkLmVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoXCJscy1maWxlc1wiKSk7XG4gIGFzc2VydChmYWlsZWQuZXJyb3IubWVzc2FnZS5pbmNsdWRlcyhcImluZGV4IGNvcnJ1cHRcIikpO1xuICBhc3NlcnRJbnN0YW5jZU9mKGZhaWxlZC5lcnJvciwgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yKTtcbiAgYXNzZXJ0RXF1YWxzKGNhbGxzLCBbXCJsb2dcIiwgXCJsb2dcIiwgXCJscy1maWxlc1wiXSk7XG5cbiAgY29uc3QgYWNjZXB0ZWQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7IC4uLmlucHV0LCBnaXQ6IG1ha2VHaXQoMCkgfSk7XG4gIGFzc2VydChhY2NlcHRlZC5vayk7XG59KTtcblxuRGVuby50ZXN0KFwiZGVmYXVsdFByZVB1c2hHaXQ6IGEgbm9uZXhpc3RlbnQgd29ya2luZyBkaXJlY3RvcnkgZmFpbHMgY2xvc2VkXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgZGVmYXVsdFByZVB1c2hHaXQoXG4gICAgW1wic3RhdHVzXCJdLFxuICAgIFwiL25vbmV4aXN0ZW50L3ZpYmUtcHJlLXB1c2gtZGlyXCIsXG4gICk7XG4gIGFzc2VydChyZXN1bHQuY29kZSAhPT0gMCk7XG4gIGFzc2VydChyZXN1bHQuc3RkZXJyLnRyaW0oKS5sZW5ndGggPiAwKTtcblxuICBjb25zdCBkaXIgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRGlyKHsgcHJlZml4OiBcInByZV9wdXNoX2RlZmF1bHRfZ2l0X1wiIH0pO1xuICB0cnkge1xuICAgIGNvbnN0IG9rID0gYXdhaXQgZGVmYXVsdFByZVB1c2hHaXQoW1wiLS12ZXJzaW9uXCJdLCBkaXIpO1xuICAgIGFzc2VydEVxdWFscyhvay5jb2RlLCAwKTtcbiAgICBhc3NlcnQob2suc3Rkb3V0LnN0YXJ0c1dpdGgoXCJnaXQgdmVyc2lvblwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbi8vIC0tLS0gY3NwZWxsIChJc3N1ZSAjMzY4OSkgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbkRlbm8udGVzdChcInBsYW5DaGFuZ2VkRmlsZUNoZWNrczogY3NwZWxsIGNvbmZpZyBhbmQgYSBjaGFuZ2VkIC5tZCBwbGFucyBjc3BlbGwgd2l0aCB0aGUgZmlsZXNcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoXG4gICAgW1wicHItc3VtbWFyeS0xLm1kXCIsIFwieC5yc1wiXSxcbiAgICBbXCJjc3BlbGwuanNvblwiXSxcbiAgICB7XG4gICAgICByZXBvUm9vdDogXCIvclwiLFxuICAgICAgbWFya2Rvd25saW50QmluYXJ5OiBudWxsLFxuICAgICAgY3NwZWxsQmluYXJ5OiBcIi9yL2Jpbi9jc3BlbGxcIixcbiAgICAgIGNzcGVsbEluQ2k6IHRydWUsXG4gICAgfSxcbiAgKTtcbiAgYXNzZXJ0KHJlc3VsdC5vayk7XG4gIGNvbnN0IGNoZWNrID0gcmVzdWx0LnZhbHVlLmZpbmQoKGMpID0+IGMubGFiZWwgPT09IFwiY3NwZWxsXCIpO1xuICBhc3NlcnQoY2hlY2sgIT09IHVuZGVmaW5lZCk7XG4gIGFzc2VydEVxdWFscyhcbiAgICBjaGVjay5jb21tYW5kLFxuICAgIFwiJy9yL2Jpbi9jc3BlbGwnIC0tbm8tcHJvZ3Jlc3MgLS1uby1zdW1tYXJ5IC0tbm8tbXVzdC1maW5kLWZpbGVzIFwiICtcbiAgICAgIFwiJ3ByLXN1bW1hcnktMS5tZCdcIixcbiAgKTtcbiAgYXNzZXJ0RXF1YWxzKGNoZWNrLmN3ZCwgXCIvclwiKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJwbGFuQ2hhbmdlZEZpbGVDaGVja3M6IGEgZG9jcy9jc3BlbGwuanNvbiBjb25maWcgaXMgcGFzc2VkIHdpdGggLS1jb25maWdcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoW1wiQ0hBTkdFTE9HLm1kXCJdLCBbXCJkb2NzL2NzcGVsbC5qc29uXCJdLCB7XG4gICAgcmVwb1Jvb3Q6IFwiL3JcIixcbiAgICBtYXJrZG93bmxpbnRCaW5hcnk6IG51bGwsXG4gICAgY3NwZWxsQmluYXJ5OiBcIi9yL2Jpbi9jc3BlbGxcIixcbiAgICBjc3BlbGxJbkNpOiB0cnVlLFxuICB9KTtcbiAgYXNzZXJ0KHJlc3VsdC5vayk7XG4gIGFzc2VydChyZXN1bHQudmFsdWVbMF0hLmNvbW1hbmQuaW5jbHVkZXMoXCItLWNvbmZpZyBkb2NzL2NzcGVsbC5qc29uIFwiKSk7XG59KTtcblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBubyBjc3BlbGwgY29uZmlnIG1lYW5zIG5vIGNzcGVsbCBjaGVja1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHBsYW5DaGFuZ2VkRmlsZUNoZWNrcyhbXCJhLm1kXCJdLCBbXCJSRUFETUUubWRcIl0sIHtcbiAgICByZXBvUm9vdDogXCIvclwiLFxuICAgIG1hcmtkb3dubGludEJpbmFyeTogbnVsbCxcbiAgICBjc3BlbGxCaW5hcnk6IG51bGwsXG4gICAgY3NwZWxsSW5DaTogdHJ1ZSxcbiAgfSk7XG4gIGFzc2VydChyZXN1bHQub2spO1xuICBhc3NlcnRFcXVhbHMocmVzdWx0LnZhbHVlLCBbXSk7XG59KTtcblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBjc3BlbGwgY29uZmlndXJlZCBidXQgYmluYXJ5IG1pc3NpbmcgaXMgYW4gZXJyb3IgbmFtaW5nIGNzcGVsbFwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHBsYW5DaGFuZ2VkRmlsZUNoZWNrcyhbXCJhLm1kXCJdLCBbXCJjc3BlbGwuanNvblwiXSwge1xuICAgIHJlcG9Sb290OiBcIi9yXCIsXG4gICAgbWFya2Rvd25saW50QmluYXJ5OiBudWxsLFxuICAgIGNzcGVsbEJpbmFyeTogbnVsbCxcbiAgICBjc3BlbGxJbkNpOiB0cnVlLFxuICB9KTtcbiAgYXNzZXJ0KCFyZXN1bHQub2spO1xuICBhc3NlcnQocmVzdWx0LmVycm9yLmluY2x1ZGVzKFwiY3NwZWxsXCIpKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJwbGFuQ2hhbmdlZEZpbGVDaGVja3M6IG9ubHkgbm9uLXNwZWxsY2hlY2tlZCBleHRlbnNpb25zIG1lYW5zIG5vIGNzcGVsbCBjaGVja1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHBsYW5DaGFuZ2VkRmlsZUNoZWNrcyhbXCJzcmMvYS5yc1wiXSwgW1wiY3NwZWxsLmpzb25cIl0sIHtcbiAgICByZXBvUm9vdDogXCIvclwiLFxuICAgIG1hcmtkb3dubGludEJpbmFyeTogbnVsbCxcbiAgICBjc3BlbGxCaW5hcnk6IG51bGwsXG4gICAgY3NwZWxsSW5DaTogdHJ1ZSxcbiAgfSk7XG4gIGFzc2VydChyZXN1bHQub2spO1xuICBhc3NlcnRFcXVhbHMocmVzdWx0LnZhbHVlLCBbXSk7XG59KTtcblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBjc3BlbGwgY29uZmlnIGJ1dCByZXBvIENJIGRvZXMgbm90IHJ1biBjc3BlbGwgcGxhbnMgbm8gY2hlY2sgYW5kIGlzIG5vdCBibG9ja2VkXCIsICgpID0+IHtcbiAgY29uc3QgcmVzdWx0ID0gcGxhbkNoYW5nZWRGaWxlQ2hlY2tzKFtcIm5vdGVzLm1kXCJdLCBbXCJjc3BlbGwuanNvblwiXSwge1xuICAgIHJlcG9Sb290OiBcIi9yXCIsXG4gICAgbWFya2Rvd25saW50QmluYXJ5OiBudWxsLFxuICAgIGNzcGVsbEJpbmFyeTogbnVsbCxcbiAgICBjc3BlbGxJbkNpOiBmYWxzZSxcbiAgfSk7XG4gIGFzc2VydChyZXN1bHQub2spO1xuICBhc3NlcnRFcXVhbHMocmVzdWx0LnZhbHVlLmZpbmQoKGMpID0+IGMubGFiZWwgPT09IFwiY3NwZWxsXCIpLCB1bmRlZmluZWQpO1xufSk7XG5cbkRlbm8udGVzdChcInJlcG9DaVJ1bnNDc3BlbGw6IGEgd29ya2Zsb3cgcnVuIHN0ZXAgbmFtaW5nIGNzcGVsbCBjb3VudHNcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRGlyKCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtkaXJ9Ly5naXRodWIvd29ya2Zsb3dzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7ZGlyfS8uZ2l0aHViL3dvcmtmbG93cy9zcGVsbC55bWxgLFxuICAgICAgJ2pvYnM6XFxuICBzcGVsbDpcXG4gICAgc3RlcHM6XFxuICAgICAgLSBydW46IG5weCBjc3BlbGwgXCIqKi8qLm1kXCJcXG4nLFxuICAgICk7XG4gICAgYXNzZXJ0RXF1YWxzKFxuICAgICAgYXdhaXQgcmVwb0NpUnVuc0NzcGVsbChkaXIsIFtcIi5naXRodWIvd29ya2Zsb3dzL3NwZWxsLnltbFwiXSksXG4gICAgICB0cnVlLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJlcG9DaVJ1bnNDc3BlbGw6IGEgY29tbWVudGVkLW91dCBjc3BlbGwgc3RlcCBkb2VzIG5vdCBjb3VudFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IGRpciA9IGF3YWl0IERlbm8ubWFrZVRlbXBEaXIoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLm1rZGlyKGAke2Rpcn0vLmdpdGh1Yi93b3JrZmxvd3NgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtkaXJ9Ly5naXRodWIvd29ya2Zsb3dzL2NpLnltbGAsXG4gICAgICBcImpvYnM6XFxuICB0ZXN0OlxcbiAgICBzdGVwczpcXG4gICAgICAjIC0gcnVuOiBjc3BlbGwgLlxcbiAgICAgIC0gcnVuOiBkZW5vIHRlc3RcXG5cIixcbiAgICApO1xuICAgIGFzc2VydEVxdWFscyhcbiAgICAgIGF3YWl0IHJlcG9DaVJ1bnNDc3BlbGwoZGlyLCBbXCIuZ2l0aHViL3dvcmtmbG93cy9jaS55bWxcIl0pLFxuICAgICAgZmFsc2UsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShkaXIsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwicmVwb0NpUnVuc0NzcGVsbDogYSB0cmFja2VkIGZpbGUgb3V0c2lkZSAuZ2l0aHViL3dvcmtmbG93cy8gb3Igbm90IFlBTUwgZG9lcyBub3QgY291bnRcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCBkaXIgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRGlyKCk7XG4gIGNvbnN0IGJvZHkgPSBcImpvYnM6XFxuICBzcGVsbDpcXG4gICAgc3RlcHM6XFxuICAgICAgLSBydW46IG5weCBjc3BlbGwgLlxcblwiO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7ZGlyfS8uZ2l0aHViL3dvcmtmbG93c2AsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7ZGlyfS9jaWAsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtkaXJ9Ly5naXRodWIvd29ya2Zsb3dzL3JlYWwueW1sYCwgYm9keSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Rpcn0vY2kvc3BlbGwueW1sYCwgYm9keSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Rpcn0vLmdpdGh1Yi93b3JrZmxvd3Mvbm90ZXMubWRgLCBib2R5KTtcbiAgICAvLyBQb3NpdGl2ZSBjb250cm9sOiB0aGUgc2FtZSB0ZXh0IGluIGEgdHJhY2tlZCB3b3JrZmxvdyBZQU1MIGNvdW50cy5cbiAgICBhc3NlcnRFcXVhbHMoXG4gICAgICBhd2FpdCByZXBvQ2lSdW5zQ3NwZWxsKGRpciwgW1wiLmdpdGh1Yi93b3JrZmxvd3MvcmVhbC55bWxcIl0pLFxuICAgICAgdHJ1ZSxcbiAgICApO1xuICAgIC8vIFByZWZpeCBmaWx0ZXI6IGEgWUFNTCBvdXRzaWRlIC5naXRodWIvd29ya2Zsb3dzLyBpcyBhbm90aGVyIENJIHN5c3RlbSdzLlxuICAgIGFzc2VydEVxdWFscyhhd2FpdCByZXBvQ2lSdW5zQ3NwZWxsKGRpciwgW1wiY2kvc3BlbGwueW1sXCJdKSwgZmFsc2UpO1xuICAgIC8vIEV4dGVuc2lvbiBmaWx0ZXI6IGEgbm9uLVlBTUwgZmlsZSB1bmRlciAuZ2l0aHViL3dvcmtmbG93cy8gaXMgbm90IGEgd29ya2Zsb3cuXG4gICAgYXNzZXJ0RXF1YWxzKFxuICAgICAgYXdhaXQgcmVwb0NpUnVuc0NzcGVsbChkaXIsIFtcIi5naXRodWIvd29ya2Zsb3dzL25vdGVzLm1kXCJdKSxcbiAgICAgIGZhbHNlLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUoZGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJlcG9DaVJ1bnNDc3BlbGw6IGEgdHJhY2tlZCB3b3JrZmxvdyB0aGF0IGNhbm5vdCBiZSByZWFkIGlzIHNraXBwZWRcIiwgYXN5bmMgKCkgPT4ge1xuICBhc3NlcnRFcXVhbHMoXG4gICAgYXdhaXQgcmVwb0NpUnVuc0NzcGVsbChcIi9ub25leGlzdGVudFwiLCBbXCIuZ2l0aHViL3dvcmtmbG93cy94LnltbFwiXSksXG4gICAgZmFsc2UsXG4gICk7XG59KTtcblxuRGVuby50ZXN0KFwid29ya2Zsb3dSdW5zQ3NwZWxsOiBhIGJsb2NrLXNjYWxhciBydW4gc3RlcCB0aGF0IGNhbGxzIGNzcGVsbCBjb3VudHNcIiwgKCkgPT4ge1xuICBjb25zdCB5bWwgPVxuICAgICdqb2JzOlxcbiAgc3BlbGw6XFxuICAgIHN0ZXBzOlxcbiAgICAgIC0gbmFtZTogU3BlbGxcXG4gICAgICAgIHJ1bjogfFxcbiAgICAgICAgICBucG0gY2lcXG4gICAgICAgICAgbnB4IGNzcGVsbCAtLWNvbmZpZyBkb2NzL2NzcGVsbC5qc29uIFwiKiovKi5tZFwiXFxuJztcbiAgYXNzZXJ0KHdvcmtmbG93UnVuc0NzcGVsbCh5bWwpKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJ3b3JrZmxvd1J1bnNDc3BlbGw6IEdSUSdzIGNzcGVsbC1hY3Rpb24gdXNlcyBzdGVwIGNvdW50c1wiLCAoKSA9PiB7XG4gIGNvbnN0IHltbCA9XG4gICAgXCJqb2JzOlxcbiAgc3BlbGw6XFxuICAgIHN0ZXBzOlxcbiAgICAgIC0gdXNlczogc3RyZWV0c2lkZXNvZnR3YXJlL2NzcGVsbC1hY3Rpb25AdjZcXG5cIjtcbiAgYXNzZXJ0KHdvcmtmbG93UnVuc0NzcGVsbCh5bWwpKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJ3b3JrZmxvd1J1bnNDc3BlbGw6IGJsb2NrLXNjYWxhciBhbmQgc2luZ2xlLWxpbmUgc3RlcHMgd2l0aG91dCBjc3BlbGwgZG8gbm90IGNvdW50XCIsICgpID0+IHtcbiAgYXNzZXJ0KFxuICAgICF3b3JrZmxvd1J1bnNDc3BlbGwoXG4gICAgICBcImpvYnM6XFxuICB0ZXN0OlxcbiAgICBzdGVwczpcXG4gICAgICAtIHJ1bjogfFxcbiAgICAgICAgICBkZW5vIHRlc3RcXG4gICAgICAgICAgZGVubyBsaW50XFxuICAgICAgLSBydW46IGRlbm8gZm10IC0tY2hlY2tcXG5cIixcbiAgICApLFxuICApO1xufSk7XG5cbkRlbm8udGVzdChcIndvcmtmbG93UnVuc0NzcGVsbDogYSBjb21tZW50ZWQtb3V0IGNzcGVsbCBzdGVwIGluc2lkZSBhIGJsb2NrIGRvZXMgbm90IGNvdW50XCIsICgpID0+IHtcbiAgYXNzZXJ0KFxuICAgICF3b3JrZmxvd1J1bnNDc3BlbGwoXG4gICAgICBcImpvYnM6XFxuICB0ZXN0OlxcbiAgICBzdGVwczpcXG4gICAgICAtIHJ1bjogfFxcbiAgICAgICAgICBkZW5vIHRlc3RcXG4gICAgICAgICAgIyBucHggY3NwZWxsIC5cXG5cIixcbiAgICApLFxuICApO1xufSk7XG5cbi8vIEVhY2ggdGVzdCBiZWxvdyBnb2VzIHJlZCB3aGVuIG9uZSBicmFuY2ggb2Ygd29ya2Zsb3dSdW5zQ3NwZWxsIGlzIGJyb2tlblxuLy8gKFBSICMzNzE2IHJldmlldyk6IHRoZSBibG9jayBlbmQsIHRoZSBibGFuay1saW5lIHNraXAsIGFuZCB0aGUgYmxvY2sgaGVhZGVyLlxuRGVuby50ZXN0KFwid29ya2Zsb3dSdW5zQ3NwZWxsOiBhIHNpbmdsZS1saW5lIGNzcGVsbCBzdGVwIGFmdGVyIGEgYmxvY2stc2NhbGFyIHN0ZXAgY291bnRzXCIsICgpID0+IHtcbiAgYXNzZXJ0KFxuICAgIHdvcmtmbG93UnVuc0NzcGVsbChcbiAgICAgICdqb2JzOlxcbiAgdGVzdDpcXG4gICAgc3RlcHM6XFxuICAgICAgLSBydW46IHxcXG4gICAgICAgICAgbnBtIGNpXFxuICAgICAgLSBydW46IG5weCBjc3BlbGwgXCIqKi8qLm1kXCJcXG4nLFxuICAgICksXG4gICk7XG59KTtcblxuRGVuby50ZXN0KFwid29ya2Zsb3dSdW5zQ3NwZWxsOiBhIGJsYW5rIGxpbmUgaW5zaWRlIGEgYmxvY2sgZG9lcyBub3QgZW5kIGl0XCIsICgpID0+IHtcbiAgYXNzZXJ0KFxuICAgIHdvcmtmbG93UnVuc0NzcGVsbChcbiAgICAgICdqb2JzOlxcbiAgdGVzdDpcXG4gICAgc3RlcHM6XFxuICAgICAgLSBydW46IHxcXG4gICAgICAgICAgbnBtIGNpXFxuXFxuICAgICAgICAgIG5weCBjc3BlbGwgXCIqKi8qLm1kXCJcXG4nLFxuICAgICksXG4gICk7XG59KTtcblxuRGVuby50ZXN0KFwid29ya2Zsb3dSdW5zQ3NwZWxsOiBibG9jayBoZWFkZXJzIHdpdGggY2hvbXBpbmcgb3IgaW5kZW50IGluZGljYXRvcnMgYXJlIGJsb2Nrc1wiLCAoKSA9PiB7XG4gIGZvciAoY29uc3QgaGVhZGVyIG9mIFtcInwtXCIsIFwiPlwiLCBcIj4tXCIsIFwifCtcIiwgXCJ8MlwiXSkge1xuICAgIGFzc2VydChcbiAgICAgIHdvcmtmbG93UnVuc0NzcGVsbChcbiAgICAgICAgYGpvYnM6XFxuICB0ZXN0OlxcbiAgICBzdGVwczpcXG4gICAgICAtIHJ1bjogJHtoZWFkZXJ9XFxuICAgICAgICAgIG5weCBjc3BlbGwgXCIqKi8qLm1kXCJcXG5gLFxuICAgICAgKSxcbiAgICAgIGBoZWFkZXIgJHtoZWFkZXJ9YCxcbiAgICApO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwicnVuUHJlUHVzaEdhdGU6IGEgY3NwZWxsIGNvbmZpZyB3aXRoIG5vIENJIGNzcGVsbCBzdGVwIGlzIG5vdCBibG9ja2VkIGFuZCBuZXZlciBsb29rcyBmb3IgY3NwZWxsXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSwgc3RkaW4gfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7Y2xvbmV9L2RvY3NgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L2RvY3MvY3NwZWxsLmpzb25gLCBcInt9XFxuXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCIuXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJuZXN0ZWQgY3NwZWxsIGNvbmZpZ1wiKTtcbiAgICBjb25zdCB0aXAgPSBhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKTtcbiAgICBsZXQgbG9va2VkID0gZmFsc2U7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlUHVzaEdhdGUoe1xuICAgICAgY3dkOiBjbG9uZSxcbiAgICAgIHN0ZGluOiBzdGRpbi5yZXBsYWNlKFxuICAgICAgICAvIFswLTlhLWZdezQwfSByZWZzXFwvaGVhZHNcXC9tYWluLyxcbiAgICAgICAgYCAke3RpcH0gcmVmcy9oZWFkcy9tYWluYCxcbiAgICAgICksXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoKSA9PiBmYWxzZSwgW10pLFxuICAgICAgZmluZE1hcmtkb3dubGludDogKCkgPT4gUHJvbWlzZS5yZXNvbHZlKFwiL2Zha2UvbWRsXCIpLFxuICAgICAgZmluZENzcGVsbDogKCkgPT4ge1xuICAgICAgICBsb29rZWQgPSB0cnVlO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKG51bGwpO1xuICAgICAgfSxcbiAgICB9KTtcbiAgICBhc3NlcnQoIWxvb2tlZCwgXCJjc3BlbGwgbXVzdCBub3QgYmUgbG9va2VkIHVwIHdoZW4gQ0kgZG9lcyBub3QgcnVuIGl0XCIpO1xuICAgIGFzc2VydChcbiAgICAgIHJlc3VsdC5vayxcbiAgICAgIGB0aGUgcHVzaCBtdXN0IG5vdCBiZSBibG9ja2VkIG9uIGNzcGVsbDogJHtcbiAgICAgICAgcmVzdWx0Lm9rID8gXCJcIiA6IHJlc3VsdC5lcnJvci5tZXNzYWdlXG4gICAgICB9YCxcbiAgICApO1xuICAgIGFzc2VydChcbiAgICAgICFyZXN1bHQudmFsdWUuY2hlY2tzUnVuLnNvbWUoKGMpID0+IGMuaW5jbHVkZXMoXCItLW5vLW11c3QtZmluZC1maWxlc1wiKSksXG4gICAgICBgbm8gY3NwZWxsIGNoZWNrIG1heSBiZSBwbGFubmVkOiAke1xuICAgICAgICBKU09OLnN0cmluZ2lmeShyZXN1bHQudmFsdWUuY2hlY2tzUnVuKVxuICAgICAgfWAsXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBhIGNzcGVsbCBjb25maWcgd2l0aCBhIEdSUS1zdHlsZSBjc3BlbGwtYWN0aW9uIHN0ZXAgaXMgYmxvY2tlZCB3aGVuIGNzcGVsbCBpcyBtaXNzaW5nXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSwgc3RkaW4gfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7Y2xvbmV9L2RvY3NgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L2RvY3MvY3NwZWxsLmpzb25gLCBcInt9XFxuXCIpO1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7Y2xvbmV9Ly5naXRodWIvd29ya2Zsb3dzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7Y2xvbmV9Ly5naXRodWIvd29ya2Zsb3dzL3NwZWxsLnltbGAsXG4gICAgICBcImpvYnM6XFxuICBzcGVsbDpcXG4gICAgc3RlcHM6XFxuICAgICAgLSB1c2VzOiBzdHJlZXRzaWRlc29mdHdhcmUvY3NwZWxsLWFjdGlvbkB2NlxcblwiLFxuICAgICk7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImFkZFwiLCBcIi5cIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImNvbW1pdFwiLCBcIi1xbVwiLCBcImNzcGVsbCBjb25maWcgYW5kIENJXCIpO1xuICAgIGNvbnN0IHRpcCA9IGF3YWl0IGdpdChjbG9uZSwgXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCIpO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICAgIGN3ZDogY2xvbmUsXG4gICAgICBzdGRpbjogc3RkaW4ucmVwbGFjZShcbiAgICAgICAgLyBbMC05YS1mXXs0MH0gcmVmc1xcL2hlYWRzXFwvbWFpbi8sXG4gICAgICAgIGAgJHt0aXB9IHJlZnMvaGVhZHMvbWFpbmAsXG4gICAgICApLFxuICAgICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoKCkgPT4gZmFsc2UsIFtdKSxcbiAgICAgIGZpbmRNYXJrZG93bmxpbnQ6ICgpID0+IFByb21pc2UucmVzb2x2ZShcIi9mYWtlL21kbFwiKSxcbiAgICAgIGZpbmRDc3BlbGw6ICgpID0+IFByb21pc2UucmVzb2x2ZShudWxsKSxcbiAgICB9KTtcbiAgICBhc3NlcnQoIXJlc3VsdC5vaywgXCJDSSBydW5zIGNzcGVsbCwgc28gYSBtaXNzaW5nIGJpbmFyeSBtdXN0IGJsb2NrXCIpO1xuICAgIGFzc2VydChyZXN1bHQuZXJyb3IubWVzc2FnZS5pbmNsdWRlcyhcImNzcGVsbFwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogYSBmYWlsaW5nIGNzcGVsbCBibG9ja3MgdGhlIHB1c2hcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJvb3QsIGNsb25lLCBzdGRpbiB9ID0gYXdhaXQgbWFrZVJlcG9XaXRoRG9jQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Nsb25lfS9jc3BlbGwuanNvbmAsIFwie31cXG5cIik7XG4gICAgLy8gVGhlIHJlcG8ncyBvd24gQ0kgcnVucyBjc3BlbGwsIHNvIHRoZSBnYXRlIG11c3QgcnVuIGl0IHRvby5cbiAgICBhd2FpdCBEZW5vLm1rZGlyKGAke2Nsb25lfS8uZ2l0aHViL3dvcmtmbG93c2AsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgIGAke2Nsb25lfS8uZ2l0aHViL3dvcmtmbG93cy9zcGVsbC55bWxgLFxuICAgICAgJ2pvYnM6XFxuICBzcGVsbDpcXG4gICAgc3RlcHM6XFxuICAgICAgLSBydW46IG5weCBjc3BlbGwgXCIqKi8qLm1kXCJcXG4nLFxuICAgICk7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImFkZFwiLCBcIi5cIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImNvbW1pdFwiLCBcIi1xbVwiLCBcImNzcGVsbCBjb25maWcgYW5kIENJXCIpO1xuICAgIGNvbnN0IHRpcCA9IGF3YWl0IGdpdChjbG9uZSwgXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCIpO1xuICAgIGNvbnN0IHNlZW46IHN0cmluZ1tdID0gW107XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlUHVzaEdhdGUoe1xuICAgICAgY3dkOiBjbG9uZSxcbiAgICAgIHN0ZGluOiBzdGRpbi5yZXBsYWNlKFxuICAgICAgICAvIFswLTlhLWZdezQwfSByZWZzXFwvaGVhZHNcXC9tYWluLyxcbiAgICAgICAgYCAke3RpcH0gcmVmcy9oZWFkcy9tYWluYCxcbiAgICAgICksXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoYykgPT4gYy5pbmNsdWRlcyhcIi9mYWtlL2NzcGVsbFwiKSwgc2VlbiksXG4gICAgICBmaW5kTWFya2Rvd25saW50OiAoKSA9PiBQcm9taXNlLnJlc29sdmUoXCIvZmFrZS9tZGxcIiksXG4gICAgICBmaW5kQ3NwZWxsOiAoKSA9PiBQcm9taXNlLnJlc29sdmUoXCIvZmFrZS9jc3BlbGxcIiksXG4gICAgfSk7XG4gICAgYXNzZXJ0KCFyZXN1bHQub2spO1xuICAgIGFzc2VydEluc3RhbmNlT2YocmVzdWx0LmVycm9yLCBQcmVGbGlnaHRHYXRlRXJyb3IpO1xuICAgIGFzc2VydChyZXN1bHQuZXJyb3IuY29tbWFuZC5pbmNsdWRlcyhcIi9mYWtlL2NzcGVsbFwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyAtLS0tIEZsb2NpIENsb3VkRm9ybWF0aW9uIGRlcGxveSB0ZXN0IChJc3N1ZSAjMzcyNykgLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG5jb25zdCBGTE9DSV9DSEVDSyA9IFwiZmxvY2kgY2xvdWRmb3JtYXRpb25cIjtcbmNvbnN0IEZMT0NJX0NPTU1BTkQgPSBcImJhc2ggaW5mcmEvY2xvdWRmb3JtYXRpb24vdGVzdC1mbG9jaS5zaFwiO1xuXG5EZW5vLnRlc3QoXCJwbGFuQ2hhbmdlZEZpbGVDaGVja3M6IGEgY2hhbmdlZCB0ZW1wbGF0ZSBwbGFucyB0aGUgRmxvY2kgZGVwbG95IHRlc3Qgb25jZVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHBsYW5DaGFuZ2VkRmlsZUNoZWNrcyhcbiAgICBbXG4gICAgICBcImluZnJhL2Nsb3VkZm9ybWF0aW9uL2xpbnV4LXZlcmlmaWNhdGlvbi1ob3N0LnlhbWxcIixcbiAgICAgIFwiaW5mcmEvY2xvdWRmb3JtYXRpb24vb3RoZXIueWFtbFwiLFxuICAgIF0sXG4gICAgW1xuICAgICAgXCJpbmZyYS9jbG91ZGZvcm1hdGlvbi90ZXN0LWZsb2NpLnNoXCIsXG4gICAgICBcImluZnJhL2Nsb3VkZm9ybWF0aW9uL2xpbnV4LXZlcmlmaWNhdGlvbi1ob3N0LnlhbWxcIixcbiAgICBdLFxuICAgIHsgcmVwb1Jvb3Q6IFwiL3JlcG9cIiwgbWFya2Rvd25saW50QmluYXJ5OiBudWxsIH0sXG4gICk7XG4gIGFzc2VydChyZXN1bHQub2spO1xuICBhc3NlcnRFcXVhbHMoXG4gICAgcmVzdWx0LnZhbHVlLmZpbHRlcigoYykgPT4gYy5sYWJlbCA9PT0gRkxPQ0lfQ0hFQ0spLFxuICAgIFt7IGxhYmVsOiBGTE9DSV9DSEVDSywgY3dkOiBcIi9yZXBvXCIsIGNvbW1hbmQ6IEZMT0NJX0NPTU1BTkQgfV0sXG4gICk7XG59KTtcblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBhIGNoYW5nZSB0byB0ZXN0LWZsb2NpLnNoIGl0c2VsZiBwbGFucyB0aGUgRmxvY2kgZGVwbG95IHRlc3RcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoXG4gICAgW1wiaW5mcmEvY2xvdWRmb3JtYXRpb24vdGVzdC1mbG9jaS5zaFwiXSxcbiAgICBbXCJpbmZyYS9jbG91ZGZvcm1hdGlvbi90ZXN0LWZsb2NpLnNoXCJdLFxuICAgIHsgcmVwb1Jvb3Q6IFwiL3JlcG9cIiwgbWFya2Rvd25saW50QmluYXJ5OiBudWxsIH0sXG4gICk7XG4gIGFzc2VydChyZXN1bHQub2spO1xuICBhc3NlcnRFcXVhbHMoXG4gICAgcmVzdWx0LnZhbHVlLmZpbHRlcigoYykgPT4gYy5sYWJlbCA9PT0gRkxPQ0lfQ0hFQ0spLFxuICAgIFt7IGxhYmVsOiBGTE9DSV9DSEVDSywgY3dkOiBcIi9yZXBvXCIsIGNvbW1hbmQ6IEZMT0NJX0NPTU1BTkQgfV0sXG4gICk7XG59KTtcblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBubyBGbG9jaSBkZXBsb3kgdGVzdCBvdXRzaWRlIGluZnJhL2Nsb3VkZm9ybWF0aW9uL1wiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHBsYW5DaGFuZ2VkRmlsZUNoZWNrcyhcbiAgICBbXG4gICAgICBcImluZnJhL2hvc3QvaW5zdGFsbC1kZW5vLnNoXCIsXG4gICAgICBcImluZnJhL2Nsb3VkZm9ybWF0aW9uLW9sZC94LnlhbWxcIixcbiAgICAgIFwiZG9jcy9hLm1kXCIsXG4gICAgXSxcbiAgICBbXCJpbmZyYS9jbG91ZGZvcm1hdGlvbi90ZXN0LWZsb2NpLnNoXCIsIFwiZG9jcy9hLm1kXCJdLFxuICAgIHsgcmVwb1Jvb3Q6IFwiL3JlcG9cIiwgbWFya2Rvd25saW50QmluYXJ5OiBudWxsIH0sXG4gICk7XG4gIGFzc2VydChyZXN1bHQub2spO1xuICBhc3NlcnRFcXVhbHMocmVzdWx0LnZhbHVlLmZpbHRlcigoYykgPT4gYy5sYWJlbCA9PT0gRkxPQ0lfQ0hFQ0spLCBbXSk7XG59KTtcblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBubyBGbG9jaSBkZXBsb3kgdGVzdCB3aGVuIHRoZSByZXBvIGRvZXMgbm90IHRyYWNrIHRoZSBzY3JpcHRcIiwgKCkgPT4ge1xuICBjb25zdCByZXN1bHQgPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoXG4gICAgW1wiaW5mcmEvY2xvdWRmb3JtYXRpb24vbGludXgtdmVyaWZpY2F0aW9uLWhvc3QueWFtbFwiXSxcbiAgICBbXCJpbmZyYS9jbG91ZGZvcm1hdGlvbi9saW51eC12ZXJpZmljYXRpb24taG9zdC55YW1sXCJdLFxuICAgIHsgcmVwb1Jvb3Q6IFwiL3JlcG9cIiwgbWFya2Rvd25saW50QmluYXJ5OiBudWxsIH0sXG4gICk7XG4gIGFzc2VydChyZXN1bHQub2spO1xuICBhc3NlcnRFcXVhbHMocmVzdWx0LnZhbHVlLmZpbHRlcigoYykgPT4gYy5sYWJlbCA9PT0gRkxPQ0lfQ0hFQ0spLCBbXSk7XG59KTtcblxuLyoqXG4gKiBMaWtlIHtAbGluayBtYWtlUmVwb1dpdGhEb2NDb21taXR9LCBidXQgdGhlIG9uZSBsb2NhbCBjb21taXQgYWRkcyB0aGUgRmxvY2lcbiAqIHNjcmlwdCBhbmQgYSBDbG91ZEZvcm1hdGlvbiB0ZW1wbGF0ZSB1bmRlciBgaW5mcmEvY2xvdWRmb3JtYXRpb24vYC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gbWFrZVJlcG9XaXRoRmxvY2lDb21taXQoKTogUHJvbWlzZTxcbiAgeyByb290OiBzdHJpbmc7IGNsb25lOiBzdHJpbmc7IHN0ZGluOiBzdHJpbmcgfVxuPiB7XG4gIGNvbnN0IHJvb3QgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRGlyKHsgcHJlZml4OiBcInZpYmUtcHAtZmxvY2ktXCIgfSk7XG4gIGNvbnN0IHJlbW90ZSA9IGAke3Jvb3R9L3JlbW90ZS5naXRgO1xuICBjb25zdCBjbG9uZSA9IGAke3Jvb3R9L2Nsb25lYDtcbiAgYXdhaXQgZ2l0KHJvb3QsIFwiaW5pdFwiLCBcIi1xXCIsIFwiLS1iYXJlXCIsIFwiLWJcIiwgXCJtYWluXCIsIHJlbW90ZSk7XG4gIGF3YWl0IGdpdChyb290LCBcImNsb25lXCIsIFwiLXFcIiwgcmVtb3RlLCBjbG9uZSk7XG4gIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtjbG9uZX0vZGVuby5qc29uYCwgXCJ7fVxcblwiKTtcbiAgYXdhaXQgZ2l0KGNsb25lLCBcImFkZFwiLCBcIi5cIik7XG4gIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJpbml0XCIpO1xuICBhd2FpdCBnaXQoY2xvbmUsIFwicHVzaFwiLCBcIi1xXCIsIFwib3JpZ2luXCIsIFwiSEVBRDptYWluXCIpO1xuICBhd2FpdCBEZW5vLm1rZGlyKGAke2Nsb25lfS9pbmZyYS9jbG91ZGZvcm1hdGlvbmAsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgYCR7Y2xvbmV9L2luZnJhL2Nsb3VkZm9ybWF0aW9uL3Rlc3QtZmxvY2kuc2hgLFxuICAgIFwiIyEvdXNyL2Jpbi9lbnYgYmFzaFxcblwiLFxuICApO1xuICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgYCR7Y2xvbmV9L2luZnJhL2Nsb3VkZm9ybWF0aW9uL3QueWFtbGAsXG4gICAgXCJBV1NUZW1wbGF0ZUZvcm1hdFZlcnNpb246ICcyMDEwLTA5LTA5J1xcblwiLFxuICApO1xuICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLlwiKTtcbiAgYXdhaXQgZ2l0KGNsb25lLCBcImNvbW1pdFwiLCBcIi1xbVwiLCBcImZsb2NpXCIpO1xuICBjb25zdCBzaGEgPSBhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKTtcbiAgcmV0dXJuIHtcbiAgICByb290LFxuICAgIGNsb25lLFxuICAgIHN0ZGluOiBgcmVmcy9oZWFkcy9tYWluICR7c2hhfSByZWZzL2hlYWRzL21haW4gJHtcIjBcIi5yZXBlYXQoNDApfVxcbmAsXG4gIH07XG59XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBhIGZhaWxpbmcgRmxvY2kgZGVwbG95IHRlc3QgYmxvY2tzIHRoZSBwdXNoXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgeyByb290LCBjbG9uZSwgc3RkaW4gfSA9IGF3YWl0IG1ha2VSZXBvV2l0aEZsb2NpQ29tbWl0KCk7XG4gIHRyeSB7XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCBydW4gPSAoZmFpbDogYm9vbGVhbikgPT5cbiAgICAgIHJ1blByZVB1c2hHYXRlKHtcbiAgICAgICAgY3dkOiBjbG9uZSxcbiAgICAgICAgc3RkaW4sXG4gICAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoXG4gICAgICAgICAgKGMpID0+IGZhaWwgJiYgYy5pbmNsdWRlcyhcInRlc3QtZmxvY2kuc2hcIiksXG4gICAgICAgICAgc2VlbixcbiAgICAgICAgKSxcbiAgICAgIH0pO1xuXG4gICAgY29uc3QgYmxvY2tlZCA9IGF3YWl0IHJ1bih0cnVlKTtcbiAgICBhc3NlcnQoIWJsb2NrZWQub2spO1xuICAgIGFzc2VydEluc3RhbmNlT2YoYmxvY2tlZC5lcnJvciwgUHJlRmxpZ2h0R2F0ZUVycm9yKTtcbiAgICBhc3NlcnRFcXVhbHMoYmxvY2tlZC5lcnJvci5yZWFzb24sIFwibm9uLXplcm8tZXhpdFwiKTtcbiAgICBhc3NlcnRFcXVhbHMoYmxvY2tlZC5lcnJvci5jb21tYW5kLCBGTE9DSV9DT01NQU5EKTtcblxuICAgIGNvbnN0IGFjY2VwdGVkID0gYXdhaXQgcnVuKGZhbHNlKTtcbiAgICBhc3NlcnQoYWNjZXB0ZWQub2spO1xuICAgIGFzc2VydChhY2NlcHRlZC52YWx1ZS5jaGVja3NSdW4uaW5jbHVkZXMoRkxPQ0lfQ09NTUFORCkpO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwicmVwb1NoZWxsY2hlY2tQb2xpY3k6IHJlcG9zaXRvcnkgd29ya2Zsb3dzIGRpc3Rpbmd1aXNoIGV4ZWN1dGlvbiBmcm9tIGxvZ2dpbmcgYW5kIHNjcmlwdCBkYXRhXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3QgcmVwbyA9IG5ldyBVUkwoXCIuLi8uLi8uLi9cIiwgaW1wb3J0Lm1ldGEudXJsKS5wYXRobmFtZTtcbiAgY29uc3QgdHJhY2tlZCA9IChhd2FpdCBnaXQocmVwbywgXCJscy1maWxlc1wiLCBcIi16XCIpKS5zcGxpdChcIlxcMFwiKS5maWx0ZXIoXG4gICAgQm9vbGVhbixcbiAgKTtcbiAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVwb1NoZWxsY2hlY2tQb2xpY3kocmVwbywgdHJhY2tlZCk7XG4gIGFzc2VydChyZXN1bHQub2ssIHJlc3VsdC5vayA/IFwiXCIgOiByZXN1bHQuZXJyb3IpO1xuICBhc3NlcnQocmVzdWx0LnZhbHVlKTtcbiAgLy8gRGVyaXZlIHRoZSBleHBlY3RhdGlvbiBmcm9tIHRoZSB3b3JrZmxvdyB0ZXh0IGl0c2VsZiwgbm90IHR5cGVkLWluIGNvcGllcy5cbiAgY29uc3Qgd29ya2Zsb3cgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShcbiAgICBuZXcgVVJMKFwiLi4vLi4vLi4vLmdpdGh1Yi93b3JrZmxvd3MvdmFsaWRhdGUtc2NyaXB0cy55bWxcIiwgaW1wb3J0Lm1ldGEudXJsKSxcbiAgKTtcbiAgYXNzZXJ0RXF1YWxzKFxuICAgIHJlc3VsdC52YWx1ZS52ZXJzaW9uLFxuICAgIC9eXFxzKlNIRUxMQ0hFQ0tfVkVSU0lPTjpcXHMqW1wiJ10/KFxcZCtcXC5cXGQrXFwuXFxkKykvbS5leGVjKHdvcmtmbG93KT8uWzFdLFxuICApO1xuICBjb25zdCBleGVjID0gLy1leGVjXFxzK3NoZWxsY2hlY2tcXHMrKC4rPylcXHMrXFx7XFx9XFxzK1xcKy8uZXhlYyh3b3JrZmxvdyk7XG4gIGFzc2VydChleGVjLCBcInRoZSByZXBvc2l0b3J5IHdvcmtmbG93IHJ1bnMgU2hlbGxDaGVjayB0aHJvdWdoIGZpbmQgLWV4ZWNcIik7XG4gIGFzc2VydEVxdWFscyhyZXN1bHQudmFsdWUuZmxhZ3MsIGV4ZWNbMV0hLnNwbGl0KC9cXHMrLykpO1xuICBjb25zdCBjb250YWluZXIgPSBhd2FpdCByZXBvU2hlbGxjaGVja1BvbGljeShcbiAgICByZXBvLFxuICAgIHRyYWNrZWQuZmlsdGVyKChwKSA9PlxuICAgICAgIXAuc3RhcnRzV2l0aChcIi5naXRodWIvd29ya2Zsb3dzL1wiKSB8fCBwLmVuZHNXaXRoKFwiL2NvbnRhaW5lci1idWlsZC55bWxcIilcbiAgICApLFxuICApO1xuICBhc3NlcnRFcXVhbHMoY29udGFpbmVyLCB7IG9rOiB0cnVlLCB2YWx1ZTogbnVsbCB9KTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJyZXBvU2hlbGxjaGVja1BvbGljeTogaW52YWxpZCBwb2xpY2llcyByZXR1cm4gZXhwbGljaXQgZXJyb3JzXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdCA9IGF3YWl0IERlbm8ubWFrZVRlbXBEaXIoKTtcbiAgY29uc3QgcGF0aCA9IFwiLmdpdGh1Yi93b3JrZmxvd3MvY2hlY2sueW1sXCI7XG4gIGF3YWl0IERlbm8ubWtkaXIoYCR7cm9vdH0vLmdpdGh1Yi93b3JrZmxvd3NgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCBjYXNlczogW3N0cmluZywgc3RyaW5nXVtdID0gW1xuICAgICAgW1xuICAgICAgICBTSEVMTENIRUNLX1dPUktGTE9XKFwiLS1yY2ZpbGUgL3RtcC9jb25maWdcIiksXG4gICAgICAgIFwidW5zYWZlIFNoZWxsQ2hlY2sgcmNmaWxlIHBhdGhcIixcbiAgICAgIF0sXG4gICAgICBbXG4gICAgICAgIFNIRUxMQ0hFQ0tfV09SS0ZMT1coXCItLXJjZmlsZSBjb25maWcvLi4vcmNcIiksXG4gICAgICAgIFwidW5zYWZlIFNoZWxsQ2hlY2sgcmNmaWxlIHBhdGhcIixcbiAgICAgIF0sXG4gICAgICBbU0hFTExDSEVDS19XT1JLRkxPVyhcIi0tcmNmaWxlIC4vcmNcIiksIFwidW5zYWZlIFNoZWxsQ2hlY2sgcmNmaWxlIHBhdGhcIl0sXG4gICAgICBbU0hFTExDSEVDS19XT1JLRkxPVyhcIi0tcmNmaWxlPVwiKSwgXCJtaXNzaW5nIFNoZWxsQ2hlY2sgcmNmaWxlXCJdLFxuICAgICAgW1NIRUxMQ0hFQ0tfV09SS0ZMT1coXCItLXJjZmlsZVwiKSwgXCJtaXNzaW5nIFNoZWxsQ2hlY2sgcmNmaWxlXCJdLFxuICAgICAgW1NIRUxMQ0hFQ0tfV09SS0ZMT1coXCItLXJjZmlsZSAtLW5vcmNcIiksIFwibWlzc2luZyBTaGVsbENoZWNrIHJjZmlsZVwiXSxcbiAgICAgIFtcbiAgICAgICAgU0hFTExDSEVDS19XT1JLRkxPVyhcIi0tcmNmaWxlPS90bXAvY29uZmlnXCIpLFxuICAgICAgICBcInVuc2FmZSBTaGVsbENoZWNrIHJjZmlsZSBwYXRoXCIsXG4gICAgICBdLFxuICAgICAgW1xuICAgICAgICBTSEVMTENIRUNLX1dPUktGTE9XKFwiLS1yY2ZpbGU9Y29uZmlnLy4uL3JjXCIpLFxuICAgICAgICBcInVuc2FmZSBTaGVsbENoZWNrIHJjZmlsZSBwYXRoXCIsXG4gICAgICBdLFxuICAgICAgW1NIRUxMQ0hFQ0tfV09SS0ZMT1coXCItZVwiKSwgXCJtaXNzaW5nIHZhbHVlIGZvciBTaGVsbENoZWNrIG9wdGlvbiAtZVwiXSxcbiAgICAgIFtTSEVMTENIRUNLX1dPUktGTE9XKFwiLWFiY1wiKSwgXCJ1bnN1cHBvcnRlZCBTaGVsbENoZWNrIG9wdGlvbiAtYWJjXCJdLFxuICAgICAgW1xuICAgICAgICBTSEVMTENIRUNLX1dPUktGTE9XKFwiLXMgLS1ub3JjXCIpLFxuICAgICAgICBcIm1pc3NpbmcgdmFsdWUgZm9yIFNoZWxsQ2hlY2sgb3B0aW9uIC1zXCIsXG4gICAgICBdLFxuICAgICAgW1xuICAgICAgICBTSEVMTENIRUNLX1dPUktGTE9XKFwic2NyaXB0cy5zaFwiKSxcbiAgICAgICAgXCJ1bnN1cHBvcnRlZCBwb3NpdGlvbmFsIFNoZWxsQ2hlY2sgYXJndW1lbnRcIixcbiAgICAgIF0sXG4gICAgICBbXG4gICAgICAgIFNIRUxMQ0hFQ0tfV09SS0ZMT1coXCItZSBTQzIwODZcIikucmVwbGFjZShcbiAgICAgICAgICAnZmluZCAuIC1uYW1lIFwiKi5zaFwiIC10eXBlIGYgLWV4ZWMgJyxcbiAgICAgICAgICBcIlwiLFxuICAgICAgICApLnJlcGxhY2UoXCIge30gK1wiLCBcIiAqLnNoXCIpLFxuICAgICAgICBcInVuc3VwcG9ydGVkIFNoZWxsQ2hlY2sgY29tbWFuZFwiLFxuICAgICAgXSxcbiAgICAgIFtcbiAgICAgICAgU0hFTExDSEVDS19XT1JLRkxPVyhcIi1lIFNDMjA4NlwiKS5yZXBsYWNlKFxuICAgICAgICAgIGBcIiR7U1RVQl9TSEVMTENIRUNLX1ZFUlNJT059XCJgLFxuICAgICAgICAgICdcImxhdGVzdFwiJyxcbiAgICAgICAgKSxcbiAgICAgICAgXCJkb2VzIG5vdCBkZWNsYXJlIG9uZSBzdXBwb3J0ZWQgcGlubmVkIHZlcnNpb25cIixcbiAgICAgIF0sXG4gICAgICBbXG4gICAgICAgIFNIRUxMQ0hFQ0tfV09SS0ZMT1coXCItZSBTQzIwODZcIikgK1xuICAgICAgICBcIiAgICBkZWZhdWx0czpcXG4gICAgICBydW46XFxuICAgICAgICB3b3JraW5nLWRpcmVjdG9yeTogc2NyaXB0c1xcblwiLFxuICAgICAgICBcInVuc3VwcG9ydGVkIHdvcmtpbmctZGlyZWN0b3J5XCIsXG4gICAgICBdLFxuICAgICAgW1xuICAgICAgICBcImpvYnM6XFxuICBsaW50OlxcbiAgICBzdGVwczpcXG4gICAgICAtIHVzZXM6IGV4YW1wbGUvc2hlbGxjaGVjay1hY3Rpb25AdjFcXG5cIixcbiAgICAgICAgXCJ1bnN1cHBvcnRlZCBTaGVsbENoZWNrIGFjdGlvbiBpbiB3b3JrZmxvd1wiLFxuICAgICAgXSxcbiAgICAgIFtcbiAgICAgICAgU1lOQ0VEX1NIRUxMQ0hFQ0tfV09SS0ZMT1cucmVwbGFjZShcbiAgICAgICAgICBcInNldmVyaXR5OiB3YXJuaW5nXCIsXG4gICAgICAgICAgXCJzZXZlcml0eTogd2FybmluZ1xcbiAgICAgICAgICBpZ25vcmVfcGF0aHM6IHZlbmRvclwiLFxuICAgICAgICApLFxuICAgICAgICBcInVuc3VwcG9ydGVkIFNoZWxsQ2hlY2sgYWN0aW9uIG9wdGlvbiBpZ25vcmVfcGF0aHNcIixcbiAgICAgIF0sXG4gICAgICBbXG4gICAgICAgIFNZTkNFRF9TSEVMTENIRUNLX1dPUktGTE9XLnJlcGxhY2UoXCJzY2FuZGlyOiAuXCIsIFwic2NhbmRpcjogc2NyaXB0c1wiKSxcbiAgICAgICAgXCJ1bnN1cHBvcnRlZCBTaGVsbENoZWNrIGFjdGlvbiBvcHRpb24gc2NhbmRpclwiLFxuICAgICAgXSxcbiAgICAgIFtcbiAgICAgICAgU1lOQ0VEX1NIRUxMQ0hFQ0tfV09SS0ZMT1cucmVwbGFjZShcIndhcm5pbmdcIiwgXCJsb3VkXCIpLFxuICAgICAgICBcInVuc3VwcG9ydGVkIFNoZWxsQ2hlY2sgYWN0aW9uIG9wdGlvbiBzZXZlcml0eVwiLFxuICAgICAgXSxcbiAgICAgIFtcbiAgICAgICAgU1lOQ0VEX1NIRUxMQ0hFQ0tfV09SS0ZMT1cucmVwbGFjZShcbiAgICAgICAgICBcIiAgICAgICAgd2l0aDpcXG4gICAgICAgICAgc2NhbmRpcjogLlwiLFxuICAgICAgICAgIFwiICAgICAgICBlbnY6XFxuICAgICAgICAgIFNIRUxMQ0hFQ0tfT1BUUzogLWUgU0MyMDg2XFxuICAgICAgICB3aXRoOlxcbiAgICAgICAgICBzY2FuZGlyOiAuXCIsXG4gICAgICAgICksXG4gICAgICAgIFwidW5zdXBwb3J0ZWQgU2hlbGxDaGVjayBhY3Rpb24gb3B0aW9uIFNIRUxMQ0hFQ0tfT1BUU1wiLFxuICAgICAgXSxcbiAgICBdO1xuICAgIGZvciAoY29uc3QgW2JvZHksIGVycm9yXSBvZiBjYXNlcykge1xuICAgICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3Jvb3R9LyR7cGF0aH1gLCBib2R5KTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoXSk7XG4gICAgICBhc3NlcnRFcXVhbHMocmVzdWx0Lm9rLCBmYWxzZSwgYm9keSk7XG4gICAgICBpZiAoIXJlc3VsdC5vaykge1xuICAgICAgICBhc3NlcnQocmVzdWx0LmVycm9yLmluY2x1ZGVzKGVycm9yKSwgYCR7Ym9keX06ICR7cmVzdWx0LmVycm9yfWApO1xuICAgICAgfVxuICAgIH1cbiAgICBhd2FpdCBEZW5vLnJlbW92ZShgJHtyb290fS8ke3BhdGh9YCk7XG4gICAgbGV0IHJlYWRFcnJvcjogRXJyb3IgfCB1bmRlZmluZWQ7XG4gICAgdHJ5IHtcbiAgICAgIGF3YWl0IERlbm8ubHN0YXQoYCR7cm9vdH0vJHtwYXRofWApO1xuICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICByZWFkRXJyb3IgPSBlcnJvciBhcyBFcnJvcjtcbiAgICB9XG4gICAgYXNzZXJ0KHJlYWRFcnJvcik7XG4gICAgYXNzZXJ0RXF1YWxzKGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoXSksIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBgY2Fubm90IHJlYWQgdHJhY2tlZCB3b3JrZmxvdyAke3BhdGh9OiAke3JlYWRFcnJvci5tZXNzYWdlfWAsXG4gICAgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJyZXBvU2hlbGxjaGVja1BvbGljeTogbm9uLXdvcmtmbG93IHBhdGhzLCBjb21tZW50cywgcHJvYmVzIGFuZCBzaG9ydCByY2ZpbGUgb3B0aW9uXCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdCA9IGF3YWl0IERlbm8ubWFrZVRlbXBEaXIoKTtcbiAgY29uc3QgcGF0aCA9IFwiLmdpdGh1Yi93b3JrZmxvd3MvY2hlY2sueWFtbFwiO1xuICBhd2FpdCBEZW5vLm1rZGlyKGAke3Jvb3R9Ly5naXRodWIvd29ya2Zsb3dzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHRyeSB7XG4gICAgY29uc3QgaWdub3JlZCA9IFtcImNoZWNrLnltbFwiLCBcIi5naXRodWIvd29ya2Zsb3dzL2NoZWNrLnR4dFwiXTtcbiAgICBhc3NlcnRFcXVhbHMoYXdhaXQgcmVwb1NoZWxsY2hlY2tQb2xpY3kocm9vdCwgaWdub3JlZCksIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IG51bGwsXG4gICAgfSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7cm9vdH0vJHtwYXRofWAsXG4gICAgICBTSEVMTENIRUNLX1dPUktGTE9XKFwiLXJjIGNvbmZpZy9yY1wiKS5yZXBsYWNlKFxuICAgICAgICBcIiAgICAgICAgICBmaW5kIC5cIixcbiAgICAgICAgJyAgICAgICAgICAjIHNoZWxsY2hlY2sgaWdub3JlZC5zaFxcblxcbiAgICAgICAgICBzaGVsbGNoZWNrIC0tdmVyc2lvblxcbiAgICAgICAgICBlY2hvIFwiaW5zdGFsbGluZyBzaGVsbGNoZWNrXCJcXG4gICAgICAgICAgc3VkbyBhcHQtZ2V0IGluc3RhbGwgc2hlbGxjaGVja1xcbiAgICAgICAgICBmaW5kIC4nLFxuICAgICAgKSxcbiAgICApO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoLCBcImNvbmZpZy9yY1wiXSk7XG4gICAgYXNzZXJ0RXF1YWxzKHJlc3VsdCwge1xuICAgICAgb2s6IHRydWUsXG4gICAgICB2YWx1ZToge1xuICAgICAgICB2ZXJzaW9uOiBTVFVCX1NIRUxMQ0hFQ0tfVkVSU0lPTixcbiAgICAgICAgZmxhZ3M6IFtcIi1yY1wiLCBcImNvbmZpZy9yY1wiXSxcbiAgICAgICAgY29uZmlnRmlsZXM6IFtcImNvbmZpZy9yY1wiXSxcbiAgICAgICAgd29ya2Zsb3dGaWxlczogW3BhdGhdLFxuICAgICAgfSxcbiAgICB9KTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBhIGNvbW1lbnRlZCBZQU1MIGJsb2NrIGhlYWRlciBzdGlsbCBwbGFucyB0aGUgU2hlbGxDaGVjayBjaGVja1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGNvbnN0IHRpcCA9IGF3YWl0IGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhjbG9uZSwge1xuICAgICAgXCJiYWQuc2hcIjogXCIjIS9iaW4vc2hcXG5lY2hvICQxXFxuXCIsXG4gICAgfSk7XG4gICAgY29uc3QgcGF0aCA9IGAke2Nsb25lfS8uZ2l0aHViL3dvcmtmbG93cy92YWxpZGF0ZS1zY3JpcHRzLnltbGA7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgcGF0aCxcbiAgICAgIChhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShwYXRoKSkucmVwbGFjZShcbiAgICAgICAgXCJydW46IHxcIixcbiAgICAgICAgXCJydW46IHwgIyBDaGVjayBzY3JpcHRzXCIsXG4gICAgICApLFxuICAgICk7XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW46IHByZVB1c2hJbnB1dCh0aXApLFxuICAgICAgcHJlRmxpZ2h0Q29tbWFuZHM6IFtdLFxuICAgICAgLi4uc3R1YlNoZWxsY2hlY2soKSxcbiAgICAgIHJ1bm5lcjogcmVjb3JkaW5nUnVubmVyKChjb21tYW5kKSA9PiBjb21tYW5kLmluY2x1ZGVzKFwiYmFkLnNoXCIpLCBzZWVuKSxcbiAgICB9KTtcbiAgICBhc3NlcnRFcXVhbHMocmVzdWx0Lm9rLCBmYWxzZSk7XG4gICAgYXNzZXJ0KHNlZW4uc29tZSgoY29tbWFuZCkgPT4gY29tbWFuZC5pbmNsdWRlcyhcImJhZC5zaFwiKSksIHNlZW4uam9pbihcIlxcblwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5mb3IgKGNvbnN0IGNvbmZpZyBvZiBbXCIuc2hlbGxjaGVja3JjXCIsIFwic2NyaXB0cy8uc2hlbGxjaGVja3JjXCJdKSB7XG4gIERlbm8udGVzdChgcnVuUHJlUHVzaEdhdGU6IGRlbGV0aW5nICR7Y29uZmlnfSByZXZhbGlkYXRlcyB1bmNoYW5nZWQgc2NyaXB0cyB3aXRob3V0IGl0YCwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBEZW5vLm1rZGlyKGAke2Nsb25lfS9zY3JpcHRzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBhd2FpdCBjb21taXRTaGVsbGNoZWNrRmlsZXMoY2xvbmUsIHtcbiAgICAgICAgXCJzY3JpcHRzL2JhZC5zaFwiOiBcIiMhL2Jpbi9zaFxcbmVjaG8gJDFcXG5cIixcbiAgICAgICAgW2NvbmZpZ106IFwiZGlzYWJsZT1TQzIwODZcXG5cIixcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgZ2l0KGNsb25lLCBcInB1c2hcIiwgXCItcVwiLCBcIm9yaWdpblwiLCBcIkhFQUQ6bWFpblwiKTtcbiAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKGAke2Nsb25lfS8ke2NvbmZpZ31gKTtcbiAgICAgIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCItQVwiKTtcbiAgICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJyZW1vdmUgY29uZmlnXCIpO1xuICAgICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICAgICAgY3dkOiBjbG9uZSxcbiAgICAgICAgc3RkaW46IHByZVB1c2hJbnB1dChhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKSksXG4gICAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgICAgLi4uc3R1YlNoZWxsY2hlY2soKSxcbiAgICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoKCkgPT4gZmFsc2UsIHNlZW4pLFxuICAgICAgfSk7XG4gICAgICBhc3NlcnQocmVzdWx0Lm9rLCByZXN1bHQub2sgPyBcIlwiIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UpO1xuICAgICAgY29uc3QgY29tbWFuZCA9IHNlZW4uZmluZCgodmFsdWUpID0+IHZhbHVlLmluY2x1ZGVzKFwic2NyaXB0cy9iYWQuc2hcIikpO1xuICAgICAgYXNzZXJ0KGNvbW1hbmQsIHNlZW4uam9pbihcIlxcblwiKSk7XG4gICAgICBhc3NlcnQoY29tbWFuZC5pbmNsdWRlcyhcIi0tbm9yY1wiKSwgY29tbWFuZCk7XG4gICAgICBhc3NlcnQoIWNvbW1hbmQuaW5jbHVkZXMoXCItLXJjZmlsZVwiKSwgY29tbWFuZCk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59XG5cbkRlbm8udGVzdChcInJlcG9TaGVsbGNoZWNrUG9saWN5OiBkZWxlZ2F0ZWQgZXhlY3V0aW9uIGhhcyBhbiBleHBsaWNpdCBmYWxzZSB2ZXJkaWN0XCIsIGFzeW5jICgpID0+IHtcbiAgY29uc3Qgcm9vdCA9IGF3YWl0IERlbm8ubWFrZVRlbXBEaXIoKTtcbiAgY29uc3QgcGF0aCA9IFwiLmdpdGh1Yi93b3JrZmxvd3MvY2hlY2sueW1sXCI7XG4gIGF3YWl0IERlbm8ubWtkaXIoYCR7cm9vdH0vLmdpdGh1Yi93b3JrZmxvd3NgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtyb290fS8ke3BhdGh9YCxcbiAgICAgIFwiam9iczpcXG4gIGxpbnQ6XFxuICAgIHN0ZXBzOlxcbiAgICAgIC0gcnVuOiBiYXNoIGNoZWNrLnNoXFxuXCIsXG4gICAgKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtyb290fS9jaGVjay5zaGAsXG4gICAgICBcIiMhL2Jpbi9zaFxcbiMgc2hlbGxjaGVjayBkaXNhYmxlPVNDMjA4NlxcbmVjaG8gJ3NoZWxsY2hlY2sgbG9ncydcXG5JTUFHRV9QQVRIUz0oXFxuICAnZGF0YS5zaCdcXG4pXFxuXCIsXG4gICAgKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtyb290fS9kYXRhLnNoYCxcbiAgICAgIFwiIyEvYmluL3NoXFxuc2hlbGxjaGVjayBzY3JpcHQuc2hcXG5cIixcbiAgICApO1xuICAgIGFzc2VydEVxdWFscyhcbiAgICAgIGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoLCBcImNoZWNrLnNoXCIsIFwiZGF0YS5zaFwiXSksXG4gICAgICB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZTogbnVsbCxcbiAgICAgIH0sXG4gICAgKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtyb290fS9jaGVjay5zaGAsXG4gICAgICBcIiMhL2Jpbi9zaFxcbnNoZWxsY2hlY2sgc2NyaXB0LnNoXFxuXCIsXG4gICAgKTtcbiAgICBhc3NlcnRFcXVhbHMoYXdhaXQgcmVwb1NoZWxsY2hlY2tQb2xpY3kocm9vdCwgW3BhdGgsIFwiY2hlY2suc2hcIl0pLCB7XG4gICAgICBvazogZmFsc2UsXG4gICAgICBlcnJvcjpcbiAgICAgICAgYHJlcG9zaXRvcnkgQ0kgZGVsZWdhdGVzIFNoZWxsQ2hlY2sgdGhyb3VnaCBhIHNjcmlwdCBpbiB3b3JrZmxvdyAke3BhdGh9YCxcbiAgICB9KTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJlcG9TaGVsbGNoZWNrUG9saWN5OiBjb21tZW50cyBhbmQgdmVyc2lvbiBwcm9iZXMgZG8gbm90IGJlY29tZSBjaGVja3NcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCByb290ID0gYXdhaXQgRGVuby5tYWtlVGVtcERpcigpO1xuICBjb25zdCBwYXRoID0gXCIuZ2l0aHViL3dvcmtmbG93cy9jaGVjay55bWxcIjtcbiAgYXdhaXQgRGVuby5ta2RpcihgJHtyb290fS8uZ2l0aHViL3dvcmtmbG93c2AsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB0cnkge1xuICAgIGZvciAoXG4gICAgICBjb25zdCBsaW5lIG9mIFtcIlwiLCBcIiMgc2hlbGxjaGVjayBpZ25vcmVkLnNoXCIsIFwic2hlbGxjaGVjayAtLXZlcnNpb25cIl1cbiAgICApIHtcbiAgICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgICAgYCR7cm9vdH0vJHtwYXRofWAsXG4gICAgICAgIFNIRUxMQ0hFQ0tfV09SS0ZMT1coXCItZSBTQzIwODZcIikucmVwbGFjZShcbiAgICAgICAgICBcIiAgICAgICAgICBmaW5kIC5cIixcbiAgICAgICAgICBgJHtsaW5lID8gYCAgICAgICAgICAke2xpbmV9XFxuYCA6IFwiXFxuXCJ9ICAgICAgICAgIGZpbmQgLmAsXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVwb1NoZWxsY2hlY2tQb2xpY3kocm9vdCwgW3BhdGhdKTtcbiAgICAgIGFzc2VydEVxdWFscyhyZXN1bHQub2ssIHRydWUsIGxpbmUpO1xuICAgICAgaWYgKHJlc3VsdC5vaykgYXNzZXJ0RXF1YWxzKHJlc3VsdC52YWx1ZT8uZmxhZ3MsIFtcIi1lXCIsIFwiU0MyMDg2XCJdKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJyZXBvU2hlbGxjaGVja1BvbGljeTogdGhlIHdvcmtlcidzIHN5bmNlZCBsdWRlZXVzIHRlbXBsYXRlIGlzIGEgc3VwcG9ydGVkIHBvbGljeVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJvb3QgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRGlyKCk7XG4gIGNvbnN0IHBhdGggPSBcIi5naXRodWIvd29ya2Zsb3dzL3NoZWxsY2hlY2sueW1sXCI7XG4gIGF3YWl0IERlbm8ubWtkaXIoYCR7cm9vdH0vLmdpdGh1Yi93b3JrZmxvd3NgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7cm9vdH0vJHtwYXRofWAsIFNZTkNFRF9TSEVMTENIRUNLX1dPUktGTE9XKTtcbiAgICBhc3NlcnRFcXVhbHMoYXdhaXQgcmVwb1NoZWxsY2hlY2tQb2xpY3kocm9vdCwgW3BhdGgsIFwiLnNoZWxsY2hlY2tyY1wiXSksIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHtcbiAgICAgICAgdmVyc2lvbjogbnVsbCxcbiAgICAgICAgZmxhZ3M6IFtcIi0tc2V2ZXJpdHk9d2FybmluZ1wiXSxcbiAgICAgICAgY29uZmlnRmlsZXM6IFtcIi5zaGVsbGNoZWNrcmNcIl0sXG4gICAgICAgIHdvcmtmbG93RmlsZXM6IFtwYXRoXSxcbiAgICAgIH0sXG4gICAgfSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJyZXBvU2hlbGxjaGVja1BvbGljeTogdmFsdWUtdGFraW5nIG9wdGlvbnMgY29uc3VtZSB0aGVpciB2YWx1ZVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJvb3QgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRGlyKCk7XG4gIGNvbnN0IHBhdGggPSBcIi5naXRodWIvd29ya2Zsb3dzL2NoZWNrLnltbFwiO1xuICBhd2FpdCBEZW5vLm1rZGlyKGAke3Jvb3R9Ly5naXRodWIvd29ya2Zsb3dzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHRyeSB7XG4gICAgY29uc3QgYWNjZXB0ZWQ6IFtzdHJpbmcsIHN0cmluZ1tdXVtdID0gW1xuICAgICAgW1wiLVMgd2FybmluZ1wiLCBbXCItU1wiLCBcIndhcm5pbmdcIl1dLFxuICAgICAgW1wiLS1zZXZlcml0eSB3YXJuaW5nXCIsIFtcIi0tc2V2ZXJpdHlcIiwgXCJ3YXJuaW5nXCJdXSxcbiAgICAgIFtcIi0tc2V2ZXJpdHk9d2FybmluZ1wiLCBbXCItLXNldmVyaXR5PXdhcm5pbmdcIl1dLFxuICAgICAgW1wiLVN3YXJuaW5nXCIsIFtcIi1Td2FybmluZ1wiXV0sXG4gICAgICBbXCItLWVuYWJsZSBhbGxcIiwgW1wiLS1lbmFibGVcIiwgXCJhbGxcIl1dLFxuICAgICAgW1wiLW8gYWxsXCIsIFtcIi1vXCIsIFwiYWxsXCJdXSxcbiAgICAgIFtcIi1pIFNDMjA4NlwiLCBbXCItaVwiLCBcIlNDMjA4NlwiXV0sXG4gICAgICBbXCItLWluY2x1ZGU9U0MyMDg2XCIsIFtcIi0taW5jbHVkZT1TQzIwODZcIl1dLFxuICAgICAgW1wiLVAgU0NSSVBURElSXCIsIFtcIi1QXCIsIFwiU0NSSVBURElSXCJdXSxcbiAgICAgIFtcIi0tc291cmNlLXBhdGg9U0NSSVBURElSXCIsIFtcIi0tc291cmNlLXBhdGg9U0NSSVBURElSXCJdXSxcbiAgICAgIFtcIi1mIGdjY1wiLCBbXCItZlwiLCBcImdjY1wiXV0sXG4gICAgICBbXCItLWZvcm1hdCBnY2NcIiwgW1wiLS1mb3JtYXRcIiwgXCJnY2NcIl1dLFxuICAgICAgW1wiLVcgMFwiLCBbXCItV1wiLCBcIjBcIl1dLFxuICAgICAgW1wiLS13aWtpLWxpbmstY291bnQgMFwiLCBbXCItLXdpa2ktbGluay1jb3VudFwiLCBcIjBcIl1dLFxuICAgICAgW1wiLXggLWFcIiwgW1wiLXhcIiwgXCItYVwiXV0sXG4gICAgXTtcbiAgICBmb3IgKGNvbnN0IFtmbGFncywgZXhwZWN0ZWRdIG9mIGFjY2VwdGVkKSB7XG4gICAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7cm9vdH0vJHtwYXRofWAsIFNIRUxMQ0hFQ0tfV09SS0ZMT1coZmxhZ3MpKTtcbiAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoXSk7XG4gICAgICBhc3NlcnQocmVzdWx0Lm9rLCBgJHtmbGFnc306ICR7cmVzdWx0Lm9rID8gXCJcIiA6IHJlc3VsdC5lcnJvcn1gKTtcbiAgICAgIGFzc2VydEVxdWFscyhyZXN1bHQudmFsdWU/LmZsYWdzLCBleHBlY3RlZCwgZmxhZ3MpO1xuICAgIH1cbiAgICBjb25zdCByZWplY3RlZDogW3N0cmluZywgc3RyaW5nXVtdID0gW1xuICAgICAgW1wiLVNcIiwgXCJtaXNzaW5nIHZhbHVlIGZvciBTaGVsbENoZWNrIG9wdGlvbiAtU1wiXSxcbiAgICAgIFtcIi0tc2V2ZXJpdHlcIiwgXCJtaXNzaW5nIHZhbHVlIGZvciBTaGVsbENoZWNrIG9wdGlvbiAtLXNldmVyaXR5XCJdLFxuICAgICAgW1wiLS1zZXZlcml0eT1cIiwgXCJtaXNzaW5nIHZhbHVlIGZvciBTaGVsbENoZWNrIG9wdGlvbiAtLXNldmVyaXR5XCJdLFxuICAgICAgW1wiLS1lbmFibGUgLS1ub3JjXCIsIFwibWlzc2luZyB2YWx1ZSBmb3IgU2hlbGxDaGVjayBvcHRpb24gLS1lbmFibGVcIl0sXG4gICAgICBbXCItUyB3YXJuaW5nIHN0cmF5XCIsIFwidW5zdXBwb3J0ZWQgcG9zaXRpb25hbCBTaGVsbENoZWNrIGFyZ3VtZW50XCJdLFxuICAgIF07XG4gICAgZm9yIChjb25zdCBbZmxhZ3MsIGVycm9yXSBvZiByZWplY3RlZCkge1xuICAgICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3Jvb3R9LyR7cGF0aH1gLCBTSEVMTENIRUNLX1dPUktGTE9XKGZsYWdzKSk7XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCByZXBvU2hlbGxjaGVja1BvbGljeShyb290LCBbcGF0aF0pO1xuICAgICAgYXNzZXJ0RXF1YWxzKHJlc3VsdC5vaywgZmFsc2UsIGZsYWdzKTtcbiAgICAgIGlmICghcmVzdWx0Lm9rKSBhc3NlcnQocmVzdWx0LmVycm9yLmluY2x1ZGVzKGVycm9yKSwgcmVzdWx0LmVycm9yKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJyZXBvU2hlbGxjaGVja1BvbGljeTogZmxhZ2xlc3MgZmluZCBhbmQgd3JhcHBlZCBpbnZvY2F0aW9uc1wiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJvb3QgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRGlyKCk7XG4gIGNvbnN0IHBhdGggPSBcIi5naXRodWIvd29ya2Zsb3dzL2NoZWNrLnltbFwiO1xuICBhd2FpdCBEZW5vLm1rZGlyKGAke3Jvb3R9Ly5naXRodWIvd29ya2Zsb3dzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke3Jvb3R9LyR7cGF0aH1gLCBTSEVMTENIRUNLX1dPUktGTE9XKFwiXCIpKTtcbiAgICBjb25zdCBwbGFpbiA9IGF3YWl0IHJlcG9TaGVsbGNoZWNrUG9saWN5KHJvb3QsIFtwYXRoXSk7XG4gICAgYXNzZXJ0KHBsYWluLm9rKTtcbiAgICBhc3NlcnRFcXVhbHMocGxhaW4udmFsdWU/LmZsYWdzLCBbXSk7XG4gICAgZm9yIChcbiAgICAgIGNvbnN0IGNvbW1hbmQgb2YgW1xuICAgICAgICBcImdpdCBscy1maWxlcyAnKi5zaCcgfCB4YXJncyBzaGVsbGNoZWNrXCIsXG4gICAgICAgIFwiZmluZCAuIC1wcmludDAgfCB4YXJncyAtMCBzaGVsbGNoZWNrXCIsXG4gICAgICAgICdmb3IgZiBpbiAqLnNoOyBkbyBzaGVsbGNoZWNrIFwiJGZcIjsgZG9uZScsXG4gICAgICAgIFwidGltZSBzaGVsbGNoZWNrIHguc2hcIixcbiAgICAgICAgXCJleGVjIHNoZWxsY2hlY2sgeC5zaFwiLFxuICAgICAgICBcIm5pY2Ugc2hlbGxjaGVjayB4LnNoXCIsXG4gICAgICAgIFwidGltZW91dCAxMCBzaGVsbGNoZWNrIHguc2hcIixcbiAgICAgICAgXCJwYXJhbGxlbCBzaGVsbGNoZWNrIDo6OiB4LnNoXCIsXG4gICAgICBdXG4gICAgKSB7XG4gICAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICAgIGAke3Jvb3R9LyR7cGF0aH1gLFxuICAgICAgICBTSEVMTENIRUNLX1dPUktGTE9XKFwiXCIpLnJlcGxhY2UoXG4gICAgICAgICAgJ2ZpbmQgLiAtbmFtZSBcIiouc2hcIiAtdHlwZSBmIC1leGVjIHNoZWxsY2hlY2sgIHt9ICsnLFxuICAgICAgICAgIGNvbW1hbmQsXG4gICAgICAgICksXG4gICAgICApO1xuICAgICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcmVwb1NoZWxsY2hlY2tQb2xpY3kocm9vdCwgW3BhdGhdKTtcbiAgICAgIGFzc2VydCghcmVzdWx0Lm9rLCBjb21tYW5kKTtcbiAgICB9XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogZmxhZ2xlc3MgZmluZCBjaGVja3MgYSBjaGFuZ2VkIHNjcmlwdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IGNvbW1pdFNoZWxsY2hlY2tGaWxlcyhjbG9uZSwgeyBcInJ1bi5zaFwiOiBcIiMhL2Jpbi9zaFxcbnRydWVcXG5cIiB9LCBcIlwiKTtcbiAgICBjb25zdCBzZWVuOiBzdHJpbmdbXSA9IFtdO1xuICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICAgIGN3ZDogY2xvbmUsXG4gICAgICBzdGRpbjogcHJlUHVzaElucHV0KGF3YWl0IGdpdChjbG9uZSwgXCJyZXYtcGFyc2VcIiwgXCJIRUFEXCIpKSxcbiAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgIC4uLnN0dWJTaGVsbGNoZWNrKCksXG4gICAgICBydW5uZXI6IHJlY29yZGluZ1J1bm5lcigoKSA9PiBmYWxzZSwgc2VlbiksXG4gICAgfSk7XG4gICAgYXNzZXJ0KHJlc3VsdC5vaywgcmVzdWx0Lm9rID8gXCJcIiA6IHJlc3VsdC5lcnJvci5tZXNzYWdlKTtcbiAgICBhc3NlcnQoXG4gICAgICBzZWVuLnNvbWUoKGNvbW1hbmQpID0+XG4gICAgICAgIGNvbW1hbmQuaW5jbHVkZXMoXCJzaGVsbGNoZWNrXCIpICYmIGNvbW1hbmQuaW5jbHVkZXMoXCJydW4uc2hcIilcbiAgICAgICksXG4gICAgKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBhd2FpdCBEZW5vLnJlbW92ZShyb290LCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxufSk7XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiB1bnJlbGF0ZWQgd29ya2Zsb3cgY2hhbmdlcyBkbyBub3QgdHJpZ2dlciBhbiB1bnN1cHBvcnRlZCBwb2xpY3lcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJvb3QsIGNsb25lIH0gPSBhd2FpdCBtYWtlUmVwb1dpdGhEb2NDb21taXQoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwicHVzaFwiLCBcIi1xXCIsIFwib3JpZ2luXCIsIFwiSEVBRDptYWluXCIpO1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7Y2xvbmV9Ly5naXRodWIvd29ya2Zsb3dzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7Y2xvbmV9Ly5naXRodWIvd29ya2Zsb3dzL3NoZWxsY2hlY2sueW1sYCxcbiAgICAgIFwiam9iczpcXG4gIGxpbnQ6XFxuICAgIHN0ZXBzOlxcbiAgICAgIC0gdXNlczogZXhhbXBsZS9zaGVsbGNoZWNrLWFjdGlvbkB2MVxcblwiLFxuICAgICk7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImFkZFwiLCBcIi1BXCIpO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJ1bnN1cHBvcnRlZCBwb2xpY3lcIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcInB1c2hcIiwgXCItcVwiLCBcIm9yaWdpblwiLCBcIkhFQUQ6bWFpblwiKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtjbG9uZX0vLmdpdGh1Yi93b3JrZmxvd3MvcnVzdC55bWxgLFxuICAgICAgXCJuYW1lOiBSdXN0XFxuXCIsXG4gICAgKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLUFcIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImNvbW1pdFwiLCBcIi1xbVwiLCBcInVucmVsYXRlZCB3b3JrZmxvd1wiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW46IHByZVB1c2hJbnB1dChhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKSksXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgICBmaW5kU2hlbGxjaGVjazogKCkgPT4gUHJvbWlzZS5yZXNvbHZlKG51bGwpLFxuICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoKCkgPT4gZmFsc2UsIFtdKSxcbiAgICB9KTtcbiAgICBhc3NlcnQocmVzdWx0Lm9rLCByZXN1bHQub2sgPyBcIlwiIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UpO1xuICB9IGZpbmFsbHkge1xuICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICB9XG59KTtcblxuRGVuby50ZXN0KFwicnVuUHJlUHVzaEdhdGU6IGEgc3luY2VkIGx1ZGVldXMgd29ya2Zsb3cgcGxhbnMgLS1zZXZlcml0eSBmb3IgYSBjaGFuZ2VkIHNjcmlwdFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJwdXNoXCIsIFwiLXFcIiwgXCJvcmlnaW5cIiwgXCJIRUFEOm1haW5cIik7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtjbG9uZX0vLmdpdGh1Yi93b3JrZmxvd3NgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtjbG9uZX0vLmdpdGh1Yi93b3JrZmxvd3Mvc2hlbGxjaGVjay55bWxgLFxuICAgICAgU1lOQ0VEX1NIRUxMQ0hFQ0tfV09SS0ZMT1csXG4gICAgKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L3J1bi5zaGAsIFwiIyEvYmluL3NoXFxudHJ1ZVxcblwiKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLUFcIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImNvbW1pdFwiLCBcIi1xbVwiLCBcInN5bmNlZCB3b3JrZmxvdyBhbmQgYSBzY3JpcHRcIik7XG4gICAgY29uc3Qgc2Vlbjogc3RyaW5nW10gPSBbXTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW46IHByZVB1c2hJbnB1dChhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKSksXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgICAvLyBBIGhvc3QgU2hlbGxDaGVjayBvZiBhbnkgdmVyc2lvbiBzYXRpc2ZpZXMgYW4gYWN0aW9uLW1hbmFnZWQgcG9saWN5LlxuICAgICAgLi4uc3R1YlNoZWxsY2hlY2soXCI3LjcuN1wiKSxcbiAgICAgIHJ1bm5lcjogcmVjb3JkaW5nUnVubmVyKCgpID0+IGZhbHNlLCBzZWVuKSxcbiAgICB9KTtcbiAgICBhc3NlcnQocmVzdWx0Lm9rLCByZXN1bHQub2sgPyBcIlwiIDogcmVzdWx0LmVycm9yLm1lc3NhZ2UpO1xuICAgIGFzc2VydChcbiAgICAgIHNlZW4uc29tZSgoY29tbWFuZCkgPT5cbiAgICAgICAgY29tbWFuZC5pbmNsdWRlcyhcIi0tc2V2ZXJpdHk9d2FybmluZ1wiKSAmJiBjb21tYW5kLmluY2x1ZGVzKFwicnVuLnNoXCIpXG4gICAgICApLFxuICAgICAgc2Vlbi5qb2luKFwiXFxuXCIpLFxuICAgICk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5mb3IgKFxuICBjb25zdCBbbGFiZWwsIHdvcmtmbG93XSBvZiBbXG4gICAgW1widGhlIHdvcmtlcidzIHN5bmNlZCBsdWRlZXVzIHRlbXBsYXRlXCIsIFNZTkNFRF9TSEVMTENIRUNLX1dPUktGTE9XXSxcbiAgICBbXG4gICAgICBcImFuIHVuc3VwcG9ydGVkIFNoZWxsQ2hlY2sgYWN0aW9uXCIsXG4gICAgICBcImpvYnM6XFxuICBsaW50OlxcbiAgICBzdGVwczpcXG4gICAgICAtIHVzZXM6IGV4YW1wbGUvc2hlbGxjaGVjay1hY3Rpb25AdjFcXG5cIixcbiAgICBdLFxuICAgIFtcbiAgICAgIFwiYSBkZWxlZ2F0aW5nIHNjcmlwdFwiLFxuICAgICAgXCJqb2JzOlxcbiAgbGludDpcXG4gICAgc3RlcHM6XFxuICAgICAgLSBydW46IC4vcXVhbGl0eS5zaFxcblwiLFxuICAgIF0sXG4gIF0gYXMgY29uc3Rcbikge1xuICBEZW5vLnRlc3QoYHJ1blByZVB1c2hHYXRlOiBhIG5vbi1zaGVsbCBwdXNoIGlzIG5vdCByZWZ1c2VkIGluIGEgcmVwbyB3aXRoICR7bGFiZWx9YCwgYXN5bmMgKCkgPT4ge1xuICAgIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICAgIHRyeSB7XG4gICAgICBhd2FpdCBnaXQoY2xvbmUsIFwicHVzaFwiLCBcIi1xXCIsIFwib3JpZ2luXCIsIFwiSEVBRDptYWluXCIpO1xuICAgICAgYXdhaXQgRGVuby5ta2RpcihgJHtjbG9uZX0vLmdpdGh1Yi93b3JrZmxvd3NgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgICAgYCR7Y2xvbmV9Ly5naXRodWIvd29ya2Zsb3dzL3NoZWxsY2hlY2sueW1sYCxcbiAgICAgICAgd29ya2Zsb3csXG4gICAgICApO1xuICAgICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgICBgJHtjbG9uZX0vcXVhbGl0eS5zaGAsXG4gICAgICAgIFwiIyEvYmluL2Jhc2hcXG5zaGVsbGNoZWNrICouc2hcXG5cIixcbiAgICAgICk7XG4gICAgICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLUFcIik7XG4gICAgICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwiYWRkIHRoZSB3b3JrZmxvd1wiKTtcbiAgICAgIGF3YWl0IGdpdChjbG9uZSwgXCJwdXNoXCIsIFwiLXFcIiwgXCJvcmlnaW5cIiwgXCJIRUFEOm1haW5cIik7XG4gICAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L25vdGVzLnR4dGAsIFwibm90IGEgc2NyaXB0XFxuXCIpO1xuICAgICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKGAke2Nsb25lfS9saWIucnNgLCBcImZuIG1haW4oKSB7fVxcblwiKTtcbiAgICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtjbG9uZX0vRG9ja2VyZmlsZWAsIFwiRlJPTSBhbHBpbmVcXG5cIik7XG4gICAgICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLUFcIik7XG4gICAgICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwibm9uLXNoZWxsIGNoYW5nZVwiKTtcbiAgICAgIGNvbnN0IHNlZW46IHN0cmluZ1tdID0gW107XG4gICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICAgIGN3ZDogY2xvbmUsXG4gICAgICAgIHN0ZGluOiBwcmVQdXNoSW5wdXQoYXdhaXQgZ2l0KGNsb25lLCBcInJldi1wYXJzZVwiLCBcIkhFQURcIikpLFxuICAgICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgICAgIC8vIE5vIFNoZWxsQ2hlY2sgb24gdGhlIGhvc3Q6IGEgbm9uLXNoZWxsIHB1c2ggbXVzdCBub3QgbG9vayBmb3IgaXQuXG4gICAgICAgIGZpbmRTaGVsbGNoZWNrOiAoKSA9PiBQcm9taXNlLnJlc29sdmUobnVsbCksXG4gICAgICAgIHJ1bm5lcjogcmVjb3JkaW5nUnVubmVyKCgpID0+IGZhbHNlLCBzZWVuKSxcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0KHJlc3VsdC5vaywgcmVzdWx0Lm9rID8gXCJcIiA6IHJlc3VsdC5lcnJvci5tZXNzYWdlKTtcbiAgICAgIGFzc2VydCghc2Vlbi5zb21lKChjb21tYW5kKSA9PiBjb21tYW5kLmluY2x1ZGVzKFwic2hlbGxjaGVja1wiKSkpO1xuICAgICAgYXdhaXQgZ2l0KGNsb25lLCBcInB1c2hcIiwgXCItcVwiLCBcIm9yaWdpblwiLCBcIkhFQUQ6bWFpblwiKTtcbiAgICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShgJHtjbG9uZX0vc2NyaXB0YCwgXCIjIS9iaW4vYmFzaFxcbmVjaG8gJDFcXG5cIiwge1xuICAgICAgICBtb2RlOiAwbzc1NSxcbiAgICAgIH0pO1xuICAgICAgYXdhaXQgZ2l0KGNsb25lLCBcImFkZFwiLCBcInNjcmlwdFwiKTtcbiAgICAgIGF3YWl0IGdpdChjbG9uZSwgXCJjb21taXRcIiwgXCItcW1cIiwgXCJzaGVsbCBzY3JpcHRcIik7XG4gICAgICBjb25zdCBzaGVsbFJlc3VsdCA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICAgICAgY3dkOiBjbG9uZSxcbiAgICAgICAgc3RkaW46IHByZVB1c2hJbnB1dChhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKSksXG4gICAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgICAgZmluZFNoZWxsY2hlY2s6ICgpID0+IFByb21pc2UucmVzb2x2ZShudWxsKSxcbiAgICAgICAgcnVubmVyOiByZWNvcmRpbmdSdW5uZXIoKCkgPT4gZmFsc2UsIFtdKSxcbiAgICAgIH0pO1xuICAgICAgYXNzZXJ0KCFzaGVsbFJlc3VsdC5vayk7XG4gICAgfSBmaW5hbGx5IHtcbiAgICAgIGF3YWl0IERlbm8ucmVtb3ZlKHJvb3QsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIH1cbiAgfSk7XG59XG5cbkRlbm8udGVzdChcInJ1blByZVB1c2hHYXRlOiBhbiB1bnN1cHBvcnRlZCBTaGVsbENoZWNrIHdvcmtmbG93IHN0aWxsIHJlZnVzZXMgYSBzY3JpcHQgcHVzaFwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHsgcm9vdCwgY2xvbmUgfSA9IGF3YWl0IG1ha2VSZXBvV2l0aERvY0NvbW1pdCgpO1xuICB0cnkge1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJwdXNoXCIsIFwiLXFcIiwgXCJvcmlnaW5cIiwgXCJIRUFEOm1haW5cIik7XG4gICAgYXdhaXQgRGVuby5ta2RpcihgJHtjbG9uZX0vLmdpdGh1Yi93b3JrZmxvd3NgLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtjbG9uZX0vLmdpdGh1Yi93b3JrZmxvd3Mvc2hlbGxjaGVjay55bWxgLFxuICAgICAgXCJqb2JzOlxcbiAgbGludDpcXG4gICAgc3RlcHM6XFxuICAgICAgLSB1c2VzOiBleGFtcGxlL3NoZWxsY2hlY2stYWN0aW9uQHYxXFxuXCIsXG4gICAgKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7Y2xvbmV9L3J1bi5zaGAsIFwiIyEvYmluL3NoXFxudHJ1ZVxcblwiKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiYWRkXCIsIFwiLUFcIik7XG4gICAgYXdhaXQgZ2l0KGNsb25lLCBcImNvbW1pdFwiLCBcIi1xbVwiLCBcInNjcmlwdFwiKTtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW46IHByZVB1c2hJbnB1dChhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKSksXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgICAuLi5zdHViU2hlbGxjaGVjaygpLFxuICAgIH0pO1xuICAgIGFzc2VydCghcmVzdWx0Lm9rKTtcbiAgICBhc3NlcnRJbnN0YW5jZU9mKHJlc3VsdC5lcnJvciwgUHJlUHVzaEdhdGVJbmZyYXN0cnVjdHVyZUVycm9yKTtcbiAgICBhc3NlcnQocmVzdWx0LmVycm9yLm1lc3NhZ2UuaW5jbHVkZXMoXCJ1bnN1cHBvcnRlZCBTaGVsbENoZWNrIGFjdGlvblwiKSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG4vLyAtLS0tIGRlbm8gdGVzdDogdGFyZ2V0ZWQgdW5pdCB0ZXN0cyBvZiBjaGFuZ2VkIGZpbGVzIChJc3N1ZSAjNDkzMCkgLS0tLS0tLS0tXG5cbmNvbnN0IFVOSVRfVFJBQ0tFRCA9IFtcbiAgXCJ3b3JrZXIvZGVuby9kZW5vLmpzb25cIixcbiAgXCJ3b3JrZXIvZGVuby9saWIvZm9vLnRzXCIsXG4gIFwid29ya2VyL2Rlbm8vdGVzdHMvZm9vX3Rlc3QudHNcIixcbl07XG5cbi8qKiBUaGUgYGRlbm8gdGVzdGAgY29tbWFuZHMgcGxhbm5lZCBmb3IgYSBjaGFuZ2UsIHdpdGggbm8gb3RoZXIgY2hlY2tzLiAqL1xuZnVuY3Rpb24gZGVub1Rlc3RDb21tYW5kcyhcbiAgY2hhbmdlZDogc3RyaW5nW10sXG4gIHRyYWNrZWQ6IHN0cmluZ1tdLFxuICBkZW5vVW5pdFRlc3RSb290cz86IHN0cmluZ1tdLFxuKTogc3RyaW5nW10ge1xuICBjb25zdCByZXN1bHQgPSBwbGFuQ2hhbmdlZEZpbGVDaGVja3MoY2hhbmdlZCwgdHJhY2tlZCwge1xuICAgIHJlcG9Sb290OiBcIi9yXCIsXG4gICAgbWFya2Rvd25saW50QmluYXJ5OiBudWxsLFxuICAgIGRlbm9Vbml0VGVzdFJvb3RzLFxuICB9KTtcbiAgYXNzZXJ0KHJlc3VsdC5vayk7XG4gIHJldHVybiByZXN1bHQudmFsdWVcbiAgICAuZmlsdGVyKChjKSA9PiBjLmxhYmVsLnN0YXJ0c1dpdGgoXCJkZW5vIHRlc3RcIikpXG4gICAgLm1hcCgoYykgPT4gYy5jb21tYW5kKTtcbn1cblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBhIGNoYW5nZWQgc291cmNlIHJ1bnMgaXRzIHNhbWUtbmFtZWQgdHJhY2tlZCB0ZXN0IHZpYSB0ZXN0OnVuaXQgKCM0OTMwKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHJlc3VsdCA9IHBsYW5DaGFuZ2VkRmlsZUNoZWNrcyhcbiAgICBbXCJ3b3JrZXIvZGVuby9saWIvZm9vLnRzXCJdLFxuICAgIFVOSVRfVFJBQ0tFRCxcbiAgICB7XG4gICAgICByZXBvUm9vdDogXCIvclwiLFxuICAgICAgbWFya2Rvd25saW50QmluYXJ5OiBudWxsLFxuICAgICAgZGVub1VuaXRUZXN0Um9vdHM6IFtcIndvcmtlci9kZW5vXCJdLFxuICAgIH0sXG4gICk7XG4gIGFzc2VydChyZXN1bHQub2spO1xuICBhc3NlcnRFcXVhbHMocmVzdWx0LnZhbHVlLm1hcCgoYykgPT4gYy5sYWJlbCksIFtcbiAgICBcImRlbm8gZm10ICh3b3JrZXIvZGVubylcIixcbiAgICBcImRlbm8gbGludCAod29ya2VyL2Rlbm8pXCIsXG4gICAgXCJkZW5vIHRlc3QgKHdvcmtlci9kZW5vKVwiLFxuICBdKTtcbiAgYXNzZXJ0RXF1YWxzKHJlc3VsdC52YWx1ZVsyXSwge1xuICAgIGxhYmVsOiBcImRlbm8gdGVzdCAod29ya2VyL2Rlbm8pXCIsXG4gICAgY3dkOiBcIi9yL3dvcmtlci9kZW5vXCIsXG4gICAgY29tbWFuZDogXCJkZW5vIHRhc2sgdGVzdDp1bml0ICd0ZXN0cy9mb29fdGVzdC50cydcIixcbiAgfSk7XG59KTtcblxuRGVuby50ZXN0KFwicGxhbkNoYW5nZWRGaWxlQ2hlY2tzOiBjaGFuZ2VkIHRlc3RzIGFuZCBzb3VyY2VzIG1hcCB0byBvbmUgc29ydGVkLCBkZWR1cGxpY2F0ZWQgdGVzdDp1bml0IGxpc3QgKCM0OTMwKVwiLCAoKSA9PiB7XG4gIGNvbnN0IHRyYWNrZWQgPSBbLi4uVU5JVF9UUkFDS0VELCBcIndvcmtlci9kZW5vL3Rlc3RzL2Jhcl90ZXN0LnRzXCJdO1xuICBhc3NlcnRFcXVhbHMoXG4gICAgZGVub1Rlc3RDb21tYW5kcyhcbiAgICAgIFtcbiAgICAgICAgXCJ3b3JrZXIvZGVuby9saWIvZm9vLnRzXCIsXG4gICAgICAgIFwid29ya2VyL2Rlbm8vdGVzdHMvZm9vX3Rlc3QudHNcIixcbiAgICAgICAgXCJ3b3JrZXIvZGVuby90ZXN0cy9iYXJfdGVzdC50c1wiLFxuICAgICAgXSxcbiAgICAgIHRyYWNrZWQsXG4gICAgICBbXCJ3b3JrZXIvZGVub1wiXSxcbiAgICApLFxuICAgIFtcImRlbm8gdGFzayB0ZXN0OnVuaXQgJ3Rlc3RzL2Jhcl90ZXN0LnRzJyAndGVzdHMvZm9vX3Rlc3QudHMnXCJdLFxuICApO1xuICBhc3NlcnRFcXVhbHMoXG4gICAgZGVub1Rlc3RDb21tYW5kcyhbXCJ3b3JrZXIvZGVuby90ZXN0cy9mb29fdGVzdC50c1wiXSwgVU5JVF9UUkFDS0VELCBbXG4gICAgICBcIndvcmtlci9kZW5vXCIsXG4gICAgXSksXG4gICAgW1wiZGVubyB0YXNrIHRlc3Q6dW5pdCAndGVzdHMvZm9vX3Rlc3QudHMnXCJdLFxuICApO1xufSk7XG5cbkRlbm8udGVzdChcInBsYW5DaGFuZ2VkRmlsZUNoZWNrczogbm8gZGVubyB0ZXN0IGNoZWNrIGZvciBhbiB1bmxpc3RlZCByb290LCBhbiB1bnRlc3RlZCBzb3VyY2UsIGEgZGVsZXRlZCB0ZXN0IG9yIGRvY3MgKCM0OTMwKVwiLCAoKSA9PiB7XG4gIC8vIFJvb3Qgbm90IGluIGRlbm9Vbml0VGVzdFJvb3RzIChhbmQgbm9uZSBwYXNzZWQgYXQgYWxsKS5cbiAgYXNzZXJ0RXF1YWxzKGRlbm9UZXN0Q29tbWFuZHMoW1wid29ya2VyL2Rlbm8vbGliL2Zvby50c1wiXSwgVU5JVF9UUkFDS0VEKSwgW10pO1xuICBhc3NlcnRFcXVhbHMoXG4gICAgZGVub1Rlc3RDb21tYW5kcyhbXCJ3b3JrZXIvZGVuby9saWIvZm9vLnRzXCJdLCBVTklUX1RSQUNLRUQsIFtcIm90aGVyXCJdKSxcbiAgICBbXSxcbiAgKTtcbiAgLy8gQ2hhbmdlZCBzb3VyY2Ugd2l0aCBubyB0cmFja2VkIHNhbWUtbmFtZWQgdGVzdC5cbiAgYXNzZXJ0RXF1YWxzKFxuICAgIGRlbm9UZXN0Q29tbWFuZHMoW1wid29ya2VyL2Rlbm8vbGliL2Jhci50c1wiXSwgVU5JVF9UUkFDS0VELCBbXCJ3b3JrZXIvZGVub1wiXSksXG4gICAgW10sXG4gICk7XG4gIC8vIENoYW5nZWQgdGVzdCB0aGF0IGlzIG5vIGxvbmdlciB0cmFja2VkIChkZWxldGVkKS5cbiAgYXNzZXJ0RXF1YWxzKFxuICAgIGRlbm9UZXN0Q29tbWFuZHMoXG4gICAgICBbXCJ3b3JrZXIvZGVuby90ZXN0cy9mb29fdGVzdC50c1wiXSxcbiAgICAgIFtcIndvcmtlci9kZW5vL2Rlbm8uanNvblwiLCBcIndvcmtlci9kZW5vL2xpYi9mb28udHNcIl0sXG4gICAgICBbXCJ3b3JrZXIvZGVub1wiXSxcbiAgICApLFxuICAgIFtdLFxuICApO1xuICAvLyBNYXJrZG93bi1vbmx5IGNoYW5nZS5cbiAgYXNzZXJ0RXF1YWxzKFxuICAgIGRlbm9UZXN0Q29tbWFuZHMoW1wid29ya2VyL2Rlbm8vUkVBRE1FLm1kXCJdLCBVTklUX1RSQUNLRUQsIFtcIndvcmtlci9kZW5vXCJdKSxcbiAgICBbXSxcbiAgKTtcbn0pO1xuXG5EZW5vLnRlc3QoXCJsb2FkRGVub1VuaXRUZXN0Um9vdHM6IGEgcm9vdCBjb3VudHMgb25seSB3aGVuIGl0cyBjb25maWcgZGVmaW5lcyB0ZXN0OnVuaXQgKCM0OTMwKVwiLCBhc3luYyAoKSA9PiB7XG4gIGNvbnN0IHJvb3QgPSBhd2FpdCBEZW5vLm1ha2VUZW1wRGlyKHsgcHJlZml4OiBcInZpYmUtdW5pdC1yb290cy1cIiB9KTtcbiAgdHJ5IHtcbiAgICBjb25zdCB3cml0ZSA9IGFzeW5jIChkaXI6IHN0cmluZywgbmFtZTogc3RyaW5nLCB0ZXh0OiBzdHJpbmcpID0+IHtcbiAgICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7cm9vdH0vJHtkaXJ9YCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoYCR7cm9vdH0vJHtkaXJ9LyR7bmFtZX1gLCB0ZXh0KTtcbiAgICB9O1xuICAgIGF3YWl0IHdyaXRlKFxuICAgICAgXCJydW5zXCIsXG4gICAgICBcImRlbm8uanNvblwiLFxuICAgICAgSlNPTi5zdHJpbmdpZnkoeyB0YXNrczogeyBcInRlc3Q6dW5pdFwiOiBcInhcIiB9IH0pLFxuICAgICk7XG4gICAgYXdhaXQgd3JpdGUoXG4gICAgICBcIm5vLXRhc2tcIixcbiAgICAgIFwiZGVuby5qc29uXCIsXG4gICAgICBKU09OLnN0cmluZ2lmeSh7IHRhc2tzOiB7IHRlc3Q6IFwieFwiIH0gfSksXG4gICAgKTtcbiAgICBhd2FpdCB3cml0ZShcImJyb2tlblwiLCBcImRlbm8uanNvblwiLCBcInsgbm90IGpzb25cIik7XG4gICAgYXdhaXQgd3JpdGUoXG4gICAgICBcImpzb25jXCIsXG4gICAgICBcImRlbm8uanNvbmNcIixcbiAgICAgICd7XFxuICAvLyBKU09OQyBjb21tZW50XFxuICBcInRhc2tzXCI6IHsgXCJ0ZXN0OnVuaXRcIjogXCJ4XCIgfVxcbn1cXG4nLFxuICAgICk7XG4gICAgLy8gZGVuby5qc29uIGlzIHByZWZlcnJlZCwgc28gYSB0ZXN0OnVuaXQgb25seSBpbiBkZW5vLmpzb25jIGRvZXMgbm90IGNvdW50LlxuICAgIGF3YWl0IHdyaXRlKFwicHJlZmVycy1qc29uXCIsIFwiZGVuby5qc29uXCIsIEpTT04uc3RyaW5naWZ5KHsgdGFza3M6IHt9IH0pKTtcbiAgICBhd2FpdCB3cml0ZShcbiAgICAgIFwicHJlZmVycy1qc29uXCIsXG4gICAgICBcImRlbm8uanNvbmNcIixcbiAgICAgICd7IFwidGFza3NcIjogeyBcInRlc3Q6dW5pdFwiOiBcInhcIiB9IH1cXG4nLFxuICAgICk7XG4gICAgY29uc3QgdHJhY2tlZCA9IFtcbiAgICAgIFwicnVucy9kZW5vLmpzb25cIixcbiAgICAgIFwibm8tdGFzay9kZW5vLmpzb25cIixcbiAgICAgIFwiYnJva2VuL2Rlbm8uanNvblwiLFxuICAgICAgXCJqc29uYy9kZW5vLmpzb25jXCIsXG4gICAgICBcInByZWZlcnMtanNvbi9kZW5vLmpzb25cIixcbiAgICAgIFwicHJlZmVycy1qc29uL2Rlbm8uanNvbmNcIixcbiAgICAgIFwidW5yZWFkYWJsZS9kZW5vLmpzb25cIixcbiAgICBdO1xuICAgIGFzc2VydEVxdWFscyhhd2FpdCBsb2FkRGVub1VuaXRUZXN0Um9vdHMocm9vdCwgdHJhY2tlZCksIFtcImpzb25jXCIsIFwicnVuc1wiXSk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuXG5EZW5vLnRlc3QoXCJydW5QcmVQdXNoR2F0ZTogYSBjaGFuZ2VkIHRlc3QgcnVucyB0aGUgcmVwbydzIHRlc3Q6dW5pdCB0YXNrLCBhbmQgaXRzIGZhaWx1cmUgYmxvY2tzIHRoZSBwdXNoICgjNDkzMClcIiwgYXN5bmMgKCkgPT4ge1xuICBjb25zdCB7IHJvb3QsIGNsb25lIH0gPSBhd2FpdCBtYWtlUmVwb1dpdGhEb2NDb21taXQoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwicHVzaFwiLCBcIi1xXCIsIFwib3JpZ2luXCIsIFwiSEVBRDptYWluXCIpO1xuICAgIC8vIERyb3AgdGhlIHJvb3QgZGVuby5qc29uIHNvIHRoZSBuZXN0ZWQgd29ya2VyL2Rlbm8gcm9vdCBpcyB0aGUgb3V0ZXJtb3N0LlxuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJybVwiLCBcIi1xXCIsIFwiZGVuby5qc29uXCIpO1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7Y2xvbmV9L3dvcmtlci9kZW5vL2xpYmAsIHsgcmVjdXJzaXZlOiB0cnVlIH0pO1xuICAgIGF3YWl0IERlbm8ubWtkaXIoYCR7Y2xvbmV9L3dvcmtlci9kZW5vL3Rlc3RzYCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKFxuICAgICAgYCR7Y2xvbmV9L3dvcmtlci9kZW5vL2Rlbm8uanNvbmAsXG4gICAgICBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgIHRhc2tzOiB7IFwidGVzdDp1bml0XCI6IFwiZGVubyBydW4gdW5pdF90ZXN0X3J1bm5lci50c1wiIH0sXG4gICAgICB9KSArXG4gICAgICAgIFwiXFxuXCIsXG4gICAgKTtcbiAgICBhd2FpdCBEZW5vLndyaXRlVGV4dEZpbGUoXG4gICAgICBgJHtjbG9uZX0vd29ya2VyL2Rlbm8vbGliL2Zvby50c2AsXG4gICAgICBcImV4cG9ydCBjb25zdCB4ID0gMTtcXG5cIixcbiAgICApO1xuICAgIGF3YWl0IERlbm8ud3JpdGVUZXh0RmlsZShcbiAgICAgIGAke2Nsb25lfS93b3JrZXIvZGVuby90ZXN0cy9mb29fdGVzdC50c2AsXG4gICAgICBcImV4cG9ydCB7fTtcXG5cIixcbiAgICApO1xuICAgIGF3YWl0IGdpdChjbG9uZSwgXCJhZGRcIiwgXCItQVwiKTtcbiAgICBhd2FpdCBnaXQoY2xvbmUsIFwiY29tbWl0XCIsIFwiLXFtXCIsIFwic291cmNlLCB0ZXN0IGFuZCB0ZXN0OnVuaXQgdGFza1wiKTtcbiAgICBjb25zdCBzdGRpbiA9IHByZVB1c2hJbnB1dChhd2FpdCBnaXQoY2xvbmUsIFwicmV2LXBhcnNlXCIsIFwiSEVBRFwiKSk7XG4gICAgY29uc3QgY29tbWFuZCA9IFwiZGVubyB0YXNrIHRlc3Q6dW5pdCAndGVzdHMvZm9vX3Rlc3QudHMnXCI7XG4gICAgY29uc3QgcmFuOiBBcnJheTx7IGNvbW1hbmQ6IHN0cmluZzsgY3dkOiBzdHJpbmcgfCB1bmRlZmluZWQgfT4gPSBbXTtcbiAgICBjb25zdCBydW5uZXJGb3IgPVxuICAgICAgKGZhaWxVbml0OiBib29sZWFuKTogUHJlRmxpZ2h0UnVubmVyID0+IChjbWQsIG9wdGlvbnMpID0+IHtcbiAgICAgICAgcmFuLnB1c2goeyBjb21tYW5kOiBjbWQsIGN3ZDogb3B0aW9ucy5jd2QgfSk7XG4gICAgICAgIGNvbnN0IGZhaWxlZCA9IGZhaWxVbml0ICYmIGNtZCA9PT0gY29tbWFuZDtcbiAgICAgICAgcmV0dXJuIFByb21pc2UucmVzb2x2ZSh7XG4gICAgICAgICAgc3RhcnRlZDogdHJ1ZSxcbiAgICAgICAgICBjb2RlOiBmYWlsZWQgPyAxIDogMCxcbiAgICAgICAgICBzdGRvdXQ6IFwiXCIsXG4gICAgICAgICAgc3RkZXJyOiBmYWlsZWQgPyBcImJvb21cIiA6IFwiXCIsXG4gICAgICAgIH0pO1xuICAgICAgfTtcblxuICAgIGNvbnN0IHBhc3NlZCA9IGF3YWl0IHJ1blByZVB1c2hHYXRlKHtcbiAgICAgIGN3ZDogY2xvbmUsXG4gICAgICBzdGRpbixcbiAgICAgIHByZUZsaWdodENvbW1hbmRzOiBbXSxcbiAgICAgIC4uLnN0dWJTaGVsbGNoZWNrKCksXG4gICAgICBydW5uZXI6IHJ1bm5lckZvcihmYWxzZSksXG4gICAgfSk7XG4gICAgYXNzZXJ0KHBhc3NlZC5vaywgcGFzc2VkLm9rID8gXCJcIiA6IHBhc3NlZC5lcnJvci5tZXNzYWdlKTtcbiAgICBhc3NlcnQocGFzc2VkLnZhbHVlLmNoZWNrc1J1bi5pbmNsdWRlcyhjb21tYW5kKSk7XG4gICAgYXNzZXJ0RXF1YWxzKFxuICAgICAgcmFuLmZpbmQoKHIpID0+IHIuY29tbWFuZCA9PT0gY29tbWFuZCk/LmN3ZCxcbiAgICAgIGAke2Nsb25lfS93b3JrZXIvZGVub2AsXG4gICAgKTtcblxuICAgIGNvbnN0IGJsb2NrZWQgPSBhd2FpdCBydW5QcmVQdXNoR2F0ZSh7XG4gICAgICBjd2Q6IGNsb25lLFxuICAgICAgc3RkaW4sXG4gICAgICBwcmVGbGlnaHRDb21tYW5kczogW10sXG4gICAgICAuLi5zdHViU2hlbGxjaGVjaygpLFxuICAgICAgcnVubmVyOiBydW5uZXJGb3IodHJ1ZSksXG4gICAgfSk7XG4gICAgYXNzZXJ0KCFibG9ja2VkLm9rKTtcbiAgICBhc3NlcnRJbnN0YW5jZU9mKGJsb2NrZWQuZXJyb3IsIFByZUZsaWdodEdhdGVFcnJvcik7XG4gICAgYXNzZXJ0RXF1YWxzKGJsb2NrZWQuZXJyb3IuY29tbWFuZCwgY29tbWFuZCk7XG4gIH0gZmluYWxseSB7XG4gICAgYXdhaXQgRGVuby5yZW1vdmUocm9vdCwgeyByZWN1cnNpdmU6IHRydWUgfSk7XG4gIH1cbn0pO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7O0NBSUMsR0FFRCxTQUNFLE1BQU0sRUFDTixZQUFZLEVBQ1osZ0JBQWdCLEVBQ2hCLG9CQUFvQixRQUNmLGNBQWM7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
// denoCacheMetadata=8205037078483791574,9155897041649566020