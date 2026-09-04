/**
 * Documentation tests for Issue #628 (part of #583) — the update-mode fields
 * are only useful to an operator who can find out what they are called, what
 * they accept, and how to move a pin without re-running setup.
 *
 * Every assertion here ties the prose back to the code that reads the fields:
 * the mode names come from `UPDATE_MODES`, the pinned tools from
 * `PINNED_TOOLS`, the worked examples are parsed and pushed through the very
 * validator `.config.json` load uses (`pinValueErrors`, `KNOWN_CONFIG_KEYS`),
 * and the cross-links are resolved against the target documents' real
 * headings. A field renamed in the code therefore fails these tests rather
 * than leaving the docs quietly wrong.
 *
 * Australian English spelling used throughout (behaviour, recognised, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import { readRepoDoc as read, section } from "./support/markdown_docs.ts";
import { SKIP_CHECKOUT_UPDATE_ENV } from "../commands/worker_checkout_update.ts";
import {
  DEFAULT_UPDATE_MODE,
  PINNED_TOOLS,
  SETUP_DEFAULT_UPDATE_MODE,
  UPDATE_MODES,
} from "../lib/config_defaults.ts";
import { pinValueErrors } from "../lib/config_validator.ts";
import { KNOWN_CONFIG_KEYS } from "../lib/config_unknown_keys.ts";
import { anchorSet, githubSlug } from "../lib/markdown_anchors.ts";
import { formatReleaseNotice } from "../lib/release_notice.ts";
import { RELEASE_MANIFEST_ASSET } from "../lib/release_manifest.ts";
import { upgradeCommand } from "../commands/upgrade.ts";
import {
  UPGRADE_COMMAND_NAME,
  UPGRADE_INVOCATION,
} from "../lib/upgrade_command.ts";

/** Every fenced ```json block body in `markdown`. */
function jsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) blocks.push(match[1] ?? "");
  return blocks;
}

/** Where each of `needles` first appears in `text`; -1 when it is absent. */
function positions(text: string, needles: string[]): number[] {
  return needles.map((needle) => text.indexOf(needle));
}

const SETUP_SECTION = "Update mode: dynamic or frozen";
const CONFIG_SECTION = "Update Mode";

Deno.test("SETUP.md - the update-mode prompts are documented in the order setup asks them", async () => {
  const body = section(await read("docs/SETUP.md"), SETUP_SECTION);

  // askMode → askPinnedRef → askToolVersions, in update_mode_setup.ts.
  const order = [
    "Update mode (dynamic/frozen)",
    "Pinned ref",
    ...PINNED_TOOLS.map((tool) => `pinned_tool_versions.${tool}`),
  ];
  const found = positions(body, order);

  let previous = -1;
  for (const [index, position] of found.entries()) {
    assert(position >= 0, `"${order[index]}" is not documented`);
    assert(position > previous, `"${order[index]}" is documented out of order`);
    previous = position;
  }
});

Deno.test("SETUP.md - the update-mode section states both accepted modes and the default setup offers", async () => {
  const body = section(await read("docs/SETUP.md"), SETUP_SECTION);

  for (const mode of UPDATE_MODES) {
    assert(body.includes(`\`${mode}\``), `mode "${mode}" is not documented`);
  }
  // Issue #692: the conversation's default answer, which is deliberately not
  // the load-time default for an absent key.
  assert(
    body.includes(`defaults to \`${SETUP_DEFAULT_UPDATE_MODE}\``),
    "the default mode setup offers is not stated",
  );
  assert(
    body.includes(`loads as \`${DEFAULT_UPDATE_MODE}\``),
    "SETUP.md does not say what an absent update_mode still loads as",
  );
});

Deno.test("SETUP.md - the non-interactive fresh-host behaviour names both outcomes", async () => {
  const body = section(await read("docs/SETUP.md"), SETUP_SECTION);

  assert(
    /pinned to the latest release/i.test(body),
    "an unattended fresh host being pinned to the latest release is not documented",
  );
  assert(
    /one warning line/i.test(body) &&
      body.includes(`\`update_mode: "${DEFAULT_UPDATE_MODE}"\``),
    "the unattended fallback to the load-time default is not documented",
  );
});

