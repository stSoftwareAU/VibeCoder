/**
 * Synthetic module for the echo-consumer scanner (Issue #4211).
 *
 * A multi-line import of a fence helper plus a `parse*` export must be
 * flagged. This file is not under `lib/`; the completeness test feeds it to
 * the scanner on its own.
 */
import { fenceUntrustedIssueText } from "./prompt_delimiter.ts";

export function parseFoo(reply: string): string {
  return fenceUntrustedIssueText(reply, "Untrusted data").join("\n");
}
