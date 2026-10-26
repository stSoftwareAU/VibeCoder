/**
 * Proxy variables stay visible to the agent and to untrusted commands
 * (Issue #4047). The launch plan sets them; these builders must not strip them.
 */

import { assertEquals } from "@std/assert";
import { buildClaudeChildEnv } from "../lib/claude_env.ts";
import { buildUntrustedCommandEnv } from "../lib/untrusted_command_env.ts";

const PROXY = {
  HTTPS_PROXY: "http://vibe-coder-1-proxy:3128",
  HTTP_PROXY: "http://vibe-coder-1-proxy:3128",
  https_proxy: "http://vibe-coder-1-proxy:3128",
  http_proxy: "http://vibe-coder-1-proxy:3128",
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  PATH: "/usr/bin",
  HOME: "/home/vibe",
};

Deno.test("buildClaudeChildEnv keeps both proxy spellings", () => {
  const child = buildClaudeChildEnv(PROXY);
  for (const name of Object.keys(PROXY)) {
    assertEquals(child[name], PROXY[name as keyof typeof PROXY]);
  }
});

Deno.test("buildUntrustedCommandEnv keeps both proxy spellings", () => {
  const child = buildUntrustedCommandEnv({ source: PROXY });
  for (
    const name of [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "https_proxy",
      "http_proxy",
      "NO_PROXY",
      "no_proxy",
    ] as const
  ) {
    assertEquals(child[name], PROXY[name]);
  }
});
