/**
 * Triage of a conflicted `main` → `milestone/*` sync merge (Issue #1559).
 *
 * A conflicted sync used to have two moves, and both were wrong. Taking the
 * default branch's side wholesale is a decision nobody made — it replaced the
 * branch's version of every colliding file, test files included. Handing the
 * whole thing to a human asks a person to choose between two changes they did
 * not write, days after both were written.
 *
 * Most of what that person does is mechanical, so this module does it. Three
 * patterns have been seen, and they get three answers:
 *
 *   1. **The same fix landed twice** (#1270, #1264) — both sides cite the same
 *      issue. Keep the side whose tests are a superset and say what was
 *      dropped.
 *   2. **One side subsumes the other** — every line of the smaller side
 *      survives in the larger. Take the larger; nothing is lost.
 *   3. **Two designs for the same problem** (`IndirectSpawnRules` versus
 *      `scanContentForVariableBinarySpawn`) — neither contains the other, so a
 *      human chooses. The expensive preparation is still done here: each
 *      side's exports, each side's test names, and the difference between them.
 *
 * One rule outranks all three: **no resolution may reduce test coverage**. A
 * conflicted test file resolves only when one side is a genuine union of both
 * — every case *and* every line of the other side survives in it — otherwise
 * it escalates. Equal case names are not enough: an assertion changed inside a
 * case with the same name is exactly the silent loss this rule exists to stop.
 *
 * Nothing here touches git; the caller supplies both sides and applies the
 * plan. That keeps every decision a pure function of its inputs, and testable
 * as one.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

/** Which side of a conflicted file a resolution takes. */
export type ConflictSide = "ours" | "theirs";

/** How a conflicted file was classified. */
export type ConflictCase =
  /** Both sides fix the same issue — case 1. */
  | "duplicate-fix"
  /** One side keeps every line of the other — case 2. */
  | "superset"
  /** A test file where one side carries every case of the other. */
  | "test-union"
  /** The default branch deleted it; the deletion stands (Issue #1048). */
  | "incoming-delete"
  /** Neither side contains the other — case 3, a human chooses. */
  | "rival-designs";

/** One conflicted path, with both sides as git staged them. */
export interface ConflictedFile {
  /** Repository-relative path git reported as conflicted. */
  path: string;
  /** The milestone branch's content; null when this side deleted it. */
  ours: string | null;
  /** The default branch's content; null when that side deleted it. */
  theirs: string | null;
  /** Issues the milestone side's commits touching this path close. */
  oursFixes: number[];
  /** Issues the default side's commits touching this path close. */
  theirsFixes: number[];
}

/** What the triage decided about one conflicted path. */
export interface FileDecision {
  path: string;
  case: ConflictCase;
  /** The side to take; null when the file needs a human. */
  side: ConflictSide | null;
  /** One line, recorded on the merge commit or in the escalation. */
  reason: string;
}

/** What the triage decided about the whole merge. */
export interface ConflictPlan {
  /** Every path, in the order given. */
  decisions: FileDecision[];
  /** The paths that resolve without a human. */
  resolved: FileDecision[];
  /** The paths that need one — empty when the merge resolves entirely. */
  escalations: FileDecision[];
  /**
   * Which side's conflicted test cases are a superset of the other's. Null
   * when neither is, which is what stops a duplicate fix being resolved
   * towards the side with the thinner suite.
   */
  testsSuperset: ConflictSide | null;
}

/** Both sides of one escalated file, prepared for the reader. */
export interface FileAnalysis {
  path: string;
  /** Why the triage could not decide it. */
  reason: string;
  oursExports: string[];
  theirsExports: string[];
  oursTests: string[];
  theirsTests: string[];
  /** Cases present on the milestone side only. */
  onlyOursTests: string[];
  /** Cases present on the default side only. */
  onlyTheirsTests: string[];
}

/** Error name carried by a merge that only a human can resolve. */
export const MILESTONE_CONFLICT_ESCALATION_ERROR =
  "MilestoneConflictEscalation";

