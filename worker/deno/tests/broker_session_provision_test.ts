import { assertEquals, assertRejects } from "@std/assert";
import { provisionBrokerSession } from "../lib/broker_session_provision.ts";
const text = JSON.stringify({
  credentials: { claude: "synthetic-only-secret" },
  repositories: ["fixture/allowed"],
  lifetimeMs: 5000,
});
function stream(value: string) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(value));
      c.close();
    },
  });
}
Deno.test("broker provisioner writes a private validated session once and refuses stale contents", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await provisionBrokerSession(stream(text), dir);
    assertEquals(await Deno.readTextFile(`${dir}/session.json`), text);
    if (Deno.build.os !== "windows") {
      assertEquals(
        (await Deno.stat(`${dir}/session.json`)).mode! & 0o777,
        0o600,
      );
    }
    await assertRejects(() =>
      provisionBrokerSession(stream(text.replace("5000", "6000")), dir)
    );
    assertEquals(await Deno.readTextFile(`${dir}/session.json`), text);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
Deno.test("broker provisioner refuses malformed or oversized input before creating private state", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (
      const input of [
        "invalid",
        text.replace("5000", "0"),
        text.replace("synthetic-only-secret", "x".repeat(65536)),
      ]
    ) {
      await assertRejects(() => provisionBrokerSession(stream(input), dir));
      assertEquals(Array.from(Deno.readDirSync(dir)), []);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("broker provisioner bounds streamed input before buffering or writing it all", async () => {
  const dir = await Deno.makeTempDir();
  let pulls = 0;
  let cancelled = false;
  const input = new ReadableStream<Uint8Array>({
    pull(c) {
      pulls++;
      c.enqueue(new Uint8Array(4096));
      if (pulls === 100) c.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  try {
    await assertRejects(
      () => provisionBrokerSession(input, dir),
      Error,
      "Broker session input exceeds its bound",
    );
    assertEquals(cancelled, true);
    assertEquals(pulls < 20, true);
    assertEquals(Array.from(Deno.readDirSync(dir)), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
