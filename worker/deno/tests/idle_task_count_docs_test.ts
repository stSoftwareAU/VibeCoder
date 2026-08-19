/**
 * Regression tests for Issue #3347 — the number of registered idle-task
 * templates was stated three different ways across the live documentation, and
 * most of them were stale: `docs/CONFIGURATION.md` still said "ten registered
 * ones" and derived a `1/10` draw plus a ten-way weight example from it,
 * `docs/ADD-REPO.md` seeded "all ten" wrappers, `DESIGN-PRINCIPLES.md` claimed
 * "Sixteen production templates" two lines above "1/17 each … seventeen", and
 * the per-scan manuals still drew `1/6` or `1/13`. An operator tuning
 * `idle_task_template_weights` was reasoning from a wrong denominator.
 *
 * The registry is the single source of truth: every expectation below is
 * derived from `IDLE_TASK_WRAPPER_TEMPLATE_NAMES`, never hard-coded, so adding
 * a template keeps these tests honest instead of pinning today's number.
 *
 * `design_principles_template_count_test.ts` already guards the design digest;
 * this suite widens the same invariant to every live operator manual, and adds
 * the per-template `#N` ordinal check the digest never had (`bash-script-refs`
 * carried no ordinal at all, so `#12` was a hole and `bash-syntax-audit` was
 * labelled both "template #11" and "the twelfth registered … overall").
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { IDLE_TASK_WRAPPER_TEMPLATE_NAMES } from "../lib/idle_task_backfill.ts";

/** Registry size — the denominator every live doc claim must agree with. */
const REGISTRY_SIZE = IDLE_TASK_WRAPPER_TEMPLATE_NAMES.size;

/** Registered template names in registration order. */
const REGISTERED_NAMES: readonly string[] = [
  ...IDLE_TASK_WRAPPER_TEMPLATE_NAMES,
];

/** Cardinal number words the docs use when counting the registry. */
const NUMBER_WORDS: ReadonlyMap<string, number> = new Map([
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
]);

/** Ordinal words the per-scan manuals use for a template's registry position. */
const ORDINAL_WORDS: ReadonlyMap<string, number> = new Map([
  ["first", 1],
  ["second", 2],
  ["third", 3],
  ["fourth", 4],
  ["fifth", 5],
  ["sixth", 6],
  ["seventh", 7],
  ["eighth", 8],
  ["ninth", 9],
  ["tenth", 10],
  ["eleventh", 11],
  ["twelfth", 12],
  ["thirteenth", 13],
  ["fourteenth", 14],
  ["fifteenth", 15],
  ["sixteenth", 16],
  ["seventeenth", 17],
  ["eighteenth", 18],
  ["nineteenth", 19],
  ["twentieth", 20],
]);

// tests/ → worker/deno/ → worker/ → repo root
const REPO_ROOT = new URL("../../../", import.meta.url);

function repoPath(relative: string): URL {
  return new URL(relative, REPO_ROOT);
}

/**
 * Documents deliberately exempt from the registry-size invariant.
 *
 * `docs/archive/**` and `docs/audits/**` are dated records — a PR summary that
 * described a `1/10` draw at the time is history, not a stale claim. The OWASP
 * matrix and the supply-chain-detection design note are both explicitly
 * point-in-time (the matrix says so in its own preamble; the design note
 * numbers a *proposed* template that was never registered).
 */
const EXEMPT_PREFIXES: readonly string[] = [
  "docs/archive/",
  "docs/audits/",
];
const EXEMPT_FILES: readonly string[] = [
  "docs/OWASP-TOP-10-2025-COVERAGE-MATRIX.md",
  "docs/SUPPLY-CHAIN-DETECTION-SCAN.md",
];

function isExempt(relative: string): boolean {
  return EXEMPT_PREFIXES.some((prefix) => relative.startsWith(prefix)) ||
    EXEMPT_FILES.includes(relative);
}

