/**
 * Append-only per-host lifecycle ledger (Issue #3718, part of #3644).
 *
 * Every issue assignment, agent invocation, follow-on run, gate result and
 * outcome is recorded as one JSON line in this host's ledger:
 *
 *   {workDir}/lifecycle_ledger_{host}.jsonl
 *
 * The hostname rides in the filename, matching `fleet_telemetry_sidecar.ts`,
 * so several workers sharing a work volume keep separate ledgers instead of
 * interleaving one another's lines.
 *
 * Two rules keep the ledger safe to publish and safe to replay:
 *
 *   - **Allowlist, not denylist.** {@link validateLifecycleEvent} refuses any
 *     key the kind does not name, and any string that is not a bounded token,
 *     label, repo, UUID or timestamp. A prompt or an issue body has no key to
 *     be stored under, and an e-mail address or multi-word prose fails every
 *     value pattern. A single-token secret or a bare login does fit the token
 *     pattern, so the patterns alone do not keep one out of an identifier
 *     field; the assignment writer fills those fields from worker-owned
 *     sources (host name, run id, model routing, build facts).
 *   - **Idempotent by key.** Each event carries a deterministic `eventKey`.
 *     The writer is a plain append; {@link readLifecycleLedger} dedupes on
 *     that key, so a replay after a restart is harmless.
 *
 * Refusals name the offending field and the rule it broke, never the value,
 * so a refused secret cannot leak into a log line.
 *
 * Australian English spelling used throughout.
 */ import { getHostname } from "./worker_identity.ts";
import { sanitiseHostname } from "./fleet_telemetry_sidecar.ts";
/** Ledger line schema version. A line carrying a higher one is refused. */ export const LIFECYCLE_LEDGER_SCHEMA = 1;
/** The five kinds of lifecycle event the ledger records. */ export const LIFECYCLE_EVENT_KINDS = [
  "assignment",
  "invocation",
  "follow_on",
  "gate",
  "outcome"
];
/** The agent roles an invocation or treatment can carry. */ export const LIFECYCLE_ROLES = [
  "manager",
  "executor",
  "reviewer"
];
/** The cohort an assignment carries until an operator labels it. */ export const UNASSIGNED_COHORT = "unassigned";
/**
 * The deterministic key that identifies one event.
 *
 * Two lines with the same key describe the same fact, so the reader keeps
 * only the first. A PR outcome is keyed by its PR number and not its run, so
 * a PR counts once however many runs or hosts observe it.
 *
 * @param event - The event, before or after its key is attached.
 * @returns The key.
 */ export function lifecycleEventKey(event) {
  switch(event.kind){
    case "assignment":
      return `assignment:${event.assignmentId}:${event.host}`;
    case "invocation":
      if (event.invocationIndex !== undefined) {
        return `invocation:${event.assignmentId}:${event.runId}:${event.invocationIndex}`;
      }
      return `invocation:${event.assignmentId}:${event.runId}:${event.role}:` + `${event.agent ?? "-"}:${event.attempt}`;
    case "follow_on":
      if (event.cycle !== undefined) {
        return `follow_on:${event.assignmentId}:${event.repo}:${event.prNumber}:${event.followOn}:${event.cycle}:${event.attempt}`;
      }
      return `follow_on:${event.assignmentId}:${event.runId}:` + `${event.followOn}:${event.prNumber ?? "-"}:${event.attempt}`;
    case "gate":
      return `gate:${event.assignmentId}:${event.runId}:${event.gate}:` + `${event.attempt}`;
    case "outcome":
      return event.prNumber !== undefined ? `outcome:${event.assignmentId}:${event.outcome}:pr-${event.prNumber}` : `outcome:${event.assignmentId}:${event.outcome}:run-${event.runId}`;
  }
}
/**
 * Raised when a value is refused by the ledger's allowlist.
 *
 * `field` names the offending key or field. The message never carries the
 * value itself.
 */ export class LifecycleEventSchemaError extends Error {
  field;
  constructor(field, reason){
    super(`Lifecycle event field ${field} is invalid: ${reason}`);
    this.name = "LifecycleEventSchemaError";
    this.field = field;
  }
}
/** Keys every event may carry. Anything else is refused. */ const BASE_KEYS = [
  "schema",
  "kind",
  "eventKey",
  "assignmentId",
  "runId",
  "host",
  "repo",
  "issueNumber",
  "recordedAt"
];
/** Keys each kind may carry beyond the base keys. */ const KIND_KEYS = {
  assignment: [
    "assignedAt",
    "cohort",
    "reused",
    "treatment"
  ],
  invocation: [
    "invocationIndex",
    "requestedModel",
    "servedModel",
    "usage",
    "telemetryAbsentReason",
    "pricing",
    "estimatedApiEquivalentUsd",
    "models",
    "quotaStatus",
    "role",
    "agent",
    "attempt",
    "provider",
    "model",
    "effort",
    "servedModels",
    "result",
    "durationSeconds",
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheCreationTokens",
    "estimatedApiCostUsd"
  ],
  follow_on: [
    "followOn",
    "attempt",
    "prNumber",
    "cycle",
    "usage",
    "pricing",
    "estimatedApiEquivalentUsd"
  ],
  gate: [
    "gate",
    "result",
    "attempt",
    "prNumber"
  ],
  outcome: [
    "outcome",
    "prNumber"
  ]
};
/** Keys a treatment may carry. */ const TREATMENT_KEYS = [
  "roles",
  "workerVersion",
  "workerCommit",
  "reviewPolicyFingerprint",
  "subscriptionAllocation"
];
/** Keys one role treatment may carry. */ const ROLE_TREATMENT_KEYS = [
  "role",
  "agent",
  "provider",
  "model",
  "effort"
];
/**
 * The shape of a token: a provider, model, effort, agent, host, run id, gate
 * or version. No `@`, no whitespace, so an e-mail address or multi-word prose
 * is refused; a single-token secret or a bare login is not recognised.
 * Bounded, with no overlapping quantifiers, because it runs on agent and
 * operator text.
 */ const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]{0,127}$/;
/** A GitHub `owner/name` repository. */ const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;
/** A lowercase UUID, the form {@link AssignmentEvent} identifies itself by. */ const ASSIGNMENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A cohort or subscription label: lowercase, dotted or dashed, bounded. */ const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** An ISO-8601 UTC timestamp, to at most millisecond precision. */ const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
/**
 * Whether `value` is a plain object (a JSON object, not an array or class).
 *
 * Exported so the assignment module reads JSON through the same guard.
 */ export function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
/** Whether `value` is a UUID the ledger accepts as an assignment id. */ export function isValidAssignmentId(value) {
  return typeof value === "string" && ASSIGNMENT_ID_PATTERN.test(value);
}
/** Whether `value` is a cohort or subscription label the ledger accepts. */ export function isValidLifecycleLabel(value) {
  return typeof value === "string" && LABEL_PATTERN.test(value);
}
/** Whether `value` is a timestamp the ledger accepts. */ export function isValidLifecycleTimestamp(value) {
  return typeof value === "string" && TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}
