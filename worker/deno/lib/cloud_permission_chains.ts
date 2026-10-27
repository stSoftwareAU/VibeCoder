/**
 * Static cloud permission-chain scan for CloudFormation and Terraform (Issue #4416).
 *
 * A single AWS permission is never a finding. This module looks for the
 * dangerous COMBINATIONS of individually scoped IAM permissions that let one
 * role reach more privilege than it holds:
 *
 *   - `assume-role-escalation` — caller role C may sts:AssumeRole a target role
 *     T whose trust admits C, and T holds privileged grants C lacks;
 *   - `passrole-compute` — C may iam:PassRole T and start a compute resource
 *     (Lambda, EC2, ECS) that runs as T, and T holds privileged grants C lacks;
 *   - `ssm-send-command` — C may ssm:SendCommand to an in-repo instance whose
 *     instance profile is role T, and T holds privileged grants C lacks.
 *
 * Everything is read-only. Templates are parsed as text (CloudFormation via
 * `parseCfnDocument`, Terraform via `parseHcl`) and never executed, interpolated
 * or sent to a cloud API. Unknown values (parameters, variables, external ARNs,
 * unresolved managed policies or boundaries) stay UNKNOWN: they are never
 * turned into a grant and never into a protection. A would-be chain with an
 * unknown required hop is reported as `status: "incomplete"`, never as a chain
 * and never as a silently clean result.
 *
 * Repository text is DATA. Strings from the scanned checkout that end up in
 * rendered output are sanitised (newlines and backticks removed, truncated).
 *
 * Australian English spelling used throughout.
 */

import { parseCfnDocument } from "./cfn_cost_checks.ts";
import { computeFindingId } from "./security_finding_id.ts";
import { isHclRef, isHclUnknown, parseHcl } from "./hcl_subset.ts";
import type { HclBlock, HclValue } from "./hcl_subset.ts";

export type ChainKind =
  | "assume-role-escalation"
  | "passrole-compute"
  | "ssm-send-command";

export interface ChainHop {
  text: string;
  file: string;
  line: number;
}

export interface ChainAssessment {
  kind: ChainKind;
  status: "chain" | "incomplete";
  /** Logical id (CFN) or address (TF) of the entry principal. */
  caller: string;
  /** Target role (assume/passrole) or instance (ssm). */
  target: string;
  entryFile: string;
  entryLine: number;
  /** EVERY supported hop, in order, each with file:line. */
  hops: ChainHop[];
  /** The privileged grants the target holds that the caller lacks. */
  boundary: string;
  /** Declared intent text, or exactly "none stated in the repository". */
  intent: string;
  /** Condition blocks visible on any hop, as short text. */
  conditions: string[];
  /** What could not be resolved (non-empty for "incomplete"). */
  unresolved: string[];
  /** Smallest effective fix; never "deny all deployment/SSM access". */
  fix: string;
  /** Canonical text `${kind}|${caller}|${target}`, no line numbers. */
  signature: string;
}

export interface ChainScanResult {
  assessments: ChainAssessment[];
  filesRead: number;
  /** Files unreadable, unparseable or over the size bound: "path: reason". */
  notChecked: string[];
}

/* ------------------------------------------------------------------------ */
/* Internal intermediate representation                                      */
/* ------------------------------------------------------------------------ */

/** A value from the template: a literal, or a reference to an in-repo resource. */
type Ref = { kind: "ref"; target: string } | {
  kind: "literal";
  value: string;
} | { kind: "unknown"; text: string };

interface Loc {
  file: string;
  line: number;
}

interface Statement {
  effect: "Allow" | "Deny";
  actions: string[];
  /** Resource references; a `*` literal is kept as literal "*". */
  resources: Ref[];
  /** Principal references for trust statements (service, AWS, other). */
  principals: { type: string; values: Ref[] }[];
  /** Short condition descriptions (for `conditions` output). */
  conditions: string[];
  /** Whether a Condition block is present. */
  conditioned: boolean;
  /** iam:PassedToService values if the condition restricts them. */
  passedToService?: string[];
  /** ssm:resourceTag/K or aws:ResourceTag/K conditions; values null when unknown. */
  resourceTags: { key: string; values: string[] | null }[];
  loc: Loc;
  /** Text (action or Sid) for citing the statement. */
  text: string;
  /** Unsupported NotAction/NotResource. */
  unsupported: boolean;
}

interface PolicyDoc {
  statements: Statement[];
  loc: Loc;
  /** Inline / managed policy identity; name used in citations. */
  name: string;
}

interface RoleIr {
  id: string; // logical id or TF address
  kind: "cfn" | "tf";
  file: string;
  line: number;
  /** Literal role name when statically known. */
  roleName?: string;
  description?: string;
  tags: Record<string, string>;
  trust: Statement[];
  trustUnknown: { text: string; loc: Loc }[];
  policies: PolicyDoc[];
  unresolvedPolicies: { text: string; loc: Loc }[];
  boundary?: { kind: "resolved"; policy: PolicyDoc } | {
    kind: "unresolved";
    text: string;
    loc: Loc;
  };
}

interface InstanceIr {
  id: string;
  file: string;
  line: number;
  tags: Record<string, string>;
  tagsVisible: boolean;
  /** The instance profile (an in-repo profile id, or unknown). */
  profile: Ref;
}

interface InstanceProfileIr {
  id: string;
  /** The role the profile carries (an in-repo role id, or unknown). */
  role: Ref;
  loc: Loc;
}

interface Model {
  roles: RoleIr[];
  instances: InstanceIr[];
  profiles: InstanceProfileIr[];
  notChecked: string[];
  filesRead: number;
}

