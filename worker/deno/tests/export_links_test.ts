/**
 * Self-contained links in the staged export (Issues #4197, #4198).
 *
 * The private tree links freely between documents; the export withholds
 * the operator ones. A published page must not point at a withheld page,
 * so relative links whose target exists in the SOURCE tree but not in the
 * STAGED tree are unlinked (label kept, link dropped) and reported. A link
 * whose target exists in neither tree is a private-tree defect (or a prompt
 * placeholder such as `docs/evidence/filename.png`) — reported, left alone.
 *
 * Uses Australian English throughout (behaviour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  relinkTree,
  renderLinkReport,
  unlinkWithheld,
} from "../lib/export_links.ts";

Deno.test("unlinkWithheld - a link to a withheld target becomes its label; a live link and an external link are untouched; images keep their alt text", () => {
  const exists = (rel: string) => rel === "docs/LIVE.md";
  const withheldInSource = (rel: string) =>
    rel === "docs/OPERATOR.md" || rel === "docs/evidence/shot.png";
  const input = [
    "See [the manual](OPERATOR.md#setup) and [live](LIVE.md).",
    "External [gh](https://github.com/x/y) stays.",
    "![screenshot](evidence/shot.png) and [gone](../nowhere.md).",
  ].join("\n");
  const out = unlinkWithheld(input, "docs/README.md", {
    existsInTree: exists,
    existsInSource: (rel) => exists(rel) || withheldInSource(rel),
  });
  assertEquals(
    out.text.split("\n"),
    [
      "See the manual and [live](LIVE.md).",
      "External [gh](https://github.com/x/y) stays.",
      "screenshot and [gone](../nowhere.md).",
    ],
  );
  assertEquals(out.unlinked.map((u) => u.target), [
    "docs/OPERATOR.md",
    "docs/evidence/shot.png",
  ]);
  assertEquals(out.brokenInSource.map((b) => b.target), ["nowhere.md"]);
});

Deno.test("relinkTree - rewrites markdown files in place and reports per file (Issues #4197, #4198)", async () => {
  const source = await Deno.makeTempDir({ prefix: "export_links_src_" });
  const tree = await Deno.makeTempDir({ prefix: "export_links_tree_" });
  try {
    for (const dir of [`${source}/docs`, `${tree}/docs`]) {
      await Deno.mkdir(dir, { recursive: true });
    }
    await Deno.writeTextFile(`${source}/docs/OPERATOR.md`, "# op\n");
    await Deno.writeTextFile(`${source}/docs/PUBLIC.md`, "# pub\n");
    const readme =
      "[op](docs/OPERATOR.md) [pub](docs/PUBLIC.md) [x](docs/MISSING.md)\n";
    await Deno.writeTextFile(`${source}/README.md`, readme);
    await Deno.writeTextFile(`${tree}/docs/PUBLIC.md`, "# pub\n");
    await Deno.writeTextFile(`${tree}/README.md`, readme);
    await Deno.writeTextFile(
      `${tree}/notes.txt`,
      "[not md](docs/OPERATOR.md)\n",
    );

    const report = await relinkTree(tree, { sourceDir: source });
    assertEquals(
      await Deno.readTextFile(`${tree}/README.md`),
      "op [pub](docs/PUBLIC.md) [x](docs/MISSING.md)\n",
    );
    // Only Markdown is rewritten.
    assertEquals(
      await Deno.readTextFile(`${tree}/notes.txt`),
      "[not md](docs/OPERATOR.md)\n",
    );
    assertEquals(report.filesRewritten, 1);
    assertEquals(report.unlinked.length, 1);
    assertEquals(report.brokenInSource.length, 1);
    const text = renderLinkReport(report);
    assertStringIncludes(text, "unlinked: 1");
    assertStringIncludes(text, "README.md:1  docs/OPERATOR.md");
    assertStringIncludes(text, "broken-in-source: 1");
    assert(text.includes("docs/MISSING.md"));
  } finally {
    await Deno.remove(source, { recursive: true });
    await Deno.remove(tree, { recursive: true });
  }
});
