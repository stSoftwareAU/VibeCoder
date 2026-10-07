/**
 * Tests for the deterministic AWS-emulator-in-CI check (Issue #3366, part
 * of #3346).
 *
 * Covers both halves of the check independently: does the repo show AWS
 * usage (manifests, CloudFormation templates, Terraform), and does any
 * loaded GitHub Actions workflow run the `floci/floci` emulator image.
 *
 * Uses Australian English throughout.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";

import {
  cargoTomlUsesAws,
  checkAwsEmulatorInCI,
  isCfnTemplate,
  isFlociImage,
  packageJsonUsesAws,
  pomXmlUsesAws,
  requirementsUsesAws,
  workflowRunsFloci,
} from "../lib/aws_emulator_in_ci_check.ts";
import { parse as parseYaml } from "@std/yaml/parse";

async function makeTempRepo(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "aws_emulator_in_ci_check_test_" });
}

async function writeFile(
  root: string,
  relPath: string,
  content: string,
): Promise<void> {
  const path = `${root}/${relPath}`;
  const dir = path.slice(0, path.lastIndexOf("/"));
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, content);
}

// ---------------------------------------------------------------------------
// AWS detection — single-manifest cases
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - Cargo.toml with aws-sdk dependency is the only evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "Cargo.toml", '[dependencies]\naws-sdk-s3 = "1"\n');
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["Cargo.toml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - package.json with @aws-sdk dependency is the only evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "my-app",
        dependencies: { "@aws-sdk/client-s3": "^3.0.0" },
      }),
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["package.json"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - pom.xml with software.amazon.awssdk dependency is the only evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "pom.xml",
      `<project>
  <dependencies>
    <dependency>
      <groupId>software.amazon.awssdk</groupId>
      <artifactId>s3</artifactId>
    </dependency>
  </dependencies>
</project>
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["pom.xml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - requirements-dev.txt with boto3 is the only evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "requirements-dev.txt", "boto3==1.34.0\n");
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["requirements-dev.txt"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// AWS detection — nested manifests
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - nested Cargo.toml with aws-config under workspace.dependencies", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "crates/api/Cargo.toml",
      '[workspace.dependencies]\naws-config = "1"\n',
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["crates/api/Cargo.toml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - nested Cargo.toml with dotted dependency header", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "crates/api/Cargo.toml",
      '[dependencies.aws-sdk-s3]\nversion = "1"\n',
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["crates/api/Cargo.toml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// AWS detection — CloudFormation / Terraform
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - CloudFormation YAML with AWSTemplateFormatVersion and short-form tags", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "infra/cloudformation/host.yaml",
      `AWSTemplateFormatVersion: "2010-09-09"
Resources:
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      BucketName: !Ref BucketNameParam
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["infra/cloudformation/host.yaml"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - CloudFormation JSON with only Resources/Type AWS:: is detected", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "infra/host.json",
      JSON.stringify({
        Resources: {
          Bucket: { Type: "AWS::S3::Bucket" },
        },
      }),
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["infra/host.json"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a .tf file alone is evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "infra/main.tf",
      'resource "aws_s3_bucket" "b" {}\n',
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, true);
    assertEquals(result.awsEvidence, ["infra/main.tf"]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Emulator detection with no AWS evidence
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - no AWS evidence, but workflow runs floci service image", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({
        name: "left-pad",
        dependencies: { serde: "1.0" },
      }),
    );
    await writeFile(
      root,
      "Cargo.toml",
      '[package]\nname = "aws-sdk-thing"\n\n[dependencies]\nserde = "1"\n',
    );
    await writeFile(
      root,
      "some.yaml",
      'description: "just a plain config file, nothing AWS about it"\n',
    );
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `jobs:
  test:
    runs-on: ubuntu-latest
    services:
      floci:
        image: floci/floci
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
    assertEquals(result.emulatorConfigured, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Look-alikes that must NOT count
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - boto3-stubs in requirements does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "requirements.txt", "boto3-stubs==1.0\nboto==1.0\n");
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - pom.xml with project-level groupId only does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "pom.xml",
      `<project>
  <groupId>com.amazonaws</groupId>
  <!-- <dependency><groupId>com.amazonaws</groupId></dependency> -->
</project>
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - package.json named aws-sdk with no deps does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "package.json",
      JSON.stringify({ name: "aws-sdk", dependencies: { serde: "1.0" } }),
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - YAML mentioning AWS:: only in a plain string does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "config.yaml",
      'description: "uses AWS::S3"\n',
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Skip-dir enforcement
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - manifests under node_modules/target/vendor/.git are never evidence", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      "node_modules/aws-sdk/package.json",
      JSON.stringify({
        name: "aws-sdk",
        dependencies: { "@aws-sdk/client-s3": "1.0" },
      }),
    );
    await writeFile(
      root,
      "target/x/Cargo.toml",
      '[dependencies]\naws-sdk-s3 = "1"\n',
    );
    await writeFile(
      root,
      "vendor/y/Cargo.toml",
      '[dependencies]\naws-sdk-s3 = "1"\n',
    );
    await writeFile(
      root,
      ".git/z/Cargo.toml",
      '[dependencies]\naws-sdk-s3 = "1"\n',
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.usesAws, false);
    assertEquals(result.awsEvidence, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Emulator detection — positive shapes
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - services.floci.image with a sha256 digest", async () => {
  const root = await makeTempRepo();
  try {
    const digest = "a".repeat(64);
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `jobs:
  test:
    services:
      floci:
        image: floci/floci@sha256:${digest}
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, true);
    assertEquals(result.workflowsLoaded, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - container as a plain string", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `jobs:
  test:
    container: floci/floci:latest
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - container as a record with image", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `jobs:
  test:
    container:
      image: floci/floci:latest
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - step uses docker://floci/floci", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `jobs:
  test:
    steps:
      - uses: docker://floci/floci:1.0
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - step run with docker run floci/floci", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `jobs:
  test:
    steps:
      - run: docker run -d -p 4566:4566 floci/floci:latest
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Emulator detection — negative shapes
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - comment mentioning floci/floci does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `# runs floci/floci later
jobs:
  test:
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - run echoing floci/floci without docker run does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `jobs:
  test:
    steps:
      - run: echo floci/floci
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - floci/floci-proxy image does not count", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `jobs:
  test:
    container:
      image: floci/floci-proxy
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.emulatorConfigured, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// workflowsLoaded diagnostic flag
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - no workflows directory yields workflowsLoaded false", async () => {
  const root = await makeTempRepo();
  try {
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.workflowsLoaded, false);
    assertEquals(result.emulatorConfigured, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a workflow present yields workflowsLoaded true", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(
      root,
      ".github/workflows/ci.yml",
      `jobs:
  test:
    steps:
      - run: echo hi
`,
    );
    const result = await checkAwsEmulatorInCI(root);
    assertEquals(result.workflowsLoaded, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

Deno.test("checkAwsEmulatorInCI - unreadable nested directory rejects with the path in the message", async () => {
  const root = await makeTempRepo();
  const sub = `${root}/locked`;
  try {
    await Deno.mkdir(sub);
    await Deno.writeTextFile(
      `${root}/package.json`,
      JSON.stringify({ name: "x" }),
    );
    await Deno.chmod(sub, 0o000);
    await assertRejects(
      () => checkAwsEmulatorInCI(root),
      Error,
      sub,
    );
  } finally {
    await Deno.chmod(sub, 0o755);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("checkAwsEmulatorInCI - a nonexistent repoPath rejects", async () => {
  await assertRejects(() => checkAwsEmulatorInCI("/nonexistent/path/xyz-123"));
});

Deno.test("checkAwsEmulatorInCI - invalid package.json JSON rejects with the path in the message", async () => {
  const root = await makeTempRepo();
  try {
    await writeFile(root, "package.json", "{ not valid json");
    await assertRejects(
      () => checkAwsEmulatorInCI(root),
      Error,
      "package.json",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Pure helper unit tests
// ---------------------------------------------------------------------------

Deno.test("cargoTomlUsesAws - dotted dependency header counts", () => {
  assert(cargoTomlUsesAws('[dependencies.aws-sdk-s3]\nversion = "1"\n'));
});

Deno.test("cargoTomlUsesAws - target cfg dependency header counts", () => {
  assert(
    cargoTomlUsesAws(
      "[target.'cfg(unix)'.dependencies]\naws-sdk-s3 = \"1\"\n",
    ),
  );
});

Deno.test("cargoTomlUsesAws - package rename to aws-sdk counts", () => {
  assert(
    cargoTomlUsesAws(
      '[dependencies]\ns3 = { package = "aws-sdk-s3", version = "1" }\n',
    ),
  );
});

Deno.test("cargoTomlUsesAws - package.name = aws-sdk-foo does not count", () => {
  assert(!cargoTomlUsesAws('[package]\nname = "aws-sdk-foo"\n'));
});

Deno.test("cargoTomlUsesAws - commented-out dependency line does not count", () => {
  assert(!cargoTomlUsesAws('[dependencies]\n# aws-sdk-s3 = "1"\n'));
});

Deno.test("cargoTomlUsesAws - an aws-sdk-like key outside any dependency table does not count", () => {
  // A [features] (or any non-dependency) table may happen to declare a key
  // that looks like an AWS SDK crate name; only a key inside a genuine
  // dependency table is evidence of an actual AWS dependency.
  assert(!cargoTomlUsesAws('[features]\naws-sdk-s3 = []\n'));
});

Deno.test("packageJsonUsesAws - devDependencies @aws-sdk scope counts", () => {
  assert(
    packageJsonUsesAws(
      JSON.stringify({ devDependencies: { "@aws-sdk/client-s3": "1" } }),
    ),
  );
});

Deno.test("packageJsonUsesAws - own name as aws-sdk does not count", () => {
  assert(!packageJsonUsesAws(JSON.stringify({ name: "aws-sdk" })));
});

Deno.test("pomXmlUsesAws - amazonaws groupId inside a dependency counts", () => {
  assert(
    pomXmlUsesAws(
      "<dependency><groupId>com.amazonaws</groupId></dependency>",
    ),
  );
});

Deno.test("pomXmlUsesAws - commented-out dependency does not count", () => {
  assert(
    !pomXmlUsesAws(
      "<!-- <dependency><groupId>com.amazonaws</groupId></dependency> -->",
    ),
  );
});

Deno.test("requirementsUsesAws - aiobotocore counts, boto alone does not", () => {
  assert(requirementsUsesAws("aiobotocore==1.0\n"));
  assert(!requirementsUsesAws("boto==1.0\n"));
});

Deno.test("requirementsUsesAws - botocore with extras counts", () => {
  assert(requirementsUsesAws("botocore[crt]>=1.0\n"));
});

Deno.test("isCfnTemplate - AWSTemplateFormatVersion key counts", () => {
  assert(isCfnTemplate('AWSTemplateFormatVersion: "2010-09-09"\n'));
});

Deno.test("isCfnTemplate - plain string mention of AWS:: is not a template", () => {
  assert(!isCfnTemplate('description: "uses AWS::S3"\n'));
});

Deno.test("isFlociImage - exact, tag and digest forms match; near-miss does not", () => {
  assert(isFlociImage("floci/floci"));
  assert(isFlociImage("floci/floci:latest"));
  assert(isFlociImage("floci/floci@sha256:" + "a".repeat(64)));
  assert(!isFlociImage("floci/floci-other"));
  assert(!isFlociImage("floci/floci-proxy"));
});

Deno.test("workflowRunsFloci - run with docker run and floci/floci matches", () => {
  const doc = parseYaml(
    `jobs:
  test:
    steps:
      - run: docker run -d floci/floci:latest
`,
  );
  assert(workflowRunsFloci(doc));
});

Deno.test("workflowRunsFloci - no jobs does not throw and returns false", () => {
  assertEquals(workflowRunsFloci({}), false);
  assertEquals(workflowRunsFloci(null), false);
  assertEquals(workflowRunsFloci("not a doc"), false);
});
