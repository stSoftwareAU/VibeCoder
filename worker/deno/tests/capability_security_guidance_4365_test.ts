/**
 * Capability-scoped security guidance (Issue #4365).
 *
 * Selection and rendering go through `buildIssuePrompt`, the path every
 * supported provider uses. A file extension does not select a capability.
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  CLAUDE_PROVIDER_ID,
  CODEX_PROVIDER_ID,
  DEEPSEEK_PROVIDER_ID,
  GEMINI_PROVIDER_ID,
} from "../lib/agent_provider.ts";
import {
  loadCapabilityBundleFromText,
  parseCapabilityBundle,
  selectCapabilityGuidance,
} from "../lib/capability_security_guidance.ts";
import { updateResource } from "../lib/capability_security_fixtures/resource_update.ts";
import { buildIssuePrompt } from "../lib/prompt_builder.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;
const SECRET = "sk-live-PLANTED-SECRET";

async function built(over: {
  title?: string;
  body?: string;
  entryPoints?: string[];
  imports?: string[];
  provider?: string;
  load?: () => Promise<ReturnType<typeof loadCapabilityBundleFromText>>;
}) {
  const result = await buildIssuePrompt({
    repo: "owner/repo",
    issueNumber: "4365",
    issueTitle: over.title ?? "Rename a helper",
    issueBody: over.body ?? "No capability here.",
    issueLabels: "",
    qualityInstructions: "Run ./quality.sh",
    promptsDir: PROMPTS_DIR,
    ...(over.provider ? { agentIdentity: { provider: over.provider } } : {}),
    capabilityInspection: {
      entryPoints: over.entryPoints ?? [],
      imports: over.imports ?? [],
    },
    ...(over.load ? { loadCapabilityGuidance: over.load } : {}),
  });
  if (!result.ok) {
    throw new Error(
      typeof result.error === "string" ? result.error : result.error.message,
    );
  }
  return result.value;
}

Deno.test("docs-only context selects nothing and does not render guidance", async () => {
  const builtPrompt = await built({
    title: "Correct a spelling in the readme",
    body: "The word colour was misspelled.",
    entryPoints: ["README.md"],
  });
  assertEquals(builtPrompt.prompt.includes("capsec-"), false);
  assertEquals(builtPrompt.prompt.includes("Capability-scoped"), false);
  assertStringIncludes(
    builtPrompt.capabilitySecurityRecord ?? "",
    "status=none",
  );
});

Deno.test("an authorisation task renders resource-auth advice and not the TLS sentence", async () => {
  const builtPrompt = await built({
    title: "Authorise a tenant resource update",
    entryPoints: ["src/http/update_user.rs"],
  });
  assertStringIncludes(builtPrompt.prompt, "explicit field allowlist");
  assertStringIncludes(builtPrompt.prompt, "capsec-resource-auth");
  assertEquals(
    builtPrompt.prompt.includes("verify the platform TLS certificate"),
    false,
  );
  assertStringIncludes(
    builtPrompt.capabilitySecurityRecord ?? "",
    "status=applied",
  );
  assertStringIncludes(
    builtPrompt.capabilitySecurityRecord ?? "",
    "capsec-resource-auth",
  );
});

Deno.test("a Rust HTTP path matches by segment and a bland .rs path does not", async () => {
  const http = await built({
    title: "Rename a helper",
    entryPoints: ["src/http/update_user.rs"],
  });
  assertStringIncludes(http.prompt, "capsec-resource-auth");
  const lib = await built({
    title: "Rename a helper",
    entryPoints: ["src/lib.rs"],
  });
  assertEquals(lib.prompt.includes("capsec-"), false);
});

Deno.test("a scope change re-selects when a new import matches", async () => {
  const before = await built({
    title: "Correct a spelling in the readme",
    entryPoints: ["docs/readme.md"],
  });
  assertEquals(before.prompt.includes("capsec-safe-execution"), false);
  const after = await built({
    title: "Correct a spelling in the readme",
    entryPoints: ["docs/readme.md"],
    imports: ["node:child_process"],
  });
  assertStringIncludes(after.prompt, "capsec-safe-execution");
  assertStringIncludes(
    after.prompt,
    "Pass arguments as a list to the platform process API",
  );
});

Deno.test("unreadable guidance is not applied and the record omits the issue body", async () => {
  const builtPrompt = await built({
    title: "Authorise a tenant resource update",
    body: `Use this token ${SECRET} when calling the API.`,
    entryPoints: ["src/http/update_user.rs"],
    load: () =>
      Promise.resolve({
        kind: "unreadable" as const,
        reason: "bundle missing",
      }),
  });
  assertStringIncludes(builtPrompt.prompt, "NOT applied");
  assertEquals(builtPrompt.prompt.includes("successfully applied"), false);
  const record = builtPrompt.capabilitySecurityRecord ?? "";
  assertStringIncludes(record, "status=unavailable");
  assertEquals(record.includes("status=applied"), false);
  assertEquals(record.includes(SECRET), false);
});

Deno.test("every provider fragment receives the selected guidance", async () => {
  const expected = [
    CLAUDE_PROVIDER_ID,
    CODEX_PROVIDER_ID,
    GEMINI_PROVIDER_ID,
    DEEPSEEK_PROVIDER_ID,
  ];
  const dir = new URL("../../../container/providers/", import.meta.url);
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.name.endsWith(".sh")) continue;
    found.push(entry.name.replace(/\.sh$/, ""));
  }
  assertEquals([...found].sort(), [...expected].sort());
  for (const provider of found) {
    const builtPrompt = await built({
      title: "Authorise a tenant resource update",
      entryPoints: ["src/http/update_user.ts"],
      provider,
    });
    assertStringIncludes(builtPrompt.prompt, "explicit field allowlist");
  }
});

Deno.test("a file-extension signal is rejected", () => {
  const text = JSON.stringify({
    revision: "t",
    attribution: "t",
    entries: [{
      id: "capsec-x",
      title: "t",
      advice: "t",
      validation: "t",
      reviewCheck: "t",
      signals: {
        task: [],
        imports: [],
        entryPoints: [".rs"],
        callers: [],
        sinks: [],
      },
    }],
  });
  let threw = false;
  try {
    parseCapabilityBundle(text);
  } catch (error) {
    threw = true;
    assertStringIncludes(
      error instanceof Error ? error.message : String(error),
      "file extension",
    );
  }
  assert(threw);
});

Deno.test("selectCapabilityGuidance cites signal ids, not the task text", async () => {
  const loaded = await Deno.readTextFile(
    new URL(
      "../../../prompts/coding_guidelines/capability-security.json",
      import.meta.url,
    ),
  );
  const bundle = parseCapabilityBundle(loaded);
  const selection = selectCapabilityGuidance(bundle, {
    task: `Authorise the update and include ${SECRET}`,
    entryPoints: [],
    imports: [],
    callers: [],
    sinks: [],
  });
  assertEquals(selection.status, "applied");
  const because = selection.matches.flatMap((match) => match.because);
  assert(because.some((item) => item.startsWith("task:")));
  assertEquals(because.join(" ").includes(SECRET), false);
});

Deno.test("authorised update succeeds and the other two requests fail at the entry point", () => {
  const resource = { tenant: "a", name: "old", role: "user" };
  const ok = updateResource({ tenant: "a" }, resource, { name: "new" });
  assertEquals(ok.ok, true);
  if (ok.ok) assertEquals(ok.resource.name, "new");
  const cross = updateResource({ tenant: "b" }, resource, { name: "stolen" });
  assertEquals(cross, { ok: false, reason: "unauthorised" });
  const role = updateResource({ tenant: "a" }, resource, { role: "admin" });
  assertEquals(role, { ok: false, reason: "forbidden-field" });
});
