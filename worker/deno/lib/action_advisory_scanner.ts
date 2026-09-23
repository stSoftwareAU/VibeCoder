/**
 * GHSA cross-check of pinned GitHub Actions (Issue #4405, GHA-SUPPLY-018).
 *
 * The weekly `github-actions-audit` verifies pin *shape* (40-char SHA) and
 * staleness, and the dependency audits cover Deno and Ruby — but nothing
 * asked the GitHub Advisory Database whether a pinned *action* has a
 * disclosed, unpatched vulnerability. A tj-actions/changed-files-style
 * compromise would not surface anywhere in CI. This native pre-filer
 * enumerates every third-party `uses:` coordinate across the workflow and
 * composite-action files and queries `gh api /advisories?ecosystem=actions
 * &affects=<owner/name>` once per coordinate; each advisory becomes one
 * consolidated finding filed like the other pre-filers.
 *
 * Failure policy: a lookup that fails or returns something unparsable is
 * reported through `onLookupFailure` and yields no finding — the caller
 * logs it loud; it is never a silent "clean".
 *
 * An advisory whose fix is *already in place* is not filed (Issue #2523): a
 * pin sitting at or after `first_patched_version` at every call site is
 * remediated, and re-filing it every scan buries the real findings. The bar
 * for that suppression is deliberately high — see
 * {@link advisoryIsRemediated} — because suppressing on an unverified
 * comment would turn a live advisory into a silent pass.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { extractUsesValue } from "./action_pin_scanner.ts";
import { scrubUntrustedText } from "./prompt_delimiter.ts";
import { compareSemver, parseSemver } from "./software_updates.ts";
import {
  type ActionPinComment,
  collectActionPins,
} from "./workflow_hygiene_check.ts";
import type {
  GhCommandFn,
  WorkflowFile,
  WorkflowFindingSeverity,
} from "./workflow_scan_common.ts";

/** Owner whose actions are first-party and outside the advisory check. */
const FIRST_PARTY_OWNER = "stsoftwareau";

/** A GHSA advisory record, as the REST API returns it (fields we read). */
export interface ActionAdvisory {
  ghsa_id: string;
  cve_id?: string | null;
  summary?: string;
  severity?: string;
  html_url?: string;
  published_at?: string;
  vulnerabilities?: Array<{
    package?: { ecosystem?: string; name?: string };
    vulnerable_version_range?: string | null;
    first_patched_version?: string | null;
  }>;
}

/** One finding per (coordinate, advisory). */
export interface ActionAdvisoryFinding {
  /** `BP-GHSA-<owner>-<slug>-<GHSA id>`. */
  findingId: string;
  coordinate: string;
  ghsaId: string;
  severity: WorkflowFindingSeverity;
  title: string;
  /** First call site. */
  file: string;
  lines: number;
  whyItMatters: string;
  suggestedFix: string;
  evidence: string;
}

/** Options for {@link scanActionAdvisories}. */
export interface ScanActionAdvisoriesOptions {
  ghCommandFn: GhCommandFn;
  knownOpenFindingIds?: Iterable<string>;
  /** Called once per coordinate whose lookup failed; the scan continues. */
  onLookupFailure?: (coordinate: string, reason: string) => void;
}

/** The `gh api` argv for one coordinate's advisories. */
export function buildAdvisoryArgs(coordinate: string): string[] {
  return [
    "api",
    `/advisories?ecosystem=actions&affects=${
      encodeURIComponent(coordinate)
    }&per_page=100`,
    "--paginate",
  ];
}

/** Third-party `owner/name` from a `uses:` value, or null when exempt. */
export function advisoryCoordinate(usesValue: string): string | null {
  const trimmed = usesValue.trim();
  if (trimmed.startsWith(".") || trimmed.startsWith("docker://")) return null;
  const at = trimmed.indexOf("@");
  const path = at >= 0 ? trimmed.slice(0, at) : trimmed;
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) return null;
  const owner = segments[0] as string;
  if (owner.toLowerCase() === FIRST_PARTY_OWNER) return null;
  // GHSA names actions by repository (`owner/name`); a sub-path action
  // (`owner/name/path`) is advised under its repository.
  return `${owner}/${segments[1]}`;
}

/** GHSA severity bands onto the audit's three. */
export function mapAdvisorySeverity(
  severity: string | undefined,
): WorkflowFindingSeverity {
  switch ((severity ?? "").toLowerCase()) {
    case "critical":
    case "high":
      return "high";
    case "medium":
    case "moderate":
      return "medium";
    default:
      return "low";
  }
}

