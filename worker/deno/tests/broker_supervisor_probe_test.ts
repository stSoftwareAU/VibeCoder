import { assertEquals, assertThrows } from "@std/assert";
import {
  assertSupervisorWorkerEvidence,
  type SupervisorWorkerEvidence,
} from "./support/broker_supervisor_evidence.ts";
Deno.test("supervisor runtime evidence rejects each missing isolation witness", () => {
  const valid: SupervisorWorkerEvidence = {
    denied: true,
    privateReadable: false,
    privateMounted: false,
    socketWritable: false,
    secretMatches: 0,
    capEff: "0000000000000000",
    noNewPrivileges: "1",
    seccomp: "2",
  };
  assertSupervisorWorkerEvidence(valid);
  for (
    const field of Object.keys(valid) as Array<keyof SupervisorWorkerEvidence>
  ) {
    const changed = {
      ...valid,
      [field]: typeof valid[field] === "boolean"
        ? !valid[field]
        : typeof valid[field] === "number"
        ? 1
        : "bad",
    };
    assertThrows(() => assertSupervisorWorkerEvidence(changed));
    const missing = JSON.parse(
      JSON.stringify({ ...valid, [field]: undefined }),
    );
    assertThrows(() => assertSupervisorWorkerEvidence(missing));
    if (typeof valid[field] === "boolean") {
      for (const replacement of [0, 1, "false", "true", null]) {
        const malformed = JSON.parse(
          JSON.stringify({ ...valid, [field]: replacement }),
        );
        assertThrows(() => assertSupervisorWorkerEvidence(malformed));
      }
    }
  }
});

Deno.test("supervisor environment fingerprint detects credentials embedded in JSON and long values", async () => {
  const { countSyntheticCredentialMatches } = await import(
    "./support/agent_container_evidence.ts"
  );
  const secret = `synthetic-${crypto.randomUUID()}`;
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    ),
  ).map((b) => b.toString(16).padStart(2, "0")).join("");
  const environment = {
    JSON_CONFIG: JSON.stringify({ credential: secret }),
    LONG_VALUE: `prefix${"x".repeat(1000)}${secret}suffix`,
  };
  assertEquals(
    await countSyntheticCredentialMatches(JSON.stringify(environment), hash),
    2,
  );
});
