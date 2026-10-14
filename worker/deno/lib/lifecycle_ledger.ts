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
 *     label, repo, UUID or timestamp. A prompt, an issue body, an e-mail
 *     address or a credential therefore cannot be stored by accident, however
 *     a caller shapes the object.
 *   - **Idempotent by key.** Each event carries a deterministic `eventKey`.
 *     The writer is a plain append; {@link readLifecycleLedger} dedupes on
 *     that key, so a replay after a restart is harmless.
 *
 * Refusals name the offending field and the rule it broke, never the value,
 * so a refused secret cannot leak into a log line.
 *
 * Australian English spelling used throughout.
 */

import { getHostname } from "./worker_identity.ts";
import { sanitiseHostname } from "./fleet_telemetry_sidecar.ts";

/** Ledger line schema version. A line carrying a higher one is refused. */
export const LIFECYCLE_LEDGER_SCHEMA = 1 as const;

/** The five kinds of lifecycle event the ledger records. */
export const LIFECYCLE_EVENT_KINDS = [
  "assignment",
  "invocation",
  "follow_on",
  "gate",
  "outcome",
] as const;

/** One of {@link LIFECYCLE_EVENT_KINDS}. */
export type LifecycleEventKind = (typeof LIFECYCLE_EVENT_KINDS)[number];

/** The agent roles an invocation or treatment can carry. */
export const LIFECYCLE_ROLES = ["manager", "executor", "reviewer"] as const;

/** One of {@link LIFECYCLE_ROLES}. */
export type LifecycleRole = (typeof LIFECYCLE_ROLES)[number];

/** The cohort an assignment carries until an operator labels it. */
export const UNASSIGNED_COHORT = "unassigned";

/** The agent treatment one role ran under. */
export interface RoleTreatment {
  role: LifecycleRole;
  /** The Claude sub-agent name, when the role ran as one. */
  agent?: string;
  provider: string;
  model?: string;
  effort?: string;
}

/** Fields every ledger event carries. */
interface LifecycleEventBase {
  schema: typeof LIFECYCLE_LEDGER_SCHEMA;
  eventKey: string;
  assignmentId: string;
  runId: string;
  host: string;
  repo: string;
  issueNumber: number;
  recordedAt: string;
}

/** The treatment an assignment records. */
export interface AssignmentTreatment {
  roles: RoleTreatment[];
  workerVersion?: string;
  workerCommit?: string;
  subscriptionAllocation?: string;
}

/** An issue assignment: which cohort the issue belongs to, and its treatment. */
export interface AssignmentEvent extends LifecycleEventBase {
  kind: "assignment";
  assignedAt: string;
  cohort: string;
  reused: boolean;
  treatment: AssignmentTreatment;
}

/**
 * One agent invocation.
 *
 * An absent token or cost field means UNKNOWN, never zero. A provider that
 * does not report usage leaves the field out, so a dashboard can tell "no
 * tokens were spent" from "the count was not captured".
 */
export interface InvocationEvent extends LifecycleEventBase {
  kind: "invocation";
  role: LifecycleRole;
  agent?: string;
  attempt: number;
  provider: string;
  model?: string;
  effort?: string;
  servedModels?: string[];
  result: "success" | "failure" | "timeout" | "usage_limited";
  durationSeconds?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  estimatedApiCostUsd?: number;
}

/** A follow-on run started from an earlier outcome. */
export interface FollowOnEvent extends LifecycleEventBase {
  kind: "follow_on";
  followOn: "retry" | "ci_fix" | "pr_feedback" | "merge_conflict" | "repair_pr";
  attempt: number;
  prNumber?: number;
}

/** One quality gate's result. */
export interface GateEvent extends LifecycleEventBase {
  kind: "gate";
  gate: string;
  result: "pass" | "fail" | "skipped";
  attempt: number;
  prNumber?: number;
}

/** The outcome of an assignment, or of one PR it produced. */
export interface OutcomeEvent extends LifecycleEventBase {
  kind: "outcome";
  outcome:
    | "pr_opened"
    | "quality_green"
    | "review_approved"
    | "merged"
    | "closed_unmerged"
    | "pending"
    | "censored"
    | "failed"
    | "timeout"
    | "handed_off";
  prNumber?: number;
}

