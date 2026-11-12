/**
 * Drift test for Issues #4954 and #4955 — the TokenEconomizer trial protocol
 * page.
 *
 * `docs/TOKEN-ECONOMIZER-TRIAL.md` records the protocol the TokenEconomizer
 * trial is judged by. The image pin and the `token_economizer` config block
 * landed with #4955. The wiring, the learnings store, the stats and the verdict
 * are sibling issues #4956 to #4959, still open. This is a drift test. It pins
 * the page to the repository as it stands, and it says what must change on the
 * page when each sibling lands.
 *
 * It pins five things:
 *
 * - the commit the page names is the commit the image pins, and a file under
 *   `container/` pins it;
 * - the Claude Code version the page states for the image is the version
 *   `container/tools.json` pins for the `claude` provider;
 * - the config keys the page names are the keys the code names, and the page
 *   says "Not yet" exactly while no code names the block;
 * - the purge list names every text file in the repository that names the
 *   plugin, each with a state that matches the file;
 * - the phrases each section keeps, and the links from the pages that point
 *   here.
 *
 * The checks are one pure function over a map of repo-relative paths to text,
 * so a fixture can break one rule and the test can see that rule refuse it.
 * The live corpus is every text file git tracks at the repository root
 * (`git ls-files`). Gitignored local files, such as agent worktrees and an
 * operator's `.config.json`, are not in it. Also left out are the dependency
 * and version-control trees, the worker state under `graft/` and `.codegraph/`,
 * and the historical records under `docs/archive/` and `docs/audits/`. It is
 * read once and must pass. There are no wall-clock thresholds and no network
 * calls.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals } from "@std/assert";
import {
  type DocSection,
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const DOC = "docs/TOKEN-ECONOMIZER-TRIAL.md";
const TEST_PATH = "worker/deno/tests/token_economizer_trial_docs_test.ts";
/** `tests/` is three levels below the repo root. */
const REPO_ROOT = new URL("../../../", import.meta.url);
/** The same root as a filesystem path, with its trailing slash. */
const REPO_ROOT_PATH = decodeURIComponent(REPO_ROOT.pathname);

/** The plugin's name in any spelling the repo uses. */
const MENTION = /token[-_ ]?economizer/i;
const HEX40 = /\b[0-9a-f]{40}\b/g;
/** The manifest that pins the plugin's commit and every provider's version. */
const TOOLS_PATH = "container/tools.json";
/** The toolchain id the manifest pins the plugin under. */
const PLUGIN_ID = "tokeneconomizer";
/** The provider id whose version the page states for the image. */
const CLAUDE_ID = "claude";
const BLOCK_NOT_YET = "Not yet: #4955 adds the block";
/**
 * The sentence the page says while code reads the block: every key but
 * `learnings_repo` is read, and that one stays unread until #4957.
 */
const BLOCK_LANDED =
  "`learnings_repo` is validated but not read yet: #4957 will persist the learnings to it, so it changes no run today.";
const BLOCK_KEYS = ["enabled", "learnings_repo", "microskills", "loopguard"];
const PURGE_KINDS = [
  "Drift test",
  "Image layer",
  "Config key",
  "Doc section",
  "Callback field",
  "Learnings directory",
];
/** The image's Claude Code version, as the candidate section states it. */
const CLAUDE_STATEMENT = /This image's Claude Code: \*\*([^*\s]+)\*\*/g;
/** Upstream's Claude Code row, quoted verbatim from its supported-version table. */
const CLAUDE_ROW = "| Claude Code | 2.1.300 to 2.1.310 | not supported |";

/** A `Status` row in the header table, read as one table cell. */
const STATUS_ROW = /^\| \*\*Status\*\* \| (.*) \|$/m;
/** Names skipped at any depth: version control and installed dependencies. */
const WALK_SKIP_NAMES = [".git", "node_modules"];
/**
 * Repo-relative directories skipped where they sit: worker state, and the
 * historical records that a purge leaves alone.
 */
const WALK_SKIP_PATHS = ["graft", ".codegraph", "docs/archive", "docs/audits"];
const MAX_CORPUS_BYTES = 2 * 1024 * 1024;
/** A file with a NUL byte in its first bytes is binary, and is not read. */
const BINARY_PROBE_BYTES = 1024;

/**
 * Each section and the phrases it must keep. A phrase is matched against the
 * `flat()` text of its own section only, so the same words elsewhere on the
 * page cannot satisfy it.
 */
const STRUCTURE: ReadonlyArray<
  readonly [string, ReadonlyArray<string | RegExp>]
> = [
  [
    "The candidate",
    [
      "envfacts+distiller",
      "nudge",
      "TE_TOOLPRUNE=off",
      "TE_REPOMAP=off",
      "TE_HISTORY_IMPORT=false",
      "Apache-2.0",
      "never cloned at run time",
      "recorded sha256",
      "container/tools.json",
    ],
  ],
  [
    "The trial host",
    ["GRQ-25", "Claude Code", "counts as plugin-off", "no other trial window"],
  ],
  [
    "The window",
    [
      "first switched-on run completes",
      "7 days",
      "whichever comes later",
      "three sessions",
      "five well-ended turns",
      /\b60\b[^.]*implementation runs/,
    ],
  ],
  [
    "The bar",
    ["10% lower", "mean cost", "own model calls", "no worse", "merge rate"],
  ],
  [
    "The comparison rule",
    [
      "14 days before the window",
      "same window",
      "same repositories",
      "disagree",
      "concurrent comparison decides",
    ],
  ],
  [
    "Stop rules",
    [
      "secret",
      "another repository",
      "the plugin's fault",
      "switched off at once",
      "failed",
    ],
  ],
];

type Json = Record<string, unknown>;

function distinct(values: string[]): string[] {
  return [...new Set(values)];
}

/** True for a plain (non-array, non-null) JSON object. */
function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The section with `title`, or `undefined` — never a throw. */
function sectionOf(page: string, title: string): DocSection | undefined {
  try {
    return section(page, title);
  } catch {
    return undefined;
  }
}

/**
 * Every 40-hex token inside a JSON object that names the plugin, by one of its
 * keys or one of its own string values. The search goes to any depth, so the
 * plugin's entry is found wherever it sits in the file.
 */
