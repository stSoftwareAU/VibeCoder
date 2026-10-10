/**
 * Tests for the Floci CloudFormation CI workflow (Issue #3369).
 *
 * Parses the real `.github/workflows/floci.yml` and `container/tools.json`,
 * and exercises the pure checker against in-memory fixtures, each negative
 * breaking exactly one rule.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import {
  checkFlociWorkflow,
  flociImageDigest,
  flociImageTag,
} from "../lib/floci_workflow_check.ts";

const WORKFLOW_PATH =
  new URL("../../../.github/workflows/floci.yml", import.meta.url).pathname;
const TOOLS_PATH =
  new URL("../../../container/tools.json", import.meta.url).pathname;
const SCRIPT_PATH =
  new URL("../../../infra/cloudformation/test-floci.sh", import.meta.url)
    .pathname;

const DIGEST = "sha256:" + "a".repeat(64);
const OTHER_DIGEST = "sha256:" + "b".repeat(64);
const TAG = "2.2.0";

// deno-lint-ignore no-explicit-any
type Json = any;

function validWorkflow(): Json {
  return {
    on: {
      pull_request: {
        branches: ["Develop", "main", "milestone/*"],
        paths: ["infra/cloudformation/**", ".github/workflows/floci.yml"],
      },
      push: {
        paths: ["infra/cloudformation/**", ".github/workflows/floci.yml"],
      },
    },
    permissions: { contents: "read" },
    jobs: {
      cloudformation: {
        services: {
          floci: {
            image: `floci/floci:${TAG}@${DIGEST}`,
            volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
            env: {
              FLOCI_SERVICES_CLOUDFORMATION_ALLOW_STUB_UNSUPPORTED_RESOURCE_TYPES:
                "true",
            },
          },
        },
        steps: [
          {
            run:
              'if [ ! -S /var/run/docker.sock ]; then echo "::error::no socket"; exit 1; fi',
          },
          {
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: { "persist-credentials": false },
          },
          { run: "./infra/cloudformation/test-floci.sh" },
        ],
      },
    },
  };
}

function validTools(): Json {
  return {
    images: [
      { name: "docker.io/other/thing", digest: OTHER_DIGEST },
      { name: "docker.io/floci/floci", tag: TAG, digest: DIGEST },
    ],
  };
}

function expectOneProblem(workflow: Json, needle: string) {
  const problems = checkFlociWorkflow(workflow, DIGEST, TAG);
  assertEquals(problems.length, 1, `expected one problem: ${problems}`);
  assert(
    problems[0]?.includes(needle),
    `"${problems[0]}" lacks "${needle}"`,
  );
}

Deno.test("floci digest in workflow matches container/tools.json (drift test)", () => {
  const workflow = parseYaml(Deno.readTextFileSync(WORKFLOW_PATH)) as Json;
  const tools = JSON.parse(Deno.readTextFileSync(TOOLS_PATH));
  const digest = flociImageDigest(tools);
  const tag = flociImageTag(tools);
  const image = Object.values(workflow.jobs as Json)
    .map((j: Json) => j?.services?.floci?.image)
    .find((i) => typeof i === "string");
  assertEquals(image, `floci/floci:${tag}@${digest}`);
});

Deno.test("real floci.yml passes every check", () => {
  const workflow = parseYaml(Deno.readTextFileSync(WORKFLOW_PATH));
  const tools = JSON.parse(Deno.readTextFileSync(TOOLS_PATH));
  assertEquals(
    checkFlociWorkflow(
      workflow,
      flociImageDigest(tools),
      flociImageTag(tools),
    ),
    [],
  );
});

Deno.test("test-floci.sh exists and is executable", () => {
  const mode = Deno.statSync(SCRIPT_PATH).mode ?? 0;
  assert((mode & 0o111) !== 0, "test-floci.sh must be executable");
});

Deno.test("flociImageDigest returns the Floci digest", () => {
  assertEquals(flociImageDigest(validTools()), DIGEST);
});

Deno.test("flociImageTag returns the Floci tag", () => {
  assertEquals(flociImageTag(validTools()), TAG);
});

Deno.test("flociImageTag throws when the tag is missing or empty", () => {
  for (const bad of [undefined, "", "a@b"]) {
    const tools = validTools();
    tools.images[1].tag = bad;
    assertThrows(() => flociImageTag(tools), Error, "non-empty tag");
  }
});

Deno.test("flociImageTag throws when the Floci entry is missing", () => {
  assertThrows(
    () => flociImageTag({ images: [] }),
    Error,
    "no docker.io/floci/floci",
  );
});

Deno.test("flociImageDigest throws when the Floci entry is missing", () => {
  const tools = validTools();
  tools.images = tools.images.filter((i: Json) =>
    i.name !== "docker.io/floci/floci"
  );
  assertThrows(
    () => flociImageDigest(tools),
    Error,
    "no docker.io/floci/floci",
  );
});

Deno.test("flociImageDigest throws on a malformed digest", () => {
  const tools = validTools();
  tools.images[1].digest = "sha256:ABC";
  assertThrows(() => flociImageDigest(tools), Error, "64 lowercase hex");
});

Deno.test("flociImageDigest throws when images[] is missing", () => {
  assertThrows(() => flociImageDigest({}), Error, "images[]");
});

Deno.test("checkFlociWorkflow accepts a valid workflow", () => {
  assertEquals(checkFlociWorkflow(validWorkflow(), DIGEST, TAG), []);
});

Deno.test("checkFlociWorkflow (a) refuses a drifted image digest", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.services.floci.image =
    `floci/floci:${TAG}@${OTHER_DIGEST}`;
  expectOneProblem(w, "digest drift");
});

Deno.test("checkFlociWorkflow (a) refuses a stale tag in front of the current digest", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.services.floci.image = `floci/floci:2.1.9@${DIGEST}`;
  expectOneProblem(w, "tag or digest drift");
});

Deno.test("checkFlociWorkflow (a) accepts a new tag when tools.json moves with it", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.services.floci.image =
    `floci/floci:2.3.0@${OTHER_DIGEST}`;
  assertEquals(checkFlociWorkflow(w, OTHER_DIGEST, "2.3.0"), []);
});

Deno.test("checkFlociWorkflow (a) refuses a bare digest without a tag", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.services.floci.image = `floci/floci@${DIGEST}`;
  expectOneProblem(w, "with both a tag and a digest");
});

Deno.test("checkFlociWorkflow (a) refuses a bare tag without a digest", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.services.floci.image = `floci/floci:${TAG}`;
  expectOneProblem(w, "with both a tag and a digest");
});

Deno.test("checkFlociWorkflow (a) refuses a different image repository", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.services.floci.image = `other/thing:${TAG}@${DIGEST}`;
  expectOneProblem(w, "with both a tag and a digest");
});

Deno.test("checkFlociWorkflow (b) refuses a missing docker.sock volume", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.services.floci.volumes = [];
  expectOneProblem(w, "docker.sock");
});

Deno.test("checkFlociWorkflow (c) refuses a first step without the socket assertion", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.steps[0].run = "echo hello";
  expectOneProblem(w, "first step");
});

Deno.test("checkFlociWorkflow (d) refuses a workflow that never runs test-floci.sh", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.steps[2].run = "echo nothing";
  expectOneProblem(w, "test-floci.sh");
});

Deno.test("checkFlociWorkflow (e) refuses missing trigger paths", () => {
  const w = validWorkflow();
  w.on.push.paths = ["infra/cloudformation/**"];
  expectOneProblem(w, "paths");
});

Deno.test("checkFlociWorkflow (d) accepts bash/sh and bare-path invocations", () => {
  for (
    const run of [
      "bash infra/cloudformation/test-floci.sh",
      "sh ./infra/cloudformation/test-floci.sh",
    ]
  ) {
    const w = validWorkflow();
    w.jobs.cloudformation.steps[2].run = `set -e\n${run}`;
    assertEquals(checkFlociWorkflow(w, DIGEST, TAG), []);
  }
});

Deno.test("checkFlociWorkflow (d) ignores a commented-out invocation", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.steps[2].run = "# ./infra/cloudformation/test-floci.sh";
  expectOneProblem(w, "test-floci.sh");
});

Deno.test("checkFlociWorkflow (d) ignores an echoed invocation", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.steps[2].run =
    "echo ./infra/cloudformation/test-floci.sh";
  expectOneProblem(w, "test-floci.sh");
});

Deno.test("checkFlociWorkflow (c) refuses an echo that merely names the socket", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.steps[0].run = 'echo "::error:: /var/run/docker.sock"';
  expectOneProblem(w, "first step");
});

Deno.test("checkFlociWorkflow refuses a pull_request trigger without milestone/*", () => {
  const w = validWorkflow();
  w.on.pull_request.branches = ["Develop", "main"];
  expectOneProblem(w, "milestone/*");
});

Deno.test("checkFlociWorkflow refuses a floci service without the stub env", () => {
  const w = validWorkflow();
  delete w.jobs.cloudformation.services.floci.env;
  expectOneProblem(w, "ALLOW_STUB_UNSUPPORTED_RESOURCE_TYPES");
});

Deno.test("checkFlociWorkflow refuses permissions other than contents: read", () => {
  const w = validWorkflow();
  w.permissions = { contents: "write" };
  expectOneProblem(w, "permissions.contents");
});

Deno.test("checkFlociWorkflow refuses checkout without persist-credentials: false", () => {
  const w = validWorkflow();
  delete w.jobs.cloudformation.steps[1].with;
  expectOneProblem(w, "persist-credentials");
});

Deno.test("checkFlociWorkflow accepts the YAML 1.1 `true` key for `on`", () => {
  const w = validWorkflow();
  w["true"] = w.on;
  delete w.on;
  assertEquals(checkFlociWorkflow(w, DIGEST, TAG), []);
});

Deno.test("checkFlociWorkflow reports trigger problems when neither `on` nor `true` exists", () => {
  const w = validWorkflow();
  delete w.on;
  const problems = checkFlociWorkflow(w, DIGEST, TAG);
  assert(problems.length > 0);
  assert(problems.every((p) => p.includes("on.")), problems.join("; "));
  assert(problems.some((p) => p.includes("paths")));
});

Deno.test("checkFlociWorkflow reports non-object input without throwing", () => {
  assertEquals(checkFlociWorkflow(null, DIGEST, TAG).length, 1);
  assertEquals(checkFlociWorkflow("nope", DIGEST, TAG).length, 1);
});
