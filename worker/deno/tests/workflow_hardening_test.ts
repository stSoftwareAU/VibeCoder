/**
 * Regression guards for the GitHub Actions hardening batch (Issues #4395,
 * #4403, #4404): the workflow YAML must keep the properties the gap
 * analysis (#4377) found missing, and the toolchain versions the workflows
 * install must come from the repository's single source of truth.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";

const REPO_ROOT = new URL("../../../", import.meta.url);

async function workflowFiles(): Promise<Array<{ name: string; text: string }>> {
  const dir = new URL(".github/workflows/", REPO_ROOT);
  const out: Array<{ name: string; text: string }> = [];
  for await (const entry of Deno.readDir(dir)) {
    if (!entry.isFile || !/\.ya?ml$/.test(entry.name)) continue;
    out.push({
      name: entry.name,
      text: await Deno.readTextFile(new URL(entry.name, dir)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

Deno.test("workflows - every actions/checkout step sets persist-credentials: false (Issue #4395, GHA-SECRETS-009)", async () => {
  let checkouts = 0;
  for (const { name, text } of await workflowFiles()) {
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (!/^\s*-?\s*uses: actions\/checkout@/.test(line)) return;
      checkouts++;
      // The step's `with:` block follows within a few lines; look ahead
      // until the next step (`- `) at the same indent.
      const indent = line.search(/\S/);
      const window: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j] ?? "";
        if (l.trim() === "") continue;
        const ind = l.search(/\S/);
        if (ind <= indent && l.trim().startsWith("- ")) break;
        if (ind < indent) break;
        window.push(l.trim());
      }
      assert(
        window.some((w) => /^persist-credentials:\s*false$/.test(w)),
        `${name}:${i + 1} checkout without persist-credentials: false`,
      );
    });
  }
  assert(checkouts >= 12, `expected the 12 checkout steps, saw ${checkouts}`);
});

Deno.test("workflows - toolchains are installed from the version files, never a floating range (Issue #4403, GHA-SUPPLY-019)", async () => {
  for (const { name, text } of await workflowFiles()) {
    assert(
      !/deno-version:\s*v?\d+\.x/.test(text),
      `${name}: floating deno-version`,
    );
    assert(
      !/node-version:\s*["']?lts/.test(text),
      `${name}: floating node-version`,
    );
    if (/setup-deno@/.test(text)) {
      assert(
        /deno-version-file:\s*\.deno-version/.test(text),
        `${name}: setup-deno must read .deno-version`,
      );
    }
    if (/setup-node@/.test(text)) {
      assert(
        /node-version-file:\s*\.node-version/.test(text),
        `${name}: setup-node must read .node-version`,
      );
    }
  }
});

Deno.test(".deno-version / .node-version - agree with the container image's pins (Issue #4403)", async () => {
  const denoVersion =
    (await Deno.readTextFile(new URL(".deno-version", REPO_ROOT))).trim();
  const nodeVersion =
    (await Deno.readTextFile(new URL(".node-version", REPO_ROOT))).trim();
  const containerfile = await Deno.readTextFile(
    new URL("container/Containerfile", REPO_ROOT),
  );
  const denoImage = containerfile.match(
    /^ARG DENO_IMAGE="denoland\/deno:bin-([0-9.]+)@/m,
  )?.[1];
  const nodeArg = containerfile.match(/^ARG NODE_VERSION="([0-9.]+)"/m)?.[1];
  assertEquals(
    denoVersion,
    denoImage,
    ".deno-version must match the image's Deno",
  );
  assertEquals(
    nodeVersion,
    nodeArg,
    ".node-version must match the image's Node",
  );
  assert(
    /^\d+\.\d+\.\d+$/.test(denoVersion) && /^\d+\.\d+\.\d+$/.test(nodeVersion),
  );
});

Deno.test("workflows - container images carry a tag beside the digest, artefacts a retention window, caches an exact key (Issues #4403, #4404)", async () => {
  for (const { name, text } of await workflowFiles()) {
    for (const m of text.matchAll(/^\s*image:\s*(\S+)/gm)) {
      const ref = m[1] ?? "";
      if (!ref.includes("@sha256:")) continue;
      assert(
        /:[^@/]+@sha256:/.test(ref),
        `${name}: bare digest without a tag: ${ref}`,
      );
    }
    for (
      const m of text.matchAll(
        /uses: actions\/upload-(?:pages-)?artifact@[^\n]*\n((?:[ \t]+[^\n]*\n)+)/g,
      )
    ) {
      assert(
        /retention-days:\s*\d+/.test(m[1] ?? ""),
        `${name}: artefact upload without retention-days`,
      );
    }
    assert(
      !/restore-keys:/.test(text),
      `${name}: prefix restore-keys let a poisoned cache be selected`,
    );
  }
});