/** Every live Markdown document: repo-root `*.md` plus `docs/**`. */
async function liveDocs(): Promise<Array<{ path: string; text: string }>> {
  const paths: string[] = [];

  for await (const entry of Deno.readDir(REPO_ROOT)) {
    if (entry.isFile && entry.name.endsWith(".md")) paths.push(entry.name);
  }

  async function walk(relativeDir: string): Promise<void> {
    for await (const entry of Deno.readDir(repoPath(relativeDir))) {
      const relative = `${relativeDir}${entry.name}`;
      if (entry.isDirectory) {
        if (!isExempt(`${relative}/`)) await walk(`${relative}/`);
        continue;
      }
      if (entry.isFile && entry.name.endsWith(".md")) paths.push(relative);
    }
  }
  await walk("docs/");

  const kept = paths.filter((path) => !isExempt(path)).sort();
  return await Promise.all(kept.map(async (path) => ({
    path,
    text: await Deno.readTextFile(repoPath(path)),
  })));
}

/**
 * Flatten Markdown emphasis and Mermaid line breaks so `**ten** templates` and
 * `all ten<br/>idle-task wrappers` read as ordinary prose to the matchers.
 */
function flatten(markdown: string): string {
  return markdown.replaceAll(/<br\s*\/?>/gi, " ").replaceAll(/[*_]/g, "");
}

/** Line number (1-indexed) of a character offset, for readable failures. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

Deno.test("live docs - every uniform-draw denominator matches the registry size", async () => {
  const pattern = /1\/(\d+)\s+(?:RNG|each|chance|draw)/g;
  const offenders: string[] = [];
  let claims = 0;

  for (const { path, text } of await liveDocs()) {
    const flat = flatten(text);
    for (const match of flat.matchAll(pattern)) {
      claims++;
      const claimed = Number(match[1]);
      if (claimed !== REGISTRY_SIZE) {
        offenders.push(
          `${path}:${lineOf(flat, match.index)} claims a 1/${claimed} draw`,
        );
      }
    }
  }

  assert(
    claims > 0,
    "no uniform-draw claim found — the matcher is out of date",
  );
  assertEquals(
    offenders,
    [],
    `${REGISTRY_SIZE} idle-task templates are registered, but:\n` +
      offenders.join("\n"),
  );
});

/**
 * Phrase shapes that count the *whole* registry, as opposed to a subset ("the
 * other five templates", "which eight wrappers already existed") or a different
 * kind of template altogether ("substituted into eight prompt templates").
 */
const REGISTRY_COUNT_PATTERNS: readonly RegExp[] = [
  // "all seventeen templates", "the ten idle-task wrappers", "the six idle tasks"
  /\b(?:all|the)\s+([a-z]+)\s+(?:(?:registered|production|standard|canonical|idle-task)\s+)*(?:templates|wrappers|scans|idle tasks)\b/gi,
  // "Sixteen production templates", "seventeen registered wrappers"
  /\b([a-z]+)\s+(?:registered|production)\s+(?:idle-task\s+)?(?:templates|wrappers)\b/gi,
  // "seeds the ten idle-task scans", "twelve idle tasks"
  /\b([a-z]+)\s+idle[- ]task\s+(?:templates|wrappers|scans)\b/gi,
  /\b([a-z]+)\s+idle tasks\b/gi,
];

Deno.test("live docs - every spelled-out template count matches the registry size", async () => {
  // Keyed by location so two overlapping shapes on one line report once.
  const offenders = new Map<string, string>();
  let claims = 0;

  for (const { path, text } of await liveDocs()) {
    const flat = flatten(text);
    for (const pattern of REGISTRY_COUNT_PATTERNS) {
      for (const match of flat.matchAll(pattern)) {
        const claimed = NUMBER_WORDS.get((match[1] ?? "").toLowerCase());
        if (claimed === undefined) continue; // not a cardinal count
        claims++;
        if (claimed !== REGISTRY_SIZE) {
          const where = `${path}:${lineOf(flat, match.index)}`;
          if (!offenders.has(where)) {
            offenders.set(where, `${where} says "${match[0].trim()}"`);
          }
        }
      }
    }
  }

  assert(claims > 0, "no spelled-out count found — the matcher is out of date");
  const listed = [...offenders.values()].sort();
  assertEquals(
    listed,
    [],
    `${REGISTRY_SIZE} idle-task templates are registered, but:\n` +
      listed.join("\n"),
  );
});

