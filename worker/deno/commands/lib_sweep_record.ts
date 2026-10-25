/**
 * Record a sweep-ledger slice with `sweptAt` set to
 * `git merge-base origin/main HEAD` (Issue #4235).
 *
 * Agents must not type the commit themselves. A caller-supplied SHA is
 * refused. A failed merge-base is an error and writes nothing.
 *
 * Australian English spelling throughout (behaviour, colour, organisation).
 */

import { installConsoleRedaction } from "../lib/console_redaction.ts";
import { runGitCommand } from "../lib/git_timeout.ts";
import {
  type LibSweepRecordRequest,
  recordLibSweepSlice,
  type SweepGitRunner,
  type SweepSliceStatus,
} from "../lib/lib_sweep_coverage.ts";
import type { Command, CommandResult, WorkerConfig } from "../types.ts";

/** Parsed `lib-sweep-record` arguments. `sweptAt` is not accepted. */
export interface LibSweepRecordArgs extends LibSweepRecordRequest {
  repo: string;
}

/**
 * Parse CLI flags. `--swept-at` / `--sweptAt` is an error: this command
 * computes the commit.
 */
export function parseLibSweepRecordArgs(
  argv: readonly string[],
): { ok: true; value: LibSweepRecordArgs } | { ok: false; error: string } {
  const paths: string[] = [];
  let slice = "";
  let status = "";
  let repo = "";
  let issue: number | undefined;
  let title = "";
  let ledger = "";
  let definition = "";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    const take = (): string => {
      if (value === undefined || value.startsWith("-")) {
        throw new Error(`${flag} requires a value`);
      }
      i++;
      return value;
    };
    try {
      switch (flag) {
        case "--slice":
          slice = take();
          break;
        case "--status":
          status = take();
          break;
        case "--paths":
          paths.push(take());
          break;
        case "--repo":
          repo = take();
          break;
        case "--issue": {
          const raw = take();
          if (!/^[1-9]\d*$/.test(raw)) {
            throw new Error("--issue must be a positive integer");
          }
          issue = Number(raw);
          break;
        }
        case "--title":
          title = take();
          break;
        case "--ledger":
          ledger = take();
          break;
        case "--definition":
          definition = take();
          break;
        case "--swept-at":
        case "--sweptAt":
          throw new Error(
            "sweptAt is computed as git merge-base origin/main HEAD; do not pass it",
          );
        default:
          throw new Error(`unknown argument ${flag}`);
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  if (slice === "") return { ok: false, error: "missing --slice" };
  if (status === "") return { ok: false, error: "missing --status" };
  if (paths.length === 0) return { ok: false, error: "missing --paths" };
  return {
    ok: true,
    value: {
      slice,
      status: status as SweepSliceStatus,
      paths,
      repo: repo === "" ? Deno.cwd() : repo,
      issue,
      title: title === "" ? undefined : title,
      ledger: ledger === "" ? undefined : ledger,
      definition: definition === "" ? undefined : definition,
    },
  };
}

export const libSweepRecordCommand: Command = {
  name: "lib-sweep-record",
  description:
    "Write a sweep-ledger slice with sweptAt set to git merge-base origin/main HEAD (Issue #4235)",

  async execute(
    args: Record<string, unknown>,
    _config: WorkerConfig,
  ): Promise<CommandResult<{ sweptAt: string }>> {
    const request: LibSweepRecordRequest = {
      slice: typeof args.slice === "string" ? args.slice : "",
      status: args.status as SweepSliceStatus,
      paths: Array.isArray(args.paths)
        ? args.paths.filter((path): path is string => typeof path === "string")
        : [],
      issue: typeof args.issue === "number" ? args.issue : undefined,
      title: typeof args.title === "string" ? args.title : undefined,
      ledger: typeof args.ledger === "string" ? args.ledger : undefined,
      definition: typeof args.definition === "string"
        ? args.definition
        : undefined,
    };
    const repo = typeof args.repo === "string" && args.repo.length > 0
      ? args.repo
      : Deno.cwd();
    const runGit: SweepGitRunner = async (gitArgs) => {
      const result = await runGitCommand([...gitArgs], { cwd: repo });
      if (!result.ok) {
        return { code: 1, stdout: "", stderr: result.error.message };
      }
      return result.value;
    };
    const recorded = await recordLibSweepSlice(repo, request, runGit);
    if (!recorded.ok) {
      return { success: false, message: recorded.error.message };
    }
    return {
      success: true,
      message:
        `Recorded ${recorded.value.chunk} sweptAt ${recorded.value.sweptAt}`,
      data: { sweptAt: recorded.value.sweptAt },
    };
  },
};

/** Process entry. Returns the exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseLibSweepRecordArgs(argv);
  if (!parsed.ok) {
    console.log(parsed.error);
    return 1;
  }
  const { repo, ...request } = parsed.value;
  const result = await libSweepRecordCommand.execute(
    { ...request, repo },
    {} as WorkerConfig,
  );
  console.log(result.message);
  return result.success ? 0 : 1;
}

if (import.meta.main) {
  installConsoleRedaction();
  Deno.exit(await main(Deno.args));
}
