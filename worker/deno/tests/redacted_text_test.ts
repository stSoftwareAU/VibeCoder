/**
 * Tests for redact-before-truncate (Issue #1217).
 *
 * The regression these cover: the worker sliced the agent's stdout to a 500
 * character tail and relied on the redaction that `label_failure.ts` runs later,
 * when it builds the public issue comment. A credential straddling that cut lost
 * its leading anchor (`ghp_`, `sk-ant-`, the `AKIA…` id), so the later pass
 * matched nothing and the fragment was published.
 *
 * Every assertion here is "the known-shaped fake token is ABSENT from the
 * emitted output" — the fail direction is a leak, so a broken ordering fails
 * these tests rather than passing them quietly.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  joinRedacted,
  redactedHead,
  redactedTail,
} from "../lib/redacted_text.ts";
import {
  REDACTION_PLACEHOLDER,
  redactSecrets,
} from "../lib/secret_redaction.ts";
import { formatDetailedFailureMessage } from "../lib/failure_message.ts";
import {
  formatProcessTable,
  parseProcessTable,
} from "../lib/kill_diagnostics.ts";

/**
 * A fake GitHub token of the published shape: `ghp_` + 38 base62 characters.
 *
 * Assembled at runtime rather than written as one literal so the repository's
 * secret-history scan has no contiguous credential-shaped string to flag.
 */
const FAKE_TOKEN = ["ghp", "_", "0123456789abcdefghijklmnopqrstuvwxyzAB"]
  .join("");

/**
 * Build agent stdout whose 500-character tail cuts `FAKE_TOKEN` in half, and
 * return the fragment that survives that cut. That fragment is the leak: it
 * matches no signature rule, so redacting *after* the slice cannot mask it.
 */
function outputWithTokenStraddlingTheCut(
  budget: number,
): { output: string; leakedFragment: string } {
  const keptTokenChars = 20;
  const trailing = "x".repeat(budget - keptTokenChars);
  const output = `${"y".repeat(2000)}${FAKE_TOKEN}${trailing}`;
  return { output, leakedFragment: FAKE_TOKEN.slice(-keptTokenChars) };
}

Deno.test("redactedTail - masks a token straddling the truncation boundary", () => {
  const { output, leakedFragment } = outputWithTokenStraddlingTheCut(500);

  // The unfixed ordering: slice first, redact at the sink. The fragment
  // survives, which is the defect.
  assertStringIncludes(redactSecrets(output.slice(-500)), leakedFragment);

  // The fixed ordering: redact the whole text, then trim.
  const safe = redactedTail(output, 500);
  assert(
    !safe.includes(leakedFragment),
    "the token fragment must not survive the cut",
  );
  assert(!safe.includes(FAKE_TOKEN), "the whole token must not survive either");
});

Deno.test("redactedTail - keeps the tail within its budget and leaves prose intact", () => {
  const text = `${
    "a".repeat(100)
  }the agent finished tidying the colour palette`;
  const tail = redactedTail(text, 45);
  assertEquals(tail.length, 45);
  assertEquals(tail, "the agent finished tidying the colour palette");
});

Deno.test("redactedTail - a zero or negative budget keeps nothing", () => {
  assertEquals(redactedTail(`prefix ${FAKE_TOKEN}`, 0), "");
  assertEquals(redactedTail(`prefix ${FAKE_TOKEN}`, -10), "");
});

Deno.test("redactedTail - empty input returns empty", () => {
  assertEquals(redactedTail("", 500), "");
});

Deno.test("redactedHead - masks a token straddling the head boundary", () => {
  // A `ps` row carrying a token; the head cut lands inside it.
  const text = `pid=1 node --serve ${FAKE_TOKEN} ${"z".repeat(200)}`;
  const cut = text.indexOf(FAKE_TOKEN) + 20;

  assertStringIncludes(
    redactSecrets(text.slice(0, cut)),
    FAKE_TOKEN.slice(0, 20),
  );

  const safe = redactedHead(text, cut);
  assert(
    !safe.includes(FAKE_TOKEN.slice(0, 20)),
    "the leading token fragment must not survive the cut",
  );
  assertStringIncludes(safe, REDACTION_PLACEHOLDER);
});

Deno.test("redactedHead - a zero or negative budget keeps nothing", () => {
  assertEquals(redactedHead(`${FAKE_TOKEN} trailing`, 0), "");
  assertEquals(redactedHead(`${FAKE_TOKEN} trailing`, -10), "");
});