Deno.test("live docs - per-template ordinals cover 1..N with no hole", async () => {
  // Prose form ("template #12") and the DESIGN-PRINCIPLES module list
  // ("`bash_syntax_audit_template.ts` (#12, …)").
  const patterns = [
    /template #(\d+)/gi,
    /_template\.ts`\s*\(#(\d+)/g,
  ];
  const seen = new Map<number, string>();

  for (const { path, text } of await liveDocs()) {
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const ordinal = Number(match[1]);
        if (!seen.has(ordinal)) {
          seen.set(ordinal, `${path}:${lineOf(text, match.index)}`);
        }
      }
    }
  }

  const overflow = [...seen.entries()]
    .filter(([ordinal]) => ordinal > REGISTRY_SIZE)
    .map(([ordinal, where]) => `#${ordinal} (${where})`);
  assertEquals(
    overflow,
    [],
    `only ${REGISTRY_SIZE} templates are registered, so these ordinals cannot exist:\n` +
      overflow.join("\n"),
  );

  const missing = Array.from(
    { length: REGISTRY_SIZE },
    (_, index) => index + 1,
  ).filter((ordinal) => !seen.has(ordinal));
  assertEquals(
    missing,
    [],
    `no live document assigns template ordinal(s) ${
      missing.map((n) => `#${n}`).join(", ")
    } — every registered template must carry one`,
  );
});

Deno.test("design digest - every template module carries an ordinal", async () => {
  const digest = await Deno.readTextFile(repoPath("DESIGN-PRINCIPLES.md"));
  const missing: string[] = [];

  for await (
    const entry of Deno.readDir(repoPath("worker/deno/lib/idle_task_templates"))
  ) {
    if (!entry.isFile || !entry.name.endsWith("_template.ts")) continue;
    const numbered = new RegExp(
      `\`${entry.name.replaceAll(".", "\\.")}\`\\s*\\(#\\d+`,
    );
    if (!numbered.test(digest)) missing.push(entry.name);
  }

  assertEquals(
    missing.sort(),
    [],
    "DESIGN-PRINCIPLES.md lists these template modules without a (#N) ordinal:\n" +
      missing.join("\n"),
  );
});

Deno.test("per-scan manuals - the ordinal a manual claims for itself is in range", async () => {
  const docs = await liveDocs();
  const byPath = new Map(docs.map((doc) => [doc.path, doc.text]));
  let checked = 0;

  for (const [index, name] of REGISTERED_NAMES.entries()) {
    const position = index + 1;
    const candidates = [
      `docs/${name.toUpperCase()}-SCAN.md`,
      `docs/${name.toUpperCase()}.md`,
    ];
    const path = candidates.find((candidate) => byPath.has(candidate));
    if (path === undefined) continue;

    const text = byPath.get(path) ?? "";
    // "the thirteenth registered idle-task template" — the manual's own claim.
    for (const match of text.matchAll(/\bthe ([a-z]+) registered\b/gi)) {
      const claimed = ORDINAL_WORDS.get((match[1] ?? "").toLowerCase());
      if (claimed === undefined) continue;
      checked++;
      assert(
        claimed <= REGISTRY_SIZE,
        `${path}:${
          lineOf(text, match.index)
        } claims ordinal #${claimed} but only ${REGISTRY_SIZE} templates are registered`,
      );
      assertEquals(
        claimed,
        position,
        `${path} claims to be the ${
          match[1]
        } registered template, but ${name} is #${position} in the registry`,
      );
    }
  }

  assert(checked > 0, "no per-scan ordinal claim found — matcher out of date");
});
