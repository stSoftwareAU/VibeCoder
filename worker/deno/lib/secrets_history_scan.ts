/**
 * Full-history secrets scan across every ref, with a rotation log
 * (Issue #4190, part of the #4160 proving-ground hardening).
 *
 * `.github/workflows/gitleaks.yml` scans a pull request's commit range only.
 * That leaves the private history unaudited: a credential that leaked into an
 * old commit on a long-dead branch — or into a tag — never appears in any PR
 * diff again, yet it is still live until somebody rotates it.
 *
 * This module drives **both** scanners over **all** refs:
 *
 *   - `gitleaks git <repo> --log-opts=--all` — `--all` hands `git log` every
 *     ref, branches and tags alike, so the sweep is ref-complete by
 *     construction rather than by convention.
 *   - `trufflehog git file://<repo>` — an independent second opinion over the
 *     same local clone.
 *
 * Three invariants hold throughout:
 *
 *   1. **No secret value ever leaves the scanners.** Only the location
 *      (commit, path, line) and the rule/detector name are lifted out of the
 *      scanner output; the `Secret`, `Match`, `Raw` and `RawV2` fields are
 *      never read, so the report cannot print a live credential.
 *   2. **Fail loud.** A missing scanner binary, an unreadable baseline, or an
 *      unexpected scanner exit code is an error — never an empty finding list
 *      reported as a clean sweep (Issue #3234).
 *   3. **Unrotated means blocked.** A confirmed finding whose credential has
 *      not been rotated fails the run, so Phase 3 cannot proceed on a
 *      still-live leak.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

/** A location-only finding — never carries the secret value itself. */
export interface HistoryFinding {
  /** Scanner that reported it. */
  scanner: "gitleaks" | "trufflehog";
  /** Commit SHA the secret was introduced in (`unknown` if unreported). */
  commit: string;
  /** Repository-relative path. */
  path: string;
  /** Rule id (gitleaks) or detector name (trufflehog). */
  rule: string;
  /** 1-based line number, when the scanner reported one. */
  line?: number;
}

/** Shared fields of every baseline entry. */
interface BaselineEntryBase {
  commit: string;
  path: string;
  rule: string;
  /** Why this entry exists — mandatory, per Issue #4190. */
  reason: string;
}

/** A confirmed false positive, suppressed on later runs. */
export type FalsePositiveEntry = BaselineEntryBase;

/** A confirmed real leak, with its rotation state. */
export interface RotationEntry extends BaselineEntryBase {
  /** e.g. `github-pat`, `aws-access-key`, `imgbb-api-key`. */
  credentialClass: string;
  /** Where the credential was used, so the rotation has a blast radius. */
  usedIn: string;
  /** True once the credential has actually been rotated. */
  rotated: boolean;
  /** ISO `YYYY-MM-DD` rotation date — required when `rotated` is true. */
  rotatedOn?: string | null;
}

/** The baseline/allowlist file contents. */
export interface SecretsBaseline {
  /** Free-text note for humans reading the file. */
  note?: string;
  falsePositives: FalsePositiveEntry[];
  confirmed: RotationEntry[];
}

/** Status assigned to a deduplicated finding. */
export type FindingStatus = "false-positive" | "confirmed" | "unbaselined";

/** One row of the report — a finding merged across scanners. */
export interface EvaluatedFinding {
  key: string;
  commit: string;
  path: string;
  rule: string;
  /** Every scanner that reported this location, sorted. */
  scanners: string[];
  status: FindingStatus;
  /** Baseline reason, when baselined. */
  reason?: string;
  /** Rotation entry, when confirmed. */
  rotation?: RotationEntry;
}

/** A ref in scope for the sweep. */
export interface ScannedRef {
  name: string;
  kind: "branch" | "tag" | "other";
}

/** A scanner invocation, as data so it can be asserted on and stubbed. */
export interface ScanCommand {
  bin: string;
  args: string[];
}

