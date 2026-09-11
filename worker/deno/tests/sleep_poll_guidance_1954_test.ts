/**
 * No prompt may recommend `sleep` as a polling primitive (Issue #1954).
 *
 * `prompts/coding_guidelines/prompt.md` told an agent that, when it genuinely
 * must poll, it should bound the loop with "a fixed maximum number of
 * iterations, each with a `sleep`". The agent harness refuses a foreground
 * `sleep` in its Bash tool, so the one pattern the guidelines recommended is
 * the one pattern the runtime will not run — an agent waiting for CI followed
 * it, hit the refusal and lost the turn.
 *
 * Three properties are pinned here:
 *
 *   - **Every template, always.** Each `*.md` under `prompts/` is read off
 *     disk, so a new template is governed the day it lands and no waiver list
 *     can grow.
 *   - **The recommendation, not the word.** A prompt may still *forbid* a
 *     sleep-poll loop, or describe one as an audit finding in code under
 *     test. What it may not do is offer one as the way to wait — a sentence
 *     that names the `sleep` command alongside a polling cue must carry a
 *     prohibition.
 *   - **A working alternative is named.** The coding-guidelines and CI-fix
 *     templates must name a wait command that blocks inside `gh` rather than
 *     in the shell, and say what bounds it.
 *
 * The guard's own verdict on those commands is asserted too: they are reads,
 * so the agent-side `gh` shim must pass `--watch` through.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { evaluateGhCommand } from "../lib/gh_guard_decision.ts";
import { REPO_ROOT } from "./support/repo_root.ts";
import { flattenAll } from "./support/prompt_prose.ts";

const PROMPTS_DIR = `${REPO_ROOT}prompts`;

/**
 * `sleep` used as a shell command — `sleep 30`, a `` `sleep` `` code span, or
 * `sleep $SECONDS`. Prose about a test that "sleeps for five seconds", or a
 * `time.sleep(…)` finding in someone else's code, is a different subject and
 * is deliberately not matched.
 */
