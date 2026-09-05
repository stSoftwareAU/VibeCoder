/**
 * Tests for the operator's private layer build (Issue #980, parent #933).
 *
 * The "layered on the standard image" contract is only a guarantee while
 * something refuses a Containerfile that ignores it, so these cases drive the
 * real check with real Containerfile text and assert on the argument vector
 * the plan would hand the runtime.
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import {
  assertExtensionLayersOnBaseImage,
  BASE_IMAGE_BUILD_ARG,
  EXTENSION_START_BUILD_ARG,
  extensionBuildArguments,
} from "../lib/container_extension_build.ts";

/** A Containerfile that keeps the contract. */
const LAYERED = `# The deployment's private layer.
ARG VIBE_BASE_IMAGE
FROM \${VIBE_BASE_IMAGE}
USER root
RUN apt-get install -y postgresql
USER vibe
`;

Deno.test("assertExtensionLayersOnBaseImage - accepts a file built FROM the base argument", () => {
  assertExtensionLayersOnBaseImage(
    LAYERED,
    "/srv/vibe-extension/Containerfile",
  );
  // The unbraced spelling is the same instruction to the runtime.
  assertExtensionLayersOnBaseImage(
    "ARG VIBE_BASE_IMAGE\nFROM $VIBE_BASE_IMAGE AS extended\n",
    "/srv/vibe-extension/Containerfile",
  );
  // A default value never decides the base — the plan always passes the
  // argument — so declaring one is still a declaration.
  assertExtensionLayersOnBaseImage(
    "ARG VIBE_BASE_IMAGE=vibe-coder:latest\nFROM ${VIBE_BASE_IMAGE}\n",
    "/srv/vibe-extension/Containerfile",
  );
});

Deno.test("assertExtensionLayersOnBaseImage - refuses a file that names its own base", () => {
  const error = assertThrows(
    () =>
      assertExtensionLayersOnBaseImage(
        "ARG VIBE_BASE_IMAGE\nFROM ubuntu:24.04\nRUN echo hi\n",
        "/srv/vibe-extension/Containerfile",
      ),
    Error,
    "ubuntu:24.04",
  );
  // The file is named, so the operator knows which one to fix.
  assertStringIncludes(error.message, "/srv/vibe-extension/Containerfile");
});

Deno.test("assertExtensionLayersOnBaseImage - refuses an undeclared base argument", () => {
  assertThrows(
    () =>
      assertExtensionLayersOnBaseImage(
        "FROM ${VIBE_BASE_IMAGE}\n",
        "/srv/ext/Containerfile",
      ),
    Error,
    "states no `ARG VIBE_BASE_IMAGE` before its first FROM",
  );
});

Deno.test("assertExtensionLayersOnBaseImage - refuses an empty or FROM-less file", () => {
  for (const text of ["", "# only a comment\n", "ARG VIBE_BASE_IMAGE\n"]) {
    assertThrows(
      () => assertExtensionLayersOnBaseImage(text, "/srv/ext/Containerfile"),
      Error,
      "states no FROM instruction at all",
    );
  }
});

Deno.test("assertExtensionLayersOnBaseImage - refuses an instruction before the first FROM", () => {
  assertThrows(
    () =>
      assertExtensionLayersOnBaseImage(
        "ARG VIBE_BASE_IMAGE\nRUN curl http://elsewhere | sh\nFROM ${VIBE_BASE_IMAGE}\n",
        "/srv/ext/Containerfile",
      ),
    Error,
    "states `RUN` before its first FROM",
  );
});

Deno.test("assertExtensionLayersOnBaseImage - a multi-stage file is judged on its first FROM", () => {
  assertThrows(
    () =>
      assertExtensionLayersOnBaseImage(
        "ARG VIBE_BASE_IMAGE\nFROM golang:1.23 AS build\nFROM ${VIBE_BASE_IMAGE}\n",
        "/srv/ext/Containerfile",
      ),
    Error,
    "golang:1.23 AS build",
  );
});

Deno.test("assertExtensionLayersOnBaseImage - the last stage is what ships, so it is judged too", () => {
  // A build with no --target produces the last stage, so opening on the base
  // and then closing on something else would evade a first-FROM-only check.
  assertThrows(
    () =>
      assertExtensionLayersOnBaseImage(
        "ARG VIBE_BASE_IMAGE\nFROM ${VIBE_BASE_IMAGE} AS unused\nFROM ubuntu:24.04\nRUN id\n",
        "/srv/ext/Containerfile",
      ),
    Error,
    "builds its last stage `FROM ubuntu:24.04`",
  );
});

