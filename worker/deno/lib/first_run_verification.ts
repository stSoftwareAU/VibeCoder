/**
 * Fresh first-run verification: the decisions (Issue #736).
 *
 * Issue #722's definition of done is an end-to-end run on a fresh Ubuntu +
 * Podman host: `setup.sh` then `run.sh` complete and the worker takes one
 * issue end to end with **no** manual workaround. `infra/verify/first-run.sh`
 * sequences that run; every decision it reports is made here, so each one is
 * unit-testable without a host, a Podman or an image build.
 *
 * Three decisions live in this module:
 *
 *   - **Fresh state.** A host already carrying one of the reporter's
 *     workarounds is refused before `setup.sh` is touched: a run that starts
 *     from a patched host proves nothing.
 *   - **What the run produced.** The Codex-only configuration setup wrote, and
 *     the provider stamp and CLI the build baked into the image.
 *   - **Expected warning or new defect.** A private-repository ruleset 403
 *     (Issue #733) and a runtime that refuses `FITRIM` (Issue #734) are benign
 *     and permanent; every fault a sibling issue removed is recognised by name
 *     if it comes back, so a reader is never left to re-derive the difference.
 *
 * Australian English spelling used throughout (behaviour, colour).
 */

/** Environment variables whose mere presence means the host is not fresh. */
export const WORKAROUND_ENV_VARS: ReadonlyArray<
  { readonly name: string; readonly reason: string }
> = [
  {
    name: "VIBE_SKIP_PREREQ_CHECK",
    reason: "the prerequisite probe must run unaided (Issue #730)",
  },
  {
    name: "VIBE_SKIP_AUTH_CHECK",
    reason:
      "the credential probe must run unaided — the same skip, one gate over (Issue #730)",
  },
  {
    name: "VIBE_HOST_DISK_LOW_FLOOR_GB",
    reason:
      "the host must claim work at its resolved floor, not a moved one (Issue #732)",
  },
  {
    name: "VIBE_HOST_DISK_LOW_FLOOR_PERCENT",
    reason:
      "the host must claim work at its resolved floor, not a moved one (Issue #732)",
  },
  {
    name: "VIBE_HOST_DISK_HARD_FLOOR_GB",
    reason:
      "the host must claim work at its resolved floor, not a moved one (Issue #732)",
  },
];

/** Short-name settings a fresh host must not need (Issue #728). */
const SHORT_NAME_SETTINGS = ["[aliases]", "unqualified-search-registries"];

/** What the launcher would name a locally built worker image. */
const WORKER_IMAGE = /(^|\/)vibe-coder$/;

/** The host state the fresh-state decision is made from. */
export interface FreshStateFacts {
  /** Workaround-shaped variables, as read from the environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Resolved configuration file, by the repository's own rule. */
  readonly configFile: string;
  /** Whether that configuration file already exists. */
  readonly configFileExists: boolean;
  /** Whether `CONFIG_FILE` and `CONFIG_PATH` name different files. */
  readonly configFileSplit?: string;
  /** Whether a Claude CLI is on the host's PATH. */
  readonly claudeOnPath: boolean;
  /** Repository names the container runtime already holds locally. */
  readonly localImages: readonly string[];
  /** `git status --porcelain` over the checkout under test. */
  readonly checkoutStatus: string;
  /** The operator's own `registries.conf`, or null when absent. */
  readonly userRegistriesConf: string | null;
  /** The distribution's `registries.conf`, or null when absent. */
  readonly systemRegistriesConf: string | null;
}

/** Whether the host may be verified, and what a reader should know. */
export interface FreshStateVerdict {
  /** Workarounds present — each one refuses the run. */
  readonly violations: string[];
  /** Host baseline worth recording, which does not refuse the run. */
  readonly notes: string[];
}

/** Whether `text` sets `setting` on a line that is not commented out. */
function setsUncommented(text: string, setting: string): boolean {
  return text.split("\n").some((line) => line.trimStart().startsWith(setting));
}

