/**
 * Documentation tests for Issue #871 (part of #863) — the release-integrity
 * guarantees are only worth having if an operator can find out what they are,
 * verify them, and learn the supported way to move between releases.
 *
 * Every assertion ties the prose back to something real: the blocked
 * operations come from the checked-in ruleset payload
 * (`infra/rulesets/release-tags.json`, loaded through the same parser the
 * ruleset tests use), the example tags in the verification commands are
 * pushed through the real ref matcher, the notice wording is rendered by
 * `formatReleaseNotice`, the upgrade command by `UPGRADE_INVOCATION`, and the
 * cross-links resolve against the target documents' real headings. A rule
 * added to the payload, or a command renamed in the code, therefore fails
 * these tests rather than leaving the docs quietly wrong.
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */

import { assert } from "@std/assert";
import { flat, readRepoDoc as read, section } from "./support/markdown_docs.ts";
import {
  loadReleaseTagRuleset,
  refIsProtected,
  RELEASE_TAG_RULESET_PATH,
  ruleTypes,
} from "../lib/release_tag_ruleset.ts";
import { anchorSet } from "../lib/markdown_anchors.ts";
import { formatReleaseNotice } from "../lib/release_notice.ts";
import { UPGRADE_INVOCATION } from "../lib/upgrade_command.ts";

const INTEGRITY_SECTION = "Release integrity";
const CHECKOUT_UPDATE_SECTION = "Host-Side Checkout Update";
const NOTICE_SECTION = "New-Release Notice";
const SETUP_SECTION = "Update mode: dynamic or frozen";

/** The release from which GitHub's immutable-releases setting applies. */
const FIRST_IMMUTABLE_RELEASE = "1.0.50";

/** How many earlier releases predate it and stay `immutable: false`. */
const MUTABLE_RELEASE_COUNT = "31";

async function integritySection(): Promise<string> {
  return section(await read("docs/RELEASE-TAGGING.md"), INTEGRITY_SECTION);
}

Deno.test("RELEASE-TAGGING.md - release integrity states the immutable-releases boundary", async () => {
  const body = flat(await integritySection());

  assert(
    body.includes("immutable"),
    "the section does not name the immutable-releases setting",
  );
  assert(
    body.includes(FIRST_IMMUTABLE_RELEASE),
    `the section does not name ${FIRST_IMMUTABLE_RELEASE} as the first immutable release`,
  );
  assert(
    body.includes(MUTABLE_RELEASE_COUNT),
    "the section does not say how many earlier releases stay mutable",
  );
  assert(
    body.includes("`immutable: true`") && body.includes("`immutable: false`"),
    "the section does not say what the API reports for either side of the boundary",
  );
  assert(
    /not retroactive|stay that way|never becomes/i.test(body),
    "the section does not say the earlier releases keep reporting false",
  );
});

Deno.test("RELEASE-TAGGING.md - release integrity names every rule the payload carries", async () => {
  const ruleset = await loadReleaseTagRuleset();
  const body = flat(await integritySection());

  for (const rule of ruleTypes(ruleset)) {
    assert(
      body.includes(`\`${rule}\``),
      `the section does not name the "${rule}" rule the payload carries`,
    );
  }
  assert(
    body.includes(RELEASE_TAG_RULESET_PATH),
    `the section does not name ${RELEASE_TAG_RULESET_PATH} as the source of truth`,
  );
});

Deno.test("RELEASE-TAGGING.md - release integrity states what the ruleset leaves alone", async () => {
  const ruleset = await loadReleaseTagRuleset();
  const body = flat(await integritySection());

  // The payload carries no creation rule, and the docs have to say so: the
  // tagging workflow mints a new tag on every merge.
  assert(
    !ruleTypes(ruleset).includes("creation"),
    "the payload now blocks creation — the documented allowance is wrong",
  );
  assert(
    /no `creation` rule/.test(body),
    "the section does not say creating a tag is deliberately unblocked",
  );
  assert(
    body.includes("release-tag.yml"),
    "the section does not say the tagging workflow keeps minting patches",
  );

  assert(
    (ruleset.bypass_actors ?? []).length === 0,
    "the payload now carries bypass actors — the documented guarantee is wrong",
  );
  assert(
    /bypass/i.test(body),
    "the section does not say the ruleset has no bypass actors",
  );
});

