/**
 * Deterministic CloudFormation cost / reliability pre-scan for the
 * best-practices `aws-cloudformation` bucket (Issue #2579).
 *
 * Two of the bucket's "Cost, speed and reliability" checks are mechanical
 * enough to detect without judgement, so they are found here and handed to
 * the scan as evidence rather than left to a reviewer noticing them:
 *
 *   - `lambda-not-arm64` — an `AWS::Lambda::Function` without
 *     `Architectures: [arm64]` (x86_64 is the default, and Graviton is about
 *     20% cheaper per GB-second);
 *   - `lambda-log-retention` — a function with no `AWS::Logs::LogGroup`
 *     carrying `RetentionInDays` for it, so CloudWatch keeps its logs for
 *     ever.
 *
 * The output is candidates, not findings: the scan still triages each one
 * (Phase 3), states its estimated effect and risk, and may drop it. Nothing
 * here files an issue.
 *
 * Template text is read-only data from the scanned checkout. It is parsed as
 * JSON or YAML (short-form intrinsic tags such as `!Ref` stripped first, since
 * only textual references matter here) and never executed or interpolated.
 *
 * Australian English spelling used throughout.
 */

import { parse as parseYaml } from "@std/yaml/parse";

/** Which mechanical check a candidate came from. */
export type CfnCostCheck = "lambda-not-arm64" | "lambda-log-retention";

/** One candidate the scan should triage. */
export interface CfnCostCandidate {
  check: CfnCostCheck;
  /** Logical id of the Lambda function. */
  logicalId: string;
  /** 1-based line of the logical id's declaration in the template. */
  line: number;
  /** One-sentence evidence for the reviewer. */
  detail: string;
}

type Resource = { Type?: unknown; Properties?: Record<string, unknown> };

/** Short-form intrinsic tag (`!Ref`, `!Sub`, `!GetAtt` …) before a value. */
const SHORT_FORM_TAG = /(^|[\s[{,])![A-Z][A-Za-z]*(?=[\s[{]|$)/gm;

function parseTemplate(text: string): Record<string, Resource> | null {
  let doc: unknown;
  try {
    doc = text.trimStart().startsWith("{")
      ? JSON.parse(text)
      : parseYaml(text.replace(SHORT_FORM_TAG, "$1"));
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object") return null;
  const resources = (doc as { Resources?: unknown }).Resources;
  if (resources === null || typeof resources !== "object") return null;
  return resources as Record<string, Resource>;
}

/** A character that continues a reference token (so is not a boundary). */
const TOKEN_CHAR = /[\w:]/;

/**
 * True when `value` mentions `logicalId` as a whole reference token. Plain
 * string search, not a regex built from the id, so a crafted logical id
 * cannot shape a pattern.
 */
function mentions(value: unknown, logicalId: string): boolean {
  const text = JSON.stringify(value ?? null);
  for (
    let at = text.indexOf(logicalId);
    at >= 0;
    at = text.indexOf(logicalId, at + 1)
  ) {
    const before = text[at - 1] ?? "";
    const after = text[at + logicalId.length] ?? "";
    if (!TOKEN_CHAR.test(before) && !TOKEN_CHAR.test(after)) return true;
  }
  return false;
}

/** 1-based line declaring `logicalId:` (optionally quoted), or 0. */
function declarationLine(text: string, logicalId: string): number {
  const index = text.split("\n").findIndex((line) => {
    let rest = line.trimStart();
    if (rest.startsWith('"')) rest = rest.slice(1);
    if (!rest.startsWith(logicalId)) return false;
    rest = rest.slice(logicalId.length);
    if (rest.startsWith('"')) rest = rest.slice(1);
    return rest.trimStart().startsWith(":");
  });
  return index + 1;
}

/**
 * Candidates in one template's text. Anything that is not a parseable
 * template with a `Resources` map yields none.
 */
export function findCfnCostCandidates(text: string): CfnCostCandidate[] {
  const resources = parseTemplate(text);
  if (resources === null) return [];
  const entries = Object.entries(resources).filter(([, r]) =>
    r !== null && typeof r === "object"
  );
  const retained = entries.filter(([, r]) =>
    r.Type === "AWS::Logs::LogGroup" &&
    r.Properties?.RetentionInDays !== undefined
  );
  const candidates: CfnCostCandidate[] = [];
  for (const [id, r] of entries) {
    if (r.Type !== "AWS::Lambda::Function") continue;
    const props = r.Properties ?? {};
    const line = declarationLine(text, id);
    const archs = props.Architectures;
    if (!Array.isArray(archs) || !archs.includes("arm64")) {
      const memory = props.MemorySize === undefined
        ? ""
        : ` (MemorySize ${String(props.MemorySize)})`;
      candidates.push({
        check: "lambda-not-arm64",
        logicalId: id,
        line,
        detail: `Lambda \`${id}\` runs on x86_64${memory}; ` +
          "no `Architectures: [arm64]`",
      });
    }
    const logging = props.LoggingConfig;
    const covered = retained.some(([groupId, group]) =>
      mentions(group.Properties, id) || mentions(logging, groupId)
    );
    if (!covered) {
      candidates.push({
        check: "lambda-log-retention",
        logicalId: id,
        line,
        detail: `Lambda \`${id}\` has no \`AWS::Logs::LogGroup\` with ` +
          "`RetentionInDays`, so its logs are kept for ever",
      });
    }
  }
  return candidates;
}

/** Evidence lines for the scan prompt, cited as `` `file:line` detail``. */
export function renderCfnCostCandidates(
  file: string,
  candidates: readonly CfnCostCandidate[],
): string[] {
  return candidates.map((c) => `\`${file}:${c.line}\` ${c.detail}`);
}

/** Directories never scanned: dependencies, VCS and generated output. */
const SKIP_DIRS = new Set(["node_modules", "cdk.out", "target", "vendor"]);
const TEMPLATE_FILE = /\.(ya?ml|json|template)$/;
/** Bounds so a huge checkout cannot stall the run. */
const MAX_FILES = 500;
const MAX_BYTES = 1_000_000;

/**
 * Walk a checkout and return the rendered candidates of every template that
 * declares a Lambda function. A missing or unreadable path yields none.
 */
export async function scanCfnCostCandidates(root: string): Promise<string[]> {
  const lines: string[] = [];
  let visited = 0;
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (visited >= MAX_FILES) return;
      const path = `${dir}/${entry.name}`;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          await walk(path, relPath);
        }
        continue;
      }
      if (!entry.isFile || !TEMPLATE_FILE.test(entry.name)) continue;
      visited++;
      try {
        if ((await Deno.stat(path)).size > MAX_BYTES) continue;
        const text = await Deno.readTextFile(path);
        if (!text.includes("AWS::Lambda::Function")) continue;
        lines.push(
          ...renderCfnCostCandidates(relPath, findCfnCostCandidates(text)),
        );
      } catch {
        // An unreadable file is not evidence of anything; skip it.
      }
    }
  }
  await walk(root, "");
  return lines;
}
