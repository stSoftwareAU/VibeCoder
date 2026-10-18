/** Fixed, network-free initialiser: selected session data arrives only on stdin. */
import {
  MAX_BROKER_SESSION_BYTES,
  parseBrokerSessionConfig,
} from "./broker_session_config.ts";

/** Validate fully before writing a new 0600 file; never overwrite old state. */
export async function provisionBrokerSession(
  input: ReadableStream<Uint8Array>,
  directory: string,
): Promise<void> {
  const reader = input.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > MAX_BROKER_SESSION_BYTES) {
        await reader.cancel();
        throw new Error("Broker session input exceeds its bound");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const config = parseBrokerSessionConfig(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  await Deno.writeTextFile(
    `${directory}/session.json`,
    JSON.stringify(config),
    {
      createNew: true,
      mode: 0o600,
    },
  );
}
