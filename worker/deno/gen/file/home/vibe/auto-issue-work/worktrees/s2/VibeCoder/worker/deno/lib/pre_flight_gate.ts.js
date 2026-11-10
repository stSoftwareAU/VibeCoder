/**
 * Pre-flight enforcement gate (Issue #3577).
 *
 * Runs a repo's configured mandatory pre-flight commands in the working tree
 * immediately before the worker's automated commit, at the same chokepoint as
 * `assertSafeToCommit()`. The first non-zero exit blocks BOTH the commit and
 * the push — there is deliberately no override/force flag and no environment
 * escape hatch. The same `runPreFlightGate` also runs before the agent's own
 * `git push`, through the per-run pre-push hook (`pre_push_hook.ts` →
 * `pre_push_gate.ts`, Issue #3394).
 *
 * Fail loud, never fail open: a command that is missing, not executable,
 * cannot be started, or times out is a **block**, not a pass. "Could not run
 * the check" is never reported as "check passed" (carried over from
 * private-repo-12#563, where a check exited 0 when a prerequisite was absent).
 *
 * The failure carries a distinct `reason` and the captured command output so
 * callers can surface the real compiler error to the retry/diagnosis path.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ import { TIMEOUT_EXIT_CODE } from "./git_timeout.ts";
import { buildUntrustedCommandEnv } from "./untrusted_command_env.ts";
import { buildCacheEnvForCheckout } from "./ephemeral_build_cache.ts";
/**
 * Default per-command timeout in seconds (Issue #3577).
 *
 * These builds legitimately take many minutes, so the default is generous
 * (30 minutes). A timeout is a **block**, never a pass. Override per-gate via
 * {@link PreFlightGateOptions.timeoutSeconds}.
 */ export const PRE_FLIGHT_DEFAULT_TIMEOUT_SECONDS = 1800;