/**
 * Decide whether a host is fresh enough to verify.
 *
 * Every workaround the reporter of Issue #722 needed is checked, and all of
 * them are reported together: a host with three workarounds should learn all
 * three at once rather than one per attempt.
 *
 * @param facts - The gathered host state
 * @returns The refusals, and the baseline notes worth recording
 */
export function evaluateFreshState(facts: FreshStateFacts): FreshStateVerdict {
  const violations: string[] = [];
  const notes: string[] = [];

  for (const { name, reason } of WORKAROUND_ENV_VARS) {
    const value = facts.env[name];
    if (value !== undefined && value !== "") {
      violations.push(`${name} is set to "${value}" — ${reason}`);
    }
  }

  if (facts.configFileSplit) violations.push(facts.configFileSplit);

  if (facts.configFileExists) {
    violations.push(
      `${facts.configFile} already exists — setup.sh must write it, not a ` +
        `prior run or a hand edit`,
    );
  }

  if (facts.claudeOnPath) {
    violations.push(
      "the Claude CLI is on PATH — a Codex-only configuration must complete " +
        "with no Claude CLI present (Issue #730)",
    );
  }

  for (const image of facts.localImages) {
    if (WORKER_IMAGE.test(image.trim())) {
      violations.push(
        `a worker image (${image.trim()}) is already present — the build ` +
          `must run from nothing on a fresh host`,
      );
    }
  }

  if (facts.checkoutStatus.trim() !== "") {
    violations.push(
      "the checkout has uncommitted changes — a patched checkout is a " +
        "workaround, not a fresh run",
    );
  }

  for (const setting of SHORT_NAME_SETTINGS) {
    if (
      facts.userRegistriesConf !== null &&
      setsUncommented(facts.userRegistriesConf, setting)
    ) {
      violations.push(
        `the operator's registries.conf sets ${setting} — the Issue #728 ` +
          `short-name workaround, which a fresh host must not need`,
      );
    }
  }

  // The distribution's own file is host baseline, not an operator workaround.
  // Both base images name docker.io outright (Issue #728), so the build must
  // not depend on it — which is worth recording, not refusing.
  if (
    facts.systemRegistriesConf !== null &&
    setsUncommented(facts.systemRegistriesConf, "unqualified-search-registries")
  ) {
    notes.push(
      "/etc/containers/registries.conf sets unqualified-search-registries " +
        "(distribution default) — both base images name docker.io, so the " +
        "build must not depend on it",
    );
  }

  return { violations, notes };
}

/** The outcome of a check that either holds or names what is wrong. */
export interface CheckVerdict {
  /** Whether the check held. */
  readonly ok: boolean;
  /** What was found — the reasons when it did not hold, evidence when it did. */
  readonly findings: string[];
}

/**
 * Decide whether the configuration setup wrote is the Codex-only one.
 *
 * A configuration that cannot be parsed is a loud failure naming the parse
 * error, never an empty provider list treated as "not codex".
 *
 * @param configText - Raw `.config.json` contents
 * @returns Whether it selects Codex and nothing else, and why
 */
export function evaluateCodexOnlyConfig(configText: string): CheckVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch (error) {
    return {
      ok: false,
      findings: [
        `the configuration is not readable JSON: ${(error as Error).message}`,
      ],
    };
  }
  const providers = (parsed as { agent_providers?: unknown })?.agent_providers;
  if (!Array.isArray(providers)) {
    return {
      ok: false,
      findings: [
        "the configuration states no agent_providers — this run verifies a " +
        "Codex-only configuration, so the selection must be explicit",
      ],
    };
  }
  const names = providers.map((value) => String(value));
  const findings = [`agent_providers = ${names.join(", ") || "(empty)"}`];
  if (!names.includes("codex")) {
    findings.push("agent_providers does not select codex");
    return { ok: false, findings };
  }
  if (names.length > 1) {
    findings.push(
      `agent_providers also selects ${
        names.filter((n) => n !== "codex").join(", ")
      } — not the Codex-only configuration under test`,
    );
    return { ok: false, findings };
  }
  return { ok: true, findings };
}