/** Result of running a {@link ScanCommand}. */
export interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command in `cwd`. Injected so tests can stub the scanners. */
export type CommandRunner = (
  cmd: ScanCommand,
  cwd: string,
) => Promise<CommandOutcome>;

/** Options for {@link runFullHistoryScan}. */
export interface FullHistoryScanOptions {
  /** Repository to sweep. */
  repoDir: string;
  /** Baseline/allowlist JSON path. */
  baselinePath: string;
  /** Markdown report output path. */
  reportPath: string;
  /** gitleaks config (defaults to the repo's `.github/gitleaks.toml`). */
  gitleaksConfig?: string;
  /** Where gitleaks writes its JSON report (a temp file by default). */
  gitleaksReportPath?: string;
  /** Command runner — defaults to a real subprocess runner. */
  runner?: CommandRunner;
  /** Timestamp stamped into the report. */
  now?: Date;
  /** Set false to skip writing the report to disk. */
  writeReport?: boolean;
}

/** Outcome of a full sweep. */
export interface FullHistoryScanResult {
  /** False when the run must exit non-zero. */
  ok: boolean;
  refs: ScannedRef[];
  findings: EvaluatedFinding[];
  unbaselined: EvaluatedFinding[];
  unrotated: RotationEntry[];
  /** Baseline entries matching no finding — reported, but not fatal. */
  staleBaselineKeys: string[];
  /** Structural problems in the baseline file — fatal. */
  baselineErrors: string[];
  report: string;
  reportPath: string;
  /** One-line human summary. */
  summary: string;
}

/** ISO calendar date, e.g. `2026-08-18`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Minimum length of a `reason` — a bare "ok" explains nothing. */
const MIN_REASON_LENGTH = 10;

/** Stable identity of a finding, independent of which scanner saw it. */
export function findingKey(
  finding: { commit: string; path: string; rule: string },
): string {
  return `${finding.commit}|${finding.path}|${finding.rule}`;
}

/**
 * Build the gitleaks invocation for a full-history sweep.
 *
 * `--log-opts=--all` is the load-bearing flag: it makes gitleaks walk every
 * ref (branches *and* tags) rather than the checked-out branch alone.
 * `--redact` keeps secret values out of gitleaks' own stdout.
 */
export function buildGitleaksCommand(
  repoDir: string,
  reportPath: string,
  configPath?: string,
): ScanCommand {
  const args = [
    "git",
    repoDir,
    "--log-opts=--all",
    "--no-banner",
    "--redact",
    "--report-format",
    "json",
    "--report-path",
    reportPath,
  ];
  if (configPath) args.push("--config", configPath);
  return { bin: "gitleaks", args };
}

/**
 * Build the trufflehog invocation for a full-history sweep.
 *
 * With no `--branch` filter, trufflehog's git source walks every ref in the
 * local clone, mirroring gitleaks' `--log-opts=--all` scope.
 */
export function buildTrufflehogCommand(repoDir: string): ScanCommand {
  return {
    bin: "trufflehog",
    args: ["git", `file://${repoDir}`, "--json", "--no-update"],
  };
}

/**
 * Parse a gitleaks JSON report into location-only findings.
 *
 * Only `Commit`, `File`, `RuleID` and `StartLine` are read — the `Secret` and
 * `Match` fields are deliberately never touched, so a secret value cannot
 * reach the report.
 */
