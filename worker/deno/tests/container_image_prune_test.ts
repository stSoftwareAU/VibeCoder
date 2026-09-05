/**
 * Tests for pruning superseded container image tags (Issue #4162).
 *
 * The content-derived tag (#4062) rebuilds on every container-definition
 * change, and until this module nothing ever deleted the tag it superseded: on
 * host-23 four multi-gigabyte `vibe-coder:<hash>` images filled the store and
 * the next build died mid-export with "No space left on device".
 *
 * Driving a container runtime is exactly what a test must not really do, so
 * every runtime invocation is a seam here. The cases below cover the three
 * things that keep an unattended prune safe: it keeps the current reference, it
 * never touches an image that is not ours, and a listing or a removal it could
 * not perform is a loud failure rather than a quiet "nothing to prune"
 * (Issue #3234).
 *
 * Australian English spelling throughout (behaviour, colour, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  parseImageListing,
  parseImageReference,
  type PruneDeps,
  pruneSupersededImages,
  selectSupersededImages,
} from "../lib/container_image_prune.ts";
import { CONTAINER_RUNTIMES } from "../lib/container_runtime.ts";

/** The OCI dialect's own list/remove spelling, so the tests use real argv. */
const OCI = CONTAINER_RUNTIMES.docker.dialect;

/** One recorded runtime invocation. */
interface Invocation {
  args: string[];
}

/** A recording stand-in for the runtime, answering each sub-command. */
function stubDeps(options: {
  listExit?: number;
  listStdout?: string;
  listStderr?: string;
  removeExit?: (reference: string) => number;
}): PruneDeps & { calls: Invocation[]; logs: string[] } {
  const calls: Invocation[] = [];
  const logs: string[] = [];
  return {
    calls,
    logs,
    log: (message) => logs.push(message),
    runRuntime: (args) => {
      calls.push({ args: [...args] });
      const isList = args[1] === "ls" || args[1] === "list";
      if (isList) {
        return Promise.resolve({
          code: options.listExit ?? 0,
          stdout: options.listStdout ?? "",
          stderr: options.listStderr ?? "",
        });
      }
      const reference = args[args.length - 1] ?? "";
      const code = options.removeExit?.(reference) ?? 0;
      return Promise.resolve({
        code,
        stdout: "",
        stderr: code === 0 ? "" : `cannot remove ${reference}`,
      });
    },
  };
}

/** Run a prune against the OCI dialect's argv. */
function prune(deps: PruneDeps, ...keep: string[]) {
  return pruneSupersededImages(deps, {
    keep,
    listArgs: OCI.imageListArgs,
    removeArgs: OCI.imageRemoveArgs,
  });
}

// ---------------------------------------------------------------------------
// Reference parsing
// ---------------------------------------------------------------------------

Deno.test("parseImageReference - splits a repository and tag", () => {
  assertEquals(parseImageReference("vibe-coder:0a1b2c3d4e5f"), {
    repository: "vibe-coder",
    tag: "0a1b2c3d4e5f",
  });
  // Podman prefixes locally built images with its own registry.
  assertEquals(parseImageReference("localhost/vibe-coder:abc123abc123"), {
    repository: "localhost/vibe-coder",
    tag: "abc123abc123",
  });
  // A registry port must not be mistaken for the tag separator.
  assertEquals(parseImageReference("registry:5000/vibe-coder:abc"), {
    repository: "registry:5000/vibe-coder",
    tag: "abc",
  });
});

Deno.test("parseImageReference - rejects what is not a usable reference", () => {
  for (
    const reference of [
      "",
      "   ",
      "vibe-coder",
      "vibe-coder:",
      ":abc",
      "<none>:<none>",
      "vibe-coder:<none>",
      // Nothing that could be read as another argument or a shell fragment.
      "vibe-coder:abc;rm -rf /",
      "--force",
      "vibe coder:abc",
    ]
  ) {
    assertEquals(
      parseImageReference(reference),
      null,
      `${JSON.stringify(reference)} must not parse as an image reference`,
    );
  }
});

// ---------------------------------------------------------------------------
// Listing shapes
// ---------------------------------------------------------------------------

