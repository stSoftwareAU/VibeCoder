/**
 * Behavioural security-test coverage scan (Issue #4367).
 *
 * A narrow, static check on top of the best-practices scan. It looks for
 * three contracts from the capability guidance: resource or tenant
 * authorisation, sensitive-field updates, and redaction at a log or
 * outbound sink. A missing test of that contract is a best-practices
 * finding. It is not proof of an exploit — the security scan owns those.
 *
 * A file named security is not what the check looks for. A test that was
 * not executed is not a pass. A read failure is unknown, never a clean scan.
 *
 * Australian English throughout (authorise, behaviour).
 *
 * @module
 */

import { cap } from "./best_practices_capper.ts";

/** Findings kept in one best-practices run. Matches the template's cap. */
export const COVERAGE_FILING_CAP = 6;

export interface CoverageFile {
  path: string;
  text: string;
}

export interface CoverageFinding {
  id: string;
  path: string;
  capability:
    | "capsec-resource-auth"
    | "capsec-sensitive-field"
    | "capsec-secret-logging";
  testsInspected: string[];
  contract: string;
  title: string;
  body: string;
}

export interface SecurityScanIssue {
  number: number;
  title: string;
  body?: string;
  labels?: readonly string[];
}

export type CoverageScan =
  | {
    status: "none" | "findings" | "not_checked";
    findings: CoverageFinding[];
    /** True only when the tests were executed and every contract was present. */
    pass: boolean;
  }
  | {
    status: "unknown";
    findings: CoverageFinding[];
    pass: false;
    reason: string;
  };

export type CoverageFiling =
  | { outcome: "zero"; pass: false }
  | { outcome: "one"; pass: false; findings: CoverageFinding[] }
  | { outcome: "dedup"; pass: false; existingIssue: number; path: string }
  | { outcome: "error"; pass: false; reason: string };

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  ".cache",
  "vendor",
]);

const MAX_FILES = 400;
const MAX_BYTES = 200_000;

function isTestPath(path: string): boolean {
  const normalised = path.replaceAll("\\", "/");
  return normalised.startsWith("tests/") ||
    normalised.includes("/tests/") ||
    normalised.startsWith("test/") ||
    normalised.includes("/test/") ||
    /_test\.(ts|js|rs)$/.test(normalised) ||
    /\.test\.(ts|js)$/.test(normalised);
}

