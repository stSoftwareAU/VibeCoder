/**
 * Canonical worker run id (Issue #2381).
 *
 * Every GitHub mutation the worker performs — commits, PR bodies,
 * issue/PR comments, issue creates — must be traceable back to the
 * specific worker run that produced it. This module is the single
 * source of truth for that run id and the formatting helpers that stamp
 * it onto each mutation:
 *
 *   - {@link getRunId} resolves a stable run id for the current worker
 *     invocation, generating one once and caching it in the
 *     `VIBE_RUN_ID` environment variable so every child `deno` command
 *     spawned by the same worker process inherits the same id.
 *   - {@link appendRunIdTrailer} / {@link assertRunIdTrailer} /
 *     {@link hasRunIdTrailer} handle the `Vibe-Coder-Run-Id` git commit
 *     trailer (the join key between the GitHub timeline and the worker
 *     logs).
 *   - {@link buildRunIdFooterLine} produces the compact footer line for
 *     comments and PR bodies.
 *   - {@link buildRunIdMetadataBlock} produces the machine-readable
 *     metadata block embedded in worker-filed issue bodies.
 *
 * Implements the "identity delegation" actionable improvements from
 * `docs/AGENT-ACCOUNTABILITY.md` (Theme 2).
 *
 * Australian English spelling throughout (behaviour, organisation,
 * authorised).
 */ import { processEnvLookup } from "./env_lookup.ts";
/** Environment variable holding the canonical run id for this invocation. */ export const RUN_ID_ENV_VAR = "VIBE_RUN_ID";
/** Git trailer key that stamps a commit with its originating run id. */ export const RUN_ID_TRAILER_KEY = "Vibe-Coder-Run-Id";
/** Prefix every generated run id carries, so the id is greppable. */ export const RUN_ID_PREFIX = "vibe";
/**
 * Generate a fresh run id.
 *
 * Format: `vibe-<base36 epoch ms>-<6 hex random>` (e.g.
 * `vibe-lkz3p9x-1a2b3c`). Compact, URL-safe, greppable by the `vibe-`
 * prefix, and unique per invocation without needing any system
 * permission.
 */ export function generateRunId(opts = {}) {
  const now = opts.now ?? Date.now();
  const random = opts.random ?? Math.random;
  const ts = Math.max(0, Math.floor(now)).toString(36);
  const suffix = Math.floor(random() * 0x1000000).toString(16).padStart(6, "0").slice(0, 6);
  return `${RUN_ID_PREFIX}-${ts}-${suffix}`;
}
/**
 * Read the run id already established for this invocation, without
 * establishing one (Issue #963).
 *
 * This is the read half of {@link getRunId}, split out so a caller — and a
 * test — can ask "what is the run id?" without the module writing anything
 * into the process. Blank and whitespace-only values read as absent, which
 * is what makes them regenerable rather than a run id of `"   "`.
 *
 * @param env - Environment lookup. Defaults to the real process environment,
 *   so production callers pass nothing and behave exactly as before.
 * @returns The trimmed run id, or `undefined` when none is set.
 */ export function readRunId(env = processEnvLookup) {
  let raw;
  try {
    raw = env(RUN_ID_ENV_VAR);
  } catch  {
    // A denied `--allow-env` is "no run id set", not a crash.
    return undefined;
  }
  const trimmed = raw?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}
