/**
 * Recovery stays within configured authority (Issue #4417).
 *
 * The sixth entry, `capsec-recovery-boundary`, is read from the shipped
 * bundle and selected through `buildIssuePrompt`, the path every supported
 * provider uses. Task selection is a case-insensitive substring match, so the
 * negative cases name ordinary retry and backoff work that must not select it.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  capabilityBundlePath,
  type CapabilityEntry,
  parseCapabilityBundle,
  selectCapabilityGuidance,
} from "../lib/capability_security_guidance.ts";
import { buildIssuePrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const RECOVERY_ID = "capsec-recovery-boundary";

async function shippedBundle() {
  return parseCapabilityBundle(
    await Deno.readTextFile(capabilityBundlePath()),
  );
}

async function recoveryEntry(): Promise<CapabilityEntry> {
  const entry = (await shippedBundle()).entries.find((e) =>
    e.id === RECOVERY_ID
  );
  assert(entry, `${RECOVERY_ID} is in the shipped bundle`);
  return entry;
}

async function built(over: {
  title?: string;
  body?: string;
  entryPoints?: string[];
  sinks?: string[];
}) {
  const result = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "4417",
    issueTitle: over.title ?? "Rename a helper",
    issueBody: over.body ?? "No capability here.",
    issueLabels: "",
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
    capabilityInspection: {
      entryPoints: over.entryPoints ?? [],
      sinks: over.sinks ?? [],
    },
  });
  if (!result.ok) {
    throw new Error(
      typeof result.error === "string" ? result.error : result.error.message,
    );
  }
  return result.value;
}

Deno.test("the recovery boundary entry parses from the shipped bundle with every required field (Issue #4417)", async () => {
  const bundle = await shippedBundle();
  assertEquals(bundle.revision, "2026-10-27.1");
  assertEquals(bundle.entries.length, 6);
  const entry = await recoveryEntry();
  assertEquals(entry.title, "Recovery stays within configured authority");
  for (
    const field of [entry.advice, entry.validation, entry.reviewCheck]
  ) {
    assert(field.trim() !== "", "a required text field is non-empty");
  }
  assert(entry.signals.task.length > 0, "the entry has task signals");
  assertStringIncludes(bundle.attribution, "Issue #4417");
  assertStringIncludes(bundle.attribution, "not CodeGuard material");
});

Deno.test("a restart path that refreshes a credential selects recovery-boundary and renders its advice (Issue #4417)", async () => {
  const builtPrompt = await built({
    title:
      "Fix the restart path so a credential refresh does not change the mounts",
  });
  assertStringIncludes(builtPrompt.prompt, `${RECOVERY_ID}: When a failure`);
  assertStringIncludes(
    builtPrompt.prompt,
    "A refreshed token inside the configured scope is legitimate",
  );
  const record = builtPrompt.capabilitySecurityRecord ?? "";
  assertStringIncludes(record, "status=applied");
  assertStringIncludes(record, RECOVERY_ID);
});

Deno.test("an ordinary retry with backoff does not select recovery-boundary (Issue #4417)", async () => {
  const builtPrompt = await built({
    title: "Add retry with exponential backoff to the HTTP client",
  });
  assertEquals(builtPrompt.prompt.includes(RECOVERY_ID), false);
  const record = builtPrompt.capabilitySecurityRecord ?? "";
  assertEquals(record.includes(RECOVERY_ID), false);
  assertStringIncludes(record, "status=none");
});

Deno.test("a docs-only change does not select recovery-boundary (Issue #4417)", async () => {
  const builtPrompt = await built({
    title: "Correct a spelling in the readme",
    body: "The word colour was misspelled.",
    entryPoints: ["docs/CAPABILITY-SECURITY-GUIDANCE.md"],
  });
  assertEquals(builtPrompt.prompt.includes(RECOVERY_ID), false);
  assertStringIncludes(
    builtPrompt.capabilitySecurityRecord ?? "",
    "status=none",
  );
});

Deno.test("a recovery path on an authorisation task renders both applicable entries (Issue #4417)", async () => {
  const builtPrompt = await built({
    title: "Authorise a tenant resource update after the restart path is fixed",
    entryPoints: ["src/http/update_user.rs"],
  });
  assertStringIncludes(builtPrompt.prompt, "capsec-resource-auth:");
  assertStringIncludes(builtPrompt.prompt, `${RECOVERY_ID}:`);
  const record = builtPrompt.capabilitySecurityRecord ?? "";
  assertStringIncludes(record, "capsec-resource-auth");
  assertStringIncludes(record, RECOVERY_ID);
});

Deno.test("the review check says an unrelated identical retry does not trigger it (Issue #4417)", async () => {
  const entry = await recoveryEntry();
  assertStringIncludes(
    entry.reviewCheck,
    "A retry that only repeats the same request (no change to credentials, mounts, identity or network) does not trigger this check.",
  );
  assertStringIncludes(
    entry.reviewCheck,
    "A stub, a deny-all, or a test that only asserts the failure does not pass.",
  );
});

Deno.test("sink fragments must share one line to select recovery-boundary (Issue #4417)", async () => {
  const bundle = await shippedBundle();
  const context = (sinks: string[]) => ({
    task: "Rename a helper",
    entryPoints: [],
    imports: [],
    callers: [],
    sinks,
  });
  const together = selectCapabilityGuidance(
    bundle,
    context(["let pool = retryWithCredential(pool_state);"]),
  );
  const match = together.matches.find((m) => m.entry.id === RECOVERY_ID);
  assert(match, "both fragments on one line select the entry");
  assertEquals(match.because, ["sink:retry+credential"]);

  const split = selectCapabilityGuidance(
    bundle,
    context(["await retry(pool);", "const credential = pool.next();"]),
  );
  assertEquals(
    split.matches.some((m) => m.entry.id === RECOVERY_ID),
    false,
  );
});
