/**
 * Tests for `workflowSyncActionReferences` (Issue #4448): the third-party
 * actions of the workflow-sync templates a repository would be filed with,
 * which the repository-settings allow-list must admit.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { pinnedAction } from "../lib/pinned_actions.ts";
import { workflowSyncActionReferences } from "../lib/workflow_sync_actions.ts";

/**
 * A routing `gh` stub: answers each endpoint from `routes` (a value is
 * returned as JSON, a string as a raw body, an Error is thrown); an unknown
 * endpoint is a 404.
 */
function routedGh(routes: Record<string, unknown>) {
  return async (args: string[]): Promise<string> => {
    const value = routes[args[1] ?? ""];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new Error("gh: Not Found (HTTP 404)");
    return typeof value === "string" ? value : JSON.stringify(value);
  };
}

/** The `owner/repo@sha` a template's `pinnedAction()` line resolves to. */
function pinnedReference(name: string): string {
  return pinnedAction(name).split(" # ")[0]!;
}

Deno.test("workflowSyncActionReferences - an empty repository's templates give SHA-pinned, sorted, unique references, GitHub-owned ones kept (Issue #4448)", async () => {
  const gh = routedGh({
    "repos/acme/empty/contents/": [],
    "repos/acme/empty/languages": {},
  });
  const result = await workflowSyncActionReferences("acme/empty", gh);
  assertEquals(result.fault, undefined);
  assertEquals(result.references, [...result.references].sort());
  assertEquals(new Set(result.references).size, result.references.length);
  assert(
    result.references.includes(pinnedReference("gitleaks/gitleaks-action")),
    result.references.join(", "),
  );
  // GitHub-owned actions are kept here; buildAllowedActionPatterns keeps them
  // implicit, so the allow-list never gets a pattern for them.
  assert(result.references.includes(pinnedReference("actions/checkout")));
  for (const ref of result.references) {
    assert(/^[\w.-]+\/[^@\s]+@[0-9a-f]{40}$/.test(ref), ref);
  }
});

Deno.test("workflowSyncActionReferences - a failed language detection is a fault naming the cause, never a throw (Issue #4448)", async () => {
  const gh = async (): Promise<string> => {
    throw new Error("HTTP 503: unavailable");
  };
  const result = await workflowSyncActionReferences("acme/down", gh);
  assertEquals(result.references, []);
  assert(
    result.fault?.includes("language detection failed"),
    result.fault,
  );
  assert(result.fault?.includes("HTTP 503: unavailable"), result.fault);
});

Deno.test("workflowSyncActionReferences - a failed workflow audit is a fault naming the cause, never a throw (Issue #4448)", async () => {
  const gh = routedGh({
    "repos/acme/broken/contents/": [],
    "repos/acme/broken/languages": {},
    "repos/acme/broken/contents/.github/workflows": new Error(
      "HTTP 500: server error",
    ),
  });
  const result = await workflowSyncActionReferences("acme/broken", gh);
  assertEquals(result.references, []);
  assert(result.fault?.includes("workflow audit failed"), result.fault);
  assert(result.fault?.includes("HTTP 500: server error"), result.fault);
});
