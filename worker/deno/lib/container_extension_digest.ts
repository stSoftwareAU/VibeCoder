/**
 * Content digest of a deployment's private extension directory (Issue #979,
 * parent #933).
 *
 * The extension is an operator-owned directory on the host — a `Containerfile`
 * built `FROM` the standard image, optionally a start script, and whatever the
 * build needs beside them (SQL dumps, Jenkinsfiles, config). Nothing in it is
 * committed to this repository, so `CONTAINER_IMAGE_INPUTS` cannot enumerate
 * it; this module reduces the whole directory to one digest that
 * `container_image_hash.ts` mixes into the image tag instead.
 *
 * ## What the digest covers, and why
 *
 * **Every file**, dumps and Jenkinsfiles among them. Changing a dump changes
 * the image the extension builds, so it must change the tag — the alternative
 * (an ignore list) is a cached image quietly satisfying a definition it was
 * not built from. The declaration's own `containerfile` and `start`
 * selections are covered too: pointing the same directory at
 * `Containerfile.dev` is a different image, and a digest of the bytes alone
 * would not see it.
 *
 * The extension **path** is deliberately *not* covered. The tag is
 * content-derived: two hosts that sync the same extension to different
 * directories build the same image, and should share it.
 *
 * ## Determinism
 *
 * Entries are collected recursively, spelled with `/` regardless of the host's
 * own separator, and sorted **byte-wise** on their UTF-8 encoding — never in
 * the order the filesystem happened to return them. Each entry is framed as
 * `<relative path>\0<mode>\0<byte length>\0<bytes>` under the same
 * `FIELD_SEPARATOR` convention the enumerated inputs use, so moving content
 * between two files changes the digest rather than cancelling out, and making
 * `start.sh` executable is a different image.
 *
 * ## Memory
 *
 * File bytes are fed into the digest in {@link EXTENSION_READ_CHUNK_BYTES}
 * chunks rather than concatenated, so a multi-gigabyte dump costs one buffer
 * rather than the worker's whole heap. The result is identical to a single-shot
 * SHA-256 of the same byte stream, which `container_extension_digest_test.ts`
 * pins.
 *
 * ## Fail loud
 *
 * An absent directory, a `path` that is not a directory, an unreadable file, a
 * symlink resolving outside the directory, a symlink cycle, a device or socket,
 * or a file whose length changes mid-read all throw naming the offending entry
 * — the same posture `readInput` takes for the enumerated inputs. Hashing a
 * partial view would produce a tag that names an image nobody built.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { crypto as streamingCrypto } from "@std/crypto";
import type { ContainerExtensionSpec } from "../types.ts";
import { isAtOrAbove, normalisePath, pathStyleFor } from "./host_path_style.ts";

/** Bytes read from a file per digest update. */
export const EXTENSION_READ_CHUNK_BYTES = 64 * 1024;

/**
 * Separator between an entry's fields.
 *
 * The same NUL `container_image_hash.ts` frames the enumerated inputs with: it
 * cannot occur in a path, so no file's content can forge another entry's
 * framing.
 */
const FIELD_SEPARATOR = "\0";

/**
 * Mode field for the declaration's own fields, distinguishing them from a file
 * entry — whose mode field is only ever `644` or `755`, so an extension file
 * literally named `containerfile` cannot forge one.
 */
const SPEC_MODE = "spec";

const encoder = new TextEncoder();

/** One regular file inside the extension directory. */
interface ExtensionFile {
  /** Path relative to the extension directory, always `/`-separated. */
  relative: string;
  /** Absolute host path the bytes are read from. */
  path: string;
  /** Byte length as stat reported it, re-checked while reading. */
  size: number;
  /** Whether any execute bit is set; `false` where the host has no modes. */
  executable: boolean;
}

