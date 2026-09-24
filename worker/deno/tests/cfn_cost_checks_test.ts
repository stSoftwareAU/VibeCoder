/**
 * Tests for the CloudFormation cost / reliability pre-scan (Issue #2579).
 *
 * The regression the issue names: a template with a 3008 MB x86 Lambda and no
 * log retention yields both findings, and a template already on arm64 with
 * retention yields neither. Both directions are pinned here, in YAML (with
 * the short-form intrinsic tags real templates use) and in JSON (the form CDK
 * emits).
 *
 * Uses Australian English throughout.
 */

import { assertEquals } from "@std/assert";

import {
  findCfnCostCandidates,
  renderCfnCostCandidates,
  scanCfnCostCandidates,
} from "../lib/cfn_cost_checks.ts";

const OVERSIZED_X86_NO_RETENTION = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  ApiFunction:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: provided.al2023
      Handler: bootstrap
      MemorySize: 3008
      Role: !GetAtt ApiRole.Arn
      Code:
        S3Bucket: !Ref ArtefactBucket
        S3Key: api.zip
`;

const ARM64_WITH_RETENTION = `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  ApiFunction:
    Type: AWS::Lambda::Function
    Properties:
      Runtime: provided.al2023
      Handler: bootstrap
      MemorySize: 512
      Architectures: [arm64]
      Role: !GetAtt ApiRole.Arn
      Code:
        S3Bucket: !Ref ArtefactBucket
        S3Key: api.zip
  ApiFunctionLogs:
    Type: AWS::Logs::LogGroup
    Properties:
      LogGroupName: !Sub "/aws/lambda/\${ApiFunction}"
      RetentionInDays: 30
`;

Deno.test("findCfnCostCandidates - 3008 MB x86 Lambda with no log retention yields both findings", () => {
  const found = findCfnCostCandidates(OVERSIZED_X86_NO_RETENTION);
  assertEquals(
    found.map((c) => [c.check, c.logicalId, c.line]),
    [
      ["lambda-not-arm64", "ApiFunction", 3],
      ["lambda-log-retention", "ApiFunction", 3],
    ],
  );
  assertEquals(found[0]!.detail.includes("MemorySize 3008"), true);
});

Deno.test("findCfnCostCandidates - arm64 Lambda with retained log group yields neither", () => {
  assertEquals(findCfnCostCandidates(ARM64_WITH_RETENTION), []);
});

Deno.test("findCfnCostCandidates - a log group without RetentionInDays does not count", () => {
  const template = ARM64_WITH_RETENTION.replace(
    "      RetentionInDays: 30\n",
    "",
  );
  assertEquals(
    findCfnCostCandidates(template).map((c) => c.check),
    ["lambda-log-retention"],
  );
});

Deno.test("findCfnCostCandidates - LoggingConfig pointing at a retained group counts", () => {
  const template = `Resources:
  Worker:
    Type: AWS::Lambda::Function
    Properties:
      Architectures:
        - arm64
      LoggingConfig:
        LogGroup: !Ref SharedLogs
  SharedLogs:
    Type: AWS::Logs::LogGroup
    Properties:
      RetentionInDays: 14
`;
  assertEquals(findCfnCostCandidates(template), []);
});

Deno.test("findCfnCostCandidates - JSON (CDK-emitted) templates are read too", () => {
  const bad = JSON.stringify(
    {
      Resources: {
        Fn: {
          Type: "AWS::Lambda::Function",
          Properties: { MemorySize: 3008, Handler: "index.handler" },
        },
      },
    },
    null,
    2,
  );
  assertEquals(
    findCfnCostCandidates(bad).map((c) => [c.check, c.line]),
    [["lambda-not-arm64", 3], ["lambda-log-retention", 3]],
  );

  const good = JSON.stringify({
    Resources: {
      Fn: {
        Type: "AWS::Lambda::Function",
        Properties: { Architectures: ["arm64"] },
      },
      FnLogs: {
        Type: "AWS::Logs::LogGroup",
        Properties: {
          LogGroupName: { "Fn::Sub": "/aws/lambda/${Fn}" },
          RetentionInDays: 7,
        },
      },
    },
  });
  assertEquals(findCfnCostCandidates(good), []);
});

Deno.test("findCfnCostCandidates - non-templates and unparseable text yield nothing", () => {
  assertEquals(findCfnCostCandidates("name: build\non: push\n"), []);
  assertEquals(findCfnCostCandidates("{ not json"), []);
  assertEquals(findCfnCostCandidates(": : :\n\t- ["), []);
});

Deno.test("renderCfnCostCandidates - one evidence line per candidate, cited by file and line", () => {
  const lines = renderCfnCostCandidates(
    "infra/api.yaml",
    findCfnCostCandidates(OVERSIZED_X86_NO_RETENTION),
  );
  assertEquals(lines.length, 2);
  assertEquals(lines[0]!.startsWith("`infra/api.yaml:3` "), true);
  assertEquals(lines[1]!.includes("RetentionInDays"), true);
});

Deno.test("scanCfnCostCandidates - walks the checkout, skipping dependency and build output", async () => {
  const root = await Deno.makeTempDir({ prefix: "cfn-cost-" });
  try {
    await Deno.mkdir(`${root}/infra`);
    await Deno.mkdir(`${root}/node_modules/pkg`, { recursive: true });
    await Deno.mkdir(`${root}/cdk.out`);
    await Deno.writeTextFile(
      `${root}/infra/api.yaml`,
      OVERSIZED_X86_NO_RETENTION,
    );
    await Deno.writeTextFile(`${root}/infra/ok.yml`, ARM64_WITH_RETENTION);
    await Deno.writeTextFile(
      `${root}/node_modules/pkg/t.yaml`,
      OVERSIZED_X86_NO_RETENTION,
    );
    await Deno.writeTextFile(
      `${root}/cdk.out/Stack.template.json`,
      OVERSIZED_X86_NO_RETENTION,
    );

    const lines = await scanCfnCostCandidates(root);
    assertEquals(lines.length, 2);
    assertEquals(lines.every((l) => l.startsWith("`infra/api.yaml:3` ")), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("scanCfnCostCandidates - a missing checkout yields nothing rather than throwing", async () => {
  assertEquals(await scanCfnCostCandidates("/nonexistent/cfn-cost-root"), []);
});
