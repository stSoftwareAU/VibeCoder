/**
 * Gemini's per-run settings file (Issue #5341).
 *
 * The Gemini CLI reads its system settings from the path named in the
 * `GEMINI_CLI_SYSTEM_SETTINGS_PATH` environment variable. Each run writes its
 * own file there, enforcing the run's denied tools, so a denial reaches the
 * CLI as a setting rather than as prompt text. An unmapped name, or a file that
 * cannot be written, refuses the spawn (see `claude_runner.ts`).
 *
 * The builder is pure; the writer is the only part that touches the disk.
 *
 * Australian English spelling throughout (behaviour, organisation, honour).
 */

import type { AgentRunSettings, ToolDenialSettings } from "./agent_provider.ts";
import type { EnvLookup } from "./env_lookup.ts";
import type { Result } from "../types.ts";

/** The environment variable the Gemini CLI reads its system settings path from. */
export const GEMINI_SYSTEM_SETTINGS_ENV_VAR = "GEMINI_CLI_SYSTEM_SETTINGS_PATH";

/**
 * The Gemini CLI tool each mapped denial excludes (v0.68.0 `tool-names.ts` and
 * `definitions/base-declarations.ts`).
 *
 * `WebFetch` and `WebSearch` are mapped because the existing deny lists
 * (summarise, closure verdict, drift check) carry them and Gemini has the
 * equivalent tools, `web_fetch` and `google_web_search`.
 *
 * `EnterPlanMode` and `ExitPlanMode` are not in the issue's list, but the
 * runner denies them by default and the Quorum judge relies on that, so
 * refusing them would refuse every default Gemini run.
 */
const GEMINI_TOOL_FOR_DENIAL: ReadonlyMap<string, string> = new Map([
  ["Edit", "replace"],
  ["MultiEdit", "replace"],
  ["Write", "write_file"],
  ["Bash", "run_shell_command"],
  ["WebFetch", "web_fetch"],
  ["WebSearch", "google_web_search"],
  ["EnterPlanMode", "enter_plan_mode"],
  ["ExitPlanMode", "exit_plan_mode"],
]);

/** Denials that turn off sub-agents through `experimental.enableAgents`. */
const SUB_AGENT_DENIALS: ReadonlySet<string> = new Set(["Task", "Agent"]);

/**
 * Denials Gemini has no tool for: the CLI has no notebook tool, so a notebook
 * edit cannot happen and the denial is met without a setting.
 */
const NO_TOOL_DENIALS: ReadonlySet<string> = new Set(["NotebookEdit"]);

/**
 * Maps a list of denied tool names into Gemini's settings object.
 *
 * `tools.exclude` lists each Gemini tool once, in order of first appearance;
 * `tools` is omitted when nothing is excluded, and `experimental` when neither
 * sub-agent name is denied. A name with no mapping (exact match only) refuses
 * the whole list, naming every such tool.
 *
 * @param disallowedTools - Tool names the run denies, as the runner names them.
 * @returns The settings object, or the refusal naming the unmapped tools.
 */
export function buildGeminiToolSettings(
  disallowedTools: readonly string[],
): ToolDenialSettings {
  const exclude: string[] = [];
  const unmapped: string[] = [];
  let subAgentsOff = false;
  for (const tool of disallowedTools) {
    if (SUB_AGENT_DENIALS.has(tool)) {
      subAgentsOff = true;
    } else if (NO_TOOL_DENIALS.has(tool)) {
      continue;
    } else {
      const geminiTool = GEMINI_TOOL_FOR_DENIAL.get(tool);
      if (geminiTool === undefined) {
        if (!unmapped.includes(tool)) unmapped.push(tool);
      } else if (!exclude.includes(geminiTool)) {
        exclude.push(geminiTool);
      }
    }
  }
  if (unmapped.length > 0) {
    return {
      ok: false,
      refusal: {
        kind: "missing_tool_support",
        message: `gemini cannot enforce the denied tool(s) ${
          unmapped.join(", ")
        }: no Gemini CLI setting is mapped for them, and a denial is never left as prompt text only`,
      },
    };
  }
  const settings: Record<string, unknown> = {};
  if (exclude.length > 0) settings.tools = { exclude };
  if (subAgentsOff) settings.experimental = { enableAgents: false };
  return { ok: true, settings };
}

/** The cause of a thrown value, as a message. */
function causeOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Removes a directory the writer made after a failed write. Returns the cause
 * when the removal also fails, so the caller can report it, or undefined when
 * the directory is gone.
 */
async function removeDirectory(dir: string): Promise<string | undefined> {
  try {
    await Deno.remove(dir, { recursive: true });
    return undefined;
  } catch (error) {
    return causeOf(error);
  }
}

/**
 * Writes this run's settings file into a fresh, owner-only directory.
 *
 * The directory is made under `TMPDIR` as the run's own environment lookup
 * reads it, or under the system temporary directory when that is absent or
 * empty. The file is `settings.json`, created new with mode 0600 and chmodded
 * explicitly so the umask cannot widen it. Any failure names the path and the
 * cause, and removes the directory it made.
 *
 * @param request - The denials to enforce and the environment lookup.
 * @returns The environment that points the CLI at the file (its path is the
 *   value of `GEMINI_CLI_SYSTEM_SETTINGS_PATH`), and a `cleanup` that removes
 *   the directory (safe to call twice).
 */
export async function writeGeminiRunSettings(request: {
  disallowedTools: readonly string[];
  env?: EnvLookup;
}): Promise<Result<AgentRunSettings>> {
  const built = buildGeminiToolSettings(request.disallowedTools);
  if (!built.ok) return { ok: false, error: new Error(built.refusal.message) };

  const configuredRoot = (request.env?.("TMPDIR") ?? "").trim();
  const root = configuredRoot === "" ? undefined : configuredRoot;
  const rootLabel = root ?? "the system temporary directory";
  const consequence =
    "so the spawn is refused rather than leave its denied tools as prompt text only";

  let dir: string;
  try {
    dir = await Deno.makeTempDir({
      dir: root,
      prefix: "vibe-gemini-settings-",
    });
  } catch (error) {
    return {
      ok: false,
      error: new Error(
        `the Gemini settings file could not be written to ${rootLabel}: ${
          causeOf(error)
        }; ${consequence}`,
      ),
    };
  }

  const filePath = `${dir}/settings.json`;
  try {
    await Deno.chmod(dir, 0o700);
    await Deno.writeTextFile(
      filePath,
      `${JSON.stringify(built.settings, null, 2)}\n`,
      { mode: 0o600, createNew: true },
    );
    await Deno.chmod(filePath, 0o600);
  } catch (error) {
    const removalFailure = await removeDirectory(dir);
    const removalNote = removalFailure === undefined
      ? ""
      : `; the directory ${dir} could not be removed either: ${removalFailure}`;
    return {
      ok: false,
      error: new Error(
        `the Gemini settings file could not be written to ${filePath}: ${
          causeOf(error)
        }${removalNote}; ${consequence}`,
      ),
    };
  }

  const cleanup = async (): Promise<void> => {
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  };
  return {
    ok: true,
    value: {
      env: { [GEMINI_SYSTEM_SETTINGS_ENV_VAR]: filePath },
      cleanup,
    },
  };
}