Deno.test("parseImageListing - reads Docker's one-object-per-line JSON", () => {
  const text = [
    '{"Repository":"vibe-coder","Tag":"0a1b2c3d4e5f","Size":"3.1GB"}',
    '{"Repository":"vibe-coder","Tag":"ffffffffffff","Size":"3.1GB"}',
    '{"Repository":"node","Tag":"22","Size":"1.1GB"}',
  ].join("\n");
  assertEquals(parseImageListing(text).map((record) => record.reference), [
    "vibe-coder:0a1b2c3d4e5f",
    "vibe-coder:ffffffffffff",
    "node:22",
  ]);
});

Deno.test("parseImageListing - reads a JSON array with references or name/tag pairs", () => {
  // Apple container reports a reference; Podman reports a Names array.
  const text = JSON.stringify([
    { reference: "vibe-coder:0a1b2c3d4e5f" },
    { Names: ["localhost/vibe-coder:ffffffffffff"] },
    { Repository: "localhost/node", Tag: "22" },
  ]);
  assertEquals(parseImageListing(text).map((record) => record.reference), [
    "vibe-coder:0a1b2c3d4e5f",
    "localhost/vibe-coder:ffffffffffff",
    "localhost/node:22",
  ]);
});

Deno.test("parseImageListing - reads Apple container's REAL shape: the reference is nested at configuration.name (Issue #4331)", () => {
  // Captured from `container image ls --format json` on Apple container
  // 1.2.2 (host-23). The reference is NOT a top-level key — it lives at
  // configuration.name — so the top-level-only parser returned zero records
  // and the #4162 prune was a silent no-op on every launch: six superseded
  // 4.9 GB vibe-coder snapshots accumulated (~30 GB) before anyone noticed.
  const text = JSON.stringify([
    {
      configuration: {
        creationDate: "2026-08-06T15:15:51Z",
        descriptor: { digest: "sha256:0d12", mediaType: "…", size: 645 },
        name:
          "docker.io/denoland/deno@sha256:0d1262facd139e815217c001945eb822c7a78584cf660142c34a6b53effec1aa",
      },
      id: "0d1262facd13",
      variants: [],
    },
    {
      configuration: {
        creationDate: "2026-08-17T00:00:00Z",
        descriptor: { digest: "sha256:1b6d", mediaType: "…", size: 1000 },
        name: "vibe-coder:1f97877fdc6b",
      },
      id: "1b6d15f06757",
      variants: [],
    },
    {
      configuration: {
        creationDate: "2026-08-18T03:00:00Z",
        descriptor: { digest: "sha256:9990", mediaType: "…", size: 1000 },
        name: "vibe-coder:99900b7f5f70",
      },
      id: "99900b7f5f70",
      variants: [],
    },
  ]);
  assertEquals(parseImageListing(text).map((record) => record.reference), [
    "vibe-coder:1f97877fdc6b",
    "vibe-coder:99900b7f5f70",
  ]);
});

Deno.test("parseImageListing - reads a plain reference per line", () => {
  const text =
    "vibe-coder:0a1b2c3d4e5f\nvibe-coder:ffffffffffff\n<none>:<none>\n";
  assertEquals(parseImageListing(text).map((record) => record.reference), [
    "vibe-coder:0a1b2c3d4e5f",
    "vibe-coder:ffffffffffff",
  ]);
});

Deno.test("parseImageListing - an empty listing names nothing", () => {
  assertEquals(parseImageListing(""), []);
  assertEquals(parseImageListing("[]"), []);
});

// ---------------------------------------------------------------------------
// Choosing what to prune
// ---------------------------------------------------------------------------

Deno.test("selectSupersededImages - every other tag of our own image", () => {
  const records = parseImageListing([
    "vibe-coder:0a1b2c3d4e5f",
    "vibe-coder:ffffffffffff",
    "localhost/vibe-coder:eeeeeeeeeeee",
    "node:22",
    "ghcr.io/other/vibe-coder:latest",
    "vibe-coder-tools:1.0",
  ].join("\n"));

  assertEquals(
    selectSupersededImages({ records, keep: ["vibe-coder:0a1b2c3d4e5f"] })
      .map((record) => record.reference),
    [
      "vibe-coder:ffffffffffff",
      // Podman's local prefix is still this host's own image.
      "localhost/vibe-coder:eeeeeeeeeeee",
    ],
  );
});

