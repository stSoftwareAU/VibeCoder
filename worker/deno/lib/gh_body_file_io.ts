/**
 * Filesystem side of `gh` body redaction (Issue #1254).
 *
 * `gh_body_redaction.ts` stays a pure function of its inputs — it performs no
 * `Deno` calls — so every chokepoint that wants file bodies scanned has to
 * hand it a reader and a writer. There are two such chokepoints: the agent's
 * guard child (`gh_guard_cli.ts`) and the worker's spawn chokepoint
 * (`gh_spawn.ts`). They had drifted apart, with only the agent path supplying
 * a reader, so a worker `--body-file` body was published unscanned. This
 * module is the one implementation both now share.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { BodyFileReader, BodyFileWriter } from "./gh_body_redaction.ts";

/** Production body-file reader — throws when the path cannot be read. */
export const denoBodyFileReader: BodyFileReader = (path) =>
  Deno.readTextFileSync(path);

/**
 * Production writer for a masked `--input` body: a fresh temp file the
 * redacted JSON lands in, so the caller's own file is never rewritten.
 */
export const denoBodyFileWriter: BodyFileWriter = (content) => {
  const path = Deno.makeTempFileSync({ prefix: "gh-input-", suffix: ".json" });
  Deno.writeTextFileSync(path, content);
  return path;
};
