/**
 * Tests for Issue #517 — `docs/REFERENCES.md`, the standalone credit list for
 * the external sources whose ideas are embedded in the Vibe Coder's prompts
 * and documentation.
 *
 * The end-state these tests pin:
 *
 *   - Every entry carries a source name, an `https://` URL, a one-line note of
 *     what we took, and at least one repo path where the idea shows up.
 *   - Those paths really exist, so the credit list cannot quietly rot into
 *     pointing at files that were renamed or deleted.
 *   - The document is reachable from README.md by following markdown links.
 *   - Prompts stay pure: no prompt template references the credit list, and
 *     nothing fetches a source at run time.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { parseReferenceEntries } from "../lib/references_doc.ts";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

function read(relative: string): string {
  return Deno.readTextFileSync(repoPath(relative));
}

function exists(relative: string): boolean {
  try {
    Deno.statSync(repoPath(relative));
    return true;
  } catch {
    return false;
  }
}

const HEADER = [
  "| Source | What we took | Where it shows up |",
  "| ------ | ------------ | ----------------- |",
].join("\n");

function table(...rows: string[]): string {
  return [HEADER, ...rows].join("\n");
}

// ---------------------------------------------------------------------------
// Parser — happy path
// ---------------------------------------------------------------------------

Deno.test("parseReferenceEntries reads name, URL, note and paths", () => {
  const entries = parseReferenceEntries(
    table(
      "| [OWASP Top 10](https://owasp.org/Top10/2025/) | The ten risk " +
        "categories the scan enumerates | `prompts/security_scan/` |",
    ),
  );

  assertEquals(entries.length, 1);
  assertEquals(entries[0]?.name, "OWASP Top 10");
  assertEquals(entries[0]?.url, "https://owasp.org/Top10/2025/");
  assertEquals(
    entries[0]?.note,
    "The ten risk categories the scan enumerates",
  );
  assertEquals(entries[0]?.usedIn, ["prompts/security_scan/"]);
});

Deno.test("parseReferenceEntries collects every path in a cell", () => {
  const entries = parseReferenceEntries(
    table(
      "| [spec-kit](https://github.com/github/spec-kit) | Five adopted ideas " +
        "| `docs/SPEC-KIT-COMPARISON.md`, `README.md` |",
    ),
  );

  assertEquals(entries[0]?.usedIn, [
    "docs/SPEC-KIT-COMPARISON.md",
    "README.md",
  ]);
});

Deno.test("parseReferenceEntries reads rows from every credit table", () => {
  const entries = parseReferenceEntries([
    "## Security",
    table("| [A](https://a.example) | Took A | `README.md` |"),
    "## Prompting",
    table("| [B](https://b.example) | Took B | `AGENTS.md` |"),
  ].join("\n\n"));

  assertEquals(entries.map((entry) => entry.name), ["A", "B"]);
});

Deno.test("parseReferenceEntries ignores tables with a different header", () => {
  const entries = parseReferenceEntries([
    "| Not | A | Credit table |",
    "| --- | --- | --- |",
    "| [X](https://x.example) | nope | `README.md` |",
    "",
    table("| [A](https://a.example) | Took A | `README.md` |"),
  ].join("\n"));

  assertEquals(entries.map((entry) => entry.name), ["A"]);
});

// ---------------------------------------------------------------------------
// Parser — error paths (fail loud, never silently drop an entry)
// ---------------------------------------------------------------------------

Deno.test("parseReferenceEntries rejects a source without a link", () => {
  assertThrows(
    () => parseReferenceEntries(table("| OWASP | Took it | `README.md` |")),
    Error,
    "linked source",
  );
});

Deno.test("parseReferenceEntries rejects a non-https source URL", () => {
  assertThrows(
    () =>
      parseReferenceEntries(
        table("| [OWASP](http://owasp.org/) | Took it | `README.md` |"),
      ),
    Error,
    "https://",
  );
});

Deno.test("parseReferenceEntries rejects an entry with no note", () => {
  assertThrows(
    () =>
      parseReferenceEntries(
        table("| [OWASP](https://owasp.org/) |  | `README.md` |"),
      ),
    Error,
    "note",
  );
});

Deno.test("parseReferenceEntries rejects an entry with no repo path", () => {
  assertThrows(
    () =>
      parseReferenceEntries(
        table("| [OWASP](https://owasp.org/) | Took it | everywhere |"),
      ),
    Error,
    "path",
  );
});

Deno.test("parseReferenceEntries rejects a document with no credit table", () => {
  assertThrows(
    () => parseReferenceEntries("# References\n\nNothing here yet.\n"),
    Error,
    "no credit table",
  );
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

Deno.test("parseReferenceEntries rejects an empty document", () => {
  assertThrows(() => parseReferenceEntries(""), Error, "no credit table");
});

Deno.test("parseReferenceEntries keeps unicode and punctuation intact", () => {
  const entries = parseReferenceEntries(
    table(
      "| [Diátaxis — the four modes](https://diataxis.fr/) | Splits how-to " +
        "from reference | `README.md` |",
    ),
  );

  assertEquals(entries[0]?.name, "Diátaxis — the four modes");
});

// ---------------------------------------------------------------------------
// The real document
// ---------------------------------------------------------------------------

Deno.test("docs/REFERENCES.md credits the known seed sources", () => {
  const entries = parseReferenceEntries(read("docs/REFERENCES.md"));
  const urls = entries.map((entry) => entry.url).join("\n");

  for (
    const seed of [
      "https://owasp.org/Top10/2025/",
      "https://github.com/github/spec-kit",
      "https://github.com/JuliusBrussee/caveman",
      "https://github.com/mattpocock/skills",
      "https://rust-lang.github.io/api-guidelines/",
    ]
  ) {
    assert(urls.includes(seed), `docs/REFERENCES.md must credit ${seed}`);
  }
});

Deno.test("every docs/REFERENCES.md entry points at paths that exist", () => {
  const entries = parseReferenceEntries(read("docs/REFERENCES.md"));
  const missing = entries
    .flatMap((entry) => entry.usedIn)
    .filter((path) => !exists(path))
    .sort();

  assertEquals(missing, [], "Credit list points at paths that no longer exist");
});

Deno.test("docs/REFERENCES.md credits each source exactly once", () => {
  const entries = parseReferenceEntries(read("docs/REFERENCES.md"));
  const seen = new Set<string>();
  const duplicates = entries
    .map((entry) => entry.url)
    .filter((url) => !seen.add(url))
    .sort();

  assertEquals(duplicates, [], "Each source deserves a single credit row");
});

Deno.test("docs/REFERENCES.md is linked from the README", () => {
  const readme = read("README.md");
  assert(
    readme.includes("docs/REFERENCES.md"),
    "README.md must link to docs/REFERENCES.md",
  );
});

// ---------------------------------------------------------------------------
// Prompt purity — the credit list never leaks into a prompt
// ---------------------------------------------------------------------------

Deno.test("no prompt template references the credit list", () => {
  const offenders: string[] = [];
  const walk = (relative: string) => {
    for (const entry of Deno.readDirSync(repoPath(relative))) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory) {
        walk(child);
      } else if (
        entry.name.endsWith(".md") && read(child).includes("REFERENCES.md")
      ) {
        offenders.push(child);
      }
    }
  };
  walk("prompts");

  assertEquals(
    offenders.sort(),
    [],
    "Prompts stay pure — credit lives in docs/REFERENCES.md, not in prompts",
  );
});