function commitsUnderPluginObjects(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(commitsUnderPluginObjects);
  if (!isRecord(node)) return [];
  const entries = Object.entries(node);
  const namesPlugin = entries.some(([key, value]) =>
    MENTION.test(key) || (typeof value === "string" && MENTION.test(value))
  );
  if (namesPlugin) return commitsIn(node);
  return entries.flatMap(([, value]) => commitsUnderPluginObjects(value));
}

/** Every 40-hex token anywhere inside a parsed JSON value. */
function commitsIn(node: unknown): string[] {
  if (typeof node === "string") return node.match(HEX40) ?? [];
  if (Array.isArray(node)) return node.flatMap(commitsIn);
  if (isRecord(node)) return Object.values(node).flatMap(commitsIn);
  return [];
}

/**
 * The commit a `container/` file pins for the plugin. A `.json` file is read
 * under the objects that name the plugin, and it is a problem when none of
 * them yields a commit, so the check fails closed. Any other file is read from
 * its plugin-naming lines, and naming the plugin without a commit is no problem
 * by itself.
 */
function readPins(
  path: string,
  text: string,
): { tokens: string[]; problem?: string } {
  if (path.endsWith(".json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        tokens: [],
        problem:
          `${path} is not valid JSON, so the commit it pins cannot be read: fix the JSON`,
      };
    }
    const tokens = commitsUnderPluginObjects(parsed);
    if (tokens.length === 0) {
      return {
        tokens,
        problem:
          `${path} names the plugin but no 40-character commit can be read from the object that names it: put the pinned commit (40 lowercase hex characters) on the plugin's object, under its id or key`,
      };
    }
    return { tokens };
  }
  const tokens = text
    .split("\n")
    .filter((line) => MENTION.test(line))
    .flatMap((line) => line.match(HEX40) ?? []);
  return { tokens };
}

/** Rule R1: the page's commit, the candidate section and the image pin. */
function pinProblems(
  page: string,
  candidate: DocSection,
  files: Map<string, string>,
): string[] {
  const shas = distinct(
    Array.from(candidate.matchAll(/`([0-9a-f]{40})`/g), (m) => m[1] ?? ""),
  );
  const sha = shas[0];
  if (shas.length !== 1 || sha === undefined) {
    return [
      `${DOC}: the candidate section must name exactly one commit, written as \`<40-character sha>\`; it names ${shas.length}: keep the one pinned commit there`,
    ];
  }

  const problems: string[] = [];
  for (const token of distinct(page.match(HEX40) ?? [])) {
    if (token !== sha) {
      problems.push(
        `${DOC} names commit ${token} on the page, but its candidate section pins ${sha}: the header table and the candidate section disagree, so make every 40-character commit on the page the same value`,
      );
    }
  }

  const pinnedBy: string[] = [];
  const naming: string[] = [];
  for (const [path, text] of files) {
    if (
      !path.startsWith("container/") ||
      !(MENTION.test(path) || MENTION.test(text))
    ) {
      continue;
    }
    naming.push(path);
    const { tokens, problem } = readPins(path, text);
    if (problem !== undefined) {
      problems.push(problem);
      continue;
    }
    if (tokens.length === 0) continue;
    pinnedBy.push(path);
    for (const token of tokens) {
      if (token !== sha) {
        problems.push(
          `${path} pins commit ${token}, but ${DOC} says ${sha}: change the image's pin and the page's commit together, in one PR`,
        );
      }
    }
  }

  if (pinnedBy.length === 0) {
    const named = naming.length === 0
      ? "no file under container/ names the plugin"
      : `${naming.join(", ")} name the plugin, but none yields a commit`;
    problems.push(
      `${DOC} says the image pins commit ${sha}, but ${named}: restore the pin: the page says the image pins it`,
    );
  }
  return problems;
}

/** Rule R2: the config keys the page names against the code that reads them. */
function blockProblems(
  candidate: DocSection,
  files: Map<string, string>,
): string[] {
  const problems: string[] = [];
  const docKeys = distinct(
    Array.from(
      candidate.matchAll(/token_economizer\.([a-z_]+)/g),
      (m) => m[1] ?? "",
    ),
  );
  for (const key of BLOCK_KEYS) {
    if (!docKeys.includes(key)) {
      problems.push(
        `${DOC}: the candidate section does not name token_economizer.${key}: the block has four keys (${
          BLOCK_KEYS.map((k) => `token_economizer.${k}`).join(", ")
        }), so name each one`,
      );
    }
  }
  for (const key of docKeys) {
    if (!BLOCK_KEYS.includes(key)) {
      problems.push(
        `${DOC} names token_economizer.${key}, which is not one of the block's four keys (${
          BLOCK_KEYS.join(", ")
        }): correct the key name on the page, or change the block`,
      );
    }
  }

  const hasSentence = flat(candidate).includes(BLOCK_NOT_YET);
  const codeFiles = [...files].filter(([path, text]) =>
    (path.startsWith("worker/deno/lib/") ||
      path.startsWith("worker/deno/commands/")) &&
    (MENTION.test(path) || MENTION.test(text))
  );
  if (codeFiles.length === 0) {
    if (!hasSentence) {
      problems.push(
        `${DOC}: no file under worker/deno/lib or worker/deno/commands names the block, so the candidate section must say "${BLOCK_NOT_YET}": restore that sentence until #4955 adds the block`,
      );
    }
    return problems;
  }

  const names = codeFiles.map(([path]) => path).join(", ");
  if (hasSentence) {
    problems.push(
      `${names} names the block, but the candidate section still says "${BLOCK_NOT_YET}": delete that sentence`,
    );
  }
  const blockFiles = codeFiles.filter(([, text]) =>
    text.includes("token_economizer")
  );
  if (blockFiles.length === 0) {
    problems.push(
      `${names} names the plugin, but none contains the exact text token_economizer: the code names the block differently, so name it token_economizer as the page does`,
    );
  }
  for (const key of docKeys) {
    if (
      !blockFiles.some(([, text]) => text.split(/[^A-Za-z0-9_]+/).includes(key))
    ) {
      problems.push(
        `no code file that contains token_economizer contains the key ${key}: the page documents token_economizer.${key}, so the code must read it, or the page must drop it`,
      );
    }
  }
  return problems;
}

/**
 * The `version` the manifest pins for the `claude` provider, read from the
 * manifest's JSON. A missing or unreadable manifest is a problem, not a pass.
 */
