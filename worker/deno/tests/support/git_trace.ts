/**
 * Record the argv of every git command a code path runs (Issue #2807).
 *
 * `GIT_TRACE=<absolute path>` makes git append one `trace: built-in: git …`
 * line per command it runs to that file. Passing the env through
 * `GitCommandOptions.env` records exactly what the worker ran, so a test can
 * assert over real argv — "no push carried `--force`" — without a mock.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

/** A recorder whose `env` is passed to the code under test. */
export interface GitTraceRecorder {
  /** Env to merge into `GitCommandOptions.env`. */
  env: Record<string, string>;
  /** The argv (after `git`) of every recorded command, in order. */
  commands: () => Promise<string[][]>;
  /** Delete the trace file. */
  dispose: () => Promise<void>;
}

const BUILT_IN = "trace: built-in: git ";

/** Split a traced argv; git single-quotes an argument with special characters. */
function splitTracedArgs(text: string): string[] {
  return (text.match(/'[^']*'|\S+/g) ?? []).map((arg) =>
    arg.startsWith("'") && arg.endsWith("'") ? arg.slice(1, -1) : arg
  );
}

/** Start recording git commands into a fresh temporary trace file. */
export async function startGitTrace(): Promise<GitTraceRecorder> {
  const path = await Deno.makeTempFile({ prefix: "git_trace_" });
  return {
    env: { GIT_TRACE: path },
    commands: async () => {
      const text = await Deno.readTextFile(path);
      return text.split("\n")
        .filter((line) => line.includes(BUILT_IN))
        .map((line) =>
          splitTracedArgs(line.slice(line.indexOf(BUILT_IN) + BUILT_IN.length))
        );
    },
    dispose: () => Deno.remove(path).catch(() => {}),
  };
}

/** Every recorded `git push` argv. */
export async function recordedPushes(
  recorder: GitTraceRecorder,
): Promise<string[][]> {
  return (await recorder.commands()).filter((argv) => argv[0] === "push");
}

/** Whether any recorded push forced: `--force*`, `-f` or a `+refspec`. */
export function isForcedPush(argv: readonly string[]): boolean {
  return argv.some((arg) =>
    arg.startsWith("--force") || arg === "-f" || arg.startsWith("+")
  );
}

/** Whether any recorded command is a `git rebase`. */
export async function recordedRebase(
  recorder: GitTraceRecorder,
): Promise<boolean> {
  return (await recorder.commands()).some((argv) => argv[0] === "rebase");
}
