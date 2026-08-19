/**
 * Tests for image_path_resolver.ts — soft-gate image path rewriting
 * (Issue #2229).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";
import { resolveImagePaths } from "../lib/image_path_resolver.ts";

/** Build an injectable listFilesFn that returns a fixed file listing. */
function listing(files: string[]): (root: string) => Promise<string[]> {
  return (_root: string) => Promise.resolve(files);
}

Deno.test("resolveImagePaths - exact basename rewrite", async () => {
  const body = "![Foo](docs/evidence/foo.png)";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/screenshots/foo.png"]),
  });

  assertEquals(result.body, "![Foo](docs/screenshots/foo.png)");
  assertEquals(result.rewrites, [
    { from: "docs/evidence/foo.png", to: "docs/screenshots/foo.png" },
  ]);
  assertEquals(result.warnings, []);
});

Deno.test("resolveImagePaths - fuzzy rewrite strips issue-NNN- prefix", async () => {
  const body = "![Graph desktop](docs/evidence/issue-224-graph-desktop.png)";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/screenshots/graph-desktop.png"]),
  });

  assertEquals(
    result.body,
    "![Graph desktop](docs/screenshots/graph-desktop.png)",
  );
  assertEquals(result.rewrites, [
    {
      from: "docs/evidence/issue-224-graph-desktop.png",
      to: "docs/screenshots/graph-desktop.png",
    },
  ]);
  assertEquals(result.warnings, []);
});

Deno.test("resolveImagePaths - suffix match rewrite", async () => {
  const body = "![Desktop](docs/evidence/desktop.png)";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/screenshots/graph-desktop.png"]),
  });

  assertEquals(result.body, "![Desktop](docs/screenshots/graph-desktop.png)");
  assertEquals(result.rewrites, [
    {
      from: "docs/evidence/desktop.png",
      to: "docs/screenshots/graph-desktop.png",
    },
  ]);
  assertEquals(result.warnings, []);
});

Deno.test("resolveImagePaths - ambiguous match leaves body unchanged", async () => {
  const body = "![Foo](docs/evidence/foo.png)";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/a/foo.png", "docs/b/foo.png"]),
  });

  assertEquals(result.body, body);
  assertEquals(result.rewrites, []);
  assertEquals(result.warnings, [
    {
      path: "docs/evidence/foo.png",
      reason: "ambiguous",
      candidates: ["docs/a/foo.png", "docs/b/foo.png"],
    },
  ]);
});

Deno.test("resolveImagePaths - no candidate emits warning", async () => {
  const body = "![Foo](docs/evidence/missing.png)";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/screenshots/other.png"]),
  });

  assertEquals(result.body, body);
  assertEquals(result.rewrites, []);
  assertEquals(result.warnings, [
    {
      path: "docs/evidence/missing.png",
      reason: "no-candidate",
      candidates: [],
    },
  ]);
});

Deno.test("resolveImagePaths - external URLs are untouched", async () => {
  const body =
    "![Shot](https://github.com/org/repo/user-attachments/assets/abc.png)";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/screenshots/abc.png"]),
  });

  assertEquals(result.body, body);
  assertEquals(result.rewrites, []);
  assertEquals(result.warnings, []);
});

Deno.test("resolveImagePaths - protocol-relative and data URIs untouched", async () => {
  const body =
    "![A](//cdn.example.com/a.png) ![B](data:image/png;base64,iVBOR=)";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/a.png"]),
  });

  assertEquals(result.body, body);
  assertEquals(result.rewrites, []);
  assertEquals(result.warnings, []);
});

Deno.test("resolveImagePaths - absolute filesystem paths untouched", async () => {
  const body = "![Abs](/etc/secret/foo.png)";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/foo.png"]),
  });

  assertEquals(result.body, body);
  assertEquals(result.rewrites, []);
  assertEquals(result.warnings, []);
});

Deno.test("resolveImagePaths - already correct relative path untouched", async () => {
  const body = "![Foo](docs/screenshots/foo.png)";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/screenshots/foo.png"]),
  });

  assertEquals(result.body, body);
  assertEquals(result.rewrites, []);
  assertEquals(result.warnings, []);
});

Deno.test("resolveImagePaths - non-image markdown links ignored", async () => {
  const body = "See [the docs](docs/foo.md) for details.";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/screenshots/foo.png"]),
  });

  assertEquals(result.body, body);
  assertEquals(result.rewrites, []);
  assertEquals(result.warnings, []);
});

Deno.test("resolveImagePaths - default listFilesFn walks repo and rewrites", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/docs/screenshots`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/docs/screenshots/foo.png`, "x");
    // Ignored directory should not be walked.
    await Deno.mkdir(`${tmp}/node_modules/docs`, { recursive: true });
    await Deno.writeTextFile(`${tmp}/node_modules/docs/foo.png`, "x");

    const body = "![Foo](docs/evidence/foo.png)";
    const result = await resolveImagePaths(body, tmp);

    assertEquals(result.body, "![Foo](docs/screenshots/foo.png)");
    assertEquals(result.rewrites, [
      { from: "docs/evidence/foo.png", to: "docs/screenshots/foo.png" },
    ]);
    assertEquals(result.warnings, []);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("resolveImagePaths - missing repo path does not throw", async () => {
  const body = "![Foo](docs/evidence/foo.png)";
  const result = await resolveImagePaths(body, "/no/such/path/xyz");

  assertEquals(result.body, body);
  assertEquals(result.rewrites, []);
  assertEquals(result.warnings, [
    { path: "docs/evidence/foo.png", reason: "no-candidate", candidates: [] },
  ]);
});

Deno.test("resolveImagePaths - duplicate references rewritten together", async () => {
  const body =
    "![A](docs/evidence/foo.png) and again ![B](docs/evidence/foo.png)";
  const result = await resolveImagePaths(body, "/repo", {
    listFilesFn: listing(["docs/screenshots/foo.png"]),
  });

  assertEquals(
    result.body,
    "![A](docs/screenshots/foo.png) and again ![B](docs/screenshots/foo.png)",
  );
  assertEquals(result.rewrites, [
    { from: "docs/evidence/foo.png", to: "docs/screenshots/foo.png" },
  ]);
  assertEquals(result.warnings, []);
});