function claudeVersionPinned(
  files: Map<string, string>,
): { version?: string; problem?: string } {
  const text = files.get(TOOLS_PATH);
  if (text === undefined) {
    return {
      problem:
        `${TOOLS_PATH} is missing, so the Claude Code version the image pins cannot be read: restore the manifest`,
    };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(text);
  } catch {
    return {
      problem:
        `${TOOLS_PATH} is not valid JSON, so the Claude Code version the image pins cannot be read: fix the JSON`,
    };
  }
  const providers: unknown[] = isRecord(manifest) &&
      Array.isArray(manifest.providers)
    ? manifest.providers
    : [];
  const claude = providers.find((p): p is Json =>
    isRecord(p) && p.id === CLAUDE_ID
  );
  if (claude === undefined || typeof claude.version !== "string") {
    return {
      problem:
        `${TOOLS_PATH} has no providers entry with id "${CLAUDE_ID}" and a version, so the Claude Code version the image pins cannot be read: restore that entry`,
    };
  }
  return { version: claude.version };
}

/**
 * Rule R5: the image's Claude Code version the candidate section states, and
 * the upstream row beside it, against the `claude` provider in the manifest.
 */
function claudeProblems(
  candidate: DocSection,
  files: Map<string, string>,
): string[] {
  const problems: string[] = [];
  const stated = Array.from(
    candidate.matchAll(CLAUDE_STATEMENT),
    (m) => m[1] ?? "",
  );
  if (stated.length !== 1) {
    problems.push(
      `${DOC}: the candidate section must state the image's Claude Code version once, as "This image's Claude Code: **<version>**" beside the upstream table; it states ${stated.length}: write that line once`,
    );
  }
  const quoted = candidate.split("\n").some((line) =>
    line.trim() === CLAUDE_ROW
  );
  if (!quoted) {
    problems.push(
      `${DOC}: the candidate section does not quote upstream's Claude Code row "${CLAUDE_ROW}": quote the supported-version table verbatim`,
    );
  }
  const pinned = claudeVersionPinned(files);
  if (pinned.problem !== undefined) {
    problems.push(pinned.problem);
    return problems;
  }
  if (stated.length === 1 && stated[0] !== pinned.version) {
    problems.push(
      `${DOC} says this image's Claude Code is ${
        stated[0]
      }, but ${TOOLS_PATH} pins the claude provider at ${pinned.version}: update the page's Claude Code version in the same PR as the Claude Code bump`,
    );
  }
  return problems;
}

type PurgeRow = { kind: string; path: string | undefined; state: string };

/** The purge table's rows; the header and the separator are skipped. */
function purgeRows(purge: DocSection, problems: string[]): PurgeRow[] {
  const rows: PurgeRow[] = [];
  for (const raw of purge.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    const kind = cells[0] ?? "";
    if (kind === "Kind" || /^:?-{3,}$/.test(kind)) continue;
    if (cells.length !== 4) {
      problems.push(
        `${DOC}: purge list row "${line}" has ${cells.length} cells, not 4 (Kind | What | Path | State)`,
      );
      continue;
    }
    const pathCell = cells[2] ?? "";
    const state = cells[3] ?? "";
    const backticked = /^`([^`]+)`$/.exec(pathCell);
    if (backticked) {
      rows.push({ kind, path: backticked[1], state });
    } else if (pathCell === "—") {
      rows.push({ kind, path: undefined, state });
    } else {
      problems.push(
        `purge list row "${kind}" has path cell "${pathCell}": write a backticked repo-relative path, or — for none`,
      );
    }
  }
  return rows;
}

/** Rule R3: the purge list against the files that name the plugin. */
function purgeProblems(
  purge: DocSection,
  files: Map<string, string>,
): string[] {
  const problems: string[] = [];
  const rows = purgeRows(purge, problems);

  const kinds = new Set(rows.map((row) => row.kind));
  for (const kind of PURGE_KINDS) {
    if (!kinds.has(kind)) {
      problems.push(
        `the purge list has no "${kind}" row: add one for each ${kind.toLowerCase()} the trial adds, with its state`,
      );
    }
  }

  for (const row of rows) {
    const { kind, state } = row;
    if (!(state === "present" || /^planned #\d+$/.test(state))) {
      problems.push(
        `purge list row "${kind}" has state "${state}": use \`present\` or \`planned #N\``,
      );
    }
    const path = row.path;
    if (path === undefined) continue;
    const isDir = path.endsWith("/");
    const named = [...files].filter(([p]) =>
      isDir ? p.startsWith(path) : p === path
    );
    const mentioning = named.some(([, text]) => MENTION.test(text));
    if (state === "present" && !mentioning) {
      problems.push(
        `purge list row "${kind}" marks ${path} present, but ${
          named.length === 0
            ? "it is not in the repository"
            : "it does not name the plugin"
        }: fix the path, or mark the row planned #N until the file names the plugin`,
      );
    }
    if (/^planned/.test(state) && mentioning) {
      problems.push(
        `purge list row "${kind}" marks ${path} planned, but it now names the plugin: mark it present`,
      );
    }
  }

  for (const [path, text] of files) {
    if (path === DOC || !(MENTION.test(path) || MENTION.test(text))) continue;
    const covered = rows.some((row) =>
      row.path !== undefined &&
      (row.path === path ||
        (row.path.endsWith("/") && path.startsWith(row.path)))
    );
    if (!covered) {
      problems.push(
        `${path} names the plugin, but no row of the purge list covers it: add a row for it, or for its directory, to the purge list in ${DOC}, so a purge removes it`,
      );
    }
  }
  return problems;
}

/**
 * Rule R4: the header table's Status cell says "not started", and each section
 * keeps its phrases. Returns the problems rather than throwing.
 */