Deno.test("RELEASE-TAGGING.md - release integrity carries both verification commands", async () => {
  const body = await integritySection();

  assert(
    body.includes("gh api repos/stSoftwareAU/VibeCoder/rulesets"),
    "the section does not show how to read the live ruleset back",
  );
  assert(
    /git push origin :refs\/tags\//.test(body),
    "the section does not show the refused delete as the behavioural proof",
  );
});

Deno.test("RELEASE-TAGGING.md - every example tag in the section is one the ruleset protects", async () => {
  const ruleset = await loadReleaseTagRuleset();
  const body = await integritySection();

  const refs = [...body.matchAll(/refs\/tags\/([\w.+-]+)/g)]
    .map((match) => `refs/tags/${match[1] ?? ""}`)
    .filter((ref) => !ref.includes("<")); // placeholders, not real tags
  assert(refs.length > 0, "the section shows no worked tag");

  for (const ref of refs) {
    assert(
      refIsProtected(ruleset, ref),
      `the section uses ${ref} as a protected example, but the ruleset does not match it`,
    );
  }
});

Deno.test("RELEASE-TAGGING.md - release integrity points at the upgrade command, not an edited tag", async () => {
  const body = flat(await integritySection());
  const configAnchors = anchorSet(await read("docs/CONFIGURATION.md"));

  assert(
    body.includes(UPGRADE_INVOCATION),
    `the section does not name "${UPGRADE_INVOCATION}" as the way to move a frozen host`,
  );
  const anchor = "the-upgrade-loop";
  assert(
    body.includes(`CONFIGURATION.md#${anchor}`),
    "the section does not link the upgrade loop",
  );
  assert(
    configAnchors.has(anchor),
    `the section links CONFIGURATION.md#${anchor}, which is not a real heading`,
  );
});

Deno.test("CONFIGURATION.md - a frozen host at its pin is documented as doing no fetch", async () => {
  const body = section(
    await read("docs/CONFIGURATION.md"),
    CHECKOUT_UPDATE_SECTION,
  );

  const atPin = body.split(/\n\s*\n/).map(flat).find((paragraph) =>
    /already (on|at) (its|the) pin/i.test(paragraph)
  );
  assert(
    atPin,
    "the checkout-update section does not say what a host already at its pin does",
  );
  assert(
    /no fetch/i.test(atPin),
    "the checkout-update section does not say a host at its pin fetches nothing",
  );
});

Deno.test("CONFIGURATION.md - the notice section quotes the line the code emits", async () => {
  const body = section(await read("docs/CONFIGURATION.md"), NOTICE_SECTION);

  assert(
    body.includes(formatReleaseNotice("1.0.4", "1.0.5")),
    "the notice section does not quote the notice line verbatim",
  );
  assert(
    body.includes(UPGRADE_INVOCATION),
    `the notice section does not name "${UPGRADE_INVOCATION}"`,
  );
});

Deno.test("SETUP.md - the latest-release pin is stated, and dynamic is not the default", async () => {
  const body = section(await read("docs/SETUP.md"), SETUP_SECTION);

  assert(
    /latest release tag/i.test(flat(body)),
    "the section does not say a fresh frozen host is pinned to the latest release tag",
  );
  // Issue #871: `dynamic` stays available, but the docs must say who it is
  // for rather than leaving it looking like the default.
  const dynamicFor = body.split(/\n\s*\n/).map(flat).find((paragraph) =>
    /not the default/i.test(paragraph) && /testing Vibe Coder/i.test(paragraph)
  );
  assert(
    dynamicFor,
    "no paragraph says dynamic is not the default and who it is for",
  );
});