function slug(coordinate: string): string {
  return coordinate.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Render one advisory-supplied string inert for the filed issue body
 * (Issue #1249, finding 8).
 *
 * Every field read off a GHSA record — the summary above all — is third-party
 * text this scanner interpolates into an issue body the worker files. An
 * unscrubbed summary containing `<!-- finding-id: … -->` lands in that body and
 * is read back as a genuine dedup key on the next scan, silently suppressing a
 * *different* real finding. `scrubUntrustedText` neutralises the HTML-comment
 * and delimiter shapes while leaving the prose readable; the line-break
 * collapse keeps a multi-line summary inside its own bullet.
 */
function advisoryText(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  return scrubUntrustedText(value).replace(/[\r\n]+/g, " ").trim();
}

/**
 * Tag shapes we are willing to interpolate into a `gh api` path. A git tag
 * is one path segment, so anything outside `[A-Za-z0-9._-]` — or a `..`
 * traversal — is refused rather than sent (input validation at the trust
 * boundary: the tag is read off a workflow comment).
 */
const SAFE_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Resolves `owner/name@tag` to its commit SHA, memoised, null when unproven. */
type TagResolver = (coordinate: string, tag: string) => Promise<string | null>;

/**
 * Resolve a tag to the SHA it points at upstream, once per `coordinate@tag`.
 *
 * A refused tag, a failed call, or an unparsable answer returns `null`,
 * which the caller reads as "not proven patched" and therefore *files* the
 * finding — the loud direction. Nothing here can turn a live advisory into a
 * silent pass.
 */
function makeTagResolver(ghCommandFn: GhCommandFn): TagResolver {
  const cache = new Map<string, Promise<string | null>>();
  return (coordinate, tag) => {
    const key = `${coordinate}@${tag}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = (async (): Promise<string | null> => {
      if (!SAFE_TAG_RE.test(tag) || tag.includes("..")) return null;
      try {
        const raw = await ghCommandFn([
          "api",
          `repos/${coordinate}/commits/${tag}`,
          "--jq",
          ".sha",
        ]);
        const sha = raw.trim().replace(/^"|"$/g, "").toLowerCase();
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
      } catch {
        return null;
      }
    })();
    cache.set(key, pending);
    return pending;
  };
}

/** SHA-pinned `uses:` references and their version comments, by `file:line`. */
function pinsByLocation(
  files: readonly WorkflowFile[],
): Map<string, ActionPinComment[]> {
  const byLocation = new Map<string, ActionPinComment[]>();
  for (const file of files) {
    for (const pin of collectActionPins(file.rawText, file.path)) {
      const key = `${pin.file}:${pin.line}`;
      byLocation.set(key, [...(byLocation.get(key) ?? []), pin]);
    }
  }
  return byLocation;
}

/**
 * True only when this advisory is provably fixed at **every** call site.
 *
 * All four conditions must hold, at every site, or the finding is filed:
 *
 * 1. `first_patched_version` parses as a semver.
 * 2. The site is SHA-pinned and carries a version comment that parses.
 * 3. That version is at or after the patched version.
 * 4. The tag the comment claims resolves *upstream* to the SHA actually
 *    pinned — a comment is a human annotation, and trusting one unverified
 *    would suppress a real advisory on the strength of a typo or a lie.
 */
async function advisoryIsRemediated(
  coordinate: string,
  patched: string,
  siteKeys: readonly string[],
  pins: Map<string, ActionPinComment[]>,
  resolveTag: TagResolver,
): Promise<boolean> {
  const target = parseSemver(patched);
  if (target === null || siteKeys.length === 0) return false;

  for (const key of siteKeys) {
    const sitePins = pins.get(key) ?? [];
    if (sitePins.length === 0) return false;
    let verified = false;
    for (const pin of sitePins) {
      const claimed = pin.version === undefined
        ? null
        : parseSemver(pin.version);
      if (claimed === null || compareSemver(claimed, target) < 0) return false;
      if (!verified) {
        const sha = await resolveTag(coordinate, pin.version as string);
        verified = sha !== null && sha === pin.sha.toLowerCase();
      }
    }
    if (!verified) return false;
  }
  return true;
}

/**
 * Enumerate third-party action coordinates with their first call site,
 * query GHSA once per coordinate, and return one finding per advisory.
 */
export async function scanActionAdvisories(
  files: readonly WorkflowFile[],
  options: ScanActionAdvisoriesOptions,
): Promise<ActionAdvisoryFinding[]> {
  const known = new Set(options.knownOpenFindingIds ?? []);
  // coordinate → first call site
  const sites = new Map<string, { file: string; line: number }>();
  const allSites = new Map<string, string[]>();
  for (const file of files) {
    file.rawText.split("\n").forEach((line, index) => {
      const value = extractUsesValue(line);
      if (value === null) return;
      const coordinate = advisoryCoordinate(value);
      if (coordinate === null) return;
      if (!sites.has(coordinate)) {
        sites.set(coordinate, { file: file.path, line: index + 1 });
      }
      const list = allSites.get(coordinate) ?? [];
      list.push(`${file.path}:${index + 1}`);
      allSites.set(coordinate, list);
    });
  }

  const pins = pinsByLocation(files);
  const resolveTag = makeTagResolver(options.ghCommandFn);

  const findings: ActionAdvisoryFinding[] = [];
  for (const [coordinate, site] of sites) {
    let advisories: ActionAdvisory[];
    try {
      const raw = await options.ghCommandFn(buildAdvisoryArgs(coordinate));
      const parsed = JSON.parse(raw);
      // `--paginate` on a JSON-array endpoint concatenates arrays; gh
      // renders them as one array or several back to back — normalise.
      advisories = Array.isArray(parsed) ? parsed : [];
      if (!Array.isArray(parsed)) {
        throw new Error("advisory payload is not an array");
      }
    } catch (err) {
      options.onLookupFailure?.(
        coordinate,
        err instanceof Error ? err.message : String(err),
      );
      continue;
    }
    for (const advisory of advisories) {
      if (!advisory || typeof advisory.ghsa_id !== "string") continue;
      // `slug` leaves a well-formed `GHSA-xxxx-xxxx-xxxx` id byte-identical
      // and strips anything else back to alphanumerics and hyphens, so no
      // advisory can plant marker syntax in the dedup key itself.
      const findingId = `BP-GHSA-${slug(coordinate)}-${slug(advisory.ghsa_id)}`;
      const ghsaId = slug(advisory.ghsa_id);
      if (known.has(findingId)) continue;
      const severity = mapAdvisorySeverity(advisory.severity);
      const vuln = (advisory.vulnerabilities ?? []).find((v) =>
        (v.package?.name ?? "").toLowerCase() === coordinate.toLowerCase()
      ) ?? advisory.vulnerabilities?.[0];
      // Every advisory-sourced string reaches a filed issue body, so each is
      // scrubbed once here and only the scrubbed form is interpolated below.
      const patched = advisoryText(vuln?.first_patched_version);
      // Already fixed everywhere it is used? Then there is nothing to file.
      if (
        patched !== null && await advisoryIsRemediated(
          coordinate,
          patched,
          allSites.get(coordinate) ?? [],
          pins,
          resolveTag,
        )
      ) {
        continue;
      }
      const range = advisoryText(vuln?.vulnerable_version_range) ??
        "unspecified";
      const summary = advisoryText(advisory.summary) ?? "no summary";
      const advisorySeverity = advisoryText(advisory.severity) ?? "unrated";
      const cveId = advisoryText(advisory.cve_id);
      const htmlUrl = advisoryText(advisory.html_url) ?? "no URL";
      const publishedAt = advisoryText(advisory.published_at);
      const emoji = severity === "high"
        ? "🔴"
        : severity === "medium"
        ? "🟠"
        : "🟡";
      findings.push({
        findingId,
        coordinate,
        ghsaId,
        severity,
        title:
          `${emoji} Pinned action \`${coordinate}\` has a disclosed advisory ${ghsaId}` +
          (cveId ? ` (${cveId})` : ""),
        file: site.file,
        lines: site.line,
        whyItMatters: `GHSA lists ${ghsaId}${cveId ? ` / ${cveId}` : ""} ` +
          `against \`${coordinate}\` (${advisorySeverity}): ` +
          `${summary}. Vulnerable range: ${range}; ` +
          (patched
            ? `first patched version: ${patched}. `
            : "no patched version is published — consider removing the action. ") +
          "A SHA pin freezes whatever version was current when it was taken; if that " +
          "version is inside the vulnerable range the pin keeps the vulnerability (Issue #4405).",
        suggestedFix: patched
          ? `Move every call site to a SHA of \`${coordinate}\` at or after ${patched}, ` +
            `keep the trailing version comment accurate, and honour the 24h quarantine.`
          : `Replace \`${coordinate}\` or drop it until GHSA records a patched version.`,
        evidence: [
          `Advisory: ${ghsaId}${cveId ? ` / ${cveId}` : ""} — ${htmlUrl}` +
          (publishedAt ? ` (published ${publishedAt})` : ""),
          `Vulnerable range: ${range}`,
          `First patched: ${patched ?? "none"}`,
          `Call sites: ${(allSites.get(coordinate) ?? []).join(", ")}`,
        ].join("\n"),
      });
    }
  }
  return findings;
}
