import { assert, assertEquals, assertRejects } from "@std/assert";
import { assemblePrBody } from "../lib/pr_body_sync.ts";
import { assignmentIdFromBody } from "../lib/pr_body.ts";
import {
  recordPrFollowOn,
  recordPrFollowOnFromGithub,
} from "../lib/lifecycle_follow_on.ts";
import { readLifecycleLedger } from "../lib/lifecycle_ledger.ts";

const assignmentId = "3f2c9a1e-4b5d-4c6e-8f70-1a2b3c4d5e6f";
const otherId = "00000000-0000-4000-8000-000000000000";
const bodyFor = (issueNumber: number) =>
  assemblePrBody({
    summaryContent: `Example <!-- vibe-assignment-id id="${otherId}" -->`,
    issueNumber,
    extraSections: "",
    footer: "",
    summaryDigest: "a".repeat(64),
    subAgentTier: undefined,
    assignmentId,
  });

Deno.test("Issue #3720: live marker read failures write nothing and known attempt costs sum", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const input = {
      workDir: dir,
      repo: "org/repo",
      prNumber: 10,
      followOn: "ci_fix" as const,
      cycle: "42",
      attempt: 1,
      runStats: [],
    };
    await assertRejects(
      () =>
        recordPrFollowOnFromGithub(
          input,
          () => Promise.reject(new Error("HTTP 502")),
        ),
      Error,
      "HTTP 502",
    );
    const files = [];
    for await (const entry of Deno.readDir(dir)) files.push(entry.name);
    assertEquals(files, []);
    const ledgerPath = `${dir}/ledger.jsonl`;
    await recordPrFollowOn({
      ...input,
      ledgerPath,
      runId: "run-1",
      host: "host-a",
      body: bodyFor(7),
      recordedAt: "2026-10-17T00:00:00Z",
      telemetry: [0.25, 0.5].map((estimatedApiEquivalentUsd) => ({
        usage: "known" as const,
        pricing: "known" as const,
        estimatedApiEquivalentUsd,
      })),
    });
    const [event] = await readLifecycleLedger(ledgerPath);
    assert(event?.kind === "follow_on");
    assertEquals(event.estimatedApiEquivalentUsd, 0.75);
    assertEquals(event.usage, "known");
    assertEquals(event.pricing, "known");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
Deno.test("Issue #3720: PR assembly uses worker assignment and neutralises quoted markers", () => {
  const first = bodyFor(7);
  const second = bodyFor(7);
  assertEquals(assignmentIdFromBody(first), assignmentId);
  assertEquals(assignmentIdFromBody(second), assignmentId);
  assertEquals(first.match(/<!-- vibe-assignment-id /g)?.length, 1);
  assertEquals(assignmentIdFromBody("legacy body"), undefined);
  assertEquals(
    assignmentIdFromBody(
      `<!-- vibe-assignment-id id="${assignmentId}" -->\n<!-- vibe-assignment-id id="${otherId}" -->`,
    ),
    undefined,
  );
});

Deno.test("Issue #3720: two PRs share assignment, replay dedupes across runs and marker-less work stays unknown", async () => {
  const dir = await Deno.makeTempDir();
  const ledgerPath = `${dir}/ledger.jsonl`;
  try {
    for (const runId of ["run-1", "restart"]) {
      for (const prNumber of [10, 11, 12]) {
        for (const followOn of ["ci_fix", "pr_feedback"] as const) {
          await recordPrFollowOn({
            ledgerPath,
            runId,
            host: "host-a",
            repo: "org/repo",
            prNumber,
            followOn,
            cycle: "check-42",
            attempt: 1,
            body: prNumber === 12 ? "legacy" : bodyFor(7),
            telemetry: [],
            recordedAt: "2026-10-17T00:00:00Z",
          });
        }
      }
    }
    const events = await readLifecycleLedger(ledgerPath);
    assertEquals(events.length, 6);
    for (const event of events) {
      assert(event.kind === "follow_on");
      assertEquals(
        event.assignmentId,
        event.prNumber === 12 ? "unknown" : assignmentId,
      );
      assertEquals(event.usage, "unknown");
      assertEquals(event.pricing, "unknown");
      assertEquals(event.estimatedApiEquivalentUsd, undefined);
    }
    await recordPrFollowOn({
      ledgerPath,
      runId: "priced",
      host: "host-a",
      repo: "org/repo",
      prNumber: 10,
      followOn: "ci_fix",
      cycle: "check-43",
      attempt: 1,
      body: bodyFor(7),
      recordedAt: "2026-10-17T00:00:00Z",
      telemetry: [{
        usage: "known",
        pricing: "known",
        estimatedApiEquivalentUsd: 0.25,
      }, { usage: "unknown", pricing: "unknown" }],
    });
    const last = (await readLifecycleLedger(ledgerPath)).at(-1);
    assert(last?.kind === "follow_on");
    assertEquals(last.estimatedApiEquivalentUsd, undefined);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