/** Refuse a key the allowlist does not name. */ function assertAllowedKeys(value, allowed, prefix) {
  for (const key of Object.keys(value)){
    if (!allowed.includes(key)) {
      throw new LifecycleEventSchemaError(`${prefix}${key}`, "key is not on the allowlist");
    }
  }
}
/** Refuse a string that does not match `pattern`. */ function requirePattern(value, field, pattern, rule) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new LifecycleEventSchemaError(field, rule);
  }
  return value;
}
/** Refuse a value that is not one of `allowed`. */ function requireEnum(value, field, allowed) {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new LifecycleEventSchemaError(field, `must be one of ${allowed.join(", ")}`);
  }
  return value;
}
/** Refuse a value that is not a positive safe integer. */ function requirePositiveInteger(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new LifecycleEventSchemaError(field, "must be a positive integer");
  }
  return value;
}
/** Refuse a value that is not a non-negative safe integer. */ function requireCount(value, field) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LifecycleEventSchemaError(field, "must be a non-negative integer");
  }
  return value;
}
/** Refuse a value that is not a finite, non-negative number. */ function requireNonNegativeNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new LifecycleEventSchemaError(field, "must be a finite number >= 0");
  }
  return value;
}
/** Refuse a value that is not a boolean. */ function requireBoolean(value, field) {
  if (typeof value !== "boolean") {
    throw new LifecycleEventSchemaError(field, "must be a boolean");
  }
  return value;
}
/** Refuse a value that is not a timestamp the ledger accepts. */ function requireTimestamp(value, field) {
  if (!isValidLifecycleTimestamp(value)) {
    throw new LifecycleEventSchemaError(field, "must be an ISO-8601 UTC timestamp");
  }
  return value;
}
/** Refuse a value that is not a token. */ function requireToken(value, field) {
  return requirePattern(value, field, TOKEN_PATTERN, "must be a bounded token");
}
/** Refuse a value that is not a label. */ function requireLabel(value, field) {
  if (!isValidLifecycleLabel(value)) {
    throw new LifecycleEventSchemaError(field, "must be a bounded label");
  }
  return value;
}
/** Refuse a value that is not a `string[]` of tokens. */ function requireTokenList(value, field) {
  if (!Array.isArray(value)) {
    throw new LifecycleEventSchemaError(field, "must be an array");
  }
  return value.map((item, index)=>requireToken(item, `${field}[${index}]`));
}
/** Read an optional field: absent or `undefined` is no value. */ function optional(value, check) {
  return value === undefined ? undefined : check(value);
}
/** Validate one role treatment against its allowlist. */ function validateRoleTreatment(value, index) {
  const field = `treatment.roles[${index}]`;
  if (!isPlainObject(value)) {
    throw new LifecycleEventSchemaError(field, "must be an object");
  }
  assertAllowedKeys(value, ROLE_TREATMENT_KEYS, "treatment.roles[].");
  const role = requireEnum(value.role, `${field}.role`, LIFECYCLE_ROLES);
  const provider = requireToken(value.provider, `${field}.provider`);
  const agent = optional(value.agent, (v)=>requireToken(v, `${field}.agent`));
  const model = optional(value.model, (v)=>requireToken(v, `${field}.model`));
  const effort = optional(value.effort, (v)=>requireToken(v, `${field}.effort`));
  return {
    role,
    provider,
    ...agent !== undefined ? {
      agent
    } : {},
    ...model !== undefined ? {
      model
    } : {},
    ...effort !== undefined ? {
      effort
    } : {}
  };
}
/** Validate an assignment's treatment against its allowlist. */ function validateTreatment(value) {
  if (!isPlainObject(value)) {
    throw new LifecycleEventSchemaError("treatment", "must be an object");
  }
  assertAllowedKeys(value, TREATMENT_KEYS, "treatment.");
  if (!Array.isArray(value.roles) || value.roles.length === 0) {
    throw new LifecycleEventSchemaError("treatment.roles", "must be a non-empty array");
  }
  const roles = value.roles.map((item, index)=>validateRoleTreatment(item, index));
  const workerVersion = optional(value.workerVersion, (v)=>requireToken(v, "treatment.workerVersion"));
  const workerCommit = optional(value.workerCommit, (v)=>requireToken(v, "treatment.workerCommit"));
  const reviewPolicyFingerprint = optional(value.reviewPolicyFingerprint, (v)=>{
    if (typeof v !== "string" || !/^[0-9a-f]{64}$/.test(v)) {
      throw new LifecycleEventSchemaError("treatment.reviewPolicyFingerprint", "must be a SHA-256 fingerprint");
    }
    return v;
  });
  const subscriptionAllocation = optional(value.subscriptionAllocation, (v)=>requireLabel(v, "treatment.subscriptionAllocation"));
  return {
    roles,
    ...workerVersion !== undefined ? {
      workerVersion
    } : {},
    ...workerCommit !== undefined ? {
      workerCommit
    } : {},
    ...reviewPolicyFingerprint !== undefined ? {
      reviewPolicyFingerprint
    } : {},
    ...subscriptionAllocation !== undefined ? {
      subscriptionAllocation
    } : {}
  };
}
/** Validate the optional telemetry extension, including every nested key. */ function validateTelemetry(value) {
  optional(value.usage, (v)=>requireEnum(v, "usage", [
      "known",
      "unknown"
    ]));
  optional(value.pricing, (v)=>requireEnum(v, "pricing", [
      "known",
      "unknown"
    ]));
  optional(value.estimatedApiEquivalentUsd, (v)=>requireNonNegativeNumber(v, "estimatedApiEquivalentUsd"));
  if ((value.usage === "unknown" || value.pricing === "unknown") && value.estimatedApiEquivalentUsd !== undefined) {
    throw new LifecycleEventSchemaError("estimatedApiEquivalentUsd", "must be absent when usage or pricing is unknown");
  }
}
/** Validate the kind-specific fields of an event, after the base fields. */ function validateKindFields(value, kind) {
  switch(kind){
    case "assignment":
      requireTimestamp(value.assignedAt, "assignedAt");
      requireLabel(value.cohort, "cohort");
      requireBoolean(value.reused, "reused");
      validateTreatment(value.treatment);
      return;
    case "invocation":
      {
        validateTelemetry(value);
        optional(value.invocationIndex, (v)=>requirePositiveInteger(v, "invocationIndex"));
        optional(value.requestedModel, (v)=>requireToken(v, "requestedModel"));
        optional(value.servedModel, (v)=>requireToken(v, "servedModel"));
        optional(value.quotaStatus, (v)=>requireEnum(v, "quotaStatus", [
            "limited",
            "unknown"
          ]));
        optional(value.telemetryAbsentReason, (v)=>requireEnum(v, "telemetryAbsentReason", [
            "agent_not_invoked",
            "provider_unsupported",
            "usage_not_reported"
          ]));
        if (value.models !== undefined) {
          if (!Array.isArray(value.models) || value.models.length > 128) {
            throw new LifecycleEventSchemaError("models", "must be a list of at most 128 model records");
          }
          for (const item of value.models){
            if (!isPlainObject(item)) {
              throw new LifecycleEventSchemaError("models", "must contain objects");
            }
            assertAllowedKeys(item, [
              "model",
              "role",
              "tokens",
              "pricing",
              "estimatedApiEquivalentUsd"
            ], "models");
            requireToken(item.model, "models.model");
            requireEnum(item.role, "models.role", [
              ...LIFECYCLE_ROLES,
              "sub-agent (unattributed)"
            ]);
            requireEnum(item.pricing, "models.pricing", [
              "known",
              "unknown"
            ]);
            validateTelemetry(item);
            if (!isPlainObject(item.tokens)) {
              throw new LifecycleEventSchemaError("models.tokens", "must be an object");
            }
            const counts = [
              "inputTokens",
              "outputTokens",
              "cacheCreationTokens",
              "cacheReadTokens"
            ];
            assertAllowedKeys(item.tokens, counts, "models.tokens");
            for (const field of counts){
              requireCount(item.tokens[field], `models.tokens.${field}`);
            }
          }
        }
        requireEnum(value.role, "role", LIFECYCLE_ROLES);
        optional(value.agent, (v)=>requireToken(v, "agent"));
        requirePositiveInteger(value.attempt, "attempt");
        requireToken(value.provider, "provider");
        optional(value.model, (v)=>requireToken(v, "model"));
        optional(value.effort, (v)=>requireToken(v, "effort"));
        optional(value.servedModels, (v)=>requireTokenList(v, "servedModels"));
        requireEnum(value.result, "result", [
          "success",
          "failure",
          "timeout",
          "usage_limited"
        ]);
        optional(value.durationSeconds, (v)=>requireNonNegativeNumber(v, "durationSeconds"));
        for (const field of [
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheCreationTokens"
        ]){
          optional(value[field], (v)=>requireCount(v, field));
        }
        optional(value.estimatedApiCostUsd, (v)=>requireNonNegativeNumber(v, "estimatedApiCostUsd"));
        return;
      }
    case "follow_on":
      validateTelemetry(value);
      optional(value.cycle, (v)=>requireToken(v, "cycle"));
      requireEnum(value.followOn, "followOn", [
        "retry",
        "ci_fix",
        "pr_feedback",
        "merge_conflict",
        "repair_pr"
      ]);
      requirePositiveInteger(value.attempt, "attempt");
      optional(value.prNumber, (v)=>requirePositiveInteger(v, "prNumber"));
      return;
    case "gate":
      requireToken(value.gate, "gate");
      requireEnum(value.result, "result", [
        "pass",
        "fail",
        "skipped"
      ]);
      requirePositiveInteger(value.attempt, "attempt");
      optional(value.prNumber, (v)=>requirePositiveInteger(v, "prNumber"));
      return;
    case "outcome":
      requireEnum(value.outcome, "outcome", [
        "pr_opened",
        "quality_green",
        "review_approved",
        "merged",
        "closed_unmerged",
        "pending",
        "censored",
        "failed",
        "timeout",
        "handed_off"
      ]);
      optional(value.prNumber, (v)=>requirePositiveInteger(v, "prNumber"));
      return;
  }
}
/**
 * Validate a value against the ledger's allowlist and return it as an event.
 *
 * This is the one gate every write and every read passes through. It refuses
 * any key the event kind does not name, and any value that is not a bounded
 * token, label, repo, UUID or timestamp of the right shape.
 *
 * @param value - The untrusted value to check.
 * @returns The same value, typed as a lifecycle event.
 * @throws {LifecycleEventSchemaError} When the value is refused.
 */ export function validateLifecycleEvent(value) {
  if (!isPlainObject(value)) {
    throw new LifecycleEventSchemaError("(root)", "must be an object");
  }
  if (value.schema !== LIFECYCLE_LEDGER_SCHEMA) {
    throw new LifecycleEventSchemaError("schema", "must be 1");
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !LIFECYCLE_EVENT_KINDS.includes(kind)) {
    throw new LifecycleEventSchemaError("kind", `must be one of ${LIFECYCLE_EVENT_KINDS.join(", ")}`);
  }
  const eventKind = kind;
  assertAllowedKeys(value, [
    ...BASE_KEYS,
    ...KIND_KEYS[eventKind]
  ], "");
  requireToken(value.host, "host");
  requireToken(value.runId, "runId");
  requirePattern(value.repo, "repo", REPO_PATTERN, "must be owner/name");
  if (eventKind === "invocation" || eventKind === "follow_on") {
    optional(value.issueNumber, (v)=>requirePositiveInteger(v, "issueNumber"));
  } else {
    requirePositiveInteger(value.issueNumber, "issueNumber");
  }
  requireTimestamp(value.recordedAt, "recordedAt");
  if (!(value.assignmentId === "unknown" && (eventKind === "invocation" || eventKind === "follow_on")) && !isValidAssignmentId(value.assignmentId)) {
    throw new LifecycleEventSchemaError("assignmentId", "must be a lowercase UUID");
  }
  validateKindFields(value, eventKind);
  if (typeof value.eventKey !== "string" || value.eventKey !== lifecycleEventKey(value)) {
    throw new LifecycleEventSchemaError("eventKey", "must equal the key derived from the event");
  }
  return value;
}
/**
 * Build a ledger event from a caller's input, deriving its key.
 *
 * The result is validated before it is returned, so an invalid input is
 * refused here, before anything is posted or written.
 *
 * @param input - The event, without `schema` and `eventKey`.
 * @returns The validated event.
 * @throws {LifecycleEventSchemaError} When the input is refused.
 */ export function buildLifecycleEvent(input) {
  const eventKey = lifecycleEventKey(input);
  return validateLifecycleEvent({
    schema: 1,
    ...input,
    eventKey
  });
}
/**
 * Serialise an event as one JSON line, without a trailing newline.
 *
 * @param event - The event to write.
 * @returns The JSON line.
 * @throws {LifecycleEventSchemaError} When the event is refused.
 */ export function serialiseLifecycleEvent(event) {
  return JSON.stringify(validateLifecycleEvent(event));
}
/**
 * Path to this host's lifecycle ledger inside `workDir`.
 *
 * The hostname is sanitised, so a hostname carrying a separator cannot
 * escape the ledger out of `workDir`.
 *
 * @param workDir - The worker's work directory.
 * @param hostname - The host whose ledger this is.
 * @returns The ledger path.
 */ export function lifecycleLedgerPath(workDir, hostname = getHostname()) {
  return `${workDir}/lifecycle_ledger_${sanitiseHostname(hostname)}.jsonl`;
}
/** Describe an unknown error without relying on its type. */ function causeMessage(cause) {
  return cause instanceof Error ? cause.message : String(cause);
}
/** Raised when an event cannot be appended to the ledger. */ export class LifecycleLedgerAppendError extends Error {
  path;
  constructor(path, cause){
    super(`Could not append to the lifecycle ledger ${path}: ${causeMessage(cause)}`, {
      cause
    });
    this.name = "LifecycleLedgerAppendError";
    this.path = path;
  }
}
/**
 * Append one event to the ledger.
 *
 * The writer is a plain append. Dedupe happens on read, so a replay after a
 * restart is harmless. The event is validated before anything is written, and
 * any write failure throws; nothing is swallowed.
 *
 * @param path - The ledger path.
 * @param event - The event to append.
 * @throws {LifecycleEventSchemaError} When the event is refused.
 * @throws {LifecycleLedgerAppendError} When the write fails.
 */ export async function appendLifecycleEvent(path, event) {
  const line = serialiseLifecycleEvent(event);
  try {
    await Deno.writeTextFile(path, line + "\n", {
      append: true,
      create: true
    });
  } catch (error) {
    throw new LifecycleLedgerAppendError(path, error);
  }
}
/**
 * Raised when a ledger cannot be read as a whole, or a line cannot be used.
 *
 * `line` is 1-based, and 0 when the whole file is unreadable. The detail
 * never echoes the raw line; it may only name the offending field.
 */ export class LifecycleLedgerReadError extends Error {
  path;
  line;
  reason;
  constructor(path, line, reason, detail){
    super(`Lifecycle ledger ${path} line ${line} is ${reason}: ${detail}`);
    this.name = "LifecycleLedgerReadError";
    this.path = path;
    this.line = line;
    this.reason = reason;
  }
}
/**
 * Read a ledger, validating every line and keeping the first of each event.
 *
 * A missing ledger is a legitimate empty result. Any other fault is refused
 * rather than skipped, so a damaged ledger cannot be mistaken for a short one.
 *
 * @param path - The ledger path.
 * @returns The distinct events, in first-seen order.
 * @throws {LifecycleLedgerReadError} When the ledger or a line is refused.
 */ export async function readLifecycleLedger(path) {
  // SIMPLE-ON-PURPOSE: reads the whole file into memory, fine to ~100,000 events — upgrade when a host's ledger exceeds tens of megabytes
  let text;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw new LifecycleLedgerReadError(path, 0, "unreadable", causeMessage(error));
  }
  const events = [];
  const seen = new Set();
  const lines = text.split("\n");
  for(let index = 0; index < lines.length; index++){
    const raw = lines[index] ?? "";
    if (raw.trim() === "") continue;
    const lineNumber = index + 1;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch  {
      throw new LifecycleLedgerReadError(path, lineNumber, "unparseable", "not valid JSON");
    }
    if (isPlainObject(parsed) && typeof parsed.schema === "number" && parsed.schema > LIFECYCLE_LEDGER_SCHEMA) {
      throw new LifecycleLedgerReadError(path, lineNumber, "future-schema", `schema ${parsed.schema} is newer than ${LIFECYCLE_LEDGER_SCHEMA}`);
    }
    let event;
    try {
      event = validateLifecycleEvent(parsed);
    } catch (error) {
      // validateLifecycleEvent only throws LifecycleEventSchemaError.
      throw new LifecycleLedgerReadError(path, lineNumber, "invalid", `field ${error.field} failed validation`);
    }
    if (seen.has(event.eventKey)) continue;
    seen.add(event.eventKey);
    events.push(event);
  }
  return events;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL2xpYi9saWZlY3ljbGVfbGVkZ2VyLnRzIl0sInNvdXJjZXNDb250ZW50IjpbIi8qKlxuICogQXBwZW5kLW9ubHkgcGVyLWhvc3QgbGlmZWN5Y2xlIGxlZGdlciAoSXNzdWUgIzM3MTgsIHBhcnQgb2YgIzM2NDQpLlxuICpcbiAqIEV2ZXJ5IGlzc3VlIGFzc2lnbm1lbnQsIGFnZW50IGludm9jYXRpb24sIGZvbGxvdy1vbiBydW4sIGdhdGUgcmVzdWx0IGFuZFxuICogb3V0Y29tZSBpcyByZWNvcmRlZCBhcyBvbmUgSlNPTiBsaW5lIGluIHRoaXMgaG9zdCdzIGxlZGdlcjpcbiAqXG4gKiAgIHt3b3JrRGlyfS9saWZlY3ljbGVfbGVkZ2VyX3tob3N0fS5qc29ubFxuICpcbiAqIFRoZSBob3N0bmFtZSByaWRlcyBpbiB0aGUgZmlsZW5hbWUsIG1hdGNoaW5nIGBmbGVldF90ZWxlbWV0cnlfc2lkZWNhci50c2AsXG4gKiBzbyBzZXZlcmFsIHdvcmtlcnMgc2hhcmluZyBhIHdvcmsgdm9sdW1lIGtlZXAgc2VwYXJhdGUgbGVkZ2VycyBpbnN0ZWFkIG9mXG4gKiBpbnRlcmxlYXZpbmcgb25lIGFub3RoZXIncyBsaW5lcy5cbiAqXG4gKiBUd28gcnVsZXMga2VlcCB0aGUgbGVkZ2VyIHNhZmUgdG8gcHVibGlzaCBhbmQgc2FmZSB0byByZXBsYXk6XG4gKlxuICogICAtICoqQWxsb3dsaXN0LCBub3QgZGVueWxpc3QuKioge0BsaW5rIHZhbGlkYXRlTGlmZWN5Y2xlRXZlbnR9IHJlZnVzZXMgYW55XG4gKiAgICAga2V5IHRoZSBraW5kIGRvZXMgbm90IG5hbWUsIGFuZCBhbnkgc3RyaW5nIHRoYXQgaXMgbm90IGEgYm91bmRlZCB0b2tlbixcbiAqICAgICBsYWJlbCwgcmVwbywgVVVJRCBvciB0aW1lc3RhbXAuIEEgcHJvbXB0IG9yIGFuIGlzc3VlIGJvZHkgaGFzIG5vIGtleSB0b1xuICogICAgIGJlIHN0b3JlZCB1bmRlciwgYW5kIGFuIGUtbWFpbCBhZGRyZXNzIG9yIG11bHRpLXdvcmQgcHJvc2UgZmFpbHMgZXZlcnlcbiAqICAgICB2YWx1ZSBwYXR0ZXJuLiBBIHNpbmdsZS10b2tlbiBzZWNyZXQgb3IgYSBiYXJlIGxvZ2luIGRvZXMgZml0IHRoZSB0b2tlblxuICogICAgIHBhdHRlcm4sIHNvIHRoZSBwYXR0ZXJucyBhbG9uZSBkbyBub3Qga2VlcCBvbmUgb3V0IG9mIGFuIGlkZW50aWZpZXJcbiAqICAgICBmaWVsZDsgdGhlIGFzc2lnbm1lbnQgd3JpdGVyIGZpbGxzIHRob3NlIGZpZWxkcyBmcm9tIHdvcmtlci1vd25lZFxuICogICAgIHNvdXJjZXMgKGhvc3QgbmFtZSwgcnVuIGlkLCBtb2RlbCByb3V0aW5nLCBidWlsZCBmYWN0cykuXG4gKiAgIC0gKipJZGVtcG90ZW50IGJ5IGtleS4qKiBFYWNoIGV2ZW50IGNhcnJpZXMgYSBkZXRlcm1pbmlzdGljIGBldmVudEtleWAuXG4gKiAgICAgVGhlIHdyaXRlciBpcyBhIHBsYWluIGFwcGVuZDsge0BsaW5rIHJlYWRMaWZlY3ljbGVMZWRnZXJ9IGRlZHVwZXMgb25cbiAqICAgICB0aGF0IGtleSwgc28gYSByZXBsYXkgYWZ0ZXIgYSByZXN0YXJ0IGlzIGhhcm1sZXNzLlxuICpcbiAqIFJlZnVzYWxzIG5hbWUgdGhlIG9mZmVuZGluZyBmaWVsZCBhbmQgdGhlIHJ1bGUgaXQgYnJva2UsIG5ldmVyIHRoZSB2YWx1ZSxcbiAqIHNvIGEgcmVmdXNlZCBzZWNyZXQgY2Fubm90IGxlYWsgaW50byBhIGxvZyBsaW5lLlxuICpcbiAqIEF1c3RyYWxpYW4gRW5nbGlzaCBzcGVsbGluZyB1c2VkIHRocm91Z2hvdXQuXG4gKi9cblxuaW1wb3J0IHR5cGUgeyBUZWxlbWV0cnlBYnNlbnRSZWFzb24gfSBmcm9tIFwiLi9ydW5fY2FsbGJhY2tzLnRzXCI7XG5pbXBvcnQgdHlwZSB7IFRva2VuVXNhZ2UgfSBmcm9tIFwiLi90b2tlbl91c2FnZS50c1wiO1xuXG5pbXBvcnQgeyBnZXRIb3N0bmFtZSB9IGZyb20gXCIuL3dvcmtlcl9pZGVudGl0eS50c1wiO1xuaW1wb3J0IHsgc2FuaXRpc2VIb3N0bmFtZSB9IGZyb20gXCIuL2ZsZWV0X3RlbGVtZXRyeV9zaWRlY2FyLnRzXCI7XG5cbi8qKiBMZWRnZXIgbGluZSBzY2hlbWEgdmVyc2lvbi4gQSBsaW5lIGNhcnJ5aW5nIGEgaGlnaGVyIG9uZSBpcyByZWZ1c2VkLiAqL1xuZXhwb3J0IGNvbnN0IExJRkVDWUNMRV9MRURHRVJfU0NIRU1BID0gMSBhcyBjb25zdDtcblxuLyoqIFRoZSBmaXZlIGtpbmRzIG9mIGxpZmVjeWNsZSBldmVudCB0aGUgbGVkZ2VyIHJlY29yZHMuICovXG5leHBvcnQgY29uc3QgTElGRUNZQ0xFX0VWRU5UX0tJTkRTID0gW1xuICBcImFzc2lnbm1lbnRcIixcbiAgXCJpbnZvY2F0aW9uXCIsXG4gIFwiZm9sbG93X29uXCIsXG4gIFwiZ2F0ZVwiLFxuICBcIm91dGNvbWVcIixcbl0gYXMgY29uc3Q7XG5cbi8qKiBPbmUgb2Yge0BsaW5rIExJRkVDWUNMRV9FVkVOVF9LSU5EU30uICovXG5leHBvcnQgdHlwZSBMaWZlY3ljbGVFdmVudEtpbmQgPSAodHlwZW9mIExJRkVDWUNMRV9FVkVOVF9LSU5EUylbbnVtYmVyXTtcblxuLyoqIFRoZSBhZ2VudCByb2xlcyBhbiBpbnZvY2F0aW9uIG9yIHRyZWF0bWVudCBjYW4gY2FycnkuICovXG5leHBvcnQgY29uc3QgTElGRUNZQ0xFX1JPTEVTID0gW1wibWFuYWdlclwiLCBcImV4ZWN1dG9yXCIsIFwicmV2aWV3ZXJcIl0gYXMgY29uc3Q7XG5cbi8qKiBPbmUgb2Yge0BsaW5rIExJRkVDWUNMRV9ST0xFU30uICovXG5leHBvcnQgdHlwZSBMaWZlY3ljbGVSb2xlID0gKHR5cGVvZiBMSUZFQ1lDTEVfUk9MRVMpW251bWJlcl07XG5cbi8qKiBUaGUgY29ob3J0IGFuIGFzc2lnbm1lbnQgY2FycmllcyB1bnRpbCBhbiBvcGVyYXRvciBsYWJlbHMgaXQuICovXG5leHBvcnQgY29uc3QgVU5BU1NJR05FRF9DT0hPUlQgPSBcInVuYXNzaWduZWRcIjtcblxuLyoqIFRoZSBhZ2VudCB0cmVhdG1lbnQgb25lIHJvbGUgcmFuIHVuZGVyLiAqL1xuZXhwb3J0IGludGVyZmFjZSBSb2xlVHJlYXRtZW50IHtcbiAgcm9sZTogTGlmZWN5Y2xlUm9sZTtcbiAgLyoqIFRoZSBDbGF1ZGUgc3ViLWFnZW50IG5hbWUsIHdoZW4gdGhlIHJvbGUgcmFuIGFzIG9uZS4gKi9cbiAgYWdlbnQ/OiBzdHJpbmc7XG4gIHByb3ZpZGVyOiBzdHJpbmc7XG4gIG1vZGVsPzogc3RyaW5nO1xuICBlZmZvcnQ/OiBzdHJpbmc7XG59XG5cbi8qKiBGaWVsZHMgZXZlcnkgbGVkZ2VyIGV2ZW50IGNhcnJpZXMuICovXG5pbnRlcmZhY2UgTGlmZWN5Y2xlRXZlbnRCYXNlIHtcbiAgc2NoZW1hOiB0eXBlb2YgTElGRUNZQ0xFX0xFREdFUl9TQ0hFTUE7XG4gIGV2ZW50S2V5OiBzdHJpbmc7XG4gIGFzc2lnbm1lbnRJZDogc3RyaW5nO1xuICBydW5JZDogc3RyaW5nO1xuICBob3N0OiBzdHJpbmc7XG4gIHJlcG86IHN0cmluZztcbiAgaXNzdWVOdW1iZXI/OiBudW1iZXI7XG4gIHJlY29yZGVkQXQ6IHN0cmluZztcbn1cblxuLyoqIFRoZSB0cmVhdG1lbnQgYW4gYXNzaWdubWVudCByZWNvcmRzLiAqL1xuZXhwb3J0IGludGVyZmFjZSBBc3NpZ25tZW50VHJlYXRtZW50IHtcbiAgcm9sZXM6IFJvbGVUcmVhdG1lbnRbXTtcbiAgd29ya2VyVmVyc2lvbj86IHN0cmluZztcbiAgd29ya2VyQ29tbWl0Pzogc3RyaW5nO1xuICAvKiogU0hBLTI1NiBvZiBhbGxvd2xpc3RlZCwgcmVzb2x2ZWQgcmV2aWV3LXBvbGljeSBzZXR0aW5ncyAoSXNzdWUgIzQ2NTgpLiAqL1xuICByZXZpZXdQb2xpY3lGaW5nZXJwcmludD86IHN0cmluZztcbiAgc3Vic2NyaXB0aW9uQWxsb2NhdGlvbj86IHN0cmluZztcbn1cblxuLyoqIEFuIGlzc3VlIGFzc2lnbm1lbnQ6IHdoaWNoIGNvaG9ydCB0aGUgaXNzdWUgYmVsb25ncyB0bywgYW5kIGl0cyB0cmVhdG1lbnQuICovXG5leHBvcnQgaW50ZXJmYWNlIEFzc2lnbm1lbnRFdmVudCBleHRlbmRzIExpZmVjeWNsZUV2ZW50QmFzZSB7XG4gIGtpbmQ6IFwiYXNzaWdubWVudFwiO1xuICBhc3NpZ25lZEF0OiBzdHJpbmc7XG4gIGNvaG9ydDogc3RyaW5nO1xuICByZXVzZWQ6IGJvb2xlYW47XG4gIHRyZWF0bWVudDogQXNzaWdubWVudFRyZWF0bWVudDtcbn1cblxuLyoqIFBlci1tb2RlbCBvYnNlcnZlZCB1c2FnZTsgYSBtb2RlbCBpcyBub3QgZXZpZGVuY2Ugb2YgYSBzdWItYWdlbnQncyByb2xlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBMaWZlY3ljbGVNb2RlbFVzYWdlIHtcbiAgbW9kZWw6IHN0cmluZztcbiAgcm9sZTogTGlmZWN5Y2xlUm9sZSB8IFwic3ViLWFnZW50ICh1bmF0dHJpYnV0ZWQpXCI7XG4gIHRva2VuczogVG9rZW5Vc2FnZTtcbiAgcHJpY2luZzogXCJrbm93blwiIHwgXCJ1bmtub3duXCI7XG4gIGVzdGltYXRlZEFwaUVxdWl2YWxlbnRVc2Q/OiBudW1iZXI7XG59XG5cbi8qKiBVbmtub3duIHVzYWdlIG9yIHByaWNpbmcgbmV2ZXIgY2FycmllcyBhbiBpbXBsaWVkIHplcm8tZG9sbGFyIGVzdGltYXRlLiAqL1xuZXhwb3J0IGludGVyZmFjZSBJbnZvY2F0aW9uVGVsZW1ldHJ5IHtcbiAgdXNhZ2U6IFwia25vd25cIiB8IFwidW5rbm93blwiO1xuICB0ZWxlbWV0cnlBYnNlbnRSZWFzb24/OiBUZWxlbWV0cnlBYnNlbnRSZWFzb247XG4gIHByaWNpbmc6IFwia25vd25cIiB8IFwidW5rbm93blwiO1xuICBlc3RpbWF0ZWRBcGlFcXVpdmFsZW50VXNkPzogbnVtYmVyO1xuICBtb2RlbHM/OiBMaWZlY3ljbGVNb2RlbFVzYWdlW107XG59XG5cbi8qKlxuICogT25lIGFnZW50IGludm9jYXRpb24uXG4gKlxuICogQW4gYWJzZW50IHRva2VuIG9yIGNvc3QgZmllbGQgbWVhbnMgVU5LTk9XTiwgbmV2ZXIgemVyby4gQSBwcm92aWRlciB0aGF0XG4gKiBkb2VzIG5vdCByZXBvcnQgdXNhZ2UgbGVhdmVzIHRoZSBmaWVsZCBvdXQsIHNvIGEgZGFzaGJvYXJkIGNhbiB0ZWxsIFwibm9cbiAqIHRva2VucyB3ZXJlIHNwZW50XCIgZnJvbSBcInRoZSBjb3VudCB3YXMgbm90IGNhcHR1cmVkXCIuXG4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgSW52b2NhdGlvbkV2ZW50IGV4dGVuZHMgTGlmZWN5Y2xlRXZlbnRCYXNlIHtcbiAga2luZDogXCJpbnZvY2F0aW9uXCI7XG4gIGludm9jYXRpb25JbmRleD86IG51bWJlcjtcbiAgcmVxdWVzdGVkTW9kZWw/OiBzdHJpbmc7XG4gIHNlcnZlZE1vZGVsPzogc3RyaW5nO1xuICB1c2FnZT86IEludm9jYXRpb25UZWxlbWV0cnlbXCJ1c2FnZVwiXTtcbiAgdGVsZW1ldHJ5QWJzZW50UmVhc29uPzogVGVsZW1ldHJ5QWJzZW50UmVhc29uO1xuICBwcmljaW5nPzogSW52b2NhdGlvblRlbGVtZXRyeVtcInByaWNpbmdcIl07XG4gIGVzdGltYXRlZEFwaUVxdWl2YWxlbnRVc2Q/OiBudW1iZXI7XG4gIG1vZGVscz86IExpZmVjeWNsZU1vZGVsVXNhZ2VbXTtcbiAgcXVvdGFTdGF0dXM/OiBcImxpbWl0ZWRcIiB8IFwidW5rbm93blwiO1xuICByb2xlOiBMaWZlY3ljbGVSb2xlO1xuICBhZ2VudD86IHN0cmluZztcbiAgYXR0ZW1wdDogbnVtYmVyO1xuICBwcm92aWRlcjogc3RyaW5nO1xuICBtb2RlbD86IHN0cmluZztcbiAgZWZmb3J0Pzogc3RyaW5nO1xuICBzZXJ2ZWRNb2RlbHM/OiBzdHJpbmdbXTtcbiAgcmVzdWx0OiBcInN1Y2Nlc3NcIiB8IFwiZmFpbHVyZVwiIHwgXCJ0aW1lb3V0XCIgfCBcInVzYWdlX2xpbWl0ZWRcIjtcbiAgZHVyYXRpb25TZWNvbmRzPzogbnVtYmVyO1xuICBpbnB1dFRva2Vucz86IG51bWJlcjtcbiAgb3V0cHV0VG9rZW5zPzogbnVtYmVyO1xuICBjYWNoZVJlYWRUb2tlbnM/OiBudW1iZXI7XG4gIGNhY2hlQ3JlYXRpb25Ub2tlbnM/OiBudW1iZXI7XG4gIGVzdGltYXRlZEFwaUNvc3RVc2Q/OiBudW1iZXI7XG59XG5cbi8qKiBBIGZvbGxvdy1vbiBydW4gc3RhcnRlZCBmcm9tIGFuIGVhcmxpZXIgb3V0Y29tZS4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgRm9sbG93T25FdmVudCBleHRlbmRzIExpZmVjeWNsZUV2ZW50QmFzZSB7XG4gIGtpbmQ6IFwiZm9sbG93X29uXCI7XG4gIGN5Y2xlPzogc3RyaW5nO1xuICB1c2FnZT86IEludm9jYXRpb25UZWxlbWV0cnlbXCJ1c2FnZVwiXTtcbiAgcHJpY2luZz86IEludm9jYXRpb25UZWxlbWV0cnlbXCJwcmljaW5nXCJdO1xuICBlc3RpbWF0ZWRBcGlFcXVpdmFsZW50VXNkPzogbnVtYmVyO1xuICBmb2xsb3dPbjogXCJyZXRyeVwiIHwgXCJjaV9maXhcIiB8IFwicHJfZmVlZGJhY2tcIiB8IFwibWVyZ2VfY29uZmxpY3RcIiB8IFwicmVwYWlyX3ByXCI7XG4gIGF0dGVtcHQ6IG51bWJlcjtcbiAgcHJOdW1iZXI/OiBudW1iZXI7XG59XG5cbi8qKiBPbmUgcXVhbGl0eSBnYXRlJ3MgcmVzdWx0LiAqL1xuZXhwb3J0IGludGVyZmFjZSBHYXRlRXZlbnQgZXh0ZW5kcyBMaWZlY3ljbGVFdmVudEJhc2Uge1xuICBraW5kOiBcImdhdGVcIjtcbiAgZ2F0ZTogc3RyaW5nO1xuICByZXN1bHQ6IFwicGFzc1wiIHwgXCJmYWlsXCIgfCBcInNraXBwZWRcIjtcbiAgYXR0ZW1wdDogbnVtYmVyO1xuICBwck51bWJlcj86IG51bWJlcjtcbn1cblxuLyoqIFRoZSBvdXRjb21lIG9mIGFuIGFzc2lnbm1lbnQsIG9yIG9mIG9uZSBQUiBpdCBwcm9kdWNlZC4gKi9cbmV4cG9ydCBpbnRlcmZhY2UgT3V0Y29tZUV2ZW50IGV4dGVuZHMgTGlmZWN5Y2xlRXZlbnRCYXNlIHtcbiAga2luZDogXCJvdXRjb21lXCI7XG4gIG91dGNvbWU6XG4gICAgfCBcInByX29wZW5lZFwiXG4gICAgfCBcInF1YWxpdHlfZ3JlZW5cIlxuICAgIHwgXCJyZXZpZXdfYXBwcm92ZWRcIlxuICAgIHwgXCJtZXJnZWRcIlxuICAgIHwgXCJjbG9zZWRfdW5tZXJnZWRcIlxuICAgIHwgXCJwZW5kaW5nXCJcbiAgICB8IFwiY2Vuc29yZWRcIlxuICAgIHwgXCJmYWlsZWRcIlxuICAgIHwgXCJ0aW1lb3V0XCJcbiAgICB8IFwiaGFuZGVkX29mZlwiO1xuICBwck51bWJlcj86IG51bWJlcjtcbn1cblxuLyoqIEFueSBldmVudCB0aGUgbGVkZ2VyIGNhbiBob2xkLiAqL1xuZXhwb3J0IHR5cGUgTGlmZWN5Y2xlRXZlbnQgPVxuICB8IEFzc2lnbm1lbnRFdmVudFxuICB8IEludm9jYXRpb25FdmVudFxuICB8IEZvbGxvd09uRXZlbnRcbiAgfCBHYXRlRXZlbnRcbiAgfCBPdXRjb21lRXZlbnQ7XG5cbi8qKiBEaXN0cmlidXRlcyBgT21pdGAgYWNyb3NzIGEgdW5pb24gc28gZWFjaCBtZW1iZXIga2VlcHMgaXRzIG93biBmaWVsZHMuICovXG50eXBlIERpc3RyaWJ1dGl2ZU9taXQ8VCwgSyBleHRlbmRzIFByb3BlcnR5S2V5PiA9IFQgZXh0ZW5kcyB1bmtub3duID8gT21pdDxULCBLPlxuICA6IG5ldmVyO1xuXG4vKiogQW4gZXZlbnQgYXMgYSBjYWxsZXIgYnVpbGRzIGl0LCBiZWZvcmUgdGhlIGtleSBpcyBkZXJpdmVkLiAqL1xuZXhwb3J0IHR5cGUgTGlmZWN5Y2xlRXZlbnRJbnB1dCA9IERpc3RyaWJ1dGl2ZU9taXQ8XG4gIExpZmVjeWNsZUV2ZW50LFxuICBcInNjaGVtYVwiIHwgXCJldmVudEtleVwiXG4+O1xuXG4vKipcbiAqIFRoZSBkZXRlcm1pbmlzdGljIGtleSB0aGF0IGlkZW50aWZpZXMgb25lIGV2ZW50LlxuICpcbiAqIFR3byBsaW5lcyB3aXRoIHRoZSBzYW1lIGtleSBkZXNjcmliZSB0aGUgc2FtZSBmYWN0LCBzbyB0aGUgcmVhZGVyIGtlZXBzXG4gKiBvbmx5IHRoZSBmaXJzdC4gQSBQUiBvdXRjb21lIGlzIGtleWVkIGJ5IGl0cyBQUiBudW1iZXIgYW5kIG5vdCBpdHMgcnVuLCBzb1xuICogYSBQUiBjb3VudHMgb25jZSBob3dldmVyIG1hbnkgcnVucyBvciBob3N0cyBvYnNlcnZlIGl0LlxuICpcbiAqIEBwYXJhbSBldmVudCAtIFRoZSBldmVudCwgYmVmb3JlIG9yIGFmdGVyIGl0cyBrZXkgaXMgYXR0YWNoZWQuXG4gKiBAcmV0dXJucyBUaGUga2V5LlxuICovXG5leHBvcnQgZnVuY3Rpb24gbGlmZWN5Y2xlRXZlbnRLZXkoXG4gIGV2ZW50OiBMaWZlY3ljbGVFdmVudElucHV0IHwgTGlmZWN5Y2xlRXZlbnQsXG4pOiBzdHJpbmcge1xuICBzd2l0Y2ggKGV2ZW50LmtpbmQpIHtcbiAgICBjYXNlIFwiYXNzaWdubWVudFwiOlxuICAgICAgcmV0dXJuIGBhc3NpZ25tZW50OiR7ZXZlbnQuYXNzaWdubWVudElkfToke2V2ZW50Lmhvc3R9YDtcbiAgICBjYXNlIFwiaW52b2NhdGlvblwiOlxuICAgICAgaWYgKGV2ZW50Lmludm9jYXRpb25JbmRleCAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiBgaW52b2NhdGlvbjoke2V2ZW50LmFzc2lnbm1lbnRJZH06JHtldmVudC5ydW5JZH06JHtldmVudC5pbnZvY2F0aW9uSW5kZXh9YDtcbiAgICAgIH1cbiAgICAgIHJldHVybiBgaW52b2NhdGlvbjoke2V2ZW50LmFzc2lnbm1lbnRJZH06JHtldmVudC5ydW5JZH06JHtldmVudC5yb2xlfTpgICtcbiAgICAgICAgYCR7ZXZlbnQuYWdlbnQgPz8gXCItXCJ9OiR7ZXZlbnQuYXR0ZW1wdH1gO1xuICAgIGNhc2UgXCJmb2xsb3dfb25cIjpcbiAgICAgIGlmIChldmVudC5jeWNsZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgICAgIHJldHVybiBgZm9sbG93X29uOiR7ZXZlbnQuYXNzaWdubWVudElkfToke2V2ZW50LnJlcG99OiR7ZXZlbnQucHJOdW1iZXJ9OiR7ZXZlbnQuZm9sbG93T259OiR7ZXZlbnQuY3ljbGV9OiR7ZXZlbnQuYXR0ZW1wdH1gO1xuICAgICAgfVxuICAgICAgcmV0dXJuIGBmb2xsb3dfb246JHtldmVudC5hc3NpZ25tZW50SWR9OiR7ZXZlbnQucnVuSWR9OmAgK1xuICAgICAgICBgJHtldmVudC5mb2xsb3dPbn06JHtldmVudC5wck51bWJlciA/PyBcIi1cIn06JHtldmVudC5hdHRlbXB0fWA7XG4gICAgY2FzZSBcImdhdGVcIjpcbiAgICAgIHJldHVybiBgZ2F0ZToke2V2ZW50LmFzc2lnbm1lbnRJZH06JHtldmVudC5ydW5JZH06JHtldmVudC5nYXRlfTpgICtcbiAgICAgICAgYCR7ZXZlbnQuYXR0ZW1wdH1gO1xuICAgIGNhc2UgXCJvdXRjb21lXCI6XG4gICAgICByZXR1cm4gZXZlbnQucHJOdW1iZXIgIT09IHVuZGVmaW5lZFxuICAgICAgICA/IGBvdXRjb21lOiR7ZXZlbnQuYXNzaWdubWVudElkfToke2V2ZW50Lm91dGNvbWV9OnByLSR7ZXZlbnQucHJOdW1iZXJ9YFxuICAgICAgICA6IGBvdXRjb21lOiR7ZXZlbnQuYXNzaWdubWVudElkfToke2V2ZW50Lm91dGNvbWV9OnJ1bi0ke2V2ZW50LnJ1bklkfWA7XG4gIH1cbn1cblxuLyoqXG4gKiBSYWlzZWQgd2hlbiBhIHZhbHVlIGlzIHJlZnVzZWQgYnkgdGhlIGxlZGdlcidzIGFsbG93bGlzdC5cbiAqXG4gKiBgZmllbGRgIG5hbWVzIHRoZSBvZmZlbmRpbmcga2V5IG9yIGZpZWxkLiBUaGUgbWVzc2FnZSBuZXZlciBjYXJyaWVzIHRoZVxuICogdmFsdWUgaXRzZWxmLlxuICovXG5leHBvcnQgY2xhc3MgTGlmZWN5Y2xlRXZlbnRTY2hlbWFFcnJvciBleHRlbmRzIEVycm9yIHtcbiAgcmVhZG9ubHkgZmllbGQ6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihmaWVsZDogc3RyaW5nLCByZWFzb246IHN0cmluZykge1xuICAgIHN1cGVyKGBMaWZlY3ljbGUgZXZlbnQgZmllbGQgJHtmaWVsZH0gaXMgaW52YWxpZDogJHtyZWFzb259YCk7XG4gICAgdGhpcy5uYW1lID0gXCJMaWZlY3ljbGVFdmVudFNjaGVtYUVycm9yXCI7XG4gICAgdGhpcy5maWVsZCA9IGZpZWxkO1xuICB9XG59XG5cbi8qKiBLZXlzIGV2ZXJ5IGV2ZW50IG1heSBjYXJyeS4gQW55dGhpbmcgZWxzZSBpcyByZWZ1c2VkLiAqL1xuY29uc3QgQkFTRV9LRVlTOiByZWFkb25seSBzdHJpbmdbXSA9IFtcbiAgXCJzY2hlbWFcIixcbiAgXCJraW5kXCIsXG4gIFwiZXZlbnRLZXlcIixcbiAgXCJhc3NpZ25tZW50SWRcIixcbiAgXCJydW5JZFwiLFxuICBcImhvc3RcIixcbiAgXCJyZXBvXCIsXG4gIFwiaXNzdWVOdW1iZXJcIixcbiAgXCJyZWNvcmRlZEF0XCIsXG5dO1xuXG4vKiogS2V5cyBlYWNoIGtpbmQgbWF5IGNhcnJ5IGJleW9uZCB0aGUgYmFzZSBrZXlzLiAqL1xuY29uc3QgS0lORF9LRVlTOiBSZWFkb25seTxSZWNvcmQ8TGlmZWN5Y2xlRXZlbnRLaW5kLCByZWFkb25seSBzdHJpbmdbXT4+ID0ge1xuICBhc3NpZ25tZW50OiBbXCJhc3NpZ25lZEF0XCIsIFwiY29ob3J0XCIsIFwicmV1c2VkXCIsIFwidHJlYXRtZW50XCJdLFxuICBpbnZvY2F0aW9uOiBbXG4gICAgXCJpbnZvY2F0aW9uSW5kZXhcIixcbiAgICBcInJlcXVlc3RlZE1vZGVsXCIsXG4gICAgXCJzZXJ2ZWRNb2RlbFwiLFxuICAgIFwidXNhZ2VcIixcbiAgICBcInRlbGVtZXRyeUFic2VudFJlYXNvblwiLFxuICAgIFwicHJpY2luZ1wiLFxuICAgIFwiZXN0aW1hdGVkQXBpRXF1aXZhbGVudFVzZFwiLFxuICAgIFwibW9kZWxzXCIsXG4gICAgXCJxdW90YVN0YXR1c1wiLFxuICAgIFwicm9sZVwiLFxuICAgIFwiYWdlbnRcIixcbiAgICBcImF0dGVtcHRcIixcbiAgICBcInByb3ZpZGVyXCIsXG4gICAgXCJtb2RlbFwiLFxuICAgIFwiZWZmb3J0XCIsXG4gICAgXCJzZXJ2ZWRNb2RlbHNcIixcbiAgICBcInJlc3VsdFwiLFxuICAgIFwiZHVyYXRpb25TZWNvbmRzXCIsXG4gICAgXCJpbnB1dFRva2Vuc1wiLFxuICAgIFwib3V0cHV0VG9rZW5zXCIsXG4gICAgXCJjYWNoZVJlYWRUb2tlbnNcIixcbiAgICBcImNhY2hlQ3JlYXRpb25Ub2tlbnNcIixcbiAgICBcImVzdGltYXRlZEFwaUNvc3RVc2RcIixcbiAgXSxcbiAgZm9sbG93X29uOiBbXG4gICAgXCJmb2xsb3dPblwiLFxuICAgIFwiYXR0ZW1wdFwiLFxuICAgIFwicHJOdW1iZXJcIixcbiAgICBcImN5Y2xlXCIsXG4gICAgXCJ1c2FnZVwiLFxuICAgIFwicHJpY2luZ1wiLFxuICAgIFwiZXN0aW1hdGVkQXBpRXF1aXZhbGVudFVzZFwiLFxuICBdLFxuICBnYXRlOiBbXCJnYXRlXCIsIFwicmVzdWx0XCIsIFwiYXR0ZW1wdFwiLCBcInByTnVtYmVyXCJdLFxuICBvdXRjb21lOiBbXCJvdXRjb21lXCIsIFwicHJOdW1iZXJcIl0sXG59O1xuXG4vKiogS2V5cyBhIHRyZWF0bWVudCBtYXkgY2FycnkuICovXG5jb25zdCBUUkVBVE1FTlRfS0VZUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwicm9sZXNcIixcbiAgXCJ3b3JrZXJWZXJzaW9uXCIsXG4gIFwid29ya2VyQ29tbWl0XCIsXG4gIFwicmV2aWV3UG9saWN5RmluZ2VycHJpbnRcIixcbiAgXCJzdWJzY3JpcHRpb25BbGxvY2F0aW9uXCIsXG5dO1xuXG4vKiogS2V5cyBvbmUgcm9sZSB0cmVhdG1lbnQgbWF5IGNhcnJ5LiAqL1xuY29uc3QgUk9MRV9UUkVBVE1FTlRfS0VZUzogcmVhZG9ubHkgc3RyaW5nW10gPSBbXG4gIFwicm9sZVwiLFxuICBcImFnZW50XCIsXG4gIFwicHJvdmlkZXJcIixcbiAgXCJtb2RlbFwiLFxuICBcImVmZm9ydFwiLFxuXTtcblxuLyoqXG4gKiBUaGUgc2hhcGUgb2YgYSB0b2tlbjogYSBwcm92aWRlciwgbW9kZWwsIGVmZm9ydCwgYWdlbnQsIGhvc3QsIHJ1biBpZCwgZ2F0ZVxuICogb3IgdmVyc2lvbi4gTm8gYEBgLCBubyB3aGl0ZXNwYWNlLCBzbyBhbiBlLW1haWwgYWRkcmVzcyBvciBtdWx0aS13b3JkIHByb3NlXG4gKiBpcyByZWZ1c2VkOyBhIHNpbmdsZS10b2tlbiBzZWNyZXQgb3IgYSBiYXJlIGxvZ2luIGlzIG5vdCByZWNvZ25pc2VkLlxuICogQm91bmRlZCwgd2l0aCBubyBvdmVybGFwcGluZyBxdWFudGlmaWVycywgYmVjYXVzZSBpdCBydW5zIG9uIGFnZW50IGFuZFxuICogb3BlcmF0b3IgdGV4dC5cbiAqL1xuY29uc3QgVE9LRU5fUEFUVEVSTiA9IC9eW0EtWmEtejAtOV1bQS1aYS16MC05Ll86LytcXFtcXF0tXXswLDEyN30kLztcblxuLyoqIEEgR2l0SHViIGBvd25lci9uYW1lYCByZXBvc2l0b3J5LiAqL1xuY29uc3QgUkVQT19QQVRURVJOID0gL15bQS1aYS16MC05XVtBLVphLXowLTkuXy1dezAsOTl9XFwvW0EtWmEtejAtOS5fLV17MSwxMDB9JC87XG5cbi8qKiBBIGxvd2VyY2FzZSBVVUlELCB0aGUgZm9ybSB7QGxpbmsgQXNzaWdubWVudEV2ZW50fSBpZGVudGlmaWVzIGl0c2VsZiBieS4gKi9cbmNvbnN0IEFTU0lHTk1FTlRfSURfUEFUVEVSTiA9XG4gIC9eWzAtOWEtZl17OH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17NH0tWzAtOWEtZl17MTJ9JC87XG5cbi8qKiBBIGNvaG9ydCBvciBzdWJzY3JpcHRpb24gbGFiZWw6IGxvd2VyY2FzZSwgZG90dGVkIG9yIGRhc2hlZCwgYm91bmRlZC4gKi9cbmNvbnN0IExBQkVMX1BBVFRFUk4gPSAvXlthLXowLTldW2EtejAtOS5fLV17MCw2M30kLztcblxuLyoqIEFuIElTTy04NjAxIFVUQyB0aW1lc3RhbXAsIHRvIGF0IG1vc3QgbWlsbGlzZWNvbmQgcHJlY2lzaW9uLiAqL1xuY29uc3QgVElNRVNUQU1QX1BBVFRFUk4gPVxuICAvXlxcZHs0fS1cXGR7Mn0tXFxkezJ9VFxcZHsyfTpcXGR7Mn06XFxkezJ9KD86XFwuXFxkezEsM30pP1okLztcblxuLyoqXG4gKiBXaGV0aGVyIGB2YWx1ZWAgaXMgYSBwbGFpbiBvYmplY3QgKGEgSlNPTiBvYmplY3QsIG5vdCBhbiBhcnJheSBvciBjbGFzcykuXG4gKlxuICogRXhwb3J0ZWQgc28gdGhlIGFzc2lnbm1lbnQgbW9kdWxlIHJlYWRzIEpTT04gdGhyb3VnaCB0aGUgc2FtZSBndWFyZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzUGxhaW5PYmplY3QoXG4gIHZhbHVlOiB1bmtub3duLFxuKTogdmFsdWUgaXMgUmVjb3JkPHN0cmluZywgdW5rbm93bj4ge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm9iamVjdFwiIHx8IHZhbHVlID09PSBudWxsIHx8IEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGNvbnN0IHByb3RvID0gT2JqZWN0LmdldFByb3RvdHlwZU9mKHZhbHVlKTtcbiAgcmV0dXJuIHByb3RvID09PSBPYmplY3QucHJvdG90eXBlIHx8IHByb3RvID09PSBudWxsO1xufVxuXG4vKiogV2hldGhlciBgdmFsdWVgIGlzIGEgVVVJRCB0aGUgbGVkZ2VyIGFjY2VwdHMgYXMgYW4gYXNzaWdubWVudCBpZC4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ZhbGlkQXNzaWdubWVudElkKHZhbHVlOiB1bmtub3duKTogdmFsdWUgaXMgc3RyaW5nIHtcbiAgcmV0dXJuIHR5cGVvZiB2YWx1ZSA9PT0gXCJzdHJpbmdcIiAmJiBBU1NJR05NRU5UX0lEX1BBVFRFUk4udGVzdCh2YWx1ZSk7XG59XG5cbi8qKiBXaGV0aGVyIGB2YWx1ZWAgaXMgYSBjb2hvcnQgb3Igc3Vic2NyaXB0aW9uIGxhYmVsIHRoZSBsZWRnZXIgYWNjZXB0cy4gKi9cbmV4cG9ydCBmdW5jdGlvbiBpc1ZhbGlkTGlmZWN5Y2xlTGFiZWwodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBzdHJpbmcge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmIExBQkVMX1BBVFRFUk4udGVzdCh2YWx1ZSk7XG59XG5cbi8qKiBXaGV0aGVyIGB2YWx1ZWAgaXMgYSB0aW1lc3RhbXAgdGhlIGxlZGdlciBhY2NlcHRzLiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGlzVmFsaWRMaWZlY3ljbGVUaW1lc3RhbXAodmFsdWU6IHVua25vd24pOiB2YWx1ZSBpcyBzdHJpbmcge1xuICByZXR1cm4gdHlwZW9mIHZhbHVlID09PSBcInN0cmluZ1wiICYmIFRJTUVTVEFNUF9QQVRURVJOLnRlc3QodmFsdWUpICYmXG4gICAgIU51bWJlci5pc05hTihEYXRlLnBhcnNlKHZhbHVlKSk7XG59XG5cbi8qKiBSZWZ1c2UgYSBrZXkgdGhlIGFsbG93bGlzdCBkb2VzIG5vdCBuYW1lLiAqL1xuZnVuY3Rpb24gYXNzZXJ0QWxsb3dlZEtleXMoXG4gIHZhbHVlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPixcbiAgYWxsb3dlZDogcmVhZG9ubHkgc3RyaW5nW10sXG4gIHByZWZpeDogc3RyaW5nLFxuKTogdm9pZCB7XG4gIGZvciAoY29uc3Qga2V5IG9mIE9iamVjdC5rZXlzKHZhbHVlKSkge1xuICAgIGlmICghYWxsb3dlZC5pbmNsdWRlcyhrZXkpKSB7XG4gICAgICB0aHJvdyBuZXcgTGlmZWN5Y2xlRXZlbnRTY2hlbWFFcnJvcihcbiAgICAgICAgYCR7cHJlZml4fSR7a2V5fWAsXG4gICAgICAgIFwia2V5IGlzIG5vdCBvbiB0aGUgYWxsb3dsaXN0XCIsXG4gICAgICApO1xuICAgIH1cbiAgfVxufVxuXG4vKiogUmVmdXNlIGEgc3RyaW5nIHRoYXQgZG9lcyBub3QgbWF0Y2ggYHBhdHRlcm5gLiAqL1xuZnVuY3Rpb24gcmVxdWlyZVBhdHRlcm4oXG4gIHZhbHVlOiB1bmtub3duLFxuICBmaWVsZDogc3RyaW5nLFxuICBwYXR0ZXJuOiBSZWdFeHAsXG4gIHJ1bGU6IHN0cmluZyxcbik6IHN0cmluZyB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIXBhdHRlcm4udGVzdCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgTGlmZWN5Y2xlRXZlbnRTY2hlbWFFcnJvcihmaWVsZCwgcnVsZSk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKiogUmVmdXNlIGEgdmFsdWUgdGhhdCBpcyBub3Qgb25lIG9mIGBhbGxvd2VkYC4gKi9cbmZ1bmN0aW9uIHJlcXVpcmVFbnVtPFQgZXh0ZW5kcyBzdHJpbmc+KFxuICB2YWx1ZTogdW5rbm93bixcbiAgZmllbGQ6IHN0cmluZyxcbiAgYWxsb3dlZDogcmVhZG9ubHkgVFtdLFxuKTogVCB7XG4gIGlmIChcbiAgICB0eXBlb2YgdmFsdWUgIT09IFwic3RyaW5nXCIgfHwgIShhbGxvd2VkIGFzIHJlYWRvbmx5IHN0cmluZ1tdKS5pbmNsdWRlcyh2YWx1ZSlcbiAgKSB7XG4gICAgdGhyb3cgbmV3IExpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3IoXG4gICAgICBmaWVsZCxcbiAgICAgIGBtdXN0IGJlIG9uZSBvZiAke2FsbG93ZWQuam9pbihcIiwgXCIpfWAsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gdmFsdWUgYXMgVDtcbn1cblxuLyoqIFJlZnVzZSBhIHZhbHVlIHRoYXQgaXMgbm90IGEgcG9zaXRpdmUgc2FmZSBpbnRlZ2VyLiAqL1xuZnVuY3Rpb24gcmVxdWlyZVBvc2l0aXZlSW50ZWdlcih2YWx1ZTogdW5rbm93biwgZmllbGQ6IHN0cmluZyk6IG51bWJlciB7XG4gIGlmICh0eXBlb2YgdmFsdWUgIT09IFwibnVtYmVyXCIgfHwgIU51bWJlci5pc1NhZmVJbnRlZ2VyKHZhbHVlKSB8fCB2YWx1ZSA8PSAwKSB7XG4gICAgdGhyb3cgbmV3IExpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3IoZmllbGQsIFwibXVzdCBiZSBhIHBvc2l0aXZlIGludGVnZXJcIik7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKiogUmVmdXNlIGEgdmFsdWUgdGhhdCBpcyBub3QgYSBub24tbmVnYXRpdmUgc2FmZSBpbnRlZ2VyLiAqL1xuZnVuY3Rpb24gcmVxdWlyZUNvdW50KHZhbHVlOiB1bmtub3duLCBmaWVsZDogc3RyaW5nKTogbnVtYmVyIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJudW1iZXJcIiB8fCAhTnVtYmVyLmlzU2FmZUludGVnZXIodmFsdWUpIHx8IHZhbHVlIDwgMCkge1xuICAgIHRocm93IG5ldyBMaWZlY3ljbGVFdmVudFNjaGVtYUVycm9yKFxuICAgICAgZmllbGQsXG4gICAgICBcIm11c3QgYmUgYSBub24tbmVnYXRpdmUgaW50ZWdlclwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKiogUmVmdXNlIGEgdmFsdWUgdGhhdCBpcyBub3QgYSBmaW5pdGUsIG5vbi1uZWdhdGl2ZSBudW1iZXIuICovXG5mdW5jdGlvbiByZXF1aXJlTm9uTmVnYXRpdmVOdW1iZXIodmFsdWU6IHVua25vd24sIGZpZWxkOiBzdHJpbmcpOiBudW1iZXIge1xuICBpZiAodHlwZW9mIHZhbHVlICE9PSBcIm51bWJlclwiIHx8ICFOdW1iZXIuaXNGaW5pdGUodmFsdWUpIHx8IHZhbHVlIDwgMCkge1xuICAgIHRocm93IG5ldyBMaWZlY3ljbGVFdmVudFNjaGVtYUVycm9yKGZpZWxkLCBcIm11c3QgYmUgYSBmaW5pdGUgbnVtYmVyID49IDBcIik7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKiogUmVmdXNlIGEgdmFsdWUgdGhhdCBpcyBub3QgYSBib29sZWFuLiAqL1xuZnVuY3Rpb24gcmVxdWlyZUJvb2xlYW4odmFsdWU6IHVua25vd24sIGZpZWxkOiBzdHJpbmcpOiBib29sZWFuIHtcbiAgaWYgKHR5cGVvZiB2YWx1ZSAhPT0gXCJib29sZWFuXCIpIHtcbiAgICB0aHJvdyBuZXcgTGlmZWN5Y2xlRXZlbnRTY2hlbWFFcnJvcihmaWVsZCwgXCJtdXN0IGJlIGEgYm9vbGVhblwiKTtcbiAgfVxuICByZXR1cm4gdmFsdWU7XG59XG5cbi8qKiBSZWZ1c2UgYSB2YWx1ZSB0aGF0IGlzIG5vdCBhIHRpbWVzdGFtcCB0aGUgbGVkZ2VyIGFjY2VwdHMuICovXG5mdW5jdGlvbiByZXF1aXJlVGltZXN0YW1wKHZhbHVlOiB1bmtub3duLCBmaWVsZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFpc1ZhbGlkTGlmZWN5Y2xlVGltZXN0YW1wKHZhbHVlKSkge1xuICAgIHRocm93IG5ldyBMaWZlY3ljbGVFdmVudFNjaGVtYUVycm9yKFxuICAgICAgZmllbGQsXG4gICAgICBcIm11c3QgYmUgYW4gSVNPLTg2MDEgVVRDIHRpbWVzdGFtcFwiLFxuICAgICk7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKiogUmVmdXNlIGEgdmFsdWUgdGhhdCBpcyBub3QgYSB0b2tlbi4gKi9cbmZ1bmN0aW9uIHJlcXVpcmVUb2tlbih2YWx1ZTogdW5rbm93biwgZmllbGQ6IHN0cmluZyk6IHN0cmluZyB7XG4gIHJldHVybiByZXF1aXJlUGF0dGVybih2YWx1ZSwgZmllbGQsIFRPS0VOX1BBVFRFUk4sIFwibXVzdCBiZSBhIGJvdW5kZWQgdG9rZW5cIik7XG59XG5cbi8qKiBSZWZ1c2UgYSB2YWx1ZSB0aGF0IGlzIG5vdCBhIGxhYmVsLiAqL1xuZnVuY3Rpb24gcmVxdWlyZUxhYmVsKHZhbHVlOiB1bmtub3duLCBmaWVsZDogc3RyaW5nKTogc3RyaW5nIHtcbiAgaWYgKCFpc1ZhbGlkTGlmZWN5Y2xlTGFiZWwodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IExpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3IoZmllbGQsIFwibXVzdCBiZSBhIGJvdW5kZWQgbGFiZWxcIik7XG4gIH1cbiAgcmV0dXJuIHZhbHVlO1xufVxuXG4vKiogUmVmdXNlIGEgdmFsdWUgdGhhdCBpcyBub3QgYSBgc3RyaW5nW11gIG9mIHRva2Vucy4gKi9cbmZ1bmN0aW9uIHJlcXVpcmVUb2tlbkxpc3QodmFsdWU6IHVua25vd24sIGZpZWxkOiBzdHJpbmcpOiBzdHJpbmdbXSB7XG4gIGlmICghQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgTGlmZWN5Y2xlRXZlbnRTY2hlbWFFcnJvcihmaWVsZCwgXCJtdXN0IGJlIGFuIGFycmF5XCIpO1xuICB9XG4gIHJldHVybiB2YWx1ZS5tYXAoKGl0ZW0sIGluZGV4KSA9PiByZXF1aXJlVG9rZW4oaXRlbSwgYCR7ZmllbGR9WyR7aW5kZXh9XWApKTtcbn1cblxuLyoqIFJlYWQgYW4gb3B0aW9uYWwgZmllbGQ6IGFic2VudCBvciBgdW5kZWZpbmVkYCBpcyBubyB2YWx1ZS4gKi9cbmZ1bmN0aW9uIG9wdGlvbmFsPFQ+KFxuICB2YWx1ZTogdW5rbm93bixcbiAgY2hlY2s6ICh2YWx1ZTogdW5rbm93bikgPT4gVCxcbik6IFQgfCB1bmRlZmluZWQge1xuICByZXR1cm4gdmFsdWUgPT09IHVuZGVmaW5lZCA/IHVuZGVmaW5lZCA6IGNoZWNrKHZhbHVlKTtcbn1cblxuLyoqIFZhbGlkYXRlIG9uZSByb2xlIHRyZWF0bWVudCBhZ2FpbnN0IGl0cyBhbGxvd2xpc3QuICovXG5mdW5jdGlvbiB2YWxpZGF0ZVJvbGVUcmVhdG1lbnQodmFsdWU6IHVua25vd24sIGluZGV4OiBudW1iZXIpOiBSb2xlVHJlYXRtZW50IHtcbiAgY29uc3QgZmllbGQgPSBgdHJlYXRtZW50LnJvbGVzWyR7aW5kZXh9XWA7XG4gIGlmICghaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICB0aHJvdyBuZXcgTGlmZWN5Y2xlRXZlbnRTY2hlbWFFcnJvcihmaWVsZCwgXCJtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgfVxuICBhc3NlcnRBbGxvd2VkS2V5cyh2YWx1ZSwgUk9MRV9UUkVBVE1FTlRfS0VZUywgXCJ0cmVhdG1lbnQucm9sZXNbXS5cIik7XG4gIGNvbnN0IHJvbGUgPSByZXF1aXJlRW51bSh2YWx1ZS5yb2xlLCBgJHtmaWVsZH0ucm9sZWAsIExJRkVDWUNMRV9ST0xFUyk7XG4gIGNvbnN0IHByb3ZpZGVyID0gcmVxdWlyZVRva2VuKHZhbHVlLnByb3ZpZGVyLCBgJHtmaWVsZH0ucHJvdmlkZXJgKTtcbiAgY29uc3QgYWdlbnQgPSBvcHRpb25hbCh2YWx1ZS5hZ2VudCwgKHYpID0+IHJlcXVpcmVUb2tlbih2LCBgJHtmaWVsZH0uYWdlbnRgKSk7XG4gIGNvbnN0IG1vZGVsID0gb3B0aW9uYWwodmFsdWUubW9kZWwsICh2KSA9PiByZXF1aXJlVG9rZW4odiwgYCR7ZmllbGR9Lm1vZGVsYCkpO1xuICBjb25zdCBlZmZvcnQgPSBvcHRpb25hbChcbiAgICB2YWx1ZS5lZmZvcnQsXG4gICAgKHYpID0+IHJlcXVpcmVUb2tlbih2LCBgJHtmaWVsZH0uZWZmb3J0YCksXG4gICk7XG4gIHJldHVybiB7XG4gICAgcm9sZSxcbiAgICBwcm92aWRlcixcbiAgICAuLi4oYWdlbnQgIT09IHVuZGVmaW5lZCA/IHsgYWdlbnQgfSA6IHt9KSxcbiAgICAuLi4obW9kZWwgIT09IHVuZGVmaW5lZCA/IHsgbW9kZWwgfSA6IHt9KSxcbiAgICAuLi4oZWZmb3J0ICE9PSB1bmRlZmluZWQgPyB7IGVmZm9ydCB9IDoge30pLFxuICB9O1xufVxuXG4vKiogVmFsaWRhdGUgYW4gYXNzaWdubWVudCdzIHRyZWF0bWVudCBhZ2FpbnN0IGl0cyBhbGxvd2xpc3QuICovXG5mdW5jdGlvbiB2YWxpZGF0ZVRyZWF0bWVudCh2YWx1ZTogdW5rbm93bik6IEFzc2lnbm1lbnRUcmVhdG1lbnQge1xuICBpZiAoIWlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IExpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3IoXCJ0cmVhdG1lbnRcIiwgXCJtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgfVxuICBhc3NlcnRBbGxvd2VkS2V5cyh2YWx1ZSwgVFJFQVRNRU5UX0tFWVMsIFwidHJlYXRtZW50LlwiKTtcbiAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlLnJvbGVzKSB8fCB2YWx1ZS5yb2xlcy5sZW5ndGggPT09IDApIHtcbiAgICB0aHJvdyBuZXcgTGlmZWN5Y2xlRXZlbnRTY2hlbWFFcnJvcihcbiAgICAgIFwidHJlYXRtZW50LnJvbGVzXCIsXG4gICAgICBcIm11c3QgYmUgYSBub24tZW1wdHkgYXJyYXlcIixcbiAgICApO1xuICB9XG4gIGNvbnN0IHJvbGVzID0gdmFsdWUucm9sZXMubWFwKChpdGVtLCBpbmRleCkgPT5cbiAgICB2YWxpZGF0ZVJvbGVUcmVhdG1lbnQoaXRlbSwgaW5kZXgpXG4gICk7XG4gIGNvbnN0IHdvcmtlclZlcnNpb24gPSBvcHRpb25hbChcbiAgICB2YWx1ZS53b3JrZXJWZXJzaW9uLFxuICAgICh2KSA9PiByZXF1aXJlVG9rZW4odiwgXCJ0cmVhdG1lbnQud29ya2VyVmVyc2lvblwiKSxcbiAgKTtcbiAgY29uc3Qgd29ya2VyQ29tbWl0ID0gb3B0aW9uYWwoXG4gICAgdmFsdWUud29ya2VyQ29tbWl0LFxuICAgICh2KSA9PiByZXF1aXJlVG9rZW4odiwgXCJ0cmVhdG1lbnQud29ya2VyQ29tbWl0XCIpLFxuICApO1xuICBjb25zdCByZXZpZXdQb2xpY3lGaW5nZXJwcmludCA9IG9wdGlvbmFsKFxuICAgIHZhbHVlLnJldmlld1BvbGljeUZpbmdlcnByaW50LFxuICAgICh2KSA9PiB7XG4gICAgICBpZiAodHlwZW9mIHYgIT09IFwic3RyaW5nXCIgfHwgIS9eWzAtOWEtZl17NjR9JC8udGVzdCh2KSkge1xuICAgICAgICB0aHJvdyBuZXcgTGlmZWN5Y2xlRXZlbnRTY2hlbWFFcnJvcihcbiAgICAgICAgICBcInRyZWF0bWVudC5yZXZpZXdQb2xpY3lGaW5nZXJwcmludFwiLFxuICAgICAgICAgIFwibXVzdCBiZSBhIFNIQS0yNTYgZmluZ2VycHJpbnRcIixcbiAgICAgICAgKTtcbiAgICAgIH1cbiAgICAgIHJldHVybiB2O1xuICAgIH0sXG4gICk7XG4gIGNvbnN0IHN1YnNjcmlwdGlvbkFsbG9jYXRpb24gPSBvcHRpb25hbChcbiAgICB2YWx1ZS5zdWJzY3JpcHRpb25BbGxvY2F0aW9uLFxuICAgICh2KSA9PiByZXF1aXJlTGFiZWwodiwgXCJ0cmVhdG1lbnQuc3Vic2NyaXB0aW9uQWxsb2NhdGlvblwiKSxcbiAgKTtcbiAgcmV0dXJuIHtcbiAgICByb2xlcyxcbiAgICAuLi4od29ya2VyVmVyc2lvbiAhPT0gdW5kZWZpbmVkID8geyB3b3JrZXJWZXJzaW9uIH0gOiB7fSksXG4gICAgLi4uKHdvcmtlckNvbW1pdCAhPT0gdW5kZWZpbmVkID8geyB3b3JrZXJDb21taXQgfSA6IHt9KSxcbiAgICAuLi4ocmV2aWV3UG9saWN5RmluZ2VycHJpbnQgIT09IHVuZGVmaW5lZFxuICAgICAgPyB7IHJldmlld1BvbGljeUZpbmdlcnByaW50IH1cbiAgICAgIDoge30pLFxuICAgIC4uLihzdWJzY3JpcHRpb25BbGxvY2F0aW9uICE9PSB1bmRlZmluZWQgPyB7IHN1YnNjcmlwdGlvbkFsbG9jYXRpb24gfSA6IHt9KSxcbiAgfTtcbn1cblxuLyoqIFZhbGlkYXRlIHRoZSBvcHRpb25hbCB0ZWxlbWV0cnkgZXh0ZW5zaW9uLCBpbmNsdWRpbmcgZXZlcnkgbmVzdGVkIGtleS4gKi9cbmZ1bmN0aW9uIHZhbGlkYXRlVGVsZW1ldHJ5KHZhbHVlOiBSZWNvcmQ8c3RyaW5nLCB1bmtub3duPik6IHZvaWQge1xuICBvcHRpb25hbCh2YWx1ZS51c2FnZSwgKHYpID0+IHJlcXVpcmVFbnVtKHYsIFwidXNhZ2VcIiwgW1wia25vd25cIiwgXCJ1bmtub3duXCJdKSk7XG4gIG9wdGlvbmFsKFxuICAgIHZhbHVlLnByaWNpbmcsXG4gICAgKHYpID0+IHJlcXVpcmVFbnVtKHYsIFwicHJpY2luZ1wiLCBbXCJrbm93blwiLCBcInVua25vd25cIl0pLFxuICApO1xuICBvcHRpb25hbChcbiAgICB2YWx1ZS5lc3RpbWF0ZWRBcGlFcXVpdmFsZW50VXNkLFxuICAgICh2KSA9PiByZXF1aXJlTm9uTmVnYXRpdmVOdW1iZXIodiwgXCJlc3RpbWF0ZWRBcGlFcXVpdmFsZW50VXNkXCIpLFxuICApO1xuICBpZiAoXG4gICAgKHZhbHVlLnVzYWdlID09PSBcInVua25vd25cIiB8fCB2YWx1ZS5wcmljaW5nID09PSBcInVua25vd25cIikgJiZcbiAgICB2YWx1ZS5lc3RpbWF0ZWRBcGlFcXVpdmFsZW50VXNkICE9PSB1bmRlZmluZWRcbiAgKSB7XG4gICAgdGhyb3cgbmV3IExpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3IoXG4gICAgICBcImVzdGltYXRlZEFwaUVxdWl2YWxlbnRVc2RcIixcbiAgICAgIFwibXVzdCBiZSBhYnNlbnQgd2hlbiB1c2FnZSBvciBwcmljaW5nIGlzIHVua25vd25cIixcbiAgICApO1xuICB9XG59XG5cbi8qKiBWYWxpZGF0ZSB0aGUga2luZC1zcGVjaWZpYyBmaWVsZHMgb2YgYW4gZXZlbnQsIGFmdGVyIHRoZSBiYXNlIGZpZWxkcy4gKi9cbmZ1bmN0aW9uIHZhbGlkYXRlS2luZEZpZWxkcyhcbiAgdmFsdWU6IFJlY29yZDxzdHJpbmcsIHVua25vd24+LFxuICBraW5kOiBMaWZlY3ljbGVFdmVudEtpbmQsXG4pOiB2b2lkIHtcbiAgc3dpdGNoIChraW5kKSB7XG4gICAgY2FzZSBcImFzc2lnbm1lbnRcIjpcbiAgICAgIHJlcXVpcmVUaW1lc3RhbXAodmFsdWUuYXNzaWduZWRBdCwgXCJhc3NpZ25lZEF0XCIpO1xuICAgICAgcmVxdWlyZUxhYmVsKHZhbHVlLmNvaG9ydCwgXCJjb2hvcnRcIik7XG4gICAgICByZXF1aXJlQm9vbGVhbih2YWx1ZS5yZXVzZWQsIFwicmV1c2VkXCIpO1xuICAgICAgdmFsaWRhdGVUcmVhdG1lbnQodmFsdWUudHJlYXRtZW50KTtcbiAgICAgIHJldHVybjtcbiAgICBjYXNlIFwiaW52b2NhdGlvblwiOiB7XG4gICAgICB2YWxpZGF0ZVRlbGVtZXRyeSh2YWx1ZSk7XG4gICAgICBvcHRpb25hbChcbiAgICAgICAgdmFsdWUuaW52b2NhdGlvbkluZGV4LFxuICAgICAgICAodikgPT4gcmVxdWlyZVBvc2l0aXZlSW50ZWdlcih2LCBcImludm9jYXRpb25JbmRleFwiKSxcbiAgICAgICk7XG4gICAgICBvcHRpb25hbCh2YWx1ZS5yZXF1ZXN0ZWRNb2RlbCwgKHYpID0+IHJlcXVpcmVUb2tlbih2LCBcInJlcXVlc3RlZE1vZGVsXCIpKTtcbiAgICAgIG9wdGlvbmFsKHZhbHVlLnNlcnZlZE1vZGVsLCAodikgPT4gcmVxdWlyZVRva2VuKHYsIFwic2VydmVkTW9kZWxcIikpO1xuICAgICAgb3B0aW9uYWwoXG4gICAgICAgIHZhbHVlLnF1b3RhU3RhdHVzLFxuICAgICAgICAodikgPT4gcmVxdWlyZUVudW0odiwgXCJxdW90YVN0YXR1c1wiLCBbXCJsaW1pdGVkXCIsIFwidW5rbm93blwiXSksXG4gICAgICApO1xuICAgICAgb3B0aW9uYWwoXG4gICAgICAgIHZhbHVlLnRlbGVtZXRyeUFic2VudFJlYXNvbixcbiAgICAgICAgKHYpID0+XG4gICAgICAgICAgcmVxdWlyZUVudW0odiwgXCJ0ZWxlbWV0cnlBYnNlbnRSZWFzb25cIiwgW1xuICAgICAgICAgICAgXCJhZ2VudF9ub3RfaW52b2tlZFwiLFxuICAgICAgICAgICAgXCJwcm92aWRlcl91bnN1cHBvcnRlZFwiLFxuICAgICAgICAgICAgXCJ1c2FnZV9ub3RfcmVwb3J0ZWRcIixcbiAgICAgICAgICBdKSxcbiAgICAgICk7XG4gICAgICBpZiAodmFsdWUubW9kZWxzICE9PSB1bmRlZmluZWQpIHtcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHZhbHVlLm1vZGVscykgfHwgdmFsdWUubW9kZWxzLmxlbmd0aCA+IDEyOCkge1xuICAgICAgICAgIHRocm93IG5ldyBMaWZlY3ljbGVFdmVudFNjaGVtYUVycm9yKFxuICAgICAgICAgICAgXCJtb2RlbHNcIixcbiAgICAgICAgICAgIFwibXVzdCBiZSBhIGxpc3Qgb2YgYXQgbW9zdCAxMjggbW9kZWwgcmVjb3Jkc1wiLFxuICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICAgICAgZm9yIChjb25zdCBpdGVtIG9mIHZhbHVlLm1vZGVscykge1xuICAgICAgICAgIGlmICghaXNQbGFpbk9iamVjdChpdGVtKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IExpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3IoXG4gICAgICAgICAgICAgIFwibW9kZWxzXCIsXG4gICAgICAgICAgICAgIFwibXVzdCBjb250YWluIG9iamVjdHNcIixcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgfVxuICAgICAgICAgIGFzc2VydEFsbG93ZWRLZXlzKGl0ZW0sIFtcbiAgICAgICAgICAgIFwibW9kZWxcIixcbiAgICAgICAgICAgIFwicm9sZVwiLFxuICAgICAgICAgICAgXCJ0b2tlbnNcIixcbiAgICAgICAgICAgIFwicHJpY2luZ1wiLFxuICAgICAgICAgICAgXCJlc3RpbWF0ZWRBcGlFcXVpdmFsZW50VXNkXCIsXG4gICAgICAgICAgXSwgXCJtb2RlbHNcIik7XG4gICAgICAgICAgcmVxdWlyZVRva2VuKGl0ZW0ubW9kZWwsIFwibW9kZWxzLm1vZGVsXCIpO1xuICAgICAgICAgIHJlcXVpcmVFbnVtKGl0ZW0ucm9sZSwgXCJtb2RlbHMucm9sZVwiLCBbXG4gICAgICAgICAgICAuLi5MSUZFQ1lDTEVfUk9MRVMsXG4gICAgICAgICAgICBcInN1Yi1hZ2VudCAodW5hdHRyaWJ1dGVkKVwiLFxuICAgICAgICAgIF0pO1xuICAgICAgICAgIHJlcXVpcmVFbnVtKGl0ZW0ucHJpY2luZywgXCJtb2RlbHMucHJpY2luZ1wiLCBbXCJrbm93blwiLCBcInVua25vd25cIl0pO1xuICAgICAgICAgIHZhbGlkYXRlVGVsZW1ldHJ5KGl0ZW0pO1xuICAgICAgICAgIGlmICghaXNQbGFpbk9iamVjdChpdGVtLnRva2VucykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBMaWZlY3ljbGVFdmVudFNjaGVtYUVycm9yKFxuICAgICAgICAgICAgICBcIm1vZGVscy50b2tlbnNcIixcbiAgICAgICAgICAgICAgXCJtdXN0IGJlIGFuIG9iamVjdFwiLFxuICAgICAgICAgICAgKTtcbiAgICAgICAgICB9XG4gICAgICAgICAgY29uc3QgY291bnRzID0gW1xuICAgICAgICAgICAgXCJpbnB1dFRva2Vuc1wiLFxuICAgICAgICAgICAgXCJvdXRwdXRUb2tlbnNcIixcbiAgICAgICAgICAgIFwiY2FjaGVDcmVhdGlvblRva2Vuc1wiLFxuICAgICAgICAgICAgXCJjYWNoZVJlYWRUb2tlbnNcIixcbiAgICAgICAgICBdO1xuICAgICAgICAgIGFzc2VydEFsbG93ZWRLZXlzKGl0ZW0udG9rZW5zLCBjb3VudHMsIFwibW9kZWxzLnRva2Vuc1wiKTtcbiAgICAgICAgICBmb3IgKGNvbnN0IGZpZWxkIG9mIGNvdW50cykge1xuICAgICAgICAgICAgcmVxdWlyZUNvdW50KGl0ZW0udG9rZW5zW2ZpZWxkXSwgYG1vZGVscy50b2tlbnMuJHtmaWVsZH1gKTtcbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIHJlcXVpcmVFbnVtKHZhbHVlLnJvbGUsIFwicm9sZVwiLCBMSUZFQ1lDTEVfUk9MRVMpO1xuICAgICAgb3B0aW9uYWwodmFsdWUuYWdlbnQsICh2KSA9PiByZXF1aXJlVG9rZW4odiwgXCJhZ2VudFwiKSk7XG4gICAgICByZXF1aXJlUG9zaXRpdmVJbnRlZ2VyKHZhbHVlLmF0dGVtcHQsIFwiYXR0ZW1wdFwiKTtcbiAgICAgIHJlcXVpcmVUb2tlbih2YWx1ZS5wcm92aWRlciwgXCJwcm92aWRlclwiKTtcbiAgICAgIG9wdGlvbmFsKHZhbHVlLm1vZGVsLCAodikgPT4gcmVxdWlyZVRva2VuKHYsIFwibW9kZWxcIikpO1xuICAgICAgb3B0aW9uYWwodmFsdWUuZWZmb3J0LCAodikgPT4gcmVxdWlyZVRva2VuKHYsIFwiZWZmb3J0XCIpKTtcbiAgICAgIG9wdGlvbmFsKHZhbHVlLnNlcnZlZE1vZGVscywgKHYpID0+IHJlcXVpcmVUb2tlbkxpc3QodiwgXCJzZXJ2ZWRNb2RlbHNcIikpO1xuICAgICAgcmVxdWlyZUVudW0odmFsdWUucmVzdWx0LCBcInJlc3VsdFwiLCBbXG4gICAgICAgIFwic3VjY2Vzc1wiLFxuICAgICAgICBcImZhaWx1cmVcIixcbiAgICAgICAgXCJ0aW1lb3V0XCIsXG4gICAgICAgIFwidXNhZ2VfbGltaXRlZFwiLFxuICAgICAgXSk7XG4gICAgICBvcHRpb25hbChcbiAgICAgICAgdmFsdWUuZHVyYXRpb25TZWNvbmRzLFxuICAgICAgICAodikgPT4gcmVxdWlyZU5vbk5lZ2F0aXZlTnVtYmVyKHYsIFwiZHVyYXRpb25TZWNvbmRzXCIpLFxuICAgICAgKTtcbiAgICAgIGZvciAoXG4gICAgICAgIGNvbnN0IGZpZWxkIG9mIFtcbiAgICAgICAgICBcImlucHV0VG9rZW5zXCIsXG4gICAgICAgICAgXCJvdXRwdXRUb2tlbnNcIixcbiAgICAgICAgICBcImNhY2hlUmVhZFRva2Vuc1wiLFxuICAgICAgICAgIFwiY2FjaGVDcmVhdGlvblRva2Vuc1wiLFxuICAgICAgICBdIGFzIGNvbnN0XG4gICAgICApIHtcbiAgICAgICAgb3B0aW9uYWwodmFsdWVbZmllbGRdLCAodikgPT4gcmVxdWlyZUNvdW50KHYsIGZpZWxkKSk7XG4gICAgICB9XG4gICAgICBvcHRpb25hbChcbiAgICAgICAgdmFsdWUuZXN0aW1hdGVkQXBpQ29zdFVzZCxcbiAgICAgICAgKHYpID0+IHJlcXVpcmVOb25OZWdhdGl2ZU51bWJlcih2LCBcImVzdGltYXRlZEFwaUNvc3RVc2RcIiksXG4gICAgICApO1xuICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBjYXNlIFwiZm9sbG93X29uXCI6XG4gICAgICB2YWxpZGF0ZVRlbGVtZXRyeSh2YWx1ZSk7XG4gICAgICBvcHRpb25hbCh2YWx1ZS5jeWNsZSwgKHYpID0+IHJlcXVpcmVUb2tlbih2LCBcImN5Y2xlXCIpKTtcbiAgICAgIHJlcXVpcmVFbnVtKHZhbHVlLmZvbGxvd09uLCBcImZvbGxvd09uXCIsIFtcbiAgICAgICAgXCJyZXRyeVwiLFxuICAgICAgICBcImNpX2ZpeFwiLFxuICAgICAgICBcInByX2ZlZWRiYWNrXCIsXG4gICAgICAgIFwibWVyZ2VfY29uZmxpY3RcIixcbiAgICAgICAgXCJyZXBhaXJfcHJcIixcbiAgICAgIF0pO1xuICAgICAgcmVxdWlyZVBvc2l0aXZlSW50ZWdlcih2YWx1ZS5hdHRlbXB0LCBcImF0dGVtcHRcIik7XG4gICAgICBvcHRpb25hbCh2YWx1ZS5wck51bWJlciwgKHYpID0+IHJlcXVpcmVQb3NpdGl2ZUludGVnZXIodiwgXCJwck51bWJlclwiKSk7XG4gICAgICByZXR1cm47XG4gICAgY2FzZSBcImdhdGVcIjpcbiAgICAgIHJlcXVpcmVUb2tlbih2YWx1ZS5nYXRlLCBcImdhdGVcIik7XG4gICAgICByZXF1aXJlRW51bSh2YWx1ZS5yZXN1bHQsIFwicmVzdWx0XCIsIFtcInBhc3NcIiwgXCJmYWlsXCIsIFwic2tpcHBlZFwiXSk7XG4gICAgICByZXF1aXJlUG9zaXRpdmVJbnRlZ2VyKHZhbHVlLmF0dGVtcHQsIFwiYXR0ZW1wdFwiKTtcbiAgICAgIG9wdGlvbmFsKHZhbHVlLnByTnVtYmVyLCAodikgPT4gcmVxdWlyZVBvc2l0aXZlSW50ZWdlcih2LCBcInByTnVtYmVyXCIpKTtcbiAgICAgIHJldHVybjtcbiAgICBjYXNlIFwib3V0Y29tZVwiOlxuICAgICAgcmVxdWlyZUVudW0odmFsdWUub3V0Y29tZSwgXCJvdXRjb21lXCIsIFtcbiAgICAgICAgXCJwcl9vcGVuZWRcIixcbiAgICAgICAgXCJxdWFsaXR5X2dyZWVuXCIsXG4gICAgICAgIFwicmV2aWV3X2FwcHJvdmVkXCIsXG4gICAgICAgIFwibWVyZ2VkXCIsXG4gICAgICAgIFwiY2xvc2VkX3VubWVyZ2VkXCIsXG4gICAgICAgIFwicGVuZGluZ1wiLFxuICAgICAgICBcImNlbnNvcmVkXCIsXG4gICAgICAgIFwiZmFpbGVkXCIsXG4gICAgICAgIFwidGltZW91dFwiLFxuICAgICAgICBcImhhbmRlZF9vZmZcIixcbiAgICAgIF0pO1xuICAgICAgb3B0aW9uYWwodmFsdWUucHJOdW1iZXIsICh2KSA9PiByZXF1aXJlUG9zaXRpdmVJbnRlZ2VyKHYsIFwicHJOdW1iZXJcIikpO1xuICAgICAgcmV0dXJuO1xuICB9XG59XG5cbi8qKlxuICogVmFsaWRhdGUgYSB2YWx1ZSBhZ2FpbnN0IHRoZSBsZWRnZXIncyBhbGxvd2xpc3QgYW5kIHJldHVybiBpdCBhcyBhbiBldmVudC5cbiAqXG4gKiBUaGlzIGlzIHRoZSBvbmUgZ2F0ZSBldmVyeSB3cml0ZSBhbmQgZXZlcnkgcmVhZCBwYXNzZXMgdGhyb3VnaC4gSXQgcmVmdXNlc1xuICogYW55IGtleSB0aGUgZXZlbnQga2luZCBkb2VzIG5vdCBuYW1lLCBhbmQgYW55IHZhbHVlIHRoYXQgaXMgbm90IGEgYm91bmRlZFxuICogdG9rZW4sIGxhYmVsLCByZXBvLCBVVUlEIG9yIHRpbWVzdGFtcCBvZiB0aGUgcmlnaHQgc2hhcGUuXG4gKlxuICogQHBhcmFtIHZhbHVlIC0gVGhlIHVudHJ1c3RlZCB2YWx1ZSB0byBjaGVjay5cbiAqIEByZXR1cm5zIFRoZSBzYW1lIHZhbHVlLCB0eXBlZCBhcyBhIGxpZmVjeWNsZSBldmVudC5cbiAqIEB0aHJvd3Mge0xpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3J9IFdoZW4gdGhlIHZhbHVlIGlzIHJlZnVzZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiB2YWxpZGF0ZUxpZmVjeWNsZUV2ZW50KHZhbHVlOiB1bmtub3duKTogTGlmZWN5Y2xlRXZlbnQge1xuICBpZiAoIWlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgdGhyb3cgbmV3IExpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3IoXCIocm9vdClcIiwgXCJtdXN0IGJlIGFuIG9iamVjdFwiKTtcbiAgfVxuICBpZiAodmFsdWUuc2NoZW1hICE9PSBMSUZFQ1lDTEVfTEVER0VSX1NDSEVNQSkge1xuICAgIHRocm93IG5ldyBMaWZlY3ljbGVFdmVudFNjaGVtYUVycm9yKFwic2NoZW1hXCIsIFwibXVzdCBiZSAxXCIpO1xuICB9XG4gIGNvbnN0IGtpbmQgPSB2YWx1ZS5raW5kO1xuICBpZiAoXG4gICAgdHlwZW9mIGtpbmQgIT09IFwic3RyaW5nXCIgfHxcbiAgICAhKExJRkVDWUNMRV9FVkVOVF9LSU5EUyBhcyByZWFkb25seSBzdHJpbmdbXSkuaW5jbHVkZXMoa2luZClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IExpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3IoXG4gICAgICBcImtpbmRcIixcbiAgICAgIGBtdXN0IGJlIG9uZSBvZiAke0xJRkVDWUNMRV9FVkVOVF9LSU5EUy5qb2luKFwiLCBcIil9YCxcbiAgICApO1xuICB9XG4gIGNvbnN0IGV2ZW50S2luZCA9IGtpbmQgYXMgTGlmZWN5Y2xlRXZlbnRLaW5kO1xuICBhc3NlcnRBbGxvd2VkS2V5cyh2YWx1ZSwgWy4uLkJBU0VfS0VZUywgLi4uS0lORF9LRVlTW2V2ZW50S2luZF1dLCBcIlwiKTtcblxuICByZXF1aXJlVG9rZW4odmFsdWUuaG9zdCwgXCJob3N0XCIpO1xuICByZXF1aXJlVG9rZW4odmFsdWUucnVuSWQsIFwicnVuSWRcIik7XG4gIHJlcXVpcmVQYXR0ZXJuKHZhbHVlLnJlcG8sIFwicmVwb1wiLCBSRVBPX1BBVFRFUk4sIFwibXVzdCBiZSBvd25lci9uYW1lXCIpO1xuICBpZiAoZXZlbnRLaW5kID09PSBcImludm9jYXRpb25cIiB8fCBldmVudEtpbmQgPT09IFwiZm9sbG93X29uXCIpIHtcbiAgICBvcHRpb25hbChcbiAgICAgIHZhbHVlLmlzc3VlTnVtYmVyLFxuICAgICAgKHYpID0+IHJlcXVpcmVQb3NpdGl2ZUludGVnZXIodiwgXCJpc3N1ZU51bWJlclwiKSxcbiAgICApO1xuICB9IGVsc2Uge1xuICAgIHJlcXVpcmVQb3NpdGl2ZUludGVnZXIodmFsdWUuaXNzdWVOdW1iZXIsIFwiaXNzdWVOdW1iZXJcIik7XG4gIH1cbiAgcmVxdWlyZVRpbWVzdGFtcCh2YWx1ZS5yZWNvcmRlZEF0LCBcInJlY29yZGVkQXRcIik7XG4gIGlmIChcbiAgICAhKHZhbHVlLmFzc2lnbm1lbnRJZCA9PT0gXCJ1bmtub3duXCIgJiZcbiAgICAgIChldmVudEtpbmQgPT09IFwiaW52b2NhdGlvblwiIHx8IGV2ZW50S2luZCA9PT0gXCJmb2xsb3dfb25cIikpICYmXG4gICAgIWlzVmFsaWRBc3NpZ25tZW50SWQodmFsdWUuYXNzaWdubWVudElkKVxuICApIHtcbiAgICB0aHJvdyBuZXcgTGlmZWN5Y2xlRXZlbnRTY2hlbWFFcnJvcihcbiAgICAgIFwiYXNzaWdubWVudElkXCIsXG4gICAgICBcIm11c3QgYmUgYSBsb3dlcmNhc2UgVVVJRFwiLFxuICAgICk7XG4gIH1cbiAgdmFsaWRhdGVLaW5kRmllbGRzKHZhbHVlLCBldmVudEtpbmQpO1xuXG4gIGlmIChcbiAgICB0eXBlb2YgdmFsdWUuZXZlbnRLZXkgIT09IFwic3RyaW5nXCIgfHxcbiAgICB2YWx1ZS5ldmVudEtleSAhPT0gbGlmZWN5Y2xlRXZlbnRLZXkodmFsdWUgYXMgdW5rbm93biBhcyBMaWZlY3ljbGVFdmVudClcbiAgKSB7XG4gICAgdGhyb3cgbmV3IExpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3IoXG4gICAgICBcImV2ZW50S2V5XCIsXG4gICAgICBcIm11c3QgZXF1YWwgdGhlIGtleSBkZXJpdmVkIGZyb20gdGhlIGV2ZW50XCIsXG4gICAgKTtcbiAgfVxuICByZXR1cm4gdmFsdWUgYXMgdW5rbm93biBhcyBMaWZlY3ljbGVFdmVudDtcbn1cblxuLyoqXG4gKiBCdWlsZCBhIGxlZGdlciBldmVudCBmcm9tIGEgY2FsbGVyJ3MgaW5wdXQsIGRlcml2aW5nIGl0cyBrZXkuXG4gKlxuICogVGhlIHJlc3VsdCBpcyB2YWxpZGF0ZWQgYmVmb3JlIGl0IGlzIHJldHVybmVkLCBzbyBhbiBpbnZhbGlkIGlucHV0IGlzXG4gKiByZWZ1c2VkIGhlcmUsIGJlZm9yZSBhbnl0aGluZyBpcyBwb3N0ZWQgb3Igd3JpdHRlbi5cbiAqXG4gKiBAcGFyYW0gaW5wdXQgLSBUaGUgZXZlbnQsIHdpdGhvdXQgYHNjaGVtYWAgYW5kIGBldmVudEtleWAuXG4gKiBAcmV0dXJucyBUaGUgdmFsaWRhdGVkIGV2ZW50LlxuICogQHRocm93cyB7TGlmZWN5Y2xlRXZlbnRTY2hlbWFFcnJvcn0gV2hlbiB0aGUgaW5wdXQgaXMgcmVmdXNlZC5cbiAqL1xuZXhwb3J0IGZ1bmN0aW9uIGJ1aWxkTGlmZWN5Y2xlRXZlbnQoXG4gIGlucHV0OiBMaWZlY3ljbGVFdmVudElucHV0LFxuKTogTGlmZWN5Y2xlRXZlbnQge1xuICBjb25zdCBldmVudEtleSA9IGxpZmVjeWNsZUV2ZW50S2V5KGlucHV0KTtcbiAgcmV0dXJuIHZhbGlkYXRlTGlmZWN5Y2xlRXZlbnQoeyBzY2hlbWE6IDEsIC4uLmlucHV0LCBldmVudEtleSB9KTtcbn1cblxuLyoqXG4gKiBTZXJpYWxpc2UgYW4gZXZlbnQgYXMgb25lIEpTT04gbGluZSwgd2l0aG91dCBhIHRyYWlsaW5nIG5ld2xpbmUuXG4gKlxuICogQHBhcmFtIGV2ZW50IC0gVGhlIGV2ZW50IHRvIHdyaXRlLlxuICogQHJldHVybnMgVGhlIEpTT04gbGluZS5cbiAqIEB0aHJvd3Mge0xpZmVjeWNsZUV2ZW50U2NoZW1hRXJyb3J9IFdoZW4gdGhlIGV2ZW50IGlzIHJlZnVzZWQuXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBzZXJpYWxpc2VMaWZlY3ljbGVFdmVudChldmVudDogTGlmZWN5Y2xlRXZlbnQpOiBzdHJpbmcge1xuICByZXR1cm4gSlNPTi5zdHJpbmdpZnkodmFsaWRhdGVMaWZlY3ljbGVFdmVudChldmVudCkpO1xufVxuXG4vKipcbiAqIFBhdGggdG8gdGhpcyBob3N0J3MgbGlmZWN5Y2xlIGxlZGdlciBpbnNpZGUgYHdvcmtEaXJgLlxuICpcbiAqIFRoZSBob3N0bmFtZSBpcyBzYW5pdGlzZWQsIHNvIGEgaG9zdG5hbWUgY2FycnlpbmcgYSBzZXBhcmF0b3IgY2Fubm90XG4gKiBlc2NhcGUgdGhlIGxlZGdlciBvdXQgb2YgYHdvcmtEaXJgLlxuICpcbiAqIEBwYXJhbSB3b3JrRGlyIC0gVGhlIHdvcmtlcidzIHdvcmsgZGlyZWN0b3J5LlxuICogQHBhcmFtIGhvc3RuYW1lIC0gVGhlIGhvc3Qgd2hvc2UgbGVkZ2VyIHRoaXMgaXMuXG4gKiBAcmV0dXJucyBUaGUgbGVkZ2VyIHBhdGguXG4gKi9cbmV4cG9ydCBmdW5jdGlvbiBsaWZlY3ljbGVMZWRnZXJQYXRoKFxuICB3b3JrRGlyOiBzdHJpbmcsXG4gIGhvc3RuYW1lOiBzdHJpbmcgPSBnZXRIb3N0bmFtZSgpLFxuKTogc3RyaW5nIHtcbiAgcmV0dXJuIGAke3dvcmtEaXJ9L2xpZmVjeWNsZV9sZWRnZXJfJHtzYW5pdGlzZUhvc3RuYW1lKGhvc3RuYW1lKX0uanNvbmxgO1xufVxuXG4vKiogRGVzY3JpYmUgYW4gdW5rbm93biBlcnJvciB3aXRob3V0IHJlbHlpbmcgb24gaXRzIHR5cGUuICovXG5mdW5jdGlvbiBjYXVzZU1lc3NhZ2UoY2F1c2U6IHVua25vd24pOiBzdHJpbmcge1xuICByZXR1cm4gY2F1c2UgaW5zdGFuY2VvZiBFcnJvciA/IGNhdXNlLm1lc3NhZ2UgOiBTdHJpbmcoY2F1c2UpO1xufVxuXG4vKiogUmFpc2VkIHdoZW4gYW4gZXZlbnQgY2Fubm90IGJlIGFwcGVuZGVkIHRvIHRoZSBsZWRnZXIuICovXG5leHBvcnQgY2xhc3MgTGlmZWN5Y2xlTGVkZ2VyQXBwZW5kRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IHBhdGg6IHN0cmluZztcblxuICBjb25zdHJ1Y3RvcihwYXRoOiBzdHJpbmcsIGNhdXNlOiB1bmtub3duKSB7XG4gICAgc3VwZXIoXG4gICAgICBgQ291bGQgbm90IGFwcGVuZCB0byB0aGUgbGlmZWN5Y2xlIGxlZGdlciAke3BhdGh9OiAke1xuICAgICAgICBjYXVzZU1lc3NhZ2UoY2F1c2UpXG4gICAgICB9YCxcbiAgICAgIHsgY2F1c2UgfSxcbiAgICApO1xuICAgIHRoaXMubmFtZSA9IFwiTGlmZWN5Y2xlTGVkZ2VyQXBwZW5kRXJyb3JcIjtcbiAgICB0aGlzLnBhdGggPSBwYXRoO1xuICB9XG59XG5cbi8qKlxuICogQXBwZW5kIG9uZSBldmVudCB0byB0aGUgbGVkZ2VyLlxuICpcbiAqIFRoZSB3cml0ZXIgaXMgYSBwbGFpbiBhcHBlbmQuIERlZHVwZSBoYXBwZW5zIG9uIHJlYWQsIHNvIGEgcmVwbGF5IGFmdGVyIGFcbiAqIHJlc3RhcnQgaXMgaGFybWxlc3MuIFRoZSBldmVudCBpcyB2YWxpZGF0ZWQgYmVmb3JlIGFueXRoaW5nIGlzIHdyaXR0ZW4sIGFuZFxuICogYW55IHdyaXRlIGZhaWx1cmUgdGhyb3dzOyBub3RoaW5nIGlzIHN3YWxsb3dlZC5cbiAqXG4gKiBAcGFyYW0gcGF0aCAtIFRoZSBsZWRnZXIgcGF0aC5cbiAqIEBwYXJhbSBldmVudCAtIFRoZSBldmVudCB0byBhcHBlbmQuXG4gKiBAdGhyb3dzIHtMaWZlY3ljbGVFdmVudFNjaGVtYUVycm9yfSBXaGVuIHRoZSBldmVudCBpcyByZWZ1c2VkLlxuICogQHRocm93cyB7TGlmZWN5Y2xlTGVkZ2VyQXBwZW5kRXJyb3J9IFdoZW4gdGhlIHdyaXRlIGZhaWxzLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gYXBwZW5kTGlmZWN5Y2xlRXZlbnQoXG4gIHBhdGg6IHN0cmluZyxcbiAgZXZlbnQ6IExpZmVjeWNsZUV2ZW50LFxuKTogUHJvbWlzZTx2b2lkPiB7XG4gIGNvbnN0IGxpbmUgPSBzZXJpYWxpc2VMaWZlY3ljbGVFdmVudChldmVudCk7XG4gIHRyeSB7XG4gICAgYXdhaXQgRGVuby53cml0ZVRleHRGaWxlKHBhdGgsIGxpbmUgKyBcIlxcblwiLCB7IGFwcGVuZDogdHJ1ZSwgY3JlYXRlOiB0cnVlIH0pO1xuICB9IGNhdGNoIChlcnJvcikge1xuICAgIHRocm93IG5ldyBMaWZlY3ljbGVMZWRnZXJBcHBlbmRFcnJvcihwYXRoLCBlcnJvcik7XG4gIH1cbn1cblxuLyoqIFdoeSBhIGxlZGdlciBsaW5lIGNvdWxkIG5vdCBiZSByZWFkLiAqL1xuZXhwb3J0IHR5cGUgTGlmZWN5Y2xlTGVkZ2VyUmVhZFJlYXNvbiA9XG4gIHwgXCJ1bnJlYWRhYmxlXCJcbiAgfCBcInVucGFyc2VhYmxlXCJcbiAgfCBcImludmFsaWRcIlxuICB8IFwiZnV0dXJlLXNjaGVtYVwiO1xuXG4vKipcbiAqIFJhaXNlZCB3aGVuIGEgbGVkZ2VyIGNhbm5vdCBiZSByZWFkIGFzIGEgd2hvbGUsIG9yIGEgbGluZSBjYW5ub3QgYmUgdXNlZC5cbiAqXG4gKiBgbGluZWAgaXMgMS1iYXNlZCwgYW5kIDAgd2hlbiB0aGUgd2hvbGUgZmlsZSBpcyB1bnJlYWRhYmxlLiBUaGUgZGV0YWlsXG4gKiBuZXZlciBlY2hvZXMgdGhlIHJhdyBsaW5lOyBpdCBtYXkgb25seSBuYW1lIHRoZSBvZmZlbmRpbmcgZmllbGQuXG4gKi9cbmV4cG9ydCBjbGFzcyBMaWZlY3ljbGVMZWRnZXJSZWFkRXJyb3IgZXh0ZW5kcyBFcnJvciB7XG4gIHJlYWRvbmx5IHBhdGg6IHN0cmluZztcbiAgcmVhZG9ubHkgbGluZTogbnVtYmVyO1xuICByZWFkb25seSByZWFzb246IExpZmVjeWNsZUxlZGdlclJlYWRSZWFzb247XG5cbiAgY29uc3RydWN0b3IoXG4gICAgcGF0aDogc3RyaW5nLFxuICAgIGxpbmU6IG51bWJlcixcbiAgICByZWFzb246IExpZmVjeWNsZUxlZGdlclJlYWRSZWFzb24sXG4gICAgZGV0YWlsOiBzdHJpbmcsXG4gICkge1xuICAgIHN1cGVyKGBMaWZlY3ljbGUgbGVkZ2VyICR7cGF0aH0gbGluZSAke2xpbmV9IGlzICR7cmVhc29ufTogJHtkZXRhaWx9YCk7XG4gICAgdGhpcy5uYW1lID0gXCJMaWZlY3ljbGVMZWRnZXJSZWFkRXJyb3JcIjtcbiAgICB0aGlzLnBhdGggPSBwYXRoO1xuICAgIHRoaXMubGluZSA9IGxpbmU7XG4gICAgdGhpcy5yZWFzb24gPSByZWFzb247XG4gIH1cbn1cblxuLyoqXG4gKiBSZWFkIGEgbGVkZ2VyLCB2YWxpZGF0aW5nIGV2ZXJ5IGxpbmUgYW5kIGtlZXBpbmcgdGhlIGZpcnN0IG9mIGVhY2ggZXZlbnQuXG4gKlxuICogQSBtaXNzaW5nIGxlZGdlciBpcyBhIGxlZ2l0aW1hdGUgZW1wdHkgcmVzdWx0LiBBbnkgb3RoZXIgZmF1bHQgaXMgcmVmdXNlZFxuICogcmF0aGVyIHRoYW4gc2tpcHBlZCwgc28gYSBkYW1hZ2VkIGxlZGdlciBjYW5ub3QgYmUgbWlzdGFrZW4gZm9yIGEgc2hvcnQgb25lLlxuICpcbiAqIEBwYXJhbSBwYXRoIC0gVGhlIGxlZGdlciBwYXRoLlxuICogQHJldHVybnMgVGhlIGRpc3RpbmN0IGV2ZW50cywgaW4gZmlyc3Qtc2VlbiBvcmRlci5cbiAqIEB0aHJvd3Mge0xpZmVjeWNsZUxlZGdlclJlYWRFcnJvcn0gV2hlbiB0aGUgbGVkZ2VyIG9yIGEgbGluZSBpcyByZWZ1c2VkLlxuICovXG5leHBvcnQgYXN5bmMgZnVuY3Rpb24gcmVhZExpZmVjeWNsZUxlZGdlcihcbiAgcGF0aDogc3RyaW5nLFxuKTogUHJvbWlzZTxMaWZlY3ljbGVFdmVudFtdPiB7XG4gIC8vIFNJTVBMRS1PTi1QVVJQT1NFOiByZWFkcyB0aGUgd2hvbGUgZmlsZSBpbnRvIG1lbW9yeSwgZmluZSB0byB+MTAwLDAwMCBldmVudHMg4oCUIHVwZ3JhZGUgd2hlbiBhIGhvc3QncyBsZWRnZXIgZXhjZWVkcyB0ZW5zIG9mIG1lZ2FieXRlc1xuICBsZXQgdGV4dDogc3RyaW5nO1xuICB0cnkge1xuICAgIHRleHQgPSBhd2FpdCBEZW5vLnJlYWRUZXh0RmlsZShwYXRoKTtcbiAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICBpZiAoZXJyb3IgaW5zdGFuY2VvZiBEZW5vLmVycm9ycy5Ob3RGb3VuZCkgcmV0dXJuIFtdO1xuICAgIHRocm93IG5ldyBMaWZlY3ljbGVMZWRnZXJSZWFkRXJyb3IoXG4gICAgICBwYXRoLFxuICAgICAgMCxcbiAgICAgIFwidW5yZWFkYWJsZVwiLFxuICAgICAgY2F1c2VNZXNzYWdlKGVycm9yKSxcbiAgICApO1xuICB9XG5cbiAgY29uc3QgZXZlbnRzOiBMaWZlY3ljbGVFdmVudFtdID0gW107XG4gIGNvbnN0IHNlZW4gPSBuZXcgU2V0PHN0cmluZz4oKTtcbiAgY29uc3QgbGluZXMgPSB0ZXh0LnNwbGl0KFwiXFxuXCIpO1xuICBmb3IgKGxldCBpbmRleCA9IDA7IGluZGV4IDwgbGluZXMubGVuZ3RoOyBpbmRleCsrKSB7XG4gICAgY29uc3QgcmF3ID0gbGluZXNbaW5kZXhdID8/IFwiXCI7XG4gICAgaWYgKHJhdy50cmltKCkgPT09IFwiXCIpIGNvbnRpbnVlO1xuICAgIGNvbnN0IGxpbmVOdW1iZXIgPSBpbmRleCArIDE7XG5cbiAgICBsZXQgcGFyc2VkOiB1bmtub3duO1xuICAgIHRyeSB7XG4gICAgICBwYXJzZWQgPSBKU09OLnBhcnNlKHJhdyk7XG4gICAgfSBjYXRjaCB7XG4gICAgICB0aHJvdyBuZXcgTGlmZWN5Y2xlTGVkZ2VyUmVhZEVycm9yKFxuICAgICAgICBwYXRoLFxuICAgICAgICBsaW5lTnVtYmVyLFxuICAgICAgICBcInVucGFyc2VhYmxlXCIsXG4gICAgICAgIFwibm90IHZhbGlkIEpTT05cIixcbiAgICAgICk7XG4gICAgfVxuICAgIGlmIChcbiAgICAgIGlzUGxhaW5PYmplY3QocGFyc2VkKSAmJiB0eXBlb2YgcGFyc2VkLnNjaGVtYSA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgcGFyc2VkLnNjaGVtYSA+IExJRkVDWUNMRV9MRURHRVJfU0NIRU1BXG4gICAgKSB7XG4gICAgICB0aHJvdyBuZXcgTGlmZWN5Y2xlTGVkZ2VyUmVhZEVycm9yKFxuICAgICAgICBwYXRoLFxuICAgICAgICBsaW5lTnVtYmVyLFxuICAgICAgICBcImZ1dHVyZS1zY2hlbWFcIixcbiAgICAgICAgYHNjaGVtYSAke3BhcnNlZC5zY2hlbWF9IGlzIG5ld2VyIHRoYW4gJHtMSUZFQ1lDTEVfTEVER0VSX1NDSEVNQX1gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBsZXQgZXZlbnQ6IExpZmVjeWNsZUV2ZW50O1xuICAgIHRyeSB7XG4gICAgICBldmVudCA9IHZhbGlkYXRlTGlmZWN5Y2xlRXZlbnQocGFyc2VkKTtcbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgLy8gdmFsaWRhdGVMaWZlY3ljbGVFdmVudCBvbmx5IHRocm93cyBMaWZlY3ljbGVFdmVudFNjaGVtYUVycm9yLlxuICAgICAgdGhyb3cgbmV3IExpZmVjeWNsZUxlZGdlclJlYWRFcnJvcihcbiAgICAgICAgcGF0aCxcbiAgICAgICAgbGluZU51bWJlcixcbiAgICAgICAgXCJpbnZhbGlkXCIsXG4gICAgICAgIGBmaWVsZCAkeyhlcnJvciBhcyBMaWZlY3ljbGVFdmVudFNjaGVtYUVycm9yKS5maWVsZH0gZmFpbGVkIHZhbGlkYXRpb25gLFxuICAgICAgKTtcbiAgICB9XG5cbiAgICBpZiAoc2Vlbi5oYXMoZXZlbnQuZXZlbnRLZXkpKSBjb250aW51ZTtcbiAgICBzZWVuLmFkZChldmVudC5ldmVudEtleSk7XG4gICAgZXZlbnRzLnB1c2goZXZlbnQpO1xuICB9XG4gIHJldHVybiBldmVudHM7XG59XG4iXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztDQThCQyxHQUtELFNBQVMsV0FBVyxRQUFRLHVCQUF1QjtBQUNuRCxTQUFTLGdCQUFnQixRQUFRLCtCQUErQjtBQUVoRSx5RUFBeUUsR0FDekUsT0FBTyxNQUFNLDBCQUEwQixFQUFXO0FBRWxELDBEQUEwRCxHQUMxRCxPQUFPLE1BQU0sd0JBQXdCO0VBQ25DO0VBQ0E7RUFDQTtFQUNBO0VBQ0E7Q0FDRCxDQUFVO0FBS1gsMERBQTBELEdBQzFELE9BQU8sTUFBTSxrQkFBa0I7RUFBQztFQUFXO0VBQVk7Q0FBVyxDQUFVO0FBSzVFLGtFQUFrRSxHQUNsRSxPQUFPLE1BQU0sb0JBQW9CLGFBQWE7QUF1SjlDOzs7Ozs7Ozs7Q0FTQyxHQUNELE9BQU8sU0FBUyxrQkFDZCxLQUEyQztFQUUzQyxPQUFRLE1BQU0sSUFBSTtJQUNoQixLQUFLO01BQ0gsT0FBTyxDQUFDLFdBQVcsRUFBRSxNQUFNLFlBQVksQ0FBQyxDQUFDLEVBQUUsTUFBTSxJQUFJ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
// denoCacheMetadata=8527209524635710906,14320528324563063395