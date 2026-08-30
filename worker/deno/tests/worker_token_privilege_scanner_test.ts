/**
 * Tests for the worker-token privilege scanner (Issue #599, part of #566).
 *
 * The operator's hard constraint is that the Vibe Coder can never change a
 * GitHub ruleset — rulesets are how a human keeps builds clean before a
 * merge. Until this scanner existed nothing checked the constraint: it held
 * only because the worker did not choose to call those endpoints. The
 * scanner reads the token's own repository permissions read-only and emits a
 * `needs-human` escalation finding when they include `admin` or `maintain`,
 * either of which carries the rulesets API.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  scanWorkerTokenPrivileges,
  WORKER_TOKEN_RULESET_FINDING_ID,
} from "../lib/worker_token_privilege_scanner.ts";

/** A gh stub answering endpoints from a table, recording every call. */
function ghFor(answers: Record<string, unknown>): {
  gh: (args: string[]) => Promise<string>;
  calls: string[][];
} {
  const calls: string[][] = [];
  const gh = (args: string[]): Promise<string> => {
    calls.push([...args]);
    const endpoint = args[1] ?? "";
    for (const [key, value] of Object.entries(answers)) {
      if (endpoint === key) {
        if (value instanceof Error) return Promise.reject(value);
        return Promise.resolve(JSON.stringify(value));
      }
    }
    return Promise.reject(new Error(`unexpected endpoint ${endpoint}`));
  };
  return { gh, calls };
}

const PUSH_ONLY = {
  "repos/org/repo": {
    permissions: { admin: false, maintain: false, push: true, pull: true },
  },
  "user": { login: "vibe-coder-bot", type: "User" },
};

const ADMIN = {
  "repos/org/repo": {
    permissions: { admin: true, maintain: true, push: true, pull: true },
  },
  "user": { login: "vibe-coder-bot", type: "User" },
};

const MAINTAIN = {
  "repos/org/repo": {
    permissions: { admin: false, maintain: true, push: true, pull: true },
  },
  "user": { login: "vibe-coder-bot", type: "User" },
};

Deno.test("scanWorkerTokenPrivileges - an admin token is one needs-human escalation naming the grant (Issue #599)", async () => {
  const { gh } = ghFor(ADMIN);
  const findings = await scanWorkerTokenPrivileges("org/repo", gh, {});
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assertEquals(f.findingId, WORKER_TOKEN_RULESET_FINDING_ID);
  assertEquals(f.severity, "high");
  assertEquals([...f.labels].sort(), ["needs-human", "security"]);
  assert(f.evidence.includes("admin=true"), f.evidence);
  assert(f.evidence.includes("maintain=true"), f.evidence);
  assert(f.evidence.includes("vibe-coder-bot"), f.evidence);
  // The body must say what the grant lets the worker do, and the remedy.
  assert(/ruleset/i.test(f.whyItMatters), f.whyItMatters);
  assert(/status check/i.test(f.whyItMatters), f.whyItMatters);
  assert(/\bwrite\b|\bpush\b/.test(f.suggestedFix), f.suggestedFix);
});

Deno.test("scanWorkerTokenPrivileges - maintain alone is still a finding; push-only is silent (Issue #599)", async () => {
  const maintain = await scanWorkerTokenPrivileges(
    "org/repo",
    ghFor(MAINTAIN).gh,
    {},
  );
  assertEquals(maintain.length, 1);
  assert(maintain[0]!.evidence.includes("maintain=true"));
  assert(!maintain[0]!.evidence.includes("admin=true"));

  const pushOnly = await scanWorkerTokenPrivileges(
    "org/repo",
    ghFor(PUSH_ONLY).gh,
    {},
  );
  assertEquals(pushOnly, []);
});

