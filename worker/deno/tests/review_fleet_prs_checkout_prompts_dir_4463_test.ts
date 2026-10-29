import { assertEquals } from "@std/assert";
import { checkoutPromptsDir } from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";

Deno.test("checkoutPromptsDir decodes a percent-encoded checkout path", () => {
  const url =
    "file:///Users/a%20b/M%C3%BCller/VibeCoder/.claude/skills/review-fleet-prs/scripts/gate.ts";
  assertEquals(
    checkoutPromptsDir(url),
    "/Users/a b/Müller/VibeCoder/prompts",
  );
});
