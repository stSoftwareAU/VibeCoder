/**
 * Entry point of the agent's git `pre-push` hook (Issue #3394).
 *
 * Run as `deno run --quiet --no-config --no-lock --allow-read
 * --allow-write=<tmp> --allow-run --allow-env pre_push_gate_cli.ts
 * --spec <path> [-- <remote> <url>]`. It must work under `--no-config`, so
 * nothing in its import graph may rely on an import map (no bare specifiers at
 * runtime).
 *
 * The spec is JSON: `{ "preFlightCommands": string[], "timeoutSeconds"?: n,
 * "ciCargo"?: CiCargoScan, "compareRef"?: string }`. The `ciCargo` entry is
 * the repo's CI cargo checks, precomputed by the worker before the agent runs
 * (Issue #4630 review): the hook passes them back as `findCiCargo` so the CI cargo checks
 * run on the agent's own push without this module loading the YAML parser.
 * `compareRef` is the PR base (`origin/<branch>`, or `""` when a comparison is
 * required but the base is unknown): a CI cargo failure the base already has is
 * no verdict on the push, and an unavailable comparison is infrastructure.
 * A missing or invalid spec, unreadable stdin or any thrown error blocks the
 * push (exit 1). Git's own hook arguments (remote name, URL) are ignored.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import type { Result } from "../types.ts";
import type { CiCargoScan } from "./ci_cargo_checks.ts";
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
  ciCargo?: CiCargoScan;
  compareRef?: string;
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
  const ciCargo = readCiCargo(record.ciCargo);
  if (!ciCargo.ok) return { ok: false, error: ciCargo.error };
  const compareRef = record.compareRef;
  if (compareRef !== undefined && typeof compareRef !== "string") {
    return { ok: false, error: "compareRef must be a string" };
  }
  return {
    ok: true,
    value: {
      preFlightCommands: commands.value,
      timeoutSeconds: timeout,
      ciCargo: ciCargo.value,
      compareRef,
    },
  };
}

/**
 * The `ciCargo` entry of the hook spec, validated shape-only. Absent is not an
 * error; a present but malformed entry blocks the push rather than being run.
 */
function readCiCargo(raw: unknown): Result<CiCargoScan | undefined, string> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, error: "ciCargo must be a JSON object" };
  }
  const record = raw as Record<string, unknown>;
  const rawChecks = record.checks;
  const rawUnverifiable = record.unverifiable;
  if (!Array.isArray(rawChecks)) {
    return { ok: false, error: "ciCargo.checks must be an array" };
  }
  if (rawUnverifiable !== undefined && !Array.isArray(rawUnverifiable)) {
    return { ok: false, error: "ciCargo.unverifiable must be an array" };
  }
  const checks: CiCargoScan["checks"] = [];
  for (const entry of rawChecks) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: "ciCargo.checks entries must be objects" };
    }
    const check = entry as Record<string, unknown>;
    if (check.kind !== "clippy" && check.kind !== "test-build") {
      return {
        ok: false,
        error: `ciCargo.checks entry has an invalid kind: ${
          JSON.stringify(check.kind)
        }`,
      };
    }
    if (typeof check.workingDirectory !== "string") {
      return {
        ok: false,
        error: "ciCargo.checks entry has a non-string workingDirectory",
      };
    }
    if (
      !Array.isArray(check.argv) ||
      !check.argv.every((word) => typeof word === "string")
    ) {
      return {
        ok: false,
        error: "ciCargo.checks entry has a non-string-array argv",
      };
    }
    if (typeof check.source !== "string") {
      return {
        ok: false,
        error: "ciCargo.checks entry has a non-string source",
      };
    }
    const env: Record<string, string> = {};
    if (check.env !== undefined) {
      if (
        typeof check.env !== "object" || check.env === null ||
        Array.isArray(check.env)
      ) {
        return {
          ok: false,
          error: "ciCargo.checks entry has a non-object env",
        };
      }
      for (
        const [key, value] of Object.entries(
          check.env as Record<string, unknown>,
        )
      ) {
        if (typeof value !== "string") {
          return {
            ok: false,
            error: `ciCargo.checks entry env key ${
              JSON.stringify(key)
            } is not a string`,
          };
        }
        env[key] = value;
      }
    }
    checks.push({
      kind: check.kind,
      workingDirectory: check.workingDirectory,
      argv: check.argv,
      env,
      source: check.source,
    });
  }
  const unverifiable: string[] = [];
  if (rawUnverifiable !== undefined) {
    for (const entry of rawUnverifiable) {
      if (typeof entry !== "string") {
        return {
          ok: false,
          error: "ciCargo.unverifiable entries must be strings",
        };
      }
      unverifiable.push(entry);
    }
  }
  return { ok: true, value: { checks, unverifiable } };
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
    const ciCargo = spec.value.ciCargo;
    const result = await gate({
      cwd: (deps.cwd ?? Deno.cwd)(),
      stdin,
      preFlightCommands: spec.value.preFlightCommands,
      timeoutSeconds: spec.value.timeoutSeconds,
      ...(ciCargo === undefined ? {} : { findCiCargo: async () => ciCargo }),
      ...(spec.value.compareRef === undefined
        ? {}
        : { compareRef: spec.value.compareRef }),
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
