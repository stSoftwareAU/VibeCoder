/**
 * Security-fix patch-verification gate (Issue #3540, gap G4).
 *
 * VibeCoder's scans are detect-only: a finding is filed as a `security`
 * -labelled issue and the fix rides the normal `work-on` PR. That PR has no
 * vulnerability-specific gate, so nothing guarantees a regression test
 * reproduces the flaw, nor that the original trigger is actually closed — the
 * static analogue of Anthropic `/patch`'s "PoC no longer fires / no bypass"
 * and Visa VVAH S11's adversarial validation panel.
 *
 * This module is the lightweight per-repo gate (Issue #3239 — no cross-repo
 * centralisation). It activates only when the PR closes a security finding
 * (the issue carries the `security` label, or the PR summary references a
 * `SEC-<hex>` finding id) and then requires machine-checked evidence plus one
 * self-reported statement:
 *
 * **Machine-checkable (the gate proper, Issue #3652)** — asserted against the
 * branch diff, which the agent cannot satisfy by writing prose:
 *
 *  1. the diff **adds or modifies a test file**; and
 *  2. a **test identifier named in the PR summary actually names a test
 *     declared** in the added lines of that test diff — matched on whole
 *     tokens of a test-declaration line, with generic tokens (`test`, `spec`,
 *     `case`, …) rejected outright, so neither the `test` inside `Deno.test`
 *     nor a name borrowed from an assertion body satisfies it (Issue #1279);
 *     and
 *  3. **the cited test discriminates the fix (Issue #3659)** — the worker, not
 *     the agent, executed the cited test twice in a disposable checkout: once
 *     against the base branch's versions of the changed non-test files (it must
 *     FAIL) and once at the head (it must PASS). Only a red → green record
 *     satisfies it; green → green, red → red and green → red all block, and a
 *     run the worker could not perform is `discrimination-not-checked`, never
 *     counted as the red run. This check is only due once items 1 and 2 hold,
 *     because it needs a test that exists and is named.
 *
 * The earlier prose requirement — a summary sentence linking the regression
 * test to a fail-before/pass-after result — was dropped in Issue #3659: the
 * executed record in item 3 replaces it, and a sentence written by the party
 * the evidence is about proved nothing the run did not.
 *
 * **Self-reported prose (a human-review aid)** — only the original-trigger-
 * closed statement remains. The summary is written by the same party the
 * evidence is about, and the finding body that steers it is untrusted input,
 * so it is treated as untrusted text here (bounded regexes over a capped
 * slice, never executed).
 *
 * Aligns with the "fail loud / never mask a fault as success" principle
 * (Issue #3234): a security-fix PR that cannot show the fault is genuinely
 * closed must not sail through as a clean success — including when the diff
 * evidence could not be collected at all.
 *
 * Pure functions, no I/O (the discrimination record is produced elsewhere and
 * passed in). Australian English throughout.
 */ import { codeFenceFor, scrubUntrustedText } from "./prompt_delimiter.ts";