Deno.test("SETUP.md - the non-interactive and Windows behaviour is documented", async () => {
  const body = section(await read("docs/SETUP.md"), SETUP_SECTION);

  assert(
    /non-interactive|no terminal/i.test(body),
    "a non-interactive setup run's behaviour is not documented",
  );
  assert(
    body.includes("setup.ps1"),
    "the Windows follow-up is not noted in the setup docs",
  );
});

Deno.test("CONFIGURATION.md - the worked examples cover both modes and validate", async () => {
  const body = section(await read("docs/CONFIGURATION.md"), CONFIG_SECTION);
  const examples = jsonBlocks(body).map((block) =>
    JSON.parse(block) as Record<string, unknown>
  );

  const frozen = examples.filter((e) => e.update_mode === "frozen");
  const dynamic = examples.filter((e) => e.update_mode === "dynamic");
  assertEquals(frozen.length >= 1, true, "no worked frozen example");
  assertEquals(dynamic.length >= 1, true, "no worked dynamic example");

  for (const example of examples) {
    for (const key of Object.keys(example)) {
      assert(
        KNOWN_CONFIG_KEYS.has(key),
        `example key "${key}" is not a recognised config key`,
      );
    }
  }

  for (const example of frozen) {
    const ref = example.pinned_ref;
    assertEquals(typeof ref, "string", "a frozen example has no pinned_ref");
    assertEquals(
      pinValueErrors("pinned_ref", ref as string),
      [],
      "the example pinned_ref is rejected by the validator",
    );
    const versions = (example.pinned_tool_versions ?? {}) as Record<
      string,
      string
    >;
    for (const tool of PINNED_TOOLS) {
      const version = versions[tool];
      assertEquals(
        typeof version,
        "string",
        `the frozen example does not pin ${tool}`,
      );
      assertEquals(
        pinValueErrors(`pinned_tool_versions.${tool}`, version as string),
        [],
        `the example ${tool} version is rejected by the validator`,
      );
    }
  }
});

Deno.test("CONFIGURATION.md - the setup default and the load-time default are stated and distinguished", async () => {
  const body = section(await read("docs/CONFIGURATION.md"), CONFIG_SECTION);

  // Issue #692: two different defaults, and the docs have to say why. A
  // single paragraph must carry both, so neither can be read alone.
  const distinction = body.split(/\n\s*\n/).find((paragraph) =>
    paragraph.includes(`\`${SETUP_DEFAULT_UPDATE_MODE}\``) &&
    paragraph.includes(`\`${DEFAULT_UPDATE_MODE}\``) &&
    /setup/i.test(paragraph) && /load/i.test(paragraph)
  );
  assert(
    distinction,
    "no paragraph states the setup default and the load-time default together",
  );
  assert(
    /absent|missing|no `update_mode`/i.test(distinction),
    "the distinction does not say what an absent update_mode resolves to",
  );

  // And the reference table has to agree with both.
  const row = body.split("\n").find((line) =>
    line.startsWith("| `update_mode`")
  );
  assert(row, "no update_mode row in the field table");
  assert(
    row.includes(`\`"${DEFAULT_UPDATE_MODE}"\``) &&
      row.includes(`\`"${SETUP_DEFAULT_UPDATE_MODE}"\``),
    "the update_mode row does not name both defaults",
  );
});

Deno.test("CONFIGURATION.md - hand-editing a pin is documented as needing no setup re-run", async () => {
  const body = section(await read("docs/CONFIGURATION.md"), CONFIG_SECTION);

  assert(
    /re-running setup is not required|without re-running setup/i.test(body),
    "the no-setup-re-run guarantee is not stated",
  );
  assert(
    body.includes("pinned_ref") && body.includes("pinned_tool_versions") &&
      /relaunch/i.test(body),
    "the hand-edit path (edit the field, relaunch) is not documented",
  );
});

Deno.test("CONFIGURATION.md - the pin is related to the release tags and to the skip env var", async () => {
  const body = section(await read("docs/CONFIGURATION.md"), CONFIG_SECTION);

  assert(
    body.includes("RELEASE-TAGGING.md"),
    "choosing a pin does not link the release tags",
  );
  assert(
    body.includes(SKIP_CHECKOUT_UPDATE_ENV),
    `${SKIP_CHECKOUT_UPDATE_ENV} is not distinguished from frozen mode`,
  );
});

