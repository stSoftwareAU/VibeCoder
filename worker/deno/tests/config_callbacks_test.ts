/**
 * `.config.json` → `WorkerConfig.callbacks` wiring (Issue #806, parent #796).
 *
 * Australian English spelling used throughout (behaviour, recognised).
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { loadConfig } from "../lib/config.ts";
import {
  DEFAULT_CALLBACK_TIMEOUT_SECONDS,
} from "../lib/run_callbacks_config.ts";
import { KNOWN_CONFIG_KEYS } from "../lib/config_unknown_keys.ts";
import { detectUnknownConfigKeys } from "../lib/config_unknown_keys.ts";

async function withConfig(
  body: (
    path: string,
    write: (json: unknown) => Promise<void>,
  ) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "vibe-config-callbacks-" });
  const path = `${dir}/.config.json`;
  try {
    await body(
      path,
      (json) => Deno.writeTextFile(path, JSON.stringify(json, null, 2)),
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("config callbacks - a config without the block configures no hooks", async () => {
  await withConfig(async (path, write) => {
    await write({ repos: ["org/repo"] });
    const config = await loadConfig(path);
    assertEquals(config.callbacks.success, undefined);
    assertEquals(config.callbacks.failure, undefined);
    assertEquals(config.callbacks.always, undefined);
    assertEquals(
      config.callbacks.timeoutSeconds,
      DEFAULT_CALLBACK_TIMEOUT_SECONDS,
    );
  });
});

Deno.test("config callbacks - configured hooks reach WorkerConfig", async () => {
  await withConfig(async (path, write) => {
    await write({
      repos: ["org/repo"],
      callbacks: {
        success: "/opt/hooks/success.sh",
        failure: "/opt/hooks/failure.sh",
        always: "/opt/hooks/always.sh",
        timeout_seconds: 15,
      },
    });
    const config = await loadConfig(path);
    assertEquals(config.callbacks.success, "/opt/hooks/success.sh");
    assertEquals(config.callbacks.failure, "/opt/hooks/failure.sh");
    assertEquals(config.callbacks.always, "/opt/hooks/always.sh");
    assertEquals(config.callbacks.timeoutSeconds, 15);
  });
});

Deno.test("config callbacks - a relative hook path fails the config load", async () => {
  await withConfig(async (path, write) => {
    await write({ repos: ["org/repo"], callbacks: { success: "hooks/s.sh" } });
    const error = await assertRejects(() => loadConfig(path), Error);
    assert(error.message.includes("callbacks.success"), error.message);
    assert(error.message.includes("absolute"), error.message);
  });
});

Deno.test("config callbacks - an unknown key inside the block fails the config load", async () => {
  await withConfig(async (path, write) => {
    await write({
      repos: ["org/repo"],
      callbacks: { onSuccess: "/opt/hooks/s.sh" },
    });
    const error = await assertRejects(() => loadConfig(path), Error);
    assert(error.message.includes("onSuccess"), error.message);
  });
});

Deno.test("config callbacks - `callbacks` is a recognised top-level key", () => {
  assertEquals(KNOWN_CONFIG_KEYS.has("callbacks"), true);
  assertEquals(
    detectUnknownConfigKeys({ callbacks: { always: "/opt/hooks/a.sh" } }),
    [],
  );
});
