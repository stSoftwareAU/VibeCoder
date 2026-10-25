/**
 * Capability-scoped security guidance (Issues #4365 and #4366).
 *
 * A small, version-controlled bundle shared by issue implementation and
 * review. Selection uses the task, entry points, imports, callers and sinks.
 * A file extension never selects a capability on its own. The bundle is read
 * from the trusted VibeCoder tree; a pull request that edits it is reviewed
 * against the base copy, so it cannot weaken the checks used to review it.
 *
 * Attribution lives in `docs/REFERENCES.md` and `docs/CAPABILITY-SECURITY-GUIDANCE.md`.
 * The rendered prompt does not carry the bibliography.
 *
 * Australian English throughout (authorise, behaviour).
 *
 * @module
 */

import type { ChecklistState } from "./review_checklists.ts";

/** Repo-relative path of the guidance bundle. */
export const CAPABILITY_BUNDLE_PATH =
  "prompts/coding_guidelines/capability-security.json";

/** URL of the bundle next to this module's repository tree. */
export function capabilityBundleUrl(): URL {
  return new URL(
    "../../../prompts/coding_guidelines/capability-security.json",
    import.meta.url,
  );
}

export interface CapabilitySignals {
  task: string[];
  imports: string[];
  entryPoints: string[];
  callers: string[];
  /** Each group matches a line that contains every fragment. */
  sinks: string[][];
}

export interface CapabilityEntry {
  id: string;
  title: string;
  advice: string;
  validation: string;
  reviewCheck: string;
  signals: CapabilitySignals;
}

export interface CapabilityBundle {
  revision: string;
  attribution: string;
  entries: CapabilityEntry[];
}

export type CapabilityLoad =
  | { kind: "absent" }
  | { kind: "loaded"; bundle: CapabilityBundle; headCopy?: true }
  | { kind: "malformed"; reason: string; headCopy?: true }
  | { kind: "unreadable"; reason: string; headCopy?: true }
  | { kind: "fetch_failed"; reason: string };

export interface CapabilityContext {
  task: string;
  entryPoints: readonly string[];
  imports: readonly string[];
  callers: readonly string[];
  sinks: readonly string[];
}

export interface CapabilityMatch {
  entry: CapabilityEntry;
  because: string[];
}

export interface CapabilitySelection {
  status: "applied" | "none";
  revision: string;
  matches: CapabilityMatch[];
}

export interface CapabilitySecurityEvidence {
  status: "applied" | "none" | "unavailable";
  revision: string | null;
  selected: { id: string; because: string[] }[];
  reason?: string;
}

export interface CapabilityReview {
  /** Markdown appended to the shared review-checklist section. */
  markdown: string;
  /** Items and problems merged into the existing checklist contract. */
  state: ChecklistState;
  /**
   * Infrastructure failure. The caller retries or records not-checked.
   * Never a clean review, and never a finding charged to the change.
   */
  retry: boolean;
  retryReason?: string;
}

