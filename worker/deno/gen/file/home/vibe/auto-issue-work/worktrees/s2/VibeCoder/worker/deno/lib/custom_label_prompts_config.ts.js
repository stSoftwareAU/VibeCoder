/**
 * `.config.json` surface for operator-defined custom label → prompt file
 * mappings (Issue #846, part of #843).
 *
 * An operator can dispatch a GitHub label to a prompt template that lives
 * outside the public repository — an absolute path on the host — so the
 * Vibe Coder can be extended with private prompts without publishing them.
 * This module is the trust boundary: dispatch (a later sub-issue of #843)
 * assumes an already-validated mapping.
 *
 * ## Validation posture — fail loud
 *
 * Matching `lib/container_tools_config.ts`'s posture (and unlike the
 * warn-and-default `idle_task_cadence` parser): a malformed mapping is never
 * repaired and never partially applied. {@link parseCustomLabelPrompts}
 * returns the first fault as an error naming the offending entry and field,
 * and {@link assertCustomLabelPrompts} throws it. A silently dropped mapping
 * is exactly the failure #843 rules out — an operator who added a mapping
 * and saw it silently ignored would never know their extension never
 * dispatched.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */ import { isReservedLabel } from "./config_defaults.ts";
import { isWorkerAppliableLabel } from "./worker_label_guard.ts";
import { DEFAULT_BUILTIN_LABEL_NAMES, resolveOverridePhase, validateOverrideTemplate } from "./builtin_prompt_overrides.ts";
import { hasTraversalSegment } from "./custom_prompt_mounts.ts";
/** Keys a `custom_label_prompts` entry may carry. */ const KNOWN_ENTRY_KEYS = new Set([
  "label",
  "prompt_path",
  // Issue #849: which built-in phase this entry overrides. Only meaningful on
  // a built-in label, and only needed for a phase whose label owns more than
  // one template (`planning` also owns `planning_critique`).
  "phase",
  // Issue #1008 (part of #938): which phase this entry's prompt runs in —
  // `issue` (the default) or `pr`.
  "target_phase"
]);
/** The `target_phase` values a mapping may state. */ const TARGET_PHASES = [
  "issue",
  "pr"
];
/** Whether a value is a plain (non-array, non-null) object. */ function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Short, safe rendering of an operator value for an error message. */ function show(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}
/** Whether a string contains a NUL byte or a C0/C1 control character. */ function hasControlCharacters(value) {
  for(let i = 0; i < value.length; i++){
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f || code >= 0x80 && code <= 0x9f) {
      return true;
    }
  }
  return false;
}
/** Failure carrying a message; `parse` funnels every fault through this. */ class MappingError extends Error {
}
/** Throw a fault naming the field it came from. */ function reject(field, detail) {
  throw new MappingError(`${field}: ${detail}`);
}
/** Validate a required non-empty string field, free of control characters. */ function parseCleanString(raw, field) {
  if (typeof raw !== "string" || raw.length === 0) {
    reject(field, `must be a non-empty string, got ${show(raw)}`);
  }
  if (hasControlCharacters(raw)) {
    reject(field, `must not contain NUL or control characters`);
  }
  return raw;
}
/** Validate one entry; `seen` carries the claims already accepted. */ function parseEntry(raw, index, seen, names, resolvePath) {
  const entryField = `custom_label_prompts[${index}]`;
  if (!isPlainObject(raw)) {
    reject(entryField, `must be an object, got ${show(raw)}`);
  }
  for (const key of Object.keys(raw)){
    if (!KNOWN_ENTRY_KEYS.has(key)) {
      reject(entryField, `unknown key "${key}" — expected one of ${[
        ...KNOWN_ENTRY_KEYS
      ].join(", ")}`);
    }
  }
  const label = parseCleanString(raw.label, `${entryField}.label`);
  const targetPhase = parseTargetPhase(raw.target_phase, entryField);
  const requestedPhase = raw.phase === undefined ? undefined : parseCleanString(raw.phase, `${entryField}.phase`);
  // Issue #849: a label matching a built-in one overrides that phase's
  // template rather than dispatching a new label. Resolved against the
  // *configured* label names, because a fleet may have renamed `planning`.
  const phaseResult = resolveOverridePhase(label, requestedPhase, names);
  if (!phaseResult.ok) {
    reject(requestedPhase === undefined ? `${entryField}.label` : `${entryField}.phase`, phaseResult.error);
  }
  const overridesPhase = phaseResult.value;
  // A built-in override replaces that phase's template; it is dispatched by
  // the built-in label's own handler, which knows nothing of a target phase.
  // Accepting `"target_phase": "pr"` here would silently do nothing — the
  // exact silent drop #843 rules out — so it is refused at the boundary.
  if (overridesPhase !== undefined && targetPhase !== "issue") {
    reject(`${entryField}.target_phase`, `must be "issue" on an entry that overrides the built-in "${overridesPhase}" ` + `phase, got ${show(targetPhase)}`);
  }
  // RESERVED_LABELS already contains the three hardwired discovery labels
  // (top-priority/work-on/low-priority), so isReservedLabel's case-
  // insensitive check alone covers both lists the issue names. A built-in
  // label an override names is reserved *by design* — that is what makes it
  // an override — so the check only guards labels that dispatch anew.
  if (overridesPhase === undefined && isReservedLabel(label)) {
    reject(`${entryField}.label`, `"${label}" is a reserved or discovery label and cannot be remapped`);
  }
  // Issue #847: a custom label dispatches a privileged phase, so the worker
  // must never self-apply one — the creation-time filters treat it as
  // reserved. A label the worker legitimately applies itself (`idle-task`,
  // `security`, `severity:high`, …) would therefore be stripped from the
  // worker's own issues, starving the very flow that files them. Those labels
  // are not in RESERVED_LABELS by design, so refuse the collision at config
  // load rather than let it fail silently at runtime.
  if (isWorkerAppliableLabel(label)) {
    reject(`${entryField}.label`, `"${label}" is a label the worker applies itself and cannot be remapped`);
  }
  // Fail loud on an ambiguous mapping: two entries cannot claim one label —
  // nor, for an override, one phase — or whichever came first wins silently.
  const claim = `${label.toLowerCase()}::${overridesPhase ?? ""}`;
  if (seen.has(claim)) {
    reject(`${entryField}.label`, overridesPhase === undefined ? `duplicate label ${show(label)}` : `duplicate label ${show(label)} — phase "${overridesPhase}" is ` + `already overridden by custom_label_prompts[${seen.get(claim)}]`);
  }
  const configuredPath = parseCleanString(raw.prompt_path, `${entryField}.prompt_path`);
  if (!configuredPath.startsWith("/")) {
    reject(`${entryField}.prompt_path`, `must be an absolute path, got ${show(configuredPath)}`);
  }
  // Issue #850: in container mode the containing directory of this path is
  // bind-mounted, and the mount-source allowlist compares strings — so a
  // traversal segment would derive a source the allowlist never judged
  // (`/srv/../home/operator` is the home directory once resolved). Refused at
  // the trust boundary, in both run modes, rather than only at launch.
  if (hasTraversalSegment(configuredPath)) {
    reject(`${entryField}.prompt_path`, `must not contain a "." or ".." segment, got ${show(configuredPath)}`);
  }
  // Validated — and, from here on, used — at the path this run can actually
  // read it at: inside the container that is the launcher's read-only mount
  // of the operator's directory (Issue #850).
  const promptPath = resolvePath(configuredPath);
  const origin = promptPath === configuredPath ? "" : ` (mounted from ${configuredPath})`;
  let content;
  try {
    content = Deno.readTextFileSync(promptPath);
  } catch (error) {
    reject(`${entryField}.prompt_path`, `is not a readable file: ${promptPath}${origin} (${error.message})`);
  }
  // An override answers to the placeholder contract of the phase it replaces,
  // not to the `issue` one a new custom label runs (Issue #849).
  if (overridesPhase !== undefined) {
    const templateResult = validateOverrideTemplate(overridesPhase, content);
    if (!templateResult.ok) {
      reject(`${entryField}.prompt_path`, templateResult.error);
    }
  }
  seen.set(claim, index);
  return {
    label,
    promptPath,
    targetPhase,
    ...overridesPhase !== undefined ? {
      overridesPhase
    } : {}
  };
}
/**
 * Validate an entry's `target_phase` (Issue #1008, part of #938).
 *
 * Absent or `null` is `"issue"`, so a `.config.json` written before the field
 * existed produces exactly the mappings it always did. Anything else that is
 * not one of the accepted values — a non-string, an empty string, or a case
 * variant — is refused through the shared {@link reject} path rather than
 * repaired, naming the entry, the offending value and the accepted set.
 */ function parseTargetPhase(raw, entryField) {
  if (raw === undefined || raw === null) return "issue";
  if (typeof raw !== "string" || !TARGET_PHASES.includes(raw)) {
    reject(`${entryField}.target_phase`, `must be one of ${TARGET_PHASES.join(", ")}, got ${show(raw)}`);
  }
  return raw;
}
/**
 * Validate the raw `custom_label_prompts` block from `.config.json`.
 *
 * Returns `ok` with an empty array when the key is absent, so an operator
 * who never opts in gets today's behaviour unchanged. Returns the **first**
 * fault as an error message naming the offending entry and field — the list
 * is never partially accepted.
 *
 * @param raw - The `custom_label_prompts` value from `.config.json`
 * @param options - The configured built-in label names, which decide whether an
 *   entry overrides a built-in phase (Issue #849), and the host → container
 *   path translation (Issue #850). Callers holding a `WorkerConfig` must pass
 *   its resolved label names: the stock defaults used otherwise would resolve a
 *   renamed label to the wrong phase, or to none.
 * @returns The validated mappings, or the first fault
 */ export function parseCustomLabelPrompts(raw, options = {}) {
  if (raw === undefined || raw === null) return {
    ok: true,
    value: []
  };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      error: `custom_label_prompts must be an array of label/prompt_path mappings, got ${show(raw)}`
    };
  }
  const mappings = [];
  const seen = new Map();
  const { resolvePath = (path)=>path, ...configuredNames } = options;
  const names = {
    ...DEFAULT_BUILTIN_LABEL_NAMES,
    ...configuredNames
  };
  try {
    for(let index = 0; index < raw.length; index++){
      mappings.push(parseEntry(raw[index], index, seen, names, resolvePath));
    }
  } catch (error) {
    if (error instanceof MappingError) {
      return {
        ok: false,
        error: error.message
      };
    }
    throw error;
  }
  return {
    ok: true,
    value: mappings
  };
}
/**
 * {@link parseCustomLabelPrompts}, but throwing — the fail-loud entry point
 * used at config load so a malformed, colliding or unreadable mapping stops
 * the worker before a custom label could ever dispatch silently.
 *
 * @param raw - The `custom_label_prompts` value from `.config.json`
 * @param options - The configured built-in label names and path translation
 *   (see {@link parseCustomLabelPrompts})
 * @returns The validated mappings
 * @throws When any entry is invalid
 */ export function assertCustomLabelPrompts(raw, options = {}) {
  const result = parseCustomLabelPrompts(raw, options);
  if (!result.ok) {
    throw new Error(`Invalid custom_label_prompts in .config.json: ${result.error}`);
  }
  return result.value;
}
/**
 * The configured prompt paths, read straight from a `.config.json` on disk
 * (Issue #850, part of #843).
 *
 * Used by the container launcher, which must know which host directories to
 * mount before any worker has loaded a configuration. Absent file → no
 * mappings, which is what an unconfigured host has always had. A file that
 * exists but cannot be read, is not JSON, or states a malformed mapping is
 * **not** treated as unconfigured: it throws, because launching without the
 * mount would leave every custom label failing at dispatch inside the
 * container.
 *
 * The label names are read from the same file (Issue #849), so the launcher
 * resolves an override exactly as `loadConfig` will inside the container. Left
 * to the stock defaults it would reject a fleet that renamed `planning` — a
 * valid configuration that the worker itself accepts.
 *
 * @param configFile - Host path of the worker configuration file
 * @returns The configured absolute host prompt paths, in configuration order
 * @throws When the file exists but is unreadable, is not a JSON object, or
 *   carries an invalid `custom_label_prompts` block
 */ export async function readConfiguredCustomPromptPaths(configFile) {
  let text;
  try {
    text = await Deno.readTextFile(configFile);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw new Error(`Cannot read the custom prompt mappings: ${configFile} is unreadable ` + `(${error.message}).`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Cannot read the custom prompt mappings: ${configFile} is not valid ` + `JSON (${error.message}).`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cannot read the custom prompt mappings: ${configFile} is not a JSON ` + `object.`);
  }
  const file = parsed;
  return assertCustomLabelPrompts(file["custom_label_prompts"], configuredLabelNames(file)).map((mapping)=>mapping.promptPath);
}
/** The configurable built-in label names a raw `.config.json` object states. */ function configuredLabelNames(file) {
  // `work_on_label` is deliberately absent: the three discovery labels are
  // hardwired in `lib/config_defaults.ts` and cannot be renamed (Issue #1834).
  const fields = [
    [
      "planningLabel",
      "planning_label"
    ],
    [
      "questionLabel",
      "question_label"
    ],
    [
      "grillMeLabel",
      "grill_me_label"
    ],
    [
      "quorumLabel",
      "quorum_label"
    ],
    [
      "refineIssueLabel",
      "refine_issue_label"
    ]
  ];
  const names = {};
  for (const [field, key] of fields){
    const value = file[key];
    if (typeof value === "string" && value.length > 0) names[field] = value;
  }
  return names;
}
/**
 * The label names that **dispatch** a configured mapping (Issue #847, part of
 * #843).
 *
 * The trust gate (`operationalDispatchLabels`), the operational-label
 * verification in `label_security.ts`, and the reserved-label filters in
 * `github.ts` all need the label names without the prompt paths. Reading them
 * from this one helper keeps those guards in step with the validated config
 * rather than each rebuilding the list.
 *
 * An **override** is excluded (Issue #849): it names a built-in label that
 * already carries its own gate, so adding it here would change that label's
 * trust posture as a side effect of swapping its template. `work-on` is the
 * sharp case — it sits deliberately outside the AND-gated set, and an operator
 * who overrode its prompt would otherwise find the fleet's main discovery
 * label newly stripped on every untrusted or unattributable add. Only a new
 * label brings a new privileged dispatch with it.
 *
 * The optional `phase` narrows the result to one target phase (Issue #1008).
 * `operationalDispatchLabels` deliberately calls this **unfiltered** — the
 * trust gate applies to a custom label whichever phase it runs in — while the
 * two dispatch paths each ask for their own.
 *
 * @param config - Worker configuration (or any object carrying the resolved list)
 * @param phase - Optional target-phase filter (Issue #1008)
 * @returns The dispatching labels, in configuration order and original case
 */ export function customLabelPromptLabels(config, phase) {
  return customDispatchMappings(config, phase).map((mapping)=>mapping.label);
}
/**
 * Resolve the configured prompt file for a GitHub label, if any (Issue #846,
 * part of #843).
 *
 * A pure lookup against the already-validated `WorkerConfig.customLabelPrompts`
 * list — the trust gate (#847) and dispatch (#848) build on this rather than
 * re-parsing the raw config. Comparison is case-insensitive, matching GitHub's
 * own label handling and `isReservedLabel`.
 *
 * @param config - Worker configuration (or any object carrying the resolved list)
 * @param label - The GitHub label to look up
 * @returns The mapping's absolute prompt path, or `undefined` when no mapping
 *   is configured for that label
 */ export function customLabelPromptPath(config, label) {
  const target = label.toLowerCase();
  return config.customLabelPrompts.find((mapping)=>mapping.label.toLowerCase() === target)?.promptPath;
}
/**
 * The mappings that dispatch a **new** label (Issue #849).
 *
 * An override names a built-in label, which already has its own priority
 * handler; scanning for it again in the custom-label row would run, say, a
 * `planning`-labelled issue through the implementation phase. Only new labels
 * belong in that scan.
 *
 * The optional `phase` narrows the result to the mappings that run in one
 * target phase (Issue #1008, part of #938), so the issue scanner never sees a
 * `pr` label — it would be hunted for among issues and its template rejected
 * for missing `{{ISSUE_NUMBER}}` — and the PR scanner never sees an `issue`
 * one.
 *
 * @param config - Worker configuration (or any object carrying the list)
 * @param phase - Optional target-phase filter (Issue #1008)
 * @returns The mappings with no built-in phase to override
 */ export function customDispatchMappings(config, phase) {
  return config.customLabelPrompts.filter((mapping)=>mapping.overridesPhase === undefined && (phase === undefined || mapping.targetPhase === phase));
}
/**
 * The mappings that override a built-in phase's template (Issue #849).
 *
 * Handed to the prompt builders, which resolve the template for the phase they
 * are building through `resolvePromptTemplate`.
 *
 * @param config - Worker configuration (or any object carrying the list)
 * @returns The mappings that replace a built-in phase template
 */ export function promptOverrideMappings(config) {
  return config.customLabelPrompts.filter((mapping)=>mapping.overridesPhase !== undefined);
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9jdXN0b21fbGFiZWxfcHJvbXB0c19jb25maWcudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBgLmNvbmZpZy5qc29uYCBzdXJmYWNlIGZvciBvcGVyYXRvci1kZWZpbmVkIGN1c3RvbSBsYWJlbCDihpIgcHJvbXB0IGZpbGVcbiAqIG1hcHBpbmdzIChJc3N1ZSAjODQ2LCBwYXJ0IG9mICM4NDMpLlxuICpcbiAqIEFuIG9wZXJhdG9yIGNhbiBkaXNwYXRjaCBhIEdpdEh1YiBsYWJlbCB0byBhIHByb21wdCB0ZW1wbGF0ZSB0aGF0IGxpdmVzXG4gKiBvdXRzaWRlIHRoZSBwdWJsaWMgcmVwb3NpdG9yeSDigJQgYW4gYWJzb2x1dGUgcGF0aCBvbiB0aGUgaG9zdCDigJQgc28gdGhlXG4gKiBWaWJlIENvZGVyIGNhbiBiZSBleHRlbmRlZCB3aXRoIHByaXZhdGUgcHJvbXB0cyB3aXRob3V0IHB1Ymxpc2hpbmcgdGhlbS5cbiAqIFRoaXMgbW9kdWxlIGlzIHRoZSB0cnVzdCBib3VuZGFyeTogZGlzcGF0Y2ggKGEgbGF0ZXIgc3ViLWlzc3VlIG9mICM4NDMpXG4gKiBhc3N1bWVzIGFuIGFscmVhZHktdmFsaWRhdGVkIG1hcHBpbmcuXG4gKlxuICogIyMgVmFsaWRhdGlvbiBwb3N0dXJlIOKAlCBmYWlsIGxvdWRcbiAqXG4gKiBNYXRjaGluZyBgbGliL2NvbnRhaW5lcl90b29sc19jb25maWcudHNgJ3MgcG9zdHVyZSAoYW5kIHVubGlrZSB0aGVcbiAqIHdhcm4tYW5kLWRlZmF1bHQgYGlkbGVfdGFza19jYWRlbmNlYCBwYXJzZXIpOiBhIG1hbGZvcm1lZCBtYXBwaW5nIGlzIG5ldmVyXG4gKiByZXBhaXJlZCBhbmQgbmV2ZXIgcGFydGlhbGx5IGFwcGxpZWQuIHtAbGluayBwYXJzZUN1c3RvbUxhYmVsUHJvbXB0c31cbiAqIHJldHVybnMgdGhlIGZpcnN0IGZhdWx0IGFzIGFuIGVycm9yIG5hbWluZyB0aGUgb2ZmZW5kaW5nIGVudHJ5IGFuZCBmaWVsZCxcbiAqIGFuZCB7QGxpbmsgYXNzZXJ0Q3VzdG9tTGFiZWxQcm9tcHRzfSB0aHJvd3MgaXQuIEEgc2lsZW50bHkgZHJvcHBlZCBtYXBwaW5nXG4gKiBpcyBleGFjdGx5IHRoZSBmYWlsdXJlICM4NDMgcnVsZXMgb3V0IOKAlCBhbiBvcGVyYXRvciB3aG8gYWRkZWQgYSBtYXBwaW5nXG4gKiBhbmQgc2F3IGl0IHNpbGVudGx5IGlnbm9yZWQgd291bGQgbmV2ZXIga25vdyB0aGVpciBleHRlbnNpb24gbmV2ZXJcbiAqIGRpc3BhdGNoZWQuXG4gKlxuICogQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIHVzZWQgdGhyb3VnaG91dCAoYmVoYXZpb3VyLCBvcmdhbmlzYXRpb24pLlxuICovXG5cbmltcG9ydCB0eXBlIHtcbiAgQ3VzdG9tTGFiZWxQcm9tcHRNYXBwaW5nLFxuICBDdXN0b21Qcm9tcHRUYXJnZXRQaGFzZSxcbiAgUmVzdWx0LFxufSBmcm9tIFwiLi4vdHlwZXMudHNcIjtcbmltcG9ydCB7IGlzUmVzZXJ2ZWRMYWJlbCB9IGZyb20gXCIuL2NvbmZpZ19kZWZhdWx0cy50c1wiO1xuaW1wb3J0IHsgaXNXb3JrZXJBcHBsaWFibGVMYWJlbCB9IGZyb20gXCIuL3dvcmtlcl9sYWJlbF9ndWFyZC50c1wiO1xuaW1wb3J0IHR5cGUgeyBCdWlsdEluTGFiZWxOYW1lcyB9IGZyb20gXCIuL2J1aWx0aW5fcHJvbXB0X292ZXJyaWRlcy50c1wiO1xuaW1wb3J0IHtcbiAgREVGQVVMVF9CVUlMVElOX0xBQkVMX05BTUVTLFxuICByZXNvbHZlT3ZlcnJpZGVQaGFzZSxcbiAgdmFsaWRhdGVPdmVycmlkZVRlbXBsYXRlLFxufSBmcm9tIFwiLi9idWlsdGluX3Byb21wdF9vdmVycmlkZXMudHNcIjtcbmltcG9ydCB7IGhhc1RyYXZlcnNhbFNlZ21lbnQgfSBmcm9tIFwiLi9jdXN0b21fcHJvbXB0X21vdW50cy50c1wiO1xuXG4vKiogS2V5cyBhIGBjdXN0b21fbGFiZWxfcHJvbXB0c2AgZW50cnkgbWF5IGNhcnJ5LiAqL1xuY29uc3QgS05PV05fRU5UUllfS0VZUzogUmVhZG9ubHlTZXQ8c3RyaW5nPiA9IG5ldyBTZXQoW1xuICBcImxhYmVsXCIsXG4gIFwicHJvbXB0X3BhdGhcIixcbiAgLy8gSXNzdWUgIzg0OTogd2hpY2ggYnVpbHQtaW4gcGhhc2UgdGhpcyBlbnRyeSBvdmVycmlkZXMuIE9ubHkgbWVhbmluZ2Z1bCBvblxuICAvLyBhIGJ1aWx0LWluIGxhYmVsLCBhbmQgb25seSBuZWVkZWQgZm9yIGEgcGhhc2Ugd2hvc2UgbGFiZWwgb3ducyBtb3JlIHRoYW5cbiAgLy8gb25lIHRlbXBsYXRlIChgcGxhbm5pbmdgIGFsc28gb3ducyBgcGxhbm5pbmdfY3JpdGlxdWVgKS5cbiAgXCJwaGFzZVwiLFxuICAvLyBJc3N1ZSAjMTAwOCAocGFydCBvZiAjOTM4KTogd2hpY2ggcGhhc2UgdGhpcyBlbnRyeSdzIHByb21wdCBydW5zIGluIOKAlFxuICAvLyBgaXNzdWVgICh0aGUgZGVmYXVsdCkgb3IgYHByYC5cbiAgXCJ0YXJnZXRfcGhhc2VcIixcbl0pO1xuXG4vKiogVGhlIGB0YXJnZXRfcGhhc2VgIHZhbHVlcyBhIG1hcHBpbmcgbWF5IHN0YXRlLiAqL1xuY29uc3QgVEFSR0VUX1BIQVNFUzogcmVhZG9ubHkgQ3VzdG9tUHJvbXB0VGFyZ2V0UGhhc2VbXSA9IFtcImlzc3VlXCIsIFwicHJcIl07XG5cbi8qKiBXaGV0aGVyIGEgdmFsdWUgaXMgYSBwbGFpbiAobm9uLWFycmF5LCBub24tbnVsbCkgb2JqZWN0LiAqL1xuZnVuY3Rpb24gaXNQbGFpbk9iamVjdCh2YWx1ZTogdW5rbm93bik6IHZhbHVlIGlzIFJlY29yZDxzdHJpbmcsIHVua25vd24+IHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJvYmplY3RcIiAmJiB2YWx1ZSAhPT0gbnVsbCAmJiAhQXJyYXkuaXNBcnJheSh2YWx1ZSk7XG59XG5cbi8qKiBTaG9ydCwgc2FmZSByZW5kZXJpbmcgb2YgYW4gb3BlcmF0b3IgdmFsdWUgZm9yIGFuIGVycm9yIG1lc3NhZ2UuICovXG5mdW5jdGlvbiBzaG93KHZhbHVlOiB1bmtub3duKTogc3RyaW5nIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiA/IEpTT04uc3RyaW5naWZ5KHZhbHVlKSA6IFN0cmluZyh2YWx1ZSk7XG59XG5cbi8qKiBXaGV0aGVyIGEgc3RyaW5nIGNvbnRhaW5zIGEgTlVMIGJ5dGUgb3IgYSBDMC9DMSBjb250cm9sIGNoYXJhY3Rlci4gKi9cbmZ1bmN0aW9uIGhhc0NvbnRyb2xDaGFyYWN0ZXJzKHZhbHVlOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCB2YWx1ZS5sZW5ndGg7IGkrKykge1xuICAgIGNvbnN0IGNvZGUgPSB2YWx1ZS5jaGFyQ29kZUF0KGkpO1xuICAgIGlmIChjb2RlIDw9IDB4MWYgfHwgY29kZSA9PT0gMHg3ZiB8fCAoY29kZSA+PSAweDgwICYmIGNvZGUgPD0gMHg5ZikpIHtcbiAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgfVxuICByZXR1cm4gZmFsc2U7XG59XG5cbi8qKiBGYWlsdXJlIGNhcnJ5aW5nIGEgbWVzc2FnZTsgYHBhcnNlYCBmdW5uZWxzIGV2ZXJ5IGZhdWx0IHRocm91Z2ggdGhpcy4gKi9cbmNsYXNzIE1hcHBpbmdFcnJvciBleHRlbmRzIEVycm9yIHt9XG5cbi8qKiBUaHJvdyBhIGZhdWx0IG5hbWluZyB0aGUgZmllbGQgaXQgY2FtZSBmcm9tLiAqL1xuZnVuY3Rpb24gcmVqZWN0KGZpZWxkOiBzdHJpbmcsIGRldGFpbDogc3RyaW5nKTogbmV2ZXIge1xuICB0aHJvdyBuZXcgTWFwcGluZ0Vycm9yKGAke2ZpZWxkfTogJHtkZXRhaWx9YCk7XG59XG5cbi8qKiBWYWxpZGF0ZSBhIHJlcXVpcmVkIG5vbi1lbXB0eSBzdHJpbmcgZmllbGQsIGZyZWUgb2YgY29udHJvbCBjaGFyYWN0ZXJzLiAqL1xuZnVuY3Rpb24gcGFyc2VDbGVhblN0cmluZyhyYXc6IHVua25vd24sIGZpZWxkOiBzdHJpbmcpOiBzdHJpbmcge1xuICBpZiAodHlwZW9mIHJhdyAhPT0gXCJzdHJpbmdcIiB8fCByYXcubGVuZ3RoID09PSAwKSB7XG4gICAgcmVqZWN0KGZpZWxkLCBgbXVzdCBiZSBhIG5vbi1lbXB0eSBzdHJpbmcsIGdvdCAke3Nob3cocmF3KX1gKTtcbiAgfVxuICBpZiAoaGFzQ29udHJvbENoYXJhY3RlcnMocmF3KSkge1xuICAgIHJlamVjdChmaWVsZCwgYG11c3Qgbm90IGNvbnRhaW4gTlVMIG9yIGNvbnRyb2wgY2hhcmFjdGVyc2ApO1xuICB9XG4gIHJldHVybiByYXc7XG59XG5cbi8qKlxuICogQ2xhaW1zIG1hZGUgYnkgZWFybGllciBlbnRyaWVzOiBsb3dlci1jYXNlZCBgbGFiZWw6OnBoYXNlYCDihpIgZW50cnkgaW5kZXguXG4gKlxuICogVGhlIHBoYXNlIGlzIHBhcnQgb2YgdGhlIGtleSBzbyBhIGxhYmVsIG93bmluZyB0d28gdGVtcGxhdGVzIChgcGxhbm5pbmdgXG4gKiBhbmQgYHBsYW5uaW5nX2NyaXRpcXVlYCkgY2FuIGNhcnJ5IG9uZSBlbnRyeSBlYWNoLCB3aGlsZSBhIHNlY29uZCBlbnRyeVxuICogY2xhaW1pbmcgYSBwaGFzZSBhbHJlYWR5IGNsYWltZWQgaXMgcmVmdXNlZCBieSBpbmRleC5cbiAqL1xudHlwZSBTZWVuQ2xhaW1zID0gTWFwPHN0cmluZywgbnVtYmVyPjtcblxuLyoqXG4gKiBXaGF0IHRoZSBwYXJzZSBuZWVkcyBiZXlvbmQgdGhlIHJhdyBibG9jazogdGhlIGNvbmZpZ3VyZWQgYnVpbHQtaW4gbGFiZWxcbiAqIG5hbWVzLCBhbmQgaG93IGEgY29uZmlndXJlZCBwcm9tcHQgcGF0aCBpcyByZXNvbHZlZCB0byB3aGVyZSBpdCBpcyByZWFkYWJsZS5cbiAqXG4gKiBUaGUgbGFiZWwgbmFtZXMgZGVjaWRlIHdoaWNoIGVudHJpZXMgb3ZlcnJpZGUgYSBidWlsdC1pbiBwaGFzZSAoSXNzdWUgIzg0OSlcbiAqIGFuZCBkZWZhdWx0IHRvIHRoZSBzdG9jayBvbmVzLiBQYXRoIHJlc29sdXRpb24gaXMgdGhlIGlkZW50aXR5IGJ5IGRlZmF1bHQg4oCUXG4gKiByZWFkIG9uIHRoZSBob3N0LCB0aGUgb3BlcmF0b3IncyBwYXRoICppcyogdGhlIHBhdGguIEluc2lkZSB0aGUgY29udGFpbmVyIHRoZVxuICogbGF1bmNoZXIgaGFzIG1vdW50ZWQgZWFjaCBwcm9tcHQgZGlyZWN0b3J5IHJlYWQtb25seSBhbmQgaGFuZGVkIG92ZXIgdGhlXG4gKiBob3N0IOKGkiBpbi1jb250YWluZXIgdHJhbnNsYXRpb24gKElzc3VlICM4NTApLCBzbyB0aGUgc2FtZSBgLmNvbmZpZy5qc29uYFxuICogc2VydmVzIGJvdGggc2lkZXMgb2YgdGhlIGJvdW5kYXJ5LlxuICovXG5leHBvcnQgaW50ZXJmYWNlIEN1c3RvbUxhYmVsUHJvbXB0T3B0aW9ucyBleHRlbmRzIFBhcnRpYWw8QnVpbHRJbkxhYmVsTmFtZXM+IHtcbiAgLyoqIFJlc29sdmUgYSBjb25maWd1cmVkIGhvc3QgcGF0aCB0byB3aGVyZSB0aGlzIHJ1biBjYW4gcmVhZCBpdC4gKi9cbiAgcmVzb2x2ZVBhdGg/OiAocHJvbXB0UGF0aDogc3RyaW5nKSA9PiBzdHJpbmc7XG59XG5cbi8qKiBWYWxpZGF0ZSBvbmUgZW50cnk7IGBzZWVuYCBjYXJyaWVzIHRoZSBjbGFpbXMgYWxyZWFkeSBhY2NlcHRlZC4gKi9cbmZ1bmN0aW9uIHBhcnNlRW50cnkoXG4gIHJhdzogdW5rbm93bixcbiAgaW5kZXg6IG51bWJlcixcbiAgc2VlbjogU2VlbkNsYWltcyxcbiAgbmFtZXM6IEJ1aWx0SW5MYWJlbE5hbWVzLFxuICByZXNvbHZlUGF0aDogKHByb21wdFBhdGg6IHN0cmluZykgPT4gc3RyaW5nLFxuKTogQ3VzdG9tTGFiZWxQcm9tcHRNYXBwaW5nIHtcbiAgY29uc3QgZW50cnlGaWVsZCA9IGBjdXN0b21fbGFiZWxfcHJvbXB0c1ske2luZGV4fV1gO1xuICBpZiAoIWlzUGxhaW5PYmplY3QocmF3KSkge1xuICAgIHJlamVjdChlbnRyeUZpZWxkLCBgbXVzdCBiZSBhbiBvYmplY3QsIGdvdCAke3Nob3cocmF3KX1gKTtcbiAgfVxuXG4gIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHJhdykpIHtcbiAgICBpZiAoIUtOT1dOX0VOVFJZX0tFWVMuaGFzKGtleSkpIHtcbiAgICAgIHJlamVjdChcbiAgICAgICAgZW50cnlGaWVsZCxcbiAgICAgICAgYHVua25vd24ga2V5IFwiJHtrZXl9XCIg4oCUIGV4cGVjdGVkIG9uZSBvZiAke1xuICAgICAgICAgIFsuLi5LTk9XTl9FTlRSWV9LRVlTXS5qb2luKFwiLCBcIilcbiAgICAgICAgfWAsXG4gICAgICApO1xuICAgIH1cbiAgfVxuXG4gIGNvbnN0IGxhYmVsID0gcGFyc2VDbGVhblN0cmluZyhyYXcubGFiZWwsIGAke2VudHJ5RmllbGR9LmxhYmVsYCk7XG4gIGNvbnN0IHRhcmdldFBoYXNlID0gcGFyc2VUYXJnZXRQaGFzZShyYXcudGFyZ2V0X3BoYXNlLCBlbnRyeUZpZWxkKTtcbiAgY29uc3QgcmVxdWVzdGVkUGhhc2UgPSByYXcucGhhc2UgPT09IHVuZGVmaW5lZFxuICAgID8gdW5kZWZpbmVkXG4gICAgOiBwYXJzZUNsZWFuU3RyaW5nKHJhdy5waGFzZSwgYCR7ZW50cnlGaWVsZH0ucGhhc2VgKTtcblxuICAvLyBJc3N1ZSAjODQ5OiBhIGxhYmVsIG1hdGNoaW5nIGEgYnVpbHQtaW4gb25lIG92ZXJyaWRlcyB0aGF0IHBoYXNlJ3NcbiAgLy8gdGVtcGxhdGUgcmF0aGVyIHRoYW4gZGlzcGF0Y2hpbmcgYSBuZXcgbGFiZWwuIFJlc29sdmVkIGFnYWluc3QgdGhlXG4gIC8vICpjb25maWd1cmVkKiBsYWJlbCBuYW1lcywgYmVjYXVzZSBhIGZsZWV0IG1heSBoYXZlIHJlbmFtZWQgYHBsYW5uaW5nYC5cbiAgY29uc3QgcGhhc2VSZXN1bHQgPSByZXNvbHZlT3ZlcnJpZGVQaGFzZShsYWJlbCwgcmVxdWVzdGVkUGhhc2UsIG5hbWVzKTtcbiAgaWYgKCFwaGFzZVJlc3VsdC5vaykge1xuICAgIHJlamVjdChcbiAgICAgIHJlcXVlc3RlZFBoYXNlID09PSB1bmRlZmluZWRcbiAgICAgICAgPyBgJHtlbnRyeUZpZWxkfS5sYWJlbGBcbiAgICAgICAgOiBgJHtlbnRyeUZpZWxkfS5waGFzZWAsXG4gICAgICBwaGFzZVJlc3VsdC5lcnJvcixcbiAgICApO1xuICB9XG4gIGNvbnN0IG92ZXJyaWRlc1BoYXNlID0gcGhhc2VSZXN1bHQudmFsdWU7XG5cbiAgLy8gQSBidWlsdC1pbiBvdmVycmlkZSByZXBsYWNlcyB0aGF0IHBoYXNlJ3MgdGVtcGxhdGU7IGl0IGlzIGRpc3BhdGNoZWQgYnlcbiAgLy8gdGhlIGJ1aWx0LWluIGxhYmVsJ3Mgb3duIGhhbmRsZXIsIHdoaWNoIGtub3dzIG5vdGhpbmcgb2YgYSB0YXJnZXQgcGhhc2UuXG4gIC8vIEFjY2VwdGluZyBgXCJ0YXJnZXRfcGhhc2VcIjogXCJwclwiYCBoZXJlIHdvdWxkIHNpbGVudGx5IGRvIG5vdGhpbmcg4oCUIHRoZVxuICAvLyBleGFjdCBzaWxlbnQgZHJvcCAjODQzIHJ1bGVzIG91dCDigJQgc28gaXQgaXMgcmVmdXNlZCBhdCB0aGUgYm91bmRhcnkuXG4gIGlmIChvdmVycmlkZXNQaGFzZSAhPT0gdW5kZWZpbmVkICYmIHRhcmdldFBoYXNlICE9PSBcImlzc3VlXCIpIHtcbiAgICByZWplY3QoXG4gICAgICBgJHtlbnRyeUZpZWxkfS50YXJnZXRfcGhhc2VgLFxuICAgICAgYG11c3QgYmUgXCJpc3N1ZVwiIG9uIGFuIGVudHJ5IHRoYXQgb3ZlcnJpZGVzIHRoZSBidWlsdC1pbiBcIiR7b3ZlcnJpZGVzUGhhc2V9XCIgYCArXG4gICAgICAgIGBwaGFzZSwgZ290ICR7c2hvdyh0YXJnZXRQaGFzZSl9YCxcbiAgICApO1xuICB9XG5cbiAgLy8gUkVTRVJWRURfTEFCRUxTIGFscmVhZHkgY29udGFpbnMgdGhlIHRocmVlIGhhcmR3aXJlZCBkaXNjb3ZlcnkgbGFiZWxzXG4gIC8vICh0b3AtcHJpb3JpdHkvd29yay1vbi9sb3ctcHJpb3JpdHkpLCBzbyBpc1Jlc2VydmVkTGFiZWwncyBjYXNlLVxuICAvLyBpbnNlbnNpdGl2ZSBjaGVjayBhbG9uZSBjb3ZlcnMgYm90aCBsaXN0cyB0aGUgaXNzdWUgbmFtZXMuIEEgYnVpbHQtaW5cbiAgLy8gbGFiZWwgYW4gb3ZlcnJpZGUgbmFtZXMgaXMgcmVzZXJ2ZWQgKmJ5IGRlc2lnbiog4oCUIHRoYXQgaXMgd2hhdCBtYWtlcyBpdFxuICAvLyBhbiBvdmVycmlkZSDigJQgc28gdGhlIGNoZWNrIG9ubHkgZ3VhcmRzIGxhYmVscyB0aGF0IGRpc3BhdGNoIGFuZXcuXG4gIGlmIChvdmVycmlkZXNQaGFzZSA9PT0gdW5kZWZpbmVkICYmIGlzUmVzZXJ2ZWRMYWJlbChsYWJlbCkpIHtcbiAgICByZWplY3QoXG4gICAgICBgJHtlbnRyeUZpZWxkfS5sYWJlbGAsXG4gICAgICBgXCIke2xhYmVsfVwiIGlzIGEgcmVzZXJ2ZWQgb3IgZGlzY292ZXJ5IGxhYmVsIGFuZCBjYW5ub3QgYmUgcmVtYXBwZWRgLFxuICAgICk7XG4gIH1cbiAgLy8gSXNzdWUgIzg0NzogYSBjdXN0b20gbGFiZWwgZGlzcGF0Y2hlcyBhIHByaXZpbGVnZWQgcGhhc2UsIHNvIHRoZSB3b3JrZXJcbiAgLy8gbXVzdCBuZXZlciBzZWxmLWFwcGx5IG9uZSDigJQgdGhlIGNyZWF0aW9uLXRpbWUgZmlsdGVycyB0cmVhdCBpdCBhc1xuICAvLyByZXNlcnZlZC4gQSBsYWJlbCB0aGUgd29ya2VyIGxlZ2l0aW1hdGVseSBhcHBsaWVzIGl0c2VsZiAoYGlkbGUtdGFza2AsXG4gIC8vIGBzZWN1cml0eWAsIGBzZXZlcml0eTpoaWdoYCwg4oCmKSB3b3VsZCB0aGVyZWZvcmUgYmUgc3RyaXBwZWQgZnJvbSB0aGVcbiAgLy8gd29ya2VyJ3Mgb3duIGlzc3Vlcywgc3RhcnZpbmcgdGhlIHZlcnkgZmxvdyB0aGF0IGZpbGVzIHRoZW0uIFRob3NlIGxhYmVsc1xuICAvLyBhcmUgbm90IGluIFJFU0VSVkVEX0xBQkVMUyBieSBkZXNpZ24sIHNvIHJlZnVzZSB0aGUgY29sbGlzaW9uIGF0IGNvbmZpZ1xuICAvLyBsb2FkIHJhdGhlciB0aGFuIGxldCBpdCBmYWlsIHNpbGVudGx5IGF0IHJ1bnRpbWUuXG4gIGlmIChpc1dvcmtlckFwcGxpYWJsZUxhYmVsKGxhYmVsKSkge1xuICAgIHJlamVjdChcbiAgICAgIGAke2VudHJ5RmllbGR9LmxhYmVsYCxcbiAgICAgIGBcIiR7bGFiZWx9XCIgaXMgYSBsYWJlbCB0aGUgd29ya2VyIGFwcGxpZXMgaXRzZWxmIGFuZCBjYW5ub3QgYmUgcmVtYXBwZWRgLFxuICAgICk7XG4gIH1cbiAgLy8gRmFpbCBsb3VkIG9uIGFuIGFtYmlndW91cyBtYXBwaW5nOiB0d28gZW50cmllcyBjYW5ub3QgY2xhaW0gb25lIGxhYmVsIOKAlFxuICAvLyBub3IsIGZvciBhbiBvdmVycmlkZSwgb25lIHBoYXNlIOKAlCBvciB3aGljaGV2ZXIgY2FtZSBmaXJzdCB3aW5zIHNpbGVudGx5LlxuICBjb25zdCBjbGFpbSA9IGAke2xhYmVsLnRvTG93ZXJDYXNlKCl9Ojoke292ZXJyaWRlc1BoYXNlID8/IFwiXCJ9YDtcbiAgaWYgKHNlZW4uaGFzKGNsYWltKSkge1xuICAgIHJlamVjdChcbiAgICAgIGAke2VudHJ5RmllbGR9LmxhYmVsYCxcbiAgICAgIG92ZXJyaWRlc1BoYXNlID09PSB1bmRlZmluZWRcbiAgICAgICAgPyBgZHVwbGljYXRlIGxhYmVsICR7c2hvdyhsYWJlbCl9YFxuICAgICAgICA6IGBkdXBsaWNhdGUgbGFiZWwgJHtzaG93KGxhYmVsKX0g4oCUIHBoYXNlIFwiJHtvdmVycmlkZXNQaGFzZX1cIiBpcyBgICtcbiAgICAgICAgICBgYWxyZWFkeSBvdmVycmlkZGVuIGJ5IGN1c3RvbV9sYWJlbF9wcm9tcHRzWyR7c2Vlbi5nZXQoY2xhaW0pfV1gLFxuICAgICk7XG4gIH1cblxuICBjb25zdCBjb25maWd1cmVkUGF0aCA9IHBhcnNlQ2xlYW5TdHJpbmcoXG4gICAgcmF3LnByb21wdF9wYXRoLFxuICAgIGAke2VudHJ5RmllbGR9LnByb21wdF9wYXRoYCxcbiAgKTtcbiAgaWYgKCFjb25maWd1cmVkUGF0aC5zdGFydHNXaXRoKFwiL1wiKSkge1xuICAgIHJlamVjdChcbiAgICAgIGAke2VudHJ5RmllbGR9LnByb21wdF9wYXRoYCxcbiAgICAgIGBtdXN0IGJlIGFuIGFic29sdXRlIHBhdGgsIGdvdCAke3Nob3coY29uZmlndXJlZFBhdGgpfWAsXG4gICAgKTtcbiAgfVxuICAvLyBJc3N1ZSAjODUwOiBpbiBjb250YWluZXIgbW9kZSB0aGUgY29udGFpbmluZyBkaXJlY3Rvcnkgb2YgdGhpcyBwYXRoIGlzXG4gIC8vIGJpbmQtbW91bnRlZCwgYW5kIHRoZSBtb3VudC1zb3VyY2UgYWxsb3dsaXN0IGNvbXBhcmVzIHN0cmluZ3Mg4oCUIHNvIGFcbiAgLy8gdHJhdmVyc2FsIHNlZ21lbnQgd291bGQgZGVyaXZlIGEgc291cmNlIHRoZSBhbGxvd2xpc3QgbmV2ZXIganVkZ2VkXG4gIC8vIChgL3Nydi8uLi9ob21lL29wZXJhdG9yYCBpcyB0aGUgaG9tZSBkaXJlY3Rvcnkgb25jZSByZXNvbHZlZCkuIFJlZnVzZWQgYXRcbiAgLy8gdGhlIHRydXN0IGJvdW5kYXJ5LCBpbiBib3RoIHJ1biBtb2RlcywgcmF0aGVyIHRoYW4gb25seSBhdCBsYXVuY2guXG4gIGlmIChoYXNUcmF2ZXJzYWxTZWdtZW50KGNvbmZpZ3VyZWRQYXRoKSkge1xuICAgIHJlamVjdChcbiAgICAgIGAke2VudHJ5RmllbGR9LnByb21wdF9wYXRoYCxcbiAgICAgIGBtdXN0IG5vdCBjb250YWluIGEgXCIuXCIgb3IgXCIuLlwiIHNlZ21lbnQsIGdvdCAke3Nob3coY29uZmlndXJlZFBhdGgpfWAsXG4gICAgKTtcbiAgfVxuXG4gIC8vIFZhbGlkYXRlZCDigJQgYW5kLCBmcm9tIGhlcmUgb24sIHVzZWQg4oCUIGF0IHRoZSBwYXRoIHRoaXMgcnVuIGNhbiBhY3R1YWxseVxuICAvLyByZWFkIGl0IGF0OiBpbnNpZGUgdGhlIGNvbnRhaW5lciB0aGF0IGlzIHRoZSBsYXVuY2hlcidzIHJlYWQtb25seSBtb3VudFxuICAvLyBvZiB0aGUgb3BlcmF0b3IncyBkaXJlY3RvcnkgKElzc3VlICM4NTApLlxuICBjb25zdCBwcm9tcHRQYXRoID0gcmVzb2x2ZVBhdGgoY29uZmlndXJlZFBhdGgpO1xuICBjb25zdCBvcmlnaW4gPSBwcm9tcHRQYXRoID09PSBjb25maWd1cmVkUGF0aFxuICAgID8gXCJcIlxuICAgIDogYCAobW91bnRlZCBmcm9tICR7Y29uZmlndXJlZFBhdGh9KWA7XG5cbiAgbGV0IGNvbnRlbnQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICBjb250ZW50ID0gRGVuby5yZWFkVGV4dEZpbGVTeW5jKHByb21wdFBhdGgpO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHJlamVjdChcbiAgICAgIGAke2VudHJ5RmllbGR9LnByb21wdF9wYXRoYCxcbiAgICAgIGBpcyBub3QgYSByZWFkYWJsZSBmaWxlOiAke3Byb21wdFBhdGh9JHtvcmlnaW59ICgke1xuICAgICAgICAoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2VcbiAgICAgIH0pYCxcbiAgICApO1xuICB9XG5cbiAgLy8gQW4gb3ZlcnJpZGUgYW5zd2VycyB0byB0aGUgcGxhY2Vob2xkZXIgY29udHJhY3Qgb2YgdGhlIHBoYXNlIGl0IHJlcGxhY2VzLFxuICAvLyBub3QgdG8gdGhlIGBpc3N1ZWAgb25lIGEgbmV3IGN1c3RvbSBsYWJlbCBydW5zIChJc3N1ZSAjODQ5KS5cbiAgaWYgKG92ZXJyaWRlc1BoYXNlICE9PSB1bmRlZmluZWQpIHtcbiAgICBjb25zdCB0ZW1wbGF0ZVJlc3VsdCA9IHZhbGlkYXRlT3ZlcnJpZGVUZW1wbGF0ZShvdmVycmlkZXNQaGFzZSwgY29udGVudCk7XG4gICAgaWYgKCF0ZW1wbGF0ZVJlc3VsdC5vaykge1xuICAgICAgcmVqZWN0KGAke2VudHJ5RmllbGR9LnByb21wdF9wYXRoYCwgdGVtcGxhdGVSZXN1bHQuZXJyb3IpO1xuICAgIH1cbiAgfVxuXG4gIHNlZW4uc2V0KGNsYWltLCBpbmRleCk7XG4gIHJldHVybiB7XG4gICAgbGFiZWwsXG4gICAgcHJvbXB0UGF0aCxcbiAgICB0YXJnZXRQaGFzZSxcbiAgICAuLi4ob3ZlcnJpZGVzUGhhc2UgIT09IHVuZGVmaW5lZCA/IHsgb3ZlcnJpZGVzUGhhc2UgfSA6IHt9KSxcbiAgfTtcbn1cblxuLyoqXG4gKiBWYWxpZGF0ZSBhbiBlbnRyeSdzIGB0YXJnZXRfcGhhc2VgIChJc3N1ZSAjMTAwOCwgcGFydCBvZiAjOTM4KS5cbiAqXG4gKiBBYnNlbnQgb3IgYG51bGxgIGlzIGBcImlzc3VlXCJgLCBzbyBhIGAuY29uZmlnLmpzb25gIHdyaXR0ZW4gYmVmb3JlIHRoZSBmaWVsZFxuICogZXhpc3RlZCBwcm9kdWNlcyBleGFjdGx5IHRoZSBtYXBwaW5ncyBpdCBhbHdheXMgZGlkLiBBbnl0aGluZyBlbHNlIHRoYXQgaXNcbiAqIG5vdCBvbmUgb2YgdGhlIGFjY2VwdGVkIHZhbHVlcyDigJQgYSBub24tc3RyaW5nLCBhbiBlbXB0eSBzdHJpbmcsIG9yIGEgY2FzZVxuICogdmFyaWFudCDigJQgaXMgcmVmdXNlZCB0aHJvdWdoIHRoZSBzaGFyZWQge0BsaW5rIHJlamVjdH0gcGF0aCByYXRoZXIgdGhhblxuICogcmVwYWlyZWQsIG5hbWluZyB0aGUgZW50cnksIHRoZSBvZmZlbmRpbmcgdmFsdWUgYW5kIHRoZSBhY2NlcHRlZCBzZXQuXG4gKi9cbmZ1bmN0aW9uIHBhcnNlVGFyZ2V0UGhhc2UoXG4gIHJhdzogdW5rbm93bixcbiAgZW50cnlGaWVsZDogc3RyaW5nLFxuKTogQ3VzdG9tUHJvbXB0VGFyZ2V0UGhhc2Uge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3ID09PSBudWxsKSByZXR1cm4gXCJpc3N1ZVwiO1xuICBpZiAoXG4gICAgdHlwZW9mIHJhdyAhPT0gXCJzdHJpbmdcIiB8fFxuICAgICFUQVJHRVRfUEhBU0VTLmluY2x1ZGVzKHJhdyBhcyBDdXN0b21Qcm9tcHRUYXJnZXRQaGFzZSlcbiAgKSB7XG4gICAgcmVqZWN0KFxuICAgICAgYCR7ZW50cnlGaWVsZH0udGFyZ2V0X3BoYXNlYCxcbiAgICAgIGBtdXN0IGJlIG9uZSBvZiAke1RBUkdFVF9QSEFTRVMuam9pbihcIiwgXCIpfSwgZ290ICR7c2hvdyhyYXcpfWAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gcmF3IGFzIEN1c3RvbVByb21wdFRhcmdldFBoYXNlO1xufVxuXG4vKipcbiAqIFZhbGlkYXRlIHRoZSByYXcgYGN1c3RvbV9sYWJlbF9wcm9tcHRzYCBibG9jayBmcm9tIGAuY29uZmlnLmpzb25gLlxuICpcbiAqIFJldHVybnMgYG9rYCB3aXRoIGFuIGVtcHR5IGFycmF5IHdoZW4gdGhlIGtleSBpcyBhYnNlbnQsIHNvIGFuIG9wZXJhdG9yXG4gKiB3aG8gbmV2ZXIgb3B0cyBpbiBnZXRzIHRvZGF5J3MgYmVoYXZpb3VyIHVuY2hhbmdlZC4gUmV0dXJucyB0aGUgKipmaXJzdCoqXG4gKiBmYXVsdCBhcyBhbiBlcnJvciBtZXNzYWdlIG5hbWluZyB0aGUgb2ZmZW5kaW5nIGVudHJ5IGFuZCBmaWVsZCDigJQgdGhlIGxpc3RcbiAqIGlzIG5ldmVyIHBhcnRpYWxseSBhY2NlcHRlZC5cbiAqXG4gKiBAcGFyYW0gcmF3IC0gVGhlIGBjdXN0b21fbGFiZWxfcHJvbXB0c2AgdmFsdWUgZnJvbSBgLmNvbmZpZy5qc29uYFxuICogQHBhcmFtIG9wdGlvbnMgLSBUaGUgY29uZmlndXJlZCBidWlsdC1pbiBsYWJlbCBuYW1lcywgd2hpY2ggZGVjaWRlIHdoZXRoZXIgYW5cbiAqICAgZW50cnkgb3ZlcnJpZGVzIGEgYnVpbHQtaW4gcGhhc2UgKElzc3VlICM4NDkpLCBhbmQgdGhlIGhvc3Qg4oaSIGNvbnRhaW5lclxuICogICBwYXRoIHRyYW5zbGF0aW9uIChJc3N1ZSAjODUwKS4gQ2FsbGVycyBob2xkaW5nIGEgYFdvcmtlckNvbmZpZ2AgbXVzdCBwYXNzXG4gKiAgIGl0cyByZXNvbHZlZCBsYWJlbCBuYW1lczogdGhlIHN0b2NrIGRlZmF1bHRzIHVzZWQgb3RoZXJ3aXNlIHdvdWxkIHJlc29sdmUgYVxuICogICByZW5hbWVkIGxhYmVsIHRvIHRoZSB3cm9uZyBwaGFzZSwgb3IgdG8gbm9uZS5cbiAqIEByZXR1cm5zIFRoZSB2YWxpZGF0ZWQgbWFwcGluZ3MsIG9yIHRoZSBmaXJzdCBmYXVsdFxuICovXG5leHBvcnQgZnVuY3Rpb24gcGFyc2VDdXN0b21MYWJlbFByb21wdHMoXG4gIHJhdzogdW5rbm93bixcbiAgb3B0aW9uczogQ3VzdG9tTGFiZWxQcm9tcHRPcHRpb25zID0ge30sXG4pOiBSZXN1bHQ8Q3VzdG9tTGFiZWxQcm9tcHRNYXBwaW5nW10sIHN0cmluZz4ge1xuICBpZiAocmF3ID09PSB1bmRlZmluZWQgfHwgcmF3ID09PSBudWxsKSByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IFtdIH07XG4gIGlmICghQXJyYXkuaXNBcnJheShyYXcpKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIG9rOiBmYWxzZSxcbiAgICAgIGVycm9yOlxuICAgICAgICBgY3VzdG9tX2xhYmVsX3Byb21wdHMgbXVzdCBiZSBhbiBhcnJheSBvZiBsYWJlbC9wcm9tcHRfcGF0aCBtYXBwaW5ncywgZ290ICR7XG4gICAgICAgICAgc2hvdyhyYXcpXG4gICAgICAgIH1gLFxuICAgIH07XG4gIH1cblxuICBjb25zdCBtYXBwaW5nczogQ3VzdG9tTGFiZWxQcm9tcHRNYXBwaW5nW10gPSBbXTtcbiAgY29uc3Qgc2VlbjogU2VlbkNsYWltcyA9IG5ldyBNYXAoKTtcbiAgY29uc3QgeyByZXNvbHZlUGF0aCA9IChwYXRoOiBzdHJpbmcpID0+IHBhdGgsIC4uLmNvbmZpZ3VyZWROYW1lcyB9ID0gb3B0aW9ucztcbiAgY29uc3QgbmFtZXM6IEJ1aWx0SW5MYWJlbE5hbWVzID0ge1xuICAgIC4uLkRFRkFVTFRfQlVJTFRJTl9MQUJFTF9OQU1FUyxcbiAgICAuLi5jb25maWd1cmVkTmFtZXMsXG4gIH07XG4gIHRyeSB7XG4gICAgZm9yIChsZXQgaW5kZXggPSAwOyBpbmRleCA8IHJhdy5sZW5ndGg7IGluZGV4KyspIHtcbiAgICAgIG1hcHBpbmdzLnB1c2gocGFyc2VFbnRyeShyYXdbaW5kZXhdLCBpbmRleCwgc2VlbiwgbmFtZXMsIHJlc29sdmVQYXRoKSk7XG4gICAgfVxuICB9IGNhdGNoIChlcnJvcikge1xuICAgIGlmIChlcnJvciBpbnN0YW5jZW9mIE1hcHBpbmdFcnJvcikge1xuICAgICAgcmV0dXJuIHsgb2s6IGZhbHNlLCBlcnJvcjogZXJyb3IubWVzc2FnZSB9O1xuICAgIH1cbiAgICB0aHJvdyBlcnJvcjtcbiAgfVxuICByZXR1cm4geyBvazogdHJ1ZSwgdmFsdWU6IG1hcHBpbmdzIH07XG59XG5cbi8qKlxuICoge0BsaW5rIHBhcnNlQ3VzdG9tTGFiZWxQcm9tcHRzfSwgYnV0IHRocm93aW5nIOKAlCB0aGUgZmFpbC1sb3VkIGVudHJ5IHBvaW50XG4gKiB1c2VkIGF0IGNvbmZpZyBsb2FkIHNvIGEgbWFsZm9ybWVkLCBjb2xsaWRpbmcgb3IgdW5yZWFkYWJsZSBtYXBwaW5nIHN0b3BzXG4gKiB0aGUgd29ya2VyIGJlZm9yZSBhIGN1c3RvbSBsYWJlbCBjb3VsZCBldmVyIGRpc3BhdGNoIHNpbGVudGx5LlxuICpcbiAqIEBwYXJhbSByYXcgLSBUaGUgYGN1c3RvbV9sYWJlbF9wcm9tcHRzYCB2YWx1ZSBmcm9tIGAuY29uZmlnLmpzb25gXG4gKiBAcGFyYW0gb3B0aW9ucyAtIFRoZSBjb25maWd1cmVkIGJ1aWx0LWluIGxhYmVsIG5hbWVzIGFuZCBwYXRoIHRyYW5zbGF0aW9uXG4gKiAgIChzZWUge0BsaW5rIHBhcnNlQ3VzdG9tTGFiZWxQcm9tcHRzfSlcbiAqIEByZXR1cm5zIFRoZSB2YWxpZGF0ZWQgbWFwcGluZ3NcbiAqIEB0aHJvd3MgV2hlbiBhbnkgZW50cnkgaXMgaW52YWxpZFxuICovXG5leHBvcnQgZnVuY3Rpb24gYXNzZXJ0Q3VzdG9tTGFiZWxQcm9tcHRzKFxuICByYXc6IHVua25vd24sXG4gIG9wdGlvbnM6IEN1c3RvbUxhYmVsUHJvbXB0T3B0aW9ucyA9IHt9LFxuKTogQ3VzdG9tTGFiZWxQcm9tcHRNYXBwaW5nW10ge1xuICBjb25zdCByZXN1bHQgPSBwYXJzZUN1c3RvbUxhYmVsUHJvbXB0cyhyYXcsIG9wdGlvbnMpO1xuICBpZiAoIXJlc3VsdC5vaykge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBJbnZhbGlkIGN1c3RvbV9sYWJlbF9wcm9tcHRzIGluIC5jb25maWcuanNvbjogJHtyZXN1bHQuZXJyb3J9YCxcbiAgICApO1xuICB9XG4gIHJldHVybiByZXN1bHQudmFsdWU7XG59XG5cbi8qKlxuICogVGhlIGNvbmZpZ3VyZWQgcHJvbXB0IHBhdGhzLCByZWFkIHN0cmFpZ2h0IGZyb20gYSBgLmNvbmZpZy5qc29uYCBvbiBkaXNrXG4gKiAoSXNzdWUgIzg1MCwgcGFydCBvZiAjODQzKS5cbiAqXG4gKiBVc2VkIGJ5IHRoZSBjb250YWluZXIgbGF1bmNoZXIsIHdoaWNoIG11c3Qga25vdyB3aGljaCBob3N0IGRpcmVjdG9yaWVzIHRvXG4gKiBtb3VudCBiZWZvcmUgYW55IHdvcmtlciBoYXMgbG9hZGVkIGEgY29uZmlndXJhdGlvbi4gQWJzZW50IGZpbGUg4oaSIG5vXG4gKiBtYXBwaW5ncywgd2hpY2ggaXMgd2hhdCBhbiB1bmNvbmZpZ3VyZWQgaG9zdCBoYXMgYWx3YXlzIGhhZC4gQSBmaWxlIHRoYXRcbiAqIGV4aXN0cyBidXQgY2Fubm90IGJlIHJlYWQsIGlzIG5vdCBKU09OLCBvciBzdGF0ZXMgYSBtYWxmb3JtZWQgbWFwcGluZyBpc1xuICogKipub3QqKiB0cmVhdGVkIGFzIHVuY29uZmlndXJlZDogaXQgdGhyb3dzLCBiZWNhdXNlIGxhdW5jaGluZyB3aXRob3V0IHRoZVxuICogbW91bnQgd291bGQgbGVhdmUgZXZlcnkgY3VzdG9tIGxhYmVsIGZhaWxpbmcgYXQgZGlzcGF0Y2ggaW5zaWRlIHRoZVxuICogY29udGFpbmVyLlxuICpcbiAqIFRoZSBsYWJlbCBuYW1lcyBhcmUgcmVhZCBmcm9tIHRoZSBzYW1lIGZpbGUgKElzc3VlICM4NDkpLCBzbyB0aGUgbGF1bmNoZXJcbiAqIHJlc29sdmVzIGFuIG92ZXJyaWRlIGV4YWN0bHkgYXMgYGxvYWRDb25maWdgIHdpbGwgaW5zaWRlIHRoZSBjb250YWluZXIuIExlZnRcbiAqIHRvIHRoZSBzdG9jayBkZWZhdWx0cyBpdCB3b3VsZCByZWplY3QgYSBmbGVldCB0aGF0IHJlbmFtZWQgYHBsYW5uaW5nYCDigJQgYVxuICogdmFsaWQgY29uZmlndXJhdGlvbiB0aGF0IHRoZSB3b3JrZXIgaXRzZWxmIGFjY2VwdHMuXG4gKlxuICogQHBhcmFtIGNvbmZpZ0ZpbGUgLSBIb3N0IHBhdGggb2YgdGhlIHdvcmtlciBjb25maWd1cmF0aW9uIGZpbGVcbiAqIEByZXR1cm5zIFRoZSBjb25maWd1cmVkIGFic29sdXRlIGhvc3QgcHJvbXB0IHBhdGhzLCBpbiBjb25maWd1cmF0aW9uIG9yZGVyXG4gKiBAdGhyb3dzIFdoZW4gdGhlIGZpbGUgZXhpc3RzIGJ1dCBpcyB1bnJlYWRhYmxlLCBpcyBub3QgYSBKU09OIG9iamVjdCwgb3JcbiAqICAgY2FycmllcyBhbiBpbnZhbGlkIGBjdXN0b21fbGFiZWxfcHJvbXB0c2AgYmxvY2tcbiAqL1xuZXhwb3J0IGFzeW5jIGZ1bmN0aW9uIHJlYWRDb25maWd1cmVkQ3VzdG9tUHJvbXB0UGF0aHMoXG4gIGNvbmZpZ0ZpbGU6IHN0cmluZyxcbik6IFByb21pc2U8c3RyaW5nW10+IHtcbiAgbGV0IHRleHQ6IHN0cmluZztcbiAgdHJ5IHtcbiAgICB0ZXh0ID0gYXdhaXQgRGVuby5yZWFkVGV4dEZpbGUoY29uZmlnRmlsZSk7XG4gIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgaWYgKGVycm9yIGluc3RhbmNlb2YgRGVuby5lcnJvcnMuTm90Rm91bmQpIHJldHVybiBbXTtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQ2Fubm90IHJlYWQgdGhlIGN1c3RvbSBwcm9tcHQgbWFwcGluZ3M6ICR7Y29uZmlnRmlsZX0gaXMgdW5yZWFkYWJsZSBgICtcbiAgICAgICAgYCgkeyhlcnJvciBhcyBFcnJvcikubWVzc2FnZX0pLmAsXG4gICAgKTtcbiAgfVxuXG4gIGxldCBwYXJzZWQ6IHVua25vd247XG4gIHRyeSB7XG4gICAgcGFyc2VkID0gSlNPTi5wYXJzZSh0ZXh0KTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoXG4gICAgICBgQ2Fubm90IHJlYWQgdGhlIGN1c3RvbSBwcm9tcHQgbWFwcGluZ3M6ICR7Y29uZmlnRmlsZX0gaXMgbm90IHZhbGlkIGAgK1xuICAgICAgICBgSlNPTiAoJHsoZXJyb3IgYXMgRXJyb3IpLm1lc3NhZ2V9KS5gLFxuICAgICk7XG4gIH1cbiAgaWYgKHBhcnNlZCA9PT0gbnVsbCB8fCB0eXBlb2YgcGFyc2VkICE9PSBcIm9iamVjdFwiIHx8IEFycmF5LmlzQXJyYXkocGFyc2VkKSkge1xuICAgIHRocm93IG5ldyBFcnJvcihcbiAgICAgIGBDYW5ub3QgcmVhZCB0aGUgY3VzdG9tIHByb21wdCBtYXBwaW5nczogJHtjb25maWdGaWxlfSBpcyBub3QgYSBKU09OIGAgK1xuICAgICAgICBgb2JqZWN0LmAsXG4gICAgKTtcbiAgfVxuXG4gIGNvbnN0IGZpbGUgPSBwYXJzZWQgYXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj47XG4gIHJldHVybiBhc3NlcnRDdXN0b21MYWJlbFByb21wdHMoXG4gICAgZmlsZVtcImN1c3RvbV9sYWJlbF9wcm9tcHRzXCJdLFxuICAgIGNvbmZpZ3VyZWRMYWJlbE5hbWVzKGZpbGUpLFxuICApLm1hcCgobWFwcGluZykgPT4gbWFwcGluZy5wcm9tcHRQYXRoKTtcbn1cblxuLyoqIFRoZSBjb25maWd1cmFibGUgYnVpbHQtaW4gbGFiZWwgbmFtZXMgYSByYXcgYC5jb25maWcuanNvbmAgb2JqZWN0IHN0YXRlcy4gKi9cbmZ1bmN0aW9uIGNvbmZpZ3VyZWRMYWJlbE5hbWVzKFxuICBmaWxlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbik6IFBhcnRpYWw8QnVpbHRJbkxhYmVsTmFtZXM+IHtcbiAgLy8gYHdvcmtfb25fbGFiZWxgIGlzIGRlbGliZXJhdGVseSBhYnNlbnQ6IHRoZSB0aHJlZSBkaXNjb3ZlcnkgbGFiZWxzIGFyZVxuICAvLyBoYXJkd2lyZWQgaW4gYGxpYi9jb25maWdfZGVmYXVsdHMudHNgIGFuZCBjYW5ub3QgYmUgcmVuYW1lZCAoSXNzdWUgIzE4MzQpLlxuICBjb25zdCBmaWVsZHM6IFtrZXlvZiBCdWlsdEluTGFiZWxOYW1lcywgc3RyaW5nXVtdID0gW1xuICAgIFtcInBsYW5uaW5nTGFiZWxcIiwgXCJwbGFubmluZ19sYWJlbFwiXSxcbiAgICBbXCJxdWVzdGlvbkxhYmVsXCIsIFwicXVlc3Rpb25fbGFiZWxcIl0sXG4gICAgW1wiZ3JpbGxNZUxhYmVsXCIsIFwiZ3JpbGxfbWVfbGFiZWxcIl0sXG4gICAgW1wicXVvcnVtTGFiZWxcIiwgXCJxdW9ydW1fbGFiZWxcIl0sXG4gICAgW1wicmVmaW5lSXNzdWVMYWJlbFwiLCBcInJlZmluZV9pc3N1ZV9sYWJlbFwiXSxcbiAgXTtcbiAgY29uc3QgbmFtZXM6IFBhcnRpYWw8QnVpbHRJbkxhYmVsTmFtZXM+ID0ge307XG4gIGZvciAoY29uc3QgW2ZpZWxkLCBrZXldIG9mIGZpZWxkcykge1xuICAgIGNvbnN0IHZhbHVlID0gZmlsZVtrZXldO1xuICAgIGlmICh0eXBlb2YgdmFsdWUgPT09IFwic3RyaW5nXCIgJiYgdmFsdWUubGVuZ3RoID4gMCkgbmFtZXNbZmllbGRdID0gdmFsdWU7XG4gIH1cbiAgcmV0dXJuIG5hbWVzO1xufVxuXG4vKipcbiAqIFRoZSBsYWJlbCBuYW1lcyB0aGF0ICoqZGlzcGF0Y2gqKiBhIGNvbmZpZ3VyZWQgbWFwcGluZyAoSXNzdWUgIzg0NywgcGFydCBvZlxuICogIzg0MykuXG4gKlxuICogVGhlIHRydXN0IGdhdGUgKGBvcGVyYXRpb25hbERpc3BhdGNoTGFiZWxzYCksIHRoZSBvcGVyYXRpb25hbC1sYWJlbFxuICogdmVyaWZpY2F0aW9uIGluIGBsYWJlbF9zZWN1cml0eS50c2AsIGFuZCB0aGUgcmVzZXJ2ZWQtbGFiZWwgZmlsdGVycyBpblxuICogYGdpdGh1Yi50c2AgYWxsIG5lZWQgdGhlIGxhYmVsIG5hbWVzIHdpdGhvdXQgdGhlIHByb21wdCBwYXRocy4gUmVhZGluZyB0aGVtXG4gKiBmcm9tIHRoaXMgb25lIGhlbHBlciBrZWVwcyB0aG9zZSBndWFyZHMgaW4gc3RlcCB3aXRoIHRoZSB2YWxpZGF0ZWQgY29uZmlnXG4gKiByYXRoZXIgdGhhbiBlYWNoIHJlYnVpbGRpbmcgdGhlIGxpc3QuXG4gKlxuICogQW4gKipvdmVycmlkZSoqIGlzIGV4Y2x1ZGVkIChJc3N1ZSAjODQ5KTogaXQgbmFtZXMgYSBidWlsdC1pbiBsYWJlbCB0aGF0XG4gKiBhbHJlYWR5IGNhcnJpZXMgaXRzIG93biBnYXRlLCBzbyBhZGRpbmcgaXQgaGVyZSB3b3VsZCBjaGFuZ2UgdGhhdCBsYWJlbCdzXG4gKiB0cnVzdCBwb3N0dXJlIGFzIGEgc2lkZSBlZmZlY3Qgb2Ygc3dhcHBpbmcgaXRzIHRlbXBsYXRlLiBgd29yay1vbmAgaXMgdGhlXG4gKiBzaGFycCBjYXNlIOKAlCBpdCBzaXRzIGRlbGliZXJhdGVseSBvdXRzaWRlIHRoZSBBTkQtZ2F0ZWQgc2V0LCBhbmQgYW4gb3BlcmF0b3JcbiAqIHdobyBvdmVycm9kZSBpdHMgcHJvbXB0IHdvdWxkIG90aGVyd2lzZSBmaW5kIHRoZSBmbGVldCdzIG1haW4gZGlzY292ZXJ5XG4gKiBsYWJlbCBuZXdseSBzdHJpcHBlZCBvbiBldmVyeSB1bnRydXN0ZWQgb3IgdW5hdHRyaWJ1dGFibGUgYWRkLiBPbmx5IGEgbmV3XG4gKiBsYWJlbCBicmluZ3MgYSBuZXcgcHJpdmlsZWdlZCBkaXNwYXRjaCB3aXRoIGl0LlxuICpcbiAqIFRoZSBvcHRpb25hbCBgcGhhc2VgIG5hcnJvd3MgdGhlIHJlc3VsdCB0byBvbmUgdGFyZ2V0IHBoYXNlIChJc3N1ZSAjMTAwOCkuXG4gKiBgb3BlcmF0aW9uYWxEaXNwYXRjaExhYmVsc2AgZGVsaWJlcmF0ZWx5IGNhbGxzIHRoaXMgKip1bmZpbHRlcmVkKiog4oCUIHRoZVxuICogdHJ1c3QgZ2F0ZSBhcHBsaWVzIHRvIGEgY3VzdG9tIGxhYmVsIHdoaWNoZXZlciBwaGFzZSBpdCBydW5zIGluIOKAlCB3aGlsZSB0aGVcbiAqIHR3byBkaXNwYXRjaCBwYXRocyBlYWNoIGFzayBmb3IgdGhlaXIgb3duLlxuICpcbiAqIEBwYXJhbSBjb25maWcgLSBXb3JrZXIgY29uZmlndXJhdGlvbiAob3IgYW55IG9iamVjdCBjYXJyeWluZyB0aGUgcmVzb2x2ZWQgbGlzdClcbiAqIEBwYXJhbSBwaGFzZSAtIE9wdGlvbmFsIHRhcmdldC1waGFzZSBmaWx0ZXIgKElzc3VlICMxMDA4KVxuICogQHJldHVybnMgVGhlIGRpc3BhdGNoaW5nIGxhYmVscywgaW4gY29uZmlndXJhdGlvbiBvcmRlciBhbmQgb3JpZ2luYWwgY2FzZVxuICovXG5leHBvcnQgZnVuY3Rpb24gY3VzdG9tTGFiZWxQcm9tcHRMYWJlbHMoXG4gIGNvbmZpZzogeyBjdXN0b21MYWJlbFByb21wdHM6IEN1c3RvbUxhYmVsUHJvbXB0TWFwcGluZ1tdIH0sXG4gIHBoYXNlPzogQ3VzdG9tUHJvbXB0VGFyZ2V0UGhhc2UsXG4pOiBzdHJpbmdbXSB7XG4gIHJldHVybiBjdXN0b21EaXNwYXRjaE1hcHBpbmdzKGNvbmZpZywgcGhhc2UpLm1hcCgobWFwcGluZykgPT4gbWFwcGluZy5sYWJlbCk7XG59XG5cbi8qKlxuICogUmVzb2x2ZSB0aGUgY29uZmlndXJlZCBwcm9tcHQgZmlsZSBmb3IgYSBHaXRIdWIgbGFiZWwsIGlmIGFueSAoSXNzdWUgIzg0NixcbiAqIHBhcnQgb2YgIzg0MykuXG4gKlxuICogQSBwdXJlIGxvb2t1cCBhZ2FpbnN0IHRoZSBhbHJlYWR5LXZhbGlkYXRlZCBgV29ya2VyQ29uZmlnLmN1c3RvbUxhYmVsUHJvbXB0c2BcbiAqIGxpc3Qg4oCUIHRoZSB0cnVzdCBnYXRlICgjODQ3KSBhbmQgZGlzcGF0Y2ggKCM4NDgpIGJ1aWxkIG9uIHRoaXMgcmF0aGVyIHRoYW5cbiAqIHJlLXBhcnNpbmcgdGhlIHJhdyBjb25maWcuIENvbXBhcmlzb24gaXMgY2FzZS1pbnNlbnNpdGl2ZSwgbWF0Y2hpbmcgR2l0SHViJ3NcbiAqIG93biBsYWJlbCBoYW5kbGluZyBhbmQgYGlzUmVzZXJ2ZWRMYWJlbGAuXG4gKlxuICogQHBhcmFtIGNvbmZpZyAtIFdvcmtlciBjb25maWd1cmF0aW9uIChvciBhbnkgb2JqZWN0IGNhcnJ5aW5nIHRoZSByZXNvbHZlZCBsaXN0KVxuICogQHBhcmFtIGxhYmVsIC0gVGhlIEdpdEh1YiBsYWJlbCB0byBsb29rIHVwXG4gKiBAcmV0dXJucyBUaGUgbWFwcGluZydzIGFic29sdXRlIHByb21wdCBwYXRoLCBvciBgdW5kZWZpbmVkYCB3aGVuIG5vIG1hcHBpbmdcbiAqICAgaXMgY29uZmlndXJlZCBmb3IgdGhhdCBsYWJlbFxuICovXG5leHBvcnQgZnVuY3Rpb24gY3VzdG9tTGFiZWxQcm9tcHRQYXRoKFxuICBjb25maWc6IHsgY3VzdG9tTGFiZWxQcm9tcHRzOiBDdXN0b21MYWJlbFByb21wdE1hcHBpbmdbXSB9LFxuICBsYWJlbDogc3RyaW5nLFxuKTogc3RyaW5nIHwgdW5kZWZpbmVkIHtcbiAgY29uc3QgdGFyZ2V0ID0gbGFiZWwudG9Mb3dlckNhc2UoKTtcbiAgcmV0dXJuIGNvbmZpZy5jdXN0b21MYWJlbFByb21wdHMuZmluZCgobWFwcGluZykgPT5cbiAgICBtYXBwaW5nLmxhYmVsLnRvTG93ZXJDYXNlKCkgPT09IHRhcmdldFxuICApPy5wcm9tcHRQYXRoO1xufVxuXG4vKipcbiAqIFRoZSBtYXBwaW5ncyB0aGF0IGRpc3BhdGNoIGEgKipuZXcqKiBsYWJlbCAoSXNzdWUgIzg0OSkuXG4gKlxuICogQW4gb3ZlcnJpZGUgbmFtZXMgYSBidWlsdC1pbiBsYWJlbCwgd2hpY2ggYWxyZWFkeSBoYXMgaXRzIG93biBwcmlvcml0eVxuICogaGFuZGxlcjsgc2Nhbm5pbmcgZm9yIGl0IGFnYWluIGluIHRoZSBjdXN0b20tbGFiZWwgcm93IHdvdWxkIHJ1biwgc2F5LCBhXG4gKiBgcGxhbm5pbmdgLWxhYmVsbGVkIGlzc3VlIHRocm91Z2ggdGhlIGltcGxlbWVudGF0aW9uIHBoYXNlLiBPbmx5IG5ldyBsYWJlbHNcbiAqIGJlbG9uZyBpbiB0aGF0IHNjYW4uXG4gKlxuICogVGhlIG9wdGlvbmFsIGBwaGFzZWAgbmFycm93cyB0aGUgcmVzdWx0IHRvIHRoZSBtYXBwaW5ncyB0aGF0IHJ1biBpbiBvbmVcbiAqIHRhcmdldCBwaGFzZSAoSXNzdWUgIzEwMDgsIHBhcnQgb2YgIzkzOCksIHNvIHRoZSBpc3N1ZSBzY2FubmVyIG5ldmVyIHNlZXMgYVxuICogYHByYCBsYWJlbCDigJQgaXQgd291bGQgYmUgaHVudGVkIGZvciBhbW9uZyBpc3N1ZXMgYW5kIGl0cyB0ZW1wbGF0ZSByZWplY3RlZFxuICogZm9yIG1pc3NpbmcgYHt7SVNTVUVfTlVNQkVSfX1gIOKAlCBhbmQgdGhlIFBSIHNjYW5uZXIgbmV2ZXIgc2VlcyBhbiBgaXNzdWVgXG4gKiBvbmUuXG4gKlxuICogQHBhcmFtIGNvbmZpZyAtIFdvcmtlciBjb25maWd1cmF0aW9uIChvciBhbnkgb2JqZWN0IGNhcnJ5aW5nIHRoZSBsaXN0KVxuICogQHBhcmFtIHBoYXNlIC0gT3B0aW9uYWwgdGFyZ2V0LXBoYXNlIGZpbHRlciAoSXNzdWUgIzEwMDgpXG4gKiBAcmV0dXJucyBUaGUgbWFwcGluZ3Mgd2l0aCBubyBidWlsdC1pbiBwaGFzZSB0byBvdmVycmlkZVxuICovXG5leHBvcnQgZnVuY3Rpb24gY3VzdG9tRGlzcGF0Y2hNYXBwaW5ncyhcbiAgY29uZmlnOiB7IGN1c3RvbUxhYmVsUHJvbXB0czogQ3VzdG9tTGFiZWxQcm9tcHRNYXBwaW5nW10gfSxcbiAgcGhhc2U/OiBDdXN0b21Qcm9tcHRUYXJnZXRQaGFzZSxcbik6IEN1c3RvbUxhYmVsUHJvbXB0TWFwcGluZ1tdIHtcbiAgcmV0dXJuIGNvbmZpZy5jdXN0b21MYWJlbFByb21wdHMuZmlsdGVyKFxuICAgIChtYXBwaW5nKSA9PlxuICAgICAgbWFwcGluZy5vdmVycmlkZXNQaGFzZSA9PT0gdW5kZWZpbmVkICYmXG4gICAgICAocGhhc2UgPT09IHVuZGVmaW5lZCB8fCBtYXBwaW5nLnRhcmdldFBoYXNlID09PSBwaGFzZSksXG4gICk7XG59XG5cbi8qKlxuICogVGhlIG1hcHBpbmdzIHRoYXQgb3ZlcnJpZGUgYSBidWlsdC1pbiBwaGFzZSdzIHRlbXBsYXRlIChJc3N1ZSAjODQ5KS5cbiAqXG4gKiBIYW5kZWQgdG8gdGhlIHByb21wdCBidWlsZGVycywgd2hpY2ggcmVzb2x2ZSB0aGUgdGVtcGxhdGUgZm9yIHRoZSBwaGFzZSB0aGV5XG4gKiBhcmUgYnVpbGRpbmcgdGhyb3VnaCBgcmVzb2x2ZVByb21wdFRlbXBsYXRlYC5cbiAqXG4gKiBAcGFyYW0gY29uZmlnIC0gV29ya2VyIGNvbmZpZ3VyYXRpb24gKG9yIGFueSBvYmplY3QgY2FycnlpbmcgdGhlIGxpc3QpXG4gKiBAcmV0dXJucyBUaGUgbWFwcGluZ3MgdGhhdCByZXBsYWNlIGEgYnVpbHQtaW4gcGhhc2UgdGVtcGxhdGVcbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIHByb21wdE92ZXJyaWRlTWFwcGluZ3MoXG4gIGNvbmZpZzogeyBjdXN0b21MYWJlbFByb21wdHM6IEN1c3RvbUxhYmVsUHJvbXB0TWFwcGluZ1tdIH0sXG4pOiBDdXN0b21MYWJlbFByb21wdE1hcHBpbmdbXSB7XG4gIHJldHVybiBjb25maWcuY3VzdG9tTGFiZWxQcm9tcHRzLmZpbHRlcihcbiAgICAobWFwcGluZykgPT4gbWFwcGluZy5vdmVycmlkZXNQaGFzZSAhPT0gdW5kZWZpbmVkLFxuICApO1xufVxuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0NBc0JDLEdBT0QsU0FBUyxlQUFlLFFBQVEsdUJBQXVCO0FBQ3ZELFNBQVMsc0JBQXNCLFFBQVEsMEJBQTBCO0FBRWpFLFNBQ0UsMkJBQTJCLEVBQzNCLG9C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
// denoCacheMetadata=6406552003619293072,18085431770331796390