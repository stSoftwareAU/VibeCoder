/**
 * Tests for the static cloud permission-chain scan (Issue #4416).
 *
 * A single permission is never a finding. These tests pin the three chains
 * (assume-role escalation, PassRole to compute, SSM run-command) through the
 * real directory walk over versioned fixtures, plus inline variants for the
 * negative cases. Every hop must cite a real file:line whose text carries the
 * relevant token. Unknown values must come out as "incomplete", never as a
 * chain and never as a silently clean result.
 *
 * Uses Australian English throughout.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";

import {
  type ChainAssessment,
  evaluateCloudPermissionChains,
  globMatch,
  renderChainCandidates,
  scanCloudPermissionChains,
} from "../lib/cloud_permission_chains.ts";

const FIXTURES = new URL(
  "./fixtures/cloud_permission_chains/v1/",
  import.meta.url,
).pathname;

/** Assert each hop of `a` cites a line that contains the matching token. */
async function assertHopsCited(
  dir: string,
  a: ChainAssessment,
  tokens: string[],
): Promise<void> {
  assertEquals(
    a.hops.length,
    tokens.length,
    `hop count for ${a.signature}: ${a.hops.map((h) => h.text).join(" | ")}`,
  );
  for (const [i, token] of tokens.entries()) {
    const hop = a.hops[i];
    assert(hop !== undefined, `hop ${i + 1} missing`);
    const lines = (await Deno.readTextFile(`${FIXTURES}${dir}/${hop.file}`))
      .split("\n");
    const line = lines[hop.line - 1] ?? "";
    assert(
      line.includes(token),
      `hop ${
        i + 1
      } (${hop.text}) cites ${hop.file}:${hop.line}, which lacks "${token}": ${line}`,
    );
  }
}

/** Assert no assessment is a proven chain. */
function assertNoChain(assessments: ChainAssessment[]): void {
  for (const a of assessments) {
    assert(a.status !== "chain", `unexpected chain: ${a.signature}`);
  }
}

// ---------------------------------------------------------------------------
// Chains through the real walk
// ---------------------------------------------------------------------------

Deno.test("assume-role-cfn: CiRole chains to AdminRole through every hop", async () => {
  const result = await scanCloudPermissionChains(`${FIXTURES}assume-role-cfn`);
  assertEquals(result.assessments.length, 1);
  const [a] = result.assessments;
  assertEquals(a.kind, "assume-role-escalation");
  assertEquals(a.status, "chain");
  assertEquals(a.caller, "CiRole");
  assertEquals(a.target, "AdminRole");
  assertEquals(a.signature, "assume-role-escalation|CiRole|AdminRole");
  assertEquals(a.intent, '"Pipeline role that deploys the service"');
  assertEquals(a.unresolved, []);
  assertStringIncludes(a.boundary, "iam:*");
  await assertHopsCited("assume-role-cfn", a, [
    "sts:AssumeRole",
    "sts:AssumeRole",
    "iam:*",
  ]);
  assertEquals(result.notChecked, []);
});

Deno.test("assume-role-tf: the same escalation in Terraform", async () => {
  const result = await scanCloudPermissionChains(`${FIXTURES}assume-role-tf`);
  assertEquals(result.assessments.length, 1);
  const [a] = result.assessments;
  assertEquals(a.kind, "assume-role-escalation");
  assertEquals(a.status, "chain");
  assertEquals(a.caller, "aws_iam_role.ci");
  assertEquals(a.target, "aws_iam_role.admin");
  await assertHopsCited("assume-role-tf", a, [
    "sts:AssumeRole",
    "sts:AssumeRole",
    "iam:*",
  ]);
});

