import { assert, assertEquals } from "@std/assert";
import {
  type GitBrokerContext,
  inspectGitReceivePack,
  resolveGitBrokerRequest,
} from "../lib/git_broker_transport.ts";

const encode = (text: string) => new TextEncoder().encode(text);
const zero = "0".repeat(40);
const oldOid = "a".repeat(40);
const newOid = "b".repeat(40);
const ref = "refs/heads/issue-7-fixture";
const pack = new Uint8Array(32);
pack.set(encode("PACK"));
pack[7] = 2;
function join(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function pkt(text: string) {
  const bytes = encode(text);
  return join(encode((bytes.length + 4).toString(16).padStart(4, "0")), bytes);
}
function payload(
  command = `${oldOid} ${newOid} ${ref}`,
  capabilities =
    " report-status-v2 side-band-64k quiet object-format=sha1 agent=git/2.47.3",
) {
  return join(pkt(`${command}\0${capabilities}`), encode("0000"), pack);
}
function context(
  kind: "create" | "fast-forward" | "rewrite" = "fast-forward",
): GitBrokerContext {
  return {
    repositories: [{
      repo: "fixture/allowed",
      defaultBranch: "main",
      protectedBranches: ["release/live"],
    }],
    transactions: [{ repo: "fixture/allowed", ref, oldOid, newOid, kind }],
  };
}
function request(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
) {
  return new Request(`http://broker.invalid/git/fixture/allowed.git/${path}`, {
    method,
    headers,
  });
}
function push(bytes = payload(), trusted = context()) {
  return resolveGitBrokerRequest(
    request("git-receive-pack", "POST", {
      "content-type": "application/x-git-receive-pack-request",
    }),
    trusted,
    bytes,
  );
}

Deno.test("Git broker routes native discovery and fetch only to the fixed allowed GitHub repository", () => {
  for (const service of ["git-upload-pack", "git-receive-pack"]) {
    const result = resolveGitBrokerRequest(
      request(`info/refs?service=${service}`, "GET", {
        "git-protocol": "version=2",
        authorization: "Bearer caller-secret",
        cookie: "secret=value",
        host: "attacker.invalid",
      }),
      context(),
    );
    assert(result.allowed);
    assertEquals(result.kind, "discovery");
    assertEquals(
      result.upstream.href,
      `https://github.com/fixture/allowed.git/info/refs?service=${service}`,
    );
    assertEquals([...result.headers], [["git-protocol", "version=2"]]);
    assertEquals(result.updates, []);
  }
  for (const protocol of [undefined, "version=1", "version=2"]) {
    const headers: Record<string, string> = {
      "content-type": "application/x-git-upload-pack-request",
    };
    if (protocol) headers["git-protocol"] = protocol;
    const bytes = pkt("command=fetch\n");
    const result = resolveGitBrokerRequest(
      request("git-upload-pack", "POST", headers),
      context(),
      bytes,
    );
    assert(result.allowed);
    assertEquals(result.kind, "fetch");
    assertEquals(result.headers.get("git-protocol"), protocol ?? null);
    assertEquals(
      result.upstream.href,
      "https://github.com/fixture/allowed.git/git-upload-pack",
    );
    assertEquals(result.body, bytes);
    assertEquals(result.headers.get("content-type"), headers["content-type"]);
  }
});

Deno.test("Git broker rejects arbitrary paths, query extensions, methods and compressed or unbounded bodies", () => {
  for (
    const path of [
      "info/refs",
      "info/refs?service=git-upload-pack&x=1",
      "info/refs?service=git-upload-pack&service=git-receive-pack",
      "info/refs?service=unknown",
      "objects/aa/bb",
      "git-upload-pack?x=1",
      "git-upload-pack/",
      "git%2dupload-pack",
    ]
  ) {
    assertEquals(
      resolveGitBrokerRequest(request(path), context()).allowed,
      false,
      path,
    );
  }
  for (
    const path of [
      "/git/fixture/other.git/info/refs?service=git-upload-pack",
      "/git/fixture/allowed.git/../other.git/info/refs?service=git-upload-pack",
      "/git/fixture/allowed.git//info/refs?service=git-upload-pack",
      "/git/fixture/allowed.git@attacker.invalid/info/refs?service=git-upload-pack",
      "/github/repos/fixture/allowed",
    ]
  ) {
    assertEquals(
      resolveGitBrokerRequest(
        new Request(`http://broker.invalid${path}`),
        context(),
      ).allowed,
      false,
    );
  }
  for (const method of ["HEAD", "PUT", "DELETE", "POST"]) {
    assertEquals(
      resolveGitBrokerRequest(
        request("info/refs?service=git-upload-pack", method),
        context(),
      ).allowed,
      false,
    );
  }
  for (
    const headers of [{ "git-protocol": "version=2:agent=secret" }, {
      "content-encoding": "gzip",
    }] as Record<string, string>[]
  ) {
    assertEquals(
      resolveGitBrokerRequest(
        request("info/refs?service=git-upload-pack", "GET", headers),
        context(),
      ).allowed,
      false,
    );
  }
  assertEquals(
    resolveGitBrokerRequest(
      request("info/refs?service=git-upload-pack"),
      context(),
      encode("hidden body"),
    ).allowed,
    false,
  );
  for (
    const headers of [{}, { "content-type": "application/json" }, {
      "content-type": "application/x-git-upload-pack-request",
      "content-encoding": "gzip",
    }] as Record<string, string>[]
  ) {
    assertEquals(
      resolveGitBrokerRequest(
        request("git-upload-pack", "POST", headers),
        context(),
        encode("data"),
      ).allowed,
      false,
    );
  }
  assertEquals(push(new Uint8Array(64 * 1024 * 1024 + 1)).allowed, false);
});

Deno.test("Git receive parser reads every update, shallow declaration and exact binary pack boundary", () => {
  const first = pkt(
    `${oldOid} ${newOid} ${ref}\0report-status ofs-delta atomic\n`,
  );
  const second = pkt(`${zero} ${newOid} refs/heads/feature/second\n`);
  const shallow = pkt(`shallow ${oldOid}\n`);
  const bytes = join(shallow, first, second, encode("0000"), pack);
  const result = inspectGitReceivePack(bytes);
  assertEquals(result, {
    updates: [{ ref, oldOid, newOid }, {
      ref: "refs/heads/feature/second",
      oldOid: zero,
      newOid,
    }],
    shallow: [oldOid],
    packOffset: shallow.length + first.length + second.length + 4,
  });
  assertEquals(bytes.slice(result!.packOffset), pack);
  assertEquals(inspectGitReceivePack(payload())!.updates[0], {
    ref,
    oldOid,
    newOid,
  });
});

Deno.test("Git receive parser refuses malformed framing, hidden capabilities and ambiguous refs before approval", () => {
  for (
    const bytes of [
      encode(""),
      encode("0000"),
      encode("zzzz"),
      encode("0001"),
      encode("0004"),
      encode("ffffshort"),
      payload("push-cert"),
      payload(`${oldOid} ${newOid} ${ref}`, "push-options"),
      payload(`${oldOid} ${newOid} ${ref}`, "object-format=sha256"),
      payload(`${oldOid} ${newOid} ${ref}`, "agent=bad\nheader"),
      payload(`${oldOid} ${newOid} ${ref}`, "report-status report-status"),
      payload(`${oldOid} ${newOid} ${ref}`, "unknown"),
      payload(`${oldOid} ${newOid} ${ref}\0report-status`),
      payload(`${oldOid} ${newOid} ${ref}\nextra`),
      join(pkt(`${oldOid} ${newOid} ${ref}`), encode("0000"), pack),
      join(
        pkt(`${oldOid} ${newOid} ${ref}\0report-status`),
        pkt(`${oldOid} ${newOid} ${ref}`),
        encode("0000"),
        pack,
      ),
      join(pkt(`shallow ${zero}`), payload()),
      join(pkt(`shallow ${oldOid}`), pkt(`shallow ${oldOid}`), payload()),
      join(
        pkt(`${oldOid} ${newOid} ${ref}\0report-status`),
        pkt(`shallow ${oldOid}`),
        encode("0000"),
        pack,
      ),
      join(
        pkt(`${oldOid} ${newOid} ${ref}\0report-status`),
        encode("0000"),
        encode("PACK"),
      ),
      join(
        pkt(`${oldOid} ${newOid} ${ref}\0report-status`),
        encode("0000"),
        new Uint8Array(32),
      ),
      payload(`${oldOid.toUpperCase()} ${newOid} ${ref}`),
    ]
  ) {
    assertEquals(
      inspectGitReceivePack(bytes),
      undefined,
      new TextDecoder().decode(bytes.slice(0, 220)),
    );
  }
  for (
    const branch of [
      "",
      "-flag",
      ".hidden",
      "a/.hidden",
      "a..b",
      "a//b",
      "a.lock",
      "a/b.lock",
      "a@{b",
      "a.",
      "a/",
      "a b",
      "a:b",
      "a\\b",
      "a\u007fb",
    ]
  ) {
    assertEquals(
      inspectGitReceivePack(
        payload(`${oldOid} ${newOid} refs/heads/${branch}`),
      ),
      undefined,
      branch,
    );
  }
  for (const suffix of ["refs/tags/v1", "refs/replace/abc", "HEAD"]) {
    assertEquals(push(payload(`${oldOid} ${newOid} ${suffix}`)).allowed, false);
  }
  const badVersion = pack.slice();
  badVersion[7] = 4;
  assertEquals(
    inspectGitReceivePack(
      join(pkt(`${oldOid} ${newOid} ${ref}\0`), encode("0000"), badVersion),
    ),
    undefined,
  );
});

Deno.test("Git pushes require exact host transactions and preserve create, fast-forward and owned lease rewrites", () => {
  for (const kind of ["create", "fast-forward", "rewrite"] as const) {
    const trusted = context(kind);
    const previous = kind === "create" ? zero : oldOid;
    trusted.transactions = [{ ...trusted.transactions[0]!, oldOid: previous }];
    const bytes = payload(`${previous} ${newOid} ${ref}`);
    const result = push(bytes, trusted);
    assert(result.allowed);
    assertEquals(result.kind, "push");
    assertEquals(
      result.upstream.href,
      "https://github.com/fixture/allowed.git/git-receive-pack",
    );
    assertEquals(result.updates, [{ ref, oldOid: previous, newOid }]);
    assertEquals(result.body, bytes);
    bytes.fill(0);
    assertEquals(inspectGitReceivePack(result.body)!.updates, result.updates);
  }
  for (
    const patch of [
      { repo: "other/repo" },
      { ref: "refs/heads/other" },
      { oldOid: newOid },
      { newOid: oldOid },
      { kind: "create" as const },
    ]
  ) {
    const trusted = context();
    trusted.transactions = [{ ...trusted.transactions[0]!, ...patch }];
    assertEquals(push(payload(), trusted).allowed, false);
  }
  const missing = context();
  missing.transactions = [];
  assertEquals(push(payload(), missing).allowed, false);
  assertEquals(push(payload(`${oldOid} ${zero} ${ref}`)).allowed, false);
  assertEquals(push(payload(`${oldOid} ${oldOid} ${ref}`)).allowed, false);
  for (const kind of ["fast-forward", "rewrite"] as const) {
    const trusted = context(kind);
    trusted.transactions = [{ ...trusted.transactions[0]!, oldOid: zero }];
    assertEquals(
      push(payload(`${zero} ${newOid} ${ref}`), trusted).allowed,
      false,
    );
  }
});

Deno.test("Git push authority refuses default, protected rewrites and unowned branches even with an exact transaction", () => {
  for (
    const [branch, kind, expected] of [
      ["main", "fast-forward", false],
      ["main", "create", false],
      ["milestone/121", "fast-forward", true],
      ["milestone/121", "rewrite", false],
      ["release/live", "rewrite", false],
      ["release/live", "fast-forward", true],
      ["develop", "rewrite", false],
      ["feature/someone", "rewrite", false],
      ["fix/owned", "rewrite", true],
    ] as const
  ) {
    const trusted = context(kind);
    const nextRef = `refs/heads/${branch}`;
    const previous = kind === "create" ? zero : oldOid;
    trusted.transactions = [{
      ...trusted.transactions[0]!,
      ref: nextRef,
      oldOid: previous,
    }];
    assertEquals(
      push(payload(`${previous} ${newOid} ${nextRef}`), trusted).allowed,
      expected,
      `${branch} ${kind}`,
    );
  }
  const trusted = context();
  trusted.repositories = [{ ...trusted.repositories[0]!, defaultBranch: "" }];
  assertEquals(push(payload(), trusted).allowed, false);
  const two = join(
    pkt(`${oldOid} ${newOid} ${ref}\0report-status`),
    pkt(`${oldOid} ${newOid} refs/heads/other`),
    encode("0000"),
    pack,
  );
  assertEquals(push(two).allowed, false);
  trusted.repositories = context().repositories;
  trusted.transactions = [...context().transactions, {
    ...context().transactions[0]!,
    ref: "refs/heads/other",
  }];
  assertEquals(push(two, trusted).allowed, true);
});

Deno.test("Git parser bounds and individual refusal guards each see otherwise valid packets", () => {
  const header = pkt(`${oldOid} ${newOid} ${ref}\0report-status`);
  const flush = encode("0000");
  const pack3 = pack.slice();
  pack3[7] = 3;
  assert(inspectGitReceivePack(join(header, flush, pack3)));
  const wrongMagic = pack.slice();
  wrongMagic[0] = 88;
  const second = pkt(`${zero} ${newOid} refs/heads/second\0report-status`);
  const invalidUtf8 = header.slice();
  invalidUtf8[4] = 255;
  for (
    const body of [
      join(flush, pack),
      join(header, flush, pack.slice(0, 20)),
      join(header, flush, wrongMagic),
      join(header, second, flush, pack),
      join(invalidUtf8, flush, pack),
      payload(`${oldOid} ${newOid} refs/tags/v1`),
      payload(`${oldOid} ${newOid} refs/heads/${"x".repeat(256)}`),
    ]
  ) assertEquals(inspectGitReceivePack(body), undefined);
  const upperPrefix = payload();
  upperPrefix.set(
    encode(new TextDecoder().decode(upperPrefix.slice(0, 4)).toUpperCase()),
  );
  assertEquals(inspectGitReceivePack(upperPrefix), undefined);
  const command = `${oldOid} ${newOid} ${ref}\0`;
  const oversizedPacket = pkt(command + " ".repeat(65535 - 4 - command.length));
  assertEquals(
    inspectGitReceivePack(join(oversizedPacket, flush, pack)),
    undefined,
  );
  const commands = Array.from(
    { length: 33 },
    (_, index) =>
      pkt(
        `${oldOid} ${newOid} refs/heads/item${index}${
          index === 0 ? "\0report-status" : ""
        }`,
      ),
  );
  assertEquals(
    inspectGitReceivePack(join(...commands, flush, pack)),
    undefined,
  );
  assertEquals(
    inspectGitReceivePack(join(...commands.slice(0, 32), flush, pack))!.updates
      .length,
    32,
  );
  const shallows = Array.from(
    { length: 129 },
    (_, index) => pkt(`shallow ${(index + 1).toString(16).padStart(40, "0")}`),
  );
  assertEquals(
    inspectGitReceivePack(join(...shallows, header, flush, pack)),
    undefined,
  );
  assertEquals(
    inspectGitReceivePack(join(...shallows.slice(0, 128), header, flush, pack))!
      .shallow.length,
    128,
  );
  const oversizedBody = new Uint8Array(64 * 1024 * 1024 + 1);
  oversizedBody.set(payload());
  assertEquals(inspectGitReceivePack(oversizedBody), undefined);
  assertEquals(
    resolveGitBrokerRequest(
      request("git-upload-pack", "POST", {
        "content-type": "application/x-git-upload-pack-request",
      }),
      context(),
      oversizedBody,
    ).allowed,
    false,
  );
});

Deno.test("Git transaction and HTTP guards refuse independently of unrelated denial paths", () => {
  for (const [previous, next] of [[oldOid, zero], [oldOid, oldOid]]) {
    const trusted = context();
    trusted.transactions = [{
      ...trusted.transactions[0]!,
      oldOid: previous!,
      newOid: next!,
    }];
    assertEquals(
      push(payload(`${previous} ${next} ${ref}`), trusted).allowed,
      false,
    );
  }
  const trusted = context("rewrite");
  trusted.repositories = [{
    ...trusted.repositories[0]!,
    protectedBranches: ["fix/locked"],
  }];
  trusted.transactions = [{
    ...trusted.transactions[0]!,
    ref: "refs/heads/fix/locked",
  }];
  assertEquals(
    push(payload(`${oldOid} ${newOid} refs/heads/fix/locked`), trusted).allowed,
    false,
  );
  for (
    const [path, method] of [["git-upload-pack", "GET"], [
      "git-upload-pack?x=1",
      "POST",
    ], ["git-upload-pack#secret", "POST"]]
  ) {
    assertEquals(
      resolveGitBrokerRequest(
        request(path!, method!, {
          "content-type": "application/x-git-upload-pack-request",
        }),
        context(),
        encode("fetch"),
      ).allowed,
      false,
    );
  }
});
