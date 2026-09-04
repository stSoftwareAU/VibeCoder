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

import { type EnvLookup, processEnvLookup } from "./env_lookup.ts";
import { redactSecrets } from "./secret_redaction.ts";

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
  {
    name: "VIBE_HOST_DISK_AVAIL_BYTES",
    reason:
      "the disk reading must come from the host, not from a handed-in figure (Issue #226)",
  },
  {
    name: "VIBE_HOST_DISK_TOTAL_BYTES",
    reason:
      "the disk reading must come from the host, not from a handed-in figure (Issue #226)",
  },
  {
    name: "VIBE_SKIP_CHECKOUT_UPDATE",
    reason: "the launcher's checkout update must run unaided (Issue #735)",
  },
];

/**
 * The workaround-shaped variables this host actually carries (Issue #962).
 *
 * The one place the preflight reads an environment, so the read has a seam:
 * `first_run_verify.ts` used to call `Deno.env.get` per name inline, which
 * left the command testable only by setting the variables on the process —
 * and a process the preflight itself judges, so the test had to clear them
 * again afterwards or turn every later prerequisite check into a skip
 * (Issue #880, plan in #944).
 *
 * @param env - The host environment. Defaults to the process environment, so
 *   a real verification run reads exactly what it read before.
 * @returns Name to value, holding only the variables that are set.
 */
export function readWorkaroundEnv(
  env: EnvLookup = processEnvLookup,
): Record<string, string> {
  const present: Record<string, string> = {};
  for (const { name } of WORKAROUND_ENV_VARS) {
    const value = env(name);
    if (value !== undefined) present[name] = value;
  }
  return present;
}

/** Short-name settings a fresh host must not need (Issue #728). */
const SHORT_NAME_SETTINGS = ["[aliases]", "unqualified-search-registries"];

/** The host state the fresh-state decision is made from. */
export interface FreshStateFacts {
  /** Workaround-shaped variables, as read from the environment. */
  readonly env: Readonly<Record<string, string>>;
  /** Resolved configuration file, by the repository's own rule. */
  readonly configFile: string;
  /** Whether that configuration file already exists. */
  readonly configFileExists: boolean;
  /** Whether a Claude CLI is on the host's PATH. */
  readonly claudeOnPath: boolean;
  /** Repository names the container runtime already holds locally. */
  readonly localImages: readonly string[];
  /**
   * Provider the run declares to `setup.sh` through `VIBE_AGENT_PROVIDER`.
   *
   * A bare host has no `.config.json` for setup to read the selection from —
   * criterion 2 requires setup to write it — so the run must say which agent
   * the host is being configured for (`docs/SETUP.md`). It is a declaration,
   * not a workaround, so it is recorded as a note and the reader judges it.
   */
  readonly declaredProvider?: string;
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

