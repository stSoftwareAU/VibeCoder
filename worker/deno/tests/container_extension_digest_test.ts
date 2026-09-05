/**
 * Tests for container_extension_digest.ts — the content digest of a
 * deployment's private extension directory (Issue #979, parent #933).
 *
 * Every case builds a throwaway extension directory, calls the real digest,
 * and asserts on what it returns, so the ways a content-derived identity
 * silently breaks are all covered: the digest going unstable, stopping
 * responding to a content change, collapsing two different trees onto one
 * value, or hashing a partial view instead of failing.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  computeContainerExtensionDigest,
  EXTENSION_READ_CHUNK_BYTES,
} from "../lib/container_extension_digest.ts";
import type { ContainerExtensionSpec } from "../types.ts";

/** Write a file inside the extension, creating its parent directories. */
async function write(
  root: string,
  relative: string,
  contents: string | Uint8Array,
): Promise<void> {
  const path = `${root}/${relative}`;
  const parent = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(parent, { recursive: true });
  if (typeof contents === "string") {
    await Deno.writeTextFile(path, contents);
  } else {
    await Deno.writeFile(path, contents);
  }
}

/** A throwaway extension directory carrying a small, realistic tree. */
async function extensionDir(): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "vibe-extension-" });
  await write(root, "Containerfile", "FROM vibe-coder:base\n");
  await write(root, "start.sh", "#!/bin/sh\nservice postgres start\n");
  await write(root, "seed/schema.sql", "CREATE TABLE jobs (id int);\n");
  await write(root, "jenkins/Jenkinsfile", "pipeline { agent any }\n");
  return root;
}

/** The declaration for a directory, with the parser's own defaults. */
function spec(
  path: string,
  overrides: Partial<ContainerExtensionSpec> = {},
): ContainerExtensionSpec {
  return { path, containerfile: "Containerfile", ...overrides };
}

const encoder = new TextEncoder();
const NUL = String.fromCharCode(0);

/**
 * The digest of a framed byte stream assembled and hashed in **one shot**.
 *
 * The expectation the streaming digest is measured against: each entry framed
 * `<label><NUL><mode><NUL><byte length><NUL><bytes>\n`, in the order given.
 */
async function oneShotDigest(
  entries: [label: string, mode: string, bytes: Uint8Array][],
): Promise<string> {
  const parts: Uint8Array[] = [];
  for (const [label, mode, bytes] of entries) {
    parts.push(
      encoder.encode(`${label}${NUL}${mode}${NUL}${bytes.length}${NUL}`),
    );
    parts.push(bytes);
    parts.push(encoder.encode("\n"));
  }
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    buffer.set(part, offset);
    offset += part.length;
  }
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", buffer)),
  ).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The message a call threw, or `""` when it did not throw. */
async function messageFrom(call: () => Promise<unknown>): Promise<string> {
  try {
    await call();
    return "";
  } catch (error) {
    return (error as Error).message;
  }
}

// ---------------------------------------------------------------------------
// Stability and determinism
// ---------------------------------------------------------------------------

