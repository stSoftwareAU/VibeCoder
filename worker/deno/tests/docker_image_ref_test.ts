/**
 * Tests for lib/docker_image_ref.ts — option-injection defence on the
 * `docker run` image positional (Issue #3661, SEC-76c9c3e5baf5).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals } from "@std/assert";
import {
  buildDockerRunArgs,
  isSafeDockerImageRef,
} from "../lib/docker_image_ref.ts";

Deno.test("isSafeDockerImageRef - accepts ordinary image references", () => {
  for (
    const image of [
      "ubuntu",
      "ubuntu:22.04",
      "library/node:20-alpine",
      "ghcr.io/stsoftwareau/build:latest",
      "registry.example.com:5000/team/img:v1.2.3",
      "alpine@sha256:" + "a".repeat(64),
    ]
  ) {
    assert(isSafeDockerImageRef(image), `${image} should be accepted`);
  }
});

Deno.test("isSafeDockerImageRef - rejects a flag disguised as an image", () => {
  for (const image of ["--privileged", "-v", "-v/:/host", "--network=host"]) {
    assertEquals(
      isSafeDockerImageRef(image),
      false,
      `${image} should be rejected`,
    );
  }
});

Deno.test("isSafeDockerImageRef - rejects whitespace, empty and metacharacters", () => {
  for (
    const image of ["", " ", "ubuntu --privileged", "ubuntu;rm -rf /", "a\nb"]
  ) {
    assertEquals(
      isSafeDockerImageRef(image),
      false,
      `${JSON.stringify(image)} should be rejected`,
    );
  }
});

Deno.test("buildDockerRunArgs - places -- immediately before the image", () => {
  const args = buildDockerRunArgs({
    image: "ubuntu:22.04",
    userId: "501",
    groupId: "20",
    repoPath: "/repo",
    command: "./quality.sh",
  });
  const dashIndex = args.indexOf("--");
  assert(dashIndex > 0, "expected an end-of-options separator");
  assertEquals(args[dashIndex + 1], "ubuntu:22.04");
});

Deno.test("buildDockerRunArgs - keeps the mount, user and command wiring", () => {
  const args = buildDockerRunArgs({
    image: "ubuntu",
    userId: "1000",
    groupId: "1000",
    repoPath: "/home/bot/repo",
    command: "make check",
  });
  assertEquals(args[0], "docker");
  assertEquals(args[1], "run");
  assertEquals(args[args.length - 3], "sh");
  assertEquals(args[args.length - 2], "-c");
  assertEquals(args[args.length - 1], "make check");
  assert(args.includes("/home/bot/repo:/workspace"));
  assert(args.includes("1000:1000"));
});