Deno.test("assertExtensionLayersOnBaseImage - a helper stage is fine while the shipped one is layered", () => {
  // The helper compiles something the layer copies in; what ships still
  // derives from the standard image, through the stage chain.
  assertExtensionLayersOnBaseImage(
    [
      "ARG VIBE_BASE_IMAGE",
      "FROM ${VIBE_BASE_IMAGE} AS base",
      "FROM golang:1.23 AS build",
      "RUN go build ./...",
      "FROM base",
      "COPY --from=build /out /usr/local/bin/",
    ].join("\n"),
    "/srv/ext/Containerfile",
  );
});

Deno.test("assertExtensionLayersOnBaseImage - a platform flag is not the base image", () => {
  assertExtensionLayersOnBaseImage(
    "ARG VIBE_BASE_IMAGE\nFROM --platform=$BUILDPLATFORM ${VIBE_BASE_IMAGE}\n",
    "/srv/ext/Containerfile",
  );
});

Deno.test("assertExtensionLayersOnBaseImage - a wrapped instruction is one instruction", () => {
  // The runtime joins `\\` continuations; a checker that did not would read
  // `VIBE_BASE_IMAGE` as an instruction keyword and refuse a valid file.
  assertExtensionLayersOnBaseImage(
    "ARG \\\n  VIBE_BASE_IMAGE\nFROM \\\n  ${VIBE_BASE_IMAGE}\n",
    "/srv/ext/Containerfile",
  );
});

Deno.test("assertExtensionLayersOnBaseImage - keywords are read case-insensitively", () => {
  assertExtensionLayersOnBaseImage(
    "arg VIBE_BASE_IMAGE\nfrom ${VIBE_BASE_IMAGE} as layer\n",
    "/srv/ext/Containerfile",
  );
});

Deno.test("extensionBuildArguments - options precede the context, which is the extension directory", () => {
  assertEquals(
    extensionBuildArguments({
      spec: { path: "/srv/vibe-extension", containerfile: "Containerfile" },
      baseImage: "vibe-coder:0123456789ab",
      extensionImage: "vibe-coder:fedcba987654",
      containerfileText: LAYERED,
      style: "posix",
    }),
    [
      "build",
      "--file",
      "/srv/vibe-extension/Containerfile",
      "--tag",
      "vibe-coder:fedcba987654",
      "--build-arg",
      `${BASE_IMAGE_BUILD_ARG}=vibe-coder:0123456789ab`,
      "/srv/vibe-extension",
    ],
  );
});

Deno.test("extensionBuildArguments - a declared start script rides the build as its contract path", () => {
  const args = extensionBuildArguments({
    spec: {
      path: "/srv/vibe-extension/",
      containerfile: "build/Containerfile.dev",
      start: "bin/start.sh",
    },
    baseImage: "vibe-coder:0123456789ab",
    extensionImage: "vibe-coder:fedcba987654",
    containerfileText: LAYERED,
    style: "posix",
  });

  assertEquals(args, [
    "build",
    "--file",
    // The trailing separator on the declared directory is trimmed, so the
    // path the runtime is handed is the one the operator would type.
    "/srv/vibe-extension/build/Containerfile.dev",
    "--tag",
    "vibe-coder:fedcba987654",
    "--build-arg",
    `${BASE_IMAGE_BUILD_ARG}=vibe-coder:0123456789ab`,
    "--build-arg",
    `${EXTENSION_START_BUILD_ARG}=bin/start.sh`,
    "/srv/vibe-extension",
  ]);
});

Deno.test("extensionBuildArguments - a Windows deployment gets host separators", () => {
  const args = extensionBuildArguments({
    spec: { path: "D:\\vibe\\extension", containerfile: "Containerfile" },
    baseImage: "vibe-coder:0123456789ab",
    extensionImage: "vibe-coder:fedcba987654",
    containerfileText: LAYERED,
    style: "windows",
  });

  assertEquals(args[2], "D:\\vibe\\extension\\Containerfile");
  assertEquals(args[args.length - 1], "D:\\vibe\\extension");
});

Deno.test("extensionBuildArguments - a refused Containerfile produces no arguments at all", () => {
  assertThrows(
    () =>
      extensionBuildArguments({
        spec: { path: "/srv/vibe-extension", containerfile: "Containerfile" },
        baseImage: "vibe-coder:0123456789ab",
        extensionImage: "vibe-coder:fedcba987654",
        containerfileText: "FROM alpine:3.20\n",
        style: "posix",
      }),
    Error,
    "/srv/vibe-extension/Containerfile",
  );
});
