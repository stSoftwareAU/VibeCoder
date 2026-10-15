/**
 * Tests for the comment-stripped Containerfile (Issue #4393).
 *
 * Apple `container` rejects a Dockerfile over 16,384 bytes, so the launcher
 * builds from a stripped copy — comment lines and blank lines removed —
 * while the committed `container/Containerfile` keeps its comments. The
 * strip must be semantics-preserving: every instruction and every `\`
 * continuation survives, and parser directives at the top are kept.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  CONTAINERFILE_SIZE_CAP_BYTES,
  stripContainerfile,
} from "../lib/containerfile_strip.ts";
import {
  AGENT_PROVIDERS_BUILD_ARG,
  agentProviderIds,
} from "../lib/agent_provider.ts";

Deno.test("stripContainerfile - drops comment and blank lines, keeps instructions and continuations (Issue #4393)", () => {
  const input = [
    "# syntax=docker/dockerfile:1",
    "# escape=\\",
    "",
    "# Base image (pinned).",
    "FROM ruby:3.4@sha256:abc AS base",
    "",
    'ARG GH_VERSION="2.97.0"   # not a comment: trailing text is part of the ARG value',
    "RUN set -eu; \\",
    "    # a comment inside a continuation is a comment to the parser too",
    '    curl -fsSL -o /tmp/gh.tar.gz "https://example/${GH_VERSION}"; \\',
    "",
    "    tar -xzf /tmp/gh.tar.gz",
    "   ",
    "COPY entrypoint.sh /usr/local/bin/vibe-entrypoint",
    "USER vibe",
  ].join("\n") + "\n";
  const out = stripContainerfile(input);
  assertEquals(
    out,
    [
      "# syntax=docker/dockerfile:1",
      "# escape=\\",
      "FROM ruby:3.4@sha256:abc AS base",
      'ARG GH_VERSION="2.97.0"   # not a comment: trailing text is part of the ARG value',
      "RUN set -eu; \\",
      '    curl -fsSL -o /tmp/gh.tar.gz "https://example/${GH_VERSION}"; \\',
      "    tar -xzf /tmp/gh.tar.gz",
      "COPY entrypoint.sh /usr/local/bin/vibe-entrypoint",
      "USER vibe",
    ].join("\n") + "\n",
  );
});

Deno.test("stripContainerfile - parser directives are kept only at the very top (Issue #4393)", () => {
  const out = stripContainerfile("FROM x\n# syntax=late\nRUN y\n");
  assertEquals(out, "FROM x\nRUN y\n");
});

Deno.test("stripContainerfile - is idempotent and never grows the file (Issue #4393)", () => {
  const once = stripContainerfile("# c\n\nFROM x\n\n\nRUN y \\\n  z\n");
  assertEquals(stripContainerfile(once), once);
  assert(once.length < "# c\n\nFROM x\n\n\nRUN y \\\n  z\n".length);
});

Deno.test("Containerfile - the STRIPPED committed file stays under Apple container's cap; the readable one may grow (Issue #4393)", async () => {
  const path = new URL("../../../container/Containerfile", import.meta.url);
  const text = await Deno.readTextFile(path);
  const stripped = stripContainerfile(text);
  const size = new TextEncoder().encode(stripped).length;
  assert(
    size <= CONTAINERFILE_SIZE_CAP_BYTES,
    `stripped Containerfile is ${size} bytes; the cap is ${CONTAINERFILE_SIZE_CAP_BYTES} — trim instructions, comments no longer count`,
  );
  // Every instruction line of the original is present in the stripped copy.
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    assert(stripped.includes(line), `instruction dropped by strip: ${line}`);
  }
});

// Apple container 1.2.2 sends the Dockerfile JSON-escaped, together with the
// build arguments, in one request. Measured on GRQ-23 on 2026-10-15: the
// request with AGENT_PROVIDERS=claude,deepseek was accepted with the file at
// 15,822 escaped characters and dropped ("Stream unexpectedly closed") at
// 15,824 — the committed file then, 15,000 raw bytes.
const MEASURED_ESCAPED_REQUEST_LIMIT = 15_822 +
  `${AGENT_PROVIDERS_BUILD_ARG}=claude,deepseek`.length;

Deno.test("Containerfile - the stripped file plus every provider's build argument fits Apple container's request with headroom", async () => {
  const path = new URL("../../../container/Containerfile", import.meta.url);
  const stripped = stripContainerfile(await Deno.readTextFile(path));
  const widestBuildArg = `${AGENT_PROVIDERS_BUILD_ARG}=${
    agentProviderIds().join(",")
  }`;
  const request = JSON.stringify(stripped).length + widestBuildArg.length;
  const headroom = 250;
  assert(
    request + headroom <= MEASURED_ESCAPED_REQUEST_LIMIT,
    `stripped Containerfile escapes to ${
      JSON.stringify(stripped).length
    } characters; with ${widestBuildArg} the request is ${request}, within ${headroom} of the ${MEASURED_ESCAPED_REQUEST_LIMIT} Apple container drops — trim instructions`,
  );
});

Deno.test("CONTAINERFILE_SIZE_CAP_BYTES - a file at the cap still fits the measured request limit once escaped", () => {
  // The cap is the guard CI enforces, so a file exactly at it must build on a
  // multi-provider host. Escaping grows the committed file by about 5.5%.
  const escapedAtCap = Math.ceil(
    CONTAINERFILE_SIZE_CAP_BYTES * (15_824 / 15_000),
  );
  const widestBuildArg = `${AGENT_PROVIDERS_BUILD_ARG}=${
    agentProviderIds().join(",")
  }`;
  assert(
    escapedAtCap + widestBuildArg.length <= MEASURED_ESCAPED_REQUEST_LIMIT,
    `a ${CONTAINERFILE_SIZE_CAP_BYTES}-byte file escapes to about ${escapedAtCap}; with ${widestBuildArg} that exceeds ${MEASURED_ESCAPED_REQUEST_LIMIT}`,
  );
});

// ---------------------------------------------------------------------------
// The launch-plan command writes the stripped copy and builds from it
// ---------------------------------------------------------------------------

import { stripContainerfileCommand } from "../commands/strip_containerfile.ts";
import { buildDefaultWorkerConfig } from "../lib/config_defaults.ts";

Deno.test("strip-containerfile command - writes the stripped copy and reports the sizes (Issue #4393)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "strip_cf_" });
  try {
    await Deno.writeTextFile(
      `${dir}/Containerfile`,
      "# hello\n\nFROM x\n# c\nRUN y\n",
    );
    const result = await stripContainerfileCommand.execute(
      { in: `${dir}/Containerfile`, out: `${dir}/stripped` },
      buildDefaultWorkerConfig(),
    );
    assert(result.success, result.message);
    assertEquals(await Deno.readTextFile(`${dir}/stripped`), "FROM x\nRUN y\n");
    const data = result.data as {
      originalBytes: number;
      strippedBytes: number;
    };
    assert(data.strippedBytes < data.originalBytes);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("strip-containerfile command - refuses without --out and fails when the stripped file is over the cap (Issue #4393)", async () => {
  const noOut = await stripContainerfileCommand.execute(
    {},
    buildDefaultWorkerConfig(),
  );
  assertEquals(noOut.success, false);
  const dir = await Deno.makeTempDir({ prefix: "strip_cf_" });
  try {
    await Deno.writeTextFile(
      `${dir}/Containerfile`,
      `FROM x\n${"RUN echo " + "y".repeat(200) + "\n"}`.repeat(90),
    );
    const result = await stripContainerfileCommand.execute(
      { in: `${dir}/Containerfile`, out: `${dir}/stripped` },
      buildDefaultWorkerConfig(),
    );
    assertEquals(result.success, false);
    assert(result.message.includes("over the"), result.message);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