  // "No pre-pulled or manually tagged images" is the issue's own wording, and
  // it is the base layers that matter as much as the worker image: a host that
  // already holds docker.io/library/… resolved those names before this run
  // started, so a build that depended on a search registry would never be seen
  // to (Issue #728).
  const present = facts.localImages.map((image) => image.trim()).filter((
    image,
  ) => image !== "" && image !== "<none>");
  if (present.length > 0) {
    violations.push(
      `the container runtime already holds ${present.length} image(s) ` +
        `(${present.join(", ")}) — the build must resolve and pull every ` +
        `layer itself on a fresh host`,
    );
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
  // not depend on either setting — which is worth recording, not refusing.
  for (const setting of SHORT_NAME_SETTINGS) {
    if (
      facts.systemRegistriesConf !== null &&
      setsUncommented(facts.systemRegistriesConf, setting)
    ) {
      notes.push(
        `/etc/containers/registries.conf sets ${setting} (distribution ` +
          `default) — both base images name docker.io, so the build must not ` +
          `depend on it`,
      );
    }
  }

  if (facts.declaredProvider) {
    notes.push(
      `the run declares VIBE_AGENT_PROVIDER=${facts.declaredProvider} to ` +
        `setup.sh — a bare host has no .config.json for setup to read the ` +
        `selection from, and docs/SETUP.md names this as the first-run way ` +
        `to say which agent the host runs (Issue #730)`,
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

/**
 * A refusal that names both the floor it used and the free space behind it.
 *
 * Two subsystems can refuse, and criterion 7 of Issue #736 is about both. The
 * **launcher** refuses to start at all (`run.sh`: "refusing to launch: N MB
 * free, below the N GB hard floor"); the **worker** starts and then refuses to
 * claim (`[HOST_DISK_LOW] … GB free (…%) of …, floor … — below the floor`,
 * `run_core.ts`). The launcher speaks in MB and the worker in GB, so both
 * units are matched — a refusal read from the wrong unit would be reported as
 * unexplained, which is the Issue #732 defect.
 */
const EXPLAINED_REFUSAL = /below the .*floor|floor \d/;
const FREE_SPACE = /\d+(\.\d+)?\s*[MG]B free/;
const REFUSAL = /refus(ing|ed) (to launch|launch)|\[HOST_DISK_LOW\]/;

/** What the disk and volume evidence of one launch says. */
export interface DiskChainVerdict {
  /** Whether volume initialisation was seen to run at all. */
  readonly volumeInitSeen: boolean;
  /**
   * Whether the volume itself is implicated — a refused trim followed by a
   * refused launch, the chain Issue #734 reported.
   *
   * A refusal on its own is a disk decision, not a volume fault, so it must
   * not be reported against the volume-init row: the two have different
   * owners and a reader chasing the wrong one wastes the run.
   */
  readonly volumeImplicated: boolean;
  /** Whether work was refused, by the launcher or by the worker. */
  readonly refused: boolean;
  /** Expected warnings and defects read from the evidence. */
  readonly findings: Finding[];
}

/**
 * Read the volume and disk evidence of one launch.
 *
 * All three sources are needed and none is optional: `volume-init` speaks on
 * the launcher's stderr, `run.sh` writes the trim refusal and every launch-time
 * disk decision to `run_core.log`, and the **worker** writes its claim-time
 * refusal to `worker.log` — which is the refusal criterion 7 of Issue #736 is
 * actually about. Reading only the launcher would miss the chain Issue #734
 * reported; reading only the launcher and `run_core.log` would report a worker
 * that started and then refused to claim as "claimed nothing", with neither
 * the floor nor the free space behind it.
 *
 * @param launchOutput - Everything `run.sh` printed
 * @param runCoreLog - The `run_core.log` written during this launch
 * @param workerLog - The `worker.log` written during this run
 * @returns What was seen, and how it is classified
 */
export function analyseDiskChain(
  launchOutput: string,
  runCoreLog: string,
  workerLog = "",
): DiskChainVerdict {
  const combined = `${launchOutput}\n${runCoreLog}\n${workerLog}`;
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
          "work was refused, and the refusal named both the resolved floor " +
          "and the free space behind it (Issue #732)",
        evidence: refusalLine.trim(),
      });
    } else {
      findings.push({
        kind: "defect",
        summary:
          "work was refused without naming the resolved floor and the free " +
          "space behind it (Issue #732)",
        evidence: refusalLine.trim(),
      });
    }
  }

  return {
    volumeInitSeen,
    volumeImplicated: trimRefused && refusalLine !== undefined,
    refused: refusalLine !== undefined,
    findings,
  };
}

/**
 * Markers the worker prints when it takes an issue.
 *
 * Both are the worker's own, read from `run_core.ts`: `Processing issue …#N`
 * when a cycle picks one up, `Successfully processed` when it finishes. They
 * live here rather than in the harness's shell so a rename is caught by this
 * module's tests, alongside every other signature the run reads.
 */
const CLAIMED = /Processing issue[^\n]*#\d+/;
const COMPLETED = /Successfully processed/;

/** What the worker log says the worker did with the issue it was given. */
export interface ClaimVerdict {
  /** Whether the worker was seen to take an issue. */
  readonly claimed: boolean;
  /** Whether it was seen to finish one. */
  readonly completed: boolean;
  /** One line on what was seen, for the stage record. */
  readonly detail: string;
}

/**
 * Decide whether the worker claimed one issue and took it to completion.
 *
 * A log that shows neither marker is "nothing was seen", never a pass: absence
 * of a failure is not success.
 *
 * @param workerLog - Everything the worker printed
 * @returns What the log shows, and the line the report records
 */
export function evaluateClaim(workerLog: string): ClaimVerdict {
  const claimed = CLAIMED.test(workerLog);
  const completed = COMPLETED.test(workerLog);
  if (completed) {
    return { claimed: true, completed: true, detail: "one issue completed" };
  }
  return {
    claimed,
    completed: false,
    detail: claimed
      ? "the worker claimed an issue but did not complete one"
      : "the worker claimed no issue",
  };
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
 * Every line it quotes came from a stage's captured output, and its documented
 * destination is a public issue, so the whole rendered report goes through
 * {@link redactSecrets} before it is returned — the same treatment every other
 * outbound sink in this repository gets.
 *
 * @param run - The assembled run
 * @returns Markdown, with any secret shape masked
 */
export function renderReport(run: RunSummary): string {
  return redactSecrets(renderReportUnredacted(run));
}

function renderReportUnredacted(run: RunSummary): string {
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
