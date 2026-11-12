/**
 * A fake of `gh api repos/<repo>/issues/<n>/comments --paginate --jq <filter>`
 * over REST-shaped comments (`{ user: { login }, body }`), for tests of code
 * that reads a PR's comments (PR #4896 review).
 *
 * The filter the caller sends is applied by the real `jq` to the comments, the
 * way `gh --jq` applies it to each page, so a filter that reads a field the REST
 * API does not have, or matches the wrong text, gives the wrong answer here as
 * it would against GitHub. Strings are printed raw, as `gh --jq` prints them.
 *
 * Uses Australian English spelling (behaviour, normalise, recognise, etc.).
 */

/** One issue comment as the REST API returns it, reduced to what is read. */
export interface RestComment {
  user: { login: string };
  body: string;
}

/** Whether `args` read the comments of an issue or PR through `gh api`. */
export function isIssueCommentsRead(args: readonly string[]): boolean {
  return args[0] === "api" &&
    /^repos\/[^/]+\/[^/]+\/issues\/\d+\/comments$/.test(args[1] ?? "");
}

/**
 * Answers a `gh api …/comments --jq <filter>` call over `comments`, running the
 * filter with the real `jq`. Throws when the call carries no `--jq` filter or
 * `jq` rejects it, as `gh` fails then.
 */
export async function answerCommentsRead(
  args: readonly string[],
  comments: readonly RestComment[],
): Promise<string> {
  const at = args.indexOf("--jq");
  const filter = at === -1 ? undefined : args[at + 1];
  if (filter === undefined) {
    throw new Error("the comments fake answers only a --jq read");
  }
  const child = new Deno.Command("jq", {
    args: ["-r", "-c", filter],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(comments)));
  await writer.close();
  const output = await child.output();
  if (!output.success) {
    throw new Error(`jq: ${new TextDecoder().decode(output.stderr)}`);
  }
  return new TextDecoder().decode(output.stdout);
}
