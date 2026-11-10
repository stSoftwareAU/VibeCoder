/**
 * Triage of a conflicted `main` → `milestone/*` sync merge (Issue #1559).
 *
 * A conflicted sync used to have two moves, and both were wrong. Taking the
 * default branch's side wholesale is a decision nobody made — it replaced the
 * branch's version of every colliding file, test files included. Handing the
 * whole thing to a human asks a person to choose between two changes they did
 * not write, days after both were written.
 *
 * Most of what that person does is mechanical, so this module does it. Four
 * patterns have been seen, and they get four answers:
 *
 *   1. **The same fix landed twice** (#1270, #1264) — both sides cite the same
 *      issue. Keep the side whose tests are a superset and say what was
 *      dropped.
 *   2. **One side subsumes the other** — every line of the smaller side
 *      survives in the larger. Take the larger; nothing is lost.
 *   3. **Both sides only appended** (`CHANGELOG.md`, release notes, the audit
 *      ledgers) — every line of the merge base survives on both sides, so
 *      nothing was deleted and both additions are kept, the default branch's
 *      first (Issue #1768).
 *   4. **Two designs for the same problem** (`IndirectSpawnRules` versus
 *      `scanContentForVariableBinarySpawn`) — neither contains the other and
 *      one of them changed what the base had, so a human chooses. Rival
 *      designs that are *both* purely additive are case 3's union instead. The expensive preparation is still done here: each
 *      side's exports, each side's test names, and the difference between them.
 *
 * One rule outranks all four: **no resolution may reduce test coverage**. A
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
 */ /** Which side of a conflicted file a resolution takes. */ /** Error name carried by a merge that only a human can resolve. */ export const MILESTONE_CONFLICT_ESCALATION_ERROR = "MilestoneConflictEscalation";