/** Cap on untrusted text scanned by the gate's regexes (defence in depth). */ const MAX_SCAN_CHARS = 200_000;
/** Stable `SEC-<hex>` finding id, e.g. `SEC-a1b2c3d4e5f6` (Issue #1938). */ const FINDING_ID_PATTERN = /\bSEC-[0-9a-f]{6,}\b/i;
/**
 * Original trigger closed with no trivial bypass — the static analogue of
 * "a fresh find agent cannot bypass" / VVAH S11 adoption scoring.
 */ const TRIGGER_CLOSED = /\bno\s+(trivial\s+)?bypass\b|\b(cannot|can't|unable to|prevents?|blocks?|rejects?|neutralis\w+|mitigat\w+)\b[\s\S]{0,60}\bbypass\b|\boriginal\s+(trigger|attack|input|vector|payload|poc|exploit|request)\b|\btrigger\s+is\s+(now\s+)?closed\b|\bno longer\s+(fires|triggers|exploitable|vulnerable)\b|\bclose[sd]?\s+the\s+(original\s+)?(trigger|attack|vector|hole|vulnerability)\b/i;
/** Path shapes that count as a test file across this fleet's ecosystems. */ const TEST_PATH_PATTERNS = [
  /(^|\/)tests?\//i,
  /_test\.[a-z]+$/i,
  /\.test\.[a-z]+$/i,
  /\.spec\.[a-z]+$/i,
  /(^|\/)test_[^/]+\.[a-z]+$/i,
  /\.bats$/i,
  /(^|\/)cypress\//i,
  /Test\.java$/
];
/** Whether a repo-relative path is a test file. */ export function isTestFilePath(path) {
  const trimmed = path.trim();
  if (!trimmed) return false;
  return TEST_PATH_PATTERNS.some((pattern)=>pattern.test(trimmed));
}
/**
 * Test identifiers cited in a PR summary. Bounded patterns only — the summary
 * is untrusted text.
 */ const TEST_IDENTIFIER_PATTERNS = [
  // `tests/foo_test.ts::rejects_injection` — the documented citation form.
  /::\s*([A-Za-z0-9_][A-Za-z0-9_.\-]{2,120})/g,
  // `tests/foo.bats::"handles empty input"` — quoted names may hold spaces.
  /::\s*["'`]([^\n"'`]{3,160})["'`]/g,
  // An inline test declaration quoted in the summary.
  /\b(?:Deno\.test|@test|it|test)\s*\(?\s*["'`]([^"'`\n]{3,160})["'`]/g
];
/**
 * The whole name after a `::` citation, up to the closing backtick or the end of
 * the line, so a spaced name (`foo_test.ts::sanitise - rejects traversal`) is
 * read in full rather than as its first word (PR #3921 review). No `\s*` before
 * the class: the capture is trimmed by {@link normalise}.
 */ const FULL_CITED_NAME_PATTERN = /::([^`\n]{3,200})/g;
/** Lowercase and collapse punctuation so `a_b` and `a b` compare equal. */ function normalise(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
/**
 * Minimum length of a normalised identifier (Issue #1279). Four characters
 * admitted every generic token in the fleet's test vocabulary.
 */ const MIN_IDENTIFIER_LENGTH = 6;
/**
 * Tokens that name no particular test (Issue #1279). An identifier built only
 * from these — `test`, `test_case`, `it should` — cites nothing checkable, so
 * it is dropped rather than matched against the diff.
 */ const GENERIC_IDENTIFIER_TOKENS = new Set([
  "test",
  "tests",
  "spec",
  "specs",
  "deno",
  "case",
  "cases",
  "it",
  "should",
  "todo"
]);
/** Whether a normalised candidate names a specific test rather than a shape. */ function isMeaningfulIdentifier(candidate) {
  if (candidate.length < MIN_IDENTIFIER_LENGTH) return false;
  return candidate.split(" ").some((token)=>!GENERIC_IDENTIFIER_TOKENS.has(token));
}
/**
 * Extract the test identifiers a PR summary claims to have added, e.g. the
 * `rejects_injection` in ``tests/db_test.ts::rejects_injection``. Generic and
 * trivially short candidates are dropped — see {@link isMeaningfulIdentifier}.
 */ export function extractTestIdentifiers(content) {
  const scanned = content.slice(0, MAX_SCAN_CHARS);
  const identifiers = new Set();
  for (const pattern of TEST_IDENTIFIER_PATTERNS){
    for (const match of scanned.matchAll(pattern)){
      const candidate = normalise(match[1] ?? "");
      if (isMeaningfulIdentifier(candidate)) identifiers.add(candidate);
    }
  }
  return [
    ...identifiers
  ];
}
/**
 * The names a PR summary cites for the tests it says it added (PR #3921
 * review), as normalised whole names for an exact comparison with a declared
 * name — unlike {@link extractTestIdentifiers}, which the static gate matches
 * as a whole token inside a declaration line.
 *
 * `full` holds each `::` citation read to its closing backtick or end of line,
 * and each quoted or inline name. `tokens` holds the first word of a `::`
 * citation (`::rejects_injection`), for a name written in prose with no closing
 * backtick; it is the first word of a spaced name too, so the caller consults it
 * only when no full name matched a declaration.
 */ export function extractCitedTestNames(content) {
  const scanned = content.slice(0, MAX_SCAN_CHARS);
  const collect = (patterns)=>{
    const found = new Set();
    for (const pattern of patterns){
      for (const match of scanned.matchAll(pattern)){
        const candidate = normalise(match[1] ?? "");
        if (isMeaningfulIdentifier(candidate)) found.add(candidate);
      }
    }
    return found;
  };
  const [token, ...quoted] = TEST_IDENTIFIER_PATTERNS;
  return {
    full: collect([
      FULL_CITED_NAME_PATTERN,
      ...quoted
    ]),
    tokens: collect(token ? [
      token
    ] : [])
  };
}
/**
 * Added (`+`) line bodies of a unified diff, excluding the `+++` file header.
 * The leading `+` is stripped so each entry is the source line as written.
 */ function addedLines(diffText) {
  return diffText.slice(0, MAX_SCAN_CHARS).split("\n").filter((line)=>line.startsWith("+") && !line.startsWith("+++")).map((line)=>line.slice(1));
}
/** Lines that declare a test across this fleet's ecosystems (Issue #1279). */ const TEST_DECLARATION_PATTERNS = [
  /\bDeno\.test\s*\(/,
  /^\s*name\s*:\s*["'`]/,
  /(^|[^.\w])(it|test|specify)\s*(\.\s*[a-z]+\s*)?\(\s*["'`]/,
  /^\s*@test\b/i,
  /\bdef\s+test_\w+\s*\(/,
  /^\s*func\s+Test\w*\s*\(/
];
/**
 * Java-style annotation alone on a line — the test name is on the line that
 * follows it, so that next line counts as the declaration.
 */ const TEST_ANNOTATION_LINE = /^\s*@(Test|ParameterizedTest|RepeatedTest|TestTemplate)\s*(\(.*\))?\s*$/;
/**
 * Rust test attribute alone on a line — `#[test]`, `#[tokio::test(…)]`,
 * `#[rstest]`, `#[proptest]` … As with the Java annotation the name lives on
 * a following line, but Rust allows further attributes in between
 * (`#[should_panic]`), so the pending state carries across them until the
 * `fn` line (Issue #1680). `#[cfg(test)]` is deliberately absent: it gates a
 * module, not a test function.
 */ const RUST_TEST_ATTRIBUTE_LINE = /^\s*#\[\s*(?:tokio::|async_std::|actix_rt::|smol_potat::)?(?:test|rstest|proptest)\b[^\]]*\]\s*$/;
/** Any attribute alone on a line — may sit between the attribute and the `fn`. */ const RUST_ATTRIBUTE_LINE = /^\s*#!?\[[^\]]*\]\s*$/;
/** A Rust function signature — the declaration a test attribute points at. */ const RUST_FN_LINE = /^\s*(?:pub(?:\s*\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+\w+\s*[(<]/;
/**
 * A test call opened on one line with nothing after the parenthesis, or the
 * object form's bare `name:` — `deno fmt` wraps a long declaration exactly
 * so, and the name lands on the line that follows (Issue #1581):
 *
 *     Deno.test(
 *       "handle_no_changes_phase - an untrusted image withholds the close",
 *       async () => { … },
 *     );
 *
 * The line carrying `Deno.test(` matches {@link TEST_DECLARATION_PATTERNS}
 * but holds no name, so on its own the gate reported the cited test missing
 * from a branch that added it. As with the Java annotation, the next line is
 * the declaration — when it is a string literal.
 */ const TEST_CALL_OPENER_LINE = /(^|[^.\w])(Deno\.test|it|test|specify)\s*(\.\s*[a-z]+\s*)?\(\s*$|^\s*name\s*:\s*$/;
/** A line that is only a string literal (the wrapped test name), with or without its trailing comma. */ const STRING_LITERAL_LINE = /^\s*(["'`])[^"'`]*\1\s*,?\s*$/;
/**
 * Added lines that declare a test, so citing a token from an assertion body
 * does not satisfy the gate (Issue #1279).
 */ function testDeclarationLines(diffText) {
  const declarations = [];
  let previousWasAnnotation = false;
  let previousWasOpener = false;
  let pendingRustAttribute = false;
  for (const line of addedLines(diffText)){
    const isRustDeclaration = pendingRustAttribute && RUST_FN_LINE.test(line);
    if (previousWasAnnotation || isRustDeclaration || previousWasOpener && STRING_LITERAL_LINE.test(line) || TEST_DECLARATION_PATTERNS.some((pattern)=>pattern.test(line))) {
      declarations.push(line);
    }
    previousWasAnnotation = TEST_ANNOTATION_LINE.test(line);
    previousWasOpener = TEST_CALL_OPENER_LINE.test(line);
    // A test attribute opens the pending state; further attribute lines carry
    // it; anything else closes it, so a stray `fn` never counts (Issue #1680).
    pendingRustAttribute = RUST_TEST_ATTRIBUTE_LINE.test(line) || pendingRustAttribute && RUST_ATTRIBUTE_LINE.test(line);
  }
  return declarations;
}
/** Cap on test-declaration lines reported back to the agent (Issue #1575). */ export const MAX_REPORTED_TEST_DECLARATIONS = 10;
/** Cap on the length of a single reported declaration line (Issue #1575). */ export const MAX_DECLARATION_LINE_CHARS = 200;
/**
 * The test declarations the gate actually matched in the added lines of the
 * branch's test diff (Issue #1575).
 *
 * A `test-identifier-in-diff` block says only that no cited identifier named a
 * declared test — it never said what the gate *did* see, so a false block
 * (#1385 lost three runs to one) could not be told apart from a real one. The
 * lines are deduplicated, trimmed, truncated and capped at
 * {@link MAX_REPORTED_TEST_DECLARATIONS}: they are agent-authored diff text, so
 * every consumer fences them as untrusted.
 */ export function matchedTestDeclarations(testDiffText) {
  const matched = new Set();
  for (const line of testDeclarationLines(testDiffText)){
    const trimmed = line.trim().slice(0, MAX_DECLARATION_LINE_CHARS);
    if (trimmed) matched.add(trimmed);
    if (matched.size >= MAX_REPORTED_TEST_DECLARATIONS) break;
  }
  return [
    ...matched
  ];
}
/**
 * Render the matched declarations for an operator comment or a retry prompt
 * (Issue #1575). Empty is a finding in its own right — the branch declares no
 * test at all — and is stated rather than left blank.
 */ export function formatMatchedTestDeclarations(declarations) {
  if (declarations.length === 0) {
    return "The gate matched NO test-declaration line in the added lines of this branch's test diff, so no citation could have satisfied it.";
  }
  // Scrubbed and code-fenced, not nonce-fenced: the lines are diff text, so
  // they must render as data in the comment and stay inert in the retry
  // prompt, but this message is also the operator's evidence and must read the
  // same every time it is built.
  const body = scrubUntrustedText(declarations.join("\n"));
  const fence = codeFenceFor(body);
  return `The gate matched these test declarations in the added lines of the branch diff (up to ${MAX_REPORTED_TEST_DECLARATIONS}) — if the test you cited is listed here, the name in the summary does not match the declared one:

${fence}text
${body}
${fence}`;
}
/** Whether `haystack` contains `needle` as a whole normalised token run. */ function containsWholeToken(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}
/**
 * Most cited tests {@link citedSecurityTests} returns (Issue #3659). Bounds the
 * number of runs the worker may be asked to perform on agent-authored input.
 */ export const MAX_CITED_SECURITY_TESTS = 10;
/**
 * The test declarations, per file, that the PR summary cites and the added
 * lines of the test diff declare (Issue #3659). Unsupported languages remain
 * represented so the runner can record why each cited test could not run.
 *
 * The file sections come from the `+++ b/<path>` headers of the unified diff;
 * `+++ /dev/null` (a deletion) names no file and is skipped. The match rule is
 * stricter than the static one {@link citedTestIdentifierInDiff} applies: the
 * declared name, normalised, must EQUAL a name the summary cites
 * ({@link extractCitedTestNames}), so a declaration sharing only a word with the
 * cited name is not run in its place. The name returned is the first string
 * literal on the declaration line, as written — or the function name of a
 * Rust, pytest, Go or Java test in its own language's file. JS/TS declarations
 * always retain their string name, even if the callback resembles another
 * language's function declaration. The runner executes only Deno and Rust;
 * the other citations receive a not-run cause. The result is
 * deduplicated by file and name, kept in diff order and capped at
 * {@link MAX_CITED_SECURITY_TESTS}. Bounded patterns over a capped slice only —
 * both inputs are untrusted.
 */ export function citedSecurityTests(content, testDiffText) {
  const cited = extractCitedTestNames(content);
  if (cited.full.size === 0 && cited.tokens.size === 0) return [];
  const sections = [];
  // Hunk-aware split: inside a hunk every line is content, so an added line
  // whose text is `++ b/other_test.ts` (rendered `+++ b/other_test.ts`) cannot
  // re-attribute later declarations to another file. Only outside a hunk may
  // `+++ ` open a new file section.
  let oldRemaining = 0;
  let newRemaining = 0;
  for (const line of testDiffText.slice(0, MAX_SCAN_CHARS).split("\n")){
    if (oldRemaining > 0 || newRemaining > 0) {
      const marker = line[0];
      if (marker === "\\") {
      // "\ No newline at end of file" consumes neither count.
      } else if (marker === "+") {
        newRemaining--;
      } else if (marker === "-") {
        oldRemaining--;
      } else {
        oldRemaining--;
        newRemaining--;
      }
      sections[sections.length - 1]?.lines.push(line);
      continue;
    }
    const hunk = HUNK_HEADER.exec(line);
    if (hunk) {
      oldRemaining = hunk[1] === undefined ? 1 : Number(hunk[1]);
      newRemaining = hunk[2] === undefined ? 1 : Number(hunk[2]);
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        sections.push({
          file: "",
          lines: []
        });
      } else {
        sections.push({
          file: target.startsWith("b/") ? target.slice(2) : target,
          lines: []
        });
      }
    } else {
      sections[sections.length - 1]?.lines.push(line);
    }
  }
  const declared = [];
  for (const section of sections){
    if (!section.file) continue;
    for (const declaration of testDeclarationLines(section.lines.join("\n"))){
      const name = section.file.endsWith(".rs") ? RUST_FN_NAME_PATTERN.exec(declaration)?.[1] ?? "" : declaredFunctionName(section.file, declaration) ?? STRING_NAME_PATTERN.exec(declaration)?.[2] ?? "";
      if (!name.trim()) continue;
      declared.push({
        file: section.file,
        name,
        normalised: normalise(name)
      });
    }
  }
  // The declared name must equal the cited name, not merely contain a word of
  // it: a looser match picks tests the summary never meant (PR #3921 review).
  let chosen = declared.filter((d)=>cited.full.has(d.normalised));
  if (chosen.length === 0) {
    chosen = declared.filter((d)=>cited.tokens.has(d.normalised));
  }
  const found = [];
  const seen = new Set();
  for (const { file, name } of chosen){
    const key = `${file}\u0000${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    found.push({
      file,
      name
    });
    if (found.length >= MAX_CITED_SECURITY_TESTS) break;
  }
  return found;
}
/** Unsupported function-named tests still need a recorded not-run cause. */ function declaredFunctionName(file, declaration) {
  if (file.endsWith(".py")) {
    return /^\s*(?:async\s+)?def\s+(test_\w+)\s*\(/.exec(declaration)?.[1];
  }
  if (file.endsWith(".go")) {
    return /^\s*func\s+(Test\w*)\s*\(/.exec(declaration)?.[1];
  }
  if (file.endsWith(".java")) {
    return /^\s*(?:(?:public|protected|private|static|final)\s+)*void\s+(\w+)\s*\(/.exec(declaration)?.[1];
  }
  // JS/TS declarations keep their string name even when the callback contains
  // `void check()` or a string resembling another language's declaration.
  return undefined;
}
/** A unified-diff hunk header; groups 1 and 2 are the optional old/new line counts. */ const HUNK_HEADER = /^@@ -\d{1,9}(?:,(\d{1,9}))? \+\d{1,9}(?:,(\d{1,9}))? @@/;
/** The function name on a Rust `fn` declaration line (group 1). */ const RUST_FN_NAME_PATTERN = /\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/;
/** The first string literal on a declaration line; group 2 is its content. */ const STRING_NAME_PATTERN = /(["'`])([^"'`\n]*)\1/;
/**
 * Whether any identifier cited in the summary actually names a test declared
 * in the added lines of the test diff — the coupling that prose alone cannot
 * fake. The match is on whole tokens of a declaration line, so neither the
 * `test` inside `Deno.test` nor a name used only in an assertion body counts
 * (Issue #1279).
 */ export function citedTestIdentifierInDiff(content, testDiffText) {
  const declarations = testDeclarationLines(testDiffText).map(normalise).filter((line)=>line.length > 0);
  if (declarations.length === 0) return false;
  return extractTestIdentifiers(content).some((id)=>declarations.some((line)=>containsWholeToken(line, id)));
}
/** Whether the issue labels contain `security` as a whole label. */ export function hasSecurityLabel(issueLabels) {
  return issueLabels.split(",").map((label)=>label.trim().toLowerCase()).includes("security");
}
/** Whether the content references a `SEC-<hex>` finding id. */ export function referencesFindingId(content) {
  return FINDING_ID_PATTERN.test(content);
}
/**
 * Evaluate the security-fix patch-verification gate.
 *
 * The gate is active when the issue carries the `security` label or the PR
 * summary references a `SEC-<hex>` finding id. When active it asserts the
 * machine-checkable diff signals first: a test file changed and a cited test
 * is declared in the added lines. Only when both hold does it check the
 * worker-executed record: null or not_checked yields discrimination-not-checked;
 * any checked outcome other than red → green yields test-discriminates. It
 * then checks the self-reported trigger-closed statement. Pure — inspects the
 * supplied strings and record, never executes anything.
 */ export function evaluateSecurityFixGate(input) {
  const content = (input.prSummaryContent ?? "").slice(0, MAX_SCAN_CHARS);
  const isSecurityFix = hasSecurityLabel(input.issueLabels) || referencesFindingId(content);
  if (!isSecurityFix) {
    return {
      isSecurityFix: false,
      ok: true,
      missing: []
    };
  }
  const missing = [];
  // Machine-checkable evidence — the gate proper (Issue #3652).
  if (!input.diff) {
    missing.push("diff-unavailable");
  } else {
    if (!input.diff.changedFiles.some(isTestFilePath)) {
      missing.push("test-file-changed");
    }
    if (!citedTestIdentifierInDiff(content, input.diff.testDiffText)) {
      missing.push("test-identifier-in-diff");
    }
  }
  // Executed red → green record (Issue #3659). Due only once a test file is
  // changed and a cited test is declared: those are the preconditions for the
  // worker having anything to run, and each already reports its own fault.
  if (input.diff && !missing.includes("test-file-changed") && !missing.includes("test-identifier-in-diff")) {
    const record = input.discrimination;
    if (!record || record.kind === "not_checked") {
      missing.push("discrimination-not-checked");
    } else if (!(record.preFix === "fail" && record.postFix === "pass")) {
      missing.push("test-discriminates");
    }
  }
  // Self-reported prose — retained as a human-review aid, not the gate.
  if (!TRIGGER_CLOSED.test(content)) missing.push("trigger-closed");
  return {
    isSecurityFix: true,
    ok: missing.length === 0,
    missing
  };
}
/**
 * Remediation instruction for each missing evidence item.
 *
 * Exported (Issue #4057) so the coding prompt can state the same contract up
 * front instead of leaving an agent to discover it by being blocked — one
 * source of truth for what the gate demands and what the prompt promises.
 */ export const SECURITY_FIX_EVIDENCE_DESCRIPTIONS = {
  "test-file-changed": "Add or modify a TEST FILE in this branch. The branch diff currently changes no test file, so there is no regression test to verify — prose in the summary cannot substitute for it.",
  "test-identifier-in-diff": "Name the ACTUAL TEST IDENTIFIER you added, in the form `path/to/foo_test.ts::the test name`, and make sure that name matches the declaration of a test added in this branch's diff. A generic token (`test`, `spec`, `case`, …) or a name that only appears inside a test body does not count. The summary either names no test or names one that does not declare a test in the added lines.",
  "diff-unavailable": "The branch diff could not be computed against the base branch, so the machine-checkable test assertion could not run. Ensure the base branch is fetched (`git fetch origin <base>`) and retry — an uncheckable security fix is blocked rather than assumed good.",
  "test-discriminates": "The cited test must FAIL against the base branch's versions of the changed non-test files and PASS at the head. The worker ran it both ways in a disposable checkout and it did not go red then green, so it does not discriminate the fix. Make the test exercise the vulnerable code path the fix changes, so that it fails on the unfixed code.",
  "discrimination-not-checked": "The worker could not run the cited test against both the base and the head (runner error, unresolvable base ref, build failure, timeout, or a cited test in a language the worker cannot execute), so whether it discriminates the fix is unchecked. An unchecked security fix is blocked, never assumed good, and never counted as the red run. Today the worker can execute two kinds of test: a `Deno.test` with a string name in a `*_test.*` or `*.test.*` file under a `deno.json`, `deno.jsonc` or `deno.lock` project, and a Rust `#[test] fn` in a `.rs` file under a `Cargo.toml` package.",
  "trigger-closed": 'Add a short statement that the ORIGINAL TRIGGER is closed with no trivial bypass (static reasoning over the changed code path — e.g. "the original attack input is now rejected by the allowlist and no equivalent bypass exists").'
};
/**
 * Evidence items a security-fix PR must positively supply, in the order the
 * prompt states them (Issue #4057). `diff-unavailable` and
 * `discrimination-not-checked` are excluded because they report an environment
 * fault the summary cannot be written to satisfy.
 */ export const REQUIRED_SECURITY_FIX_EVIDENCE = [
  "test-file-changed",
  "test-identifier-in-diff",
  "test-discriminates",
  "trigger-closed"
];
/** Whether a value is one of the gate's evidence kinds (Issue #4057). */ export function isSecurityFixEvidenceKind(value) {
  return typeof value === "string" && Object.hasOwn(SECURITY_FIX_EVIDENCE_DESCRIPTIONS, value);
}
/**
 * Render the recorded discrimination runs (Issue #3659). The test name and the
 * reason are agent-authored or tool output, so they are scrubbed and
 * code-fenced exactly as {@link formatMatchedTestDeclarations} does.
 */ export function formatDiscriminationRecord(discrimination) {
  const runLines = (run)=>[
      `${run.test.file}::${run.test.name}`,
      `base production files: ${run.preFix} (expected fail)`,
      `head: ${run.postFix} (expected pass)`
    ];
  const others = discrimination.kind === "checked" ? discrimination.others : discrimination.runs;
  const lines = [
    ...discrimination.kind === "checked" ? runLines(discrimination) : [
      discrimination.reason
    ],
    ...(others ?? []).flatMap((o)=>[
        "",
        ...runLines(o)
      ]),
    ...(discrimination.notRun ?? []).flatMap((run)=>[
        "",
        `${run.test.file}::${run.test.name}`,
        `not run: ${run.reason}`
      ])
  ];
  const body = scrubUntrustedText(lines.join("\n"));
  const fence = codeFenceFor(body);
  return `Recorded discrimination runs:

${fence}text
${body}
${fence}`;
}
/**
 * Build the operator-facing failure message for a blocked security-fix PR.
 * Lists exactly what the PR summary must add so the retry is productive.
 */ export function buildSecurityFixGateMessage(missing, declarations, discrimination) {
  const items = missing.map((kind)=>`- ${SECURITY_FIX_EVIDENCE_DESCRIPTIONS[kind]}`).join("\n");
  // A missing test identifier is the one verdict an agent cannot check for
  // itself, so the block states what the gate matched (Issue #1575).
  const matched = missing.includes("test-identifier-in-diff") ? `\n\n${formatMatchedTestDeclarations(declarations)}` : "";
  const recorded = (missing.includes("test-discriminates") || missing.includes("discrimination-not-checked")) && discrimination ? `\n\n${formatDiscriminationRecord(discrimination)}` : "";
  return `PR creation blocked: this PR closes a security-labelled finding but is missing required vulnerability-fix verification evidence.

Any PR that closes a \`security\` finding must show — in the branch diff, not only in prose — that the fault is genuinely closed (fail loud — never mask a fault as success, Issue #3234):

${items}${matched}${recorded}

Fix the branch (and \`docs/archive/pr-summaries/pr-summary-<issue>.md\`), then retry. The test-file and test-identifier assertions are static checks over \`git diff\`; the discrimination check is executed by the worker (not the agent) in a disposable checkout; the trigger-closed statement is static reasoning over the changed code path.`;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9zZWN1cml0eV9maXhfZ2F0ZS50cyJdLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIFNlY3VyaXR5LWZpeCBwYXRjaC12ZXJpZmljYXRpb24gZ2F0ZSAoSXNzdWUgIzM1NDAsIGdhcCBHNCkuXG4gKlxuICogVmliZUNvZGVyJ3Mgc2NhbnMgYXJlIGRldGVjdC1vbmx5OiBhIGZpbmRpbmcgaXMgZmlsZWQgYXMgYSBgc2VjdXJpdHlgXG4gKiAtbGFiZWxsZWQgaXNzdWUgYW5kIHRoZSBmaXggcmlkZXMgdGhlIG5vcm1hbCBgd29yay1vbmAgUFIuIFRoYXQgUFIgaGFzIG5vXG4gKiB2dWxuZXJhYmlsaXR5LXNwZWNpZmljIGdhdGUsIHNvIG5vdGhpbmcgZ3VhcmFudGVlcyBhIHJlZ3Jlc3Npb24gdGVzdFxuICogcmVwcm9kdWNlcyB0aGUgZmxhdywgbm9yIHRoYXQgdGhlIG9yaWdpbmFsIHRyaWdnZXIgaXMgYWN0dWFsbHkgY2xvc2VkIOKAlCB0aGVcbiAqIHN0YXRpYyBhbmFsb2d1ZSBvZiBBbnRocm9waWMgYC9wYXRjaGAncyBcIlBvQyBubyBsb25nZXIgZmlyZXMgLyBubyBieXBhc3NcIlxuICogYW5kIFZpc2EgVlZBSCBTMTEncyBhZHZlcnNhcmlhbCB2YWxpZGF0aW9uIHBhbmVsLlxuICpcbiAqIFRoaXMgbW9kdWxlIGlzIHRoZSBsaWdodHdlaWdodCBwZXItcmVwbyBnYXRlIChJc3N1ZSAjMzIzOSDigJQgbm8gY3Jvc3MtcmVwb1xuICogY2VudHJhbGlzYXRpb24pLiBJdCBhY3RpdmF0ZXMgb25seSB3aGVuIHRoZSBQUiBjbG9zZXMgYSBzZWN1cml0eSBmaW5kaW5nXG4gKiAodGhlIGlzc3VlIGNhcnJpZXMgdGhlIGBzZWN1cml0eWAgbGFiZWwsIG9yIHRoZSBQUiBzdW1tYXJ5IHJlZmVyZW5jZXMgYVxuICogYFNFQy08aGV4PmAgZmluZGluZyBpZCkgYW5kIHRoZW4gcmVxdWlyZXMgbWFjaGluZS1jaGVja2VkIGV2aWRlbmNlIHBsdXMgb25lXG4gKiBzZWxmLXJlcG9ydGVkIHN0YXRlbWVudDpcbiAqXG4gKiAqKk1hY2hpbmUtY2hlY2thYmxlICh0aGUgZ2F0ZSBwcm9wZXIsIElzc3VlICMzNjUyKSoqIOKAlCBhc3NlcnRlZCBhZ2FpbnN0IHRoZVxuICogYnJhbmNoIGRpZmYsIHdoaWNoIHRoZSBhZ2VudCBjYW5ub3Qgc2F0aXNmeSBieSB3cml0aW5nIHByb3NlOlxuICpcbiAqICAxLiB0aGUgZGlmZiAqKmFkZHMgb3IgbW9kaWZpZXMgYSB0ZXN0IGZpbGUqKjsgYW5kXG4gKiAgMi4gYSAqKnRlc3QgaWRlbnRpZmllciBuYW1lZCBpbiB0aGUgUFIgc3VtbWFyeSBhY3R1YWxseSBuYW1lcyBhIHRlc3RcbiAqICAgICBkZWNsYXJlZCoqIGluIHRoZSBhZGRlZCBsaW5lcyBvZiB0aGF0IHRlc3QgZGlmZiDigJQgbWF0Y2hlZCBvbiB3aG9sZVxuICogICAgIHRva2VucyBvZiBhIHRlc3QtZGVjbGFyYXRpb24gbGluZSwgd2l0aCBnZW5lcmljIHRva2VucyAoYHRlc3RgLCBgc3BlY2AsXG4gKiAgICAgYGNhc2VgLCDigKYpIHJlamVjdGVkIG91dHJpZ2h0LCBzbyBuZWl0aGVyIHRoZSBgdGVzdGAgaW5zaWRlIGBEZW5vLnRlc3RgXG4gKiAgICAgbm9yIGEgbmFtZSBib3Jyb3dlZCBmcm9tIGFuIGFzc2VydGlvbiBib2R5IHNhdGlzZmllcyBpdCAoSXNzdWUgIzEyNzkpO1xuICogICAgIGFuZFxuICogIDMuICoqdGhlIGNpdGVkIHRlc3QgZGlzY3JpbWluYXRlcyB0aGUgZml4IChJc3N1ZSAjMzY1OSkqKiDigJQgdGhlIHdvcmtlciwgbm90XG4gKiAgICAgdGhlIGFnZW50LCBleGVjdXRlZCB0aGUgY2l0ZWQgdGVzdCB0d2ljZSBpbiBhIGRpc3Bvc2FibGUgY2hlY2tvdXQ6IG9uY2VcbiAqICAgICBhZ2FpbnN0IHRoZSBiYXNlIGJyYW5jaCdzIHZlcnNpb25zIG9mIHRoZSBjaGFuZ2VkIG5vbi10ZXN0IGZpbGVzIChpdCBtdXN0XG4gKiAgICAgRkFJTCkgYW5kIG9uY2UgYXQgdGhlIGhlYWQgKGl0IG11c3QgUEFTUykuIE9ubHkgYSByZWQg4oaSIGdyZWVuIHJlY29yZFxuICogICAgIHNhdGlzZmllcyBpdDsgZ3JlZW4g4oaSIGdyZWVuLCByZWQg4oaSIHJlZCBhbmQgZ3JlZW4g4oaSIHJlZCBhbGwgYmxvY2ssIGFuZCBhXG4gKiAgICAgcnVuIHRoZSB3b3JrZXIgY291bGQgbm90IHBlcmZvcm0gaXMgYGRpc2NyaW1pbmF0aW9uLW5vdC1jaGVja2VkYCwgbmV2ZXJcbiAqICAgICBjb3VudGVkIGFzIHRoZSByZWQgcnVuLiBUaGlzIGNoZWNrIGlzIG9ubHkgZHVlIG9uY2UgaXRlbXMgMSBhbmQgMiBob2xkLFxuICogICAgIGJlY2F1c2UgaXQgbmVlZHMgYSB0ZXN0IHRoYXQgZXhpc3RzIGFuZCBpcyBuYW1lZC5cbiAqXG4gKiBUaGUgZWFybGllciBwcm9zZSByZXF1aXJlbWVudCDigJQgYSBzdW1tYXJ5IHNlbnRlbmNlIGxpbmtpbmcgdGhlIHJlZ3Jlc3Npb25cbiAqIHRlc3QgdG8gYSBmYWlsLWJlZm9yZS9wYXNzLWFmdGVyIHJlc3VsdCDigJQgd2FzIGRyb3BwZWQgaW4gSXNzdWUgIzM2NTk6IHRoZVxuICogZXhlY3V0ZWQgcmVjb3JkIGluIGl0ZW0gMyByZXBsYWNlcyBpdCwgYW5kIGEgc2VudGVuY2Ugd3JpdHRlbiBieSB0aGUgcGFydHlcbiAqIHRoZSBldmlkZW5jZSBpcyBhYm91dCBwcm92ZWQgbm90aGluZyB0aGUgcnVuIGRpZCBub3QuXG4gKlxuICogKipTZWxmLXJlcG9ydGVkIHByb3NlIChhIGh1bWFuLXJldmlldyBhaWQpKiog4oCUIG9ubHkgdGhlIG9yaWdpbmFsLXRyaWdnZXItXG4gKiBjbG9zZWQgc3RhdGVtZW50IHJlbWFpbnMuIFRoZSBzdW1tYXJ5IGlzIHdyaXR0ZW4gYnkgdGhlIHNhbWUgcGFydHkgdGhlXG4gKiBldmlkZW5jZSBpcyBhYm91dCwgYW5kIHRoZSBmaW5kaW5nIGJvZHkgdGhhdCBzdGVlcnMgaXQgaXMgdW50cnVzdGVkIGlucHV0LFxuICogc28gaXQgaXMgdHJlYXRlZCBhcyB1bnRydXN0ZWQgdGV4dCBoZXJlIChib3VuZGVkIHJlZ2V4ZXMgb3ZlciBhIGNhcHBlZFxuICogc2xpY2UsIG5ldmVyIGV4ZWN1dGVkKS5cbiAqXG4gKiBBbGlnbnMgd2l0aCB0aGUgXCJmYWlsIGxvdWQgLyBuZXZlciBtYXNrIGEgZmF1bHQgYXMgc3VjY2Vzc1wiIHByaW5jaXBsZVxuICogKElzc3VlICMzMjM0KTogYSBzZWN1cml0eS1maXggUFIgdGhhdCBjYW5ub3Qgc2hvdyB0aGUgZmF1bHQgaXMgZ2VudWluZWx5XG4gKiBjbG9zZWQgbXVzdCBub3Qgc2FpbCB0aHJvdWdoIGFzIGEgY2xlYW4gc3VjY2VzcyDigJQgaW5jbHVkaW5nIHdoZW4gdGhlIGRpZmZcbiAqIGV2aWRlbmNlIGNvdWxkIG5vdCBiZSBjb2xsZWN0ZWQgYXQgYWxsLlxuICpcbiAqIFB1cmUgZnVuY3Rpb25zLCBubyBJL08gKHRoZSBkaXNjcmltaW5hdGlvbiByZWNvcmQgaXMgcHJvZHVjZWQgZWxzZXdoZXJlIGFuZFxuICogcGFzc2VkIGluKS4gQXVzdHJhbGlhbiBFbmdsaXNoIHRocm91Z2hvdXQuXG4gKi9cblxuaW1wb3J0IHsgY29kZUZlbmNlRm9yLCBzY3J1YlVudHJ1c3RlZFRleHQgfSBmcm9tIFwiLi9wcm9tcHRfZGVsaW1pdGVyLnRzXCI7XG5pbXBvcnQgdHlwZSB7XG4gIENpdGVkU2VjdXJpdHlUZXN0LFxuICBEaXNjcmltaW5hdGlvblJ1bixcbiAgU2VjdXJpdHlGaXhEaXNjcmltaW5hdGlvbixcbn0gZnJvbSBcIi4vc2VjdXJpdHlfZml4X2Rpc2NyaW1pbmF0aW9uLnRzXCI7XG5cbi8qKiBEaXN0aW5jdCBldmlkZW5jZSBpdGVtcyB0aGUgZ2F0ZSByZXF1aXJlcyBvZiBhIHNlY3VyaXR5LWZpeCBQUi4gKi9cbmV4cG9ydCB0eXBlIFNlY3VyaXR5Rml4RXZpZGVuY2VLaW5kID1cbiAgfCBcInRyaWdnZXItY2xvc2VkXCJcbiAgfCBcInRlc3QtZmlsZS1jaGFuZ2VkXCJcbiAgfCBcInRlc3QtaWRlbnRpZmllci1pbi1kaWZmXCJcbiAgfCBcInRlc3QtZGlzY3JpbWluYXRlc1wiXG4gIHwgXCJkaXNjcmltaW5hdGlvbi1ub3QtY2hlY2tlZFwiXG4gIHwgXCJkaWZmLXVuYXZhaWxhYmxlXCI7XG5cbi8qKlxuICogTWFjaGluZS1jaGVja2FibGUgZGlmZiBldmlkZW5jZSBmb3IgdGhlIFBSIGJyYW5jaCwgY29sbGVjdGVkIGJ5XG4gKiBgc2VjdXJpdHlfZml4X2RpZmYudHNgIChgZ2l0IGRpZmZgIG9ubHkg4oCUIG5vdGhpbmcgaXMgZXhlY3V0ZWQpLlxuICovXG5leHBvcnQgaW50ZXJmYWNlIFNlY3VyaXR5Rml4RGlmZkV2aWRlbmNlIHtcbiAgLyoqIFBhdGhzIGNoYW5nZWQgYnkgdGhlIGJyYW5jaCAoYGdpdCBkaWZmIC0tbmFtZS1vbmx5IDxiYXNlPi4uLkhFQURgKS4gKi9cbiAgY2hhbmdlZEZpbGVzOiBzdHJpbmdbXTtcbiAgLyoqIERpZmYgYm9keSByZXN0cmljdGVkIHRvIHRoZSBjaGFuZ2VkIHRlc3QgZmlsZXMuICovXG4gIHRlc3REaWZmVGV4dDogc3RyaW5nO1xufVxuXG4vKiogT3V0Y29tZSBvZiBldmFsdWF0aW5nIHRoZSBzZWN1cml0eS1maXggZ2F0ZSBhZ2FpbnN0IGEgUFIgc3VtbWFyeS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgU2VjdXJpdHlGaXhHYXRlUmVzdWx0IHtcbiAgLyoqXG4gICAqIFdoZXRoZXIgdGhpcyBQUiBjbG9zZXMgYSBzZWN1cml0eSBmaW5kaW5nLCBpLmUuIHdoZXRoZXIgdGhlIGdhdGUgaXNcbiAgICogYWN0aXZlLiBXaGVuIGBmYWxzZWAsIHRoZSBnYXRlIGlzIGEgbm8tb3AgYW5kIGBva2AgaXMgYWx3YXlzIGB0cnVlYC5cbiAgICovXG4gIGlzU2VjdXJpdHlGaXg6IGJvb2xlYW47XG4gIC8qKlxuICAgKiBgdHJ1ZWAgd2hlbiB0aGUgZ2F0ZSBpcyBpbmFjdGl2ZSwgb3IgYWN0aXZlIHdpdGggZXZlcnkgcmVxdWlyZWQgZXZpZGVuY2VcbiAgICogaXRlbSBwcmVzZW50LiBgZmFsc2VgIG9ubHkgd2hlbiBhY3RpdmUgYW5kIGF0IGxlYXN0IG9uZSBpdGVtIGlzIG1pc3NpbmcuXG4gICAqL1xuICBvazogYm9vbGVhbjtcbiAgLyoqIFJlcXVpcmVkIGV2aWRlbmNlIGl0ZW1zIHRoYXQgd2VyZSBub3QgZm91bmQgKGVtcHR5IHdoZW4gYG9rYCkuICovXG4gIG1pc3Npbmc6IFNlY3VyaXR5Rml4RXZpZGVuY2VLaW5kW107XG59XG5cbi8qKiBJbnB1dCB0byB7QGxpbmsgZXZhbHVhdGVTZWN1cml0eUZpeEdhdGV9LiAqL1xuZXhwb3J0IGludGVyZmFjZSBTZWN1cml0eUZpeEdhdGVJbnB1dCB7XG4gIC8qKiBUaGUgUFIgc3VtbWFyeSAvIGJvZHkgY29udGVudCB0byBpbnNwZWN0LiBVbnRydXN0ZWQsIGFnZW50LWF1dGhvcmVkLiAqL1xuICBwclN1bW1hcnlDb250ZW50OiBzdHJpbmc7XG4gIC8qKiBDb21tYS1zZXBhcmF0ZWQgaXNzdWUgbGFiZWxzIChlLmcuIGBzZWN1cml0eSx3b3JrLW9uYCkuICovXG4gIGlzc3VlTGFiZWxzOiBzdHJpbmc7XG4gIC8qKlxuICAgKiBEaWZmIGV2aWRlbmNlIGZvciB0aGUgUFIgYnJhbmNoLCBvciBgbnVsbGAgd2hlbiBpdCBjb3VsZCBub3QgYmUgY29sbGVjdGVkLlxuICAgKiBSZXF1aXJlZCDigJQgYSBjYWxsZXIgbXVzdCBub3QgYmUgYWJsZSB0byBvbWl0IHRoZSBtYWNoaW5lLWNoZWNrYWJsZSBoYWxmIGJ5XG4gICAqIGFjY2lkZW50LCBhbmQgYG51bGxgIGJsb2NrcyByYXRoZXIgdGhhbiBzaWxlbnRseSBwYXNzaW5nIChJc3N1ZSAjMzY1MikuXG4gICAqL1xuICBkaWZmOiBTZWN1cml0eUZpeERpZmZFdmlkZW5jZSB8IG51bGw7XG4gIC8qKlxuICAgKiBUaGUgd29ya2VyLWV4ZWN1dGVkIHJlZCDihpIgZ3JlZW4gcmVjb3JkIGZvciB0aGUgY2l0ZWQgdGVzdCAoSXNzdWUgIzM2NTkpLCBvclxuICAgKiBgbnVsbGAgd2hlbiB0aGUgY2hlY2sgd2FzIG5vdCBydW4uIGBudWxsYCBibG9ja3Mgd2hlbmV2ZXIgdGhlIGNoZWNrIGlzIGR1ZS5cbiAgICovXG4gIGRpc2NyaW1pbmF0aW9uOiBTZWN1cml0eUZpeERpc2NyaW1pbmF0aW9uIHwgbnVsbDtcbn1cblxuLyoqIENhcCBvbiB1bnRydXN0ZWQgdGV4dCBzY2FubmVkIGJ5IHRoZSBnYXRlJ3MgcmVnZXhlcyAoZGVmZW5jZSBpbiBkZXB0aCkuICovXG5jb25zdCBNQVhfU0NBTl9DSEFSUyA9IDIwMF8wMDA7XG5cbi8qKiBTdGFibGUgYFNFQy08aGV4PmAgZmluZGluZyBpZCwgZS5nLiBgU0VDLWExYjJjM2Q0ZTVmNmAgKElzc3VlICMxOTM4KS4gKi9cbmNvbnN0IEZJTkRJTkdfSURfUEFUVEVSTiA9IC9cXGJTRUMtWzAtOWEtZl17Nix9XFxiL2k7XG5cbi8qKlxuICogT3JpZ2luYWwgdHJpZ2dlciBjbG9zZWQgd2l0aCBubyB0cml2aWFsIGJ5cGFzcyDigJQgdGhlIHN0YXRpYyBhbmFsb2d1ZSBvZlxuICogXCJhIGZyZXNoIGZpbmQgYWdlbnQgY2Fubm90IGJ5cGFzc1wiIC8gVlZBSCBTMTEgYWRvcHRpb24gc2NvcmluZy5cbiAqL1xuY29uc3QgVFJJR0dFUl9DTE9TRUQgPVxuICAvXFxibm9cXHMrKHRyaXZpYWxcXHMrKT9ieXBhc3NcXGJ8XFxiKGNhbm5vdHxjYW4ndHx1bmFibGUgdG98cHJldmVudHM/fGJsb2Nrcz98cmVqZWN0cz98bmV1dHJhbGlzXFx3K3xtaXRpZ2F0XFx3KylcXGJbXFxzXFxTXXswLDYwfVxcYmJ5cGFzc1xcYnxcXGJvcmlnaW5hbFxccysodHJpZ2dlcnxhdHRhY2t8aW5wdXR8dmVjdG9yfHBheWxvYWR8cG9jfGV4cGxvaXR8cmVxdWVzdClcXGJ8XFxidHJpZ2dlclxccytpc1xccysobm93XFxzKyk/Y2xvc2VkXFxifFxcYm5vIGxvbmdlclxccysoZmlyZXN8dHJpZ2dlcnN8ZXhwbG9pdGFibGV8dnVsbmVyYWJsZSlcXGJ8XFxiY2xvc2Vbc2RdP1xccyt0aGVcXHMrKG9yaWdpbmFsXFxzKyk/KHRyaWdnZXJ8YXR0YWNrfHZlY3Rvcnxob2xlfHZ1bG5lcmFiaWxpdHkpXFxiL2k7XG5cbi8qKiBQYXRoIHNoYXBlcyB0aGF0IGNvdW50IGFzIGEgdGVzdCBmaWxlIGFjcm9zcyB0aGlzIGZsZWV0J3MgZWNvc3lzdGVtcy4gKi9cbmNvbnN0IFRFU1RfUEFUSF9QQVRURVJOUzogUmVnRXhwW10gPSBbXG4gIC8oXnxcXC8pdGVzdHM/XFwvL2ksIC8vIHRlc3RzL+KApiBvciB0ZXN0L+KAplxuICAvX3Rlc3RcXC5bYS16XSskL2ksIC8vIGZvb190ZXN0LnRzIChEZW5vKSwgZm9vX3Rlc3QucHlcbiAgL1xcLnRlc3RcXC5bYS16XSskL2ksIC8vIGZvby50ZXN0LnRzIChKZXN0L1ZpdGVzdClcbiAgL1xcLnNwZWNcXC5bYS16XSskL2ksIC8vIGZvby5zcGVjLnRzIChDeXByZXNzL0phc21pbmUpXG4gIC8oXnxcXC8pdGVzdF9bXi9dK1xcLlthLXpdKyQvaSwgLy8gdGVzdF9mb28ucHlcbiAgL1xcLmJhdHMkL2ksIC8vIEJBVFMgc3VpdGVzXG4gIC8oXnxcXC8pY3lwcmVzc1xcLy9pLCAvLyBDeXByZXNzIHNwZWNzXG4gIC9UZXN0XFwuamF2YSQvLCAvLyBGb29UZXN0LmphdmFcbl07XG5cbi8qKiBXaGV0aGVyIGEgcmVwby1yZWxhdGl2ZSBwYXRoIGlzIGEgdGVzdCBmaWxlLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzVGVzdEZpbGVQYXRoKHBhdGg6IHN0cmluZyk6IGJvb2xlYW4ge1xuICBjb25zdCB0cmltbWVkID0gcGF0aC50cmltKCk7XG4gIGlmICghdHJpbW1lZCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gVEVTVF9QQVRIX1BBVFRFUk5TLnNvbWUoKHBhdHRlcm4pID0+IHBhdHRlcm4udGVzdCh0cmltbWVkKSk7XG59XG5cbi8qKlxuICogVGVzdCBpZGVudGlmaWVycyBjaXRlZCBpbiBhIFBSIHN1bW1hcnkuIEJvdW5kZWQgcGF0dGVybnMgb25seSDigJQgdGhlIHN1bW1hcnlcbiAqIGlzIHVudHJ1c3RlZCB0ZXh0LlxuICovXG5jb25zdCBURVNUX0lERU5USUZJRVJfUEFUVEVSTlM6IFJlZ0V4cFtdID0gW1xuICAvLyBgdGVzdHMvZm9vX3Rlc3QudHM6OnJlamVjdHNfaW5qZWN0aW9uYCDigJQgdGhlIGRvY3VtZW50ZWQgY2l0YXRpb24gZm9ybS5cbiAgLzo6XFxzKihbQS1aYS16MC05X11bQS1aYS16MC05Xy5cXC1dezIsMTIwfSkvZyxcbiAgLy8gYHRlc3RzL2Zvby5iYXRzOjpcImhhbmRsZXMgZW1wdHkgaW5wdXRcImAg4oCUIHF1b3RlZCBuYW1lcyBtYXkgaG9sZCBzcGFjZXMuXG4gIC86OlxccypbXCInYF0oW15cXG5cIidgXXszLDE2MH0pW1wiJ2BdL2csXG4gIC8vIEFuIGlubGluZSB0ZXN0IGRlY2xhcmF0aW9uIHF1b3RlZCBpbiB0aGUgc3VtbWFyeS5cbiAgL1xcYig/OkRlbm9cXC50ZXN0fEB0ZXN0fGl0fHRlc3QpXFxzKlxcKD9cXHMqW1wiJ2BdKFteXCInYFxcbl17MywxNjB9KVtcIidgXS9nLFxuXTtcblxuLyoqXG4gKiBUaGUgd2hvbGUgbmFtZSBhZnRlciBhIGA6OmAgY2l0YXRpb24sIHVwIHRvIHRoZSBjbG9zaW5nIGJhY2t0aWNrIG9yIHRoZSBlbmQgb2ZcbiAqIHRoZSBsaW5lLCBzbyBhIHNwYWNlZCBuYW1lIChgZm9vX3Rlc3QudHM6OnNhbml0aXNlIC0gcmVqZWN0cyB0cmF2ZXJzYWxgKSBpc1xuICogcmVhZCBpbiBmdWxsIHJhdGhlciB0aGFuIGFzIGl0cyBmaXJzdCB3b3JkIChQUiAjMzkyMSByZXZpZXcpLiBObyBgXFxzKmAgYmVmb3JlXG4gKiB0aGUgY2xhc3M6IHRoZSBjYXB0dXJlIGlzIHRyaW1tZWQgYnkge0BsaW5rIG5vcm1hbGlzZX0uXG4gKi9cbmNvbnN0IEZVTExfQ0lURURfTkFNRV9QQVRURVJOID0gLzo6KFteYFxcbl17MywyMDB9KS9nO1xuXG4vKiogTG93ZXJjYXNlIGFuZCBjb2xsYXBzZSBwdW5jdHVhdGlvbiBzbyBgYV9iYCBhbmQgYGEgYmAgY29tcGFyZSBlcXVhbC4gKi9cbmZ1bmN0aW9uIG5vcm1hbGlzZSh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC50b0xvd2VyQ2FzZSgpLnJlcGxhY2UoL1teYS16MC05XSsvZywgXCIgXCIpLnRyaW0oKTtcbn1cblxuLyoqXG4gKiBNaW5pbXVtIGxlbmd0aCBvZiBhIG5vcm1hbGlzZWQgaWRlbnRpZmllciAoSXNzdWUgIzEyNzkpLiBGb3VyIGNoYXJhY3RlcnNcbiAqIGFkbWl0dGVkIGV2ZXJ5IGdlbmVyaWMgdG9rZW4gaW4gdGhlIGZsZWV0J3MgdGVzdCB2b2NhYnVsYXJ5LlxuICovXG5jb25zdCBNSU5fSURFTlRJRklFUl9MRU5HVEggPSA2O1xuXG4vKipcbiAqIFRva2VucyB0aGF0IG5hbWUgbm8gcGFydGljdWxhciB0ZXN0IChJc3N1ZSAjMTI3OSkuIEFuIGlkZW50aWZpZXIgYnVpbHQgb25seVxuICogZnJvbSB0aGVzZSDigJQgYHRlc3RgLCBgdGVzdF9jYXNlYCwgYGl0IHNob3VsZGAg4oCUIGNpdGVzIG5vdGhpbmcgY2hlY2thYmxlLCBzb1xuICogaXQgaXMgZHJvcHBlZCByYXRoZXIgdGhhbiBtYXRjaGVkIGFnYWluc3QgdGhlIGRpZmYuXG4gKi9cbmNvbnN0IEdFTkVSSUNfSURFTlRJRklFUl9UT0tFTlMgPSBuZXcgU2V0KFtcbiAgXCJ0ZXN0XCIsXG4gIFwidGVzdHNcIixcbiAgXCJzcGVjXCIsXG4gIFwic3BlY3NcIixcbiAgXCJkZW5vXCIsXG4gIFwiY2FzZVwiLFxuICBcImNhc2VzXCIsXG4gIFwiaXRcIixcbiAgXCJzaG91bGRcIixcbiAgXCJ0b2RvXCIsXG5dKTtcblxuLyoqIFdoZXRoZXIgYSBub3JtYWxpc2VkIGNhbmRpZGF0ZSBuYW1lcyBhIHNwZWNpZmljIHRlc3QgcmF0aGVyIHRoYW4gYSBzaGFwZS4gKi9cbmZ1bmN0aW9uIGlzTWVhbmluZ2Z1bElkZW50aWZpZXIoY2FuZGlkYXRlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKGNhbmRpZGF0ZS5sZW5ndGggPCBNSU5fSURFTlRJRklFUl9MRU5HVEgpIHJldHVybiBmYWxzZTtcbiAgcmV0dXJuIGNhbmRpZGF0ZVxuICAgIC5zcGxpdChcIiBcIilcbiAgICAuc29tZSgodG9rZW4pID0+ICFHRU5FUklDX0lERU5USUZJRVJfVE9LRU5TLmhhcyh0b2tlbikpO1xufVxuXG4vKipcbiAqIEV4dHJhY3QgdGhlIHRlc3QgaWRlbnRpZmllcnMgYSBQUiBzdW1tYXJ5IGNsYWltcyB0byBoYXZlIGFkZGVkLCBlLmcuIHRoZVxuICogYHJlamVjdHNfaW5qZWN0aW9uYCBpbiBgYHRlc3RzL2RiX3Rlc3QudHM6OnJlamVjdHNfaW5qZWN0aW9uYGAuIEdlbmVyaWMgYW5kXG4gKiB0cml2aWFsbHkgc2hvcnQgY2FuZGlkYXRlcyBhcmUgZHJvcHBlZCDigJQgc2VlIHtAbGluayBpc01lYW5pbmdmdWxJZGVudGlmaWVyfS5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RUZXN0SWRlbnRpZmllcnMoY29udGVudDogc3RyaW5nKTogc3RyaW5nW10ge1xuICBjb25zdCBzY2FubmVkID0gY29udGVudC5zbGljZSgwLCBNQVhfU0NBTl9DSEFSUyk7XG4gIGNvbnN0IGlkZW50aWZpZXJzID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGZvciAoY29uc3QgcGF0dGVybiBvZiBURVNUX0lERU5USUZJRVJfUEFUVEVSTlMpIHtcbiAgICBmb3IgKGNvbnN0IG1hdGNoIG9mIHNjYW5uZWQubWF0Y2hBbGwocGF0dGVybikpIHtcbiAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IG5vcm1hbGlzZShtYXRjaFsxXSA/PyBcIlwiKTtcbiAgICAgIGlmIChpc01lYW5pbmdmdWxJZGVudGlmaWVyKGNhbmRpZGF0ZSkpIGlkZW50aWZpZXJzLmFkZChjYW5kaWRhdGUpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gWy4uLmlkZW50aWZpZXJzXTtcbn1cblxuLyoqXG4gKiBUaGUgbmFtZXMgYSBQUiBzdW1tYXJ5IGNpdGVzIGZvciB0aGUgdGVzdHMgaXQgc2F5cyBpdCBhZGRlZCAoUFIgIzM5MjFcbiAqIHJldmlldyksIGFzIG5vcm1hbGlzZWQgd2hvbGUgbmFtZXMgZm9yIGFuIGV4YWN0IGNvbXBhcmlzb24gd2l0aCBhIGRlY2xhcmVkXG4gKiBuYW1lIOKAlCB1bmxpa2Uge0BsaW5rIGV4dHJhY3RUZXN0SWRlbnRpZmllcnN9LCB3aGljaCB0aGUgc3RhdGljIGdhdGUgbWF0Y2hlc1xuICogYXMgYSB3aG9sZSB0b2tlbiBpbnNpZGUgYSBkZWNsYXJhdGlvbiBsaW5lLlxuICpcbiAqIGBmdWxsYCBob2xkcyBlYWNoIGA6OmAgY2l0YXRpb24gcmVhZCB0byBpdHMgY2xvc2luZyBiYWNrdGljayBvciBlbmQgb2YgbGluZSxcbiAqIGFuZCBlYWNoIHF1b3RlZCBvciBpbmxpbmUgbmFtZS4gYHRva2Vuc2AgaG9sZHMgdGhlIGZpcnN0IHdvcmQgb2YgYSBgOjpgXG4gKiBjaXRhdGlvbiAoYDo6cmVqZWN0c19pbmplY3Rpb25gKSwgZm9yIGEgbmFtZSB3cml0dGVuIGluIHByb3NlIHdpdGggbm8gY2xvc2luZ1xuICogYmFja3RpY2s7IGl0IGlzIHRoZSBmaXJzdCB3b3JkIG9mIGEgc3BhY2VkIG5hbWUgdG9vLCBzbyB0aGUgY2FsbGVyIGNvbnN1bHRzIGl0XG4gKiBvbmx5IHdoZW4gbm8gZnVsbCBuYW1lIG1hdGNoZWQgYSBkZWNsYXJhdGlvbi5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGV4dHJhY3RDaXRlZFRlc3ROYW1lcyhcbiAgY29udGVudDogc3RyaW5nLFxuKTogeyBmdWxsOiBTZXQ8c3RyaW5nPjsgdG9rZW5zOiBTZXQ8c3RyaW5nPiB9IHtcbiAgY29uc3Qgc2Nhbm5lZCA9IGNvbnRlbnQuc2xpY2UoMCwgTUFYX1NDQU5fQ0hBUlMpO1xuICBjb25zdCBjb2xsZWN0ID0gKHBhdHRlcm5zOiBSZWdFeHBbXSk6IFNldDxzdHJpbmc+ID0+IHtcbiAgICBjb25zdCBmb3VuZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICAgIGZvciAoY29uc3QgcGF0dGVybiBvZiBwYXR0ZXJucykge1xuICAgICAgZm9yIChjb25zdCBtYXRjaCBvZiBzY2FubmVkLm1hdGNoQWxsKHBhdHRlcm4pKSB7XG4gICAgICAgIGNvbnN0IGNhbmRpZGF0ZSA9IG5vcm1hbGlzZShtYXRjaFsxXSA/PyBcIlwiKTtcbiAgICAgICAgaWYgKGlzTWVhbmluZ2Z1bElkZW50aWZpZXIoY2FuZGlkYXRlKSkgZm91bmQuYWRkKGNhbmRpZGF0ZSk7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiBmb3VuZDtcbiAgfTtcbiAgY29uc3QgW3Rva2VuLCAuLi5xdW90ZWRdID0gVEVTVF9JREVOVElGSUVSX1BBVFRFUk5TO1xuICByZXR1cm4ge1xuICAgIGZ1bGw6IGNvbGxlY3QoW0ZVTExfQ0lURURfTkFNRV9QQVRURVJOLCAuLi5xdW90ZWRdKSxcbiAgICB0b2tlbnM6IGNvbGxlY3QodG9rZW4gPyBbdG9rZW5dIDogW10pLFxuICB9O1xufVxuXG4vKipcbiAqIEFkZGVkIChgK2ApIGxpbmUgYm9kaWVzIG9mIGEgdW5pZmllZCBkaWZmLCBleGNsdWRpbmcgdGhlIGArKytgIGZpbGUgaGVhZGVyLlxuICogVGhlIGxlYWRpbmcgYCtgIGlzIHN0cmlwcGVkIHNvIGVhY2ggZW50cnkgaXMgdGhlIHNvdXJjZSBsaW5lIGFzIHdyaXR0ZW4uXG4gKi9cbmZ1bmN0aW9uIGFkZGVkTGluZXMoZGlmZlRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIGRpZmZUZXh0XG4gICAgLnNsaWNlKDAsIE1BWF9TQ0FOX0NIQVJTKVxuICAgIC5zcGxpdChcIlxcblwiKVxuICAgIC5maWx0ZXIoKGxpbmUpID0+IGxpbmUuc3RhcnRzV2l0aChcIitcIikgJiYgIWxpbmUuc3RhcnRzV2l0aChcIisrK1wiKSlcbiAgICAubWFwKChsaW5lKSA9PiBsaW5lLnNsaWNlKDEpKTtcbn1cblxuLyoqIExpbmVzIHRoYXQgZGVjbGFyZSBhIHRlc3QgYWNyb3NzIHRoaXMgZmxlZXQncyBlY29zeXN0ZW1zIChJc3N1ZSAjMTI3OSkuICovXG5jb25zdCBURVNUX0RFQ0xBUkFUSU9OX1BBVFRFUk5TOiBSZWdFeHBbXSA9IFtcbiAgL1xcYkRlbm9cXC50ZXN0XFxzKlxcKC8sIC8vIERlbm8udGVzdChcIm5hbWVcIiwg4oCmKSBhbmQgdGhlIG9iamVjdCBmb3JtXG4gIC9eXFxzKm5hbWVcXHMqOlxccypbXCInYF0vLCAvLyB0aGUgYG5hbWU6YCBmaWVsZCBvZiBEZW5vLnRlc3QoeyDigKYgfSlcbiAgLyhefFteLlxcd10pKGl0fHRlc3R8c3BlY2lmeSlcXHMqKFxcLlxccypbYS16XStcXHMqKT9cXChcXHMqW1wiJ2BdLywgLy8gSmVzdC9Nb2NoYS9DeXByZXNzXG4gIC9eXFxzKkB0ZXN0XFxiL2ksIC8vIEJBVFM6IEB0ZXN0IFwibmFtZVwiIHtcbiAgL1xcYmRlZlxccyt0ZXN0X1xcdytcXHMqXFwoLywgLy8gcHl0ZXN0XG4gIC9eXFxzKmZ1bmNcXHMrVGVzdFxcdypcXHMqXFwoLywgLy8gR286IGZ1bmMgVGVzdE5hbWUodCAqdGVzdGluZy5UKVxuXTtcblxuLyoqXG4gKiBKYXZhLXN0eWxlIGFubm90YXRpb24gYWxvbmUgb24gYSBsaW5lIOKAlCB0aGUgdGVzdCBuYW1lIGlzIG9uIHRoZSBsaW5lIHRoYXRcbiAqIGZvbGxvd3MgaXQsIHNvIHRoYXQgbmV4dCBsaW5lIGNvdW50cyBhcyB0aGUgZGVjbGFyYXRpb24uXG4gKi9cbmNvbnN0IFRFU1RfQU5OT1RBVElPTl9MSU5FID1cbiAgL15cXHMqQChUZXN0fFBhcmFtZXRlcml6ZWRUZXN0fFJlcGVhdGVkVGVzdHxUZXN0VGVtcGxhdGUpXFxzKihcXCguKlxcKSk/XFxzKiQvO1xuXG4vKipcbiAqIFJ1c3QgdGVzdCBhdHRyaWJ1dGUgYWxvbmUgb24gYSBsaW5lIOKAlCBgI1t0ZXN0XWAsIGAjW3Rva2lvOjp0ZXN0KOKApildYCxcbiAqIGAjW3JzdGVzdF1gLCBgI1twcm9wdGVzdF1gIOKApiBBcyB3aXRoIHRoZSBKYXZhIGFubm90YXRpb24gdGhlIG5hbWUgbGl2ZXMgb25cbiAqIGEgZm9sbG93aW5nIGxpbmUsIGJ1dCBSdXN0IGFsbG93cyBmdXJ0aGVyIGF0dHJpYnV0ZXMgaW4gYmV0d2VlblxuICogKGAjW3Nob3VsZF9wYW5pY11gKSwgc28gdGhlIHBlbmRpbmcgc3RhdGUgY2FycmllcyBhY3Jvc3MgdGhlbSB1bnRpbCB0aGVcbiAqIGBmbmAgbGluZSAoSXNzdWUgIzE2ODApLiBgI1tjZmcodGVzdCldYCBpcyBkZWxpYmVyYXRlbHkgYWJzZW50OiBpdCBnYXRlcyBhXG4gKiBtb2R1bGUsIG5vdCBhIHRlc3QgZnVuY3Rpb24uXG4gKi9cbmNvbnN0IFJVU1RfVEVTVF9BVFRSSUJVVEVfTElORSA9XG4gIC9eXFxzKiNcXFtcXHMqKD86dG9raW86Onxhc3luY19zdGQ6OnxhY3RpeF9ydDo6fHNtb2xfcG90YXQ6Oik/KD86dGVzdHxyc3Rlc3R8cHJvcHRlc3QpXFxiW15cXF1dKlxcXVxccyokLztcblxuLyoqIEFueSBhdHRyaWJ1dGUgYWxvbmUgb24gYSBsaW5lIOKAlCBtYXkgc2l0IGJldHdlZW4gdGhlIGF0dHJpYnV0ZSBhbmQgdGhlIGBmbmAuICovXG5jb25zdCBSVVNUX0FUVFJJQlVURV9MSU5FID0gL15cXHMqIyE/XFxbW15cXF1dKlxcXVxccyokLztcblxuLyoqIEEgUnVzdCBmdW5jdGlvbiBzaWduYXR1cmUg4oCUIHRoZSBkZWNsYXJhdGlvbiBhIHRlc3QgYXR0cmlidXRlIHBvaW50cyBhdC4gKi9cbmNvbnN0IFJVU1RfRk5fTElORSA9XG4gIC9eXFxzKig/OnB1Yig/OlxccypcXChbXildKlxcKSk/XFxzKyk/KD86Y29uc3RcXHMrKT8oPzphc3luY1xccyspPyg/OnVuc2FmZVxccyspPyg/OmV4dGVyblxccytcIlteXCJdKlwiXFxzKyk/Zm5cXHMrXFx3K1xccypbKDxdLztcblxuLyoqXG4gKiBBIHRlc3QgY2FsbCBvcGVuZWQgb24gb25lIGxpbmUgd2l0aCBub3RoaW5nIGFmdGVyIHRoZSBwYXJlbnRoZXNpcywgb3IgdGhlXG4gKiBvYmplY3QgZm9ybSdzIGJhcmUgYG5hbWU6YCDigJQgYGRlbm8gZm10YCB3cmFwcyBhIGxvbmcgZGVjbGFyYXRpb24gZXhhY3RseVxuICogc28sIGFuZCB0aGUgbmFtZSBsYW5kcyBvbiB0aGUgbGluZSB0aGF0IGZvbGxvd3MgKElzc3VlICMxNTgxKTpcbiAqXG4gKiAgICAgRGVuby50ZXN0KFxuICogICAgICAgXCJoYW5kbGVfbm9fY2hhbmdlc19waGFzZSAtIGFuIHVudHJ1c3RlZCBpbWFnZSB3aXRoaG9sZHMgdGhlIGNsb3NlXCIsXG4gKiAgICAgICBhc3luYyAoKSA9PiB7IOKApiB9LFxuICogICAgICk7XG4gKlxuICogVGhlIGxpbmUgY2FycnlpbmcgYERlbm8udGVzdChgIG1hdGNoZXMge0BsaW5rIFRFU1RfREVDTEFSQVRJT05fUEFUVEVSTlN9XG4gKiBidXQgaG9sZHMgbm8gbmFtZSwgc28gb24gaXRzIG93biB0aGUgZ2F0ZSByZXBvcnRlZCB0aGUgY2l0ZWQgdGVzdCBtaXNzaW5nXG4gKiBmcm9tIGEgYnJhbmNoIHRoYXQgYWRkZWQgaXQuIEFzIHdpdGggdGhlIEphdmEgYW5ub3RhdGlvbiwgdGhlIG5leHQgbGluZSBpc1xuICogdGhlIGRlY2xhcmF0aW9uIOKAlCB3aGVuIGl0IGlzIGEgc3RyaW5nIGxpdGVyYWwuXG4gKi9cbmNvbnN0IFRFU1RfQ0FMTF9PUEVORVJfTElORSA9XG4gIC8oXnxbXi5cXHddKShEZW5vXFwudGVzdHxpdHx0ZXN0fHNwZWNpZnkpXFxzKihcXC5cXHMqW2Etel0rXFxzKik/XFwoXFxzKiR8XlxccypuYW1lXFxzKjpcXHMqJC87XG5cbi8qKiBBIGxpbmUgdGhhdCBpcyBvbmx5IGEgc3RyaW5nIGxpdGVyYWwgKHRoZSB3cmFwcGVkIHRlc3QgbmFtZSksIHdpdGggb3Igd2l0aG91dCBpdHMgdHJhaWxpbmcgY29tbWEuICovXG5jb25zdCBTVFJJTkdfTElURVJBTF9MSU5FID0gL15cXHMqKFtcIidgXSlbXlwiJ2BdKlxcMVxccyosP1xccyokLztcblxuLyoqXG4gKiBBZGRlZCBsaW5lcyB0aGF0IGRlY2xhcmUgYSB0ZXN0LCBzbyBjaXRpbmcgYSB0b2tlbiBmcm9tIGFuIGFzc2VydGlvbiBib2R5XG4gKiBkb2VzIG5vdCBzYXRpc2Z5IHRoZSBnYXRlIChJc3N1ZSAjMTI3OSkuXG4gKi9cbmZ1bmN0aW9uIHRlc3REZWNsYXJhdGlvbkxpbmVzKGRpZmZUZXh0OiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGNvbnN0IGRlY2xhcmF0aW9uczogc3RyaW5nW10gPSBbXTtcbiAgbGV0IHByZXZpb3VzV2FzQW5ub3RhdGlvbiA9IGZhbHNlO1xuICBsZXQgcHJldmlvdXNXYXNPcGVuZXIgPSBmYWxzZTtcbiAgbGV0IHBlbmRpbmdSdXN0QXR0cmlidXRlID0gZmFsc2U7XG4gIGZvciAoY29uc3QgbGluZSBvZiBhZGRlZExpbmVzKGRpZmZUZXh0KSkge1xuICAgIGNvbnN0IGlzUnVzdERlY2xhcmF0aW9uID0gcGVuZGluZ1J1c3RBdHRyaWJ1dGUgJiYgUlVTVF9GTl9MSU5FLnRlc3QobGluZSk7XG4gICAgaWYgKFxuICAgICAgcHJldmlvdXNXYXNBbm5vdGF0aW9uIHx8XG4gICAgICBpc1J1c3REZWNsYXJhdGlvbiB8fFxuICAgICAgKHByZXZpb3VzV2FzT3BlbmVyICYmIFNUUklOR19MSVRFUkFMX0xJTkUudGVzdChsaW5lKSkgfHxcbiAgICAgIFRFU1RfREVDTEFSQVRJT05fUEFUVEVSTlMuc29tZSgocGF0dGVybikgPT4gcGF0dGVybi50ZXN0KGxpbmUpKVxuICAgICkge1xuICAgICAgZGVjbGFyYXRpb25zLnB1c2gobGluZSk7XG4gICAgfVxuICAgIHByZXZpb3VzV2FzQW5ub3RhdGlvbiA9IFRFU1RfQU5OT1RBVElPTl9MSU5FLnRlc3QobGluZSk7XG4gICAgcHJldmlvdXNXYXNPcGVuZXIgPSBURVNUX0NBTExfT1BFTkVSX0xJTkUudGVzdChsaW5lKTtcbiAgICAvLyBBIHRlc3QgYXR0cmlidXRlIG9wZW5zIHRoZSBwZW5kaW5nIHN0YXRlOyBmdXJ0aGVyIGF0dHJpYnV0ZSBsaW5lcyBjYXJyeVxuICAgIC8vIGl0OyBhbnl0aGluZyBlbHNlIGNsb3NlcyBpdCwgc28gYSBzdHJheSBgZm5gIG5ldmVyIGNvdW50cyAoSXNzdWUgIzE2ODApLlxuICAgIHBlbmRpbmdSdXN0QXR0cmlidXRlID0gUlVTVF9URVNUX0FUVFJJQlVURV9MSU5FLnRlc3QobGluZSkgfHxcbiAgICAgIChwZW5kaW5nUnVzdEF0dHJpYnV0ZSAmJiBSVVNUX0FUVFJJQlVURV9MSU5FLnRlc3QobGluZSkpO1xuICB9XG4gIHJldHVybiBkZWNsYXJhdGlvbnM7XG59XG5cbi8qKiBDYXAgb24gdGVzdC1kZWNsYXJhdGlvbiBsaW5lcyByZXBvcnRlZCBiYWNrIHRvIHRoZSBhZ2VudCAoSXNzdWUgIzE1NzUpLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9SRVBPUlRFRF9URVNUX0RFQ0xBUkFUSU9OUyA9IDEwO1xuXG4vKiogQ2FwIG9uIHRoZSBsZW5ndGggb2YgYSBzaW5nbGUgcmVwb3J0ZWQgZGVjbGFyYXRpb24gbGluZSAoSXNzdWUgIzE1NzUpLiAqL1xuZXhwb3J0IGNvbnN0IE1BWF9ERUNMQVJBVElPTl9MSU5FX0NIQVJTID0gMjAwO1xuXG4vKipcbiAqIFRoZSB0ZXN0IGRlY2xhcmF0aW9ucyB0aGUgZ2F0ZSBhY3R1YWxseSBtYXRjaGVkIGluIHRoZSBhZGRlZCBsaW5lcyBvZiB0aGVcbiAqIGJyYW5jaCdzIHRlc3QgZGlmZiAoSXNzdWUgIzE1NzUpLlxuICpcbiAqIEEgYHRlc3QtaWRlbnRpZmllci1pbi1kaWZmYCBibG9jayBzYXlzIG9ubHkgdGhhdCBubyBjaXRlZCBpZGVudGlmaWVyIG5hbWVkIGFcbiAqIGRlY2xhcmVkIHRlc3Qg4oCUIGl0IG5ldmVyIHNhaWQgd2hhdCB0aGUgZ2F0ZSAqZGlkKiBzZWUsIHNvIGEgZmFsc2UgYmxvY2tcbiAqICgjMTM4NSBsb3N0IHRocmVlIHJ1bnMgdG8gb25lKSBjb3VsZCBub3QgYmUgdG9sZCBhcGFydCBmcm9tIGEgcmVhbCBvbmUuIFRoZVxuICogbGluZXMgYXJlIGRlZHVwbGljYXRlZCwgdHJpbW1lZCwgdHJ1bmNhdGVkIGFuZCBjYXBwZWQgYXRcbiAqIHtAbGluayBNQVhfUkVQT1JURURfVEVTVF9ERUNMQVJBVElPTlN9OiB0aGV5IGFyZSBhZ2VudC1hdXRob3JlZCBkaWZmIHRleHQsIHNvXG4gKiBldmVyeSBjb25zdW1lciBmZW5jZXMgdGhlbSBhcyB1bnRydXN0ZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBtYXRjaGVkVGVzdERlY2xhcmF0aW9ucyh0ZXN0RGlmZlRleHQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3QgbWF0Y2hlZCA9IG5ldyBTZXQ8c3RyaW5nPigpO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgdGVzdERlY2xhcmF0aW9uTGluZXModGVzdERpZmZUZXh0KSkge1xuICAgIGNvbnN0IHRyaW1tZWQgPSBsaW5lLnRyaW0oKS5zbGljZSgwLCBNQVhfREVDTEFSQVRJT05fTElORV9DSEFSUyk7XG4gICAgaWYgKHRyaW1tZWQpIG1hdGNoZWQuYWRkKHRyaW1tZWQpO1xuICAgIGlmIChtYXRjaGVkLnNpemUgPj0gTUFYX1JFUE9SVEVEX1RFU1RfREVDTEFSQVRJT05TKSBicmVhaztcbiAgfVxuICByZXR1cm4gWy4uLm1hdGNoZWRdO1xufVxuXG4vKipcbiAqIFJlbmRlciB0aGUgbWF0Y2hlZCBkZWNsYXJhdGlvbnMgZm9yIGFuIG9wZXJhdG9yIGNvbW1lbnQgb3IgYSByZXRyeSBwcm9tcHRcbiAqIChJc3N1ZSAjMTU3NSkuIEVtcHR5IGlzIGEgZmluZGluZyBpbiBpdHMgb3duIHJpZ2h0IOKAlCB0aGUgYnJhbmNoIGRlY2xhcmVzIG5vXG4gKiB0ZXN0IGF0IGFsbCDigJQgYW5kIGlzIHN0YXRlZCByYXRoZXIgdGhhbiBsZWZ0IGJsYW5rLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZm9ybWF0TWF0Y2hlZFRlc3REZWNsYXJhdGlvbnMoXG4gIGRlY2xhcmF0aW9uczogcmVhZG9ubHkgc3RyaW5nW10sXG4pOiBzdHJpbmcge1xuICBpZiAoZGVjbGFyYXRpb25zLmxlbmd0aCA9PT0gMCkge1xuICAgIHJldHVybiBcIlRoZSBnYXRlIG1hdGNoZWQgTk8gdGVzdC1kZWNsYXJhdGlvbiBsaW5lIGluIHRoZSBhZGRlZCBsaW5lcyBvZiB0aGlzIGJyYW5jaCdzIHRlc3QgZGlmZiwgc28gbm8gY2l0YXRpb24gY291bGQgaGF2ZSBzYXRpc2ZpZWQgaXQuXCI7XG4gIH1cbiAgLy8gU2NydWJiZWQgYW5kIGNvZGUtZmVuY2VkLCBub3Qgbm9uY2UtZmVuY2VkOiB0aGUgbGluZXMgYXJlIGRpZmYgdGV4dCwgc29cbiAgLy8gdGhleSBtdXN0IHJlbmRlciBhcyBkYXRhIGluIHRoZSBjb21tZW50IGFuZCBzdGF5IGluZXJ0IGluIHRoZSByZXRyeVxuICAvLyBwcm9tcHQsIGJ1dCB0aGlzIG1lc3NhZ2UgaXMgYWxzbyB0aGUgb3BlcmF0b3IncyBldmlkZW5jZSBhbmQgbXVzdCByZWFkIHRoZVxuICAvLyBzYW1lIGV2ZXJ5IHRpbWUgaXQgaXMgYnVpbHQuXG4gIGNvbnN0IGJvZHkgPSBzY3J1YlVudHJ1c3RlZFRleHQoZGVjbGFyYXRpb25zLmpvaW4oXCJcXG5cIikpO1xuICBjb25zdCBmZW5jZSA9IGNvZGVGZW5jZUZvcihib2R5KTtcbiAgcmV0dXJuIGBUaGUgZ2F0ZSBtYXRjaGVkIHRoZXNlIHRlc3QgZGVjbGFyYXRpb25zIGluIHRoZSBhZGRlZCBsaW5lcyBvZiB0aGUgYnJhbmNoIGRpZmYgKHVwIHRvICR7TUFYX1JFUE9SVEVEX1RFU1RfREVDTEFSQVRJT05TfSkg4oCUIGlmIHRoZSB0ZXN0IHlvdSBjaXRlZCBpcyBsaXN0ZWQgaGVyZSwgdGhlIG5hbWUgaW4gdGhlIHN1bW1hcnkgZG9lcyBub3QgbWF0Y2ggdGhlIGRlY2xhcmVkIG9uZTpcblxuJHtmZW5jZX10ZXh0XG4ke2JvZHl9XG4ke2ZlbmNlfWA7XG59XG5cbi8qKiBXaGV0aGVyIGBoYXlzdGFja2AgY29udGFpbnMgYG5lZWRsZWAgYXMgYSB3aG9sZSBub3JtYWxpc2VkIHRva2VuIHJ1bi4gKi9cbmZ1bmN0aW9uIGNvbnRhaW5zV2hvbGVUb2tlbihoYXlzdGFjazogc3RyaW5nLCBuZWVkbGU6IHN0cmluZyk6IGJvb2xlYW4ge1xuICByZXR1cm4gYCAke2hheXN0YWNrfSBgLmluY2x1ZGVzKGAgJHtuZWVkbGV9IGApO1xufVxuXG4vKipcbiAqIE1vc3QgY2l0ZWQgdGVzdHMge0BsaW5rIGNpdGVkU2VjdXJpdHlUZXN0c30gcmV0dXJucyAoSXNzdWUgIzM2NTkpLiBCb3VuZHMgdGhlXG4gKiBudW1iZXIgb2YgcnVucyB0aGUgd29ya2VyIG1heSBiZSBhc2tlZCB0byBwZXJmb3JtIG9uIGFnZW50LWF1dGhvcmVkIGlucHV0LlxuICovXG5leHBvcnQgY29uc3QgTUFYX0NJVEVEX1NFQ1VSSVRZX1RFU1RTID0gMTA7XG5cbi8qKlxuICogVGhlIHRlc3QgZGVjbGFyYXRpb25zLCBwZXIgZmlsZSwgdGhhdCB0aGUgUFIgc3VtbWFyeSBjaXRlcyBhbmQgdGhlIGFkZGVkXG4gKiBsaW5lcyBvZiB0aGUgdGVzdCBkaWZmIGRlY2xhcmUgKElzc3VlICMzNjU5KS4gVW5zdXBwb3J0ZWQgbGFuZ3VhZ2VzIHJlbWFpblxuICogcmVwcmVzZW50ZWQgc28gdGhlIHJ1bm5lciBjYW4gcmVjb3JkIHdoeSBlYWNoIGNpdGVkIHRlc3QgY291bGQgbm90IHJ1bi5cbiAqXG4gKiBUaGUgZmlsZSBzZWN0aW9ucyBjb21lIGZyb20gdGhlIGArKysgYi88cGF0aD5gIGhlYWRlcnMgb2YgdGhlIHVuaWZpZWQgZGlmZjtcbiAqIGArKysgL2Rldi9udWxsYCAoYSBkZWxldGlvbikgbmFtZXMgbm8gZmlsZSBhbmQgaXMgc2tpcHBlZC4gVGhlIG1hdGNoIHJ1bGUgaXNcbiAqIHN0cmljdGVyIHRoYW4gdGhlIHN0YXRpYyBvbmUge0BsaW5rIGNpdGVkVGVzdElkZW50aWZpZXJJbkRpZmZ9IGFwcGxpZXM6IHRoZVxuICogZGVjbGFyZWQgbmFtZSwgbm9ybWFsaXNlZCwgbXVzdCBFUVVBTCBhIG5hbWUgdGhlIHN1bW1hcnkgY2l0ZXNcbiAqICh7QGxpbmsgZXh0cmFjdENpdGVkVGVzdE5hbWVzfSksIHNvIGEgZGVjbGFyYXRpb24gc2hhcmluZyBvbmx5IGEgd29yZCB3aXRoIHRoZVxuICogY2l0ZWQgbmFtZSBpcyBub3QgcnVuIGluIGl0cyBwbGFjZS4gVGhlIG5hbWUgcmV0dXJuZWQgaXMgdGhlIGZpcnN0IHN0cmluZ1xuICogbGl0ZXJhbCBvbiB0aGUgZGVjbGFyYXRpb24gbGluZSwgYXMgd3JpdHRlbiDigJQgb3IgdGhlIGZ1bmN0aW9uIG5hbWUgb2YgYVxuICogUnVzdCwgcHl0ZXN0LCBHbyBvciBKYXZhIHRlc3QgaW4gaXRzIG93biBsYW5ndWFnZSdzIGZpbGUuIEpTL1RTIGRlY2xhcmF0aW9uc1xuICogYWx3YXlzIHJldGFpbiB0aGVpciBzdHJpbmcgbmFtZSwgZXZlbiBpZiB0aGUgY2FsbGJhY2sgcmVzZW1ibGVzIGFub3RoZXJcbiAqIGxhbmd1YWdlJ3MgZnVuY3Rpb24gZGVjbGFyYXRpb24uIFRoZSBydW5uZXIgZXhlY3V0ZXMgb25seSBEZW5vIGFuZCBSdXN0O1xuICogdGhlIG90aGVyIGNpdGF0aW9ucyByZWNlaXZlIGEgbm90LXJ1biBjYXVzZS4gVGhlIHJlc3VsdCBpc1xuICogZGVkdXBsaWNhdGVkIGJ5IGZpbGUgYW5kIG5hbWUsIGtlcHQgaW4gZGlmZiBvcmRlciBhbmQgY2FwcGVkIGF0XG4gKiB7QGxpbmsgTUFYX0NJVEVEX1NFQ1VSSVRZX1RFU1RTfS4gQm91bmRlZCBwYXR0ZXJucyBvdmVyIGEgY2FwcGVkIHNsaWNlIG9ubHkg4oCUXG4gKiBib3RoIGlucHV0cyBhcmUgdW50cnVzdGVkLlxuICovXG5leHBvcnQgZnVuY3Rpb24gY2l0ZWRTZWN1cml0eVRlc3RzKFxuICBjb250ZW50OiBzdHJpbmcsXG4gIHRlc3REaWZmVGV4dDogc3RyaW5nLFxuKTogQ2l0ZWRTZWN1cml0eVRlc3RbXSB7XG4gIGNvbnN0IGNpdGVkID0gZXh0cmFjdENpdGVkVGVzdE5hbWVzKGNvbnRlbnQpO1xuICBpZiAoY2l0ZWQuZnVsbC5zaXplID09PSAwICYmIGNpdGVkLnRva2Vucy5zaXplID09PSAwKSByZXR1cm4gW107XG5cbiAgY29uc3Qgc2VjdGlvbnM6IHsgZmlsZTogc3RyaW5nOyBsaW5lczogc3RyaW5nW10gfVtdID0gW107XG4gIC8vIEh1bmstYXdhcmUgc3BsaXQ6IGluc2lkZSBhIGh1bmsgZXZlcnkgbGluZSBpcyBjb250ZW50LCBzbyBhbiBhZGRlZCBsaW5lXG4gIC8vIHdob3NlIHRleHQgaXMgYCsrIGIvb3RoZXJfdGVzdC50c2AgKHJlbmRlcmVkIGArKysgYi9vdGhlcl90ZXN0LnRzYCkgY2Fubm90XG4gIC8vIHJlLWF0dHJpYnV0ZSBsYXRlciBkZWNsYXJhdGlvbnMgdG8gYW5vdGhlciBmaWxlLiBPbmx5IG91dHNpZGUgYSBodW5rIG1heVxuICAvLyBgKysrIGAgb3BlbiBhIG5ldyBmaWxlIHNlY3Rpb24uXG4gIGxldCBvbGRSZW1haW5pbmcgPSAwO1xuICBsZXQgbmV3UmVtYWluaW5nID0gMDtcbiAgZm9yIChjb25zdCBsaW5lIG9mIHRlc3REaWZmVGV4dC5zbGljZSgwLCBNQVhfU0NBTl9DSEFSUykuc3BsaXQoXCJcXG5cIikpIHtcbiAgICBpZiAob2xkUmVtYWluaW5nID4gMCB8fCBuZXdSZW1haW5pbmcgPiAwKSB7XG4gICAgICBjb25zdCBtYXJrZXIgPSBsaW5lWzBdO1xuICAgICAgaWYgKG1hcmtlciA9PT0gXCJcXFxcXCIpIHtcbiAgICAgICAgLy8gXCJcXCBObyBuZXdsaW5lIGF0IGVuZCBvZiBmaWxlXCIgY29uc3VtZXMgbmVpdGhlciBjb3VudC5cbiAgICAgIH0gZWxzZSBpZiAobWFya2VyID09PSBcIitcIikge1xuICAgICAgICBuZXdSZW1haW5pbmctLTtcbiAgICAgIH0gZWxzZSBpZiAobWFya2VyID09PSBcIi1cIikge1xuICAgICAgICBvbGRSZW1haW5pbmctLTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIG9sZFJlbWFpbmluZy0tO1xuICAgICAgICBuZXdSZW1haW5pbmctLTtcbiAgICAgIH1cbiAgICAgIHNlY3Rpb25zW3NlY3Rpb25zLmxlbmd0aCAtIDFdPy5saW5lcy5wdXNoKGxpbmUpO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IGh1bmsgPSBIVU5LX0hFQURFUi5leGVjKGxpbmUpO1xuICAgIGlmIChodW5rKSB7XG4gICAgICBvbGRSZW1haW5pbmcgPSBodW5rWzFdID09PSB1bmRlZmluZWQgPyAxIDogTnVtYmVyKGh1bmtbMV0pO1xuICAgICAgbmV3UmVtYWluaW5nID0gaHVua1syXSA9PT0gdW5kZWZpbmVkID8gMSA6IE51bWJlcihodW5rWzJdKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAobGluZS5zdGFydHNXaXRoKFwiKysrIFwiKSkge1xuICAgICAgY29uc3QgdGFyZ2V0ID0gbGluZS5zbGljZSg0KS50cmltKCk7XG4gICAgICBpZiAodGFyZ2V0ID09PSBcIi9kZXYvbnVsbFwiKSB7XG4gICAgICAgIHNlY3Rpb25zLnB1c2goeyBmaWxlOiBcIlwiLCBsaW5lczogW10gfSk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICBzZWN0aW9ucy5wdXNoKHtcbiAgICAgICAgICBmaWxlOiB0YXJnZXQuc3RhcnRzV2l0aChcImIvXCIpID8gdGFyZ2V0LnNsaWNlKDIpIDogdGFyZ2V0LFxuICAgICAgICAgIGxpbmVzOiBbXSxcbiAgICAgICAgfSk7XG4gICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgIHNlY3Rpb25zW3NlY3Rpb25zLmxlbmd0aCAtIDFdPy5saW5lcy5wdXNoKGxpbmUpO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGRlY2xhcmVkOiBBcnJheTxDaXRlZFNlY3VyaXR5VGVzdCAmIHsgbm9ybWFsaXNlZDogc3RyaW5nIH0+ID0gW107XG4gIGZvciAoY29uc3Qgc2VjdGlvbiBvZiBzZWN0aW9ucykge1xuICAgIGlmICghc2VjdGlvbi5maWxlKSBjb250aW51ZTtcbiAgICBmb3IgKGNvbnN0IGRlY2xhcmF0aW9uIG9mIHRlc3REZWNsYXJhdGlvbkxpbmVzKHNlY3Rpb24ubGluZXMuam9pbihcIlxcblwiKSkpIHtcbiAgICAgIGNvbnN0IG5hbWUgPSBzZWN0aW9uLmZpbGUuZW5kc1dpdGgoXCIucnNcIilcbiAgICAgICAgPyBSVVNUX0ZOX05BTUVfUEFUVEVSTi5leGVjKGRlY2xhcmF0aW9uKT8uWzFdID8/IFwiXCJcbiAgICAgICAgOiBkZWNsYXJlZEZ1bmN0aW9uTmFtZShzZWN0aW9uLmZpbGUsIGRlY2xhcmF0aW9uKSA/P1xuICAgICAgICAgIFNUUklOR19OQU1FX1BBVFRFUk4uZXhlYyhkZWNsYXJhdGlvbik/LlsyXSA/PyBcIlwiO1xuICAgICAgaWYgKCFuYW1lLnRyaW0oKSkgY29udGludWU7XG4gICAgICBkZWNsYXJlZC5wdXNoKHsgZmlsZTogc2VjdGlvbi5maWxlLCBuYW1lLCBub3JtYWxpc2VkOiBub3JtYWxpc2UobmFtZSkgfSk7XG4gICAgfVxuICB9XG5cbiAgLy8gVGhlIGRlY2xhcmVkIG5hbWUgbXVzdCBlcXVhbCB0aGUgY2l0ZWQgbmFtZSwgbm90IG1lcmVseSBjb250YWluIGEgd29yZCBvZlxuICAvLyBpdDogYSBsb29zZXIgbWF0Y2ggcGlja3MgdGVzdHMgdGhlIHN1bW1hcnkgbmV2ZXIgbWVhbnQgKFBSICMzOTIxIHJldmlldykuXG4gIGxldCBjaG9zZW4gPSBkZWNsYXJlZC5maWx0ZXIoKGQpID0+IGNpdGVkLmZ1bGwuaGFzKGQubm9ybWFsaXNlZCkpO1xuICBpZiAoY2hvc2VuLmxlbmd0aCA9PT0gMCkge1xuICAgIGNob3NlbiA9IGRlY2xhcmVkLmZpbHRlcigoZCkgPT4gY2l0ZWQudG9rZW5zLmhhcyhkLm5vcm1hbGlzZWQpKTtcbiAgfVxuXG4gIGNvbnN0IGZvdW5kOiBDaXRlZFNlY3VyaXR5VGVzdFtdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgZm9yIChjb25zdCB7IGZpbGUsIG5hbWUgfSBvZiBjaG9zZW4pIHtcbiAgICBjb25zdCBrZXkgPSBgJHtmaWxlfVxcdTAwMDAke25hbWV9YDtcbiAgICBpZiAoc2Vlbi5oYXMoa2V5KSkgY29udGludWU7XG4gICAgc2Vlbi5hZGQoa2V5KTtcbiAgICBmb3VuZC5wdXNoKHsgZmlsZSwgbmFtZSB9KTtcbiAgICBpZiAoZm91bmQubGVuZ3RoID49IE1BWF9DSVRFRF9TRUNVUklUWV9URVNUUykgYnJlYWs7XG4gIH1cbiAgcmV0dXJuIGZvdW5kO1xufVxuXG4vKiogVW5zdXBwb3J0ZWQgZnVuY3Rpb24tbmFtZWQgdGVzdHMgc3RpbGwgbmVlZCBhIHJlY29yZGVkIG5vdC1ydW4gY2F1c2UuICovXG5mdW5jdGlvbiBkZWNsYXJlZEZ1bmN0aW9uTmFtZShcbiAgZmlsZTogc3RyaW5nLFxuICBkZWNsYXJhdGlvbjogc3RyaW5nLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgaWYgKGZpbGUuZW5kc1dpdGgoXCIucHlcIikpIHtcbiAgICByZXR1cm4gL15cXHMqKD86YXN5bmNcXHMrKT9kZWZcXHMrKHRlc3RfXFx3KylcXHMqXFwoLy5leGVjKGRlY2xhcmF0aW9uKT8uWzFdO1xuICB9XG4gIGlmIChmaWxlLmVuZHNXaXRoKFwiLmdvXCIpKSB7XG4gICAgcmV0dXJuIC9eXFxzKmZ1bmNcXHMrKFRlc3RcXHcqKVxccypcXCgvLmV4ZWMoZGVjbGFyYXRpb24pPy5bMV07XG4gIH1cbiAgaWYgKGZpbGUuZW5kc1dpdGgoXCIuamF2YVwiKSkge1xuICAgIHJldHVybiAvXlxccyooPzooPzpwdWJsaWN8cHJvdGVjdGVkfHByaXZhdGV8c3RhdGljfGZpbmFsKVxccyspKnZvaWRcXHMrKFxcdyspXFxzKlxcKC9cbiAgICAgIC5leGVjKGRlY2xhcmF0aW9uKT8uWzFdO1xuICB9XG4gIC8vIEpTL1RTIGRlY2xhcmF0aW9ucyBrZWVwIHRoZWlyIHN0cmluZyBuYW1lIGV2ZW4gd2hlbiB0aGUgY2FsbGJhY2sgY29udGFpbnNcbiAgLy8gYHZvaWQgY2hlY2soKWAgb3IgYSBzdHJpbmcgcmVzZW1ibGluZyBhbm90aGVyIGxhbmd1YWdlJ3MgZGVjbGFyYXRpb24uXG4gIHJldHVybiB1bmRlZmluZWQ7XG59XG5cbi8qKiBBIHVuaWZpZWQtZGlmZiBodW5rIGhlYWRlcjsgZ3JvdXBzIDEgYW5kIDIgYXJlIHRoZSBvcHRpb25hbCBvbGQvbmV3IGxpbmUgY291bnRzLiAqL1xuY29uc3QgSFVOS19IRUFERVIgPSAvXkBAIC1cXGR7MSw5fSg/OiwoXFxkezEsOX0pKT8gXFwrXFxkezEsOX0oPzosKFxcZHsxLDl9KSk/IEBALztcblxuLyoqIFRoZSBmdW5jdGlvbiBuYW1lIG9uIGEgUnVzdCBgZm5gIGRlY2xhcmF0aW9uIGxpbmUgKGdyb3VwIDEpLiAqL1xuY29uc3QgUlVTVF9GTl9OQU1FX1BBVFRFUk4gPSAvXFxiZm5cXHMrKFtBLVphLXpfXVtBLVphLXowLTlfXSopLztcblxuLyoqIFRoZSBmaXJzdCBzdHJpbmcgbGl0ZXJhbCBvbiBhIGRlY2xhcmF0aW9uIGxpbmU7IGdyb3VwIDIgaXMgaXRzIGNvbnRlbnQuICovXG5jb25zdCBTVFJJTkdfTkFNRV9QQVRURVJOID0gLyhbXCInYF0pKFteXCInYFxcbl0qKVxcMS87XG5cbi8qKlxuICogV2hldGhlciBhbnkgaWRlbnRpZmllciBjaXRlZCBpbiB0aGUgc3VtbWFyeSBhY3R1YWxseSBuYW1lcyBhIHRlc3QgZGVjbGFyZWRcbiAqIGluIHRoZSBhZGRlZCBsaW5lcyBvZiB0aGUgdGVzdCBkaWZmIOKAlCB0aGUgY291cGxpbmcgdGhhdCBwcm9zZSBhbG9uZSBjYW5ub3RcbiAqIGZha2UuIFRoZSBtYXRjaCBpcyBvbiB3aG9sZSB0b2tlbnMgb2YgYSBkZWNsYXJhdGlvbiBsaW5lLCBzbyBuZWl0aGVyIHRoZVxuICogYHRlc3RgIGluc2lkZSBgRGVuby50ZXN0YCBub3IgYSBuYW1lIHVzZWQgb25seSBpbiBhbiBhc3NlcnRpb24gYm9keSBjb3VudHNcbiAqIChJc3N1ZSAjMTI3OSkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjaXRlZFRlc3RJZGVudGlmaWVySW5EaWZmKFxuICBjb250ZW50OiBzdHJpbmcsXG4gIHRlc3REaWZmVGV4dDogc3RyaW5nLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IGRlY2xhcmF0aW9ucyA9IHRlc3REZWNsYXJhdGlvbkxpbmVzKHRlc3REaWZmVGV4dClcbiAgICAubWFwKG5vcm1hbGlzZSlcbiAgICAuZmlsdGVyKChsaW5lKSA9PiBsaW5lLmxlbmd0aCA+IDApO1xuICBpZiAoZGVjbGFyYXRpb25zLmxlbmd0aCA9PT0gMCkgcmV0dXJuIGZhbHNlO1xuICByZXR1cm4gZXh0cmFjdFRlc3RJZGVudGlmaWVycyhjb250ZW50KS5zb21lKChpZCkgPT5cbiAgICBkZWNsYXJhdGlvbnMuc29tZSgobGluZSkgPT4gY29udGFpbnNXaG9sZVRva2VuKGxpbmUsIGlkKSlcbiAgKTtcbn1cblxuLyoqIFdoZXRoZXIgdGhlIGlzc3VlIGxhYmVscyBjb250YWluIGBzZWN1cml0eWAgYXMgYSB3aG9sZSBsYWJlbC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNTZWN1cml0eUxhYmVsKGlzc3VlTGFiZWxzOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIGlzc3VlTGFiZWxzXG4gICAgLnNwbGl0KFwiLFwiKVxuICAgIC5tYXAoKGxhYmVsKSA9PiBsYWJlbC50cmltKCkudG9Mb3dlckNhc2UoKSlcbiAgICAuaW5jbHVkZXMoXCJzZWN1cml0eVwiKTtcbn1cblxuLyoqIFdoZXRoZXIgdGhlIGNvbnRlbnQgcmVmZXJlbmNlcyBhIGBTRUMtPGhleD5gIGZpbmRpbmcgaWQuICovXG5leHBvcnQgZnVuY3Rpb24gcmVmZXJlbmNlc0ZpbmRpbmdJZChjb250ZW50OiBzdHJpbmcpOiBib29sZWFuIHtcbiAgcmV0dXJuIEZJTkRJTkdfSURfUEFUVEVSTi50ZXN0KGNvbnRlbnQpO1xufVxuXG4vKipcbiAqIEV2YWx1YXRlIHRoZSBzZWN1cml0eS1maXggcGF0Y2gtdmVyaWZpY2F0aW9uIGdhdGUuXG4gKlxuICogVGhlIGdhdGUgaXMgYWN0aXZlIHdoZW4gdGhlIGlzc3VlIGNhcnJpZXMgdGhlIGBzZWN1cml0eWAgbGFiZWwgb3IgdGhlIFBSXG4gKiBzdW1tYXJ5IHJlZmVyZW5jZXMgYSBgU0VDLTxoZXg+YCBmaW5kaW5nIGlkLiBXaGVuIGFjdGl2ZSBpdCBhc3NlcnRzIHRoZVxuICogbWFjaGluZS1jaGVja2FibGUgZGlmZiBzaWduYWxzIGZpcnN0OiBhIHRlc3QgZmlsZSBjaGFuZ2VkIGFuZCBhIGNpdGVkIHRlc3RcbiAqIGlzIGRlY2xhcmVkIGluIHRoZSBhZGRlZCBsaW5lcy4gT25seSB3aGVuIGJvdGggaG9sZCBkb2VzIGl0IGNoZWNrIHRoZVxuICogd29ya2VyLWV4ZWN1dGVkIHJlY29yZDogbnVsbCBvciBub3RfY2hlY2tlZCB5aWVsZHMgZGlzY3JpbWluYXRpb24tbm90LWNoZWNrZWQ7XG4gKiBhbnkgY2hlY2tlZCBvdXRjb21lIG90aGVyIHRoYW4gcmVkIOKGkiBncmVlbiB5aWVsZHMgdGVzdC1kaXNjcmltaW5hdGVzLiBJdFxuICogdGhlbiBjaGVja3MgdGhlIHNlbGYtcmVwb3J0ZWQgdHJpZ2dlci1jbG9zZWQgc3RhdGVtZW50LiBQdXJlIOKAlCBpbnNwZWN0cyB0aGVcbiAqIHN1cHBsaWVkIHN0cmluZ3MgYW5kIHJlY29yZCwgbmV2ZXIgZXhlY3V0ZXMgYW55dGhpbmcuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBldmFsdWF0ZVNlY3VyaXR5Rml4R2F0ZShcbiAgaW5wdXQ6IFNlY3VyaXR5Rml4R2F0ZUlucHV0LFxuKTogU2VjdXJpdHlGaXhHYXRlUmVzdWx0IHtcbiAgY29uc3QgY29udGVudCA9IChpbnB1dC5wclN1bW1hcnlDb250ZW50ID8/IFwiXCIpLnNsaWNlKDAsIE1BWF9TQ0FOX0NIQVJTKTtcbiAgY29uc3QgaXNTZWN1cml0eUZpeCA9IGhhc1NlY3VyaXR5TGFiZWwoaW5wdXQuaXNzdWVMYWJlbHMpIHx8XG4gICAgcmVmZXJlbmNlc0ZpbmRpbmdJZChjb250ZW50KTtcblxuICBpZiAoIWlzU2VjdXJpdHlGaXgpIHtcbiAgICByZXR1cm4geyBpc1NlY3VyaXR5Rml4OiBmYWxzZSwgb2s6IHRydWUsIG1pc3Npbmc6IFtdIH07XG4gIH1cblxuICBjb25zdCBtaXNzaW5nOiBTZWN1cml0eUZpeEV2aWRlbmNlS2luZFtdID0gW107XG5cbiAgLy8gTWFjaGluZS1jaGVja2FibGUgZXZpZGVuY2Ug4oCUIHRoZSBnYXRlIHByb3BlciAoSXNzdWUgIzM2NTIpLlxuICBpZiAoIWlucHV0LmRpZmYpIHtcbiAgICBtaXNzaW5nLnB1c2goXCJkaWZmLXVuYXZhaWxhYmxlXCIpO1xuICB9IGVsc2Uge1xuICAgIGlmICghaW5wdXQuZGlmZi5jaGFuZ2VkRmlsZXMuc29tZShpc1Rlc3RGaWxlUGF0aCkpIHtcbiAgICAgIG1pc3NpbmcucHVzaChcInRlc3QtZmlsZS1jaGFuZ2VkXCIpO1xuICAgIH1cbiAgICBpZiAoIWNpdGVkVGVzdElkZW50aWZpZXJJbkRpZmYoY29udGVudCwgaW5wdXQuZGlmZi50ZXN0RGlmZlRleHQpKSB7XG4gICAgICBtaXNzaW5nLnB1c2goXCJ0ZXN0LWlkZW50aWZpZXItaW4tZGlmZlwiKTtcbiAgICB9XG4gIH1cblxuICAvLyBFeGVjdXRlZCByZWQg4oaSIGdyZWVuIHJlY29yZCAoSXNzdWUgIzM2NTkpLiBEdWUgb25seSBvbmNlIGEgdGVzdCBmaWxlIGlzXG4gIC8vIGNoYW5nZWQgYW5kIGEgY2l0ZWQgdGVzdCBpcyBkZWNsYXJlZDogdGhvc2UgYXJlIHRoZSBwcmVjb25kaXRpb25zIGZvciB0aGVcbiAgLy8gd29ya2VyIGhhdmluZyBhbnl0aGluZyB0byBydW4sIGFuZCBlYWNoIGFscmVhZHkgcmVwb3J0cyBpdHMgb3duIGZhdWx0LlxuICBpZiAoXG4gICAgaW5wdXQuZGlmZiAmJlxuICAgICFtaXNzaW5nLmluY2x1ZGVzKFwidGVzdC1maWxlLWNoYW5nZWRcIikgJiZcbiAgICAhbWlzc2luZy5pbmNsdWRlcyhcInRlc3QtaWRlbnRpZmllci1pbi1kaWZmXCIpXG4gICkge1xuICAgIGNvbnN0IHJlY29yZCA9IGlucHV0LmRpc2NyaW1pbmF0aW9uO1xuICAgIGlmICghcmVjb3JkIHx8IHJlY29yZC5raW5kID09PSBcIm5vdF9jaGVja2VkXCIpIHtcbiAgICAgIG1pc3NpbmcucHVzaChcImRpc2NyaW1pbmF0aW9uLW5vdC1jaGVja2VkXCIpO1xuICAgIH0gZWxzZSBpZiAoIShyZWNvcmQucHJlRml4ID09PSBcImZhaWxcIiAmJiByZWNvcmQucG9zdEZpeCA9PT0gXCJwYXNzXCIpKSB7XG4gICAgICBtaXNzaW5nLnB1c2goXCJ0ZXN0LWRpc2NyaW1pbmF0ZXNcIik7XG4gICAgfVxuICB9XG5cbiAgLy8gU2VsZi1yZXBvcnRlZCBwcm9zZSDigJQgcmV0YWluZWQgYXMgYSBodW1hbi1yZXZpZXcgYWlkLCBub3QgdGhlIGdhdGUuXG4gIGlmICghVFJJR0dFUl9DTE9TRUQudGVzdChjb250ZW50KSkgbWlzc2luZy5wdXNoKFwidHJpZ2dlci1jbG9zZWRcIik7XG5cbiAgcmV0dXJuIHsgaXNTZWN1cml0eUZpeDogdHJ1ZSwgb2s6IG1pc3NpbmcubGVuZ3RoID09PSAwLCBtaXNzaW5nIH07XG59XG5cbi8qKlxuICogUmVtZWRpYXRpb24gaW5zdHJ1Y3Rpb24gZm9yIGVhY2ggbWlzc2luZyBldmlkZW5jZSBpdGVtLlxuICpcbiAqIEV4cG9ydGVkIChJc3N1ZSAjNDA1Nykgc28gdGhlIGNvZGluZyBwcm9tcHQgY2FuIHN0YXRlIHRoZSBzYW1lIGNvbnRyYWN0IHVwXG4gKiBmcm9udCBpbnN0ZWFkIG9mIGxlYXZpbmcgYW4gYWdlbnQgdG8gZGlzY292ZXIgaXQgYnkgYmVpbmcgYmxvY2tlZCDigJQgb25lXG4gKiBzb3VyY2Ugb2YgdHJ1dGggZm9yIHdoYXQgdGhlIGdhdGUgZGVtYW5kcyBhbmQgd2hhdCB0aGUgcHJvbXB0IHByb21pc2VzLlxuICovXG5leHBvcnQgY29uc3QgU0VDVVJJVFlfRklYX0VWSURFTkNFX0RFU0NSSVBUSU9OUzogUmVjb3JkPFxuICBTZWN1cml0eUZpeEV2aWRlbmNlS2luZCxcbiAgc3RyaW5nXG4+ID0ge1xuICBcInRlc3QtZmlsZS1jaGFuZ2VkXCI6XG4gICAgXCJBZGQgb3IgbW9kaWZ5IGEgVEVTVCBGSUxFIGluIHRoaXMgYnJhbmNoLiBUaGUgYnJhbmNoIGRpZmYgY3VycmVudGx5IGNoYW5nZXMgbm8gdGVzdCBmaWxlLCBzbyB0aGVyZSBpcyBubyByZWdyZXNzaW9uIHRlc3QgdG8gdmVyaWZ5IOKAlCBwcm9zZSBpbiB0aGUgc3VtbWFyeSBjYW5ub3Qgc3Vic3RpdHV0ZSBmb3IgaXQuXCIsXG4gIFwidGVzdC1pZGVudGlmaWVyLWluLWRpZmZcIjpcbiAgICBcIk5hbWUgdGhlIEFDVFVBTCBURVNUIElERU5USUZJRVIgeW91IGFkZGVkLCBpbiB0aGUgZm9ybSBgcGF0aC90by9mb29fdGVzdC50czo6dGhlIHRlc3QgbmFtZWAsIGFuZCBtYWtlIHN1cmUgdGhhdCBuYW1lIG1hdGNoZXMgdGhlIGRlY2xhcmF0aW9uIG9mIGEgdGVzdCBhZGRlZCBpbiB0aGlzIGJyYW5jaCdzIGRpZmYuIEEgZ2VuZXJpYyB0b2tlbiAoYHRlc3RgLCBgc3BlY2AsIGBjYXNlYCwg4oCmKSBvciBhIG5hbWUgdGhhdCBvbmx5IGFwcGVhcnMgaW5zaWRlIGEgdGVzdCBib2R5IGRvZXMgbm90IGNvdW50LiBUaGUgc3VtbWFyeSBlaXRoZXIgbmFtZXMgbm8gdGVzdCBvciBuYW1lcyBvbmUgdGhhdCBkb2VzIG5vdCBkZWNsYXJlIGEgdGVzdCBpbiB0aGUgYWRkZWQgbGluZXMuXCIsXG4gIFwiZGlmZi11bmF2YWlsYWJsZVwiOlxuICAgIFwiVGhlIGJyYW5jaCBkaWZmIGNvdWxkIG5vdCBiZSBjb21wdXRlZCBhZ2FpbnN0IHRoZSBiYXNlIGJyYW5jaCwgc28gdGhlIG1hY2hpbmUtY2hlY2thYmxlIHRlc3QgYXNzZXJ0aW9uIGNvdWxkIG5vdCBydW4uIEVuc3VyZSB0aGUgYmFzZSBicmFuY2ggaXMgZmV0Y2hlZCAoYGdpdCBmZXRjaCBvcmlnaW4gPGJhc2U+YCkgYW5kIHJldHJ5IOKAlCBhbiB1bmNoZWNrYWJsZSBzZWN1cml0eSBmaXggaXMgYmxvY2tlZCByYXRoZXIgdGhhbiBhc3N1bWVkIGdvb2QuXCIsXG4gIFwidGVzdC1kaXNjcmltaW5hdGVzXCI6XG4gICAgXCJUaGUgY2l0ZWQgdGVzdCBtdXN0IEZBSUwgYWdhaW5zdCB0aGUgYmFzZSBicmFuY2gncyB2ZXJzaW9ucyBvZiB0aGUgY2hhbmdlZCBub24tdGVzdCBmaWxlcyBhbmQgUEFTUyBhdCB0aGUgaGVhZC4gVGhlIHdvcmtlciByYW4gaXQgYm90aCB3YXlzIGluIGEgZGlzcG9zYWJsZSBjaGVja291dCBhbmQgaXQgZGlkIG5vdCBnbyByZWQgdGhlbiBncmVlbiwgc28gaXQgZG9lcyBub3QgZGlzY3JpbWluYXRlIHRoZSBmaXguIE1ha2UgdGhlIHRlc3QgZXhlcmNpc2UgdGhlIHZ1bG5lcmFibGUgY29kZSBwYXRoIHRoZSBmaXggY2hhbmdlcywgc28gdGhhdCBpdCBmYWlscyBvbiB0aGUgdW5maXhlZCBjb2RlLlwiLFxuICBcImRpc2NyaW1pbmF0aW9uLW5vdC1jaGVja2VkXCI6XG4gICAgXCJUaGUgd29ya2VyIGNvdWxkIG5vdCBydW4gdGhlIGNpdGVkIHRlc3QgYWdhaW5zdCBib3RoIHRoZSBiYXNlIGFuZCB0aGUgaGVhZCAocnVubmVyIGVycm9yLCB1bnJlc29sdmFibGUgYmFzZSByZWYsIGJ1aWxkIGZhaWx1cmUsIHRpbWVvdXQsIG9yIGEgY2l0ZWQgdGVzdCBpbiBhIGxhbmd1YWdlIHRoZSB3b3JrZXIgY2Fubm90IGV4ZWN1dGUpLCBzbyB3aGV0aGVyIGl0IGRpc2NyaW1pbmF0ZXMgdGhlIGZpeCBpcyB1bmNoZWNrZWQuIEFuIHVuY2hlY2tlZCBzZWN1cml0eSBmaXggaXMgYmxvY2tlZCwgbmV2ZXIgYXNzdW1lZCBnb29kLCBhbmQgbmV2ZXIgY291bnRlZCBhcyB0aGUgcmVkIHJ1bi4gVG9kYXkgdGhlIHdvcmtlciBjYW4gZXhlY3V0ZSB0d28ga2luZHMgb2YgdGVzdDogYSBgRGVuby50ZXN0YCB3aXRoIGEgc3RyaW5nIG5hbWUgaW4gYSBgKl90ZXN0LipgIG9yIGAqLnRlc3QuKmAgZmlsZSB1bmRlciBhIGBkZW5vLmpzb25gLCBgZGVuby5qc29uY2Agb3IgYGRlbm8ubG9ja2AgcHJvamVjdCwgYW5kIGEgUnVzdCBgI1t0ZXN0XSBmbmAgaW4gYSBgLnJzYCBmaWxlIHVuZGVyIGEgYENhcmdvLnRvbWxgIHBhY2thZ2UuXCIsXG4gIFwidHJpZ2dlci1jbG9zZWRcIjpcbiAgICAnQWRkIGEgc2hvcnQgc3RhdGVtZW50IHRoYXQgdGhlIE9SSUdJTkFMIFRSSUdHRVIgaXMgY2xvc2VkIHdpdGggbm8gdHJpdmlhbCBieXBhc3MgKHN0YXRpYyByZWFzb25pbmcgb3ZlciB0aGUgY2hhbmdlZCBjb2RlIHBhdGgg4oCUIGUuZy4gXCJ0aGUgb3JpZ2luYWwgYXR0YWNrIGlucHV0IGlzIG5vdyByZWplY3RlZCBieSB0aGUgYWxsb3dsaXN0IGFuZCBubyBlcXVpdmFsZW50IGJ5cGFzcyBleGlzdHNcIikuJyxcbn07XG5cbi8qKlxuICogRXZpZGVuY2UgaXRlbXMgYSBzZWN1cml0eS1maXggUFIgbXVzdCBwb3NpdGl2ZWx5IHN1cHBseSwgaW4gdGhlIG9yZGVyIHRoZVxuICogcHJvbXB0IHN0YXRlcyB0aGVtIChJc3N1ZSAjNDA1NykuIGBkaWZmLXVuYXZhaWxhYmxlYCBhbmRcbiAqIGBkaXNjcmltaW5hdGlvbi1ub3QtY2hlY2tlZGAgYXJlIGV4Y2x1ZGVkIGJlY2F1c2UgdGhleSByZXBvcnQgYW4gZW52aXJvbm1lbnRcbiAqIGZhdWx0IHRoZSBzdW1tYXJ5IGNhbm5vdCBiZSB3cml0dGVuIHRvIHNhdGlzZnkuXG4gKi9cbmV4cG9ydCBjb25zdCBSRVFVSVJFRF9TRUNVUklUWV9GSVhfRVZJREVOQ0U6XG4gIHJlYWRvbmx5IFNlY3VyaXR5Rml4RXZpZGVuY2VLaW5kW10gPSBbXG4gICAgXCJ0ZXN0LWZpbGUtY2hhbmdlZFwiLFxuICAgIFwidGVzdC1pZGVudGlmaWVyLWluLWRpZmZcIixcbiAgICBcInRlc3QtZGlzY3JpbWluYXRlc1wiLFxuICAgIFwidHJpZ2dlci1jbG9zZWRcIixcbiAgXTtcblxuLyoqIFdoZXRoZXIgYSB2YWx1ZSBpcyBvbmUgb2YgdGhlIGdhdGUncyBldmlkZW5jZSBraW5kcyAoSXNzdWUgIzQwNTcpLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzU2VjdXJpdHlGaXhFdmlkZW5jZUtpbmQoXG4gIHZhbHVlOiB1bmtub3duLFxuKTogdmFsdWUgaXMgU2VjdXJpdHlGaXhFdmlkZW5jZUtpbmQge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmXG4gICAgT2JqZWN0Lmhhc093bihTRUNVUklUWV9GSVhfRVZJREVOQ0VfREVTQ1JJUFRJT05TLCB2YWx1ZSk7XG59XG5cbi8qKlxuICogUmVuZGVyIHRoZSByZWNvcmRlZCBkaXNjcmltaW5hdGlvbiBydW5zIChJc3N1ZSAjMzY1OSkuIFRoZSB0ZXN0IG5hbWUgYW5kIHRoZVxuICogcmVhc29uIGFyZSBhZ2VudC1hdXRob3JlZCBvciB0b29sIG91dHB1dCwgc28gdGhleSBhcmUgc2NydWJiZWQgYW5kXG4gKiBjb2RlLWZlbmNlZCBleGFjdGx5IGFzIHtAbGluayBmb3JtYXRNYXRjaGVkVGVzdERlY2xhcmF0aW9uc30gZG9lcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGZvcm1hdERpc2NyaW1pbmF0aW9uUmVjb3JkKFxuICBkaXNjcmltaW5hdGlvbjogU2VjdXJpdHlGaXhEaXNjcmltaW5hdGlvbixcbik6IHN0cmluZyB7XG4gIGNvbnN0IHJ1bkxpbmVzID0gKHJ1bjogRGlzY3JpbWluYXRpb25SdW4pID0+IFtcbiAgICBgJHtydW4udGVzdC5maWxlfTo6JHtydW4udGVzdC5uYW1lfWAsXG4gICAgYGJhc2UgcHJvZHVjdGlvbiBmaWxlczogJHtydW4ucHJlRml4fSAoZXhwZWN0ZWQgZmFpbClgLFxuICAgIGBoZWFkOiAke3J1bi5wb3N0Rml4fSAoZXhwZWN0ZWQgcGFzcylgLFxuICBdO1xuICBjb25zdCBvdGhlcnMgPSBkaXNjcmltaW5hdGlvbi5raW5kID09PSBcImNoZWNrZWRcIlxuICAgID8gZGlzY3JpbWluYXRpb24ub3RoZXJzXG4gICAgOiBkaXNjcmltaW5hdGlvbi5ydW5zO1xuICBjb25zdCBsaW5lcyA9IFtcbiAgICAuLi4oZGlzY3JpbWluYXRpb24ua2luZCA9PT0gXCJjaGVja2VkXCJcbiAgICAgID8gcnVuTGluZXMoZGlzY3JpbWluYXRpb24pXG4gICAgICA6IFtkaXNjcmltaW5hdGlvbi5yZWFzb25dKSxcbiAgICAuLi4ob3RoZXJzID8/IFtdKS5mbGF0TWFwKChvKSA9PiBbXCJcIiwgLi4ucnVuTGluZXMobyldKSxcbiAgICAuLi4oZGlzY3JpbWluYXRpb24ubm90UnVuID8/IFtdKS5mbGF0TWFwKChydW4pID0+IFtcbiAgICAgIFwiXCIsXG4gICAgICBgJHtydW4udGVzdC5maWxlfTo6JHtydW4udGVzdC5uYW1lfWAsXG4gICAgICBgbm90IHJ1bjogJHtydW4ucmVhc29ufWAsXG4gICAgXSksXG4gIF07XG4gIGNvbnN0IGJvZHkgPSBzY3J1YlVudHJ1c3RlZFRleHQobGluZXMuam9pbihcIlxcblwiKSk7XG4gIGNvbnN0IGZlbmNlID0gY29kZUZlbmNlRm9yKGJvZHkpO1xuICByZXR1cm4gYFJlY29yZGVkIGRpc2NyaW1pbmF0aW9uIHJ1bnM6XG5cbiR7ZmVuY2V9dGV4dFxuJHtib2R5fVxuJHtmZW5jZX1gO1xufVxuXG4vKipcbiAqIEJ1aWxkIHRoZSBvcGVyYXRvci1mYWNpbmcgZmFpbHVyZSBtZXNzYWdlIGZvciBhIGJsb2NrZWQgc2VjdXJpdHktZml4IFBSLlxuICogTGlzdHMgZXhhY3RseSB3aGF0IHRoZSBQUiBzdW1tYXJ5IG11c3QgYWRkIHNvIHRoZSByZXRyeSBpcyBwcm9kdWN0aXZlLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRTZWN1cml0eUZpeEdhdGVNZXNzYWdlKFxuICBtaXNzaW5nOiBTZWN1cml0eUZpeEV2aWRlbmNlS2luZFtdLFxuICBkZWNsYXJhdGlvbnM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBkaXNjcmltaW5hdGlvbjogU2VjdXJpdHlGaXhEaXNjcmltaW5hdGlvbiB8IG51bGwsXG4pOiBzdHJpbmcge1xuICBjb25zdCBpdGVtcyA9IG1pc3NpbmdcbiAgICAubWFwKChraW5kKSA9PiBgLSAke1NFQ1VSSVRZX0ZJWF9FVklERU5DRV9ERVNDUklQVElPTlNba2luZF19YClcbiAgICAuam9pbihcIlxcblwiKTtcbiAgLy8gQSBtaXNzaW5nIHRlc3QgaWRlbnRpZmllciBpcyB0aGUgb25lIHZlcmRpY3QgYW4gYWdlbnQgY2Fubm90IGNoZWNrIGZvclxuICAvLyBpdHNlbGYsIHNvIHRoZSBibG9jayBzdGF0ZXMgd2hhdCB0aGUgZ2F0ZSBtYXRjaGVkIChJc3N1ZSAjMTU3NSkuXG4gIGNvbnN0IG1hdGNoZWQgPSBtaXNzaW5nLmluY2x1ZGVzKFwidGVzdC1pZGVudGlmaWVyLWluLWRpZmZcIilcbiAgICA/IGBcXG5cXG4ke2Zvcm1hdE1hdGNoZWRUZXN0RGVjbGFyYXRpb25zKGRlY2xhcmF0aW9ucyl9YFxuICAgIDogXCJcIjtcbiAgY29uc3QgcmVjb3JkZWQgPSAobWlzc2luZy5pbmNsdWRlcyhcInRlc3QtZGlzY3JpbWluYXRlc1wiKSB8fFxuICAgICAgbWlzc2luZy5pbmNsdWRlcyhcImRpc2NyaW1pbmF0aW9uLW5vdC1jaGVja2VkXCIpKSAmJiBkaXNjcmltaW5hdGlvblxuICAgID8gYFxcblxcbiR7Zm9ybWF0RGlzY3JpbWluYXRpb25SZWNvcmQoZGlzY3JpbWluYXRpb24pfWBcbiAgICA6IFwiXCI7XG4gIHJldHVybiBgUFIgY3JlYXRpb24gYmxvY2tlZDogdGhpcyBQUiBjbG9zZXMgYSBzZWN1cml0eS1sYWJlbGxlZCBmaW5kaW5nIGJ1dCBpcyBtaXNzaW5nIHJlcXVpcmVkIHZ1bG5lcmFiaWxpdHktZml4IHZlcmlmaWNhdGlvbiBldmlkZW5jZS5cblxuQW55IFBSIHRoYXQgY2xvc2VzIGEgXFxgc2VjdXJpdHlcXGAgZmluZGluZyBtdXN0IHNob3cg4oCUIGluIHRoZSBicmFuY2ggZGlmZiwgbm90IG9ubHkgaW4gcHJvc2Ug4oCUIHRoYXQgdGhlIGZhdWx0IGlzIGdlbnVpbmVseSBjbG9zZWQgKGZhaWwgbG91ZCDigJQgbmV2ZXIgbWFzayBhIGZhdWx0IGFzIHN1Y2Nlc3MsIElzc3VlICMzMjM0KTpcblxuJHtpdGVtc30ke21hdGNoZWR9JHtyZWNvcmRlZH1cblxuRml4IHRoZSBicmFuY2ggKGFuZCBcXGBkb2NzL2FyY2hpdmUvcHItc3VtbWFyaWVzL3ByLXN1bW1hcnktPGlzc3VlPi5tZFxcYCksIHRoZW4gcmV0cnkuIFRoZSB0ZXN0LWZpbGUgYW5kIHRlc3QtaWRlbnRpZmllciBhc3NlcnRpb25zIGFyZSBzdGF0aWMgY2hlY2tzIG92ZXIgXFxgZ2l0IGRpZmZcXGA7IHRoZSBkaXNjcmltaW5hdGlvbiBjaGVjayBpcyBleGVjdXRlZCBieSB0aGUgd29ya2VyIChub3QgdGhlIGFnZW50KSBpbiBhIGRpc3Bvc2FibGUgY2hlY2tvdXQ7IHRoZSB0cmlnZ2VyLWNsb3NlZCBzdGF0ZW1lbnQgaXMgc3RhdGljIHJlYXNvbmluZyBvdmVyIHRoZSBjaGFuZ2VkIGNvZGUgcGF0aC5gO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQXFEQyxHQUVELFNBQVMsWUFBWSxFQUFFLGtCQUFrQixRQUFRLHdCQUF3QjtBQThEekUsNEVBQTRFLEdBQzVFLE1BQU0saUJBQWlCO0FBRXZCLDBFQUEwRSxHQUMxRSxNQUFNLHFCQUFxQjtBQUUzQjs7O0NBR0MsR0FDRCxNQUFNLGlCQUNKO0FBRUYsMEVBQTBFLEdBQzFFLE1BQU0scUJBQStCO0VBQ25DO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRDtBQUVELGlEQUFpRCxHQUNqRCxPQUFPLFNBQVMsZUFBZSxJQUFZO0VBQ3pDLE1BQU0sVUFBVSxLQUFLLElBQUk7RUFDekIsSUFBSSxDQUFDLFNBQVMsT0FBTztFQUNyQixPQUFPLG1CQUFtQixJQUFJ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
// denoCacheMetadata=5074106252556329963,12063961041154978884