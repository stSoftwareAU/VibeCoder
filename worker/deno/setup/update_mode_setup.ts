/**
 * The update-mode conversation setup runs (Issue #626, part of #583).
 *
 * `setup.sh` owns terminal I/O and nothing else: it delegates the whole
 * conversation here, exactly as `run.sh` delegates the checkout update to
 * `worker-checkout-update`. Keeping the logic in Deno is what makes the ref
 * validation, the version defaults and the merge testable — and what makes the
 * Windows counterpart a follow-up rather than a rewrite.
 *
 * The conversation:
 *   1. `dynamic` or `frozen`, defaulting to whatever the host already says.
 *   2. Under `frozen`, the pinned ref — validated by resolving it in this very
 *      checkout after a fetch, so an unresolvable pin is rejected here rather
 *      than at the next launch.
 *   3. Under `frozen`, one exact version per tool, each defaulting to what
 *      dynamic mode would install today (Issue #623).
 *
 * A non-interactive run never prompts: existing values are left untouched and
 * a fresh config is defaulted to `dynamic`, which is what every host did
 * before these keys existed.
 */

import { fetchOrigin, resolveRefCommit } from "../lib/checkout_update.ts";
import {
  DEFAULT_UPDATE_MODE,
  PINNED_TOOLS,
  UPDATE_MODES,
} from "../lib/config_defaults.ts";
import { pinValueErrors } from "../lib/config_validator.ts";
import { defaultLogger } from "../lib/logger.ts";
import {
  type DynamicVersionCandidate,
  type PinnedTool,
  resolveDynamicVersions,
} from "../lib/software_updates.ts";
import type { PinnedToolVersions, Result, UpdateMode } from "../types.ts";
import {
  readUpdateModeSettings,
  type UpdateModeSettings,
  writeUpdateModeConfig,
} from "./config_writer.ts";

/** How a tool is named in a prompt. */
const TOOL_PROMPT_LABELS: Readonly<Record<PinnedTool, string>> = {
  claude: "Claude CLI",
  gh: "GitHub CLI (gh)",
  deno: "Deno",
};

/**
 * Rejected answers accepted per question before the conversation gives up.
 *
 * An operator who mistypes gets asked again; one who cannot produce a valid
 * answer gets a fail-loud exit instead of a prompt that never ends.
 */
const MAX_ATTEMPTS = 5;

/** Injectable side effects, so the conversation is testable end to end. */
export interface UpdateModeSetupDeps {
  /** Ask one question; `null` when input ended before an answer arrived. */
  ask(question: string): Promise<string | null>;
  /** Show one line to the operator. */
  say(message: string): void;
  /** Is an operator actually there to answer? */
  interactive(): boolean;
  /** Fetch origin (with tags) so a ref pushed since the last launch resolves. */
  fetchOrigin(repoDir: string): Promise<Result<void>>;
  /** Resolve a ref to its commit in the checkout; `null` when it does not. */
  resolveCommit(repoDir: string, ref: string): Promise<string | null>;
  /** What dynamic mode would install right now, per tool (Issue #623). */
  dynamicVersions(): Promise<DynamicVersionCandidate[]>;
}

/** What one setup run did to the update-mode fields. */
export interface UpdateModeOutcome {
  /** The settings the run settled on. */
  settings: UpdateModeSettings;
  /** True when `.config.json` was rewritten. */
  changed: boolean;
  /** False on a non-interactive run — no question was asked. */
  prompted: boolean;
}

/** Where git output is logged when nothing better is known. */
function defaultLogDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  return home ? `${home}/logs` : "logs";
}

/**
 * The real side effects: the terminal, git in the checkout, and the release
 * gate that answers "what would dynamic install today?".
 */
export function createDefaultUpdateModeDeps(): UpdateModeSetupDeps {
  return {
    ask: (question) => Promise.resolve(prompt(question)),
    say: (message) => console.log(message),
    interactive: () => Deno.stdin.isTerminal(),
    fetchOrigin: (repoDir) => fetchOrigin(repoDir, defaultLogDir()),
    resolveCommit: resolveRefCommit,
    dynamicVersions: () => resolveDynamicVersions(defaultLogger),
  };
}

/** The fail-loud error for input that ended mid-conversation. */
function inputEnded(what: string): Result<never> {
  return {
    ok: false,
    error: new Error(
      `Input ended before the ${what} was answered — nothing was written. ` +
        `Re-run ./setup.sh from a terminal to set the update mode.`,
    ),
  };
}

