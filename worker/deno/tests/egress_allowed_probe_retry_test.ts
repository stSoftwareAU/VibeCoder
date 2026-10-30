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
    "an allowlisted CONNECT waits for a late listener and spends no attempts (Issue #4493)",
    "an allowlisted CONNECT with no listener ever is failed and spends no attempts (Issue #4493)",
    "an allowlisted CONNECT answered 502 every time fails and counts what it saw (Issue #4493)",
    "an allowlisted CONNECT refused three times says so (Issue #4493)",
    "runEgressProbes with a live proxy fills the four-probe enforced set (Issue #4493)",
    "runEgressProbes with a proxy that never listens fails the allowed probe without attempts (Issue #4493)",
    "runEgressProbes with a proxy that starts listening late still passes (Issue #4493)",
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