/** Any event the ledger can hold. */
export type LifecycleEvent =
  | AssignmentEvent
  | InvocationEvent
  | FollowOnEvent
  | GateEvent
  | OutcomeEvent;

/** Distributes `Omit` across a union so each member keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K>
  : never;

/** An event as a caller builds it, before the key is derived. */
export type LifecycleEventInput = DistributiveOmit<
  LifecycleEvent,
  "schema" | "eventKey"
>;

/**
 * The deterministic key that identifies one event.
 *
 * Two lines with the same key describe the same fact, so the reader keeps
 * only the first. A PR outcome is keyed by its PR number and not its run, so
 * a PR counts once however many runs or hosts observe it.
 *
 * @param event - The event, before or after its key is attached.
 * @returns The key.
 */
export function lifecycleEventKey(
  event: LifecycleEventInput | LifecycleEvent,
): string {
  switch (event.kind) {
    case "assignment":
      return `assignment:${event.assignmentId}:${event.runId}`;
    case "invocation":
      return `invocation:${event.assignmentId}:${event.runId}:${event.role}:` +
        `${event.agent ?? "-"}:${event.attempt}`;
    case "follow_on":
      return `follow_on:${event.assignmentId}:${event.runId}:` +
        `${event.followOn}:${event.prNumber ?? "-"}:${event.attempt}`;
    case "gate":
      return `gate:${event.assignmentId}:${event.runId}:${event.gate}:` +
        `${event.attempt}`;
    case "outcome":
      return event.prNumber !== undefined
        ? `outcome:${event.assignmentId}:${event.outcome}:pr-${event.prNumber}`
        : `outcome:${event.assignmentId}:${event.outcome}:run-${event.runId}`;
  }
}

/**
 * Raised when a value is refused by the ledger's allowlist.
 *
 * `field` names the offending key or field. The message never carries the
 * value itself.
 */
export class LifecycleEventSchemaError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Lifecycle event field ${field} is invalid: ${reason}`);
    this.name = "LifecycleEventSchemaError";
    this.field = field;
  }
}

/** Keys every event may carry. Anything else is refused. */
const BASE_KEYS: readonly string[] = [
  "schema",
  "kind",
  "eventKey",
  "assignmentId",
  "runId",
  "host",
  "repo",
  "issueNumber",
  "recordedAt",
];

/** Keys each kind may carry beyond the base keys. */
const KIND_KEYS: Readonly<Record<LifecycleEventKind, readonly string[]>> = {
  assignment: ["assignedAt", "cohort", "reused", "treatment"],
  invocation: [
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
    "estimatedApiCostUsd",
  ],
  follow_on: ["followOn", "attempt", "prNumber"],
  gate: ["gate", "result", "attempt", "prNumber"],
  outcome: ["outcome", "prNumber"],
};

/** Keys a treatment may carry. */
const TREATMENT_KEYS: readonly string[] = [
  "roles",
  "workerVersion",
  "workerCommit",
  "subscriptionAllocation",
];

/** Keys one role treatment may carry. */
const ROLE_TREATMENT_KEYS: readonly string[] = [
  "role",
  "agent",
  "provider",
  "model",
  "effort",
];

/**
 * The shape of a token: a provider, model, effort, agent, host, run id, gate
 * or version. No `@`, no whitespace, so an e-mail address or prose cannot be
 * stored. Bounded, with no overlapping quantifiers, because it runs on agent
 * and operator text.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+\[\]-]{0,127}$/;

/** A GitHub `owner/name` repository. */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9._-]{1,100}$/;

/** A lowercase UUID, the form {@link AssignmentEvent} identifies itself by. */
const ASSIGNMENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A cohort or subscription label: lowercase, dotted or dashed, bounded. */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** An ISO-8601 UTC timestamp, to at most millisecond precision. */
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** Whether `value` is a plain object (a JSON object, not an array or class). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Whether `value` is a UUID the ledger accepts as an assignment id. */
export function isValidAssignmentId(value: unknown): value is string {
  return typeof value === "string" && ASSIGNMENT_ID_PATTERN.test(value);
}

/** Whether `value` is a cohort or subscription label the ledger accepts. */
export function isValidLifecycleLabel(value: unknown): value is string {
  return typeof value === "string" && LABEL_PATTERN.test(value);
}

/** Whether `value` is a timestamp the ledger accepts. */
export function isValidLifecycleTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value));
}

/** Refuse a key the allowlist does not name. */
function assertAllowedKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new LifecycleEventSchemaError(
        `${prefix}${key}`,
        "key is not on the allowlist",
      );
    }
  }
}

/** Refuse a string that does not match `pattern`. */
function requirePattern(
  value: unknown,
  field: string,
  pattern: RegExp,
  rule: string,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new LifecycleEventSchemaError(field, rule);
  }
  return value;
}

/** Refuse a value that is not one of `allowed`. */
function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (
    typeof value !== "string" || !(allowed as readonly string[]).includes(value)
  ) {
    throw new LifecycleEventSchemaError(
      field,
      `must be one of ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

