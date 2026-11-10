/**
 * Cargo-deny CI gate (Issue #4626).
 *
 * CI runs `cargo deny check` on fleet PRs, but the Mac-side push gates never
 * ran it, so a dependency-audit failure only surfaced after the push. This
 * module reads the repository's own workflows, finds the cargo-deny
 * invocations CI makes, and hands the pre-push gate the same argv to run
 * locally.
 *
 * Fail closed. A CI invocation that cannot be reproduced locally blocks the
 * push. A failure that shows the tool itself is unavailable (no network, no
 * advisory database, no cargo-deny binary) is an infrastructure deferral,
 * never a pass and never a verdict. Any other non-zero exit is a verdict, unless CI allows the
 * invocation to fail (see below), when it is a warning.
 *
 * The gate never adds `--offline`, an ignore list or a reduced-scope flag.
 * A `${{ matrix.<key> }}` expression is expanded from the job's literal
 * matrix, one invocation per combination. An expression or variable that
 * cannot be expanded is dropped, together with the option it was the value of,
 * so the invocation runs a plain `check` (every check, so every subset) with
 * the action's defaults. Only a `cargo deny` line that names no `check` and
 * holds one, or a working directory that cannot be resolved, stays unrunnable.
 *
 * An invocation CI allows to fail (`continue-on-error` on its step or job: a
 * literal true, or a `matrix.<key>` test evaluated for each combination) still
 * runs, but a failure is a warning, never a verdict.
 *
 * A workflow CI does not run for the push (a `schedule`-only audit, or a
 * `paths` filter that selects none of the branch's touched paths) is not read:
 * those trigger and path cases do not cause an extra check.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */ // Reviewer entry points also load this module outside the worker's import map.