/**
 * Decide whether the built image is the Codex one (Issue #729).
 *
 * @param inspectOutput - The image's environment, one `NAME=value` per line
 * @param cliOutput - What `command -v codex; command -v claude` reported
 * @returns Whether the image carries Codex and no Claude, and why
 */
export function evaluateImage(
  inspectOutput: string,
  cliOutput: string,
): CheckVerdict {
  const findings: string[] = [];
  const stamp = inspectOutput.split("\n").map((line) => line.trim()).find((
    line,
  ) => line.startsWith("VIBE_IMAGE_AGENT_PROVIDERS="));
  if (stamp === undefined) {
    return {
      ok: false,
      findings: [
        "the image reports no VIBE_IMAGE_AGENT_PROVIDERS at all — the build " +
        "did not stamp its provider set (Issue #729)",
      ],
    };
  }
  findings.push(stamp);
  const providers = stamp.slice("VIBE_IMAGE_AGENT_PROVIDERS=".length);
  let ok = true;
  if (!providers.includes("codex")) {
    findings.push(
      "the built image does not report codex in VIBE_IMAGE_AGENT_PROVIDERS " +
        "(Issue #729)",
    );
    ok = false;
  }

  // Absence of a marker is never success: the probe states both answers, so a
  // probe that ran and found nothing is distinguishable from one that failed.
  const sawCodex = cliOutput.includes("CODEX_PRESENT");
  const sawNoCodex = cliOutput.includes("CODEX_ABSENT");
  const sawClaude = cliOutput.includes("CLAUDE_PRESENT");
  const sawNoClaude = cliOutput.includes("CLAUDE_ABSENT");
  if (!(sawCodex || sawNoCodex) || !(sawClaude || sawNoClaude)) {
    findings.push(
      "the image CLI probe reported neither presence nor absence — it did " +
        "not run, so nothing can be concluded from it",
    );
    return { ok: false, findings };
  }
  if (sawNoCodex) {
    findings.push("the built image carries no Codex CLI (Issue #729)");
    ok = false;
  }
  if (sawClaude) {
    findings.push(
      "the built image carries the Claude CLI, which a Codex-only " +
        "configuration must not build (Issue #729)",
    );
    ok = false;
  }
  return { ok, findings };
}

/** One classified line of a stage's output. */
export interface Finding {
  /** Whether the line is benign and permanent, or a fault to file. */
  readonly kind: "expected" | "defect";
  /** What it means, and the issue that owns it. */
  readonly summary: string;
  /** The line it was read from. */
  readonly evidence: string;
}

interface Signature {
  readonly pattern: RegExp;
  readonly kind: Finding["kind"];
  readonly summary: string;
}

/**
 * The messages this run must tell apart.
 *
 * Expected: benign, permanent, and not the operator's to fix. Defects: a
 * fault a sibling issue removed, named with the issue that owns it, so a
 * regression is reported as the regression it is.
 */
