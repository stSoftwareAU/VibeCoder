/**
 * Cargo (crates.io) scanning for the release-age bump audit (stSoftwareAU/NEAT-AI-scorer#627).
 *
 * `Cargo.toml` and `Cargo.lock` were classified as a foreign manifest, so
 * every versioned added line in a Rust repository's bump was refused as
 * unverifiable and the whole bump was rejected. The refusal was correct in
 * shape — the embargo must never pass what it cannot see — but wrong in
 * outcome: a managed Rust repo could never take a dependency update at all
 * and sat on stale crates indefinitely, which is the worse supply-chain
 * position. This module gives the embargo eyes for crates.io instead, so a
 * Cargo bump is **verified** rather than refused.
 *
 * Both Cargo files need more than the added line to be understood, so this
 * scanner is stateful over the whole diff of one file:
 *
 *  - **`Cargo.lock`** spreads a package over a `[[package]]` block whose
 *    `name`, `version` and `source` are separate lines. A version bump adds
 *    only the `version` (and `checksum`) line, so the crate's name and its
 *    registry come from the surrounding *context* lines. State is dropped at
 *    every `@@` hunk boundary — what lies between hunks is unseen, and an
 *    unseen block must never lend its name to the next one.
 *  - **`Cargo.toml`** puts the crate name in the key but the meaning of that
 *    key in the enclosing `[dependencies]`-style table header.
 *
 * The fail-closed boundary from Issue #3951 is kept throughout: a git or
 * alternate-registry source, an open-ended requirement, or a version whose
 * package cannot be named is **refused**, never guessed at. A block that is
 * definitively source-less is a workspace or path member — the repo's own
 * code, not a published release — and is skipped rather than refused.
 *
 * Pure — no I/O, no clock — so it unit-tests exhaustively.
 *
 * Australian English used throughout (behaviour, organisation, etc.).
 */

import {
  pinnedVersion,
  quoteLine,
  RANGE_LOOKING_RE,
} from "./bump_version_pin.ts";

/** Which Cargo file is being scanned. */
export type CargoManifest = "lock" | "toml";

/** Where a scanner reports what it found. */
export interface CargoCollector {
  /** A crates.io release whose publish time can be resolved. */
  addCrate: (name: string, version: string) => void;
  /** A dependency-shaped line whose release age cannot be resolved. */
  flag: (line: string, reason: string) => void;
}

/** Stateful scanner over the diff lines of one Cargo file. */
export interface CargoScanner {
  /** Feed one file line; `added` is true for a `+` diff line. */
  feed: (line: string, added: boolean) => void;
  /** A `@@` hunk boundary — everything before it is out of context. */
  breakContext: () => void;
  /** End of this file's diff. */
  finish: () => void;
}

/**
 * `source` values that name the real crates.io index, in both the git and
 * sparse forms Cargo writes. Matched exactly: a look-alike index URL is an
 * alternate registry whose publish times this worker cannot resolve.
 */
const CRATES_IO_SOURCES: ReadonlySet<string> = new Set([
  "registry+https://github.com/rust-lang/crates.io-index",
  "sparse+https://index.crates.io/",
]);

/** A `key = "quoted value"` line, the only shape `Cargo.lock` uses. */
const LOCK_STRING_KEY_RE = /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"\s*$/;

/** A TOML table header, e.g. `[dependencies]` or `[[package]]`. */
const TABLE_HEADER_RE = /^\[+([^\]]*)\]+\s*$/;

/** A `key = value` line in a `Cargo.toml`, with an optionally quoted key. */
const TOML_ENTRY_RE = /^"?([A-Za-z0-9_.-]+)"?\s*=\s*(.+?)\s*$/;

/**
 * A table header that carries dependencies: `[dependencies]`,
 * `[dev-dependencies]`, `[build-dependencies]`, `[workspace.dependencies]`,
 * `[target.'cfg(unix)'.dependencies]` and the `[dependencies.<crate>]`
 * single-crate form, whose crate name is captured.
 */
const DEPENDENCY_HEADER_RE =
  /(?:^|\.)(?:dev-|build-)?dependencies(?:\.([A-Za-z0-9_-]+))?$/;

/** `[patch.crates-io]` / `[replace]` also redirect real dependencies. */
const OVERRIDE_HEADER_RE = /^(?:patch(?:\..+)?|replace)$/;

/**
 * `Cargo.toml` keys that carry a version-shaped value but are not a
 * dependency on a published crate. Only consulted when the enclosing table
 * header was not visible in the diff, so a `-U3` hunk in the middle of a
 * long `[package]` or `[profile.*]` table cannot be misread as a crate.
 */