Deno.test("scanWorkerTokenPrivileges - reads only; never probes a ruleset with a write (Issue #599)", async () => {
  const { gh, calls } = ghFor({
    ...ADMIN,
    "repos/org/repo/installation": {
      app_slug: "vibe-coder",
      permissions: { administration: "write", repository_hooks: "write" },
    },
  });
  await scanWorkerTokenPrivileges("org/repo", gh, {});
  assert(calls.length > 0, "the scanner must actually call gh");
  for (const args of calls) {
    assertEquals(args[0], "api", args.join(" "));
    // No verb override, no field payload — a GET and nothing else. A write
    // probe (create/edit/delete a ruleset) is forbidden outright.
    for (const [i, arg] of args.entries()) {
      assert(
        !["-X", "--method", "-f", "--field", "-F", "--raw-field", "--input"]
          .includes(arg),
        `write-shaped argument ${arg} in: ${args.join(" ")}`,
      );
      assert(
        !(arg === "api" && /rulesets/.test(args[i + 1] ?? "")),
        `ruleset probe in: ${args.join(" ")}`,
      );
    }
  }
});

Deno.test("scanWorkerTokenPrivileges - an App installation grant is named in the evidence (Issue #599)", async () => {
  const { gh } = ghFor({
    "repos/org/repo": {
      permissions: { admin: true, maintain: false, push: true },
    },
    "user": { login: "vibe-coder[bot]", type: "Bot" },
    "repos/org/repo/installation": {
      app_slug: "vibe-coder",
      permissions: {
        administration: "write",
        repository_hooks: "write",
        contents: "write",
      },
    },
  });
  const findings = await scanWorkerTokenPrivileges("org/repo", gh, {});
  assertEquals(findings.length, 1);
  const f = findings[0]!;
  assert(f.evidence.includes("administration=write"), f.evidence);
  assert(f.evidence.includes("repository_hooks=write"), f.evidence);
  assert(/installation/i.test(f.suggestedFix), f.suggestedFix);
});

Deno.test("scanWorkerTokenPrivileges - a failed permission lookup is reported and yields no finding, never a safe verdict (Issue #599)", async () => {
  const failures: string[] = [];
  const findings = await scanWorkerTokenPrivileges(
    "org/repo",
    ghFor({ "repos/org/repo": new Error("HTTP 403: Forbidden") }).gh,
    { onLookupFailure: (what, reason) => failures.push(`${what}: ${reason}`) },
  );
  assertEquals(findings, []);
  assertEquals(failures.length, 1);
  assert(failures[0]!.includes("HTTP 403"), failures[0]);

  // A response with no `.permissions` object is equally unreadable — the
  // token's scope is unknown, which is not the same as safe.
  const noPerms: string[] = [];
  const blind = await scanWorkerTokenPrivileges(
    "org/repo",
    ghFor({ "repos/org/repo": { name: "repo" } }).gh,
    { onLookupFailure: (what, reason) => noPerms.push(`${what}: ${reason}`) },
  );
  assertEquals(blind, []);
  assertEquals(noPerms.length, 1);
});

Deno.test("scanWorkerTokenPrivileges - an unreadable identity is reported but the over-privilege finding still stands (Issue #599)", async () => {
  const failures: string[] = [];
  const findings = await scanWorkerTokenPrivileges(
    "org/repo",
    ghFor({
      "repos/org/repo": { permissions: { admin: true, push: true } },
      "user": new Error("HTTP 403: Resource not accessible by integration"),
    }).gh,
    { onLookupFailure: (what, reason) => failures.push(`${what}: ${reason}`) },
  );
  assertEquals(findings.length, 1);
  assert(findings[0]!.evidence.includes("admin=true"));
  assertEquals(failures.length, 2, JSON.stringify(failures));
  assert(failures.some((f) => f.includes("Resource not accessible")));
});

Deno.test("scanWorkerTokenPrivileges - an already-open finding id is not re-filed (Issue #599)", async () => {
  const findings = await scanWorkerTokenPrivileges("org/repo", ghFor(ADMIN).gh, {
    knownOpenFindingIds: [WORKER_TOKEN_RULESET_FINDING_ID],
  });
  assertEquals(findings, []);
});
