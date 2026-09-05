/**
 * The update-mode conversation setup runs (Issue #626, part of #583;
 * default flipped to `frozen` by Issue #692, part of #674).
 *
 * `setup.sh` owns terminal I/O and nothing else: it delegates the whole
 * conversation here, exactly as `run.sh` delegates the checkout update to
 * `worker-checkout-update`. Keeping the logic in Deno is what makes the ref
 * validation, the version defaults and the merge testable — and what makes the
 * Windows counterpart a follow-up rather than a rewrite.
 *
 * The conversation:
 *   1. `dynamic` or `frozen`, defaulting to `frozen` on a fresh host and, on a
 *      re-run, to whatever the host already says.
 *   2. Under `frozen`, the pinned ref — defaulting to the latest release tag
 *      (Issue #689), validated by resolving it in this very checkout after a
 *      fetch, so an unresolvable pin is rejected here rather than at the next
 *      launch.
 *   3. Under `frozen`, one exact version per tool, each defaulting to the
 *      version that release recorded in its manifest (Issue #688) so
 *      accepting every default reproduces a released, tested combination.
 *      With no resolvable release manifest the defaults fall back to what
 *      dynamic mode would install today (Issue #623), and the fallback is
 *      stated in one line rather than leaving a prompt blank.
 *
 * A non-interactive run never prompts: existing values are left untouched, and
 * a fresh config is pinned to the latest release when one resolves with a
 * manifest — otherwise it stays `dynamic` with one warning line saying why.
 *
 * Every line is styled through `lib/console_style.ts` (Issue #870), so the
 * conversation reads in the same `ℹ`/`✓`/`⚠` house style as the `setup.sh`
 * output around it and a question that has a default shows it in brackets.
 * The styler is a `deps` seam like every other side effect here, so a test
 * names it rather than setting `NO_COLOR` on the shared process.
 *
 * The load-time default is untouched: an absent `update_mode` still resolves
 * to `dynamic` (`DEFAULT_UPDATE_MODE`), because an existing host carries no
 * pins and frozen is all-or-nothing (Issue #622).
 */

import { fetchOrigin, resolveRefCommit } from "../lib/checkout_update.ts";
import {
  bracketedDefault,
  type ConsoleStyler,
  terminalStyler,
} from "../lib/console_style.ts";
import {
  DEFAULT_UPDATE_MODE,
  PINNED_TOOLS,
  SETUP_DEFAULT_UPDATE_MODE,
  UPDATE_MODES,
} from "../lib/config_defaults.ts";
import {
  pinValueErrors,
  validateUpdateModeSettings,
} from "../lib/config_validator.ts";
import { defaultLogger } from "../lib/logger.ts";
import { processEnvLookup } from "../lib/env_lookup.ts";
import { pathStyleFor } from "../lib/host_path_style.ts";
import { resolveLogDir } from "../lib/log_dir.ts";
import {
  createDefaultReleaseCheckDeps,
  latestRelease as resolveLatestRelease,
  type ReleaseManifestLookup,
  type ReleaseRef,
  releaseToolVersions as resolveReleaseToolVersions,
} from "../lib/release_check.ts";
import type { ReleaseToolVersions } from "../lib/release_manifest.ts";
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
  /**
   * The glyphs and colour the lines are styled with (Issue #870).
   *
   * A seam like every other dependency here: a test names the styler instead
   * of setting `NO_COLOR` on the process, which would race every test running
   * beside it (Issue #880). Bound to stdout in production, because `say`
   * prints there.
   */
  style: ConsoleStyler;
  /** Is an operator actually there to answer? */
  interactive(): boolean;
  /** Fetch origin (with tags) so a ref pushed since the last launch resolves. */
  fetchOrigin(repoDir: string): Promise<Result<void>>;
  /** Resolve a ref to its commit in the checkout; `null` when it does not. */
  resolveCommit(repoDir: string, ref: string): Promise<string | null>;
  /** What dynamic mode would install right now, per tool (Issue #623). */
  dynamicVersions(): Promise<DynamicVersionCandidate[]>;
  /** The newest release of the repository this checkout came from (#689). */
  latestRelease(repoDir: string): Promise<Result<ReleaseRef | null>>;
  /** The tool versions a release recorded in its manifest (Issue #688). */
  releaseToolVersions(
    repoDir: string,
    tag: string,
  ): Promise<Result<ReleaseManifestLookup>>;
}

