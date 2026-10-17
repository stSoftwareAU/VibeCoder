/**
 * Growth bound for the raw-pass check in `redactTranscriptLine` (Issue #3826).
 * Registered in `WALL_CLOCK_TEST_FILES` so it runs in the serial pass;
 * measured by shape, never against a wall-clock constant.
 *
 * Australian English used throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { redactTranscriptLine } from "../lib/agent_transcript.ts";
import { REDACTION_PLACEHOLDER } from "../lib/secret_redaction.ts";
import { assertLinearGrowth } from "./support/growth.ts";

Deno.test("agent_transcript - redacting a many-string line with a masked value stays linear (Issue #3826)", () => {
  const out = assertLinearGrowth(
    "redactTranscriptLine over many short strings",
    (chars) => {
      const count = Math.ceil(chars / 8);
      const names = Array.from({ length: count }, (_, i) => `f${i}`);
      return JSON.stringify({ text: "export TOKEN=aaaabbbbcccc", names });
    },
    (line) => redactTranscriptLine(line),
    { baseChars: 100_000 },
  );
  const event = JSON.parse(out) as { text: string; names: string[] };
  assertEquals(event.text, `export TOKEN=${REDACTION_PLACEHOLDER}`);
  assertEquals(event.names[1], "f1");
});

Deno.test("agent_transcript - many escaped assignments on one line stay linear (Issue #3826)", () => {
  const out = assertLinearGrowth(
    "redactTranscriptLine over many escaped assignments",
    (chars) => {
      const count = Math.ceil(chars / 40);
      const items = Array.from(
        { length: count },
        (_, i) => `accessToken: "v${i}xxxxxxxx"`,
      );
      return JSON.stringify({ items });
    },
    (line) => redactTranscriptLine(line),
    { baseChars: 100_000 },
  );
  const event = JSON.parse(out) as { items: string[] };
  assertEquals(event.items[0], `accessToken: "${REDACTION_PLACEHOLDER}"`);
  assertEquals(event.items.at(-1), `accessToken: "${REDACTION_PLACEHOLDER}"`);
});
