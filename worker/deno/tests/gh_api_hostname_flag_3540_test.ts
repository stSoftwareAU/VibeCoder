/**
 * Issue #3540: `gh api --hostname <host>` must not have its host value read
 * as the endpoint.
 *
 * `--hostname` was missing from the classifier's value-flag set, so
 * `github.com` was taken as the endpoint, `MutationInfo.target` was wrong and
 * the reserved-label-definition denylist was skipped (even with an inactive
 * guard context).
 */
import { assert, assertEquals } from "@std/assert";
import { classifyGhMutation } from "../lib/audit_mutation_classifier.ts";
import { evaluateGhCommand } from "../lib/gh_guard_decision.ts";

const INACTIVE = { active: false, allowedRepos: [] as string[] };

Deno.test("#3540: --hostname <host> value is not the endpoint", () => {
  const info = classifyGhMutation([
    "api",
    "--hostname",
    "github.com",
    "-X",
    "DELETE",
    "repos/o/r/labels/top-priority",
  ]);
  assert(info);
  assertEquals(info.target, "repos/o/r/labels/top-priority");
  assertEquals(info.repo, "o/r");
  assertEquals(info.verb, "api-delete");
});

Deno.test("#3540: pin: inline --hostname=<host> already classified correctly", () => {
  const info = classifyGhMutation([
    "api",
    "--hostname=github.com",
    "-X",
    "DELETE",
    "repos/o/r/labels/top-priority",
  ]);
  assert(info);
  assertEquals(info.target, "repos/o/r/labels/top-priority");
  assertEquals(info.repo, "o/r");
});

Deno.test("#3540: reserved label DELETE with --hostname is refused (inactive ctx)", () => {
  const d = evaluateGhCommand([
    "api",
    "--hostname",
    "github.com",
    "-X",
    "DELETE",
    "repos/o/r/labels/top-priority",
  ], INACTIVE);
  assertEquals(d.allowed, false);
  assertEquals(d.marker, "WORKER_LABEL_REFUSED");
  assert(d.reason?.includes("reserved_workflow_label_definition"));
  assert(d.reason?.includes("top-priority"));
});

Deno.test("#3540: rename to reserved label with --hostname is refused (inactive ctx)", () => {
  const d = evaluateGhCommand([
    "api",
    "--hostname",
    "github.com",
    "-X",
    "PATCH",
    "repos/o/r/labels/my-label",
    "-f",
    "new_name=top-priority",
  ], INACTIVE);
  assertEquals(d.allowed, false);
  assertEquals(d.marker, "WORKER_LABEL_REFUSED");
  assert(d.reason?.includes("reserved_workflow_label_definition"));
});

Deno.test("#3540: control: same argv with a non-reserved label is allowed", () => {
  const d = evaluateGhCommand([
    "api",
    "--hostname",
    "github.com",
    "-X",
    "DELETE",
    "repos/o/r/labels/my-label",
  ], INACTIVE);
  assertEquals(d.allowed, true);
});
