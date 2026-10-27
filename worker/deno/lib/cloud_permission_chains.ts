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
  return {
    kind: "unknown",
    text: clean(`${name} (parameter or pseudo value)`),
  };
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
    return {
      kind: "unknown",
      text: clean(`${value} (parameter or pseudo value)`),
    };
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
  const lid = lone?.[1];
  if (lid !== undefined && ctx.resourceIds.has(lid)) {
    return { kind: "ref", target: lid };
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

/**
 * Line of the first occurrence of `token` at or after `fromLine`, else the
 * first occurrence anywhere in the file, else `fromLine`. A statement's
 * cited line therefore contains its token whenever the token appears at all.
 */
function lineAfter(
  text: string,
  token: string | undefined,
  fromLine: number,
): number {
  if (!token) return fromLine;
  const lines = text.split("\n");
  const from = Math.max(0, fromLine - 1);
  for (let i = from; i < lines.length; i++) {
    if ((lines[i] ?? "").includes(token)) return i + 1;
  }
  for (let i = 0; i < from; i++) {
    if ((lines[i] ?? "").includes(token)) return i + 1;
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
      principals.push({
        type,
        values: listOf(vals).map((v) => cfnRef(v, ctx)),
      });
    }
  }
  const condition = st.Condition;
  const acts = actions ?? [];
  const token = acts[0] ??
    (resources[0]?.kind === "literal" ? resources[0].value : undefined);
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
      resourceTags: [],
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

function cfnTags(
  value: unknown,
): { tags: Record<string, string>; visible: boolean } {
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
  const entries = Object.entries(resources).filter(
    (e): e is [string, Record<string, unknown>] => isObject(e[1]),
  ).map((e): [string, Record<string, unknown>] => [e[0], e[1]]);
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
        managed.set(id, {
          name: id,
          loc: { file, line },
          statements: parsed.statements,
        });
      }
    } else if (r.Type === "AWS::IAM::Role") {
      const tags = cfnTags(props.Tags);
      model.roles.push({
        id,
        file,
        line,
        roleName: typeof props.RoleName === "string"
          ? props.RoleName
          : undefined,
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
      role.trustUnknown.push({
        text: clean(trust.unknown),
        loc: { file, line: role.line },
      });
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
      resolveCfnManaged(role, arn, ctx, managed, managedUnknown);
    }
    if (props.PermissionsBoundary !== undefined) {
      role.boundary = resolveCfnBoundary(
        props.PermissionsBoundary,
        ctx,
        managed,
        role.line,
      );
    }
  }

  // Pass 3: AWS::IAM::Policy and AWS::IAM::ManagedPolicy attached via Roles.
  for (const [id, r] of entries) {
    if (r.Type !== "AWS::IAM::Policy" && r.Type !== "AWS::IAM::ManagedPolicy") {
      continue;
    }
    const props = isObject(r.Properties) ? r.Properties : {};
    const line = ctx.lineOf(id);
    const loc = { file, line };
    const parsed = cfnStatements(props.PolicyDocument, ctx, line);
    for (const roleRef of listOf(props.Roles)) {
      const ref = cfnRef(roleRef, ctx);
      if (ref.kind === "ref") {
        const role = model.roles.find((x) =>
          x.id === ref.target && x.file === file
        );
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
      text: clean(
        `ManagedPolicyArns ${ref.target} is not an in-repo managed policy`,
      ),
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
  role.unresolvedPolicies.push({
    text: clean(`managed policy ${ref.text} is unknown`),
    loc,
  });
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
  if (
    ref.kind === "literal" &&
    ref.value === "arn:aws:iam::aws:policy/AdministratorAccess"
  ) {
    return {
      kind: "resolved",
      policy: administratorPolicy(loc, "AdministratorAccess"),
    };
  }
  const text = ref.kind === "literal"
    ? ref.value
    : ref.kind === "ref"
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
    if (parts.length >= 2 && Object.hasOwn(TF_TYPES, parts[0] ?? "")) {
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
        const type = typeof p.attrs.type === "string"
          ? p.attrs.type
          : "unknown";
        principal[type] = tfToJs(p.attrs.identifiers);
      } else if (p.type === "not_principals") {
        st.NotPrincipal = true;
      } else if (p.type === "condition") {
        const test = typeof p.attrs.test === "string"
          ? p.attrs.test
          : "unknown";
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
      `${file}: HCL not parseable (${clean(parsed.errors[0] ?? "")})`,
    );
    return;
  }
  const dataDocs = new Map<string, unknown>();
  for (const b of parsed.blocks) {
    if (
      b.type === "data" && b.labels[0] === "aws_iam_policy_document" &&
      b.labels[1]
    ) {
      dataDocs.set(
        `data.aws_iam_policy_document.${b.labels[1]}`,
        dataDocToJs(b),
      );
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
    const type = TF_TYPES[b.labels[0] ?? ""];
    if (type === undefined) continue;
    lines.set(address, b.line);
    const props: Record<string, unknown> = {};
    if (b.labels[0] === "aws_iam_role") {
      if (typeof a.name === "string") props.RoleName = a.name;
      if (typeof a.description === "string") props.Description = a.description;
      props.Tags = tfTagList(a.tags);
      props.AssumeRolePolicyDocument = tfPolicyJs(
        a.assume_role_policy,
        dataDocs,
      );
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
        ...(Array.isArray(props.ManagedPolicyArns)
          ? props.ManagedPolicyArns
          : []),
        arn,
      ];
    } else {
      for (const r of roleResources) {
        const props = (r as { Properties: Record<string, unknown> }).Properties;
        props.ManagedPolicyArns = [
          ...(Array.isArray(props.ManagedPolicyArns)
            ? props.ManagedPolicyArns
            : []),
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
      out.push({ key: m[1] ?? "", values: stringList(vals) });
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
  kind?: "role" | "instance";
  id: string;
  file: string;
  roleName?: string;
  tags?: Record<string, string>;
  tagsVisible?: boolean;
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

/**
 * Conditions of the conditioned Deny statements of `role` that cover `action`
 * on `target`. Such a Deny does not remove the chain, but it may narrow when
 * it applies, so its conditions are recorded on the assessment.
 */
function conditionedDenyConditions(
  role: RoleIr,
  action: string,
  target: TargetRef,
  fromFile: string,
): string[] {
  const out: string[] = [];
  for (const d of expandGrants(role.policies, "Deny")) {
    if (!d.stmt.conditioned || !actionCovers(d.action, action)) continue;
    if (classify(d.res, target, fromFile) === "match") {
      out.push(...d.stmt.conditions);
    }
  }
  return out;
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
    out.unknownPrincipal = t.trustUnknown[0]?.text;
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
      if (
        anyValues.length > 0 || svcValues.some((v) =>
          v.kind === "literal" &&
          v.value.toLowerCase() === service.toLowerCase()
        )
      ) {
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
      const viaRoot = awsValues.some((v) =>
        v.kind === "literal" && /^arn:aws:iam::[^:]*:root$/.test(v.value)
      ) && !awsValues.some((v) =>
        caller !== undefined && roleValueIs(v, caller, t.file)
      );
      out.text = viaRoot
        ? `${t.id} trusts the account root, which delegates to ${
          caller?.id ?? "the caller"
        }`
        : `${t.id} trusts ${caller?.id ?? "the caller"}`;
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
  if (v.kind === "ref") {
    return v.target === caller.id && caller.file === fromFile;
  }
  if (v.kind !== "literal") return false;
  if (v.value === "*") return true;
  if (/^arn:aws:iam::[^:]*:root$/.test(v.value)) return true;
  const tail = arnTail(v.value);
  if (!tail.startsWith("role/") || caller.roleName === undefined) return false;
  return globMatch(tail.slice(tail.lastIndexOf("/") + 1), caller.roleName);
}

/* ------------------------------------------------------------------------ */
/* Chain builders                                                            */
/* ------------------------------------------------------------------------ */

/** Declared intent on the roles, quoted, or the fixed phrase. */
function intentOf(...roles: RoleIr[]): string {
  for (const r of roles) {
    if (r.description) return `"${r.description}"`;
    for (const k of ["Purpose", "Description", "Name"]) {
      const v = r.tags[k];
      if (v) return `"${clean(v)}"`;
    }
  }
  return "none stated in the repository";
}

/** Distinct action names of a grant list, for citing what a target holds. */
function summaryOf(grants: Grant[]): string {
  return [...new Set(grants.map((g) => g.action))].join(", ");
}

/** Citations `file:line` for a grant list. */
function citeOf(grants: Grant[]): string {
  return grants.map((g) => `${g.stmt.loc.file}:${g.stmt.loc.line}`).join(", ");
}

/** The grant's statement location, or the fallback when there is no grant. */
function locOf(g: Grant | undefined, fallback: Loc): Loc {
  return g?.stmt.loc ?? fallback;
}

function callerLoc(c: RoleIr): Loc {
  return { file: c.file, line: c.line };
}

function locHop(text: string, loc: Loc): ChainHop {
  return { text: clean(text), file: loc.file, line: loc.line };
}

function unresolvedOf(role: RoleIr): string[] {
  const out: string[] = [];
  if (role.boundary?.kind === "unresolved") {
    out.push(
      clean(`caller ${role.id} boundary ${role.boundary.text} is unresolved`),
    );
  }
  return out;
}

interface Draft {
  kind: ChainKind;
  status: "chain" | "incomplete";
  caller: RoleIr;
  target: string;
  hops: ChainHop[];
  boundary: string;
  intent: string;
  conditions: string[];
  unresolved: string[];
  fix: string;
}

function finish(d: Draft): ChainAssessment {
  const conditions = [...new Set(d.conditions)].filter((c) => c.length > 0);
  return {
    kind: d.kind,
    status: d.status,
    caller: d.caller.id,
    target: d.target,
    entryFile: d.caller.file,
    entryLine: d.caller.line,
    hops: d.hops,
    boundary: clean(d.boundary, 500),
    intent: d.intent,
    conditions,
    unresolved: [...new Set(d.unresolved)],
    fix: clean(d.fix, 500),
    signature: `${d.kind}|${d.caller.id}|${d.target}`,
  };
}

/** The unknown grant text a caller holds that may name a target. */
function possibleText(g: Grant | undefined): string {
  if (g === undefined) return "an unknown resource";
  return clean(`${g.action} on ${valueText(g.res)}`);
}

/** Caller policy unknowns that may already hold the extra grants. */
function callerUnknowns(c: RoleIr, extras: Grant[]): string[] {
  if (c.unresolvedPolicies.length === 0) return [];
  const names = c.unresolvedPolicies.map((u) => u.text).join("; ");
  return [
    clean(
      `caller ${c.id} has unresolved policy/boundary ${names}: it may already hold ${
        summaryOf(extras)
      }`,
    ),
  ];
}

/** Informational unknowns on the target: they can only add grants. */
function targetInfo(t: RoleIr): string[] {
  return t.unresolvedPolicies.map((u) =>
    clean(`${t.id} has unresolved policy ${u.text} (may add grants)`)
  );
}

function assumeFix(c: RoleIr, t: RoleIr, extras: Grant[]): string {
  return `Scope the sts:AssumeRole Resource of ${c.id} to a role that does not hold ${
    summaryOf(extras)
  }, or constrain the trust policy of ${t.id} to a named principal with an sts:ExternalId/aws:PrincipalOrgID condition, or remove the unneeded grant from ${t.id}`;
}

/** Chain 1: caller C may sts:AssumeRole target T, which trusts C and holds extra grants. */
function assumeChains(
  model: Model,
  eff: Map<RoleIr, Grant[]>,
): ChainAssessment[] {
  const out: ChainAssessment[] = [];
  const action = "sts:AssumeRole";
  for (const c of model.roles) {
    const cg = eff.get(c) ?? [];
    const assumeGrants = cg.filter((g) => actionCovers(g.action, action));
    if (assumeGrants.length === 0) continue;
    for (const t of model.roles) {
      if (t === c) continue;
      const matched = assumeGrants.filter((g) =>
        classify(g.res, t, c.file) === "match" &&
        !deniedOn(c, action, t, c.file).denied
      );
      const possible = assumeGrants.filter((g) =>
        classify(g.res, t, c.file) === "possible"
      );
      if (matched.length === 0 && possible.length === 0) continue;
      if (!boundaryAllows(c, action, t, c.file)) continue;
      const trust = trustEval(t, c, undefined);
      if (trust.blocked) continue;
      if (!trust.admitted && trust.unknownPrincipal === undefined) continue;
      const extras = extraGrants(eff.get(t) ?? [], cg);
      if (extras.length === 0) continue;
      const unresolved: string[] = [];
      if (matched.length === 0) {
        unresolved.push(
          clean(
            `sts:AssumeRole of ${c.id} may name ${t.id} via ${
              possibleText(possible[0])
            }`,
          ),
        );
      }
      if (!trust.admitted && trust.unknownPrincipal) {
        unresolved.push(clean(trust.unknownPrincipal));
      }
      if (t.boundary?.kind === "unresolved") {
        unresolved.push(
          clean(`boundary of ${t.id} is unresolved: ${t.boundary.text}`),
        );
      }
      unresolved.push(...unresolvedOf(c), ...callerUnknowns(c, extras));
      const hops: ChainHop[] = [];
      if (matched.length > 0) {
        hops.push(
          locHop(
            `${c.id} may sts:AssumeRole ${t.id}`,
            locOf(matched[0], callerLoc(c)),
          ),
        );
      }
      if (trust.admitted && trust.loc) {
        hops.push(locHop(trust.text, trust.loc));
      }
      for (const g of extras) {
        hops.push(locHop(`${t.id} holds ${g.action} on *`, g.stmt.loc));
      }
      const required = matched.length > 0 && trust.admitted &&
        c.unresolvedPolicies.length === 0 &&
        c.boundary?.kind !== "unresolved" &&
        t.boundary?.kind !== "unresolved";
      unresolved.push(...targetInfo(t));
      out.push(finish({
        kind: "assume-role-escalation",
        status: required ? "chain" : "incomplete",
        caller: c,
        target: t.id,
        hops,
        boundary: `${t.id} holds ${summaryOf(extras)} on * (${
          citeOf(extras)
        }) that ${c.id} does not hold`,
        intent: intentOf(t, c),
        conditions: [
          ...matched.flatMap((g) => g.stmt.conditions),
          ...trust.conditions,
          ...conditionedDenyConditions(c, action, t, c.file),
        ],
        unresolved: unresolved.filter((u) => u.length > 0),
        fix: assumeFix(c, t, extras),
      }));
    }
  }
  return out;
}

/** Chain 2: caller C may iam:PassRole target T and start a compute resource that runs as T. */
const COMPUTE: {
  svc: string;
  actions: string[];
  link: "profile" | "direct";
}[] = [
  {
    svc: "lambda.amazonaws.com",
    actions: ["lambda:CreateFunction", "lambda:UpdateFunctionConfiguration"],
    link: "direct",
  },
  {
    svc: "ec2.amazonaws.com",
    actions: ["ec2:RunInstances", "ec2:AssociateIamInstanceProfile"],
    link: "profile",
  },
  {
    svc: "ecs-tasks.amazonaws.com",
    actions: ["ecs:RunTask", "ecs:RegisterTaskDefinition"],
    link: "direct",
  },
];

/** iam:PassedToService conditions that exclude the service remove the hop. */
function passedTo(st: Statement, svc: string): boolean {
  return st.passedToService === undefined ||
    st.passedToService.some((v) => v === "?" || globMatch(v, svc));
}

/** An in-repo instance profile carries role `t`. */
function profileLinks(model: Model, t: RoleIr): boolean {
  return model.profiles.some((p) =>
    p.role.kind === "ref" && p.role.target === t.id && p.loc.file === t.file
  );
}

function passFix(c: RoleIr, t: RoleIr, extras: Grant[]): string {
  return `Scope iam:PassRole on ${c.id} to the specific lower-privilege role and add an iam:PassedToService condition, or reduce ${t.id}'s grants (${
    summaryOf(extras)
  })`;
}

function passroleChains(
  model: Model,
  eff: Map<RoleIr, Grant[]>,
): ChainAssessment[] {
  const out: ChainAssessment[] = [];
  const action = "iam:PassRole";
  for (const c of model.roles) {
    const cg = eff.get(c) ?? [];
    const passGrants = cg.filter((g) => actionCovers(g.action, action));
    if (passGrants.length === 0) continue;
    let emitted = false;
    for (const t of model.roles) {
      if (t === c) continue;
      const pMatch = passGrants.filter((g) =>
        classify(g.res, t, c.file) === "match" &&
        !deniedOn(c, action, t, c.file).denied
      );
      const pPossible = passGrants.filter((g) =>
        classify(g.res, t, c.file) === "possible"
      );
      if (pMatch.length === 0 && pPossible.length === 0) continue;
      if (!boundaryAllows(c, action, t, c.file)) continue;
      const extras = extraGrants(eff.get(t) ?? [], cg);
      if (extras.length === 0) continue;
      const cands: {
        svc: (typeof COMPUTE)[number];
        compute: Grant;
        pass: Grant;
        trust: TrustEval;
      }[] = [];
      for (const svc of COMPUTE) {
        const compute = cg.find((g) =>
          svc.actions.some((a) => actionCovers(g.action, a))
        );
        if (!compute) continue;
        if (svc.link === "profile" && !profileLinks(model, t)) continue;
        const pass = pMatch.find((g) => passedTo(g.stmt, svc.svc));
        if (!pass) continue;
        const trust = trustEval(t, undefined, svc.svc);
        if (trust.blocked) continue;
        if (!trust.admitted && trust.unknownPrincipal === undefined) continue;
        cands.push({ svc, compute, pass, trust });
      }
      if (cands.length === 0) continue;
      emitted = true;
      const hops: ChainHop[] = [];
      const unresolved: string[] = [];
      for (const x of cands) {
        hops.push(
          locHop(
            `${c.id} may iam:PassRole ${t.id} for ${x.svc.svc}`,
            x.pass.stmt.loc,
          ),
        );
        hops.push(locHop(
          `${c.id} may ${x.compute.action} so that ${x.svc.svc} runs ${t.id}`,
          x.compute.stmt.loc,
        ));
        if (x.trust.admitted && x.trust.loc) {
          hops.push(locHop(`${t.id} trusts ${x.svc.svc}`, x.trust.loc));
        } else if (x.trust.unknownPrincipal) {
          unresolved.push(clean(x.trust.unknownPrincipal));
        }
      }
      for (const g of extras) {
        hops.push(locHop(`${t.id} holds ${g.action} on *`, g.stmt.loc));
      }
      if (pMatch.length === 0) {
        unresolved.push(
          clean(
            `iam:PassRole of ${c.id} may name ${t.id} via ${
              possibleText(pPossible[0])
            }`,
          ),
        );
      }
      if (t.boundary?.kind === "unresolved") {
        unresolved.push(
          clean(`boundary of ${t.id} is unresolved: ${t.boundary.text}`),
        );
      }
      unresolved.push(
        ...unresolvedOf(c),
        ...callerUnknowns(c, extras),
        ...targetInfo(t),
      );
      const proven = cands.some((x) => x.trust.admitted);
      const required = proven && pMatch.length > 0 &&
        c.unresolvedPolicies.length === 0 &&
        c.boundary?.kind !== "unresolved" &&
        t.boundary?.kind !== "unresolved";
      out.push(finish({
        kind: "passrole-compute",
        status: required ? "chain" : "incomplete",
        caller: c,
        target: t.id,
        hops,
        boundary: `${t.id} holds ${summaryOf(extras)} on * (${
          citeOf(extras)
        }) that ${c.id} does not hold`,
        intent: intentOf(t, c),
        conditions: [
          ...cands.flatMap((x) => x.pass.stmt.conditions),
          ...cands.flatMap((x) => x.trust.conditions),
        ],
        unresolved: unresolved.filter((u) => u.length > 0),
        fix: passFix(c, t, extras),
      }));
    }
    if (emitted) continue;
    // PassRole on * with a compute API, and no in-repo target qualifies:
    // roles outside the repository cannot be checked.
    const star = passGrants.filter((g) => isWildcardRes(g.res));
    const compute = cg.find((g) =>
      COMPUTE.some((svc) => svc.actions.some((a) => actionCovers(g.action, a)))
    );
    if (star.length > 0 && compute !== undefined) {
      out.push(finish({
        kind: "passrole-compute",
        status: "incomplete",
        caller: c,
        target: "*",
        hops: [
          locHop(`${c.id} may iam:PassRole on *`, locOf(star[0], callerLoc(c))),
        ],
        boundary:
          `no in-repo role qualifies as the PassRole target for ${c.id}`,
        intent: intentOf(c),
        conditions: star.flatMap((g) => g.stmt.conditions),
        unresolved: [
          "PassRole on * may reach roles defined outside this repository (not checked)",
        ],
        fix:
          `Scope iam:PassRole on ${c.id} to the specific lower-privilege role and add an iam:PassedToService condition`,
      }));
    }
  }
  return out;
}

/* ------------------------------------------------------------------------ */
/* Chain 3: ssm:SendCommand to an instance whose profile role is more privileged */
/* ------------------------------------------------------------------------ */

/** The run-command document is covered by the statement's resources. */
function docOk(st: Statement): boolean {
  return st.resources.some((r) =>
    r.kind === "literal" && (isWildcardRes(r) ||
      globMatch(arnTail(r.value), "document/AWS-RunShellScript") ||
      globMatch(arnTail(r.value), "document/AWS-RunPowerShellScript"))
  );
}

/** The role an in-repo instance runs as, or why it cannot be resolved. */
function profileRoleOf(
  model: Model,
  inst: InstanceIr,
): { role?: RoleIr; unresolved?: string } {
  const pref = inst.profile;
  if (pref.kind !== "ref") return { unresolved: valueText(pref) };
  const profile = model.profiles.find((p) =>
    p.id === pref.target && p.loc.file === inst.file
  );
  if (!profile) {
    return { unresolved: clean(`profile ${pref.target} not in repo`) };
  }
  const rref = profile.role;
  if (rref.kind !== "ref") return { unresolved: valueText(rref) };
  const role = model.roles.find((r) =>
    r.id === rref.target && r.file === inst.file
  );
  return role
    ? { role }
    : { unresolved: clean(`role ${rref.target} not in repo`) };
}

function ssmFix(caller: string, target: string, extras: Grant[]): string {
  return `Scope ssm:SendCommand on ${caller} to the instances it must manage (resource ARNs or an ssm:resourceTag condition) or reduce the instance role ${target}'s grants (${
    summaryOf(extras)
  })`;
}

function ssmChains(model: Model, eff: Map<RoleIr, Grant[]>): ChainAssessment[] {
  const out: ChainAssessment[] = [];
  const action = "ssm:SendCommand";
  for (const c of model.roles) {
    const cg = eff.get(c) ?? [];
    const sendGrants = cg.filter((g) => actionCovers(g.action, action));
    if (sendGrants.length === 0) continue;
    for (const inst of model.instances) {
      const target: TargetRef = {
        kind: "instance",
        id: inst.id,
        file: inst.file,
        tags: inst.tags,
        tagsVisible: inst.tagsVisible,
      };
      const m = sendGrants.filter((g) =>
        docOk(g.stmt) &&
        classify(g.res, target, c.file, g.stmt.resourceTags) === "match" &&
        !deniedOn(c, action, target, c.file, g.stmt.resourceTags).denied
      );
      const p = sendGrants.filter((g) =>
        classify(g.res, target, c.file, g.stmt.resourceTags) === "possible"
      );
      if (m.length === 0 && p.length === 0) continue;
      if (!boundaryAllows(c, action, target, c.file)) continue;
      const prof = profileRoleOf(model, inst);
      if (prof.role === undefined) {
        if (m.length === 0) continue;
        out.push(finish({
          kind: "ssm-send-command",
          status: "incomplete",
          caller: c,
          target: inst.id,
          hops: [
            locHop(
              `${c.id} may ssm:SendCommand ${inst.id}`,
              locOf(m[0], callerLoc(c)),
            ),
          ],
          boundary:
            `commands on ${inst.id} execute with the credentials of its instance profile role, which is not resolved`,
          intent: intentOf(c),
          conditions: m[0]?.stmt.conditions ?? [],
          unresolved: [
            clean(
              `instance profile of ${inst.id} is unresolved: ${
                prof.unresolved ?? "unknown"
              }`,
            ),
          ],
          fix: ssmFix(c.id, "the instance role", []),
        }));
        continue;
      }
      const t = prof.role;
      const extras = extraGrants(eff.get(t) ?? [], cg);
      if (extras.length === 0) continue;
      const unresolved: string[] = [];
      if (m.length === 0) {
        unresolved.push(
          clean(
            `ssm:SendCommand of ${c.id} may reach ${inst.id} via ${
              possibleText(p[0])
            }`,
          ),
        );
      }
      if (t.boundary?.kind === "unresolved") {
        unresolved.push(
          clean(`boundary of ${t.id} is unresolved: ${t.boundary.text}`),
        );
      }
      unresolved.push(
        ...unresolvedOf(c),
        ...callerUnknowns(c, extras),
        ...targetInfo(t),
      );
      const hops: ChainHop[] = [];
      if (m.length > 0) {
        hops.push(
          locHop(
            `${c.id} may ssm:SendCommand ${inst.id}`,
            locOf(m[0], callerLoc(c)),
          ),
        );
      }
      hops.push(locHop(
        `${inst.id} runs with the instance profile role ${t.id}`,
        { file: inst.file, line: inst.line },
      ));
      for (const g of extras) {
        hops.push(locHop(`${t.id} holds ${g.action} on *`, g.stmt.loc));
      }
      const required = m.length > 0 && c.unresolvedPolicies.length === 0 &&
        c.boundary?.kind !== "unresolved" && t.boundary?.kind !== "unresolved";
      out.push(finish({
        kind: "ssm-send-command",
        status: required ? "chain" : "incomplete",
        caller: c,
        target: inst.id,
        hops,
        boundary:
          `commands run on ${inst.id} execute with ${t.id}'s credentials: ${t.id} holds ${
            summaryOf(extras)
          } on * (${citeOf(extras)}) that ${c.id} does not hold`,
        intent: intentOf(t, c),
        conditions: m.flatMap((g) => g.stmt.conditions),
        unresolved: unresolved.filter((u) => u.length > 0),
        fix: ssmFix(c.id, t.id, extras),
      }));
    }
  }
  return out;
}

/** All three chain kinds over one model. */
function evaluateModel(model: Model): ChainAssessment[] {
  const eff = new Map<RoleIr, Grant[]>();
  for (const r of model.roles) eff.set(r, effectiveGrants(r));
  return [
    ...assumeChains(model, eff),
    ...passroleChains(model, eff),
    ...ssmChains(model, eff),
  ];
}

/* ------------------------------------------------------------------------ */
/* Public API                                                                */
/* ------------------------------------------------------------------------ */

const CFN_MARKER = /AWSTemplateFormatVersion|AWS::IAM::/;
const TF_MARKER = /aws_iam_|aws_instance|aws_lambda_function/;
/** Directories never scanned: dependencies, VCS and generated output. */
const SKIP_DIRS = new Set(["node_modules", "cdk.out", "target", "vendor"]);
const IAC_FILE = /\.(ya?ml|json|template|tf)$/;
/** Bounds so a huge checkout cannot stall the run. */
const MAX_FILES = 500;
const MAX_BYTES = 1_000_000;

/**
 * Pure evaluation over in-memory files (`path` is the repo-relative path used
 * in citations). A `.tf` file is read as Terraform when it carries a Terraform
 * marker; any other file as CloudFormation when it carries a CloudFormation
 * marker. Everything else is ignored. `filesRead` counts the files passed in.
 */
export function evaluateCloudPermissionChains(
  files: ReadonlyArray<{ path: string; text: string }>,
): ChainScanResult {
  const model: Model = {
    roles: [],
    instances: [],
    profiles: [],
    notChecked: [],
    filesRead: 0,
  };
  for (const f of files) {
    model.filesRead++;
    if (f.path.endsWith(".tf")) {
      if (TF_MARKER.test(f.text)) addTfFile(model, f.path, f.text);
    } else if (CFN_MARKER.test(f.text)) {
      addCfnTemplate(model, f.path, f.text);
    }
  }
  return {
    assessments: evaluateModel(model),
    filesRead: model.filesRead,
    notChecked: model.notChecked,
  };
}

/**
 * Walk a checkout (sorted, skipping dot-directories and generated output) and
 * evaluate every CloudFormation or Terraform file. Unreadable, oversized or
 * unparseable files are listed in `notChecked`, never treated as clean.
 */
export async function scanCloudPermissionChains(
  root: string,
): Promise<ChainScanResult> {
  const files: { path: string; text: string }[] = [];
  const notChecked: string[] = [];
  let candidates = 0;
  let limitHit = false;
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (!entry.name.startsWith(".") && !SKIP_DIRS.has(entry.name)) {
          await walk(path, relPath);
        }
        continue;
      }
      if (!entry.isFile || !IAC_FILE.test(entry.name)) continue;
      if (candidates >= MAX_FILES) {
        limitHit = true;
        return;
      }
      candidates++;
      try {
        if ((await Deno.stat(path)).size > MAX_BYTES) {
          notChecked.push(`${relPath}: over the ${MAX_BYTES}-byte bound`);
          continue;
        }
        files.push({ path: relPath, text: await Deno.readTextFile(path) });
      } catch {
        notChecked.push(`${relPath}: unreadable`);
      }
    }
  }
  await walk(root, "");
  if (limitHit) {
    notChecked.push(
      `${root}: more than ${MAX_FILES} candidate files, the rest not checked`,
    );
  }
  const result = evaluateCloudPermissionChains(files);
  return {
    assessments: result.assessments,
    filesRead: result.filesRead,
    notChecked: [...notChecked, ...result.notChecked],
  };
}

export interface RenderedChains {
  lines: string[];
  incompleteLines: string[];
  ids: string[];
  omitted: number;
  notChecked: string[];
}

/** Repo-derived text for a prompt line: no newlines or backticks, at most 200 characters. */
function safe(text: string): string {
  return clean(text, 200);
}

function hopList(hops: ChainHop[]): string {
  return hops.map((h, i) =>
    `hop ${i + 1}: ${safe(h.text)} (\`${safe(h.file)}:${h.line}\`)`
  ).join(" → ");
}

function chainLine(id: string, a: ChainAssessment): string {
  const conditions = a.conditions.length > 0
    ? a.conditions.map(safe).join("; ")
    : "none visible";
  return `\`${id}\` cloud-permission-chain ${a.kind} — ${
    hopList(a.hops)
  } — boundary: ${
    safe(a.boundary)
  } — conditions: ${conditions} — declared intent: ${
    safe(a.intent)
  } — smallest fix: ${safe(a.fix)}`;
}

function incompleteLine(a: ChainAssessment): string {
  const proven = a.hops.length > 0 ? hopList(a.hops) : "none";
  const unresolved = a.unresolved.map(safe).join("; ");
  return `\`${
    safe(a.entryFile)
  }:${a.entryLine}\` cloud-permission-chain ${a.kind} INCOMPLETE EVIDENCE (not a proven exploit, not a clean result) — hops proven: ${proven} — not resolved: ${unresolved}`;
}

/**
 * Render chains for the scan prompt. Chains already suppressed or known open
 * are dropped; at most `max` chain lines are kept, unconditioned chains first,
 * then by id. Incomplete evidence is always listed (at most `max`). Anything
 * beyond those limits is counted in `omitted`.
 */
export async function renderChainCandidates(
  result: ChainScanResult,
  opts: {
    repo: string;
    suppressedIds: readonly string[];
    knownOpenFindingIds: readonly string[];
    max?: number;
  },
): Promise<RenderedChains> {
  const max = opts.max ?? 5;
  const suppressed = new Set(opts.suppressedIds);
  const known = new Set(opts.knownOpenFindingIds);
  const chains: { id: string; a: ChainAssessment }[] = [];
  const incompletes: { id: string; a: ChainAssessment }[] = [];
  for (const a of result.assessments) {
    const id = await computeFindingId({
      repo: opts.repo,
      class: "exploit-chain",
      file: a.entryFile,
      snippet: a.signature,
    });
    if (a.status === "chain") {
      if (suppressed.has(id) || known.has(id)) continue;
      chains.push({ id, a });
    } else {
      incompletes.push({ id, a });
    }
  }
  chains.sort((x, y) =>
    Number(x.a.conditions.length > 0) - Number(y.a.conditions.length > 0) ||
    x.id.localeCompare(y.id)
  );
  incompletes.sort((x, y) => x.id.localeCompare(y.id));
  const keptChains = chains.slice(0, max);
  const keptIncompletes = incompletes.slice(0, max);
  return {
    lines: keptChains.map((r) => chainLine(r.id, r.a)),
    incompleteLines: keptIncompletes.map((r) => incompleteLine(r.a)),
    ids: [...keptChains, ...keptIncompletes].map((r) => r.id),
    omitted: (chains.length - keptChains.length) +
      (incompletes.length - keptIncompletes.length),
    notChecked: [...result.notChecked],
  };
}