/** The fail-loud error for a question that never got a usable answer. */
function tooManyAttempts(what: string): Result<never> {
  return {
    ok: false,
    error: new Error(
      `No valid ${what} after ${MAX_ATTEMPTS} attempts — nothing was ` +
        `written. Re-run ./setup.sh when you have the value to hand.`,
    ),
  };
}

/** Ask for `dynamic` or `frozen`, defaulting to what the host already says. */
async function askMode(
  current: UpdateMode,
  deps: UpdateModeSetupDeps,
): Promise<Result<UpdateMode>> {
  deps.say("");
  deps.say(
    "  Update mode: 'dynamic' tracks the tip of the default branch and " +
      "installs the latest tools;",
  );
  deps.say(
    "  'frozen' holds this host at a pinned ref with exact tool versions.",
  );

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = await deps.ask(
      `  Update mode (dynamic/frozen) [${current}]`,
    );
    if (answer === null) return inputEnded("update mode");
    const value = answer.trim() === "" ? current : answer.trim().toLowerCase();
    if ((UPDATE_MODES as readonly string[]).includes(value)) {
      return { ok: true, value: value as UpdateMode };
    }
    deps.say(
      `  "${answer.trim()}" is not an update mode. Accepted values: ` +
        `${UPDATE_MODES.join(", ")}.`,
    );
  }
  return tooManyAttempts("update mode");
}

/**
 * Ask for the pinned ref, and refuse one that does not resolve.
 *
 * Origin is fetched first because a tag pushed since the last launch does not
 * exist in the checkout until it is — the same reason the frozen launch path
 * fetches before resolving (Issue #624). A fetch that fails is reported and
 * the conversation continues against what the checkout already holds: an
 * offline host can still pin a ref it has, and a ref it does not have is
 * rejected by the resolution below rather than saved on a guess.
 */
async function askPinnedRef(
  repoDir: string,
  current: string | undefined,
  deps: UpdateModeSetupDeps,
): Promise<Result<string>> {
  const fetched = await deps.fetchOrigin(repoDir);
  if (!fetched.ok) {
    deps.say(
      `  Could not fetch origin in ${repoDir}: ${fetched.error.message}`,
    );
    deps.say(
      "  Only refs already in this checkout can be validated.",
    );
  }

  deps.say("");
  deps.say("  Pinned ref: the commit SHA or tag this host is held at.");

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const suffix = current ? ` [${current}]` : "";
    const answer = await deps.ask(`  Pinned ref${suffix}`);
    if (answer === null) return inputEnded("pinned ref");

    const value = answer.trim() === "" ? (current ?? "") : answer.trim();
    if (value === "") {
      deps.say(
        "  Frozen mode needs a pinned ref — a commit SHA or a tag name.",
      );
      continue;
    }

    const invalid = pinValueErrors("pinned_ref", value);
    if (invalid.length > 0) {
      deps.say(`  ${invalid.join(" ")}`);
      continue;
    }

    const commit = await deps.resolveCommit(repoDir, value);
    if (commit === null) {
      deps.say(
        `  "${value}" does not resolve to a commit in ${repoDir} — it was ` +
          `not saved. Enter a commit SHA or a tag that exists here.`,
      );
      continue;
    }

    deps.say(`  ${value} resolves to ${commit}.`);
    return { ok: true, value };
  }
  return tooManyAttempts("pinned ref");
}

/** The version dynamic mode would install for `tool`, when it resolved one. */
function candidateVersion(
  candidates: DynamicVersionCandidate[],
  tool: PinnedTool,
): DynamicVersionCandidate | undefined {
  return candidates.find((candidate) => candidate.tool === tool);
}

/**
 * Ask for one exact version per tool, each defaulting to what dynamic mode
 * would install today (Issue #623), so blank answers pin today's fleet.
 */
