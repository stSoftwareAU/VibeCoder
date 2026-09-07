/**
 * Tests for `container_stamp.ts` — the one rule for reading the container
 * image stamp (Issue #1262).
 *
 * SEC-1217-11: every reader spelled the test as `!== undefined`, so
 * `VIBE_IMAGE_AGENT_PROVIDERS=` — the empty string — flipped container-only
 * behaviour on for a host run. The rule is value, not presence.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  CONTAINER_IMAGE_STAMP_ENV,
  runningInContainerImage,
} from "../lib/container_stamp.ts";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";

Deno.test("runningInContainerImage - a stamped provider set is a container run", () => {
  assertEquals(
    runningInContainerImage(
      envFrom({ [CONTAINER_IMAGE_STAMP_ENV]: "claude,codex" }),
    ),
    true,
  );
});

Deno.test("runningInContainerImage - an absent stamp is a host run", () => {
  assertEquals(runningInContainerImage(emptyEnv), false);
});

Deno.test("runningInContainerImage - a blank stamp is a host run, not a mode switch", () => {
  // The empty string is what the setup suites export to simulate a host run,
  // and what an operator or entrypoint leaves behind when the build stamped
  // nothing. Presence must not stand in for a provider set.
  assertEquals(
    runningInContainerImage(envFrom({ [CONTAINER_IMAGE_STAMP_ENV]: "" })),
    false,
  );
  assertEquals(
    runningInContainerImage(envFrom({ [CONTAINER_IMAGE_STAMP_ENV]: " \t " })),
    false,
  );
});

Deno.test("runningInContainerImage - surrounding whitespace does not hide a real stamp", () => {
  assertEquals(
    runningInContainerImage(
      envFrom({ [CONTAINER_IMAGE_STAMP_ENV]: " claude " }),
    ),
    true,
  );
});