/** Strip trailing separators so a directory joins cleanly. */
function trimDirectory(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

/** Compare two paths by their UTF-8 bytes, not by UTF-16 code unit. */
function compareUtf8(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const shared = Math.min(a.length, b.length);
  for (let index = 0; index < shared; index++) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** Whether a stat mode carries any execute bit. */
function isExecutable(mode: number | null): boolean {
  return mode !== null && (mode & 0o111) !== 0;
}

/** Stat one entry, following symlinks, failing loud with the entry named. */
async function statEntry(
  path: string,
  relative: string,
): Promise<Deno.FileInfo> {
  try {
    return await Deno.stat(path);
  } catch (error) {
    throw new Error(
      `Container extension entry unreadable: ${relative} (${path}): ` +
        `${(error as Error).message}`,
    );
  }
}

/**
 * The real path of an entry, failing loud with the entry named.
 *
 * @param path - The host path to resolve
 * @param relative - The entry's path relative to the extension directory
 * @returns The resolved real path
 * @throws When the path cannot be resolved
 */
async function realPathOf(path: string, relative: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    throw new Error(
      `Container extension entry cannot be resolved: ${relative} (${path}): ` +
        `${(error as Error).message}`,
    );
  }
}

/**
 * The extension directory's real path, refusing anything that is not a
 * directory.
 *
 * @param path - The declared extension directory
 * @returns Its resolved real path
 * @throws When the directory is absent, unreadable, or not a directory
 */
async function resolveExtensionRoot(path: string): Promise<string> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(
        `Container extension directory missing: ${path}. The operator syncs ` +
          `their own extension into it — hashing an absent directory would ` +
          `name an image nobody built.`,
      );
    }
    throw new Error(
      `Container extension directory unreadable: ${path} ` +
        `(${(error as Error).message}).`,
    );
  }
  if (!info.isDirectory) {
    throw new Error(
      `Container extension path is not a directory: ${path}.`,
    );
  }
  return await realPathOf(path, ".");
}

/**
 * Walk one directory, appending its regular files to `files`.
 *
 * `ancestors` holds the real paths of the directories on the **current** chain,
 * not every directory seen: a link back up the chain is an endless walk and is
 * refused, while `latest -> v3` beside its target is an ordinary alias whose
 * contents the build would copy twice, so it is hashed twice under its two
 * paths rather than misdiagnosed as a cycle.
 */
async function walkExtension(
  directory: string,
  prefix: string,
  realRoot: string,
  ancestors: Set<string>,
  files: ExtensionFile[],
): Promise<void> {
  const style = pathStyleFor(realRoot);
  let entries: Deno.DirEntry[];
  try {
    entries = [];
    for await (const entry of Deno.readDir(directory)) entries.push(entry);
  } catch (error) {
    throw new Error(
      `Container extension directory unreadable: ${directory} ` +
        `(${(error as Error).message}).`,
    );
  }

  for (const entry of entries) {
    const path = `${directory}/${entry.name}`;
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;

    // A symlink is followed only while it stays inside the extension: an
    // escaping link would fold host content the operator never synced into
    // the image's identity, and a dangling one would hash a partial view.
    if (entry.isSymlink) {
      const target = await realPathOf(path, relative);
      const inside = isAtOrAbove(
        normalisePath(realRoot, style),
        normalisePath(target, style),
        style,
      );
      if (!inside) {
        throw new Error(
          `Container extension symlink escapes the extension directory: ` +
            `${relative} resolves to ${target}, outside ${realRoot}.`,
        );
      }
    }

    const info = await statEntry(path, relative);
    if (info.isDirectory) {
      const real = await realPathOf(path, relative);
      if (ancestors.has(real)) {
        throw new Error(
          `Container extension directory loops: ${relative} resolves to ` +
            `${real}, a directory it is already inside — a cycle has no ` +
            `deterministic digest.`,
        );
      }
      await walkExtension(
        path,
        relative,
        realRoot,
        new Set([...ancestors, real]),
        files,
      );
      continue;
    }
    if (!info.isFile) {
      throw new Error(
        `Container extension entry is neither a file nor a directory: ` +
          `${relative} (${path}) — its contents cannot be hashed.`,
      );
    }
    files.push({
      relative,
      path,
      size: info.size,
      executable: isExecutable(info.mode),
    });
  }
}

