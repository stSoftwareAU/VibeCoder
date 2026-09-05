/**
 * A stub agent executable, addressed by path (Issue #959, part of #944).
 *
 * Twenty-seven test files used to write a shell script into a temp directory
 * and then prepend that directory to the process-wide `PATH`, so that
 * `new Deno.Command(provider.binary)` inside the runner resolved to the stub.
 * `PATH` is process-wide, so every one of them raced the rest of the suite
 * under `deno test --parallel` — the debt `parallel_safety_cap_test.ts` caps.
 *
 * The child environment was never the leak: `runClaudeWithTimeout` already
 * builds it explicitly (`clearEnv: true`, `provider.buildChildEnv()`). What
 * leaked was *binary resolution*. So this helper writes the stub and hands
 * back its absolute path, which the caller passes as `agentBinaryPath`:
 *
 * ```ts
 * await withAgentStub("printf 'hi\\n'", async (stub) => {
 *   await runClaudeWithTimeout({ prompt: "x", agentBinaryPath: stub.path });
 * });
 * ```
 *
 * It touches **no** process state: it neither writes an environment variable
 * nor moves the working directory. A helper that mutates taints every file
 * that imports it, which is how the cap test's list came to under-count by
 * more than half.
 *
 * The stub deliberately runs in the `deno test` process group, so a runner
 * watchdog signals its PID and descendants and never a process GROUP
 * (Issue #471; see the note in {@link file://../../../../CODING-STANDARDS.md}).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** A stub agent on disk, plus the temp directory holding it. */
export interface AgentStub {
  /**
   * Absolute path to the stub executable. Pass it as `agentBinaryPath` on
   * the `runClaudeWithTimeout`/`runClaudeWithRetry` options.
   */
  readonly path: string;
  /**
   * The temp directory holding the stub. Anywhere the stub writes evidence —
   * an argv log, a run counter — belongs in here, so cleanup takes it too.
   */
  readonly dir: string;
  /** Remove the directory and everything in it. Safe to call more than once. */
  dispose(): Promise<void>;
}

/** Options for {@link createAgentStub} and {@link withAgentStub}. */
export interface AgentStubOptions {
  /** Temp-directory prefix, so a leaked directory names the test that left it. */
  prefix?: string;
  /**
   * Basename of the stub executable.
   *
   * The default is deliberately **not** `claude`, and deliberately not a name
   * any real `PATH` carries: the runner is given this path explicitly, so if
   * production ever silently fell back to resolving the provider's binary on
   * `PATH`, the stub would not be what ran and the test would fail rather
   * than pass on the ambient agent.
   */
  name?: string;
}

/** Default basename — no `PATH` on any host resolves it. */
const DEFAULT_STUB_NAME = "vibe-agent-stub";

/**
 * Bash that blocks the stub until {@link releaseAgentStub} lets it through.
 *
 * The replacement for `sleep N` in the middle of a stub body. A stub that
 * sleeps hands the test no way of knowing when the agent reached the point
 * under test, so suites guessed — "two seconds should be enough" — and the
 * guess is what goes wrong on a loaded host. This blocks on a file instead:
 * the test drives its own clock, drives the watchdog, and only then releases
 * the agent, in that order and no other, whatever else the machine is doing.
 *
 * The poll is a real 50 ms sleep, so a busy host makes the wait longer and
 * never makes the answer different — and it is short enough that a stub the
 * runner kills mid-gate leaves nothing holding the stdout pipe for long.
 *
 * @param name - Gate name, for a stub that stops more than once.
 * @returns Bash, newline-terminated, to splice into a stub body.
 */
export function agentStubGate(name: string = "gate"): string {
  return `while [ ! -f "$0.${name}" ]; do sleep 0.05; done\n`;
}

/**
 * Let a stub blocked on {@link agentStubGate} run on.
 *
 * @param stub - The stub holding the gate.
 * @param name - The gate name passed to {@link agentStubGate}.
 */
export function releaseAgentStub(
  stub: AgentStub,
  name: string = "gate",
): Promise<void> {
  return Deno.writeTextFile(`${stub.path}.${name}`, "go\n");
}

/**
 * Write a stub agent to a fresh temp directory and return its path.
 *
 * @param body - The bash body of the stub, after the shebang.
 * @param options - Directory prefix and executable name.
 */
export async function createAgentStub(
  body: string,
  options: AgentStubOptions = {},
): Promise<AgentStub> {
  const dir = await Deno.makeTempDir({
    prefix: options.prefix ?? "vibe_agent_stub_",
  });
  const path = `${dir}/${options.name ?? DEFAULT_STUB_NAME}`;
  await Deno.writeTextFile(
    path,
    `#!/usr/bin/env bash\n${body.endsWith("\n") ? body : `${body}\n`}`,
  );
  await Deno.chmod(path, 0o755);
  return {
    path,
    dir,
    dispose: () => Deno.remove(dir, { recursive: true }).catch(() => {}),
  };
}

/**
 * Run `fn` with a stub agent, then clean it up however `fn` ends.
 *
 * @param body - The bash body of the stub, after the shebang.
 * @param fn - Receives the stub; pass `stub.path` as `agentBinaryPath`.
 * @param options - Directory prefix and executable name.
 */
export async function withAgentStub<T>(
  body: string,
  fn: (stub: AgentStub) => Promise<T>,
  options: AgentStubOptions = {},
): Promise<T> {
  const stub = await createAgentStub(body, options);
  try {
    return await fn(stub);
  } finally {
    await stub.dispose();
  }
}
