/**
 * End-to-end tests for `infra/verify/first-run.sh` (Issue #736).
 *
 * The script sequences the fresh first-run verification: it gathers the host
 * facts, starts `setup.sh` and `run.sh`, waits on the container and the
 * worker, and hands every judgement to `first-run-verify`. These tests run the
 * real script against stub `setup.sh` / `run.sh` / `podman` executables and
 * the **real** Deno command, then assert on the exit status and the report it
 * wrote — the wiring, not the decisions (those are unit-tested in
 * `first_run_verification_test.ts`).
 *
 * What they hold:
 *
 *   - a clean host passes every stage and the report says so;
 *   - a host carrying a workaround is refused before `setup.sh` is touched;
 *   - a fault a sibling issue removed is reported as a defect to file;
 *   - the refused-trim evidence is read from `run_core.log`, where `run.sh`
 *     actually writes it — not only from the launcher's own output;
 *   - a worker that claims but completes nothing fails the run.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";

/** tests/ → worker/deno/ → worker/ → repository root. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const SCRIPT = `${REPO_ROOT}/infra/verify/first-run.sh`;

/** Executables the stub PATH borrows from the host, by absolute path. */
const BORROWED = ["git", "sed", "grep", "date", "uname", "df", "tail", "cat"];

interface Sandbox {
  /** Temporary root holding the fake HOME and the fake checkout. */
  readonly dir: string;
  /** The fake checkout the script verifies. */
  readonly repo: string;
  /** The fake HOME, holding `logs/` and the transcript. */
  readonly home: string;
  /** Where the stub executables live. */
  readonly bin: string;
  /** Transcript directory the run writes into. */
  readonly transcript: string;
  cleanup(): Promise<void>;
}

interface StubOptions {
  /** Lines `setup.sh` prints; it also writes the configuration. */
  setupOutput?: string;
  /** `agent_providers` the stub `setup.sh` writes, or null to write nothing. */
  configProviders?: string[] | null;
  /** Lines the stub `run.sh` prints before it settles. */
  launchOutput?: string;
  /** Exit status of the stub `run.sh` (non-zero exits immediately). */
  launchExit?: number;
  /** Lines the stub `run.sh` appends to `~/logs/run_core.log`. */
  runCoreLog?: string;
  /** What the stub image reports for its provider stamp. */
  imageProviders?: string;
  /** CLIs the stub image reports as installed. */
  imageClis?: string[];
  /** Lines the stub `run.sh` appends to `~/logs/worker.log`. */
  workerLog?: string;
  /** What the launcher's runtime detection answers (default `podman`). */
  runtimeDetect?: string;
  /** Exit status of that detection (non-zero means it could not answer). */
  runtimeDetectExit?: number;
  /** `run_core.log` content written before the run, as a previous launch would. */
  staleRunCoreLog?: string;
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await Deno.writeTextFile(path, body);
  await Deno.chmod(path, 0o755);
}

/**
 * Build a sandbox: a fake, committed checkout carrying stub `setup.sh` and
 * `run.sh`, a fake HOME, and a stub PATH with `podman` and a dispatching
 * `deno` on it and no `claude`.
 */