function structureProblems(page: string): string[] {
  const problems: string[] = [];
  const status = STATUS_ROW.exec(page)?.[1];
  if (status === undefined) {
    problems.push(
      `${DOC}: the header table has no **Status** row: add one, with its state, and say not started until the window opens`,
    );
  } else if (!/\bnot started\b/.test(status)) {
    problems.push(
      `${DOC}: the Status cell must say "not started" until the window opens: set it to not started`,
    );
  }
  for (const [title, pins] of STRUCTURE) {
    const body = sectionOf(page, title);
    if (body === undefined) {
      problems.push(
        `${DOC} has no heading containing "${title}": restore the section, or rename the title here to match`,
      );
      continue;
    }
    const text = flat(body);
    for (const pin of pins) {
      const found = typeof pin === "string"
        ? text.includes(flatWholeFile(pin))
        : pin.test(text);
      if (!found) {
        const shown = typeof pin === "string" ? `"${pin}"` : pin.source;
        problems.push(
          `the "${title}" section of ${DOC} is missing ${shown}: restore the rule it pins inside that section`,
        );
      }
    }
  }
  return problems;
}

/**
 * Every drift problem on the trial page, given the page and the repository's
 * files as a map of repo-relative path to text. `[]` means consistent.
 */
function driftProblems(page: string, files: Map<string, string>): string[] {
  const problems = structureProblems(page);
  const candidate = sectionOf(page, "The candidate");
  if (candidate !== undefined) {
    problems.push(
      ...pinProblems(page, candidate, files),
      ...blockProblems(candidate, files),
      ...claudeProblems(candidate, files),
    );
  }
  const purge = sectionOf(page, "The purge list");
  if (purge === undefined) {
    problems.push(
      `${DOC} has no heading containing "The purge list": restore the purge list`,
    );
  } else {
    problems.push(...purgeProblems(purge, files));
  }
  return problems;
}

/** True when `path` sits under an excluded tree or has an excluded name. */
function isSkipped(path: string): boolean {
  if (path.split("/").some((part) => WALK_SKIP_NAMES.includes(part))) {
    return true;
  }
  return WALK_SKIP_PATHS.some((dir) =>
    path === dir || path.startsWith(`${dir}/`)
  );
}

/** Tracked paths at `root`, from `git ls-files -z`: ignored files never appear. */
async function trackedPaths(root: string): Promise<string[]> {
  const result = await new Deno.Command("git", {
    args: ["ls-files", "-z"],
    cwd: root,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    throw new Error(`git ls-files failed at ${root}: ${stderr}`);
  }
  return new TextDecoder().decode(result.stdout).split("\0").filter((p) =>
    p !== ""
  );
}

/**
 * Add one tracked file to the corpus, unless it is excluded, a symlink, absent
 * from the working tree, large or binary.
 */
async function addFile(
  files: Map<string, string>,
  root: string,
  path: string,
): Promise<void> {
  if (isSkipped(path)) return;
  const file = `${root}${path}`;
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(file);
  } catch (error) {
    // A tracked file deleted in the working tree is not in the corpus.
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  if (!info.isFile || info.size > MAX_CORPUS_BYTES) return;
  const bytes = await Deno.readFile(file);
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return;
  files.set(path, new TextDecoder().decode(bytes));
}

/**
 * Every tracked text file of the git repository at `root` (a path with a
 * trailing slash), keyed by repo-relative path. Gitignored local files, such
 * as agent worktrees and an operator's `.config.json`, are not repository
 * files and are left out.
 */
async function readCorpus(
  root: string = REPO_ROOT_PATH,
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const path of await trackedPaths(root)) {
    await addFile(files, root, path);
  }
  return files;
}

/** The trial page, read fresh so an edit between tests cannot be cached. */
async function livePage(): Promise<string> {
  return await readRepoDoc(DOC);
}

let liveCorpusCache: Promise<Map<string, string>> | undefined;
/** The live corpus, read once. Fixtures copy it and never mutate it. */
function liveCorpus(): Promise<Map<string, string>> {
  liveCorpusCache ??= readCorpus();
  return liveCorpusCache;
}

/** The candidate's commit, read from a page the way rule R1 reads it. */
function candidateSha(page: string): string {
  const shas = distinct(
    Array.from(
      section(page, "The candidate").matchAll(/`([0-9a-f]{40})`/g),
      (m) => m[1] ?? "",
    ),
  );
  assertEquals(shas.length, 1, "fixture: the candidate names one commit");
  const sha = shas[0];
  assert(sha !== undefined, "fixture: the candidate names one commit");
  return sha;
}

const A40 = "a".repeat(40);
const B40 = "b".repeat(40);
const CONFIG_PATH = "worker/deno/lib/token_economizer_config.ts";
const NAMED_PATH = "worker/deno/lib/tokenEconomizerConfig.ts";
const CONFIG_TEXT =
  "// The token_economizer block: enabled, learnings_repo, microskills, loopguard.\n";
const SH_PATH = "container/toolchains/token_economizer.sh";
const TYPES_PATH = "worker/deno/types.ts";
const EXTRA_PATH = "container/extra.json";
const NOTES_PATH = "container/notes.txt";
const PURGE_SEPARATOR = "| ---- | ---- | ---- | ----- |";

function withFile(
  files: Map<string, string>,
  path: string,
  text: string,
): Map<string, string> {
  return new Map(files).set(path, text);
}

/** Replace a literal that must occur exactly once in the fixture. */
function replaceOnce(text: string, from: string, to: string): string {
  assertEquals(
    text.split(from).length - 1,
    1,
    `fixture: "${from}" must occur exactly once`,
  );
  return text.replace(from, () => to);
}

/** Replace a phrase that may wrap across lines, as `flat()` reads it. */
function replacePhrase(page: string, phrase: string, to: string): string {
  // Flatten the page as flat() does, each whitespace run becoming one space,
  // and record where each flattened character sits in the page.
  let flattened = "";
  const origin: number[] = [];
  let i = 0;
  while (i < page.length) {
    if (/\s/.test(page.charAt(i))) {
      const runStart = i;
      while (i < page.length && /\s/.test(page.charAt(i))) i++;
      flattened += " ";
      origin.push(runStart);
    } else {
      flattened += page.charAt(i);
      origin.push(i);
      i++;
    }
  }
  const at = flattened.indexOf(phrase);
  let count = 0;
  for (
    let found = at;
    found !== -1;
    found = flattened.indexOf(phrase, found + phrase.length)
  ) {
    count++;
  }
  assertEquals(count, 1, `fixture: "${phrase}" must occur exactly once`);
  const start = origin[at] ?? 0;
  const end = (origin[at + phrase.length - 1] ?? 0) + 1;
  return page.slice(0, start) + to + page.slice(end);
}

