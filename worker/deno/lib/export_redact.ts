/**
 * Export-time identifier redaction (Issues #4196, #4197).
 *
 * The private tree is full of operator specifics that are correct there and
 * must not cross into the public repository: fleet account names used as
 * test fixtures, internal hostnames, telemetry names, and references to
 * other private `stSoftwareAU/<repo>` repositories. Rewriting the private
 * tree would be churn for no gain (and would break its own tests), so the
 * rename happens on the **staged export tree**, deterministically, before
 * the scrub gate (#4196) runs — the gate then judges only what the mapping
 * could not express.
 *
 * Rules live in `export/scrub-redactions.txt` (private, never exported):
 *
 *   <class>: <literal | /regex/i> -> <replacement>
 *   private-repo: * -> <template containing {n}>
 *   rename: <word> -> <word>
 *
 * A literal matches as a whole word, case-insensitively; a `/regex/` may
 * capture groups and reference them as `$1` in the replacement. Private
 * repository names are mapped to numbered placeholders by a **tree-wide**
 * index (names sorted, first = 1) so the same name gets the same placeholder
 * in every file and the mapping is stable across runs; declared public
 * repositories and documentation placeholders (`foo`, `repo-a`…) are left.
 *
 * A `rename:` rule is a case-preserving **substring** rename of a private
 * name that has been baked into identifiers and file names (`fleet_metrics.ts`,
 * `reportFleetMetricsBeat`, `VIBE_FLEET_METRICS_DIR`): lower-case stays
 * lower, Capitalised stays Capitalised, UPPER stays UPPER, and every file or
 * directory whose path carries the substring is renamed the same way — so
 * imports keep resolving and the published tree still builds. Applied last.
 *
 * The report lists counts per class and per file and — because it is
 * written beside the staging tree, never inside it — the private-repository
 * mapping itself, so an operator can review what was hidden.
 *
 * This source file is itself exported: no operator identifier appears here.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import {
  classifyRepoName,
  compileIdentifier,
  IDENTIFIER_CLASSES,
  PRIVATE_REPO_RE,
  type RepoPolicy,
} from "./export_scrub_gate.ts";
import { decodeTextOrNull, listTreeFiles } from "./export_tree.ts";

/** One redaction rule. */
export interface RedactionRule {
  klass: (typeof IDENTIFIER_CLASSES)[number];
  regex: RegExp;
  replacement: string;
  /** Line as written, for the report and error messages. */
  source: string;
}

/** One case-preserving substring rename (text and paths). */
export interface RenameRule {
  /** Lower-case source word, matched case-insensitively as a substring. */
  from: string;
  /** Lower-case replacement word. */
  to: string;
}

/** Parsed redactions file. */
export interface ParsedRedactions {
  rules: RedactionRule[];
  /** Template for private repositories, e.g. `example-org/private-repo-{n}`. */
  privateRepoTemplate: string | null;
  renames: RenameRule[];
  errors: string[];
}

const RENAME_WORD_RE = /^[a-z][a-z0-9]*$/;

