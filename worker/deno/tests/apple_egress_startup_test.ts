import { assert, assertEquals } from "@std/assert";
import { checkEgressPolicy } from "../lib/egress_selfcheck.ts";

Deno.test("Apple startup refuses a broken configured proxy before claims", async () => {
  let ran = false;
  const result = await checkEgressPolicy({
    env: (name) =>
      ({
        VIBE_EGRESS_ENFORCED: "false",
        VIBE_RUNTIME_KIND: "apple-container",
        VIBE_APPLE_EGRESS_MODE: "advisory",
      })[name],
    probe: () => {
      ran = true;
      return Promise.resolve({
        directCloudflare: "connected",
        directGithub: "connected",
        proxyAllowed: "failed",
        proxyDenied: "not_checked",
      });
    },
  });
  assert(
    ran,
    "a configured Apple proxy must be measured, even with egressEnforced=false",
  );
  assertEquals(result.exitCode, 90);
});
