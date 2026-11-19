/**
 * Issue #5134 — the agent prompts promised a cross-repo dependency PR for any
 * reachable `stSoftwareAU/*` repo, while the worker authorises only a
 * dependency the consuming repo's own manifest declares on its default branch.
 * An undeclared repo (one a script checks out) was always refused after the
 * agent had already pushed a branch. The guidelines now define "can access" as
 * the worker enforces it, before any push step.
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CONSUMING_CARGO_MANIFEST,
  CONSUMING_MANIFEST_PATHS,
} from "../lib/cross_repo_fix.ts";
import { CROSS_REPO_PR_MARKER_NAME } from "../lib/cross_repo_pr_handoff.ts";
import {
  assertPins,
  flat,
  readRepoDoc,
  section,
  splitSection,
} from "./support/markdown_docs.ts";

const GUIDELINES_TITLE =
  "## Internal `stSoftwareAU/*` dependency fixes — fix the root cause cross-repo";

async function prePushText() {
  const guidelines = await readRepoDoc("prompts/coding_guidelines/prompt.md");
  const parts = splitSection(
    section(guidelines, GUIDELINES_TITLE),
    "### How to open that PR",
  );
  return { text: parts[0]!, pieces: parts.length };
}

Deno.test("guidelines define can-access by the declared manifests before any push step", async () => {
  const { text, pieces } = await prePushText();
  assert(pieces >= 2, "push steps must follow the definition");
  const body = flat(text);
  for (const path of CONSUMING_MANIFEST_PATHS) {
    assert(body.includes(`\`${path}\``), `definition omits ${path}`);
  }
  assert(
    body.includes(`\`${CONSUMING_CARGO_MANIFEST}\``),
    `definition omits ${CONSUMING_CARGO_MANIFEST}`,
  );
  assertPins(text, ["own manifest on its default branch declares"]);
});

Deno.test("guidelines state the undeclared-repo rule: no branch, no marker, no write authority", async () => {
  const { text } = await prePushText();
  assertPins(text, [
    `Push no branch there and declare no \`${CROSS_REPO_PR_MARKER_NAME}\` marker`,
    "reachability grants no cross-repo write authority",
  ]);
});

Deno.test("issue prompt no longer promises cross-repo work in any reachable repository", async () => {
  const issue = await readRepoDoc("prompts/issue/prompt.md");
  const text = section(issue, "## No hand-back, no follow-up");
  assertEquals(
    flat(text).includes("in another repository you can reach"),
    false,
  );
  assertPins(text, ["this repo's own manifest declares"]);
});
