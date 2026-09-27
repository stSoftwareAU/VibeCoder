/**
 * Tests for the worker planning hand-off trust exception (Issue #2688).
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals } from "@std/assert";
import {
  type HandoffTimelineEvent,
  isWorkerPlanningHandoff,
} from "../lib/planning_handoff_trust.ts";

const ALLOWED = ["alice", "Vibecoderbot"];
const WORKERS = ["Vibecoderbot", "stsvcbot"];

function ev(
  event: string,
  label: string,
  login: string | null,
): HandoffTimelineEvent {
  return {
    event,
    label: { name: label },
    actor: login === null ? null : { login },
  };
}

Deno.test("isWorkerPlanningHandoff - trusted work-on then worker planning is a hand-off", () => {
  const timeline = [
    ev("labeled", "work-on", "alice"),
    ev("labeled", "planning", "stsvcbot"),
  ];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "planning", ALLOWED, WORKERS),
    true,
  );
});

Deno.test("isWorkerPlanningHandoff - label names and logins compare case-insensitively", () => {
  const timeline = [
    ev("labeled", "Work-On", "ALICE"),
    ev("labeled", "Planning", "StSvcBot"),
  ];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "Planning", ALLOWED, WORKERS),
    true,
  );
});

Deno.test("isWorkerPlanningHandoff - planning added by an outsider is not a hand-off", () => {
  const timeline = [
    ev("labeled", "work-on", "alice"),
    ev("labeled", "planning", "mallory"),
  ];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "planning", ALLOWED, WORKERS),
    false,
  );
});

Deno.test("isWorkerPlanningHandoff - worker planning with no work-on is not a hand-off", () => {
  const timeline = [ev("labeled", "planning", "stsvcbot")];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "planning", ALLOWED, WORKERS),
    false,
  );
});

Deno.test("isWorkerPlanningHandoff - work-on added by a worker login does not anchor", () => {
  // Vibecoderbot is in allowedAuthors (fleet PR-dedup) but is a worker login.
  const timeline = [
    ev("labeled", "work-on", "Vibecoderbot"),
    ev("labeled", "planning", "stsvcbot"),
  ];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "planning", ALLOWED, WORKERS),
    false,
  );
});

Deno.test("isWorkerPlanningHandoff - work-on added by an untrusted user does not anchor", () => {
  const timeline = [
    ev("labeled", "work-on", "mallory"),
    ev("labeled", "planning", "stsvcbot"),
  ];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "planning", ALLOWED, WORKERS),
    false,
  );
});

Deno.test("isWorkerPlanningHandoff - a later untrusted work-on re-add replaces the trusted anchor", () => {
  const timeline = [
    ev("labeled", "work-on", "alice"),
    ev("unlabeled", "work-on", "mallory"),
    ev("labeled", "work-on", "mallory"),
    ev("labeled", "planning", "stsvcbot"),
  ];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "planning", ALLOWED, WORKERS),
    false,
  );
});

Deno.test("isWorkerPlanningHandoff - work-on removed after the add is not a hand-off", () => {
  const timeline = [
    ev("labeled", "work-on", "alice"),
    ev("labeled", "planning", "stsvcbot"),
    ev("unlabeled", "work-on", "alice"),
  ];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "planning", ALLOWED, WORKERS),
    false,
  );
});

Deno.test("isWorkerPlanningHandoff - work-on added after planning is not a hand-off", () => {
  const timeline = [
    ev("labeled", "planning", "stsvcbot"),
    ev("labeled", "work-on", "alice"),
  ];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "planning", ALLOWED, WORKERS),
    false,
  );
});

Deno.test("isWorkerPlanningHandoff - covers planning only, never another operational label", () => {
  const timeline = [
    ev("labeled", "work-on", "alice"),
    ev("labeled", "question", "stsvcbot"),
    ev("labeled", "best-model", "stsvcbot"),
  ];
  for (const label of ["question", "best-model", "quorum", "work-on"]) {
    assertEquals(
      isWorkerPlanningHandoff(timeline, label, ALLOWED, WORKERS),
      false,
      label,
    );
  }
});

Deno.test("isWorkerPlanningHandoff - null actors and an empty timeline are not a hand-off", () => {
  assertEquals(
    isWorkerPlanningHandoff([], "planning", ALLOWED, WORKERS),
    false,
  );
  const timeline = [
    ev("labeled", "work-on", null),
    ev("labeled", "planning", "stsvcbot"),
  ];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "planning", ALLOWED, WORKERS),
    false,
  );
  assertEquals(
    isWorkerPlanningHandoff(
      [ev("labeled", "work-on", "alice"), ev("labeled", "planning", null)],
      "planning",
      ALLOWED,
      WORKERS,
    ),
    false,
  );
});

Deno.test("isWorkerPlanningHandoff - an empty worker list trusts no hand-off", () => {
  const timeline = [
    ev("labeled", "work-on", "alice"),
    ev("labeled", "planning", "stsvcbot"),
  ];
  assertEquals(
    isWorkerPlanningHandoff(timeline, "planning", ALLOWED, []),
    false,
  );
});
