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
import { SKIP_CHECKOUT_UPDATE_ENV } from "../commands/worker_checkout_update.ts";
import {
  DEFAULT_UPDATE_MODE,
  PINNED_TOOLS,
  UPDATE_MODES,
} from "../lib/config_defaults.ts";
import { pinValueErrors } from "../lib/config_validator.ts";
import { KNOWN_CONFIG_KEYS } from "../lib/config_unknown_keys.ts";
import { anchorSet } from "../lib/markdown_anchors.ts";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(repoPath(relative));
}

/**
 * The body of the section introduced by the first heading matching `title`,
 * up to the next heading at the same or a higher level.
 */
function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const startIndex = lines.findIndex((line) =>
    /^#{2,6} /.test(line) && line.includes(title)
  );
  assert(startIndex >= 0, `no heading containing "${title}"`);
  const level = (lines[startIndex]?.match(/^#+/)?.[0] ?? "##").length;
  const rest = lines.slice(startIndex + 1);
  const endOffset = rest.findIndex((line) => {
    const hashes = line.match(/^(#{1,6}) /)?.[1];
    return hashes !== undefined && hashes.length <= level;
  });
  const body = endOffset === -1 ? rest : rest.slice(0, endOffset);
  return body.join("\n");
}

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

Deno.test("SETUP.md - the update-mode section states both accepted modes and the default", async () => {
  const body = section(await read("docs/SETUP.md"), SETUP_SECTION);

  for (const mode of UPDATE_MODES) {
    assert(body.includes(`\`${mode}\``), `mode "${mode}" is not documented`);
  }
  assert(
    body.includes(`defaults to \`${DEFAULT_UPDATE_MODE}\``),
    "the default mode is not stated",
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