/** Refuse a value that is not a positive safe integer. */
function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new LifecycleEventSchemaError(field, "must be a positive integer");
  }
  return value;
}

/** Refuse a value that is not a non-negative safe integer. */
function requireCount(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new LifecycleEventSchemaError(
      field,
      "must be a non-negative integer",
    );
  }
  return value;
}

/** Refuse a value that is not a finite, non-negative number. */
function requireNonNegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new LifecycleEventSchemaError(field, "must be a finite number >= 0");
  }
  return value;
}

/** Refuse a value that is not a boolean. */
function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new LifecycleEventSchemaError(field, "must be a boolean");
  }
  return value;
}

/** Refuse a value that is not a timestamp the ledger accepts. */
function requireTimestamp(value: unknown, field: string): string {
  if (!isValidLifecycleTimestamp(value)) {
    throw new LifecycleEventSchemaError(
      field,
      "must be an ISO-8601 UTC timestamp",
    );
  }
  return value;
}

/** Refuse a value that is not a token. */
function requireToken(value: unknown, field: string): string {
  return requirePattern(value, field, TOKEN_PATTERN, "must be a bounded token");
}

/** Refuse a value that is not a label. */
function requireLabel(value: unknown, field: string): string {
  if (!isValidLifecycleLabel(value)) {
    throw new LifecycleEventSchemaError(field, "must be a bounded label");
  }
  return value;
}

/** Refuse a value that is not a `string[]` of tokens. */
function requireTokenList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new LifecycleEventSchemaError(field, "must be an array");
  }
  return value.map((item, index) => requireToken(item, `${field}[${index}]`));
}

/** Read an optional field: absent or `undefined` is no value. */
function optional<T>(
  value: unknown,
  check: (value: unknown) => T,
): T | undefined {
  return value === undefined ? undefined : check(value);
}