/**
 * The real process environment as a {@link RunIdStore}.
 *
 * The default for {@link getRunId}, so production is unchanged: the id is
 * read from and cached into `VIBE_RUN_ID`. Both halves tolerate a denied
 * `--allow-env` — the caller still gets an id back, it just will not
 * propagate to child processes on this run.
 */ export const processRunIdStore = {
  get: (name)=>{
    try {
      return processEnvLookup(name);
    } catch  {
      return undefined;
    }
  },
  set: (name, value)=>{
    try {
      Deno.env.set(name, value);
    } catch  {
    // Permission denied — see above.
    }
  }
};
/**
 * Resolve the canonical run id for the current worker invocation.
 *
 * If `VIBE_RUN_ID` is already set (by the shell entry point or a parent
 * worker process), that value is returned verbatim so every mutation
 * path on the same invocation shares one id. Otherwise a fresh id is
 * generated, cached into `VIBE_RUN_ID` (so subsequent calls and child
 * processes reuse it), and returned.
 *
 * @param store - Where the id is read from and cached to. Defaults to
 *   {@link processRunIdStore}, the real process environment (Issue #963).
 */ export function getRunId(store = processRunIdStore) {
  const existing = readRunId((name)=>store.get(name));
  if (existing !== undefined) return existing;
  const id = generateRunId();
  store.set(RUN_ID_ENV_VAR, id);
  return id;
}
/** Matches a `Vibe-Coder-Run-Id: <value>` trailer line anywhere in a message. */ const TRAILER_RE = new RegExp(`^${RUN_ID_TRAILER_KEY}:[ \\t]*(\\S.*)$`, "mi");
/** Whether `message` already carries a non-empty run-id trailer. */ export function hasRunIdTrailer(message) {
  return TRAILER_RE.test(message);
}
/** Matches a generic git trailer line (`Some-Key: value`). */ const GENERIC_TRAILER_LINE_RE = /^[A-Za-z][A-Za-z0-9-]*:[ \t]+\S/;
/**
 * Append the run-id trailer to a commit message.
 *
 * Idempotent — if the message already carries a `Vibe-Coder-Run-Id`
 * trailer it is returned unchanged. When the message already ends with a
 * git trailer block (e.g. a `Co-Authored-By:` line), the run-id trailer
 * is appended on the next line so it joins the same block; otherwise it
 * is appended as a new trailer block separated by a blank line.
 */ export function appendRunIdTrailer(message, runId) {
  if (hasRunIdTrailer(message)) return message;
  const trimmed = message.replace(/\s+$/, "");
  const trailerLine = `${RUN_ID_TRAILER_KEY}: ${runId}`;
  const lines = trimmed.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";
  if (GENERIC_TRAILER_LINE_RE.test(lastLine)) {
    // Existing trailer block — keep the run id in the same block.
    return `${trimmed}\n${trailerLine}`;
  }
  return `${trimmed}\n\n${trailerLine}`;
}
/**
 * Assert that a commit message carries the run-id trailer.
 *
 * This is the validator behind the pre-commit run-id gate: a commit
 * message lacking the trailer is rejected with an actionable error.
 */ export function assertRunIdTrailer(message) {
  if (hasRunIdTrailer(message)) {
    return {
      ok: true,
      value: undefined
    };
  }
  return {
    ok: false,
    error: new Error(`Commit message is missing the required ${RUN_ID_TRAILER_KEY} trailer ` + `(Issue #2381). Append a line of the form "${RUN_ID_TRAILER_KEY}: <run-id>" ` + "so the commit is traceable back to its originating worker run.")
  };
}
/**
 * Build the compact run-id footer line for comments and PR bodies.
 *
 * Produces a single greppable line, e.g. ``Run id: `vibe-...` ``.
 */ export function buildRunIdFooterLine(runId) {
  return `🏷️ Run id: \`${runId}\``;
}
/**
 * Build a machine-readable run-id metadata block for issue bodies.
 *
 * Worker-filed issues (security-scan, best-practices, test-audit,
 * github-actions-audit, and idle-task wrappers) embed this block so a
 * reviewer can join the issue back to the run that filed it. The block
 * is a fenced `key: value` snippet that scripts can parse without
 * guessing.
 */ export function buildRunIdMetadataBlock(runId) {
  return [
    "```",
    `run-id: ${runId}`,
    "```"
  ].join("\n");
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9ydW5faWQudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDYW5vbmljYWwgd29ya2VyIHJ1biBpZCAoSXNzdWUgIzIzODEpLlxuICpcbiAqIEV2ZXJ5IEdpdEh1YiBtdXRhdGlvbiB0aGUgd29ya2VyIHBlcmZvcm1zIOKAlCBjb21taXRzLCBQUiBib2RpZXMsXG4gKiBpc3N1ZS9QUiBjb21tZW50cywgaXNzdWUgY3JlYXRlcyDigJQgbXVzdCBiZSB0cmFjZWFibGUgYmFjayB0byB0aGVcbiAqIHNwZWNpZmljIHdvcmtlciBydW4gdGhhdCBwcm9kdWNlZCBpdC4gVGhpcyBtb2R1bGUgaXMgdGhlIHNpbmdsZVxuICogc291cmNlIG9mIHRydXRoIGZvciB0aGF0IHJ1biBpZCBhbmQgdGhlIGZvcm1hdHRpbmcgaGVscGVycyB0aGF0IHN0YW1wXG4gKiBpdCBvbnRvIGVhY2ggbXV0YXRpb246XG4gKlxuICogICAtIHtAbGluayBnZXRSdW5JZH0gcmVzb2x2ZXMgYSBzdGFibGUgcnVuIGlkIGZvciB0aGUgY3VycmVudCB3b3JrZXJcbiAqICAgICBpbnZvY2F0aW9uLCBnZW5lcmF0aW5nIG9uZSBvbmNlIGFuZCBjYWNoaW5nIGl0IGluIHRoZVxuICogICAgIGBWSUJFX1JVTl9JRGAgZW52aXJvbm1lbnQgdmFyaWFibGUgc28gZXZlcnkgY2hpbGQgYGRlbm9gIGNvbW1hbmRcbiAqICAgICBzcGF3bmVkIGJ5IHRoZSBzYW1lIHdvcmtlciBwcm9jZXNzIGluaGVyaXRzIHRoZSBzYW1lIGlkLlxuICogICAtIHtAbGluayBhcHBlbmRSdW5JZFRyYWlsZXJ9IC8ge0BsaW5rIGFzc2VydFJ1bklkVHJhaWxlcn0gL1xuICogICAgIHtAbGluayBoYXNSdW5JZFRyYWlsZXJ9IGhhbmRsZSB0aGUgYFZpYmUtQ29kZXItUnVuLUlkYCBnaXQgY29tbWl0XG4gKiAgICAgdHJhaWxlciAodGhlIGpvaW4ga2V5IGJldHdlZW4gdGhlIEdpdEh1YiB0aW1lbGluZSBhbmQgdGhlIHdvcmtlclxuICogICAgIGxvZ3MpLlxuICogICAtIHtAbGluayBidWlsZFJ1bklkRm9vdGVyTGluZX0gcHJvZHVjZXMgdGhlIGNvbXBhY3QgZm9vdGVyIGxpbmUgZm9yXG4gKiAgICAgY29tbWVudHMgYW5kIFBSIGJvZGllcy5cbiAqICAgLSB7QGxpbmsgYnVpbGRSdW5JZE1ldGFkYXRhQmxvY2t9IHByb2R1Y2VzIHRoZSBtYWNoaW5lLXJlYWRhYmxlXG4gKiAgICAgbWV0YWRhdGEgYmxvY2sgZW1iZWRkZWQgaW4gd29ya2VyLWZpbGVkIGlzc3VlIGJvZGllcy5cbiAqXG4gKiBJbXBsZW1lbnRzIHRoZSBcImlkZW50aXR5IGRlbGVnYXRpb25cIiBhY3Rpb25hYmxlIGltcHJvdmVtZW50cyBmcm9tXG4gKiBgZG9jcy9BR0VOVC1BQ0NPVU5UQUJJTElUWS5tZGAgKFRoZW1lIDIpLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB0aHJvdWdob3V0IChiZWhhdmlvdXIsIG9yZ2FuaXNhdGlvbixcbiAqIGF1dGhvcmlzZWQpLlxuICovXG5cbmltcG9ydCB0eXBlIHsgUmVzdWx0IH0gZnJvbSBcIi4uL3R5cGVzLnRzXCI7XG5pbXBvcnQgeyB0eXBlIEVudkxvb2t1cCwgcHJvY2Vzc0Vudkxvb2t1cCB9IGZyb20gXCIuL2Vudl9sb29rdXAudHNcIjtcblxuLyoqIEVudmlyb25tZW50IHZhcmlhYmxlIGhvbGRpbmcgdGhlIGNhbm9uaWNhbCBydW4gaWQgZm9yIHRoaXMgaW52b2NhdGlvbi4gKi9cbmV4cG9ydCBjb25zdCBSVU5fSURfRU5WX1ZBUiA9IFwiVklCRV9SVU5fSURcIjtcblxuLyoqIEdpdCB0cmFpbGVyIGtleSB0aGF0IHN0YW1wcyBhIGNvbW1pdCB3aXRoIGl0cyBvcmlnaW5hdGluZyBydW4gaWQuICovXG5leHBvcnQgY29uc3QgUlVOX0lEX1RSQUlMRVJfS0VZID0gXCJWaWJlLUNvZGVyLVJ1bi1JZFwiO1xuXG4vKiogUHJlZml4IGV2ZXJ5IGdlbmVyYXRlZCBydW4gaWQgY2Fycmllcywgc28gdGhlIGlkIGlzIGdyZXBwYWJsZS4gKi9cbmV4cG9ydCBjb25zdCBSVU5fSURfUFJFRklYID0gXCJ2aWJlXCI7XG5cbi8qKiBPcHRpb25zIGZvciB7QGxpbmsgZ2VuZXJhdGVSdW5JZH0gKGluamVjdGFibGUgZm9yIGRldGVybWluaXN0aWMgdGVzdHMpLiAqL1xuZXhwb3J0IGludGVyZmFjZSBHZW5lcmF0ZVJ1bklkT3B0aW9ucyB7XG4gIC8qKiBNaWxsaXNlY29uZCBlcG9jaCB0aW1lc3RhbXAuIERlZmF1bHRzIHRvIGBEYXRlLm5vdygpYC4gKi9cbiAgbm93PzogbnVtYmVyO1xuICAvKiogUmFuZG9tIHNvdXJjZSBpbiBbMCwgMSkuIERlZmF1bHRzIHRvIGBNYXRoLnJhbmRvbWAuICovXG4gIHJhbmRvbT86ICgpID0+IG51bWJlcjtcbn1cblxuLyoqXG4gKiBHZW5lcmF0ZSBhIGZyZXNoIHJ1biBpZC5cbiAqXG4gKiBGb3JtYXQ6IGB2aWJlLTxiYXNlMzYgZXBvY2ggbXM+LTw2IGhleCByYW5kb20+YCAoZS5nLlxuICogYHZpYmUtbGt6M3A5eC0xYTJiM2NgKS4gQ29tcGFjdCwgVVJMLXNhZmUsIGdyZXBwYWJsZSBieSB0aGUgYHZpYmUtYFxuICogcHJlZml4LCBhbmQgdW5pcXVlIHBlciBpbnZvY2F0aW9uIHdpdGhvdXQgbmVlZGluZyBhbnkgc3lzdGVtXG4gKiBwZXJtaXNzaW9uLlxuICovXG5leHBvcnQgZnVuY3Rpb24gZ2VuZXJhdGVSdW5JZChvcHRzOiBHZW5lcmF0ZVJ1bklkT3B0aW9ucyA9IHt9KTogc3RyaW5nIHtcbiAgY29uc3Qgbm93ID0gb3B0cy5ub3cgPz8gRGF0ZS5ub3coKTtcbiAgY29uc3QgcmFuZG9tID0gb3B0cy5yYW5kb20gPz8gTWF0aC5yYW5kb207XG4gIGNvbnN0IHRzID0gTWF0aC5tYXgoMCwgTWF0aC5mbG9vcihub3cpKS50b1N0cmluZygzNik7XG4gIGNvbnN0IHN1ZmZpeCA9IE1hdGguZmxvb3IocmFuZG9tKCkgKiAweDEwMDAwMDApXG4gICAgLnRvU3RyaW5nKDE2KVxuICAgIC5wYWRTdGFydCg2LCBcIjBcIilcbiAgICAuc2xpY2UoMCwgNik7XG4gIHJldHVybiBgJHtSVU5fSURfUFJFRklYfS0ke3RzfS0ke3N1ZmZpeH1gO1xufVxuXG4vKipcbiAqIFJlYWQgdGhlIHJ1biBpZCBhbHJlYWR5IGVzdGFibGlzaGVkIGZvciB0aGlzIGludm9jYXRpb24sIHdpdGhvdXRcbiAqIGVzdGFibGlzaGluZyBvbmUgKElzc3VlICM5NjMpLlxuICpcbiAqIFRoaXMgaXMgdGhlIHJlYWQgaGFsZiBvZiB7QGxpbmsgZ2V0UnVuSWR9LCBzcGxpdCBvdXQgc28gYSBjYWxsZXIg4oCUIGFuZCBhXG4gKiB0ZXN0IOKAlCBjYW4gYXNrIFwid2hhdCBpcyB0aGUgcnVuIGlkP1wiIHdpdGhvdXQgdGhlIG1vZHVsZSB3cml0aW5nIGFueXRoaW5nXG4gKiBpbnRvIHRoZSBwcm9jZXNzLiBCbGFuayBhbmQgd2hpdGVzcGFjZS1vbmx5IHZhbHVlcyByZWFkIGFzIGFic2VudCwgd2hpY2hcbiAqIGlzIHdoYXQgbWFrZXMgdGhlbSByZWdlbmVyYWJsZSByYXRoZXIgdGhhbiBhIHJ1biBpZCBvZiBgXCIgICBcImAuXG4gKlxuICogQHBhcmFtIGVudiAtIEVudmlyb25tZW50IGxvb2t1cC4gRGVmYXVsdHMgdG8gdGhlIHJlYWwgcHJvY2VzcyBlbnZpcm9ubWVudCxcbiAqICAgc28gcHJvZHVjdGlvbiBjYWxsZXJzIHBhc3Mgbm90aGluZyBhbmQgYmVoYXZlIGV4YWN0bHkgYXMgYmVmb3JlLlxuICogQHJldHVybnMgVGhlIHRyaW1tZWQgcnVuIGlkLCBvciBgdW5kZWZpbmVkYCB3aGVuIG5vbmUgaXMgc2V0LlxuICovXG5leHBvcnQgZnVuY3Rpb24gcmVhZFJ1bklkKFxuICBlbnY6IEVudkxvb2t1cCA9IHByb2Nlc3NFbnZMb29rdXAsXG4pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICBsZXQgcmF3OiBzdHJpbmcgfCB1bmRlZmluZWQ7XG4gIHRyeSB7XG4gICAgcmF3ID0gZW52KFJVTl9JRF9FTlZfVkFSKTtcbiAgfSBjYXRjaCB7XG4gICAgLy8gQSBkZW5pZWQgYC0tYWxsb3ctZW52YCBpcyBcIm5vIHJ1biBpZCBzZXRcIiwgbm90IGEgY3Jhc2guXG4gICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxuICBjb25zdCB0cmltbWVkID0gcmF3Py50cmltKCk7XG4gIHJldHVybiB0cmltbWVkICE9PSB1bmRlZmluZWQgJiYgdHJpbW1lZC5sZW5ndGggPiAwID8gdHJpbW1lZCA6IHVuZGVmaW5lZDtcbn1cblxuLyoqXG4gKiBXaGVyZSB7QGxpbmsgZ2V0UnVuSWR9IGNhY2hlcyB0aGUgaWQgaXQgZ2VuZXJhdGVzIChJc3N1ZSAjOTYzKS5cbiAqXG4gKiBUaGUgcnVuIGlkIGlzIGdlbnVpbmVseSBwcm9jZXNzLXNjb3BlZCBpbiBwcm9kdWN0aW9uOiBpdCBpcyBjYWNoZWQgaW50b1xuICogYFZJQkVfUlVOX0lEYCBzbyBldmVyeSBjaGlsZCBgZGVub2AgY29tbWFuZCBpbmhlcml0cyBpdC4gVGhhdCB3cml0ZSBpcyB0aGVcbiAqIHJlYXNvbiBhIHRlc3QgdG91Y2hpbmcgdGhpcyBtb2R1bGUgdXNlZCB0byBoYXZlIHRvIG11dGF0ZSB0aGUgcHJvY2Vzc1xuICogZW52aXJvbm1lbnQg4oCUIGFuZCBhIG11dGF0ZWQgcHJvY2VzcyBlbnZpcm9ubWVudCByYWNlcyBldmVyeSBvdGhlciB0ZXN0XG4gKiBydW5uaW5nIGF0IHRoYXQgbW9tZW50IChJc3N1ZSAjODgwKS4gTmFtaW5nIHRoZSBzdG9yZSBhcyBhIHBhcmFtZXRlciBsZXRzIGFcbiAqIHRlc3QgaGFuZCBvdmVyIGEgcGxhaW4gYE1hcGAsIHNvIHRoZSBnZW5lcmF0ZS1vbmNlLWFuZC1jYWNoZSBiZWhhdmlvdXIgaXNcbiAqIHN0aWxsIHByb3ZlbiB3aGlsZSBub3RoaW5nIHByb2Nlc3Mtd2lkZSBtb3Zlcy5cbiAqXG4gKiBBIGBNYXA8c3RyaW5nLCBzdHJpbmc+YCBzYXRpc2ZpZXMgdGhpcyBpbnRlcmZhY2UgYXMtaXMuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgUnVuSWRTdG9yZSB7XG4gIC8qKiBSZWFkcyB0aGUgY2FjaGVkIHJ1biBpZCDigJQgdGhlIHNhbWUgY29udHJhY3QgYXMge0BsaW5rIEVudkxvb2t1cH0uICovXG4gIGdldDogRW52TG9va3VwO1xuICAvKiogQ2FjaGVzIGEgZnJlc2hseSBnZW5lcmF0ZWQgcnVuIGlkLiAqL1xuICBzZXQobmFtZTogc3RyaW5nLCB2YWx1ZTogc3RyaW5nKTogdm9pZDtcbn1cblxuLyoqXG4gKiBUaGUgcmVhbCBwcm9jZXNzIGVudmlyb25tZW50IGFzIGEge0BsaW5rIFJ1bklkU3RvcmV9LlxuICpcbiAqIFRoZSBkZWZhdWx0IGZvciB7QGxpbmsgZ2V0UnVuSWR9LCBzbyBwcm9kdWN0aW9uIGlzIHVuY2hhbmdlZDogdGhlIGlkIGlzXG4gKiByZWFkIGZyb20gYW5kIGNhY2hlZCBpbnRvIGBWSUJFX1JVTl9JRGAuIEJvdGggaGFsdmVzIHRvbGVyYXRlIGEgZGVuaWVkXG4gKiBgLS1hbGxvdy1lbnZgIOKAlCB0aGUgY2FsbGVyIHN0aWxsIGdldHMgYW4gaWQgYmFjaywgaXQganVzdCB3aWxsIG5vdFxuICogcHJvcGFnYXRlIHRvIGNoaWxkIHByb2Nlc3NlcyBvbiB0aGlzIHJ1bi5cbiAqL1xuZXhwb3J0IGNvbnN0IHByb2Nlc3NSdW5JZFN0b3JlOiBSdW5JZFN0b3JlID0ge1xuICBnZXQ6IChuYW1lKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIHJldHVybiBwcm9jZXNzRW52TG9va3VwKG5hbWUpO1xuICAgIH0gY2F0Y2gge1xuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICB9XG4gIH0sXG4gIHNldDogKG5hbWUsIHZhbHVlKSA9PiB7XG4gICAgdHJ5IHtcbiAgICAgIERlbm8uZW52LnNldChuYW1lLCB2YWx1ZSk7XG4gICAgfSBjYXRjaCB7XG4gICAgICAvLyBQZXJtaXNzaW9uIGRlbmllZCDigJQgc2VlIGFib3ZlLlxuICAgIH1cbiAgfSxcbn07XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgY2Fub25pY2FsIHJ1biBpZCBmb3IgdGhlIGN1cnJlbnQgd29ya2VyIGludm9jYXRpb24uXG4gKlxuICogSWYgYFZJQkVfUlVOX0lEYCBpcyBhbHJlYWR5IHNldCAoYnkgdGhlIHNoZWxsIGVudHJ5IHBvaW50IG9yIGEgcGFyZW50XG4gKiB3b3JrZXIgcHJvY2VzcyksIHRoYXQgdmFsdWUgaXMgcmV0dXJuZWQgdmVyYmF0aW0gc28gZXZlcnkgbXV0YXRpb25cbiAqIHBhdGggb24gdGhlIHNhbWUgaW52b2NhdGlvbiBzaGFyZXMgb25lIGlkLiBPdGhlcndpc2UgYSBmcmVzaCBpZCBpc1xuICogZ2VuZXJhdGVkLCBjYWNoZWQgaW50byBgVklCRV9SVU5fSURgIChzbyBzdWJzZXF1ZW50IGNhbGxzIGFuZCBjaGlsZFxuICogcHJvY2Vzc2VzIHJldXNlIGl0KSwgYW5kIHJldHVybmVkLlxuICpcbiAqIEBwYXJhbSBzdG9yZSAtIFdoZXJlIHRoZSBpZCBpcyByZWFkIGZyb20gYW5kIGNhY2hlZCB0by4gRGVmYXVsdHMgdG9cbiAqICAge0BsaW5rIHByb2Nlc3NSdW5JZFN0b3JlfSwgdGhlIHJlYWwgcHJvY2VzcyBlbnZpcm9ubWVudCAoSXNzdWUgIzk2MykuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBnZXRSdW5JZChzdG9yZTogUnVuSWRTdG9yZSA9IHByb2Nlc3NSdW5JZFN0b3JlKTogc3RyaW5nIHtcbiAgY29uc3QgZXhpc3RpbmcgPSByZWFkUnVuSWQoKG5hbWUpID0+IHN0b3JlLmdldChuYW1lKSk7XG4gIGlmIChleGlzdGluZyAhPT0gdW5kZWZpbmVkKSByZXR1cm4gZXhpc3Rpbmc7XG4gIGNvbnN0IGlkID0gZ2VuZXJhdGVSdW5JZCgpO1xuICBzdG9yZS5zZXQoUlVOX0lEX0VOVl9WQVIsIGlkKTtcbiAgcmV0dXJuIGlkO1xufVxuXG4vKiogTWF0Y2hlcyBhIGBWaWJlLUNvZGVyLVJ1bi1JZDogPHZhbHVlPmAgdHJhaWxlciBsaW5lIGFueXdoZXJlIGluIGEgbWVzc2FnZS4gKi9cbmNvbnN0IFRSQUlMRVJfUkUgPSBuZXcgUmVnRXhwKFxuICBgXiR7UlVOX0lEX1RSQUlMRVJfS0VZfTpbIFxcXFx0XSooXFxcXFMuKikkYCxcbiAgXCJtaVwiLFxuKTtcblxuLyoqIFdoZXRoZXIgYG1lc3NhZ2VgIGFscmVhZHkgY2FycmllcyBhIG5vbi1lbXB0eSBydW4taWQgdHJhaWxlci4gKi9cbmV4cG9ydCBmdW5jdGlvbiBoYXNSdW5JZFRyYWlsZXIobWVzc2FnZTogc3RyaW5nKTogYm9vbGVhbiB7XG4gIHJldHVybiBUUkFJTEVSX1JFLnRlc3QobWVzc2FnZSk7XG59XG5cbi8qKiBNYXRjaGVzIGEgZ2VuZXJpYyBnaXQgdHJhaWxlciBsaW5lIChgU29tZS1LZXk6IHZhbHVlYCkuICovXG5jb25zdCBHRU5FUklDX1RSQUlMRVJfTElORV9SRSA9IC9eW0EtWmEtel1bQS1aYS16MC05LV0qOlsgXFx0XStcXFMvO1xuXG4vKipcbiAqIEFwcGVuZCB0aGUgcnVuLWlkIHRyYWlsZXIgdG8gYSBjb21taXQgbWVzc2FnZS5cbiAqXG4gKiBJZGVtcG90ZW50IOKAlCBpZiB0aGUgbWVzc2FnZSBhbHJlYWR5IGNhcnJpZXMgYSBgVmliZS1Db2Rlci1SdW4tSWRgXG4gKiB0cmFpbGVyIGl0IGlzIHJldHVybmVkIHVuY2hhbmdlZC4gV2hlbiB0aGUgbWVzc2FnZSBhbHJlYWR5IGVuZHMgd2l0aCBhXG4gKiBnaXQgdHJhaWxlciBibG9jayAoZS5nLiBhIGBDby1BdXRob3JlZC1CeTpgIGxpbmUpLCB0aGUgcnVuLWlkIHRyYWlsZXJcbiAqIGlzIGFwcGVuZGVkIG9uIHRoZSBuZXh0IGxpbmUgc28gaXQgam9pbnMgdGhlIHNhbWUgYmxvY2s7IG90aGVyd2lzZSBpdFxuICogaXMgYXBwZW5kZWQgYXMgYSBuZXcgdHJhaWxlciBibG9jayBzZXBhcmF0ZWQgYnkgYSBibGFuayBsaW5lLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYXBwZW5kUnVuSWRUcmFpbGVyKG1lc3NhZ2U6IHN0cmluZywgcnVuSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGlmIChoYXNSdW5JZFRyYWlsZXIobWVzc2FnZSkpIHJldHVybiBtZXNzYWdlO1xuICBjb25zdCB0cmltbWVkID0gbWVzc2FnZS5yZXBsYWNlKC9cXHMrJC8sIFwiXCIpO1xuICBjb25zdCB0cmFpbGVyTGluZSA9IGAke1JVTl9JRF9UUkFJTEVSX0tFWX06ICR7cnVuSWR9YDtcblxuICBjb25zdCBsaW5lcyA9IHRyaW1tZWQuc3BsaXQoXCJcXG5cIik7XG4gIGNvbnN0IGxhc3RMaW5lID0gbGluZXNbbGluZXMubGVuZ3RoIC0gMV0gPz8gXCJcIjtcbiAgaWYgKEdFTkVSSUNfVFJBSUxFUl9MSU5FX1JFLnRlc3QobGFzdExpbmUpKSB7XG4gICAgLy8gRXhpc3RpbmcgdHJhaWxlciBibG9jayDigJQga2VlcCB0aGUgcnVuIGlkIGluIHRoZSBzYW1lIGJsb2NrLlxuICAgIHJldHVybiBgJHt0cmltbWVkfVxcbiR7dHJhaWxlckxpbmV9YDtcbiAgfVxuICByZXR1cm4gYCR7dHJpbW1lZH1cXG5cXG4ke3RyYWlsZXJMaW5lfWA7XG59XG5cbi8qKlxuICogQXNzZXJ0IHRoYXQgYSBjb21taXQgbWVzc2FnZSBjYXJyaWVzIHRoZSBydW4taWQgdHJhaWxlci5cbiAqXG4gKiBUaGlzIGlzIHRoZSB2YWxpZGF0b3IgYmVoaW5kIHRoZSBwcmUtY29tbWl0IHJ1bi1pZCBnYXRlOiBhIGNvbW1pdFxuICogbWVzc2FnZSBsYWNraW5nIHRoZSB0cmFpbGVyIGlzIHJlamVjdGVkIHdpdGggYW4gYWN0aW9uYWJsZSBlcnJvci5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGFzc2VydFJ1bklkVHJhaWxlcihtZXNzYWdlOiBzdHJpbmcpOiBSZXN1bHQ8dm9pZD4ge1xuICBpZiAoaGFzUnVuSWRUcmFpbGVyKG1lc3NhZ2UpKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB1bmRlZmluZWQgfTtcbiAgfVxuICByZXR1cm4ge1xuICAgIG9rOiBmYWxzZSxcbiAgICBlcnJvcjogbmV3IEVycm9yKFxuICAgICAgYENvbW1pdCBtZXNzYWdlIGlzIG1pc3NpbmcgdGhlIHJlcXVpcmVkICR7UlVOX0lEX1RSQUlMRVJfS0VZfSB0cmFpbGVyIGAgK1xuICAgICAgICBgKElzc3VlICMyMzgxKS4gQXBwZW5kIGEgbGluZSBvZiB0aGUgZm9ybSBcIiR7UlVOX0lEX1RSQUlMRVJfS0VZfTogPHJ1bi1pZD5cIiBgICtcbiAgICAgICAgXCJzbyB0aGUgY29tbWl0IGlzIHRyYWNlYWJsZSBiYWNrIHRvIGl0cyBvcmlnaW5hdGluZyB3b3JrZXIgcnVuLlwiLFxuICAgICksXG4gIH07XG59XG5cbi8qKlxuICogQnVpbGQgdGhlIGNvbXBhY3QgcnVuLWlkIGZvb3RlciBsaW5lIGZvciBjb21tZW50cyBhbmQgUFIgYm9kaWVzLlxuICpcbiAqIFByb2R1Y2VzIGEgc2luZ2xlIGdyZXBwYWJsZSBsaW5lLCBlLmcuIGBgUnVuIGlkOiBgdmliZS0uLi5gIGBgLlxuICovXG5leHBvcnQgZnVuY3Rpb24gYnVpbGRSdW5JZEZvb3RlckxpbmUocnVuSWQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiBg8J+Pt++4jyBSdW4gaWQ6IFxcYCR7cnVuSWR9XFxgYDtcbn1cblxuLyoqXG4gKiBCdWlsZCBhIG1hY2hpbmUtcmVhZGFibGUgcnVuLWlkIG1ldGFkYXRhIGJsb2NrIGZvciBpc3N1ZSBib2RpZXMuXG4gKlxuICogV29ya2VyLWZpbGVkIGlzc3VlcyAoc2VjdXJpdHktc2NhbiwgYmVzdC1wcmFjdGljZXMsIHRlc3QtYXVkaXQsXG4gKiBnaXRodWItYWN0aW9ucy1hdWRpdCwgYW5kIGlkbGUtdGFzayB3cmFwcGVycykgZW1iZWQgdGhpcyBibG9jayBzbyBhXG4gKiByZXZpZXdlciBjYW4gam9pbiB0aGUgaXNzdWUgYmFjayB0byB0aGUgcnVuIHRoYXQgZmlsZWQgaXQuIFRoZSBibG9ja1xuICogaXMgYSBmZW5jZWQgYGtleTogdmFsdWVgIHNuaXBwZXQgdGhhdCBzY3JpcHRzIGNhbiBwYXJzZSB3aXRob3V0XG4gKiBndWVzc2luZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkUnVuSWRNZXRhZGF0YUJsb2NrKHJ1bklkOiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gW1wiYGBgXCIsIGBydW4taWQ6ICR7cnVuSWR9YCwgXCJgYGBcIl0uam9pbihcIlxcblwiKTtcbn1cbiJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBMkJDLEdBR0QsU0FBeUIsZ0JBQWdCLFFBQVEsa0JBQWtCO0FBRW5FLDJFQUEyRSxHQUMzRSxPQUFPLE1BQU0saUJBQWlCLGNBQWM7QUFFNUMsc0VBQXNFLEdBQ3RFLE9BQU8sTUFBTSxxQkFBcUIsb0JBQW9CO0FBRXRELG1FQUFtRSxHQUNuRSxPQUFPLE1BQU0sZ0JBQWdCLE9BQU87QUFVcEM7Ozs7Ozs7Q0FPQyxHQUNELE9BQU8sU0FBUyxjQUFjLE9BQTZCLENBQUMsQ0FBQztFQUMzRCxNQUFNLE1BQU0sS0FBSyxHQUFHLElBQUksS0FBSyxHQUFHO0VBQ2hDLE1BQU0sU0FBUyxLQUFLLE1BQU0sSUFBSSxLQUFLLE1BQU07RUFDekMsTUFBTSxLQUFLLEtBQUssR0FBRyxDQUFDLEdBQUcsS0FBSyxLQUFLLENBQUMsTUFBTSxRQUFRLENBQUM7RUFDakQsTUFBTSxTQUFTLEtBQUssS0FBSyxDQUFDLFdBQVcsV0FDbEMsUUFBUSxDQUFDLElBQ1QsUUFBUSxDQUFDLEdBQUcsS0FDWixLQUFLLENBQUMsR0FBRztFQUNaLE9BQU8sR0FBRyxjQUFjLENBQUMsRUFBRSxHQUFHLENBQUMsRUFBRSxRQUFRO0FBQzNDO0FBRUE7Ozs7Ozs7Ozs7OztDQVlDLEdBQ0QsT0FBTyxTQUFTLFVBQ2QsTUFBaUIsZ0JBQWdCO0VBRWpDLElBQUk7RUFDSixJQUFJO0lBQ0YsTUFBTSxJQUFJO0VBQ1osRUFBRSxPQUFNO0lBQ04sMERBQTBEO0lBQzFELE9BQU87RUFDVDtFQUNBLE1BQU0sVUFBVSxLQUFLO0VBQ3JCLE9BQU8sWUFBWSxhQUFhLFFBQVEsTUFBTSxHQUFHLElBQUksVUFBVTtBQUNqRTtBQXNCQTs7Ozs7OztDQU9DLEdBQ0QsT0FBTyxNQUFNLG9CQUFnQztFQUMzQyxLQUFLLENBQUM7SUFDSixJQUFJO01BQ0YsT0FBTyxpQkFBaUI7SUFDMUIsRUFBRSxPQUFNO01BQ04sT0FBTztJQUNUO0VBQ0Y7RUFDQSxLQUFLLENBQUMsTUFBTTtJQUNWLElBQUk7TUFDRixLQUFLLEdBQUcsQ0FBQyxHQUFHLENBQUMsTUFBTTtJQUNyQixFQUFFLE9BQU07SUFDTixpQ0FBaUM7SUFDbkM7RUFDRjtBQUNGLEVBQUU7QUFFRjs7Ozs7Ozs7Ozs7Q0FXQyxHQUNELE9BQU8sU0FBUyxTQUFTLFFBQW9CLGlCQUFpQjtFQUM1RCxNQUFNLFdBQVcsVUFBVSxDQUFDLE9BQVMsTUFBTSxHQUFHLENBQUM7RUFDL0MsSUFBSSxhQUFhLFdBQVcsT0FBTztFQUNuQyxNQUFNLEtBQUs7RUFDWCxNQUFNLEdBQUcsQ0FBQyxnQkFBZ0I7RUFDMUIsT0FBTztBQUNUO0FBRUEsK0VBQStFLEdBQy9FLE1BQU0sYUFBYSxJQUFJLE9BQ3JCLENBQUMsQ0FBQyxFQUFFLG1CQUFtQixnQkFBZ0IsQ0FBQyxFQUN4QztBQUdGLGtFQUFrRSxHQUNsRSxPQUFPLFNBQVMsZ0JBQWdCLE9BQWU7RUFDN0MsT0FBTyxXQUFXLElBQUksQ0FBQztBQUN6QjtBQUVBLDREQUE0RCxHQUM1RCxNQUFNLDBCQUEwQjtBQUVoQzs7Ozs7Ozs7Q0FRQyxHQUNELE9BQU8sU0FBUyxtQkFBbUIsT0FBZSxFQUFFLEtBQWE7RUFDL0QsSUFBSSxnQkFBZ0IsVUFBVSxPQUFPO0VBQ3JDLE1BQU0sVUFBVSxRQUFRLE9BQU8sQ0FBQyxRQUFRO0VBQ3hDLE1BQU0sY0FBYyxHQUFHLG1CQUFtQixFQUFFLEVBQUUsT0FBTztFQUVyRCxNQUFNLFFBQVEsUUFBUSxLQUFLLENBQUM7RUFDNUIsTUFBTSxXQUFXLEtBQUssQ0FBQyxNQUFNLE1BQU0sR0FBRyxFQUFFLElBQUk7RUFDNUMsSUFBSSx3QkFBd0IsSUFBSSxDQUFDLFdBQVc7SUFDMUMsOERBQThEO0lBQzlELE9BQU8sR0FBRyxRQUFRLEVBQUUsRUFBRSxhQUFhO0VBQ3JDO0VBQ0EsT0FBTyxHQUFHLFFBQVEsSUFBSSxFQUFFLGFBQWE7QUFDdkM7QUFFQTs7Ozs7Q0FLQyxHQUNELE9BQU8sU0FBUyxtQkFBbUIsT0FBZTtFQUNoRCxJQUFJLGdCQUFnQixVQUFVO0lBQzVCLE9BQU87TUFBRSxJQUFJO01BQU0sT0FBTztJQUFVO0VBQ3RDO0VBQ0EsT0FBTztJQUNMLElBQUk7SUFDSixPQUFPLElBQUksTUFDVCxDQUFDLHVDQUF1QyxFQUFFLG1CQUFtQixTQUFTLENBQUMsR0FDckUsQ0FBQywwQ0FBMEMsRUFBRSxtQkFBbUIsWUFBWSxDQUFDLEdBQzdFO0VBRU47QUFDRjtBQUVBOzs7O0NBSUMsR0FDRCxPQUFPLFNBQVMscUJBQXFCLEtBQWE7RUFDaEQsT0FBTyxDQUFDLGNBQWMsRUFBRSxNQUFNLEVBQUUsQ0FBQztBQUNuQztBQUVBOzs7Ozs7OztDQVFDLEdBQ0QsT0FBTyxTQUFTLHdCQUF3QixLQUFhO0VBQ25ELE9BQU87SUFBQztJQUFPLENBQUMsUUFBUSxFQUFFLE9BQU87SUFBRTtHQUFNLENBQUMsSUFBSSxDQUFDO0FBQ2pEIn0=
// denoCacheMetadata=4490353735040625731,16536409512384153936