/**
 * A conflicted sync no automatic rule could resolve (Issue #1559).
 *
 * The merge is aborted before this is raised, so the branch is exactly as it
 * was. The analysis travels with the error rather than being reconstructed by
 * whoever reports it — that preparation is the point.
 */ export class MilestoneConflictEscalation extends Error {
  analyses;
  resolved;
  defaultSha;
  gateFailure;
  milestoneSha;
  timings;
  name;
  constructor(message, /** Both sides of every file that needs a human. */ analyses, /** What the triage would have resolved on its own, for context. */ resolved, /** The default branch's tip that conflicted, for escalation dedup. */ defaultSha, /**
     * Set when the resolution itself was made and the verification then
     * refused it (Issue #1559). The reader needs both halves: what the gate
     * said, and the two sides that produced it — a wall of `TS2304` on its
     * own decides nothing.
     */ gateFailure, /**
     * The milestone branch's tip at the time of the merge (Issue #1786).
     * With the conflicted paths it identifies the conflict itself, so an
     * escalation is deduped on what actually collided rather than on the
     * default branch's tip — which moves every few minutes on a busy
     * repository and made the same analysis a comment per cycle.
     */ milestoneSha, /**
     * The attempt's stage timings and host, as `formatStageTimings` rendered
     * them (Issues #2308, #2311). A failed run costs the same twenty minutes
     * a successful one does, and the `merge-fallback` flag is where that
     * cost is read back — so the refusal carries it rather than leaving it
     * in a log nobody keeps.
     */ timings){
    super(message), this.analyses = analyses, this.resolved = resolved, this.defaultSha = defaultSha, this.gateFailure = gateFailure, this.milestoneSha = milestoneSha, this.timings = timings, this.name = MILESTONE_CONFLICT_ESCALATION_ERROR;
  }
}
/** Whether an error is the "only a human can resolve this" outcome. */ export function isConflictEscalation(err) {
  return err instanceof Error && err.name === MILESTONE_CONFLICT_ESCALATION_ERROR;
}
// ---------------------------------------------------------------------------
// Parsing primitives
// ---------------------------------------------------------------------------
/** A test file by directory, or by the suffix conventions in use here. */ const TEST_DIR = /(^|\/)(tests?|__tests__|spec)\//;
const TEST_SUFFIX = /[._](test|spec)\.[a-z]+$/i;
/** Whether a repository-relative path is a test file. */ export function isTestPath(path) {
  return TEST_DIR.test(path) || TEST_SUFFIX.test(path);
}
/**
 * Issue numbers a commit message says it **closes**.
 *
 * GitHub's closing keywords only. A bare `Refs #N`, or prose that merely
 * mentions an issue number, is deliberately not a claim to have fixed
 * anything and is not read as one — reading it that way would let two
 * unrelated commits that both discuss #1216 be classified as the same fix
 * landing twice, and one side's implementation would then be dropped.
 */ export function parseFixReferences(text) {
  const found = new Set();
  const pattern = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/gi;
  for (const match of text.matchAll(pattern)){
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > 0) found.add(n);
  }
  return [
    ...found
  ];
}
/**
 * Issue numbers this fleet's own `(Issue #N)` stamp claims, from a commit
 * **subject line**.
 *
 * The worker writes that stamp on the subject of every commit it authors, so
 * a duplicate fix landing twice is invisible without it. Only the subject
 * counts: commit *bodies* here routinely discuss other issues in passing
 * ("Issue #1562 records three defects"), and a mention is not a claim.
 */ export function parseStampedIssues(subject) {
  const found = new Set();
  // The first line only — a subject is one line, whatever the caller passed.
  const line = subject.split("\n")[0] ?? "";
  for (const match of line.matchAll(/\(\s*issue\s+#(\d+)\s*\)/gi)){
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > 0) found.add(n);
  }
  return [
    ...found
  ];
}
/** Names of the test cases a source file declares, in source order. */ export function extractTestNames(source) {
  const names = [];
  const seen = new Set();
  const pattern = /(?:Deno\.test|\bit|\btest|\bdescribe)\s*\(\s*(?:\{\s*name\s*:\s*)?(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const match of source.matchAll(pattern)){
    const name = match[2] ?? "";
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}
/** Names a source file exports, sorted so two sides compare deterministically. */ export function extractExports(source) {
  const names = new Set();
  const declaration = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\s*\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of source.matchAll(declaration)){
    if (match[1]) names.add(match[1]);
  }
  const list = /^\s*export\s*\{([^}]*)\}/gm;
  for (const match of source.matchAll(list)){
    for (const part of (match[1] ?? "").split(",")){
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name) names.add(name);
    }
  }
  return [
    ...names
  ].sort();
}
/** Non-empty trimmed lines, counted — duplicates are not collapsed. */ function lineCounts(source) {
  const counts = new Map();
  for (const raw of source.split("\n")){
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
 */ export function isLineSuperset(superset, subset) {
  const have = lineCounts(superset);
  for (const [line, needed] of lineCounts(subset)){
    if ((have.get(line) ?? 0) < needed) return false;
  }
  return true;
}
/** Members of `a` that are not in `b`. */ function only(a, b) {
  const other = new Set(b);
  return a.filter((item)=>!other.has(item));
}
// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------
/** Never resolved automatically — the reason travels with the escalation. */ function escalate(path, reason, kind = "needs-human") {
  return {
    path,
    case: kind,
    action: "escalate",
    reason
  };
}
/**
 * Decide one conflicted test file.
 *
 * Resolvable only when one side is a genuine union of both: every case name
 * *and* every line of the other side survives in it. Anything else escalates,
 * because taking a side would drop coverage — the loss this rule exists to
 * stop, and the one that is silent when the case names happen to match.
 */ function classifyTestFile(path, ours, theirs) {
  const oursTests = extractTestNames(ours);
  const theirsTests = extractTestNames(theirs);
  const onlyOurs = only(oursTests, theirsTests);
  const onlyTheirs = only(theirsTests, oursTests);
  if (onlyTheirs.length === 0 && isLineSuperset(ours, theirs)) {
    return {
      path,
      case: "test-union",
      action: "ours",
      reason: `the milestone side is already a union of both — it keeps every case ` + `and every line of the default branch's version${onlyOurs.length ? `, and adds ${onlyOurs.length} case(s)` : ""}`
    };
  }
  if (onlyOurs.length === 0 && isLineSuperset(theirs, ours)) {
    return {
      path,
      case: "test-union",
      action: "theirs",
      reason: `the default branch's side is already a union of both — it keeps ` + `every case and every line of the milestone branch's version${onlyTheirs.length ? `, and adds ${onlyTheirs.length} case(s)` : ""}`
    };
  }
  // Neither side contains the other, so taking a side would drop cases. The
  // file is merged as a **union** instead — both sides' hunks kept — and the
  // caller checks that every case on both sides survived it. A union that
  // does not survive that check escalates; it never lands short.
  return {
    path,
    case: "test-union",
    action: "union",
    reason: `neither side of this test file contains the other, so both ` + `sides' hunks are kept by a union merge rather than a side being ` + `taken${onlyOurs.length ? ` — only on the milestone side: ${onlyOurs.join(", ")}` : ""}${onlyTheirs.length ? ` — only on the default branch: ${onlyTheirs.join(", ")}` : ""}`
  };
}
/** Decide one conflicted path that is not a test file. */ function classifySourceFile(file, ours, theirs, evidence) {
  // Containment first: a side that keeps every line of the other drops
  // nothing, so it is the safest answer available and does not depend on
  // reading either side's tests.
  if (isLineSuperset(theirs, ours)) {
    return {
      path: file.path,
      case: "superset",
      action: "theirs",
      reason: `the default branch's side keeps every line of the milestone side, ` + `so nothing is dropped by taking it`
    };
  }
  if (isLineSuperset(ours, theirs)) {
    return {
      path: file.path,
      case: "superset",
      action: "ours",
      reason: `the milestone side keeps every line of the default branch's side, ` + `so nothing is dropped by taking it`
    };
  }
  const shared = file.oursFixes.filter((n)=>file.theirsFixes.includes(n));
  if (shared.length > 0) {
    const decided = decideDuplicateFix(shared, evidence);
    if (decided.side === null) {
      return escalate(file.path, `both sides fix ${shared.map((n)=>`#${n}`).join(", ")}, but ${decided.why}, so there is no implementation to keep without ` + `risking the cases the other side wrote for the same fix`);
    }
    const kept = decided.side === "ours" ? "milestone" : "default";
    const dropped = decided.side === "ours" ? "default" : "milestone";
    return {
      path: file.path,
      case: "duplicate-fix",
      action: decided.side,
      reason: `both sides fix ${shared.map((n)=>`#${n}`).join(", ")} — the same fix landed twice. The ${kept} branch's implementation is ` + `kept because ${decided.why}; the ${dropped} branch's implementation ` + `of the same fix was dropped${decided.droppedCases.length ? `, and its case(s) ${decided.droppedCases.join(", ")} are covered by the kept side` : ""}`
    };
  }
  // Append-only ledgers — `CHANGELOG.md`, release notes, the audit ledgers —
  // conflict on every merge and are never a judgement: both sides appended and
  // neither removed anything, so both entries are kept (Issue #1768). Decided
  // last of the resolvable rules, so a duplicate fix is still a duplicate fix
  // rather than an implementation kept twice.
  if (isBothInserted(file.base, ours, theirs)) {
    return {
      path: file.path,
      case: "both-inserted",
      action: "union",
      reason: `both sides only added to this file — every line of the merge base ` + `survives on both sides — so both additions are kept by a union ` + `merge, the default branch's first`
    };
  }
  return escalate(file.path, `both sides changed the same code and neither contains the other — two ` + `designs for the same problem, which only a human can choose between`, "rival-designs");
}
/**
 * Whether both sides only inserted: every line of the merge base survives on
 * each side.
 *
 * A base that was not read (`undefined`) or does not exist (`null`, an add/add
 * conflict) decides nothing — the rule needs the base to prove a deletion did
 * not happen, and an unread base must never read as an empty one.
 */ export function isBothInserted(base, ours, theirs) {
  if (typeof base !== "string") return false;
  return isLineSuperset(ours, base) && isLineSuperset(theirs, base);
}
/**
 * Which side of a duplicate fix to keep, scoped to the issues both sides cite.
 *
 * Only the cases each side wrote **for those issues** count. Pooling every
 * case either branch added would compare two populations dominated by
 * unrelated churn, and the answer would be "incomparable" on every real
 * repository. Evidence that could not be read, and evidence that does not
 * exist at all, both decide nothing: a side is kept because its cases cover
 * the other's, never because nothing was found.
 */ function decideDuplicateFix(shared, evidence) {
  if (!evidence.complete) {
    return {
      side: null,
      why: "the cases each side wrote for it could not be read",
      droppedCases: []
    };
  }
  const casesFor = (added)=>{
    const names = [];
    for (const issue of shared)names.push(...added[issue] ?? []);
    return names;
  };
  const oursCases = casesFor(evidence.oursAdded);
  const theirsCases = casesFor(evidence.theirsAdded);
  if (oursCases.length === 0 && theirsCases.length === 0) {
    return {
      side: null,
      why: "neither side wrote a test case for it, so there is no evidence " + "that either implementation is the one to keep",
      droppedCases: []
    };
  }
  const onlyOurs = only(oursCases, theirsCases);
  const onlyTheirs = only(theirsCases, oursCases);
  if (onlyTheirs.length === 0) {
    return {
      side: "ours",
      why: "its cases for that fix are a superset of the default branch's",
      droppedCases: theirsCases
    };
  }
  if (onlyOurs.length === 0) {
    return {
      side: "theirs",
      why: "its cases for that fix are a superset of the milestone branch's",
      droppedCases: oursCases
    };
  }
  return {
    side: null,
    why: `each side wrote cases the other did not (${onlyOurs.join(", ")} against ${onlyTheirs.join(", ")})`,
    droppedCases: []
  };
}
/**
 * Decide one conflicted path.
 *
 * @param file - Both sides, as git staged them
 * @param evidence - The cases each side wrote for the issues it cites
 */ export function classifyConflictedFile(file, evidence = EMPTY_EVIDENCE) {
  const test = isTestPath(file.path);
  if (file.ours === null && file.theirs === null) {
    // Both sides deleted it, yet git called it conflicted — the state is not
    // one this triage understands, so it is not one it resolves.
    return escalate(file.path, "neither side has a version of this file, so git's conflict cannot be " + "read as a choice between two sides");
  }
  if (file.theirs === null) {
    if (test) {
      return escalate(file.path, "the default branch deleted this test file while the milestone " + "branch edited it — deleting it here would drop its cases, and " + "keeping it would revive a file the default branch removed");
    }
    return {
      path: file.path,
      case: "incoming-delete",
      action: "theirs",
      reason: "the default branch deleted this file, so the deletion stands rather " + "than reviving removed code (Issue #1048)"
    };
  }
  if (file.ours === null) {
    return escalate(file.path, "the milestone branch deleted this file and the default branch edited " + "it — keeping it revives what the branch removed, deleting it drops " + "the default branch's change");
  }
  return test ? classifyTestFile(file.path, file.ours, file.theirs) : classifySourceFile(file, file.ours, file.theirs, evidence);
}
/** No evidence, honestly labelled as read (the caller supplied none). */ const EMPTY_EVIDENCE = {
  oursAdded: {},
  theirsAdded: {},
  complete: true
};
/**
 * Plan the resolution of a conflicted sync merge.
 *
 * @param files - Every conflicted path, with both sides
 * @param evidence - The cases each side wrote for the issues it cites
 * @returns What resolves, what does not, and why in both cases
 */ export function planConflictResolution(files, evidence = EMPTY_EVIDENCE) {
  const decisions = files.map((file)=>classifyConflictedFile(file, evidence));
  return {
    decisions,
    resolved: decisions.filter((d)=>d.action !== "escalate"),
    escalations: decisions.filter((d)=>d.action === "escalate")
  };
}
// ---------------------------------------------------------------------------
// What the reader is handed
// ---------------------------------------------------------------------------
/** Prepare both sides of a file a human has to decide. */ export function analyseConflictedFile(file, reason) {
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
    onlyTheirsTests: only(theirsTests, oursTests)
  };
}
/** Render a list for a comment, or say plainly that it is empty. */ function bullets(items, empty) {
  return items.length ? items.map((i)=>`  - \`${i}\``).join("\n") : `  - ${empty}`;
}
/**
 * Name the rung that settled a decision, for every surface that reports it.
 *
 * One wording, three readers (Issue #1777): the merge commit, the sync's log
 * line and the report comment all say `triage: <case>`, `rule: <reason>` or
 * `agent`, so a file's resolution reads the same wherever it is found.
 *
 * @param d - The decision to describe
 * @param sides - How to name each side, as that surface writes branch names
 * @returns One line, without a leading bullet
 */ export function describeDecisionRung(d, sides) {
  if (d.rung === "rule") return `rule: ${d.reason}`;
  if (d.rung === "ported") return `ported: ${d.reason}`;
  if (d.rung === "agent") return "agent";
  const how = d.action === "union" ? "kept both sides' hunks" : d.action === "resolved" ? "the resolution was already in the tree" : `took the ${d.action === "ours" ? sides.ours : sides.theirs} side`;
  return `triage: ${d.case}, ${how}: ${d.reason}`;
}
/**
 * The labels of the notes a milestone sync's push carries when a check did not
 * run (`gateThenPushMilestoneBranch` in git_pull.ts). The resolution commit
 * message names every one, so adding a label here adds it there (Issue #4441).
 */ export const SYNC_UNCHECKED_NOTE = {
  ungated: "UNGATED",
  checkLeftToCi: "CHECK LEFT TO CI",
  suiteLeftToCi: "TESTS LEFT TO CI",
  cargoSkipped: "CARGO SKIPPED"
};
/**
 * The merge commit's message for a conflict the worker resolved itself.
 *
 * Every decision is named with its reasoning, because the commit is where
 * whoever reads this branch months later will look — not the run log, which
 * is gone by then.
 */ export function buildResolutionCommitMessage(o) {
  const lines = o.plan.resolved.map((d)=>`- \`${d.path}\` — ${describeDecisionRung(d, {
      ours: "milestone branch's",
      theirs: `'${o.defaultBranch}'`
    })}`);
  const n = SYNC_UNCHECKED_NOTE;
  return `Merge '${o.defaultBranch}' into '${o.milestoneBranch}' — ${o.plan.resolved.length} conflict(s) resolved automatically\n\n` + `${lines.join("\n")}\n\n` + `Each resolution was verified before it was pushed: the merged tree ` + `passes the repository's own check, its manifest check and its unit ` + `suite, unless the sync's note says ${n.ungated}, ${n.checkLeftToCi}, ` + `${n.suiteLeftToCi} or ${n.cargoSkipped}. Each of those means a check ` + `did not run. ${n.ungated} means a cargo-only merge-only sync (Issue ` + `#4326) left the whole build to the milestone PR's CI. ` + `${n.checkLeftToCi} means the host could not reach a Deno project's ` + `module host, so that project's type check was left to that CI (Issue ` + `#4441). ${n.suiteLeftToCi} means a Deno task of the resolution gate was ` + `left to that CI for the same reason (Issue #4422). ${n.cargoSkipped} ` + `means the checks that ran passed and cargo did not complete: it was skipped ` + `for the host's budget (Issue #4326) or a cargo check or cargo test timed out or ` + `could not reach the crate registry (Issue #4786), and was left to that CI. None of them ` + `means the check it names passed. No ` + `conflicted test file was resolved by taking a side that drops cases ` + `(Issue #1559).`;
}
/**
 * The escalation for a conflict only a human can resolve.
 *
 * It carries the preparation rather than the compiler output: what each side
 * exports, what each side tests, and which cases exist on one side only. That
 * is most of the hour the reader would otherwise spend before they can decide
 * anything.
 */ export function buildConflictAnalysisComment(e) {
  const sections = e.analyses.map((a)=>`### \`${a.path}\`\n\n` + `${a.reason}.\n\n` + `- Exports on \`${e.milestoneBranch}\`:\n${bullets(a.oursExports, "none found")}\n` + `- Exports on \`${e.defaultBranch}\`:\n${bullets(a.theirsExports, "none found")}\n` + `- Test cases on \`${e.milestoneBranch}\`:\n${bullets(a.oursTests, "none found")}\n` + `- Test cases on \`${e.defaultBranch}\`:\n${bullets(a.theirsTests, "none found")}\n` + `- Cases only on \`${e.milestoneBranch}\`:\n${bullets(a.onlyOursTests, "none")}\n` + `- Cases only on \`${e.defaultBranch}\`:\n${bullets(a.onlyTheirsTests, "none")}`).join("\n\n");
  const resolvedNote = e.resolved.length ? `\n\nThe same merge resolved ${e.resolved.length} other file(s) on its ` + `own — those decisions were discarded with the merge and will be ` + `retaken once the files above are settled:\n\n${e.resolved.map((d)=>`- \`${d.path}\` — ${d.case}: ${d.reason}`).join("\n")}` : "";
  const gateNote = e.gateFailure ? `The conflict itself **was** resolved automatically, and the ` + `verification then refused the result — so the resolution was rolled ` + `back. What the verification said:\n\n\`\`\`\n${e.gateFailure}\n\`\`\`\n\n` : "";
  return `## Milestone sync conflict — both sides prepared\n\n` + `Merging \`${e.defaultBranch}\` into \`${e.milestoneBranch}\` in ` + `\`${e.repo}\` conflicted in a way no automatic rule can resolve ` + `(Issue #1559). Nothing has been pushed and \`${e.milestoneBranch}\` is ` + `exactly as it was.\n\n${gateNote}` + `${sections}${resolvedNote}\n\n` + `The sync keeps attempting the resolution each cycle and lands on its ` + `own once these files stop being two designs for the same problem — a ` + `conflict is the worker's to resolve, never a human's (Issue #2388).`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9taWxlc3RvbmVfY29uZmxpY3RfdHJpYWdlLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogVHJpYWdlIG9mIGEgY29uZmxpY3RlZCBgbWFpbmAg4oaSIGBtaWxlc3RvbmUvKmAgc3luYyBtZXJnZSAoSXNzdWUgIzE1NTkpLlxuICpcbiAqIEEgY29uZmxpY3RlZCBzeW5jIHVzZWQgdG8gaGF2ZSB0d28gbW92ZXMsIGFuZCBib3RoIHdlcmUgd3JvbmcuIFRha2luZyB0aGVcbiAqIGRlZmF1bHQgYnJhbmNoJ3Mgc2lkZSB3aG9sZXNhbGUgaXMgYSBkZWNpc2lvbiBub2JvZHkgbWFkZSDigJQgaXQgcmVwbGFjZWQgdGhlXG4gKiBicmFuY2gncyB2ZXJzaW9uIG9mIGV2ZXJ5IGNvbGxpZGluZyBmaWxlLCB0ZXN0IGZpbGVzIGluY2x1ZGVkLiBIYW5kaW5nIHRoZVxuICogd2hvbGUgdGhpbmcgdG8gYSBodW1hbiBhc2tzIGEgcGVyc29uIHRvIGNob29zZSBiZXR3ZWVuIHR3byBjaGFuZ2VzIHRoZXkgZGlkXG4gKiBub3Qgd3JpdGUsIGRheXMgYWZ0ZXIgYm90aCB3ZXJlIHdyaXR0ZW4uXG4gKlxuICogTW9zdCBvZiB3aGF0IHRoYXQgcGVyc29uIGRvZXMgaXMgbWVjaGFuaWNhbCwgc28gdGhpcyBtb2R1bGUgZG9lcyBpdC4gRm91clxuICogcGF0dGVybnMgaGF2ZSBiZWVuIHNlZW4sIGFuZCB0aGV5IGdldCBmb3VyIGFuc3dlcnM6XG4gKlxuICogICAxLiAqKlRoZSBzYW1lIGZpeCBsYW5kZWQgdHdpY2UqKiAoIzEyNzAsICMxMjY0KSDigJQgYm90aCBzaWRlcyBjaXRlIHRoZSBzYW1lXG4gKiAgICAgIGlzc3VlLiBLZWVwIHRoZSBzaWRlIHdob3NlIHRlc3RzIGFyZSBhIHN1cGVyc2V0IGFuZCBzYXkgd2hhdCB3YXNcbiAqICAgICAgZHJvcHBlZC5cbiAqICAgMi4gKipPbmUgc2lkZSBzdWJzdW1lcyB0aGUgb3RoZXIqKiDigJQgZXZlcnkgbGluZSBvZiB0aGUgc21hbGxlciBzaWRlXG4gKiAgICAgIHN1cnZpdmVzIGluIHRoZSBsYXJnZXIuIFRha2UgdGhlIGxhcmdlcjsgbm90aGluZyBpcyBsb3N0LlxuICogICAzLiAqKkJvdGggc2lkZXMgb25seSBhcHBlbmRlZCoqIChgQ0hBTkdFTE9HLm1kYCwgcmVsZWFzZSBub3RlcywgdGhlIGF1ZGl0XG4gKiAgICAgIGxlZGdlcnMpIOKAlCBldmVyeSBsaW5lIG9mIHRoZSBtZXJnZSBiYXNlIHN1cnZpdmVzIG9uIGJvdGggc2lkZXMsIHNvXG4gKiAgICAgIG5vdGhpbmcgd2FzIGRlbGV0ZWQgYW5kIGJvdGggYWRkaXRpb25zIGFyZSBrZXB0LCB0aGUgZGVmYXVsdCBicmFuY2gnc1xuICogICAgICBmaXJzdCAoSXNzdWUgIzE3NjgpLlxuICogICA0LiAqKlR3byBkZXNpZ25zIGZvciB0aGUgc2FtZSBwcm9ibGVtKiogKGBJbmRpcmVjdFNwYXduUnVsZXNgIHZlcnN1c1xuICogICAgICBgc2NhbkNvbnRlbnRGb3JWYXJpYWJsZUJpbmFyeVNwYXduYCkg4oCUIG5laXRoZXIgY29udGFpbnMgdGhlIG90aGVyIGFuZFxuICogICAgICBvbmUgb2YgdGhlbSBjaGFuZ2VkIHdoYXQgdGhlIGJhc2UgaGFkLCBzbyBhIGh1bWFuIGNob29zZXMuIFJpdmFsXG4gKiAgICAgIGRlc2lnbnMgdGhhdCBhcmUgKmJvdGgqIHB1cmVseSBhZGRpdGl2ZSBhcmUgY2FzZSAzJ3MgdW5pb24gaW5zdGVhZC4gVGhlIGV4cGVuc2l2ZSBwcmVwYXJhdGlvbiBpcyBzdGlsbCBkb25lIGhlcmU6IGVhY2hcbiAqICAgICAgc2lkZSdzIGV4cG9ydHMsIGVhY2ggc2lkZSdzIHRlc3QgbmFtZXMsIGFuZCB0aGUgZGlmZmVyZW5jZSBiZXR3ZWVuIHRoZW0uXG4gKlxuICogT25lIHJ1bGUgb3V0cmFua3MgYWxsIGZvdXI6ICoqbm8gcmVzb2x1dGlvbiBtYXkgcmVkdWNlIHRlc3QgY292ZXJhZ2UqKi4gQVxuICogY29uZmxpY3RlZCB0ZXN0IGZpbGUgcmVzb2x2ZXMgb25seSB3aGVuIG9uZSBzaWRlIGlzIGEgZ2VudWluZSB1bmlvbiBvZiBib3RoXG4gKiDigJQgZXZlcnkgY2FzZSAqYW5kKiBldmVyeSBsaW5lIG9mIHRoZSBvdGhlciBzaWRlIHN1cnZpdmVzIGluIGl0IOKAlCBvdGhlcndpc2VcbiAqIGl0IGVzY2FsYXRlcy4gRXF1YWwgY2FzZSBuYW1lcyBhcmUgbm90IGVub3VnaDogYW4gYXNzZXJ0aW9uIGNoYW5nZWQgaW5zaWRlIGFcbiAqIGNhc2Ugd2l0aCB0aGUgc2FtZSBuYW1lIGlzIGV4YWN0bHkgdGhlIHNpbGVudCBsb3NzIHRoaXMgcnVsZSBleGlzdHMgdG8gc3RvcC5cbiAqXG4gKiBOb3RoaW5nIGhlcmUgdG91Y2hlcyBnaXQ7IHRoZSBjYWxsZXIgc3VwcGxpZXMgYm90aCBzaWRlcyBhbmQgYXBwbGllcyB0aGVcbiAqIHBsYW4uIFRoYXQga2VlcHMgZXZlcnkgZGVjaXNpb24gYSBwdXJlIGZ1bmN0aW9uIG9mIGl0cyBpbnB1dHMsIGFuZCB0ZXN0YWJsZVxuICogYXMgb25lLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQgKGJlaGF2aW91ciwgY29sb3VyLCBvcmdhbmlzYXRpb24sIGV0Yy4pLlxuICovXG5cbi8qKiBXaGljaCBzaWRlIG9mIGEgY29uZmxpY3RlZCBmaWxlIGEgcmVzb2x1dGlvbiB0YWtlcy4gKi9cbmV4cG9ydCB0eXBlIENvbmZsaWN0U2lkZSA9IFwib3Vyc1wiIHwgXCJ0aGVpcnNcIjtcblxuLyoqIEhvdyBhIGNvbmZsaWN0ZWQgZmlsZSB3YXMgY2xhc3NpZmllZC4gKi9cbmV4cG9ydCB0eXBlIENvbmZsaWN0Q2FzZSA9XG4gIC8qKiBCb3RoIHNpZGVzIGZpeCB0aGUgc2FtZSBpc3N1ZSDigJQgY2FzZSAxLiAqL1xuICB8IFwiZHVwbGljYXRlLWZpeFwiXG4gIC8qKiBPbmUgc2lkZSBrZWVwcyBldmVyeSBsaW5lIG9mIHRoZSBvdGhlciDigJQgY2FzZSAyLiAqL1xuICB8IFwic3VwZXJzZXRcIlxuICAvKiogQSB0ZXN0IGZpbGUgd2hlcmUgb25lIHNpZGUgY2FycmllcyBldmVyeSBjYXNlIG9mIHRoZSBvdGhlci4gKi9cbiAgfCBcInRlc3QtdW5pb25cIlxuICAvKiogQm90aCBzaWRlcyBvbmx5IGFwcGVuZGVkLCBhbmQgbm90aGluZyBpbiB0aGUgbWVyZ2UgYmFzZSB3YXMgcmVtb3ZlZC4gKi9cbiAgfCBcImJvdGgtaW5zZXJ0ZWRcIlxuICAvKiogVGhlIGRlZmF1bHQgYnJhbmNoIGRlbGV0ZWQgaXQ7IHRoZSBkZWxldGlvbiBzdGFuZHMgKElzc3VlICMxMDQ4KS4gKi9cbiAgfCBcImluY29taW5nLWRlbGV0ZVwiXG4gIC8qKiBCb3RoIHNpZGVzIGNoYW5nZWQgdGhlIHNhbWUgY29kZSBhbmQgbmVpdGhlciBjb250YWlucyB0aGUgb3RoZXIg4oCUIGNhc2UgMy4gKi9cbiAgfCBcInJpdmFsLWRlc2lnbnNcIlxuICAvKiogQW55IG90aGVyIHN0YXRlIG5vIHJ1bGUgZGVjaWRlczogYSBodW1hbiBsb29rcyBhdCBpdC4gKi9cbiAgfCBcIm5lZWRzLWh1bWFuXCI7XG5cbi8qKiBPbmUgY29uZmxpY3RlZCBwYXRoLCB3aXRoIGJvdGggc2lkZXMgYXMgZ2l0IHN0YWdlZCB0aGVtLiAqL1xuZXhwb3J0IGludGVyZmFjZSBDb25mbGljdGVkRmlsZSB7XG4gIC8qKiBSZXBvc2l0b3J5LXJlbGF0aXZlIHBhdGggZ2l0IHJlcG9ydGVkIGFzIGNvbmZsaWN0ZWQuICovXG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFRoZSBtaWxlc3RvbmUgYnJhbmNoJ3MgY29udGVudDsgbnVsbCB3aGVuIHRoaXMgc2lkZSBkZWxldGVkIGl0LiAqL1xuICBvdXJzOiBzdHJpbmcgfCBudWxsO1xuICAvKiogVGhlIGRlZmF1bHQgYnJhbmNoJ3MgY29udGVudDsgbnVsbCB3aGVuIHRoYXQgc2lkZSBkZWxldGVkIGl0LiAqL1xuICB0aGVpcnM6IHN0cmluZyB8IG51bGw7XG4gIC8qKlxuICAgKiBUaGUgbWVyZ2UgYmFzZSdzIGNvbnRlbnQgKGluZGV4IHN0YWdlIDEpOyBudWxsIHdoZW4gdGhlcmUgaXMgbm9uZSDigJQgYW5cbiAgICogYWRkL2FkZCBjb25mbGljdCDigJQgYW5kIHVuZGVmaW5lZCB3aGVuIHRoZSBjYWxsZXIgZGlkIG5vdCByZWFkIGl0LlxuICAgKlxuICAgKiBSZWFkLCBuZXZlciBpbmZlcnJlZDogXCJ0aGUgYmFzZSBjb3VsZCBub3QgYmUgcmVhZFwiIG11c3Qgbm90IGJlY29tZSBcInRoZVxuICAgKiBiYXNlIHdhcyBlbXB0eVwiLCB3aGljaCB3b3VsZCB0dXJuIGEgZGVsZXRpb24gaW50byBhIHVuaW9uIChJc3N1ZSAjMTc2OCkuXG4gICAqL1xuICBiYXNlPzogc3RyaW5nIHwgbnVsbDtcbiAgLyoqIElzc3VlcyB0aGUgbWlsZXN0b25lIHNpZGUncyBjb21taXRzIHRvdWNoaW5nIHRoaXMgcGF0aCBjbG9zZS4gKi9cbiAgb3Vyc0ZpeGVzOiBudW1iZXJbXTtcbiAgLyoqIElzc3VlcyB0aGUgZGVmYXVsdCBzaWRlJ3MgY29tbWl0cyB0b3VjaGluZyB0aGlzIHBhdGggY2xvc2UuICovXG4gIHRoZWlyc0ZpeGVzOiBudW1iZXJbXTtcbn1cblxuLyoqXG4gKiBXaGljaCBydW5nIG9mIHRoZSBsYWRkZXIgc2V0dGxlZCBhIGNvbmZsaWN0ZWQgcGF0aCAoSXNzdWUgIzE3NzcpLlxuICpcbiAqIFRoZSBzeW5jIHRyaWVzIHRoZSBkZXRlcm1pbmlzdGljIHRyaWFnZSwgdGhlbiB0aGUgZGVwZW5kZW5jeSBydWxlcywgdGhlblxuICogdGhlIHJlc29sdXRpb24gYWdlbnQuIEFic2VudCBtZWFucyBgdHJpYWdlYCDigJQgdGhlIGRlY2lzaW9ucyBhbHJlYWR5IGluIHRoZVxuICogd2lsZCBjYXJyeSBubyBydW5nIGFuZCB3ZXJlIGFsbCB0aGUgdHJpYWdlJ3MuXG4gKi9cbmV4cG9ydCB0eXBlIFJlc29sdXRpb25SdW5nID1cbiAgLyoqIERlY2lkZWQgYnkgdGhlIGRldGVybWluaXN0aWMgdHJpYWdlIGluIHRoaXMgbW9kdWxlLiAqL1xuICB8IFwidHJpYWdlXCJcbiAgLyoqIERlY2lkZWQgYnkgdGhlIGRldGVybWluaXN0aWMgZGVwZW5kZW5jeSBydWxlcy4gKi9cbiAgfCBcInJ1bGVcIlxuICAvKipcbiAgICogRGVjaWRlZCBmcm9tIGhpc3Rvcnk6IHRoZSBvdGhlciBicmFuY2ggYWxyZWFkeSBjYXJyaWVkIHRoaXMgc2lkZSdzXG4gICAqIGV4YWN0IHZlcnNpb24gb2YgdGhlIGZpbGUgYW5kIG1vdmVkIG9uLCBzbyBpdHMgdmVyc2lvbiBjb250YWlucyBvdXJzXG4gICAqIChJc3N1ZSAjMjAyMykuXG4gICAqL1xuICB8IFwicG9ydGVkXCJcbiAgLyoqIERlY2lkZWQgYnkgdGhlIG1lcmdlLWNvbmZsaWN0IHJlc29sdXRpb24gYWdlbnQuICovXG4gIHwgXCJhZ2VudFwiO1xuXG4vKiogV2hhdCB0aGUgdHJpYWdlIGRlY2lkZWQgYWJvdXQgb25lIGNvbmZsaWN0ZWQgcGF0aC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRmlsZURlY2lzaW9uIHtcbiAgcGF0aDogc3RyaW5nO1xuICBjYXNlOiBDb25mbGljdENhc2U7XG4gIC8qKlxuICAgKiBXaGF0IHRvIGRvOiB0YWtlIG9uZSBzaWRlLCBtZXJnZSBib3RoIHNpZGVzIHNvIG5laXRoZXIgbG9zZXMgYSBjYXNlLCBvclxuICAgKiBoYW5kIHRoZSBmaWxlIHRvIGEgaHVtYW4uXG4gICAqL1xuICBhY3Rpb246IENvbmZsaWN0QWN0aW9uO1xuICAvKiogT25lIGxpbmUsIHJlY29yZGVkIG9uIHRoZSBtZXJnZSBjb21taXQgb3IgaW4gdGhlIGVzY2FsYXRpb24uICovXG4gIHJlYXNvbjogc3RyaW5nO1xuICAvKiogVGhlIHJ1bmcgdGhhdCBzZXR0bGVkIGl0OyBhYnNlbnQgbWVhbnMgdGhlIHRyaWFnZSBkaWQgKElzc3VlICMxNzc3KS4gKi9cbiAgcnVuZz86IFJlc29sdXRpb25SdW5nO1xufVxuXG4vKiogV2hhdCBhIGRlY2lzaW9uIGRvZXMgdG8gYSBjb25mbGljdGVkIHBhdGguICovXG5leHBvcnQgdHlwZSBDb25mbGljdEFjdGlvbiA9XG4gIC8qKiBUYWtlIHRoZSBtaWxlc3RvbmUgYnJhbmNoJ3MgdmVyc2lvbi4gKi9cbiAgfCBcIm91cnNcIlxuICAvKiogVGFrZSB0aGUgZGVmYXVsdCBicmFuY2gncyB2ZXJzaW9uLiAqL1xuICB8IFwidGhlaXJzXCJcbiAgLyoqIEtlZXAgYm90aCBzaWRlcycgaHVua3MsIHNvIG5vIGNhc2Ugb24gZWl0aGVyIHNpZGUgaXMgbG9zdC4gKi9cbiAgfCBcInVuaW9uXCJcbiAgLyoqXG4gICAqIEEgcnVuZyBiZWxvdyB0aGUgaHVtYW4gYWxyZWFkeSB3cm90ZSBhbmQgc3RhZ2VkIHRoZSByZXNvbHV0aW9uLCBzb1xuICAgKiBub3RoaW5nIGZ1cnRoZXIgaXMgYXBwbGllZCB0byB0aGUgaW5kZXggKElzc3VlICMxNzc3KS5cbiAgICovXG4gIHwgXCJyZXNvbHZlZFwiXG4gIC8qKiBObyBydWxlIGRlY2lkZXMgaXQg4oCUIGEgaHVtYW4gZG9lcy4gKi9cbiAgfCBcImVzY2FsYXRlXCI7XG5cbi8qKiBXaGF0IHRoZSB0cmlhZ2UgZGVjaWRlZCBhYm91dCB0aGUgd2hvbGUgbWVyZ2UuICovXG5leHBvcnQgaW50ZXJmYWNlIENvbmZsaWN0UGxhbiB7XG4gIC8qKiBFdmVyeSBwYXRoLCBpbiB0aGUgb3JkZXIgZ2l2ZW4uICovXG4gIGRlY2lzaW9uczogRmlsZURlY2lzaW9uW107XG4gIC8qKiBUaGUgcGF0aHMgdGhhdCByZXNvbHZlIHdpdGhvdXQgYSBodW1hbi4gKi9cbiAgcmVzb2x2ZWQ6IEZpbGVEZWNpc2lvbltdO1xuICAvKiogVGhlIHBhdGhzIHRoYXQgbmVlZCBvbmUg4oCUIGVtcHR5IHdoZW4gdGhlIG1lcmdlIHJlc29sdmVzIGVudGlyZWx5LiAqL1xuICBlc2NhbGF0aW9uczogRmlsZURlY2lzaW9uW107XG59XG5cbi8qKiBCb3RoIHNpZGVzIG9mIG9uZSBlc2NhbGF0ZWQgZmlsZSwgcHJlcGFyZWQgZm9yIHRoZSByZWFkZXIuICovXG5leHBvcnQgaW50ZXJmYWNlIEZpbGVBbmFseXNpcyB7XG4gIHBhdGg6IHN0cmluZztcbiAgLyoqIFdoeSB0aGUgdHJpYWdlIGNvdWxkIG5vdCBkZWNpZGUgaXQuICovXG4gIHJlYXNvbjogc3RyaW5nO1xuICBvdXJzRXhwb3J0czogc3RyaW5nW107XG4gIHRoZWlyc0V4cG9ydHM6IHN0cmluZ1tdO1xuICBvdXJzVGVzdHM6IHN0cmluZ1tdO1xuICB0aGVpcnNUZXN0czogc3RyaW5nW107XG4gIC8qKiBDYXNlcyBwcmVzZW50IG9uIHRoZSBtaWxlc3RvbmUgc2lkZSBvbmx5LiAqL1xuICBvbmx5T3Vyc1Rlc3RzOiBzdHJpbmdbXTtcbiAgLyoqIENhc2VzIHByZXNlbnQgb24gdGhlIGRlZmF1bHQgc2lkZSBvbmx5LiAqL1xuICBvbmx5VGhlaXJzVGVzdHM6IHN0cmluZ1tdO1xufVxuXG4vKiogRXJyb3IgbmFtZSBjYXJyaWVkIGJ5IGEgbWVyZ2UgdGhhdCBvbmx5IGEgaHVtYW4gY2FuIHJlc29sdmUuICovXG5leHBvcnQgY29uc3QgTUlMRVNUT05FX0NPTkZMSUNUX0VTQ0FMQVRJT05fRVJST1IgPVxuICBcIk1pbGVzdG9uZUNvbmZsaWN0RXNjYWxhdGlvblwiO1xuXG4vKipcbiAqIEEgY29uZmxpY3RlZCBzeW5jIG5vIGF1dG9tYXRpYyBydWxlIGNvdWxkIHJlc29sdmUgKElzc3VlICMxNTU5KS5cbiAqXG4gKiBUaGUgbWVyZ2UgaXMgYWJvcnRlZCBiZWZvcmUgdGhpcyBpcyByYWlzZWQsIHNvIHRoZSBicmFuY2ggaXMgZXhhY3RseSBhcyBpdFxuICogd2FzLiBUaGUgYW5hbHlzaXMgdHJhdmVscyB3aXRoIHRoZSBlcnJvciByYXRoZXIgdGhhbiBiZWluZyByZWNvbnN0cnVjdGVkIGJ5XG4gKiB3aG9ldmVyIHJlcG9ydHMgaXQg4oCUIHRoYXQgcHJlcGFyYXRpb24gaXMgdGhlIHBvaW50LlxuICovXG5leHBvcnQgY2xhc3MgTWlsZXN0b25lQ29uZmxpY3RFc2NhbGF0aW9uIGV4dGVuZHMgRXJyb3Ige1xuICBvdmVycmlkZSByZWFkb25seSBuYW1lID0gTUlMRVNUT05FX0NPTkZMSUNUX0VTQ0FMQVRJT05fRVJST1I7XG4gIGNvbnN0cnVjdG9yKFxuICAgIG1lc3NhZ2U6IHN0cmluZyxcbiAgICAvKiogQm90aCBzaWRlcyBvZiBldmVyeSBmaWxlIHRoYXQgbmVlZHMgYSBodW1hbi4gKi9cbiAgICByZWFkb25seSBhbmFseXNlczogRmlsZUFuYWx5c2lzW10sXG4gICAgLyoqIFdoYXQgdGhlIHRyaWFnZSB3b3VsZCBoYXZlIHJlc29sdmVkIG9uIGl0cyBvd24sIGZvciBjb250ZXh0LiAqL1xuICAgIHJlYWRvbmx5IHJlc29sdmVkOiBGaWxlRGVjaXNpb25bXSxcbiAgICAvKiogVGhlIGRlZmF1bHQgYnJhbmNoJ3MgdGlwIHRoYXQgY29uZmxpY3RlZCwgZm9yIGVzY2FsYXRpb24gZGVkdXAuICovXG4gICAgcmVhZG9ubHkgZGVmYXVsdFNoYTogc3RyaW5nLFxuICAgIC8qKlxuICAgICAqIFNldCB3aGVuIHRoZSByZXNvbHV0aW9uIGl0c2VsZiB3YXMgbWFkZSBhbmQgdGhlIHZlcmlmaWNhdGlvbiB0aGVuXG4gICAgICogcmVmdXNlZCBpdCAoSXNzdWUgIzE1NTkpLiBUaGUgcmVhZGVyIG5lZWRzIGJvdGggaGFsdmVzOiB3aGF0IHRoZSBnYXRlXG4gICAgICogc2FpZCwgYW5kIHRoZSB0d28gc2lkZXMgdGhhdCBwcm9kdWNlZCBpdCDigJQgYSB3YWxsIG9mIGBUUzIzMDRgIG9uIGl0c1xuICAgICAqIG93biBkZWNpZGVzIG5vdGhpbmcuXG4gICAgICovXG4gICAgcmVhZG9ubHkgZ2F0ZUZhaWx1cmU/OiBzdHJpbmcsXG4gICAgLyoqXG4gICAgICogVGhlIG1pbGVzdG9uZSBicmFuY2gncyB0aXAgYXQgdGhlIHRpbWUgb2YgdGhlIG1lcmdlIChJc3N1ZSAjMTc4NikuXG4gICAgICogV2l0aCB0aGUgY29uZmxpY3RlZCBwYXRocyBpdCBpZGVudGlmaWVzIHRoZSBjb25mbGljdCBpdHNlbGYsIHNvIGFuXG4gICAgICogZXNjYWxhdGlvbiBpcyBkZWR1cGVkIG9uIHdoYXQgYWN0dWFsbHkgY29sbGlkZWQgcmF0aGVyIHRoYW4gb24gdGhlXG4gICAgICogZGVmYXVsdCBicmFuY2gncyB0aXAg4oCUIHdoaWNoIG1vdmVzIGV2ZXJ5IGZldyBtaW51dGVzIG9uIGEgYnVzeVxuICAgICAqIHJlcG9zaXRvcnkgYW5kIG1hZGUgdGhlIHNhbWUgYW5hbHlzaXMgYSBjb21tZW50IHBlciBjeWNsZS5cbiAgICAgKi9cbiAgICByZWFkb25seSBtaWxlc3RvbmVTaGE/OiBzdHJpbmcsXG4gICAgLyoqXG4gICAgICogVGhlIGF0dGVtcHQncyBzdGFnZSB0aW1pbmdzIGFuZCBob3N0LCBhcyBgZm9ybWF0U3RhZ2VUaW1pbmdzYCByZW5kZXJlZFxuICAgICAqIHRoZW0gKElzc3VlcyAjMjMwOCwgIzIzMTEpLiBBIGZhaWxlZCBydW4gY29zdHMgdGhlIHNhbWUgdHdlbnR5IG1pbnV0ZXNcbiAgICAgKiBhIHN1Y2Nlc3NmdWwgb25lIGRvZXMsIGFuZCB0aGUgYG1lcmdlLWZhbGxiYWNrYCBmbGFnIGlzIHdoZXJlIHRoYXRcbiAgICAgKiBjb3N0IGlzIHJlYWQgYmFjayDigJQgc28gdGhlIHJlZnVzYWwgY2FycmllcyBpdCByYXRoZXIgdGhhbiBsZWF2aW5nIGl0XG4gICAgICogaW4gYSBsb2cgbm9ib2R5IGtlZXBzLlxuICAgICAqL1xuICAgIHJlYWRvbmx5IHRpbWluZ3M/OiBzdHJpbmcsXG4gICkge1xuICAgIHN1cGVyKG1lc3NhZ2UpO1xuICB9XG59XG5cbi8qKiBXaGV0aGVyIGFuIGVycm9yIGlzIHRoZSBcIm9ubHkgYSBodW1hbiBjYW4gcmVzb2x2ZSB0aGlzXCIgb3V0Y29tZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0NvbmZsaWN0RXNjYWxhdGlvbihcbiAgZXJyOiB1bmtub3duLFxuKTogZXJyIGlzIE1pbGVzdG9uZUNvbmZsaWN0RXNjYWxhdGlvbiB7XG4gIHJldHVybiBlcnIgaW5zdGFuY2VvZiBFcnJvciAmJlxuICAgIGVyci5uYW1lID09PSBNSUxFU1RPTkVfQ09ORkxJQ1RfRVNDQUxBVElPTl9FUlJPUjtcbn1cblxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4vLyBQYXJzaW5nIHByaW1pdGl2ZXNcbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogQSB0ZXN0IGZpbGUgYnkgZGlyZWN0b3J5LCBvciBieSB0aGUgc3VmZml4IGNvbnZlbnRpb25zIGluIHVzZSBoZXJlLiAqL1xuY29uc3QgVEVTVF9ESVIgPSAvKF58XFwvKSh0ZXN0cz98X190ZXN0c19ffHNwZWMpXFwvLztcbmNvbnN0IFRFU1RfU1VGRklYID0gL1suX10odGVzdHxzcGVjKVxcLlthLXpdKyQvaTtcblxuLyoqIFdoZXRoZXIgYSByZXBvc2l0b3J5LXJlbGF0aXZlIHBhdGggaXMgYSB0ZXN0IGZpbGUuICovXG5leHBvcnQgZnVuY3Rpb24gaXNUZXN0UGF0aChwYXRoOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIFRFU1RfRElSLnRlc3QocGF0aCkgfHwgVEVTVF9TVUZGSVgudGVzdChwYXRoKTtcbn1cblxuLyoqXG4gKiBJc3N1ZSBudW1iZXJzIGEgY29tbWl0IG1lc3NhZ2Ugc2F5cyBpdCAqKmNsb3NlcyoqLlxuICpcbiAqIEdpdEh1YidzIGNsb3Npbmcga2V5d29yZHMgb25seS4gQSBiYXJlIGBSZWZzICNOYCwgb3IgcHJvc2UgdGhhdCBtZXJlbHlcbiAqIG1lbnRpb25zIGFuIGlzc3VlIG51bWJlciwgaXMgZGVsaWJlcmF0ZWx5IG5vdCBhIGNsYWltIHRvIGhhdmUgZml4ZWRcbiAqIGFueXRoaW5nIGFuZCBpcyBub3QgcmVhZCBhcyBvbmUg4oCUIHJlYWRpbmcgaXQgdGhhdCB3YXkgd291bGQgbGV0IHR3b1xuICogdW5yZWxhdGVkIGNvbW1pdHMgdGhhdCBib3RoIGRpc2N1c3MgIzEyMTYgYmUgY2xhc3NpZmllZCBhcyB0aGUgc2FtZSBmaXhcbiAqIGxhbmRpbmcgdHdpY2UsIGFuZCBvbmUgc2lkZSdzIGltcGxlbWVudGF0aW9uIHdvdWxkIHRoZW4gYmUgZHJvcHBlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHBhcnNlRml4UmVmZXJlbmNlcyh0ZXh0OiBzdHJpbmcpOiBudW1iZXJbXSB7XG4gIGNvbnN0IGZvdW5kID0gbmV3IFNldDxudW1iZXI+KCk7XG4gIGNvbnN0IHBhdHRlcm4gPSAvXFxiKD86Zml4KD86ZVtzZF0pP3xjbG9zZVtzZF0/fHJlc29sdmVbc2RdPylcXHMrIyhcXGQrKVxcYi9naTtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiB0ZXh0Lm1hdGNoQWxsKHBhdHRlcm4pKSB7XG4gICAgY29uc3QgbiA9IE51bWJlcihtYXRjaFsxXSk7XG4gICAgaWYgKE51bWJlci5pc1NhZmVJbnRlZ2VyKG4pICYmIG4gPiAwKSBmb3VuZC5hZGQobik7XG4gIH1cbiAgcmV0dXJuIFsuLi5mb3VuZF07XG59XG5cbi8qKlxuICogSXNzdWUgbnVtYmVycyB0aGlzIGZsZWV0J3Mgb3duIGAoSXNzdWUgI04pYCBzdGFtcCBjbGFpbXMsIGZyb20gYSBjb21taXRcbiAqICoqc3ViamVjdCBsaW5lKiouXG4gKlxuICogVGhlIHdvcmtlciB3cml0ZXMgdGhhdCBzdGFtcCBvbiB0aGUgc3ViamVjdCBvZiBldmVyeSBjb21taXQgaXQgYXV0aG9ycywgc29cbiAqIGEgZHVwbGljYXRlIGZpeCBsYW5kaW5nIHR3aWNlIGlzIGludmlzaWJsZSB3aXRob3V0IGl0LiBPbmx5IHRoZSBzdWJqZWN0XG4gKiBjb3VudHM6IGNvbW1pdCAqYm9kaWVzKiBoZXJlIHJvdXRpbmVseSBkaXNjdXNzIG90aGVyIGlzc3VlcyBpbiBwYXNzaW5nXG4gKiAoXCJJc3N1ZSAjMTU2MiByZWNvcmRzIHRocmVlIGRlZmVjdHNcIiksIGFuZCBhIG1lbnRpb24gaXMgbm90IGEgY2xhaW0uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwYXJzZVN0YW1wZWRJc3N1ZXMoc3ViamVjdDogc3RyaW5nKTogbnVtYmVyW10ge1xuICBjb25zdCBmb3VuZCA9IG5ldyBTZXQ8bnVtYmVyPigpO1xuICAvLyBUaGUgZmlyc3QgbGluZSBvbmx5IOKAlCBhIHN1YmplY3QgaXMgb25lIGxpbmUsIHdoYXRldmVyIHRoZSBjYWxsZXIgcGFzc2VkLlxuICBjb25zdCBsaW5lID0gc3ViamVjdC5zcGxpdChcIlxcblwiKVswXSA/PyBcIlwiO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIGxpbmUubWF0Y2hBbGwoL1xcKFxccyppc3N1ZVxccysjKFxcZCspXFxzKlxcKS9naSkpIHtcbiAgICBjb25zdCBuID0gTnVtYmVyKG1hdGNoWzFdKTtcbiAgICBpZiAoTnVtYmVyLmlzU2FmZUludGVnZXIobikgJiYgbiA+IDApIGZvdW5kLmFkZChuKTtcbiAgfVxuICByZXR1cm4gWy4uLmZvdW5kXTtcbn1cblxuLyoqIE5hbWVzIG9mIHRoZSB0ZXN0IGNhc2VzIGEgc291cmNlIGZpbGUgZGVjbGFyZXMsIGluIHNvdXJjZSBvcmRlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0VGVzdE5hbWVzKHNvdXJjZTogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBuYW1lczogc3RyaW5nW10gPSBbXTtcbiAgY29uc3Qgc2VlbiA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBjb25zdCBwYXR0ZXJuID1cbiAgICAvKD86RGVub1xcLnRlc3R8XFxiaXR8XFxidGVzdHxcXGJkZXNjcmliZSlcXHMqXFwoXFxzKig/Olxce1xccypuYW1lXFxzKjpcXHMqKT8oW1wiJ2BdKSgoPzpcXFxcLnwoPyFcXDEpW15cXFxcXSkqKVxcMS9nO1xuICBmb3IgKGNvbnN0IG1hdGNoIG9mIHNvdXJjZS5tYXRjaEFsbChwYXR0ZXJuKSkge1xuICAgIGNvbnN0IG5hbWUgPSBtYXRjaFsyXSA/PyBcIlwiO1xuICAgIGlmIChuYW1lICYmICFzZWVuLmhhcyhuYW1lKSkge1xuICAgICAgc2Vlbi5hZGQobmFtZSk7XG4gICAgICBuYW1lcy5wdXNoKG5hbWUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gbmFtZXM7XG59XG5cbi8qKiBOYW1lcyBhIHNvdXJjZSBmaWxlIGV4cG9ydHMsIHNvcnRlZCBzbyB0d28gc2lkZXMgY29tcGFyZSBkZXRlcm1pbmlzdGljYWxseS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBleHRyYWN0RXhwb3J0cyhzb3VyY2U6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbmFtZXMgPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgZGVjbGFyYXRpb24gPVxuICAgIC9eXFxzKmV4cG9ydFxccysoPzpkZWZhdWx0XFxzKyk/KD86YXN5bmNcXHMrKT8oPzpmdW5jdGlvblxccypcXCo/fGNsYXNzfGNvbnN0fGxldHx2YXJ8aW50ZXJmYWNlfHR5cGV8ZW51bSlcXHMrKFtBLVphLXpfJF1bXFx3JF0qKS9nbTtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiBzb3VyY2UubWF0Y2hBbGwoZGVjbGFyYXRpb24pKSB7XG4gICAgaWYgKG1hdGNoWzFdKSBuYW1lcy5hZGQobWF0Y2hbMV0pO1xuICB9XG4gIGNvbnN0IGxpc3QgPSAvXlxccypleHBvcnRcXHMqXFx7KFtefV0qKVxcfS9nbTtcbiAgZm9yIChjb25zdCBtYXRjaCBvZiBzb3VyY2UubWF0Y2hBbGwobGlzdCkpIHtcbiAgICBmb3IgKGNvbnN0IHBhcnQgb2YgKG1hdGNoWzFdID8/IFwiXCIpLnNwbGl0KFwiLFwiKSkge1xuICAgICAgY29uc3QgbmFtZSA9IHBhcnQudHJpbSgpLnNwbGl0KC9cXHMrYXNcXHMrLylbMF0/LnRyaW0oKTtcbiAgICAgIGlmIChuYW1lKSBuYW1lcy5hZGQobmFtZSk7XG4gICAgfVxuICB9XG4gIHJldHVybiBbLi4ubmFtZXNdLnNvcnQoKTtcbn1cblxuLyoqIE5vbi1lbXB0eSB0cmltbWVkIGxpbmVzLCBjb3VudGVkIOKAlCBkdXBsaWNhdGVzIGFyZSBub3QgY29sbGFwc2VkLiAqL1xuZnVuY3Rpb24gbGluZUNvdW50cyhzb3VyY2U6IHN0cmluZyk6IE1hcDxzdHJpbmcsIG51bWJlcj4ge1xuICBjb25zdCBjb3VudHMgPSBuZXcgTWFwPHN0cmluZywgbnVtYmVyPigpO1xuICBmb3IgKGNvbnN0IHJhdyBvZiBzb3VyY2Uuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBjb25zdCBsaW5lID0gcmF3LnRyaW0oKTtcbiAgICBpZiAoIWxpbmUpIGNvbnRpbnVlO1xuICAgIGNvdW50cy5zZXQobGluZSwgKGNvdW50cy5nZXQobGluZSkgPz8gMCkgKyAxKTtcbiAgfVxuICByZXR1cm4gY291bnRzO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgZXZlcnkgbGluZSBvZiBgc3Vic2V0YCBzdXJ2aXZlcyBpbiBgc3VwZXJzZXRgLlxuICpcbiAqIExpbmVzIGFyZSBjb3VudGVkIHJhdGhlciB0aGFuIGNvbGxhcHNlZDogYSBzaWRlIHRoYXQgY2FycmllcyBvbmUgY29weSBvZiBhXG4gKiBsaW5lIGRvZXMgbm90IHN1YnN1bWUgYSBzaWRlIHRoYXQgY2FycmllcyB0d28uXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc0xpbmVTdXBlcnNldChzdXBlcnNldDogc3RyaW5nLCBzdWJzZXQ6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCBoYXZlID0gbGluZUNvdW50cyhzdXBlcnNldCk7XG4gIGZvciAoY29uc3QgW2xpbmUsIG5lZWRlZF0gb2YgbGluZUNvdW50cyhzdWJzZXQpKSB7XG4gICAgaWYgKChoYXZlLmdldChsaW5lKSA/PyAwKSA8IG5lZWRlZCkgcmV0dXJuIGZhbHNlO1xuICB9XG4gIHJldHVybiB0cnVlO1xufVxuXG4vKiogTWVtYmVycyBvZiBgYWAgdGhhdCBhcmUgbm90IGluIGBiYC4gKi9cbmZ1bmN0aW9uIG9ubHkoYTogc3RyaW5nW10sIGI6IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICBjb25zdCBvdGhlciA9IG5ldyBTZXQoYik7XG4gIHJldHVybiBhLmZpbHRlcigoaXRlbSkgPT4gIW90aGVyLmhhcyhpdGVtKSk7XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gQ2xhc3NpZmljYXRpb25cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuXG4vKiogTmV2ZXIgcmVzb2x2ZWQgYXV0b21hdGljYWxseSDigJQgdGhlIHJlYXNvbiB0cmF2ZWxzIHdpdGggdGhlIGVzY2FsYXRpb24uICovXG5mdW5jdGlvbiBlc2NhbGF0ZShcbiAgcGF0aDogc3RyaW5nLFxuICByZWFzb246IHN0cmluZyxcbiAga2luZDogQ29uZmxpY3RDYXNlID0gXCJuZWVkcy1odW1hblwiLFxuKTogRmlsZURlY2lzaW9uIHtcbiAgcmV0dXJuIHsgcGF0aCwgY2FzZToga2luZCwgYWN0aW9uOiBcImVzY2FsYXRlXCIsIHJlYXNvbiB9O1xufVxuXG4vKipcbiAqIERlY2lkZSBvbmUgY29uZmxpY3RlZCB0ZXN0IGZpbGUuXG4gKlxuICogUmVzb2x2YWJsZSBvbmx5IHdoZW4gb25lIHNpZGUgaXMgYSBnZW51aW5lIHVuaW9uIG9mIGJvdGg6IGV2ZXJ5IGNhc2UgbmFtZVxuICogKmFuZCogZXZlcnkgbGluZSBvZiB0aGUgb3RoZXIgc2lkZSBzdXJ2aXZlcyBpbiBpdC4gQW55dGhpbmcgZWxzZSBlc2NhbGF0ZXMsXG4gKiBiZWNhdXNlIHRha2luZyBhIHNpZGUgd291bGQgZHJvcCBjb3ZlcmFnZSDigJQgdGhlIGxvc3MgdGhpcyBydWxlIGV4aXN0cyB0b1xuICogc3RvcCwgYW5kIHRoZSBvbmUgdGhhdCBpcyBzaWxlbnQgd2hlbiB0aGUgY2FzZSBuYW1lcyBoYXBwZW4gdG8gbWF0Y2guXG4gKi9cbmZ1bmN0aW9uIGNsYXNzaWZ5VGVzdEZpbGUoXG4gIHBhdGg6IHN0cmluZyxcbiAgb3Vyczogc3RyaW5nLFxuICB0aGVpcnM6IHN0cmluZyxcbik6IEZpbGVEZWNpc2lvbiB7XG4gIGNvbnN0IG91cnNUZXN0cyA9IGV4dHJhY3RUZXN0TmFtZXMob3Vycyk7XG4gIGNvbnN0IHRoZWlyc1Rlc3RzID0gZXh0cmFjdFRlc3ROYW1lcyh0aGVpcnMpO1xuICBjb25zdCBvbmx5T3VycyA9IG9ubHkob3Vyc1Rlc3RzLCB0aGVpcnNUZXN0cyk7XG4gIGNvbnN0IG9ubHlUaGVpcnMgPSBvbmx5KHRoZWlyc1Rlc3RzLCBvdXJzVGVzdHMpO1xuXG4gIGlmIChvbmx5VGhlaXJzLmxlbmd0aCA9PT0gMCAmJiBpc0xpbmVTdXBlcnNldChvdXJzLCB0aGVpcnMpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGgsXG4gICAgICBjYXNlOiBcInRlc3QtdW5pb25cIixcbiAgICAgIGFjdGlvbjogXCJvdXJzXCIsXG4gICAgICByZWFzb246XG4gICAgICAgIGB0aGUgbWlsZXN0b25lIHNpZGUgaXMgYWxyZWFkeSBhIHVuaW9uIG9mIGJvdGgg4oCUIGl0IGtlZXBzIGV2ZXJ5IGNhc2UgYCArXG4gICAgICAgIGBhbmQgZXZlcnkgbGluZSBvZiB0aGUgZGVmYXVsdCBicmFuY2gncyB2ZXJzaW9uJHtcbiAgICAgICAgICBvbmx5T3Vycy5sZW5ndGggPyBgLCBhbmQgYWRkcyAke29ubHlPdXJzLmxlbmd0aH0gY2FzZShzKWAgOiBcIlwiXG4gICAgICAgIH1gLFxuICAgIH07XG4gIH1cbiAgaWYgKG9ubHlPdXJzLmxlbmd0aCA9PT0gMCAmJiBpc0xpbmVTdXBlcnNldCh0aGVpcnMsIG91cnMpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGgsXG4gICAgICBjYXNlOiBcInRlc3QtdW5pb25cIixcbiAgICAgIGFjdGlvbjogXCJ0aGVpcnNcIixcbiAgICAgIHJlYXNvbjpcbiAgICAgICAgYHRoZSBkZWZhdWx0IGJyYW5jaCdzIHNpZGUgaXMgYWxyZWFkeSBhIHVuaW9uIG9mIGJvdGgg4oCUIGl0IGtlZXBzIGAgK1xuICAgICAgICBgZXZlcnkgY2FzZSBhbmQgZXZlcnkgbGluZSBvZiB0aGUgbWlsZXN0b25lIGJyYW5jaCdzIHZlcnNpb24ke1xuICAgICAgICAgIG9ubHlUaGVpcnMubGVuZ3RoID8gYCwgYW5kIGFkZHMgJHtvbmx5VGhlaXJzLmxlbmd0aH0gY2FzZShzKWAgOiBcIlwiXG4gICAgICAgIH1gLFxuICAgIH07XG4gIH1cbiAgLy8gTmVpdGhlciBzaWRlIGNvbnRhaW5zIHRoZSBvdGhlciwgc28gdGFraW5nIGEgc2lkZSB3b3VsZCBkcm9wIGNhc2VzLiBUaGVcbiAgLy8gZmlsZSBpcyBtZXJnZWQgYXMgYSAqKnVuaW9uKiogaW5zdGVhZCDigJQgYm90aCBzaWRlcycgaHVua3Mga2VwdCDigJQgYW5kIHRoZVxuICAvLyBjYWxsZXIgY2hlY2tzIHRoYXQgZXZlcnkgY2FzZSBvbiBib3RoIHNpZGVzIHN1cnZpdmVkIGl0LiBBIHVuaW9uIHRoYXRcbiAgLy8gZG9lcyBub3Qgc3Vydml2ZSB0aGF0IGNoZWNrIGVzY2FsYXRlczsgaXQgbmV2ZXIgbGFuZHMgc2hvcnQuXG4gIHJldHVybiB7XG4gICAgcGF0aCxcbiAgICBjYXNlOiBcInRlc3QtdW5pb25cIixcbiAgICBhY3Rpb246IFwidW5pb25cIixcbiAgICByZWFzb246IGBuZWl0aGVyIHNpZGUgb2YgdGhpcyB0ZXN0IGZpbGUgY29udGFpbnMgdGhlIG90aGVyLCBzbyBib3RoIGAgK1xuICAgICAgYHNpZGVzJyBodW5rcyBhcmUga2VwdCBieSBhIHVuaW9uIG1lcmdlIHJhdGhlciB0aGFuIGEgc2lkZSBiZWluZyBgICtcbiAgICAgIGB0YWtlbiR7XG4gICAgICAgIG9ubHlPdXJzLmxlbmd0aFxuICAgICAgICAgID8gYCDigJQgb25seSBvbiB0aGUgbWlsZXN0b25lIHNpZGU6ICR7b25seU91cnMuam9pbihcIiwgXCIpfWBcbiAgICAgICAgICA6IFwiXCJcbiAgICAgIH0ke1xuICAgICAgICBvbmx5VGhlaXJzLmxlbmd0aFxuICAgICAgICAgID8gYCDigJQgb25seSBvbiB0aGUgZGVmYXVsdCBicmFuY2g6ICR7b25seVRoZWlycy5qb2luKFwiLCBcIil9YFxuICAgICAgICAgIDogXCJcIlxuICAgICAgfWAsXG4gIH07XG59XG5cbi8qKiBEZWNpZGUgb25lIGNvbmZsaWN0ZWQgcGF0aCB0aGF0IGlzIG5vdCBhIHRlc3QgZmlsZS4gKi9cbmZ1bmN0aW9uIGNsYXNzaWZ5U291cmNlRmlsZShcbiAgZmlsZTogQ29uZmxpY3RlZEZpbGUsXG4gIG91cnM6IHN0cmluZyxcbiAgdGhlaXJzOiBzdHJpbmcsXG4gIGV2aWRlbmNlOiBUZXN0RXZpZGVuY2UsXG4pOiBGaWxlRGVjaXNpb24ge1xuICAvLyBDb250YWlubWVudCBmaXJzdDogYSBzaWRlIHRoYXQga2VlcHMgZXZlcnkgbGluZSBvZiB0aGUgb3RoZXIgZHJvcHNcbiAgLy8gbm90aGluZywgc28gaXQgaXMgdGhlIHNhZmVzdCBhbnN3ZXIgYXZhaWxhYmxlIGFuZCBkb2VzIG5vdCBkZXBlbmQgb25cbiAgLy8gcmVhZGluZyBlaXRoZXIgc2lkZSdzIHRlc3RzLlxuICBpZiAoaXNMaW5lU3VwZXJzZXQodGhlaXJzLCBvdXJzKSkge1xuICAgIHJldHVybiB7XG4gICAgICBwYXRoOiBmaWxlLnBhdGgsXG4gICAgICBjYXNlOiBcInN1cGVyc2V0XCIsXG4gICAgICBhY3Rpb246IFwidGhlaXJzXCIsXG4gICAgICByZWFzb246XG4gICAgICAgIGB0aGUgZGVmYXVsdCBicmFuY2gncyBzaWRlIGtlZXBzIGV2ZXJ5IGxpbmUgb2YgdGhlIG1pbGVzdG9uZSBzaWRlLCBgICtcbiAgICAgICAgYHNvIG5vdGhpbmcgaXMgZHJvcHBlZCBieSB0YWtpbmcgaXRgLFxuICAgIH07XG4gIH1cbiAgaWYgKGlzTGluZVN1cGVyc2V0KG91cnMsIHRoZWlycykpIHtcbiAgICByZXR1cm4ge1xuICAgICAgcGF0aDogZmlsZS5wYXRoLFxuICAgICAgY2FzZTogXCJzdXBlcnNldFwiLFxuICAgICAgYWN0aW9uOiBcIm91cnNcIixcbiAgICAgIHJlYXNvbjpcbiAgICAgICAgYHRoZSBtaWxlc3RvbmUgc2lkZSBrZWVwcyBldmVyeSBsaW5lIG9mIHRoZSBkZWZhdWx0IGJyYW5jaCdzIHNpZGUsIGAgK1xuICAgICAgICBgc28gbm90aGluZyBpcyBkcm9wcGVkIGJ5IHRha2luZyBpdGAsXG4gICAgfTtcbiAgfVxuXG4gIGNvbnN0IHNoYXJlZCA9IGZpbGUub3Vyc0ZpeGVzLmZpbHRlcigobikgPT4gZmlsZS50aGVpcnNGaXhlcy5pbmNsdWRlcyhuKSk7XG4gIGlmIChzaGFyZWQubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IGRlY2lkZWQgPSBkZWNpZGVEdXBsaWNhdGVGaXgoc2hhcmVkLCBldmlkZW5jZSk7XG4gICAgaWYgKGRlY2lkZWQuc2lkZSA9PT0gbnVsbCkge1xuICAgICAgcmV0dXJuIGVzY2FsYXRlKFxuICAgICAgICBmaWxlLnBhdGgsXG4gICAgICAgIGBib3RoIHNpZGVzIGZpeCAke1xuICAgICAgICAgIHNoYXJlZC5tYXAoKG4pID0+IGAjJHtufWApLmpvaW4oXCIsIFwiKVxuICAgICAgICB9LCBidXQgJHtkZWNpZGVkLndoeX0sIHNvIHRoZXJlIGlzIG5vIGltcGxlbWVudGF0aW9uIHRvIGtlZXAgd2l0aG91dCBgICtcbiAgICAgICAgICBgcmlza2luZyB0aGUgY2FzZXMgdGhlIG90aGVyIHNpZGUgd3JvdGUgZm9yIHRoZSBzYW1lIGZpeGAsXG4gICAgICApO1xuICAgIH1cbiAgICBjb25zdCBrZXB0ID0gZGVjaWRlZC5zaWRlID09PSBcIm91cnNcIiA/IFwibWlsZXN0b25lXCIgOiBcImRlZmF1bHRcIjtcbiAgICBjb25zdCBkcm9wcGVkID0gZGVjaWRlZC5zaWRlID09PSBcIm91cnNcIiA/IFwiZGVmYXVsdFwiIDogXCJtaWxlc3RvbmVcIjtcbiAgICByZXR1cm4ge1xuICAgICAgcGF0aDogZmlsZS5wYXRoLFxuICAgICAgY2FzZTogXCJkdXBsaWNhdGUtZml4XCIsXG4gICAgICBhY3Rpb246IGRlY2lkZWQuc2lkZSxcbiAgICAgIHJlYXNvbjogYGJvdGggc2lkZXMgZml4ICR7XG4gICAgICAgIHNoYXJlZC5tYXAoKG4pID0+IGAjJHtufWApLmpvaW4oXCIsIFwiKVxuICAgICAgfSDigJQgdGhlIHNhbWUgZml4IGxhbmRlZCB0d2ljZS4gVGhlICR7a2VwdH0gYnJhbmNoJ3MgaW1wbGVtZW50YXRpb24gaXMgYCArXG4gICAgICAgIGBrZXB0IGJlY2F1c2UgJHtkZWNpZGVkLndoeX07IHRoZSAke2Ryb3BwZWR9IGJyYW5jaCdzIGltcGxlbWVudGF0aW9uIGAgK1xuICAgICAgICBgb2YgdGhlIHNhbWUgZml4IHdhcyBkcm9wcGVkJHtcbiAgICAgICAgICBkZWNpZGVkLmRyb3BwZWRDYXNlcy5sZW5ndGhcbiAgICAgICAgICAgID8gYCwgYW5kIGl0cyBjYXNlKHMpICR7XG4gICAgICAgICAgICAgIGRlY2lkZWQuZHJvcHBlZENhc2VzLmpvaW4oXCIsIFwiKVxuICAgICAgICAgICAgfSBhcmUgY292ZXJlZCBieSB0aGUga2VwdCBzaWRlYFxuICAgICAgICAgICAgOiBcIlwiXG4gICAgICAgIH1gLFxuICAgIH07XG4gIH1cblxuICAvLyBBcHBlbmQtb25seSBsZWRnZXJzIOKAlCBgQ0hBTkdFTE9HLm1kYCwgcmVsZWFzZSBub3RlcywgdGhlIGF1ZGl0IGxlZGdlcnMg4oCUXG4gIC8vIGNvbmZsaWN0IG9uIGV2ZXJ5IG1lcmdlIGFuZCBhcmUgbmV2ZXIgYSBqdWRnZW1lbnQ6IGJvdGggc2lkZXMgYXBwZW5kZWQgYW5kXG4gIC8vIG5laXRoZXIgcmVtb3ZlZCBhbnl0aGluZywgc28gYm90aCBlbnRyaWVzIGFyZSBrZXB0IChJc3N1ZSAjMTc2OCkuIERlY2lkZWRcbiAgLy8gbGFzdCBvZiB0aGUgcmVzb2x2YWJsZSBydWxlcywgc28gYSBkdXBsaWNhdGUgZml4IGlzIHN0aWxsIGEgZHVwbGljYXRlIGZpeFxuICAvLyByYXRoZXIgdGhhbiBhbiBpbXBsZW1lbnRhdGlvbiBrZXB0IHR3aWNlLlxuICBpZiAoaXNCb3RoSW5zZXJ0ZWQoZmlsZS5iYXNlLCBvdXJzLCB0aGVpcnMpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGg6IGZpbGUucGF0aCxcbiAgICAgIGNhc2U6IFwiYm90aC1pbnNlcnRlZFwiLFxuICAgICAgYWN0aW9uOiBcInVuaW9uXCIsXG4gICAgICByZWFzb246XG4gICAgICAgIGBib3RoIHNpZGVzIG9ubHkgYWRkZWQgdG8gdGhpcyBmaWxlIOKAlCBldmVyeSBsaW5lIG9mIHRoZSBtZXJnZSBiYXNlIGAgK1xuICAgICAgICBgc3Vydml2ZXMgb24gYm90aCBzaWRlcyDigJQgc28gYm90aCBhZGRpdGlvbnMgYXJlIGtlcHQgYnkgYSB1bmlvbiBgICtcbiAgICAgICAgYG1lcmdlLCB0aGUgZGVmYXVsdCBicmFuY2gncyBmaXJzdGAsXG4gICAgfTtcbiAgfVxuXG4gIHJldHVybiBlc2NhbGF0ZShcbiAgICBmaWxlLnBhdGgsXG4gICAgYGJvdGggc2lkZXMgY2hhbmdlZCB0aGUgc2FtZSBjb2RlIGFuZCBuZWl0aGVyIGNvbnRhaW5zIHRoZSBvdGhlciDigJQgdHdvIGAgK1xuICAgICAgYGRlc2lnbnMgZm9yIHRoZSBzYW1lIHByb2JsZW0sIHdoaWNoIG9ubHkgYSBodW1hbiBjYW4gY2hvb3NlIGJldHdlZW5gLFxuICAgIFwicml2YWwtZGVzaWduc1wiLFxuICApO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgYm90aCBzaWRlcyBvbmx5IGluc2VydGVkOiBldmVyeSBsaW5lIG9mIHRoZSBtZXJnZSBiYXNlIHN1cnZpdmVzIG9uXG4gKiBlYWNoIHNpZGUuXG4gKlxuICogQSBiYXNlIHRoYXQgd2FzIG5vdCByZWFkIChgdW5kZWZpbmVkYCkgb3IgZG9lcyBub3QgZXhpc3QgKGBudWxsYCwgYW4gYWRkL2FkZFxuICogY29uZmxpY3QpIGRlY2lkZXMgbm90aGluZyDigJQgdGhlIHJ1bGUgbmVlZHMgdGhlIGJhc2UgdG8gcHJvdmUgYSBkZWxldGlvbiBkaWRcbiAqIG5vdCBoYXBwZW4sIGFuZCBhbiB1bnJlYWQgYmFzZSBtdXN0IG5ldmVyIHJlYWQgYXMgYW4gZW1wdHkgb25lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gaXNCb3RoSW5zZXJ0ZWQoXG4gIGJhc2U6IHN0cmluZyB8IG51bGwgfCB1bmRlZmluZWQsXG4gIG91cnM6IHN0cmluZyxcbiAgdGhlaXJzOiBzdHJpbmcsXG4pOiBib29sZWFuIHtcbiAgaWYgKHR5cGVvZiBiYXNlICE9PSBcInN0cmluZ1wiKSByZXR1cm4gZmFsc2U7XG4gIHJldHVybiBpc0xpbmVTdXBlcnNldChvdXJzLCBiYXNlKSAmJiBpc0xpbmVTdXBlcnNldCh0aGVpcnMsIGJhc2UpO1xufVxuXG4vKipcbiAqIFdoaWNoIHNpZGUgb2YgYSBkdXBsaWNhdGUgZml4IHRvIGtlZXAsIHNjb3BlZCB0byB0aGUgaXNzdWVzIGJvdGggc2lkZXMgY2l0ZS5cbiAqXG4gKiBPbmx5IHRoZSBjYXNlcyBlYWNoIHNpZGUgd3JvdGUgKipmb3IgdGhvc2UgaXNzdWVzKiogY291bnQuIFBvb2xpbmcgZXZlcnlcbiAqIGNhc2UgZWl0aGVyIGJyYW5jaCBhZGRlZCB3b3VsZCBjb21wYXJlIHR3byBwb3B1bGF0aW9ucyBkb21pbmF0ZWQgYnlcbiAqIHVucmVsYXRlZCBjaHVybiwgYW5kIHRoZSBhbnN3ZXIgd291bGQgYmUgXCJpbmNvbXBhcmFibGVcIiBvbiBldmVyeSByZWFsXG4gKiByZXBvc2l0b3J5LiBFdmlkZW5jZSB0aGF0IGNvdWxkIG5vdCBiZSByZWFkLCBhbmQgZXZpZGVuY2UgdGhhdCBkb2VzIG5vdFxuICogZXhpc3QgYXQgYWxsLCBib3RoIGRlY2lkZSBub3RoaW5nOiBhIHNpZGUgaXMga2VwdCBiZWNhdXNlIGl0cyBjYXNlcyBjb3ZlclxuICogdGhlIG90aGVyJ3MsIG5ldmVyIGJlY2F1c2Ugbm90aGluZyB3YXMgZm91bmQuXG4gKi9cbmZ1bmN0aW9uIGRlY2lkZUR1cGxpY2F0ZUZpeChcbiAgc2hhcmVkOiBudW1iZXJbXSxcbiAgZXZpZGVuY2U6IFRlc3RFdmlkZW5jZSxcbik6IHsgc2lkZTogQ29uZmxpY3RTaWRlIHwgbnVsbDsgd2h5OiBzdHJpbmc7IGRyb3BwZWRDYXNlczogc3RyaW5nW10gfSB7XG4gIGlmICghZXZpZGVuY2UuY29tcGxldGUpIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2lkZTogbnVsbCxcbiAgICAgIHdoeTogXCJ0aGUgY2FzZXMgZWFjaCBzaWRlIHdyb3RlIGZvciBpdCBjb3VsZCBub3QgYmUgcmVhZFwiLFxuICAgICAgZHJvcHBlZENhc2VzOiBbXSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IGNhc2VzRm9yID0gKGFkZGVkOiBSZWNvcmQ8bnVtYmVyLCBzdHJpbmdbXT4pOiBzdHJpbmdbXSA9PiB7XG4gICAgY29uc3QgbmFtZXM6IHN0cmluZ1tdID0gW107XG4gICAgZm9yIChjb25zdCBpc3N1ZSBvZiBzaGFyZWQpIG5hbWVzLnB1c2goLi4uKGFkZGVkW2lzc3VlXSA/PyBbXSkpO1xuICAgIHJldHVybiBuYW1lcztcbiAgfTtcbiAgY29uc3Qgb3Vyc0Nhc2VzID0gY2FzZXNGb3IoZXZpZGVuY2Uub3Vyc0FkZGVkKTtcbiAgY29uc3QgdGhlaXJzQ2FzZXMgPSBjYXNlc0ZvcihldmlkZW5jZS50aGVpcnNBZGRlZCk7XG4gIGlmIChvdXJzQ2FzZXMubGVuZ3RoID09PSAwICYmIHRoZWlyc0Nhc2VzLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiB7XG4gICAgICBzaWRlOiBudWxsLFxuICAgICAgd2h5OiBcIm5laXRoZXIgc2lkZSB3cm90ZSBhIHRlc3QgY2FzZSBmb3IgaXQsIHNvIHRoZXJlIGlzIG5vIGV2aWRlbmNlIFwiICtcbiAgICAgICAgXCJ0aGF0IGVpdGhlciBpbXBsZW1lbnRhdGlvbiBpcyB0aGUgb25lIHRvIGtlZXBcIixcbiAgICAgIGRyb3BwZWRDYXNlczogW10sXG4gICAgfTtcbiAgfVxuICBjb25zdCBvbmx5T3VycyA9IG9ubHkob3Vyc0Nhc2VzLCB0aGVpcnNDYXNlcyk7XG4gIGNvbnN0IG9ubHlUaGVpcnMgPSBvbmx5KHRoZWlyc0Nhc2VzLCBvdXJzQ2FzZXMpO1xuICBpZiAob25seVRoZWlycy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2lkZTogXCJvdXJzXCIsXG4gICAgICB3aHk6IFwiaXRzIGNhc2VzIGZvciB0aGF0IGZpeCBhcmUgYSBzdXBlcnNldCBvZiB0aGUgZGVmYXVsdCBicmFuY2gnc1wiLFxuICAgICAgZHJvcHBlZENhc2VzOiB0aGVpcnNDYXNlcyxcbiAgICB9O1xuICB9XG4gIGlmIChvbmx5T3Vycy5sZW5ndGggPT09IDApIHtcbiAgICByZXR1cm4ge1xuICAgICAgc2lkZTogXCJ0aGVpcnNcIixcbiAgICAgIHdoeTogXCJpdHMgY2FzZXMgZm9yIHRoYXQgZml4IGFyZSBhIHN1cGVyc2V0IG9mIHRoZSBtaWxlc3RvbmUgYnJhbmNoJ3NcIixcbiAgICAgIGRyb3BwZWRDYXNlczogb3Vyc0Nhc2VzLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHtcbiAgICBzaWRlOiBudWxsLFxuICAgIHdoeTogYGVhY2ggc2lkZSB3cm90ZSBjYXNlcyB0aGUgb3RoZXIgZGlkIG5vdCAoJHtcbiAgICAgIG9ubHlPdXJzLmpvaW4oXCIsIFwiKVxuICAgIH0gYWdhaW5zdCAke29ubHlUaGVpcnMuam9pbihcIiwgXCIpfSlgLFxuICAgIGRyb3BwZWRDYXNlczogW10sXG4gIH07XG59XG5cbi8qKlxuICogRGVjaWRlIG9uZSBjb25mbGljdGVkIHBhdGguXG4gKlxuICogQHBhcmFtIGZpbGUgLSBCb3RoIHNpZGVzLCBhcyBnaXQgc3RhZ2VkIHRoZW1cbiAqIEBwYXJhbSBldmlkZW5jZSAtIFRoZSBjYXNlcyBlYWNoIHNpZGUgd3JvdGUgZm9yIHRoZSBpc3N1ZXMgaXQgY2l0ZXNcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNsYXNzaWZ5Q29uZmxpY3RlZEZpbGUoXG4gIGZpbGU6IENvbmZsaWN0ZWRGaWxlLFxuICBldmlkZW5jZTogVGVzdEV2aWRlbmNlID0gRU1QVFlfRVZJREVOQ0UsXG4pOiBGaWxlRGVjaXNpb24ge1xuICBjb25zdCB0ZXN0ID0gaXNUZXN0UGF0aChmaWxlLnBhdGgpO1xuXG4gIGlmIChmaWxlLm91cnMgPT09IG51bGwgJiYgZmlsZS50aGVpcnMgPT09IG51bGwpIHtcbiAgICAvLyBCb3RoIHNpZGVzIGRlbGV0ZWQgaXQsIHlldCBnaXQgY2FsbGVkIGl0IGNvbmZsaWN0ZWQg4oCUIHRoZSBzdGF0ZSBpcyBub3RcbiAgICAvLyBvbmUgdGhpcyB0cmlhZ2UgdW5kZXJzdGFuZHMsIHNvIGl0IGlzIG5vdCBvbmUgaXQgcmVzb2x2ZXMuXG4gICAgcmV0dXJuIGVzY2FsYXRlKFxuICAgICAgZmlsZS5wYXRoLFxuICAgICAgXCJuZWl0aGVyIHNpZGUgaGFzIGEgdmVyc2lvbiBvZiB0aGlzIGZpbGUsIHNvIGdpdCdzIGNvbmZsaWN0IGNhbm5vdCBiZSBcIiArXG4gICAgICAgIFwicmVhZCBhcyBhIGNob2ljZSBiZXR3ZWVuIHR3byBzaWRlc1wiLFxuICAgICk7XG4gIH1cbiAgaWYgKGZpbGUudGhlaXJzID09PSBudWxsKSB7XG4gICAgaWYgKHRlc3QpIHtcbiAgICAgIHJldHVybiBlc2NhbGF0ZShcbiAgICAgICAgZmlsZS5wYXRoLFxuICAgICAgICBcInRoZSBkZWZhdWx0IGJyYW5jaCBkZWxldGVkIHRoaXMgdGVzdCBmaWxlIHdoaWxlIHRoZSBtaWxlc3RvbmUgXCIgK1xuICAgICAgICAgIFwiYnJhbmNoIGVkaXRlZCBpdCDigJQgZGVsZXRpbmcgaXQgaGVyZSB3b3VsZCBkcm9wIGl0cyBjYXNlcywgYW5kIFwiICtcbiAgICAgICAgICBcImtlZXBpbmcgaXQgd291bGQgcmV2aXZlIGEgZmlsZSB0aGUgZGVmYXVsdCBicmFuY2ggcmVtb3ZlZFwiLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHtcbiAgICAgIHBhdGg6IGZpbGUucGF0aCxcbiAgICAgIGNhc2U6IFwiaW5jb21pbmctZGVsZXRlXCIsXG4gICAgICBhY3Rpb246IFwidGhlaXJzXCIsXG4gICAgICByZWFzb246XG4gICAgICAgIFwidGhlIGRlZmF1bHQgYnJhbmNoIGRlbGV0ZWQgdGhpcyBmaWxlLCBzbyB0aGUgZGVsZXRpb24gc3RhbmRzIHJhdGhlciBcIiArXG4gICAgICAgIFwidGhhbiByZXZpdmluZyByZW1vdmVkIGNvZGUgKElzc3VlICMxMDQ4KVwiLFxuICAgIH07XG4gIH1cbiAgaWYgKGZpbGUub3VycyA9PT0gbnVsbCkge1xuICAgIHJldHVybiBlc2NhbGF0ZShcbiAgICAgIGZpbGUucGF0aCxcbiAgICAgIFwidGhlIG1pbGVzdG9uZSBicmFuY2ggZGVsZXRlZCB0aGlzIGZpbGUgYW5kIHRoZSBkZWZhdWx0IGJyYW5jaCBlZGl0ZWQgXCIgK1xuICAgICAgICBcIml0IOKAlCBrZWVwaW5nIGl0IHJldml2ZXMgd2hhdCB0aGUgYnJhbmNoIHJlbW92ZWQsIGRlbGV0aW5nIGl0IGRyb3BzIFwiICtcbiAgICAgICAgXCJ0aGUgZGVmYXVsdCBicmFuY2gncyBjaGFuZ2VcIixcbiAgICApO1xuICB9XG5cbiAgcmV0dXJuIHRlc3RcbiAgICA/IGNsYXNzaWZ5VGVzdEZpbGUoZmlsZS5wYXRoLCBmaWxlLm91cnMsIGZpbGUudGhlaXJzKVxuICAgIDogY2xhc3NpZnlTb3VyY2VGaWxlKGZpbGUsIGZpbGUub3VycywgZmlsZS50aGVpcnMsIGV2aWRlbmNlKTtcbn1cblxuLyoqXG4gKiBUaGUgY2FzZXMgZWFjaCBzaWRlIHdyb3RlIGZvciB0aGUgaXNzdWVzIGl0cyBjb21taXRzIGNpdGUsIHNpbmNlIHRoZSBtZXJnZVxuICogYmFzZS5cbiAqXG4gKiBBIGR1cGxpY2F0ZSBmaXggaXMgbm90IGRlY2lkZWQgYnkgdGhlIGNvbmZsaWN0ZWQgZmlsZXMgYWxvbmU6IHRoZSBicmFuY2hcbiAqIGZpeGVkICMxMjcwIGFuZCB3cm90ZSBpdHMgY2FzZSBpbiBhIHRlc3QgZmlsZSB0aGUgZGVmYXVsdCBicmFuY2ggbmV2ZXJcbiAqIHRvdWNoZWQsIHNvIG5vdGhpbmcgYWJvdXQgdGhhdCBjYXNlIGNvbmZsaWN0cyBhbmQgaXQgaXMgaW52aXNpYmxlIHRvIGFcbiAqIGZpbGUtYnktZmlsZSB2aWV3LiBLZXllZCBieSBpc3N1ZSBzbyB0aGUgY29tcGFyaXNvbiBzdGF5cyBzY29wZWQgdG8gdGhlXG4gKiBmaXggdGhhdCBsYW5kZWQgdHdpY2UgcmF0aGVyIHRoYW4gdG8gZXZlcnkgdW5yZWxhdGVkIGNhc2UgZWl0aGVyIGJyYW5jaFxuICogYWRkZWQgaW4gdGhlIG1lYW50aW1lLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFRlc3RFdmlkZW5jZSB7XG4gIC8qKiBDYXNlcyB0aGUgbWlsZXN0b25lIGJyYW5jaCBhZGRlZCwga2V5ZWQgYnkgdGhlIGlzc3VlIHRoZXkgd2VyZSBmb3IuICovXG4gIG91cnNBZGRlZDogUmVjb3JkPG51bWJlciwgc3RyaW5nW10+O1xuICAvKiogQ2FzZXMgdGhlIGRlZmF1bHQgYnJhbmNoIGFkZGVkLCBrZXllZCBieSB0aGUgaXNzdWUgdGhleSB3ZXJlIGZvci4gKi9cbiAgdGhlaXJzQWRkZWQ6IFJlY29yZDxudW1iZXIsIHN0cmluZ1tdPjtcbiAgLyoqXG4gICAqIEZhbHNlIHdoZW4gZ2l0IHJlZnVzZWQgc29tZSBwYXJ0IG9mIHRoZSBldmlkZW5jZS4gVW5yZWFkIGV2aWRlbmNlXG4gICAqIGRlY2lkZXMgbm90aGluZyDigJQgaXQgbmV2ZXIgcmVhZHMgYXMgXCJuZWl0aGVyIHNpZGUgd3JvdGUgYSBjYXNlXCIuXG4gICAqL1xuICBjb21wbGV0ZTogYm9vbGVhbjtcbn1cblxuLyoqIE5vIGV2aWRlbmNlLCBob25lc3RseSBsYWJlbGxlZCBhcyByZWFkICh0aGUgY2FsbGVyIHN1cHBsaWVkIG5vbmUpLiAqL1xuY29uc3QgRU1QVFlfRVZJREVOQ0U6IFRlc3RFdmlkZW5jZSA9IHtcbiAgb3Vyc0FkZGVkOiB7fSxcbiAgdGhlaXJzQWRkZWQ6IHt9LFxuICBjb21wbGV0ZTogdHJ1ZSxcbn07XG5cbi8qKlxuICogUGxhbiB0aGUgcmVzb2x1dGlvbiBvZiBhIGNvbmZsaWN0ZWQgc3luYyBtZXJnZS5cbiAqXG4gKiBAcGFyYW0gZmlsZXMgLSBFdmVyeSBjb25mbGljdGVkIHBhdGgsIHdpdGggYm90aCBzaWRlc1xuICogQHBhcmFtIGV2aWRlbmNlIC0gVGhlIGNhc2VzIGVhY2ggc2lkZSB3cm90ZSBmb3IgdGhlIGlzc3VlcyBpdCBjaXRlc1xuICogQHJldHVybnMgV2hhdCByZXNvbHZlcywgd2hhdCBkb2VzIG5vdCwgYW5kIHdoeSBpbiBib3RoIGNhc2VzXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBwbGFuQ29uZmxpY3RSZXNvbHV0aW9uKFxuICBmaWxlczogQ29uZmxpY3RlZEZpbGVbXSxcbiAgZXZpZGVuY2U6IFRlc3RFdmlkZW5jZSA9IEVNUFRZX0VWSURFTkNFLFxuKTogQ29uZmxpY3RQbGFuIHtcbiAgY29uc3QgZGVjaXNpb25zID0gZmlsZXMubWFwKChmaWxlKSA9PiBjbGFzc2lmeUNvbmZsaWN0ZWRGaWxlKGZpbGUsIGV2aWRlbmNlKSk7XG4gIHJldHVybiB7XG4gICAgZGVjaXNpb25zLFxuICAgIHJlc29sdmVkOiBkZWNpc2lvbnMuZmlsdGVyKChkKSA9PiBkLmFjdGlvbiAhPT0gXCJlc2NhbGF0ZVwiKSxcbiAgICBlc2NhbGF0aW9uczogZGVjaXNpb25zLmZpbHRlcigoZCkgPT4gZC5hY3Rpb24gPT09IFwiZXNjYWxhdGVcIiksXG4gIH07XG59XG5cbi8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuLy8gV2hhdCB0aGUgcmVhZGVyIGlzIGhhbmRlZFxuLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG5cbi8qKiBQcmVwYXJlIGJvdGggc2lkZXMgb2YgYSBmaWxlIGEgaHVtYW4gaGFzIHRvIGRlY2lkZS4gKi9cbmV4cG9ydCBmdW5jdGlvbiBhbmFseXNlQ29uZmxpY3RlZEZpbGUoXG4gIGZpbGU6IENvbmZsaWN0ZWRGaWxlLFxuICByZWFzb246IHN0cmluZyxcbik6IEZpbGVBbmFseXNpcyB7XG4gIGNvbnN0IG91cnNUZXN0cyA9IGV4dHJhY3RUZXN0TmFtZXMoZmlsZS5vdXJzID8/IFwiXCIpO1xuICBjb25zdCB0aGVpcnNUZXN0cyA9IGV4dHJhY3RUZXN0TmFtZXMoZmlsZS50aGVpcnMgPz8gXCJcIik7XG4gIHJldHVybiB7XG4gICAgcGF0aDogZmlsZS5wYXRoLFxuICAgIHJlYXNvbixcbiAgICBvdXJzRXhwb3J0czogZXh0cmFjdEV4cG9ydHMoZmlsZS5vdXJzID8/IFwiXCIpLFxuICAgIHRoZWlyc0V4cG9ydHM6IGV4dHJhY3RFeHBvcnRzKGZpbGUudGhlaXJzID8/IFwiXCIpLFxuICAgIG91cnNUZXN0cyxcbiAgICB0aGVpcnNUZXN0cyxcbiAgICBvbmx5T3Vyc1Rlc3RzOiBvbmx5KG91cnNUZXN0cywgdGhlaXJzVGVzdHMpLFxuICAgIG9ubHlUaGVpcnNUZXN0czogb25seSh0aGVpcnNUZXN0cywgb3Vyc1Rlc3RzKSxcbiAgfTtcbn1cblxuLyoqIFJlbmRlciBhIGxpc3QgZm9yIGEgY29tbWVudCwgb3Igc2F5IHBsYWlubHkgdGhhdCBpdCBpcyBlbXB0eS4gKi9cbmZ1bmN0aW9uIGJ1bGxldHMoaXRlbXM6IHN0cmluZ1tdLCBlbXB0eTogc3RyaW5nKTogc3RyaW5nIHtcbiAgcmV0dXJuIGl0ZW1zLmxlbmd0aFxuICAgID8gaXRlbXMubWFwKChpKSA9PiBgICAtIFxcYCR7aX1cXGBgKS5qb2luKFwiXFxuXCIpXG4gICAgOiBgICAtICR7ZW1wdHl9YDtcbn1cblxuLyoqXG4gKiBOYW1lIHRoZSBydW5nIHRoYXQgc2V0dGxlZCBhIGRlY2lzaW9uLCBmb3IgZXZlcnkgc3VyZmFjZSB0aGF0IHJlcG9ydHMgaXQuXG4gKlxuICogT25lIHdvcmRpbmcsIHRocmVlIHJlYWRlcnMgKElzc3VlICMxNzc3KTogdGhlIG1lcmdlIGNvbW1pdCwgdGhlIHN5bmMncyBsb2dcbiAqIGxpbmUgYW5kIHRoZSByZXBvcnQgY29tbWVudCBhbGwgc2F5IGB0cmlhZ2U6IDxjYXNlPmAsIGBydWxlOiA8cmVhc29uPmAgb3JcbiAqIGBhZ2VudGAsIHNvIGEgZmlsZSdzIHJlc29sdXRpb24gcmVhZHMgdGhlIHNhbWUgd2hlcmV2ZXIgaXQgaXMgZm91bmQuXG4gKlxuICogQHBhcmFtIGQgLSBUaGUgZGVjaXNpb24gdG8gZGVzY3JpYmVcbiAqIEBwYXJhbSBzaWRlcyAtIEhvdyB0byBuYW1lIGVhY2ggc2lkZSwgYXMgdGhhdCBzdXJmYWNlIHdyaXRlcyBicmFuY2ggbmFtZXNcbiAqIEByZXR1cm5zIE9uZSBsaW5lLCB3aXRob3V0IGEgbGVhZGluZyBidWxsZXRcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGRlc2NyaWJlRGVjaXNpb25SdW5nKFxuICBkOiBGaWxlRGVjaXNpb24sXG4gIHNpZGVzOiB7IG91cnM6IHN0cmluZzsgdGhlaXJzOiBzdHJpbmcgfSxcbik6IHN0cmluZyB7XG4gIGlmIChkLnJ1bmcgPT09IFwicnVsZVwiKSByZXR1cm4gYHJ1bGU6ICR7ZC5yZWFzb259YDtcbiAgaWYgKGQucnVuZyA9PT0gXCJwb3J0ZWRcIikgcmV0dXJuIGBwb3J0ZWQ6ICR7ZC5yZWFzb259YDtcbiAgaWYgKGQucnVuZyA9PT0gXCJhZ2VudFwiKSByZXR1cm4gXCJhZ2VudFwiO1xuICBjb25zdCBob3cgPSBkLmFjdGlvbiA9PT0gXCJ1bmlvblwiXG4gICAgPyBcImtlcHQgYm90aCBzaWRlcycgaHVua3NcIlxuICAgIDogZC5hY3Rpb24gPT09IFwicmVzb2x2ZWRcIlxuICAgID8gXCJ0aGUgcmVzb2x1dGlvbiB3YXMgYWxyZWFkeSBpbiB0aGUgdHJlZVwiXG4gICAgOiBgdG9vayB0aGUgJHtkLmFjdGlvbiA9PT0gXCJvdXJzXCIgPyBzaWRlcy5vdXJzIDogc2lkZXMudGhlaXJzfSBzaWRlYDtcbiAgcmV0dXJuIGB0cmlhZ2U6ICR7ZC5jYXNlfSwgJHtob3d9OiAke2QucmVhc29ufWA7XG59XG5cbi8qKlxuICogVGhlIGxhYmVscyBvZiB0aGUgbm90ZXMgYSBtaWxlc3RvbmUgc3luYydzIHB1c2ggY2FycmllcyB3aGVuIGEgY2hlY2sgZGlkIG5vdFxuICogcnVuIChgZ2F0ZVRoZW5QdXNoTWlsZXN0b25lQnJhbmNoYCBpbiBnaXRfcHVsbC50cykuIFRoZSByZXNvbHV0aW9uIGNvbW1pdFxuICogbWVzc2FnZSBuYW1lcyBldmVyeSBvbmUsIHNvIGFkZGluZyBhIGxhYmVsIGhlcmUgYWRkcyBpdCB0aGVyZSAoSXNzdWUgIzQ0NDEpLlxuICovXG5leHBvcnQgY29uc3QgU1lOQ19VTkNIRUNLRURfTk9URSA9IHtcbiAgdW5nYXRlZDogXCJVTkdBVEVEXCIsXG4gIGNoZWNrTGVmdFRvQ2k6IFwiQ0hFQ0sgTEVGVCBUTyBDSVwiLFxuICBzdWl0ZUxlZnRUb0NpOiBcIlRFU1RTIExFRlQgVE8gQ0lcIixcbiAgY2FyZ29Ta2lwcGVkOiBcIkNBUkdPIFNLSVBQRURcIixcbn0gYXMgY29uc3Q7XG5cbi8qKlxuICogVGhlIG1lcmdlIGNvbW1pdCdzIG1lc3NhZ2UgZm9yIGEgY29uZmxpY3QgdGhlIHdvcmtlciByZXNvbHZlZCBpdHNlbGYuXG4gKlxuICogRXZlcnkgZGVjaXNpb24gaXMgbmFtZWQgd2l0aCBpdHMgcmVhc29uaW5nLCBiZWNhdXNlIHRoZSBjb21taXQgaXMgd2hlcmVcbiAqIHdob2V2ZXIgcmVhZHMgdGhpcyBicmFuY2ggbW9udGhzIGxhdGVyIHdpbGwgbG9vayDigJQgbm90IHRoZSBydW4gbG9nLCB3aGljaFxuICogaXMgZ29uZSBieSB0aGVuLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRSZXNvbHV0aW9uQ29tbWl0TWVzc2FnZShvOiB7XG4gIGRlZmF1bHRCcmFuY2g6IHN0cmluZztcbiAgbWlsZXN0b25lQnJhbmNoOiBzdHJpbmc7XG4gIHBsYW46IENvbmZsaWN0UGxhbjtcbn0pOiBzdHJpbmcge1xuICBjb25zdCBsaW5lcyA9IG8ucGxhbi5yZXNvbHZlZC5tYXAoKGQpID0+XG4gICAgYC0gXFxgJHtkLnBhdGh9XFxgIOKAlCAke1xuICAgICAgZGVzY3JpYmVEZWNpc2lvblJ1bmcoZCwge1xuICAgICAgICBvdXJzOiBcIm1pbGVzdG9uZSBicmFuY2gnc1wiLFxuICAgICAgICB0aGVpcnM6IGAnJHtvLmRlZmF1bHRCcmFuY2h9J2AsXG4gICAgICB9KVxuICAgIH1gXG4gICk7XG4gIGNvbnN0IG4gPSBTWU5DX1VOQ0hFQ0tFRF9OT1RFO1xuICByZXR1cm4gYE1lcmdlICcke28uZGVmYXVsdEJyYW5jaH0nIGludG8gJyR7by5taWxlc3RvbmVCcmFuY2h9JyDigJQgJHtvLnBsYW4ucmVzb2x2ZWQubGVuZ3RofSBjb25mbGljdChzKSByZXNvbHZlZCBhdXRvbWF0aWNhbGx5XFxuXFxuYCArXG4gICAgYCR7bGluZXMuam9pbihcIlxcblwiKX1cXG5cXG5gICtcbiAgICBgRWFjaCByZXNvbHV0aW9uIHdhcyB2ZXJpZmllZCBiZWZvcmUgaXQgd2FzIHB1c2hlZDogdGhlIG1lcmdlZCB0cmVlIGAgK1xuICAgIGBwYXNzZXMgdGhlIHJlcG9zaXRvcnkncyBvd24gY2hlY2ssIGl0cyBtYW5pZmVzdCBjaGVjayBhbmQgaXRzIHVuaXQgYCArXG4gICAgYHN1aXRlLCB1bmxlc3MgdGhlIHN5bmMncyBub3RlIHNheXMgJHtuLnVuZ2F0ZWR9LCAke24uY2hlY2tMZWZ0VG9DaX0sIGAgK1xuICAgIGAke24uc3VpdGVMZWZ0VG9DaX0gb3IgJHtuLmNhcmdvU2tpcHBlZH0uIEVhY2ggb2YgdGhvc2UgbWVhbnMgYSBjaGVjayBgICtcbiAgICBgZGlkIG5vdCBydW4uICR7bi51bmdhdGVkfSBtZWFucyBhIGNhcmdvLW9ubHkgbWVyZ2Utb25seSBzeW5jIChJc3N1ZSBgICtcbiAgICBgIzQzMjYpIGxlZnQgdGhlIHdob2xlIGJ1aWxkIHRvIHRoZSBtaWxlc3RvbmUgUFIncyBDSS4gYCArXG4gICAgYCR7bi5jaGVja0xlZnRUb0NpfSBtZWFucyB0aGUgaG9zdCBjb3VsZCBub3QgcmVhY2ggYSBEZW5vIHByb2plY3QncyBgICtcbiAgICBgbW9kdWxlIGhvc3QsIHNvIHRoYXQgcHJvamVjdCdzIHR5cGUgY2hlY2sgd2FzIGxlZnQgdG8gdGhhdCBDSSAoSXNzdWUgYCArXG4gICAgYCM0NDQxKS4gJHtuLnN1aXRlTGVmdFRvQ2l9IG1lYW5zIGEgRGVubyB0YXNrIG9mIHRoZSByZXNvbHV0aW9uIGdhdGUgd2FzIGAgK1xuICAgIGBsZWZ0IHRvIHRoYXQgQ0kgZm9yIHRoZSBzYW1lIHJlYXNvbiAoSXNzdWUgIzQ0MjIpLiAke24uY2FyZ29Ta2lwcGVkfSBgICtcbiAgICBgbWVhbnMgdGhlIGNoZWNrcyB0aGF0IHJhbiBwYXNzZWQgYW5kIGNhcmdvIGRpZCBub3QgY29tcGxldGU6IGl0IHdhcyBza2lwcGVkIGAgK1xuICAgIGBmb3IgdGhlIGhvc3QncyBidWRnZXQgKElzc3VlICM0MzI2KSBvciBhIGNhcmdvIGNoZWNrIG9yIGNhcmdvIHRlc3QgdGltZWQgb3V0IG9yIGAgK1xuICAgIGBjb3VsZCBub3QgcmVhY2ggdGhlIGNyYXRlIHJlZ2lzdHJ5IChJc3N1ZSAjNDc4NiksIGFuZCB3YXMgbGVmdCB0byB0aGF0IENJLiBOb25lIG9mIHRoZW0gYCArXG4gICAgYG1lYW5zIHRoZSBjaGVjayBpdCBuYW1lcyBwYXNzZWQuIE5vIGAgK1xuICAgIGBjb25mbGljdGVkIHRlc3QgZmlsZSB3YXMgcmVzb2x2ZWQgYnkgdGFraW5nIGEgc2lkZSB0aGF0IGRyb3BzIGNhc2VzIGAgK1xuICAgIGAoSXNzdWUgIzE1NTkpLmA7XG59XG5cbi8qKlxuICogVGhlIGVzY2FsYXRpb24gZm9yIGEgY29uZmxpY3Qgb25seSBhIGh1bWFuIGNhbiByZXNvbHZlLlxuICpcbiAqIEl0IGNhcnJpZXMgdGhlIHByZXBhcmF0aW9uIHJhdGhlciB0aGFuIHRoZSBjb21waWxlciBvdXRwdXQ6IHdoYXQgZWFjaCBzaWRlXG4gKiBleHBvcnRzLCB3aGF0IGVhY2ggc2lkZSB0ZXN0cywgYW5kIHdoaWNoIGNhc2VzIGV4aXN0IG9uIG9uZSBzaWRlIG9ubHkuIFRoYXRcbiAqIGlzIG1vc3Qgb2YgdGhlIGhvdXIgdGhlIHJlYWRlciB3b3VsZCBvdGhlcndpc2Ugc3BlbmQgYmVmb3JlIHRoZXkgY2FuIGRlY2lkZVxuICogYW55dGhpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBidWlsZENvbmZsaWN0QW5hbHlzaXNDb21tZW50KGU6IHtcbiAgcmVwbzogc3RyaW5nO1xuICBtaWxlc3RvbmVCcmFuY2g6IHN0cmluZztcbiAgZGVmYXVsdEJyYW5jaDogc3RyaW5nO1xuICBhbmFseXNlczogRmlsZUFuYWx5c2lzW107XG4gIHJlc29sdmVkOiBGaWxlRGVjaXNpb25bXTtcbiAgLyoqIFdoYXQgdGhlIHZlcmlmaWNhdGlvbiBzYWlkLCB3aGVuIGl0IGlzIHdoYXQgcmVmdXNlZCB0aGUgcmVzb2x1dGlvbi4gKi9cbiAgZ2F0ZUZhaWx1cmU/OiBzdHJpbmc7XG59KTogc3RyaW5nIHtcbiAgY29uc3Qgc2VjdGlvbnMgPSBlLmFuYWx5c2VzLm1hcCgoYSkgPT5cbiAgICBgIyMjIFxcYCR7YS5wYXRofVxcYFxcblxcbmAgK1xuICAgIGAke2EucmVhc29ufS5cXG5cXG5gICtcbiAgICBgLSBFeHBvcnRzIG9uIFxcYCR7ZS5taWxlc3RvbmVCcmFuY2h9XFxgOlxcbiR7XG4gICAgICBidWxsZXRzKGEub3Vyc0V4cG9ydHMsIFwibm9uZSBmb3VuZFwiKVxuICAgIH1cXG5gICtcbiAgICBgLSBFeHBvcnRzIG9uIFxcYCR7ZS5kZWZhdWx0QnJhbmNofVxcYDpcXG4ke1xuICAgICAgYnVsbGV0cyhhLnRoZWlyc0V4cG9ydHMsIFwibm9uZSBmb3VuZFwiKVxuICAgIH1cXG5gICtcbiAgICBgLSBUZXN0IGNhc2VzIG9uIFxcYCR7ZS5taWxlc3RvbmVCcmFuY2h9XFxgOlxcbiR7XG4gICAgICBidWxsZXRzKGEub3Vyc1Rlc3RzLCBcIm5vbmUgZm91bmRcIilcbiAgICB9XFxuYCArXG4gICAgYC0gVGVzdCBjYXNlcyBvbiBcXGAke2UuZGVmYXVsdEJyYW5jaH1cXGA6XFxuJHtcbiAgICAgIGJ1bGxldHMoYS50aGVpcnNUZXN0cywgXCJub25lIGZvdW5kXCIpXG4gICAgfVxcbmAgK1xuICAgIGAtIENhc2VzIG9ubHkgb24gXFxgJHtlLm1pbGVzdG9uZUJyYW5jaH1cXGA6XFxuJHtcbiAgICAgIGJ1bGxldHMoYS5vbmx5T3Vyc1Rlc3RzLCBcIm5vbmVcIilcbiAgICB9XFxuYCArXG4gICAgYC0gQ2FzZXMgb25seSBvbiBcXGAke2UuZGVmYXVsdEJyYW5jaH1cXGA6XFxuJHtcbiAgICAgIGJ1bGxldHMoYS5vbmx5VGhlaXJzVGVzdHMsIFwibm9uZVwiKVxuICAgIH1gXG4gICkuam9pbihcIlxcblxcblwiKTtcblxuICBjb25zdCByZXNvbHZlZE5vdGUgPSBlLnJlc29sdmVkLmxlbmd0aFxuICAgID8gYFxcblxcblRoZSBzYW1lIG1lcmdlIHJlc29sdmVkICR7ZS5yZXNvbHZlZC5sZW5ndGh9IG90aGVyIGZpbGUocykgb24gaXRzIGAgK1xuICAgICAgYG93biDigJQgdGhvc2UgZGVjaXNpb25zIHdlcmUgZGlzY2FyZGVkIHdpdGggdGhlIG1lcmdlIGFuZCB3aWxsIGJlIGAgK1xuICAgICAgYHJldGFrZW4gb25jZSB0aGUgZmlsZXMgYWJvdmUgYXJlIHNldHRsZWQ6XFxuXFxuJHtcbiAgICAgICAgZS5yZXNvbHZlZC5tYXAoKGQpID0+IGAtIFxcYCR7ZC5wYXRofVxcYCDigJQgJHtkLmNhc2V9OiAke2QucmVhc29ufWApXG4gICAgICAgICAgLmpvaW4oXCJcXG5cIilcbiAgICAgIH1gXG4gICAgOiBcIlwiO1xuXG4gIGNvbnN0IGdhdGVOb3RlID0gZS5nYXRlRmFpbHVyZVxuICAgID8gYFRoZSBjb25mbGljdCBpdHNlbGYgKip3YXMqKiByZXNvbHZlZCBhdXRvbWF0aWNhbGx5LCBhbmQgdGhlIGAgK1xuICAgICAgYHZlcmlmaWNhdGlvbiB0aGVuIHJlZnVzZWQgdGhlIHJlc3VsdCDigJQgc28gdGhlIHJlc29sdXRpb24gd2FzIHJvbGxlZCBgICtcbiAgICAgIGBiYWNrLiBXaGF0IHRoZSB2ZXJpZmljYXRpb24gc2FpZDpcXG5cXG5cXGBcXGBcXGBcXG4ke2UuZ2F0ZUZhaWx1cmV9XFxuXFxgXFxgXFxgXFxuXFxuYFxuICAgIDogXCJcIjtcblxuICByZXR1cm4gYCMjIE1pbGVzdG9uZSBzeW5jIGNvbmZsaWN0IOKAlCBib3RoIHNpZGVzIHByZXBhcmVkXFxuXFxuYCArXG4gICAgYE1lcmdpbmcgXFxgJHtlLmRlZmF1bHRCcmFuY2h9XFxgIGludG8gXFxgJHtlLm1pbGVzdG9uZUJyYW5jaH1cXGAgaW4gYCArXG4gICAgYFxcYCR7ZS5yZXBvfVxcYCBjb25mbGljdGVkIGluIGEgd2F5IG5vIGF1dG9tYXRpYyBydWxlIGNhbiByZXNvbHZlIGAgK1xuICAgIGAoSXNzdWUgIzE1NTkpLiBOb3RoaW5nIGhhcyBiZWVuIHB1c2hlZCBhbmQgXFxgJHtlLm1pbGVzdG9uZUJyYW5jaH1cXGAgaXMgYCArXG4gICAgYGV4YWN0bHkgYXMgaXQgd2FzLlxcblxcbiR7Z2F0ZU5vdGV9YCArXG4gICAgYCR7c2VjdGlvbnN9JHtyZXNvbHZlZE5vdGV9XFxuXFxuYCArXG4gICAgYFRoZSBzeW5jIGtlZXBzIGF0dGVtcHRpbmcgdGhlIHJlc29sdXRpb24gZWFjaCBjeWNsZSBhbmQgbGFuZHMgb24gaXRzIGAgK1xuICAgIGBvd24gb25jZSB0aGVzZSBmaWxlcyBzdG9wIGJlaW5nIHR3byBkZXNpZ25zIGZvciB0aGUgc2FtZSBwcm9ibGVtIOKAlCBhIGAgK1xuICAgIGBjb25mbGljdCBpcyB0aGUgd29ya2VyJ3MgdG8gcmVzb2x2ZSwgbmV2ZXIgYSBodW1hbidzIChJc3N1ZSAjMjM4OCkuYDtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0FzQ0MsR0FFRCx3REFBd0QsR0F1SHhELGlFQUFpRSxHQUNqRSxPQUFPLE1BQU0sc0NBQ1gsOEJBQThCO0FBRWhDOzs7Ozs7Q0FNQyxHQUNELE9BQU8sTUFBTSxvQ0FBb0M7Ozs7Ozs7RUFDN0IsS0FBMkM7RUFDN0QsWUFDRSxPQUFlLEVBQ2YsaURBQWlELEdBQ2pELEFBQVMsUUFB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
// denoCacheMetadata=9289688991818931504,6019456305749654343