// deno-lint-ignore no-import-prefix
import { parse as parseYaml } from "jsr:@std/yaml@^1.0.12/parse";
import { runPreFlightGate, tokeniseCommand } from "./pre_flight_gate.ts";
/** The most characters of a failed check's output kept in a warning. */ const WARNING_CAP = 1000;
/** Longest line the parser's messages and the classifier will examine. */ const LINE_CAP = 2000;
const INFRA_PREFIX = "cargo deny could not run, so the dependency audit was not checked (this is not a pass): ";
/** A YAML list item, `- ` at the start of a line (a workflow step). */ const LIST_ITEM = /^(\s*)-(.*)$/;
const MAPPING_KEY = /^([A-Za-z_][\w-]*):(.*)$/;
const BLOCK_INDICATOR = /^[|>][-+0-9]*$/;
const CARGO_DENY_START = /^cargo\s+deny\b/;
const ACTION_REPO = /^embarkstudios\/cargo-deny-action(?:@|$)/i;
const TRIGGER_BASENAMES = new Set([
  "Cargo.toml",
  "Cargo.lock",
  "deny.toml",
  ".deny.toml"
]);
const TRIGGER_CARGO_CONFIG = /(?:^|\/)\.cargo\/(?:config|deny)\.toml$/;
/** A diagnostic from cargo-deny itself: a verdict on the dependency graph. */ const VERDICT_LINE = /^error\[[a-z0-9-]+\]/;
/** Optional `2026-11-07 18:04:31 [ERROR] ` style prefix on a log line. */ const LOG_PREFIX = /^(?:\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} )?(?:\[[A-Z]+\] )?/;
const URL_CREDENTIALS = /\/\/[^\s/@]+@/g;
/**
 * Lines that show the tool could not reach its inputs. Each is matched
 * anchored at the start of a line (after the log prefix), never as a
 * substring of the output.
 */ const TOOL_UNAVAILABLE = [
  /^failed to fetch advisory database/,
  /^fatal: unable to access/,
  /^error: no such command: `deny`/,
  /^(?:(?:warning|error): )?spurious network error/,
  /^failed to download/,
  /^download of config\.json failed/,
  /^Could not resolve host/,
  /^Couldn't resolve host/,
  /^Network is unreachable/,
  /^Connection (?:refused|timed out|reset)/
];
/** The action's input defaults (EmbarkStudios/cargo-deny-action action.yml). */ const ACTION_DEFAULTS = {
  "log-level": "warn",
  "manifest-path": "./Cargo.toml",
  arguments: "--all-features",
  command: "check",
  "command-arguments": ""
};
function indentOf(line) {
  return line.length - line.trimStart().length;
}
function isSkippable(text) {
  const t = text.trim();
  return t === "" || t.startsWith("#");
}
/** Split `key: value` (the key must be a plain identifier). */ function parseMapping(text) {
  const m = MAPPING_KEY.exec(text.trim());
  if (!m) return null;
  const after = m[2] ?? "";
  if (after !== "" && !/^\s/.test(after)) return null;
  return {
    key: m[1] ?? "",
    raw: after.trim()
  };
}
/**
 * A YAML scalar's value: a plain value loses its ` #` comment, and a quoted
 * value loses its quotes, so `run: "cargo deny check"` is still seen.
 */ function scalarValue(raw) {
  let v = raw.trim();
  if (v.startsWith("#")) return "";
  if (!/^["']/.test(v)) {
    const comment = v.search(/\s#/);
    if (comment !== -1) v = v.slice(0, comment).trimEnd();
  }
  const quote = v.charAt(0);
  if (v.length >= 2 && (quote === '"' || quote === "'") && v.endsWith(quote)) {
    return v.slice(1, -1);
  }
  return v;
}
function splitWords(value) {
  return value.split(/\s+/).filter((word)=>word !== "");
}
/**
 * Cut a shell command at its first unquoted operator (`&&`, `||`, `;`, `|`,
 * `&`, a redirect) or comment. The digit of a `2>&1` file descriptor goes
 * with the redirect, so it does not become an argument.
 */ function cutAtShellOperator(command) {
  let quote = "";
  for(let i = 0; i < command.length; i++){
    const ch = command.charAt(i);
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    const startsWord = i === 0 || /\s/.test(command.charAt(i - 1));
    if (ch === "#" && startsWord) return command.slice(0, i);
    if ("&|;<>".includes(ch)) {
      const fdDigit = (ch === ">" || ch === "<") && /\d/.test(command.charAt(i - 1)) && (i === 1 || /\s/.test(command.charAt(i - 2)));
      return command.slice(0, fdDigit ? i - 1 : i);
    }
  }
  return command;
}
/**
 * Join backslash-continued lines into one logical command each. A line
 * ending in `\` continues onto the next line.
 */ function joinContinuations(lines) {
  const commands = [];
  let pending = null;
  for (const line of lines){
    const piece = line.text.trim();
    pending = pending === null ? {
      text: piece,
      no: line.no
    } : {
      text: `${pending.text} ${piece}`,
      no: pending.no
    };
    if (pending.text.endsWith("\\")) {
      pending = {
        text: pending.text.slice(0, -1).trimEnd(),
        no: pending.no
      };
      continue;
    }
    commands.push(pending);
    pending = null;
  }
  if (pending !== null) commands.push(pending);
  return commands;
}
/** The working directory a step's run commands execute in. */ function resolveWorkingDirectory(wd) {
  if (wd === undefined || wd === "") return {
    ok: true,
    cwd: "."
  };
  if (wd.startsWith("/") || wd.includes("..") || /[${]/.test(wd)) {
    return {
      ok: false,
      reason: `working-directory "${wd}" is not a plain relative path ` + `(it uses "..", a shell variable, a workflow expression or an ` + `absolute path), so the directory cannot be reproduced locally`
    };
  }
  return {
    ok: true,
    cwd: wd
  };
}
/** `NAME=` at the start of a shell command: an environment assignment. */ const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
/**
 * Split a shell line into its command segments at unquoted `;`, `|`, `&`,
 * `&&` and `||`, and stop at a shell comment. A `&` that is part of a
 * redirect (`2>&1`, `&>`) is not a separator.
 */ function splitShellSegments(line) {
  const segments = [];
  let quote = "";
  let start = 0;
  let end = line.length;
  for(let i = 0; i < line.length; i++){
    const ch = line.charAt(i);
    if (quote !== "") {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    const startsWord = i === 0 || /\s/.test(line.charAt(i - 1));
    if (ch === "#" && startsWord) {
      end = i;
      break;
    }
    if (ch !== ";" && ch !== "|" && ch !== "&") continue;
    const inRedirect = ch === "&" && (line.charAt(i - 1) === ">" || line.charAt(i - 1) === "<" || line.charAt(i + 1) === ">");
    if (inRedirect) continue;
    segments.push(line.slice(start, i));
    start = i + 1;
  }
  segments.push(line.slice(start, end));
  return segments;
}
/**
 * The command text after any leading `NAME=value` environment assignments.
 * A quoted value may contain spaces or operators.
 */ function stripEnvAssignments(segment) {
  let rest = segment.trimStart();
  while(ENV_ASSIGNMENT.test(rest)){
    let quote = "";
    let i = rest.indexOf("=") + 1;
    for(; i < rest.length; i++){
      const ch = rest.charAt(i);
      if (quote !== "") {
        if (ch === quote) quote = "";
        continue;
      }
      // A `${{ ... }}` expression may hold spaces; it is one value.
      if (rest.startsWith("${{", i)) {
        const close = rest.indexOf("}}", i);
        if (close === -1) break;
        i = close + 1;
        continue;
      }
      if (ch === '"' || ch === "'") {
        quote = ch;
        continue;
      }
      if (/\s/.test(ch)) break;
    }
    rest = rest.slice(i).trimStart();
  }
  return rest;
}
/** A workflow expression or shell variable left in a token. */ const UNRESOLVED = /[$`]/;
/** A `${{ ... }}` expression, whose spaces would split it across tokens. */ const WORKFLOW_EXPRESSION = /\$\{\{[^}]{0,500}\}\}/g;
/** A `${{ matrix.<key> }}` expression. */ const MATRIX_EXPRESSION = /\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g;
/** A matrix value that is safe to place in an argv: no quoting or shell syntax. */ const SAFE_MATRIX_VALUE = /^[\w./ ,=:@+-]*$/;
/** The most matrix combinations the gate expands before it falls back. */ const MAX_MATRIX_COMBINATIONS = 64;
function matrixScalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}
/** The distinct matrix keys the texts name in `${{ matrix.<key> }}`. */ function matrixKeys(texts) {
  return [
    ...new Set(texts.flatMap((text)=>[
        ...text.matchAll(MATRIX_EXPRESSION)
      ].map((match)=>match[1] ?? "")))
  ];
}
/** Any `matrix.<key>` a `continue-on-error` test reads, in whatever form. */ const CONTINUE_MATRIX_KEY = /\bmatrix\.([\w-]+)/g;
/** The distinct matrix keys a `continue-on-error` test reads. */ function continueKeys(texts) {
  return [
    ...new Set(texts.flatMap((text)=>[
        ...text.matchAll(CONTINUE_MATRIX_KEY)
      ].map((match)=>match[1] ?? "")))
  ];
}
/**
 * The value of each of `keys` in every combination of the job's literal
 * `strategy.matrix`: the lists cross, each `include` entry adds to the
 * combinations it matches or is its own combination, and `exclude` is not
 * applied (an excluded combination is checked too, which is stricter). Null
 * when a key has no literal value in some combination, a value is not a plain
 * scalar, or there are too many combinations: the caller then falls back to a
 * plain `check`. A key in `optionalKeys` may be missing from a combination
 * (it is then "", as in a workflow expression) and need not be a safe value.
 * Every dimension a key or an `include` entry names is expanded before the
 * entries are applied; the combinations are then projected onto the keys.
 */ function matrixCombinations(matrix, keys, optionalKeys = []) {
  const wanted = [
    ...keys,
    ...optionalKeys.filter((key)=>!keys.includes(key))
  ];
  if (wanted.length === 0) return [
    {}
  ];
  const dimensions = Object.entries(matrix).filter(([key, value])=>key !== "include" && key !== "exclude" && Array.isArray(value));
  const includes = Array.isArray(matrix.include) ? matrix.include : [];
  // A dimension an `include` entry names is expanded too, so the entry is
  // added only to the combinations it matches, not to a collapsed one.
  const includeKeys = new Set(includes.flatMap((entry)=>entry === null || typeof entry !== "object" ? [] : Object.keys(entry)));
  let combinations = dimensions.length === 0 ? [] : [
    {}
  ];
  for (const [key, list] of dimensions){
    if (!wanted.includes(key) && !includeKeys.has(key)) continue;
    const values = list.map(matrixScalar);
    if (values.length === 0 || values.some((value)=>value === undefined)) {
      return null;
    }
    combinations = combinations.flatMap((combination)=>values.map((value)=>({
          ...combination,
          [key]: value
        })));
    if (combinations.length > MAX_MATRIX_COMBINATIONS) return null;
  }
  for (const entry of includes){
    if (entry === null || typeof entry !== "object") continue;
    const values = {};
    for (const [key, value] of Object.entries(entry)){
      const scalar = matrixScalar(value);
      if (scalar !== undefined) values[key] = scalar;
    }
    let matched = false;
    combinations = combinations.map((combination)=>{
      const agrees = Object.entries(combination).every(([key, value])=>values[key] === undefined || values[key] === value);
      if (!agrees) return combination;
      matched = true;
      return {
        ...values,
        ...combination
      };
    });
    // An entry naming no wanted key adds nothing a wanted key could read.
    if (!matched) combinations.push(values);
  }
  if (combinations.length > MAX_MATRIX_COMBINATIONS) return null;
  const seen = new Set();
  const result = [];
  for (const combination of combinations){
    const picked = {};
    for (const key of wanted){
      const value = combination[key];
      if (keys.includes(key)) {
        if (value === undefined || !SAFE_MATRIX_VALUE.test(value)) return null;
      }
      picked[key] = value ?? "";
    }
    const id = JSON.stringify(picked);
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(picked);
  }
  return result.length === 0 ? null : result;
}
/** `text` with each `${{ matrix.<key> }}` replaced by the combination's value. */ function substituteMatrix(text, combination) {
  return text.replace(MATRIX_EXPRESSION, (_match, key)=>combination[key] ?? "");
}
/** A `continue-on-error` value that is a literal true. */ const CONTINUE_LITERAL = /^(?:true|\$\{\{\s*true\s*\}\})$/i;
/**
 * A `continue-on-error` test on one matrix key: `${{ matrix.<key> }}`, or
 * `${{ matrix.<key> == '<value>' }}` (also `!=`, and an unquoted value).
 */ const CONTINUE_MATRIX_TEST = /^\$\{\{\s*matrix\.([\w-]+)(?:\s*(==|!=)\s*(?:'([^']{0,200})'|([\w.-]{1,200})))?\s*\}\}$/;
/**
 * Whether a `continue-on-error` value lets the invocation of `combination`
 * fail. A literal true does. A matrix test is evaluated for the combination as
 * GitHub does (strings compare without regard to case, a missing key is "").
 * Anything else, and any test with no combination to evaluate it on, does
 * not: the failure then blocks.
 */ function continueOnErrorAllows(value, combination) {
  const text = value.trim();
  if (CONTINUE_LITERAL.test(text)) return true;
  if (combination === null) return false;
  const test = CONTINUE_MATRIX_TEST.exec(text);
  if (test === null) return false;
  const actual = (combination[test[1] ?? ""] ?? "").toLowerCase();
  if (test[2] === undefined) return actual === "true";
  const expected = (test[3] ?? test[4] ?? "").toLowerCase();
  return actual === expected === (test[2] === "==");
}
/** `allowFailure: true` when any of the step's `continue-on-error` values allows it. */ function allowFailureFor(ctx, combination) {
  return ctx.continueOnError.some((value)=>continueOnErrorAllows(value, combination)) ? {
    allowFailure: true
  } : {};
}
/**
 * The tokens with each variable or expression that is left dropped. An option
 * the dropped token stood after is dropped with it, so no option is left
 * without its value (`--config ${{ env.X }}` goes whole). The command is then
 * a plain check of what remains.
 */ function dropUnresolved(tokens) {
  const kept = [];
  for (const token of tokens){
    if (!UNRESOLVED.test(token)) {
      kept.push(token);
      continue;
    }
    // `kept` always holds `cargo`, so there is a previous token; "" is for the types.
    const previous = kept.at(-1) ?? "";
    if (previous.startsWith("-") && !previous.includes("=")) kept.pop();
  }
  return kept;
}
/**
 * The findings for one command segment of a shell line. A `${{ matrix.<key> }}`
 * expression is expanded from the job's literal matrix, one invocation per
 * combination. A variable or expression that stays, before or after `check`,
 * is dropped, so the invocation runs a plain `check`, which covers every subset
 * the variable could select. One in a command that names no `check` could
 * stand for another subcommand, so that is unrunnable.
 */ function segmentFindings(segment, no, ctx) {
  // The text before any redirect or comment. Environment assignments are
  // dropped (the check is run with the gate's own environment).
  const head = cutAtShellOperator(segment.trim());
  const command = stripEnvAssignments(head);
  if (!CARGO_DENY_START.test(command)) return [];
  const source = `line ${no}`;
  const combinations = matrixCombinations(ctx.matrix, matrixKeys([
    command,
    ctx.wd ?? ""
  ]), continueKeys(ctx.continueOnError));
  const findings = [];
  for (const combination of combinations ?? [
    null
  ]){
    const text = (combination === null ? command : substituteMatrix(command, combination)).replace(WORKFLOW_EXPRESSION, "$EXPRESSION");
    const argv = tokeniseCommand(text);
    if (argv[0] !== "cargo" || argv[1] !== "deny") continue;
    const checkAt = argv.indexOf("check", 2);
    if (checkAt === -1) {
      // Without `check` a variable could still stand for it.
      if (argv.some((token)=>UNRESOLVED.test(token))) {
        return [
          {
            kind: "unrunnable",
            source,
            reason: "the line uses a shell variable or workflow expression " + "($ or a backtick) in a cargo deny command that names no " + "`check`, so it cannot be run as CI runs it"
          }
        ];
      }
      continue;
    }
    const wd = ctx.wd === undefined || combination === null ? ctx.wd : substituteMatrix(ctx.wd, combination);
    const cwd = resolveWorkingDirectory(wd);
    if (!cwd.ok) return [
      {
        kind: "unrunnable",
        source,
        reason: cwd.reason
      }
    ];
    findings.push({
      kind: "command",
      argv: dropUnresolved(argv),
      cwd: cwd.cwd,
      ...allowFailureFor(ctx, combination)
    });
  }
  return findings;
}
/**
 * The findings for one logical `run:` line. Every command segment is
 * examined, so `cargo fetch && cargo deny check` is found. A segment's `cd`
 * or other commands are ignored, and the step's working directory applies.
 */ function cargoDenyCommandFindings(line, no, ctx) {
  return splitShellSegments(line).flatMap((segment)=>segmentFindings(segment, no, ctx));
}
/**
 * The findings for one `run:` key of a step. A block scalar gives one shell
 * line per YAML line. A plain value folds its lines into one, as YAML does.
 */ function runFindings(run, ctx) {
  const script = BLOCK_INDICATOR.test(scalarValue(run.raw)) ? run.children : [
    {
      indent: 0,
      text: [
        scalarValue(run.raw),
        ...run.children.map((line)=>line.text.trim())
      ].filter((part)=>part !== "").join(" "),
      no: run.no
    }
  ];
  const findings = [];
  let quote = "";
  for (const command of joinContinuations(script)){
    const startsInQuote = quote !== "";
    for(let i = 0; i < command.text.length; i++){
      const ch = command.text[i];
      if (ch === "\\" && quote !== "'") {
        i++;
        continue;
      }
      if (quote !== "") {
        if (ch === quote) quote = "";
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === "#" && (i === 0 || /\s/.test(command.text[i - 1] ?? ""))) break;
    }
    if (!startsInQuote) {
      findings.push(...cargoDenyCommandFindings(command.text, command.no, ctx));
    }
  }
  return findings;
}
/** The `with:` inputs of an action step, from its child lines. */ function parseWith(children) {
  const inputs = new Map();
  const level = children[0]?.indent;
  for (const child of children){
    if (child.indent !== level) continue;
    const mapping = parseMapping(child.text);
    if (mapping) inputs.set(mapping.key, scalarValue(mapping.raw));
  }
  return inputs;
}
/**
 * The argv the action builds from its inputs, run from the repo root. A
 * `${{ matrix.<key> }}` expression is expanded from the job's literal matrix,
 * one invocation per combination.
 */ function actionFindings(inputs, ctx) {
  const combinations = matrixCombinations(ctx.matrix, matrixKeys([
    ...inputs.values()
  ]), continueKeys(ctx.continueOnError));
  return (combinations ?? [
    null
  ]).flatMap((combination)=>actionVariantFindings(new Map([
      ...inputs
    ].map(([name, value])=>[
        name,
        combination === null ? value : substituteMatrix(value, combination)
      ])), allowFailureFor(ctx, combination)));
}
/**
 * One invocation of the action. An input that still holds a variable or
 * expression cannot be reproduced, so it takes the action's own default: the
 * command becomes a plain `check`, which runs every check and so covers every
 * subset the expression could select.
 */ function actionVariantFindings(inputs, allow) {
  const value = (name)=>{
    const input = inputs.get(name) ?? ACTION_DEFAULTS[name];
    return UNRESOLVED.test(input) ? ACTION_DEFAULTS[name] : input;
  };
  return [
    {
      kind: "command",
      argv: [
        "cargo",
        "deny",
        "--log-level",
        value("log-level"),
        "--manifest-path",
        value("manifest-path"),
        ...splitWords(value("arguments")),
        ...splitWords(value("command")),
        ...splitWords(value("command-arguments"))
      ],
      cwd: ".",
      ...allow
    }
  ];
}
/** Direct children of `all[idx]`: deeper lines, up to the next key at `c`. */ function childrenOf(all, idx, c) {
  const out = [];
  for(let j = idx + 1; j < all.length; j++){
    const line = all[j];
    if (line === undefined || isSkippable(line.text)) continue;
    if (line.indent <= c) break;
    out.push(line);
  }
  return out;
}
/** The findings for one step, which spans lines `start` (the `- `) to `end`. */ function stepFindings(lines, start, end, dashIndent, job, parsed) {
  const afterDash = LIST_ITEM.exec(lines[start] ?? "")?.[2] ?? "";
  const content = afterDash.trimStart();
  const all = [];
  if (content !== "") {
    all.push({
      indent: dashIndent + 1 + (afterDash.length - content.length),
      text: content,
      no: start + 1
    });
  }
  for(let k = start + 1; k < end; k++){
    const text = lines[k] ?? "";
    all.push({
      indent: indentOf(text),
      text,
      no: k + 1
    });
  }
  // The step's own keys sit at one column: after `- ` when the key is on the
  // dash line, otherwise the first key line under a bare `-`.
  const c = content !== "" ? dashIndent + 1 + (afterDash.length - content.length) : all.find((line)=>!isSkippable(line.text))?.indent ?? -1;
  if (c <= dashIndent) return [];
  const keys = [];
  for(let idx = 0; idx < all.length; idx++){
    const line = all[idx];
    if (line === undefined || line.indent !== c || isSkippable(line.text)) {
      continue;
    }
    const mapping = parseMapping(line.text);
    if (!mapping) continue;
    keys.push({
      ...mapping,
      no: line.no,
      children: childrenOf(all, idx, c)
    });
  }
  const find = (name)=>keys.find((key)=>key.key === name);
  if (parsed !== undefined) {
    const ctx = {
      matrix: job.matrix,
      wd: yamlScalar(parsed["working-directory"]) ?? job.defaultWd,
      continueOnError: [
        ...[
          yamlScalar(parsed["continue-on-error"])
        ].filter((v)=>v !== undefined),
        ...job.continueOnError === undefined ? [] : [
          job.continueOnError
        ]
      ]
    };
    const findings = [];
    const uses = yamlScalar(parsed.uses);
    if (uses !== undefined && ACTION_REPO.test(uses)) {
      const inputs = new Map();
      if (parsed.with !== null && typeof parsed.with === "object" && !Array.isArray(parsed.with)) {
        for (const [key, value] of Object.entries(parsed.with)){
          const scalar = yamlScalar(value);
          if (scalar !== undefined) inputs.set(key, scalar);
        }
      }
      findings.push(...actionFindings(inputs, ctx));
    }
    const run = yamlScalar(parsed.run);
    if (run !== undefined) {
      const runKey = find("run");
      const no = (runKey?.no ?? start + 1) + (runKey !== undefined && BLOCK_INDICATOR.test(scalarValue(runKey.raw)) ? 1 : 0);
      findings.push(...runFindings({
        key: "run",
        raw: "|",
        no,
        children: run.split("\n").map((text, i)=>({
            text,
            indent: 0,
            no: no + i
          }))
      }, ctx));
    }
    return findings;
  }
  // A step's own `working-directory` wins over the job's and the workflow's
  // `defaults.run.working-directory`, which apply to `run:` steps only.
  const wdKey = find("working-directory");
  const coeKey = find("continue-on-error");
  const ctx = {
    matrix: job.matrix,
    wd: wdKey === undefined ? job.defaultWd : scalarValue(wdKey.raw),
    continueOnError: [
      ...coeKey === undefined ? [] : [
        scalarValue(coeKey.raw)
      ],
      ...job.continueOnError === undefined ? [] : [
        job.continueOnError
      ]
    ]
  };
  const findings = [];
  const usesKey = find("uses");
  if (usesKey !== undefined && ACTION_REPO.test(scalarValue(usesKey.raw))) {
    const withKey = find("with");
    findings.push(...actionFindings(withKey === undefined ? new Map() : parseWith(withKey.children), ctx));
  }
  for (const key of keys){
    if (key.key === "run") findings.push(...runFindings(key, ctx));
  }
  return findings;
}
/** A parsed YAML scalar as the text GitHub would see, or undefined. */ function yamlScalar(value) {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}
/** The workflow as YAML parsed it, or null when it is not valid YAML. */ function parseWorkflow(text) {
  try {
    const parsed = parseYaml(text);
    // Bare step sequences are accepted by the scanner as workflow fragments.
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch  {
    // GitHub does not run a workflow that is not valid YAML, so CI has no default to mirror.
    return null;
  }
}
/** The most characters of a `paths` or `branches` pattern the gate reads. */ const FILTER_PATTERN_CAP = 200;
/** Read a single-character class without compiling repository input as a regex. */ function filterClass(source) {
  const negated = source.startsWith("^");
  const chars = negated ? source.slice(1) : source;
  if (!chars) return null;
  const ranges = [];
  for(let i = 0; i < chars.length; i++){
    const start = chars.charCodeAt(i);
    if (chars[i + 1] === "-" && i + 2 < chars.length) {
      const end = chars.charCodeAt(i + 2);
      if (start > end) return null;
      ranges.push([
        start,
        end
      ]);
      i += 2;
    } else ranges.push([
      start,
      start
    ]);
  }
  return (ch)=>{
    const code = ch.charCodeAt(0);
    const found = ranges.some(([start, end])=>code >= start && code <= end);
    return negated ? !found : found;
  };
}
/**
 * Match a GitHub filter pattern: `*` is any run but `/`, `**` any run,
 * `?` and `+` apply to the character before them, `[...]` is a class. Null
 * for a pattern the gate cannot read, which the caller treats as a match.
 */ function filterPatternMatches(pattern, name) {
  if (pattern.length > FILTER_PATTERN_CAP) return null;
  const tokens = [];
  for(let i = 0; i < pattern.length; i++){
    const ch = pattern[i] ?? "";
    if (pattern.startsWith("**/", i)) {
      tokens.push({
        kind: "dirs"
      });
      i += 2;
    } else if (ch === "*") {
      if (pattern[i + 1] === "*") {
        tokens.push({
          kind: "globstar"
        });
        i++;
      } else tokens.push({
        kind: "star"
      });
    } else if (ch === "?" || ch === "+") {
      const previous = tokens[tokens.length - 1];
      if (!previous || previous.kind !== "char") return null;
      previous.kind = ch;
    } else if (ch === "[") {
      const close = pattern.indexOf("]", i + 2);
      if (close === -1) return null;
      const matches = filterClass(pattern.slice(i + 1, close));
      if (!matches) return null;
      tokens.push({
        kind: "char",
        matches
      });
      i = close;
    } else {
      if (ch === "\\" && i + 1 < pattern.length) i++;
      const literal = pattern[i];
      tokens.push({
        kind: "char",
        matches: (value)=>value === literal
      });
    }
  }
  let next = Array.from({
    length: name.length + 1
  }, (_, i)=>i === name.length);
  for(let t = tokens.length - 1; t >= 0; t--){
    const token = tokens[t];
    const row = Array(name.length + 1).fill(false);
    let slashMatch = false;
    for(let i = name.length; i >= 0; i--){
      const ch = name[i];
      const matched = ch !== undefined && (token.matches?.(ch) ?? false);
      if (token.kind === "char") row[i] = matched && next[i + 1];
      else if (token.kind === "?") {
        row[i] = next[i] || matched && next[i + 1];
      } else if (token.kind === "+") {
        row[i] = matched && (next[i + 1] || row[i + 1]);
      } else if (token.kind === "dirs") {
        slashMatch ||= ch === "/" && next[i + 1];
        row[i] = next[i] || slashMatch;
      } else {
        row[i] = next[i] || ch !== undefined && (token.kind === "globstar" || ch !== "/") && row[i + 1];
      }
    }
    next = row;
  }
  return next[0];
}
/**
 * Whether the filter patterns select `name`: the last pattern that matches
 * decides, and a leading `!` deselects. Null means the filter is unreadable.
 */ function filterSelects(patterns, name) {
  let selected = false;
  for (const pattern of patterns){
    const negated = pattern.startsWith("!");
    const matches = filterPatternMatches(negated ? pattern.slice(1) : pattern, name);
    if (matches === null) return null;
    if (matches) selected = !negated;
  }
  return selected;
}
function stringList(value) {
  if (typeof value === "string") return [
    value
  ];
  return Array.isArray(value) && value.every((v)=>typeof v === "string") ? value : undefined;
}
/** Whether the names pass an include list and an ignore list (either may be absent). */ function namesPass(names, include, ignore) {
  if (names === undefined) return true;
  if (include !== undefined) {
    return names.some((name)=>filterSelects(include, name) !== false);
  }
  if (ignore !== undefined) {
    return names.some((name)=>filterSelects(ignore, name) !== true);
  }
  return true;
}
/** One `on:` event's filters: an event with no mapping has none. */ function eventFilters(config) {
  return config !== null && typeof config === "object" && !Array.isArray(config) ? config : {};
}
/**
 * Whether CI can run the workflow for a push of these branches and paths:
 * it has a `pull_request`, `pull_request_target`, `merge_group` or
 * `workflow_call` trigger, or a `push` trigger whose branch filter matches;
 * and the trigger's `paths` / `paths-ignore` filter selects a touched path.
 * A `pull_request` `branches` filter is not read (the base branch is not
 * known here), so it matches. A workflow whose triggers cannot be read runs.
 */ function workflowRunsFor(workflow, context) {
  const on = workflow === null ? undefined : workflow.on ?? workflow["true"];
  let events;
  if (typeof on === "string") events = {
    [on]: null
  };
  else if (Array.isArray(on)) {
    events = Object.fromEntries(on.map((event)=>[
        String(event),
        null
      ]));
  } else if (on !== null && typeof on === "object") {
    events = on;
  } else return true;
  const pathsPass = (filters)=>namesPass(context.touched, stringList(filters.paths), stringList(filters["paths-ignore"]));
  return Object.entries(events).some(([event, config])=>{
    const filters = eventFilters(config);
    if (event === "pull_request" || event === "pull_request_target") {
      return pathsPass(filters);
    }
    if (event === "merge_group" || event === "workflow_call") return true;
    if (event !== "push") return false;
    const branches = stringList(filters.branches);
    const branchesIgnore = stringList(filters["branches-ignore"]);
    // A push filtered by tags alone does not run for a branch push.
    if (branches === undefined && branchesIgnore === undefined && (filters.tags !== undefined || filters["tags-ignore"] !== undefined)) return false;
    return namesPass(context.branches, branches, branchesIgnore) && pathsPass(filters);
  });
}
/**
 * The jobs of the workflow: the direct children of the top-level `jobs:` key,
 * at whatever indent the file uses.
 */ function jobBlocks(lines) {
  const jobsAt = lines.findIndex((line)=>/^jobs:\s*(?:#.*)?$/.test(line));
  if (jobsAt === -1) return [];
  const first = lines.slice(jobsAt + 1).find((line)=>!isSkippable(line) && indentOf(line) > 0);
  if (first === undefined) return [];
  const indent = indentOf(first);
  const blocks = [];
  for(let i = jobsAt + 1; i < lines.length; i++){
    const line = lines[i] ?? "";
    if (isSkippable(line)) continue;
    if (indentOf(line) === 0) break;
    if (indentOf(line) !== indent || !/^\s*(?:[\w-]+|"[^"]*"|'[^']*'):\s*(?:&[\w-]+\s*)?(?:#.*)?$/.test(line)) continue;
    let end = i + 1;
    while(end < lines.length && (isSkippable(lines[end] ?? "") || indentOf(lines[end] ?? "") > indent))end++;
    blocks.push({
      header: i,
      end,
      indent
    });
  }
  return blocks;
}
/**
 * Parse one workflow file's text into the cargo-deny invocations its steps
 * make. A step starts at a `- ` line and ends at the next non-blank line at
 * or below its dash's indent. Comment lines are ignored.
 *
 * A workflow CI cannot run for the push (see {@link workflowRunsFor}) has no
 * findings. A `run:` step without its own `working-directory` takes the job's,
 * then the workflow's, `defaults.run.working-directory`. A step's or job's
 * `continue-on-error` marks the invocations it allows to fail.
 *
 * SIMPLE-ON-PURPOSE: `exclude` entries of a matrix, `continue-on-error` tests other than a literal true or one matrix key, a `pull_request` `branches` filter, and script-hidden invocations are not read — upgrade when a cargo deny check run escapes this gate in practice or a workflow uses one of those forms.
 */ export function workflowCargoDenyFindings(text, context = {}) {
  const lines = text.split("\n").map((raw)=>raw.replace(/\r$/, ""));
  const workflow = parseWorkflow(text);
  if (!workflowRunsFor(workflow, context)) return [];
  const findings = [];
  const workflowWd = yamlScalar(workflow?.defaults?.run?.["working-directory"]);
  const jobs = jobBlocks(lines);
  if (workflow !== null) {
    for (const [key, parsedJob] of Object.entries(workflow.jobs ?? {})){
      if (parsedJob === null || !Array.isArray(parsedJob.steps)) continue;
      const job = {
        matrix: parsedJob.strategy?.matrix ?? {},
        defaultWd: yamlScalar(parsedJob.defaults?.run?.["working-directory"]) ?? workflowWd,
        continueOnError: yamlScalar(parsedJob["continue-on-error"])
      };
      const block = jobs.find((candidate)=>{
        const header = (lines[candidate.header] ?? "").trim().replace(/:\s*(?:&[\w-]+\s*)?(?:#.*)?$/, "");
        return (header.startsWith('"') || header.startsWith("'") ? yamlScalar(parseYaml(header)) : header) === key;
      });
      const stepsLine = block === undefined ? -1 : lines.findIndex((line, i)=>i > block.header && i < block.end && /^\s*steps:\s*(?:&[\w-]+\s*)?(?:#.*)?$/.test(line) && indentOf(line) > block.indent);
      const locations = [];
      if (block !== undefined && stepsLine !== -1) {
        const stepsIndent = indentOf(lines[stepsLine] ?? "");
        for(let i = stepsLine + 1; i < block.end;){
          const line = lines[i] ?? "";
          const item = LIST_ITEM.exec(line);
          if (!isSkippable(line) && (indentOf(line) < stepsIndent || indentOf(line) === stepsIndent && item === null)) break;
          if (item === null) {
            i++;
            continue;
          }
          const indent = (item[1] ?? "").length;
          let end = i + 1;
          while(end < block.end && (isSkippable(lines[end] ?? "") || indentOf(lines[end] ?? "") > indent))end++;
          locations.push({
            start: i,
            end,
            indent
          });
          i = end;
        }
      }
      for (const [index, step] of parsedJob.steps.entries()){
        if (step === null || typeof step !== "object" || Array.isArray(step)) {
          continue;
        }
        const loc = locations[index];
        findings.push(...loc === undefined ? stepFindings([
          "- step: parsed"
        ], 0, 1, 0, job, step).map((finding)=>finding.kind === "unrunnable" ? {
            ...finding,
            source: `job ${key} step ${index + 1}`
          } : finding) : stepFindings(lines, loc.start, loc.end, loc.indent, job, step));
      }
    }
    return findings;
  }
  let start = 0;
  while(start < lines.length){
    const item = LIST_ITEM.exec(lines[start] ?? "");
    const afterDash = item?.[2] ?? "";
    if (item === null || afterDash !== "" && !/^\s/.test(afterDash)) {
      start++;
      continue;
    }
    const dashIndent = (item[1] ?? "").length;
    let end = start + 1;
    while(end < lines.length){
      const line = lines[end] ?? "";
      if (!isSkippable(line) && indentOf(line) <= dashIndent) break;
      end++;
    }
    const job = {
      matrix: {},
      defaultWd: workflowWd,
      continueOnError: undefined
    };
    findings.push(...stepFindings(lines, start, end, dashIndent, job));
    start = end;
  }
  return findings;
}
/**
 * Locate the repository's cargo-deny invocations. Reads every tracked
 * `.github/workflows/*.yml|yaml`, but reports nothing for a workflow CI does
 * not run for the push described by `context` (a `schedule`-only trigger, a
 * non-matching `branches` filter, or a `paths` filter selecting none of the
 * touched paths). A workflow that cannot be read is one
 * unrunnable finding naming that file (fail closed).
 */ export async function repoCargoDenyFindings(repoRoot, tracked, context = {}) {
  const findings = [];
  for (const path of tracked){
    if (!path.startsWith(".github/workflows/")) continue;
    if (!/\.ya?ml$/.test(path)) continue;
    let text;
    try {
      text = await Deno.readTextFile(`${repoRoot}/${path}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      findings.push({
        kind: "unrunnable",
        source: path,
        reason: `the workflow file could not be read (${detail}), so its ` + `cargo-deny steps cannot be checked`
      });
      continue;
    }
    for (const finding of workflowCargoDenyFindings(text, context)){
      findings.push(finding.kind === "unrunnable" ? {
        ...finding,
        source: `${path} ${finding.source}`
      } : finding);
    }
  }
  return findings;
}
/**
 * Whether a push touches a file that changes the cargo-deny result: a
 * manifest, lock file, deny config, or cargo config.
 */ export function cargoDenyTriggered(changed) {
  return changed.some((path)=>{
    const base = path.slice(path.lastIndexOf("/") + 1);
    return TRIGGER_BASENAMES.has(base) || TRIGGER_CARGO_CONFIG.test(path);
  });
}
/** The output split into lines, each capped at {@link LINE_CAP} characters. */ function outputLines(output) {
  return output.split("\n").map((line)=>line.replace(/\r$/, "").slice(0, LINE_CAP));
}
/** Redact URL credentials (`//user:token@` becomes `//***@`). */ function redactUrlCredentials(text) {
  return text.replace(URL_CREDENTIALS, "//***@");
}
function infrastructure(cause) {
  return {
    kind: "infrastructure",
    message: `${INFRA_PREFIX}"${redactUrlCredentials(cause)}"`
  };
}
/**
 * Classify a failed cargo-deny run (Issue #4626).
 *
 * - `not-started` and `timeout` are infrastructure.
 * - `non-zero-exit` with an `error[code]` diagnostic is a verdict, whatever
 *   else the output says.
 * - `non-zero-exit` with a line that begins with a tool-unavailability
 *   message is infrastructure.
 * - Any other non-zero exit is a verdict (fail closed).
 */ export function classifyCargoDenyFailure(error) {
  const lines = outputLines(error.output);
  const firstLine = lines.find((line)=>line.trim() !== "")?.trim();
  if (error.reason === "not-started") {
    return infrastructure(firstLine ?? "cargo deny could not be started (no error text captured)");
  }
  if (error.reason === "timeout") {
    return infrastructure(firstLine ?? "cargo deny timed out (no output captured)");
  }
  const verdict = {
    kind: "verdict",
    message: error.message
  };
  if (lines.some((line)=>VERDICT_LINE.test(line))) return verdict;
  const cause = lines.find((line)=>TOOL_UNAVAILABLE.some((re)=>re.test(line.replace(LOG_PREFIX, ""))));
  if (cause !== undefined) return infrastructure(cause);
  return verdict;
}
/** Quote one argv entry for the pre-flight tokeniser, or null if impossible. */ export function quoteArg(value) {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return null;
}
/**
 * Run the cargo-deny gate (Issue #4626). Intermediate pushes without cargo
 * inputs skip it unless `always` is set. The first failed check stops the gate.
 * An invocation CI allows to fail (`allowFailure`) runs after the others and
 * never stops the gate: its failure is a warning in the result, as it is
 * in CI. An identical invocation that CI does not allow to fail blocks.
 */ export async function runCargoDenyGate(opts) {
  if (!opts.always && !cargoDenyTriggered(opts.changed)) {
    return {
      ok: true,
      value: {
        checksRun: [],
        warnings: []
      }
    };
  }
  const findings = opts.findings ?? await repoCargoDenyFindings(opts.cwd, opts.tracked, opts.context);
  for (const finding of findings){
    if (finding.kind === "unrunnable") {
      return {
        ok: false,
        error: {
          kind: "verdict",
          message: `cargo deny is part of this repository's CI but its ` + `invocation cannot be reproduced locally (${finding.source}: ` + `${finding.reason}) — the push is blocked, not waved through`
        }
      };
    }
  }
  const checks = new Map();
  for (const finding of findings){
    if (finding.kind !== "command") continue;
    const key = JSON.stringify([
      finding.argv,
      finding.cwd
    ]);
    const allowFailure = finding.allowFailure === true;
    const seen = checks.get(key);
    if (seen !== undefined) {
      seen.allowFailure = seen.allowFailure && allowFailure;
      continue;
    }
    const parts = [];
    for (const arg of finding.argv){
      const quoted = quoteArg(arg);
      if (quoted === null) {
        return {
          ok: false,
          error: {
            kind: "verdict",
            message: `cargo deny argument ${JSON.stringify(arg)} contains ` + `both ' and " and cannot be quoted for the pre-flight runner ` + `— the push is blocked, not waved through`
          }
        };
      }
      parts.push(quoted);
    }
    checks.set(key, {
      command: parts.join(" "),
      cwd: finding.cwd === "." ? opts.cwd : `${opts.cwd}/${finding.cwd}`,
      allowFailure
    });
  }
  const checksRun = [];
  const warnings = [];
  const ordered = [
    ...checks.values()
  ];
  for (const check of [
    ...ordered.filter((item)=>!item.allowFailure),
    ...ordered.filter((item)=>item.allowFailure)
  ]){
    const result = await runPreFlightGate([
      check.command
    ], {
      cwd: check.cwd,
      runner: opts.runner,
      timeoutSeconds: opts.timeoutSeconds
    });
    if (!result.ok) {
      const error = classifyCargoDenyFailure(result.error);
      if (!check.allowFailure) return {
        ok: false,
        error
      };
      warnings.push(`${check.command} failed, which CI allows (continue-on-error), so ` + `the push is not blocked: ${error.message.slice(0, WARNING_CAP)}`);
      continue;
    }
    checksRun.push(check.command);
  }
  return {
    ok: true,
    value: {
      checksRun,
      warnings
    }
  };
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jYXJnb19kZW55X2dhdGUudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBDYXJnby1kZW55IENJIGdhdGUgKElzc3VlICM0NjI2KS5cbiAqXG4gKiBDSSBydW5zIGBjYXJnbyBkZW55IGNoZWNrYCBvbiBmbGVldCBQUnMsIGJ1dCB0aGUgTWFjLXNpZGUgcHVzaCBnYXRlcyBuZXZlclxuICogcmFuIGl0LCBzbyBhIGRlcGVuZGVuY3ktYXVkaXQgZmFpbHVyZSBvbmx5IHN1cmZhY2VkIGFmdGVyIHRoZSBwdXNoLiBUaGlzXG4gKiBtb2R1bGUgcmVhZHMgdGhlIHJlcG9zaXRvcnkncyBvd24gd29ya2Zsb3dzLCBmaW5kcyB0aGUgY2FyZ28tZGVueVxuICogaW52b2NhdGlvbnMgQ0kgbWFrZXMsIGFuZCBoYW5kcyB0aGUgcHJlLXB1c2ggZ2F0ZSB0aGUgc2FtZSBhcmd2IHRvIHJ1blxuICogbG9jYWxseS5cbiAqXG4gKiBGYWlsIGNsb3NlZC4gQSBDSSBpbnZvY2F0aW9uIHRoYXQgY2Fubm90IGJlIHJlcHJvZHVjZWQgbG9jYWxseSBibG9ja3MgdGhlXG4gKiBwdXNoLiBBIGZhaWx1cmUgdGhhdCBzaG93cyB0aGUgdG9vbCBpdHNlbGYgaXMgdW5hdmFpbGFibGUgKG5vIG5ldHdvcmssIG5vXG4gKiBhZHZpc29yeSBkYXRhYmFzZSwgbm8gY2FyZ28tZGVueSBiaW5hcnkpIGlzIGFuIGluZnJhc3RydWN0dXJlIGRlZmVycmFsLFxuICogbmV2ZXIgYSBwYXNzIGFuZCBuZXZlciBhIHZlcmRpY3QuIEFueSBvdGhlciBub24temVybyBleGl0IGlzIGEgdmVyZGljdCwgdW5sZXNzIENJIGFsbG93cyB0aGVcbiAqIGludm9jYXRpb24gdG8gZmFpbCAoc2VlIGJlbG93KSwgd2hlbiBpdCBpcyBhIHdhcm5pbmcuXG4gKlxuICogVGhlIGdhdGUgbmV2ZXIgYWRkcyBgLS1vZmZsaW5lYCwgYW4gaWdub3JlIGxpc3Qgb3IgYSByZWR1Y2VkLXNjb3BlIGZsYWcuXG4gKiBBIGAke3sgbWF0cml4LjxrZXk+IH19YCBleHByZXNzaW9uIGlzIGV4cGFuZGVkIGZyb20gdGhlIGpvYidzIGxpdGVyYWxcbiAqIG1hdHJpeCwgb25lIGludm9jYXRpb24gcGVyIGNvbWJpbmF0aW9uLiBBbiBleHByZXNzaW9uIG9yIHZhcmlhYmxlIHRoYXRcbiAqIGNhbm5vdCBiZSBleHBhbmRlZCBpcyBkcm9wcGVkLCB0b2dldGhlciB3aXRoIHRoZSBvcHRpb24gaXQgd2FzIHRoZSB2YWx1ZSBvZixcbiAqIHNvIHRoZSBpbnZvY2F0aW9uIHJ1bnMgYSBwbGFpbiBgY2hlY2tgIChldmVyeSBjaGVjaywgc28gZXZlcnkgc3Vic2V0KSB3aXRoXG4gKiB0aGUgYWN0aW9uJ3MgZGVmYXVsdHMuIE9ubHkgYSBgY2FyZ28gZGVueWAgbGluZSB0aGF0IG5hbWVzIG5vIGBjaGVja2AgYW5kXG4gKiBob2xkcyBvbmUsIG9yIGEgd29ya2luZyBkaXJlY3RvcnkgdGhhdCBjYW5ub3QgYmUgcmVzb2x2ZWQsIHN0YXlzIHVucnVubmFibGUuXG4gKlxuICogQW4gaW52b2NhdGlvbiBDSSBhbGxvd3MgdG8gZmFpbCAoYGNvbnRpbnVlLW9uLWVycm9yYCBvbiBpdHMgc3RlcCBvciBqb2I6IGFcbiAqIGxpdGVyYWwgdHJ1ZSwgb3IgYSBgbWF0cml4LjxrZXk+YCB0ZXN0IGV2YWx1YXRlZCBmb3IgZWFjaCBjb21iaW5hdGlvbikgc3RpbGxcbiAqIHJ1bnMsIGJ1dCBhIGZhaWx1cmUgaXMgYSB3YXJuaW5nLCBuZXZlciBhIHZlcmRpY3QuXG4gKlxuICogQSB3b3JrZmxvdyBDSSBkb2VzIG5vdCBydW4gZm9yIHRoZSBwdXNoIChhIGBzY2hlZHVsZWAtb25seSBhdWRpdCwgb3IgYVxuICogYHBhdGhzYCBmaWx0ZXIgdGhhdCBzZWxlY3RzIG5vbmUgb2YgdGhlIGJyYW5jaCdzIHRvdWNoZWQgcGF0aHMpIGlzIG5vdCByZWFkOlxuICogdGhvc2UgdHJpZ2dlciBhbmQgcGF0aCBjYXNlcyBkbyBub3QgY2F1c2UgYW4gZXh0cmEgY2hlY2suXG4gKlxuICogVXNlcyBBdXN0cmFsaWFuIEVuZ2xpc2ggdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBjb2xvdXIsIG9yZ2FuaXNhdGlvbikuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBSZXN1bHQgfSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbi8vIFJldmlld2VyIGVudHJ5IHBvaW50cyBhbHNvIGxvYWQgdGhpcyBtb2R1bGUgb3V0c2lkZSB0aGUgd29ya2VyJ3MgaW1wb3J0IG1hcC5cbi8vIGRlbm8tbGludC1pZ25vcmUgbm8taW1wb3J0LXByZWZpeFxuaW1wb3J0IHsgcGFyc2UgYXMgcGFyc2VZYW1sIH0gZnJvbSBcImpzcjpAc3RkL3lhbWxAXjEuMC4xMi9wYXJzZVwiO1xuaW1wb3J0IHtcbiAgdHlwZSBQcmVGbGlnaHRHYXRlRXJyb3IsXG4gIHR5cGUgUHJlRmxpZ2h0UnVubmVyLFxuICBydW5QcmVGbGlnaHRHYXRlLFxuICB0b2tlbmlzZUNvbW1hbmQsXG59IGZyb20gXCIuL3ByZV9mbGlnaHRfZ2F0ZS50c1wiO1xuXG4vKiogT25lIGNhcmdvLWRlbnkgaW52b2NhdGlvbiBDSSBtYWtlcywgb3IgYSBDSSBpbnZvY2F0aW9uIHdlIGNhbm5vdCByZXByb2R1Y2UuICovXG5leHBvcnQgdHlwZSBDYXJnb0RlbnlDaUZpbmRpbmcgPVxuICB8IHtcbiAgICBraW5kOiBcImNvbW1hbmRcIjtcbiAgICBhcmd2OiBzdHJpbmdbXTtcbiAgICBjd2Q6IHN0cmluZztcbiAgICAvKiogQ0kgYWxsb3dzIHRoaXMgaW52b2NhdGlvbiB0byBmYWlsIChgY29udGludWUtb24tZXJyb3JgKTsgc2V0IG9ubHkgd2hlbiB0cnVlLiAqL1xuICAgIGFsbG93RmFpbHVyZT86IHRydWU7XG4gIH1cbiAgfCB7IGtpbmQ6IFwidW5ydW5uYWJsZVwiOyBzb3VyY2U6IHN0cmluZzsgcmVhc29uOiBzdHJpbmcgfTtcblxuLyoqIEEgY2FyZ28tZGVueSBnYXRlIGZhaWx1cmU6IGEgcmVhbCB2ZXJkaWN0LCBvciB0aGUgdG9vbCBjb3VsZCBub3QgcnVuLiAqL1xuZXhwb3J0IHR5cGUgQ2FyZ29EZW55R2F0ZUVycm9yID0ge1xuICBraW5kOiBcInZlcmRpY3RcIiB8IFwiaW5mcmFzdHJ1Y3R1cmVcIjtcbiAgbWVzc2FnZTogc3RyaW5nO1xufTtcblxuLyoqIFRoZSBtb3N0IGNoYXJhY3RlcnMgb2YgYSBmYWlsZWQgY2hlY2sncyBvdXRwdXQga2VwdCBpbiBhIHdhcm5pbmcuICovXG5jb25zdCBXQVJOSU5HX0NBUCA9IDEwMDA7XG5cbi8qKiBMb25nZXN0IGxpbmUgdGhlIHBhcnNlcidzIG1lc3NhZ2VzIGFuZCB0aGUgY2xhc3NpZmllciB3aWxsIGV4YW1pbmUuICovXG5jb25zdCBMSU5FX0NBUCA9IDIwMDA7XG5cbmNvbnN0IElORlJBX1BSRUZJWCA9XG4gIFwiY2FyZ28gZGVueSBjb3VsZCBub3QgcnVuLCBzbyB0aGUgZGVwZW5kZW5jeSBhdWRpdCB3YXMgbm90IGNoZWNrZWQgKHRoaXMgaXMgbm90IGEgcGFzcyk6IFwiO1xuXG4vKiogQSBZQU1MIGxpc3QgaXRlbSwgYC0gYCBhdCB0aGUgc3RhcnQgb2YgYSBsaW5lIChhIHdvcmtmbG93IHN0ZXApLiAqL1xuY29uc3QgTElTVF9JVEVNID0gL14oXFxzKiktKC4qKSQvO1xuY29uc3QgTUFQUElOR19LRVkgPSAvXihbQS1aYS16X11bXFx3LV0qKTooLiopJC87XG5jb25zdCBCTE9DS19JTkRJQ0FUT1IgPSAvXlt8Pl1bLSswLTldKiQvO1xuY29uc3QgQ0FSR09fREVOWV9TVEFSVCA9IC9eY2FyZ29cXHMrZGVueVxcYi87XG5jb25zdCBBQ1RJT05fUkVQTyA9IC9eZW1iYXJrc3R1ZGlvc1xcL2NhcmdvLWRlbnktYWN0aW9uKD86QHwkKS9pO1xuY29uc3QgVFJJR0dFUl9CQVNFTkFNRVMgPSBuZXcgU2V0KFtcbiAgXCJDYXJnby50b21sXCIsXG4gIFwiQ2FyZ28ubG9ja1wiLFxuICBcImRlbnkudG9tbFwiLFxuICBcIi5kZW55LnRvbWxcIixcbl0pO1xuY29uc3QgVFJJR0dFUl9DQVJHT19DT05GSUcgPSAvKD86XnxcXC8pXFwuY2FyZ29cXC8oPzpjb25maWd8ZGVueSlcXC50b21sJC87XG5cbi8qKiBBIGRpYWdub3N0aWMgZnJvbSBjYXJnby1kZW55IGl0c2VsZjogYSB2ZXJkaWN0IG9uIHRoZSBkZXBlbmRlbmN5IGdyYXBoLiAqL1xuY29uc3QgVkVSRElDVF9MSU5FID0gL15lcnJvclxcW1thLXowLTktXStcXF0vO1xuLyoqIE9wdGlvbmFsIGAyMDI2LTExLTA3IDE4OjA0OjMxIFtFUlJPUl0gYCBzdHlsZSBwcmVmaXggb24gYSBsb2cgbGluZS4gKi9cbmNvbnN0IExPR19QUkVGSVggPSAvXig/OlxcZHs0fS1cXGR7Mn0tXFxkezJ9IFxcZHsyfTpcXGR7Mn06XFxkezJ9ICk/KD86XFxbW0EtWl0rXFxdICk/LztcbmNvbnN0IFVSTF9DUkVERU5USUFMUyA9IC9cXC9cXC9bXlxccy9AXStAL2c7XG5cbi8qKlxuICogTGluZXMgdGhhdCBzaG93IHRoZSB0b29sIGNvdWxkIG5vdCByZWFjaCBpdHMgaW5wdXRzLiBFYWNoIGlzIG1hdGNoZWRcbiAqIGFuY2hvcmVkIGF0IHRoZSBzdGFydCBvZiBhIGxpbmUgKGFmdGVyIHRoZSBsb2cgcHJlZml4KSwgbmV2ZXIgYXMgYVxuICogc3Vic3RyaW5nIG9mIHRoZSBvdXRwdXQuXG4gKi9cbmNvbnN0IFRPT0xfVU5BVkFJTEFCTEU6IHJlYWRvbmx5IFJlZ0V4cFtdID0gW1xuICAvXmZhaWxlZCB0byBmZXRjaCBhZHZpc29yeSBkYXRhYmFzZS8sXG4gIC9eZmF0YWw6IHVuYWJsZSB0byBhY2Nlc3MvLFxuICAvXmVycm9yOiBubyBzdWNoIGNvbW1hbmQ6IGBkZW55YC8sXG4gIC9eKD86KD86d2FybmluZ3xlcnJvcik6ICk/c3B1cmlvdXMgbmV0d29yayBlcnJvci8sXG4gIC9eZmFpbGVkIHRvIGRvd25sb2FkLyxcbiAgL15kb3dubG9hZCBvZiBjb25maWdcXC5qc29uIGZhaWxlZC8sXG4gIC9eQ291bGQgbm90IHJlc29sdmUgaG9zdC8sXG4gIC9eQ291bGRuJ3QgcmVzb2x2ZSBob3N0LyxcbiAgL15OZXR3b3JrIGlzIHVucmVhY2hhYmxlLyxcbiAgL15Db25uZWN0aW9uICg/OnJlZnVzZWR8dGltZWQgb3V0fHJlc2V0KS8sXG5dO1xuXG4vKiogVGhlIGFjdGlvbidzIGlucHV0IGRlZmF1bHRzIChFbWJhcmtTdHVkaW9zL2NhcmdvLWRlbnktYWN0aW9uIGFjdGlvbi55bWwpLiAqL1xuY29uc3QgQUNUSU9OX0RFRkFVTFRTID0ge1xuICBcImxvZy1sZXZlbFwiOiBcIndhcm5cIixcbiAgXCJtYW5pZmVzdC1wYXRoXCI6IFwiLi9DYXJnby50b21sXCIsXG4gIGFyZ3VtZW50czogXCItLWFsbC1mZWF0dXJlc1wiLFxuICBjb21tYW5kOiBcImNoZWNrXCIsXG4gIFwiY29tbWFuZC1hcmd1bWVudHNcIjogXCJcIixcbn0gYXMgY29uc3Q7XG50eXBlIEFjdGlvbklucHV0ID0ga2V5b2YgdHlwZW9mIEFDVElPTl9ERUZBVUxUUztcblxuaW50ZXJmYWNlIFlhbWxMaW5lIHtcbiAgaW5kZW50OiBudW1iZXI7XG4gIHRleHQ6IHN0cmluZztcbiAgbm86IG51bWJlcjtcbn1cblxuaW50ZXJmYWNlIE1hcHBpbmdMaW5lIHtcbiAga2V5OiBzdHJpbmc7XG4gIHJhdzogc3RyaW5nO1xuICBubzogbnVtYmVyO1xuICBjaGlsZHJlbjogWWFtbExpbmVbXTtcbn1cblxudHlwZSBXb3JrRGlyID0geyBvazogdHJ1ZTsgY3dkOiBzdHJpbmcgfSB8IHsgb2s6IGZhbHNlOyByZWFzb246IHN0cmluZyB9O1xuXG5mdW5jdGlvbiBpbmRlbnRPZihsaW5lOiBzdHJpbmcpOiBudW1iZXIge1xuICByZXR1cm4gbGluZS5sZW5ndGggLSBsaW5lLnRyaW1TdGFydCgpLmxlbmd0aDtcbn1cblxuZnVuY3Rpb24gaXNTa2lwcGFibGUodGV4dDogc3RyaW5nKTogYm9vbGVhbiB7XG4gIGNvbnN0IHQgPSB0ZXh0LnRyaW0oKTtcbiAgcmV0dXJuIHQgPT09IFwiXCIgfHwgdC5zdGFydHNXaXRoKFwiI1wiKTtcbn1cblxuLyoqIFNwbGl0IGBrZXk6IHZhbHVlYCAodGhlIGtleSBtdXN0IGJlIGEgcGxhaW4gaWRlbnRpZmllcikuICovXG5mdW5jdGlvbiBwYXJzZU1hcHBpbmcodGV4dDogc3RyaW5nKTogeyBrZXk6IHN0cmluZzsgcmF3OiBzdHJpbmcgfSB8IG51bGwge1xuICBjb25zdCBtID0gTUFQUElOR19LRVkuZXhlYyh0ZXh0LnRyaW0oKSk7XG4gIGlmICghbSkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IGFmdGVyID0gbVsyXSA/PyBcIlwiO1xuICBpZiAoYWZ0ZXIgIT09IFwiXCIgJiYgIS9eXFxzLy50ZXN0KGFmdGVyKSkgcmV0dXJuIG51bGw7XG4gIHJldHVybiB7IGtleTogbVsxXSA/PyBcIlwiLCByYXc6IGFmdGVyLnRyaW0oKSB9O1xufVxuXG4vKipcbiAqIEEgWUFNTCBzY2FsYXIncyB2YWx1ZTogYSBwbGFpbiB2YWx1ZSBsb3NlcyBpdHMgYCAjYCBjb21tZW50LCBhbmQgYSBxdW90ZWRcbiAqIHZhbHVlIGxvc2VzIGl0cyBxdW90ZXMsIHNvIGBydW46IFwiY2FyZ28gZGVueSBjaGVja1wiYCBpcyBzdGlsbCBzZWVuLlxuICovXG5mdW5jdGlvbiBzY2FsYXJWYWx1ZShyYXc6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCB2ID0gcmF3LnRyaW0oKTtcbiAgaWYgKHYuc3RhcnRzV2l0aChcIiNcIikpIHJldHVybiBcIlwiO1xuICBpZiAoIS9eW1wiJ10vLnRlc3QodikpIHtcbiAgICBjb25zdCBjb21tZW50ID0gdi5zZWFyY2goL1xccyMvKTtcbiAgICBpZiAoY29tbWVudCAhPT0gLTEpIHYgPSB2LnNsaWNlKDAsIGNvbW1lbnQpLnRyaW1FbmQoKTtcbiAgfVxuICBjb25zdCBxdW90ZSA9IHYuY2hhckF0KDApO1xuICBpZiAoXG4gICAgdi5sZW5ndGggPj0gMiAmJiAocXVvdGUgPT09ICdcIicgfHwgcXVvdGUgPT09IFwiJ1wiKSAmJiB2LmVuZHNXaXRoKHF1b3RlKVxuICApIHtcbiAgICByZXR1cm4gdi5zbGljZSgxLCAtMSk7XG4gIH1cbiAgcmV0dXJuIHY7XG59XG5cbmZ1bmN0aW9uIHNwbGl0V29yZHModmFsdWU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIHZhbHVlLnNwbGl0KC9cXHMrLykuZmlsdGVyKCh3b3JkKSA9PiB3b3JkICE9PSBcIlwiKTtcbn1cblxuLyoqXG4gKiBDdXQgYSBzaGVsbCBjb21tYW5kIGF0IGl0cyBmaXJzdCB1bnF1b3RlZCBvcGVyYXRvciAoYCYmYCwgYHx8YCwgYDtgLCBgfGAsXG4gKiBgJmAsIGEgcmVkaXJlY3QpIG9yIGNvbW1lbnQuIFRoZSBkaWdpdCBvZiBhIGAyPiYxYCBmaWxlIGRlc2NyaXB0b3IgZ29lc1xuICogd2l0aCB0aGUgcmVkaXJlY3QsIHNvIGl0IGRvZXMgbm90IGJlY29tZSBhbiBhcmd1bWVudC5cbiAqL1xuZnVuY3Rpb24gY3V0QXRTaGVsbE9wZXJhdG9yKGNvbW1hbmQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIGxldCBxdW90ZSA9IFwiXCI7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgY29tbWFuZC5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGNoID0gY29tbWFuZC5jaGFyQXQoaSk7XG4gICAgaWYgKHF1b3RlICE9PSBcIlwiKSB7XG4gICAgICBpZiAoY2ggPT09IHF1b3RlKSBxdW90ZSA9IFwiXCI7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgaWYgKGNoID09PSAnXCInIHx8IGNoID09PSBcIidcIikge1xuICAgICAgcXVvdGUgPSBjaDtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBzdGFydHNXb3JkID0gaSA9PT0gMCB8fCAvXFxzLy50ZXN0KGNvbW1hbmQuY2hhckF0KGkgLSAxKSk7XG4gICAgaWYgKGNoID09PSBcIiNcIiAmJiBzdGFydHNXb3JkKSByZXR1cm4gY29tbWFuZC5zbGljZSgwLCBpKTtcbiAgICBpZiAoXCImfDs8PlwiLmluY2x1ZGVzKGNoKSkge1xuICAgICAgY29uc3QgZmREaWdpdCA9IChjaCA9PT0gXCI+XCIgfHwgY2ggPT09IFwiPFwiKSAmJlxuICAgICAgICAvXFxkLy50ZXN0KGNvbW1hbmQuY2hhckF0KGkgLSAxKSkgJiZcbiAgICAgICAgKGkgPT09IDEgfHwgL1xccy8udGVzdChjb21tYW5kLmNoYXJBdChpIC0gMikpKTtcbiAgICAgIHJldHVybiBjb21tYW5kLnNsaWNlKDAsIGZkRGlnaXQgPyBpIC0gMSA6IGkpO1xuICAgIH1cbiAgfVxuICByZXR1cm4gY29tbWFuZDtcbn1cblxuLyoqXG4gKiBKb2luIGJhY2tzbGFzaC1jb250aW51ZWQgbGluZXMgaW50byBvbmUgbG9naWNhbCBjb21tYW5kIGVhY2guIEEgbGluZVxuICogZW5kaW5nIGluIGBcXGAgY29udGludWVzIG9udG8gdGhlIG5leHQgbGluZS5cbiAqL1xuZnVuY3Rpb24gam9pbkNvbnRpbnVhdGlvbnMoXG4gIGxpbmVzOiByZWFkb25seSBZYW1sTGluZVtdLFxuKTogeyB0ZXh0OiBzdHJpbmc7IG5vOiBudW1iZXIgfVtdIHtcbiAgY29uc3QgY29tbWFuZHM6IHsgdGV4dDogc3RyaW5nOyBubzogbnVtYmVyIH1bXSA9IFtdO1xuICBsZXQgcGVuZGluZzogeyB0ZXh0OiBzdHJpbmc7IG5vOiBudW1iZXIgfSB8IG51bGwgPSBudWxsO1xuICBmb3IgKGNvbnN0IGxpbmUgb2YgbGluZXMpIHtcbiAgICBjb25zdCBwaWVjZSA9IGxpbmUudGV4dC50cmltKCk7XG4gICAgcGVuZGluZyA9IHBlbmRpbmcgPT09IG51bGxcbiAgICAgID8geyB0ZXh0OiBwaWVjZSwgbm86IGxpbmUubm8gfVxuICAgICAgOiB7IHRleHQ6IGAke3BlbmRpbmcudGV4dH0gJHtwaWVjZX1gLCBubzogcGVuZGluZy5ubyB9O1xuICAgIGlmIChwZW5kaW5nLnRleHQuZW5kc1dpdGgoXCJcXFxcXCIpKSB7XG4gICAgICBwZW5kaW5nID0geyB0ZXh0OiBwZW5kaW5nLnRleHQuc2xpY2UoMCwgLTEpLnRyaW1FbmQoKSwgbm86IHBlbmRpbmcubm8gfTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb21tYW5kcy5wdXNoKHBlbmRpbmcpO1xuICAgIHBlbmRpbmcgPSBudWxsO1xuICB9XG4gIGlmIChwZW5kaW5nICE9PSBudWxsKSBjb21tYW5kcy5wdXNoKHBlbmRpbmcpO1xuICByZXR1cm4gY29tbWFuZHM7XG59XG5cbi8qKiBXaGF0IGEgc3RlcCBpbmhlcml0cyBmcm9tIGl0cyBqb2IgYW5kIHdvcmtmbG93LiAqL1xuaW50ZXJmYWNlIEpvYkNvbnRleHQge1xuICBtYXRyaXg6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAvKiogYGRlZmF1bHRzLnJ1bi53b3JraW5nLWRpcmVjdG9yeWAgb2YgdGhlIGpvYiwgZWxzZSBvZiB0aGUgd29ya2Zsb3cuICovXG4gIGRlZmF1bHRXZDogc3RyaW5nIHwgdW5kZWZpbmVkO1xuICAvKiogVGhlIGpvYidzIGBjb250aW51ZS1vbi1lcnJvcmAsIGFzIHdyaXR0ZW4uICovXG4gIGNvbnRpbnVlT25FcnJvcjogc3RyaW5nIHwgdW5kZWZpbmVkO1xufVxuXG4vKiogVGhlIHN0ZXAtbGV2ZWwgdmlldyBvZiBvbmUgc3RlcCwgd2l0aCB0aGUgam9iJ3MgY29udGV4dCBmb2xkZWQgaW4uICovXG5pbnRlcmZhY2UgU3RlcENvbnRleHQge1xuICBtYXRyaXg6IFJlY29yZDxzdHJpbmcsIHVua25vd24+O1xuICAvKiogVGhlIGB3b3JraW5nLWRpcmVjdG9yeWAgYSBgcnVuOmAgY29tbWFuZCBleGVjdXRlcyBpbiwgYXMgd3JpdHRlbi4gKi9cbiAgd2Q6IHN0cmluZyB8IHVuZGVmaW5lZDtcbiAgLyoqIEV2ZXJ5IGBjb250aW51ZS1vbi1lcnJvcmAgdmFsdWUgdGhhdCBhcHBsaWVzICh0aGUgc3RlcCdzLCB0aGVuIHRoZSBqb2IncykuICovXG4gIGNvbnRpbnVlT25FcnJvcjogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbi8qKiBUaGUgd29ya2luZyBkaXJlY3RvcnkgYSBzdGVwJ3MgcnVuIGNvbW1hbmRzIGV4ZWN1dGUgaW4uICovXG5mdW5jdGlvbiByZXNvbHZlV29ya2luZ0RpcmVjdG9yeSh3ZDogc3RyaW5nIHwgdW5kZWZpbmVkKTogV29ya0RpciB7XG4gIGlmICh3ZCA9PT0gdW5kZWZpbmVkIHx8IHdkID09PSBcIlwiKSByZXR1cm4geyBvazogdHJ1ZSwgY3dkOiBcIi5cIiB9O1xuICBpZiAod2Quc3RhcnRzV2l0aChcIi9cIikgfHwgd2QuaW5jbHVkZXMoXCIuLlwiKSB8fCAvWyR7XS8udGVzdCh3ZCkpIHtcbiAgICByZXR1cm4ge1xuICAgICAgb2s6IGZhbHNlLFxuICAgICAgcmVhc29uOiBgd29ya2luZy1kaXJlY3RvcnkgXCIke3dkfVwiIGlzIG5vdCBhIHBsYWluIHJlbGF0aXZlIHBhdGggYCArXG4gICAgICAgIGAoaXQgdXNlcyBcIi4uXCIsIGEgc2hlbGwgdmFyaWFibGUsIGEgd29ya2Zsb3cgZXhwcmVzc2lvbiBvciBhbiBgICtcbiAgICAgICAgYGFic29sdXRlIHBhdGgpLCBzbyB0aGUgZGlyZWN0b3J5IGNhbm5vdCBiZSByZXByb2R1Y2VkIGxvY2FsbHlgLFxuICAgIH07XG4gIH1cbiAgcmV0dXJuIHsgb2s6IHRydWUsIGN3ZDogd2QgfTtcbn1cblxuLyoqIGBOQU1FPWAgYXQgdGhlIHN0YXJ0IG9mIGEgc2hlbGwgY29tbWFuZDogYW4gZW52aXJvbm1lbnQgYXNzaWdubWVudC4gKi9cbmNvbnN0IEVOVl9BU1NJR05NRU5UID0gL15bQS1aYS16X11cXHcqPS87XG5cbi8qKlxuICogU3BsaXQgYSBzaGVsbCBsaW5lIGludG8gaXRzIGNvbW1hbmQgc2VnbWVudHMgYXQgdW5xdW90ZWQgYDtgLCBgfGAsIGAmYCxcbiAqIGAmJmAgYW5kIGB8fGAsIGFuZCBzdG9wIGF0IGEgc2hlbGwgY29tbWVudC4gQSBgJmAgdGhhdCBpcyBwYXJ0IG9mIGFcbiAqIHJlZGlyZWN0IChgMj4mMWAsIGAmPmApIGlzIG5vdCBhIHNlcGFyYXRvci5cbiAqL1xuZnVuY3Rpb24gc3BsaXRTaGVsbFNlZ21lbnRzKGxpbmU6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgY29uc3Qgc2VnbWVudHM6IHN0cmluZ1tdID0gW107XG4gIGxldCBxdW90ZSA9IFwiXCI7XG4gIGxldCBzdGFydCA9IDA7XG4gIGxldCBlbmQgPSBsaW5lLmxlbmd0aDtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgY2ggPSBsaW5lLmNoYXJBdChpKTtcbiAgICBpZiAocXVvdGUgIT09IFwiXCIpIHtcbiAgICAgIGlmIChjaCA9PT0gcXVvdGUpIHF1b3RlID0gXCJcIjtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBpZiAoY2ggPT09ICdcIicgfHwgY2ggPT09IFwiJ1wiKSB7XG4gICAgICBxdW90ZSA9IGNoO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHN0YXJ0c1dvcmQgPSBpID09PSAwIHx8IC9cXHMvLnRlc3QobGluZS5jaGFyQXQoaSAtIDEpKTtcbiAgICBpZiAoY2ggPT09IFwiI1wiICYmIHN0YXJ0c1dvcmQpIHtcbiAgICAgIGVuZCA9IGk7XG4gICAgICBicmVhaztcbiAgICB9XG4gICAgaWYgKGNoICE9PSBcIjtcIiAmJiBjaCAhPT0gXCJ8XCIgJiYgY2ggIT09IFwiJlwiKSBjb250aW51ZTtcbiAgICBjb25zdCBpblJlZGlyZWN0ID0gY2ggPT09IFwiJlwiICYmXG4gICAgICAobGluZS5jaGFyQXQoaSAtIDEpID09PSBcIj5cIiB8fCBsaW5lLmNoYXJBdChpIC0gMSkgPT09IFwiPFwiIHx8XG4gICAgICAgIGxpbmUuY2hhckF0KGkgKyAxKSA9PT0gXCI+XCIpO1xuICAgIGlmIChpblJlZGlyZWN0KSBjb250aW51ZTtcbiAgICBzZWdtZW50cy5wdXNoKGxpbmUuc2xpY2Uoc3RhcnQsIGkpKTtcbiAgICBzdGFydCA9IGkgKyAxO1xuICB9XG4gIHNlZ21lbnRzLnB1c2gobGluZS5zbGljZShzdGFydCwgZW5kKSk7XG4gIHJldHVybiBzZWdtZW50cztcbn1cblxuLyoqXG4gKiBUaGUgY29tbWFuZCB0ZXh0IGFmdGVyIGFueSBsZWFkaW5nIGBOQU1FPXZhbHVlYCBlbnZpcm9ubWVudCBhc3NpZ25tZW50cy5cbiAqIEEgcXVvdGVkIHZhbHVlIG1heSBjb250YWluIHNwYWNlcyBvciBvcGVyYXRvcnMuXG4gKi9cbmZ1bmN0aW9uIHN0cmlwRW52QXNzaWdubWVudHMoc2VnbWVudDogc3RyaW5nKTogc3RyaW5nIHtcbiAgbGV0IHJlc3QgPSBzZWdtZW50LnRyaW1TdGFydCgpO1xuICB3aGlsZSAoRU5WX0FTU0lHTk1FTlQudGVzdChyZXN0KSkge1xuICAgIGxldCBxdW90ZSA9IFwiXCI7XG4gICAgbGV0IGkgPSByZXN0LmluZGV4T2YoXCI9XCIpICsgMTtcbiAgICBmb3IgKDsgaSA8IHJlc3QubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGNoID0gcmVzdC5jaGFyQXQoaSk7XG4gICAgICBpZiAocXVvdGUgIT09IFwiXCIpIHtcbiAgICAgICAgaWYgKGNoID09PSBxdW90ZSkgcXVvdGUgPSBcIlwiO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIC8vIEEgYCR7eyAuLi4gfX1gIGV4cHJlc3Npb24gbWF5IGhvbGQgc3BhY2VzOyBpdCBpcyBvbmUgdmFsdWUuXG4gICAgICBpZiAocmVzdC5zdGFydHNXaXRoKFwiJHt7XCIsIGkpKSB7XG4gICAgICAgIGNvbnN0IGNsb3NlID0gcmVzdC5pbmRleE9mKFwifX1cIiwgaSk7XG4gICAgICAgIGlmIChjbG9zZSA9PT0gLTEpIGJyZWFrO1xuICAgICAgICBpID0gY2xvc2UgKyAxO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChjaCA9PT0gJ1wiJyB8fCBjaCA9PT0gXCInXCIpIHtcbiAgICAgICAgcXVvdGUgPSBjaDtcbiAgICAgICAgY29udGludWU7XG4gICAgICB9XG4gICAgICBpZiAoL1xccy8udGVzdChjaCkpIGJyZWFrO1xuICAgIH1cbiAgICByZXN0ID0gcmVzdC5zbGljZShpKS50cmltU3RhcnQoKTtcbiAgfVxuICByZXR1cm4gcmVzdDtcbn1cblxuLyoqIEEgd29ya2Zsb3cgZXhwcmVzc2lvbiBvciBzaGVsbCB2YXJpYWJsZSBsZWZ0IGluIGEgdG9rZW4uICovXG5jb25zdCBVTlJFU09MVkVEID0gL1skYF0vO1xuLyoqIEEgYCR7eyAuLi4gfX1gIGV4cHJlc3Npb24sIHdob3NlIHNwYWNlcyB3b3VsZCBzcGxpdCBpdCBhY3Jvc3MgdG9rZW5zLiAqL1xuY29uc3QgV09SS0ZMT1dfRVhQUkVTU0lPTiA9IC9cXCRcXHtcXHtbXn1dezAsNTAwfVxcfVxcfS9nO1xuLyoqIEEgYCR7eyBtYXRyaXguPGtleT4gfX1gIGV4cHJlc3Npb24uICovXG5jb25zdCBNQVRSSVhfRVhQUkVTU0lPTiA9IC9cXCRcXHtcXHtcXHMqbWF0cml4XFwuKFtcXHctXSspXFxzKlxcfVxcfS9nO1xuLyoqIEEgbWF0cml4IHZhbHVlIHRoYXQgaXMgc2FmZSB0byBwbGFjZSBpbiBhbiBhcmd2OiBubyBxdW90aW5nIG9yIHNoZWxsIHN5bnRheC4gKi9cbmNvbnN0IFNBRkVfTUFUUklYX1ZBTFVFID0gL15bXFx3Li8gLD06QCstXSokLztcbi8qKiBUaGUgbW9zdCBtYXRyaXggY29tYmluYXRpb25zIHRoZSBnYXRlIGV4cGFuZHMgYmVmb3JlIGl0IGZhbGxzIGJhY2suICovXG5jb25zdCBNQVhfTUFUUklYX0NPTUJJTkFUSU9OUyA9IDY0O1xuXG5mdW5jdGlvbiBtYXRyaXhTY2FsYXIodmFsdWU6IHVua25vd24pOiBzdHJpbmcgfCB1bmRlZmluZWQge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiIHx8IHR5cGVvZiB2YWx1ZSA9PT0gXCJudW1iZXJcIiB8fFxuICAgICAgdHlwZW9mIHZhbHVlID09PSBcImJvb2xlYW5cIlxuICAgID8gU3RyaW5nKHZhbHVlKVxuICAgIDogdW5kZWZpbmVkO1xufVxuXG4vKiogVGhlIGRpc3RpbmN0IG1hdHJpeCBrZXlzIHRoZSB0ZXh0cyBuYW1lIGluIGAke3sgbWF0cml4LjxrZXk+IH19YC4gKi9cbmZ1bmN0aW9uIG1hdHJpeEtleXModGV4dHM6IHJlYWRvbmx5IHN0cmluZ1tdKTogc3RyaW5nW10ge1xuICByZXR1cm4gW1xuICAgIC4uLm5ldyBTZXQoXG4gICAgICB0ZXh0cy5mbGF0TWFwKCh0ZXh0KSA9PlxuICAgICAgICBbLi4udGV4dC5tYXRjaEFsbChNQVRSSVhfRVhQUkVTU0lPTildLm1hcCgobWF0Y2gpID0+IG1hdGNoWzFdID8/IFwiXCIpXG4gICAgICApLFxuICAgICksXG4gIF07XG59XG5cbi8qKiBBbnkgYG1hdHJpeC48a2V5PmAgYSBgY29udGludWUtb24tZXJyb3JgIHRlc3QgcmVhZHMsIGluIHdoYXRldmVyIGZvcm0uICovXG5jb25zdCBDT05USU5VRV9NQVRSSVhfS0VZID0gL1xcYm1hdHJpeFxcLihbXFx3LV0rKS9nO1xuXG4vKiogVGhlIGRpc3RpbmN0IG1hdHJpeCBrZXlzIGEgYGNvbnRpbnVlLW9uLWVycm9yYCB0ZXN0IHJlYWRzLiAqL1xuZnVuY3Rpb24gY29udGludWVLZXlzKHRleHRzOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIFtcbiAgICAuLi5uZXcgU2V0KFxuICAgICAgdGV4dHMuZmxhdE1hcCgodGV4dCkgPT5cbiAgICAgICAgWy4uLnRleHQubWF0Y2hBbGwoQ09OVElOVUVfTUFUUklYX0tFWSldLm1hcCgobWF0Y2gpID0+IG1hdGNoWzFdID8/IFwiXCIpXG4gICAgICApLFxuICAgICksXG4gIF07XG59XG5cbi8qKlxuICogVGhlIHZhbHVlIG9mIGVhY2ggb2YgYGtleXNgIGluIGV2ZXJ5IGNvbWJpbmF0aW9uIG9mIHRoZSBqb2IncyBsaXRlcmFsXG4gKiBgc3RyYXRlZ3kubWF0cml4YDogdGhlIGxpc3RzIGNyb3NzLCBlYWNoIGBpbmNsdWRlYCBlbnRyeSBhZGRzIHRvIHRoZVxuICogY29tYmluYXRpb25zIGl0IG1hdGNoZXMgb3IgaXMgaXRzIG93biBjb21iaW5hdGlvbiwgYW5kIGBleGNsdWRlYCBpcyBub3RcbiAqIGFwcGxpZWQgKGFuIGV4Y2x1ZGVkIGNvbWJpbmF0aW9uIGlzIGNoZWNrZWQgdG9vLCB3aGljaCBpcyBzdHJpY3RlcikuIE51bGxcbiAqIHdoZW4gYSBrZXkgaGFzIG5vIGxpdGVyYWwgdmFsdWUgaW4gc29tZSBjb21iaW5hdGlvbiwgYSB2YWx1ZSBpcyBub3QgYSBwbGFpblxuICogc2NhbGFyLCBvciB0aGVyZSBhcmUgdG9vIG1hbnkgY29tYmluYXRpb25zOiB0aGUgY2FsbGVyIHRoZW4gZmFsbHMgYmFjayB0byBhXG4gKiBwbGFpbiBgY2hlY2tgLiBBIGtleSBpbiBgb3B0aW9uYWxLZXlzYCBtYXkgYmUgbWlzc2luZyBmcm9tIGEgY29tYmluYXRpb25cbiAqIChpdCBpcyB0aGVuIFwiXCIsIGFzIGluIGEgd29ya2Zsb3cgZXhwcmVzc2lvbikgYW5kIG5lZWQgbm90IGJlIGEgc2FmZSB2YWx1ZS5cbiAqIEV2ZXJ5IGRpbWVuc2lvbiBhIGtleSBvciBhbiBgaW5jbHVkZWAgZW50cnkgbmFtZXMgaXMgZXhwYW5kZWQgYmVmb3JlIHRoZVxuICogZW50cmllcyBhcmUgYXBwbGllZDsgdGhlIGNvbWJpbmF0aW9ucyBhcmUgdGhlbiBwcm9qZWN0ZWQgb250byB0aGUga2V5cy5cbiAqL1xuZnVuY3Rpb24gbWF0cml4Q29tYmluYXRpb25zKFxuICBtYXRyaXg6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICBrZXlzOiByZWFkb25seSBzdHJpbmdbXSxcbiAgb3B0aW9uYWxLZXlzOiByZWFkb25seSBzdHJpbmdbXSA9IFtdLFxuKTogUmVjb3JkPHN0cmluZywgc3RyaW5nPltdIHwgbnVsbCB7XG4gIGNvbnN0IHdhbnRlZCA9IFtcbiAgICAuLi5rZXlzLFxuICAgIC4uLm9wdGlvbmFsS2V5cy5maWx0ZXIoKGtleSkgPT4gIWtleXMuaW5jbHVkZXMoa2V5KSksXG4gIF07XG4gIGlmICh3YW50ZWQubGVuZ3RoID09PSAwKSByZXR1cm4gW3t9XTtcbiAgY29uc3QgZGltZW5zaW9ucyA9IE9iamVjdC5lbnRyaWVzKG1hdHJpeCkuZmlsdGVyKChba2V5LCB2YWx1ZV0pID0+XG4gICAga2V5ICE9PSBcImluY2x1ZGVcIiAmJiBrZXkgIT09IFwiZXhjbHVkZVwiICYmIEFycmF5LmlzQXJyYXkodmFsdWUpXG4gICk7XG4gIGNvbnN0IGluY2x1ZGVzID0gQXJyYXkuaXNBcnJheShtYXRyaXguaW5jbHVkZSkgPyBtYXRyaXguaW5jbHVkZSA6IFtdO1xuICAvLyBBIGRpbWVuc2lvbiBhbiBgaW5jbHVkZWAgZW50cnkgbmFtZXMgaXMgZXhwYW5kZWQgdG9vLCBzbyB0aGUgZW50cnkgaXNcbiAgLy8gYWRkZWQgb25seSB0byB0aGUgY29tYmluYXRpb25zIGl0IG1hdGNoZXMsIG5vdCB0byBhIGNvbGxhcHNlZCBvbmUuXG4gIGNvbnN0IGluY2x1ZGVLZXlzID0gbmV3IFNldChcbiAgICBpbmNsdWRlcy5mbGF0TWFwKChlbnRyeSkgPT5cbiAgICAgIGVudHJ5ID09PSBudWxsIHx8IHR5cGVvZiBlbnRyeSAhPT0gXCJvYmplY3RcIiA/IFtdIDogT2JqZWN0LmtleXMoZW50cnkpXG4gICAgKSxcbiAgKTtcbiAgbGV0IGNvbWJpbmF0aW9uczogUmVjb3JkPHN0cmluZywgc3RyaW5nPltdID0gZGltZW5zaW9ucy5sZW5ndGggPT09IDBcbiAgICA/IFtdXG4gICAgOiBbe31dO1xuICBmb3IgKGNvbnN0IFtrZXksIGxpc3RdIG9mIGRpbWVuc2lvbnMpIHtcbiAgICBpZiAoIXdhbnRlZC5pbmNsdWRlcyhrZXkpICYmICFpbmNsdWRlS2V5cy5oYXMoa2V5KSkgY29udGludWU7XG4gICAgY29uc3QgdmFsdWVzID0gKGxpc3QgYXMgdW5rbm93bltdKS5tYXAobWF0cml4U2NhbGFyKTtcbiAgICBpZiAodmFsdWVzLmxlbmd0aCA9PT0gMCB8fCB2YWx1ZXMuc29tZSgodmFsdWUpID0+IHZhbHVlID09PSB1bmRlZmluZWQpKSB7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG4gICAgY29tYmluYXRpb25zID0gY29tYmluYXRpb25zLmZsYXRNYXAoKGNvbWJpbmF0aW9uKSA9PlxuICAgICAgdmFsdWVzLm1hcCgodmFsdWUpID0+ICh7IC4uLmNvbWJpbmF0aW9uLCBba2V5XTogdmFsdWUgYXMgc3RyaW5nIH0pKVxuICAgICk7XG4gICAgaWYgKGNvbWJpbmF0aW9ucy5sZW5ndGggPiBNQVhfTUFUUklYX0NPTUJJTkFUSU9OUykgcmV0dXJuIG51bGw7XG4gIH1cbiAgZm9yIChjb25zdCBlbnRyeSBvZiBpbmNsdWRlcykge1xuICAgIGlmIChlbnRyeSA9PT0gbnVsbCB8fCB0eXBlb2YgZW50cnkgIT09IFwib2JqZWN0XCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IHZhbHVlczogUmVjb3JkPHN0cmluZywgc3RyaW5nPiA9IHt9O1xuICAgIGZvciAoY29uc3QgW2tleSwgdmFsdWVdIG9mIE9iamVjdC5lbnRyaWVzKGVudHJ5KSkge1xuICAgICAgY29uc3Qgc2NhbGFyID0gbWF0cml4U2NhbGFyKHZhbHVlKTtcbiAgICAgIGlmIChzY2FsYXIgIT09IHVuZGVmaW5lZCkgdmFsdWVzW2tleV0gPSBzY2FsYXI7XG4gICAgfVxuICAgIGxldCBtYXRjaGVkID0gZmFsc2U7XG4gICAgY29tYmluYXRpb25zID0gY29tYmluYXRpb25zLm1hcCgoY29tYmluYXRpb24pID0+IHtcbiAgICAgIGNvbnN0IGFncmVlcyA9IE9iamVjdC5lbnRyaWVzKGNvbWJpbmF0aW9uKS5ldmVyeSgoW2tleSwgdmFsdWVdKSA9PlxuICAgICAgICB2YWx1ZXNba2V5XSA9PT0gdW5kZWZpbmVkIHx8IHZhbHVlc1trZXldID09PSB2YWx1ZVxuICAgICAgKTtcbiAgICAgIGlmICghYWdyZWVzKSByZXR1cm4gY29tYmluYXRpb247XG4gICAgICBtYXRjaGVkID0gdHJ1ZTtcbiAgICAgIHJldHVybiB7IC4uLnZhbHVlcywgLi4uY29tYmluYXRpb24gfTtcbiAgICB9KTtcbiAgICAvLyBBbiBlbnRyeSBuYW1pbmcgbm8gd2FudGVkIGtleSBhZGRzIG5vdGhpbmcgYSB3YW50ZWQga2V5IGNvdWxkIHJlYWQuXG4gICAgaWYgKCFtYXRjaGVkKSBjb21iaW5hdGlvbnMucHVzaCh2YWx1ZXMpO1xuICB9XG4gIGlmIChjb21iaW5hdGlvbnMubGVuZ3RoID4gTUFYX01BVFJJWF9DT01CSU5BVElPTlMpIHJldHVybiBudWxsO1xuICBjb25zdCBzZWVuID0gbmV3IFNldDxzdHJpbmc+KCk7XG4gIGNvbnN0IHJlc3VsdDogUmVjb3JkPHN0cmluZywgc3RyaW5nPltdID0gW107XG4gIGZvciAoY29uc3QgY29tYmluYXRpb24gb2YgY29tYmluYXRpb25zKSB7XG4gICAgY29uc3QgcGlja2VkOiBSZWNvcmQ8c3RyaW5nLCBzdHJpbmc+ID0ge307XG4gICAgZm9yIChjb25zdCBrZXkgb2Ygd2FudGVkKSB7XG4gICAgICBjb25zdCB2YWx1ZSA9IGNvbWJpbmF0aW9uW2tleV07XG4gICAgICBpZiAoa2V5cy5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICAgIGlmICh2YWx1ZSA9PT0gdW5kZWZpbmVkIHx8ICFTQUZFX01BVFJJWF9WQUxVRS50ZXN0KHZhbHVlKSkgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgICBwaWNrZWRba2V5XSA9IHZhbHVlID8/IFwiXCI7XG4gICAgfVxuICAgIGNvbnN0IGlkID0gSlNPTi5zdHJpbmdpZnkocGlja2VkKTtcbiAgICBpZiAoc2Vlbi5oYXMoaWQpKSBjb250aW51ZTtcbiAgICBzZWVuLmFkZChpZCk7XG4gICAgcmVzdWx0LnB1c2gocGlja2VkKTtcbiAgfVxuICByZXR1cm4gcmVzdWx0Lmxlbmd0aCA9PT0gMCA/IG51bGwgOiByZXN1bHQ7XG59XG5cbi8qKiBgdGV4dGAgd2l0aCBlYWNoIGAke3sgbWF0cml4LjxrZXk+IH19YCByZXBsYWNlZCBieSB0aGUgY29tYmluYXRpb24ncyB2YWx1ZS4gKi9cbmZ1bmN0aW9uIHN1YnN0aXR1dGVNYXRyaXgoXG4gIHRleHQ6IHN0cmluZyxcbiAgY29tYmluYXRpb246IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+LFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIHRleHQucmVwbGFjZShcbiAgICBNQVRSSVhfRVhQUkVTU0lPTixcbiAgICAoX21hdGNoLCBrZXk6IHN0cmluZykgPT4gY29tYmluYXRpb25ba2V5XSA/PyBcIlwiLFxuICApO1xufVxuXG4vKiogQSBgY29udGludWUtb24tZXJyb3JgIHZhbHVlIHRoYXQgaXMgYSBsaXRlcmFsIHRydWUuICovXG5jb25zdCBDT05USU5VRV9MSVRFUkFMID0gL14oPzp0cnVlfFxcJFxce1xce1xccyp0cnVlXFxzKlxcfVxcfSkkL2k7XG4vKipcbiAqIEEgYGNvbnRpbnVlLW9uLWVycm9yYCB0ZXN0IG9uIG9uZSBtYXRyaXgga2V5OiBgJHt7IG1hdHJpeC48a2V5PiB9fWAsIG9yXG4gKiBgJHt7IG1hdHJpeC48a2V5PiA9PSAnPHZhbHVlPicgfX1gIChhbHNvIGAhPWAsIGFuZCBhbiB1bnF1b3RlZCB2YWx1ZSkuXG4gKi9cbmNvbnN0IENPTlRJTlVFX01BVFJJWF9URVNUID1cbiAgL15cXCRcXHtcXHtcXHMqbWF0cml4XFwuKFtcXHctXSspKD86XFxzKig9PXwhPSlcXHMqKD86JyhbXiddezAsMjAwfSknfChbXFx3Li1dezEsMjAwfSkpKT9cXHMqXFx9XFx9JC87XG5cbi8qKlxuICogV2hldGhlciBhIGBjb250aW51ZS1vbi1lcnJvcmAgdmFsdWUgbGV0cyB0aGUgaW52b2NhdGlvbiBvZiBgY29tYmluYXRpb25gXG4gKiBmYWlsLiBBIGxpdGVyYWwgdHJ1ZSBkb2VzLiBBIG1hdHJpeCB0ZXN0IGlzIGV2YWx1YXRlZCBmb3IgdGhlIGNvbWJpbmF0aW9uIGFzXG4gKiBHaXRIdWIgZG9lcyAoc3RyaW5ncyBjb21wYXJlIHdpdGhvdXQgcmVnYXJkIHRvIGNhc2UsIGEgbWlzc2luZyBrZXkgaXMgXCJcIikuXG4gKiBBbnl0aGluZyBlbHNlLCBhbmQgYW55IHRlc3Qgd2l0aCBubyBjb21iaW5hdGlvbiB0byBldmFsdWF0ZSBpdCBvbiwgZG9lc1xuICogbm90OiB0aGUgZmFpbHVyZSB0aGVuIGJsb2Nrcy5cbiAqL1xuZnVuY3Rpb24gY29udGludWVPbkVycm9yQWxsb3dzKFxuICB2YWx1ZTogc3RyaW5nLFxuICBjb21iaW5hdGlvbjogUmVhZG9ubHk8UmVjb3JkPHN0cmluZywgc3RyaW5nPj4gfCBudWxsLFxuKTogYm9vbGVhbiB7XG4gIGNvbnN0IHRleHQgPSB2YWx1ZS50cmltKCk7XG4gIGlmIChDT05USU5VRV9MSVRFUkFMLnRlc3QodGV4dCkpIHJldHVybiB0cnVlO1xuICBpZiAoY29tYmluYXRpb24gPT09IG51bGwpIHJldHVybiBmYWxzZTtcbiAgY29uc3QgdGVzdCA9IENPTlRJTlVFX01BVFJJWF9URVNULmV4ZWModGV4dCk7XG4gIGlmICh0ZXN0ID09PSBudWxsKSByZXR1cm4gZmFsc2U7XG4gIGNvbnN0IGFjdHVhbCA9IChjb21iaW5hdGlvblt0ZXN0WzFdID8/IFwiXCJdID8/IFwiXCIpLnRvTG93ZXJDYXNlKCk7XG4gIGlmICh0ZXN0WzJdID09PSB1bmRlZmluZWQpIHJldHVybiBhY3R1YWwgPT09IFwidHJ1ZVwiO1xuICBjb25zdCBleHBlY3RlZCA9ICh0ZXN0WzNdID8/IHRlc3RbNF0gPz8gXCJcIikudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIChhY3R1YWwgPT09IGV4cGVjdGVkKSA9PT0gKHRlc3RbMl0gPT09IFwiPT1cIik7XG59XG5cbi8qKiBgYWxsb3dGYWlsdXJlOiB0cnVlYCB3aGVuIGFueSBvZiB0aGUgc3RlcCdzIGBjb250aW51ZS1vbi1lcnJvcmAgdmFsdWVzIGFsbG93cyBpdC4gKi9cbmZ1bmN0aW9uIGFsbG93RmFpbHVyZUZvcihcbiAgY3R4OiBTdGVwQ29udGV4dCxcbiAgY29tYmluYXRpb246IFJlYWRvbmx5PFJlY29yZDxzdHJpbmcsIHN0cmluZz4+IHwgbnVsbCxcbik6IHsgYWxsb3dGYWlsdXJlPzogdHJ1ZSB9IHtcbiAgcmV0dXJuIGN0eC5jb250aW51ZU9uRXJyb3Iuc29tZSgodmFsdWUpID0+XG4gICAgICBjb250aW51ZU9uRXJyb3JBbGxvd3ModmFsdWUsIGNvbWJpbmF0aW9uKVxuICAgIClcbiAgICA/IHsgYWxsb3dGYWlsdXJlOiB0cnVlIH1cbiAgICA6IHt9O1xufVxuXG4vKipcbiAqIFRoZSB0b2tlbnMgd2l0aCBlYWNoIHZhcmlhYmxlIG9yIGV4cHJlc3Npb24gdGhhdCBpcyBsZWZ0IGRyb3BwZWQuIEFuIG9wdGlvblxuICogdGhlIGRyb3BwZWQgdG9rZW4gc3Rvb2QgYWZ0ZXIgaXMgZHJvcHBlZCB3aXRoIGl0LCBzbyBubyBvcHRpb24gaXMgbGVmdFxuICogd2l0aG91dCBpdHMgdmFsdWUgKGAtLWNvbmZpZyAke3sgZW52LlggfX1gIGdvZXMgd2hvbGUpLiBUaGUgY29tbWFuZCBpcyB0aGVuXG4gKiBhIHBsYWluIGNoZWNrIG9mIHdoYXQgcmVtYWlucy5cbiAqL1xuZnVuY3Rpb24gZHJvcFVucmVzb2x2ZWQodG9rZW5zOiByZWFkb25seSBzdHJpbmdbXSk6IHN0cmluZ1tdIHtcbiAgY29uc3Qga2VwdDogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCB0b2tlbiBvZiB0b2tlbnMpIHtcbiAgICBpZiAoIVVOUkVTT0xWRUQudGVzdCh0b2tlbikpIHtcbiAgICAgIGtlcHQucHVzaCh0b2tlbik7XG4gICAgICBjb250aW51ZTtcbiAgICB9XG4gICAgLy8gYGtlcHRgIGFsd2F5cyBob2xkcyBgY2FyZ29gLCBzbyB0aGVyZSBpcyBhIHByZXZpb3VzIHRva2VuOyBcIlwiIGlzIGZvciB0aGUgdHlwZXMuXG4gICAgY29uc3QgcHJldmlvdXMgPSBrZXB0LmF0KC0xKSA/PyBcIlwiO1xuICAgIGlmIChwcmV2aW91cy5zdGFydHNXaXRoKFwiLVwiKSAmJiAhcHJldmlvdXMuaW5jbHVkZXMoXCI9XCIpKSBrZXB0LnBvcCgpO1xuICB9XG4gIHJldHVybiBrZXB0O1xufVxuXG4vKipcbiAqIFRoZSBmaW5kaW5ncyBmb3Igb25lIGNvbW1hbmQgc2VnbWVudCBvZiBhIHNoZWxsIGxpbmUuIEEgYCR7eyBtYXRyaXguPGtleT4gfX1gXG4gKiBleHByZXNzaW9uIGlzIGV4cGFuZGVkIGZyb20gdGhlIGpvYidzIGxpdGVyYWwgbWF0cml4LCBvbmUgaW52b2NhdGlvbiBwZXJcbiAqIGNvbWJpbmF0aW9uLiBBIHZhcmlhYmxlIG9yIGV4cHJlc3Npb24gdGhhdCBzdGF5cywgYmVmb3JlIG9yIGFmdGVyIGBjaGVja2AsXG4gKiBpcyBkcm9wcGVkLCBzbyB0aGUgaW52b2NhdGlvbiBydW5zIGEgcGxhaW4gYGNoZWNrYCwgd2hpY2ggY292ZXJzIGV2ZXJ5IHN1YnNldFxuICogdGhlIHZhcmlhYmxlIGNvdWxkIHNlbGVjdC4gT25lIGluIGEgY29tbWFuZCB0aGF0IG5hbWVzIG5vIGBjaGVja2AgY291bGRcbiAqIHN0YW5kIGZvciBhbm90aGVyIHN1YmNvbW1hbmQsIHNvIHRoYXQgaXMgdW5ydW5uYWJsZS5cbiAqL1xuZnVuY3Rpb24gc2VnbWVudEZpbmRpbmdzKFxuICBzZWdtZW50OiBzdHJpbmcsXG4gIG5vOiBudW1iZXIsXG4gIGN0eDogU3RlcENvbnRleHQsXG4pOiBDYXJnb0RlbnlDaUZpbmRpbmdbXSB7XG4gIC8vIFRoZSB0ZXh0IGJlZm9yZSBhbnkgcmVkaXJlY3Qgb3IgY29tbWVudC4gRW52aXJvbm1lbnQgYXNzaWdubWVudHMgYXJlXG4gIC8vIGRyb3BwZWQgKHRoZSBjaGVjayBpcyBydW4gd2l0aCB0aGUgZ2F0ZSdzIG93biBlbnZpcm9ubWVudCkuXG4gIGNvbnN0IGhlYWQgPSBjdXRBdFNoZWxsT3BlcmF0b3Ioc2VnbWVudC50cmltKCkpO1xuICBjb25zdCBjb21tYW5kID0gc3RyaXBFbnZBc3NpZ25tZW50cyhoZWFkKTtcbiAgaWYgKCFDQVJHT19ERU5ZX1NUQVJULnRlc3QoY29tbWFuZCkpIHJldHVybiBbXTtcbiAgY29uc3Qgc291cmNlID0gYGxpbmUgJHtub31gO1xuICBjb25zdCBjb21iaW5hdGlvbnMgPSBtYXRyaXhDb21iaW5hdGlvbnMoXG4gICAgY3R4Lm1hdHJpeCxcbiAgICBtYXRyaXhLZXlzKFtjb21tYW5kLCBjdHgud2QgPz8gXCJcIl0pLFxuICAgIGNvbnRpbnVlS2V5cyhjdHguY29udGludWVPbkVycm9yKSxcbiAgKTtcbiAgY29uc3QgZmluZGluZ3M6IENhcmdvRGVueUNpRmluZGluZ1tdID0gW107XG4gIGZvciAoY29uc3QgY29tYmluYXRpb24gb2YgY29tYmluYXRpb25zID8/IFtudWxsXSkge1xuICAgIGNvbnN0IHRleHQgPVxuICAgICAgKGNvbWJpbmF0aW9uID09PSBudWxsID8gY29tbWFuZCA6IHN1YnN0aXR1dGVNYXRyaXgoY29tbWFuZCwgY29tYmluYXRpb24pKVxuICAgICAgICAucmVwbGFjZShXT1JLRkxPV19FWFBSRVNTSU9OLCBcIiRFWFBSRVNTSU9OXCIpO1xuICAgIGNvbnN0IGFyZ3YgPSB0b2tlbmlzZUNvbW1hbmQodGV4dCk7XG4gICAgaWYgKGFyZ3ZbMF0gIT09IFwiY2FyZ29cIiB8fCBhcmd2WzFdICE9PSBcImRlbnlcIikgY29udGludWU7XG4gICAgY29uc3QgY2hlY2tBdCA9IGFyZ3YuaW5kZXhPZihcImNoZWNrXCIsIDIpO1xuICAgIGlmIChjaGVja0F0ID09PSAtMSkge1xuICAgICAgLy8gV2l0aG91dCBgY2hlY2tgIGEgdmFyaWFibGUgY291bGQgc3RpbGwgc3RhbmQgZm9yIGl0LlxuICAgICAgaWYgKGFyZ3Yuc29tZSgodG9rZW4pID0+IFVOUkVTT0xWRUQudGVzdCh0b2tlbikpKSB7XG4gICAgICAgIHJldHVybiBbe1xuICAgICAgICAgIGtpbmQ6IFwidW5ydW5uYWJsZVwiLFxuICAgICAgICAgIHNvdXJjZSxcbiAgICAgICAgICByZWFzb246IFwidGhlIGxpbmUgdXNlcyBhIHNoZWxsIHZhcmlhYmxlIG9yIHdvcmtmbG93IGV4cHJlc3Npb24gXCIgK1xuICAgICAgICAgICAgXCIoJCBvciBhIGJhY2t0aWNrKSBpbiBhIGNhcmdvIGRlbnkgY29tbWFuZCB0aGF0IG5hbWVzIG5vIFwiICtcbiAgICAgICAgICAgIFwiYGNoZWNrYCwgc28gaXQgY2Fubm90IGJlIHJ1biBhcyBDSSBydW5zIGl0XCIsXG4gICAgICAgIH1dO1xuICAgICAgfVxuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHdkID0gY3R4LndkID09PSB1bmRlZmluZWQgfHwgY29tYmluYXRpb24gPT09IG51bGxcbiAgICAgID8gY3R4LndkXG4gICAgICA6IHN1YnN0aXR1dGVNYXRyaXgoY3R4LndkLCBjb21iaW5hdGlvbik7XG4gICAgY29uc3QgY3dkID0gcmVzb2x2ZVdvcmtpbmdEaXJlY3Rvcnkod2QpO1xuICAgIGlmICghY3dkLm9rKSByZXR1cm4gW3sga2luZDogXCJ1bnJ1bm5hYmxlXCIsIHNvdXJjZSwgcmVhc29uOiBjd2QucmVhc29uIH1dO1xuICAgIGZpbmRpbmdzLnB1c2goe1xuICAgICAga2luZDogXCJjb21tYW5kXCIsXG4gICAgICBhcmd2OiBkcm9wVW5yZXNvbHZlZChhcmd2KSxcbiAgICAgIGN3ZDogY3dkLmN3ZCxcbiAgICAgIC4uLmFsbG93RmFpbHVyZUZvcihjdHgsIGNvbWJpbmF0aW9uKSxcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gZmluZGluZ3M7XG59XG5cbi8qKlxuICogVGhlIGZpbmRpbmdzIGZvciBvbmUgbG9naWNhbCBgcnVuOmAgbGluZS4gRXZlcnkgY29tbWFuZCBzZWdtZW50IGlzXG4gKiBleGFtaW5lZCwgc28gYGNhcmdvIGZldGNoICYmIGNhcmdvIGRlbnkgY2hlY2tgIGlzIGZvdW5kLiBBIHNlZ21lbnQncyBgY2RgXG4gKiBvciBvdGhlciBjb21tYW5kcyBhcmUgaWdub3JlZCwgYW5kIHRoZSBzdGVwJ3Mgd29ya2luZyBkaXJlY3RvcnkgYXBwbGllcy5cbiAqL1xuZnVuY3Rpb24gY2FyZ29EZW55Q29tbWFuZEZpbmRpbmdzKFxuICBsaW5lOiBzdHJpbmcsXG4gIG5vOiBudW1iZXIsXG4gIGN0eDogU3RlcENvbnRleHQsXG4pOiBDYXJnb0RlbnlDaUZpbmRpbmdbXSB7XG4gIHJldHVybiBzcGxpdFNoZWxsU2VnbWVudHMobGluZSkuZmxhdE1hcCgoc2VnbWVudCkgPT5cbiAgICBzZWdtZW50RmluZGluZ3Moc2VnbWVudCwgbm8sIGN0eClcbiAgKTtcbn1cblxuLyoqXG4gKiBUaGUgZmluZGluZ3MgZm9yIG9uZSBgcnVuOmAga2V5IG9mIGEgc3RlcC4gQSBibG9jayBzY2FsYXIgZ2l2ZXMgb25lIHNoZWxsXG4gKiBsaW5lIHBlciBZQU1MIGxpbmUuIEEgcGxhaW4gdmFsdWUgZm9sZHMgaXRzIGxpbmVzIGludG8gb25lLCBhcyBZQU1MIGRvZXMuXG4gKi9cbmZ1bmN0aW9uIHJ1bkZpbmRpbmdzKFxuICBydW46IE1hcHBpbmdMaW5lLFxuICBjdHg6IFN0ZXBDb250ZXh0LFxuKTogQ2FyZ29EZW55Q2lGaW5kaW5nW10ge1xuICBjb25zdCBzY3JpcHQ6IFlhbWxMaW5lW10gPSBCTE9DS19JTkRJQ0FUT1IudGVzdChzY2FsYXJWYWx1ZShydW4ucmF3KSlcbiAgICA/IHJ1bi5jaGlsZHJlblxuICAgIDogW3tcbiAgICAgIGluZGVudDogMCxcbiAgICAgIHRleHQ6IFtcbiAgICAgICAgc2NhbGFyVmFsdWUocnVuLnJhdyksXG4gICAgICAgIC4uLnJ1bi5jaGlsZHJlbi5tYXAoKGxpbmUpID0+IGxpbmUudGV4dC50cmltKCkpLFxuICAgICAgXVxuICAgICAgICAuZmlsdGVyKChwYXJ0KSA9PiBwYXJ0ICE9PSBcIlwiKVxuICAgICAgICAuam9pbihcIiBcIiksXG4gICAgICBubzogcnVuLm5vLFxuICAgIH1dO1xuICBjb25zdCBmaW5kaW5nczogQ2FyZ29EZW55Q2lGaW5kaW5nW10gPSBbXTtcbiAgbGV0IHF1b3RlID0gXCJcIjtcbiAgZm9yIChjb25zdCBjb21tYW5kIG9mIGpvaW5Db250aW51YXRpb25zKHNjcmlwdCkpIHtcbiAgICBjb25zdCBzdGFydHNJblF1b3RlID0gcXVvdGUgIT09IFwiXCI7XG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBjb21tYW5kLnRleHQubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IGNoID0gY29tbWFuZC50ZXh0W2ldO1xuICAgICAgaWYgKGNoID09PSBcIlxcXFxcIiAmJiBxdW90ZSAhPT0gXCInXCIpIHtcbiAgICAgICAgaSsrO1xuICAgICAgICBjb250aW51ZTtcbiAgICAgIH1cbiAgICAgIGlmIChxdW90ZSAhPT0gXCJcIikgeyBpZiAoY2ggPT09IHF1b3RlKSBxdW90ZSA9IFwiXCI7IH1cbiAgICAgIGVsc2UgaWYgKGNoID09PSBcIidcIiB8fCBjaCA9PT0gJ1wiJykgcXVvdGUgPSBjaDtcbiAgICAgIGVsc2UgaWYgKFxuICAgICAgICBjaCA9PT0gXCIjXCIgJiYgKGkgPT09IDAgfHwgL1xccy8udGVzdChjb21tYW5kLnRleHRbaSAtIDFdID8/IFwiXCIpKVxuICAgICAgKSBicmVhaztcbiAgICB9XG4gICAgaWYgKCFzdGFydHNJblF1b3RlKSB7XG4gICAgICBmaW5kaW5ncy5wdXNoKFxuICAgICAgICAuLi5jYXJnb0RlbnlDb21tYW5kRmluZGluZ3MoY29tbWFuZC50ZXh0LCBjb21tYW5kLm5vLCBjdHgpLFxuICAgICAgKTtcbiAgICB9XG4gIH1cbiAgcmV0dXJuIGZpbmRpbmdzO1xufVxuXG4vKiogVGhlIGB3aXRoOmAgaW5wdXRzIG9mIGFuIGFjdGlvbiBzdGVwLCBmcm9tIGl0cyBjaGlsZCBsaW5lcy4gKi9cbmZ1bmN0aW9uIHBhcnNlV2l0aChjaGlsZHJlbjogcmVhZG9ubHkgWWFtbExpbmVbXSk6IE1hcDxzdHJpbmcsIHN0cmluZz4ge1xuICBjb25zdCBpbnB1dHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICBjb25zdCBsZXZlbCA9IGNoaWxkcmVuWzBdPy5pbmRlbnQ7XG4gIGZvciAoY29uc3QgY2hpbGQgb2YgY2hpbGRyZW4pIHtcbiAgICBpZiAoY2hpbGQuaW5kZW50ICE9PSBsZXZlbCkgY29udGludWU7XG4gICAgY29uc3QgbWFwcGluZyA9IHBhcnNlTWFwcGluZyhjaGlsZC50ZXh0KTtcbiAgICBpZiAobWFwcGluZykgaW5wdXRzLnNldChtYXBwaW5nLmtleSwgc2NhbGFyVmFsdWUobWFwcGluZy5yYXcpKTtcbiAgfVxuICByZXR1cm4gaW5wdXRzO1xufVxuXG4vKipcbiAqIFRoZSBhcmd2IHRoZSBhY3Rpb24gYnVpbGRzIGZyb20gaXRzIGlucHV0cywgcnVuIGZyb20gdGhlIHJlcG8gcm9vdC4gQVxuICogYCR7eyBtYXRyaXguPGtleT4gfX1gIGV4cHJlc3Npb24gaXMgZXhwYW5kZWQgZnJvbSB0aGUgam9iJ3MgbGl0ZXJhbCBtYXRyaXgsXG4gKiBvbmUgaW52b2NhdGlvbiBwZXIgY29tYmluYXRpb24uXG4gKi9cbmZ1bmN0aW9uIGFjdGlvbkZpbmRpbmdzKFxuICBpbnB1dHM6IFJlYWRvbmx5TWFwPHN0cmluZywgc3RyaW5nPixcbiAgY3R4OiBTdGVwQ29udGV4dCxcbik6IENhcmdvRGVueUNpRmluZGluZ1tdIHtcbiAgY29uc3QgY29tYmluYXRpb25zID0gbWF0cml4Q29tYmluYXRpb25zKFxuICAgIGN0eC5tYXRyaXgsXG4gICAgbWF0cml4S2V5cyhbLi4uaW5wdXRzLnZhbHVlcygpXSksXG4gICAgY29udGludWVLZXlzKGN0eC5jb250aW51ZU9uRXJyb3IpLFxuICApO1xuICByZXR1cm4gKGNvbWJpbmF0aW9ucyA/PyBbbnVsbF0pLmZsYXRNYXAoKGNvbWJpbmF0aW9uKSA9PlxuICAgIGFjdGlvblZhcmlhbnRGaW5kaW5ncyhcbiAgICAgIG5ldyBNYXAoXG4gICAgICAgIFsuLi5pbnB1dHNdLm1hcCgoW25hbWUsIHZhbHVlXSkgPT4gW1xuICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgY29tYmluYXRpb24gPT09IG51bGwgPyB2YWx1ZSA6IHN1YnN0aXR1dGVNYXRyaXgodmFsdWUsIGNvbWJpbmF0aW9uKSxcbiAgICAgICAgXSksXG4gICAgICApLFxuICAgICAgYWxsb3dGYWlsdXJlRm9yKGN0eCwgY29tYmluYXRpb24pLFxuICAgIClcbiAgKTtcbn1cblxuLyoqXG4gKiBPbmUgaW52b2NhdGlvbiBvZiB0aGUgYWN0aW9uLiBBbiBpbnB1dCB0aGF0IHN0aWxsIGhvbGRzIGEgdmFyaWFibGUgb3JcbiAqIGV4cHJlc3Npb24gY2Fubm90IGJlIHJlcHJvZHVjZWQsIHNvIGl0IHRha2VzIHRoZSBhY3Rpb24ncyBvd24gZGVmYXVsdDogdGhlXG4gKiBjb21tYW5kIGJlY29tZXMgYSBwbGFpbiBgY2hlY2tgLCB3aGljaCBydW5zIGV2ZXJ5IGNoZWNrIGFuZCBzbyBjb3ZlcnMgZXZlcnlcbiAqIHN1YnNldCB0aGUgZXhwcmVzc2lvbiBjb3VsZCBzZWxlY3QuXG4gKi9cbmZ1bmN0aW9uIGFjdGlvblZhcmlhbnRGaW5kaW5ncyhcbiAgaW5wdXRzOiBSZWFkb25seU1hcDxzdHJpbmcsIHN0cmluZz4sXG4gIGFsbG93OiB7IGFsbG93RmFpbHVyZT86IHRydWUgfSxcbik6IENhcmdvRGVueUNpRmluZGluZ1tdIHtcbiAgY29uc3QgdmFsdWUgPSAobmFtZTogQWN0aW9uSW5wdXQpOiBzdHJpbmcgPT4ge1xuICAgIGNvbnN0IGlucHV0ID0gaW5wdXRzLmdldChuYW1lKSA/PyBBQ1RJT05fREVGQVVMVFNbbmFtZV07XG4gICAgcmV0dXJuIFVOUkVTT0xWRUQudGVzdChpbnB1dCkgPyBBQ1RJT05fREVGQVVMVFNbbmFtZV0gOiBpbnB1dDtcbiAgfTtcbiAgcmV0dXJuIFt7XG4gICAga2luZDogXCJjb21tYW5kXCIsXG4gICAgYXJndjogW1xuICAgICAgXCJjYXJnb1wiLFxuICAgICAgXCJkZW55XCIsXG4gICAgICBcIi0tbG9nLWxldmVsXCIsXG4gICAgICB2YWx1ZShcImxvZy1sZXZlbFwiKSxcbiAgICAgIFwiLS1tYW5pZmVzdC1wYXRoXCIsXG4gICAgICB2YWx1ZShcIm1hbmlmZXN0LXBhdGhcIiksXG4gICAgICAuLi5zcGxpdFdvcmRzKHZhbHVlKFwiYXJndW1lbnRzXCIpKSxcbiAgICAgIC4uLnNwbGl0V29yZHModmFsdWUoXCJjb21tYW5kXCIpKSxcbiAgICAgIC4uLnNwbGl0V29yZHModmFsdWUoXCJjb21tYW5kLWFyZ3VtZW50c1wiKSksXG4gICAgXSxcbiAgICBjd2Q6IFwiLlwiLFxuICAgIC4uLmFsbG93LFxuICB9XTtcbn1cblxuLyoqIERpcmVjdCBjaGlsZHJlbiBvZiBgYWxsW2lkeF1gOiBkZWVwZXIgbGluZXMsIHVwIHRvIHRoZSBuZXh0IGtleSBhdCBgY2AuICovXG5mdW5jdGlvbiBjaGlsZHJlbk9mKFxuICBhbGw6IHJlYWRvbmx5IFlhbWxMaW5lW10sXG4gIGlkeDogbnVtYmVyLFxuICBjOiBudW1iZXIsXG4pOiBZYW1sTGluZVtdIHtcbiAgY29uc3Qgb3V0OiBZYW1sTGluZVtdID0gW107XG4gIGZvciAobGV0IGogPSBpZHggKyAxOyBqIDwgYWxsLmxlbmd0aDsgaisrKSB7XG4gICAgY29uc3QgbGluZSA9IGFsbFtqXTtcbiAgICBpZiAobGluZSA9PT0gdW5kZWZpbmVkIHx8IGlzU2tpcHBhYmxlKGxpbmUudGV4dCkpIGNvbnRpbnVlO1xuICAgIGlmIChsaW5lLmluZGVudCA8PSBjKSBicmVhaztcbiAgICBvdXQucHVzaChsaW5lKTtcbiAgfVxuICByZXR1cm4gb3V0O1xufVxuXG4vKiogVGhlIGZpbmRpbmdzIGZvciBvbmUgc3RlcCwgd2hpY2ggc3BhbnMgbGluZXMgYHN0YXJ0YCAodGhlIGAtIGApIHRvIGBlbmRgLiAqL1xuZnVuY3Rpb24gc3RlcEZpbmRpbmdzKFxuICBsaW5lczogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHN0YXJ0OiBudW1iZXIsXG4gIGVuZDogbnVtYmVyLFxuICBkYXNoSW5kZW50OiBudW1iZXIsXG4gIGpvYjogSm9iQ29udGV4dCxcbiAgcGFyc2VkPzogUmVjb3JkPHN0cmluZywgdW5rbm93bj4sXG4pOiBDYXJnb0RlbnlDaUZpbmRpbmdbXSB7XG4gIGNvbnN0IGFmdGVyRGFzaCA9IExJU1RfSVRFTS5leGVjKGxpbmVzW3N0YXJ0XSA/PyBcIlwiKT8uWzJdID8/IFwiXCI7XG4gIGNvbnN0IGNvbnRlbnQgPSBhZnRlckRhc2gudHJpbVN0YXJ0KCk7XG4gIGNvbnN0IGFsbDogWWFtbExpbmVbXSA9IFtdO1xuICBpZiAoY29udGVudCAhPT0gXCJcIikge1xuICAgIGFsbC5wdXNoKHtcbiAgICAgIGluZGVudDogZGFzaEluZGVudCArIDEgKyAoYWZ0ZXJEYXNoLmxlbmd0aCAtIGNvbnRlbnQubGVuZ3RoKSxcbiAgICAgIHRleHQ6IGNvbnRlbnQsXG4gICAgICBubzogc3RhcnQgKyAxLFxuICAgIH0pO1xuICB9XG4gIGZvciAobGV0IGsgPSBzdGFydCArIDE7IGsgPCBlbmQ7IGsrKykge1xuICAgIGNvbnN0IHRleHQgPSBsaW5lc1trXSA/PyBcIlwiO1xuICAgIGFsbC5wdXNoKHsgaW5kZW50OiBpbmRlbnRPZih0ZXh0KSwgdGV4dCwgbm86IGsgKyAxIH0pO1xuICB9XG4gIC8vIFRoZSBzdGVwJ3Mgb3duIGtleXMgc2l0IGF0IG9uZSBjb2x1bW46IGFmdGVyIGAtIGAgd2hlbiB0aGUga2V5IGlzIG9uIHRoZVxuICAvLyBkYXNoIGxpbmUsIG90aGVyd2lzZSB0aGUgZmlyc3Qga2V5IGxpbmUgdW5kZXIgYSBiYXJlIGAtYC5cbiAgY29uc3QgYyA9IGNvbnRlbnQgIT09IFwiXCJcbiAgICA/IGRhc2hJbmRlbnQgKyAxICsgKGFmdGVyRGFzaC5sZW5ndGggLSBjb250ZW50Lmxlbmd0aClcbiAgICA6IChhbGwuZmluZCgobGluZSkgPT4gIWlzU2tpcHBhYmxlKGxpbmUudGV4dCkpPy5pbmRlbnQgPz8gLTEpO1xuICBpZiAoYyA8PSBkYXNoSW5kZW50KSByZXR1cm4gW107XG5cbiAgY29uc3Qga2V5czogTWFwcGluZ0xpbmVbXSA9IFtdO1xuICBmb3IgKGxldCBpZHggPSAwOyBpZHggPCBhbGwubGVuZ3RoOyBpZHgrKykge1xuICAgIGNvbnN0IGxpbmUgPSBhbGxbaWR4XTtcbiAgICBpZiAobGluZSA9PT0gdW5kZWZpbmVkIHx8IGxpbmUuaW5kZW50ICE9PSBjIHx8IGlzU2tpcHBhYmxlKGxpbmUudGV4dCkpIHtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBtYXBwaW5nID0gcGFyc2VNYXBwaW5nKGxpbmUudGV4dCk7XG4gICAgaWYgKCFtYXBwaW5nKSBjb250aW51ZTtcbiAgICBrZXlzLnB1c2goe1xuICAgICAgLi4ubWFwcGluZyxcbiAgICAgIG5vOiBsaW5lLm5vLFxuICAgICAgY2hpbGRyZW46IGNoaWxkcmVuT2YoYWxsLCBpZHgsIGMpLFxuICAgIH0pO1xuICB9XG5cbiAgY29uc3QgZmluZCA9IChuYW1lOiBzdHJpbmcpOiBNYXBwaW5nTGluZSB8IHVuZGVmaW5lZCA9PlxuICAgIGtleXMuZmluZCgoa2V5KSA9PiBrZXkua2V5ID09PSBuYW1lKTtcbiAgaWYgKHBhcnNlZCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgY29uc3QgY3R4OiBTdGVwQ29udGV4dCA9IHtcbiAgICAgIG1hdHJpeDogam9iLm1hdHJpeCxcbiAgICAgIHdkOiB5YW1sU2NhbGFyKHBhcnNlZFtcIndvcmtpbmctZGlyZWN0b3J5XCJdKSA/PyBqb2IuZGVmYXVsdFdkLFxuICAgICAgY29udGludWVPbkVycm9yOiBbXG4gICAgICAgIC4uLlt5YW1sU2NhbGFyKHBhcnNlZFtcImNvbnRpbnVlLW9uLWVycm9yXCJdKV0uZmlsdGVyKCh2KTogdiBpcyBzdHJpbmcgPT5cbiAgICAgICAgICB2ICE9PSB1bmRlZmluZWRcbiAgICAgICAgKSxcbiAgICAgICAgLi4uKGpvYi5jb250aW51ZU9uRXJyb3IgPT09IHVuZGVmaW5lZCA/IFtdIDogW2pvYi5jb250aW51ZU9uRXJyb3JdKSxcbiAgICAgIF0sXG4gICAgfTtcbiAgICBjb25zdCBmaW5kaW5nczogQ2FyZ29EZW55Q2lGaW5kaW5nW10gPSBbXTtcbiAgICBjb25zdCB1c2VzID0geWFtbFNjYWxhcihwYXJzZWQudXNlcyk7XG4gICAgaWYgKHVzZXMgIT09IHVuZGVmaW5lZCAmJiBBQ1RJT05fUkVQTy50ZXN0KHVzZXMpKSB7XG4gICAgICBjb25zdCBpbnB1dHMgPSBuZXcgTWFwPHN0cmluZywgc3RyaW5nPigpO1xuICAgICAgaWYgKFxuICAgICAgICBwYXJzZWQud2l0aCAhPT0gbnVsbCAmJiB0eXBlb2YgcGFyc2VkLndpdGggPT09IFwib2JqZWN0XCIgJiZcbiAgICAgICAgIUFycmF5LmlzQXJyYXkocGFyc2VkLndpdGgpXG4gICAgICApIHtcbiAgICAgICAgZm9yIChjb25zdCBba2V5LCB2YWx1ZV0gb2YgT2JqZWN0LmVudHJpZXMocGFyc2VkLndpdGgpKSB7XG4gICAgICAgICAgY29uc3Qgc2NhbGFyID0geWFtbFNjYWxhcih2YWx1ZSk7XG4gICAgICAgICAgaWYgKHNjYWxhciAhPT0gdW5kZWZpbmVkKSBpbnB1dHMuc2V0KGtleSwgc2NhbGFyKTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgZmluZGluZ3MucHVzaCguLi5hY3Rpb25GaW5kaW5ncyhpbnB1dHMsIGN0eCkpO1xuICAgIH1cbiAgICBjb25zdCBydW4gPSB5YW1sU2NhbGFyKHBhcnNlZC5ydW4pO1xuICAgIGlmIChydW4gIT09IHVuZGVmaW5lZCkge1xuICAgICAgY29uc3QgcnVuS2V5ID0gZmluZChcInJ1blwiKTtcbiAgICAgIGNvbnN0IG5vID0gKHJ1bktleT8ubm8gPz8gc3RhcnQgKyAxKSArXG4gICAgICAgIChydW5LZXkgIT09IHVuZGVmaW5lZCAmJiBCTE9DS19JTkRJQ0FUT1IudGVzdChzY2FsYXJWYWx1ZShydW5LZXkucmF3KSlcbiAgICAgICAgICA/IDFcbiAgICAgICAgICA6IDApO1xuICAgICAgZmluZGluZ3MucHVzaChcbiAgICAgICAgLi4ucnVuRmluZGluZ3Moe1xuICAgICAgICAgIGtleTogXCJydW5cIixcbiAgICAgICAgICByYXc6IFwifFwiLFxuICAgICAgICAgIG5vLFxuICAgICAgICAgIGNoaWxkcmVuOiBydW4uc3BsaXQoXCJcXG5cIikubWFwKCh0ZXh0LCBpKSA9PiAoe1xuICAgICAgICAgICAgdGV4dCxcbiAgICAgICAgICAgIGluZGVudDogMCxcbiAgICAgICAgICAgIG5vOiBubyArIGksXG4gICAgICAgICAgfSkpLFxuICAgICAgICB9LCBjdHgpLFxuICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIGZpbmRpbmdzO1xuICB9XG4gIC8vIEEgc3RlcCdzIG93biBgd29ya2luZy1kaXJlY3RvcnlgIHdpbnMgb3ZlciB0aGUgam9iJ3MgYW5kIHRoZSB3b3JrZmxvdydzXG4gIC8vIGBkZWZhdWx0cy5ydW4ud29ya2luZy1kaXJlY3RvcnlgLCB3aGljaCBhcHBseSB0byBgcnVuOmAgc3RlcHMgb25seS5cbiAgY29uc3Qgd2RLZXkgPSBmaW5kKFwid29ya2luZy1kaXJlY3RvcnlcIik7XG4gIGNvbnN0IGNvZUtleSA9IGZpbmQoXCJjb250aW51ZS1vbi1lcnJvclwiKTtcbiAgY29uc3QgY3R4OiBTdGVwQ29udGV4dCA9IHtcbiAgICBtYXRyaXg6IGpvYi5tYXRyaXgsXG4gICAgd2Q6IHdkS2V5ID09PSB1bmRlZmluZWQgPyBqb2IuZGVmYXVsdFdkIDogc2NhbGFyVmFsdWUod2RLZXkucmF3KSxcbiAgICBjb250aW51ZU9uRXJyb3I6IFtcbiAgICAgIC4uLihjb2VLZXkgPT09IHVuZGVmaW5lZCA/IFtdIDogW3NjYWxhclZhbHVlKGNvZUtleS5yYXcpXSksXG4gICAgICAuLi4oam9iLmNvbnRpbnVlT25FcnJvciA9PT0gdW5kZWZpbmVkID8gW10gOiBbam9iLmNvbnRpbnVlT25FcnJvcl0pLFxuICAgIF0sXG4gIH07XG4gIGNvbnN0IGZpbmRpbmdzOiBDYXJnb0RlbnlDaUZpbmRpbmdbXSA9IFtdO1xuICBjb25zdCB1c2VzS2V5ID0gZmluZChcInVzZXNcIik7XG4gIGlmICh1c2VzS2V5ICE9PSB1bmRlZmluZWQgJiYgQUNUSU9OX1JFUE8udGVzdChzY2FsYXJWYWx1ZSh1c2VzS2V5LnJhdykpKSB7XG4gICAgY29uc3Qgd2l0aEtleSA9IGZpbmQoXCJ3aXRoXCIpO1xuICAgIGZpbmRpbmdzLnB1c2goXG4gICAgICAuLi5hY3Rpb25GaW5kaW5ncyhcbiAgICAgICAgd2l0aEtleSA9PT0gdW5kZWZpbmVkID8gbmV3IE1hcCgpIDogcGFyc2VXaXRoKHdpdGhLZXkuY2hpbGRyZW4pLFxuICAgICAgICBjdHgsXG4gICAgICApLFxuICAgICk7XG4gIH1cbiAgZm9yIChjb25zdCBrZXkgb2Yga2V5cykge1xuICAgIGlmIChrZXkua2V5ID09PSBcInJ1blwiKSBmaW5kaW5ncy5wdXNoKC4uLnJ1bkZpbmRpbmdzKGtleSwgY3R4KSk7XG4gIH1cbiAgcmV0dXJuIGZpbmRpbmdzO1xufVxuXG4vKiogVGhlIHBhcnRzIG9mIGEgcGFyc2VkIGpvYiB0aGlzIGdhdGUgcmVhZHMuICovXG5pbnRlcmZhY2UgUGFyc2VkSm9iIHtcbiAgc3RyYXRlZ3k/OiB7IG1hdHJpeD86IFJlY29yZDxzdHJpbmcsIHVua25vd24+IH07XG4gIGRlZmF1bHRzPzogeyBydW4/OiB7IFwid29ya2luZy1kaXJlY3RvcnlcIj86IHVua25vd24gfSB9O1xuICBcImNvbnRpbnVlLW9uLWVycm9yXCI/OiB1bmtub3duO1xuICBzdGVwcz86IFJlY29yZDxzdHJpbmcsIHVua25vd24+W107XG59XG5cbi8qKiBBIHBhcnNlZCBZQU1MIHNjYWxhciBhcyB0aGUgdGV4dCBHaXRIdWIgd291bGQgc2VlLCBvciB1bmRlZmluZWQuICovXG5mdW5jdGlvbiB5YW1sU2NhbGFyKHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiB8fCB0eXBlb2YgdmFsdWUgPT09IFwibnVtYmVyXCIgfHxcbiAgICAgIHR5cGVvZiB2YWx1ZSA9PT0gXCJib29sZWFuXCJcbiAgICA/IFN0cmluZyh2YWx1ZSlcbiAgICA6IHVuZGVmaW5lZDtcbn1cblxuLyoqIFRoZSBwYXJ0cyBvZiBhIHBhcnNlZCB3b3JrZmxvdyB0aGlzIGdhdGUgcmVhZHMuICovXG5pbnRlcmZhY2UgUGFyc2VkV29ya2Zsb3cge1xuICBvbj86IHVua25vd247XG4gIGRlZmF1bHRzPzogeyBydW4/OiB7IFwid29ya2luZy1kaXJlY3RvcnlcIj86IHVua25vd24gfSB9O1xuICBqb2JzPzogUmVjb3JkPHN0cmluZywgUGFyc2VkSm9iIHwgbnVsbD47XG59XG5cbi8qKiBUaGUgd29ya2Zsb3cgYXMgWUFNTCBwYXJzZWQgaXQsIG9yIG51bGwgd2hlbiBpdCBpcyBub3QgdmFsaWQgWUFNTC4gKi9cbmZ1bmN0aW9uIHBhcnNlV29ya2Zsb3codGV4dDogc3RyaW5nKTogUGFyc2VkV29ya2Zsb3cgfCBudWxsIHtcbiAgdHJ5IHtcbiAgICBjb25zdCBwYXJzZWQgPSBwYXJzZVlhbWwodGV4dCk7XG4gICAgLy8gQmFyZSBzdGVwIHNlcXVlbmNlcyBhcmUgYWNjZXB0ZWQgYnkgdGhlIHNjYW5uZXIgYXMgd29ya2Zsb3cgZnJhZ21lbnRzLlxuICAgIHJldHVybiBwYXJzZWQgIT09IG51bGwgJiYgdHlwZW9mIHBhcnNlZCA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgICAhQXJyYXkuaXNBcnJheShwYXJzZWQpXG4gICAgICA/IHBhcnNlZCBhcyBQYXJzZWRXb3JrZmxvd1xuICAgICAgOiBudWxsO1xuICB9IGNhdGNoIHtcbiAgICAvLyBHaXRIdWIgZG9lcyBub3QgcnVuIGEgd29ya2Zsb3cgdGhhdCBpcyBub3QgdmFsaWQgWUFNTCwgc28gQ0kgaGFzIG5vIGRlZmF1bHQgdG8gbWlycm9yLlxuICAgIHJldHVybiBudWxsO1xuICB9XG59XG5cbi8qKiBXaGF0IGRlY2lkZXMgd2hldGhlciBDSSBydW5zIGEgd29ya2Zsb3cgZm9yIGEgcHVzaDogdGhlIHBhdGhzIGFuZCBicmFuY2hlcyBpdCBjYXJyaWVzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBXb3JrZmxvd1J1bkNvbnRleHQge1xuICAvKiogRXZlcnkgcGF0aCB0aGUgYnJhbmNoJ3MgY29tbWl0cyB0b3VjaCAoZGVsZXRlZCBvbmVzIHRvbyk7IHVua25vd24gbWVhbnMgYSBwYXRoIGZpbHRlciBtYXRjaGVzLiAqL1xuICB0b3VjaGVkPzogcmVhZG9ubHkgc3RyaW5nW107XG4gIC8qKiBUaGUgYnJhbmNoZXMgcHVzaGVkLCB3aXRob3V0IGByZWZzL2hlYWRzL2A7IHVua25vd24gbWVhbnMgYSBicmFuY2ggZmlsdGVyIG1hdGNoZXMuICovXG4gIGJyYW5jaGVzPzogcmVhZG9ubHkgc3RyaW5nW107XG59XG5cbi8qKiBUaGUgbW9zdCBjaGFyYWN0ZXJzIG9mIGEgYHBhdGhzYCBvciBgYnJhbmNoZXNgIHBhdHRlcm4gdGhlIGdhdGUgcmVhZHMuICovXG5jb25zdCBGSUxURVJfUEFUVEVSTl9DQVAgPSAyMDA7XG5cbi8qKiBSZWFkIGEgc2luZ2xlLWNoYXJhY3RlciBjbGFzcyB3aXRob3V0IGNvbXBpbGluZyByZXBvc2l0b3J5IGlucHV0IGFzIGEgcmVnZXguICovXG5mdW5jdGlvbiBmaWx0ZXJDbGFzcyhzb3VyY2U6IHN0cmluZyk6ICgoY2g6IHN0cmluZykgPT4gYm9vbGVhbikgfCBudWxsIHtcbiAgY29uc3QgbmVnYXRlZCA9IHNvdXJjZS5zdGFydHNXaXRoKFwiXlwiKTtcbiAgY29uc3QgY2hhcnMgPSBuZWdhdGVkID8gc291cmNlLnNsaWNlKDEpIDogc291cmNlO1xuICBpZiAoIWNoYXJzKSByZXR1cm4gbnVsbDtcbiAgY29uc3QgcmFuZ2VzOiBbbnVtYmVyLCBudW1iZXJdW10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBjaGFycy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IHN0YXJ0ID0gY2hhcnMuY2hhckNvZGVBdChpKTtcbiAgICBpZiAoY2hhcnNbaSArIDFdID09PSBcIi1cIiAmJiBpICsgMiA8IGNoYXJzLmxlbmd0aCkge1xuICAgICAgY29uc3QgZW5kID0gY2hhcnMuY2hhckNvZGVBdChpICsgMik7XG4gICAgICBpZiAoc3RhcnQgPiBlbmQpIHJldHVybiBudWxsO1xuICAgICAgcmFuZ2VzLnB1c2goW3N0YXJ0LCBlbmRdKTtcbiAgICAgIGkgKz0gMjtcbiAgICB9IGVsc2UgcmFuZ2VzLnB1c2goW3N0YXJ0LCBzdGFydF0pO1xuICB9XG4gIHJldHVybiAoY2gpID0+IHtcbiAgICBjb25zdCBjb2RlID0gY2guY2hhckNvZGVBdCgwKTtcbiAgICBjb25zdCBmb3VuZCA9IHJhbmdlcy5zb21lKChbc3RhcnQsIGVuZF0pID0+IGNvZGUgPj0gc3RhcnQgJiYgY29kZSA8PSBlbmQpO1xuICAgIHJldHVybiBuZWdhdGVkID8gIWZvdW5kIDogZm91bmQ7XG4gIH07XG59XG5cbi8qKlxuICogTWF0Y2ggYSBHaXRIdWIgZmlsdGVyIHBhdHRlcm46IGAqYCBpcyBhbnkgcnVuIGJ1dCBgL2AsIGAqKmAgYW55IHJ1bixcbiAqIGA/YCBhbmQgYCtgIGFwcGx5IHRvIHRoZSBjaGFyYWN0ZXIgYmVmb3JlIHRoZW0sIGBbLi4uXWAgaXMgYSBjbGFzcy4gTnVsbFxuICogZm9yIGEgcGF0dGVybiB0aGUgZ2F0ZSBjYW5ub3QgcmVhZCwgd2hpY2ggdGhlIGNhbGxlciB0cmVhdHMgYXMgYSBtYXRjaC5cbiAqL1xuZnVuY3Rpb24gZmlsdGVyUGF0dGVybk1hdGNoZXMocGF0dGVybjogc3RyaW5nLCBuYW1lOiBzdHJpbmcpOiBib29sZWFuIHwgbnVsbCB7XG4gIGlmIChwYXR0ZXJuLmxlbmd0aCA+IEZJTFRFUl9QQVRURVJOX0NBUCkgcmV0dXJuIG51bGw7XG4gIGNvbnN0IHRva2VuczogeyBraW5kOiBzdHJpbmc7IG1hdGNoZXM/OiAoY2g6IHN0cmluZykgPT4gYm9vbGVhbiB9W10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBwYXR0ZXJuLmxlbmd0aDsgaSsrKSB7XG4gICAgY29uc3QgY2ggPSBwYXR0ZXJuW2ldID8/IFwiXCI7XG4gICAgaWYgKHBhdHRlcm4uc3RhcnRzV2l0aChcIioqL1wiLCBpKSkge1xuICAgICAgdG9rZW5zLnB1c2goeyBraW5kOiBcImRpcnNcIiB9KTtcbiAgICAgIGkgKz0gMjtcbiAgICB9IGVsc2UgaWYgKGNoID09PSBcIipcIikge1xuICAgICAgaWYgKHBhdHRlcm5baSArIDFdID09PSBcIipcIikge1xuICAgICAgICB0b2tlbnMucHVzaCh7IGtpbmQ6IFwiZ2xvYnN0YXJcIiB9KTtcbiAgICAgICAgaSsrO1xuICAgICAgfSBlbHNlIHRva2Vucy5wdXNoKHsga2luZDogXCJzdGFyXCIgfSk7XG4gICAgfSBlbHNlIGlmIChjaCA9PT0gXCI/XCIgfHwgY2ggPT09IFwiK1wiKSB7XG4gICAgICBjb25zdCBwcmV2aW91cyA9IHRva2Vuc1t0b2tlbnMubGVuZ3RoIC0gMV07XG4gICAgICBpZiAoIXByZXZpb3VzIHx8IHByZXZpb3VzLmtpbmQgIT09IFwiY2hhclwiKSByZXR1cm4gbnVsbDtcbiAgICAgIHByZXZpb3VzLmtpbmQgPSBjaDtcbiAgICB9IGVsc2UgaWYgKGNoID09PSBcIltcIikge1xuICAgICAgY29uc3QgY2xvc2UgPSBwYXR0ZXJuLmluZGV4T2YoXCJdXCIsIGkgKyAyKTtcbiAgICAgIGlmIChjbG9zZSA9PT0gLTEpIHJldHVybiBudWxsO1xuICAgICAgY29uc3QgbWF0Y2hlcyA9IGZpbHRlckNsYXNzKHBhdHRlcm4uc2xpY2UoaSArIDEsIGNsb3NlKSk7XG4gICAgICBpZiAoIW1hdGNoZXMpIHJldHVybiBudWxsO1xuICAgICAgdG9rZW5zLnB1c2goeyBraW5kOiBcImNoYXJcIiwgbWF0Y2hlcyB9KTtcbiAgICAgIGkgPSBjbG9zZTtcbiAgICB9IGVsc2Uge1xuICAgICAgaWYgKGNoID09PSBcIlxcXFxcIiAmJiBpICsgMSA8IHBhdHRlcm4ubGVuZ3RoKSBpKys7XG4gICAgICBjb25zdCBsaXRlcmFsID0gcGF0dGVybltpXTtcbiAgICAgIHRva2Vucy5wdXNoKHsga2luZDogXCJjaGFyXCIsIG1hdGNoZXM6ICh2YWx1ZSkgPT4gdmFsdWUgPT09IGxpdGVyYWwgfSk7XG4gICAgfVxuICB9XG4gIGxldCBuZXh0ID0gQXJyYXkuZnJvbShcbiAgICB7IGxlbmd0aDogbmFtZS5sZW5ndGggKyAxIH0sXG4gICAgKF8sIGkpID0+IGkgPT09IG5hbWUubGVuZ3RoLFxuICApO1xuICBmb3IgKGxldCB0ID0gdG9rZW5zLmxlbmd0aCAtIDE7IHQgPj0gMDsgdC0tKSB7XG4gICAgY29uc3QgdG9rZW4gPSB0b2tlbnNbdF0hO1xuICAgIGNvbnN0IHJvdyA9IEFycmF5PGJvb2xlYW4+KG5hbWUubGVuZ3RoICsgMSkuZmlsbChmYWxzZSk7XG4gICAgbGV0IHNsYXNoTWF0Y2ggPSBmYWxzZTtcbiAgICBmb3IgKGxldCBpID0gbmFtZS5sZW5ndGg7IGkgPj0gMDsgaS0tKSB7XG4gICAgICBjb25zdCBjaCA9IG5hbWVbaV07XG4gICAgICBjb25zdCBtYXRjaGVkID0gY2ggIT09IHVuZGVmaW5lZCAmJiAodG9rZW4ubWF0Y2hlcz8uKGNoKSA/PyBmYWxzZSk7XG4gICAgICBpZiAodG9rZW4ua2luZCA9PT0gXCJjaGFyXCIpIHJvd1tpXSA9IG1hdGNoZWQgJiYgbmV4dFtpICsgMV0hO1xuICAgICAgZWxzZSBpZiAodG9rZW4ua2luZCA9PT0gXCI/XCIpIHtcbiAgICAgICAgcm93W2ldID0gbmV4dFtpXSEgfHwgKG1hdGNoZWQgJiYgbmV4dFtpICsgMV0hKTtcbiAgICAgIH0gZWxzZSBpZiAodG9rZW4ua2luZCA9PT0gXCIrXCIpIHtcbiAgICAgICAgcm93W2ldID0gbWF0Y2hlZCAmJiAobmV4dFtpICsgMV0hIHx8IHJvd1tpICsgMV0hKTtcbiAgICAgIH0gZWxzZSBpZiAodG9rZW4ua2luZCA9PT0gXCJkaXJzXCIpIHtcbiAgICAgICAgc2xhc2hNYXRjaCB8fD0gY2ggPT09IFwiL1wiICYmIG5leHRbaSArIDFdITtcbiAgICAgICAgcm93W2ldID0gbmV4dFtpXSEgfHwgc2xhc2hNYXRjaDtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHJvd1tpXSA9IG5leHRbaV0hIHx8XG4gICAgICAgICAgKGNoICE9PSB1bmRlZmluZWQgJiYgKHRva2VuLmtpbmQgPT09IFwiZ2xvYnN0YXJcIiB8fCBjaCAhPT0gXCIvXCIpICYmXG4gICAgICAgICAgICByb3dbaSArIDFdISk7XG4gICAgICB9XG4gICAgfVxuICAgIG5leHQgPSByb3c7XG4gIH1cbiAgcmV0dXJuIG5leHRbMF0hO1xufVxuXG4vKipcbiAqIFdoZXRoZXIgdGhlIGZpbHRlciBwYXR0ZXJucyBzZWxlY3QgYG5hbWVgOiB0aGUgbGFzdCBwYXR0ZXJuIHRoYXQgbWF0Y2hlc1xuICogZGVjaWRlcywgYW5kIGEgbGVhZGluZyBgIWAgZGVzZWxlY3RzLiBOdWxsIG1lYW5zIHRoZSBmaWx0ZXIgaXMgdW5yZWFkYWJsZS5cbiAqL1xuZnVuY3Rpb24gZmlsdGVyU2VsZWN0cyhcbiAgcGF0dGVybnM6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBuYW1lOiBzdHJpbmcsXG4pOiBib29sZWFuIHwgbnVsbCB7XG4gIGxldCBzZWxlY3RlZCA9IGZhbHNlO1xuICBmb3IgKGNvbnN0IHBhdHRlcm4gb2YgcGF0dGVybnMpIHtcbiAgICBjb25zdCBuZWdhdGVkID0gcGF0dGVybi5zdGFydHNXaXRoKFwiIVwiKTtcbiAgICBjb25zdCBtYXRjaGVzID0gZmlsdGVyUGF0dGVybk1hdGNoZXMoXG4gICAgICBuZWdhdGVkID8gcGF0dGVybi5zbGljZSgxKSA6IHBhdHRlcm4sXG4gICAgICBuYW1lLFxuICAgICk7XG4gICAgaWYgKG1hdGNoZXMgPT09IG51bGwpIHJldHVybiBudWxsO1xuICAgIGlmIChtYXRjaGVzKSBzZWxlY3RlZCA9ICFuZWdhdGVkO1xuICB9XG4gIHJldHVybiBzZWxlY3RlZDtcbn1cblxuZnVuY3Rpb24gc3RyaW5nTGlzdCh2YWx1ZTogdW5rbm93bik6IHN0cmluZ1tdIHwgdW5kZWZpbmVkIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIikgcmV0dXJuIFt2YWx1ZV07XG4gIHJldHVybiBBcnJheS5pc0FycmF5KHZhbHVlKSAmJiB2YWx1ZS5ldmVyeSgodikgPT4gdHlwZW9mIHYgPT09IFwic3RyaW5nXCIpXG4gICAgPyB2YWx1ZSBhcyBzdHJpbmdbXVxuICAgIDogdW5kZWZpbmVkO1xufVxuXG4vKiogV2hldGhlciB0aGUgbmFtZXMgcGFzcyBhbiBpbmNsdWRlIGxpc3QgYW5kIGFuIGlnbm9yZSBsaXN0IChlaXRoZXIgbWF5IGJlIGFic2VudCkuICovXG5mdW5jdGlvbiBuYW1lc1Bhc3MoXG4gIG5hbWVzOiByZWFkb25seSBzdHJpbmdbXSB8IHVuZGVmaW5lZCxcbiAgaW5jbHVkZTogc3RyaW5nW10gfCB1bmRlZmluZWQsXG4gIGlnbm9yZTogc3RyaW5nW10gfCB1bmRlZmluZWQsXG4pOiBib29sZWFuIHtcbiAgaWYgKG5hbWVzID09PSB1bmRlZmluZWQpIHJldHVybiB0cnVlO1xuICBpZiAoaW5jbHVkZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgcmV0dXJuIG5hbWVzLnNvbWUoKG5hbWUpID0+IGZpbHRlclNlbGVjdHMoaW5jbHVkZSwgbmFtZSkgIT09IGZhbHNlKTtcbiAgfVxuICBpZiAoaWdub3JlICE9PSB1bmRlZmluZWQpIHtcbiAgICByZXR1cm4gbmFtZXMuc29tZSgobmFtZSkgPT4gZmlsdGVyU2VsZWN0cyhpZ25vcmUsIG5hbWUpICE9PSB0cnVlKTtcbiAgfVxuICByZXR1cm4gdHJ1ZTtcbn1cblxuLyoqIE9uZSBgb246YCBldmVudCdzIGZpbHRlcnM6IGFuIGV2ZW50IHdpdGggbm8gbWFwcGluZyBoYXMgbm9uZS4gKi9cbmZ1bmN0aW9uIGV2ZW50RmlsdGVycyhjb25maWc6IHVua25vd24pOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPiB7XG4gIHJldHVybiBjb25maWcgIT09IG51bGwgJiYgdHlwZW9mIGNvbmZpZyA9PT0gXCJvYmplY3RcIiAmJlxuICAgICAgIUFycmF5LmlzQXJyYXkoY29uZmlnKVxuICAgID8gY29uZmlnIGFzIFJlY29yZDxzdHJpbmcsIHVua25vd24+XG4gICAgOiB7fTtcbn1cblxuLyoqXG4gKiBXaGV0aGVyIENJIGNhbiBydW4gdGhlIHdvcmtmbG93IGZvciBhIHB1c2ggb2YgdGhlc2UgYnJhbmNoZXMgYW5kIHBhdGhzOlxuICogaXQgaGFzIGEgYHB1bGxfcmVxdWVzdGAsIGBwdWxsX3JlcXVlc3RfdGFyZ2V0YCwgYG1lcmdlX2dyb3VwYCBvclxuICogYHdvcmtmbG93X2NhbGxgIHRyaWdnZXIsIG9yIGEgYHB1c2hgIHRyaWdnZXIgd2hvc2UgYnJhbmNoIGZpbHRlciBtYXRjaGVzO1xuICogYW5kIHRoZSB0cmlnZ2VyJ3MgYHBhdGhzYCAvIGBwYXRocy1pZ25vcmVgIGZpbHRlciBzZWxlY3RzIGEgdG91Y2hlZCBwYXRoLlxuICogQSBgcHVsbF9yZXF1ZXN0YCBgYnJhbmNoZXNgIGZpbHRlciBpcyBub3QgcmVhZCAodGhlIGJhc2UgYnJhbmNoIGlzIG5vdFxuICoga25vd24gaGVyZSksIHNvIGl0IG1hdGNoZXMuIEEgd29ya2Zsb3cgd2hvc2UgdHJpZ2dlcnMgY2Fubm90IGJlIHJlYWQgcnVucy5cbiAqL1xuZnVuY3Rpb24gd29ya2Zsb3dSdW5zRm9yKFxuICB3b3JrZmxvdzogUGFyc2VkV29ya2Zsb3cgfCBudWxsLFxuICBjb250ZXh0OiBXb3JrZmxvd1J1bkNvbnRleHQsXG4pOiBib29sZWFuIHtcbiAgY29uc3Qgb24gPSB3b3JrZmxvdyA9PT0gbnVsbFxuICAgID8gdW5kZWZpbmVkXG4gICAgOiB3b3JrZmxvdy5vbiA/PyAod29ya2Zsb3cgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4pW1widHJ1ZVwiXTtcbiAgbGV0IGV2ZW50czogUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIGlmICh0eXBlb2Ygb24gPT09IFwic3RyaW5nXCIpIGV2ZW50cyA9IHsgW29uXTogbnVsbCB9O1xuICBlbHNlIGlmIChBcnJheS5pc0FycmF5KG9uKSkge1xuICAgIGV2ZW50cyA9IE9iamVjdC5mcm9tRW50cmllcyhvbi5tYXAoKGV2ZW50KSA9PiBbU3RyaW5nKGV2ZW50KSwgbnVsbF0pKTtcbiAgfSBlbHNlIGlmIChvbiAhPT0gbnVsbCAmJiB0eXBlb2Ygb24gPT09IFwib2JqZWN0XCIpIHtcbiAgICBldmVudHMgPSBvbiBhcyBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPjtcbiAgfSBlbHNlIHJldHVybiB0cnVlO1xuICBjb25zdCBwYXRoc1Bhc3MgPSAoZmlsdGVyczogUmVjb3JkPHN0cmluZywgdW5rbm93bj4pID0+XG4gICAgbmFtZXNQYXNzKFxuICAgICAgY29udGV4dC50b3VjaGVkLFxuICAgICAgc3RyaW5nTGlzdChmaWx0ZXJzLnBhdGhzKSxcbiAgICAgIHN0cmluZ0xpc3QoZmlsdGVyc1tcInBhdGhzLWlnbm9yZVwiXSksXG4gICAgKTtcbiAgcmV0dXJuIE9iamVjdC5lbnRyaWVzKGV2ZW50cykuc29tZSgoW2V2ZW50LCBjb25maWddKSA9PiB7XG4gICAgY29uc3QgZmlsdGVycyA9IGV2ZW50RmlsdGVycyhjb25maWcpO1xuICAgIGlmIChldmVudCA9PT0gXCJwdWxsX3JlcXVlc3RcIiB8fCBldmVudCA9PT0gXCJwdWxsX3JlcXVlc3RfdGFyZ2V0XCIpIHtcbiAgICAgIHJldHVybiBwYXRoc1Bhc3MoZmlsdGVycyk7XG4gICAgfVxuICAgIGlmIChldmVudCA9PT0gXCJtZXJnZV9ncm91cFwiIHx8IGV2ZW50ID09PSBcIndvcmtmbG93X2NhbGxcIikgcmV0dXJuIHRydWU7XG4gICAgaWYgKGV2ZW50ICE9PSBcInB1c2hcIikgcmV0dXJuIGZhbHNlO1xuICAgIGNvbnN0IGJyYW5jaGVzID0gc3RyaW5nTGlzdChmaWx0ZXJzLmJyYW5jaGVzKTtcbiAgICBjb25zdCBicmFuY2hlc0lnbm9yZSA9IHN0cmluZ0xpc3QoZmlsdGVyc1tcImJyYW5jaGVzLWlnbm9yZVwiXSk7XG4gICAgLy8gQSBwdXNoIGZpbHRlcmVkIGJ5IHRhZ3MgYWxvbmUgZG9lcyBub3QgcnVuIGZvciBhIGJyYW5jaCBwdXNoLlxuICAgIGlmIChcbiAgICAgIGJyYW5jaGVzID09PSB1bmRlZmluZWQgJiYgYnJhbmNoZXNJZ25vcmUgPT09IHVuZGVmaW5lZCAmJlxuICAgICAgKGZpbHRlcnMudGFncyAhPT0gdW5kZWZpbmVkIHx8IGZpbHRlcnNbXCJ0YWdzLWlnbm9yZVwiXSAhPT0gdW5kZWZpbmVkKVxuICAgICkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiBuYW1lc1Bhc3MoY29udGV4dC5icmFuY2hlcywgYnJhbmNoZXMsIGJyYW5jaGVzSWdub3JlKSAmJlxuICAgICAgcGF0aHNQYXNzKGZpbHRlcnMpO1xuICB9KTtcbn1cblxuLyoqIEEgam9iIG9mIHRoZSB3b3JrZmxvdzogaXRzIGhlYWRlciBsaW5lIGFuZCB0aGUgbGluZSBhZnRlciBpdHMgbGFzdC4gKi9cbmludGVyZmFjZSBKb2JCbG9jayB7XG4gIGhlYWRlcjogbnVtYmVyO1xuICBlbmQ6IG51bWJlcjtcbiAgaW5kZW50OiBudW1iZXI7XG59XG5cbi8qKlxuICogVGhlIGpvYnMgb2YgdGhlIHdvcmtmbG93OiB0aGUgZGlyZWN0IGNoaWxkcmVuIG9mIHRoZSB0b3AtbGV2ZWwgYGpvYnM6YCBrZXksXG4gKiBhdCB3aGF0ZXZlciBpbmRlbnQgdGhlIGZpbGUgdXNlcy5cbiAqL1xuZnVuY3Rpb24gam9iQmxvY2tzKGxpbmVzOiByZWFkb25seSBzdHJpbmdbXSk6IEpvYkJsb2NrW10ge1xuICBjb25zdCBqb2JzQXQgPSBsaW5lcy5maW5kSW5kZXgoKGxpbmUpID0+IC9eam9iczpcXHMqKD86Iy4qKT8kLy50ZXN0KGxpbmUpKTtcbiAgaWYgKGpvYnNBdCA9PT0gLTEpIHJldHVybiBbXTtcbiAgY29uc3QgZmlyc3QgPSBsaW5lcy5zbGljZShqb2JzQXQgKyAxKS5maW5kKChsaW5lKSA9PlxuICAgICFpc1NraXBwYWJsZShsaW5lKSAmJiBpbmRlbnRPZihsaW5lKSA+IDBcbiAgKTtcbiAgaWYgKGZpcnN0ID09PSB1bmRlZmluZWQpIHJldHVybiBbXTtcbiAgY29uc3QgaW5kZW50ID0gaW5kZW50T2YoZmlyc3QpO1xuICBjb25zdCBibG9ja3M6IEpvYkJsb2NrW10gPSBbXTtcbiAgZm9yIChsZXQgaSA9IGpvYnNBdCArIDE7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGxpbmUgPSBsaW5lc1tpXSA/PyBcIlwiO1xuICAgIGlmIChpc1NraXBwYWJsZShsaW5lKSkgY29udGludWU7XG4gICAgaWYgKGluZGVudE9mKGxpbmUpID09PSAwKSBicmVhaztcbiAgICBpZiAoXG4gICAgICBpbmRlbnRPZihsaW5lKSAhPT0gaW5kZW50IHx8XG4gICAgICAhL15cXHMqKD86W1xcdy1dK3xcIlteXCJdKlwifCdbXiddKicpOlxccyooPzomW1xcdy1dK1xccyopPyg/OiMuKik/JC8udGVzdChsaW5lKVxuICAgICkgY29udGludWU7XG4gICAgbGV0IGVuZCA9IGkgKyAxO1xuICAgIHdoaWxlIChcbiAgICAgIGVuZCA8IGxpbmVzLmxlbmd0aCAmJlxuICAgICAgKGlzU2tpcHBhYmxlKGxpbmVzW2VuZF0gPz8gXCJcIikgfHwgaW5kZW50T2YobGluZXNbZW5kXSA/PyBcIlwiKSA+IGluZGVudClcbiAgICApIGVuZCsrO1xuICAgIGJsb2Nrcy5wdXNoKHsgaGVhZGVyOiBpLCBlbmQsIGluZGVudCB9KTtcbiAgfVxuICByZXR1cm4gYmxvY2tzO1xufVxuXG4vKipcbiAqIFBhcnNlIG9uZSB3b3JrZmxvdyBmaWxlJ3MgdGV4dCBpbnRvIHRoZSBjYXJnby1kZW55IGludm9jYXRpb25zIGl0cyBzdGVwc1xuICogbWFrZS4gQSBzdGVwIHN0YXJ0cyBhdCBhIGAtIGAgbGluZSBhbmQgZW5kcyBhdCB0aGUgbmV4dCBub24tYmxhbmsgbGluZSBhdFxuICogb3IgYmVsb3cgaXRzIGRhc2gncyBpbmRlbnQuIENvbW1lbnQgbGluZXMgYXJlIGlnbm9yZWQuXG4gKlxuICogQSB3b3JrZmxvdyBDSSBjYW5ub3QgcnVuIGZvciB0aGUgcHVzaCAoc2VlIHtAbGluayB3b3JrZmxvd1J1bnNGb3J9KSBoYXMgbm9cbiAqIGZpbmRpbmdzLiBBIGBydW46YCBzdGVwIHdpdGhvdXQgaXRzIG93biBgd29ya2luZy1kaXJlY3RvcnlgIHRha2VzIHRoZSBqb2IncyxcbiAqIHRoZW4gdGhlIHdvcmtmbG93J3MsIGBkZWZhdWx0cy5ydW4ud29ya2luZy1kaXJlY3RvcnlgLiBBIHN0ZXAncyBvciBqb2Inc1xuICogYGNvbnRpbnVlLW9uLWVycm9yYCBtYXJrcyB0aGUgaW52b2NhdGlvbnMgaXQgYWxsb3dzIHRvIGZhaWwuXG4gKlxuICogU0lNUExFLU9OLVBVUlBPU0U6IGBleGNsdWRlYCBlbnRyaWVzIG9mIGEgbWF0cml4LCBgY29udGludWUtb24tZXJyb3JgIHRlc3RzIG90aGVyIHRoYW4gYSBsaXRlcmFsIHRydWUgb3Igb25lIG1hdHJpeCBrZXksIGEgYHB1bGxfcmVxdWVzdGAgYGJyYW5jaGVzYCBmaWx0ZXIsIGFuZCBzY3JpcHQtaGlkZGVuIGludm9jYXRpb25zIGFyZSBub3QgcmVhZCDigJQgdXBncmFkZSB3aGVuIGEgY2FyZ28gZGVueSBjaGVjayBydW4gZXNjYXBlcyB0aGlzIGdhdGUgaW4gcHJhY3RpY2Ugb3IgYSB3b3JrZmxvdyB1c2VzIG9uZSBvZiB0aG9zZSBmb3Jtcy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHdvcmtmbG93Q2FyZ29EZW55RmluZGluZ3MoXG4gIHRleHQ6IHN0cmluZyxcbiAgY29udGV4dDogV29ya2Zsb3dSdW5Db250ZXh0ID0ge30sXG4pOiBDYXJnb0RlbnlDaUZpbmRpbmdbXSB7XG4gIGNvbnN0IGxpbmVzID0gdGV4dC5zcGxpdChcIlxcblwiKS5tYXAoKHJhdykgPT4gcmF3LnJlcGxhY2UoL1xcciQvLCBcIlwiKSk7XG4gIGNvbnN0IHdvcmtmbG93ID0gcGFyc2VXb3JrZmxvdyh0ZXh0KTtcbiAgaWYgKCF3b3JrZmxvd1J1bnNGb3Iod29ya2Zsb3csIGNvbnRleHQpKSByZXR1cm4gW107XG4gIGNvbnN0IGZpbmRpbmdzOiBDYXJnb0RlbnlDaUZpbmRpbmdbXSA9IFtdO1xuICBjb25zdCB3b3JrZmxvd1dkID0geWFtbFNjYWxhcih3b3JrZmxvdz8uZGVmYXVsdHM/LnJ1bj8uW1wid29ya2luZy1kaXJlY3RvcnlcIl0pO1xuICBjb25zdCBqb2JzID0gam9iQmxvY2tzKGxpbmVzKTtcbiAgaWYgKHdvcmtmbG93ICE9PSBudWxsKSB7XG4gICAgZm9yIChjb25zdCBba2V5LCBwYXJzZWRKb2JdIG9mIE9iamVjdC5lbnRyaWVzKHdvcmtmbG93LmpvYnMgPz8ge30pKSB7XG4gICAgICBpZiAocGFyc2VkSm9iID09PSBudWxsIHx8ICFBcnJheS5pc0FycmF5KHBhcnNlZEpvYi5zdGVwcykpIGNvbnRpbnVlO1xuICAgICAgY29uc3Qgam9iOiBKb2JDb250ZXh0ID0ge1xuICAgICAgICBtYXRyaXg6IHBhcnNlZEpvYi5zdHJhdGVneT8ubWF0cml4ID8/IHt9LFxuICAgICAgICBkZWZhdWx0V2Q6IHlhbWxTY2FsYXIocGFyc2VkSm9iLmRlZmF1bHRzPy5ydW4/LltcIndvcmtpbmctZGlyZWN0b3J5XCJdKSA/P1xuICAgICAgICAgIHdvcmtmbG93V2QsXG4gICAgICAgIGNvbnRpbnVlT25FcnJvcjogeWFtbFNjYWxhcihwYXJzZWRKb2JbXCJjb250aW51ZS1vbi1lcnJvclwiXSksXG4gICAgICB9O1xuICAgICAgY29uc3QgYmxvY2sgPSBqb2JzLmZpbmQoKGNhbmRpZGF0ZSkgPT4ge1xuICAgICAgICBjb25zdCBoZWFkZXIgPSAobGluZXNbY2FuZGlkYXRlLmhlYWRlcl0gPz8gXCJcIikudHJpbSgpLnJlcGxhY2UoXG4gICAgICAgICAgLzpcXHMqKD86JltcXHctXStcXHMqKT8oPzojLiopPyQvLFxuICAgICAgICAgIFwiXCIsXG4gICAgICAgICk7XG4gICAgICAgIHJldHVybiAoaGVhZGVyLnN0YXJ0c1dpdGgoJ1wiJykgfHwgaGVhZGVyLnN0YXJ0c1dpdGgoXCInXCIpXG4gICAgICAgICAgPyB5YW1sU2NhbGFyKHBhcnNlWWFtbChoZWFkZXIpKVxuICAgICAgICAgIDogaGVhZGVyKSA9PT0ga2V5O1xuICAgICAgfSk7XG4gICAgICBjb25zdCBzdGVwc0xpbmUgPSBibG9jayA9PT0gdW5kZWZpbmVkXG4gICAgICAgID8gLTFcbiAgICAgICAgOiBsaW5lcy5maW5kSW5kZXgoKGxpbmUsIGkpID0+XG4gICAgICAgICAgaSA+IGJsb2NrLmhlYWRlciAmJiBpIDwgYmxvY2suZW5kICYmXG4gICAgICAgICAgL15cXHMqc3RlcHM6XFxzKig/OiZbXFx3LV0rXFxzKik/KD86Iy4qKT8kLy50ZXN0KGxpbmUpICYmXG4gICAgICAgICAgaW5kZW50T2YobGluZSkgPiBibG9jay5pbmRlbnRcbiAgICAgICAgKTtcbiAgICAgIGNvbnN0IGxvY2F0aW9uczogeyBzdGFydDogbnVtYmVyOyBlbmQ6IG51bWJlcjsgaW5kZW50OiBudW1iZXIgfVtdID0gW107XG4gICAgICBpZiAoYmxvY2sgIT09IHVuZGVmaW5lZCAmJiBzdGVwc0xpbmUgIT09IC0xKSB7XG4gICAgICAgIGNvbnN0IHN0ZXBzSW5kZW50ID0gaW5kZW50T2YobGluZXNbc3RlcHNMaW5lXSA/PyBcIlwiKTtcbiAgICAgICAgZm9yIChsZXQgaSA9IHN0ZXBzTGluZSArIDE7IGkgPCBibG9jay5lbmQ7KSB7XG4gICAgICAgICAgY29uc3QgbGluZSA9IGxpbmVzW2ldID8/IFwiXCI7XG4gICAgICAgICAgY29uc3QgaXRlbSA9IExJU1RfSVRFTS5leGVjKGxpbmUpO1xuICAgICAgICAgIGlmIChcbiAgICAgICAgICAgICFpc1NraXBwYWJsZShsaW5lKSAmJlxuICAgICAgICAgICAgKGluZGVudE9mKGxpbmUpIDwgc3RlcHNJbmRlbnQgfHxcbiAgICAgICAgICAgICAgKGluZGVudE9mKGxpbmUpID09PSBzdGVwc0luZGVudCAmJiBpdGVtID09PSBudWxsKSlcbiAgICAgICAgICApIGJyZWFrO1xuICAgICAgICAgIGlmIChpdGVtID09PSBudWxsKSB7XG4gICAgICAgICAgICBpKys7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgaW5kZW50ID0gKGl0ZW1bMV0gPz8gXCJcIikubGVuZ3RoO1xuICAgICAgICAgIGxldCBlbmQgPSBpICsgMTtcbiAgICAgICAgICB3aGlsZSAoXG4gICAgICAgICAgICBlbmQgPCBibG9jay5lbmQgJiZcbiAgICAgICAgICAgIChpc1NraXBwYWJsZShsaW5lc1tlbmRdID8/IFwiXCIpIHx8XG4gICAgICAgICAgICAgIGluZGVudE9mKGxpbmVzW2VuZF0gPz8gXCJcIikgPiBpbmRlbnQpXG4gICAgICAgICAgKSBlbmQrKztcbiAgICAgICAgICBsb2NhdGlvbnMucHVzaCh7IHN0YXJ0OiBpLCBlbmQsIGluZGVudCB9KTtcbiAgICAgICAgICBpID0gZW5kO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgICBmb3IgKGNvbnN0IFtpbmRleCwgc3RlcF0gb2YgcGFyc2VkSm9iLnN0ZXBzLmVudHJpZXMoKSkge1xuICAgICAgICBpZiAoc3RlcCA9PT0gbnVsbCB8fCB0eXBlb2Ygc3RlcCAhPT0gXCJvYmplY3RcIiB8fCBBcnJheS5pc0FycmF5KHN0ZXApKSB7XG4gICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgY29uc3QgbG9jID0gbG9jYXRpb25zW2luZGV4XTtcbiAgICAgICAgZmluZGluZ3MucHVzaChcbiAgICAgICAgICAuLi4obG9jID09PSB1bmRlZmluZWRcbiAgICAgICAgICAgID8gc3RlcEZpbmRpbmdzKFtcIi0gc3RlcDogcGFyc2VkXCJdLCAwLCAxLCAwLCBqb2IsIHN0ZXApLm1hcChcbiAgICAgICAgICAgICAgKGZpbmRpbmcpID0+XG4gICAgICAgICAgICAgICAgZmluZGluZy5raW5kID09PSBcInVucnVubmFibGVcIlxuICAgICAgICAgICAgICAgICAgPyB7IC4uLmZpbmRpbmcsIHNvdXJjZTogYGpvYiAke2tleX0gc3RlcCAke2luZGV4ICsgMX1gIH1cbiAgICAgICAgICAgICAgICAgIDogZmluZGluZyxcbiAgICAgICAgICAgIClcbiAgICAgICAgICAgIDogc3RlcEZpbmRpbmdzKGxpbmVzLCBsb2Muc3RhcnQsIGxvYy5lbmQsIGxvYy5pbmRlbnQsIGpvYiwgc3RlcCkpLFxuICAgICAgICApO1xuICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gZmluZGluZ3M7XG4gIH1cbiAgbGV0IHN0YXJ0ID0gMDtcbiAgd2hpbGUgKHN0YXJ0IDwgbGluZXMubGVuZ3RoKSB7XG4gICAgY29uc3QgaXRlbSA9IExJU1RfSVRFTS5leGVjKGxpbmVzW3N0YXJ0XSA/PyBcIlwiKTtcbiAgICBjb25zdCBhZnRlckRhc2ggPSBpdGVtPy5bMl0gPz8gXCJcIjtcbiAgICBpZiAoaXRlbSA9PT0gbnVsbCB8fCAoYWZ0ZXJEYXNoICE9PSBcIlwiICYmICEvXlxccy8udGVzdChhZnRlckRhc2gpKSkge1xuICAgICAgc3RhcnQrKztcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjb25zdCBkYXNoSW5kZW50ID0gKGl0ZW1bMV0gPz8gXCJcIikubGVuZ3RoO1xuICAgIGxldCBlbmQgPSBzdGFydCArIDE7XG4gICAgd2hpbGUgKGVuZCA8IGxpbmVzLmxlbmd0aCkge1xuICAgICAgY29uc3QgbGluZSA9IGxpbmVzW2VuZF0gPz8gXCJcIjtcbiAgICAgIGlmICghaXNTa2lwcGFibGUobGluZSkgJiYgaW5kZW50T2YobGluZSkgPD0gZGFzaEluZGVudCkgYnJlYWs7XG4gICAgICBlbmQrKztcbiAgICB9XG4gICAgY29uc3Qgam9iOiBKb2JDb250ZXh0ID0ge1xuICAgICAgbWF0cml4OiB7fSxcbiAgICAgIGRlZmF1bHRXZDogd29ya2Zsb3dXZCxcbiAgICAgIGNvbnRpbnVlT25FcnJvcjogdW5kZWZpbmVkLFxuICAgIH07XG4gICAgZmluZGluZ3MucHVzaChcbiAgICAgIC4uLnN0ZXBGaW5kaW5ncyhsaW5lcywgc3RhcnQsIGVuZCwgZGFzaEluZGVudCwgam9iKSxcbiAgICApO1xuICAgIHN0YXJ0ID0gZW5kO1xuICB9XG4gIHJldHVybiBmaW5kaW5ncztcbn1cblxuLyoqXG4gKiBMb2NhdGUgdGhlIHJlcG9zaXRvcnkncyBjYXJnby1kZW55IGludm9jYXRpb25zLiBSZWFkcyBldmVyeSB0cmFja2VkXG4gKiBgLmdpdGh1Yi93b3JrZmxvd3MvKi55bWx8eWFtbGAsIGJ1dCByZXBvcnRzIG5vdGhpbmcgZm9yIGEgd29ya2Zsb3cgQ0kgZG9lc1xuICogbm90IHJ1biBmb3IgdGhlIHB1c2ggZGVzY3JpYmVkIGJ5IGBjb250ZXh0YCAoYSBgc2NoZWR1bGVgLW9ubHkgdHJpZ2dlciwgYVxuICogbm9uLW1hdGNoaW5nIGBicmFuY2hlc2AgZmlsdGVyLCBvciBhIGBwYXRoc2AgZmlsdGVyIHNlbGVjdGluZyBub25lIG9mIHRoZVxuICogdG91Y2hlZCBwYXRocykuIEEgd29ya2Zsb3cgdGhhdCBjYW5ub3QgYmUgcmVhZCBpcyBvbmVcbiAqIHVucnVubmFibGUgZmluZGluZyBuYW1pbmcgdGhhdCBmaWxlIChmYWlsIGNsb3NlZCkuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiByZXBvQ2FyZ29EZW55RmluZGluZ3MoXG4gIHJlcG9Sb290OiBzdHJpbmcsXG4gIHRyYWNrZWQ6IHJlYWRvbmx5IHN0cmluZ1tdLFxuICBjb250ZXh0OiBXb3JrZmxvd1J1bkNvbnRleHQgPSB7fSxcbik6IFByb21pc2U8Q2FyZ29EZW55Q2lGaW5kaW5nW10+IHtcbiAgY29uc3QgZmluZGluZ3M6IENhcmdvRGVueUNpRmluZGluZ1tdID0gW107XG4gIGZvciAoY29uc3QgcGF0aCBvZiB0cmFja2VkKSB7XG4gICAgaWYgKCFwYXRoLnN0YXJ0c1dpdGgoXCIuZ2l0aHViL3dvcmtmbG93cy9cIikpIGNvbnRpbnVlO1xuICAgIGlmICghL1xcLnlhP21sJC8udGVzdChwYXRoKSkgY29udGludWU7XG4gICAgbGV0IHRleHQ6IHN0cmluZztcbiAgICB0cnkge1xuICAgICAgdGV4dCA9IGF3YWl0IERlbm8ucmVhZFRleHRGaWxlKGAke3JlcG9Sb290fS8ke3BhdGh9YCk7XG4gICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgIGNvbnN0IGRldGFpbCA9IGVycm9yIGluc3RhbmNlb2YgRXJyb3IgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKTtcbiAgICAgIGZpbmRpbmdzLnB1c2goe1xuICAgICAgICBraW5kOiBcInVucnVubmFibGVcIixcbiAgICAgICAgc291cmNlOiBwYXRoLFxuICAgICAgICByZWFzb246IGB0aGUgd29ya2Zsb3cgZmlsZSBjb3VsZCBub3QgYmUgcmVhZCAoJHtkZXRhaWx9KSwgc28gaXRzIGAgK1xuICAgICAgICAgIGBjYXJnby1kZW55IHN0ZXBzIGNhbm5vdCBiZSBjaGVja2VkYCxcbiAgICAgIH0pO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGZvciAoY29uc3QgZmluZGluZyBvZiB3b3JrZmxvd0NhcmdvRGVueUZpbmRpbmdzKHRleHQsIGNvbnRleHQpKSB7XG4gICAgICBmaW5kaW5ncy5wdXNoKFxuICAgICAgICBmaW5kaW5nLmtpbmQgPT09IFwidW5ydW5uYWJsZVwiXG4gICAgICAgICAgPyB7IC4uLmZpbmRpbmcsIHNvdXJjZTogYCR7cGF0aH0gJHtmaW5kaW5nLnNvdXJjZX1gIH1cbiAgICAgICAgICA6IGZpbmRpbmcsXG4gICAgICApO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmluZGluZ3M7XG59XG5cbi8qKlxuICogV2hldGhlciBhIHB1c2ggdG91Y2hlcyBhIGZpbGUgdGhhdCBjaGFuZ2VzIHRoZSBjYXJnby1kZW55IHJlc3VsdDogYVxuICogbWFuaWZlc3QsIGxvY2sgZmlsZSwgZGVueSBjb25maWcsIG9yIGNhcmdvIGNvbmZpZy5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGNhcmdvRGVueVRyaWdnZXJlZChjaGFuZ2VkOiByZWFkb25seSBzdHJpbmdbXSk6IGJvb2xlYW4ge1xuICByZXR1cm4gY2hhbmdlZC5zb21lKChwYXRoKSA9PiB7XG4gICAgY29uc3QgYmFzZSA9IHBhdGguc2xpY2UocGF0aC5sYXN0SW5kZXhPZihcIi9cIikgKyAxKTtcbiAgICByZXR1cm4gVFJJR0dFUl9CQVNFTkFNRVMuaGFzKGJhc2UpIHx8IFRSSUdHRVJfQ0FSR09fQ09ORklHLnRlc3QocGF0aCk7XG4gIH0pO1xufVxuXG4vKiogVGhlIG91dHB1dCBzcGxpdCBpbnRvIGxpbmVzLCBlYWNoIGNhcHBlZCBhdCB7QGxpbmsgTElORV9DQVB9IGNoYXJhY3RlcnMuICovXG5mdW5jdGlvbiBvdXRwdXRMaW5lcyhvdXRwdXQ6IHN0cmluZyk6IHN0cmluZ1tdIHtcbiAgcmV0dXJuIG91dHB1dC5zcGxpdChcIlxcblwiKS5tYXAoKGxpbmUpID0+XG4gICAgbGluZS5yZXBsYWNlKC9cXHIkLywgXCJcIikuc2xpY2UoMCwgTElORV9DQVApXG4gICk7XG59XG5cbi8qKiBSZWRhY3QgVVJMIGNyZWRlbnRpYWxzIChgLy91c2VyOnRva2VuQGAgYmVjb21lcyBgLy8qKipAYCkuICovXG5mdW5jdGlvbiByZWRhY3RVcmxDcmVkZW50aWFscyh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xuICByZXR1cm4gdGV4dC5yZXBsYWNlKFVSTF9DUkVERU5USUFMUywgXCIvLyoqKkBcIik7XG59XG5cbmZ1bmN0aW9uIGluZnJhc3RydWN0dXJlKGNhdXNlOiBzdHJpbmcpOiBDYXJnb0RlbnlHYXRlRXJyb3Ige1xuICByZXR1cm4ge1xuICAgIGtpbmQ6IFwiaW5mcmFzdHJ1Y3R1cmVcIixcbiAgICBtZXNzYWdlOiBgJHtJTkZSQV9QUkVGSVh9XCIke3JlZGFjdFVybENyZWRlbnRpYWxzKGNhdXNlKX1cImAsXG4gIH07XG59XG5cbi8qKlxuICogQ2xhc3NpZnkgYSBmYWlsZWQgY2FyZ28tZGVueSBydW4gKElzc3VlICM0NjI2KS5cbiAqXG4gKiAtIGBub3Qtc3RhcnRlZGAgYW5kIGB0aW1lb3V0YCBhcmUgaW5mcmFzdHJ1Y3R1cmUuXG4gKiAtIGBub24temVyby1leGl0YCB3aXRoIGFuIGBlcnJvcltjb2RlXWAgZGlhZ25vc3RpYyBpcyBhIHZlcmRpY3QsIHdoYXRldmVyXG4gKiAgIGVsc2UgdGhlIG91dHB1dCBzYXlzLlxuICogLSBgbm9uLXplcm8tZXhpdGAgd2l0aCBhIGxpbmUgdGhhdCBiZWdpbnMgd2l0aCBhIHRvb2wtdW5hdmFpbGFiaWxpdHlcbiAqICAgbWVzc2FnZSBpcyBpbmZyYXN0cnVjdHVyZS5cbiAqIC0gQW55IG90aGVyIG5vbi16ZXJvIGV4aXQgaXMgYSB2ZXJkaWN0IChmYWlsIGNsb3NlZCkuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBjbGFzc2lmeUNhcmdvRGVueUZhaWx1cmUoXG4gIGVycm9yOiBQcmVGbGlnaHRHYXRlRXJyb3IsXG4pOiBDYXJnb0RlbnlHYXRlRXJyb3Ige1xuICBjb25zdCBsaW5lcyA9IG91dHB1dExpbmVzKGVycm9yLm91dHB1dCk7XG4gIGNvbnN0IGZpcnN0TGluZSA9IGxpbmVzLmZpbmQoKGxpbmUpID0+IGxpbmUudHJpbSgpICE9PSBcIlwiKT8udHJpbSgpO1xuICBpZiAoZXJyb3IucmVhc29uID09PSBcIm5vdC1zdGFydGVkXCIpIHtcbiAgICByZXR1cm4gaW5mcmFzdHJ1Y3R1cmUoXG4gICAgICBmaXJzdExpbmUgPz8gXCJjYXJnbyBkZW55IGNvdWxkIG5vdCBiZSBzdGFydGVkIChubyBlcnJvciB0ZXh0IGNhcHR1cmVkKVwiLFxuICAgICk7XG4gIH1cbiAgaWYgKGVycm9yLnJlYXNvbiA9PT0gXCJ0aW1lb3V0XCIpIHtcbiAgICByZXR1cm4gaW5mcmFzdHJ1Y3R1cmUoXG4gICAgICBmaXJzdExpbmUgPz8gXCJjYXJnbyBkZW55IHRpbWVkIG91dCAobm8gb3V0cHV0IGNhcHR1cmVkKVwiLFxuICAgICk7XG4gIH1cbiAgY29uc3QgdmVyZGljdDogQ2FyZ29EZW55R2F0ZUVycm9yID0ge1xuICAgIGtpbmQ6IFwidmVyZGljdFwiLFxuICAgIG1lc3NhZ2U6IGVycm9yLm1lc3NhZ2UsXG4gIH07XG4gIGlmIChsaW5lcy5zb21lKChsaW5lKSA9PiBWRVJESUNUX0xJTkUudGVzdChsaW5lKSkpIHJldHVybiB2ZXJkaWN0O1xuICBjb25zdCBjYXVzZSA9IGxpbmVzLmZpbmQoKGxpbmUpID0+XG4gICAgVE9PTF9VTkFWQUlMQUJMRS5zb21lKChyZSkgPT4gcmUudGVzdChsaW5lLnJlcGxhY2UoTE9HX1BSRUZJWCwgXCJcIikpKVxuICApO1xuICBpZiAoY2F1c2UgIT09IHVuZGVmaW5lZCkgcmV0dXJuIGluZnJhc3RydWN0dXJlKGNhdXNlKTtcbiAgcmV0dXJuIHZlcmRpY3Q7XG59XG5cbi8qKiBRdW90ZSBvbmUgYXJndiBlbnRyeSBmb3IgdGhlIHByZS1mbGlnaHQgdG9rZW5pc2VyLCBvciBudWxsIGlmIGltcG9zc2libGUuICovXG5leHBvcnQgZnVuY3Rpb24gcXVvdGVBcmcodmFsdWU6IHN0cmluZyk6IHN0cmluZyB8IG51bGwge1xuICBpZiAoIXZhbHVlLmluY2x1ZGVzKFwiJ1wiKSkgcmV0dXJuIGAnJHt2YWx1ZX0nYDtcbiAgaWYgKCF2YWx1ZS5pbmNsdWRlcygnXCInKSkgcmV0dXJuIGBcIiR7dmFsdWV9XCJgO1xuICByZXR1cm4gbnVsbDtcbn1cblxuLyoqXG4gKiBSdW4gdGhlIGNhcmdvLWRlbnkgZ2F0ZSAoSXNzdWUgIzQ2MjYpLiBJbnRlcm1lZGlhdGUgcHVzaGVzIHdpdGhvdXQgY2FyZ29cbiAqIGlucHV0cyBza2lwIGl0IHVubGVzcyBgYWx3YXlzYCBpcyBzZXQuIFRoZSBmaXJzdCBmYWlsZWQgY2hlY2sgc3RvcHMgdGhlIGdhdGUuXG4gKiBBbiBpbnZvY2F0aW9uIENJIGFsbG93cyB0byBmYWlsIChgYWxsb3dGYWlsdXJlYCkgcnVucyBhZnRlciB0aGUgb3RoZXJzIGFuZFxuICogbmV2ZXIgc3RvcHMgdGhlIGdhdGU6IGl0cyBmYWlsdXJlIGlzIGEgd2FybmluZyBpbiB0aGUgcmVzdWx0LCBhcyBpdCBpc1xuICogaW4gQ0kuIEFuIGlkZW50aWNhbCBpbnZvY2F0aW9uIHRoYXQgQ0kgZG9lcyBub3QgYWxsb3cgdG8gZmFpbCBibG9ja3MuXG4gKi9cbmV4cG9ydCBhc3luYyBmdW5jdGlvbiBydW5DYXJnb0RlbnlHYXRlKG9wdHM6IHtcbiAgY3dkOiBzdHJpbmc7XG4gIGNoYW5nZWQ6IHJlYWRvbmx5IHN0cmluZ1tdO1xuICBhbHdheXM/OiBib29sZWFuO1xuICB0cmFja2VkOiByZWFkb25seSBzdHJpbmdbXTtcbiAgcnVubmVyPzogUHJlRmxpZ2h0UnVubmVyO1xuICB0aW1lb3V0U2Vjb25kcz86IG51bWJlcjtcbiAgZmluZGluZ3M/OiBDYXJnb0RlbnlDaUZpbmRpbmdbXTtcbiAgLyoqIFRoZSBwYXRocyBhbmQgYnJhbmNoZXMgdGhhdCBkZWNpZGUgd2hpY2ggd29ya2Zsb3dzIENJIHJ1bnMgZm9yIHRoaXMgcHVzaC4gKi9cbiAgY29udGV4dD86IFdvcmtmbG93UnVuQ29udGV4dDtcbn0pOiBQcm9taXNlPFxuICBSZXN1bHQ8eyBjaGVja3NSdW46IHN0cmluZ1tdOyB3YXJuaW5nczogc3RyaW5nW10gfSwgQ2FyZ29EZW55R2F0ZUVycm9yPlxuPiB7XG4gIGlmICghb3B0cy5hbHdheXMgJiYgIWNhcmdvRGVueVRyaWdnZXJlZChvcHRzLmNoYW5nZWQpKSB7XG4gICAgcmV0dXJuIHsgb2s6IHRydWUsIHZhbHVlOiB7IGNoZWNrc1J1bjogW10sIHdhcm5pbmdzOiBbXSB9IH07XG4gIH1cbiAgY29uc3QgZmluZGluZ3MgPSBvcHRzLmZpbmRpbmdzID8/XG4gICAgYXdhaXQgcmVwb0NhcmdvRGVueUZpbmRpbmdzKG9wdHMuY3dkLCBvcHRzLnRyYWNrZWQsIG9wdHMuY29udGV4dCk7XG5cbiAgZm9yIChjb25zdCBmaW5kaW5nIG9mIGZpbmRpbmdzKSB7XG4gICAgaWYgKGZpbmRpbmcua2luZCA9PT0gXCJ1bnJ1bm5hYmxlXCIpIHtcbiAgICAgIHJldHVybiB7XG4gICAgICAgIG9rOiBmYWxzZSxcbiAgICAgICAgZXJyb3I6IHtcbiAgICAgICAgICBraW5kOiBcInZlcmRpY3RcIixcbiAgICAgICAgICBtZXNzYWdlOiBgY2FyZ28gZGVueSBpcyBwYXJ0IG9mIHRoaXMgcmVwb3NpdG9yeSdzIENJIGJ1dCBpdHMgYCArXG4gICAgICAgICAgICBgaW52b2NhdGlvbiBjYW5ub3QgYmUgcmVwcm9kdWNlZCBsb2NhbGx5ICgke2ZpbmRpbmcuc291cmNlfTogYCArXG4gICAgICAgICAgICBgJHtmaW5kaW5nLnJlYXNvbn0pIOKAlCB0aGUgcHVzaCBpcyBibG9ja2VkLCBub3Qgd2F2ZWQgdGhyb3VnaGAsXG4gICAgICAgIH0sXG4gICAgICB9O1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGNoZWNrcyA9IG5ldyBNYXA8XG4gICAgc3RyaW5nLFxuICAgIHsgY29tbWFuZDogc3RyaW5nOyBjd2Q6IHN0cmluZzsgYWxsb3dGYWlsdXJlOiBib29sZWFuIH1cbiAgPigpO1xuICBmb3IgKGNvbnN0IGZpbmRpbmcgb2YgZmluZGluZ3MpIHtcbiAgICBpZiAoZmluZGluZy5raW5kICE9PSBcImNvbW1hbmRcIikgY29udGludWU7XG4gICAgY29uc3Qga2V5ID0gSlNPTi5zdHJpbmdpZnkoW2ZpbmRpbmcuYXJndiwgZmluZGluZy5jd2RdKTtcbiAgICBjb25zdCBhbGxvd0ZhaWx1cmUgPSBmaW5kaW5nLmFsbG93RmFpbHVyZSA9PT0gdHJ1ZTtcbiAgICBjb25zdCBzZWVuID0gY2hlY2tzLmdldChrZXkpO1xuICAgIGlmIChzZWVuICE9PSB1bmRlZmluZWQpIHtcbiAgICAgIHNlZW4uYWxsb3dGYWlsdXJlID0gc2Vlbi5hbGxvd0ZhaWx1cmUgJiYgYWxsb3dGYWlsdXJlO1xuICAgICAgY29udGludWU7XG4gICAgfVxuICAgIGNvbnN0IHBhcnRzOiBzdHJpbmdbXSA9IFtdO1xuICAgIGZvciAoY29uc3QgYXJnIG9mIGZpbmRpbmcuYXJndikge1xuICAgICAgY29uc3QgcXVvdGVkID0gcXVvdGVBcmcoYXJnKTtcbiAgICAgIGlmIChxdW90ZWQgPT09IG51bGwpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICBvazogZmFsc2UsXG4gICAgICAgICAgZXJyb3I6IHtcbiAgICAgICAgICAgIGtpbmQ6IFwidmVyZGljdFwiLFxuICAgICAgICAgICAgbWVzc2FnZTogYGNhcmdvIGRlbnkgYXJndW1lbnQgJHtKU09OLnN0cmluZ2lmeShhcmcpfSBjb250YWlucyBgICtcbiAgICAgICAgICAgICAgYGJvdGggJyBhbmQgXCIgYW5kIGNhbm5vdCBiZSBxdW90ZWQgZm9yIHRoZSBwcmUtZmxpZ2h0IHJ1bm5lciBgICtcbiAgICAgICAgICAgICAgYOKAlCB0aGUgcHVzaCBpcyBibG9ja2VkLCBub3Qgd2F2ZWQgdGhyb3VnaGAsXG4gICAgICAgICAgfSxcbiAgICAgICAgfTtcbiAgICAgIH1cbiAgICAgIHBhcnRzLnB1c2gocXVvdGVkKTtcbiAgICB9XG4gICAgY2hlY2tzLnNldChrZXksIHtcbiAgICAgIGNvbW1hbmQ6IHBhcnRzLmpvaW4oXCIgXCIpLFxuICAgICAgY3dkOiBmaW5kaW5nLmN3ZCA9PT0gXCIuXCIgPyBvcHRzLmN3ZCA6IGAke29wdHMuY3dkfS8ke2ZpbmRpbmcuY3dkfWAsXG4gICAgICBhbGxvd0ZhaWx1cmUsXG4gICAgfSk7XG4gIH1cblxuICBjb25zdCBjaGVja3NSdW46IHN0cmluZ1tdID0gW107XG4gIGNvbnN0IHdhcm5pbmdzOiBzdHJpbmdbXSA9IFtdO1xuICBjb25zdCBvcmRlcmVkID0gWy4uLmNoZWNrcy52YWx1ZXMoKV07XG4gIGZvciAoXG4gICAgY29uc3QgY2hlY2sgb2YgW1xuICAgICAgLi4ub3JkZXJlZC5maWx0ZXIoKGl0ZW0pID0+ICFpdGVtLmFsbG93RmFpbHVyZSksXG4gICAgICAuLi5vcmRlcmVkLmZpbHRlcigoaXRlbSkgPT4gaXRlbS5hbGxvd0ZhaWx1cmUpLFxuICAgIF1cbiAgKSB7XG4gICAgY29uc3QgcmVzdWx0ID0gYXdhaXQgcnVuUHJlRmxpZ2h0R2F0ZShbY2hlY2suY29tbWFuZF0sIHtcbiAgICAgIGN3ZDogY2hlY2suY3dkLFxuICAgICAgcnVubmVyOiBvcHRzLnJ1bm5lcixcbiAgICAgIHRpbWVvdXRTZWNvbmRzOiBvcHRzLnRpbWVvdXRTZWNvbmRzLFxuICAgIH0pO1xuICAgIGlmICghcmVzdWx0Lm9rKSB7XG4gICAgICBjb25zdCBlcnJvciA9IGNsYXNzaWZ5Q2FyZ29EZW55RmFpbHVyZShyZXN1bHQuZXJyb3IpO1xuICAgICAgaWYgKCFjaGVjay5hbGxvd0ZhaWx1cmUpIHJldHVybiB7IG9rOiBmYWxzZSwgZXJyb3IgfTtcbiAgICAgIHdhcm5pbmdzLnB1c2goXG4gICAgICAgIGAke2NoZWNrLmNvbW1hbmR9IGZhaWxlZCwgd2hpY2ggQ0kgYWxsb3dzIChjb250aW51ZS1vbi1lcnJvciksIHNvIGAgK1xuICAgICAgICAgIGB0aGUgcHVzaCBpcyBub3QgYmxvY2tlZDogJHtlcnJvci5tZXNzYWdlLnNsaWNlKDAsIFdBUk5JTkdfQ0FQKX1gLFxuICAgICAgKTtcbiAgICAgIGNvbnRpbnVlO1xuICAgIH1cbiAgICBjaGVja3NSdW4ucHVzaChjaGVjay5jb21tYW5kKTtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IHsgY2hlY2tzUnVuLCB3YXJuaW5ncyB9IH07XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBZ0NDLEdBR0QsK0VBQStFO0FBQy9FLG9DQUFvQztBQUNwQyxTQUFTLFNBQVMsU0FBUyxRQUFRLDhCQUE4QjtBQUNqRSxTQUdFLGdCQUFnQixFQUNoQixlQUFlLFFBQ1YsdUJBQXVCO0FBbUI5QixzRUFBc0UsR0FDdEUsTUFBTSxjQUFjO0FBRXBCLHdFQUF3RSxHQUN4RSxNQUFNLFdBQVc7QUFFakIsTUFBTSxlQUNKO0FBRUYscUVBQXFFLEdBQ3JFLE1BQU0sWUFBWTtBQUNsQixNQUFNLGNBQWM7QUFDcEIsTUFBTSxrQkFBa0I7QUFDeEIsTUFBTSxtQkFBbUI7QUFDekIsTUFBTSxjQUFjO0FBQ3BCLE1BQU0sb0JBQW9CLElBQUksSUFBSTtFQUNoQztFQUNBO0VBQ0E7RUFDQTtDQUNEO0FBQ0QsTUFBTSx1QkFBdUI7QUFFN0IsNEVBQTRFLEdBQzVFLE1BQU0sZUFBZTtBQUNyQix3RUFBd0UsR0FDeEUsTUFBTSxhQUFhO0FBQ25CLE1BQU0sa0JBQWtCO0FBRXhCOzs7O0NBSUMsR0FDRCxNQUFNLG1CQUFzQztFQUMxQztFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7RUFDQTtDQUNEO0FBRUQsOEVBQThFLEdBQzlFLE1BQU0sa0JBQWtCO0VBQ3RCLGFBQWE7RUFDYixpQkFBaUI7RUFDakIsV0FBVztFQUNYLFNBQVM7RUFDVCxxQkFBcUI7QUFDdkI7QUFrQkEsU0FBUyxTQUFTLElBQVk7RUFDNUIsT0FBTyxLQUFLLE1BQU0sR0FBRyxLQUFLLFNBQVMsR0FBRyxNQUFNO0FBQzlDO0FBRUEs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
// denoCacheMetadata=17113251255934488438,13674441052177780076