/**
 * A conflicted sync no automatic rule could resolve (Issue #1559).
 *
 * The merge is aborted before this is raised, so the branch is exactly as it
 * was. The analysis travels with the error rather than being reconstructed by
 * whoever reports it — that preparation is the point.
 */
export class MilestoneConflictEscalation extends Error {
  override readonly name = MILESTONE_CONFLICT_ESCALATION_ERROR;
  constructor(
    message: string,
    /** Both sides of every file that needs a human. */
    readonly analyses: FileAnalysis[],
    /** What the triage would have resolved on its own, for context. */
    readonly resolved: FileDecision[],
    /** The default branch's tip that conflicted, for escalation dedup. */
    readonly defaultSha: string,
  ) {
    super(message);
  }
}

/** Whether an error is the "only a human can resolve this" outcome. */
export function isConflictEscalation(
  err: unknown,
): err is MilestoneConflictEscalation {
  return err instanceof Error &&
    err.name === MILESTONE_CONFLICT_ESCALATION_ERROR;
}

// ---------------------------------------------------------------------------
// Parsing primitives
// ---------------------------------------------------------------------------

/** A test file by directory, or by the suffix conventions in use here. */
const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//;
const TEST_SUFFIX = /[._](test|spec)\.[a-z]+$/i;

/** Whether a repository-relative path is a test file. */
export function isTestPath(path: string): boolean {
  return TEST_DIR.test(path) || TEST_SUFFIX.test(path);
}

/**
 * Issue numbers a commit message says it closes.
 *
 * GitHub's closing keywords, plus this fleet's own `(Issue #N)` stamp — the
 * worker writes that on every commit it authors, so a duplicate fix landing
 * twice is invisible without it. A bare `Refs #N` is deliberately not a claim
 * to have fixed anything and is not read as one.
 */
export function parseFixReferences(text: string): number[] {
  const found = new Set<number>();
  const pattern =
    /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|issue)\s*:?\s+#(\d+)\b/gi;
  for (const match of text.matchAll(pattern)) {
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > 0) found.add(n);
  }
  return [...found];
}

/** Names of the test cases a source file declares, in source order. */
export function extractTestNames(source: string): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const pattern =
    /(?:Deno\.test|\bit|\btest|\bdescribe)\s*\(\s*(?:\{\s*name\s*:\s*)?(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[2] ?? "";
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/** Names a source file exports, sorted so two sides compare deterministically. */
export function extractExports(source: string): string[] {
  const names = new Set<string>();
  const declaration =
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(declaration)) {
    if (match[1]) names.add(match[1]);
  }
  const list = /^\s*export\s*\{([^}]*)\}/gm;
  for (const match of source.matchAll(list)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) names.add(name);
    }
  }
  return [...names].sort();
}

/** Non-empty trimmed lines, counted — duplicates are not collapsed. */
function lineCounts(source: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  return counts;
}

/**
 * Whether every line of `subset` survives in `superset`.
 *
 * Lines are counted rather than collapsed: a side that carries one copy of a
 * line does not subsume a side that carries two.
 */
export function isLineSuperset(superset: string, subset: string): boolean {
  const have = lineCounts(superset);
  for (const [line, needed] of lineCounts(subset)) {
    if ((have.get(line) ?? 0) < needed) return false;
  }
  return true;
}

