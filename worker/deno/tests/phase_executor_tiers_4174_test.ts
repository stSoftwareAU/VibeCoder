/**
 * Every phase the work executor is given resolves under the default config
 * (Issue #4174).
 *
 * The phase list is read from the call sites, not copied from the table: a
 * new phase passed to the executor with no tier fails here. Idle-task scans
 * go through `runIdleTaskClaude` and are left out — their model is the
 * cadence stamp, and an unstamped scan is documented as leaving `model`
 * unset. They are not phase-table phases.
 *
 * Australian English spelling throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { resolveClaudeModel } from "../lib/claude_executor.ts";
import {
  CODEX_PHASE_EFFORT_DEFAULTS,
  CODEX_PHASE_MODEL_DEFAULTS,
  DEEPSEEK_PHASE_MODEL_DEFAULTS,
  GEMINI_PHASE_MODEL_DEFAULTS,
  PHASE_EFFORT_DEFAULTS,
  PHASE_MODEL_DEFAULTS,
} from "../lib/config_defaults.ts";

const LIB = decodeURIComponent(new URL("../lib/", import.meta.url).pathname);

const EXECUTOR =
  /(?:^|[^\w.])(?:[\w.]+\.)?(runClaudeWithTimeout|runClaudeWithRetry|runAgentTracked|runAgent|runner|ask)\s*\(/g;

const PHASE_LIT = /phase\s*:\s*["']([A-Za-z0-9_]+)["']/g;
const PHASE_IDENT = /phase\s*:\s*([A-Za-z_][A-Za-z0-9_]*)/g;
const CONST_DEF =
  /(?:export\s+)?const\s+([A-Z][A-Z0-9_]+)\s*=\s*["']([A-Za-z0-9_]+)["']/g;

function walk(dir: string, out: string[]): void {
  for (const entry of Deno.readDirSync(dir)) {
    if (entry.name === "idle_task_templates") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) walk(path, out);
    else if (entry.isFile && entry.name.endsWith(".ts")) out.push(path);
  }
}

function matchBrace(text: string, open: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let i = open; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return undefined;
}

function skipSpace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

/** Phase names the work executor is actually given. */
function executorPhases(): string[] {
  const files: string[] = [];
  walk(LIB, files);
  const constants = new Map<string, string>();
  const sources = files.map((path) => {
    const text = Deno.readTextFileSync(path);
    for (const match of text.matchAll(CONST_DEF)) {
      constants.set(match[1]!, match[2]!);
    }
    return { path, text };
  });

  const phases = new Set<string>();
  const add = (name: string | undefined) => {
    if (name) phases.add(name);
  };
  const addFromObject = (object: string) => {
    for (const match of object.matchAll(PHASE_LIT)) add(match[1]);
    for (const match of object.matchAll(PHASE_IDENT)) {
      const ident = match[1]!;
      if (constants.has(ident)) add(constants.get(ident));
    }
  };

  for (const { path, text } of sources) {
    const callsExecutor = new RegExp(EXECUTOR.source, "g");
    let called = false;
    for (const match of text.matchAll(callsExecutor)) {
      const name = match[1]!;
      if (name === "runner" && !path.endsWith("/claude_runner.ts")) continue;
      called = true;
      const at = skipSpace(text, match.index! + match[0].length);
      if (text[at] === "{") {
        const end = matchBrace(text, at);
        if (end !== undefined) addFromObject(text.slice(at, end + 1));
      } else if (/[A-Za-z_]/.test(text[at] ?? "")) {
        const ident = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(at))?.[0];
        if (!ident) continue;
        const assign = new RegExp(
          `(?:const|let|var)\\s+${ident}\\b[^=]*=\\s*\\{`,
          "g",
        );
        let last: RegExpExecArray | null = null;
        for (const found of text.slice(0, match.index).matchAll(assign)) {
          last = found;
        }
        if (!last) continue;
        const brace = text.indexOf("{", last.index);
        const end = matchBrace(text, brace);
        if (end !== undefined && end < match.index!) {
          addFromObject(text.slice(brace, end + 1));
        }
      }
    }
    if (!called) continue;
    // A phase that rides on a prompt object, or on a call argument, in a
    // function that does invoke the executor. Covers quorum's spec array
    // and clarification's pass-through without listing the names.
    for (let i = 0; i < text.length; i++) {
      if (text[i] !== "{") continue;
      const end = matchBrace(text, i);
      if (end === undefined) break;
      const object = text.slice(i, end + 1);
      if (!object.includes("phase")) {
        i = end;
        continue;
      }
      let before = i - 1;
      while (before >= 0 && /\s/.test(text[before]!)) before--;
      const callArg = before >= 0 && text[before] === "(";
      if (callArg || /\bprompt\s*:/.test(object)) addFromObject(object);
      i = end;
    }
  }
  return [...phases].sort();
}

Deno.test("every phase passed to the work executor resolves under the default config (Issue #4174)", () => {
  const phases = executorPhases();
  assert(phases.includes("merge_conflict"), phases.join(", "));
  assert(phases.includes("compaction"), phases.join(", "));
  const missing = phases.filter((phase) => !PHASE_MODEL_DEFAULTS[phase]);
  assertEquals(
    missing,
    [],
    `phases with no default model: ${phases.join(", ")}`,
  );
  const empty = (): undefined => undefined;
  for (const phase of phases) {
    const claude = PHASE_MODEL_DEFAULTS[phase]!;
    assertEquals(resolveClaudeModel(phase, empty), claude, phase);
    assert(
      CODEX_PHASE_MODEL_DEFAULTS[phase],
      `${phase} has no Codex model`,
    );
    assert(
      GEMINI_PHASE_MODEL_DEFAULTS[phase],
      `${phase} has no Gemini model`,
    );
    assert(
      DEEPSEEK_PHASE_MODEL_DEFAULTS[phase],
      `${phase} has no DeepSeek model`,
    );
    assert(PHASE_EFFORT_DEFAULTS[phase], `${phase} has no Claude effort`);
    assert(
      CODEX_PHASE_EFFORT_DEFAULTS[phase],
      `${phase} has no Codex effort`,
    );
  }
});