const EMPTY_STATE: ChecklistState = { problem: null, expected: [] };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringList(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be an array of strings`);
  }
  return value.map((entry, i) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new Error(`${where}[${i}] must be a non-empty string`);
    }
    if (entry.startsWith(".")) {
      throw new Error(
        `${where}[${i}] must not be a file extension; selection does not use extensions`,
      );
    }
    return entry;
  });
}

function sinkGroups(value: unknown, where: string): string[][] {
  if (!Array.isArray(value)) {
    throw new Error(`${where} must be an array of fragment groups`);
  }
  return value.map((group, i) => stringList(group, `${where}[${i}]`));
}

/** Parse the bundle. Throws a descriptive error on anything unusable. */
export function parseCapabilityBundle(text: string): CapabilityBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${CAPABILITY_BUNDLE_PATH} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isObject(raw)) {
    throw new Error(`${CAPABILITY_BUNDLE_PATH} must be a JSON object`);
  }
  if (typeof raw.revision !== "string" || raw.revision.trim() === "") {
    throw new Error(
      `${CAPABILITY_BUNDLE_PATH} "revision" must be a non-empty string`,
    );
  }
  if (typeof raw.attribution !== "string" || raw.attribution.trim() === "") {
    throw new Error(
      `${CAPABILITY_BUNDLE_PATH} "attribution" must be a non-empty string`,
    );
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) {
    throw new Error(
      `${CAPABILITY_BUNDLE_PATH} "entries" must be a non-empty array`,
    );
  }
  const seen = new Set<string>();
  const entries = raw.entries.map((entry, i) => {
    const where = `entries[${i}]`;
    if (!isObject(entry)) throw new Error(`${where} must be an object`);
    for (
      const field of ["id", "title", "advice", "validation", "reviewCheck"]
    ) {
      if (typeof entry[field] !== "string" || entry[field].trim() === "") {
        throw new Error(`${where} "${field}" must be a non-empty string`);
      }
    }
    if (seen.has(entry.id as string)) {
      throw new Error(`${where} duplicates id ${entry.id}`);
    }
    seen.add(entry.id as string);
    if (!isObject(entry.signals)) {
      throw new Error(`${where} "signals" must be an object`);
    }
    const signals: CapabilitySignals = {
      task: stringList(entry.signals.task, `${where} signals.task`),
      imports: stringList(entry.signals.imports, `${where} signals.imports`),
      entryPoints: stringList(
        entry.signals.entryPoints,
        `${where} signals.entryPoints`,
      ),
      callers: stringList(entry.signals.callers, `${where} signals.callers`),
      sinks: sinkGroups(entry.signals.sinks, `${where} signals.sinks`),
    };
    const any = signals.task.length + signals.imports.length +
      signals.entryPoints.length + signals.callers.length +
      signals.sinks.length;
    if (any === 0) {
      throw new Error(`${where} needs at least one applicability signal`);
    }
    return {
      id: entry.id as string,
      title: entry.title as string,
      advice: entry.advice as string,
      validation: entry.validation as string,
      reviewCheck: entry.reviewCheck as string,
      signals,
    };
  });
  return {
    revision: raw.revision.trim(),
    attribution: raw.attribution.trim(),
    entries,
  };
}

/** Turn file text or a read error into a load. `null` text means absent. */
export function loadCapabilityBundleFromText(
  text: string | null,
  readError?: string,
): CapabilityLoad {
  if (readError !== undefined) {
    return { kind: "unreadable", reason: readError };
  }
  if (text === null) return { kind: "absent" };
  try {
    return { kind: "loaded", bundle: parseCapabilityBundle(text) };
  } catch (error) {
    return {
      kind: "malformed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Interpret `git show <sha>:<bundle>`. A missing path is absent. A spawn or
 * git failure is `fetch_failed` so the caller retries rather than approving.
 */
export function capabilityLoadFromGitShow(
  result: { code: number; stdout: string; stderr: string } | null,
): CapabilityLoad {
  if (result === null) {
    return { kind: "fetch_failed", reason: "git could not be spawned" };
  }
  if (result.code === 0) return loadCapabilityBundleFromText(result.stdout);
  const stderr = result.stderr;
  if (
    stderr.includes("does not exist") ||
    stderr.includes("exists on disk, but not in") ||
    stderr.includes("Path") && stderr.includes("does not exist")
  ) {
    return loadCapabilityBundleFromText(null);
  }
  const cause = stderr.split("\n").map((l) => l.trim()).find((l) => l) ??
    `git exited ${result.code}`;
  return { kind: "fetch_failed", reason: `git show failed: ${cause}` };
}

/** Read the trusted bundle that ships with this worker. */
export async function loadTrustedCapabilityBundle(): Promise<CapabilityLoad> {
  try {
    const text = await Deno.readTextFile(capabilityBundleUrl());
    return loadCapabilityBundleFromText(text);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        kind: "unreadable",
        reason: `${CAPABILITY_BUNDLE_PATH} is missing`,
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "fetch_failed", reason: message };
  }
}

/**
 * The base copy governs, so a change cannot weaken the bundle. The change's
 * own copy is used only when it is broken (so a broken file cannot merge) or
 * when it repairs a broken base. When the repository has no bundle, the
 * trusted worker copy applies.
 */
export function effectiveCapabilityLoad(
  base: CapabilityLoad,
  head: CapabilityLoad | null,
  trusted: CapabilityLoad,
): CapabilityLoad {
  if (base.kind === "fetch_failed") return base;
  if (head?.kind === "fetch_failed") return head;
  if (head && (head.kind === "malformed" || head.kind === "unreadable")) {
    return { ...head, headCopy: true };
  }
  if (base.kind === "loaded") return base;
  if (
    (base.kind === "malformed" || base.kind === "unreadable") &&
    head?.kind === "loaded"
  ) {
    return { ...head, headCopy: true };
  }
  if (base.kind === "malformed" || base.kind === "unreadable") return base;
  // A repository that does not already carry the bundle cannot supply one
  // in the change and have that copy replace the trusted worker revision.
  return trusted;
}

function includesSignal(haystack: string, signal: string): boolean {
  return haystack.toLowerCase().includes(signal.toLowerCase());
}

/** Path segments, with the final extension removed so `.rs` cannot match. */
export function pathSegments(path: string): string[] {
  const normalised = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const parts = normalised.split("/").filter((part) =>
    part !== "" && part !== "."
  );
  const last = parts[parts.length - 1];
  if (last !== undefined) {
    const dot = last.lastIndexOf(".");
    if (dot > 0) parts[parts.length - 1] = last.slice(0, dot);
  }
  return parts;
}

function segmentHit(
  paths: readonly string[],
  signals: readonly string[],
): string | null {
  for (const path of paths) {
    const segments = pathSegments(path);
    for (const signal of signals) {
      if (
        segments.some((segment) =>
          segment.toLowerCase() === signal.toLowerCase()
        )
      ) {
        return signal;
      }
    }
  }
  return null;
}

function importHit(
  imports: readonly string[],
  signals: readonly string[],
): string | null {
  for (const spec of imports) {
    for (const signal of signals) {
      if (includesSignal(spec, signal)) return signal;
    }
  }
  return null;
}

function sinkHit(
  lines: readonly string[],
  groups: readonly string[][],
): string | null {
  for (const line of lines) {
    const lower = line.toLowerCase();
    for (const group of groups) {
      if (group.every((fragment) => lower.includes(fragment.toLowerCase()))) {
        return group.join("+");
      }
    }
  }
  return null;
}

/**
 * Select the entries whose signals match. Evidence cites the signal, never
 * the task text, so a secret in the issue body is not copied into the record.
 */
export function selectCapabilityGuidance(
  bundle: CapabilityBundle,
  context: CapabilityContext,
): CapabilitySelection {
  const matches: CapabilityMatch[] = [];
  for (const entry of bundle.entries) {
    const because: string[] = [];
    for (const signal of entry.signals.task) {
      if (includesSignal(context.task, signal)) because.push(`task:${signal}`);
    }
    const imported = importHit(context.imports, entry.signals.imports);
    if (imported) because.push(`import:${imported}`);
    const entryHit = segmentHit(context.entryPoints, entry.signals.entryPoints);
    if (entryHit) because.push(`entry:${entryHit}`);
    const callerHit = segmentHit(context.callers, entry.signals.callers);
    if (callerHit) because.push(`caller:${callerHit}`);
    const sink = sinkHit(context.sinks, entry.signals.sinks);
    if (sink) because.push(`sink:${sink}`);
    if (because.length > 0) matches.push({ entry, because });
  }
  return {
    status: matches.length > 0 ? "applied" : "none",
    revision: bundle.revision,
    matches,
  };
}

export function capabilityContextFromChange(input: {
  title?: string;
  body?: string;
  labels?: string;
  paths?: readonly string[];
  imports?: readonly string[];
  callers?: readonly string[];
  sinks?: readonly string[];
  diff?: string;
}): CapabilityContext {
  const fromDiff = signalsFromDiff(input.diff ?? "");
  return {
    task: [input.title ?? "", input.body ?? "", input.labels ?? ""].join("\n"),
    entryPoints: input.paths ?? [],
    imports: [...(input.imports ?? []), ...fromDiff.imports],
    callers: input.callers ?? [],
    sinks: [...(input.sinks ?? []), ...fromDiff.sinks],
  };
}

/** Added diff lines that name an import or a sink. Bounded and line-based. */
export function signalsFromDiff(
  diff: string,
): { imports: string[]; sinks: string[] } {
  const imports: string[] = [];
  const sinks: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const text = line.slice(1);
    const from = text.match(/from\s+["']([^"']+)["']/);
    if (from?.[1]) imports.push(from[1]);
    const use = text.match(/\buse\s+([^;]+);/);
    if (use?.[1]) imports.push(use[1].trim());
    if (
      /fetch\(|Command::new|child_process|readFile|writeFile|File::open|console\.log|logger\.|log::|tracing::/
        .test(
          text,
        )
    ) {
      sinks.push(text);
    }
  }
  return { imports, sinks };
}

export function evidenceFromSelection(
  selection: CapabilitySelection,
): CapabilitySecurityEvidence {
  return {
    status: selection.status,
    revision: selection.revision,
    selected: selection.matches.map((match) => ({
      id: match.entry.id,
      because: match.because,
    })),
  };
}

export function unavailableEvidence(
  reason: string,
): CapabilitySecurityEvidence {
  return {
    status: "unavailable",
    revision: null,
    selected: [],
    reason,
  };
}

/** One log line. Signal ids and the revision only — never the task body. */
export function formatCapabilityEvidence(
  evidence: CapabilitySecurityEvidence,
): string {
  const selected = evidence.selected
    .map((item) => `${item.id}(${item.because.join(",")})`)
    .join(" ");
  const reason = evidence.reason ? ` reason=${evidence.reason}` : "";
  return `Capability security guidance: status=${evidence.status} revision=${
    evidence.revision ?? "none"
  }${selected ? ` selected=${selected}` : ""}${reason}`;
}

/**
 * Render the implementation section. An empty string means no capability
 * applies. Unavailable guidance is named and is never described as applied.
 */
export function renderCapabilityGuidanceForIssue(
  load: CapabilityLoad,
  context: CapabilityContext,
): { section: string; evidence: CapabilitySecurityEvidence } {
  if (load.kind !== "loaded") {
    const reason = load.kind === "absent"
      ? `${CAPABILITY_BUNDLE_PATH} is missing`
      : load.reason;
    return {
      section: [
        "## Capability-scoped security guidance NOT applied",
        "",
        `The guidance bundle could not be read (${reason}). It was NOT applied. Do not record it as applied.`,
      ].join("\n"),
      evidence: unavailableEvidence(reason),
    };
  }
  const selection = selectCapabilityGuidance(load.bundle, context);
  if (selection.status === "none") {
    return { section: "", evidence: evidenceFromSelection(selection) };
  }
  return {
    section: renderAppliedWithIndex(load.bundle, selection),
    evidence: evidenceFromSelection(selection),
  };
}

function renderAppliedWithIndex(
  bundle: CapabilityBundle,
  selection: CapabilitySelection,
): string {
  const lines = [
    "## Capability-scoped security guidance",
    "",
    `Revision ${selection.revision}. Apply every section below. Re-evaluate when the implementation scope changes: a new entry point, import, caller or sink that matches a capability not listed as selected was not applied, and must not be recorded as applied.`,
    "",
    "Selected:",
  ];
  const selectedIds = new Set<string>();
  for (const match of selection.matches) {
    selectedIds.add(match.entry.id);
    lines.push(`- \`${match.entry.id}\` — ${match.because.join(", ")}`);
  }
  lines.push("");
  for (const match of selection.matches) {
    lines.push(
      `### ${match.entry.id} — ${match.entry.title}`,
      "",
      match.entry.advice,
      "",
      `Validation: ${match.entry.validation}`,
      "",
    );
  }
  const others = bundle.entries.filter((entry) => !selectedIds.has(entry.id));
  if (others.length > 0) {
    lines.push(
      "Not selected (no advice is included; do not record these as applied):",
    );
    for (const entry of others) {
      const names = [
        ...entry.signals.task,
        ...entry.signals.imports,
        ...entry.signals.entryPoints,
        ...entry.signals.sinks.map((group) => group.join("+")),
      ];
      lines.push(`- \`${entry.id}\` — signals: ${names.join(", ")}`);
    }
  }
  return lines.join("\n").trimEnd();
}

