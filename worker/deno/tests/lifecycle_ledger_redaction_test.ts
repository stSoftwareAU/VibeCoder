/**
 * The lifecycle ledger's allowlist, composed with the real secret redactor
 * (Issue #3718, part of #3644).
 *
 * Modelled on `fleet_telemetry_redaction_test.ts`: each assertion runs the
 * real `serialiseLifecycleEvent` and `appendLifecycleEvent` and the real
 * `redactSecrets`, rather than checking either in isolation. A refusal is
 * always paired with a positive control that serialises, so each refusal is
 * shown to come from the allowlist and not from a broken base event.
 *
 * Australian English spelling used throughout.
 */

import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  appendLifecycleEvent,
  type AssignmentEvent,
  buildLifecycleEvent,
  type LifecycleEvent,
  type LifecycleEventInput,
  LifecycleEventSchemaError,
  serialiseLifecycleEvent,
} from "../lib/lifecycle_ledger.ts";
import { redactSecrets } from "../lib/secret_redaction.ts";

/** A valid assignment event, the base for every probe below. */
function validAssignment(): AssignmentEvent {
  const input: LifecycleEventInput = {
    kind: "assignment",
    assignmentId: "3f2c9a1e-4b5d-4c6e-8f70-1a2b3c4d5e6f",
    runId: "vibe-lkz3p9x-1a2b3c",
    host: "worker-1",
    repo: "stSoftwareAU/VibeCoder",
    issueNumber: 3718,
    recordedAt: "2026-10-14T10:00:00Z",
    assignedAt: "2026-10-14T09:59:00Z",
    cohort: "exp-a",
    reused: false,
    treatment: {
      roles: [{ role: "manager", provider: "claude", model: "opus" }],
      workerVersion: "v1.2.3",
    },
  };
  return buildLifecycleEvent(input) as AssignmentEvent;
}

/** Add one key to a copy of `event`, bypassing the type checker on purpose. */
function withKey(
  event: LifecycleEvent,
  key: string,
  value: unknown,
): LifecycleEvent {
  return { ...event, [key]: value } as unknown as LifecycleEvent;
}

/** Whether a file exists at `path`. */
async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Run `body` against a fresh temporary directory, removed afterwards. */
async function withTempDir(
  body: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "lifecycle_redaction_test_" });
  try {
    await body(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("lifecycle redaction - the positive control serialises", () => {
  const line = serialiseLifecycleEvent(validAssignment());
  assertEquals(JSON.parse(line).kind, "assignment");
});

Deno.test("lifecycle redaction - an extra top-level key is refused, naming the key", async () => {
  for (
    const key of [
      "prompt",
      "issueBody",
      "email",
      "token",
      "credentials",
      "user",
    ]
  ) {
    const probe = withKey(validAssignment(), key, "probe-value");
    const error = assertThrows(
      () => serialiseLifecycleEvent(probe),
      LifecycleEventSchemaError,
    );
    assertEquals(error.field, key);

    await withTempDir(async (dir) => {
      const path = `${dir}/ledger.jsonl`;
      await assertRejects(
        () => appendLifecycleEvent(path, probe),
        LifecycleEventSchemaError,
      );
      // Nothing is written: the refusal happens before the append.
      assertEquals(await exists(path), false);
    });
  }
});

Deno.test("lifecycle redaction - an extra key on treatment is refused", () => {
  const event = validAssignment();
  const probe = {
    ...event,
    treatment: { ...event.treatment, prompt: "do the thing" },
  } as unknown as LifecycleEvent;
  const error = assertThrows(
    () => serialiseLifecycleEvent(probe),
    LifecycleEventSchemaError,
  );
  assertEquals(error.field.endsWith("prompt"), true);
});

Deno.test("lifecycle redaction - an extra key on a role item is refused", () => {
  const event = validAssignment();
  const role = { role: "manager", provider: "claude", email: "a@example.com" };
  const probe = {
    ...event,
    treatment: { ...event.treatment, roles: [role] },
  } as unknown as LifecycleEvent;
  const error = assertThrows(
    () => serialiseLifecycleEvent(probe),
    LifecycleEventSchemaError,
  );
  assertEquals(error.field.endsWith("email"), true);
});

Deno.test("lifecycle redaction - an e-mail address as cohort is refused", () => {
  const error = assertThrows(
    () =>
      serialiseLifecycleEvent(
        withKey(validAssignment(), "cohort", "alice@example.com"),
      ),
    LifecycleEventSchemaError,
  );
  assertEquals(error.field, "cohort");
});

Deno.test("lifecycle redaction - an e-mail address as subscriptionAllocation is refused", () => {
  const event = validAssignment();
  const probe = {
    ...event,
    treatment: {
      ...event.treatment,
      subscriptionAllocation: "acct-1234@example.com",
    },
  } as unknown as LifecycleEvent;
  const error = assertThrows(
    () => serialiseLifecycleEvent(probe),
    LifecycleEventSchemaError,
  );
  assertEquals(error.field.endsWith("subscriptionAllocation"), true);
});

Deno.test("lifecycle redaction - prose as host is refused", () => {
  const error = assertThrows(
    () =>
      serialiseLifecycleEvent(
        withKey(validAssignment(), "host", "worker one runs the issue"),
      ),
    LifecycleEventSchemaError,
  );
  assertEquals(error.field, "host");
});

Deno.test("lifecycle redaction - a prompt sentence as model is refused", () => {
  const event = validAssignment();
  const probe = {
    ...event,
    treatment: {
      ...event.treatment,
      roles: [{
        role: "manager",
        provider: "claude",
        model: "Please fix the failing tests now",
      }],
    },
  } as unknown as LifecycleEvent;
  assertThrows(
    () => serialiseLifecycleEvent(probe),
    LifecycleEventSchemaError,
  );
});

Deno.test("lifecycle redaction - a long hostile run is refused without backtracking", () => {
  // A long run followed by a character the token alphabet forbids.
  const hostileHost = "a".repeat(50_000) + "@";
  const hostileError = assertThrows(
    () =>
      serialiseLifecycleEvent(withKey(validAssignment(), "host", hostileHost)),
    LifecycleEventSchemaError,
  );
  assertEquals(hostileError.field, "host");

  // A long run of a character the label alphabet forbids in first position.
  const hostileLabel = "-".repeat(50_000);
  const labelError = assertThrows(
    () =>
      serialiseLifecycleEvent(
        withKey(validAssignment(), "cohort", hostileLabel),
      ),
    LifecycleEventSchemaError,
  );
  assertEquals(labelError.field, "cohort");
});

Deno.test("lifecycle redaction - a valid serialised line passes the redactor unchanged", () => {
  const line = serialiseLifecycleEvent(validAssignment());
  assertEquals(redactSecrets(line), line, line);
});