/** Replace text inside one section only. */
function replaceInSection(
  page: string,
  title: string,
  from: string,
  to: string,
): string {
  const body = section(page, title);
  const at = page.indexOf(body);
  return page.slice(0, at) + body.replaceAll(from, to) +
    page.slice(at + body.length);
}

/** Insert a purge-list row directly under the table's separator. */
function withPurgeRow(page: string, row: string): string {
  return replaceOnce(page, PURGE_SEPARATOR, `${PURGE_SEPARATOR}\n${row}`);
}

/** The manifest text in a corpus; the live corpus always carries it. */
function manifestOf(files: Map<string, string>): string {
  const text = files.get(TOOLS_PATH);
  assert(text !== undefined, `fixture: ${TOOLS_PATH} must be in the corpus`);
  return text;
}

/** Edit a manifest's parsed JSON and write it back, two-space indented. */
function editManifest(text: string, edit: (manifest: Json) => void): string {
  const manifest = JSON.parse(text) as Json;
  edit(manifest);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** The entry of `list` (`toolchains` or `providers`) whose `id` is `id`. */
function entryWithId(manifest: Json, list: string, id: string): Json {
  const entries = manifest[list];
  const entry = Array.isArray(entries)
    ? (entries as Json[]).find((e) => e.id === id)
    : undefined;
  assert(
    entry !== undefined,
    `fixture: ${TOOLS_PATH} has no ${list} entry with id ${id}`,
  );
  return entry;
}

/** The manifest text with the plugin's pinned commit replaced. */
function withPluginCommit(text: string, commit: string): string {
  return editManifest(text, (manifest) => {
    entryWithId(manifest, "toolchains", PLUGIN_ID).commit = commit;
  });
}

/**
 * The manifest text with the plugin's entry carrying no commit at all: its
 * `commit` is malformed and its `notes` no longer name the commit, because a
 * 40-character token anywhere in the plugin's entry counts as a pin.
 */
function withoutPluginCommit(text: string): string {
  return editManifest(text, (manifest) => {
    const entry = entryWithId(manifest, "toolchains", PLUGIN_ID);
    entry.commit = "not-a-commit";
    entry.notes = "no commit is named here";
  });
}

function codeRow(path: string): string {
  return `| Config key | the block and its parser | \`${path}\` | present |`;
}

/**
 * The page with the purge row for a code file the fixture adds. The live page
 * already says the block has landed.
 */
function blockLanded(page: string, path: string): string {
  return withPurgeRow(page, codeRow(path));
}

/** The page as it read before #4955 landed: the Not-yet sentence back in place of the landed one. */
function blockNotYet(page: string): string {
  return replacePhrase(page, BLOCK_LANDED, BLOCK_NOT_YET);
}

/**
 * The corpus with the exact block text removed from every code file under
 * `worker/deno/lib` and `worker/deno/commands`, so no code file but a fixture
 * carries it. The plugin is still named there, just not as `token_economizer`.
 */
function withoutBlockText(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, text] of files) {
    const isCode = path.startsWith("worker/deno/lib/") ||
      path.startsWith("worker/deno/commands/");
    out.set(
      path,
      isCode ? text.replaceAll("token_economizer", "token-economizer") : text,
    );
  }
  return out;
}

/** The page with every purge-list row for `path` removed, so no row covers it. */
function withoutPurgeRow(page: string, path: string): string {
  return page.split("\n").filter((line) =>
    !(line.startsWith("| ") && line.includes(`\`${path}\``))
  ).join("\n");
}

Deno.test("the live trial page passes every drift rule against the live repository", async () => {
  const problems = driftProblems(await livePage(), await liveCorpus());
  assertEquals(
    problems,
    [],
    `the live trial page drifted from the repository:\n${problems.join("\n")}`,
  );
});

Deno.test("the live corpus reads every tracked repository file", async () => {
  const corpus = await liveCorpus();
  for (
    const path of [
      "README.md",
      TEST_PATH,
      "container/Containerfile",
      "docs/RTK-OUTPUT-TRIAL.md",
      "CODING-STANDARDS.md",
      "worker/deno/deno.json",
    ]
  ) {
    assert(corpus.has(path), `the live corpus must contain ${path}`);
  }
  for (const path of corpus.keys()) {
    assert(
      !WALK_SKIP_PATHS.some((dir) => path.startsWith(`${dir}/`)),
      `the live corpus must skip the excluded directories: ${path}`,
    );
    assert(
      !path.split("/").some((part) => WALK_SKIP_NAMES.includes(part)),
      `the live corpus must skip version-control and dependency trees: ${path}`,
    );
    assert(!path.includes("\\"), `corpus keys use forward slashes: ${path}`);
  }
});

/** A throwaway git repository holding one tracked and several ignored files. */
async function withIgnoredFixture(
  body: (root: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "te-corpus-" });
  try {
    const root = `${dir}/`;
    const write = async (path: string, text: string) => {
      const full = `${root}${path}`;
      await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
        recursive: true,
      });
      await Deno.writeTextFile(full, text);
    };
    await write(".gitignore", ".claude/worktrees/\n.config.json*\n");
    await write("README.md", "tracked: names TokenEconomizer\n");
    await write(".claude/worktrees/x/README.md", "ignored: TokenEconomizer\n");
    await write(".config.json", '{"token_economizer":{}}\n');
    await write(".config.json.grq-backup-1", '{"token_economizer":{}}\n');
    const git = await new Deno.Command("git", {
      args: ["init", "-q"],
      cwd: root,
      stdin: "null",
    }).output();
    assert(git.success, "git init must succeed in the fixture");
    const add = await new Deno.Command("git", {
      args: ["add", ".gitignore", "README.md"],
      cwd: root,
      stdin: "null",
    }).output();
    assert(add.success, "git add must succeed in the fixture");
    await body(root);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("the corpus leaves out gitignored nested copies and an ignored root config", async () => {
  await withIgnoredFixture(async (root) => {
    const corpus = await readCorpus(root);
    // Positive control: the tracked file naming the plugin is read.
    assert(corpus.has("README.md"), "a tracked file must be in the corpus");
    assertEquals(
      [...corpus.keys()].sort(),
      [".gitignore", "README.md"],
      "only tracked files are in the corpus; ignored copies and config are not",
    );
  });
});

