/**
 * Issue #3047: `security_scan` must tell the model never to quote a full
 * secret value in an issue it files.
 *
 * The model files its finding with `gh issue create` directly. The gh guard
 * shim backstops that call with a shape-based mask (recognised credential
 * formats only), so without an explicit redaction rule in the prompt, a
 * finding about a hard-coded credential could still reproduce an unrecognised
 * secret value — a password, a bespoke key — in the issue title, body, or a
 * comment, where it is then readable by anyone who can read the repo's
 * issues.
 *
 * This test reads `prompts/security_scan/prompt.md` through the real
 * `loadPrompt` and checks three scoped slices — the A04 **Secrets** bullet,
 * the "Committed secret files" bullet, and the Phase 4 filing step — each
 * carry the redaction rule, so a later edit that drops it from one of the
 * three fails here rather than surfacing as a leaked secret in a filed
 * issue.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import { REPO_ROOT } from "./support/repo_root.ts";
import { flattenAll } from "./support/prompt_prose.ts";

const PROMPTS_DIR = `${REPO_ROOT}prompts`;

/**
 * The slice of `flat` from the first occurrence of `start` up to (not
 * including) the first occurrence of `end` after it.
 */
function sliceBetween(flat: string, start: string, end: string): string {
  const startAt = flat.indexOf(start);
  assert(startAt !== -1, `could not find start marker: ${start}`);
  const endAt = flat.indexOf(end, startAt + start.length);
  assert(endAt !== -1, `could not find end marker: ${end}`);
  return flat.slice(startAt, endAt);
}

/**
 * True when `slice` carries the redaction rule: never the live value, and
 * the four-character-prefix-plus-ellipsis convention for when the value's
 * shape matters.
 */
function carriesRedactionRule(slice: string): boolean {
  const namesNeverValue = /never\s+its\s+value/i.test(slice) ||
    /Never\s+quote\s+a\s+secret\s+value/i.test(slice);
  const namesFourCharEllipsis = /first\s+four\s+characters/i.test(slice) &&
    slice.includes("…");
  return namesNeverValue && namesFourCharEllipsis;
}

Deno.test("security_scan prompt tells the model to redact secret values in filed issue bodies (Issue #3047)", async () => {
  const result = await loadPrompt("security_scan", PROMPTS_DIR);
  assert(result.ok, "security_scan prompt failed to load");
  const { flat } = flattenAll(result.value);

  const secretsBullet = sliceBetween(flat, "- **Secrets** —", "#### A05");
  assert(
    carriesRedactionRule(secretsBullet),
    "the A04 **Secrets** bullet must tell the model never to quote a " +
      "secret's live value, showing at most its first four characters " +
      "followed by `…` when the shape matters:\n" + secretsBullet,
  );

  const committedSecretFilesBullet = sliceBetween(
    flat,
    "**Committed secret files",
    "**Test / example / seed credentials",
  );
  assert(
    carriesRedactionRule(committedSecretFilesBullet),
    "the Committed secret files bullet must carry the same redaction " +
      "rule as the A04 Secrets bullet:\n" + committedSecretFilesBullet,
  );

  const filingStep = sliceBetween(
    flat,
    "**File the issue** with `gh issue create`",
    "**Combined exploit-chain findings",
  );
  assert(
    carriesRedactionRule(filingStep),
    "the Phase 4 filing step must repeat the redaction rule, since the " +
      "gh guard shim's backstop only masks recognised credential shapes:\n" +
      filingStep,
  );
});
