/** Real Git plumbing over pipes; deliberately not an HTTP/isolation proof. */
import { assert, assertEquals } from "@std/assert";

export async function nativeGit(
  args: string[],
  cwd: string,
  env: Record<string, string>,
  input?: Uint8Array,
): Promise<Uint8Array<ArrayBuffer>> {
  const child = new Deno.Command("git", {
    args,
    cwd,
    env,
    clearEnv: true,
    stdin: input ? "piped" : "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input) {
    const writer = child.stdin.getWriter();
    await writer.write(input);
    await writer.close();
  }
  const output = await child.output();
  assertEquals(output.code, 0, new TextDecoder().decode(output.stderr));
  return output.stdout;
}

/** Exchange the exact packets native smart HTTP gives its remote-curl layer. */
export async function nativeGitPush(options: {
  local: string;
  remote: string;
  env: Record<string, string>;
  ref: string;
  baseline?: string;
  approve: (body: Uint8Array<ArrayBuffer>) => boolean;
}): Promise<
  { body: Uint8Array<ArrayBuffer>; exitCode: number; forwarded: boolean }
> {
  const { local, remote, env, ref } = options;
  const advertisement = await nativeGit(
    [
      "receive-pack",
      "--stateless-rpc",
      "--advertise-refs",
      remote,
    ],
    local,
    env,
  );
  const child = new Deno.Command("git", {
    args: [
      "send-pack",
      "--stateless-rpc",
      ...(options.baseline
        ? [`--force-with-lease=${ref}:${options.baseline}`]
        : []),
      remote,
      `HEAD:${ref}`,
    ],
    cwd: local,
    env,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  const reader = child.stdout.getReader();
  const stderr = new Response(child.stderr).text();
  let pending = new Uint8Array();
  const take = async (size: number): Promise<Uint8Array<ArrayBuffer>> => {
    while (pending.length < size) {
      const chunk = await reader.read();
      assert(!chunk.done, "native Git ended before its request flush");
      const joined = new Uint8Array(pending.length + chunk.value.length);
      joined.set(pending);
      joined.set(chunk.value, pending.length);
      pending = joined;
    }
    const part = pending.slice(0, size);
    pending = pending.slice(size);
    return part;
  };
  try {
    await writer.write(advertisement);
    const parts: Uint8Array[] = [];
    while (true) {
      const prefix = new TextDecoder().decode(await take(4));
      assert(/^[0-9a-f]{4}$/.test(prefix));
      const length = Number.parseInt(prefix, 16);
      if (length === 0) break;
      assert(length >= 4);
      parts.push(await take(length - 4));
    }
    const body = new Uint8Array(
      parts.reduce((size, part) => size + part.length, 0),
    );
    let offset = 0;
    for (const part of parts) {
      body.set(part, offset);
      offset += part.length;
    }
    const forwarded = options.approve(body);
    if (forwarded) {
      const response = await nativeGit(
        ["receive-pack", "--stateless-rpc", remote],
        local,
        env,
        body,
      );
      await writer.write(response);
    }
    await writer.close();
    while (!(await reader.read()).done) {
      /* drain the remote-curl terminator */
    }
    const status = await child.status;
    await stderr;
    return { body, exitCode: status.code, forwarded };
  } finally {
    await writer.close().catch(() => {});
    await child.status;
    await stderr;
    reader.releaseLock();
    writer.releaseLock();
  }
}
