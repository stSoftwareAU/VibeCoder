/**
 * Tests for container/entrypoint.sh — the container's process-1 launcher
 * (Issue #4061).
 *
 * Every test runs the real script with a stub `deno` on PATH and asserts on
 * what the script actually execs (or on the failure it reports), so the
 * permission set and the fail-loud behaviour are verified rather than
 * described.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { QUOTA_PAUSE_EXIT_STATUS } from "../lib/quota_pause.ts";

const ENTRYPOINT = new URL("../../../container/entrypoint.sh", import.meta.url)
  .pathname;
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);

/** Create a stub `deno` that records its argv and exits 0. */
async function stubDeno(dir: string): Promise<string> {
  const binDir = `${dir}/bin`;
  const argvFile = `${dir}/argv.txt`;
  await Deno.mkdir(binDir, { recursive: true });
  await Deno.writeTextFile(
    `${binDir}/deno`,
    `#!/bin/bash\nprintf '%s\\n' "$@" > "${argvFile}"\nexit 0\n`,
  );
  await Deno.chmod(`${binDir}/deno`, 0o755);
  return argvFile;
}

/**
 * The per-launch scratch root the entrypoint resolves for a test run
 * (Issue #515) — `${TMPDIR}/vibe-scratch`, with TMPDIR isolated per case by
 * {@link runEntrypoint}.
 */
function scratchRoot(dir: string): string {
  return `${dir}/tmp/vibe-scratch`;
}

/**
 * The durable state root the entrypoint resolves, where the writable gh copy
 * lives (Issue #564 moved it off the agents' scratch).
 */
function stateRoot(dir: string): string {
  return `${dir}/home/auto-issue-work/.container-state`;
}

/** Create a throwaway repo layout the entrypoint can point at. */
async function fakeRepo(dir: string): Promise<void> {
  await Deno.mkdir(`${dir}/repo/worker/deno`, { recursive: true });
  await Deno.writeTextFile(`${dir}/repo/worker/deno/mod.ts`, "// stub\n");
  await Deno.writeTextFile(`${dir}/repo/worker/deno/deno.lock`, "{}\n");
}

interface EntrypointOpts {
  dir: string;
  path: string;
  env?: Record<string, string>;
  args?: string[];
  /** Run with HOME genuinely unset (the legacy-path case only). */
  homeless?: boolean;
}

/**
 * The isolated environment every entrypoint case runs under.
 *
 * Built here, and nowhere else, so no case can spawn the entrypoint with the
 * host's own environment: {@link spawnEntrypoint} is the only way to start it
 * and it always clears the inherited set.
 */
function entrypointEnv(opts: EntrypointOpts): Record<string, string> {
  // HOME is isolated at the temporary directory exactly like VIBE_BASE_DIR
  // (Issue #4284). The entrypoint's gh-credential staging is gated on
  // ${HOME:-/home/vibe}/.vibe-coder/credentials/gh/hosts.yml, so a case that
  // leaves HOME to the host reads — and copies — the OPERATOR's real
  // credential: false in CI, true on every worker host, where the branch
  // then needs mkdir/cp/sed that a stub-only PATH does not provide and the
  // entrypoint exits 127.
  // TMPDIR is isolated for the same reason (Issue #515): the entrypoint's
  // per-launch scratch root defaults to ${TMPDIR:-/tmp}/vibe-scratch, so a
  // case that leaves TMPDIR unset would write into — and race other cases
  // over — the host's real /tmp.
  const env: Record<string, string> = {
    PATH: opts.path,
    HOME: `${opts.dir}/home`,
    TMPDIR: `${opts.dir}/tmp`,
    ...(opts.env ?? {}),
  };
  if (opts.homeless) delete env.HOME;
  return env;
}

/**
 * Spawn the real entrypoint under {@link entrypointEnv}.
 *
 * `clearEnv` is the load-bearing flag: VIBE_SCRATCH_DIR is the FIRST candidate
 * the entrypoint considers for its scratch root, ahead of TMPDIR, and it
 * `rm -rf`s whatever it resolves. The suite runs on a worker host inside a live
 * run that exports VIBE_SCRATCH_DIR=/tmp/vibe-scratch, so the one case that
 * inherited the host's set deleted the running worker's own staged source —
 * the gh guard's CLI among it — and restaged this file's `// stub` repo over
 * it. Observed live while working Issue #612.
 */
