/**
 * Entry point of the agent's git `pre-push` hook (Issue #3394).
 *
 * Run as `deno run --quiet --no-config --no-lock --allow-read --allow-run
 * --allow-env pre_push_gate_cli.ts --spec <path> [-- <remote> <url>]`. It must
 * work under `--no-config`, so nothing in its import graph may rely on an
 * import map (no bare specifiers at runtime).
 *
 * The spec is JSON: `{ "preFlightCommands": string[], "timeoutSeconds"?: n }`.
 * A missing or invalid spec, unreadable stdin or any thrown error blocks the
 * push (exit 1). Git's own hook arguments (remote name, URL) are ignored.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import { parsePreFlightCommands } from "./repo_config.ts";
import { installConsoleRedaction } from "./console_redaction.ts";
import { runPrePushGate } from "./pre_push_gate.ts";

/** Injectable seams. */
export interface PrePushCliDeps {
  readStdin?: () => Promise<string>;
  cwd?: () => string;
  gate?: typeof runPrePushGate;
  writeErr?: (text: string) => void;
}

interface PrePushSpec {
  preFlightCommands: string[];
  timeoutSeconds?: number;
}

async function readSpec(path: string): Promise<Result<PrePushSpec, string>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await Deno.readTextFile(path));
  } catch (error) {
    return {
      ok: false,
      error: `cannot read pre-push spec ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "pre-push spec must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const commands = parsePreFlightCommands(record.preFlightCommands ?? []);
  if (!commands.ok) return { ok: false, error: commands.error };
  const timeout = record.timeoutSeconds;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0)
  ) {
    return {
      ok: false,
      error: "timeoutSeconds must be a positive integer",
    };
  }
  return {
    ok: true,
    value: { preFlightCommands: commands.value, timeoutSeconds: timeout },
  };
}

/** Run the hook. Returns the process exit code (0 allows the push). */
export async function runPrePushGateCli(
  args: string[],
  deps: PrePushCliDeps = {},
): Promise<number> {
  const writeErr = deps.writeErr ??
    ((text: string) => {
      Deno.stderr.writeSync(new TextEncoder().encode(text));
    });
  const block = (message: string): number => {
    writeErr(`[PRE_PUSH_BLOCKED] ${message}\n`);
    return 1;
  };

  try {
    const specIndex = args.indexOf("--spec");
    const dashDash = args.indexOf("--");
    const specPath =
      specIndex === -1 || (dashDash !== -1 && specIndex > dashDash)
        ? undefined
        : args[specIndex + 1];
    if (!specPath) return block("missing --spec <path> argument");

    const spec = await readSpec(specPath);
    if (!spec.ok) return block(spec.error);

    let stdin: string;
    try {
      stdin = await (deps.readStdin ?? readProcessStdin)();
    } catch (error) {
      return block(
        `cannot read hook input: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const gate = deps.gate ?? runPrePushGate;
    const result = await gate({
      cwd: (deps.cwd ?? Deno.cwd)(),
      stdin,
      preFlightCommands: spec.value.preFlightCommands,
      timeoutSeconds: spec.value.timeoutSeconds,
    });
    if (!result.ok) {
      writeErr(
        `[PRE_PUSH_BLOCKED] ${result.error.message}\n` +
          "Fix the failure above and push again; never bypass this gate.\n",
      );
      return 1;
    }
    writeErr(
      `pre-push gate passed (${result.value.checksRun.length} changed-file ` +
        `checks, ${spec.value.preFlightCommands.length} pre-flight commands)\n`,
    );
    return 0;
  } catch (error) {
    return block(error instanceof Error ? error.message : String(error));
  }
}

async function readProcessStdin(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
}

if (import.meta.main) {
  installConsoleRedaction();
  Deno.exit(await runPrePushGateCli(Deno.args));
}