Deno.test("selectSupersededImages - keeps the base a kept tag is built FROM (Issue #1059)", () => {
  // #980 builds a deployment's private layer as a second image, FROM the
  // standard one, and the container runs the extension tag. Told only that
  // tag, the prune untagged the base its own `FROM` names on every launch.
  const records = parseImageListing([
    "vibe-coder:extension0001",
    "vibe-coder:base00000001",
    "vibe-coder:superseded01",
  ].join("\n"));

  assertEquals(
    selectSupersededImages({
      records,
      keep: ["vibe-coder:extension0001", "vibe-coder:base00000001"],
    }).map((record) => record.reference),
    ["vibe-coder:superseded01"],
  );
});

Deno.test("selectSupersededImages - a chain of any depth survives (Issue #1059)", () => {
  // Nothing special-cases two tags: the keep set is the dependency chain the
  // launch plan resolved, so a third layer needs no further change.
  const records = parseImageListing([
    "localhost/vibe-coder:leaf00000001",
    "vibe-coder:middle000001",
    "vibe-coder:base00000001",
    "vibe-coder:superseded01",
  ].join("\n"));

  assertEquals(
    selectSupersededImages({
      records,
      keep: [
        "vibe-coder:leaf00000001",
        "vibe-coder:middle000001",
        "vibe-coder:base00000001",
      ],
    }).map((record) => record.reference),
    ["vibe-coder:superseded01"],
  );
});

Deno.test("pruneSupersededImages - the extension's base survives a launch that built it", async () => {
  const deps = stubDeps({
    listStdout: [
      "vibe-coder:extension0001",
      "vibe-coder:base00000001",
      "vibe-coder:superseded01",
    ].join("\n"),
  });

  const outcome = await prune(
    deps,
    "vibe-coder:extension0001",
    "vibe-coder:base00000001",
  );

  assertEquals(outcome.ok, true);
  assertEquals(outcome.removed, ["vibe-coder:superseded01"]);
});

Deno.test("pruneSupersededImages - a keep reference that does not parse prunes nothing", async () => {
  // Dropping an unreadable reference silently would delete the image it names.
  const deps = stubDeps({
    listStdout: "vibe-coder:extension0001\nvibe-coder:superseded01\n",
  });

  const outcome = await prune(deps, "vibe-coder:extension0001", "vibe-coder");

  assertEquals(outcome.ok, false);
  assertEquals(outcome.removed, []);
  assertStringIncludes(outcome.detail ?? "", '"vibe-coder"');
});

Deno.test("selectSupersededImages - keeps the current reference under either spelling", () => {
  const records = parseImageListing(
    "vibe-coder:0a1b2c3d4e5f\nlocalhost/vibe-coder:0a1b2c3d4e5f\n",
  );
  assertEquals(
    selectSupersededImages({ records, keep: ["vibe-coder:0a1b2c3d4e5f"] }),
    [],
  );
});

// ---------------------------------------------------------------------------
// The prune itself
// ---------------------------------------------------------------------------