Deno.test("passrole-lambda-cfn: PassRole plus CreateFunction runs as a privileged role", async () => {
  const result = await scanCloudPermissionChains(
    `${FIXTURES}passrole-lambda-cfn`,
  );
  assertEquals(result.assessments.length, 1);
  const [a] = result.assessments;
  assertEquals(a.kind, "passrole-compute");
  assertEquals(a.status, "chain");
  assertEquals(a.signature, "passrole-compute|CiRole|RuntimeRole");
  await assertHopsCited("passrole-lambda-cfn", a, [
    "iam:PassRole",
    "lambda:CreateFunction",
    "sts:AssumeRole",
    "iam:*",
  ]);
});

Deno.test("passrole-lambda-tf: the same PassRole chain in Terraform", async () => {
  const result = await scanCloudPermissionChains(
    `${FIXTURES}passrole-lambda-tf`,
  );
  assertEquals(result.assessments.length, 1);
  const [a] = result.assessments;
  assertEquals(a.kind, "passrole-compute");
  assertEquals(a.status, "chain");
  assertEquals(
    a.signature,
    "passrole-compute|aws_iam_role.ci|aws_iam_role.runtime",
  );
  await assertHopsCited("passrole-lambda-tf", a, [
    "iam:PassRole",
    "lambda:CreateFunction",
    "sts:AssumeRole",
    "iam:*",
  ]);
});

Deno.test("ssm-cfn: SendCommand to an instance whose role is more privileged", async () => {
  const result = await scanCloudPermissionChains(`${FIXTURES}ssm-cfn`);
  assertEquals(result.assessments.length, 1);
  const [a] = result.assessments;
  assertEquals(a.kind, "ssm-send-command");
  assertEquals(a.status, "chain");
  assertEquals(a.signature, "ssm-send-command|CiRole|AppInstance");
  await assertHopsCited("ssm-cfn", a, [
    "ssm:SendCommand",
    "AppInstance",
    "iam:*",
  ]);
});

Deno.test("ssm-tf: the same SSM chain in Terraform", async () => {
  const result = await scanCloudPermissionChains(`${FIXTURES}ssm-tf`);
  assertEquals(result.assessments.length, 1);
  const [a] = result.assessments;
  assertEquals(a.kind, "ssm-send-command");
  assertEquals(a.status, "chain");
  assertEquals(
    a.signature,
    "ssm-send-command|aws_iam_role.ci|aws_instance.app",
  );
  await assertHopsCited("ssm-tf", a, [
    "ssm:SendCommand",
    "aws_instance",
    "iam:*",
  ]);
});

// ---------------------------------------------------------------------------
// Legitimate and explicitly denied configurations: zero assessments
// ---------------------------------------------------------------------------

Deno.test("constrained-deploy: narrowly scoped deploy role yields zero assessments", async () => {
  const result = await scanCloudPermissionChains(
    `${FIXTURES}constrained-deploy`,
  );
  assertEquals(result.assessments, []);
  assertEquals(result.notChecked, []);
});

Deno.test("explicit-deny: an unconditioned Deny on the caller removes the chain", async () => {
  const result = await scanCloudPermissionChains(`${FIXTURES}explicit-deny`);
  assertEquals(result.assessments, []);
});

Deno.test("explicit-deny-passrole: an unconditioned Deny of iam:PassRole removes the chain", async () => {
  const result = await scanCloudPermissionChains(
    `${FIXTURES}explicit-deny-passrole`,
  );
  assertEquals(result.assessments, []);
});

Deno.test("permissions-boundary: a resolvable boundary removes the grant; an external boundary is incomplete", async () => {
  const result = await scanCloudPermissionChains(
    `${FIXTURES}permissions-boundary`,
  );
  // BoundedRole's iam:* is outside its resolvable boundary, so CiRole's
  // assumption of BoundedRole yields nothing. The external boundary on
  // ExternalBoundedCi leaves its chain to AdminRole incomplete.
  assertEquals(result.assessments.length, 1);
  const [a] = result.assessments;
  assertEquals(a.status, "incomplete");
  assertEquals(a.caller, "ExternalBoundedCi");
  assertEquals(a.target, "AdminRole");
  assert(a.unresolved.length > 0, "unresolved must name the boundary");
  assertStringIncludes(a.unresolved.join(" "), "ExternalBoundary");
  assertNoChain(result.assessments);
});