Deno.test("the corpus refuses a directory that is not a git repository", async () => {
  const dir = await Deno.makeTempDir({ prefix: "te-corpus-nogit-" });
  try {
    let message = "";
    try {
      await readCorpus(`${dir}/`);
    } catch (error) {
      message = (error as Error).message;
    }
    assert(
      message.includes("git ls-files failed"),
      `a missing repository must fail loud, got: ${message}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("SHA drift: a pin that matches the page passes (positive control)", async () => {
  const live = await livePage();
  const sha = candidateSha(live);
  const corpus = await liveCorpus();
  assertEquals(driftProblems(live, corpus), []);
  assertEquals(
    driftProblems(
      live,
      withFile(corpus, TOOLS_PATH, withPluginCommit(manifestOf(corpus), sha)),
    ),
    [],
  );
});

Deno.test("SHA drift: a commit changed everywhere on the page is refused by the pin file", async () => {
  const live = await livePage();
  const sha = candidateSha(live);
  const problems = driftProblems(live.replaceAll(sha, A40), await liveCorpus());
  assert(
    problems.some((p) =>
      p.includes(TOOLS_PATH) && p.includes(sha) && p.includes(A40)
    ),
    `expected a problem naming ${TOOLS_PATH} and both commits; got:\n${
      problems.join("\n")
    }`,
  );
});

Deno.test("SHA drift: a commit changed in the candidate section only is refused by the page", async () => {
  const live = await livePage();
  const sha = candidateSha(live);
  const problems = driftProblems(
    replaceInSection(live, "The candidate", sha, A40),
    await liveCorpus(),
  );
  assert(
    problems.some((p) =>
      p.includes("disagree") && p.includes(sha) && p.includes(A40)
    ),
    `expected a page-internal disagreement; got:\n${problems.join("\n")}`,
  );
});

Deno.test("SHA drift: a pin that differs from the page's commit is refused", async () => {
  const live = await livePage();
  const sha = candidateSha(live);
  const corpus = await liveCorpus();
  assertEquals(
    driftProblems(
      live,
      withFile(corpus, TOOLS_PATH, withPluginCommit(manifestOf(corpus), sha)),
    ),
    [],
  );
  const problems = driftProblems(
    live,
    withFile(corpus, TOOLS_PATH, withPluginCommit(manifestOf(corpus), B40)),
  );
  assert(
    problems.some((p) =>
      p.includes(TOOLS_PATH) && p.includes(B40) && p.includes(sha)
    ),
    `expected the differing pin to be refused; got:\n${problems.join("\n")}`,
  );
});

Deno.test("SHA drift: no container file pins the commit, so the page's pin is refused", async () => {
  const live = await livePage();
  const corpus = await liveCorpus();
  assertEquals(driftProblems(live, corpus), []);
  const unpinned = new Map(corpus);
  unpinned.delete(TOOLS_PATH);
  const problems = driftProblems(live, unpinned);
  assert(
    problems.some((p) => p.includes("restore the pin")),
    `expected the missing pin to be refused by the restore rule; got:\n${
      problems.join("\n")
    }`,
  );
});

Deno.test("SHA drift: a pin file naming the plugin without a commit fails closed", async () => {
  const live = await livePage();
  const sha = candidateSha(live);
  const corpus = await liveCorpus();
  assertEquals(
    driftProblems(
      live,
      withFile(corpus, TOOLS_PATH, withPluginCommit(manifestOf(corpus), sha)),
    ),
    [],
  );
  const problems = driftProblems(
    live,
    withFile(corpus, TOOLS_PATH, withoutPluginCommit(manifestOf(corpus))),
  );
  assert(
    problems.some((p) =>
      p.includes(TOOLS_PATH) && p.includes("no 40-character commit")
    ),
    `expected the file to fail closed; got:\n${problems.join("\n")}`,
  );
});

Deno.test("SHA drift: a commit in a re-wrapped multi-line JSON pin is still read", async () => {
  const live = await livePage();
  const sha = candidateSha(live);
  const corpus = await liveCorpus();
  const rewrapped = (commit: string) =>
    replaceOnce(
      manifestOf(corpus),
      `"commit": "${sha}"`,
      `"commit":\n        "${commit}"`,
    );
  assertEquals(
    driftProblems(live, withFile(corpus, TOOLS_PATH, rewrapped(sha))),
    [],
  );
  const problems = driftProblems(
    live,
    withFile(corpus, TOOLS_PATH, rewrapped(A40)),
  );
  assert(
    problems.some((p) =>
      p.includes(TOOLS_PATH) && p.includes(A40) && p.includes(sha)
    ),
    `expected the re-wrapped pin to be read and refused; got:\n${
      problems.join("\n")
    }`,
  );
});

Deno.test("SHA drift: a commit under the plugin's own id, in any JSON file, is read", async () => {
  const live = await livePage();
  const sha = candidateSha(live);
  const corpus = await liveCorpus();
  const entry = (commit: string) =>
    `${JSON.stringify({ id: PLUGIN_ID, commit })}\n`;
  const page = withPurgeRow(
    live,
    `| Image layer | a fixture pin | \`${EXTRA_PATH}\` | present |`,
  );
  assertEquals(
    driftProblems(page, withFile(corpus, EXTRA_PATH, entry(sha))),
    [],
  );
  const problems = driftProblems(
    page,
    withFile(corpus, EXTRA_PATH, entry(A40)),
  );
  assert(
    problems.some((p) =>
      p.includes(EXTRA_PATH) && p.includes(A40) && p.includes(sha)
    ),
    `expected the id-keyed commit to be read and refused; got:\n${
      problems.join("\n")
    }`,
  );
});

Deno.test("SHA drift: a non-JSON container file is read line by line, and naming the plugin without a commit is no problem", async () => {
  const live = await livePage();
  const sha = candidateSha(live);
  const corpus = await liveCorpus();
  const page = withPurgeRow(
    live,
    `| Image layer | a fixture note | \`${NOTES_PATH}\` | present |`,
  );
  assertEquals(
    driftProblems(
      page,
      withFile(corpus, NOTES_PATH, "tokeneconomizer notes, no commit here\n"),
    ),
    [],
  );
  const problems = driftProblems(
    page,
    withFile(corpus, NOTES_PATH, `tokeneconomizer pin ${A40}\n`),
  );
  assert(
    problems.some((p) =>
      p.includes(NOTES_PATH) && p.includes(A40) && p.includes(sha)
    ),
    `expected the line's commit to be read and refused; got:\n${
      problems.join("\n")
    }`,
  );
});

/** The live Claude Code version the manifest pins, read from its parsed JSON. */
async function liveClaudeVersion(): Promise<string> {
  const pinned = claudeVersionPinned(await liveCorpus());
  assert(pinned.version !== undefined, `fixture: ${pinned.problem}`);
  return pinned.version;
}

/** The version with its last numeric component incremented: 2.1.310 gives 2.1.311. */
function bumpVersion(version: string): string {
  const parts = version.split(".");
  const last = parts.pop() ?? "";
  assert(/^\d+$/.test(last), `fixture: ${version} must end in a number`);
  return [...parts, String(Number(last) + 1)].join(".");
}

Deno.test("Claude Code version: a manifest bump the page does not follow is refused, and the page updated with it passes", async () => {
  const live = await livePage();
  const corpus = await liveCorpus();
  const pinnedVersion = await liveClaudeVersion();
  const bumpedVersion = bumpVersion(pinnedVersion);
  const bumped = withFile(
    corpus,
    TOOLS_PATH,
    editManifest(manifestOf(corpus), (manifest) => {
      entryWithId(manifest, "providers", CLAUDE_ID).version = bumpedVersion;
    }),
  );
  const problems = driftProblems(live, bumped);
  assert(
    problems.some((p) =>
      p.includes(pinnedVersion) &&
      p.includes(bumpedVersion) &&
      p.includes(TOOLS_PATH)
    ),
    `expected the bumped Claude Code version to be refused, naming both values; got:\n${
      problems.join("\n")
    }`,
  );
  // Positive control: the same manifest, with the page's version updated too.
  assertEquals(
    driftProblems(
      replaceOnce(
        live,
        `This image's Claude Code: **${pinnedVersion}**`,
        `This image's Claude Code: **${bumpedVersion}**`,
      ),
      bumped,
    ),
    [],
  );
  assertEquals(driftProblems(live, corpus), []);
});

Deno.test("Claude Code version: the page must state the image's version and quote upstream's Claude Code row", async () => {
  const live = await livePage();
  const corpus = await liveCorpus();
  assertEquals(driftProblems(live, corpus), []);
  const pinnedVersion = await liveClaudeVersion();
  const unquoted = driftProblems(
    replaceOnce(live, `${CLAUDE_ROW}\n`, ""),
    corpus,
  );
  assert(
    unquoted.some((p) => p.includes(CLAUDE_ROW)),
    `expected the missing Claude Code row to be refused; got:\n${
      unquoted.join("\n")
    }`,
  );
  const unstated = driftProblems(
    replaceOnce(
      live,
      `This image's Claude Code: **${pinnedVersion}**`,
      "This image's Claude Code is pending",
    ),
    corpus,
  );
  assert(
    unstated.some((p) =>
      p.includes("must state the image's Claude Code version")
    ),
    `expected the missing version statement to be refused; got:\n${
      unstated.join("\n")
    }`,
  );
});

Deno.test("config drift: the keys the page names match the keys the code names (positive control)", async () => {
  const live = await livePage();
  assertEquals(
    driftProblems(
      live,
      withFile(await liveCorpus(), CONFIG_PATH, CONFIG_TEXT),
    ),
    [],
  );
});

Deno.test("config drift: a key the page names but the code drops is refused", async () => {
  const live = await livePage();
  const unnamed = withoutBlockText(await liveCorpus());
  const dropped = replaceOnce(CONFIG_TEXT, "learnings_repo, ", "");
  const problems = driftProblems(
    live,
    withFile(unnamed, CONFIG_PATH, dropped),
  );
  assert(
    problems.some((p) => p.includes("token_economizer.learnings_repo")),
    `expected learnings_repo to be refused; got:\n${problems.join("\n")}`,
  );
  assertEquals(
    driftProblems(live, withFile(unnamed, CONFIG_PATH, CONFIG_TEXT)),
    [],
  );
});

Deno.test("config drift: a block the code names differently is refused", async () => {
  const live = await livePage();
  const corpus = await liveCorpus();
  const unnamed = withoutBlockText(corpus);
  const named = withFile(unnamed, NAMED_PATH, "// tokenEconomizer block\n");
  const problems = driftProblems(blockLanded(live, NAMED_PATH), named);
  assert(
    problems.some((p) => p.includes("names the block differently")),
    `expected the block to be refused as named differently; got:\n${
      problems.join("\n")
    }`,
  );
  assertEquals(
    driftProblems(
      blockLanded(live, NAMED_PATH),
      withFile(unnamed, NAMED_PATH, CONFIG_TEXT),
    ),
    [],
  );
});

Deno.test("config drift: code that names the block while the page says Not yet is refused", async () => {
  const live = await livePage();
  const corpus = await liveCorpus();
  const problems = driftProblems(
    blockNotYet(live),
    withFile(corpus, CONFIG_PATH, CONFIG_TEXT),
  );
  assert(
    problems.some((p) => p.includes(BLOCK_NOT_YET)),
    `expected the Not-yet sentence to be refused; got:\n${problems.join("\n")}`,
  );
  assertEquals(
    driftProblems(live, withFile(corpus, CONFIG_PATH, CONFIG_TEXT)),
    [],
  );
});

Deno.test("config drift: a key renamed on the page is refused", async () => {
  const live = await livePage();
  const corpus = await liveCorpus();
  const renamed = replaceOnce(
    live,
    "token_economizer.microskills",
    "token_economizer.skills",
  );
  const problems = driftProblems(
    renamed,
    withFile(corpus, CONFIG_PATH, CONFIG_TEXT),
  );
  assert(
    problems.some((p) => p.includes("token_economizer.skills")),
    `expected the renamed key to be refused; got:\n${problems.join("\n")}`,
  );
  assertEquals(
    driftProblems(live, withFile(corpus, CONFIG_PATH, CONFIG_TEXT)),
    [],
  );
});

Deno.test("purge drift: a file naming the plugin must be on the purge list, a file or directory row covers it", async () => {
  const live = await livePage();
  const sha = candidateSha(live);
  const corpus = withFile(
    await liveCorpus(),
    SH_PATH,
    `TOKEN_ECONOMIZER_COMMIT=${sha}\n`,
  );
  const problems = driftProblems(live, corpus);
  assert(
    problems.some((p) => p.includes(SH_PATH) && p.includes("purge list")),
    `expected the uncovered file to be refused; got:\n${problems.join("\n")}`,
  );
  assertEquals(
    driftProblems(
      withPurgeRow(
        live,
        `| Image layer | toolchain | \`${SH_PATH}\` | present |`,
      ),
      corpus,
    ),
    [],
  );
  assertEquals(
    driftProblems(
      withPurgeRow(
        live,
        "| Image layer | toolchains | `container/toolchains/` | present |",
      ),
      corpus,
    ),
    [],
  );
});

Deno.test("purge drift: a file outside the old corpus roots that names the plugin needs a purge row", async () => {
  const live = await livePage();
  const corpus = withFile(
    await liveCorpus(),
    TYPES_PATH,
    "// token_economizer: the plugin's types\n",
  );
  const bare = withoutPurgeRow(live, TYPES_PATH);
  const problems = driftProblems(bare, corpus);
  assert(
    problems.some((p) => p.includes(TYPES_PATH) && p.includes("purge list")),
    `expected the uncovered types file to be refused; got:\n${
      problems.join("\n")
    }`,
  );
  assertEquals(
    driftProblems(
      withPurgeRow(
        bare,
        `| Source | the plugin's types | \`${TYPES_PATH}\` | present |`,
      ),
      corpus,
    ),
    [],
  );
});

Deno.test("purge drift: a planned row whose file now names the plugin is refused", async () => {
  const live = await livePage();
  const corpus = await liveCorpus();
  const flipped = replaceOnce(
    live,
    "`README.md` | present |",
    "`README.md` | planned #1 |",
  );
  const problems = driftProblems(flipped, corpus);
  assert(
    problems.some((p) =>
      p.includes("README.md") && p.includes("mark it present")
    ),
    `expected the planned README row to be refused; got:\n${
      problems.join("\n")
    }`,
  );
  assertEquals(driftProblems(live, corpus), []);
});

Deno.test("purge drift: a present row whose file no longer names the plugin is refused", async () => {
  const live = await livePage();
  const corpus = await liveCorpus();
  const quiet = withFile(corpus, "README.md", "# VibeCoder\n");
  const problems = driftProblems(live, quiet);
  assert(
    problems.some((p) =>
      p.includes("README.md") && p.includes("does not name the plugin")
    ),
    `expected the present README row to be refused; got:\n${
      problems.join("\n")
    }`,
  );
  assertEquals(driftProblems(live, corpus), []);
});

Deno.test("purge drift: a state other than present or planned #N is refused", async () => {
  const live = await livePage();
  const corpus = await liveCorpus();
  const maybe = replaceOnce(
    live,
    "`README.md` | present |",
    "`README.md` | maybe |",
  );
  const problems = driftProblems(maybe, corpus);
  assert(
    problems.some((p) => p.includes('"maybe"')),
    `expected the state to be refused; got:\n${problems.join("\n")}`,
  );
  assertEquals(driftProblems(live, corpus), []);
});

Deno.test("purge drift: a purge list missing a kind is refused", async () => {
  const live = await livePage();
  const corpus = await liveCorpus();
  const lines = live.split("\n");
  const without = lines.filter((l) => !l.startsWith("| Learnings directory |"));
  assertEquals(
    lines.length - without.length,
    1,
    "fixture: exactly one Learnings directory row",
  );
  const problems = driftProblems(without.join("\n"), corpus);
  assert(
    problems.some((p) => p.includes("Learnings directory")),
    `expected the missing kind to be refused; got:\n${problems.join("\n")}`,
  );
  assertEquals(driftProblems(live, corpus), []);
});

Deno.test("structure pins: the live sections keep every phrase (positive control)", async () => {
  assertEquals(structureProblems(await livePage()), []);
});

Deno.test("structure pins: a phrase removed from its section is refused", async () => {
  const live = await livePage();
  const weakened = replacePhrase(live, "five well-ended turns", "five turns");
  const problems = structureProblems(weakened);
  assert(
    problems.some((p) =>
      p.includes('"five well-ended turns"') && p.includes("The window")
    ),
    `expected the window pin to be refused; got:\n${problems.join("\n")}`,
  );
  assertEquals(structureProblems(live), []);
});

Deno.test("structure pins: a phrase moved outside its section is refused", async () => {
  const live = await livePage();
  const moved = `${
    replacePhrase(live, "five well-ended turns", "five turns")
  }\nfive well-ended turns\n`;
  const problems = structureProblems(moved);
  assert(
    problems.some((p) =>
      p.includes('"five well-ended turns"') && p.includes("The window")
    ),
    `expected the moved phrase to be refused; got:\n${problems.join("\n")}`,
  );
  assertEquals(structureProblems(live), []);
});

Deno.test("structure pins: the Status cell must say not started", async () => {
  const live = await livePage();
  assertEquals(structureProblems(live), []);
  const kept = live.replace(STATUS_ROW, "| **Status** | kept |");
  assert(kept !== live, "fixture: the page has a Status row");
  const problems = structureProblems(kept);
  assert(
    problems.some((p) => p.includes('"not started"')),
    `expected a Status cell of "kept" to be refused; got:\n${
      problems.join("\n")
    }`,
  );
  const missing = live.replace(STATUS_ROW, "");
  assert(
    structureProblems(missing).some((p) => p.includes("**Status** row")),
    "expected a page with no Status row to be refused",
  );
});

Deno.test("the pages that name the trial link to it", async () => {
  const readme = await readRepoDoc("README.md");
  assert(
    flat(section(readme, "Documentation")).includes(`](${DOC})`),
    `README.md must link ${DOC} in its Documentation section`,
  );
  for (
    const source of ["docs/RTK-OUTPUT-TRIAL.md", "docs/REPO-CONTEXT-TRIAL.md"]
  ) {
    const page = await readRepoDoc(source);
    assert(
      flat(section(page, "Related documentation")).includes(
        "](TOKEN-ECONOMIZER-TRIAL.md)",
      ),
      `${source} must link TOKEN-ECONOMIZER-TRIAL.md in its Related documentation section`,
    );
  }
});