export function parseGitleaksReport(json: string): HistoryFinding[] {
  const trimmed = json.trim();
  if (trimmed === "" || trimmed === "null") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `gitleaks report is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("gitleaks report is not a JSON array");
  }
  const findings: HistoryFinding[] = [];
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    findings.push({
      scanner: "gitleaks",
      commit: asText(entry["Commit"]) || "unknown",
      path: asText(entry["File"]) || "unknown",
      rule: asText(entry["RuleID"]) || "unknown",
      ...(typeof entry["StartLine"] === "number"
        ? { line: entry["StartLine"] }
        : {}),
    });
  }
  return findings;
}

/**
 * Parse trufflehog's newline-delimited JSON output into location-only
 * findings. Non-JSON log lines are ignored; `Raw`/`RawV2` are never read.
 */
export function parseTrufflehogOutput(stdout: string): HistoryFinding[] {
  const findings: HistoryFinding[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // Progress/log line — not a result.
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const entry = parsed as Record<string, unknown>;
    const detector = asText(entry["DetectorName"]);
    if (detector === "") continue; // Not a result record.
    const git = readGitMetadata(entry);
    findings.push({
      scanner: "trufflehog",
      commit: asText(git["commit"]) || "unknown",
      path: asText(git["file"]) || "unknown",
      rule: detector,
      ...(typeof git["line"] === "number" ? { line: git["line"] } : {}),
    });
  }
  return findings;
}

/** Pull `SourceMetadata.Data.Git` out of a trufflehog record. */
function readGitMetadata(entry: Record<string, unknown>): Record<
  string,
  unknown
> {
  const metadata = entry["SourceMetadata"];
  if (typeof metadata !== "object" || metadata === null) return {};
  const data = (metadata as Record<string, unknown>)["Data"];
  if (typeof data !== "object" || data === null) return {};
  const git = (data as Record<string, unknown>)["Git"];
  if (typeof git !== "object" || git === null) return {};
  return git as Record<string, unknown>;
}

/** Coerce an unknown JSON value to a trimmed string. */
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse and structurally validate a baseline file's contents.
 *
 * Returns the baseline plus every structural problem found. Callers treat a
 * non-empty error list as fatal — a malformed baseline must never silently
 * suppress findings.
 */
export function parseBaseline(
  json: string,
): { baseline: SecretsBaseline; errors: string[] } {
  const empty: SecretsBaseline = { falsePositives: [], confirmed: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    return {
      baseline: empty,
      errors: [`baseline is not valid JSON: ${(error as Error).message}`],
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { baseline: empty, errors: ["baseline must be a JSON object"] };
  }
  const source = parsed as Record<string, unknown>;
  const errors: string[] = [];
  const falsePositives = readEntries(
    source["falsePositives"],
    "falsePositives",
    errors,
  );
  const confirmedRaw = readEntries(source["confirmed"], "confirmed", errors);

  const seen = new Set<string>();
  const fps: FalsePositiveEntry[] = [];
  for (const [index, entry] of falsePositives.entries()) {
    const base = validateBase(entry, `falsePositives[${index}]`, errors);
    if (base === null) continue;
    flagDuplicate(seen, findingKey(base), `falsePositives[${index}]`, errors);
    fps.push(base);
  }

  const confirmed: RotationEntry[] = [];
  for (const [index, entry] of confirmedRaw.entries()) {
    const label = `confirmed[${index}]`;
    const base = validateBase(entry, label, errors);
    if (base === null) continue;
    flagDuplicate(seen, findingKey(base), label, errors);
    const credentialClass = asText(entry["credentialClass"]);
    const usedIn = asText(entry["usedIn"]);
    if (credentialClass === "") {
      errors.push(`${label}: "credentialClass" is required`);
    }
    if (usedIn === "") {
      errors.push(`${label}: "usedIn" is required (where was it used?)`);
    }
    const rotated = entry["rotated"];
    if (typeof rotated !== "boolean") {
      errors.push(`${label}: "rotated" must be true or false`);
    }
    const rotatedOn = asText(entry["rotatedOn"]);
    if (rotated === true && !ISO_DATE.test(rotatedOn)) {
      errors.push(
        `${label}: "rotatedOn" must be an ISO date (YYYY-MM-DD) once rotated`,
      );
    }
    confirmed.push({
      ...base,
      credentialClass,
      usedIn,
      rotated: rotated === true,
      rotatedOn: rotatedOn === "" ? null : rotatedOn,
    });
  }

  const note = asText(source["note"]);
  return {
    baseline: {
      ...(note === "" ? {} : { note }),
      falsePositives: fps,
      confirmed,
    },
    errors,
  };
}

/** Read a list-valued baseline section, recording a type error if wrong. */
function readEntries(
  value: unknown,
  label: string,
  errors: string[],
): Array<Record<string, unknown>> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    errors.push(`"${label}" must be an array`);
    return [];
  }
  const entries: Array<Record<string, unknown>> = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      errors.push(`${label}[${index}]: entry must be an object`);
      continue;
    }
    entries.push(item as Record<string, unknown>);
  }
  return entries;
}

/** Validate the fields every baseline entry shares. */
function validateBase(
  entry: Record<string, unknown>,
  label: string,
  errors: string[],
): BaselineEntryBase | null {
  const commit = asText(entry["commit"]);
  const path = asText(entry["path"]);
  const rule = asText(entry["rule"]);
  const reason = asText(entry["reason"]);
  let valid = true;
  for (
    const [field, value] of [["commit", commit], ["path", path], [
      "rule",
      rule,
    ]] as const
  ) {
    if (value === "") {
      errors.push(`${label}: "${field}" is required`);
      valid = false;
    }
  }
  if (reason.length < MIN_REASON_LENGTH) {
    errors.push(
      `${label}: "reason" must explain the entry in at least ` +
        `${MIN_REASON_LENGTH} characters`,
    );
    valid = false;
  }
  return valid ? { commit, path, rule, reason } : null;
}

/** Record a duplicate baseline key as an error. */
function flagDuplicate(
  seen: Set<string>,
  key: string,
  label: string,
  errors: string[],
): void {
  if (seen.has(key)) {
    errors.push(`${label}: duplicate baseline entry for ${key}`);
    return;
  }
  seen.add(key);
}

/**
 * Merge raw scanner findings into one row per location and classify each row
 * against the baseline.
 */
export function evaluateFindings(
  findings: readonly HistoryFinding[],
  baseline: SecretsBaseline,
): {
  rows: EvaluatedFinding[];
  unbaselined: EvaluatedFinding[];
  unrotated: RotationEntry[];
  staleBaselineKeys: string[];
} {
  const falsePositives = new Map(
    baseline.falsePositives.map((e) => [findingKey(e), e]),
  );
  const confirmed = new Map(baseline.confirmed.map((e) => [findingKey(e), e]));

  const merged = new Map<string, EvaluatedFinding>();
  for (const finding of findings) {
    const key = findingKey(finding);
    const existing = merged.get(key);
    if (existing) {
      if (!existing.scanners.includes(finding.scanner)) {
        existing.scanners.push(finding.scanner);
        existing.scanners.sort();
      }
      continue;
    }
    const fp = falsePositives.get(key);
    const hit = confirmed.get(key);
    merged.set(key, {
      key,
      commit: finding.commit,
      path: finding.path,
      rule: finding.rule,
      scanners: [finding.scanner],
      status: fp ? "false-positive" : hit ? "confirmed" : "unbaselined",
      ...(fp ? { reason: fp.reason } : {}),
      ...(hit ? { reason: hit.reason, rotation: hit } : {}),
    });
  }

  const rows = [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
  const unbaselined = rows.filter((r) => r.status === "unbaselined");
  // Every confirmed leak must be rotated — including one no longer detected,
  // because the credential it exposed is live until somebody rotates it.
  const unrotated = baseline.confirmed.filter((e) => !e.rotated);
  const matchedKeys = new Set(rows.map((r) => r.key));
  const staleBaselineKeys = [
    ...falsePositives.keys(),
    ...confirmed.keys(),
  ].filter((k) => !matchedKeys.has(k)).sort();

  return { rows, unbaselined, unrotated, staleBaselineKeys };
}

/** Inputs for {@link renderReport}. */
export interface RenderReportOptions {
  repoDir: string;
  scannedAt: Date;
  refs: readonly ScannedRef[];
  rows: readonly EvaluatedFinding[];
  confirmed: readonly RotationEntry[];
  unbaselined: readonly EvaluatedFinding[];
  unrotated: readonly RotationEntry[];
  staleBaselineKeys: readonly string[];
  baselinePath: string;
}

/**
 * Render the deterministic Markdown report.
 *
 * Rows carry the location and rule only; no secret value is ever available to
 * this function, by construction of the parsers above.
 */
export function renderReport(options: RenderReportOptions): string {
  const {
    repoDir,
    scannedAt,
    refs,
    rows,
    confirmed,
    unbaselined,
    unrotated,
    staleBaselineKeys,
    baselinePath,
  } = options;
  const branches = refs.filter((r) => r.kind === "branch").length;
  const tags = refs.filter((r) => r.kind === "tag").length;

  const lines: string[] = [
    "# 🔐 Full-history secret scan",
    "",
    "Generated by `mod.ts secrets-history-scan` (Issue #4190) — do not edit",
    "by hand; edit the baseline instead. Locations and rule names only: the",
    "report never contains a secret value.",
    "",
    `- **Scanned at**: ${scannedAt.toISOString()}`,
    `- **Repository**: \`${basename(repoDir)}\``,
    `- **Refs in scope**: ${refs.length} (${branches} branches, ${tags} tags)`,
    `- **Scanners**: gitleaks (\`--log-opts=--all\`), trufflehog`,
    `- **Baseline**: \`${relativise(baselinePath, repoDir)}\``,
    "",
    "## Findings",
    "",
  ];

  if (rows.length === 0) {
    lines.push("No findings across any ref.", "");
  } else {
    lines.push(
      "| Commit | Path | Rule | Scanners | Status |",
      "| ------ | ---- | ---- | -------- | ------ |",
    );
    for (const row of rows) {
      lines.push(
        `| \`${row.commit}\` | \`${row.path}\` | \`${row.rule}\` | ` +
          `${row.scanners.join(", ")} | ${statusLabel(row.status)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Rotation log", "");
  if (confirmed.length === 0) {
    lines.push("No confirmed findings — nothing to rotate.", "");
  } else {
    lines.push(
      "| Commit | Path | Credential class | Where used | Rotated | Date |",
      "| ------ | ---- | ---------------- | ---------- | ------- | ---- |",
    );
    for (const entry of [...confirmed].sort(byKey)) {
      lines.push(
        `| \`${entry.commit}\` | \`${entry.path}\` | ` +
          `${entry.credentialClass} | ${entry.usedIn} | ` +
          `${entry.rotated ? "✅ rotated" : "❌ NOT ROTATED"} | ` +
          `${entry.rotatedOn ?? "—"} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Verdict", "");
  if (unbaselined.length === 0 && unrotated.length === 0) {
    lines.push(
      "✅ Every finding is baselined and every confirmed leak is rotated.",
      "",
    );
  } else {
    if (unbaselined.length > 0) {
      lines.push(
        `❌ ${unbaselined.length} unbaselined finding(s) — triage each into ` +
          "the baseline as a false positive (with a reason) or as a confirmed " +
          "leak (with a rotation row):",
        "",
      );
      for (const row of unbaselined) lines.push(`- \`${row.key}\``);
      lines.push("");
    }
    if (unrotated.length > 0) {
      lines.push(
        `❌ ${unrotated.length} confirmed finding(s) awaiting rotation — ` +
          "Phase 3 is blocked until each is rotated:",
        "",
      );
      for (const entry of [...unrotated].sort(byKey)) {
        lines.push(`- \`${findingKey(entry)}\` (${entry.credentialClass})`);
      }
      lines.push("");
    }
  }

  if (staleBaselineKeys.length > 0) {
    lines.push(
      "## Stale baseline entries",
      "",
      "These baseline entries matched no finding in this sweep. They are not",
      "fatal, but a stale entry suppresses nothing and should be removed.",
      "",
    );
    for (const key of staleBaselineKeys) lines.push(`- \`${key}\``);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Last path segment. The report is a committed artefact, so it names the
 * repository rather than the operator's absolute checkout path — an internal
 * path is exactly the sort of detail the export scrub strips.
 */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Express `path` relative to `repoDir` when it sits inside it. */
function relativise(path: string, repoDir: string): string {
  const root = repoDir.replace(/\/+$/, "") + "/";
  return path.startsWith(root) ? path.slice(root.length) : basename(path);
}

/** Sort baseline entries deterministically. */
function byKey(a: BaselineEntryBase, b: BaselineEntryBase): number {
  return findingKey(a).localeCompare(findingKey(b));
}

/** Human-readable status cell. */
function statusLabel(status: FindingStatus): string {
  switch (status) {
    case "false-positive":
      return "false positive (baselined)";
    case "confirmed":
      return "confirmed";
    default:
      return "**UNBASELINED**";
  }
}

/** Default runner — spawns the scanner as a subprocess. */
const defaultRunner: CommandRunner = async (cmd, cwd) => {
  let output: Deno.CommandOutput;
  try {
    output = await new Deno.Command(cmd.bin, {
      args: cmd.args,
      cwd,
      stdout: "piped",
      stderr: "piped",
    }).output();
  } catch (error) {
    // Fail loud: a missing scanner must never look like a clean sweep.
    throw new Error(
      `failed to run "${cmd.bin}": ${(error as Error).message}. ` +
        `Install ${cmd.bin} before running the full-history scan.`,
    );
  }
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
};

/** Enumerate every ref in the repository (branches, tags, remotes). */
export async function listRefs(
  repoDir: string,
  runner: CommandRunner = defaultRunner,
): Promise<ScannedRef[]> {
  const result = await runner(
    { bin: "git", args: ["for-each-ref", "--format=%(refname)"] },
    repoDir,
  );
  if (result.code !== 0) {
    throw new Error(
      `git for-each-ref failed in ${repoDir} (exit ${result.code}): ` +
        result.stderr.trim(),
    );
  }
  const refs: ScannedRef[] = [];
  for (const line of result.stdout.split("\n")) {
    const name = line.trim();
    if (name === "") continue;
    refs.push({
      name,
      kind: name.startsWith("refs/tags/")
        ? "tag"
        : name.startsWith("refs/heads/") || name.startsWith("refs/remotes/")
        ? "branch"
        : "other",
    });
  }
  return refs;
}

/**
 * Run the full-history sweep: both scanners over every ref, classified
 * against the baseline, written to a deterministic Markdown report.
 *
 * The result is `ok: false` — the caller exits non-zero — when the baseline
 * is malformed, when any finding is unbaselined, or while any confirmed
 * finding is unrotated.
 *
 * Throws (fail loud) when a scanner is missing, exits unexpectedly, or the
 * baseline file cannot be read.
 */
export async function runFullHistoryScan(
  options: FullHistoryScanOptions,
): Promise<FullHistoryScanResult> {
  const runner = options.runner ?? defaultRunner;
  const now = options.now ?? new Date();
  const repoDir = options.repoDir;

  const refs = await listRefs(repoDir, runner);
  if (refs.length === 0) {
    throw new Error(
      `no refs found in ${repoDir} — a full-history scan needs a git ` +
        "repository with at least one ref",
    );
  }

  const baselineText = await readBaseline(options.baselinePath);
  const { baseline, errors: baselineErrors } = parseBaseline(baselineText);

  const gitleaksReportPath = options.gitleaksReportPath ??
    await Deno.makeTempFile({ prefix: "gitleaks-", suffix: ".json" });
  const gitleaksCmd = buildGitleaksCommand(
    repoDir,
    gitleaksReportPath,
    options.gitleaksConfig,
  );
  const gitleaksResult = await runner(gitleaksCmd, repoDir);
  // gitleaks exits 0 (clean) or 1 (leaks found); anything else is a fault.
  if (gitleaksResult.code !== 0 && gitleaksResult.code !== 1) {
    throw new Error(
      `gitleaks failed (exit ${gitleaksResult.code}): ` +
        gitleaksResult.stderr.trim(),
    );
  }
  const findings: HistoryFinding[] = [
    ...parseGitleaksReport(await readReportFile(gitleaksReportPath)),
  ];

  const trufflehogCmd = buildTrufflehogCommand(repoDir);
  const trufflehogResult = await runner(trufflehogCmd, repoDir);
  if (trufflehogResult.code !== 0) {
    throw new Error(
      `trufflehog failed (exit ${trufflehogResult.code}): ` +
        trufflehogResult.stderr.trim(),
    );
  }
  findings.push(...parseTrufflehogOutput(trufflehogResult.stdout));

  const { rows, unbaselined, unrotated, staleBaselineKeys } = evaluateFindings(
    findings,
    baseline,
  );

  const report = renderReport({
    repoDir,
    scannedAt: now,
    refs,
    rows,
    confirmed: baseline.confirmed,
    unbaselined,
    unrotated,
    staleBaselineKeys,
    baselinePath: options.baselinePath,
  });

  if (options.writeReport !== false) {
    await writeReport(options.reportPath, report);
  }

  const ok = baselineErrors.length === 0 && unbaselined.length === 0 &&
    unrotated.length === 0;
  const summary = buildSummary({
    ok,
    refs: refs.length,
    rows: rows.length,
    unbaselined: unbaselined.length,
    unrotated: unrotated.length,
    baselineErrors,
  });

  return {
    ok,
    refs,
    findings: rows,
    unbaselined,
    unrotated,
    staleBaselineKeys,
    baselineErrors,
    report,
    reportPath: options.reportPath,
    summary,
  };
}

/** Read the baseline file, failing loud when it is missing. */
async function readBaseline(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    throw new Error(
      `cannot read baseline ${path}: ${(error as Error).message}. ` +
        "The baseline is mandatory — an absent file must not be read as " +
        "'nothing to suppress'.",
    );
  }
}