/**
 * The pin defaults taken from the latest release (Issues #688, #689).
 *
 * Every field is optional because each half can fail on its own: a release
 * that cannot be resolved leaves no tag, and a release minted before the
 * manifest leaves a tag with no versions. The note says which happened, so no
 * prompt is ever left with a blank default and no explanation.
 */
interface ReleaseDefaults {
  /** The latest release tag, when one resolved. */
  tag?: string;
  /** The versions that release records, when it carries a manifest. */
  tools?: ReleaseToolVersions;
  /** One line explaining a missing default; absent when both resolved. */
  note?: string;
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

/**
 * Where git output is logged when nothing better is known.
 *
 * Setup runs on the host, so it is the host's log directory — one resolution
 * with the launcher and the shell (Issues #872, #873).
 */
function defaultLogDir(): string {
  const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE");
  return home
    ? resolveLogDir(home, processEnvLookup, pathStyleFor(home))
    : "logs";
}

/**
 * The real side effects: the terminal, git in the checkout, and the release
 * gate that answers "what would dynamic install today?".
 */
export function createDefaultUpdateModeDeps(): UpdateModeSetupDeps {
  return {
    ask: (question) => Promise.resolve(prompt(question)),
    say: (message) => console.log(message),
    style: terminalStyler(),
    interactive: () => Deno.stdin.isTerminal(),
    fetchOrigin: (repoDir) => fetchOrigin(repoDir, defaultLogDir()),
    resolveCommit: resolveRefCommit,
    dynamicVersions: () => resolveDynamicVersions(defaultLogger),
    latestRelease: (repoDir) =>
      resolveLatestRelease(createDefaultReleaseCheckDeps(repoDir)),
    releaseToolVersions: (repoDir, tag) =>
      resolveReleaseToolVersions(tag, createDefaultReleaseCheckDeps(repoDir)),
  };
}

/** The message of a thrown value, whatever shape it arrived in. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The pin defaults the latest release offers (Issues #688, #689).
 *
 * Nothing here throws or fails the run: setup must still be able to pin a host
 * by hand when GitHub is unreachable, so every fault becomes a note the caller
 * says out loud beside the prompt whose default it cost.
 */
async function releaseDefaults(
  repoDir: string,
  deps: UpdateModeSetupDeps,
): Promise<ReleaseDefaults> {
  const fallback = "Falling back to the versions dynamic mode would install " +
    "today.";

  let release: Result<ReleaseRef | null>;
  try {
    release = await deps.latestRelease(repoDir);
  } catch (error) {
    return {
      note: `Could not resolve the latest release: ${describe(error)}. ` +
        fallback,
    };
  }
  if (!release.ok) {
    return {
      note: `Could not resolve the latest release: ${release.error.message} ` +
        fallback,
    };
  }
  if (release.value === null) {
    return {
      note: `No MAJOR.MINOR.PATCH release exists to pin to yet. ${fallback}`,
    };
  }
  const tag = release.value.tag;

  let lookup: Result<ReleaseManifestLookup>;
  try {
    lookup = await deps.releaseToolVersions(repoDir, tag);
  } catch (error) {
    return {
      tag,
      note: `Could not read the tool versions release ${tag} ships with: ` +
        `${describe(error)}. ${fallback}`,
    };
  }
  if (!lookup.ok) {
    return {
      tag,
      note: `Could not read the tool versions release ${tag} ships with: ` +
        `${lookup.error.message} ${fallback}`,
    };
  }
  if (lookup.value.kind === "no-manifest") {
    return { tag, note: `${lookup.value.reason} ${fallback}` };
  }

  return { tag, tools: lookup.value.tools };
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
    deps.style.info(
      "Update mode: 'dynamic' tracks the tip of the default branch and " +
        "installs the latest tools;",
    ),
  );
  deps.say(
    deps.style.plain(
      "'frozen' holds this host at a pinned ref with exact tool versions.",
    ),
  );

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = await deps.ask(
      deps.style.plain(
        bracketedDefault("Update mode (dynamic/frozen)", current),
      ),
    );
    if (answer === null) return inputEnded("update mode");
    const value = answer.trim() === "" ? current : answer.trim().toLowerCase();
    if ((UPDATE_MODES as readonly string[]).includes(value)) {
      deps.say(deps.style.success(`Update mode: ${value}.`));
      return { ok: true, value: value as UpdateMode };
    }
    deps.say(
      deps.style.warning(
        `"${answer.trim()}" is not an update mode. Accepted values: ` +
          `${UPDATE_MODES.join(", ")}.`,
      ),
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
      deps.style.warning(
        `Could not fetch origin in ${repoDir}: ${fetched.error.message}`,
      ),
    );
    deps.say(
      deps.style.plain("Only refs already in this checkout can be validated."),
    );
  }

  deps.say("");
  deps.say(
    deps.style.info("Pinned ref: the commit SHA or tag this host is held at."),
  );

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const answer = await deps.ask(
      deps.style.plain(bracketedDefault("Pinned ref", current)),
    );
    if (answer === null) return inputEnded("pinned ref");

    const value = answer.trim() === "" ? (current ?? "") : answer.trim();
    if (value === "") {
      deps.say(
        deps.style.warning(
          "Frozen mode needs a pinned ref — a commit SHA or a tag name.",
        ),
      );
      continue;
    }

    const invalid = pinValueErrors("pinned_ref", value);
    if (invalid.length > 0) {
      deps.say(deps.style.warning(invalid.join(" ")));
      continue;
    }

    const commit = await deps.resolveCommit(repoDir, value);
    if (commit === null) {
      deps.say(
        deps.style.warning(
          `"${value}" does not resolve to a commit in ${repoDir} — it was ` +
            `not saved. Enter a commit SHA or a tag that exists here.`,
        ),
      );
      continue;
    }

    deps.say(deps.style.success(`${value} resolves to ${commit}.`));
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
 * Ask for one exact version per tool (Issue #692).
 *
 * Each prompt defaults to the first of: what the host already pins, what the
 * latest release recorded (Issue #688), and what dynamic mode would install
 * today (Issue #623). Accepting every default therefore reproduces a released,
 * tested combination rather than assembling a set no release ever shipped.
 * Dynamic resolution is only attempted when a tool still has no default, so a
 * release manifest spares setup the network round-trips entirely.
 */
async function askToolVersions(
  current: PinnedToolVersions,
  releaseTools: ReleaseToolVersions | undefined,
  deps: UpdateModeSetupDeps,
): Promise<Result<PinnedToolVersions>> {
  const covered = (tool: PinnedTool) =>
    current[tool] !== undefined || releaseTools?.[tool] !== undefined;

  let candidates: DynamicVersionCandidate[] = [];
  if (!PINNED_TOOLS.every(covered)) {
    try {
      candidates = await deps.dynamicVersions();
    } catch (error) {
      deps.say(
        deps.style.warning(
          `Could not work out what dynamic mode would install: ` +
            `${describe(error)}`,
        ),
      );
      deps.say(deps.style.plain("Enter each version by hand."));
    }
  }

  deps.say("");
  deps.say(
    deps.style.info(
      "Tool versions: the exact version this host installs while frozen.",
    ),
  );

  const versions: PinnedToolVersions = {};
  for (const tool of PINNED_TOOLS) {
    const candidate = candidateVersion(candidates, tool);
    const fallback = current[tool] ?? releaseTools?.[tool] ??
      (candidate?.eligible ? candidate.version ?? undefined : undefined);
    if (!fallback && candidate && !candidate.eligible) {
      deps.say(deps.style.warning(candidate.reason));
    }

    let answered = false;
    for (let attempt = 0; attempt < MAX_ATTEMPTS && !answered; attempt++) {
      const answer = await deps.ask(
        deps.style.plain(
          bracketedDefault(`${TOOL_PROMPT_LABELS[tool]} version`, fallback),
        ),
      );
      if (answer === null) return inputEnded(`${tool} version`);

      const value = answer.trim() === "" ? (fallback ?? "") : answer.trim();
      if (value === "") {
        deps.say(
          deps.style.warning(
            `Frozen mode needs an exact ${TOOL_PROMPT_LABELS[tool]} version.`,
          ),
        );
        continue;
      }

      const invalid = pinValueErrors(`pinned_tool_versions.${tool}`, value);
      if (invalid.length > 0) {
        deps.say(deps.style.warning(invalid.join(" ")));
        continue;
      }

      versions[tool] = value;
      answered = true;
    }
    if (!answered) return tooManyAttempts(`${tool} version`);
  }

  deps.say(
    deps.style.success(
      `Pinned ${
        PINNED_TOOLS.map((tool) =>
          `${TOOL_PROMPT_LABELS[tool]} ${versions[tool]}`
        ).join(", ")
      }.`,
    ),
  );
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
  // A fresh host defaults to `frozen` (Issue #692); a re-run defaults to
  // whatever the host already says, so pressing Enter throughout is a no-op.
  const mode = await askMode(
    existing.update_mode ?? SETUP_DEFAULT_UPDATE_MODE,
    deps,
  );
  if (!mode.ok) return mode;

  // Dynamic ends the conversation: the pin fields are ignored in dynamic mode
  // rather than rejected (Issue #622), so they are left where they are and a
  // host can flip back to frozen without retyping them.
  if (mode.value === "dynamic") {
    return { ok: true, value: { update_mode: "dynamic" } };
  }

  // The pin defaults come from the latest release, so accepting every default
  // reproduces a released, tested combination (Issues #688, #689). What the
  // host already says still wins — a re-run must not re-ask its way into a
  // different answer.
  const release = await releaseDefaults(repoDir, deps);
  if (release.note) deps.say(deps.style.warning(release.note));

  const ref = await askPinnedRef(
    repoDir,
    existing.pinned_ref ?? release.tag,
    deps,
  );
  if (!ref.ok) return ref;

  const versions = await askToolVersions(
    existing.pinned_tool_versions ?? {},
    release.tools,
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

/**
 * What a fresh config is written with when nobody is there to ask (#692).
 *
 * Pinned to the latest release when it resolves *with* a manifest, because a
 * ref without the versions it ships with is exactly the partial pin frozen
 * mode exists to prevent (Issue #622). Anything else leaves the host
 * `dynamic`, with one line naming what could not be resolved — an unpinned
 * host is a working host, a silently half-pinned one is not.
 */
async function nonInteractiveSettings(
  repoDir: string,
  deps: UpdateModeSetupDeps,
): Promise<UpdateModeSettings> {
  const stayDynamic = (reason: string): UpdateModeSettings => {
    deps.say(
      deps.style.warning(
        `Leaving this host on update_mode "${DEFAULT_UPDATE_MODE}": ${reason}`,
      ),
    );
    return { update_mode: DEFAULT_UPDATE_MODE };
  };

  const release = await releaseDefaults(repoDir, deps);
  if (!release.tag || !release.tools) {
    return stayDynamic(
      release.note ?? "no release could be resolved to pin to.",
    );
  }

  const tools: PinnedToolVersions = { ...release.tools };
  // The very validator config load runs, applied before the write: an invalid
  // pin must never reach the file.
  const errors = validateUpdateModeSettings({
    updateMode: "frozen",
    pinnedRef: release.tag,
    pinnedToolVersions: tools,
  });
  if (errors.length > 0) {
    return stayDynamic(
      `the pins release ${release.tag} records do not validate — ` +
        errors.join(" "),
    );
  }

  deps.say(
    deps.style.success(
      `Pinned this host to release ${release.tag} — claude ${tools.claude}, ` +
        `gh ${tools.gh}, deno ${tools.deno}.`,
    ),
  );
  return {
    update_mode: "frozen",
    pinned_ref: release.tag,
    pinned_tool_versions: tools,
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

  // No operator to answer: keep what the host already says, and pin a fresh
  // config to the latest release when one resolves with a manifest (Issue
  // #692). A host that cannot be pinned stays `dynamic` — what it behaved as
  // before the key existed — with one line saying why, never a partial pin.
  if (!deps.interactive()) {
    if (existing.value.update_mode !== undefined) {
      return {
        ok: true,
        value: { settings: existing.value, changed: false, prompted: false },
      };
    }
    const settings = await nonInteractiveSettings(options.repoDir, deps);
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
