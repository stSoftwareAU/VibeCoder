/**
 * Shared fixtures for the `gh_body_redaction.ts` suites (Issue #1283).
 *
 * The body-file suite and the published-text suite both need the same three
 * things: a known-shaped fake token, a reader backed by an in-memory file set,
 * and a writer that records what it materialises. They lived in one file until
 * the second suite arrived; they live here now so neither copy can drift.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type {
  BodyFileReader,
  BodyFileWriter,
} from "../../lib/gh_body_redaction.ts";

/**
 * A realistic GitHub token shape — the payload each published field carries.
 * Fake: a fixed repeating pattern, never a live credential.
 */
export const GH_TOKEN_SAMPLE = `ghp_${"a1B2c3D4e5".repeat(4)}`;

/**
 * A reader serving a fixed set of paths; anything else fails to read, which is
 * how the unreadable-path fail-closed path is exercised.
 */
export function readerFor(files: Record<string, string>): BodyFileReader {
  return (path: string) => {
    const content = files[path];
    if (content === undefined) throw new Error(`no such file: ${path}`);
    return content;
  };
}

/** A writer that records every content it materialises and hands back a path. */
export function capturingWriter(): {
  writer: BodyFileWriter;
  written: string[];
} {
  const written: string[] = [];
  const writer: BodyFileWriter = (content) => {
    written.push(content);
    return `/tmp/gh-input-${written.length}.json`;
  };
  return { writer, written };
}
