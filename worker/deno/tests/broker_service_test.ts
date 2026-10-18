import { assertEquals, assertThrows } from "@std/assert";
import { parseBrokerSessionConfig } from "../lib/broker_session_config.ts";

Deno.test("broker service accepts only a host-owned immutable credential session", () => {
  const value = {
    credentials: { claude: "synthetic-secret" },
    repositories: ["fixture/allowed"],
    lifetimeMs: 5000,
    claudeAuthentication: "bearer" as const,
  };
  assertEquals(parseBrokerSessionConfig(JSON.stringify(value)), value);
  assertThrows(
    () => parseBrokerSessionConfig("not-json"),
    Error,
    "Invalid private broker session configuration",
  );
  for (
    const invalid of [
      null,
      [],
      "wrong",
      { ...value, credentials: null },
      { ...value, credentials: [] },
      { ...value, credentials: { claude: 7 } },
      { ...value, credentials: { claude: "x".repeat(65_536) } },
      { ...value, credentials: { claude: "line\nbreak" } },
      { ...value, repositories: "fixture/allowed" },
      { ...value, repositories: [7] },
      { ...value, repositories: ["fixture/with/query"] },
      { ...value, lifetimeMs: "5000" },
      { ...value, lifetimeMs: 1.5 },
      { ...value, lifetimeMs: 86_400_001 },
      { ...value, fetch: "worker-code" },
      { ...value, credentials: { unknown: "secret" } },
      { ...value, repositories: ["../other"] },
      { ...value, lifetimeMs: 0 },
      { ...value, claudeAuthentication: "fallback" },
    ]
  ) {
    assertThrows(
      () => parseBrokerSessionConfig(JSON.stringify(invalid)),
      Error,
      "Invalid private broker session configuration",
    );
  }
});
