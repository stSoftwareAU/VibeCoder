/**
 * Tests for github_actions_audit prompt v17 (Issue #3902).
 *
 * v17 closes the container-image pin gap the NEAT-AI `semgrep.yml` case
 * exposed: a workflow container pinned as a bare
 * `semgrep/semgrep@sha256:…` digest with no tag is immutable but
 * **untrackable** — Renovate and Dependabot key their bumps off the tag,
 * so the image froze at whatever `latest` resolved to on the day it was
 * pinned, and no v16 check fired. v16's check 25 flags mutable *tags* and
 * explicitly skips digest-pinned images; nothing tested pin trackability
 * or digest freshness.
 *
 * v17 adds two checks on workflow container images:
 *
 *   35. **Untrackable pin** — a digest with no version tag, on the same
 *       four surfaces check 25 covers, fixed by converting the pin to
 *       `<image>:<X.Y.Z>@sha256:<digest>` so the repo's own updater can
 *       bump it (per-repo isolation, Issue #3239 — the audit stays
 *       read-only detect-and-file).
 *   36. **Materially stale digest** — a digest pin the tree itself shows
 *       is behind (an aged capture comment on a floating channel, or a
 *       newer pin of the same image elsewhere in the repo), with
 *       precedence given to 35 so one image never yields two issues.
 *
 * Also guards immutability of v16 (Issue #235 — prompt versions are
 * immutable once shipped).
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  loadPrompt,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";
import { GITHUB_ACTIONS_AUDIT_BODY_FINGERPRINT } from "../lib/idle_task_templates/github_actions_audit_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function loadVersion(version: string): Promise<string> {
  const result = await loadPrompt("github_actions_audit", version, PROMPTS_DIR);
  assert(result.ok, `github_actions_audit ${version} must load`);
  return result.ok ? result.value : "";
}

const loadV17 = () => loadVersion("v17");

/** Sorted, deduplicated `{{PLACEHOLDER}}` names used by a template. */
function placeholders(body: string): string[] {
  return [...new Set(body.match(/\{\{[A-Z0-9_]+\}\}/g) ?? [])].sort();
}

/** Body with all runs of whitespace collapsed, for phrase matching. */
function flatten(body: string): string {
  return body.replace(/\s+/g, " ");
}

Deno.test("github_actions_audit v17 - loads and is the latest version", async () => {
  const latest = await getLatestVersion("github_actions_audit", PROMPTS_DIR);
  assert(latest.ok);
  if (!latest.ok) return;
  const num = parseInt(latest.value.replace("v", ""), 10);
  assertEquals(
    num >= 17,
    true,
    `Expected github_actions_audit prompt >= v17, got ${latest.value}`,
  );
});

Deno.test("github_actions_audit v17 - substitutes exactly what v16 did", async () => {
  const body = await loadV17();
  assertEquals(placeholders(body), placeholders(await loadVersion("v16")));
  const validation = validatePromptTemplate("github_actions_audit", body);
  assert(validation.ok, "v17 must validate against the registration");
  if (!validation.ok) return;
  assertEquals(validation.value, [], "v17 must miss no placeholder");
});

Deno.test("github_actions_audit v17 - keeps the load-bearing worker contracts", async () => {
  const body = await loadV17();
  assert(
    GITHUB_ACTIONS_AUDIT_BODY_FINGERPRINT.test(body),
    "v17 must keep the 'GitHub Actions Audit' H1 fingerprint",
  );
  for (
    const contract of [
      "BP-<12 hex>",
      '"github-actions-audit"',
      "<!-- finding-id:",
      "BP- in:body",
      "best-practice-ignore",
      "severity:high|severity:medium|severity:low",
      "expires=<YYYY-MM-DD>",
      "Rejected suppression:",
      "at most **6 findings**",
      "BP-STALE-ACTION-<owner>-<action>",
      "BP-EOL-RUNTIME-<runtime>-<version>",
      "BP-ARTIFACT-UPLOAD-<workflow-basename>-<job>-<step-index>",
      "BP-AI-INJECTION-<workflow-basename>-<job>-<step-index>",
      "BP-MILESTONE-FILTER-<workflow-basename>",
      "BP-DEPRECATED-RUNTIME-<owner>-<action>",
    ]
  ) {
    assertStringIncludes(body, contract);
  }
});

