/**
 * `PreToolUse` guard entry point for a split `issue` run (Issue #2344).
 *
 * The Claude CLI spawns this for every `Edit`/`Write` call in a run whose
 * `--settings` carry {@link buildIssueExecutorHookSettings}. It reads the hook
 * payload from stdin, asks {@link decideIssueEditHook} who called the tool,
 * and denies the advisor's own edits while letting an executor's through.
 *
 * Exits `0` whatever it decides: a denial is a refused tool call the advisor
 * is told about, never a failed run. A payload it cannot read is allowed and
 * said so loudly on stderr — the guard is one of two defences (the run's own
 * advisor-edit count is the other), and failing closed here would strand a
 * run whose executors could no longer edit anything.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import {
  decideIssueEditHook,
  formatIssueEditDenialLog,
  ISSUE_EXECUTOR_DENIAL_MARKER,
  renderIssueEditHookOutput,
} from "./issue_executor_enforcement.ts";

/** Read all of stdin as text. */
async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Deno.stdin.readable) chunks.push(chunk);
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(joined);
}

/**
 * Run the guard over one hook payload.
 *
 * @param raw - The payload text the CLI wrote to stdin
 * @param write - Sink for the decision (stdout) and the log line (stderr)
 */
export function runIssueEditGuard(
  raw: string,
  write: { out: (text: string) => void; err: (text: string) => void },
): void {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    write.err(
      `${ISSUE_EXECUTOR_DENIAL_MARKER} guard could not parse its hook ` +
        `payload (${
          error instanceof Error ? error.message : String(error)
        }); ` +
        `the call was allowed and the advisor edit count is the record.`,
    );
    return;
  }

  const decision = decideIssueEditHook(payload);
  if (!decision.deny) return;
  write.out(renderIssueEditHookOutput(decision));
  write.err(formatIssueEditDenialLog(decision.tool));
}

if (import.meta.main) {
  runIssueEditGuard(await readStdin(), {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  });
}