function spawnEntrypoint(opts: EntrypointOpts): Deno.ChildProcess {
  // Absolute interpreter path: the child PATH is deliberately restricted to
  // the stub bin directory, so `bash` must not be resolved through it.
  return new Deno.Command("/bin/bash", {
    args: [ENTRYPOINT, ...(opts.args ?? [])],
    env: entrypointEnv(opts),
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).spawn();
}

async function runEntrypoint(
  opts: EntrypointOpts,
): Promise<{ code: number; stderr: string }> {
  const { code, stderr } = await spawnEntrypoint(opts).output();
  return { code, stderr: new TextDecoder().decode(stderr) };
}

Deno.test("entrypoint - execs the Deno driver with the worker permission set", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDeno(dir);
    await fakeRepo(dir);

    const { code } = await runEntrypoint({
      dir,
      path: `${dir}/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo` },
    });
    assertEquals(code, 0);

    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    assertEquals(argv[0], "run");
    for (
      const flag of [
        "--frozen",
        "--allow-env",
        "--allow-read",
        "--allow-write",
        "--allow-run",
        "--allow-net",
        "--allow-sys=hostname",
      ]
    ) {
      assert(argv.includes(flag), `missing ${flag} in ${argv.join(" ")}`);
    }
    assert(argv.includes(`--lock=${dir}/repo/worker/deno/deno.lock`));
    assert(argv.includes(`${dir}/repo/worker/deno/mod.ts`));
    assertEquals(argv.includes("run-entrypoint"), true);
    assert(argv.includes("--base-dir"));
    assert(argv.includes(`${dir}/repo`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - forwards extra arguments to the driver", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDeno(dir);
    await fakeRepo(dir);

    const { code } = await runEntrypoint({
      dir,
      path: `${dir}/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo` },
      args: ["--dry-run", "--verbose"],
    });
    assertEquals(code, 0);

    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    assertEquals(argv.slice(-2), ["--dry-run", "--verbose"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - fails loudly when deno is not on PATH", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    await Deno.mkdir(`${dir}/empty`);
    await fakeRepo(dir);

    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/empty`,
      env: { VIBE_BASE_DIR: `${dir}/repo` },
    });

    assert(code !== 0, "missing deno must not exit 0");
    assert(stderr.includes("deno"), `stderr should name deno: ${stderr}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - fails loudly when the base directory has no worker tree", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    await stubDeno(dir);
    await Deno.mkdir(`${dir}/empty-repo`);

    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/bin`,
      env: { VIBE_BASE_DIR: `${dir}/empty-repo` },
    });

    assert(code !== 0, "a missing worker tree must not exit 0");
    assert(
      stderr.includes("mod.ts"),
      `stderr should name the missing driver: ${stderr}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - defaults the base directory to the repository it ships in", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDeno(dir);

    const { code } = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
    });
    assertEquals(code, 0);

    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    // --base-dir names the repository this script ships in. The driver module
    // itself runs from the VM-local staged copy of that same tree (Issue
    // #4302), so the base directory — not the module path — is what pins the
    // default; the assertion holds whether or not the staging copy succeeds.
    assertEquals(argv[argv.indexOf("--base-dir") + 1], REPO_ROOT);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - the fixture isolates HOME from the host (Issue #4284)", async () => {
  // Every case must behave identically on a host with and without a real
  // ~/.vibe-coder/credentials/gh. Leaving HOME to the host meant the
  // gh-staging branch found the operator's own credential — the dubious
  // ownership case then exited 127 on the branch's missing mkdir/cp/sed, so
  // the suite passed in CI and failed on every worker host.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const envFile = `${dir}/driver-env.txt`;
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/bin/deno`,
      "#!/bin/bash\n" +
        `{ printf '%s\\n' "\${HOME:-UNSET}"; printf '%s\\n' "\${GH_CONFIG_DIR:-UNSET}"; } > "${envFile}"\n` +
        "exit 0\n",
    );
    await Deno.chmod(`${dir}/bin/deno`, 0o755);
    await fakeRepo(dir);

    // No HOME in env: the fixture must supply an isolated one anyway.
    const outcome = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo` },
    });
    assertEquals(outcome.code, 0, outcome.stderr);

    const [home, ghConfigDir] = (await Deno.readTextFile(envFile)).trim()
      .split("\n");
    assertEquals(home, `${dir}/home`);
    // The fixture home holds no credential, so nothing is staged — the host's
    // own ~/.vibe-coder is never read.
    assertEquals(ghConfigDir, "UNSET");
    assertEquals(await exists(`${dir}/home/.config/gh-runtime`), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - trusts the mounted repositories before exec (dubious ownership)", async () => {
  // Apple container maps mount roots as root-owned while files map to the
  // container user, so git's dubious-ownership guard refuses /workspace and
  // every worker-managed clone (observed live: "fatal: detected dubious
  // ownership in repository at '/workspace'"). The entrypoint must add the
  // container-scoped trust before the driver runs a single git command.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDeno(dir);
    const gitArgvFile = `${dir}/git-argv.txt`;
    await Deno.writeTextFile(
      `${dir}/bin/git`,
      `#!/bin/bash\nprintf '%s\\n' "$@" >> "${gitArgvFile}"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/git`, 0o755);
    await fakeRepo(dir);

    const outcome = await runEntrypoint({
      dir,
      path: `${dir}/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo` },
    });
    assertEquals(outcome.code, 0, outcome.stderr);

    const gitArgv = (await Deno.readTextFile(gitArgvFile)).trim().split("\n");
    assertEquals(gitArgv, [
      "config",
      "--global",
      "--add",
      "safe.directory",
      "*",
    ]);
    // The driver still execs afterwards.
    assert((await Deno.readTextFile(argvFile)).includes("run-entrypoint"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - rewrites SSH remotes to HTTPS with the mounted gh token", async () => {
  // No SSH key ever crosses the containment boundary (Issue #4064), so the
  // worker's git transport is HTTPS with the mounted gh credential: SSH
  // remotes are rewritten and gh becomes git's credential helper. Observed
  // live before this: bootstrap's `git fetch origin` died with "Host key
  // verification failed" against the checkout's git@github.com remote.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDeno(dir);
    const gitArgvFile = `${dir}/git-argv.txt`;
    await Deno.writeTextFile(
      `${dir}/bin/git`,
      `#!/bin/bash\nprintf '%s ' "$@" >> "${gitArgvFile}"\nprintf '\\n' >> "${gitArgvFile}"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/git`, 0o755);
    const ghRecordFile = `${dir}/gh-record.txt`;
    await Deno.writeTextFile(
      `${dir}/bin/gh`,
      `#!/bin/bash\nprintf '%s %s\\n' "$*" "\${GH_CONFIG_DIR:-}" >> "${ghRecordFile}"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/gh`, 0o755);
    await fakeRepo(dir);

    // The mounted credential material lives under the container HOME.
    await Deno.mkdir(`${dir}/home/.vibe-coder/credentials/gh`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${dir}/home/.vibe-coder/credentials/gh/hosts.yml`,
      "github.com:\n",
    );

    // System dirs after the stubs: the staging step needs real mkdir/cp,
    // while the stub git/gh/deno still shadow their real counterparts.
    const outcome = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: `${dir}/home` },
    });
    assertEquals(outcome.code, 0, outcome.stderr);

    const gitArgv = (await Deno.readTextFile(gitArgvFile)).trim().split("\n")
      .map((line) => line.trim());
    // --replace-all on both multi-valued keys (Issue #635). The global config
    // survives the run, so a plain set fails from the second launch onward
    // with "cannot overwrite multiple values with a single value" — taking
    // the credential helper down with it through the && chain.
    assertEquals(gitArgv, [
      "config --global --add safe.directory *",
      "config --global --replace-all url.https://github.com/.insteadOf git@github.com:",
      "config --global --add url.https://github.com/.insteadOf ssh://git@github.com/",
      "config --global --replace-all credential.https://github.com.helper",
      "config --global --add credential.https://github.com.helper !gh auth git-credential",
    ]);
    // The helper is written directly — `gh auth setup-git` would attempt a
    // config migration it cannot write into the read-only credential mount.
    assertEquals(await exists(ghRecordFile), false);

    // The writable runtime copy is staged for gh's own config migration.
    assertEquals(
      await Deno.readTextFile(`${stateRoot(dir)}/gh/hosts.yml`),
      "github.com:\n",
    );
    // The driver still execs after the transport setup.
    assert((await Deno.readTextFile(argvFile)).includes("run-entrypoint"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** True when a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("entrypoint - exports GH_CONFIG_DIR so raw scripts inherit gh auth (Issue #4220)", async () => {
  // Observed live: a callback hook runs raw `git push` in the worker's
  // inherited environment; without GH_CONFIG_DIR the credential
  // helper reads an absent default config and the push dies unauthenticated
  // ("could not read Username for 'https://github.com'") — silently, behind
  // the script's exit 0 and its own rate limit. The staged runtime copy must
  // be the whole container's gh config, not a per-call secret handshake.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const envFile = `${dir}/driver-env.txt`;
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/bin/deno`,
      `#!/bin/bash\nprintf '%s\\n' "\${GH_CONFIG_DIR:-UNSET}" > "${envFile}"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/deno`, 0o755);
    await fakeRepo(dir);
    await Deno.mkdir(`${dir}/home/.vibe-coder/credentials/gh`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${dir}/home/.vibe-coder/credentials/gh/hosts.yml`,
      "github.com:\n",
    );

    const outcome = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: `${dir}/home` },
    });
    assertEquals(outcome.code, 0, outcome.stderr);
    // Under the scratch root, not ~/.config: the image layer goes read-only
    // (Issue #515) and the staged copy is regenerated from the mount anyway.
    assertEquals(
      (await Deno.readTextFile(envFile)).trim(),
      `${stateRoot(dir)}/gh`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - leaves GH_CONFIG_DIR unset when no credential is mounted (Issue #4220)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const envFile = `${dir}/driver-env.txt`;
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/bin/deno`,
      `#!/bin/bash\nprintf '%s\\n' "\${GH_CONFIG_DIR:-UNSET}" > "${envFile}"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/deno`, 0o755);
    await fakeRepo(dir);

    const outcome = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: `${dir}/home` },
    });
    assertEquals(outcome.code, 0, outcome.stderr);
    assertEquals((await Deno.readTextFile(envFile)).trim(), "UNSET");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - sets a container-wide git identity from the mounted credential (Issue #4235)", async () => {
  // Raw scripts (a callback hook) inherit no per-call identity, so their
  // `git commit` died identity-less, exited 0, and the uncommitted edit
  // rate-limited every retry — the write stayed dead behind three separate
  // silent layers. The identity comes from the credential's own `user:`
  // record, so such commits attribute to the host's service account like the
  // rest of the fleet.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    await stubDeno(dir);
    const gitArgvFile = `${dir}/git-argv.txt`;
    await Deno.writeTextFile(
      `${dir}/bin/git`,
      `#!/bin/bash\nprintf '%s ' "$@" >> "${gitArgvFile}"\nprintf '\\n' >> "${gitArgvFile}"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/git`, 0o755);
    await fakeRepo(dir);
    await Deno.mkdir(`${dir}/home/.vibe-coder/credentials/gh`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${dir}/home/.vibe-coder/credentials/gh/hosts.yml`,
      "github.com:\n    user: Vibecoderbot\n    git_protocol: https\n",
    );

    const outcome = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: `${dir}/home` },
    });
    assertEquals(outcome.code, 0, outcome.stderr);

    const gitArgv = await Deno.readTextFile(gitArgvFile);
    assertStringIncludes(gitArgv, "config --global user.name Vibecoderbot");
    assertStringIncludes(
      gitArgv,
      "config --global user.email Vibecoderbot@users.noreply.github.com",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - stays PID 1, reaps orphans, forwards TERM, keeps the exit status (Issue #4239)", async () => {
  // exec-ing the driver made Deno the container's PID 1, and Deno never
  // waits on children it did not spawn — every double-forked git from the
  // agent's bash tools became a permanent zombie (2,137 counted live). The
  // entrypoint now keeps bash as the reaper and runs the driver as a child:
  // signals forward, the exit status survives, and orphans get reaped.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const recordFile = `${dir}/driver-record.txt`;
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    // A driver stub that exits 23 after a moment — long enough for the
    // TERM-forwarding case below to race it deliberately short here.
    await Deno.writeTextFile(
      `${dir}/bin/deno`,
      `#!/bin/bash\ntrap 'echo TERM-RECEIVED >> "${recordFile}"; exit 143' TERM\necho STARTED >> "${recordFile}"\nsleep 0.3\nexit 23\n`,
    );
    await Deno.chmod(`${dir}/bin/deno`, 0o755);
    await fakeRepo(dir);

    const outcome = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: `${dir}/home` },
    });
    // The child's exit status is propagated verbatim, not swallowed by the
    // reaper loop.
    assertEquals(outcome.code, 23, outcome.stderr);
    assertStringIncludes(await Deno.readTextFile(recordFile), "STARTED");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - carries the quota-pause status across the container boundary (Issue #342)", async () => {
  // The supervisor classifies on this status: a run that stopped because the
  // host is out of quota must not reach it wearing a crash's status.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/bin/deno`,
      `#!/bin/bash\nexit ${QUOTA_PAUSE_EXIT_STATUS}\n`,
    );
    await Deno.chmod(`${dir}/bin/deno`, 0o755);
    await fakeRepo(dir);

    const outcome = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: `${dir}/home` },
    });
    assertEquals(outcome.code, QUOTA_PAUSE_EXIT_STATUS, outcome.stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - forwards SIGTERM to the driver child (Issue #4239)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const recordFile = `${dir}/driver-record.txt`;
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/bin/deno`,
      `#!/bin/bash\ntrap 'echo TERM-RECEIVED >> "${recordFile}"; exit 143' TERM\necho STARTED >> "${recordFile}"\nsleep 30 &\nwait $!\n`,
    );
    await Deno.chmod(`${dir}/bin/deno`, 0o755);
    await fakeRepo(dir);

    const child = spawnEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo` },
    });

    // Wait for the driver to start, then stop the entrypoint like the
    // runtime would.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        if ((await Deno.readTextFile(recordFile)).includes("STARTED")) break;
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    child.kill("SIGTERM");
    const output = await child.output();

    assertStringIncludes(
      await Deno.readTextFile(recordFile),
      "TERM-RECEIVED",
      "the stop signal must reach the driver child",
    );
    assertEquals(output.code, 143);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - never reaches the host's own scratch root, whatever the environment says", async () => {
  // The suite runs ON a worker host, inside a live run that exports
  // VIBE_SCRATCH_DIR=/tmp/vibe-scratch. That variable is the FIRST candidate
  // the entrypoint considers for its scratch root, ahead of TMPDIR, and it
  // `rm -rf`s whatever it resolves before restaging a driver copy. A case that
  // let it through deleted the running worker's own staged source — the gh
  // guard's CLI among it, so every subsequent `gh` call in that run failed
  // closed — and left this file's `// stub` repo in its place.
  //
  // `clearEnv` in {@link spawnEntrypoint} is what stops that, so this case
  // proves the clearing itself rather than exporting a host scratch root to
  // stand in for it (Issue #967): the child's environment is captured and
  // matched against this process's own, and a variable of ours that reached
  // it fails here. That covers every leaked root at once, VIBE_SCRATCH_DIR
  // included, without moving a variable nine other test workers can see.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  const hostScratch = await Deno.makeTempDir({ prefix: "vibe-host-scratch-" });
  const guard = `${hostScratch}/worker-src/worker/deno/lib/gh_guard_cli.ts`;
  const guardSource = "// the live run's guard\n";
  try {
    await Deno.mkdir(`${hostScratch}/worker-src/worker/deno/lib`, {
      recursive: true,
    });
    await Deno.writeTextFile(guard, guardSource);

    const envFile = await stubDenoDumpingWholeEnv(dir);
    await fakeRepo(dir);
    // A real PATH, like the live container's: the entrypoint clears its
    // scratch root with `rm -rf`, and a stub-only PATH cannot resolve `rm`,
    // so a case without the real coreutils never exercises the deletion.
    await spawnEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo` },
    }).output();

    const childEnv = parseEnvDump(await Deno.readTextFile(envFile));
    // The scratch root the entrypoint resolved is the fixture's, derived from
    // the isolated TMPDIR — never anything outside it.
    assertEquals(childEnv.VIBE_SCRATCH_DIR, scratchRoot(dir));
    const leaked = Object.entries(Deno.env.toObject())
      .filter(([name]) => !SHELL_OWNED_ENV.has(name))
      .filter(([name, value]) => childEnv[name] === value)
      .map(([name]) => name)
      .sort();
    assertEquals(
      leaked,
      [],
      "the entrypoint must never see this process's environment: " +
        leaked.join(", "),
    );
    assertEquals(
      await Deno.readTextFile(guard),
      guardSource,
      "the entrypoint must never resolve its scratch root from the host's environment",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
    await Deno.remove(hostScratch, { recursive: true });
  }
});

/**
 * Variables the child's own shell establishes, whatever it inherited.
 *
 * `bash` sets these from its own state — the working directory it was started
 * in among them — so a match with this process is not evidence of a leak.
 */
const SHELL_OWNED_ENV = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
]);

/**
 * Stub `deno` that dumps its WHOLE environment, not a named subset — the
 * leak this case looks for could be any variable at all.
 */
async function stubDenoDumpingWholeEnv(dir: string): Promise<string> {
  const binDir = `${dir}/bin`;
  const envFile = `${dir}/driver-env.txt`;
  await Deno.mkdir(binDir, { recursive: true });
  await Deno.writeTextFile(
    `${binDir}/deno`,
    `#!/bin/bash\nenv > "${envFile}"\nexit 0\n`,
  );
  await Deno.chmod(`${binDir}/deno`, 0o755);
  return envFile;
}

