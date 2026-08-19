/**
 * Generate the benign GhostCommit canary image fixtures (Issue #3390).
 *
 * Run once to (re)produce the committed `.png` fixtures next to this file:
 *
 *   deno run --allow-read --allow-write \
 *     worker/deno/tests/fixtures/ghostcommit/generate_fixtures.ts
 *
 * Each fixture renders its instruction payload as overlaid text and embeds the
 * exact payload as a `tEXt` chunk (keyword {@link PAYLOAD_KEYWORD}) so the
 * committed bytes are verifiable by `ghostcommit_image_injection_test.ts`
 * without decoding pixels. Only synthetic tokens are used — no real secrets.
 *
 * Australian English used throughout (behaviour, colour, organisation, etc.).
 */

import { encodePng, renderText } from "./png.ts";
import {
  CANARY_SPECS,
  type CanarySpec,
  PAYLOAD_KEYWORD,
  renderOptionsFor,
} from "./canaries.ts";

/** Build the PNG bytes for a single canary spec. */
export async function buildCanaryPng(spec: CanarySpec): Promise<Uint8Array> {
  const rendered = renderText(spec.payload, renderOptionsFor(spec));
  return await encodePng({
    width: rendered.width,
    height: rendered.height,
    pixels: rendered.pixels,
    text: [{ keyword: PAYLOAD_KEYWORD, text: spec.payload }],
  });
}

async function main(): Promise<void> {
  const dir = new URL(".", import.meta.url);
  for (const spec of CANARY_SPECS) {
    const bytes = await buildCanaryPng(spec);
    const target = new URL(spec.file, dir);
    await Deno.writeFile(target, bytes);
    console.log(
      `wrote ${spec.file} (${bytes.length} bytes) — ${spec.description}`,
    );
  }
}

if (import.meta.main) {
  await main();
}
