/**
 * Tests for the pre-push gate's cargo-deny stage (Issue #4626): a push that
 * touches a cargo input runs the repository's CI cargo-deny invocation
 * locally, and a tool or advisory database that cannot be reached is an
 * infrastructure refusal, never a pass.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import {
  assert,
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
} from "@std/assert";
import {
  PrePushGateInfrastructureError,
  runPrePushGate,
} from "../lib/pre_push_gate.ts";
import type {
  PreFlightCommandResult,
  PreFlightRunner,
} from "../lib/pre_flight_gate.ts";

const GIT_ENV = ["-c", "user.email=t@e", "-c", "user.name=t"];
const ZERO = "0".repeat(40);
const DENY_ARGV = "'cargo' 'deny' '--all-features' 'check' 'advisories' 'bans'";

Deno.test("cargo deny: baseRef checks a source-only branch", async () => {
  const { root, clone, stdin } = await makeRepo(CI_WITH_DENY, {
    "src/main.rs": "fn main() { }\n",
  });
  try {
    const seen: Seen[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      baseRef: "origin/main",
      preFlightCommands: [],
      runner: recordingRunner(seen, () => PASS),
    });
    assert(result.ok);
    assertEquals(denyCommands(seen), [{ command: DENY_ARGV, cwd: clone }]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cargo deny: shellcheck-only mode skips cargo deny even with a baseRef", async () => {
  const { root, clone, stdin } = await makeRepo(CI_WITH_DENY, {
    "src/main.rs": "fn main() { }\n",
  });
  try {
    const seen: Seen[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      baseRef: "origin/main",
      shellcheckOnly: true,
      preFlightCommands: [],
      runner: recordingRunner(seen, () => PASS),
    });
    assert(result.ok);
    assertEquals(denyCommands(seen), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const CI_WITH_DENY = [
  "name: ci",
  "on: push",
  "jobs:",
  "  deny:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - uses: actions/checkout@v4",
  "      - run: cargo deny --all-features check advisories bans",
  "",
].join("\n");

const CI_WITHOUT_DENY = [
  "name: ci",
  "on: push",
  "jobs:",
  "  test:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: cargo test --workspace",
  "",
].join("\n");

const CI_WITH_MATRIX_DENY = [
  "name: ci",
  "on: push",
  "jobs:",
  "  deny:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: cargo deny --all-features ${{ matrix.check }} check",
  "",
].join("\n");

/** The output cargo-deny prints for a real audit failure. */
const VERDICT_OUTPUT =
  "error[vulnerability]: Detected vulnerability crate `foo` 1.0.0\n" +
  "  ┌─ Cargo.lock:4:1\n";

/** The real output a CI runner printed when the advisory database could not be cloned. */
const ADVISORY_UNREACHABLE_OUTPUT =
  "2026-11-07 18:04:31 [ERROR] failed to fetch advisory database " +
  "https://x/y with cli: failed to clone: [...]\n" +
  "fatal: unable to access 'https://x/y/': CONNECT tunnel failed, response 403";

const PASS: PreFlightCommandResult = {
  started: true,
  code: 0,
  stdout: "",
  stderr: "",
};

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

/**
 * A bare remote and a clone whose first commit (an optional CI workflow and a
 * source file) is pushed. One local commit then writes `changed`, and the
 * returned `stdin` is the push of that commit.
 */