const SIGNATURES: readonly Signature[] = [
  {
    pattern: /repository rulesets need GitHub Pro/,
    kind: "expected",
    summary: "private-repository ruleset 403, non-fatal (Issue #733)",
  },
  {
    pattern: /this runtime does not support discard|refused to trim/,
    kind: "expected",
    summary:
      "the runtime refuses FITRIM: stated, not warned about, and it starts " +
      "no recovery on its own (Issue #734)",
  },
  {
    pattern: /unknown mount option/,
    kind: "defect",
    summary: "Podman refused a tmpfs mount option (Issue #727)",
  },
  {
    pattern: /short-name|unable to find a name|resolving short name/,
    kind: "defect",
    summary:
      "a base image did not resolve without a search registry (Issue #728)",
  },
  {
    pattern: /claude CLI is not installed|the claude CLI \(setup mints/,
    kind: "defect",
    summary: "setup demanded the Claude CLI on a Codex-only host (Issue #730)",
  },
  {
    pattern: /unrecognized command|volume with name .* already exists/,
    kind: "defect",
    summary: "a volume verb the runtime does not accept (Issue #731)",
  },
  {
    pattern: /\[WORK_VOLUME_UNRECOVERED\]/,
    kind: "defect",
    summary: "volume recovery could not repair the work volume (Issue #731)",
  },
];

/**
 * Classify the lines of one stage's captured output.
 *
 * @param text - Everything the stage printed
 * @returns One finding per matched line, in the order they were printed
 */
export function classifyOutput(text: string): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const line of text.split("\n")) {
    for (const signature of SIGNATURES) {
      if (!signature.pattern.test(line)) continue;
      if (seen.has(signature.summary)) continue;
      seen.add(signature.summary);
      findings.push({
        kind: signature.kind,
        summary: signature.summary,
        evidence: line.trim(),
      });
    }
  }
  return findings;
}

/** A launcher refusal that names both the floor it used and the free space. */
const EXPLAINED_REFUSAL = /below the .*floor/;
const FREE_SPACE = /\d+\s*MB free/;
const REFUSAL = /refus(ing|ed) (to launch|launch)/;

/** What the disk and volume evidence of one launch says. */
export interface DiskChainVerdict {
  /** Whether volume initialisation was seen to run at all. */
  readonly volumeInitSeen: boolean;
  /** Whether the launcher refused to launch. */
  readonly refused: boolean;
  /** Expected warnings and defects read from the evidence. */
  readonly findings: Finding[];
}

/**
 * Read the volume and disk evidence of one launch.
 *
 * The two sources are both needed and neither is optional: `volume-init`
 * speaks on the launcher's stderr, while `run.sh` writes the trim refusal and
 * every disk decision to `run_core.log`. Reading only one of them would miss
 * exactly the chain Issue #734 reported.
 *
 * @param launchOutput - Everything `run.sh` printed
 * @param runCoreLog - The `run_core.log` written during the launch
 * @returns What was seen, and how it is classified
 */
export function analyseDiskChain(
  launchOutput: string,
  runCoreLog: string,
): DiskChainVerdict {
  const combined = `${launchOutput}\n${runCoreLog}`;
  const lines = combined.split("\n");
  const volumeInitSeen = lines.some((line) => line.includes("volume-init:"));
  const trimRefused = lines.some((line) =>
    /this runtime does not support discard|refused to trim|could not trim/
      .test(line)
  );
  const refusalLine = lines.find((line) => REFUSAL.test(line));
  const findings: Finding[] = [];

  if (trimRefused) {
    findings.push({
      kind: "expected",
      summary:
        "the runtime refuses FITRIM: stated, not warned about, and it starts " +
        "no recovery on its own (Issue #734)",
      evidence: (lines.find((line) =>
        /this runtime does not support discard|refused to trim|could not trim/
          .test(line)
      ) ?? "").trim(),
    });
  }

  if (refusalLine !== undefined) {
    const explained = EXPLAINED_REFUSAL.test(refusalLine) &&
      FREE_SPACE.test(refusalLine);
    if (trimRefused) {
      findings.push({
        kind: "defect",
        summary:
          "a refused trim was followed by a refused launch — the reported " +
          "chain of Issue #734",
        evidence: refusalLine.trim(),
      });
    } else if (explained) {
      // Criterion 7 of Issue #736 accepts a refusal that explains itself: the
      // run still cannot claim, so it is not a pass, but it is not the
      // unexplained refusal Issue #732 removed either.
      findings.push({
        kind: "expected",
        summary:
          "the launcher refused work and named both the resolved floor and " +
          "the free space behind it (Issue #732)",
        evidence: refusalLine.trim(),
      });
    } else {
      findings.push({
        kind: "defect",
        summary:
          "the launcher refused work without naming the resolved floor and " +
          "the free space behind it (Issue #732)",
        evidence: refusalLine.trim(),
      });
    }
  }

  return { volumeInitSeen, refused: refusalLine !== undefined, findings };
}