const TOML_NON_DEPENDENCY_KEYS: ReadonlySet<string> = new Set([
  "version",
  "name",
  "edition",
  "rust-version",
  "license",
  "license-file",
  "description",
  "documentation",
  "homepage",
  "repository",
  "readme",
  "authors",
  "keywords",
  "categories",
  "publish",
  "resolver",
  "members",
  "exclude",
  "include",
  "default-run",
  "build",
  "links",
  "opt-level",
  "lto",
  "codegen-units",
  "panic",
  "strip",
  "debug",
  "incremental",
  "overflow-checks",
  "rpath",
  "debug-assertions",
]);

/** True when a `Cargo.lock` `source` value is the real crates.io index. */
export function isCratesIoSource(source: string): boolean {
  return CRATES_IO_SOURCES.has(source.trim());
}

/**
 * Turn a raw requirement into a crates.io specifier, refusing anything
 * open-ended and ignoring values that were never a version at all.
 */
function resolveRequirement(
  name: string,
  raw: string,
  path: string,
  line: string,
  out: CargoCollector,
): void {
  const version = pinnedVersion(raw);
  if (version) {
    out.addCrate(name, version);
    return;
  }
  if (!RANGE_LOOKING_RE.test(raw.trim())) return;
  out.flag(
    line,
    `\`${name} = "${raw}"\` in \`${path}\` does not pin a single release, ` +
      `so its publish time cannot be checked against the quarantine.`,
  );
}

// =============================================================================
// Cargo.lock
// =============================================================================

/** The `[[package]]` block currently in view. */
interface LockBlock {
  name: string | null;
  version: string | null;
  rawVersion: string | null;
  source: string | null;
  /** True once an added line changed this block's identity or origin. */
  changed: boolean;
  /** True once the block's `version` key has been seen. */
  sawVersion: boolean;
  /**
   * True once a line after `version` proved the block carries no `source`
   * key — i.e. it is a workspace or path member, not a published release.
   */
  sourceSettled: boolean;
  /** The added line quoted back in a refusal. */
  line: string;
}

function emptyLockBlock(): LockBlock {
  return {
    name: null,
    version: null,
    rawVersion: null,
    source: null,
    changed: false,
    sawVersion: false,
    sourceSettled: false,
    line: "",
  };
}

function createLockScanner(path: string, out: CargoCollector): CargoScanner {
  let block = emptyLockBlock();

  const flush = (): void => {
    const b = block;
    block = emptyLockBlock();
    if (!b.changed) return;

    if (b.version === null) {
      if (b.rawVersion === null) return;
      out.flag(
        b.line,
        `\`${b.name ?? "?"} ${b.rawVersion}\` in \`${path}\` does not pin a ` +
          `single release, so its publish time cannot be checked against ` +
          `the quarantine.`,
      );
      return;
    }
    if (b.name === null) {
      out.flag(
        b.line,
        `A \`${path}\` entry moved to version \`${b.version}\` with no ` +
          `package name in view, so the crate whose publish time to check ` +
          `cannot be identified.`,
      );
      return;
    }
    if (b.source === null) {
      // Settled means the block genuinely has no `source` key: a workspace
      // member or a path dependency — this repo's own code, not a release.
      // Unsettled means the hunk ended before the key would have appeared,
      // so the pair is still checked; an unknown crate then reports as
      // indeterminate rather than passing by silence.
      if (b.sourceSettled) return;
      out.addCrate(b.name, b.version);
      return;
    }
    if (isCratesIoSource(b.source)) {
      out.addCrate(b.name, b.version);
      return;
    }
    out.flag(
      b.line,
      `\`${b.name}@${b.version}\` in \`${path}\` comes from ` +
        `\`${quoteLine(b.source)}\`, not crates.io, so its publish time ` +
        `cannot be checked against the quarantine.`,
    );
  };

  const feed = (line: string, added: boolean): void => {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      if (block.sawVersion) block.sourceSettled = true;
      return;
    }
    if (TABLE_HEADER_RE.test(trimmed)) {
      flush();
      return;
    }

    const entry = LOCK_STRING_KEY_RE.exec(trimmed);
    if (!entry) {
      if (block.sawVersion) block.sourceSettled = true;
      return;
    }

    const key = entry[1]!;
    const value = entry[2]!;
    switch (key) {
      case "name":
        // A second `name` without an intervening `[[package]]` means the
        // header fell outside the hunk; close the previous block first.
        if (block.sawVersion) flush();
        block.name = value;
        if (added) {
          block.changed = true;
          block.line = line;
        }
        return;
      case "version":
        block.sawVersion = true;
        block.rawVersion = value;
        block.version = pinnedVersion(value);
        if (added) {
          block.changed = true;
          block.line = line;
        }
        return;
      case "source":
        block.source = value;
        block.sourceSettled = true;
        if (added) {
          block.changed = true;
          if (block.line.length === 0) block.line = line;
        }
        return;
      default:
        if (block.sawVersion) block.sourceSettled = true;
        return;
    }
  };

  return {
    feed,
    breakContext: () => {
      flush();
    },
    finish: () => {
      flush();
    },
  };
}