// ---------------------------------------------------------------------------
// Unknown values stay unknown
// ---------------------------------------------------------------------------

Deno.test("unresolved-external: parameter and variable targets are incomplete, never chains", async () => {
  const result = await scanCloudPermissionChains(
    `${FIXTURES}unresolved-external`,
  );
  assertEquals(result.assessments.length, 2);
  for (const a of result.assessments) {
    assertEquals(a.status, "incomplete");
    assert(a.unresolved.length > 0, `${a.signature} needs unresolved text`);
    assert(a.hops.length > 0, `${a.signature} still cites its proven hops`);
  }
  assertNoChain(result.assessments);
  const signatures = result.assessments.map((a) => a.signature).sort();
  assertEquals(signatures, [
    "assume-role-escalation|CiRole|AdminRole",
    "assume-role-escalation|aws_iam_role.ci|aws_iam_role.admin",
  ]);
});

Deno.test("irrelevant: a repository with no infrastructure-as-code yields nothing", async () => {
  const result = await scanCloudPermissionChains(`${FIXTURES}irrelevant`);
  assertEquals(result.assessments, []);
  assertEquals(result.notChecked, []);
  // Only package.json has a scanned extension; it carries no IaC markers.
  assertEquals(result.filesRead, 1);
});

Deno.test("unparseable template is listed as not checked, never clean", () => {
  const result = evaluateCloudPermissionChains([{
    path: "broken.yaml",
    text: 'AWSTemplateFormatVersion: "2010-09-09"\nResources: [\n',
  }]);
  assertEquals(result.assessments, []);
  assertEquals(result.notChecked.length, 1);
  assertStringIncludes(result.notChecked[0], "broken.yaml");
});

Deno.test("a broken Terraform file is listed as not checked", () => {
  const result = evaluateCloudPermissionChains([{
    path: "broken.tf",
    text: 'resource "aws_iam_role" "x" {\n  name = \n',
  }]);
  assertEquals(result.assessments, []);
  assertEquals(result.notChecked.length, 1);
  assertStringIncludes(result.notChecked[0], "broken.tf");
});

// ---------------------------------------------------------------------------
// Inline negatives: a lone grant is never a finding
// ---------------------------------------------------------------------------

const TRUST_CODEBUILD = `      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              Service: codebuild.amazonaws.com
            Action: sts:AssumeRole
`;

Deno.test("a lone PassRole with no compute API yields no assessment", () => {
  const text = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  CiRole:
    Type: AWS::IAM::Role
    Properties:
${TRUST_CODEBUILD}      Policies:
        - PolicyName: pass
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: iam:PassRole
                Resource: !GetAtt RuntimeRole.Arn
  RuntimeRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: admin
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: iam:*
                Resource: "*"
`;
  const result = evaluateCloudPermissionChains([{ path: "t.yaml", text }]);
  assertEquals(result.assessments, []);
});

Deno.test("AssumeRole to a role whose trust does not name the caller yields no assessment", () => {
  const text = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  CiRole:
    Type: AWS::IAM::Role
    Properties:
      RoleName: ci-deploy
${TRUST_CODEBUILD}      Policies:
        - PolicyName: assume
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: sts:AssumeRole
                Resource: !GetAtt AdminRole.Arn
  AdminRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              AWS: arn:aws:iam::123456789012:role/other-pipeline
            Action: sts:AssumeRole
      Policies:
        - PolicyName: admin
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: iam:*
                Resource: "*"
`;
  const result = evaluateCloudPermissionChains([{ path: "t.yaml", text }]);
  assertEquals(result.assessments, []);
});

