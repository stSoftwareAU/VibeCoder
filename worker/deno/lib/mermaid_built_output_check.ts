/**
 * Assert Mermaid hardening in the **built** Pages output (Issue #272).
 *
 * `mermaid_security_level.ts` and `mermaid_cdn_integrity.ts` both parse the
 * source include, `_includes/head-custom.html`. That is one step removed from
 * what a visitor executes. Between the include and the served page sit Jekyll,
 * a layout that may or may not pull the include in, `strip_unpublished_links`
 * and `normalise_heading_ids`. `pages.yml` checks the artifact for structural
 * files — `index.html`, `README.html`, `docs/OVERVIEW.html` — and never looks
 * at `securityLevel` or the SRI hash. So a regression that loosened `strict`
 * or dropped `integrity` during a Mermaid bump would pass every existing test
 * and every Pages step: the source include was the only thing anyone asserted,
 * and the value that matters is the one in the HTML that ships.
 *
 * This scans the built site instead. Every page that initialises Mermaid must
 * carry a safe `securityLevel`, and every page that loads Mermaid from the CDN
 * must pin an exact version and carry a valid SRI hash with `crossorigin`.
 *
 * Absent build output is SKIPPED, not PASSED: the local quality gate does not
 * run Jekyll, and a check that silently passes when it inspected nothing is
 * how #272 happened in the first place. `pages.yml` runs it against a real
 * `_site` and strict mode promotes a SKIP to a failure.
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import {
  isHardenedMermaidCdnScript,
  parseMermaidCdnScript,
} from "./mermaid_cdn_integrity.ts";
import {
  extractMermaidSecurityLevel,
  isSafeSecurityLevel,
} from "./mermaid_security_level.ts";

/** Outcome of one built page. */
export interface MermaidBuiltPageFinding {
  /** Path of the page, relative to the site root. */
  page: string;
  /** What is wrong with it. */
  problem: string;
}

/** Result of scanning a built site. */
export interface MermaidBuiltOutputResult {
  status: "PASSED" | "FAILED" | "SKIPPED";
  output: string;
  /** Pages that load or initialise Mermaid unsafely. */
  findings: MermaidBuiltPageFinding[];
  /** Pages that reference Mermaid at all. */
  pagesWithMermaid: number;
  /** HTML pages inspected. */
  pagesScanned: number;
}

/**
 * True when the page references Mermaid in a way this check governs — either
 * it loads the CDN bundle or it calls `mermaid.initialize`.
 *
 * A page with neither is not a Mermaid page and is simply not this check's
 * business; most of the site is exactly that.
 */
export function pageUsesMermaid(html: string): boolean {
  return parseMermaidCdnScript(html) !== null ||
    /\bmermaid\s*\.\s*initialize\s*\(/.test(html);
}

/**
 * Inspect one built page.
 *
 * @param html - The page's HTML.
 * @param page - Site-relative path, used in the finding text.
 * @returns Findings for this page; empty when it is safe or not a Mermaid page.
 */
export function checkBuiltPage(
  html: string,
  page: string,
): MermaidBuiltPageFinding[] {
  if (!pageUsesMermaid(html)) return [];
  const findings: MermaidBuiltPageFinding[] = [];

  const level = extractMermaidSecurityLevel(html);
  if (!isSafeSecurityLevel(level)) {
    findings.push({
      page,
      problem:
        `Mermaid securityLevel is ${
          JSON.stringify(level)
        } in the built page; ` +
        `must be "strict" or "antiscript"`,
    });
  }

  const script = parseMermaidCdnScript(html);
  if (script === null) {
    // Initialises Mermaid but loads it from somewhere this check cannot see.
    // Not necessarily wrong — a self-hosted bundle is fine — but it is not
    // the hardened CDN tag the SRI assertion is about, so say so rather than
    // pass silently.
    findings.push({
      page,
      problem:
        "the page initialises Mermaid but carries no CDN script tag to verify " +
        "(a self-hosted bundle needs its own integrity story)",
    });
  } else if (!isHardenedMermaidCdnScript(script)) {
    findings.push({
      page,
      problem: `Mermaid CDN script is not pinned + SRI-hardened: ` +
        `${JSON.stringify(script)}`,
    });
  }

  return findings;
}

/** Recursively yield `.html` files under `dir`. */
async function* walkHtml(dir: string): AsyncGenerator<string> {
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(dir));
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      yield* walkHtml(full);
    } else if (entry.name.endsWith(".html")) {
      yield full;
    }
  }
}

/**
 * Scan a built Jekyll site for unsafe Mermaid usage.
 *
 * @param siteDir - The build output directory, normally `_site`.
 * @returns PASSED when every Mermaid page is hardened, FAILED with the
 *   offending pages listed, or SKIPPED when `siteDir` does not exist or holds
 *   no HTML.
 */
export async function checkBuiltMermaidOutput(
  siteDir: string,
): Promise<MermaidBuiltOutputResult> {
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(siteDir);
  } catch {
    return {
      status: "SKIPPED",
      output: `mermaid built output: SKIPPED (no build at ${siteDir} — ` +
        `run the Pages build first; strict mode fails on this)`,
      findings: [],
      pagesWithMermaid: 0,
      pagesScanned: 0,
    };
  }
  if (!stat.isDirectory) {
    return {
      status: "SKIPPED",
      output: `mermaid built output: SKIPPED (${siteDir} is not a directory)`,
      findings: [],
      pagesWithMermaid: 0,
      pagesScanned: 0,
    };
  }

  const findings: MermaidBuiltPageFinding[] = [];
  let pagesScanned = 0;
  let pagesWithMermaid = 0;

  for await (const absPath of walkHtml(siteDir)) {
    pagesScanned++;
    const html = await Deno.readTextFile(absPath);
    if (!pageUsesMermaid(html)) continue;
    pagesWithMermaid++;
    findings.push(
      ...checkBuiltPage(html, absPath.slice(siteDir.length + 1)),
    );
  }

  if (pagesScanned === 0) {
    return {
      status: "SKIPPED",
      output: `mermaid built output: SKIPPED (no HTML under ${siteDir})`,
      findings: [],
      pagesWithMermaid: 0,
      pagesScanned: 0,
    };
  }

  if (findings.length > 0) {
    const detail = findings
      .map((f) => `  ${f.page}: ${f.problem}`)
      .join("\n");
    return {
      status: "FAILED",
      output: `mermaid built output: FAILED (${findings.length} problem(s) ` +
        `across ${pagesWithMermaid} Mermaid page(s) of ${pagesScanned} ` +
        `scanned)\n${detail}`,
      findings,
      pagesWithMermaid,
      pagesScanned,
    };
  }

  return {
    status: "PASSED",
    output: `mermaid built output: PASSED (${pagesWithMermaid} Mermaid ` +
      `page(s) hardened, of ${pagesScanned} scanned)`,
    findings: [],
    pagesWithMermaid,
    pagesScanned,
  };
}