Deno.test("DEPLOYMENT.md - keeping a host up to date cross-links both update-mode sections", async () => {
  const deployment = await read("docs/DEPLOYMENT.md");
  const setupAnchors = anchorSet(await read("docs/SETUP.md"));
  const configAnchors = anchorSet(await read("docs/CONFIGURATION.md"));

  const links = [
    ...deployment.matchAll(/\((SETUP|CONFIGURATION)\.md#([^)]+)\)/g),
  ].map((match) => ({ doc: match[1] ?? "", anchor: match[2] ?? "" }));

  const linksUpdateMode = (doc: string, anchors: Set<string>) =>
    links.some((link) =>
      link.doc === doc && link.anchor.includes("update-mode") &&
      anchors.has(link.anchor)
    );

  assert(
    linksUpdateMode("SETUP", setupAnchors),
    "DEPLOYMENT.md does not link the setup update-mode section by a real anchor",
  );
  assert(
    linksUpdateMode("CONFIGURATION", configAnchors),
    "DEPLOYMENT.md does not link the update-mode configuration reference by a real anchor",
  );
});

/*
 * The upgrade loop (Issue #693, part of #674) — the notice, the one command
 * that moves the pins, and the launch that installs them. Each assertion below
 * is tied to the code that produces the thing being documented: the command
 * name comes from `UPGRADE_COMMAND_NAME`/`UPGRADE_INVOCATION`, the notice
 * wording is rendered by `formatReleaseNotice`, the manifest asset name by
 * `RELEASE_MANIFEST_ASSET`, and every cross-link is resolved against the
 * target document's real headings. Renaming any of them in the code turns
 * these red rather than leaving the docs quietly wrong.
 */

const UPGRADE_LOOP_SECTION = "The upgrade loop";
const NOTICE_SECTION = "A new release of Vibe Coder is available";
const DEPLOYMENT_SECTION = "Keeping a host up to date";
const MANIFEST_SECTION = "The tool-version manifest";

/** The notice line exactly as the launcher prints it. */
const NOTICE_LINE = formatReleaseNotice("1.0.4", "1.0.5");

/** The anchor the upgrade-loop section is linked by. */
const UPGRADE_LOOP_ANCHOR = githubSlug(UPGRADE_LOOP_SECTION);

Deno.test("CONFIGURATION.md - the upgrade loop names the real command and quotes the real notice", async () => {
  const body = section(
    await read("docs/CONFIGURATION.md"),
    UPGRADE_LOOP_SECTION,
  );

  // The documented command is the one that is actually registered.
  assertEquals(upgradeCommand.name, UPGRADE_COMMAND_NAME);
  assert(
    body.includes(UPGRADE_INVOCATION),
    `the upgrade loop does not name "${UPGRADE_INVOCATION}"`,
  );
  assert(
    body.includes(NOTICE_LINE),
    "the upgrade loop does not quote the notice line the code emits",
  );
  assert(
    body.includes("```mermaid"),
    "the upgrade loop carries no Mermaid diagram of the loop",
  );
});

Deno.test("CONFIGURATION.md - the upgrade loop states what the command changes and what it does not", async () => {
  const body = section(
    await read("docs/CONFIGURATION.md"),
    UPGRADE_LOOP_SECTION,
  );

  assert(body.includes("pinned_ref"), "pinned_ref is not named as rewritten");
  assert(
    body.includes("pinned_tool_versions"),
    "pinned_tool_versions is not named as rewritten",
  );
  for (const tool of PINNED_TOOLS) {
    assert(
      body.includes(`\`${tool}\``),
      `the loop does not say ${tool} is installed at its pin`,
    );
  }
  assert(
    /changes nothing else|nothing else/i.test(body),
    "the loop does not say the upgrade leaves every other key alone",
  );
  assert(
    /installs nothing/i.test(body),
    "the loop does not say the upgrade command installs nothing itself",
  );
  // The hand-edit path survives the command (Issue #628 kept it first-class).
  assert(
    /hand-edit/i.test(body) && body.includes("#moving-a-pin-by-hand"),
    "the loop does not point at the hand-edited pin as the way to a specific ref",
  );
});

/**
 * The cross-links the upgrade loop is stitched together with: the document
 * that must carry the link, the document it points into, and the anchor.
 */
const UPGRADE_LOOP_LINKS: ReadonlyArray<
  { from: string; to: string; anchor: string }
> = [
  {
    from: "README.md",
    to: "docs/CONFIGURATION.md",
    anchor: "the-upgrade-loop",
  },
  {
    from: "docs/SETUP.md",
    to: "docs/CONFIGURATION.md",
    anchor: "the-upgrade-loop",
  },
  {
    from: "docs/DEPLOYMENT.md",
    to: "docs/CONFIGURATION.md",
    anchor: "the-upgrade-loop",
  },
  {
    from: "docs/RELEASE-TAGGING.md",
    to: "docs/CONFIGURATION.md",
    anchor: "the-upgrade-loop",
  },
  {
    from: "docs/RELEASE-TAGGING.md",
    to: "docs/SETUP.md",
    anchor: "update-mode-dynamic-or-frozen",
  },
  {
    from: "docs/CONFIGURATION.md",
    to: "docs/RELEASE-TAGGING.md",
    anchor: "the-tool-version-manifest",
  },
  {
    from: "docs/TROUBLESHOOTING.md",
    to: "docs/CONFIGURATION.md",
    anchor: "choosing-a-pin",
  },
  {
    from: "docs/TROUBLESHOOTING.md",
    to: "docs/CONFIGURATION.md",
    anchor: "moving-a-pin-by-hand",
  },
  {
    from: "docs/TROUBLESHOOTING.md",
    to: "docs/RELEASE-TAGGING.md",
    anchor: "the-tool-version-manifest",
  },
];

Deno.test("the upgrade-loop cross-links resolve to real headings", async () => {
  // The anchor the whole loop hangs off is the slug of its own heading, so a
  // renamed section fails here rather than scrolling readers to nothing.
  const configAnchors = anchorSet(await read("docs/CONFIGURATION.md"));
  assertEquals(UPGRADE_LOOP_ANCHOR, "the-upgrade-loop");
  assert(
    configAnchors.has(UPGRADE_LOOP_ANCHOR),
    `CONFIGURATION.md has no heading slugging to "${UPGRADE_LOOP_ANCHOR}"`,
  );

  for (const link of UPGRADE_LOOP_LINKS) {
    const source = await read(link.from);
    const targetFile = link.to.split("/").pop() ?? link.to;
    assert(
      source.includes(`${targetFile}#${link.anchor}`),
      `${link.from} does not link ${targetFile}#${link.anchor}`,
    );
    const anchors = anchorSet(await read(link.to));
    assert(
      anchors.has(link.anchor),
      `${link.from} links ${targetFile}#${link.anchor}, which is not a real heading`,
    );
  }
});

Deno.test("README.md - the quick reference carries the real upgrade invocation", async () => {
  const readme = await read("README.md");

  assert(
    readme.includes(UPGRADE_INVOCATION),
    `README.md does not name "${UPGRADE_INVOCATION}"`,
  );
  // In the Quick Start, beside the launch it follows — not buried further
  // down. `section()` cannot be used here: the quick-start code blocks carry
  // `# comment` lines it would read as headings.
  const lines = readme.split("\n");
  const start = lines.findIndex((line) => /^## .*Quick Start/.test(line));
  assert(start >= 0, "README.md has no Quick Start heading");
  const after = lines.slice(start + 1);
  const end = after.findIndex((line) => /^## /.test(line));
  const quickStart = (end === -1 ? after : after.slice(0, end)).join("\n");
  assert(
    quickStart.includes(UPGRADE_INVOCATION),
    "the upgrade command is not in the README quick reference",
  );
  assert(
    quickStart.includes(`CONFIGURATION.md#${UPGRADE_LOOP_ANCHOR}`),
    "the README entry does not link the upgrade loop",
  );
});

Deno.test("SETUP.md - a freshly pinned host is told how its pin moves afterwards", async () => {
  const body = section(await read("docs/SETUP.md"), SETUP_SECTION);

  assert(
    body.includes(UPGRADE_INVOCATION),
    "SETUP.md does not say which command moves the pin after setup",
  );
  assert(
    body.includes("pinned_ref") && body.includes("pinned_tool_versions"),
    "SETUP.md does not say what the upgrade command rewrites",
  );
});

Deno.test("DEPLOYMENT.md - keeping a host up to date offers three answers, not two", async () => {
  const body = section(await read("docs/DEPLOYMENT.md"), DEPLOYMENT_SECTION);

  for (const mode of UPDATE_MODES) {
    assert(
      new RegExp(`\\b${mode}\\b`, "i").test(body),
      `the "${mode}" answer is not described`,
    );
  }
  assert(
    body.includes(UPGRADE_INVOCATION),
    "the upgrade-command answer is not described",
  );
  assert(
    /hand-edited|hand-edit/i.test(body),
    "the hand-edited-pin answer is not described",
  );
});

Deno.test("RELEASE-TAGGING.md - the manifest section names the hosts that consume it", async () => {
  const body = section(await read("docs/RELEASE-TAGGING.md"), MANIFEST_SECTION);

  assert(
    body.includes(RELEASE_MANIFEST_ASSET),
    `the manifest section does not name ${RELEASE_MANIFEST_ASSET}`,
  );
  assert(
    body.includes(UPGRADE_INVOCATION),
    "the manifest section does not say the upgrade command reads it",
  );
  const setupAnchors = anchorSet(await read("docs/SETUP.md"));
  const setupLinks = [...body.matchAll(/SETUP\.md#([^)\s]+)/g)].map((match) =>
    match[1] ?? ""
  );
  assert(setupLinks.length > 0, "the manifest section does not link setup");
  for (const anchor of setupLinks) {
    assert(
      setupAnchors.has(anchor),
      `the manifest section links SETUP.md#${anchor}, which is not a real heading`,
    );
  }
});

Deno.test("TROUBLESHOOTING.md - the notice entry quotes the code's wording and both sinks", async () => {
  const body = section(await read("docs/TROUBLESHOOTING.md"), NOTICE_SECTION);

  assert(
    body.includes(NOTICE_LINE),
    "TROUBLESHOOTING.md does not quote the notice line the code emits",
  );
  assert(
    body.includes(UPGRADE_INVOCATION),
    `the entry does not name "${UPGRADE_INVOCATION}"`,
  );
  assert(
    /stderr/i.test(body) && body.includes("run_core.log"),
    "the entry does not say where the warning lines land",
  );
});

Deno.test("TROUBLESHOOTING.md - the silent cases of the notice are all documented", async () => {
  const body = section(await read("docs/TROUBLESHOOTING.md"), NOTICE_SECTION);

  // Exactly the outcomes release_notice.ts stays silent on, plus the failed
  // check the launcher degrades to a warning.
  assert(
    new RegExp(`\`?${DEFAULT_UPDATE_MODE}\`?`, "i").test(body),
    "a dynamic host is not named as a reason for silence",
  );
  assert(/commit SHA/i.test(body), "a SHA pin is not named as a reason");
  assert(
    /newest release/i.test(body),
    "a host already on the newest release is not named as a reason",
  );
  assert(
    /check failed|could not check/i.test(body),
    "a failed check is not named as a reason",
  );
});

Deno.test("TROUBLESHOOTING.md - the no-manifest refusal is documented against the real asset", async () => {
  const troubleshooting = await read("docs/TROUBLESHOOTING.md");

  const heading = troubleshooting.split("\n").find((line) =>
    /^#{2,6} /.test(line) && /no tool versions/.test(line)
  );
  assert(heading, "no entry for a release that records no tool versions");
  assert(
    heading.includes(UPGRADE_INVOCATION),
    `the entry heading does not name "${UPGRADE_INVOCATION}"`,
  );

  const body = section(troubleshooting, "no tool versions");
  assert(
    body.includes(`carries no ${RELEASE_MANIFEST_ASSET} asset`),
    "the entry does not quote the refusal the release check produces",
  );
  assert(
    /nothing was written|unchanged/i.test(body),
    "the entry does not say the config is left unchanged",
  );
});