Deno.test("SendCommand to an instance whose role is not more privileged yields no assessment", () => {
  const text = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  CiRole:
    Type: AWS::IAM::Role
    Properties:
${TRUST_CODEBUILD}      Policies:
        - PolicyName: run
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: ssm:SendCommand
                Resource: "*"
  AppInstance:
    Type: AWS::EC2::Instance
    Properties:
      IamInstanceProfile: !Ref AppProfile
  AppProfile:
    Type: AWS::IAM::InstanceProfile
    Properties:
      Roles:
        - !Ref AppRole
  AppRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              Service: ec2.amazonaws.com
            Action: sts:AssumeRole
      Policies:
        - PolicyName: read
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: s3:GetObject
                Resource: arn:aws:s3:::artefacts/*
`;
  const result = evaluateCloudPermissionChains([{ path: "t.yaml", text }]);
  assertEquals(result.assessments, []);
});

Deno.test("a Deny with a condition does not remove the chain and is recorded", () => {
  const text = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  CiRole:
    Type: AWS::IAM::Role
    Properties:
      Description: Pipeline role
${TRUST_CODEBUILD}      Policies:
        - PolicyName: assume
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: sts:AssumeRole
                Resource: !GetAtt AdminRole.Arn
              - Effect: Deny
                Action: sts:AssumeRole
                Resource: "*"
                Condition:
                  StringEquals:
                    aws:RequestedRegion: us-east-1
  AdminRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: "2012-10-17"
        Statement:
          - Effect: Allow
            Principal:
              AWS: !GetAtt CiRole.Arn
            Action: sts:AssumeRole
      Policies:
        - PolicyName: admin
          PolicyDocument:
            Version: "2012-10-17"
            Statement:
              - Effect: Allow
                Action: iam:*
                Resource: "*"
`;
  const result = evaluateCloudPermissionChains([{ path: "t.yaml", text }]);
  assertEquals(result.assessments.length, 1);
  assertEquals(result.assessments[0].status, "chain");
  assertEquals(result.assessments[0].conditions.length, 1);
  assertStringIncludes(
    result.assessments[0].conditions[0],
    "aws:RequestedRegion",
  );
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** A chain assessment for rendering tests, with `caller` as its identity. */
function fakeChain(
  caller: string,
  conditions: string[] = [],
): ChainAssessment {
  return {
    kind: "assume-role-escalation",
    status: "chain",
    caller,
    target: "AdminRole",
    entryFile: "template.yaml",
    entryLine: 3,
    hops: [
      {
        text: `${caller} may sts:AssumeRole AdminRole`,
        file: "template.yaml",
        line: 14,
      },
      { text: "AdminRole holds iam:* on *", file: "template.yaml", line: 39 },
    ],
    boundary: "AdminRole holds iam:* on *",
    intent: "none stated in the repository",
    conditions,
    unresolved: [],
    fix: "Scope the sts:AssumeRole Resource",
    signature: `assume-role-escalation|${caller}|AdminRole`,
  };
}

Deno.test("renderChainCandidates: ids match SEC-<12 hex> and the line shape", async () => {
  const result = await scanCloudPermissionChains(`${FIXTURES}assume-role-cfn`);
  const rendered = await renderChainCandidates(result, {
    repo: "owner/repo",
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assertEquals(rendered.lines.length, 1);
  assertEquals(rendered.ids.length, 1);
  assertMatch(rendered.ids[0], /^SEC-[0-9a-f]{12}$/);
  assertStringIncludes(
    rendered.lines[0],
    `\`${rendered.ids[0]}\` cloud-permission-chain assume-role-escalation`,
  );
  assertStringIncludes(rendered.lines[0], "— boundary:");
  assertStringIncludes(rendered.lines[0], "— smallest fix:");
  assertStringIncludes(rendered.lines[0], "hop 1:");
  assertEquals(rendered.omitted, 0);
});

Deno.test("renderChainCandidates: suppressed and known-open ids drop chain lines", async () => {
  const result = await scanCloudPermissionChains(`${FIXTURES}assume-role-cfn`);
  const open = await renderChainCandidates(result, {
    repo: "owner/repo",
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  const id = open.ids[0];
  const suppressed = await renderChainCandidates(result, {
    repo: "owner/repo",
    suppressedIds: [id],
    knownOpenFindingIds: [],
  });
  assertEquals(suppressed.lines, []);
  const known = await renderChainCandidates(result, {
    repo: "owner/repo",
    suppressedIds: [],
    knownOpenFindingIds: [id],
  });
  assertEquals(known.lines, []);
});

Deno.test("renderChainCandidates: max caps chain lines, unconditioned first, and counts the rest", async () => {
  const result = {
    assessments: [
      fakeChain("ConditionedRole", [
        "StringEquals aws:RequestedRegion=eu-west-1",
      ]),
      fakeChain("PlainOne"),
      fakeChain("PlainTwo"),
    ],
    filesRead: 1,
    notChecked: [],
  };
  const rendered = await renderChainCandidates(result, {
    repo: "owner/repo",
    suppressedIds: [],
    knownOpenFindingIds: [],
    max: 2,
  });
  assertEquals(rendered.lines.length, 2);
  assertEquals(rendered.omitted, 1);
  for (const line of rendered.lines) {
    assert(
      !line.includes("ConditionedRole"),
      "conditioned chain must be the one omitted",
    );
  }
  assertStringIncludes(rendered.lines[0], "conditions: none visible");
});

Deno.test("renderChainCandidates: repo text is sanitised and truncated", async () => {
  const hostile = fakeChain("Evil`Role\nInjected");
  hostile.hops[0] = {
    text: `Evil\`Role\ninjected ${"a".repeat(500)}`,
    file: "template.yaml",
    line: 14,
  };
  hostile.intent = `"${"b".repeat(400)}"`;
  const rendered = await renderChainCandidates(
    { assessments: [hostile], filesRead: 1, notChecked: [] },
    { repo: "owner/repo", suppressedIds: [], knownOpenFindingIds: [] },
  );
  const [line] = rendered.lines;
  assert(!line.includes("\n"), "no newlines in a rendered line");
  assert(!line.includes("Evil`Role"), "backticks stripped from repo text");
  assert(!line.includes("a".repeat(201)), "hop text truncated to 200");
  assert(!line.includes("b".repeat(201)), "intent truncated to 200");
});

Deno.test("renderChainCandidates: incomplete evidence is listed in its own shape", async () => {
  const result = await scanCloudPermissionChains(
    `${FIXTURES}unresolved-external`,
  );
  const rendered = await renderChainCandidates(result, {
    repo: "owner/repo",
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assertEquals(rendered.lines, []);
  assertEquals(rendered.incompleteLines.length, 2);
  for (const line of rendered.incompleteLines) {
    assertStringIncludes(
      line,
      "cloud-permission-chain assume-role-escalation INCOMPLETE EVIDENCE",
    );
    assertStringIncludes(line, "— not resolved:");
  }
});

Deno.test("renderChainCandidates: output is deterministic across two runs", async () => {
  const result = await scanCloudPermissionChains(
    `${FIXTURES}permissions-boundary`,
  );
  const first = await renderChainCandidates(result, {
    repo: "owner/repo",
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  const second = await renderChainCandidates(result, {
    repo: "owner/repo",
    suppressedIds: [],
    knownOpenFindingIds: [],
  });
  assertEquals(first, second);
});

// ---------------------------------------------------------------------------
// Glob matcher
// ---------------------------------------------------------------------------

Deno.test("globMatch: wildcards, case-insensitivity and literal matches", () => {
  assert(globMatch("iam:*", "iam:PassRole"));
  assert(globMatch("IAM:PassRole", "iam:passrole"));
  assert(globMatch("a?c", "abc"));
  assert(!globMatch("a?c", "ac"));
  assert(globMatch("*", ""));
  assert(!globMatch("s3:GetObject", "s3:PutObject"));
});

Deno.test("globMatch: hostile pattern against a long non-matching string completes and returns false", () => {
  const pattern = "*a".repeat(2000);
  const value = "a".repeat(5000) + "b";
  assertEquals(globMatch(pattern, value), false);
});