Deno.test("pruneSupersededImages - removes each superseded tag and says so", async () => {
  const deps = stubDeps({
    listStdout: [
      '{"Repository":"vibe-coder","Tag":"0a1b2c3d4e5f"}',
      '{"Repository":"vibe-coder","Tag":"ffffffffffff"}',
      '{"Repository":"vibe-coder","Tag":"eeeeeeeeeeee"}',
      '{"Repository":"node","Tag":"22"}',
    ].join("\n"),
  });

  const outcome = await prune(deps, "vibe-coder:0a1b2c3d4e5f");

  assertEquals(outcome.ok, true);
  assertEquals(outcome.removed, [
    "vibe-coder:ffffffffffff",
    "vibe-coder:eeeeeeeeeeee",
  ]);
  assertEquals(outcome.failed, []);

  // The runtime saw exactly one listing and one removal per superseded tag —
  // and never a removal of the current reference or of a foreign image.
  assertEquals(deps.calls.length, 3);
  assertEquals(deps.calls[0]!.args, [...OCI.imageListArgs]);
  assertEquals(deps.calls[1]!.args, [
    ...OCI.imageRemoveArgs,
    "vibe-coder:ffffffffffff",
  ]);
  assertEquals(deps.calls[2]!.args, [
    ...OCI.imageRemoveArgs,
    "vibe-coder:eeeeeeeeeeee",
  ]);

  // Loud by design: each removed tag is named in the log (Issue #4162).
  const logged = deps.logs.join("\n");
  assertStringIncludes(logged, "vibe-coder:ffffffffffff");
  assertStringIncludes(logged, "vibe-coder:eeeeeeeeeeee");
});

Deno.test("pruneSupersededImages - a store holding only the current tag prunes nothing", async () => {
  const deps = stubDeps({
    listStdout: '{"Repository":"vibe-coder","Tag":"0a1b2c3d4e5f"}\n',
  });
  const outcome = await prune(deps, "vibe-coder:0a1b2c3d4e5f");
  assertEquals(outcome.ok, true);
  assertEquals(outcome.removed, []);
  assertEquals(deps.calls.length, 1, "nothing beyond the listing was run");
});

Deno.test("pruneSupersededImages - a listing the runtime refused is a loud failure", async () => {
  const deps = stubDeps({
    listExit: 1,
    listStderr: "Cannot connect to the Docker daemon",
  });
  const outcome = await prune(deps, "vibe-coder:0a1b2c3d4e5f");

  assertEquals(outcome.ok, false, "a failed listing must never look clean");
  assertEquals(outcome.removed, []);
  assert(outcome.detail, "the failure must name what went wrong");
  assertStringIncludes(outcome.detail!, "Cannot connect");
  assertEquals(deps.calls.length, 1, "nothing is removed on a blind listing");
});

Deno.test("pruneSupersededImages - output it cannot parse is a failure, not an empty store", async () => {
  const deps = stubDeps({ listStdout: "REPOSITORY  TAG  SIZE\n" });
  const outcome = await prune(deps, "vibe-coder:0a1b2c3d4e5f");
  assertEquals(outcome.ok, false);
  assert(outcome.detail);
  assertStringIncludes(outcome.detail!, "could not be read");
});

Deno.test("pruneSupersededImages - a removal the runtime refused is reported", async () => {
  const deps = stubDeps({
    listStdout: [
      '{"Repository":"vibe-coder","Tag":"0a1b2c3d4e5f"}',
      '{"Repository":"vibe-coder","Tag":"ffffffffffff"}',
      '{"Repository":"vibe-coder","Tag":"eeeeeeeeeeee"}',
    ].join("\n"),
    removeExit: (reference) => reference === "vibe-coder:ffffffffffff" ? 1 : 0,
  });

  const outcome = await prune(deps, "vibe-coder:0a1b2c3d4e5f");

  assertEquals(outcome.ok, false);
  // The refusal of one tag must not stop the others being reclaimed.
  assertEquals(outcome.removed, ["vibe-coder:eeeeeeeeeeee"]);
  assertEquals(outcome.failed.map((failure) => failure.reference), [
    "vibe-coder:ffffffffffff",
  ]);
  assertStringIncludes(deps.logs.join("\n"), "vibe-coder:ffffffffffff");
});

Deno.test("pruneSupersededImages - refuses a keep reference it cannot trust", async () => {
  const deps = stubDeps({ listStdout: "vibe-coder:ffffffffffff\n" });
  for (const keep of ["", "vibe-coder", "vibe-coder:abc;rm -rf /"]) {
    const outcome = await prune(deps, keep);
    assertEquals(outcome.ok, false, `${keep} must not be accepted`);
    assertStringIncludes(outcome.detail ?? "", "reference");
  }
  assertEquals(
    deps.calls.length,
    0,
    "an untrusted keep reference must not reach the runtime at all",
  );
});