Deno.test("computeContainerExtensionDigest - is stable across repeated calls", async () => {
  const root = await extensionDir();
  try {
    const first = await computeContainerExtensionDigest(spec(root));
    const second = await computeContainerExtensionDigest(spec(root));

    assertEquals(first, second);
    assert(/^[0-9a-f]{64}$/.test(first), `not a sha256 digest: ${first}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - two directories with equal contents agree", async () => {
  // The tag is content-derived: two hosts that sync the same extension to
  // different directories must share the image, so the path is not hashed.
  const left = await extensionDir();
  const right = await extensionDir();
  try {
    assertEquals(
      await computeContainerExtensionDigest(spec(left)),
      await computeContainerExtensionDigest(spec(right)),
    );
  } finally {
    await Deno.remove(left, { recursive: true });
    await Deno.remove(right, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - a trailing separator on the path is the same directory", async () => {
  const root = await extensionDir();
  try {
    assertEquals(
      await computeContainerExtensionDigest(spec(`${root}/`)),
      await computeContainerExtensionDigest(spec(root)),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Responds to every change in the directory
// ---------------------------------------------------------------------------

Deno.test("computeContainerExtensionDigest - editing any file, dumps included, moves the digest", async () => {
  const root = await extensionDir();
  try {
    const baseline = await computeContainerExtensionDigest(spec(root));
    const seen = new Set<string>([baseline]);

    for (
      const relative of [
        "Containerfile",
        "start.sh",
        "seed/schema.sql",
        "jenkins/Jenkinsfile",
      ]
    ) {
      const original = await Deno.readTextFile(`${root}/${relative}`);
      await Deno.writeTextFile(`${root}/${relative}`, `${original}-- edited\n`);

      const changed = await computeContainerExtensionDigest(spec(root));
      assert(changed !== baseline, `editing ${relative} left the digest`);
      assert(!seen.has(changed), `editing ${relative} collided`);
      seen.add(changed);

      await Deno.writeTextFile(`${root}/${relative}`, original);
      assertEquals(await computeContainerExtensionDigest(spec(root)), baseline);
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - rewriting a file with the same bytes keeps the digest", async () => {
  const root = await extensionDir();
  try {
    const baseline = await computeContainerExtensionDigest(spec(root));
    const contents = await Deno.readTextFile(`${root}/seed/schema.sql`);
    await Deno.writeTextFile(`${root}/seed/schema.sql`, contents);

    assertEquals(await computeContainerExtensionDigest(spec(root)), baseline);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - adding, deleting and renaming each move the digest", async () => {
  const root = await extensionDir();
  try {
    const baseline = await computeContainerExtensionDigest(spec(root));

    await write(root, "seed/data.sql", "INSERT INTO jobs VALUES (1);\n");
    const added = await computeContainerExtensionDigest(spec(root));
    assert(added !== baseline, "adding a file left the digest unchanged");

    await Deno.rename(`${root}/seed/data.sql`, `${root}/seed/rows.sql`);
    const renamed = await computeContainerExtensionDigest(spec(root));
    assert(renamed !== added, "renaming a file left the digest unchanged");

    await Deno.remove(`${root}/seed/rows.sql`);
    assertEquals(
      await computeContainerExtensionDigest(spec(root)),
      baseline,
      "deleting the added file did not return to the baseline digest",
    );

    await Deno.remove(`${root}/jenkins/Jenkinsfile`);
    assert(
      await computeContainerExtensionDigest(spec(root)) !== baseline,
      "deleting a file left the digest unchanged",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - moving bytes between two files moves the digest", async () => {
  const root = await extensionDir();
  try {
    const baseline = await computeContainerExtensionDigest(spec(root));
    const left = await Deno.readTextFile(`${root}/seed/schema.sql`);
    const right = await Deno.readTextFile(`${root}/jenkins/Jenkinsfile`);

    await Deno.writeTextFile(`${root}/seed/schema.sql`, `${left}${right}`);
    await Deno.writeTextFile(`${root}/jenkins/Jenkinsfile`, "");

    assert(
      await computeContainerExtensionDigest(spec(root)) !== baseline,
      "the digest ignores which file each byte came from",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - the executable bit is part of the digest", async () => {
  if (Deno.build.os === "windows") return; // No POSIX modes to set.
  const root = await extensionDir();
  try {
    await Deno.chmod(`${root}/start.sh`, 0o644);
    const plain = await computeContainerExtensionDigest(spec(root));

    await Deno.chmod(`${root}/start.sh`, 0o755);
    const executable = await computeContainerExtensionDigest(spec(root));

    assert(
      plain !== executable,
      "making start.sh executable did not change the digest",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - the declared containerfile and start move the digest", async () => {
  const root = await extensionDir();
  try {
    await write(root, "Containerfile.dev", "FROM vibe-coder:base\n");
    const standard = await computeContainerExtensionDigest(spec(root));
    const development = await computeContainerExtensionDigest(
      spec(root, { containerfile: "Containerfile.dev" }),
    );
    const started = await computeContainerExtensionDigest(
      spec(root, { start: "start.sh" }),
    );

    assertEquals(new Set([standard, development, started]).size, 3);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Streaming: bounded memory, single-shot value
// ---------------------------------------------------------------------------

Deno.test("computeContainerExtensionDigest - a file larger than the read buffer hashes as one shot would", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-extension-large-" });
  try {
    // Deliberately not a multiple of the buffer, so the last read is partial.
    const size = EXTENSION_READ_CHUNK_BYTES * 3 + 517;
    const dump = new Uint8Array(size);
    for (let index = 0; index < size; index++) dump[index] = index % 251;
    const containerfile = "FROM vibe-coder:base\n";
    await write(root, "Containerfile", containerfile);
    await write(root, "dump.sql", dump);

    assertEquals(
      await computeContainerExtensionDigest(spec(root)),
      await oneShotDigest([
        ["containerfile", "spec", encoder.encode("Containerfile")],
        ["Containerfile", "644", encoder.encode(containerfile)],
        ["dump.sql", "644", dump],
      ]),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - entries sort by UTF-8 bytes, not UTF-16 units", async () => {
  // U+FF5E encodes as EF BD 9E and U+1F600 as F0 9F 98 80, so UTF-8 puts the
  // tilde first — while a naive `<` compares UTF-16 units and puts the
  // surrogate pair (D83D) first. The two orders frame different byte streams.
  const root = await Deno.makeTempDir({ prefix: "vibe-extension-unicode-" });
  try {
    const containerfile = "FROM vibe-coder:base\n";
    const tilde = "-- wide tilde\n";
    const emoji = "-- emoji\n";
    await write(root, "Containerfile", containerfile);
    await write(root, "～.sql", tilde);
    await write(root, "\u{1F600}.sql", emoji);

    assertEquals(
      await computeContainerExtensionDigest(spec(root)),
      await oneShotDigest([
        ["containerfile", "spec", encoder.encode("Containerfile")],
        ["Containerfile", "644", encoder.encode(containerfile)],
        ["～.sql", "644", encoder.encode(tilde)],
        ["\u{1F600}.sql", "644", encoder.encode(emoji)],
      ]),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - an empty directory and a zero-byte file are hashed, not skipped", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-extension-empty-" });
  try {
    const empty = await computeContainerExtensionDigest(spec(root));
    assertEquals(
      empty,
      await oneShotDigest([
        ["containerfile", "spec", encoder.encode("Containerfile")],
      ]),
    );

    // A zero-byte file is content the build copies in, so it moves the digest
    // even though it contributes no bytes of its own.
    await write(root, "seed/.keep", "");
    assert(
      await computeContainerExtensionDigest(spec(root)) !== empty,
      "a zero-byte file was skipped rather than hashed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Fail loud rather than hash a partial view
// ---------------------------------------------------------------------------

Deno.test("computeContainerExtensionDigest - an absent directory throws, naming the path", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-extension-absent-" });
  const missing = `${root}/never-synced`;
  try {
    const message = await messageFrom(() =>
      computeContainerExtensionDigest(spec(missing))
    );

    assert(message !== "", "an absent extension directory did not throw");
    assertStringIncludes(message, missing);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - a path that is a file throws, naming it", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-extension-file-" });
  try {
    const path = `${root}/Containerfile`;
    await Deno.writeTextFile(path, "FROM vibe-coder:base\n");

    const message = await messageFrom(() =>
      computeContainerExtensionDigest(spec(path))
    );

    assertStringIncludes(message, path);
    assertStringIncludes(message, "not a directory");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - an unreadable file throws, naming the entry", async () => {
  if (Deno.build.os === "windows") return; // Mode bits are the mechanism here.
  const root = await extensionDir();
  try {
    await Deno.chmod(`${root}/seed/schema.sql`, 0o000);
    // A process running as root reads a 0o000 file regardless, so there is no
    // unreadable file to assert on — the case is skipped rather than faked.
    const stillReadable = await messageFrom(() =>
      Deno.readTextFile(`${root}/seed/schema.sql`)
    ) === "";
    if (stillReadable) return;

    const message = await messageFrom(() =>
      computeContainerExtensionDigest(spec(root))
    );

    assert(message !== "", "an unreadable extension file did not throw");
    assertStringIncludes(message, "seed/schema.sql");
  } finally {
    await Deno.chmod(`${root}/seed/schema.sql`, 0o644);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - a symlink escaping the directory throws", async () => {
  if (Deno.build.os === "windows") return; // Symlinks need elevation there.
  const outside = await Deno.makeTempDir({ prefix: "vibe-extension-outside-" });
  const root = await extensionDir();
  try {
    await Deno.writeTextFile(`${outside}/secret.env`, "TOKEN=shh\n");
    await Deno.symlink(`${outside}/secret.env`, `${root}/secret.env`);

    const message = await messageFrom(() =>
      computeContainerExtensionDigest(spec(root))
    );

    assert(message !== "", "an escaping symlink did not throw");
    assertStringIncludes(message, "secret.env");
    assertStringIncludes(message, "escapes");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(outside, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - a symlink inside the directory is hashed", async () => {
  if (Deno.build.os === "windows") return; // Symlinks need elevation there.
  const root = await extensionDir();
  try {
    const baseline = await computeContainerExtensionDigest(spec(root));
    await Deno.symlink(`${root}/seed/schema.sql`, `${root}/schema-link.sql`);

    assert(
      await computeContainerExtensionDigest(spec(root)) !== baseline,
      "a confined symlink was skipped rather than hashed",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - a confined directory symlink is an alias, not a loop", async () => {
  if (Deno.build.os === "windows") return; // Symlinks need elevation there.
  const root = await extensionDir();
  try {
    // `latest -> v3` beside its target is an ordinary extension layout: the
    // build copies those bytes under both names, so the digest sees both.
    const baseline = await computeContainerExtensionDigest(spec(root));
    await Deno.symlink(`${root}/seed`, `${root}/latest`);

    const aliased = await computeContainerExtensionDigest(spec(root));
    assert(aliased !== baseline, "a directory alias left the digest unchanged");
    assertEquals(
      aliased,
      await oneShotDigest([
        ["containerfile", "spec", encoder.encode("Containerfile")],
        [
          "Containerfile",
          "644",
          encoder.encode("FROM vibe-coder:base\n"),
        ],
        [
          "jenkins/Jenkinsfile",
          "644",
          encoder.encode("pipeline { agent any }\n"),
        ],
        [
          "latest/schema.sql",
          "644",
          encoder.encode("CREATE TABLE jobs (id int);\n"),
        ],
        [
          "seed/schema.sql",
          "644",
          encoder.encode("CREATE TABLE jobs (id int);\n"),
        ],
        [
          "start.sh",
          "644",
          encoder.encode("#!/bin/sh\nservice postgres start\n"),
        ],
      ]),
      "the alias was not hashed under both paths, in byte-wise order",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("computeContainerExtensionDigest - a symlink loop throws rather than walking forever", async () => {
  if (Deno.build.os === "windows") return; // Symlinks need elevation there.
  const root = await extensionDir();
  try {
    await Deno.symlink(`${root}/seed`, `${root}/seed/self`);

    const message = await messageFrom(() =>
      computeContainerExtensionDigest(spec(root))
    );

    assert(message !== "", "a symlink loop did not throw");
    assertStringIncludes(message, "seed/self");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
