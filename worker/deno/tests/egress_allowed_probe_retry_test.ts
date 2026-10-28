/**
 * Real CONNECT retry scenarios run with loopback-only network permission in a
 * child process. The canonical unit runner deliberately grants no network
 * access; keep its permission boundary and all scenario assertions intact.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";

const scenarios = new URL(
  "./support/egress_allowed_probe_retry_scenarios.ts",
  import.meta.url,
);

for (
  const name of [
    "an allowlisted CONNECT that times out once and then connects is enforced, not failed",
    "an allowlisted CONNECT the proxy never answers still fails after every attempt",
  ]
) {
  Deno.test(name, async () => {
    const result = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "--frozen",
        "--lock=deno.lock",
        "--allow-net=127.0.0.1",
        "--filter",
        name,
        scenarios.pathname,
      ],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(10_000),
    }).output();
    const decoder = new TextDecoder();
    assertStringIncludes(decoder.decode(result.stdout), "1 passed");
    assertEquals(
      result.code,
      0,
      decoder.decode(result.stdout) + decoder.decode(result.stderr),
    );
  });
}