/** How a stage ended. `SKIPPED` is never a pass. */
export type StageStatus = "PASS" | "FAIL" | "SKIPPED";

/** One stage of the run, as the shell sequenced it. */
export interface StageRecord {
  /** Stage name, e.g. `setup`. */
  readonly name: string;
  /** How it ended. */
  readonly status: StageStatus;
  /** One line on why — an exit status, or why it did not run. */
  readonly detail: string;
  /** Transcript file holding its output, relative to the transcript dir. */
  readonly log: string;
}

/** Everything the report is rendered from. */
export interface RunSummary {
  /** `uname -srm` of the host under test. */
  readonly host: string;
  /** Checkout directory verified. */
  readonly checkout: string;
  /** Commit the checkout was on. */
  readonly commit: string;
  /** Directory holding the transcript. */
  readonly transcript: string;
  /** The stages, in the order they ran. */
  readonly stages: readonly StageRecord[];
  /** The fresh-state decision taken before anything ran. */
  readonly freshState: FreshStateVerdict;
  /** Everything classified from the stage output. */
  readonly findings: readonly Finding[];
}

/**
 * The verdict of one run.
 *
 * `PASS` requires every stage to have passed, no workaround on the host, and
 * no defect: a skipped stage is not a pass, and neither is a run that only
 * failed to print a failure.
 *
 * @param run - The assembled run
 * @returns `PASS` or `FAIL`
 */
export function verdictFor(run: RunSummary): "PASS" | "FAIL" {
  if (run.freshState.violations.length > 0) return "FAIL";
  if (run.findings.some((finding) => finding.kind === "defect")) return "FAIL";
  if (run.stages.some((stage) => stage.status !== "PASS")) return "FAIL";
  return "PASS";
}

function bullets(items: readonly string[], empty: string): string {
  if (items.length === 0) return `${empty}\n`;
  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

/**
 * Render the report: the artefact pasted onto the issue being verified.
 *
 * @param run - The assembled run
 * @returns Markdown
 */
export function renderReport(run: RunSummary): string {
  const verdict = verdictFor(run);
  const expected = run.findings.filter((f) => f.kind === "expected");
  const defects = run.findings.filter((f) => f.kind === "defect");
  const rows = run.stages.map((stage, index) =>
    `| ${index + 1} | ${stage.name} | ${stage.status} | ${stage.detail} | ` +
    `\`${stage.log}\` |`
  ).join("\n");

  return [
    "# Fresh first-run verification (Issue #736)",
    "",
    `- host: \`${run.host}\``,
    `- checkout: \`${run.checkout}\` at \`${run.commit}\``,
    `- transcript: \`${run.transcript}\``,
    `- verdict: **${verdict}**`,
    "",
    "## Stages",
    "",
    "| # | Stage | Status | Detail | Output |",
    "| --- | --- | --- | --- | --- |",
    rows,
    "",
    "## Fresh-state violations",
    "",
    bullets(
      run.freshState.violations,
      "None — the host carried no workaround.",
    ),
    "## Expected warnings",
    "",
    bullets(
      expected.map((f) => `${f.summary}: \`${f.evidence}\``),
      "None observed.",
    ),
    "## New defects",
    "",
    defects.length === 0
      ? "None — no workaround was required.\n"
      : "Each of these is a defect to file as a further sub-issue of #722.\n\n" +
        bullets(defects.map((f) => `${f.summary}: \`${f.evidence}\``), ""),
    ...(run.freshState.notes.length > 0
      ? ["## Notes", "", bullets(run.freshState.notes, "")]
      : []),
  ].join("\n");
}
