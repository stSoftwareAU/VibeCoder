/**
 * Drift guard for the import-free template-name list (Issue #4011).
 *
 * `lib/idle_task_template_names.ts` exists so config load can validate an
 * operator's `idle_task_cadence.templates` keys without importing the `gh`
 * stack. It is only safe as a copy while it stays identical to the set
 * `idle_task_backfill.ts` derives from the canonical wrapper-title map — this
 * test is what keeps that true.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { IDLE_TASK_TEMPLATE_NAMES } from "../lib/idle_task_template_names.ts";
import { IDLE_TASK_WRAPPER_TEMPLATE_NAMES } from "../lib/idle_task_backfill.ts";

Deno.test("idle_task_template_names - matches the canonical wrapper template names", () => {
  assertEquals(
    [...IDLE_TASK_TEMPLATE_NAMES].sort(),
    [...IDLE_TASK_WRAPPER_TEMPLATE_NAMES].sort(),
  );
});