function disposition(load: CapabilityLoad): "retry" | "problem" | "use" {
  if (load.kind === "fetch_failed") return "retry";
  if (load.kind === "absent") return "retry";
  if (load.kind === "malformed" || load.kind === "unreadable") {
    return load.headCopy ? "problem" : "retry";
  }
  return "use";
}

/**
 * Review section for the shared brief. Applicable checks use the existing
 * checklist verdict contract. A trusted bundle that cannot be read is a
 * retry, not a clean review and not a finding on the change. A change that
 * breaks its own copy is a substantive problem.
 */
export function renderCapabilityReview(
  load: CapabilityLoad,
  context: CapabilityContext,
): CapabilityReview {
  const how = disposition(load);
  if (how === "retry") {
    const reason = load.kind === "absent"
      ? `${CAPABILITY_BUNDLE_PATH} is missing`
      : load.kind === "loaded"
      ? "capability guidance was not loaded"
      : load.reason;
    return {
      markdown: "",
      state: EMPTY_STATE,
      retry: true,
      retryReason:
        `capability security guidance was not checked (${reason}). This is not a clean review and it was not applied.`,
    };
  }
  if (how === "problem" && load.kind !== "loaded" && load.kind !== "absent") {
    const problem =
      `Capability security guidance bundle \`${CAPABILITY_BUNDLE_PATH}\` as changed by this PR could not be applied: ${load.reason}. A missing or unreadable applicable bundle is not a clean review.`;
    return {
      markdown: [
        "### Capability security checks NOT applied",
        "",
        problem,
        "",
        `Report a BLOCKING finding on \`${CAPABILITY_BUNDLE_PATH}\` (line 1). Do not treat this as "no security checks".`,
      ].join("\n"),
      state: {
        problem,
        expected: [],
        problemFile: CAPABILITY_BUNDLE_PATH,
      },
      retry: false,
    };
  }
  if (load.kind !== "loaded") {
    return {
      markdown: "",
      state: EMPTY_STATE,
      retry: true,
      retryReason: "capability security guidance was not checked",
    };
  }
  const selection = selectCapabilityGuidance(load.bundle, context);
  if (selection.matches.length === 0) {
    return { markdown: "", state: EMPTY_STATE, retry: false };
  }
  const source = load.headCopy
    ? "the change's own copy, because the base copy is unusable"
    : "the trusted base revision, so this change cannot weaken it";
  const lines = [
    "### Capability security checks for this change",
    "",
    `These checks are VibeCoder capability guidance revision ${selection.revision} (${source}). Report EVERY item below in the reply \`checklist\` array as \`met\`, \`missing\` or \`not applicable\`, copying the checklist name and the item text exactly. Any \`missing\` item is also a blocking finding. A stub, an unused validator, unconditional rejection, a check only in a UI, or mocked-out authorisation does not pass. A flaw present on the base and not introduced or newly exposed by this change is pre-existing. A flaw this change introduces, widens or newly exposes is a blocking finding. Do not file a finding only because a file named security is absent, and do not require enterprise infrastructure or a negative-test certificate.`,
  ];
  for (const match of selection.matches) {
    lines.push(
      "",
      `Checklist \`${match.entry.id}\` — ${match.because.join(", ")}`,
      `1. ${match.entry.reviewCheck}`,
    );
  }
  return {
    markdown: lines.join("\n"),
    state: {
      problem: null,
      expected: selection.matches.map((match) => ({
        checklist: match.entry.id,
        item: match.entry.reviewCheck,
      })),
    },
    retry: false,
  };
}

/** Merge a capability review into the repo checklist section and state. */
export function mergeCapabilityReview(
  checklistMarkdown: string,
  checklistState: ChecklistState,
  review: CapabilityReview,
): { markdown: string; state: ChecklistState } {
  const markdown = [checklistMarkdown, review.markdown]
    .filter((part) => part.trim() !== "")
    .join("\n\n");
  const problems = [checklistState.problem, review.state.problem].filter((
    problem,
  ): problem is string => problem !== null && problem !== "");
  const problemFile =
    review.state.problemFile && checklistState.problem === null
      ? review.state.problemFile
      : checklistState.problemFile;
  return {
    markdown,
    state: {
      problem: problems.length > 0 ? problems.join(" ") : null,
      expected: [...checklistState.expected, ...review.state.expected],
      ...(problemFile ? { problemFile } : {}),
    },
  };
}