Deno.test("redactedHead - empty input returns empty", () => {
  assertEquals(redactedHead("", 500), "");
});

Deno.test("joinRedacted - joins parts and drops the empty ones", () => {
  const joined = joinRedacted(
    [
      redactedTail("stdout tail", 100),
      redactedTail("", 100),
      redactedTail("stderr tail", 100),
    ],
    "\n--- stderr ---\n",
  );
  assertEquals(joined, "stdout tail\n--- stderr ---\nstderr tail");
});

// ============================================================================
// The published sink: the failure comment `label_failure.ts` posts
// ============================================================================

Deno.test("failure message - a token straddling the snippet cut never reaches the published comment", () => {
  const { output, leakedFragment } = outputWithTokenStraddlingTheCut(500);

  // `label_failure.ts` builds the public comment as
  // `redactSecrets(failureMessage)`; reproduce that final pass here.
  const published = redactSecrets(
    formatDetailedFailureMessage("Claude was killed (exit 137, SIGKILL)", {
      outputSize: output.length,
      lastOutputSnippet: redactedTail(output, 500),
    }),
  );

  assert(
    !published.includes(leakedFragment),
    "the token fragment must not reach the published issue comment",
  );
  assertStringIncludes(published, "Last output from Claude");
});

Deno.test("failure message - kill diagnostics are redacted before the 2000-character cap", () => {
  // The `ps` table shows every process's argv, so a token passed on a command
  // line lands here. The cap must not cut it into an unmatchable fragment.
  const rowPrefix = "pid=42 ppid=1 rss=10 MiB up=01:00 node --serve ";
  // Place the token so the 2000-character cap falls ten characters into it.
  const padding = "p".repeat(1990 - rowPrefix.length);
  const diagnostics = `${padding}${rowPrefix}${FAKE_TOKEN} --port 8080`;

  const published = redactSecrets(
    formatDetailedFailureMessage("Claude was killed (exit 137, SIGKILL)", {
      killDiagnostics: diagnostics,
    }),
  );

  assert(
    !published.includes(FAKE_TOKEN.slice(0, 10)),
    "no fragment of the token may survive the diagnostics cap",
  );
  assertStringIncludes(published, "Processes at the kill");
});

// ============================================================================
// The `ps` table: an argv secret cut by the per-row command budget
// ============================================================================

Deno.test("kill diagnostics - a token in a ps argv is masked before the per-row cut", () => {
  // `issue_worker.sh` passes an API key as a CLI flag value, which is why the
  // redactor carries a `secret-cli-flag` rule at all — so this is the shape
  // that really appears in `ps` output on this host. The filler places the
  // token so `formatProcessTable`'s 90-character command budget cuts it in
  // half: the surviving head matches no rule, which is the leak.
  const flag = "--imgbb-api-key ";
  const filler = "z".repeat(75 - "node ".length - flag.length);
  const command = `node ${filler}${flag}${FAKE_TOKEN}`;
  const psOutput = [
    "  PID  PPID   RSS ELAPSED COMMAND",
    `  101     1  4096   01:00 ${command}`,
  ].join("\n");

  const rows = parseProcessTable(psOutput);
  const table = formatProcessTable(rows, {
    agentPid: 101,
    knownDescendants: [],
  });

  assert(
    !table.includes(FAKE_TOKEN.slice(0, 14)),
    "no fragment of the token may survive the 90-character command budget",
  );
  assertStringIncludes(table, "pid=101");
});

Deno.test("joinRedacted - no parts, or only empty parts, yields empty", () => {
  assertEquals(joinRedacted([], "\n"), "");
  assertEquals(
    joinRedacted([redactedTail("", 10), redactedTail("", 10)], "\n"),
    "",
  );
});

Deno.test("joinRedacted - a single part is returned without a separator", () => {
  assertEquals(
    joinRedacted([redactedTail("only", 10)], "\n--- x ---\n"),
    "only",
  );
});

Deno.test("joinRedacted - the separator is redacted, not trusted", () => {
  // The separator is an unbranded string, so it would otherwise be a hole
  // straight through the brand: arbitrary text in, RedactedText out.
  const joined = joinRedacted(
    [redactedTail("head", 10), redactedTail("tail", 10)],
    `\n${FAKE_TOKEN}\n`,
  );
  assert(
    !joined.includes(FAKE_TOKEN),
    "a secret in the separator must not survive the join",
  );
  assertStringIncludes(joined, REDACTION_PLACEHOLDER);
});