/** Parse `class: pattern -> replacement` lines. */
export function parseRedactions(text: string): ParsedRedactions {
  const rules: RedactionRule[] = [];
  const errors: string[] = [];
  const renames: RenameRule[] = [];
  let privateRepoTemplate: string | null = null;

  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const where = `redactions line ${index + 1}`;
    const arrow = line.indexOf(" -> ");
    if (arrow === -1) {
      errors.push(`${where}: expected "<class>: <pattern> -> <replacement>"`);
      return;
    }
    const left = line.slice(0, arrow).trim();
    const replacement = line.slice(arrow + 4).trim();
    const colon = left.indexOf(":");
    if (colon === -1) {
      errors.push(`${where}: expected "<class>: <pattern>" before "->"`);
      return;
    }
    const klass = left.slice(0, colon).trim();
    const pattern = left.slice(colon + 1).trim();
    if (klass === "rename") {
      if (!RENAME_WORD_RE.test(pattern) || !RENAME_WORD_RE.test(replacement)) {
        errors.push(
          `${where}: rename rule takes two lower-case words (letters/digits): "rename: <word> -> <word>"`,
        );
        return;
      }
      renames.push({ from: pattern, to: replacement });
      return;
    }
    if (klass === "private-repo") {
      if (pattern !== "*" || !replacement.includes("{n}")) {
        errors.push(
          `${where}: private-repo rule must be "private-repo: * -> <template with {n}>"`,
        );
        return;
      }
      privateRepoTemplate = replacement;
      return;
    }
    if (!(IDENTIFIER_CLASSES as readonly string[]).includes(klass)) {
      errors.push(
        `${where}: unknown class "${klass}" (expected one of ${
          IDENTIFIER_CLASSES.join(", ")
        }, private-repo)`,
      );
      return;
    }
    const regex = compileIdentifier(pattern);
    if (regex === null) {
      errors.push(`${where}: invalid regular expression`);
      return;
    }
    if (replacement === "") {
      errors.push(`${where}: empty replacement`);
      return;
    }
    rules.push({
      klass: klass as RedactionRule["klass"],
      regex,
      replacement,
      source: line,
    });
  });
  return { rules, privateRepoTemplate, renames, errors };
}

/**
 * Replace every occurrence of `rule.from` (case-insensitively) with
 * `rule.to`, mirroring the case shape of each match: all-lower → lower,
 * all-upper → UPPER, leading capital → Capitalised.
 */
export function applyRename(
  text: string,
  rule: RenameRule,
): { text: string; count: number } {
  let count = 0;
  const re = new RegExp(escapeRegExp(rule.from), "gi");
  const out = text.replace(re, (match) => {
    count++;
    if (match === match.toUpperCase() && match !== match.toLowerCase()) {
      return rule.to.toUpperCase();
    }
    const first = match.charAt(0);
    if (first === first.toUpperCase() && first !== first.toLowerCase()) {
      return rule.to.charAt(0).toUpperCase() + rule.to.slice(1);
    }
    return rule.to;
  });
  return { text: out, count };
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Options for {@link redactText}. */
export interface RedactTextOptions {
  privateRepoTemplate: string | null;
  /** Lower-cased private repository name → 1-based index. */
  privateRepoIndex: Map<string, number>;
  publicRepos?: readonly string[];
  /** Full repository policy; when given it supersedes `publicRepos`. */
  repoPolicy?: RepoPolicy;
  /** Case-preserving substring renames, applied after every other rule. */
  renames?: readonly RenameRule[];
}

/** Result of {@link redactText}. */
export interface RedactedText {
  text: string;
  /** Replacements per class. */
  counts: Map<string, number>;
}

/** Apply the private-repository mapping, then every rule, to one text. */
export function redactText(
  input: string,
  rules: readonly RedactionRule[],
  options: RedactTextOptions,
): RedactedText {
  const counts = new Map<string, number>();
  const bump = (klass: string, by: number) => {
    if (by > 0) counts.set(klass, (counts.get(klass) ?? 0) + by);
  };
  let text = input;

  if (options.privateRepoTemplate !== null) {
    let n = 0;
    // The organisation is public; the repository NAME is what is private.
    // Every private name found after `stSoftwareAU/` anywhere in the tree
    // (the index) is replaced wherever it appears as a whole word — in the
    // slug, in a Jenkins job path, in a work-dir path, in a fixture — so a
    // test that derives one form from another still agrees with itself.
    // Names shorter than four characters are replaced only in slug form
    // (a bare short word is too likely to be ordinary text).
    // Longest name first, so `private-repo-9` is replaced before `fleet` can
    // match its prefix and leave a half-renamed `private-repo-13-taxation`.
    const byLength = [...options.privateRepoIndex].sort(
      (a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]),
    );
    const policy = options.repoPolicy ??
      {
        publicRepos: options.publicRepos ?? [],
        placeholderRepos: [],
        privatePatterns: [],
      };
    for (const [key, index] of byLength) {
      const placeholder = options.privateRepoTemplate.replace(
        "{n}",
        String(index),
      );
      // A declared private repository is renamed wherever its name appears
      // (≥ 4 characters, so a short word is not chased through prose); an
      // unknown one — which the gate blocks anyway — is hidden in slug form.
      const treeWide = key.length >= 4 &&
        classifyRepoName(key, policy) === "private";
      const re = treeWide
        ? new RegExp(
          `(?<![A-Za-z0-9_])${escapeRegExp(key)}(?![A-Za-z0-9_])`,
          "gi",
        )
        : new RegExp(
          `(stSoftwareAU\\/)${escapeRegExp(key)}(?![A-Za-z0-9_])`,
          "gi",
        );
      text = text.replace(re, (_whole, orgPrefix?: string) => {
        n++;
        return treeWide ? placeholder : `${orgPrefix ?? ""}${placeholder}`;
      });
    }
    bump("private-repo", n);
  }

  for (const rule of rules) {
    let n = 0;
    text = text.replace(rule.regex, (...args) => {
      n++;
      // Expand $1…$9 from the capture groups.
      const groups = args.slice(1, -2) as string[];
      return rule.replacement.replace(
        /\$(\d)/g,
        (_, d: string) => groups[Number(d) - 1] ?? "",
      );
    });
    bump(rule.klass, n);
  }
  for (const rename of options.renames ?? []) {
    const applied = applyRename(text, rename);
    text = applied.text;
    bump("rename", applied.count);
  }
  return { text, counts };
}