/**
 * Error raised when the pre-flight gate blocks a commit/push (Issue #3577).
 *
 * Carries the distinct {@link reason}, the offending {@link command}, its exit
 * {@link exitCode}, and the captured {@link output} (stdout + stderr) so the
 * failure can be surfaced verbatim to the fixer.
 */ export class PreFlightGateError extends Error {
  reason;
  command;
  exitCode;
  output;
  constructor(args){
    super(args.message);
    this.name = "PreFlightGateError";
    this.reason = args.reason;
    this.command = args.command;
    this.exitCode = args.exitCode;
    this.output = args.output;
  }
}
/**
 * Tokenise a command string into a program and its arguments.
 *
 * Commands run **directly** (not through a shell), so a missing or
 * non-executable program surfaces as a spawn failure we can classify as
 * `not-started` — distinct from a shell's exit 127. Supports simple single-
 * and double-quoted segments; shell features (pipes, redirects, globs) are
 * not interpreted.
 */ export function tokeniseCommand(command) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while((match = re.exec(command)) !== null){
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}
/** Default runner: spawn the command directly with timeout protection. */ async function defaultPreFlightRunner(command, options) {
  const tokens = tokeniseCommand(command);
  const program = tokens[0];
  if (program === undefined) {
    return {
      started: false,
      code: -1,
      stdout: "",
      stderr: "empty command string"
    };
  }
  const args = tokens.slice(1);
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(), options.timeoutSeconds * 1000);
  try {
    const cmd = new Deno.Command(program, {
      args,
      cwd: options.cwd,
      // The pre-flight scripts are supplied by the target repository, so this
      // is code the worker did not write. Its environment is BUILT from the
      // allowlist rather than inherited (Issues #572, #1214): a repo-committed
      // `./pre-flight.sh` otherwise ran with every credential the worker
      // holds, which is the whole exploit. Caller-supplied values are layered
      // on top, so an explicit need is still met.
      // Issue #2247: where the runtime refuses to trim the work volume, a
      // pre-flight that builds writes its artefacts to the container's own
      // ephemeral layer rather than ratchetting the volume's sparse image.
      env: buildUntrustedCommandEnv({
        overrides: {
          ...buildCacheEnvForCheckout(options.cwd),
          ...options.env ?? {}
        }
      }),
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal
    });
    const out = await cmd.output();
    clearTimeout(timer);
    return {
      started: true,
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr)
    };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === "AbortError") {
      // Aborted by the timeout — a BLOCK, never a pass.
      return {
        started: true,
        code: TIMEOUT_EXIT_CODE,
        stdout: "",
        stderr: `timed out after ${options.timeoutSeconds}s`,
        timedOut: true
      };
    }
    // Deno.errors.NotFound / PermissionDenied / any other spawn failure —
    // the command could not be started, so this is a BLOCK.
    return {
      started: false,
      code: -1,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err)
    };
  }
}
/** Trim and join stdout/stderr for surfacing to the fixer. */ function combineOutput(result) {
  return [
    result.stdout,
    result.stderr
  ].map((s)=>s.trim()).filter((s)=>s.length > 0).join("\n");
}
/**
 * Run a repo's pre-flight commands in listed order, stopping at the first
 * failure (Issue #3577).
 *
 * - Empty `commands` → `Ok` immediately, no runner invoked (zero added
 *   latency for repos with no gate).
 * - A command that cannot be started → `Err` with reason `not-started` and a
 *   message distinct from "check failed".
 * - A command that times out → `Err` with reason `timeout`.
 * - A command that exits non-zero → `Err` with reason `non-zero-exit`.
 *
 * @param commands Commands to run (from `getPreFlightCommands`).
 * @param options Working tree, env, timeout, and injectable runner.
 * @returns `Ok(void)` when every command passed; a `PreFlightGateError`
 *   otherwise.
 */ export async function runPreFlightGate(commands, options = {}) {
  if (commands.length === 0) {
    return {
      ok: true,
      value: undefined
    };
  }
  const runner = options.runner ?? defaultPreFlightRunner;
  const timeoutSeconds = options.timeoutSeconds ?? PRE_FLIGHT_DEFAULT_TIMEOUT_SECONDS;
  for (const command of commands){
    const result = await runner(command, {
      cwd: options.cwd,
      env: options.env,
      timeoutSeconds
    });
    const output = combineOutput(result);
    if (!result.started) {
      return {
        ok: false,
        error: new PreFlightGateError({
          reason: "not-started",
          command,
          exitCode: result.code,
          output,
          message: `Pre-flight gate BLOCK (Issue #3577): command \`${command}\` ` + `could not be started (missing, not executable, or unstartable). ` + `"Could not run the check" is treated as a block, never a pass.` + (output ? `\n\n${output}` : "")
        })
      };
    }
    if (result.timedOut || result.code === TIMEOUT_EXIT_CODE) {
      return {
        ok: false,
        error: new PreFlightGateError({
          reason: "timeout",
          command,
          exitCode: TIMEOUT_EXIT_CODE,
          output,
          message: `Pre-flight gate BLOCK (Issue #3577): command \`${command}\` ` + `timed out after ${timeoutSeconds}s. A timeout is a block, ` + `never a pass.` + (output ? `\n\n${output}` : "")
        })
      };
    }
    if (result.code !== 0) {
      return {
        ok: false,
        error: new PreFlightGateError({
          reason: "non-zero-exit",
          command,
          exitCode: result.code,
          output,
          message: `Pre-flight gate BLOCK (Issue #3577): command \`${command}\` ` + `failed with exit code ${result.code}. Fix the failure and retry ` + `— the commit and push are blocked.` + (output ? `\n\n${output}` : "")
        })
      };
    }
  }
  return {
    ok: true,
    value: undefined
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9wcmVfZmxpZ2h0X2dhdGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBQcmUtZmxpZ2h0IGVuZm9yY2VtZW50IGdhdGUgKElzc3VlICMzNTc3KS5cbiAqXG4gKiBSdW5zIGEgcmVwbydzIGNvbmZpZ3VyZWQgbWFuZGF0b3J5IHByZS1mbGlnaHQgY29tbWFuZHMgaW4gdGhlIHdvcmtpbmcgdHJlZVxuICogaW1tZWRpYXRlbHkgYmVmb3JlIHRoZSB3b3JrZXIncyBhdXRvbWF0ZWQgY29tbWl0LCBhdCB0aGUgc2FtZSBjaG9rZXBvaW50IGFzXG4gKiBgYXNzZXJ0U2FmZVRvQ29tbWl0KClgLiBUaGUgZmlyc3Qgbm9uLXplcm8gZXhpdCBibG9ja3MgQk9USCB0aGUgY29tbWl0IGFuZFxuICogdGhlIHB1c2gg4oCUIHRoZXJlIGlzIGRlbGliZXJhdGVseSBubyBvdmVycmlkZS9mb3JjZSBmbGFnIGFuZCBubyBlbnZpcm9ubWVudFxuICogZXNjYXBlIGhhdGNoLiBUaGUgc2FtZSBgcnVuUHJlRmxpZ2h0R2F0ZWAgYWxzbyBydW5zIGJlZm9yZSB0aGUgYWdlbnQncyBvd25cbiAqIGBnaXQgcHVzaGAsIHRocm91Z2ggdGhlIHBlci1ydW4gcHJlLXB1c2ggaG9vayAoYHByZV9wdXNoX2hvb2sudHNgIOKGklxuICogYHByZV9wdXNoX2dhdGUudHNgLCBJc3N1ZSAjMzM5NCkuXG4gKlxuICogRmFpbCBsb3VkLCBuZXZlciBmYWlsIG9wZW46IGEgY29tbWFuZCB0aGF0IGlzIG1pc3NpbmcsIG5vdCBleGVjdXRhYmxlLFxuICogY2Fubm90IGJlIHN0YXJ0ZWQsIG9yIHRpbWVzIG91dCBpcyBhICoqYmxvY2sqKiwgbm90IGEgcGFzcy4gXCJDb3VsZCBub3QgcnVuXG4gKiB0aGUgY2hlY2tcIiBpcyBuZXZlciByZXBvcnRlZCBhcyBcImNoZWNrIHBhc3NlZFwiIChjYXJyaWVkIG92ZXIgZnJvbVxuICogcHJpdmF0ZS1yZXBvLTEyIzU2Mywgd2hlcmUgYSBjaGVjayBleGl0ZWQgMCB3aGVuIGEgcHJlcmVxdWlzaXRlIHdhcyBhYnNlbnQpLlxuICpcbiAqIFRoZSBmYWlsdXJlIGNhcnJpZXMgYSBkaXN0aW5jdCBgcmVhc29uYCBhbmQgdGhlIGNhcHR1cmVkIGNvbW1hbmQgb3V0cHV0IHNvXG4gKiBjYWxsZXJzIGNhbiBzdXJmYWNlIHRoZSByZWFsIGNvbXBpbGVyIGVycm9yIHRvIHRoZSByZXRyeS9kaWFnbm9zaXMgcGF0aC5cbiAqXG4gKiBVc2VzIEF1c3RyYWxpYW4gRW5nbGlzaCB0aHJvdWdob3V0IChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uKS5cbiAqL1xuXG5pbXBvcnQgdHlwZSB7IFJlc3VsdCB9IGZyb20gXCIuLi90eXBlcy50c1wiO1xuaW1wb3J0IHsgVElNRU9VVF9FWElUX0NPREUgfSBmcm9tIFwiLi9naXRfdGltZW91dC50c1wiO1xuaW1wb3J0IHsgYnVpbGRVbnRydXN0ZWRDb21tYW5kRW52IH0gZnJvbSBcIi4vdW50cnVzdGVkX2NvbW1hbmRfZW52LnRzXCI7XG5pbXBvcnQgeyBidWlsZENhY2hlRW52Rm9yQ2hlY2tvdXQgfSBmcm9tIFwiLi9lcGhlbWVyYWxfYnVpbGRfY2FjaGUudHNcIjtcblxuLyoqXG4gKiBEZWZhdWx0IHBlci1jb21tYW5kIHRpbWVvdXQgaW4gc2Vjb25kcyAoSXNzdWUgIzM1NzcpLlxuICpcbiAqIFRoZXNlIGJ1aWxkcyBsZWdpdGltYXRlbHkgdGFrZSBtYW55IG1pbnV0ZXMsIHNvIHRoZSBkZWZhdWx0IGlzIGdlbmVyb3VzXG4gKiAoMzAgbWludXRlcykuIEEgdGltZW91dCBpcyBhICoqYmxvY2sqKiwgbmV2ZXIgYSBwYXNzLiBPdmVycmlkZSBwZXItZ2F0ZSB2aWFcbiAqIHtAbGluayBQcmVGbGlnaHRHYXRlT3B0aW9ucy50aW1lb3V0U2Vjb25kc30uXG4gKi9cbmV4cG9ydCBjb25zdCBQUkVfRkxJR0hUX0RFRkFVTFRfVElNRU9VVF9TRUNPTkRTID0gMTgwMDtcblxuLyoqXG4gKiBEaXN0aW5jdCBjbGFzc2lmaWNhdGlvbiBvZiBhIHByZS1mbGlnaHQgZmFpbHVyZS4gQXNzZXJ0IG9uIHRoaXMgKG5vdCBqdXN0IGFcbiAqIGJvb2xlYW4pIHNvIGEgZnV0dXJlIHJlZmFjdG9yIHRoYXQgc3dhbGxvd3MgYSBzcGF3biBlcnJvciBpbnRvIFwicGFzc2VkXCJcbiAqIGZhaWxzIGEgdGVzdC5cbiAqL1xuZXhwb3J0IHR5cGUgUHJlRmxpZ2h0RmFpbHVyZVJlYXNvbiA9XG4gIC8qKiBUaGUgY29tbWFuZCByYW4gdG8gY29tcGxldGlvbiBhbmQgZXhpdGVkIG5vbi16ZXJvIChcImNoZWNrIGZhaWxlZFwiKS4gKi9cbiAgfCBcIm5vbi16ZXJvLWV4aXRcIlxuICAvKiogVGhlIGNvbW1hbmQgY291bGQgbm90IGJlIHN0YXJ0ZWQgKG1pc3NpbmcgLyBub3QgZXhlY3V0YWJsZSAvIHVuc3RhcnRhYmxlKS4gKi9cbiAgfCBcIm5vdC1zdGFydGVkXCJcbiAgLyoqIFRoZSBjb21tYW5kIGV4Y2VlZGVkIGl0cyB0aW1lb3V0IGJlZm9yZSBjb21wbGV0aW5nLiAqL1xuICB8IFwidGltZW91dFwiO1xuXG4vKiogT3V0Y29tZSBvZiBydW5uaW5nIGEgc2luZ2xlIHByZS1mbGlnaHQgY29tbWFuZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJlRmxpZ2h0Q29tbWFuZFJlc3VsdCB7XG4gIC8qKiBGYWxzZSB3aGVuIHRoZSBjb21tYW5kIGNvdWxkIG5vdCBldmVuIGJlIHN0YXJ0ZWQgKHNwYXduIGZhaWx1cmUpLiAqL1xuICBzdGFydGVkOiBib29sZWFuO1xuICAvKiogRXhpdCBjb2RlLiBgVElNRU9VVF9FWElUX0NPREVgIG9uIHRpbWVvdXQ7IGAtMWAgd2hlbiBuZXZlciBzdGFydGVkLiAqL1xuICBjb2RlOiBudW1iZXI7XG4gIC8qKiBDYXB0dXJlZCBzdGFuZGFyZCBvdXRwdXQuICovXG4gIHN0ZG91dDogc3RyaW5nO1xuICAvKiogQ2FwdHVyZWQgc3RhbmRhcmQgZXJyb3IuICovXG4gIHN0ZGVycjogc3RyaW5nO1xuICAvKiogVHJ1ZSB3aGVuIHRoZSBjb21tYW5kIHdhcyBhYm9ydGVkIGJlY2F1c2UgaXQgZXhjZWVkZWQgdGhlIHRpbWVvdXQuICovXG4gIHRpbWVkT3V0PzogYm9vbGVhbjtcbn1cblxuLyoqIE9wdGlvbnMgZm9yIGEgc2luZ2xlIGNvbW1hbmQgcnVuLiAqL1xuZXhwb3J0IGludGVyZmFjZSBQcmVGbGlnaHRSdW5PcHRpb25zIHtcbiAgLyoqIFdvcmtpbmcgZGlyZWN0b3J5IHRoZSBjb21tYW5kIHJ1bnMgaW4uICovXG4gIGN3ZD86IHN0cmluZztcbiAgLyoqIEVudmlyb25tZW50IHZhcmlhYmxlcyBwYXNzZWQgdG8gdGhlIGNvbW1hbmQuICovXG4gIGVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIC8qKiBQZXItY29tbWFuZCB0aW1lb3V0IGluIHNlY29uZHMuICovXG4gIHRpbWVvdXRTZWNvbmRzOiBudW1iZXI7XG59XG5cbi8qKlxuICogUnVucyBhIHNpbmdsZSBwcmUtZmxpZ2h0IGNvbW1hbmQuIEluamVjdGFibGUgc28gdGVzdHMgY2FuIGV4ZXJjaXNlIHRoZSBnYXRlXG4gKiB3aXRob3V0IHNwYXduaW5nIHJlYWwgcHJvY2Vzc2VzLlxuICovXG5leHBvcnQgdHlwZSBQcmVGbGlnaHRSdW5uZXIgPSAoXG4gIGNvbW1hbmQ6IHN0cmluZyxcbiAgb3B0aW9uczogUHJlRmxpZ2h0UnVuT3B0aW9ucyxcbikgPT4gUHJvbWlzZTxQcmVGbGlnaHRDb21tYW5kUmVzdWx0PjtcblxuLyoqIE9wdGlvbnMgZm9yIHtAbGluayBydW5QcmVGbGlnaHRHYXRlfS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUHJlRmxpZ2h0R2F0ZU9wdGlvbnMge1xuICAvKiogV29ya2luZyBkaXJlY3RvcnkgdGhlIGNvbW1hbmRzIHJ1biBpbiAodGhlIHJlcG8gd29ya2luZyB0cmVlKS4gKi9cbiAgY3dkPzogc3RyaW5nO1xuICAvKiogRW52aXJvbm1lbnQgdmFyaWFibGVzIHBhc3NlZCB0byBlYWNoIGNvbW1hbmQuICovXG4gIGVudj86IFJlY29yZDxzdHJpbmcsIHN0cmluZz47XG4gIC8qKiBQZXItY29tbWFuZCB0aW1lb3V0IGluIHNlY29uZHMuIERlZmF1bHRzIHRvIHtAbGluayBQUkVfRkxJR0hUX0RFRkFVTFRfVElNRU9VVF9TRUNPTkRTfS4gKi9cbiAgdGltZW91dFNlY29uZHM/OiBudW1iZXI7XG4gIC8qKiBDb21tYW5kIHJ1bm5lciAoZGVmYXVsdHMgdG8gdGhlIHJlYWwgc3VicHJvY2VzcyBydW5uZXIpLiAqL1xuICBydW5uZXI/OiBQcmVGbGlnaHRSdW5uZXI7XG59XG5cbi8qKlxuICogRXJyb3IgcmFpc2VkIHdoZW4gdGhlIHByZS1mbGlnaHQgZ2F0ZSBibG9ja3MgYSBjb21taXQvcHVzaCAoSXNzdWUgIzM1NzcpLlxuICpcbiAqIENhcnJpZXMgdGhlIGRpc3RpbmN0IHtAbGluayByZWFzb259LCB0aGUgb2ZmZW5kaW5nIHtAbGluayBjb21tYW5kfSwgaXRzIGV4aXRcbiAqIHtAbGluayBleGl0Q29kZX0sIGFuZCB0aGUgY2FwdHVyZWQge0BsaW5rIG91dHB1dH0gKHN0ZG91dCArIHN0ZGVycikgc28gdGhlXG4gKiBmYWlsdXJlIGNhbiBiZSBzdXJmYWNlZCB2ZXJiYXRpbSB0byB0aGUgZml4ZXIuXG4gKi9cbmV4cG9ydCBjbGFzcyBQcmVGbGlnaHRHYXRlRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IHJlYXNvbjogUHJlRmxpZ2h0RmFpbHVyZVJlYXNvbjtcbiAgcmVhZG9ubHkgY29tbWFuZDogc3RyaW5nO1xuICByZWFkb25seSBleGl0Q29kZTogbnVtYmVyO1xuICByZWFkb25seSBvdXRwdXQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihhcmdzOiB7XG4gICAgcmVhc29uOiBQcmVGbGlnaHRGYWlsdXJlUmVhc29uO1xuICAgIGNvbW1hbmQ6IHN0cmluZztcbiAgICBleGl0Q29kZTogbnVtYmVyO1xuICAgIG91dHB1dDogc3RyaW5nO1xuICAgIG1lc3NhZ2U6IHN0cmluZztcbiAgfSkge1xuICAgIHN1cGVyKGFyZ3MubWVzc2FnZSk7XG4gICAgdGhpcy5uYW1lID0gXCJQcmVGbGlnaHRHYXRlRXJyb3JcIjtcbiAgICB0aGlzLnJlYXNvbiA9IGFyZ3MucmVhc29uO1xuICAgIHRoaXMuY29tbWFuZCA9IGFyZ3MuY29tbWFuZDtcbiAgICB0aGlzLmV4aXRDb2RlID0gYXJncy5leGl0Q29kZTtcbiAgICB0aGlzLm91dHB1dCA9IGFyZ3Mub3V0cHV0O1xuICB9XG59XG5cbi8qKlxuICogVG9rZW5pc2UgYSBjb21tYW5kIHN0cmluZyBpbnRvIGEgcHJvZ3JhbSBhbmQgaXRzIGFyZ3VtZW50cy5cbiAqXG4gKiBDb21tYW5kcyBydW4gKipkaXJlY3RseSoqIChub3QgdGhyb3VnaCBhIHNoZWxsKSwgc28gYSBtaXNzaW5nIG9yXG4gKiBub24tZXhlY3V0YWJsZSBwcm9ncmFtIHN1cmZhY2VzIGFzIGEgc3Bhd24gZmFpbHVyZSB3ZSBjYW4gY2xhc3NpZnkgYXNcbiAqIGBub3Qtc3RhcnRlZGAg4oCUIGRpc3RpbmN0IGZyb20gYSBzaGVsbCdzIGV4aXQgMTI3LiBTdXBwb3J0cyBzaW1wbGUgc2luZ2xlLVxuICogYW5kIGRvdWJsZS1xdW90ZWQgc2VnbWVudHM7IHNoZWxsIGZlYXR1cmVzIChwaXBlcywgcmVkaXJlY3RzLCBnbG9icykgYXJlXG4gKiBub3QgaW50ZXJwcmV0ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB0b2tlbmlzZUNvbW1hbmQoY29tbWFuZDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCB0b2tlbnM6IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHJlID0gL1wiKFteXCJdKilcInwnKFteJ10qKSd8KFxcUyspL2c7XG4gIGxldCBtYXRjaDogUmVnRXhwRXhlY0FycmF5IHwgbnVsbDtcbiAgd2hpbGUgKChtYXRjaCA9IHJlLmV4ZWMoY29tbWFuZCkpICE9PSBudWxsKSB7XG4gICAgdG9rZW5zLnB1c2gobWF0Y2hbMV0gPz8gbWF0Y2hbMl0gPz8gbWF0Y2hbM10gPz8gXCJcIik7XG4gIH1cbiAgcmV0dXJuIHRva2Vucztcbn1cblxuLyoqIERlZmF1bHQgcnVubmVyOiBzcGF3biB0aGUgY29tbWFuZCBkaXJlY3RseSB3aXRoIHRpbWVvdXQgcHJvdGVjdGlvbi4gKi9cbmFzeW5jIGZ1bmN0aW9uIGRlZmF1bHRQcmVGbGlnaHRSdW5uZXIoXG4gIGNvbW1hbmQ6IHN0cmluZyxcbiAgb3B0aW9uczogUHJlRmxpZ2h0UnVuT3B0aW9ucyxcbik6IFByb21pc2U8UHJlRmxpZ2h0Q29tbWFuZFJlc3VsdD4ge1xuICBjb25zdCB0b2tlbnMgPSB0b2tlbmlzZUNvbW1hbmQoY29tbWFuZCk7XG4gIGNvbnN0IHByb2dyYW0gPSB0b2tlbnNbMF07XG4gIGlmIChwcm9ncmFtID09PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhcnRlZDogZmFsc2UsXG4gICAgICBjb2RlOiAtMSxcbiAgICAgIHN0ZG91dDogXCJcIixcbiAgICAgIHN0ZGVycjogXCJlbXB0eSBjb21tYW5kIHN0cmluZ1wiLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBhcmdzID0gdG9rZW5zLnNsaWNlKDEpO1xuICBjb25zdCBjb250cm9sbGVyID0gbmV3IEFib3J0Q29udHJvbGxlcigpO1xuICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoXG4gICAgKCkgPT4gY29udHJvbGxlci5hYm9ydCgpLFxuICAgIG9wdGlvbnMudGltZW91dFNlY29uZHMgKiAxMDAwLFxuICApO1xuXG4gIHRyeSB7XG4gICAgY29uc3QgY21kID0gbmV3IERlbm8uQ29tbWFuZChwcm9ncmFtLCB7XG4gICAgICBhcmdzLFxuICAgICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICAgIC8vIFRoZSBwcmUtZmxpZ2h0IHNjcmlwdHMgYXJlIHN1cHBsaWVkIGJ5IHRoZSB0YXJnZXQgcmVwb3NpdG9yeSwgc28gdGhpc1xuICAgICAgLy8gaXMgY29kZSB0aGUgd29ya2VyIGRpZCBub3Qgd3JpdGUuIEl0cyBlbnZpcm9ubWVudCBpcyBCVUlMVCBmcm9tIHRoZVxuICAgICAgLy8gYWxsb3dsaXN0IHJhdGhlciB0aGFuIGluaGVyaXRlZCAoSXNzdWVzICM1NzIsICMxMjE0KTogYSByZXBvLWNvbW1pdHRlZFxuICAgICAgLy8gYC4vcHJlLWZsaWdodC5zaGAgb3RoZXJ3aXNlIHJhbiB3aXRoIGV2ZXJ5IGNyZWRlbnRpYWwgdGhlIHdvcmtlclxuICAgICAgLy8gaG9sZHMsIHdoaWNoIGlzIHRoZSB3aG9sZSBleHBsb2l0LiBDYWxsZXItc3VwcGxpZWQgdmFsdWVzIGFyZSBsYXllcmVkXG4gICAgICAvLyBvbiB0b3AsIHNvIGFuIGV4cGxpY2l0IG5lZWQgaXMgc3RpbGwgbWV0LlxuICAgICAgLy8gSXNzdWUgIzIyNDc6IHdoZXJlIHRoZSBydW50aW1lIHJlZnVzZXMgdG8gdHJpbSB0aGUgd29yayB2b2x1bWUsIGFcbiAgICAgIC8vIHByZS1mbGlnaHQgdGhhdCBidWlsZHMgd3JpdGVzIGl0cyBhcnRlZmFjdHMgdG8gdGhlIGNvbnRhaW5lcidzIG93blxuICAgICAgLy8gZXBoZW1lcmFsIGxheWVyIHJhdGhlciB0aGFuIHJhdGNoZXR0aW5nIHRoZSB2b2x1bWUncyBzcGFyc2UgaW1hZ2UuXG4gICAgICBlbnY6IGJ1aWxkVW50cnVzdGVkQ29tbWFuZEVudih7XG4gICAgICAgIG92ZXJyaWRlczoge1xuICAgICAgICAgIC4uLmJ1aWxkQ2FjaGVFbnZGb3JDaGVja291dChvcHRpb25zLmN3ZCksXG4gICAgICAgICAgLi4uKG9wdGlvbnMuZW52ID8/IHt9KSxcbiAgICAgICAgfSxcbiAgICAgIH0pLFxuICAgICAgY2xlYXJFbnY6IHRydWUsXG4gICAgICBzdGRvdXQ6IFwicGlwZWRcIixcbiAgICAgIHN0ZGVycjogXCJwaXBlZFwiLFxuICAgICAgc2lnbmFsOiBjb250cm9sbGVyLnNpZ25hbCxcbiAgICB9KTtcbiAgICBjb25zdCBvdXQgPSBhd2FpdCBjbWQub3V0cHV0KCk7XG4gICAgY2xlYXJUaW1lb3V0KHRpbWVyKTtcbiAgICByZXR1cm4ge1xuICAgICAgc3RhcnRlZDogdHJ1ZSxcbiAgICAgIGNvZGU6IG91dC5jb2RlLFxuICAgICAgc3Rkb3V0OiBuZXcgVGV4dERlY29kZXIoKS5kZWNvZGUob3V0LnN0ZG91dCksXG4gICAgICBzdGRlcnI6IG5ldyBUZXh0RGVjb2RlcigpLmRlY29kZShvdXQuc3RkZXJyKSxcbiAgICB9O1xuICB9IGNhdGNoIChlcnIpIHtcbiAgICBjbGVhclRpbWVvdXQodGltZXIpO1xuICAgIGlmIChlcnIgaW5zdGFuY2VvZiBET01FeGNlcHRpb24gJiYgZXJyLm5hbWUgPT09IFwiQWJvcnRFcnJvclwiKSB7XG4gICAgICAvLyBBYm9ydGVkIGJ5IHRoZSB0aW1lb3V0IOKAlCBhIEJMT0NLLCBuZXZlciBhIHBhc3MuXG4gICAgICByZXR1cm4ge1xuICAgICAgICBzdGFydGVkOiB0cnVlLFxuICAgICAgICBjb2RlOiBUSU1FT1VUX0VYSVRfQ09ERSxcbiAgICAgICAgc3Rkb3V0OiBcIlwiLFxuICAgICAgICBzdGRlcnI6IGB0aW1lZCBvdXQgYWZ0ZXIgJHtvcHRpb25zLnRpbWVvdXRTZWNvbmRzfXNgLFxuICAgICAgICB0aW1lZE91dDogdHJ1ZSxcbiAgICAgIH07XG4gICAgfVxuICAgIC8vIERlbm8uZXJyb3JzLk5vdEZvdW5kIC8gUGVybWlzc2lvbkRlbmllZCAvIGFueSBvdGhlciBzcGF3biBmYWlsdXJlIOKAlFxuICAgIC8vIHRoZSBjb21tYW5kIGNvdWxkIG5vdCBiZSBzdGFydGVkLCBzbyB0aGlzIGlzIGEgQkxPQ0suXG4gICAgcmV0dXJuIHtcbiAgICAgIHN0YXJ0ZWQ6IGZhbHNlLFxuICAgICAgY29kZTogLTEsXG4gICAgICBzdGRvdXQ6IFwiXCIsXG4gICAgICBzdGRlcnI6IGVyciBpbnN0YW5jZW9mIEVycm9yID8gZXJyLm1lc3NhZ2UgOiBTdHJpbmcoZXJyKSxcbiAgICB9O1xuICB9XG59XG5cbi8qKiBUcmltIGFuZCBqb2luIHN0ZG91dC9zdGRlcnIgZm9yIHN1cmZhY2luZyB0byB0aGUgZml4ZXIuICovXG5mdW5jdGlvbiBjb21iaW5lT3V0cHV0KHJlc3VsdDogUHJlRmxpZ2h0Q29tbWFuZFJlc3VsdCk6IHN0cmluZyB7XG4gIHJldHVybiBbcmVzdWx0LnN0ZG91dCwgcmVzdWx0LnN0ZGVycl1cbiAgICAubWFwKChzKSA9PiBzLnRyaW0oKSlcbiAgICAuZmlsdGVyKChzKSA9PiBzLmxlbmd0aCA+IDApXG4gICAgLmpvaW4oXCJcXG5cIik7XG59XG5cbi8qKlxuICogUnVuIGEgcmVwbydzIHByZS1mbGlnaHQgY29tbWFuZHMgaW4gbGlzdGVkIG9yZGVyLCBzdG9wcGluZyBhdCB0aGUgZmlyc3RcbiAqIGZhaWx1cmUgKElzc3VlICMzNTc3KS5cbiAqXG4gKiAtIEVtcHR5IGBjb21tYW5kc2Ag4oaSIGBPa2AgaW1tZWRpYXRlbHksIG5vIHJ1bm5lciBpbnZva2VkICh6ZXJvIGFkZGVkXG4gKiAgIGxhdGVuY3kgZm9yIHJlcG9zIHdpdGggbm8gZ2F0ZSkuXG4gKiAtIEEgY29tbWFuZCB0aGF0IGNhbm5vdCBiZSBzdGFydGVkIOKGkiBgRXJyYCB3aXRoIHJlYXNvbiBgbm90LXN0YXJ0ZWRgIGFuZCBhXG4gKiAgIG1lc3NhZ2UgZGlzdGluY3QgZnJvbSBcImNoZWNrIGZhaWxlZFwiLlxuICogLSBBIGNvbW1hbmQgdGhhdCB0aW1lcyBvdXQg4oaSIGBFcnJgIHdpdGggcmVhc29uIGB0aW1lb3V0YC5cbiAqIC0gQSBjb21tYW5kIHRoYXQgZXhpdHMgbm9uLXplcm8g4oaSIGBFcnJgIHdpdGggcmVhc29uIGBub24temVyby1leGl0YC5cbiAqXG4gKiBAcGFyYW0gY29tbWFuZHMgQ29tbWFuZHMgdG8gcnVuIChmcm9tIGBnZXRQcmVGbGlnaHRDb21tYW5kc2ApLlxuICogQHBhcmFtIG9wdGlvbnMgV29ya2luZyB0cmVlLCBlbnYsIHRpbWVvdXQsIGFuZCBpbmplY3RhYmxlIHJ1bm5lci5cbiAqIEByZXR1cm5zIGBPayh2b2lkKWAgd2hlbiBldmVyeSBjb21tYW5kIHBhc3NlZDsgYSBgUHJlRmxpZ2h0R2F0ZUVycm9yYFxuICogICBvdGhlcndpc2UuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5QcmVGbGlnaHRHYXRlKFxuICBjb21tYW5kczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIG9wdGlvbnM6IFByZUZsaWdodEdhdGVPcHRpb25zID0ge30sXG4pOiBQcm9taXNlPFJlc3VsdDx2b2lkLCBQcmVGbGlnaHRHYXRlRXJyb3I+PiB7XG4gIGlmIChjb21tYW5kcy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHVuZGVmaW5lZCB9O1xuICB9XG5cbiAgY29uc3QgcnVubmVyID0gb3B0aW9ucy5ydW5uZXIgPz8gZGVmYXVsdFByZUZsaWdodFJ1bm5lcjtcbiAgY29uc3QgdGltZW91dFNlY29uZHMgPSBvcHRpb25zLnRpbWVvdXRTZWNvbmRzID8/XG4gICAgUFJFX0ZMSUdIVF9ERUZBVUxUX1RJTUVPVVRfU0VDT05EUztcblxuICBmb3IgKGNvbnN0IGNvbW1hbmQgb2YgY29tbWFuZHMpIHtcbiAgICBjb25zdCByZXN1bHQgPSBhd2FpdCBydW5uZXIoY29tbWFuZCwge1xuICAgICAgY3dkOiBvcHRpb25zLmN3ZCxcbiAgICAgIGVudjogb3B0aW9ucy5lbnYsXG4gICAgICB0aW1lb3V0U2Vjb25kcyxcbiAgICB9KTtcbiAgICBjb25zdCBvdXRwdXQgPSBjb21iaW5lT3V0cHV0KHJlc3VsdCk7XG5cbiAgICBpZiAoIXJlc3VsdC5zdGFydGVkKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgUHJlRmxpZ2h0R2F0ZUVycm9yKHtcbiAgICAgICAgICByZWFzb246IFwibm90LXN0YXJ0ZWRcIixcbiAgICAgICAgICBjb21tYW5kLFxuICAgICAgICAgIGV4aXRDb2RlOiByZXN1bHQuY29kZSxcbiAgICAgICAgICBvdXRwdXQsXG4gICAgICAgICAgbWVzc2FnZTpcbiAgICAgICAgICAgIGBQcmUtZmxpZ2h0IGdhdGUgQkxPQ0sgKElzc3VlICMzNTc3KTogY29tbWFuZCBcXGAke2NvbW1hbmR9XFxgIGAgK1xuICAgICAgICAgICAgYGNvdWxkIG5vdCBiZSBzdGFydGVkIChtaXNzaW5nLCBub3QgZXhlY3V0YWJsZSwgb3IgdW5zdGFydGFibGUpLiBgICtcbiAgICAgICAgICAgIGBcIkNvdWxkIG5vdCBydW4gdGhlIGNoZWNrXCIgaXMgdHJlYXRlZCBhcyBhIGJsb2NrLCBuZXZlciBhIHBhc3MuYCArXG4gICAgICAgICAgICAob3V0cHV0ID8gYFxcblxcbiR7b3V0cHV0fWAgOiBcIlwiKSxcbiAgICAgICAgfSksXG4gICAgICB9O1xuICAgIH1cblxuICAgIGlmIChyZXN1bHQudGltZWRPdXQgfHwgcmVzdWx0LmNvZGUgPT09IFRJTUVPVVRfRVhJVF9DT0RFKSB7XG4gICAgICByZXR1cm4ge1xuICAgICAgICBvazogZmFsc2UsXG4gICAgICAgIGVycm9yOiBuZXcgUHJlRmxpZ2h0R2F0ZUVycm9yKHtcbiAgICAgICAgICByZWFzb246IFwidGltZW91dFwiLFxuICAgICAgICAgIGNvbW1hbmQsXG4gICAgICAgICAgZXhpdENvZGU6IFRJTUVPVVRfRVhJVF9DT0RFLFxuICAgICAgICAgIG91dHB1dCxcbiAgICAgICAgICBtZXNzYWdlOlxuICAgICAgICAgICAgYFByZS1mbGlnaHQgZ2F0ZSBCTE9DSyAoSXNzdWUgIzM1NzcpOiBjb21tYW5kIFxcYCR7Y29tbWFuZH1cXGAgYCArXG4gICAgICAgICAgICBgdGltZWQgb3V0IGFmdGVyICR7dGltZW91dFNlY29uZHN9cy4gQSB0aW1lb3V0IGlzIGEgYmxvY2ssIGAgK1xuICAgICAgICAgICAgYG5ldmVyIGEgcGFzcy5gICsgKG91dHB1dCA/IGBcXG5cXG4ke291dHB1dH1gIDogXCJcIiksXG4gICAgICAgIH0pLFxuICAgICAgfTtcbiAgICB9XG5cbiAgICBpZiAocmVzdWx0LmNvZGUgIT09IDApIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IG5ldyBQcmVGbGlnaHRHYXRlRXJyb3Ioe1xuICAgICAgICAgIHJlYXNvbjogXCJub24temVyby1leGl0XCIsXG4gICAgICAgICAgY29tbWFuZCxcbiAgICAgICAgICBleGl0Q29kZTogcmVzdWx0LmNvZGUsXG4gICAgICAgICAgb3V0cHV0LFxuICAgICAgICAgIG1lc3NhZ2U6XG4gICAgICAgICAgICBgUHJlLWZsaWdodCBnYXRlIEJMT0NLIChJc3N1ZSAjMzU3Nyk6IGNvbW1hbmQgXFxgJHtjb21tYW5kfVxcYCBgICtcbiAgICAgICAgICAgIGBmYWlsZWQgd2l0aCBleGl0IGNvZGUgJHtyZXN1bHQuY29kZX0uIEZpeCB0aGUgZmFpbHVyZSBhbmQgcmV0cnkgYCArXG4gICAgICAgICAgICBg4oCUIHRoZSBjb21taXQgYW5kIHB1c2ggYXJlIGJsb2NrZWQuYCArXG4gICAgICAgICAgICAob3V0cHV0ID8gYFxcblxcbiR7b3V0cHV0fWAgOiBcIlwiKSxcbiAgICAgICAgfSksXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIHJldHVybiB7IG9rOiB0cnVlLCB2YWx1ZTogdW5kZWZpbmVkIH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBb0JDLEdBR0QsU0FBUyxpQkFBaUIsUUFBUSxtQkFBbUI7QUFDckQsU0FBUyx3QkFBd0IsUUFBUSw2QkFBNkI7QUFDdEUsU0FBUyx3QkFBd0IsUUFBUSw2QkFBNkI7QUFFdEU7Ozs7OztDQU1DLEdBQ0QsT0FBTyxNQUFNLHFDQUFxQyxLQUFLO0FBNER2RDs7Ozs7O0NBTUMsR0FDRCxPQUFPLE1BQU0sMkJBQTJCO0VBQzdCLE9BQStCO0VBQy9CLFFBQWdCO0VBQ2hCLFNBQWlCO0VBQ2pCLE9BQWU7RUFFeEIsWUFBWSxJQU1YLENBQUU7SUFDRCxLQUFLLENBQUMsS0FBSyxPQUFPO0lBQ2xCLElBQUksQ0FBQyxJQUFJ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
// denoCacheMetadata=443477092064015223,72048951199649564