async function digest12(text: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

function publicByDesign(text: string): boolean {
  return /public by design|unauthenticated by design/i.test(text);
}

function usesResourceAuth(text: string): boolean {
  if (publicByDesign(text)) return false;
  return /authoris|authoriz|tenant|ownership/i.test(text) &&
    /\b(update|patch|save)\b/i.test(text);
}

function updatesSensitiveField(text: string): boolean {
  return /(?:password|role|isAdmin|is_admin|tenantId|tenant_id)\s*[:=]/.test(
    text,
  ) && /(?:body|request|patch|input)/i.test(text);
}

function leaksToSink(text: string): boolean {
  return /(?:console\.log|logger\.|log::|tracing::|fetch\(|reqwest::)/.test(
    text,
  ) && /(?:secret|password|apiKey|api_key|token)/.test(text);
}

function contractCovered(
  tests: string,
  kind: CoverageFinding["capability"],
): boolean {
  if (kind === "capsec-resource-auth") {
    return /authoris|succeed|ok:\s*true/i.test(tests) &&
      /unauthoris|unauthoriz|cross-tenant|forbidden/i.test(tests);
  }
  if (kind === "capsec-sensitive-field") {
    return /forbidden-field|privileged|allowlist|role/i.test(tests) &&
      /reject|unauthoris|forbidden|not allowed/i.test(tests);
  }
  return /redact|REDACTED|does not contain|not\.toContain/i.test(tests);
}

function relatedTests(path: string, tests: CoverageFile[]): CoverageFile[] {
  const base = path.split("/").pop()?.replace(/\.[^.]+$/, "") ?? path;
  return tests.filter((test) =>
    test.text.includes(base) || test.text.includes(path)
  );
}

async function findingFor(
  file: CoverageFile,
  capability: CoverageFinding["capability"],
  contract: string,
  tests: CoverageFile[],
): Promise<CoverageFinding | null> {
  const inspected = relatedTests(file.path, tests);
  const blob = inspected.map((test) => test.text).join("\n");
  if (contractCovered(blob, capability)) return null;
  const id = await coverageFindingId(capability, file.path);
  if (file.text.includes(`best-practice-ignore: ${id}`)) return null;
  const names = inspected.map((test) => test.path);
  const title = `Missing behavioural test for ${capability} in ${file.path}`;
  const body = [
    "This is a best-practices coverage gap, not proof of an exploit. The security scan owns exploit findings.",
    "",
    `**Production path:** \`${file.path}\``,
    `**Tests inspected:** ${
      names.length > 0 ? names.map((name) => `\`${name}\``).join(", ") : "none"
    } (not executed)`,
    `**Uncovered contract:** ${contract}`,
    "",
    "A file named security is not what this check looks for. A test that was not run is not a pass.",
  ].join("\n");
  return {
    id,
    path: file.path,
    capability,
    testsInspected: names,
    contract,
    title,
    body,
  };
}

export async function coverageFindingId(
  capability: string,
  path: string,
): Promise<string> {
  return `BP-${await digest12(`${capability}\0${path}`)}`;
}

/**
 * Scan an in-memory tree. `testsExecuted` is never assumed: the best-practices
 * scan is static, so a contract that appears in a test is still not a pass.
 */
export async function scanCapabilityCoverageFiles(
  files: readonly CoverageFile[],
  options: { testsExecuted?: boolean } = {},
): Promise<CoverageScan> {
  const production = files.filter((file) => !isTestPath(file.path));
  const tests = files.filter((file) => isTestPath(file.path));
  const findings: CoverageFinding[] = [];
  let applicable = 0;
  let covered = 0;
  for (const file of production) {
    if (
      file.path.split("/").pop() === "security.ts" &&
      !usesResourceAuth(file.text) &&
      !updatesSensitiveField(file.text) && !leaksToSink(file.text)
    ) {
      continue;
    }
    const checks: Array<[CoverageFinding["capability"], boolean, string]> = [
      [
        "capsec-resource-auth",
        usesResourceAuth(file.text),
        "an authorised update succeeds and a cross-tenant update fails at the authorisation control",
      ],
      [
        "capsec-sensitive-field",
        updatesSensitiveField(file.text),
        "a privileged field is rejected by the writable-field allowlist",
      ],
      [
        "capsec-secret-logging",
        leaksToSink(file.text),
        "a secret is redacted before it reaches a log or an outbound body",
      ],
    ];
    for (const [capability, applies, contract] of checks) {
      if (!applies) continue;
      applicable++;
      const gap = await findingFor(file, capability, contract, tests);
      if (gap === null) covered++;
      else findings.push(gap);
    }
  }
  if (applicable === 0) {
    return { status: "none", findings: [], pass: false };
  }
  if (findings.length > 0) {
    return { status: "findings", findings, pass: false };
  }
  if (options.testsExecuted === true && covered === applicable) {
    return { status: "findings", findings: [], pass: true };
  }
  return { status: "not_checked", findings: [], pass: false };
}

export function planCapabilityCoverageFiling(
  scan: CoverageScan,
  openIssues: readonly SecurityScanIssue[],
  suppressedIds: readonly string[] = [],
): CoverageFiling {
  if (scan.status === "unknown" && scan.findings.length === 0) {
    return { outcome: "error", pass: false, reason: scan.reason };
  }
  const suppressed = new Set(suppressedIds);
  const fresh = scan.findings.filter((finding) => !suppressed.has(finding.id));
  for (const finding of fresh) {
    const existing = openIssues.find((issue) =>
      coversPath(issue, finding.path)
    );
    if (existing) {
      return {
        outcome: "dedup",
        pass: false,
        existingIssue: existing.number,
        path: finding.path,
      };
    }
  }
  const capped = cap(
    fresh.map((finding) => ({
      id: finding.id,
      severity: "low" as const,
      title: finding.title,
      body: finding.body,
    })),
    COVERAGE_FILING_CAP,
  );
  const kept = new Set(capped.map((finding) => finding.id));
  const findings = fresh.filter((finding) => kept.has(finding.id));
  if (findings.length === 0) return { outcome: "zero", pass: false };
  return { outcome: "one", pass: false, findings };
}

/**
 * Parse `gh issue list --json number,title,labels`. `null` means the payload
 * was unusable; the caller keeps the title-only list and files rather than
 * treating a bad lookup as "nothing to deduplicate against".
 */
export function coverageIssuesFromGhJson(
  raw: string,
): SecurityScanIssue[] | null {
  let rows: unknown;
  try {
    rows = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  const issues: SecurityScanIssue[] = [];
  for (const row of rows) {
    if (row === null || typeof row !== "object") continue;
    const number = (row as { number?: unknown }).number;
    const title = (row as { title?: unknown }).title;
    if (typeof number !== "number" || typeof title !== "string") continue;
    const labelsRaw = (row as { labels?: unknown }).labels;
    const labels = Array.isArray(labelsRaw)
      ? labelsRaw.flatMap((label) => {
        if (typeof label === "string") return [label];
        if (
          label !== null && typeof label === "object" &&
          typeof (label as { name?: unknown }).name === "string"
        ) {
          return [(label as { name: string }).name];
        }
        return [];
      })
      : [];
    issues.push({ number, title, labels });
  }
  return issues;
}

function coversPath(issue: SecurityScanIssue, path: string): boolean {
  const hay = `${issue.title}\n${issue.body ?? ""}`;
  if (!hay.includes(path)) return false;
  if (issue.labels?.includes("security")) return true;
  return /security-scan|\bsecurity\b/i.test(hay);
}

/** Read a checkout. A missing tree or a read error is unknown, never none. */
export async function scanCapabilityCoverageDir(
  root: string,
  options: { testsExecuted?: boolean } = {},
): Promise<CoverageScan> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(root);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return {
        status: "unknown",
        findings: [],
        pass: false,
        reason: `checkout does not exist: ${root}`,
      };
    }
    return {
      status: "unknown",
      findings: [],
      pass: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!info.isDirectory) {
    return {
      status: "unknown",
      findings: [],
      pass: false,
      reason: `checkout is not a directory: ${root}`,
    };
  }
  const files: CoverageFile[] = [];
  let truncated = false;
  const walk = async (dir: string, prefix: string) => {
    if (files.length >= MAX_FILES) {
      truncated = true;
      return;
    }
    let entries: Deno.DirEntry[];
    try {
      entries = [];
      for await (const entry of Deno.readDir(dir)) entries.push(entry);
    } catch (error) {
      throw new Error(
        error instanceof Error ? error.message : String(error),
      );
    }
    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      if (entry.name.startsWith(".")) continue;
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const abs = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(abs, rel);
        continue;
      }
      if (!entry.isFile) continue;
      if (!/\.(ts|js|rs)$/.test(entry.name)) continue;
      let text: string;
      try {
        const stat = await Deno.stat(abs);
        if (stat.size > MAX_BYTES) {
          truncated = true;
          continue;
        }
        text = await Deno.readTextFile(abs);
      } catch (error) {
        throw new Error(
          `${rel}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      files.push({ path: rel, text });
    }
  };
  try {
    await walk(root, "");
  } catch (error) {
    return {
      status: "unknown",
      findings: [],
      pass: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const scan = await scanCapabilityCoverageFiles(files, options);
  if (truncated) {
    return {
      status: "unknown",
      findings: scan.status === "unknown" ? [] : scan.findings,
      pass: false,
      reason: "inspection stopped before the whole tree was read",
    };
  }
  return scan;
}