Deno.test("entrypoint - disables the agent CLI's self-updater (Issue #4248)", async () => {
  // The CLI's auto-updater restarts (SIGKILLs) the running process when an
  // update installs. With the image pinning the CLI version, every session
  // had a pending update — silent mid-run kills at download-completion
  // timing, container-only, stderr empty. The image is the CLI's update
  // mechanism, exactly the #4062 principle for the worker itself.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const envFile = `${dir}/driver-env.txt`;
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/bin/deno`,
      `#!/bin/bash\nprintf '%s\\n' "\${DISABLE_AUTOUPDATER:-UNSET}" > "${envFile}"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/deno`, 0o755);
    await fakeRepo(dir);

    const outcome = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: `${dir}/home` },
    });
    assertEquals(outcome.code, 0, outcome.stderr);
    assertEquals((await Deno.readTextFile(envFile)).trim(), "1");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Per-launch cache/recompute tax (Issue #4302)
// ---------------------------------------------------------------------------

/** Stub `deno` that records argv AND the DENO_DIR it inherited. */
async function stubDenoWithEnv(dir: string): Promise<string> {
  const binDir = `${dir}/bin`;
  const argvFile = `${dir}/argv.txt`;
  await Deno.mkdir(binDir, { recursive: true });
  await Deno.writeTextFile(
    `${binDir}/deno`,
    "#!/bin/bash\n" +
      `{ printf 'DENO_DIR=%s\\n' "\${DENO_DIR:-}"; printf '%s\\n' "$@"; } > "${argvFile}"\n` +
      "exit 0\n",
  );
  await Deno.chmod(`${binDir}/deno`, 0o755);
  return argvFile;
}

Deno.test("entrypoint - with HOME set, stages the worker source locally and uses the durable Deno cache (Issue #4302)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDenoWithEnv(dir);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    await Deno.mkdir(home, { recursive: true });

    const { code } = await runEntrypoint({
      dir,
      // The image PATH includes the system directories; mkdir/cp must
      // resolve for the staging block, so mirror that here.
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: home },
    });
    assertEquals(code, 0);

    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    // Durable cache on the work volume, not the ephemeral overlay.
    assertEquals(argv[0], `DENO_DIR=${home}/auto-issue-work/.deno-cache`);
    // Driver and lockfile come from the staged copy on the scratch root
    // (Issue #515 moved it off ${HOME}, which is the image layer).
    const staged = `${scratchRoot(dir)}/worker-src`;
    assert(
      argv.includes(`${staged}/worker/deno/mod.ts`),
      `driver not staged locally: ${argv.join(" ")}`,
    );
    assert(argv.includes(`--lock=${staged}/worker/deno/deno.lock`));
    // The staged copy really exists and matches the source.
    assertEquals(
      await Deno.readTextFile(`${staged}/worker/deno/mod.ts`),
      "// stub\n",
    );
    // --base-dir still names the mounted checkout (repo-root assets).
    assert(argv.includes(`${dir}/repo`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - VIBE_DENO_CACHE_DIR overrides the durable cache location (Issue #4302)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDenoWithEnv(dir);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    await Deno.mkdir(home, { recursive: true });

    const { code } = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: {
        VIBE_BASE_DIR: `${dir}/repo`,
        HOME: home,
        VIBE_DENO_CACHE_DIR: `${dir}/custom-cache`,
      },
    });
    assertEquals(code, 0);

    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    assertEquals(argv[0], `DENO_DIR=${dir}/custom-cache`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - a fresh launch replaces a stale staged copy (Issue #4302)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDenoWithEnv(dir);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    const staged = `${scratchRoot(dir)}/worker-src`;
    // A leftover staged copy from a previous (different) build.
    await Deno.mkdir(`${staged}/worker/deno`, { recursive: true });
    await Deno.writeTextFile(
      `${staged}/worker/deno/mod.ts`,
      "// stale previous build\n",
    );

    const { code } = await runEntrypoint({
      dir,
      // The image PATH includes the system directories; mkdir/cp must
      // resolve for the staging block, so mirror that here.
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: home },
    });
    assertEquals(code, 0);
    assertEquals(
      await Deno.readTextFile(`${staged}/worker/deno/mod.ts`),
      "// stub\n",
    );
    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    assert(argv.includes(`${staged}/worker/deno/mod.ts`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - without HOME the legacy paths are untouched (Issue #4302)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDenoWithEnv(dir);
    await fakeRepo(dir);

    // The one case that genuinely runs HOME-less — that is its subject. The
    // stub-only PATH keeps it host-independent even so: the gh-staging
    // branch's fallback home can only be stat-ed, never written, because
    // mkdir/cp/sed never resolve (Issue #4284).
    const { code } = await runEntrypoint({
      dir,
      homeless: true,
      path: `${dir}/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo` },
    });
    assertEquals(code, 0);

    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    assertEquals(argv[0], "DENO_DIR="); // image default, not exported
    assert(argv.includes(`${dir}/repo/worker/deno/mod.ts`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - staging the source exports PROMPTS_DIR at the checkout, never the staged copy (Issue #4302 regression)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = `${dir}/argv.txt`;
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/bin/deno`,
      "#!/bin/bash\n" +
        `{ printf 'PROMPTS_DIR=%s\\n' "\${PROMPTS_DIR:-}"; printf '%s\\n' "$@"; } > "${argvFile}"\n` +
        "exit 0\n",
    );
    await Deno.chmod(`${dir}/bin/deno`, 0o755);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    await Deno.mkdir(home, { recursive: true });

    const { code } = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: home },
    });
    assertEquals(code, 0);
    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    assertEquals(argv[0], `PROMPTS_DIR=${dir}/repo/prompts`);
    // …while the driver itself runs from the staged copy.
    assert(argv.includes(`${scratchRoot(dir)}/worker-src/worker/deno/mod.ts`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #4392 — the image's pre-warmed Deno cache seeds the durable cache
// ---------------------------------------------------------------------------

/** A fake image seed: the layout `deno cache` leaves under a DENO_DIR. */
async function fakeSeed(dir: string): Promise<string> {
  const seed = `${dir}/seed`;
  const mcp = `${seed}/npm/registry.npmjs.org/@playwright/mcp/0.0.75`;
  const core = `${seed}/npm/registry.npmjs.org/playwright-core/1.61.0-alpha-1`;
  const jsr = `${seed}/remote/https/jsr.io/@std/assert/1.0.18`;
  for (const p of [mcp, core, jsr]) await Deno.mkdir(p, { recursive: true });
  await Deno.writeTextFile(`${mcp}/package.json`, `{"name":"@playwright/mcp"}`);
  await Deno.writeTextFile(
    `${core}/package.json`,
    `{"name":"playwright-core"}`,
  );
  await Deno.writeTextFile(
    `${seed}/npm/registry.npmjs.org/@playwright/mcp/registry.json`,
    "{}",
  );
  await Deno.writeTextFile(`${jsr}/mod.ts`, "export {};");
  return seed;
}

Deno.test("entrypoint - a cold durable cache is seeded from the image's pre-warmed Deno cache (Issue #4392)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    await stubDenoWithEnv(dir);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    await Deno.mkdir(home, { recursive: true });
    const seed = await fakeSeed(dir);

    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: {
        VIBE_BASE_DIR: `${dir}/repo`,
        HOME: home,
        VIBE_DENO_SEED_DIR: seed,
      },
    });
    assertEquals(code, 0, stderr);
    const cache = `${home}/auto-issue-work/.deno-cache`;
    // The npm packages and the JSR modules landed in the durable cache.
    assert(
      await exists(
        `${cache}/npm/registry.npmjs.org/@playwright/mcp/0.0.75/package.json`,
      ),
    );
    assert(
      await exists(
        `${cache}/npm/registry.npmjs.org/playwright-core/1.61.0-alpha-1/package.json`,
      ),
    );
    assert(
      await exists(`${cache}/remote/https/jsr.io/@std/assert/1.0.18/mod.ts`),
    );
    assertStringIncludes(stderr, "seeded the Deno cache");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - a partly warm durable cache is topped up around existing files, and a fully warm one is left alone (Issue #4392)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    await stubDenoWithEnv(dir);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    const seed = await fakeSeed(dir);
    // The volume already has the MCP (a previous launch fetched or seeded
    // it) with content that differs from the seed's.
    const cache = `${home}/auto-issue-work/.deno-cache`;
    const mcp = `${cache}/npm/registry.npmjs.org/@playwright/mcp/0.0.75`;
    await Deno.mkdir(mcp, { recursive: true });
    await Deno.writeTextFile(`${mcp}/package.json`, `{"name":"volume-copy"}`);

    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: {
        VIBE_BASE_DIR: `${dir}/repo`,
        HOME: home,
        VIBE_DENO_SEED_DIR: seed,
      },
    });
    assertEquals(code, 0, stderr);
    assertEquals(
      await Deno.readTextFile(`${mcp}/package.json`),
      `{"name":"volume-copy"}`,
      "the volume's copy wins",
    );
    // The rest of the seed (playwright-core, the JSR module) was missing,
    // so those were seeded around the existing file.
    assertStringIncludes(stderr, "seeded the Deno cache");
    assert(
      await exists(
        `${cache}/npm/registry.npmjs.org/playwright-core/1.61.0-alpha-1/package.json`,
      ),
    );

    // A second launch on the now fully warm cache copies nothing.
    const again = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: {
        VIBE_BASE_DIR: `${dir}/repo`,
        HOME: home,
        VIBE_DENO_SEED_DIR: seed,
      },
    });
    assertEquals(again.code, 0, again.stderr);
    assert(!again.stderr.includes("seeded the Deno cache"), again.stderr);
    assertEquals(
      await Deno.readTextFile(`${mcp}/package.json`),
      `{"name":"volume-copy"}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - no seed directory in the image → nothing seeded, no failure (Issue #4392)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    await stubDenoWithEnv(dir);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    await Deno.mkdir(home, { recursive: true });
    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: {
        VIBE_BASE_DIR: `${dir}/repo`,
        HOME: home,
        VIBE_DENO_SEED_DIR: `${dir}/absent`,
      },
    });
    assertEquals(code, 0, stderr);
    assert(!stderr.includes("seeded"), stderr);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Issue #515 — no in-container write outside /tmp and the mounted volumes
// ---------------------------------------------------------------------------
//
// The container root filesystem is to be mounted read-only (Issue #509), so
// every writer the entrypoint owns must land on a container-managed root: the
// per-launch scratch root (a tmpfs where the runtime provides one) or the
// durable state root on the `vibe-work` volume. Nothing may be written under
// ${HOME}, which is an image layer.

/** Stub `deno` that dumps the relocated environment it inherited. */
async function stubDenoDumpingEnv(
  dir: string,
  names: string[],
): Promise<string> {
  const binDir = `${dir}/bin`;
  const envFile = `${dir}/driver-env.txt`;
  await Deno.mkdir(binDir, { recursive: true });
  const dumps = names
    .map((name) => `printf '${name}=%s\\n' "\${${name}:-}"`)
    .join("; ");
  await Deno.writeTextFile(
    `${binDir}/deno`,
    `#!/bin/bash\n{ ${dumps}; } > "${envFile}"\nexit 0\n`,
  );
  await Deno.chmod(`${binDir}/deno`, 0o755);
  return envFile;
}

/** Parse the `KEY=value` dump written by {@link stubDenoDumpingEnv}. */
function parseEnvDump(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.trim().split("\n")) {
    const index = line.indexOf("=");
    if (index > 0) env[line.slice(0, index)] = line.slice(index + 1);
  }
  return env;
}

Deno.test("entrypoint - writes nothing under HOME: the staged source, the git config and the gh copy all land on the scratch root (Issue #515)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    await stubDeno(dir);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    // A mounted gh credential, so the staging branch actually runs.
    await Deno.mkdir(`${home}/.vibe-coder/credentials/gh`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.vibe-coder/credentials/gh/hosts.yml`,
      "github.com:\n    user: vibe-bot\n",
    );

    // The REAL git, so `git config --global` writes where it truly would.
    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: home },
    });
    assertEquals(code, 0, stderr);

    const scratch = scratchRoot(dir);
    // Every per-launch writer landed on the scratch root…
    assertEquals(
      await Deno.readTextFile(`${scratch}/worker-src/worker/deno/mod.ts`),
      "// stub\n",
    );
    // …and the credential on the durable state root instead, out of the
    // world-writable /tmp the coding agents scribble in (Issue #564).
    assertEquals(await exists(`${stateRoot(dir)}/gh/hosts.yml`), true);
    assertEquals(await exists(`${scratch}/gh/hosts.yml`), false);
    // The git config is durable state, not scratch (Issue #564): it carries
    // the credential helper and the identity, and the scratch root has been
    // seen emptied mid-run.
    const gitconfig = await Deno.readTextFile(`${stateRoot(dir)}/gitconfig`);
    assertStringIncludes(gitconfig, "[safe]");
    assertStringIncludes(gitconfig, "vibe-bot");

    // …and nothing was written to the image layer under ${HOME}.
    for (
      const legacy of [
        `${home}/.worker-src`,
        `${home}/.gitconfig`,
        `${home}/.config/gh-runtime`,
        `${home}/.cache`,
      ]
    ) {
      assertEquals(await exists(legacy), false, `${legacy} was written`);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - the tool caches every CLI reaches for are relocated off the image layer (Issue #515)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const envFile = await stubDenoDumpingEnv(dir, [
      "VIBE_SCRATCH_DIR",
      "VIBE_STATE_DIR",
      "GIT_CONFIG_GLOBAL",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "CARGO_HOME",
      "npm_config_cache",
      "TMPDIR",
    ]);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    await Deno.mkdir(home, { recursive: true });

    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: home },
    });
    assertEquals(code, 0, stderr);

    const scratch = scratchRoot(dir);
    const state = `${home}/auto-issue-work/.container-state`;
    const env = parseEnvDump(await Deno.readTextFile(envFile));
    assertEquals(env["VIBE_SCRATCH_DIR"], scratch);
    assertEquals(env["VIBE_STATE_DIR"], state);
    // Durable state, not scratch (Issue #564): it carries the credential
    // helper and the identity, and a config file that exists while missing
    // its helper reads as configured — the failure that cost hours.
    assertEquals(env["GIT_CONFIG_GLOBAL"], `${state}/gitconfig`);
    assertEquals(env["XDG_CONFIG_HOME"], `${scratch}/config`);
    // Worth keeping between launches — the vibe-work volume.
    assertEquals(env["XDG_CACHE_HOME"], `${state}/cache`);
    assertEquals(env["XDG_DATA_HOME"], `${state}/data`);
    assertEquals(env["XDG_STATE_HOME"], `${state}/state`);
    assertEquals(env["CARGO_HOME"], `${state}/cargo`);
    assertEquals(env["npm_config_cache"], `${state}/npm`);
    // /tmp was usable, so temporary files are left exactly where they were.
    assertEquals(env["TMPDIR"], `${dir}/tmp`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - an unusable /tmp degrades loudly onto the work volume, never silently (Issue #515)", async () => {
  // Apple `container` reports supportsTmpfs: false, so on that runtime /tmp
  // is ordinary root filesystem and stops being writable the moment the root
  // goes read-only. A regular file standing in for the TMPDIR parent makes
  // `mkdir -p` fail for root and non-root alike.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const envFile = await stubDenoDumpingEnv(dir, [
      "VIBE_SCRATCH_DIR",
      "TMPDIR",
    ]);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    await Deno.mkdir(home, { recursive: true });
    await Deno.writeTextFile(`${dir}/not-a-dir`, "");

    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: {
        VIBE_BASE_DIR: `${dir}/repo`,
        HOME: home,
        TMPDIR: `${dir}/not-a-dir/tmp`,
      },
    });
    assertEquals(code, 0, stderr);

    const volumeScratch = `${home}/auto-issue-work/.container-scratch`;
    const env = parseEnvDump(await Deno.readTextFile(envFile));
    assertEquals(env["VIBE_SCRATCH_DIR"], volumeScratch);
    // mktemp and Deno.makeTempDir need somewhere writable too.
    assertEquals(env["TMPDIR"], `${volumeScratch}/tmp`);
    assertEquals(await exists(`${volumeScratch}/tmp`), true);
    // The staged source followed the scratch root onto the volume.
    assertEquals(
      await Deno.readTextFile(
        `${volumeScratch}/worker-src/worker/deno/mod.ts`,
      ),
      "// stub\n",
    );
    // Loud, not silent.
    assertStringIncludes(stderr, "not writable");
    assertStringIncludes(stderr, volumeScratch);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - an unusable durable Deno cache falls back to the scratch root, not the image default (Issue #515)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDenoWithEnv(dir);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    await Deno.mkdir(home, { recursive: true });
    await Deno.writeTextFile(`${dir}/not-a-dir`, "");

    const { code, stderr } = await runEntrypoint({
      dir,
      path: `${dir}/bin:/usr/bin:/bin`,
      env: {
        VIBE_BASE_DIR: `${dir}/repo`,
        HOME: home,
        VIBE_DENO_CACHE_DIR: `${dir}/not-a-dir/cache`,
      },
    });
    assertEquals(code, 0, stderr);

    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    // The image default (/home/vibe/.cache/deno) is the image layer, so the
    // fallback must be the scratch root instead — and must say so.
    assertEquals(argv[0], `DENO_DIR=${scratchRoot(dir)}/deno-cache`);
    assertStringIncludes(stderr, "could not use durable Deno cache");
    assertStringIncludes(stderr, `${scratchRoot(dir)}/deno-cache`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - a launch completes with the image layer read-only (Issue #515)", async () => {
  // The acceptance shape of Issue #509 in miniature: ${HOME} — the image
  // layer — is made read-only, leaving only /tmp and the already-created
  // mount targets writable. The launch must reach the driver with no EROFS
  // and no permission refusal, and must say which fallbacks it took.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    const argvFile = await stubDenoWithEnv(dir);
    await fakeRepo(dir);
    const home = `${dir}/home`;
    // The mounts the runtime creates before the container starts: the work
    // volume and the read-only credential directory.
    await Deno.mkdir(`${home}/auto-issue-work`, { recursive: true });
    await Deno.mkdir(`${home}/.vibe-coder/credentials/gh`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.vibe-coder/credentials/gh/hosts.yml`,
      "github.com:\n    user: vibe-bot\n",
    );
    await Deno.chmod(home, 0o555);

    let outcome;
    try {
      outcome = await runEntrypoint({
        dir,
        path: `${dir}/bin:/usr/bin:/bin`,
        env: { VIBE_BASE_DIR: `${dir}/repo`, HOME: home },
      });
    } finally {
      await Deno.chmod(home, 0o755);
    }

    assertEquals(outcome.code, 0, outcome.stderr);
    for (const refusal of ["Read-only file system", "Permission denied"]) {
      assert(
        !outcome.stderr.includes(refusal),
        `${refusal} in stderr: ${outcome.stderr}`,
      );
    }
    // Nothing degraded: every writer had a target that is not the image
    // layer, so the launch is the ordinary one.
    assert(!outcome.stderr.includes("Warning:"), outcome.stderr);
    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    // The durable cache and the tool caches on the writable volume mount…
    assertEquals(argv[0], `DENO_DIR=${home}/auto-issue-work/.deno-cache`);
    assertEquals(
      await exists(`${home}/auto-issue-work/.container-state`),
      true,
    );
    // …the per-launch copies on the tmpfs, and the driver actually ran.
    assert(argv.includes(`${scratchRoot(dir)}/worker-src/worker/deno/mod.ts`));
    assert(argv.includes("run-entrypoint"));
    // The credential is durable state, not per-launch scratch (Issue #564).
    assertEquals(await exists(`${stateRoot(dir)}/gh/hosts.yml`), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - a launch completes with the worker checkout mounted read-only (Issue #514)", async () => {
  // The acceptance shape of Issue #514: /workspace crosses the boundary
  // read-only, so the entrypoint may only ever READ the checkout. Staging the
  // driver copies out of it, and PROMPTS_DIR points back into it — neither
  // needs a write, and the launch must reach the driver with no EROFS.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  const checkout = `${dir}/repo`;
  try {
    const argvFile = `${dir}/argv.txt`;
    await Deno.mkdir(`${dir}/bin`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/bin/deno`,
      "#!/bin/bash\n" +
        `{ printf 'PROMPTS_DIR=%s\\n' "\${PROMPTS_DIR:-}"; printf '%s\\n' "$@"; } > "${argvFile}"\n` +
        "exit 0\n",
    );
    await Deno.chmod(`${dir}/bin/deno`, 0o755);
    await fakeRepo(dir);
    await Deno.mkdir(`${checkout}/prompts`, { recursive: true });
    await Deno.mkdir(`${dir}/home`, { recursive: true });
    // The checkout tree, immutable from the inside — directories first would
    // lock us out of the ones below, so the deepest are chmod'd first.
    for (
      const path of [
        `${checkout}/prompts`,
        `${checkout}/worker/deno`,
        `${checkout}/worker`,
        checkout,
      ]
    ) {
      await Deno.chmod(path, 0o555);
    }

    let outcome;
    try {
      outcome = await runEntrypoint({
        dir,
        path: `${dir}/bin:/usr/bin:/bin`,
        env: { VIBE_BASE_DIR: checkout },
      });
    } finally {
      for (
        const path of [
          checkout,
          `${checkout}/worker`,
          `${checkout}/worker/deno`,
          `${checkout}/prompts`,
        ]
      ) {
        await Deno.chmod(path, 0o755);
      }
    }

    assertEquals(outcome.code, 0, outcome.stderr);
    for (const refusal of ["Read-only file system", "Permission denied"]) {
      assert(
        !outcome.stderr.includes(refusal),
        `${refusal} in stderr: ${outcome.stderr}`,
      );
    }
    // Nothing degraded: no writer needed the checkout in the first place.
    assert(!outcome.stderr.includes("Warning:"), outcome.stderr);

    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    // The driver runs from the staged copy, which was read out of the
    // read-only mount…
    assert(argv.includes(`${scratchRoot(dir)}/worker-src/worker/deno/mod.ts`));
    assert(argv.includes("run-entrypoint"));
    // …and the prompts are still resolved in the checkout itself.
    assert(argv.includes(`PROMPTS_DIR=${checkout}/prompts`));
    // The base directory the driver is pointed at is unchanged.
    assert(argv.includes(checkout));

    // The staged copy must be writable even though its source was not: `cp
    // -R` carries the mode bits across, and the next launch's `rm -rf` needs
    // the write bit on every directory it empties.
    const stagedDir = `${scratchRoot(dir)}/worker-src/worker/deno`;
    const mode = (await Deno.stat(stagedDir)).mode ?? 0;
    assertEquals(
      mode & 0o200,
      0o200,
      `the staged copy at ${stagedDir} is not writable — the next launch ` +
        `could not replace it`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("entrypoint - a second launch still configures the credential helper (Issue #635)", async () => {
  // Observed live on the fleet: every launch after the first printed
  //
  //   warning: url.https://github.com/.insteadof has multiple values
  //   error: cannot overwrite multiple values with a single value
  //   Warning: could not configure the HTTPS git transport
  //
  // The global config now survives the run in ${STATE_ROOT}/gitconfig, so
  // from the second launch the plain `git config` set hit a key that already
  // held two values and failed. The `&&` chain then short-circuited BEFORE
  // the credential helper, leaving git with no way to authenticate for the
  // whole cycle — the failure class of Issue #564.
  //
  // Real git here, not the argv-recording stub: the bug was in git's own
  // multi-value semantics, and a stub that exits 0 cannot see it.
  const dir = await Deno.makeTempDir({ prefix: "vibe-entrypoint-" });
  try {
    await stubDeno(dir);
    const ghRecordFile = `${dir}/gh-record.txt`;
    await Deno.writeTextFile(
      `${dir}/bin/gh`,
      `#!/bin/bash\nprintf '%s\\n' "$*" >> "${ghRecordFile}"\nexit 0\n`,
    );
    await Deno.chmod(`${dir}/bin/gh`, 0o755);
    await fakeRepo(dir);
    await Deno.mkdir(`${dir}/home/.vibe-coder/credentials/gh`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${dir}/home/.vibe-coder/credentials/gh/hosts.yml`,
      "github.com:\n",
    );

    // Real git, and the same HOME both times — a persisted global config is
    // the whole point.
    const env = { VIBE_BASE_DIR: `${dir}/repo`, HOME: `${dir}/home` };
    // The stub dir carries deno and gh; git is deliberately NOT stubbed, so
    // the real one from /usr/bin answers and its multi-value rules apply.
    const path = `${dir}/bin:/usr/bin:/bin`;
    const first = await runEntrypoint({ dir, path, env });
    assertEquals(first.code, 0, first.stderr);

    const second = await runEntrypoint({ dir, path, env });
    assertEquals(second.code, 0, second.stderr);

    // The exact strings the fleet printed must not come back.
    assertEquals(
      second.stderr.includes("could not configure the HTTPS git transport"),
      false,
      `second launch reported a broken git transport:\n${second.stderr}`,
    );
    assertEquals(
      second.stderr.includes("cannot overwrite multiple values"),
      false,
      `second launch hit the multi-value set:\n${second.stderr}`,
    );

    // And the config is right, not merely quiet: the helper git actually
    // needs to authenticate is present after both launches, exactly once.
    const config = await Deno.readTextFile(`${stateRoot(dir)}/gitconfig`);
    assertEquals(
      (config.match(/!gh auth git-credential/g) ?? []).length,
      1,
      `credential helper should be configured exactly once:\n${config}`,
    );
    assertEquals(
      (config.match(/insteadOf = git@github\.com:/g) ?? []).length,
      1,
      `SSH rewrite should be configured exactly once:\n${config}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