function normaliseRepoName(name: string): string {
  return name.replace(/\.git$/i, "").replace(/\.+$/, "").toLowerCase();
}

/** Options for {@link redactTree}. */
export interface RedactTreeOptions {
  rules: readonly RedactionRule[];
  privateRepoTemplate: string | null;
  publicRepos?: readonly string[];
  /** Full repository policy; when given it supersedes `publicRepos`. */
  repoPolicy?: RepoPolicy;
  renames?: readonly RenameRule[];
}

/** Report of a tree redaction. */
export interface RedactionReport {
  root: string;
  filesScanned: number;
  filesRewritten: number;
  filesSkippedBinary: number;
  /** Replacements per class over the whole tree. */
  totals: Map<string, number>;
  /** Per-file replacements per class (files with none are omitted). */
  perFile: Map<string, Map<string, number>>;
  /** Lower-cased private repository name → placeholder. */
  privateRepoMap: Map<string, string>;
  /** Lower-cased name → the name as first seen in the tree (for the report). */
  privateRepoDisplay: Map<string, string>;
  /** Files/directories renamed by `rename:` rules (old → new path). */
  pathsRenamed: Array<{ from: string; to: string }>;
}

/**
 * Two passes: collect every private repository name in the tree (so the
 * numbering is tree-wide and sorted), then rewrite each text file in place.
 */