/* ------------------------------------------------------------------------ */
/* Limits and helpers                                                        */
/* ------------------------------------------------------------------------ */

const MAX_TEXT = 200;

/** Strip newlines and backticks from repo-derived text and truncate it. */
function clean(text: string, max = MAX_TEXT): string {
  const flat = text.replace(/[\r\n`]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * Linear, non-backtracking glob matcher over `*` (any run) and `?` (one char).
 * Case-insensitive. No RegExp is built from repo text, so a hostile pattern
 * cannot cause catastrophic backtracking.
 */
export function globMatch(pattern: string, value: string): boolean {
  const p = pattern.toLowerCase();
  const v = value.toLowerCase();
  let pi = 0;
  let vi = 0;
  let starP = -1;
  let starV = 0;
  while (vi < v.length) {
    if (pi < p.length && (p[pi] === "?" || p[pi] === v[vi])) {
      pi++;
      vi++;
    } else if (pi < p.length && p[pi] === "*") {
      starP = pi;
      starV = vi;
      pi++;
    } else if (starP >= 0) {
      pi = starP + 1;
      starV++;
      vi = starV;
    } else {
      return false;
    }
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}

/** 1-based line of the first line matching `test`, or 0. */
function findLine(text: string, test: (line: string) => boolean): number {
  const index = text.split("\n").findIndex(test);
  return index + 1;
}

/** 1-based line declaring logical id `id:` (optionally quoted), or 0. */
function resourceLine(text: string, id: string): number {
  return findLine(text, (line) => {
    let rest = line.trimStart();
    if (rest.startsWith('"')) rest = rest.slice(1);
    if (!rest.startsWith(id)) return false;
    rest = rest.slice(id.length);
    if (rest.startsWith('"')) rest = rest.slice(1);
    return rest.trimStart().startsWith(":");
  });
}

/** 1-based line containing a quoted or bare token, or the fallback. */
function tokenLine(text: string, token: string, fallback: number): number {
  const line = findLine(text, (l) => l.includes(token));
  return line > 0 ? line : fallback;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/* ------------------------------------------------------------------------ */
/* CloudFormation adapter                                                    */
/* ------------------------------------------------------------------------ */

interface CfnCtx {
  file: string;
  text: string;
  resources: Record<string, unknown>;
  /** 1-based declaration line of a resource id in this file, or 0. */
  lineOf: (id: string) => number;
  resourceIds: Set<string>;
  paramIds: Set<string>;
  typeOf: Map<string, string>;
}

/** Resolve a CFN value to a Ref. Parameters, pseudo parameters, Fn::* are unknown. */
function cfnRef(value: unknown, ctx: CfnCtx): Ref {
  if (typeof value === "number" || typeof value === "boolean") {
    return { kind: "literal", value: String(value) };
  }
  if (typeof value === "string") return cfnStringRef(value, ctx);
  if (isObject(value)) {
    if (typeof value.Ref === "string") return cfnNameRef(value.Ref, ctx);
    const attr = value["Fn::GetAtt"];
    if (Array.isArray(attr) && typeof attr[0] === "string") {
      return cfnNameRef(attr[0], ctx);
    }
    if (typeof value["Fn::Sub"] === "string") {
      return cfnSubRef(value["Fn::Sub"], ctx);
    }
  }
  return { kind: "unknown", text: "unresolved expression" };
}

function cfnNameRef(name: string, ctx: CfnCtx): Ref {
  if (ctx.resourceIds.has(name)) return { kind: "ref", target: name };
  return { kind: "unknown", text: clean(`${name} (parameter or pseudo value)`) };
}

function cfnStringRef(value: string, ctx: CfnCtx): Ref {
  if (value.includes("${")) return cfnSubRef(value, ctx);
  if (ctx.resourceIds.has(value)) return { kind: "ref", target: value };
  const dot = value.indexOf(".");
  if (
    dot > 0 && value.slice(dot + 1) === "Arn" &&
    ctx.resourceIds.has(value.slice(0, dot))
  ) {
    return { kind: "ref", target: value.slice(0, dot) };
  }
  if (ctx.paramIds.has(value) || value.startsWith("AWS::")) {
    return { kind: "unknown", text: clean(`${value} (parameter or pseudo value)`) };
  }
  return { kind: "literal", value };
}

/**
 * Fn::Sub text. `${AWS::AccountId}` is treated as the wildcard `*` (any
 * account) and `${AWS::Partition}` as `aws`; any other substitution makes the
 * value unknown, and a lone `${X}` / `${X.Arn}` naming an in-repo resource is
 * a reference to it.
 */
function cfnSubRef(text: string, ctx: CfnCtx): Ref {
  const lone = /^\$\{([A-Za-z0-9]+)(\.Arn)?\}$/.exec(text);
  if (lone && ctx.resourceIds.has(lone[1])) {
    return { kind: "ref", target: lone[1] };
  }
  const substituted = text
    .replaceAll("${AWS::AccountId}", "*")
    .replaceAll("${AWS::Partition}", "aws");
  if (substituted.includes("${")) {
    return { kind: "unknown", text: clean(text) };
  }
  return { kind: "literal", value: substituted };
}

/** A list-valued field: an array, or a single value. */
function listOf(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Strings of a list; `null` when any element is not a plain string. */
function stringList(value: unknown): string[] | null {
  const out: string[] = [];
  for (const item of listOf(value)) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

/** Short text for a Condition block, e.g. `StringEquals iam:PassedToService=lambda.amazonaws.com`. */
function conditionTexts(condition: unknown): string[] {
  if (!isObject(condition)) return [];
  const out: string[] = [];
  for (const [op, keys] of Object.entries(condition)) {
    if (!isObject(keys)) continue;
    for (const [key, vals] of Object.entries(keys)) {
      const shown = listOf(vals).map((v) =>
        typeof v === "string" ? v : JSON.stringify(v) ?? "?"
      ).join(",");
      out.push(clean(`${op} ${key}=${shown}`));
    }
  }
  return out;
}

/** The iam:PassedToService values of a condition, or undefined when none. */
function passedToServiceOf(condition: unknown): string[] | undefined {
  if (!isObject(condition)) return undefined;
  let found: string[] | undefined;
  for (const keys of Object.values(condition)) {
    if (!isObject(keys) || !("iam:PassedToService" in keys)) continue;
    found = stringList(keys["iam:PassedToService"]) ?? ["?"];
  }
  return found;
}

/** Earliest line at or after `fromLine` containing `token`, else `fromLine`. */
function lineAfter(text: string, token: string | undefined, fromLine: number): number {
  if (!token) return fromLine;
  const lines = text.split("\n");
  for (let i = Math.max(0, fromLine - 1); i < lines.length; i++) {
    if (lines[i].includes(token)) return i + 1;
  }
  return fromLine;
}

/** Parse a CFN policy document (object or JSON string) into statements. */
function cfnStatements(
  doc: unknown,
  ctx: CfnCtx,
  sectionLine: number,
): { statements: Statement[]; unknown?: string } {
  let parsed = doc;
  if (typeof doc === "string") {
    try {
      parsed = JSON.parse(doc);
    } catch {
      return { statements: [], unknown: "policy document is not JSON" };
    }
  }
  if (!isObject(parsed)) {
    return { statements: [], unknown: "policy document is unresolved" };
  }
  const out: Statement[] = [];
  for (const st of listOf(parsed.Statement)) {
    if (!isObject(st)) {
      return { statements: [], unknown: "statement is not an object" };
    }
    out.push(cfnOneStatement(st, ctx, sectionLine));
  }
  return { statements: out };
}

function cfnOneStatement(
  st: Record<string, unknown>,
  ctx: CfnCtx,
  sectionLine: number,
): Statement {
  const actions = stringList(st.Action);
  const effect = st.Effect === "Deny" ? "Deny" : "Allow";
  // NotAction / NotResource / NotPrincipal, a non-literal Action, or an
  // Effect that is neither Allow nor Deny cannot be evaluated statically.
  const unsupported = "NotAction" in st || "NotResource" in st ||
    "NotPrincipal" in st || actions === null ||
    (st.Effect !== undefined && st.Effect !== "Allow" && st.Effect !== "Deny");
  const resources = listOf(st.Resource).map((r) => cfnRef(r, ctx));
  const principals: { type: string; values: Ref[] }[] = [];
  if (st.Principal === "*") {
    principals.push({ type: "*", values: [{ kind: "literal", value: "*" }] });
  } else if (isObject(st.Principal)) {
    for (const [type, vals] of Object.entries(st.Principal)) {
      principals.push({ type, values: listOf(vals).map((v) => cfnRef(v, ctx)) });
    }
  }
  const condition = st.Condition;
  const acts = actions ?? [];
  const token = acts[0] ?? (resources[0]?.kind === "literal"
    ? resources[0].value
    : undefined);
  return {
    effect,
    actions: acts,
    resources,
    principals,
    conditions: conditionTexts(condition),
    conditioned: isObject(condition) && Object.keys(condition).length > 0,
    passedToService: passedToServiceOf(condition),
    resourceTags: resourceTagsOf(condition),
    loc: { file: ctx.file, line: lineAfter(ctx.text, token, sectionLine) },
    text: clean(
      typeof st.Sid === "string" ? st.Sid : acts.join(", ") || "statement",
    ),
    unsupported,
  };
}

/** An AdministratorAccess-equivalent policy: Allow * on *. */
function administratorPolicy(loc: Loc, name: string): PolicyDoc {
  return {
    name,
    loc,
    statements: [{
      effect: "Allow",
      actions: ["*"],
      resources: [{ kind: "literal", value: "*" }],
      principals: [],
      conditions: [],
      conditioned: false,
      loc,
      text: "AdministratorAccess",
      unsupported: false,
    }],
  };
}

/** Attach a policy to a role; unsupported statements become unresolved. */
function addPolicy(role: RoleIr, doc: PolicyDoc): void {
  if (role.policies.some((p) => p.name === doc.name)) return;
  role.policies.push(doc);
  for (const st of doc.statements) {
    if (st.unsupported) {
      role.unresolvedPolicies.push({
        text: clean(`${doc.name} statement ${st.text} (NotAction/NotResource)`),
        loc: st.loc,
      });
    }
  }
}

/** Build a model from a parsed policy result, or record it as unresolved. */
function addPolicyOrUnknown(
  role: RoleIr,
  name: string,
  parsed: { statements: Statement[]; unknown?: string },
  loc: Loc,
): void {
  if (parsed.unknown !== undefined) {
    role.unresolvedPolicies.push({
      text: clean(`${name}: ${parsed.unknown}`),
      loc,
    });
    return;
  }
  addPolicy(role, { name, loc, statements: parsed.statements });
}

/* ------------------------------------------------------------------------ */
/* CloudFormation model builder                                              */
/* ------------------------------------------------------------------------ */

function cfnTags(value: unknown): { tags: Record<string, string>; visible: boolean } {
  const tags: Record<string, string> = {};
  let visible = true;
  for (const t of listOf(value)) {
    if (!isObject(t) || typeof t.Key !== "string") continue;
    if (typeof t.Value === "string") tags[t.Key] = t.Value;
    else visible = false;
  }
  return { tags, visible };
}

/** Add one CloudFormation template's IAM-relevant resources to the model. */
function addCfnTemplate(model: Model, file: string, text: string): void {
  const doc = parseCfnDocument(text);
  if (doc === null) {
    model.notChecked.push(`${file}: not parseable as CloudFormation`);
    return;
  }
  const resources = isObject(doc.Resources) ? doc.Resources : {};
  const params = isObject(doc.Parameters) ? Object.keys(doc.Parameters) : [];
  addIamResources(
    model,
    file,
    text,
    resources,
    params,
    (id) => resourceLine(text, id),
  );
}

/**
 * Add the IAM-relevant resources of one file (CloudFormation-shaped, so
 * Terraform is normalised into the same shape) to the model.
 */
function addIamResources(
  model: Model,
  file: string,
  text: string,
  resources: Record<string, unknown>,
  params: string[],
  lineOf: (id: string) => number,
): void {
  const ctx: CfnCtx = {
    file,
    text,
    resources,
    lineOf,
    resourceIds: new Set(Object.keys(resources)),
    paramIds: new Set(params),
    typeOf: new Map(
      Object.entries(resources).map(([id, r]) => [
        id,
        isObject(r) && typeof r.Type === "string" ? r.Type : "",
      ]),
    ),
  };
  const entries = Object.entries(resources).filter(([, r]) => isObject(r));
  const managed = new Map<string, PolicyDoc | undefined>();
  const managedUnknown = new Map<string, { text: string; loc: Loc }>();

  // Pass 1: managed policies, roles (shells), profiles and instances.
  for (const [id, r] of entries) {
    const props = isObject(r.Properties) ? r.Properties : {};
    const line = ctx.lineOf(id);
    if (r.Type === "AWS::IAM::ManagedPolicy") {
      const parsed = cfnStatements(props.PolicyDocument, ctx, line);
      if (parsed.unknown !== undefined) {
        managedUnknown.set(id, {
          text: clean(`${id}: ${parsed.unknown}`),
          loc: { file, line },
        });
      } else {
        managed.set(id, { name: id, loc: { file, line }, statements: parsed.statements });
      }
    } else if (r.Type === "AWS::IAM::Role") {
      const tags = cfnTags(props.Tags);
      model.roles.push({
        id,
        kind: "cfn",
        file,
        line,
        roleName: typeof props.RoleName === "string" ? props.RoleName : undefined,
        description: typeof props.Description === "string"
          ? clean(props.Description)
          : undefined,
        tags: tags.tags,
        trust: [],
        trustUnknown: [],
        policies: [],
        unresolvedPolicies: [],
      });
    } else if (r.Type === "AWS::IAM::InstanceProfile") {
      const roles = listOf(props.Roles);
      model.profiles.push({
        id,
        loc: { file, line },
        role: roles.length === 1
          ? cfnRef(roles[0], ctx)
          : { kind: "unknown", text: "profile roles not a single role" },
      });
    } else if (r.Type === "AWS::EC2::Instance") {
      const tags = cfnTags(props.Tags);
      model.instances.push({
        id,
        file,
        line,
        tags: tags.tags,
        tagsVisible: tags.visible,
        profile: cfnRef(props.IamInstanceProfile, ctx),
      });
    }
  }

  // Pass 2: role trust, inline and managed policies, and boundary.
  for (const [id, r] of entries) {
    if (r.Type !== "AWS::IAM::Role") continue;
    const role = model.roles.find((x) => x.id === id && x.file === file);
    if (!role) continue;
    const props = isObject(r.Properties) ? r.Properties : {};
    const trust = cfnStatements(props.AssumeRolePolicyDocument, ctx, role.line);
    if (trust.unknown !== undefined) {
      role.trustUnknown.push({ text: clean(trust.unknown), loc: { file, line: role.line } });
    } else {
      role.trust = trust.statements;
    }
    for (const p of listOf(props.Policies)) {
      if (!isObject(p)) continue;
      const name = typeof p.PolicyName === "string" ? p.PolicyName : "inline";
      addPolicyOrUnknown(
        role,
        name,
        cfnStatements(p.PolicyDocument, ctx, role.line),
        { file, line: role.line },
      );
    }
    for (const arn of listOf(props.ManagedPolicyArns)) {
      resolveCfnManaged(model, role, arn, ctx, managed, managedUnknown);
    }
    if (props.PermissionsBoundary !== undefined) {
      role.boundary = resolveCfnBoundary(props.PermissionsBoundary, ctx, managed, role.line);
    }
  }

  // Pass 3: AWS::IAM::Policy and AWS::IAM::ManagedPolicy attached via Roles.
  for (const [id, r] of entries) {
    if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::ManagedPolicy") continue;
    const props = isObject(r.Properties) ? r.Properties : {};
    const line = ctx.lineOf(id);
    const loc = { file, line };
    const parsed = cfnStatements(props.PolicyDocument, ctx, line);
    for (const roleRef of listOf(props.Roles)) {
      const ref = cfnRef(roleRef, ctx);
      if (ref.kind === "ref") {
        const role = model.roles.find((x) => x.id === ref.target && x.file === file);
        if (!role) continue;
        addPolicyOrUnknown(role, id, parsed, loc);
      } else {
        for (const role of model.roles.filter((x) => x.file === file)) {
          role.unresolvedPolicies.push({
            text: clean(`${id} attaches to a role that is not resolvable`),
            loc,
          });
        }
      }
    }
  }
}

/** Resolve one ManagedPolicyArns entry onto a role. */
function resolveCfnManaged(
  model: Model,
  role: RoleIr,
  arn: unknown,
  ctx: CfnCtx,
  managed: Map<string, PolicyDoc | undefined>,
  managedUnknown: Map<string, { text: string; loc: Loc }>,
): void {
  const loc = { file: ctx.file, line: role.line };
  const ref = cfnRef(arn, ctx);
  if (ref.kind === "ref") {
    if (ctx.typeOf.get(ref.target) === "AWS::IAM::ManagedPolicy") {
      const doc = managed.get(ref.target);
      if (doc) addPolicy(role, doc);
      const broken = managedUnknown.get(ref.target);
      if (broken) role.unresolvedPolicies.push(broken);
      return;
    }
    role.unresolvedPolicies.push({
      text: clean(`ManagedPolicyArns ${ref.target} is not an in-repo managed policy`),
      loc,
    });
    return;
  }
  if (ref.kind === "literal") {
    if (ref.value === "arn:aws:iam::aws:policy/AdministratorAccess") {
      addPolicy(role, administratorPolicy(loc, "AdministratorAccess"));
      return;
    }
    role.unresolvedPolicies.push({
      text: clean(`managed policy ${ref.value} is not resolved`),
      loc,
    });
    return;
  }
  role.unresolvedPolicies.push({ text: clean(`managed policy ${ref.text} is unknown`), loc });
}

/** Resolve a PermissionsBoundary value. */
function resolveCfnBoundary(
  value: unknown,
  ctx: CfnCtx,
  managed: Map<string, PolicyDoc | undefined>,
  line: number,
): NonNullable<RoleIr["boundary"]> {
  const loc = { file: ctx.file, line };
  const ref = cfnRef(value, ctx);
  if (ref.kind === "ref") {
    const doc = managed.get(ref.target);
    if (doc) return { kind: "resolved", policy: doc };
  }
  if (ref.kind === "literal" && ref.value === "arn:aws:iam::aws:policy/AdministratorAccess") {
    return { kind: "resolved", policy: administratorPolicy(loc, "AdministratorAccess") };
  }
  const text = ref.kind === "literal" ? ref.value : ref.kind === "ref"
    ? ref.target
    : ref.text;
  return { kind: "unresolved", text: clean(text), loc };
}

/* ------------------------------------------------------------------------ */
/* Terraform adapter                                                         */
/* ------------------------------------------------------------------------ */

/** Terraform resource types the scan models, keyed to their CFN-shaped type. */
const TF_TYPES: Record<string, string> = {
  aws_iam_role: "AWS::IAM::Role",
  aws_iam_policy: "AWS::IAM::ManagedPolicy",
  aws_iam_role_policy: "AWS::IAM::Policy",
  aws_iam_instance_profile: "AWS::IAM::InstanceProfile",
  aws_instance: "AWS::EC2::Instance",
};

/** Attributes of an aws_iam_policy_document that cannot be read statically. */
const TF_DOC_UNSUPPORTED = [
  "source_json",
  "override_json",
  "source_policy_documents",
  "override_policy_documents",
];

/**
 * An HCL value as a CFN-shaped value: an in-repo reference becomes
 * `{"Fn::GetAtt": [address, attr]}` (so the shared reference logic resolves
 * it), and anything else that is a reference or unknown becomes an unknown
 * `{"Ref": "unknown:..."}`.
 */
function tfToJs(v: HclValue | undefined): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => tfToJs(x));
  if (isHclRef(v)) {
    const parts = v.ref.split(".");
    if (parts.length >= 2 && Object.hasOwn(TF_TYPES, parts[0])) {
      return {
        "Fn::GetAtt": [
          `${parts[0]}.${parts[1]}`,
          parts.slice(2).join(".") || "Arn",
        ],
      };
    }
    return { Ref: `unknown:${v.ref}` };
  }
  if (isHclUnknown(v)) return { Ref: `unknown:${v.unknown}` };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = tfToJs(x);
  return out;
}

/** A policy attribute: a data document reference, JSON text, or an object. */
function tfPolicyJs(
  v: HclValue | undefined,
  dataDocs: Map<string, unknown>,
): unknown {
  if (v === undefined || v === null) return { Ref: "unknown:missing policy" };
  if (isHclRef(v) && v.ref.startsWith("data.aws_iam_policy_document.")) {
    const address = v.ref.split(".").slice(0, 3).join(".");
    return dataDocs.get(address) ?? { Ref: `unknown:${v.ref}` };
  }
  if (typeof v === "string") return v;
  return tfToJs(v);
}

/** An aws_iam_policy_document data block as a CFN-shaped policy object. */
function dataDocToJs(block: HclBlock): unknown {
  if (TF_DOC_UNSUPPORTED.some((k) => k in block.attrs)) {
    return { Ref: "unknown:source or override document" };
  }
  const statements: Record<string, unknown>[] = [];
  for (const child of block.blocks) {
    if (child.type !== "statement") {
      return { Ref: "unknown:dynamic statement" };
    }
    const a = child.attrs;
    const st: Record<string, unknown> = {};
    if (a.effect !== undefined) st.Effect = tfToJs(a.effect);
    if (a.actions !== undefined) st.Action = tfToJs(a.actions);
    if (a.resources !== undefined) st.Resource = tfToJs(a.resources);
    if (a.not_actions !== undefined) st.NotAction = tfToJs(a.not_actions);
    if (a.not_resources !== undefined) st.NotResource = tfToJs(a.not_resources);
    if (a.sid !== undefined) st.Sid = tfToJs(a.sid);
    const principal: Record<string, unknown> = {};
    const condition: Record<string, Record<string, unknown>> = {};
    for (const p of child.blocks) {
      if (p.type === "principals") {
        const type = typeof p.attrs.type === "string" ? p.attrs.type : "unknown";
        principal[type] = tfToJs(p.attrs.identifiers);
      } else if (p.type === "not_principals") {
        st.NotPrincipal = true;
      } else if (p.type === "condition") {
        const test = typeof p.attrs.test === "string" ? p.attrs.test : "unknown";
        const variable = typeof p.attrs.variable === "string"
          ? p.attrs.variable
          : "unknown";
        condition[test] ??= {};
        condition[test][variable] = tfToJs(p.attrs.values);
      }
    }
    if (Object.keys(principal).length > 0) st.Principal = principal;
    if (Object.keys(condition).length > 0) st.Condition = condition;
    statements.push(st);
  }
  return { Statement: statements };
}

/** Tags object as `[{Key, Value}]`; a non-literal value stays unknown. */
function tfTagList(v: HclValue | undefined): unknown[] {
  if (
    v === undefined || v === null || typeof v !== "object" ||
    Array.isArray(v) || isHclRef(v) || isHclUnknown(v)
  ) {
    return [];
  }
  return Object.entries(v).map(([Key, val]) => ({
    Key,
    Value: typeof val === "string" ? val : { Ref: "unknown:tag value" },
  }));
}

/** Add one Terraform file's IAM-relevant blocks to the model. */
function addTfFile(model: Model, file: string, text: string): void {
  const parsed = parseHcl(text);
  if (parsed.errors.length > 0) {
    model.notChecked.push(
      `${file}: HCL not parseable (${clean(parsed.errors[0])})`,
    );
    return;
  }
  const dataDocs = new Map<string, unknown>();
  for (const b of parsed.blocks) {
    if (b.type === "data" && b.labels[0] === "aws_iam_policy_document" && b.labels[1]) {
      dataDocs.set(`data.aws_iam_policy_document.${b.labels[1]}`, dataDocToJs(b));
    }
  }
  const resources: Record<string, unknown> = {};
  const lines = new Map<string, number>();
  const attachments: HclBlock[] = [];
  for (const b of parsed.blocks) {
    if (b.type !== "resource" || b.labels.length !== 2) continue;
    const address = `${b.labels[0]}.${b.labels[1]}`;
    const a = b.attrs;
    if (b.labels[0] === "aws_iam_role_policy_attachment") {
      attachments.push(b);
      continue;
    }
    const type = TF_TYPES[b.labels[0]];
    if (type === undefined) continue;
    lines.set(address, b.line);
    const props: Record<string, unknown> = {};
    if (b.labels[0] === "aws_iam_role") {
      if (typeof a.name === "string") props.RoleName = a.name;
      if (typeof a.description === "string") props.Description = a.description;
      props.Tags = tfTagList(a.tags);
      props.AssumeRolePolicyDocument = tfPolicyJs(a.assume_role_policy, dataDocs);
      if (a.permissions_boundary !== undefined) {
        props.PermissionsBoundary = tfToJs(a.permissions_boundary);
      }
    } else if (b.labels[0] === "aws_iam_policy") {
      props.PolicyDocument = tfPolicyJs(a.policy, dataDocs);
    } else if (b.labels[0] === "aws_iam_role_policy") {
      props.Roles = [tfToJs(a.role)];
      props.PolicyDocument = tfPolicyJs(a.policy, dataDocs);
    } else if (b.labels[0] === "aws_iam_instance_profile") {
      props.Roles = [tfToJs(a.role)];
    } else if (b.labels[0] === "aws_instance") {
      props.IamInstanceProfile = tfToJs(a.iam_instance_profile);
      props.Tags = tfTagList(a.tags);
    }
    resources[address] = { Type: type, Properties: props };
  }
  // Attachments add managed policies to the role they name; an attachment
  // whose role cannot be resolved may attach to any role, so it is unknown
  // for every role in the file.
  for (const att of attachments) {
    const role = tfToJs(att.attrs.role);
    const arn = tfToJs(att.attrs.policy_arn);
    const target = isObject(role) && Array.isArray(role["Fn::GetAtt"])
      ? String(role["Fn::GetAtt"][0])
      : undefined;
    const synthetic = target !== undefined ? resources[target] : undefined;
    const roleResources = Object.values(resources).filter((r) =>
      isObject(r) && r.Type === "AWS::IAM::Role"
    );
    if (isObject(synthetic) && synthetic.Type === "AWS::IAM::Role") {
      const props = synthetic.Properties as Record<string, unknown>;
      props.ManagedPolicyArns = [
        ...(Array.isArray(props.ManagedPolicyArns) ? props.ManagedPolicyArns : []),
        arn,
      ];
    } else {
      for (const r of roleResources) {
        const props = (r as { Properties: Record<string, unknown> }).Properties;
        props.ManagedPolicyArns = [
          ...(Array.isArray(props.ManagedPolicyArns) ? props.ManagedPolicyArns : []),
          { Ref: "unknown:attachment to an unresolved role" },
        ];
      }
    }
  }
  addIamResources(
    model,
    file,
    text,
    resources,
    [],
    (id) => lines.get(id) ?? 0,
  );
}

/** ssm:resourceTag/K and aws:ResourceTag/K condition keys with their values. */
function resourceTagsOf(
  condition: unknown,
): { key: string; values: string[] | null }[] {
  const out: { key: string; values: string[] | null }[] = [];
  if (!isObject(condition)) return out;
  for (const keys of Object.values(condition)) {
    if (!isObject(keys)) continue;
    for (const [key, vals] of Object.entries(keys)) {
      const m = /^(?:ssm|aws):resourcetag\/(.+)$/i.exec(key);
      if (!m) continue;
      out.push({ key: m[1], values: stringList(vals) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Evaluator                                                                 */
/* ------------------------------------------------------------------------ */

type Match = "match" | "possible" | "no";

/** A role or an instance a grant's resource may name. */
interface TargetRef {
  kind: "role" | "instance";
  id: string;
  file: string;
  roleName?: string;
  tags?: Record<string, string>;
  tagsVisible?: boolean;
  line: number;
}

/** One action on one resource, from one Allow or Deny statement. */
interface Grant {
  action: string;
  res: Ref;
  stmt: Statement;
}

/** Actions the scan treats as privileged (see the module brief). */
const PRIVILEGED = [
  "*",
  "iam:*",
  "sts:*",
  "organizations:*",
  "kms:*",
  "secretsmanager:*",
  "ssm:*",
  "ec2:*",
  "lambda:*",
  "iam:PassRole",
  "iam:CreateRole",
  "iam:CreateAccessKey",
  "iam:UpdateAssumeRolePolicy",
  "iam:Put*Policy",
  "iam:Attach*Policy",
  "iam:CreatePolicyVersion",
  "sts:AssumeRole",
  "ssm:SendCommand",
  "ssm:StartSession",
  "secretsmanager:GetSecretValue",
  "kms:Decrypt",
];

/** Whether a grant action pattern covers a literal action (glob, case-insensitive). */
function actionCovers(pattern: string, action: string): boolean {
  return globMatch(pattern, action);
}

/** Whether a grant action pattern is privileged: it matches a listed action in either direction. */
function isPrivilegedAction(action: string): boolean {
  return PRIVILEGED.some((p) =>
    globMatch(action, p) || (p !== "*" && globMatch(p, action))
  );
}

/** The part of an ARN after the fifth colon, or the value itself when not an ARN. */
function arnTail(value: string): string {
  return value.startsWith("arn:") ? value.split(":").slice(5).join(":") : value;
}

/** A literal resource that names every resource (`*` or an account-wide `*` ARN). */
function isWildcardRes(r: Ref): boolean {
  return r.kind === "literal" && (r.value === "*" || arnTail(r.value) === "*");
}

/**
 * Whether a resource value names `t`. `fromFile` scopes reference matching
 * to the file the reference was written in. Literal ARNs match a role by
 * the glob of their name against the target's literal name; an instance's
 * literal ARN cannot be tied to it, so it is only possible. Tag conditions
 * (SSM only) are checked against the instance's statically visible tags.
 */
function classify(
  r: Ref,
  t: TargetRef,
  fromFile: string,
  tagConds: { key: string; values: string[] | null }[] = [],
): Match {
  if (r.kind === "unknown") return "possible";
  let base: Match;
  if (r.kind === "ref") {
    base = r.target === t.id && t.file === fromFile ? "match" : "no";
  } else if (isWildcardRes(r)) {
    base = "match";
  } else if (!r.value.startsWith("arn:")) {
    base = "no";
  } else {
    const tail = arnTail(r.value);
    if (t.kind === "instance") {
      base = tail.startsWith("instance/") ? "possible" : "no";
    } else if (!tail.startsWith("role/")) {
      base = "no";
    } else if (t.roleName === undefined) {
      base = "possible";
    } else {
      const name = tail.slice(tail.lastIndexOf("/") + 1);
      base = globMatch(name, t.roleName) ? "match" : "no";
    }
  }
  if (base !== "match") return base;
  for (const tc of tagConds) {
    if (t.tagsVisible !== true || t.tags === undefined) return "possible";
    if (tc.values === null) return "possible";
    const value = t.tags[tc.key];
    if (value === undefined || !tc.values.includes(value)) return "no";
  }
  return base;
}

/** Expand the statements of the given effect into per-action, per-resource grants. */
function expandGrants(docs: PolicyDoc[], effect: "Allow" | "Deny"): Grant[] {
  const out: Grant[] = [];
  for (const doc of docs) {
    for (const st of doc.statements) {
      if (st.effect !== effect || st.unsupported) continue;
      for (const action of st.actions) {
        for (const res of st.resources) out.push({ action, res, stmt: st });
      }
    }
  }
  return out;
}

/**
 * The grants a role effectively holds: its Allow grants minus those removed by
 * an unconditioned wildcard Deny, and (when resolved) those its permissions
 * boundary does not allow. An unresolved boundary does not filter here; the
 * caller marks the chain incomplete instead.
 */
function effectiveGrants(role: RoleIr): Grant[] {
  const allows = expandGrants(role.policies, "Allow");
  const denies = expandGrants(role.policies, "Deny").filter((d) =>
    !d.stmt.conditioned && isWildcardRes(d.res)
  );
  const boundary = role.boundary?.kind === "resolved"
    ? [role.boundary.policy]
    : [];
  const bAllows = expandGrants(boundary, "Allow");
  const bDenies = expandGrants(boundary, "Deny").filter((d) =>
    !d.stmt.conditioned && isWildcardRes(d.res)
  );
  return allows.filter((g) =>
    !denies.some((d) => actionCovers(d.action, g.action)) &&
    (boundary.length === 0 || (
      bAllows.some((b) =>
        actionCovers(b.action, g.action) && coversRes(b.res, g.res)
      ) && !bDenies.some((d) => actionCovers(d.action, g.action))
    ))
  );
}

/** Whether a pattern resource covers a value resource (wildcard, same reference, or glob). */
function coversRes(pattern: Ref, value: Ref): boolean {
  if (isWildcardRes(pattern)) return true;
  if (pattern.kind === "ref" && value.kind === "ref") {
    return pattern.target === value.target;
  }
  if (pattern.kind === "literal" && value.kind === "literal") {
    return globMatch(pattern.value, value.value);
  }
  return false;
}

/** Whether `role` holds `action` on every resource (a wildcard grant). */
function holdsWildcard(grants: Grant[], action: string): boolean {
  return grants.some((g) =>
    isWildcardRes(g.res) && actionCovers(g.action, action)
  );
}

/** The privileged wildcard grants of `t` that `c` does not also hold. */
function extraGrants(t: Grant[], c: Grant[]): Grant[] {
  return t.filter((g) =>
    isWildcardRes(g.res) && isPrivilegedAction(g.action) &&
    !holdsWildcard(c, g.action)
  );
}

/** Whether an unconditioned Deny in `role` removes `action` on `target`. */
function deniedOn(
  role: RoleIr,
  action: string,
  target: TargetRef,
  fromFile: string,
  tagConds: { key: string; values: string[] | null }[] = [],
): { denied: boolean; possible: boolean } {
  let denied = false;
  let possible = false;
  for (const d of expandGrants(role.policies, "Deny")) {
    if (d.stmt.conditioned || !actionCovers(d.action, action)) continue;
    const m = classify(d.res, target, fromFile, tagConds);
    if (m === "match") denied = true;
    if (m === "possible") possible = true;
  }
  return { denied, possible };
}

/** Whether `role`'s resolved boundary allows `action` on `target`. */
function boundaryAllows(
  role: RoleIr,
  action: string,
  target: TargetRef,
  fromFile: string,
): boolean {
  if (role.boundary?.kind !== "resolved") return true;
  const doc = [role.boundary.policy];
  return expandGrants(doc, "Allow").some((b) =>
    actionCovers(b.action, action) &&
    classify(b.res, target, fromFile) === "match"
  );
}

/** Principal values a trust statement names for one principal type. */
function principalValues(st: Statement, types: string[]): Ref[] {
  return st.principals
    .filter((p) => types.some((t) => p.type.toLowerCase() === t.toLowerCase()))
    .flatMap((p) => p.values);
}

interface TrustEval {
  /** Trust admits the caller (or service) through an unblocked Allow. */
  admitted: boolean;
  /** Admitting trust statement, for the hop. */
  loc?: Loc;
  text: string;
  conditions: string[];
  /** An unknown principal could admit the caller. */
  unknownPrincipal?: string;
  /** Trust denies the caller unconditionally. */
  blocked: boolean;
}

/**
 * Whether the trust policy of `t` admits `caller` (mode "aws") or the
 * service principal `service`, for sts:AssumeRole. An account root principal
 * admits the caller because the root delegates to its identity policies.
 */
function trustEval(
  t: RoleIr,
  caller: RoleIr | undefined,
  service: string | undefined,
): TrustEval {
  const out: TrustEval = {
    admitted: false,
    text: "",
    conditions: [],
    blocked: false,
  };
  if (t.trustUnknown.length > 0) {
    out.unknownPrincipal = t.trustUnknown[0].text;
  }
  for (const st of t.trust) {
    if (st.unsupported) {
      out.unknownPrincipal ??= "trust statement uses NotPrincipal/NotAction";
      continue;
    }
    if (!st.actions.some((a) => actionCovers(a, "sts:AssumeRole"))) continue;
    const awsValues = principalValues(st, ["AWS"]);
    const svcValues = principalValues(st, ["Service"]);
    const anyValues = principalValues(st, ["*"]);
    const callerHit = caller !== undefined && (
      awsValues.some((v) => roleValueIs(v, caller, t.file)) ||
      anyValues.length > 0
    );
    if (st.effect === "Deny") {
      if (!st.conditioned && callerHit) out.blocked = true;
      out.conditions.push(...st.conditions);
      continue;
    }
    if (service !== undefined) {
      if (anyValues.length > 0 || svcValues.some((v) =>
        v.kind === "literal" && v.value.toLowerCase() === service.toLowerCase()
      )) {
        out.admitted = true;
        out.loc ??= st.loc;
        out.text = `${t.id} trusts ${service}`;
        out.conditions.push(...st.conditions);
      } else if (svcValues.some((v) => v.kind !== "literal")) {
        out.unknownPrincipal ??= `trust principal of ${t.id} is ${
          clean(svcValues.map(valueText).join(", "))
        }`;
      }
      continue;
    }
    if (callerHit) {
      out.admitted = true;
      out.loc ??= st.loc;
      out.text = `${t.id} trusts ${caller?.id ?? "the caller"}`;
      out.conditions.push(...st.conditions);
      continue;
    }
    // Only a value that could name the caller and cannot be decided is unknown.
    const undecided = awsValues.filter((v) =>
      v.kind === "unknown" ||
      (v.kind === "literal" && arnTail(v.value).startsWith("role/") &&
        caller?.roleName === undefined)
    );
    if (undecided.length > 0) {
      out.unknownPrincipal ??= `trust principal of ${t.id} is ${
        clean(undecided.map(valueText).join(", "))
      }`;
    }
  }
  if (out.blocked) out.admitted = false;
  return out;
}

/** Text of a principal value for citations. */
function valueText(v: Ref): string {
  if (v.kind === "ref") return v.target;
  if (v.kind === "literal") return v.value;
  return v.text;
}

/** Whether a principal value names `caller` (by reference, role name, or account root). */
function roleValueIs(v: Ref, caller: RoleIr, fromFile: string): boolean {
  if (v.kind === "ref") return v.target === caller.id && caller.file === fromFile;
  if (v.kind !== "literal") return false;
  if (v.value === "*") return true;
  if (/^arn:aws:iam::[^:]*:root$/.test(v.value)) return true;
  const tail = arnTail(v.value);
  if (!tail.startsWith("role/") || caller.roleName === undefined) return false;
  return globMatch(tail.slice(tail.lastIndexOf("/") + 1), caller.roleName);
}
