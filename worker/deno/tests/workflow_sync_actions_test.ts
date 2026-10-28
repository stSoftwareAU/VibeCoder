/**
 * Tests for `workflowSyncActionReferences` (Issue #4448): the third-party
 * actions of the workflow-sync templates a repository would be filed with,
 * which the repository-settings allow-list must admit.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { pinnedAction } from "../lib/pinned_actions.ts";
import type { WorkflowSpec } from "../lib/workflow_definitions.ts";
import {
  ghRunner,
  templateActionReferences,
  workflowSyncActionReferences,
} from "../lib/workflow_sync_actions.ts";

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

Deno.test("workflowSyncActionReferences - an exact fault names the cause once, without an error-class prefix (Issue #4448)", async () => {
  const gh = async (): Promise<string> => {
    throw new Error("HTTP 503: unavailable");
  };
  const result = await workflowSyncActionReferences("acme/down", gh);
  assertEquals(result, {
    references: [],
    fault:
      "language detection failed: Failed to fetch repository contents: HTTP 503: unavailable",
  });
});

Deno.test("workflowSyncActionReferences - a response the detector cannot walk is a could-not-read fault, never a throw (Issue #4448)", async () => {
  const gh = routedGh({
    "repos/acme/odd/contents/": "null",
    "repos/acme/odd/languages": {},
  });
  const result = await workflowSyncActionReferences("acme/odd", gh);
  assertEquals(result.references, []);
  assert(
    result.fault?.startsWith("could not read the templates: "),
    result.fault,
  );
  // The Error's message, not `String(err)` ("TypeError: …").
  assert(!result.fault?.includes("TypeError"), result.fault);
});

Deno.test("ghRunner - runs only gh, refusing any other command with a stderr naming it (Issue #4448)", async () => {
  let called = false;
  const run = ghRunner(async () => {
    called = true;
    return "";
  });
  assertEquals(await run(["git", "status"]), {
    success: false,
    stdout: "",
    stderr: 'refusing to run "git"',
  });
  assertEquals(await run([]), {
    success: false,
    stdout: "",
    stderr: 'refusing to run ""',
  });
  assertEquals(called, false);
});

Deno.test("ghRunner - a gh success is passed through without the leading gh argument (Issue #4448)", async () => {
  let seen: string[] = [];
  const run = ghRunner(async (args) => {
    seen = args;
    return "body";
  });
  assertEquals(await run(["gh", "api", "x"]), {
    success: true,
    stdout: "body",
    stderr: "",
  });
  assertEquals(seen, ["api", "x"]);
});

Deno.test("ghRunner - a thrown Error or non-Error becomes a failed command carrying its message (Issue #4448)", async () => {
  const fromError = ghRunner(async () => {
    throw new Error("boom");
  });
  assertEquals(await fromError(["gh", "api"]), {
    success: false,
    stdout: "",
    stderr: "boom",
  });
  const fromString = ghRunner(async () => {
    throw "plain string";
  });
  assertEquals(await fromString(["gh", "api"]), {
    success: false,
    stdout: "",
    stderr: "plain string",
  });
});

Deno.test("templateActionReferences - local and docker:// references are skipped, the rest sorted and unique (Issue #4448)", () => {
  const specs = [
    {
      template: [
        "      - uses: ./.github/actions/local",
        "      - uses: docker://alpine:3",
        "      - uses: zed/last@" + "b".repeat(40) + " # v1",
        "      - uses: acme/first@" + "a".repeat(40),
        "      - run: echo uses",
      ].join("\n"),
    },
    { template: "      - uses: acme/first@" + "a".repeat(40) },
  ] as unknown as WorkflowSpec[];
  assertEquals(templateActionReferences(specs), [
    "acme/first@" + "a".repeat(40),
    "zed/last@" + "b".repeat(40),
  ]);
});
