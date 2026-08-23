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

/** Create a throwaway repo layout the entrypoint can point at. */
async function fakeRepo(dir: string): Promise<void> {
  await Deno.mkdir(`${dir}/repo/worker/deno`, { recursive: true });
  await Deno.writeTextFile(`${dir}/repo/worker/deno/mod.ts`, "// stub\n");
  await Deno.writeTextFile(`${dir}/repo/worker/deno/deno.lock`, "{}\n");
}

async function runEntrypoint(
  opts: {
    dir: string;
    path: string;
    env?: Record<string, string>;
    args?: string[];
    /** Run with HOME genuinely unset (the legacy-path case only). */
    homeless?: boolean;
  },
): Promise<{ code: number; stderr: string }> {
  // HOME is isolated at the temporary directory exactly like VIBE_BASE_DIR
  // (Issue #4284). The entrypoint's gh-credential staging is gated on
  // ${HOME:-/home/vibe}/.vibe-coder/credentials/gh/hosts.yml, so a case that
  // leaves HOME to the host reads — and copies — the OPERATOR's real
  // credential: false in CI, true on every worker host, where the branch
  // then needs mkdir/cp/sed that a stub-only PATH does not provide and the
  // entrypoint exits 127.
  const env: Record<string, string> = {
    PATH: opts.path,
    HOME: `${opts.dir}/home`,
    ...(opts.env ?? {}),
  };
  if (opts.homeless) delete env.HOME;

  // Absolute interpreter path: the child PATH is deliberately restricted to
  // the stub bin directory, so `bash` must not be resolved through it.
  const command = new Deno.Command("/bin/bash", {
    args: [ENTRYPOINT, ...(opts.args ?? [])],
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stderr } = await command.output();
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
    assertEquals(gitArgv, [
      "config --global --add safe.directory *",
      "config --global url.https://github.com/.insteadOf git@github.com:",
      "config --global --add url.https://github.com/.insteadOf ssh://git@github.com/",
      "config --global credential.https://github.com.helper",
      "config --global --add credential.https://github.com.helper !gh auth git-credential",
    ]);
    // The helper is written directly — `gh auth setup-git` would attempt a
    // config migration it cannot write into the read-only credential mount.
    assertEquals(await exists(ghRecordFile), false);

    // The writable runtime copy is staged for gh's own config migration.
    assertEquals(
      await Deno.readTextFile(`${dir}/home/.config/gh-runtime/hosts.yml`),
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
  // Observed live: private-repo-6's helpers/repos.sh runs raw `git push` in the
  // worker's inherited environment; without GH_CONFIG_DIR the credential
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
    assertEquals(
      (await Deno.readTextFile(envFile)).trim(),
      `${dir}/home/.config/gh-runtime`,
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
  // Raw scripts (private-repo-6's repos.sh) inherit no per-call identity, so
  // their `git commit` died identity-less, exited 0, and the uncommitted
  // repos.json edit rate-limited every retry — the heartbeat stayed dead
  // behind three separate silent layers. The identity comes from the
  // credential's own `user:` record, so heartbeat commits attribute to the
  // host's service account like the rest of the fleet.
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

    const child = new Deno.Command("bash", {
      args: [
        new URL("../../../container/entrypoint.sh", import.meta.url).pathname,
      ],
      env: {
        PATH: `${dir}/bin:/usr/bin:/bin`,
        VIBE_BASE_DIR: `${dir}/repo`,
        HOME: `${dir}/home`,
      },
      stdout: "null",
      stderr: "null",
      stdin: "null",
    }).spawn();

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
    // Driver and lockfile come from the VM-local staged copy.
    assert(
      argv.includes(`${home}/.worker-src/worker/deno/mod.ts`),
      `driver not staged locally: ${argv.join(" ")}`,
    );
    assert(argv.includes(`--lock=${home}/.worker-src/worker/deno/deno.lock`));
    // The staged copy really exists and matches the source.
    assertEquals(
      await Deno.readTextFile(`${home}/.worker-src/worker/deno/mod.ts`),
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
    // A leftover staged copy from a previous (different) build.
    await Deno.mkdir(`${home}/.worker-src/worker/deno`, { recursive: true });
    await Deno.writeTextFile(
      `${home}/.worker-src/worker/deno/mod.ts`,
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
      await Deno.readTextFile(`${home}/.worker-src/worker/deno/mod.ts`),
      "// stub\n",
    );
    const argv = (await Deno.readTextFile(argvFile)).trim().split("\n");
    assert(argv.includes(`${home}/.worker-src/worker/deno/mod.ts`));
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
    assert(argv.includes(`${home}/.worker-src/worker/deno/mod.ts`));
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