export async function redactTree(
  root: string,
  options: RedactTreeOptions,
): Promise<RedactionReport> {
  const files = await listTreeFiles(root);
  const texts = new Map<string, string>();
  let filesSkippedBinary = 0;
  const names = new Set<string>();
  const privateRepoDisplay = new Map<string, string>();

  for (const rel of files) {
    const bytes = await Deno.readFile(`${root}/${rel}`);
    const text = decodeTextOrNull(bytes);
    if (text === null) {
      filesSkippedBinary++;
      continue;
    }
    texts.set(rel, text);
    if (options.privateRepoTemplate !== null) {
      for (const m of text.matchAll(PRIVATE_REPO_RE)) {
        const name = m[1] ?? "";
        const kind = classifyRepoName(
          name,
          options.repoPolicy ?? options.publicRepos ?? [],
        );
        if (kind === "private" || kind === "unknown") {
          const key = normaliseRepoName(name);
          names.add(key);
          if (!privateRepoDisplay.has(key)) {
            privateRepoDisplay.set(key, name.replace(/\.git$/i, ""));
          }
        }
      }
    }
  }

  const privateRepoIndex = new Map<string, number>();
  const privateRepoMap = new Map<string, string>();
  [...names].sort().forEach((name, i) => {
    privateRepoIndex.set(name, i + 1);
    if (options.privateRepoTemplate !== null) {
      privateRepoMap.set(
        name,
        options.privateRepoTemplate.replace("{n}", String(i + 1)),
      );
    }
  });

  const totals = new Map<string, number>();
  const perFile = new Map<string, Map<string, number>>();
  let filesRewritten = 0;
  for (const [rel, text] of texts) {
    const out = redactText(text, options.rules, {
      privateRepoTemplate: options.privateRepoTemplate,
      privateRepoIndex,
      publicRepos: options.publicRepos,
      repoPolicy: options.repoPolicy,
      renames: options.renames,
    });
    if (out.text === text) continue;
    await Deno.writeTextFile(`${root}/${rel}`, out.text);
    filesRewritten++;
    perFile.set(rel, out.counts);
    for (const [klass, n] of out.counts) {
      totals.set(klass, (totals.get(klass) ?? 0) + n);
    }
  }

  // Paths last: rename every file whose path carries a rename substring,
  // deepest first so a renamed directory does not invalidate its children.
  const pathsRenamed: Array<{ from: string; to: string }> = [];
  const renames = options.renames ?? [];
  if (renames.length > 0) {
    const all = [...files].sort((a, b) => b.length - a.length);
    for (const rel of all) {
      let target = rel;
      for (const rename of renames) target = applyRename(target, rename).text;
      if (target === rel) continue;
      // The file may live under a directory renamed by an earlier iteration
      // only if that directory was longer — deepest-first ordering means the
      // file is moved before its directory, so the source path is intact.
      const dir = target.includes("/")
        ? target.slice(0, target.lastIndexOf("/"))
        : "";
      if (dir !== "") await Deno.mkdir(`${root}/${dir}`, { recursive: true });
      await Deno.rename(`${root}/${rel}`, `${root}/${target}`);
      pathsRenamed.push({ from: rel, to: target });
    }
    // Remove directories emptied by the moves.
    for (const rel of all) {
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      if (dir === "") continue;
      try {
        const entries = [];
        for await (const e of Deno.readDir(`${root}/${dir}`)) entries.push(e);
        if (entries.length === 0) await Deno.remove(`${root}/${dir}`);
      } catch {
        // Already gone or not a directory — nothing to tidy.
      }
    }
    pathsRenamed.sort((a, b) => a.from.localeCompare(b.from));
  }

  return {
    root,
    filesScanned: texts.size + filesSkippedBinary,
    filesRewritten,
    filesSkippedBinary,
    totals,
    perFile,
    privateRepoMap,
    privateRepoDisplay,
    pathsRenamed,
  };
}

/** Operator-facing report (written beside the staging tree, never inside). */
export function renderRedactionReport(report: RedactionReport): string {
  const lines = [
    "Export redaction report (Issues #4196, #4197)",
    `tree: ${report.root}`,
    `files-scanned: ${report.filesScanned}`,
    `files-rewritten: ${report.filesRewritten}`,
    `files-skipped-binary: ${report.filesSkippedBinary}`,
    "",
    "--- Replacements per class ---",
    ...[...report.totals].sort().map(([klass, n]) => `  ${klass}: ${n}`),
    "",
    "--- Private repositories hidden (name -> placeholder) ---",
    ...[...report.privateRepoMap].sort().map(([name, ph]) =>
      `  ${report.privateRepoDisplay.get(name) ?? name} -> ${ph}`
    ),
    "",
    "--- Paths renamed (rename rules) ---",
    ...report.pathsRenamed.map((r) => `  ${r.from} -> ${r.to}`),
    "",
    "--- Per file ---",
    ...[...report.perFile].sort().map(([rel, counts]) =>
      `  ${rel}: ${[...counts].sort().map(([k, n]) => `${k}=${n}`).join(" ")}`
    ),
    "",
  ];
  return lines.join("\n");
}