/** Read a scanner report file; an absent file means the scanner found none. */
async function readReportFile(path: string): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return "";
    throw error;
  }
}

/** Write the report, creating parent directories as needed. */
async function writeReport(path: string, contents: string): Promise<void> {
  const separator = path.lastIndexOf("/");
  if (separator > 0) {
    await Deno.mkdir(path.slice(0, separator), { recursive: true });
  }
  await Deno.writeTextFile(path, contents);
}

/** Compose the one-line summary printed by the command. */
function buildSummary(counts: {
  ok: boolean;
  refs: number;
  rows: number;
  unbaselined: number;
  unrotated: number;
  baselineErrors: string[];
}): string {
  const scope = `${counts.rows} finding(s) across ${counts.refs} ref(s)`;
  if (counts.ok) {
    return `✅ Full-history secret scan clean: ${scope}, all baselined and ` +
      "rotated.";
  }
  const problems: string[] = [];
  if (counts.baselineErrors.length > 0) {
    problems.push(`${counts.baselineErrors.length} baseline error(s)`);
  }
  if (counts.unbaselined > 0) {
    problems.push(`${counts.unbaselined} unbaselined finding(s)`);
  }
  if (counts.unrotated > 0) {
    problems.push(`${counts.unrotated} unrotated confirmed finding(s)`);
  }
  return `❌ Full-history secret scan failed: ${problems.join(", ")} ` +
    `(${scope}).`;
}
