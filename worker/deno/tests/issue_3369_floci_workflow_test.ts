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

// deno-lint-ignore no-explicit-any
type Json = any;

function validWorkflow(): Json {
  return {
    on: {
      pull_request: {
        paths: ["infra/cloudformation/**", ".github/workflows/floci.yml"],
      },
      push: {
        paths: ["infra/cloudformation/**", ".github/workflows/floci.yml"],
      },
    },
    jobs: {
      cloudformation: {
        services: {
          floci: {
            image: `floci/floci@${DIGEST}`,
            volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
          },
        },
        steps: [
          {
            run:
              'if [ ! -S /var/run/docker.sock ]; then echo "::error::no socket"; exit 1; fi',
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
      { name: "docker.io/floci/floci", tag: "2.2.0", digest: DIGEST },
    ],
  };
}

function expectOneProblem(workflow: Json, needle: string) {
  const problems = checkFlociWorkflow(workflow, DIGEST);
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
  const image = Object.values(workflow.jobs as Json)
    .map((j: Json) => j?.services?.floci?.image)
    .find((i) => typeof i === "string");
  assertEquals(image, `floci/floci@${digest}`);
});

Deno.test("real floci.yml passes every check", () => {
  const workflow = parseYaml(Deno.readTextFileSync(WORKFLOW_PATH));
  const tools = JSON.parse(Deno.readTextFileSync(TOOLS_PATH));
  assertEquals(checkFlociWorkflow(workflow, flociImageDigest(tools)), []);
});

Deno.test("test-floci.sh exists and is executable", () => {
  const mode = Deno.statSync(SCRIPT_PATH).mode ?? 0;
  assert((mode & 0o111) !== 0, "test-floci.sh must be executable");
});

Deno.test("flociImageDigest returns the Floci digest", () => {
  assertEquals(flociImageDigest(validTools()), DIGEST);
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
  assertEquals(checkFlociWorkflow(validWorkflow(), DIGEST), []);
});

Deno.test("checkFlociWorkflow (a) refuses a drifted image digest", () => {
  const w = validWorkflow();
  w.jobs.cloudformation.services.floci.image = `floci/floci@${OTHER_DIGEST}`;
  expectOneProblem(w, "digest");
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
  w.jobs.cloudformation.steps[1].run = "echo nothing";
  expectOneProblem(w, "test-floci.sh");
});

Deno.test("checkFlociWorkflow (e) refuses missing trigger paths", () => {
  const w = validWorkflow();
  w.on.push.paths = ["infra/cloudformation/**"];
  expectOneProblem(w, "paths");
});

Deno.test("checkFlociWorkflow reports non-object input without throwing", () => {
  assertEquals(checkFlociWorkflow(null, DIGEST).length, 1);
  assertEquals(checkFlociWorkflow("nope", DIGEST).length, 1);
});