const SHELL_SLEEP_RE = /\bsleep(?:\s+[\d$]|\s*`)/i;

/** The sentence is about waiting on something that has not finished yet. */
const POLL_CUE_RE = /\b(?:poll\w*|spin-wait|wait|waits|watch\w*|background)\b/i;

/**
 * The clause carrying the `sleep` forbids it rather than offering it.
 *
 * Read per clause, not per sentence: "the harness blocks background jobs, so
 * poll with `sleep 30`" is a recommendation wearing a prohibition's clothes,
 * and a sentence-wide test would excuse it on the strength of "blocks".
 */
const PROHIBITION_RE =
  /\b(?:do\s+not|don't|never|refus\w+|block\w+|unavailable|not\s+available|forbidden|banned?|cannot|must\s+not|no\s+longer)\b/i;

/** Clause boundaries within one sentence. */
const CLAUSE_SPLIT_RE = /[,;]|\s+—\s+/;

/** One sentence of a template, with the source line it started on. */
interface Sentence {
  line: number;
  text: string;
}

/**
 * Split a template into sentences, keeping code spans and fences so a
 * `sleep` inside one is still read.
 *
 * A list item is its own sentence even without a full stop, so an audit
 * template's `Flag:` bullets are judged one at a time rather than as one
 * run-on paragraph.
 *
 * @param text - The template's full text
 * @returns Every sentence with the 1-based line it starts on
 */
function sentences(text: string): Sentence[] {
  const { flat, lineAt } = flattenAll(text);
  const boundaries = /(?<=[.!?])\s+|\n(?=\s*(?:[-*+]|\d+\.)\s)/g;
  const out: Sentence[] = [];
  let start = 0;
  for (const match of flat.matchAll(boundaries)) {
    const end = (match.index ?? 0) + match[0].length;
    out.push({ line: lineAt(start), text: flat.slice(start, end) });
    start = end;
  }
  if (start < flat.length) {
    out.push({ line: lineAt(start), text: flat.slice(start) });
  }
  return out;
}

/**
 * Whether a sentence offers a `sleep` poll as the way to wait.
 *
 * The subject is read from the whole sentence — "if you must poll" can sit
 * one clause away from the `sleep` it introduces — while the prohibition must
 * govern the clause the `sleep` command is actually in.
 *
 * @param sentence - One sentence of a template
 * @returns True when the sentence recommends a sleep poll
 */
function recommendsSleepPoll(sentence: string): boolean {
  if (!POLL_CUE_RE.test(sentence)) return false;
  return sentence.split(CLAUSE_SPLIT_RE).some((clause) =>
    SHELL_SLEEP_RE.test(clause) && !PROHIBITION_RE.test(clause)
  );
}

/**
 * Sentences that offer a `sleep` poll as the way to wait.
 *
 * @param text - The template's full text
 * @returns One `line N: <sentence>` entry per recommendation
 */
export function findSleepPollRecommendations(text: string): string[] {
  return sentences(text)
    .filter((s) => recommendsSleepPoll(s.text))
    .map((s) => `line ${s.line}: ${s.text.replace(/\s+/g, " ").trim()}`);
}

/** Every `*.md` shipped under `prompts/`, in path order. */
async function promptTemplates(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.name.endsWith(".md")) found.push(path);
    }
  };
  await walk(PROMPTS_DIR);
  return found.sort();
}

// ---------------------------------------------------------------------------
// The detector itself
// ---------------------------------------------------------------------------

Deno.test("findSleepPollRecommendations - flags a bounded sleep poll loop", () => {
  const hits = findSleepPollRecommendations(
    "If you genuinely must poll, bound it: a fixed maximum number of\n" +
      "iterations, each with a `sleep`, and report that you gave up.\n",
  );
  assertEquals(
    hits.length,
    1,
    `expected the recommendation to be flagged: ${hits}`,
  );
});

Deno.test("findSleepPollRecommendations - accepts a prohibition", () => {
  const hits = findSleepPollRecommendations(
    "Never wait with `sleep 30` in a loop — the harness refuses a\n" +
      "foreground sleep, so the turn is lost.\n",
  );
  assertEquals(hits, []);
});

Deno.test("findSleepPollRecommendations - ignores sleep in code under test", () => {
  const hits = findSleepPollRecommendations(
    "- **A wall-clock sleep** — `await delay(2000)`, `sleep 5`,\n" +
      "  `Thread.sleep(…)`, `time.sleep(…)`;\n",
  );
  assertEquals(hits, []);
});

Deno.test("findSleepPollRecommendations - flags a poll dressed as a prohibition", () => {
  // The prohibition must govern the clause the `sleep` is in: a sentence that
  // merely mentions a block elsewhere is still recommending the poll.
  const hits = findSleepPollRecommendations(
    "The harness blocks background jobs, so poll with `sleep 30` in a\n" +
      "bounded loop.\n",
  );
  assertEquals(hits.length, 1, `expected the poll to be flagged: ${hits}`);
});

Deno.test("findSleepPollRecommendations - ignores a watch command", () => {
  const hits = findSleepPollRecommendations(
    "Wait with `gh run watch <id> --exit-status`, which blocks inside `gh`.\n",
  );
  assertEquals(hits, []);
});

// ---------------------------------------------------------------------------
// Acceptance 1 — no shipped prompt recommends a sleep poll
// ---------------------------------------------------------------------------

Deno.test("prompts - none recommends sleep as a polling primitive", async () => {
  const offenders: string[] = [];
  for (const path of await promptTemplates()) {
    const hits = findSleepPollRecommendations(await Deno.readTextFile(path));
    for (const hit of hits) {
      offenders.push(`${path.slice(REPO_ROOT.length)} ${hit}`);
    }
  }
  assertEquals(
    offenders,
    [],
    `a prompt offers a sleep poll as the way to wait:\n${offenders.join("\n")}`,
  );
});

// ---------------------------------------------------------------------------
// Acceptance 2 — both templates name a wait command that works in-container
// ---------------------------------------------------------------------------

/** The wait commands both templates must name, and what bounds them. */
const WAIT_CONTRACT: readonly { what: string; pattern: RegExp }[] = [
  { what: "gh pr checks --watch", pattern: /gh\s+pr\s+checks[^\n]*--watch/ },
  {
    what: "gh run watch --exit-status",
    pattern: /gh\s+run\s+watch[^\n]*--exit-status/,
  },
  {
    what: "the foreground `sleep` refusal",
    pattern: /foreground\s+`?sleep`?[^.]*block/i,
  },
  {
    what: "the bound the wait runs under",
    pattern: /bounded\s+by\s+the\s+Bash\s+tool's[^.]*timeout/i,
  },
];

for (const template of ["coding_guidelines", "ci_fix"]) {
  Deno.test(`${template} - names a wait command that works in the container`, async () => {
    const text = await Deno.readTextFile(
      `${PROMPTS_DIR}/${template}/prompt.md`,
    );
    for (const { what, pattern } of WAIT_CONTRACT) {
      assert(
        pattern.test(text),
        `${template}/prompt.md must name ${what} (no match for ${pattern})`,
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Acceptance 3 — the agent-side gh guard passes `--watch` through
// ---------------------------------------------------------------------------

Deno.test("gh guard - allows the watch commands the prompts now recommend", async () => {
  const context = {
    active: true,
    allowedRepos: ["stSoftwareAU/VibeCoder"],
    claimedIssue: {
      repo: "stSoftwareAU/VibeCoder",
      issueNumber: 1954,
      allowedVerbs: [],
    },
  };
  for (
    const argv of [
      ["pr", "checks", "12", "--watch", "--fail-fast"],
      ["run", "watch", "4242", "--exit-status"],
      ["pr", "checks", "12", "--watch", "--repo", "stSoftwareAU/VibeCoder"],
    ]
  ) {
    const decision = await evaluateGhCommand(argv, context);
    assertEquals(
      decision.allowed,
      true,
      `gh ${argv.join(" ")} must be allowed as a read, got ${decision.reason}`,
    );
  }
});
