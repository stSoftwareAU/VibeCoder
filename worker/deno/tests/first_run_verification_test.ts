/**
 * Tests for the scripted fresh first-run verification (Issue #736).
 *
 * Issue #722's definition of done is an end-to-end run on a fresh Ubuntu +
 * Podman host: `setup.sh` then `run.sh` complete and the worker takes one
 * issue end to end with **no** manual workarounds. `infra/verify/first-run.sh`
 * is that run, scripted so its output is comparable between attempts.
 *
 * The real run needs a real host, a real Podman and a real image build, so it
 * cannot be executed here. What these tests hold is the harness's own
 * behaviour, which is what a later reader trusts when they read its report:
 *
 *   - a host carrying any of the reporter's workarounds is refused **before**
 *     `setup.sh` is touched, so a patched host can never be reported as a
 *     clean first run;
 *   - the two known-benign messages (a private-repository ruleset 403, a
 *     refused `FITRIM`) are recorded as expected warnings and do not fail the
 *     run;
 *   - each fault the sibling issues fixed is recognised by name if it comes
 *     back, and reported as a defect to file against #722;
 *   - a stage that did not run is `SKIPPED`, never a pass, and the exit status
 *     is non-zero whenever anything was refused, failed or skipped short.
 *
 * Each case runs the real script against stub `setup.sh` / `run.sh` / `podman`
 * / `deno` executables and asserts on the exit status and the report it
 * wrote — no source-text inspection.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

/** tests/ → worker/deno/ → worker/ → repository root. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(
  /\/$/,
  "",
);
const SCRIPT = `${REPO_ROOT}/infra/verify/first-run.sh`;

/** Executables the stub PATH borrows from the host, by absolute path. */
const BORROWED = ["git", "jq", "sed", "grep", "date", "uname", "df", "tail"];

interface Sandbox {
  /** Temporary root holding the fake HOME and the fake checkout. */
  readonly dir: string;
  /** The fake checkout the script verifies. */
  readonly repo: string;
  /** The fake HOME, holding `logs/worker.log` and the transcript. */
  readonly home: string;
  /** Where the stub executables live — the only PATH entry that matters. */
  readonly bin: string;
  /** Transcript directory the run writes into. */
  readonly transcript: string;
  cleanup(): Promise<void>;
}

interface StubOptions {
  /** Lines `setup.sh` prints; it also writes the configuration. */
  setupOutput?: string;
  /** Exit status of the stub `setup.sh`. */
  setupExit?: number;
  /** `agent_providers` the stub `setup.sh` writes, or null to write nothing. */
  configProviders?: string[] | null;
  /** Lines the stub `run.sh` prints before it settles. */
  launchOutput?: string;
  /** Exit status of the stub `run.sh` (non-zero exits immediately). */
  launchExit?: number;
  /** What the stub `podman image inspect` reports for the provider stamp. */
  imageProviders?: string;
  /** CLIs the stub image reports as installed. */
  imageClis?: string[];
  /** Lines the stub `run.sh` appends to `~/logs/worker.log`. */
  workerLog?: string;
}

async function writeExecutable(path: string, body: string): Promise<void> {
  await Deno.writeTextFile(path, body);
  await Deno.chmod(path, 0o755);
}