// --- check 35 — untrackable container-image pin ---

Deno.test("github_actions_audit v17 - defines the untrackable container pin check", async () => {
  const body = await loadV17();
  const flat = flatten(body);
  assertStringIncludes(
    body,
    "35. **Container image pinned by a bare digest with no version tag.**",
  );
  assertStringIncludes(flat, "`<image>@sha256:<digest>` with **no** tag");
  // The reason it is invisible: updaters key their bump off the tag.
  assertStringIncludes(flat, "keys its bump off the tag");
  assertStringIncludes(flat, "Renovate");
  assertStringIncludes(flat, "Dependabot");
  // Same four surfaces as check 25.
  for (
    const surface of [
      "**Docker container action**",
      "**Job-level container**",
      "**Service containers**",
      "**Composite/Docker action `Dockerfile`**",
    ]
  ) {
    assertEquals(
      (flat.match(new RegExp(surface.replace(/[*`/]/g, "\\$&"), "g")) ?? [])
        .length >= 2,
      true,
      `v17 must repeat the '${surface}' surface for check 35`,
    );
  }
  // Target shape after the fix.
  assertStringIncludes(flat, "`<image>:<X.Y.Z>@sha256:<digest>`");
  // The audit stays read-only detect-and-file (Issue #3239 isolation).
  assertStringIncludes(flat, "this scan only files the finding");
});

Deno.test("github_actions_audit v17 - does not exempt first-party images from check 35", async () => {
  const flat = flatten(await loadV17());
  assertStringIncludes(
    flat,
    "an untrackable pin is untrackable regardless of owner",
  );
});

Deno.test("github_actions_audit v17 - keeps a tagged digest pin out of check 35", async () => {
  const flat = flatten(await loadV17());
  assertStringIncludes(
    flat,
    "Do not flag a pin that already carries a release tag alongside its digest",
  );
});

// --- check 36 — materially stale digest ---

Deno.test("github_actions_audit v17 - defines the stale container digest check", async () => {
  const body = await loadV17();
  const flat = flatten(body);
  assertStringIncludes(
    body,
    "36. **Digest-pinned container image left materially stale.**",
  );
  // Groundable in-tree only — the audit has no network access.
  assertStringIncludes(
    flat,
    "never assert an upstream version you cannot cite",
  );
  assertStringIncludes(flat, "**Aged snapshot of a floating channel.**");
  assertStringIncludes(flat, "**In-repo drift.**");
  assertStringIncludes(flat, "more than **180 days** before today");
  // Unresolvable staleness is dropped, not guessed (Hard Constraint 4).
  assertStringIncludes(
    flat,
    "**drop the candidate** (Hard Constraint 4) rather than guessing how far behind the image is",
  );
});

Deno.test("github_actions_audit v17 - gives check 35 precedence so one image files once", async () => {
  const flat = flatten(await loadV17());
  assertStringIncludes(flat, "**Precedence over 35.**");
  assertStringIncludes(flat, "file **35 only**");
  assertStringIncludes(flat, "Never file two issues for one image.");
});

// --- check 25 no longer leaves digest pins unchecked ---

Deno.test("github_actions_audit v17 - routes digest pins from check 25 to 35 and 36", async () => {
  const flat = flatten(await loadV17());
  assertEquals(
    flat.includes(
      "Do not flag an image already pinned by digest (`postgres:16@sha256:…`). **Suggested fix**",
    ),
    false,
    "v17 must not leave check 25's digest carve-out without a successor check",
  );
  assertStringIncludes(
    flat,
    "a *tagless* digest pin is check 35's, and a demonstrably stale digest pin is check 36's",
  );
});

// --- catalogue-wide consistency: the new checks are reachable ---

Deno.test("github_actions_audit v17 - counts its checks as 36 in the long-run constraint", async () => {
  const flat = flatten(await loadV17());
  assertStringIncludes(flat, "A whole-repo sweep of 36 checks");
  assertEquals(
    flat.includes("A whole-repo sweep of 34 checks"),
    false,
    "v17 must not keep the stale check count",
  );
});

Deno.test("github_actions_audit v17 - sweeps the new checks in their severity bands", async () => {
  const flat = flatten(await loadV17());
  assertStringIncludes(
    flat,
    "plus the high bands of 23, 24, 25, 35 and 36",
  );
  assertStringIncludes(
    flat,
    "12, 13, 14, 15, 16, 17, 28, 33, 34, 35, 36,",
  );
});

Deno.test("github_actions_audit v17 - names the container checks in the severity ladder", async () => {
  const flat = flatten(await loadV17());
  assertStringIncludes(flat, "untrackable container-image pin (35)");
  assertStringIncludes(flat, "materially stale container-image digest (36)");
});

Deno.test("github_actions_audit v17 - gives the container checks stable id prefixes", async () => {
  const body = await loadV17();
  const flat = flatten(body);
  assertStringIncludes(body, "BP-CONTAINER-PIN-<image-slug>");
  assertStringIncludes(body, "BP-CONTAINER-STALE-<image-slug>");
  assertStringIncludes(flat, "`BP-CONTAINER-PIN-semgrep-semgrep`");
  // One finding per image per repo, not one per call-site.
  assertEquals(
    (flat.match(/One finding per image per repo/g) ?? []).length >= 2,
    true,
    "both container checks must state the per-image dedup grain",
  );
  // The generic-id recipe must not claim the new checks.
  assertEquals(
    /the base checks 1–8[^.]*35/.test(flat),
    false,
    "checks 35 and 36 keep specific-prefix ids, not the generic recipe",
  );
});

Deno.test("github_actions_audit v17 - works the container pin through an example and a near-miss", async () => {
  const body = await loadV17();
  const names = [...body.matchAll(/<example name="([^"]+)">/g)].map((m) =>
    m[1]
  );
  assertEquals(
    (body.match(/<\/example>/g) ?? []).length,
    names.length,
    "every <example> must be closed",
  );
  for (
    const required of [
      "tagless-digest-container-pin",
      "tagged-digest-container-pin",
    ]
  ) {
    assertEquals(
      names.includes(required),
      true,
      `v17 must carry the '${required}' example`,
    );
  }
  // The v16 examples survive.
  for (
    const inherited of [
      "untrusted-pr-title-in-a-run-step",
      "trusted-github-sha-in-a-run-step",
      "sha-pin-with-no-version-comment",
      "two-shellcheck-workflows-over-distinct-globs",
      "agent-step-given-only-trusted-fields",
    ]
  ) {
    assertEquals(
      names.includes(inherited),
      true,
      `v17 must keep the '${inherited}' example`,
    );
  }
});

// --- immutability of the predecessor (Issue #235) ---

Deno.test("github_actions_audit v16 - stays frozen without the v17 container checks", async () => {
  const v16 = await loadVersion("v16");
  const flat = flatten(v16);
  assertEquals(
    v16.includes("BP-CONTAINER-PIN-"),
    false,
    "v16 is immutable and must not gain the container-pin id",
  );
  assertEquals(
    v16.includes("BP-CONTAINER-STALE-"),
    false,
    "v16 is immutable and must not gain the stale-digest id",
  );
  assert(
    flat.includes(
      "Do not flag an image already pinned by digest (`postgres:16@sha256:…`). **Suggested fix**",
    ),
    "v16 must keep the unqualified digest carve-out v17 routes onward",
  );
  assert(
    flat.includes("A whole-repo sweep of 34 checks"),
    "v16 must keep its 34-check count",
  );
});
