/**
 * Subprocess timeout utility for wrapping Deno.Command calls with
 * AbortController-based timeout protection (Issue #1168).
 *
 * Prevents indefinite hangs when subprocess calls (gh, git, df, etc.)
 * stall due to network issues, NFS mounts, or unresponsive services.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */ import { recordFaultEvent } from "./fault_tolerance_counters.ts";
import { getRunTimeline } from "./run_timeline.ts";
/** Default timeout for subprocess calls: 30 seconds. */ export const DEFAULT_SUBPROCESS_TIMEOUT_MS = 30_000;
/**
 * Milliseconds held back before the hard kill so wrap-up still runs
 * (Issue #4247). Past the finish deadline a spawn is clamped to this
 * reserve, not to the finish.
 */ export const HARD_KILL_WRAP_UP_RESERVE_MS = 300_000;
/** After SIGTERM, how long the child has to exit before the kill is given up. */ export const KILL_GRACE_MS = 5_000;
let chokepointNowForTests;
let killGraceMsForTests;
/** Pin the clock the deadline clamp reads. Tests only. */ export function _setChokepointNowForTests(now) {
  chokepointNowForTests = now;
}
/** Restore the real clock. Tests only. */ export function _resetChokepointNowForTests() {
  chokepointNowForTests = undefined;
}
/** Shorten the post-SIGTERM grace. Tests only. */ export function _setKillGraceMsForTests(ms) {
  killGraceMsForTests = ms;
}
/** Restore the production grace. Tests only. */ export function _resetKillGraceMsForTests() {
  killGraceMsForTests = undefined;
}
function chokepointNow() {
  return chokepointNowForTests ? chokepointNowForTests() : Date.now();
}
function currentKillGraceMs() {
  return killGraceMsForTests ?? KILL_GRACE_MS;
}
/** `git status` / `gh api user` — the name a refusal or kill log carries. */ export function subprocessCommandLabel(executable, args) {
  return args.length === 0 ? executable : `${executable} ${args.join(" ")}`;
}
/**
 * Whole seconds when the budget is a whole number of seconds, otherwise the
 * decimal. `1000` stays `1`, so an existing `timed out after 1s` line holds.
 */ export function formatTimeoutSeconds(ms) {
  const seconds = ms / 1000;
  return Number.isInteger(seconds) ? String(seconds) : String(seconds);
}
/**
 * Clamp a chokepoint budget to the run timeline (Issue #4247).
 *
 * With no timeline set, the budget is unchanged. Before the finish it is
 * capped at the time remaining. After the finish, when a hard kill is known,
 * it is capped at 300 s before that kill so wrap-up can still run. When no
 * hard kill is known, the requested budget is kept: nothing else can tell
 * wrap-up when to stop, and refusing the spawn would block the WIP push,
 * the claim release and the hooks. A result of 0 or less throws and names
 * `command`; the caller must not spawn.
 */ export function clampTimeoutToRunTimeline(requestedMs, command) {
  const timeline = getRunTimeline();
  if (timeline === undefined) return requestedMs;
  const now = chokepointNow();
  const limit = timeline.pastFinish(now) ? timeline.hardKillMs === null ? requestedMs : timeline.hardKillMs - HARD_KILL_WRAP_UP_RESERVE_MS - now : timeline.remainingToFinishMs(now);
  const allowed = Math.min(requestedMs, limit);
  if (!(allowed > 0)) {
    throw new Error(`refusing to spawn ${command}: no time left before the run deadline`);
  }
  return allowed;
}
/**
 * Wait for `child` to exit. Once `signal` aborts, SIGTERM is sent and the
 * wait is capped at the grace. A child still alive is logged and the wait
 * ends; it is not left running until it chooses to finish (Issue #4247).
 */ export async function waitForChildExit(child, signal, command) {
  const grace = currentKillGraceMs();
  let graceTimer;
  let removeAbort = ()=>{};
  const outputPromise = child.output().then((output)=>({
      kind: "output",
      output
    }), (error)=>{
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        kind: "aborted"
      };
    }
    throw error;
  });
  const giveUp = new Promise((resolve)=>{
    const arm = ()=>{
      try {
        child.kill("SIGTERM");
      } catch  {
      // The child has already exited.
      }
      graceTimer = setTimeout(()=>{
        console.error(`kill of ${command} did not complete within ${grace / 1000}s`);
        try {
          child.kill("SIGKILL");
        } catch  {
        // The child has already exited.
        }
        resolve({
          kind: "kill-incomplete"
        });
      }, grace);
    };
    if (signal.aborted) {
      arm();
      return;
    }
    signal.addEventListener("abort", arm, {
      once: true
    });
    removeAbort = ()=>signal.removeEventListener("abort", arm);
  });
  try {
    const outcome = await Promise.race([
      outputPromise,
      giveUp
    ]);
    if (outcome.kind === "kill-incomplete") {
      // SIGKILL has been sent. Reap if it exits promptly; never block on a
      // child that is still alive after the grace.
      await reapAfterKill(child);
    }
    return outcome;
  } finally{
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    removeAbort();
  }
}
/** Bound the post-SIGKILL reap so a stuck child cannot hold the caller. */ async function reapAfterKill(child) {
  let timer;
  const cap = new Promise((resolve)=>{
    timer = setTimeout(resolve, 1_000);
  });
  await Promise.race([
    child.status.then(()=>{}, ()=>{}),
    cap
  ]);
  if (timer !== undefined) clearTimeout(timer);
}
/** Extended timeout for network-heavy operations: 60 seconds. */ export const EXTENDED_SUBPROCESS_TIMEOUT_MS = 60_000;
/**
 * Run a subprocess with timeout protection.
 *
 * Wraps Deno.Command with an AbortController that fires after the
 * specified timeout. If the process exceeds the timeout, it is
 * killed and the result indicates a timeout occurred.
 *
 * @param executable - The command to run (e.g., "gh", "git", "df").
 * @param args - Command-line arguments.
 * @param options - Settings. `timeoutMs` is required. Also cwd, quiet mode
 *   and environment.
 *   `quiet` suppresses stdout only — stderr is always piped and captured so
 *   failure diagnostics survive (Issue #1979). `clearEnv` starts the child
 *   from an empty environment so only `env` reaches it — the callback
 *   contract's credential boundary (Issue #806).
 * @returns Result containing the subprocess output or an error.
 */ export async function runWithTimeout(executable, args, options) {
  const requestedMs = options.timeoutMs;
  // A caller-supplied non-positive budget is today's timeout result. The
  // deadline clamp below is what refuses a positive budget that shrinks to
  // nothing (Issue #4247). A timeout stays a failure: success is false.
  if (!(requestedMs > 0)) {
    return {
      ok: true,
      value: {
        success: false,
        code: 124,
        stdout: "",
        stderr: `Timed out after ${requestedMs}ms`,
        timedOut: true
      }
    };
  }
  const commandLabel = subprocessCommandLabel(executable, args);
  const timeoutMs = clampTimeoutToRunTimeline(requestedMs, commandLabel);
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    // Use spawn() so we hold the ChildProcess handle and can kill it
    // explicitly on timeout. The `signal` option alone does not reliably
    // terminate a running process on all platforms.
    const command = new Deno.Command(executable, {
      args,
      cwd: options?.cwd,
      ...options?.env ? {
        env: options.env
      } : {},
      ...options?.clearEnv ? {
        clearEnv: true
      } : {},
      stdin: options?.stdin === undefined ? "null" : "piped",
      stdout: options?.quiet ? "null" : "piped",
      // stderr is always piped + captured. Muting stderr at the OS
      // level discards exit-trap diagnostics from helper scripts
      // (e.g. a repository's quality gate), producing empty-tail "Command
      // failed with code 1: " messages that defeat operator
      // troubleshooting (Issue #1979).
      stderr: "piped"
    });
    const child = command.spawn();
    // The write starts now and runs beside the wait; it is awaited below.
    const stdinDone = options?.stdin === undefined ? undefined : writeChildStdin(child, options.stdin);
    // A timed-out call returns without awaiting the write, so a failure there
    // must not surface as an unhandled rejection.
    stdinDone?.catch(()=>{});
    const outcome = await waitForChildExit(child, controller.signal, commandLabel);
    // Drop the timer before reading the signal, so a command that has already
    // finished is not reported as a timeout.
    clearTimeout(timer);
    if (outcome.kind === "kill-incomplete" || controller.signal.aborted) {
      recordFaultEvent("timeout", `Subprocess timed out after ${timeoutMs}ms: ${commandLabel}`);
      const decode = (bytes)=>bytes ? new TextDecoder().decode(bytes).trim() : "";
      const timedOutStderr = `Timed out after ${timeoutMs}ms`;
      const captured = outcome.kind === "output" && options?.captureOutputOnTimeout ? decode(outcome.output.stderr) : "";
      return {
        ok: true,
        value: {
          success: false,
          code: 124,
          stdout: outcome.kind === "output" && options?.captureOutputOnTimeout ? decode(outcome.output.stdout) : "",
          stderr: captured ? `${timedOutStderr}\n${captured}` : timedOutStderr,
          timedOut: true
        }
      };
    }
    if (outcome.kind !== "output") {
      recordFaultEvent("timeout", `Subprocess timed out after ${timeoutMs}ms: ${commandLabel}`);
      return {
        ok: true,
        value: {
          success: false,
          code: 124,
          stdout: "",
          stderr: `Timed out after ${timeoutMs}ms`,
          timedOut: true
        }
      };
    }
    if (stdinDone) await stdinDone;
    const output = outcome.output;
    return {
      ok: true,
      value: {
        success: output.success,
        code: output.code,
        stdout: options?.quiet ? "" : output.stdout ? new TextDecoder().decode(output.stdout).trim() : "",
        // stderr is always returned regardless of quiet — see comment above.
        stderr: output.stderr ? new TextDecoder().decode(output.stderr).trim() : "",
        timedOut: false
      }
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      recordFaultEvent("timeout", `Subprocess timed out after ${timeoutMs}ms: ${commandLabel}`);
      return {
        ok: true,
        value: {
          success: false,
          code: 124,
          stdout: "",
          stderr: `Timed out after ${timeoutMs}ms`,
          timedOut: true
        }
      };
    }
    return {
      ok: false,
      error: error instanceof Error ? error : new Error(String(error))
    };
  } finally{
    clearTimeout(timer);
  }
}
/** True when `error` is a timeout raised by {@link commandOutputWithTimeout}. */ export function isCommandTimeoutError(error) {
  return error instanceof Error && error.message.includes("timed out after");
}
/** After a timeout, how long the child has to exit on SIGTERM before SIGKILL. */ const TIMEOUT_KILL_GRACE_MS = 5_000;
/**
 * Write `text` to a spawned child's stdin, then close it (Issue #4705).
 *
 * A `BrokenPipe` is the child exiting before it read everything: its exit
 * status and stderr carry the cause, and a wrapper that expects more input
 * reports the short stream itself. Only that error is swallowed; any other
 * failure is rethrown. The text is never logged.
 */ async function writeChildStdin(child, text) {
  const writer = child.stdin.getWriter();
  try {
    await writer.write(new TextEncoder().encode(text));
    await writer.close();
  } catch (error) {
    if (error instanceof Deno.errors.BrokenPipe) return;
    throw error;
  }
}
/** Read `reader` to its end. A cancelled reader ends early, keeping its bytes. */ async function drainReader(reader) {
  const chunks = [];
  let length = 0;
  for(;;){
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks){
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
/**
 * Run `Deno.Command` and reject when it exceeds `timeoutMs`.
 *
 * A timeout of zero or less fails immediately and does not spawn. The thrown
 * error names the executable. Callers report that error as a timeout or a
 * failure; they do not turn it into a successful result.
 *
 * The bound holds even when the child leaves a grandchild behind: at the
 * timeout the pipes are cancelled rather than read to EOF, because a
 * grandchild that inherited them would otherwise keep `output()` waiting
 * for as long as it lives. A child that ignores SIGTERM gets SIGKILL after
 * a short grace.
 */ export async function commandOutputWithTimeout(executable, options) {
  const { timeoutMs, stdinText, ...commandOptions } = options;
  if (!(timeoutMs > 0)) {
    throw new Error(`${executable} timed out after ${timeoutMs}ms`);
  }
  // `output()` pipes stdout and stderr unless told otherwise; `spawn()` does
  // not, so the defaults are restated here.
  const stdoutMode = commandOptions.stdout ?? "piped";
  const stderrMode = commandOptions.stderr ?? "piped";
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  let killTimer;
  const readers = [];
  const onAbort = ()=>{
    for (const reader of readers)reader.cancel().catch(()=>{});
    killTimer = setTimeout(()=>{
      try {
        child?.kill("SIGKILL");
      } catch  {}
    }, TIMEOUT_KILL_GRACE_MS);
  };
  let child;
  try {
    child = new Deno.Command(executable, {
      ...commandOptions,
      ...stdinText === undefined ? {} : {
        stdin: "piped"
      },
      stdout: stdoutMode,
      stderr: stderrMode,
      signal: controller.signal
    }).spawn();
    // The write starts now and runs beside the collection; it is awaited
    // after the child exits, and only on the success path (Issue #4705).
    const stdinDone = stdinText === undefined ? undefined : writeChildStdin(child, stdinText);
    // A timed-out call throws without awaiting the write, so a failure there
    // must not surface as an unhandled rejection.
    stdinDone?.catch(()=>{});
    const empty = Promise.resolve(new Uint8Array(0));
    const collect = (stream)=>{
      const reader = stream.getReader();
      readers.push(reader);
      return drainReader(reader);
    };
    const stdoutBytes = stdoutMode === "piped" ? collect(child.stdout) : empty;
    const stderrBytes = stderrMode === "piped" ? collect(child.stderr) : empty;
    controller.signal.addEventListener("abort", onAbort, {
      once: true
    });
    const [status, stdout, stderr] = await Promise.all([
      child.status,
      stdoutBytes,
      stderrBytes
    ]);
    if (controller.signal.aborted) {
      throw new Error(`${executable} timed out after ${timeoutMs}ms`);
    }
    if (stdinDone) await stdinDone;
    return {
      ...status,
      stdout,
      stderr
    };
  } catch (error) {
    if (controller.signal.aborted || error instanceof DOMException && error.name === "AbortError") {
      recordFaultEvent("timeout", `Subprocess timed out after ${timeoutMs}ms: ${executable}`);
      throw new Error(`${executable} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally{
    clearTimeout(timer);
    clearTimeout(killTimer);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
/** A non-git, non-gh argv. Minutes. A timeout throws; it is not a zero exit. */ export const DIRECT_COMMAND_TIMEOUT_MS = 30 * 60 * 1000;
/**
 * Run an argv to completion with trimmed text output (Issue #4251).
 *
 * The non-git, non-gh branch of the injectable `RunCommand` seams. A
 * supplied `env` is passed as is: callers that overlay the parent's
 * environment build that overlay themselves.
 */ export async function runDirectCommand(cmd, timeoutMs = DIRECT_COMMAND_TIMEOUT_MS, env) {
  const output = await commandOutputWithTimeout(cmd[0] ?? "", {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
    ...env ? {
      env
    } : {},
    timeoutMs
  });
  const decoder = new TextDecoder();
  return {
    success: output.success,
    stdout: decoder.decode(output.stdout).trim(),
    stderr: decoder.decode(output.stderr).trim()
  };
}
/**
 * Spawn a streaming child that is signalled when `timeoutMs` elapses.
 *
 * A timeout of zero or less throws and does not spawn. The timer is cleared
 * when the child exits, so a finished process is not signalled later.
 */ export function spawnCommandWithTimeout(executable, options) {
  const { timeoutMs, ...commandOptions } = options;
  if (!(timeoutMs > 0)) {
    throw new Error(`${executable} timed out after ${timeoutMs}ms`);
  }
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  try {
    const child = new Deno.Command(executable, {
      ...commandOptions,
      signal: controller.signal
    }).spawn();
    child.status.finally(()=>clearTimeout(timer));
    return child;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
}
/**
 * Run a fetch request with timeout protection.
 *
 * Wraps a fetch call with an AbortController that fires after the
 * specified timeout. Useful for API calls that may hang.
 *
 * @param url - The URL to fetch.
 * @param init - Standard fetch RequestInit options.
 * @param timeoutMs - Timeout in milliseconds (default: 30 seconds).
 * @returns The fetch Response.
 * @throws Error on timeout or network failure.
 */ export async function fetchWithTimeout(url, init, timeoutMs = DEFAULT_SUBPROCESS_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), timeoutMs);
  const mergedInit = {
    ...init,
    signal: controller.signal
  };
  try {
    const response = await fetch(url, mergedInit);
    clearTimeout(timer);
    return response;
  } catch (error) {
    clearTimeout(timer);
    if (error instanceof DOMException && error.name === "AbortError") {
      recordFaultEvent("timeout", `Fetch timed out after ${timeoutMs}ms: ${url}`);
      throw new Error(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zdWJwcm9jZXNzX3RpbWVvdXQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBTdWJwcm9jZXNzIHRpbWVvdXQgdXRpbGl0eSBmb3Igd3JhcHBpbmcgRGVuby5Db21tYW5kIGNhbGxzIHdpdGhcbiAqIEFib3J0Q29udHJvbGxlci1iYXNlZCB0aW1lb3V0IHByb3RlY3Rpb24gKElzc3VlICMxMTY4KS5cbiAqXG4gKiBQcmV2ZW50cyBpbmRlZmluaXRlIGhhbmdzIHdoZW4gc3VicHJvY2VzcyBjYWxscyAoZ2gsIGdpdCwgZGYsIGV0Yy4pXG4gKiBzdGFsbCBkdWUgdG8gbmV0d29yayBpc3N1ZXMsIE5GUyBtb3VudHMsIG9yIHVucmVzcG9uc2l2ZSBzZXJ2aWNlcy5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgcmVjb3JkRmF1bHRFdmVudCB9IGZyb20gXCIuL2ZhdWx0X3RvbGVyYW5jZV9jb3VudGVycy50c1wiO1xuaW1wb3J0IHsgZ2V0UnVuVGltZWxpbmUgfSBmcm9tIFwiLi9ydW5fdGltZWxpbmUudHNcIjtcblxuLyoqIERlZmF1bHQgdGltZW91dCBmb3Igc3VicHJvY2VzcyBjYWxsczogMzAgc2Vjb25kcy4gKi9cbmV4cG9ydCBjb25zdCBERUZBVUxUX1NVQlBST0NFU1NfVElNRU9VVF9NUyA9IDMwXzAwMDtcblxuLyoqXG4gKiBNaWxsaXNlY29uZHMgaGVsZCBiYWNrIGJlZm9yZSB0aGUgaGFyZCBraWxsIHNvIHdyYXAtdXAgc3RpbGwgcnVuc1xuICogKElzc3VlICM0MjQ3KS4gUGFzdCB0aGUgZmluaXNoIGRlYWRsaW5lIGEgc3Bhd24gaXMgY2xhbXBlZCB0byB0aGlzXG4gKiByZXNlcnZlLCBub3QgdG8gdGhlIGZpbmlzaC5cbiAqL1xuZXhwb3J0IGNvbnN0IEhBUkRfS0lMTF9XUkFQX1VQX1JFU0VSVkVfTVMgPSAzMDBfMDAwO1xuXG4vKiogQWZ0ZXIgU0lHVEVSTSwgaG93IGxvbmcgdGhlIGNoaWxkIGhhcyB0byBleGl0IGJlZm9yZSB0aGUga2lsbCBpcyBnaXZlbiB1cC4gKi9cbmV4cG9ydCBjb25zdCBLSUxMX0dSQUNFX01TID0gNV8wMDA7XG5cbmxldCBjaG9rZXBvaW50Tm93Rm9yVGVzdHM6ICgoKSA9PiBudW1iZXIpIHwgdW5kZWZpbmVkO1xubGV0IGtpbGxHcmFjZU1zRm9yVGVzdHM6IG51bWJlciB8IHVuZGVmaW5lZDtcblxuLyoqIFBpbiB0aGUgY2xvY2sgdGhlIGRlYWRsaW5lIGNsYW1wIHJlYWRzLiBUZXN0cyBvbmx5LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIF9zZXRDaG9rZXBvaW50Tm93Rm9yVGVzdHMobm93OiAoKSA9PiBudW1iZXIpOiB2b2lkIHtcbiAgY2hva2Vwb2ludE5vd0ZvclRlc3RzID0gbm93O1xufVxuXG4vKiogUmVzdG9yZSB0aGUgcmVhbCBjbG9jay4gVGVzdHMgb25seS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfcmVzZXRDaG9rZXBvaW50Tm93Rm9yVGVzdHMoKTogdm9pZCB7XG4gIGNob2tlcG9pbnROb3dGb3JUZXN0cyA9IHVuZGVmaW5lZDtcbn1cblxuLyoqIFNob3J0ZW4gdGhlIHBvc3QtU0lHVEVSTSBncmFjZS4gVGVzdHMgb25seS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBfc2V0S2lsbEdyYWNlTXNGb3JUZXN0cyhtczogbnVtYmVyKTogdm9pZCB7XG4gIGtpbGxHcmFjZU1zRm9yVGVzdHMgPSBtcztcbn1cblxuLyoqIFJlc3RvcmUgdGhlIHByb2R1Y3Rpb24gZ3JhY2UuIFRlc3RzIG9ubHkuICovXG5leHBvcnQgZnVuY3Rpb24gX3Jlc2V0S2lsbEdyYWNlTXNGb3JUZXN0cygpOiB2b2lkIHtcbiAga2lsbEdyYWNlTXNGb3JUZXN0cyA9IHVuZGVmaW5lZDtcbn1cblxuZnVuY3Rpb24gY2hva2Vwb2ludE5vdygpOiBudW1iZXIge1xuICByZXR1cm4gY2hva2Vwb2ludE5vd0ZvclRlc3RzID8gY2hva2Vwb2ludE5vd0ZvclRlc3RzKCkgOiBEYXRlLm5vdygpO1xufVxuXG5mdW5jdGlvbiBjdXJyZW50S2lsbEdyYWNlTXMoKTogbnVtYmVyIHtcbiAgcmV0dXJuIGtpbGxHcmFjZU1zRm9yVGVzdHMgPz8gS0lMTF9HUkFDRV9NUztcbn1cblxuLyoqIGBnaXQgc3RhdHVzYCAvIGBnaCBhcGkgdXNlcmAg4oCUIHRoZSBuYW1lIGEgcmVmdXNhbCBvciBraWxsIGxvZyBjYXJyaWVzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHN1YnByb2Nlc3NDb21tYW5kTGFiZWwoXG4gIGV4ZWN1dGFibGU6IHN0cmluZyxcbiAgYXJnczogcmVhZG9ubHkgc3RyaW5nW10sXG4pOiBzdHJpbmcge1xuICByZXR1cm4gYXJncy5sZW5ndGggPT09IDAgPyBleGVjdXRhYmxlIDogYCR7ZXhlY3V0YWJsZX0gJHthcmdzLmpvaW4oXCIgXCIpfWA7XG59XG5cbi8qKlxuICogV2hvbGUgc2Vjb25kcyB3aGVuIHRoZSBidWRnZXQgaXMgYSB3aG9sZSBudW1iZXIgb2Ygc2Vjb25kcywgb3RoZXJ3aXNlIHRoZVxuICogZGVjaW1hbC4gYDEwMDBgIHN0YXlzIGAxYCwgc28gYW4gZXhpc3RpbmcgYHRpbWVkIG91dCBhZnRlciAxc2AgbGluZSBob2xkcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdFRpbWVvdXRTZWNvbmRzKG1zOiBudW1iZXIpOiBzdHJpbmcge1xuICBjb25zdCBzZWNvbmRzID0gbXMgLyAxMDAwO1xuICByZXR1cm4gTnVtYmVyLmlzSW50ZWdlcihzZWNvbmRzKSA/IFN0cmluZyhzZWNvbmRzKSA6IFN0cmluZyhzZWNvbmRzKTtcbn1cblxuLyoqXG4gKiBDbGFtcCBhIGNob2tlcG9pbnQgYnVkZ2V0IHRvIHRoZSBydW4gdGltZWxpbmUgKElzc3VlICM0MjQ3KS5cbiAqXG4gKiBXaXRoIG5vIHRpbWVsaW5lIHNldCwgdGhlIGJ1ZGdldCBpcyB1bmNoYW5nZWQuIEJlZm9yZSB0aGUgZmluaXNoIGl0IGlzXG4gKiBjYXBwZWQgYXQgdGhlIHRpbWUgcmVtYWluaW5nLiBBZnRlciB0aGUgZmluaXNoLCB3aGVuIGEgaGFyZCBraWxsIGlzIGtub3duLFxuICogaXQgaXMgY2FwcGVkIGF0IDMwMCBzIGJlZm9yZSB0aGF0IGtpbGwgc28gd3JhcC11cCBjYW4gc3RpbGwgcnVuLiBXaGVuIG5vXG4gKiBoYXJkIGtpbGwgaXMga25vd24sIHRoZSByZXF1ZXN0ZWQgYnVkZ2V0IGlzIGtlcHQ6IG5vdGhpbmcgZWxzZSBjYW4gdGVsbFxuICogd3JhcC11cCB3aGVuIHRvIHN0b3AsIGFuZCByZWZ1c2luZyB0aGUgc3Bhd24gd291bGQgYmxvY2sgdGhlIFdJUCBwdXNoLFxuICogdGhlIGNsYWltIHJlbGVhc2UgYW5kIHRoZSBob29rcy4gQSByZXN1bHQgb2YgMCBvciBsZXNzIHRocm93cyBhbmQgbmFtZXNcbiAqIGBjb21tYW5kYDsgdGhlIGNhbGxlciBtdXN0IG5vdCBzcGF3bi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsYW1wVGltZW91dFRvUnVuVGltZWxpbmUoXG4gIHJlcXVlc3RlZE1zOiBudW1iZXIsXG4gIGNvbW1hbmQ6IHN0cmluZyxcbik6IG51bWJlciB7XG4gIGNvbnN0IHRpbWVsaW5lID0gZ2V0UnVuVGltZWxpbmUoKTtcbiAgaWYgKHRpbWVsaW5lID09PSB1bmRlZmluZWQpIHJldHVybiByZXF1ZXN0ZWRNcztcblxuICBjb25zdCBub3cgPSBjaG9rZXBvaW50Tm93KCk7XG4gIGNvbnN0IGxpbWl0ID0gdGltZWxpbmUucGFzdEZpbmlzaChub3cpXG4gICAgPyB0aW1lbGluZS5oYXJkS2lsbE1zID09PSBudWxsXG4gICAgICA/IHJlcXVlc3RlZE1zXG4gICAgICA6IHRpbWVsaW5lLmhhcmRLaWxsTXMgLSBIQVJEX0tJTExfV1JBUF9VUF9SRVNFUlZFX01TIC0gbm93XG4gICAgOiB0aW1lbGluZS5yZW1haW5pbmdUb0ZpbmlzaE1zKG5vdyk7XG4gIGNvbnN0IGFsbG93ZWQgPSBNYXRoLm1pbihyZXF1ZXN0ZWRNcywgbGltaXQpO1xuICBpZiAoIShhbGxvd2VkID4gMCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgcmVmdXNpbmcgdG8gc3Bhd24gJHtjb21tYW5kfTogbm8gdGltZSBsZWZ0IGJlZm9yZSB0aGUgcnVuIGRlYWRsaW5lYCxcbiAgICApO1xuICB9XG4gIHJldHVybiBhbGxvd2VkO1xufVxuXG4vKiogV2hhdCB7QGxpbmsgd2FpdEZvckNoaWxkRXhpdH0gb2JzZXJ2ZWQuICovXG5leHBvcnQgdHlwZSBDaGlsZEV4aXRPdXRjb21lID1cbiAgfCB7IGtpbmQ6IFwib3V0cHV0XCI7IG91dHB1dDogRGVuby5Db21tYW5kT3V0cHV0IH1cbiAgfCB7IGtpbmQ6IFwiYWJvcnRlZFwiIH1cbiAgfCB7IGtpbmQ6IFwia2lsbC1pbmNvbXBsZXRlXCIgfTtcblxuLyoqXG4gKiBXYWl0IGZvciBgY2hpbGRgIHRvIGV4aXQuIE9uY2UgYHNpZ25hbGAgYWJvcnRzLCBTSUdURVJNIGlzIHNlbnQgYW5kIHRoZVxuICogd2FpdCBpcyBjYXBwZWQgYXQgdGhlIGdyYWNlLiBBIGNoaWxkIHN0aWxsIGFsaXZlIGlzIGxvZ2dlZCBhbmQgdGhlIHdhaXRcbiAqIGVuZHM7IGl0IGlzIG5vdCBsZWZ0IHJ1bm5pbmcgdW50aWwgaXQgY2hvb3NlcyB0byBmaW5pc2ggKElzc3VlICM0MjQ3KS5cbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHdhaXRGb3JDaGlsZEV4aXQoXG4gIGNoaWxkOiBEZW5vLkNoaWxkUHJvY2VzcyxcbiAgc2lnbmFsOiBBYm9ydFNpZ25hbCxcbiAgY29tbWFuZDogc3RyaW5nLFxuKTogUHJvbWlzZTxDaGlsZEV4aXRPdXRjb21lPiB7XG4gIGNvbnN0IGdyYWNlID0gY3VycmVudEtpbGxHcmFjZU1zKCk7XG4gIGxldCBncmFjZVRpbWVyOiBSZXR1cm5UeXBlPHR5cGVvZiBzZXRUaW1lb3V0PiB8IHVuZGVmaW5lZDtcbiAgbGV0IHJlbW92ZUFib3J0ID0gKCkgPT4ge307XG5cbiAgY29uc3Qgb3V0cHV0UHJvbWlzZSA9IGNoaWxkLm91dHB1dCgpLnRoZW4oXG4gICAgKG91dHB1dCkgPT4gKHsga2luZDogXCJvdXRwdXRcIiBhcyBjb25zdCwgb3V0cHV0IH0pLFxuICAgIChlcnJvcjogdW5rbm93bikgPT4ge1xuICAgICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRE9NRXhjZXB0aW9uICYmIGVycm9yLm5hbWUgPT09IFwiQWJvcnRFcnJvclwiKSB7XG4gICAgICAgIHJldHVybiB7IGtpbmQ6IFwiYWJvcnRlZFwiIGFzIGNvbnN0IH07XG4gICAgICB9XG4gICAgICB0aHJvdyBlcnJvcjtcbiAgICB9LFxuICApO1xuXG4gIGNvbnN0IGdpdmVVcCA9IG5ldyBQcm9taXNlPHsga2luZDogXCJraWxsLWluY29tcGxldGVcIiB9PigocmVzb2x2ZSkgPT4ge1xuICAgIGNvbnN0IGFybSA9ICgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNoaWxkLmtpbGwoXCJTSUdURVJNXCIpO1xuICAgICAgfSBjYXRjaCB7XG4gICAgICAgIC8vIFRoZSBjaGlsZCBoYXMgYWxyZWFkeSBleGl0ZWQuXG4gICAgICB9XG4gICAgICBncmFjZVRpbWVyID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICAgIGNvbnNvbGUuZXJyb3IoXG4gICAgICAgICAgYGtpbGwgb2YgJHtjb21tYW5kfSBkaWQgbm90IGNvbXBsZXRlIHdpdGhpbiAke2dyYWNlIC8gMTAwMH1zYCxcbiAgICAgICAgKTtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICBjaGlsZC5raWxsKFwiU0lHS0lMTFwiKTtcbiAgICAgICAgfSBjYXRjaCB7XG4gICAgICAgICAgLy8gVGhlIGNoaWxkIGhhcyBhbHJlYWR5IGV4aXRlZC5cbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlKHsga2luZDogXCJraWxsLWluY29tcGxldGVcIiB9KTtcbiAgICAgIH0sIGdyYWNlKTtcbiAgICB9O1xuICAgIGlmIChzaWduYWwuYWJvcnRlZCkge1xuICAgICAgYXJtKCk7XG4gICAgICByZXR1cm47XG4gICAgfVxuICAgIHNpZ25hbC5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgYXJtLCB7IG9uY2U6IHRydWUgfSk7XG4gICAgcmVtb3ZlQWJvcnQgPSAoKSA9PiBzaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIGFybSk7XG4gIH0pO1xuXG4gIHRyeSB7XG4gICAgY29uc3Qgb3V0Y29tZSA9IGF3YWl0IFByb21pc2UucmFjZShbb3V0cHV0UHJvbWlzZSwgZ2l2ZVVwXSk7XG4gICAgaWYgKG91dGNvbWUua2luZCA9PT0gXCJraWxsLWluY29tcGxldGVcIikge1xuICAgICAgLy8gU0lHS0lMTCBoYXMgYmVlbiBzZW50LiBSZWFwIGlmIGl0IGV4aXRzIHByb21wdGx5OyBuZXZlciBibG9jayBvbiBhXG4gICAgICAvLyBjaGlsZCB0aGF0IGlzIHN0aWxsIGFsaXZlIGFmdGVyIHRoZSBncmFjZS5cbiAgICAgIGF3YWl0IHJlYXBBZnRlcktpbGwoY2hpbGQpO1xuICAgIH1cbiAgICByZXR1cm4gb3V0Y29tZTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAoZ3JhY2VUaW1lciAhPT0gdW5kZWZpbmVkKSBjbGVhclRpbWVvdXQoZ3JhY2VUaW1lcik7XG4gICAgcmVtb3ZlQWJvcnQoKTtcbiAgfVxufVxuXG4vKiogQm91bmQgdGhlIHBvc3QtU0lHS0lMTCByZWFwIHNvIGEgc3R1Y2sgY2hpbGQgY2Fubm90IGhvbGQgdGhlIGNhbGxlci4gKi9cbmFzeW5jIGZ1bmN0aW9uIHJlYXBBZnRlcktpbGwoY2hpbGQ6IERlbm8uQ2hpbGRQcm9jZXNzKTogUHJvbWlzZTx2b2lkPiB7XG4gIGxldCB0aW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IGNhcCA9IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XG4gICAgdGltZXIgPSBzZXRUaW1lb3V0KHJlc29sdmUsIDFfMDAwKTtcbiAgfSk7XG4gIGF3YWl0IFByb21pc2UucmFjZShbXG4gICAgY2hpbGQuc3RhdHVzLnRoZW4oKCkgPT4ge30sICgpID0+IHt9KSxcbiAgICBjYXAsXG4gIF0pO1xuICBpZiAodGltZXIgIT09IHVuZGVmaW5lZCkgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbn1cblxuLyoqIEV4dGVuZGVkIHRpbWVvdXQgZm9yIG5ldHdvcmstaGVhdnkgb3BlcmF0aW9uczogNjAgc2Vjb25kcy4gKi9cbmV4cG9ydCBjb25zdCBFWFRFTkRFRF9TVUJQUk9DRVNTX1RJTUVPVVRfTVMgPSA2MF8wMDA7XG5cbi8qKiBSZXN1bHQgb2YgYSBzdWJwcm9jZXNzIGV4ZWN1dGlvbi4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU3VicHJvY2Vzc1Jlc3VsdCB7XG4gIC8qKiBXaGV0aGVyIHRoZSBjb21tYW5kIGNvbXBsZXRlZCBzdWNjZXNzZnVsbHkgKGV4aXQgY29kZSAwKS4gKi9cbiAgc3VjY2VzczogYm9vbGVhbjtcbiAgLyoqIFRoZSByYXcgZXhpdCBjb2RlLiAqL1xuICBjb2RlOiBudW1iZXI7XG4gIC8qKiBEZWNvZGVkIHN0ZG91dCBjb250ZW50LiAqL1xuICBzdGRvdXQ6IHN0cmluZztcbiAgLyoqIERlY29kZWQgc3RkZXJyIGNvbnRlbnQuICovXG4gIHN0ZGVycjogc3RyaW5nO1xuICAvKiogV2hldGhlciB0aGUgY29tbWFuZCB3YXMgdGVybWluYXRlZCBkdWUgdG8gdGltZW91dC4gKi9cbiAgdGltZWRPdXQ6IGJvb2xlYW47XG59XG5cbi8qKlxuICogUnVuIGEgc3VicHJvY2VzcyB3aXRoIHRpbWVvdXQgcHJvdGVjdGlvbi5cbiAqXG4gKiBXcmFwcyBEZW5vLkNvbW1hbmQgd2l0aCBhbiBBYm9ydENvbnRyb2xsZXIgdGhhdCBmaXJlcyBhZnRlciB0aGVcbiAqIHNwZWNpZmllZCB0aW1lb3V0LiBJZiB0aGUgcHJvY2VzcyBleGNlZWRzIHRoZSB0aW1lb3V0LCBpdCBpc1xuICoga2lsbGVkIGFuZCB0aGUgcmVzdWx0IGluZGljYXRlcyBhIHRpbWVvdXQgb2NjdXJyZWQuXG4gKlxuICogQHBhcmFtIGV4ZWN1dGFibGUgLSBUaGUgY29tbWFuZCB0byBydW4gKGUuZy4sIFwiZ2hcIiwgXCJnaXRcIiwgXCJkZlwiKS5cbiAqIEBwYXJhbSBhcmdzIC0gQ29tbWFuZC1saW5lIGFyZ3VtZW50cy5cbiAqIEBwYXJhbSBvcHRpb25zIC0gU2V0dGluZ3MuIGB0aW1lb3V0TXNgIGlzIHJlcXVpcmVkLiBBbHNvIGN3ZCwgcXVpZXQgbW9kZVxuICogICBhbmQgZW52aXJvbm1lbnQuXG4gKiAgIGBxdWlldGAgc3VwcHJlc3NlcyBzdGRvdXQgb25seSDigJQgc3RkZXJyIGlzIGFsd2F5cyBwaXBlZCBhbmQgY2FwdHVyZWQgc29cbiAqICAgZmFpbHVyZSBkaWFnbm9zdGljcyBzdXJ2aXZlIChJc3N1ZSAjMTk3OSkuIGBjbGVhckVudmAgc3RhcnRzIHRoZSBjaGlsZFxuICogICBmcm9tIGFuIGVtcHR5IGVudmlyb25tZW50IHNvIG9ubHkgYGVudmAgcmVhY2hlcyBpdCDigJQgdGhlIGNhbGxiYWNrXG4gKiAgIGNvbnRyYWN0J3MgY3JlZGVudGlhbCBib3VuZGFyeSAoSXNzdWUgIzgwNikuXG4gKiBAcmV0dXJucyBSZXN1bHQgY29udGFpbmluZyB0aGUgc3VicHJvY2VzcyBvdXRwdXQgb3IgYW4gZXJyb3IuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5XaXRoVGltZW91dChcbiAgZXhlY3V0YWJsZTogc3RyaW5nLFxuICBhcmdzOiBzdHJpbmdbXSxcbiAgb3B0aW9uczoge1xuICAgIGN3ZD86IHN0cmluZztcbiAgICB0aW1lb3V0TXM6IG51bWJlcjtcbiAgICBxdWlldD86IGJvb2xlYW47XG4gICAgLyoqIEVudmlyb25tZW50IGVudHJpZXMgdG8gc2V0IG9uIHRoZSBjaGlsZC4gKi9cbiAgICBlbnY/OiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+O1xuICAgIC8qKiBTdGFydCBmcm9tIGFuIGVtcHR5IGVudmlyb25tZW50IHJhdGhlciB0aGFuIGluaGVyaXRpbmcgdGhlIHdvcmtlcidzLiAqL1xuICAgIGNsZWFyRW52PzogYm9vbGVhbjtcbiAgICAvKipcbiAgICAgKiBUZXh0IHdyaXR0ZW4gdG8gdGhlIGNoaWxkJ3Mgc3RkaW4sIHRoZW4gY2xvc2VkIChJc3N1ZSAjNDcwNSkuIE9taXR0ZWQsXG4gICAgICogdGhlIGNoaWxkJ3Mgc3RkaW4gaXMgL2Rldi9udWxsLCBhcyBpdCBhbHdheXMgd2FzLiBBIGNoaWxkIHRoYXQgZXhpdHNcbiAgICAgKiBiZWZvcmUgcmVhZGluZyB0aGUgdGV4dCBpcyBub3QgYW4gZXJyb3I6IGl0cyBleGl0IHN0YXR1cyBhbmQgc3RkZXJyXG4gICAgICogY2FycnkgdGhlIGNhdXNlLlxuICAgICAqL1xuICAgIHN0ZGluPzogc3RyaW5nO1xuICAgIC8qKlxuICAgICAqIFJldHVybiB3aGF0ZXZlciB0aGUgY2hpbGQgcHJpbnRlZCBiZWZvcmUgaXQgd2FzIGtpbGxlZCBvbiB0aW1lb3V0LFxuICAgICAqIGluc3RlYWQgb2YgZW1wdHkgc3RyZWFtcyAoSXNzdWUgIzgwNikuXG4gICAgICpcbiAgICAgKiBPZmYgYnkgZGVmYXVsdCBzbyBldmVyeSBleGlzdGluZyBjYWxsZXIga2VlcHMgdGhlIHRlcnNlIFwiVGltZWQgb3V0XG4gICAgICogYWZ0ZXIgTm1zXCIgc3RkZXJyIGl0IGFscmVhZHkgaGFuZGxlcy4gVGhlIGNhbGxiYWNrIGNvbnRyYWN0IHR1cm5zIGl0XG4gICAgICogb24gYmVjYXVzZSBhIGhvb2sncyBkaWFnbm9zdGljIG91dHB1dCBpcyBleGFjdGx5IHdoYXQgYW4gb3BlcmF0b3JcbiAgICAgKiBuZWVkcyB3aGVuIHRoZSBob29rIGlzIHRoZSB0aGluZyB0aGF0IGh1bmcuXG4gICAgICovXG4gICAgY2FwdHVyZU91dHB1dE9uVGltZW91dD86IGJvb2xlYW47XG4gIH0sXG4pOiBQcm9taXNlPFJlc3VsdDxTdWJwcm9jZXNzUmVzdWx0Pj4ge1xuICBjb25zdCByZXF1ZXN0ZWRNcyA9IG9wdGlvbnMudGltZW91dE1zO1xuXG4gIC8vIEEgY2FsbGVyLXN1cHBsaWVkIG5vbi1wb3NpdGl2ZSBidWRnZXQgaXMgdG9kYXkncyB0aW1lb3V0IHJlc3VsdC4gVGhlXG4gIC8vIGRlYWRsaW5lIGNsYW1wIGJlbG93IGlzIHdoYXQgcmVmdXNlcyBhIHBvc2l0aXZlIGJ1ZGdldCB0aGF0IHNocmlua3MgdG9cbiAgLy8gbm90aGluZyAoSXNzdWUgIzQyNDcpLiBBIHRpbWVvdXQgc3RheXMgYSBmYWlsdXJlOiBzdWNjZXNzIGlzIGZhbHNlLlxuICBpZiAoIShyZXF1ZXN0ZWRNcyA+IDApKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiB0cnVlLFxuICAgICAgdmFsdWU6IHtcbiAgICAgICAgc3VjY2VzczogZmFsc2UsXG4gICAgICAgIGNvZGU6IDEyNCxcbiAgICAgICAgc3Rkb3V0OiBcIlwiLFxuICAgICAgICBzdGRlcnI6IGBUaW1lZCBvdXQgYWZ0ZXIgJHtyZXF1ZXN0ZWRNc31tc2AsXG4gICAgICAgIHRpbWVkT3V0OiB0cnVlLFxuICAgICAgfSxcbiAgICB9O1xuICB9XG5cbiAgY29uc3QgY29tbWFuZExhYmVsID0gc3VicHJvY2Vzc0NvbW1hbmRMYWJlbChleGVjdXRhYmxlLCBhcmdzKTtcbiAgY29uc3QgdGltZW91dE1zID0gY2xhbXBUaW1lb3V0VG9SdW5UaW1lbGluZShyZXF1ZXN0ZWRNcywgY29tbWFuZExhYmVsKTtcblxuICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCB0aW1lb3V0TXMpO1xuXG4gIHRyeSB7XG4gICAgLy8gVXNlIHNwYXduKCkgc28gd2UgaG9sZCB0aGUgQ2hpbGRQcm9jZXNzIGhhbmRsZSBhbmQgY2FuIGtpbGwgaXRcbiAgICAvLyBleHBsaWNpdGx5IG9uIHRpbWVvdXQuIFRoZSBgc2lnbmFsYCBvcHRpb24gYWxvbmUgZG9lcyBub3QgcmVsaWFibHlcbiAgICAvLyB0ZXJtaW5hdGUgYSBydW5uaW5nIHByb2Nlc3Mgb24gYWxsIHBsYXRmb3Jtcy5cbiAgICBjb25zdCBjb21tYW5kID0gbmV3IERlbm8uQ29tbWFuZChleGVjdXRhYmxlLCB7XG4gICAgICBhcmdzLFxuICAgICAgY3dkOiBvcHRpb25zPy5jd2QsXG4gICAgICAuLi4ob3B0aW9ucz8uZW52ID8geyBlbnY6IG9wdGlvbnMuZW52IH0gOiB7fSksXG4gICAgICAuLi4ob3B0aW9ucz8uY2xlYXJFbnYgPyB7IGNsZWFyRW52OiB0cnVlIH0gOiB7fSksXG4gICAgICBzdGRpbjogb3B0aW9ucz8uc3RkaW4gPT09IHVuZGVmaW5lZCA/IFwibnVsbFwiIDogXCJwaXBlZFwiLFxuICAgICAgc3Rkb3V0OiBvcHRpb25zPy5xdWlldCA/IFwibnVsbFwiIDogXCJwaXBlZFwiLFxuICAgICAgLy8gc3RkZXJyIGlzIGFsd2F5cyBwaXBlZCArIGNhcHR1cmVkLiBNdXRpbmcgc3RkZXJyIGF0IHRoZSBPU1xuICAgICAgLy8gbGV2ZWwgZGlzY2FyZHMgZXhpdC10cmFwIGRpYWdub3N0aWNzIGZyb20gaGVscGVyIHNjcmlwdHNcbiAgICAgIC8vIChlLmcuIGEgcmVwb3NpdG9yeSdzIHF1YWxpdHkgZ2F0ZSksIHByb2R1Y2luZyBlbXB0eS10YWlsIFwiQ29tbWFuZFxuICAgICAgLy8gZmFpbGVkIHdpdGggY29kZSAxOiBcIiBtZXNzYWdlcyB0aGF0IGRlZmVhdCBvcGVyYXRvclxuICAgICAgLy8gdHJvdWJsZXNob290aW5nIChJc3N1ZSAjMTk3OSkuXG4gICAgICBzdGRlcnI6IFwicGlwZWRcIixcbiAgICB9KTtcblxuICAgIGNvbnN0IGNoaWxkID0gY29tbWFuZC5zcGF3bigpO1xuICAgIC8vIFRoZSB3cml0ZSBzdGFydHMgbm93IGFuZCBydW5zIGJlc2lkZSB0aGUgd2FpdDsgaXQgaXMgYXdhaXRlZCBiZWxvdy5cbiAgICBjb25zdCBzdGRpbkRvbmUgPSBvcHRpb25zPy5zdGRpbiA9PT0gdW5kZWZpbmVkXG4gICAgICA/IHVuZGVmaW5lZFxuICAgICAgOiB3cml0ZUNoaWxkU3RkaW4oY2hpbGQsIG9wdGlvbnMuc3RkaW4pO1xuICAgIC8vIEEgdGltZWQtb3V0IGNhbGwgcmV0dXJucyB3aXRob3V0IGF3YWl0aW5nIHRoZSB3cml0ZSwgc28gYSBmYWlsdXJlIHRoZXJlXG4gICAgLy8gbXVzdCBub3Qgc3VyZmFjZSBhcyBhbiB1bmhhbmRsZWQgcmVqZWN0aW9uLlxuICAgIHN0ZGluRG9uZT8uY2F0Y2goKCkgPT4ge30pO1xuICAgIGNvbnN0IG91dGNvbWUgPSBhd2FpdCB3YWl0Rm9yQ2hpbGRFeGl0KFxuICAgICAgY2hpbGQsXG4gICAgICBjb250cm9sbGVyLnNpZ25hbCxcbiAgICAgIGNvbW1hbmRMYWJlbCxcbiAgICApO1xuICAgIC8vIERyb3AgdGhlIHRpbWVyIGJlZm9yZSByZWFkaW5nIHRoZSBzaWduYWwsIHNvIGEgY29tbWFuZCB0aGF0IGhhcyBhbHJlYWR5XG4gICAgLy8gZmluaXNoZWQgaXMgbm90IHJlcG9ydGVkIGFzIGEgdGltZW91dC5cbiAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuXG4gICAgaWYgKG91dGNvbWUua2luZCA9PT0gXCJraWxsLWluY29tcGxldGVcIiB8fCBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkKSB7XG4gICAgICByZWNvcmRGYXVsdEV2ZW50KFxuICAgICAgICBcInRpbWVvdXRcIixcbiAgICAgICAgYFN1YnByb2Nlc3MgdGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zOiAke2NvbW1hbmRMYWJlbH1gLFxuICAgICAgKTtcbiAgICAgIGNvbnN0IGRlY29kZSA9IChieXRlczogVWludDhBcnJheSB8IG51bGwpID0+XG4gICAgICAgIGJ5dGVzID8gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKGJ5dGVzKS50cmltKCkgOiBcIlwiO1xuICAgICAgY29uc3QgdGltZWRPdXRTdGRlcnIgPSBgVGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zYDtcbiAgICAgIGNvbnN0IGNhcHR1cmVkID0gb3V0Y29tZS5raW5kID09PSBcIm91dHB1dFwiICYmXG4gICAgICAgICAgb3B0aW9ucz8uY2FwdHVyZU91dHB1dE9uVGltZW91dFxuICAgICAgICA/IGRlY29kZShvdXRjb21lLm91dHB1dC5zdGRlcnIpXG4gICAgICAgIDogXCJcIjtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZToge1xuICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgIGNvZGU6IDEyNCxcbiAgICAgICAgICBzdGRvdXQ6IG91dGNvbWUua2luZCA9PT0gXCJvdXRwdXRcIiAmJiBvcHRpb25zPy5jYXB0dXJlT3V0cHV0T25UaW1lb3V0XG4gICAgICAgICAgICA/IGRlY29kZShvdXRjb21lLm91dHB1dC5zdGRvdXQpXG4gICAgICAgICAgICA6IFwiXCIsXG4gICAgICAgICAgc3RkZXJyOiBjYXB0dXJlZCA/IGAke3RpbWVkT3V0U3RkZXJyfVxcbiR7Y2FwdHVyZWR9YCA6IHRpbWVkT3V0U3RkZXJyLFxuICAgICAgICAgIHRpbWVkT3V0OiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAob3V0Y29tZS5raW5kICE9PSBcIm91dHB1dFwiKSB7XG4gICAgICByZWNvcmRGYXVsdEV2ZW50KFxuICAgICAgICBcInRpbWVvdXRcIixcbiAgICAgICAgYFN1YnByb2Nlc3MgdGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zOiAke2NvbW1hbmRMYWJlbH1gLFxuICAgICAgKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZToge1xuICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgIGNvZGU6IDEyNCxcbiAgICAgICAgICBzdGRvdXQ6IFwiXCIsXG4gICAgICAgICAgc3RkZXJyOiBgVGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zYCxcbiAgICAgICAgICB0aW1lZE91dDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgaWYgKHN0ZGluRG9uZSkgYXdhaXQgc3RkaW5Eb25lO1xuICAgIGNvbnN0IG91dHB1dCA9IG91dGNvbWUub3V0cHV0O1xuICAgIHJldHVybiB7XG4gICAgICBvazogdHJ1ZSxcbiAgICAgIHZhbHVlOiB7XG4gICAgICAgIHN1Y2Nlc3M6IG91dHB1dC5zdWNjZXNzLFxuICAgICAgICBjb2RlOiBvdXRwdXQuY29kZSxcbiAgICAgICAgc3Rkb3V0OiBvcHRpb25zPy5xdWlldFxuICAgICAgICAgID8gXCJcIlxuICAgICAgICAgIDogKG91dHB1dC5zdGRvdXRcbiAgICAgICAgICAgID8gbmV3IFRleHREZWNvZGVyKCkuZGVjb2RlKG91dHB1dC5zdGRvdXQpLnRyaW0oKVxuICAgICAgICAgICAgOiBcIlwiKSxcbiAgICAgICAgLy8gc3RkZXJyIGlzIGFsd2F5cyByZXR1cm5lZCByZWdhcmRsZXNzIG9mIHF1aWV0IOKAlCBzZWUgY29tbWVudCBhYm92ZS5cbiAgICAgICAgc3RkZXJyOiBvdXRwdXQuc3RkZXJyXG4gICAgICAgICAgPyBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUob3V0cHV0LnN0ZGVycikudHJpbSgpXG4gICAgICAgICAgOiBcIlwiLFxuICAgICAgICB0aW1lZE91dDogZmFsc2UsXG4gICAgICB9LFxuICAgIH07XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRE9NRXhjZXB0aW9uICYmIGVycm9yLm5hbWUgPT09IFwiQWJvcnRFcnJvclwiKSB7XG4gICAgICByZWNvcmRGYXVsdEV2ZW50KFxuICAgICAgICBcInRpbWVvdXRcIixcbiAgICAgICAgYFN1YnByb2Nlc3MgdGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zOiAke2NvbW1hbmRMYWJlbH1gLFxuICAgICAgKTtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiB0cnVlLFxuICAgICAgICB2YWx1ZToge1xuICAgICAgICAgIHN1Y2Nlc3M6IGZhbHNlLFxuICAgICAgICAgIGNvZGU6IDEyNCxcbiAgICAgICAgICBzdGRvdXQ6IFwiXCIsXG4gICAgICAgICAgc3RkZXJyOiBgVGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zYCxcbiAgICAgICAgICB0aW1lZE91dDogdHJ1ZSxcbiAgICAgICAgfSxcbiAgICAgIH07XG4gICAgfVxuXG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOiBlcnJvciBpbnN0YW5jZW9mIEVycm9yID8gZXJyb3IgOiBuZXcgRXJyb3IoU3RyaW5nKGVycm9yKSksXG4gICAgfTtcbiAgfSBmaW5hbGx5IHtcbiAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICB9XG59XG5cbi8qKiBUcnVlIHdoZW4gYGVycm9yYCBpcyBhIHRpbWVvdXQgcmFpc2VkIGJ5IHtAbGluayBjb21tYW5kT3V0cHV0V2l0aFRpbWVvdXR9LiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzQ29tbWFuZFRpbWVvdXRFcnJvcihlcnJvcjogdW5rbm93bik6IGVycm9yIGlzIEVycm9yIHtcbiAgcmV0dXJuIGVycm9yIGluc3RhbmNlb2YgRXJyb3IgJiYgZXJyb3IubWVzc2FnZS5pbmNsdWRlcyhcInRpbWVkIG91dCBhZnRlclwiKTtcbn1cblxuLyoqIEFmdGVyIGEgdGltZW91dCwgaG93IGxvbmcgdGhlIGNoaWxkIGhhcyB0byBleGl0IG9uIFNJR1RFUk0gYmVmb3JlIFNJR0tJTEwuICovXG5jb25zdCBUSU1FT1VUX0tJTExfR1JBQ0VfTVMgPSA1XzAwMDtcblxuLyoqXG4gKiBXcml0ZSBgdGV4dGAgdG8gYSBzcGF3bmVkIGNoaWxkJ3Mgc3RkaW4sIHRoZW4gY2xvc2UgaXQgKElzc3VlICM0NzA1KS5cbiAqXG4gKiBBIGBCcm9rZW5QaXBlYCBpcyB0aGUgY2hpbGQgZXhpdGluZyBiZWZvcmUgaXQgcmVhZCBldmVyeXRoaW5nOiBpdHMgZXhpdFxuICogc3RhdHVzIGFuZCBzdGRlcnIgY2FycnkgdGhlIGNhdXNlLCBhbmQgYSB3cmFwcGVyIHRoYXQgZXhwZWN0cyBtb3JlIGlucHV0XG4gKiByZXBvcnRzIHRoZSBzaG9ydCBzdHJlYW0gaXRzZWxmLiBPbmx5IHRoYXQgZXJyb3IgaXMgc3dhbGxvd2VkOyBhbnkgb3RoZXJcbiAqIGZhaWx1cmUgaXMgcmV0aHJvd24uIFRoZSB0ZXh0IGlzIG5ldmVyIGxvZ2dlZC5cbiAqL1xuYXN5bmMgZnVuY3Rpb24gd3JpdGVDaGlsZFN0ZGluKFxuICBjaGlsZDogRGVuby5DaGlsZFByb2Nlc3MsXG4gIHRleHQ6IHN0cmluZyxcbik6IFByb21pc2U8dm9pZD4ge1xuICBjb25zdCB3cml0ZXIgPSBjaGlsZC5zdGRpbi5nZXRXcml0ZXIoKTtcbiAgdHJ5IHtcbiAgICBhd2FpdCB3cml0ZXIud3JpdGUobmV3IFRleHRFbmNvZGVyKCkuZW5jb2RlKHRleHQpKTtcbiAgICBhd2FpdCB3cml0ZXIuY2xvc2UoKTtcbiAgfSBjYXRjaCAoZXJyb3I6IHVua25vd24pIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ccm9rZW5QaXBlKSByZXR1cm47XG4gICAgdGhyb3cgZXJyb3I7XG4gIH1cbn1cblxuLyoqIFJlYWQgYHJlYWRlcmAgdG8gaXRzIGVuZC4gQSBjYW5jZWxsZWQgcmVhZGVyIGVuZHMgZWFybHksIGtlZXBpbmcgaXRzIGJ5dGVzLiAqL1xuYXN5bmMgZnVuY3Rpb24gZHJhaW5SZWFkZXIoXG4gIHJlYWRlcjogUmVhZGFibGVTdHJlYW1EZWZhdWx0UmVhZGVyPFVpbnQ4QXJyYXk+LFxuKTogUHJvbWlzZTxVaW50OEFycmF5PEFycmF5QnVmZmVyPj4ge1xuICBjb25zdCBjaHVua3M6IFVpbnQ4QXJyYXlbXSA9IFtdO1xuICBsZXQgbGVuZ3RoID0gMDtcbiAgZm9yICg7Oykge1xuICAgIGNvbnN0IHsgZG9uZSwgdmFsdWUgfSA9IGF3YWl0IHJlYWRlci5yZWFkKCk7XG4gICAgaWYgKGRvbmUpIGJyZWFrO1xuICAgIGNodW5rcy5wdXNoKHZhbHVlKTtcbiAgICBsZW5ndGggKz0gdmFsdWUubGVuZ3RoO1xuICB9XG4gIGNvbnN0IGJ5dGVzID0gbmV3IFVpbnQ4QXJyYXkobGVuZ3RoKTtcbiAgbGV0IG9mZnNldCA9IDA7XG4gIGZvciAoY29uc3QgY2h1bmsgb2YgY2h1bmtzKSB7XG4gICAgYnl0ZXMuc2V0KGNodW5rLCBvZmZzZXQpO1xuICAgIG9mZnNldCArPSBjaHVuay5sZW5ndGg7XG4gIH1cbiAgcmV0dXJuIGJ5dGVzO1xufVxuXG4vKipcbiAqIFJ1biBgRGVuby5Db21tYW5kYCBhbmQgcmVqZWN0IHdoZW4gaXQgZXhjZWVkcyBgdGltZW91dE1zYC5cbiAqXG4gKiBBIHRpbWVvdXQgb2YgemVybyBvciBsZXNzIGZhaWxzIGltbWVkaWF0ZWx5IGFuZCBkb2VzIG5vdCBzcGF3bi4gVGhlIHRocm93blxuICogZXJyb3IgbmFtZXMgdGhlIGV4ZWN1dGFibGUuIENhbGxlcnMgcmVwb3J0IHRoYXQgZXJyb3IgYXMgYSB0aW1lb3V0IG9yIGFcbiAqIGZhaWx1cmU7IHRoZXkgZG8gbm90IHR1cm4gaXQgaW50byBhIHN1Y2Nlc3NmdWwgcmVzdWx0LlxuICpcbiAqIFRoZSBib3VuZCBob2xkcyBldmVuIHdoZW4gdGhlIGNoaWxkIGxlYXZlcyBhIGdyYW5kY2hpbGQgYmVoaW5kOiBhdCB0aGVcbiAqIHRpbWVvdXQgdGhlIHBpcGVzIGFyZSBjYW5jZWxsZWQgcmF0aGVyIHRoYW4gcmVhZCB0byBFT0YsIGJlY2F1c2UgYVxuICogZ3JhbmRjaGlsZCB0aGF0IGluaGVyaXRlZCB0aGVtIHdvdWxkIG90aGVyd2lzZSBrZWVwIGBvdXRwdXQoKWAgd2FpdGluZ1xuICogZm9yIGFzIGxvbmcgYXMgaXQgbGl2ZXMuIEEgY2hpbGQgdGhhdCBpZ25vcmVzIFNJR1RFUk0gZ2V0cyBTSUdLSUxMIGFmdGVyXG4gKiBhIHNob3J0IGdyYWNlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gY29tbWFuZE91dHB1dFdpdGhUaW1lb3V0KFxuICBleGVjdXRhYmxlOiBzdHJpbmcsXG4gIG9wdGlvbnM6IERlbm8uQ29tbWFuZE9wdGlvbnMgJiB7XG4gICAgdGltZW91dE1zOiBudW1iZXI7XG4gICAgLyoqXG4gICAgICogVGV4dCB3cml0dGVuIHRvIHRoZSBjaGlsZCdzIHN0ZGluLCB0aGVuIGNsb3NlZCAoSXNzdWUgIzQ3MDUpLiBXaGVuIHNldCxcbiAgICAgKiBzdGRpbiBpcyBwaXBlZDsgYSBjaGlsZCB0aGF0IGV4aXRzIGJlZm9yZSByZWFkaW5nIGlzIG5vdCBhbiBlcnJvci5cbiAgICAgKi9cbiAgICBzdGRpblRleHQ/OiBzdHJpbmc7XG4gIH0sXG4pOiBQcm9taXNlPERlbm8uQ29tbWFuZE91dHB1dD4ge1xuICBjb25zdCB7IHRpbWVvdXRNcywgc3RkaW5UZXh0LCAuLi5jb21tYW5kT3B0aW9ucyB9ID0gb3B0aW9ucztcbiAgaWYgKCEodGltZW91dE1zID4gMCkpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoYCR7ZXhlY3V0YWJsZX0gdGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zYCk7XG4gIH1cblxuICAvLyBgb3V0cHV0KClgIHBpcGVzIHN0ZG91dCBhbmQgc3RkZXJyIHVubGVzcyB0b2xkIG90aGVyd2lzZTsgYHNwYXduKClgIGRvZXNcbiAgLy8gbm90LCBzbyB0aGUgZGVmYXVsdHMgYXJlIHJlc3RhdGVkIGhlcmUuXG4gIGNvbnN0IHN0ZG91dE1vZGUgPSBjb21tYW5kT3B0aW9ucy5zdGRvdXQgPz8gXCJwaXBlZFwiO1xuICBjb25zdCBzdGRlcnJNb2RlID0gY29tbWFuZE9wdGlvbnMuc3RkZXJyID8/IFwicGlwZWRcIjtcbiAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgdGltZW91dE1zKTtcbiAgbGV0IGtpbGxUaW1lcjogUmV0dXJuVHlwZTx0eXBlb2Ygc2V0VGltZW91dD4gfCB1bmRlZmluZWQ7XG4gIGNvbnN0IHJlYWRlcnM6IFJlYWRhYmxlU3RyZWFtRGVmYXVsdFJlYWRlcjxVaW50OEFycmF5PltdID0gW107XG4gIGNvbnN0IG9uQWJvcnQgPSAoKSA9PiB7XG4gICAgZm9yIChjb25zdCByZWFkZXIgb2YgcmVhZGVycykgcmVhZGVyLmNhbmNlbCgpLmNhdGNoKCgpID0+IHt9KTtcbiAgICBraWxsVGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgIHRyeSB7XG4gICAgICAgIGNoaWxkPy5raWxsKFwiU0lHS0lMTFwiKTtcbiAgICAgIH0gY2F0Y2ggeyAvKiBhbHJlYWR5IGV4aXRlZCAqLyB9XG4gICAgfSwgVElNRU9VVF9LSUxMX0dSQUNFX01TKTtcbiAgfTtcbiAgbGV0IGNoaWxkOiBEZW5vLkNoaWxkUHJvY2VzcyB8IHVuZGVmaW5lZDtcbiAgdHJ5IHtcbiAgICBjaGlsZCA9IG5ldyBEZW5vLkNvbW1hbmQoZXhlY3V0YWJsZSwge1xuICAgICAgLi4uY29tbWFuZE9wdGlvbnMsXG4gICAgICAuLi4oc3RkaW5UZXh0ID09PSB1bmRlZmluZWQgPyB7fSA6IHsgc3RkaW46IFwicGlwZWRcIiBhcyBjb25zdCB9KSxcbiAgICAgIHN0ZG91dDogc3Rkb3V0TW9kZSxcbiAgICAgIHN0ZGVycjogc3RkZXJyTW9kZSxcbiAgICAgIHNpZ25hbDogY29udHJvbGxlci5zaWduYWwsXG4gICAgfSkuc3Bhd24oKTtcbiAgICAvLyBUaGUgd3JpdGUgc3RhcnRzIG5vdyBhbmQgcnVucyBiZXNpZGUgdGhlIGNvbGxlY3Rpb247IGl0IGlzIGF3YWl0ZWRcbiAgICAvLyBhZnRlciB0aGUgY2hpbGQgZXhpdHMsIGFuZCBvbmx5IG9uIHRoZSBzdWNjZXNzIHBhdGggKElzc3VlICM0NzA1KS5cbiAgICBjb25zdCBzdGRpbkRvbmUgPSBzdGRpblRleHQgPT09IHVuZGVmaW5lZFxuICAgICAgPyB1bmRlZmluZWRcbiAgICAgIDogd3JpdGVDaGlsZFN0ZGluKGNoaWxkLCBzdGRpblRleHQpO1xuICAgIC8vIEEgdGltZWQtb3V0IGNhbGwgdGhyb3dzIHdpdGhvdXQgYXdhaXRpbmcgdGhlIHdyaXRlLCBzbyBhIGZhaWx1cmUgdGhlcmVcbiAgICAvLyBtdXN0IG5vdCBzdXJmYWNlIGFzIGFuIHVuaGFuZGxlZCByZWplY3Rpb24uXG4gICAgc3RkaW5Eb25lPy5jYXRjaCgoKSA9PiB7fSk7XG4gICAgY29uc3QgZW1wdHkgPSBQcm9taXNlLnJlc29sdmUobmV3IFVpbnQ4QXJyYXkoMCkpO1xuICAgIGNvbnN0IGNvbGxlY3QgPSAoc3RyZWFtOiBSZWFkYWJsZVN0cmVhbTxVaW50OEFycmF5PikgPT4ge1xuICAgICAgY29uc3QgcmVhZGVyID0gc3RyZWFtLmdldFJlYWRlcigpO1xuICAgICAgcmVhZGVycy5wdXNoKHJlYWRlcik7XG4gICAgICByZXR1cm4gZHJhaW5SZWFkZXIocmVhZGVyKTtcbiAgICB9O1xuICAgIGNvbnN0IHN0ZG91dEJ5dGVzID0gc3Rkb3V0TW9kZSA9PT0gXCJwaXBlZFwiID8gY29sbGVjdChjaGlsZC5zdGRvdXQpIDogZW1wdHk7XG4gICAgY29uc3Qgc3RkZXJyQnl0ZXMgPSBzdGRlcnJNb2RlID09PSBcInBpcGVkXCIgPyBjb2xsZWN0KGNoaWxkLnN0ZGVycikgOiBlbXB0eTtcbiAgICBjb250cm9sbGVyLnNpZ25hbC5hZGRFdmVudExpc3RlbmVyKFwiYWJvcnRcIiwgb25BYm9ydCwgeyBvbmNlOiB0cnVlIH0pO1xuICAgIGNvbnN0IFtzdGF0dXMsIHN0ZG91dCwgc3RkZXJyXSA9IGF3YWl0IFByb21pc2UuYWxsKFtcbiAgICAgIGNoaWxkLnN0YXR1cyxcbiAgICAgIHN0ZG91dEJ5dGVzLFxuICAgICAgc3RkZXJyQnl0ZXMsXG4gICAgXSk7XG4gICAgaWYgKGNvbnRyb2xsZXIuc2lnbmFsLmFib3J0ZWQpIHtcbiAgICAgIHRocm93IG5ldyBFcnJvcihgJHtleGVjdXRhYmxlfSB0aW1lZCBvdXQgYWZ0ZXIgJHt0aW1lb3V0TXN9bXNgKTtcbiAgICB9XG4gICAgaWYgKHN0ZGluRG9uZSkgYXdhaXQgc3RkaW5Eb25lO1xuICAgIHJldHVybiB7IC4uLnN0YXR1cywgc3Rkb3V0LCBzdGRlcnIgfTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoXG4gICAgICBjb250cm9sbGVyLnNpZ25hbC5hYm9ydGVkIHx8XG4gICAgICAoZXJyb3IgaW5zdGFuY2VvZiBET01FeGNlcHRpb24gJiYgZXJyb3IubmFtZSA9PT0gXCJBYm9ydEVycm9yXCIpXG4gICAgKSB7XG4gICAgICByZWNvcmRGYXVsdEV2ZW50KFxuICAgICAgICBcInRpbWVvdXRcIixcbiAgICAgICAgYFN1YnByb2Nlc3MgdGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zOiAke2V4ZWN1dGFibGV9YCxcbiAgICAgICk7XG4gICAgICB0aHJvdyBuZXcgRXJyb3IoYCR7ZXhlY3V0YWJsZX0gdGltZWQgb3V0IGFmdGVyICR7dGltZW91dE1zfW1zYCk7XG4gICAgfVxuICAgIHRocm93IGVycm9yO1xuICB9IGZpbmFsbHkge1xuICAgIGNsZWFyVGltZW91dCh0aW1lcik7XG4gICAgY2xlYXJUaW1lb3V0KGtpbGxUaW1lcik7XG4gICAgY29udHJvbGxlci5zaWduYWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImFib3J0XCIsIG9uQWJvcnQpO1xuICB9XG59XG5cbi8qKiBBIG5vbi1naXQsIG5vbi1naCBhcmd2LiBNaW51dGVzLiBBIHRpbWVvdXQgdGhyb3dzOyBpdCBpcyBub3QgYSB6ZXJvIGV4aXQuICovXG5leHBvcnQgY29uc3QgRElSRUNUX0NPTU1BTkRfVElNRU9VVF9NUyA9IDMwICogNjAgKiAxMDAwO1xuXG4vKipcbiAqIFJ1biBhbiBhcmd2IHRvIGNvbXBsZXRpb24gd2l0aCB0cmltbWVkIHRleHQgb3V0cHV0IChJc3N1ZSAjNDI1MSkuXG4gKlxuICogVGhlIG5vbi1naXQsIG5vbi1naCBicmFuY2ggb2YgdGhlIGluamVjdGFibGUgYFJ1bkNvbW1hbmRgIHNlYW1zLiBBXG4gKiBzdXBwbGllZCBgZW52YCBpcyBwYXNzZWQgYXMgaXM6IGNhbGxlcnMgdGhhdCBvdmVybGF5IHRoZSBwYXJlbnQnc1xuICogZW52aXJvbm1lbnQgYnVpbGQgdGhhdCBvdmVybGF5IHRoZW1zZWx2ZXMuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5EaXJlY3RDb21tYW5kKFxuICBjbWQ6IHN0cmluZ1tdLFxuICB0aW1lb3V0TXM6IG51bWJlciA9IERJUkVDVF9DT01NQU5EX1RJTUVPVVRfTVMsXG4gIGVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz4sXG4pOiBQcm9taXNlPHsgc3VjY2VzczogYm9vbGVhbjsgc3Rkb3V0OiBzdHJpbmc7IHN0ZGVycjogc3RyaW5nIH0+IHtcbiAgY29uc3Qgb3V0cHV0ID0gYXdhaXQgY29tbWFuZE91dHB1dFdpdGhUaW1lb3V0KGNtZFswXSA/PyBcIlwiLCB7XG4gICAgYXJnczogY21kLnNsaWNlKDEpLFxuICAgIHN0ZG91dDogXCJwaXBlZFwiLFxuICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICAgIC4uLihlbnYgPyB7IGVudiB9IDoge30pLFxuICAgIHRpbWVvdXRNcyxcbiAgfSk7XG4gIGNvbnN0IGRlY29kZXIgPSBuZXcgVGV4dERlY29kZXIoKTtcbiAgcmV0dXJuIHtcbiAgICBzdWNjZXNzOiBvdXRwdXQuc3VjY2VzcyxcbiAgICBzdGRvdXQ6IGRlY29kZXIuZGVjb2RlKG91dHB1dC5zdGRvdXQpLnRyaW0oKSxcbiAgICBzdGRlcnI6IGRlY29kZXIuZGVjb2RlKG91dHB1dC5zdGRlcnIpLnRyaW0oKSxcbiAgfTtcbn1cblxuLyoqXG4gKiBTcGF3biBhIHN0cmVhbWluZyBjaGlsZCB0aGF0IGlzIHNpZ25hbGxlZCB3aGVuIGB0aW1lb3V0TXNgIGVsYXBzZXMuXG4gKlxuICogQSB0aW1lb3V0IG9mIHplcm8gb3IgbGVzcyB0aHJvd3MgYW5kIGRvZXMgbm90IHNwYXduLiBUaGUgdGltZXIgaXMgY2xlYXJlZFxuICogd2hlbiB0aGUgY2hpbGQgZXhpdHMsIHNvIGEgZmluaXNoZWQgcHJvY2VzcyBpcyBub3Qgc2lnbmFsbGVkIGxhdGVyLlxuICovXG5leHBvcnQgZnVuY3Rpb24gc3Bhd25Db21tYW5kV2l0aFRpbWVvdXQoXG4gIGV4ZWN1dGFibGU6IHN0cmluZyxcbiAgb3B0aW9uczogRGVuby5Db21tYW5kT3B0aW9ucyAmIHsgdGltZW91dE1zOiBudW1iZXIgfSxcbik6IERlbm8uQ2hpbGRQcm9jZXNzIHtcbiAgY29uc3QgeyB0aW1lb3V0TXMsIC4uLmNvbW1hbmRPcHRpb25zIH0gPSBvcHRpb25zO1xuICBpZiAoISh0aW1lb3V0TXMgPiAwKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihgJHtleGVjdXRhYmxlfSB0aW1lZCBvdXQgYWZ0ZXIgJHt0aW1lb3V0TXN9bXNgKTtcbiAgfVxuICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLCB0aW1lb3V0TXMpO1xuICB0cnkge1xuICAgIGNvbnN0IGNoaWxkID0gbmV3IERlbm8uQ29tbWFuZChleGVjdXRhYmxlLCB7XG4gICAgICAuLi5jb21tYW5kT3B0aW9ucyxcbiAgICAgIHNpZ25hbDogY29udHJvbGxlci5zaWduYWwsXG4gICAgfSkuc3Bhd24oKTtcbiAgICBjaGlsZC5zdGF0dXMuZmluYWxseSgoKSA9PiBjbGVhclRpbWVvdXQodGltZXIpKTtcbiAgICByZXR1cm4gY2hpbGQ7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxufVxuXG4vKipcbiAqIFJ1biBhIGZldGNoIHJlcXVlc3Qgd2l0aCB0aW1lb3V0IHByb3RlY3Rpb24uXG4gKlxuICogV3JhcHMgYSBmZXRjaCBjYWxsIHdpdGggYW4gQWJvcnRDb250cm9sbGVyIHRoYXQgZmlyZXMgYWZ0ZXIgdGhlXG4gKiBzcGVjaWZpZWQgdGltZW91dC4gVXNlZnVsIGZvciBBUEkgY2FsbHMgdGhhdCBtYXkgaGFuZy5cbiAqXG4gKiBAcGFyYW0gdXJsIC0gVGhlIFVSTCB0byBmZXRjaC5cbiAqIEBwYXJhbSBpbml0IC0gU3RhbmRhcmQgZmV0Y2ggUmVxdWVzdEluaXQgb3B0aW9ucy5cbiAqIEBwYXJhbSB0aW1lb3V0TXMgLSBUaW1lb3V0IGluIG1pbGxpc2Vjb25kcyAoZGVmYXVsdDogMzAgc2Vjb25kcykuXG4gKiBAcmV0dXJucyBUaGUgZmV0Y2ggUmVzcG9uc2UuXG4gKiBAdGhyb3dzIEVycm9yIG9uIHRpbWVvdXQgb3IgbmV0d29yayBmYWlsdXJlLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gZmV0Y2hXaXRoVGltZW91dChcbiAgdXJsOiBzdHJpbmcgfCBVUkwsXG4gIGluaXQ/OiBSZXF1ZXN0SW5pdCxcbiAgdGltZW91dE1zOiBudW1iZXIgPSBERUZBVUxUX1NVQlBST0NFU1NfVElNRU9VVF9NUyxcbik6IFByb21pc2U8UmVzcG9uc2U+IHtcbiAgY29uc3QgY29udHJvbGxlciA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTtcbiAgY29uc3QgdGltZXIgPSBzZXRUaW1lb3V0KCgpID0+IGNvbnRyb2xsZXIuYWJvcnQoKSwgdGltZW91dE1zKTtcblxuICBjb25zdCBtZXJnZWRJbml0OiBSZXF1ZXN0SW5pdCA9IHtcbiAgICAuLi5pbml0LFxuICAgIHNpZ25hbDogY29udHJvbGxlci5zaWduYWwsXG4gIH07XG5cbiAgdHJ5IHtcbiAgICBjb25zdCByZXNwb25zZSA9IGF3YWl0IGZldGNoKHVybCwgbWVyZ2VkSW5pdCk7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICByZXR1cm4gcmVzcG9uc2U7XG4gIH0gY2F0Y2ggKGVycm9yOiB1bmtub3duKSB7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcblxuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIERPTUV4Y2VwdGlvbiAmJiBlcnJvci5uYW1lID09PSBcIkFib3J0RXJyb3JcIikge1xuICAgICAgcmVjb3JkRmF1bHRFdmVudChcbiAgICAgICAgXCJ0aW1lb3V0XCIsXG4gICAgICAgIGBGZXRjaCB0aW1lZCBvdXQgYWZ0ZXIgJHt0aW1lb3V0TXN9bXM6ICR7dXJsfWAsXG4gICAgICApO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKFxuICAgICAgICBgUmVxdWVzdCB0aW1lZCBvdXQgYWZ0ZXIgJHt0aW1lb3V0TXN9bXM6ICR7dXJsfWAsXG4gICAgICApO1xuICAgIH1cblxuICAgIHRocm93IGVycm9yO1xuICB9XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7O0NBUUMsR0FHRCxTQUFTLGdCQUFnQixRQUFRLGdDQUFnQztBQUNqRSxTQUFTLGNBQWMsUUFBUSxvQkFBb0I7QUFFbkQsc0RBQXNELEdBQ3RELE9BQU8sTUFBTSxnQ0FBZ0MsT0FBTztBQUVwRDs7OztDQUlDLEdBQ0QsT0FBTyxNQUFNLCtCQUErQixRQUFRO0FBRXBELCtFQUErRSxHQUMvRSxPQUFPLE1BQU0sZ0JBQWdCLE1BQU07QUFFbkMsSUFBSTtBQUNKLElBQUk7QUFFSix3REFBd0QsR0FDeEQsT0FBTyxTQUFTLDBCQUEwQixHQUFpQjtFQUN6RCx3QkFBd0I7QUFDMUI7QUFFQSx3Q0FBd0MsR0FDeEMsT0FBTyxTQUFTO0VBQ2Qsd0JBQXdCO0FBQzFCO0FBRUEsZ0RBQWdELEdBQ2hELE9BQU8sU0FBUyx3QkFBd0IsRUFBVTtFQUNoRCxzQkFBc0I7QUFDeEI7QUFFQSw4Q0FBOEMsR0FDOUMsT0FBTyxTQUFTO0VBQ2Qsc0JBQXNCO0FBQ3hCO0FBRUEsU0FBUztFQUNQLE9BQU8sd0JBQXdCLDBCQUEwQixLQUFLLEdBQUc7QUFDbkU7QUFFQSxTQUFTO0VBQ1AsT0FBTyx1QkFBdUI7QUFDaEM7QUFFQSwyRUFBMkUsR0FDM0UsT0FBTyxTQUFTLHVCQUNkLFVBQWtCLEVBQ2xCLElBQXVCO0VBRXZCLE9BQU8sS0FBSyxNQUFNLEtBQUssSUFBSSxhQUFhLEdBQUcsV0FBVyxD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
// denoCacheMetadata=12282525835400816415,16311970291097857063