/** Validate one role treatment against its allowlist. */
function validateRoleTreatment(value: unknown, index: number): RoleTreatment {
  const field = `treatment.roles[${index}]`;
  if (!isPlainObject(value)) {
    throw new LifecycleEventSchemaError(field, "must be an object");
  }
  assertAllowedKeys(value, ROLE_TREATMENT_KEYS, "treatment.roles[].");
  const role = requireEnum(value.role, `${field}.role`, LIFECYCLE_ROLES);
  const provider = requireToken(value.provider, `${field}.provider`);
  const agent = optional(value.agent, (v) => requireToken(v, `${field}.agent`));
  const model = optional(value.model, (v) => requireToken(v, `${field}.model`));
  const effort = optional(
    value.effort,
    (v) => requireToken(v, `${field}.effort`),
  );
  return {
    role,
    provider,
    ...(agent !== undefined ? { agent } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
  };
}

/** Validate an assignment's treatment against its allowlist. */
function validateTreatment(value: unknown): AssignmentTreatment {
  if (!isPlainObject(value)) {
    throw new LifecycleEventSchemaError("treatment", "must be an object");
  }
  assertAllowedKeys(value, TREATMENT_KEYS, "treatment.");
  if (!Array.isArray(value.roles) || value.roles.length === 0) {
    throw new LifecycleEventSchemaError(
      "treatment.roles",
      "must be a non-empty array",
    );
  }
  const roles = value.roles.map((item, index) =>
    validateRoleTreatment(item, index)
  );
  const workerVersion = optional(
    value.workerVersion,
    (v) => requireToken(v, "treatment.workerVersion"),
  );
  const workerCommit = optional(
    value.workerCommit,
    (v) => requireToken(v, "treatment.workerCommit"),
  );
  const subscriptionAllocation = optional(
    value.subscriptionAllocation,
    (v) => requireLabel(v, "treatment.subscriptionAllocation"),
  );
  return {
    roles,
    ...(workerVersion !== undefined ? { workerVersion } : {}),
    ...(workerCommit !== undefined ? { workerCommit } : {}),
    ...(subscriptionAllocation !== undefined ? { subscriptionAllocation } : {}),
  };
}

/** Validate the kind-specific fields of an event, after the base fields. */
function validateKindFields(
  value: Record<string, unknown>,
  kind: LifecycleEventKind,
): void {
  switch (kind) {
    case "assignment":
      requireTimestamp(value.assignedAt, "assignedAt");
      requireLabel(value.cohort, "cohort");
      requireBoolean(value.reused, "reused");
      validateTreatment(value.treatment);
      return;
    case "invocation": {
      requireEnum(value.role, "role", LIFECYCLE_ROLES);
      optional(value.agent, (v) => requireToken(v, "agent"));
      requirePositiveInteger(value.attempt, "attempt");
      requireToken(value.provider, "provider");
      optional(value.model, (v) => requireToken(v, "model"));
      optional(value.effort, (v) => requireToken(v, "effort"));
      optional(value.servedModels, (v) => requireTokenList(v, "servedModels"));
      requireEnum(value.result, "result", [
        "success",
        "failure",
        "timeout",
        "usage_limited",
      ]);
      optional(
        value.durationSeconds,
        (v) => requireNonNegativeNumber(v, "durationSeconds"),
      );
      for (
        const field of [
          "inputTokens",
          "outputTokens",
          "cacheReadTokens",
          "cacheCreationTokens",
        ] as const
      ) {
        optional(value[field], (v) => requireCount(v, field));
      }
      optional(
        value.estimatedApiCostUsd,
        (v) => requireNonNegativeNumber(v, "estimatedApiCostUsd"),
      );
      return;
    }
    case "follow_on":
      requireEnum(value.followOn, "followOn", [
        "retry",
        "ci_fix",
        "pr_feedback",
        "merge_conflict",
        "repair_pr",
      ]);
      requirePositiveInteger(value.attempt, "attempt");
      optional(value.prNumber, (v) => requirePositiveInteger(v, "prNumber"));
      return;
    case "gate":
      requireToken(value.gate, "gate");
      requireEnum(value.result, "result", ["pass", "fail", "skipped"]);
      requirePositiveInteger(value.attempt, "attempt");
      optional(value.prNumber, (v) => requirePositiveInteger(v, "prNumber"));
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
        "handed_off",
      ]);
      optional(value.prNumber, (v) => requirePositiveInteger(v, "prNumber"));
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
 */
export function validateLifecycleEvent(value: unknown): LifecycleEvent {
  if (!isPlainObject(value)) {
    throw new LifecycleEventSchemaError("(root)", "must be an object");
  }
  if (value.schema !== LIFECYCLE_LEDGER_SCHEMA) {
    throw new LifecycleEventSchemaError("schema", "must be 1");
  }
  const kind = value.kind;
  if (
    typeof kind !== "string" ||
    !(LIFECYCLE_EVENT_KINDS as readonly string[]).includes(kind)
  ) {
    throw new LifecycleEventSchemaError(
      "kind",
      `must be one of ${LIFECYCLE_EVENT_KINDS.join(", ")}`,
    );
  }
  const eventKind = kind as LifecycleEventKind;
  assertAllowedKeys(value, [...BASE_KEYS, ...KIND_KEYS[eventKind]], "");

  requireToken(value.host, "host");
  requireToken(value.runId, "runId");
  requirePattern(value.repo, "repo", REPO_PATTERN, "must be owner/name");
  requirePositiveInteger(value.issueNumber, "issueNumber");
  requireTimestamp(value.recordedAt, "recordedAt");
  if (!isValidAssignmentId(value.assignmentId)) {
    throw new LifecycleEventSchemaError(
      "assignmentId",
      "must be a lowercase UUID",
    );
  }
  validateKindFields(value, eventKind);

  if (
    typeof value.eventKey !== "string" ||
    value.eventKey !== lifecycleEventKey(value as unknown as LifecycleEvent)
  ) {
    throw new LifecycleEventSchemaError(
      "eventKey",
      "must equal the key derived from the event",
    );
  }
  return value as unknown as LifecycleEvent;
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
 */
export function buildLifecycleEvent(
  input: LifecycleEventInput,
): LifecycleEvent {
  const eventKey = lifecycleEventKey(input);
  return validateLifecycleEvent({ schema: 1, ...input, eventKey });
}

/**
 * Serialise an event as one JSON line, without a trailing newline.
 *
 * @param event - The event to write.
 * @returns The JSON line.
 * @throws {LifecycleEventSchemaError} When the event is refused.
 */
export function serialiseLifecycleEvent(event: LifecycleEvent): string {
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
 */
export function lifecycleLedgerPath(
  workDir: string,
  hostname: string = getHostname(),
): string {
  return `${workDir}/lifecycle_ledger_${sanitiseHostname(hostname)}.jsonl`;
}

/** Describe an unknown error without relying on its type. */
function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Raised when an event cannot be appended to the ledger. */
export class LifecycleLedgerAppendError extends Error {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(
      `Could not append to the lifecycle ledger ${path}: ${
        causeMessage(cause)
      }`,
      { cause },
    );
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
 */
export async function appendLifecycleEvent(
  path: string,
  event: LifecycleEvent,
): Promise<void> {
  const line = serialiseLifecycleEvent(event);
  try {
    await Deno.writeTextFile(path, line + "\n", { append: true, create: true });
  } catch (error) {
    throw new LifecycleLedgerAppendError(path, error);
  }
}

/** Why a ledger line could not be read. */
export type LifecycleLedgerReadReason =
  | "unreadable"
  | "unparseable"
  | "invalid"
  | "future-schema";

/**
 * Raised when a ledger cannot be read as a whole, or a line cannot be used.
 *
 * `line` is 1-based, and 0 when the whole file is unreadable. The detail
 * never echoes the raw line; it may only name the offending field.
 */
export class LifecycleLedgerReadError extends Error {
  readonly path: string;
  readonly line: number;
  readonly reason: LifecycleLedgerReadReason;

  constructor(
    path: string,
    line: number,
    reason: LifecycleLedgerReadReason,
    detail: string,
  ) {
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
 * SIMPLE-ON-PURPOSE: reads the whole file into memory, fine to ~100,000 events — upgrade when a host's ledger exceeds tens of megabytes
 *
 * @param path - The ledger path.
 * @returns The distinct events, in first-seen order.
 * @throws {LifecycleLedgerReadError} When the ledger or a line is refused.
 */
export async function readLifecycleLedger(
  path: string,
): Promise<LifecycleEvent[]> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw new LifecycleLedgerReadError(
      path,
      0,
      "unreadable",
      causeMessage(error),
    );
  }

  const events: LifecycleEvent[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index] ?? "";
    if (raw.trim() === "") continue;
    const lineNumber = index + 1;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LifecycleLedgerReadError(
        path,
        lineNumber,
        "unparseable",
        "not valid JSON",
      );
    }
    if (
      isPlainObject(parsed) && typeof parsed.schema === "number" &&
      parsed.schema > LIFECYCLE_LEDGER_SCHEMA
    ) {
      throw new LifecycleLedgerReadError(
        path,
        lineNumber,
        "future-schema",
        `schema ${parsed.schema} is newer than ${LIFECYCLE_LEDGER_SCHEMA}`,
      );
    }

    let event: LifecycleEvent;
    try {
      event = validateLifecycleEvent(parsed);
    } catch (error) {
      if (error instanceof LifecycleEventSchemaError) {
        throw new LifecycleLedgerReadError(
          path,
          lineNumber,
          "invalid",
          `field ${error.field} failed validation`,
        );
      }
      throw error;
    }

    if (seen.has(event.eventKey)) continue;
    seen.add(event.eventKey);
    events.push(event);
  }
  return events;
}
