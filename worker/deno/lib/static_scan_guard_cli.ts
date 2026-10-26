/**
 * `PreToolUse` guard entry point for the best-practices scan (Issue #4415).
 *
 * The Claude CLI spawns this for every Bash call in a best-practices scan
 * session whose `--settings` carry {@link buildStaticScanHookSettings}. It
 * reads the hook payload from stdin, asks {@link decideStaticScanHook} whether
 * the command invokes a build tool, and denies the call when it does.
 *
 * Unlike the issue executor's edit guard (`issue_edit_guard_cli.ts`), this
 * guard FAILS CLOSED. A payload it cannot parse is denied, not allowed: the
 * scan has no other defence against a build tool, and a scan that cannot read
 * its own calls must not run them. The denial is written as the CLI's
 * `PreToolUse` deny shape on stdout, and the log line on stderr.
 *
 * Exits `0` whatever it decides, so a denial is a refused tool call the agent
 * is told about, never a failed run.
 *
 * Uses Australian English throughout (behaviour, artefacts, organisation, etc.).
 */

import { installConsoleRedaction } from "./console_redaction.ts";
import {
  type IssueEditHookDecision,
  renderIssueEditHookOutput,
} from "./issue_executor_enforcement.ts";
import {
  decideStaticScanHook,
  STATIC_SCAN_DENIAL_MARKER,
} from "./static_scan_guard.ts";

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
 * The log line a denial writes, naming the tool that was denied.
 *
 * @param tool - The denied tool or word, e.g. `cargo`
 * @returns A single line, no trailing newline
 */
function formatStaticScanDenialLog(tool: string): string {
  return `${STATIC_SCAN_DENIAL_MARKER} denied ${tool} in the static ` +
    `best-practices scan; the run continues without it (Issue #4415).`;
}

/**
 * Run the guard over one hook payload.
 *
 * A payload that does not parse is denied. The scan cannot tell what the agent
 * asked to run, so it refuses the call rather than letting it through.
 *
 * @param raw - The payload text the CLI wrote to stdin
 * @param write - Sink for the decision (stdout) and the log line (stderr)
 */
export function runStaticScanGuard(
  raw: string,
  write: { out: (text: string) => void; err: (text: string) => void },
): void {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const decision: IssueEditHookDecision = {
      deny: true,
      tool: "payload",
      reason: `${STATIC_SCAN_DENIAL_MARKER} guard could not parse its hook ` +
        `payload (${message}); the scan fails closed and the call is denied ` +
        `(Issue #4415).`,
    };
    write.out(renderIssueEditHookOutput(decision));
    write.err(
      `${STATIC_SCAN_DENIAL_MARKER} denied: unparseable hook payload ` +
        `(${message}); failing closed (Issue #4415).`,
    );
    return;
  }

  const decision = decideStaticScanHook(payload);
  if (!decision.deny) return;
  write.out(renderIssueEditHookOutput(decision));
  write.err(formatStaticScanDenialLog(decision.tool));
}

if (import.meta.main) {
  // Issue #1280: this guard is its own process, and the payload it echoes —
  // the denied command word — comes from the agent's session.
  installConsoleRedaction();

  runStaticScanGuard(await readStdin(), {
    out: (text) => console.log(text),
    err: (text) => console.error(text),
  });
}
