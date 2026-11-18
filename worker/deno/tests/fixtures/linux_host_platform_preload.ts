/**
 * Pins the host platform to Linux (Issue #5245). Container runtime detection
 * picks its candidates by `Deno.build.os` (Apple `container` on macOS), but the
 * tests that use this fake only docker/podman. It replaces `Deno.build` with a
 * Linux copy and makes every `deno run` child this process starts load the same
 * preload, so the supervisor's babysitter child is pinned too.
 */
export {};

const self = new URL(import.meta.url).pathname;

Object.defineProperty(Deno, "build", {
  configurable: true,
  value: Object.freeze({ ...Deno.build, os: "linux" as const }),
});

const RealCommand = Deno.Command;
class PinnedCommand extends RealCommand {
  constructor(command: string | URL, options?: Deno.CommandOptions) {
    const args = options?.args?.map(String) ?? [];
    if (
      String(command) === Deno.execPath() && args[0] === "run" &&
      !args.includes(self)
    ) {
      options = {
        ...options,
        args: ["run", "--preload", self, ...args.slice(1)],
      };
    }
    super(command, options);
  }
}
Object.defineProperty(Deno, "Command", {
  configurable: true,
  writable: true,
  value: PinnedCommand,
});