// =============================================================================
// Cargo.toml
// =============================================================================

/** How the table currently in view should be read. */
type TomlSection =
  | { kind: "dependencies"; crate: string | null }
  | { kind: "other" }
  | { kind: "unknown" };

/** Classify a `[table.header]` by the dependency shapes it can carry. */
function classifyTomlHeader(content: string): TomlSection {
  const header = content.trim();
  if (OVERRIDE_HEADER_RE.test(header)) {
    return { kind: "dependencies", crate: null };
  }
  const match = DEPENDENCY_HEADER_RE.exec(header);
  if (match) return { kind: "dependencies", crate: match[1] ?? null };
  return { kind: "other" };
}

/** Read an inline table value, e.g. `{ version = "1.0", features = [] }`. */
function scanInlineTable(
  name: string,
  value: string,
  path: string,
  line: string,
  out: CargoCollector,
): void {
  if (/\bgit\s*=/.test(value)) {
    out.flag(
      line,
      `\`${name}\` in \`${path}\` is a git dependency, so it names no ` +
        `published release whose age can be checked against the quarantine.`,
    );
    return;
  }
  // A path or inherited dependency resolves elsewhere — the workspace
  // manifest or this repo's own tree — so it names no release here.
  if (/\bpath\s*=/.test(value) || /\bworkspace\s*=\s*true\b/.test(value)) {
    return;
  }
  const version = /\bversion\s*=\s*"([^"]*)"/.exec(value);
  if (!version) return;
  resolveRequirement(name, version[1]!, path, line, out);
}

function createTomlScanner(path: string, out: CargoCollector): CargoScanner {
  let section: TomlSection = { kind: "unknown" };

  const feedEntry = (line: string, key: string, value: string): void => {
    if (section.kind === "other") return;

    // `[dependencies.<crate>]` names the crate in the header, so the keys
    // inside it describe that one dependency.
    const tableCrate = section.kind === "dependencies" ? section.crate : null;
    if (tableCrate !== null) {
      if (key === "git") {
        out.flag(
          line,
          `\`${tableCrate}\` in \`${path}\` is a git dependency, so it names ` +
            `no published release whose age can be checked against the ` +
            `quarantine.`,
        );
        return;
      }
      if (key !== "version") return;
      const quoted = /^"([^"]*)"$/.exec(value);
      if (!quoted) return;
      resolveRequirement(tableCrate, quoted[1]!, path, line, out);
      return;
    }

    // Otherwise the key is the crate name — possibly in TOML's dotted form,
    // `serde.version = "1.0.229"`, where the property follows the crate.
    const dot = key.indexOf(".");
    if (dot > 0) {
      const crate = key.slice(0, dot);
      const property = key.slice(dot + 1);
      if (property === "git") {
        out.flag(
          line,
          `\`${crate}\` in \`${path}\` is a git dependency, so it names no ` +
            `published release whose age can be checked against the ` +
            `quarantine.`,
        );
        return;
      }
      if (property !== "version") return;
      const dotted = /^"([^"]*)"$/.exec(value);
      if (!dotted) return;
      resolveRequirement(crate, dotted[1]!, path, line, out);
      return;
    }
    if (section.kind === "unknown" && TOML_NON_DEPENDENCY_KEYS.has(key)) {
      return;
    }
    if (value.startsWith("{")) {
      scanInlineTable(key, value, path, line, out);
      return;
    }
    const quoted = /^"([^"]*)"$/.exec(value);
    if (!quoted) return;
    resolveRequirement(key, quoted[1]!, path, line, out);
  };

  return {
    feed: (line, added) => {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) return;
      const header = TABLE_HEADER_RE.exec(trimmed);
      if (header) {
        section = classifyTomlHeader(header[1]!);
        return;
      }
      // Context lines exist to establish the enclosing table; only an added
      // line is a change this bump introduced.
      if (!added) return;
      const entry = TOML_ENTRY_RE.exec(trimmed);
      if (!entry) return;
      feedEntry(line, entry[1]!, entry[2]!);
    },
    breakContext: () => {
      section = { kind: "unknown" };
    },
    finish: () => {},
  };
}

/** Create the scanner for one Cargo file in a bump diff. */
export function createCargoScanner(
  manifest: CargoManifest,
  path: string,
  out: CargoCollector,
): CargoScanner {
  return manifest === "lock"
    ? createLockScanner(path, out)
    : createTomlScanner(path, out);
}
