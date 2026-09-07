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
 * Production writer for a masked `--input` body (Issue #92): a fresh file the
 * redacted JSON lands in, so the caller's own file is never rewritten.
 *
 * The file is created **inside a directory the caller names** (Issue #1364).
 * It used to be a bare `Deno.makeTempFileSync()`, which put it in TMPDIR with
 * nothing owning it: at the agent's guard the copy must outlive the process —
 * the `gh` child reads it after the guard has exited — so the guard cannot
 * delete it, and no one else knew it existed. Writing into a directory the
 * caller owns gives every masked copy an owner on both chokepoints.
 *
 * There is deliberately no unowned variant to reach for. `spawnGh` shares this
 * writer (Issue #1254), and an unowned temp file there would have leaked a
 * `gh-input-*.json` per masked body for the life of the host.
 *
 * @param dir - Directory the masked copy is created in; the caller owns its
 *   lifetime.
 * @returns A writer that returns the path of the file it wrote.
 */
export function bodyFileWriterIn(dir: string): BodyFileWriter {
  return (content) => {
    const path = Deno.makeTempFileSync({
      dir,
      prefix: "gh-input-",
      suffix: ".json",
    });
    Deno.writeTextFileSync(path, content);
    return path;
  };
}
