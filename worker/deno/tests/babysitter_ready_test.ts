/**
 * Tests for the shared READY rule (Issue #4930): the host refuses to push
 * unless the agent's response reports ready, and the in-container gate
 * withholds the line by the same rule.
 */

import { assertEquals } from "@std/assert";
import {
  BABYSITTER_READY_LINE,
  isBabysitterReady,
} from "../lib/babysitter_ready.ts";

Deno.test("the READY line is the exact token the agent ends its response with (Issue #4930)", () => {
  assertEquals(BABYSITTER_READY_LINE, "BABYSITTER_READY");
});

Deno.test("a response of only the READY line is ready", () => {
  assertEquals(isBabysitterReady("BABYSITTER_READY"), true);
});

Deno.test("a READY line after text is ready", () => {
  assertEquals(isBabysitterReady("Fixed the test.\nBABYSITTER_READY"), true);
});

Deno.test("trailing whitespace and a trailing newline after the READY line are ready", () => {
  assertEquals(isBabysitterReady("Done.\nBABYSITTER_READY\n"), true);
  assertEquals(isBabysitterReady("Done.\nBABYSITTER_READY  \n\n"), true);
  assertEquals(isBabysitterReady("BABYSITTER_READY\n"), true);
});

Deno.test("READY mid-text, not as the last line, is not ready", () => {
  assertEquals(
    isBabysitterReady("BABYSITTER_READY\nbut then I kept going"),
    false,
  );
  assertEquals(
    isBabysitterReady("I was about to write BABYSITTER_READY but did not."),
    false,
  );
});

Deno.test("READY with no preceding newline, glued to other text, is not ready", () => {
  assertEquals(isBabysitterReady("xBABYSITTER_READY"), false);
  assertEquals(isBabysitterReady("Done. BABYSITTER_READY"), false);
});

Deno.test("an empty response is not ready", () => {
  assertEquals(isBabysitterReady(""), false);
  assertEquals(isBabysitterReady("   \n  "), false);
});