async function sandbox(options: StubOptions = {}): Promise<Sandbox> {
  const dir = await Deno.makeTempDir({ prefix: "first-run-verify-" });
  const repo = `${dir}/checkout`;
  const home = `${dir}/home`;
  const bin = `${dir}/bin`;
  const transcript = `${dir}/transcript`;
  for (const path of [repo, home, bin, `${home}/logs`]) {
    await Deno.mkdir(path, { recursive: true });
  }

  if (options.staleRunCoreLog) {
    await Deno.writeTextFile(
      `${home}/logs/run_core.log`,
      `${options.staleRunCoreLog}\n`,
    );
  }

  for (const tool of BORROWED) {
    const resolved = await which(tool);
    if (resolved) await Deno.symlink(resolved, `${bin}/${tool}`);
  }

  const providers = options.configProviders === undefined
    ? ["codex"]
    : options.configProviders;
  const configWrite = providers === null
    ? ""
    : `printf '%s\\n' ${
      shellQuote(JSON.stringify({ agent_providers: providers }))
    } > "$(dirname "$0")/.config.json"`;

  await writeExecutable(
    `${repo}/setup.sh`,
    [
      "#!/bin/bash",
      `printf '%s\\n' ${shellQuote(options.setupOutput ?? "Setup complete")}`,
      // Records the provider the run declared, so a test can assert setup was
      // told which agent this host runs.
      'printf "%s\\n" "${VIBE_AGENT_PROVIDER:-unset}" > "${HOME}/setup-ran"',
      configWrite,
      "",
    ].join("\n"),
  );

  await writeExecutable(
    `${repo}/run.sh`,
    [
      "#!/bin/bash",
      `printf '%s\\n' ${shellQuote(options.launchOutput ?? "[run.sh] built")}`,
      options.runCoreLog
        ? `printf '%s\\n' ${
          shellQuote(options.runCoreLog)
        } >> "\${HOME}/logs/run_core.log"`
        : ":",
      options.workerLog
        ? `printf '%s\\n' ${
          shellQuote(options.workerLog)
        } >> "\${HOME}/logs/worker.log"`
        : ":",
      `if [[ ${options.launchExit ?? 0} -ne 0 ]]; then exit ${
        options.launchExit ?? 0
      }; fi`,
      // Stand in for the worker running in the foreground.
      "sleep 5",
      "",
    ].join("\n"),
  );

  await writeExecutable(
    `${bin}/podman`,
    [
      "#!/bin/bash",
      'case "$1" in',
      // A fresh host carries no image, so `image ls` prints nothing.
      '  image) [[ "$2" != "inspect" ]] || printf ' +
      `"VIBE_IMAGE_AGENT_PROVIDERS=%s\\n" "${
        options.imageProviders ?? "codex"
      }" ;;`,
      '  ps) printf "vibe-coder-1\\n" ;;',
      // `podman run` reports which CLIs the built image carries.
      "  run)",
      ...cliReport(options.imageClis ?? ["codex"]),
      "  ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );

  // The real Deno, with the real command: the script's judgements are made by
  // `first-run-verify`, so stubbing it would test nothing. Only the two
  // launcher queries this sandbox cannot answer are faked.
  await writeExecutable(
    `${bin}/deno`,
    [
      "#!/bin/bash",
      'for arg in "$@"; do',
      '  case "$arg" in',
      '    container-image-hash) printf "vibe-coder:abc123\\n"; exit 0 ;;',
      `    container-runtime-detect) printf "${
        options.runtimeDetect ?? "podman"
      }\\n"; exit ${options.runtimeDetectExit ?? 0} ;;`,
      "  esac",
      "done",
      "args=()",
      'for arg in "$@"; do',
      '  if [[ "$arg" == "worker/deno/mod.ts" ]]; then',
      `    arg="${REPO_ROOT}/worker/deno/mod.ts"`,
      "  fi",
      '  args+=("$arg")',
      "done",
      `exec "${Deno.execPath()}" "\${args[@]}"`,
      "",
    ].join("\n"),
  );

  await writeExecutable(`${bin}/gh`, "#!/bin/bash\necho gh 2.0\n");

  // A committed checkout: `git status --porcelain` must be empty, or the run
  // is refused as patched.
  await run(["git", "init", "-q", "-b", "main", repo], dir);
  await run(["git", "-C", repo, "config", "user.email", "t@example.com"], dir);
  await run(["git", "-C", repo, "config", "user.name", "Test"], dir);
  await run(["git", "-C", repo, "add", "-A"], dir);
  await run(["git", "-C", repo, "commit", "-qm", "stubs"], dir);

  return {
    dir,
    repo,
    home,
    bin,
    transcript,
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

/** Lines that make the stub image report the CLIs it carries. */
function cliReport(clis: string[]): string[] {
  return [
    clis.includes("codex")
      ? '  printf "CODEX_PRESENT\\n"'
      : '  printf "CODEX_ABSENT\\n"',
    clis.includes("claude")
      ? '  printf "CLAUDE_PRESENT\\n"'
      : '  printf "CLAUDE_ABSENT\\n"',
  ];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function which(tool: string): Promise<string | null> {
  for (const prefix of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    try {
      await Deno.stat(`${prefix}/${tool}`);
      return `${prefix}/${tool}`;
    } catch {
      continue;
    }
  }
  return null;
}

async function run(cmd: [string, ...string[]], cwd: string): Promise<void> {
  const [executable, ...args] = cmd;
  const { code, stderr } = await new Deno.Command(executable, {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  assertEquals(code, 0, new TextDecoder().decode(stderr));
}

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly report: string;
}

/** Run the verification script against a sandbox. */
async function verify(
  box: Sandbox,
  env: Record<string, string> = {},
): Promise<Outcome> {
  const { code, stdout, stderr } = await new Deno.Command("bash", {
    args: [
      SCRIPT,
      "--repo-root",
      box.repo,
      "--transcript-dir",
      box.transcript,
      "--poll-interval",
      "1",
      "--claim-timeout",
      "2",
      "--launch-timeout",
      "4",
    ],
    cwd: box.dir,
    clearEnv: true,
    env: {
      HOME: box.home,
      PATH: `${box.bin}:/usr/bin:/bin`,
      // The real Deno needs its module cache; the sandbox HOME has none.
      DENO_DIR: Deno.env.get("DENO_DIR") ??
        `${Deno.env.get("HOME") ?? "/root"}/.cache/deno`,
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decoder = new TextDecoder();
  let report = "";
  try {
    report = await Deno.readTextFile(`${box.transcript}/report.md`);
  } catch {
    report = "";
  }
  return {
    code,
    stdout: decoder.decode(stdout) + decoder.decode(stderr),
    report,
  };
}

Deno.test("first-run.sh - a clean host passes every stage with no workaround", async () => {
  const box = await sandbox({
    launchOutput: "[run.sh] built\nvolume-init: trimmed /work (Issue #384)",
    workerLog: "Processing issue o/r#1: a title\nSuccessfully processed o/r#1",
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 0, outcome.stdout);
    assertStringIncludes(outcome.report, "verdict: **PASS**");
    assertStringIncludes(outcome.report, "None — no workaround was required.");
    for (
      const stage of [
        "fresh-state",
        "prerequisites",
        "setup",
        "config",
        "launch",
        "volume-init",
        "image",
        "claim",
      ]
    ) {
      assertStringIncludes(outcome.report, `| ${stage} | PASS |`);
    }
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - refuses a host that skips the prerequisite probe, before setup runs", async () => {
  const box = await sandbox();
  try {
    const outcome = await verify(box, { VIBE_SKIP_PREREQ_CHECK: "true" });
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "verdict: **FAIL**");
    assertStringIncludes(outcome.report, "VIBE_SKIP_PREREQ_CHECK is set");
    assertStringIncludes(outcome.report, "| fresh-state | FAIL |");
    assertStringIncludes(outcome.report, "| setup | SKIPPED |");
    // The workaround was refused rather than run around.
    let ran = true;
    try {
      await Deno.stat(`${box.home}/setup-ran`);
    } catch {
      ran = false;
    }
    assertEquals(ran, false, "setup.sh must not run on a patched host");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - a refused mount option is reported as a defect to file", async () => {
  const box = await sandbox({
    launchOutput: 'Error: unknown mount option "uid=1000"',
    launchExit: 1,
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "Issue #727");
    assertStringIncludes(outcome.report, "file as a further sub-issue of #722");
    assertStringIncludes(outcome.report, "| launch | FAIL |");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - reads the refused trim from run_core.log, where run.sh writes it", async () => {
  // run.sh captures volume-init's stdout, so `VOLUME_TRIM_REFUSED` never
  // reaches the launcher's own output: the refusal is recorded in
  // run_core.log (Issue #734). Reading only the launch log would miss it.
  const box = await sandbox({
    launchOutput: "[run.sh] built\nvolume-init: /work - discard unsupported",
    runCoreLog:
      "2026-09-02T00:00:00Z host-disk: 38400 MB free on /var/lib/containers - " +
      "this runtime refused to trim vibe-work on this launch (Issues #384, #734)",
    workerLog: "Processing issue o/r#1: a title\nSuccessfully processed o/r#1",
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 0, outcome.stdout);
    assertStringIncludes(outcome.report, "verdict: **PASS**");
    assertStringIncludes(outcome.report, "Issue #734");
    assertStringIncludes(outcome.report, "None — no workaround was required.");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - fails when the worker claims but completes nothing", async () => {
  const box = await sandbox({
    launchOutput: "volume-init: trimmed /work",
    // The worker's own claim marker, with no completion after it.
    workerLog: "Processing issue o/r#1: a title",
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "| claim | FAIL |");
    assertStringIncludes(outcome.report, "verdict: **FAIL**");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - --help names every option and exits 0", async () => {
  const { code, stdout } = await new Deno.Command("bash", {
    args: [SCRIPT, "--help"],
    stdout: "piped",
    stderr: "null",
  }).output();
  const help = new TextDecoder().decode(stdout);
  assertEquals(code, 0);
  for (
    const flag of [
      "--transcript-dir",
      "--repo-root",
      "--claim-timeout",
      "--launch-timeout",
      "--poll-interval",
    ]
  ) {
    assertStringIncludes(help, flag);
  }
});

Deno.test("first-run.sh - setup is told which agent this bare host runs", async () => {
  // A bare host has no .config.json for setup to read the selection from, so
  // the run declares it (docs/SETUP.md) and the report records the declaration
  // as a note rather than leaving a reader to find it in a log.
  const box = await sandbox({
    launchOutput: "[run.sh] built\nvolume-init: trimmed /work",
    workerLog: "Processing issue o/r#1\nSuccessfully processed o/r#1",
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 0, outcome.stdout);
    assertEquals(
      (await Deno.readTextFile(`${box.home}/setup-ran`)).trim(),
      "codex",
    );
    assertStringIncludes(outcome.report, "VIBE_AGENT_PROVIDER=codex");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - a runtime that is not podman fails the stage that claims it is", async () => {
  const box = await sandbox({ runtimeDetect: "docker" });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "| prerequisites | FAIL |");
    assertStringIncludes(outcome.report, "| setup | SKIPPED |");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - a detection that could not answer is not read as podman", async () => {
  const box = await sandbox({ runtimeDetect: "podman", runtimeDetectExit: 1 });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "| prerequisites | FAIL |");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - a previous launch's refused trim is not attributed to this run", async () => {
  // run_core.log is appended to and never truncated, so without a run window
  // every attempt on a host inherits the last one's findings and the runs stop
  // being comparable — which is the whole point of scripting this.
  const box = await sandbox({
    staleRunCoreLog:
      "volume-init: /work - this runtime does not support discard",
    launchOutput: "[run.sh] built\nvolume-init: trimmed /work",
    workerLog: "Processing issue o/r#1\nSuccessfully processed o/r#1",
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 0, outcome.stdout);
    assertStringIncludes(outcome.report, "None observed.");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - the worker's claim-time refusal is read from worker.log", async () => {
  // Criterion 7 of Issue #736 is about the *claim*, which the worker refuses in
  // worker.log — not the launcher, which refuses in run_core.log.
  const box = await sandbox({
    launchOutput: "[run.sh] built\nvolume-init: trimmed /work",
    workerLog: "[HOST_DISK_LOW] 3.2 GB free (4.1%) of 78.0 GB, floor 8.0 GB " +
      "- below the floor - draining the issue pool before claiming further work",
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "named both the resolved floor");
    assertStringIncludes(outcome.report, "| claim | FAIL |");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - the run leaves no worker behind", async () => {
  // The worker runs in the foreground under run.sh. A verification that exits
  // without stopping it leaves the host in the state its own stage 1 refuses,
  // so the next run on that host could never start.
  const box = await sandbox({
    launchOutput: "[run.sh] built\nvolume-init: trimmed /work",
    workerLog: "Processing issue o/r#1\nSuccessfully processed o/r#1",
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 0, outcome.stdout);
    assertStringIncludes(outcome.stdout, "stopping container vibe-coder-1");
  } finally {
    await box.cleanup();
  }
});
