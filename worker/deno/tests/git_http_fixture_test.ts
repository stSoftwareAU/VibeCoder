import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createNativeGitHttpFixture } from "./fixtures/native_git_http_fixture.ts";
import { nativeGit } from "./fixtures/native_git_push_probe.ts";

Deno.test("trusted Git HTTP fixture authenticates a real read-only backend and returns valid native pack objects", async () => {
  const root = await Deno.makeTempDir({ prefix: "vibe-git-http-upstream-" });
  const token = "fixture-upstream-token";
  let witnessed = 0;
  try {
    const upstream = await createNativeGitHttpFixture({
      rootDir: root,
      upstreamToken: token,
      onRequest: () => {
        witnessed++;
        return Promise.resolve();
      },
    });
    const auth = `Basic ${btoa(`x-access-token:${token}`)}`;
    const path = "https://github.com/fixture/allowed.git";
    for (
      const input of [
        new Request(`${path}/info/refs?service=git-upload-pack`),
        new Request(`${path}/info/refs?service=git-upload-pack`, {
          headers: { authorization: `Bearer ${token}` },
        }),
        new Request(`${path}/info/refs?service=git-receive-pack`, {
          headers: { authorization: auth },
        }),
        new Request(
          "https://outside.invalid/fixture/allowed.git/info/refs?service=git-upload-pack",
          { headers: { authorization: auth } },
        ),
        new Request(
          "https://github.com/fixture/other.git/info/refs?service=git-upload-pack",
          { headers: { authorization: auth } },
        ),
      ]
    ) assertEquals((await upstream.handle(input)).status, 403);
    assertEquals(upstream.witness, {
      authenticatedRequests: 0,
      discoveries: 0,
      fetches: 0,
    });
    const advertisement = await upstream.handle(
      new Request(`${path}/info/refs?service=git-upload-pack`, {
        headers: { authorization: auth, "git-protocol": "version=2" },
      }),
    );
    assertEquals(advertisement.status, 200);
    assertEquals(
      advertisement.headers.get("content-type"),
      "application/x-git-upload-pack-advertisement",
    );
    assertStringIncludes(await advertisement.text(), "version 2");
    const pkt = (text: string) =>
      (text.length + 4).toString(16).padStart(4, "0") + text;
    const packed = await upstream.handle(
      new Request(`${path}/git-upload-pack`, {
        method: "POST",
        headers: {
          authorization: auth,
          "content-type": "application/x-git-upload-pack-request",
        },
        body: pkt(`want ${upstream.mainOid}\n`) + "0000" + pkt("done\n"),
      }),
    );
    assertEquals(packed.status, 200);
    assertEquals(
      packed.headers.get("content-type"),
      "application/x-git-upload-pack-result",
    );
    const bytes = new Uint8Array(await packed.arrayBuffer());
    assertEquals(new TextDecoder().decode(bytes.slice(0, 12)), "0008NAK\nPACK");
    const target = `${root}/verify.git`;
    const env = {
      PATH: Deno.env.get("PATH")!,
      HOME: root,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    await nativeGit(["init", "--bare", target], root, env);
    await nativeGit(["index-pack", "--stdin"], target, env, bytes.slice(8));
    assertStringIncludes(
      new TextDecoder().decode(
        await nativeGit(
          ["show", `${upstream.mainOid}:fixture.txt`],
          target,
          env,
        ),
      ),
      "fixture-native-git-main",
    );
    assertEquals(upstream.witness, {
      authenticatedRequests: 2,
      discoveries: 1,
      fetches: 1,
    });
    assertEquals(witnessed, 2);
    assert(!new TextDecoder().decode(bytes).includes(token));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