/**
 * Every regular file under the extension directory, sorted byte-wise.
 *
 * @param root - The declared extension directory
 * @returns The files, in the order they are hashed
 * @throws When any entry cannot be read, escapes the directory, or loops
 */
async function collectExtensionFiles(root: string): Promise<ExtensionFile[]> {
  const directory = trimDirectory(root);
  const realRoot = await resolveExtensionRoot(directory);
  const files: ExtensionFile[] = [];
  await walkExtension(directory, "", realRoot, new Set([realRoot]), files);
  files.sort((left, right) => compareUtf8(left.relative, right.relative));
  return files;
}

/** Yield one file's bytes in bounded chunks, failing loud on a short read. */
async function* fileChunks(
  file: ExtensionFile,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  let handle: Deno.FsFile;
  try {
    handle = await Deno.open(file.path, { read: true });
  } catch (error) {
    throw new Error(
      `Container extension file unreadable: ${file.relative} (${file.path}): ` +
        `${(error as Error).message}`,
    );
  }

  let read = 0;
  try {
    const buffer = new Uint8Array(EXTENSION_READ_CHUNK_BYTES);
    while (true) {
      let count: number | null;
      try {
        count = await handle.read(buffer);
      } catch (error) {
        throw new Error(
          `Container extension file unreadable: ${file.relative} ` +
            `(${file.path}): ${(error as Error).message}`,
        );
      }
      if (count === null) break;
      read += count;
      // A copy, not a view: the consumer is free to hold the chunk, and one
      // memcpy per 64 KiB is nothing beside the hashing itself.
      yield buffer.slice(0, count);
    }
  } finally {
    handle.close();
  }

  // The length was framed into the digest before the bytes were read, so a
  // file rewritten mid-walk must fail rather than silently produce a digest
  // whose framing does not match its contents.
  if (read !== file.size) {
    throw new Error(
      `Container extension file changed while being hashed: ${file.relative} ` +
        `(${file.path}) — ${file.size} bytes expected, ${read} read.`,
    );
  }
}

/** The framed byte stream the digest is taken over. */
async function* extensionByteStream(
  spec: ContainerExtensionSpec,
  files: ExtensionFile[],
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const declared: [string, string][] = [
    ["containerfile", spec.containerfile],
    ...(spec.start === undefined
      ? []
      : [["start", spec.start] as [string, string]]),
  ];
  for (const [label, value] of declared) {
    const bytes = encoder.encode(value);
    yield encoder.encode(
      `${label}${FIELD_SEPARATOR}${SPEC_MODE}${FIELD_SEPARATOR}` +
        `${bytes.length}${FIELD_SEPARATOR}`,
    );
    yield bytes;
    yield encoder.encode("\n");
  }

  for (const file of files) {
    yield encoder.encode(
      `${file.relative}${FIELD_SEPARATOR}${file.executable ? "755" : "644"}` +
        `${FIELD_SEPARATOR}${file.size}${FIELD_SEPARATOR}`,
    );
    yield* fileChunks(file);
    yield encoder.encode("\n");
  }
}

/**
 * The digest of a validated extension declaration and its directory.
 *
 * @param spec - The validated declaration (Issue #978)
 * @returns Lowercase hex SHA-256 of the framed directory contents
 * @throws When the directory is absent or unreadable, an entry cannot be
 *   hashed, a symlink escapes the directory, or a file changes mid-read
 */
export async function computeContainerExtensionDigest(
  spec: ContainerExtensionSpec,
): Promise<string> {
  const digest = await streamingCrypto.subtle.digest(
    "SHA-256",
    extensionByteStream(spec, await collectExtensionFiles(spec.path)),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