/** Members of `a` that are not in `b`. */
function only(a: string[], b: string[]): string[] {
  const other = new Set(b);
  return a.filter((item) => !other.has(item));
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Never resolved automatically — the reason travels with the escalation. */
function escalate(path: string, reason: string): FileDecision {
  return { path, case: "rival-designs", side: null, reason };
}

/**
 * Decide one conflicted test file.
 *
 * Resolvable only when one side is a genuine union of both: every case name
 * *and* every line of the other side survives in it. Anything else escalates,
 * because taking a side would drop coverage — the loss this rule exists to
 * stop, and the one that is silent when the case names happen to match.
 */
function classifyTestFile(
  path: string,
  ours: string,
  theirs: string,
): FileDecision {
  const oursTests = extractTestNames(ours);
  const theirsTests = extractTestNames(theirs);
  const onlyOurs = only(oursTests, theirsTests);
  const onlyTheirs = only(theirsTests, oursTests);

  if (onlyTheirs.length === 0 && isLineSuperset(ours, theirs)) {
    return {
      path,
      case: "test-union",
      side: "ours",
      reason:
        `the milestone side is a union of both — it keeps every case and ` +
        `every line of the default branch's version${
          onlyOurs.length ? `, and adds ${onlyOurs.length} case(s)` : ""
        }`,
    };
  }
  if (onlyOurs.length === 0 && isLineSuperset(theirs, ours)) {
    return {
      path,
      case: "test-union",
      side: "theirs",
      reason:
        `the default branch's side is a union of both — it keeps every case ` +
        `and every line of the milestone branch's version${
          onlyTheirs.length ? `, and adds ${onlyTheirs.length} case(s)` : ""
        }`,
    };
  }
  return escalate(
    path,
    `neither side of this test file contains the other, so taking one would ` +
      `drop coverage${
        onlyOurs.length
          ? ` — only on the milestone side: ${onlyOurs.join(", ")}`
          : ""
      }${
        onlyTheirs.length
          ? ` — only on the default branch: ${onlyTheirs.join(", ")}`
          : ""
      }${
        !onlyOurs.length && !onlyTheirs.length
          ? " — the same cases differ line by line, so a case changed on one " +
            "side would be lost without changing any case name"
          : ""
      }`,
  );
}

/** Decide one conflicted path that is not a test file. */
function classifySourceFile(
  file: ConflictedFile,
  ours: string,
  theirs: string,
  testsSuperset: ConflictSide | null,
): FileDecision {
  const shared = file.oursFixes.filter((n) => file.theirsFixes.includes(n));
  if (shared.length > 0) {
    if (testsSuperset === null) {
      return escalate(
        file.path,
        `both sides fix ${
          shared.map((n) => `#${n}`).join(", ")
        }, but neither side's tests are a superset of the other's, so there ` +
          `is no implementation to keep without dropping cases`,
      );
    }
    return {
      path: file.path,
      case: "duplicate-fix",
      side: testsSuperset,
      reason: `both sides fix ${
        shared.map((n) => `#${n}`).join(", ")
      } — the same fix landed twice, and the ${
        testsSuperset === "ours" ? "milestone" : "default"
      } branch's implementation is kept because its tests are a superset of ` +
        `the other side's`,
    };
  }

  if (isLineSuperset(theirs, ours)) {
    return {
      path: file.path,
      case: "superset",
      side: "theirs",
      reason:
        `the default branch's side keeps every line of the milestone side, ` +
        `so nothing is dropped by taking it`,
    };
  }
  if (isLineSuperset(ours, theirs)) {
    return {
      path: file.path,
      case: "superset",
      side: "ours",
      reason:
        `the milestone side keeps every line of the default branch's side, ` +
        `so nothing is dropped by taking it`,
    };
  }
  return escalate(
    file.path,
    `both sides changed the same code and neither contains the other — two ` +
      `designs for the same problem, which only a human can choose between`,
  );
}

/**
 * Decide one conflicted path.
 *
 * @param file - Both sides, as git staged them
 * @param testsSuperset - Which side's conflicted test cases subsume the
 *   other's, as {@link planConflictResolution} computed it across the merge
 */
export function classifyConflictedFile(
  file: ConflictedFile,
  testsSuperset: ConflictSide | null,
): FileDecision {
  const test = isTestPath(file.path);

  if (file.ours === null && file.theirs === null) {
    // Both sides deleted it, yet git called it conflicted — the state is not
    // one this triage understands, so it is not one it resolves.
    return escalate(
      file.path,
      "neither side has a version of this file, so git's conflict cannot be " +
        "read as a choice between two sides",
    );
  }
  if (file.theirs === null) {
    if (test) {
      return escalate(
        file.path,
        "the default branch deleted this test file while the milestone " +
          "branch edited it — deleting it here would drop its cases, and " +
          "keeping it would revive a file the default branch removed",
      );
    }
    return {
      path: file.path,
      case: "incoming-delete",
      side: "theirs",
      reason:
        "the default branch deleted this file, so the deletion stands rather " +
        "than reviving removed code (Issue #1048)",
    };
  }
  if (file.ours === null) {
    return escalate(
      file.path,
      "the milestone branch deleted this file and the default branch edited " +
        "it — keeping it revives what the branch removed, deleting it drops " +
        "the default branch's change",
    );
  }

  return test
    ? classifyTestFile(file.path, file.ours, file.theirs)
    : classifySourceFile(file, file.ours, file.theirs, testsSuperset);
}

/**
 * The cases each side added since the merge base, across the test files it
 * changed.
 *
 * A duplicate fix is usually not decided by the conflicted files alone: the
 * branch fixed #1270 and wrote a case for it in a test file the default
 * branch never touched, so nothing about that case conflicts and it is
 * invisible to a file-by-file view. This is the evidence that makes "keep the
 * side whose tests are a superset" answerable.
 */
export interface TestEvidence {
  /** Cases the milestone branch added since the merge base. */
  oursAdded: string[];
  /** Cases the default branch added since the merge base. */
  theirsAdded: string[];
}

/**
 * Which side's test cases subsume the other's.
 *
 * Aggregated across every conflicted test file and every case each side added
 * since the merge base, because a duplicate fix is decided by the suite as a
 * whole rather than file by file. A merge where neither side's cases moved has
 * no coverage at stake, so the default branch's side is named and the
 * green-tree gate is what checks the choice.
 */
function decideTestsSuperset(
  files: ConflictedFile[],
  evidence: TestEvidence,
): ConflictSide | null {
  const oursTests: string[] = [...evidence.oursAdded];
  const theirsTests: string[] = [...evidence.theirsAdded];
  for (const file of files) {
    if (!isTestPath(file.path)) continue;
    oursTests.push(...extractTestNames(file.ours ?? ""));
    theirsTests.push(...extractTestNames(file.theirs ?? ""));
  }
  if (oursTests.length === 0 && theirsTests.length === 0) return "theirs";
  const onlyOurs = only(oursTests, theirsTests);
  const onlyTheirs = only(theirsTests, oursTests);
  if (onlyTheirs.length === 0 && onlyOurs.length > 0) return "ours";
  if (onlyOurs.length === 0) return "theirs";
  return null;
}

/**
 * Plan the resolution of a conflicted sync merge.
 *
 * @param files - Every conflicted path, with both sides
 * @param evidence - The cases each side added since the merge base
 * @returns What resolves, what does not, and why in both cases
 */
export function planConflictResolution(
  files: ConflictedFile[],
  evidence: TestEvidence = { oursAdded: [], theirsAdded: [] },
): ConflictPlan {
  const testsSuperset = decideTestsSuperset(files, evidence);
  const decisions = files.map((file) =>
    classifyConflictedFile(file, testsSuperset)
  );
  return {
    decisions,
    resolved: decisions.filter((d) => d.side !== null),
    escalations: decisions.filter((d) => d.side === null),
    testsSuperset,
  };
}

// ---------------------------------------------------------------------------
// What the reader is handed
// ---------------------------------------------------------------------------

/** Prepare both sides of a file a human has to decide. */
export function analyseConflictedFile(
  file: ConflictedFile,
  reason: string,
): FileAnalysis {
  const oursTests = extractTestNames(file.ours ?? "");
  const theirsTests = extractTestNames(file.theirs ?? "");
  return {
    path: file.path,
    reason,
    oursExports: extractExports(file.ours ?? ""),
    theirsExports: extractExports(file.theirs ?? ""),
    oursTests,
    theirsTests,
    onlyOursTests: only(oursTests, theirsTests),
    onlyTheirsTests: only(theirsTests, oursTests),
  };
}

/** Render a list for a comment, or say plainly that it is empty. */
function bullets(items: string[], empty: string): string {
  return items.length
    ? items.map((i) => `  - \`${i}\``).join("\n")
    : `  - ${empty}`;
}

/**
 * The merge commit's message for a conflict the worker resolved itself.
 *
 * Every decision is named with its reasoning, because the commit is where
 * whoever reads this branch months later will look — not the run log, which
 * is gone by then.
 */
export function buildResolutionCommitMessage(o: {
  defaultBranch: string;
  milestoneBranch: string;
  plan: ConflictPlan;
}): string {
  const lines = o.plan.resolved.map((d) =>
    `- \`${d.path}\` — ${d.case}, took the ${
      d.side === "ours" ? "milestone branch's" : `'${o.defaultBranch}'`
    } side: ${d.reason}`
  );
  return `Merge '${o.defaultBranch}' into '${o.milestoneBranch}' — ${o.plan.resolved.length} conflict(s) resolved automatically\n\n` +
    `${lines.join("\n")}\n\n` +
    `Each resolution was verified before it was pushed: the merged tree ` +
    `passes the repository's own check, its manifest check and its unit ` +
    `suite. No conflicted test file was resolved by taking a side that ` +
    `drops cases (Issue #1559).`;
}

/**
 * The escalation for a conflict only a human can resolve.
 *
 * It carries the preparation rather than the compiler output: what each side
 * exports, what each side tests, and which cases exist on one side only. That
 * is most of the hour the reader would otherwise spend before they can decide
 * anything.
 */
export function buildConflictAnalysisComment(e: {
  repo: string;
  milestoneBranch: string;
  defaultBranch: string;
  analyses: FileAnalysis[];
  resolved: FileDecision[];
}): string {
  const sections = e.analyses.map((a) =>
    `### \`${a.path}\`\n\n` +
    `${a.reason}.\n\n` +
    `- Exports on \`${e.milestoneBranch}\`:\n${
      bullets(a.oursExports, "none found")
    }\n` +
    `- Exports on \`${e.defaultBranch}\`:\n${
      bullets(a.theirsExports, "none found")
    }\n` +
    `- Test cases on \`${e.milestoneBranch}\`:\n${
      bullets(a.oursTests, "none found")
    }\n` +
    `- Test cases on \`${e.defaultBranch}\`:\n${
      bullets(a.theirsTests, "none found")
    }\n` +
    `- Cases only on \`${e.milestoneBranch}\`:\n${
      bullets(a.onlyOursTests, "none")
    }\n` +
    `- Cases only on \`${e.defaultBranch}\`:\n${
      bullets(a.onlyTheirsTests, "none")
    }`
  ).join("\n\n");

  const resolvedNote = e.resolved.length
    ? `\n\nThe same merge resolved ${e.resolved.length} other file(s) on its ` +
      `own — those decisions were discarded with the merge and will be ` +
      `retaken once the files above are settled:\n\n${
        e.resolved.map((d) => `- \`${d.path}\` — ${d.case}: ${d.reason}`)
          .join("\n")
      }`
    : "";

  return `## Milestone sync conflict needs a human — both sides prepared\n\n` +
    `Merging \`${e.defaultBranch}\` into \`${e.milestoneBranch}\` in ` +
    `\`${e.repo}\` conflicted in a way no automatic rule can resolve ` +
    `(Issue #1559). The merge was **aborted**: \`${e.milestoneBranch}\` is ` +
    `exactly as it was, and nothing has been pushed.\n\n` +
    `${sections}${resolvedNote}\n\n` +
    `Resolve it on \`${e.milestoneBranch}\` with a real merge. The sync will ` +
    `keep attempting resolution each cycle and will land on its own once ` +
    `these files stop being two designs for the same problem.`;
}
