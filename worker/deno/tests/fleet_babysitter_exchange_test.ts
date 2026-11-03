import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from "@std/assert";
import {
  createExchangeDir,
  readAgentOutput,
  writeExchangeFile,
} from "../lib/fleet_babysitter_exchange.ts";

/** A canonical scratch root for one test, removed by the caller. */
async function makeRoot(): Promise<string> {
  return await Deno.realPath(await Deno.makeTempDir());
}

Deno.test("createExchangeDir returns a canonical, owner-only, distinct directory per call", async () => {
  const made: string[] = [];
  try {
    const first = await createExchangeDir("exchange-test-4731-");
    made.push(first);
    const second = await createExchangeDir("exchange-test-4731-");
    made.push(second);
    assertEquals(first, await Deno.realPath(first));
    assertEquals((await Deno.stat(first)).mode! & 0o777, 0o700);
    assertNotEquals(first, second);
  } finally {
    for (const dir of made) await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readAgentOutput reads a regular file and returns null when it is absent", async () => {
  const root = await makeRoot();
  try {
    await Deno.writeTextFile(`${root}/response`, "hello");
    assertEquals(
      await readAgentOutput(root, "response", { maxBytes: 16 }),
      "hello",
    );
    assertEquals(
      await readAgentOutput(root, "absent", { maxBytes: 16 }),
      null,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readAgentOutput refuses a symlink to a secret without revealing it", async () => {
  const root = await makeRoot();
  try {
    await Deno.writeTextFile(`${root}/secret.txt`, "SECRET-TOKEN-4731");
    await Deno.symlink(`${root}/secret.txt`, `${root}/response`);
    const error = await assertRejects(
      () => readAgentOutput(root, "response", { maxBytes: 1024 }),
      Error,
      "refused unsafe agent output",
    );
    assert(!error.message.includes("SECRET-TOKEN-4731"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readAgentOutput refuses a FIFO", async () => {
  const root = await makeRoot();
  try {
    const made = await new Deno.Command("mkfifo", {
      args: [`${root}/response`],
    }).output();
    assert(made.success, "mkfifo created the FIFO");
    await assertRejects(
      () => readAgentOutput(root, "response", { maxBytes: 1024 }),
      Error,
      "refused unsafe agent output",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readAgentOutput accepts exactly maxBytes and refuses one byte more", async () => {
  const root = await makeRoot();
  try {
    await Deno.writeTextFile(`${root}/response`, "12345678");
    assertEquals(
      await readAgentOutput(root, "response", { maxBytes: 8 }),
      "12345678",
    );
    await assertRejects(
      () => readAgentOutput(root, "response", { maxBytes: 7 }),
      Error,
      "refused unsafe agent output",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readAgentOutput refuses a hard link to a file outside the exchange", async () => {
  const root = await makeRoot();
  try {
    await Deno.writeTextFile(`${root}/secret.txt`, "SECRET-TOKEN-4731");
    await Deno.link(`${root}/secret.txt`, `${root}/response`);
    await assertRejects(
      () => readAgentOutput(root, "response", { maxBytes: 1024 }),
      Error,
      "refused unsafe agent output",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readAgentOutput refuses an exchange directory replaced by a symlink", async () => {
  const root = await makeRoot();
  try {
    await Deno.mkdir(`${root}/real`);
    await Deno.writeTextFile(`${root}/real/response`, "planted");
    await Deno.symlink(`${root}/real`, `${root}/link`);
    await assertRejects(
      () => readAgentOutput(`${root}/link`, "response", { maxBytes: 1024 }),
      Error,
      "refused unsafe agent output",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readAgentOutput refuses names that are not a plain file name", async () => {
  const root = await makeRoot();
  try {
    for (const name of ["a/b", "../response", "..", ".", ""]) {
      await assertRejects(
        () => readAgentOutput(root, name, { maxBytes: 1024 }),
        Error,
        "refused unsafe agent output",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("readAgentOutput gives up on an open that never completes", async () => {
  const root = await makeRoot();
  try {
    await Deno.writeTextFile(`${root}/response`, "hello");
    await assertRejects(
      () =>
        readAgentOutput(root, "response", {
          maxBytes: 1024,
          openTimeoutMs: 20,
          open: (() => new Promise(() => {})) as unknown as typeof Deno.open,
        }),
      Error,
      "timed out",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("writeExchangeFile writes an owner-only file and returns its path", async () => {
  const root = await makeRoot();
  try {
    const path = await writeExchangeFile(root, "pr-body.md", "New body\n");
    assertEquals(path, `${root}/pr-body.md`);
    assertEquals(await Deno.readTextFile(path), "New body\n");
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("writeExchangeFile refuses to overwrite an existing file of the same name", async () => {
  const root = await makeRoot();
  try {
    await writeExchangeFile(root, "pr-body.md", "first");
    await assertRejects(
      () => writeExchangeFile(root, "pr-body.md", "second"),
      Deno.errors.AlreadyExists,
    );
    assertEquals(await Deno.readTextFile(`${root}/pr-body.md`), "first");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("writeExchangeFile does not follow a symlink planted at its name", async () => {
  const root = await makeRoot();
  try {
    const target = `${root}/target.txt`;
    await Deno.writeTextFile(target, "untouched");
    await Deno.symlink(target, `${root}/pr-body.md`);
    await assertRejects(() => writeExchangeFile(root, "pr-body.md", "owned"));
    assertEquals(await Deno.readTextFile(target), "untouched");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("writeExchangeFile refuses a directory that is a symlink, and bad names", async () => {
  const root = await makeRoot();
  try {
    const exchange = `${root}/exchange`;
    await Deno.mkdir(exchange);
    await Deno.symlink(exchange, `${root}/link`);
    await assertRejects(
      () => writeExchangeFile(`${root}/link`, "pr-body.md", "x"),
      Error,
      "refused unsafe agent output",
    );
    for (const name of ["a/b", "../x", ""]) {
      await assertRejects(
        () => writeExchangeFile(exchange, name, "x"),
        Error,
        "refused unsafe agent output",
      );
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