/**
 * Build a sandbox: a fake, committed checkout carrying stub `setup.sh` and
 * `run.sh`, a fake HOME, and a stub PATH with `podman` and `deno` on it and
 * no `claude`.
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

  for (const tool of BORROWED) {
    const resolved = await which(tool);
    if (resolved) await Deno.symlink(resolved, `${bin}/${tool}`);
  }

  const providers = options.configProviders === undefined
    ? ["codex"]
    : options.configProviders;
  const configWrite = providers === null
    ? ""
    : `printf '%s\\n' '${
      JSON.stringify({ agent_providers: providers, repositories: ["o/r"] })
    }' > "$(dirname "$0")/.config.json"`;

  await writeExecutable(
    `${repo}/setup.sh`,
    [
      "#!/bin/bash",
      `printf '%s\\n' ${shellQuote(options.setupOutput ?? "Setup complete")}`,
      'printf "ran\\n" > "${HOME}/setup-ran"',
      configWrite,
      `exit ${options.setupExit ?? 0}`,
      "",
    ].join("\n"),
  );

  await writeExecutable(
    `${repo}/run.sh`,
    [
      "#!/bin/bash",
      `printf '%s\\n' ${shellQuote(options.launchOutput ?? "[run.sh] built")}`,
      'printf "ran\\n" > "${HOME}/run-ran"',
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

  await writeExecutable(
    `${bin}/deno`,
    [
      "#!/bin/bash",
      // Only ever asked for the content-derived image reference.
      'printf "vibe-coder:abc123\\n"',
      "",
    ].join("\n"),
  );

  await writeExecutable(`${bin}/codex`, "#!/bin/bash\necho codex 1.0\n");
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
      ? '  printf "/usr/local/bin/codex\\n"'
      : '  printf "NO_CODEX\\n"',
    clis.includes("claude")
      ? '  printf "/usr/local/bin/claude\\n"'
      : '  printf "NO_CLAUDE\\n"',
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
    env: { HOME: box.home, PATH: `${box.bin}:/usr/bin:/bin`, ...env },
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
    workerLog: "Claimed by `worker-1`\nSuccessfully processed o/r#1",
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 0, outcome.stdout);
    assertStringIncludes(outcome.report, "verdict: **PASS**");
    assertStringIncludes(outcome.report, "None — no workaround was required.");
    assertEquals(
      outcome.report.includes("| SKIPPED |") ||
        outcome.report.includes("| FAIL |"),
      false,
      outcome.report,
    );
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
    await assertAbsent(`${box.home}/setup-ran`);
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - refuses a moved claiming floor", async () => {
  const box = await sandbox();
  try {
    const outcome = await verify(box, { VIBE_HOST_DISK_LOW_FLOOR_GB: "1" });
    assertEquals(outcome.code, 1);
    assertStringIncludes(
      outcome.report,
      "VIBE_HOST_DISK_LOW_FLOOR_GB is set",
    );
    assertStringIncludes(outcome.report, "Issue #732");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - refuses a configuration setup did not write", async () => {
  const box = await sandbox();
  try {
    await Deno.writeTextFile(`${box.repo}/.config.json`, "{}");
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "already exists");
    await assertAbsent(`${box.home}/setup-ran`);
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - refuses the short-name registry workaround", async () => {
  const box = await sandbox();
  try {
    await Deno.mkdir(`${box.home}/.config/containers`, { recursive: true });
    await Deno.writeTextFile(
      `${box.home}/.config/containers/registries.conf`,
      '[aliases]\n"node" = "docker.io/library/node"\n',
    );
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "Issue #728");
    assertStringIncludes(outcome.report, "registries.conf sets [aliases]");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - refuses a patched checkout", async () => {
  const box = await sandbox();
  try {
    await Deno.writeTextFile(`${box.repo}/run.sh`, "#!/bin/bash\nexit 0\n");
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "uncommitted changes");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - records the ruleset 403 and the refused trim as expected warnings", async () => {
  const box = await sandbox({
    setupOutput:
      "Ruleset sync for o/r: repository rulesets need GitHub Pro on a private repository (non-fatal)",
    launchOutput: "volume-init: vibe-work - discard unsupported\n" +
      "VOLUME_TRIM_REFUSED vibe-work",
    workerLog: "Claimed by `worker-1`\nSuccessfully processed o/r#1",
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 0, outcome.stdout);
    assertStringIncludes(outcome.report, "verdict: **PASS**");
    assertStringIncludes(outcome.report, "Issue #733");
    assertStringIncludes(outcome.report, "Issue #734");
    assertStringIncludes(outcome.report, "None — no workaround was required.");
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
    assertStringIncludes(
      outcome.report,
      "file as a further sub-issue of #722",
    );
    assertStringIncludes(outcome.report, "| launch | FAIL |");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - a refused trim followed by a refused launch is a defect, not an expected warning", async () => {
  const box = await sandbox({
    launchOutput: "VOLUME_TRIM_REFUSED vibe-work\n" +
      "[run.sh] refusing to launch: 900 MB free on /var/lib/containers",
    launchExit: 1,
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    // The reading still runs after the launch failed — that chain is the
    // finding, and skipping the analysis would drop it.
    assertStringIncludes(outcome.report, "| volume-init | FAIL |");
    assertStringIncludes(
      outcome.report,
      "a refused trim was followed by a refused launch (Issue #734)",
    );
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - fails a configuration that is not Codex-only", async () => {
  const box = await sandbox({ configProviders: ["claude"] });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "| config | FAIL |");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - fails an image that reports the wrong provider", async () => {
  const box = await sandbox({
    imageProviders: "claude",
    imageClis: ["claude"],
    workerLog: "Successfully processed o/r#1",
  });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "| image | FAIL |");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - fails when the worker claims but completes nothing", async () => {
  const box = await sandbox({ workerLog: "Claimed by `worker-1`" });
  try {
    const outcome = await verify(box);
    assertEquals(outcome.code, 1);
    assertStringIncludes(outcome.report, "| claim | FAIL |");
    assertStringIncludes(outcome.report, "verdict: **FAIL**");
  } finally {
    await box.cleanup();
  }
});

Deno.test("first-run.sh - the documented run is the scripted one", async () => {
  const doc = await Deno.readTextFile(
    `${REPO_ROOT}/docs/EC2-LINUX-VERIFICATION.md`,
  );
  assertStringIncludes(doc, "infra/verify/first-run.sh");
  assert(
    (await Deno.stat(SCRIPT)).mode! & 0o111,
    "the verification script must be executable",
  );
});

/** Assert a path was never created. */
async function assertAbsent(path: string): Promise<void> {
  let exists = true;
  try {
    await Deno.stat(path);
  } catch {
    exists = false;
  }
  assertEquals(exists, false, `${path} should not exist`);
}
