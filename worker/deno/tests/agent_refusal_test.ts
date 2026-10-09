import { assert, assertEquals } from "@std/assert";
import { extractAgentRefusals, isHaikuModel } from "../lib/agent_refusal.ts";
import { buildRunStats } from "../lib/run_stats.ts";

const init = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "s1",
});
const result = JSON.stringify({
  type: "result",
  subtype: "success",
  num_turns: 2,
  duration_ms: 10,
});

function assistant(category: unknown, model = "claude-haiku-5-5"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      model,
      stop_reason: "refusal",
      stop_details: { type: "refusal", category, explanation: "declined" },
      content: [],
    },
  });
}

function system(
  subtype: string,
  category: unknown = "frontier_llm",
  model: unknown = "claude-haiku-5-5",
): string {
  return JSON.stringify({
    type: "system",
    subtype,
    original_model: model,
    request_id: null,
    api_refusal_category: category,
    content: "refused",
    uuid: "u1",
    session_id: "s1",
  });
}

const join = (...l: string[]) => l.join("\n") + "\n";

Deno.test("no refusal yields an empty list", () => {
  const ok = JSON.stringify({
    type: "assistant",
    message: { model: "claude-haiku-5-5", stop_reason: "end_turn" },
  });
  assertEquals(extractAgentRefusals(join(init, ok, result)), []);
});

Deno.test("system no_fallback event yields one entry with its category", () => {
  assertEquals(
    extractAgentRefusals(
      join(init, system("model_refusal_no_fallback"), result),
    ),
    [{ model: "claude-haiku-5-5", category: "frontier_llm" }],
  );
});

Deno.test("system event plus matching assistant frame is counted once", () => {
  const out = extractAgentRefusals(
    join(
      init,
      system("model_refusal_no_fallback", "cyber"),
      assistant("cyber"),
      result,
    ),
  );
  assertEquals(out, [{ model: "claude-haiku-5-5", category: "cyber" }]);
});

Deno.test("model_refusal_fallback plus assistant frame is recovered", () => {
  assertEquals(
    extractAgentRefusals(
      join(init, assistant("cyber"), system("model_refusal_fallback"), result),
    ),
    [],
  );
});

Deno.test("older CLI assistant frame alone yields one entry", () => {
  assertEquals(extractAgentRefusals(join(init, assistant("cyber"), result)), [
    { model: "claude-haiku-5-5", category: "cyber" },
  ]);
});

Deno.test("null category becomes unspecified", () => {
  assertEquals(
    extractAgentRefusals(join(assistant(null)))[0]!.category,
    "unspecified",
  );
  assertEquals(
    extractAgentRefusals(join(system("model_refusal_no_fallback", null)))[0]!
      .category,
    "unspecified",
  );
});

Deno.test("hostile category and model strings are cleaned", () => {
  const out = extractAgentRefusals(
    join(assistant("Cy`ber**\n[x](http://e)", "claude`\n**haiku**|5")),
  );
  assertEquals(out[0]!.category, "cyberxhttpe");
  assertEquals(out[0]!.model, "claudehaiku5");
});

Deno.test("missing model becomes unknown", () => {
  assertEquals(
    extractAgentRefusals(
      join(system("model_refusal_no_fallback", "cyber", null)),
    )[0]!.model,
    "unknown",
  );
});

Deno.test("malformed JSON line is skipped", () => {
  const out = extractAgentRefusals(
    join("{not json refusal", assistant("cyber")),
  );
  assertEquals(out.length, 1);
});

Deno.test("a 10k-character category is capped at 64", () => {
  const out = extractAgentRefusals(join(assistant("a".repeat(10_000))));
  assertEquals(out[0]!.category.length, 64);
});

Deno.test("isHaikuModel recognises Haiku-tier ids only", () => {
  assert(isHaikuModel("claude-haiku-5-5"));
  assert(isHaikuModel("claude-haiku-4-5-20251001"));
  assert(isHaikuModel("haiku"));
  assert(!isHaikuModel("claude-sonnet-5-5"));
  assert(!isHaikuModel("unknown"));
});

Deno.test("buildRunStats carries refusals only when present", () => {
  const ctx = { requestedModel: "opus", wallClockMs: 1 };
  const withRefusal = buildRunStats(
    join(init, assistant("cyber"), result),
    ctx,
  );
  assertEquals(withRefusal.refusals, [
    { model: "claude-haiku-5-5", category: "cyber" },
  ]);
  const without = buildRunStats(join(init, result), ctx);
  assertEquals("refusals" in without, false);
});
