/** Fail-closed interpretation of the pinned Codex native diagnostic's JSONL. */
import { countSyntheticCredentialMatches } from "./agent_container_evidence.ts";

export const CODEX_NATIVE_FIXTURE_RESULT = "Codex broker fixture complete.";
type ProbeOutput = Pick<
  Deno.CommandOutput,
  "success" | "code" | "stdout" | "stderr"
>;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** A separate broker-side authenticated-request witness is still mandatory. */
export async function assertCodexNativeOutput(
  output: ProbeOutput,
  secretHash: string,
): Promise<void> {
  if (!output.success) {
    throw new Error(`Native Codex fixture failed with exit ${output.code}`);
  }
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (
    await countSyntheticCredentialMatches(stdout + stderr, secretHash) !== 0
  ) {
    throw new Error("Native Codex output contains the upstream credential");
  }
  let events: Record<string, unknown>[];
  try {
    events = stdout.trim().split(/\r?\n/).map((line) =>
      record(JSON.parse(line))
    );
  } catch {
    throw new Error("Native Codex fixture did not emit JSONL");
  }
  if (
    events.some((event) =>
      event.type === "error" || event.type === "turn.failed"
    )
  ) {
    throw new Error("Native Codex fixture emitted a failed turn");
  }
  const messages = events.flatMap((event, index) => {
    const item = record(event.item);
    return event.type === "item.completed" && item.type === "agent_message" &&
        item.text === CODEX_NATIVE_FIXTURE_RESULT
      ? [index]
      : [];
  });
  const completed = events.flatMap((event, index) =>
    event.type === "turn.completed" ? [index] : []
  );
  if (
    messages.length !== 1 || completed.length !== 1 ||
    messages[0]! >= completed[0]!
  ) {
    throw new Error(
      "Native Codex fixture lacked the broker response and completed turn",
    );
  }
}