async function askToolVersions(
  current: PinnedToolVersions,
  deps: UpdateModeSetupDeps,
): Promise<Result<PinnedToolVersions>> {
  let candidates: DynamicVersionCandidate[] = [];
  try {
    candidates = await deps.dynamicVersions();
  } catch (error) {
    deps.say(
      `  Could not work out what dynamic mode would install: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
    deps.say("  Enter each version by hand.");
  }

  deps.say("");
  deps.say(
    "  Tool versions: the exact version this host installs while frozen.",
  );

  const versions: PinnedToolVersions = {};
  for (const tool of PINNED_TOOLS) {
    const candidate = candidateVersion(candidates, tool);
    const fallback = current[tool] ??
      (candidate?.eligible ? candidate.version ?? undefined : undefined);
    if (!fallback && candidate && !candidate.eligible) {
      deps.say(`  ${candidate.reason}`);
    }

    let answered = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !answered; attempt++) {
      const suffix = fallback ? ` [${fallback}]` : "";
      const answer = await deps.ask(
        `  ${TOOL_PROMPT_LABELS[tool]} version${suffix}`,
      );
      if (answer === null) return inputEnded(`${tool} version`);

      const value = answer.trim() === "" ? (fallback ?? "") : answer.trim();
      if (value === "") {
        deps.say(
          `  Frozen mode needs an exact ${TOOL_PROMPT_LABELS[tool]} version.`,
        );
        continue;
      }

      const invalid = pinValueErrors(`pinned_tool_versions.${tool}`, value);
      if (invalid.length > 0) {
        deps.say(`  ${invalid.join(" ")}`);
        continue;
      }

      versions[tool] = value;
      answered = true;
    }
    if (!answered) return tooManyAttempts(`${tool} version`);
  }

  return { ok: true, value: versions };
}

/**
 * Run the whole conversation and return the settings it produced.
 *
 * Nothing is written here — the caller writes, so a conversation that fails
 * part-way leaves `.config.json` exactly as it was.
 *
 * @param repoDir - The checkout the pinned ref must resolve in
 * @param existing - The values already in `.config.json`, offered as defaults
 */
export async function promptUpdateMode(
  repoDir: string,
  existing: UpdateModeSettings,
  deps: UpdateModeSetupDeps,
): Promise<Result<UpdateModeSettings>> {
  const mode = await askMode(existing.update_mode ?? DEFAULT_UPDATE_MODE, deps);
  if (!mode.ok) return mode;

  // Dynamic ends the conversation: the pin fields are ignored in dynamic mode
  // rather than rejected (Issue #622), so they are left where they are and a
  // host can flip back to frozen without retyping them.
  if (mode.value === "dynamic") {
    return { ok: true, value: { update_mode: "dynamic" } };
  }

  const ref = await askPinnedRef(repoDir, existing.pinned_ref, deps);
  if (!ref.ok) return ref;

  const versions = await askToolVersions(
    existing.pinned_tool_versions ?? {},
    deps,
  );
  if (!versions.ok) return versions;

  return {
    ok: true,
    value: {
      update_mode: "frozen",
      pinned_ref: ref.value,
      pinned_tool_versions: versions.value,
    },
  };
}

/** Options for {@link runUpdateModeSetup}. */
export interface UpdateModeSetupOptions {
  /** The checkout root — where `.config.json` and the git repository live. */
  repoDir: string;
  /** Path to `.config.json`. */
  configPath: string;
  /** Overrides for the real side effects; tests supply all of them. */
  deps?: Partial<UpdateModeSetupDeps>;
}

/**
 * Ask for the update mode and record the answer in `.config.json`.
 *
 * The whole point of the sub-command: `setup.sh` calls this and keeps no mode
 * logic of its own.
 */
export async function runUpdateModeSetup(
  options: UpdateModeSetupOptions,
): Promise<Result<UpdateModeOutcome>> {
  const deps: UpdateModeSetupDeps = {
    ...createDefaultUpdateModeDeps(),
    ...options.deps,
  };

  const existing = await readUpdateModeSettings(options.configPath);
  if (!existing.ok) return existing;

  // No operator to answer: keep what the host already says, and default a
  // fresh config to `dynamic` — exactly what it behaved as before the key
  // existed.
  if (!deps.interactive()) {
    if (existing.value.update_mode !== undefined) {
      return {
        ok: true,
        value: { settings: existing.value, changed: false, prompted: false },
      };
    }
    const settings: UpdateModeSettings = { update_mode: DEFAULT_UPDATE_MODE };
    const written = await writeUpdateModeConfig(options.configPath, settings);
    if (!written.ok) return written;
    return {
      ok: true,
      value: { settings, changed: written.value, prompted: false },
    };
  }

  const answers = await promptUpdateMode(
    options.repoDir,
    existing.value,
    deps,
  );
  if (!answers.ok) return answers;

  const written = await writeUpdateModeConfig(
    options.configPath,
    answers.value,
  );
  if (!written.ok) return written;

  return {
    ok: true,
    value: { settings: answers.value, changed: written.value, prompted: true },
  };
}
