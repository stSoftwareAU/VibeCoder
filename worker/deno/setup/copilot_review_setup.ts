/**
 * The Copilot code review conversation setup runs (Issue #2701).
 *
 * Copilot code review is not free, even on a public repository: GitHub bills
 * each automatic review to the pull request author's Copilot plan, or to the
 * organisation when it pays for members without a licence. So setup asks,
 * once per host, whether `repo-settings-harden` turns it on, turns it off, or
 * leaves each monitored repository as it is, and records the answer as
 * `copilot_code_review` in `.config.json`.
 *
 * `setup.sh` and `setup.ps1` own terminal I/O and nothing else, exactly as for
 * `update-mode` (`update_mode_setup.ts`): the question, the default and the
 * write live here, where they are testable.
 *
 * The default is the host's current value, `leave` when unset, so pressing
 * Enter is always a no-op. A non-interactive run never prompts and never
 * writes: an absent key already means `leave`.
 *
 * Uses Australian English throughout (behaviour, organisation, etc.).
 */

import {
  bracketedDefault,
  type ConsoleStyler,
  terminalStyler,
} from "../lib/console_style.ts";
import { COPILOT_CODE_REVIEW_MODES } from "../lib/config_defaults.ts";
import type { CopilotCodeReviewMode, Result } from "../types.ts";
import {
  readCopilotCodeReviewSetting,
  writeCopilotCodeReviewConfig,
} from "./config_writer.ts";

/** Rejected answers accepted before the conversation gives up. */
const MAX_ATTEMPTS = 5;

/** Injectable side effects, so the conversation is testable end to end. */
export interface CopilotReviewSetupDeps {
  /** Ask one question; `null` when input ended before an answer arrived. */
  ask(question: string): Promise<string | null>;
  /** Show one line to the operator. */
  say(message: string): void;
  /** The glyphs and colour the lines are styled with (Issue #870). */
  style: ConsoleStyler;
  /** Is an operator actually there to answer? */
  interactive(): boolean;
}

/** What one setup run settled on. */
export interface CopilotReviewOutcome {
  mode: CopilotCodeReviewMode;
  /** True when `.config.json` was rewritten. */
  changed: boolean;
  /** False on a non-interactive run — no question was asked. */
  prompted: boolean;
}

/** Options for {@link runCopilotReviewSetup}. */
export interface CopilotReviewSetupOptions {
  /** Path to `.config.json`. */
  configPath: string;
  /** Overrides for the real side effects; tests supply all of them. */
  deps?: Partial<CopilotReviewSetupDeps>;
}

/**
 * The real side effects: the terminal.
 *
 * `setup.ps1` runs this with stdout piped through `Out-Host`, which prints a
 * line only once it ends, so a question left waiting on its own line would
 * never be seen. When stdout is not a terminal the question is printed as a
 * whole line first; on a terminal it is asked exactly as `update-mode` asks.
 */
export function createDefaultCopilotReviewDeps(): CopilotReviewSetupDeps {
  return {
    ask: (question) => {
      if (Deno.stdout.isTerminal()) return Promise.resolve(prompt(question));
      console.log(question);
      return Promise.resolve(prompt(">"));
    },
    say: (message) => console.log(message),
    style: terminalStyler(),
    interactive: () => Deno.stdin.isTerminal(),
  };
}

/** Ask on / off / leave, defaulting to what the host already says. */
async function askMode(
  current: CopilotCodeReviewMode,
  deps: CopilotReviewSetupDeps,
): Promise<Result<CopilotCodeReviewMode>> {
  deps.say("");
  deps.say(
    deps.style.info(
      "Copilot code review is billed per review, never free — even on " +
        "public repositories:",
    ),
  );
  deps.say(
    deps.style.plain(
      "GitHub charges each automatic review to the PR author's Copilot " +
        "plan, or to the organisation.",
    ),
  );
  deps.say(
    deps.style.plain(
      "'on' requests a review on every PR into the default branch; 'off' " +
        "removes the rule from every repository ruleset; 'leave' changes " +
        "nothing.",
    ),
  );

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = await deps.ask(
      deps.style.plain(
        bracketedDefault("Copilot code review (on/off/leave)", current),
      ),
    );
    if (answer === null) {
      return {
        ok: false,
        error: new Error(
          "Input ended before Copilot code review was answered — nothing " +
            "was written. Re-run ./setup.sh from a terminal to set it.",
        ),
      };
    }
    const value = answer.trim() === "" ? current : answer.trim().toLowerCase();
    if ((COPILOT_CODE_REVIEW_MODES as readonly string[]).includes(value)) {
      deps.say(deps.style.success(`Copilot code review: ${value}.`));
      return { ok: true, value: value as CopilotCodeReviewMode };
    }
    deps.say(
      deps.style.warning(
        `"${answer.trim()}" is not a Copilot code review setting. Accepted ` +
          `values: ${COPILOT_CODE_REVIEW_MODES.join(", ")}.`,
      ),
    );
  }
  return {
    ok: false,
    error: new Error(
      `No valid Copilot code review setting after ${MAX_ATTEMPTS} attempts ` +
        `— nothing was written.`,
    ),
  };
}

/**
 * Ask whether Copilot code review is on, off or left as is, and record the
 * answer in `.config.json` (Issue #2701).
 */
export async function runCopilotReviewSetup(
  options: CopilotReviewSetupOptions,
): Promise<Result<CopilotReviewOutcome>> {
  const deps: CopilotReviewSetupDeps = {
    ...createDefaultCopilotReviewDeps(),
    ...options.deps,
  };

  const current = await readCopilotCodeReviewSetting(options.configPath);
  if (!current.ok) return current;

  // No operator to answer: whatever the host says stands, and an absent key
  // already means `leave`, so nothing is written.
  if (!deps.interactive()) {
    return {
      ok: true,
      value: { mode: current.value, changed: false, prompted: false },
    };
  }

  const mode = await askMode(current.value, deps);
  if (!mode.ok) return mode;

  const written = await writeCopilotCodeReviewConfig(
    options.configPath,
    mode.value,
  );
  if (!written.ok) return written;
  return {
    ok: true,
    value: { mode: mode.value, changed: written.value, prompted: true },
  };
}