async function makeRepo(
  workflow: string | null,
  changed: Record<string, string>,
): Promise<{ root: string; clone: string; stdin: string }> {
  const root = await Deno.makeTempDir({ prefix: "vibe-pp-cargo-deny-" });
  const remote = `${root}/remote.git`;
  const clone = `${root}/clone`;
  await git(root, "init", "-q", "--bare", "-b", "main", remote);
  await git(root, "clone", "-q", remote, clone);
  if (workflow !== null) {
    await Deno.mkdir(`${clone}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(`${clone}/.github/workflows/ci.yml`, workflow);
  }
  await Deno.mkdir(`${clone}/src`, { recursive: true });
  await Deno.writeTextFile(`${clone}/src/main.rs`, "fn main() {}\n");
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "init");
  await git(clone, "push", "-q", "origin", "HEAD:main");
  for (const [path, text] of Object.entries(changed)) {
    await Deno.writeTextFile(`${clone}/${path}`, text);
  }
  await git(clone, "add", ".");
  await git(clone, "commit", "-qm", "change");
  const sha = await git(clone, "rev-parse", "HEAD");
  return {
    root,
    clone,
    stdin: `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`,
  };
}

interface Seen {
  command: string;
  cwd: string | undefined;
}

/** A runner that records each command and cwd, then replies by command. */
function recordingRunner(
  seen: Seen[],
  reply: (command: string) => PreFlightCommandResult,
): PreFlightRunner {
  return (command, options) => {
    seen.push({ command, cwd: options.cwd });
    return Promise.resolve(reply(command));
  };
}

/** The cargo-deny commands the runner was given. */
function denyCommands(seen: Seen[]): Seen[] {
  return seen.filter((s) => s.command.includes("'deny'"));
}

Deno.test("cargo deny: a push touching Cargo.lock runs CI's exact argv in the clone", async () => {
  const { root, clone, stdin } = await makeRepo(CI_WITH_DENY, {
    "Cargo.lock": "version = 4\n",
  });
  try {
    const seen: Seen[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(seen, () => PASS),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(seen, [{ command: DENY_ARGV, cwd: clone }]);
    assertEquals(result.value.checksRun, [DENY_ARGV]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cargo deny: a push touching only src/main.rs never runs cargo deny", async () => {
  const { root, clone, stdin } = await makeRepo(CI_WITH_DENY, {
    "src/main.rs": 'fn main() { println!("hi"); }\n',
  });
  try {
    const seen: Seen[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(seen, () => PASS),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(denyCommands(seen), []);
    assertEquals(result.value.checksRun, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cargo deny: a verdict diagnostic is a failure that is not infrastructure", async () => {
  const { root, clone, stdin } = await makeRepo(CI_WITH_DENY, {
    "Cargo.lock": "version = 4\n",
  });
  try {
    const seen: Seen[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(seen, () => ({
        started: true,
        code: 1,
        stdout: "",
        stderr: VERDICT_OUTPUT,
      })),
    });
    assert(!result.ok);
    assert(!(result.error instanceof PrePushGateInfrastructureError));
    assertStringIncludes(result.error.message, "error[vulnerability]");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cargo deny: an advisory database that cannot be fetched is an infrastructure refusal, not a pass", async () => {
  const { root, clone, stdin } = await makeRepo(CI_WITH_DENY, {
    "Cargo.lock": "version = 4\n",
  });
  try {
    const seen: Seen[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(seen, () => ({
        started: true,
        code: 1,
        stdout: "",
        stderr: ADVISORY_UNREACHABLE_OUTPUT,
      })),
    });
    assert(!result.ok, "an unreachable advisory database must not pass");
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
    assertStringIncludes(
      result.error.message,
      "failed to fetch advisory database https://x/y",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cargo deny: a missing cargo-deny binary is an infrastructure refusal", async () => {
  const { root, clone, stdin } = await makeRepo(CI_WITH_DENY, {
    "Cargo.lock": "version = 4\n",
  });
  try {
    const seen: Seen[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(seen, () => ({
        started: false,
        code: -1,
        stdout: "",
        stderr: "",
      })),
    });
    assert(!result.ok, "a cargo-deny that never started must not pass");
    assertInstanceOf(result.error, PrePushGateInfrastructureError);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cargo deny: a repo whose CI never runs cargo deny runs nothing even when Cargo.toml changes", async () => {
  const { root, clone, stdin } = await makeRepo(CI_WITHOUT_DENY, {
    "Cargo.toml": '[package]\nname = "x"\n',
  });
  try {
    const seen: Seen[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(seen, () => PASS),
    });
    assert(result.ok, result.ok ? "" : result.error.message);
    assertEquals(denyCommands(seen), []);
    assertEquals(result.value.checksRun, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("cargo deny: a CI invocation with a workflow expression is a verdict naming the workflow", async () => {
  const { root, clone, stdin } = await makeRepo(CI_WITH_MATRIX_DENY, {
    "Cargo.lock": "version = 4\n",
  });
  try {
    const seen: Seen[] = [];
    const result = await runPrePushGate({
      cwd: clone,
      stdin,
      preFlightCommands: [],
      runner: recordingRunner(seen, () => PASS),
    });
    assert(!result.ok, "an unreproducible CI invocation must block the push");
    assert(!(result.error instanceof PrePushGateInfrastructureError));
    assertStringIncludes(result.error.message, ".github/workflows/ci.yml");
    assertStringIncludes(result.error.message, "cannot be reproduced locally");
    assertEquals(denyCommands(seen), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
