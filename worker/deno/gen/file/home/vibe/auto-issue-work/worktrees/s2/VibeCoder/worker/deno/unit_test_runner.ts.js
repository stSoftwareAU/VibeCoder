/**
 * `deno task test:unit` — the gate's unit suite, run by hand (Issue #940).
 *
 * The task used to carry its own hand-typed `--ignore` list, which had
 * already drifted: it named the thirteen integration suites #907 started
 * with and not the fourteen #935 added, so a developer running the task got
 * a slower, differently-scoped suite than the gate would run on the same
 * change. Deriving the exclusions from the manifests removes the second copy
 * rather than correcting it, and running the same two passes as
 * `runDenoTests` means "it passed locally" and "the gate passed" mean the
 * same thing.
 *
 * Usage:
 *   deno task test:unit               # both passes
 *   deno task test:unit --parallel-only
 *   deno task test:unit --serial-only
 *   deno task test:unit tests/a_test.ts tests/b_test.ts
 *                                     # only the unit tests among these files
 *   deno task test:integration        # the #907 suites, same manifest
 *
 * Every unit pass is held to the time budget (Issue #2642): a test over one
 * second is reported as a WARNING, and a file whose tests are all over it
 * fails the run unless it is exempt — see `lib/unit_test_time_budget.ts`.
 * Under the agent's git guard shim that failure is reported as NOT ENFORCED
 * instead (Issue #2669): the shim's per-call cost is not the test's.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */ import { installConsoleRedaction } from "./lib/console_redaction.ts";
import { formatPassDuration, integrationTestPass, targetedUnitTestPasses, unitTestPasses } from "./lib/unit_test_passes.ts";
import { gitGuardShimOnPath, passesTimeBudget } from "./lib/unit_test_time_budget.ts";
/** The runner's own flags; anything else starting with `-` is refused. */ const KNOWN_FLAGS = [
  "--",
  "--integration",
  "--parallel-only",
  "--serial-only"
];
/** Run the passes, stopping at the first failure, then apply the budget. */ async function main() {
  // Issue #1280 (SEC-1217-12): every entry point patches its own console —
  // this one prints pass labels alongside inherited `deno test` output.
  installConsoleRedaction();
  const integration = Deno.args.includes("--integration");
  const junitDir = integration ? undefined : await Deno.makeTempDir({
    prefix: "vibe_unit_junit_"
  });
  let code;
  try {
    code = await runPasses(integration, junitDir);
  } finally{
    if (junitDir) await Deno.remove(junitDir, {
      recursive: true
    });
  }
  if (code !== 0) Deno.exit(code);
}
/** Run the selected passes; the exit code the task should end with. */ async function runPasses(integration, junitDir) {
  const options = {
    denoCmd: Deno.execPath(),
    env: Deno.env.toObject(),
    extraArgs: [
      "--frozen",
      "--lock=deno.lock"
    ],
    ...junitDir ? {
      junitDir
    } : {}
  };
  const only = Deno.args.includes("--parallel-only") ? "parallel" : Deno.args.includes("--serial-only") ? "serial" : null;
  // Positional arguments are test files (Issue #2642); `--` is what an
  // operator types to separate them from the task's own flags.
  const files = Deno.args.filter((arg)=>!arg.startsWith("-"));
  // Fail loud on anything else: `--filter foo` would otherwise read `foo` as
  // a file and run a different suite from the one asked for.
  const unknown = Deno.args.filter((arg)=>arg.startsWith("-") && !KNOWN_FLAGS.includes(arg));
  if (unknown.length > 0) {
    console.error(`Unknown option(s): ${unknown.join(" ")}`);
    return 2;
  }
  let passes;
  if (integration) {
    passes = [
      integrationTestPass(options)
    ];
  } else if (files.length > 0) {
    const plan = targetedUnitTestPasses(options, files);
    for (const file of plan.skippedIntegration){
      console.log(`skipped (integration suite, #907): ${file}`);
    }
    if (plan.passes.length === 0) {
      console.error("No unit test files among the files given.");
      return 1;
    }
    passes = plan.passes;
  } else {
    passes = unitTestPasses(options);
  }
  passes = passes.filter((pass)=>only === null || pass.label === only);
  const junitPaths = [];
  for (const pass of passes){
    console.log(`\n=== deno test: ${pass.label} pass — ${pass.description}`);
    const startedAt = Date.now();
    const status = await new Deno.Command(pass.args[0], {
      args: pass.args.slice(1),
      // The pass env is the whole environment, not an overlay (Issue #1098):
      // without `clearEnv` the child inherits the variables the pass scrubbed,
      // and "it passed locally" stops meaning what the gate means.
      env: pass.env,
      clearEnv: true,
      stdout: "inherit",
      stderr: "inherit"
    }).output();
    const elapsed = formatPassDuration(Date.now() - startedAt);
    const verdict = status.code === 0 ? "PASSED" : "FAILED";
    console.log(`=== ${pass.label} pass: ${verdict} in ${elapsed}`);
    // Stop at the first failure: the remaining pass costs minutes and
    // cannot change the verdict.
    if (status.code !== 0) return status.code;
    if (pass.junitPath) junitPaths.push(pass.junitPath);
  }
  const budget = await passesTimeBudget(junitPaths, {
    gitGuardShim: await gitGuardShimOnPath(Deno.env.get("PATH"))
  });
  for (const line of [
    ...budget.exemptNotes,
    ...budget.warnings,
    ...budget.unenforced,
    ...budget.failures
  ]){
    console.log(line);
  }
  return budget.failures.length > 0 ? 1 : 0;
}
if (import.meta.main) await main();
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImZpbGU6Ly8vaG9tZS92aWJlL2F1dG8taXNzdWUtd29yay93b3JrdHJlZXMvczIvVmliZUNvZGVyL3dvcmtlci9kZW5vL3VuaXRfdGVzdF9ydW5uZXIudHMiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBgZGVubyB0YXNrIHRlc3Q6dW5pdGAg4oCUIHRoZSBnYXRlJ3MgdW5pdCBzdWl0ZSwgcnVuIGJ5IGhhbmQgKElzc3VlICM5NDApLlxuICpcbiAqIFRoZSB0YXNrIHVzZWQgdG8gY2FycnkgaXRzIG93biBoYW5kLXR5cGVkIGAtLWlnbm9yZWAgbGlzdCwgd2hpY2ggaGFkXG4gKiBhbHJlYWR5IGRyaWZ0ZWQ6IGl0IG5hbWVkIHRoZSB0aGlydGVlbiBpbnRlZ3JhdGlvbiBzdWl0ZXMgIzkwNyBzdGFydGVkXG4gKiB3aXRoIGFuZCBub3QgdGhlIGZvdXJ0ZWVuICM5MzUgYWRkZWQsIHNvIGEgZGV2ZWxvcGVyIHJ1bm5pbmcgdGhlIHRhc2sgZ290XG4gKiBhIHNsb3dlciwgZGlmZmVyZW50bHktc2NvcGVkIHN1aXRlIHRoYW4gdGhlIGdhdGUgd291bGQgcnVuIG9uIHRoZSBzYW1lXG4gKiBjaGFuZ2UuIERlcml2aW5nIHRoZSBleGNsdXNpb25zIGZyb20gdGhlIG1hbmlmZXN0cyByZW1vdmVzIHRoZSBzZWNvbmQgY29weVxuICogcmF0aGVyIHRoYW4gY29ycmVjdGluZyBpdCwgYW5kIHJ1bm5pbmcgdGhlIHNhbWUgdHdvIHBhc3NlcyBhc1xuICogYHJ1bkRlbm9UZXN0c2AgbWVhbnMgXCJpdCBwYXNzZWQgbG9jYWxseVwiIGFuZCBcInRoZSBnYXRlIHBhc3NlZFwiIG1lYW4gdGhlXG4gKiBzYW1lIHRoaW5nLlxuICpcbiAqIFVzYWdlOlxuICogICBkZW5vIHRhc2sgdGVzdDp1bml0ICAgICAgICAgICAgICAgIyBib3RoIHBhc3Nlc1xuICogICBkZW5vIHRhc2sgdGVzdDp1bml0IC0tcGFyYWxsZWwtb25seVxuICogICBkZW5vIHRhc2sgdGVzdDp1bml0IC0tc2VyaWFsLW9ubHlcbiAqICAgZGVubyB0YXNrIHRlc3Q6dW5pdCB0ZXN0cy9hX3Rlc3QudHMgdGVzdHMvYl90ZXN0LnRzXG4gKiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAjIG9ubHkgdGhlIHVuaXQgdGVzdHMgYW1vbmcgdGhlc2UgZmlsZXNcbiAqICAgZGVubyB0YXNrIHRlc3Q6aW50ZWdyYXRpb24gICAgICAgICMgdGhlICM5MDcgc3VpdGVzLCBzYW1lIG1hbmlmZXN0XG4gKlxuICogRXZlcnkgdW5pdCBwYXNzIGlzIGhlbGQgdG8gdGhlIHRpbWUgYnVkZ2V0IChJc3N1ZSAjMjY0Mik6IGEgdGVzdCBvdmVyIG9uZVxuICogc2Vjb25kIGlzIHJlcG9ydGVkIGFzIGEgV0FSTklORywgYW5kIGEgZmlsZSB3aG9zZSB0ZXN0cyBhcmUgYWxsIG92ZXIgaXRcbiAqIGZhaWxzIHRoZSBydW4gdW5sZXNzIGl0IGlzIGV4ZW1wdCDigJQgc2VlIGBsaWIvdW5pdF90ZXN0X3RpbWVfYnVkZ2V0LnRzYC5cbiAqIFVuZGVyIHRoZSBhZ2VudCdzIGdpdCBndWFyZCBzaGltIHRoYXQgZmFpbHVyZSBpcyByZXBvcnRlZCBhcyBOT1QgRU5GT1JDRURcbiAqIGluc3RlYWQgKElzc3VlICMyNjY5KTogdGhlIHNoaW0ncyBwZXItY2FsbCBjb3N0IGlzIG5vdCB0aGUgdGVzdCdzLlxuICpcbiAqIFVzZXMgQXVzdHJhbGlhbiBFbmdsaXNoIHNwZWxsaW5nIChiZWhhdmlvdXIsIGNvbG91ciwgb3JnYW5pc2F0aW9uLCBldGMuKVxuICovXG5cbmltcG9ydCB7IGluc3RhbGxDb25zb2xlUmVkYWN0aW9uIH0gZnJvbSBcIi4vbGliL2NvbnNvbGVfcmVkYWN0aW9uLnRzXCI7XG5pbXBvcnQge1xuICBmb3JtYXRQYXNzRHVyYXRpb24sXG4gIGludGVncmF0aW9uVGVzdFBhc3MsXG4gIHRhcmdldGVkVW5pdFRlc3RQYXNzZXMsXG4gIHR5cGUgVW5pdFRlc3RQYXNzLFxuICB1bml0VGVzdFBhc3Nlcyxcbn0gZnJvbSBcIi4vbGliL3VuaXRfdGVzdF9wYXNzZXMudHNcIjtcbmltcG9ydCB7XG4gIGdpdEd1YXJkU2hpbU9uUGF0aCxcbiAgcGFzc2VzVGltZUJ1ZGdldCxcbn0gZnJvbSBcIi4vbGliL3VuaXRfdGVzdF90aW1lX2J1ZGdldC50c1wiO1xuXG4vKiogVGhlIHJ1bm5lcidzIG93biBmbGFnczsgYW55dGhpbmcgZWxzZSBzdGFydGluZyB3aXRoIGAtYCBpcyByZWZ1c2VkLiAqL1xuY29uc3QgS05PV05fRkxBR1MgPSBbXCItLVwiLCBcIi0taW50ZWdyYXRpb25cIiwgXCItLXBhcmFsbGVsLW9ubHlcIiwgXCItLXNlcmlhbC1vbmx5XCJdO1xuXG4vKiogUnVuIHRoZSBwYXNzZXMsIHN0b3BwaW5nIGF0IHRoZSBmaXJzdCBmYWlsdXJlLCB0aGVuIGFwcGx5IHRoZSBidWRnZXQuICovXG5hc3luYyBmdW5jdGlvbiBtYWluKCk6IFByb21pc2U8dm9pZD4ge1xuICAvLyBJc3N1ZSAjMTI4MCAoU0VDLTEyMTctMTIpOiBldmVyeSBlbnRyeSBwb2ludCBwYXRjaGVzIGl0cyBvd24gY29uc29sZSDigJRcbiAgLy8gdGhpcyBvbmUgcHJpbnRzIHBhc3MgbGFiZWxzIGFsb25nc2lkZSBpbmhlcml0ZWQgYGRlbm8gdGVzdGAgb3V0cHV0LlxuICBpbnN0YWxsQ29uc29sZVJlZGFjdGlvbigpO1xuXG4gIGNvbnN0IGludGVncmF0aW9uID0gRGVuby5hcmdzLmluY2x1ZGVzKFwiLS1pbnRlZ3JhdGlvblwiKTtcbiAgY29uc3QganVuaXREaXIgPSBpbnRlZ3JhdGlvbiA/IHVuZGVmaW5lZCA6IGF3YWl0IERlbm8ubWFrZVRlbXBEaXIoe1xuICAgIHByZWZpeDogXCJ2aWJlX3VuaXRfanVuaXRfXCIsXG4gIH0pO1xuICBsZXQgY29kZTogbnVtYmVyO1xuICB0cnkge1xuICAgIGNvZGUgPSBhd2FpdCBydW5QYXNzZXMoaW50ZWdyYXRpb24sIGp1bml0RGlyKTtcbiAgfSBmaW5hbGx5IHtcbiAgICBpZiAoanVuaXREaXIpIGF3YWl0IERlbm8ucmVtb3ZlKGp1bml0RGlyLCB7IHJlY3Vyc2l2ZTogdHJ1ZSB9KTtcbiAgfVxuICBpZiAoY29kZSAhPT0gMCkgRGVuby5leGl0KGNvZGUpO1xufVxuXG4vKiogUnVuIHRoZSBzZWxlY3RlZCBwYXNzZXM7IHRoZSBleGl0IGNvZGUgdGhlIHRhc2sgc2hvdWxkIGVuZCB3aXRoLiAqL1xuYXN5bmMgZnVuY3Rpb24gcnVuUGFzc2VzKFxuICBpbnRlZ3JhdGlvbjogYm9vbGVhbixcbiAganVuaXREaXI6IHN0cmluZyB8IHVuZGVmaW5lZCxcbik6IFByb21pc2U8bnVtYmVyPiB7XG4gIGNvbnN0IG9wdGlvbnMgPSB7XG4gICAgZGVub0NtZDogRGVuby5leGVjUGF0aCgpLFxuICAgIGVudjogRGVuby5lbnYudG9PYmplY3QoKSxcbiAgICBleHRyYUFyZ3M6IFtcIi0tZnJvemVuXCIsIFwiLS1sb2NrPWRlbm8ubG9ja1wiXSxcbiAgICAuLi4oanVuaXREaXIgPyB7IGp1bml0RGlyIH0gOiB7fSksXG4gIH07XG5cbiAgY29uc3Qgb25seSA9IERlbm8uYXJncy5pbmNsdWRlcyhcIi0tcGFyYWxsZWwtb25seVwiKVxuICAgID8gXCJwYXJhbGxlbFwiXG4gICAgOiBEZW5vLmFyZ3MuaW5jbHVkZXMoXCItLXNlcmlhbC1vbmx5XCIpXG4gICAgPyBcInNlcmlhbFwiXG4gICAgOiBudWxsO1xuICAvLyBQb3NpdGlvbmFsIGFyZ3VtZW50cyBhcmUgdGVzdCBmaWxlcyAoSXNzdWUgIzI2NDIpOyBgLS1gIGlzIHdoYXQgYW5cbiAgLy8gb3BlcmF0b3IgdHlwZXMgdG8gc2VwYXJhdGUgdGhlbSBmcm9tIHRoZSB0YXNrJ3Mgb3duIGZsYWdzLlxuICBjb25zdCBmaWxlcyA9IERlbm8uYXJncy5maWx0ZXIoKGFyZykgPT4gIWFyZy5zdGFydHNXaXRoKFwiLVwiKSk7XG4gIC8vIEZhaWwgbG91ZCBvbiBhbnl0aGluZyBlbHNlOiBgLS1maWx0ZXIgZm9vYCB3b3VsZCBvdGhlcndpc2UgcmVhZCBgZm9vYCBhc1xuICAvLyBhIGZpbGUgYW5kIHJ1biBhIGRpZmZlcmVudCBzdWl0ZSBmcm9tIHRoZSBvbmUgYXNrZWQgZm9yLlxuICBjb25zdCB1bmtub3duID0gRGVuby5hcmdzLmZpbHRlcigoYXJnKSA9PlxuICAgIGFyZy5zdGFydHNXaXRoKFwiLVwiKSAmJiAhS05PV05fRkxBR1MuaW5jbHVkZXMoYXJnKVxuICApO1xuICBpZiAodW5rbm93bi5sZW5ndGggPiAwKSB7XG4gICAgY29uc29sZS5lcnJvcihgVW5rbm93biBvcHRpb24ocyk6ICR7dW5rbm93bi5qb2luKFwiIFwiKX1gKTtcbiAgICByZXR1cm4gMjtcbiAgfVxuXG4gIGxldCBwYXNzZXM6IHJlYWRvbmx5IFVuaXRUZXN0UGFzc1tdO1xuICBpZiAoaW50ZWdyYXRpb24pIHtcbiAgICBwYXNzZXMgPSBbaW50ZWdyYXRpb25UZXN0UGFzcyhvcHRpb25zKV07XG4gIH0gZWxzZSBpZiAoZmlsZXMubGVuZ3RoID4gMCkge1xuICAgIGNvbnN0IHBsYW4gPSB0YXJnZXRlZFVuaXRUZXN0UGFzc2VzKG9wdGlvbnMsIGZpbGVzKTtcbiAgICBmb3IgKGNvbnN0IGZpbGUgb2YgcGxhbi5za2lwcGVkSW50ZWdyYXRpb24pIHtcbiAgICAgIGNvbnNvbGUubG9nKGBza2lwcGVkIChpbnRlZ3JhdGlvbiBzdWl0ZSwgIzkwNyk6ICR7ZmlsZX1gKTtcbiAgICB9XG4gICAgaWYgKHBsYW4ucGFzc2VzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgY29uc29sZS5lcnJvcihcIk5vIHVuaXQgdGVzdCBmaWxlcyBhbW9uZyB0aGUgZmlsZXMgZ2l2ZW4uXCIpO1xuICAgICAgcmV0dXJuIDE7XG4gICAgfVxuICAgIHBhc3NlcyA9IHBsYW4ucGFzc2VzO1xuICB9IGVsc2Uge1xuICAgIHBhc3NlcyA9IHVuaXRUZXN0UGFzc2VzKG9wdGlvbnMpO1xuICB9XG4gIHBhc3NlcyA9IHBhc3Nlcy5maWx0ZXIoKHBhc3MpID0+IG9ubHkgPT09IG51bGwgfHwgcGFzcy5sYWJlbCA9PT0gb25seSk7XG5cbiAgY29uc3QganVuaXRQYXRoczogc3RyaW5nW10gPSBbXTtcbiAgZm9yIChjb25zdCBwYXNzIG9mIHBhc3Nlcykge1xuICAgIGNvbnNvbGUubG9nKGBcXG49PT0gZGVubyB0ZXN0OiAke3Bhc3MubGFiZWx9IHBhc3Mg4oCUICR7cGFzcy5kZXNjcmlwdGlvbn1gKTtcbiAgICBjb25zdCBzdGFydGVkQXQgPSBEYXRlLm5vdygpO1xuICAgIGNvbnN0IHN0YXR1cyA9IGF3YWl0IG5ldyBEZW5vLkNvbW1hbmQocGFzcy5hcmdzWzBdISwge1xuICAgICAgYXJnczogcGFzcy5hcmdzLnNsaWNlKDEpLFxuICAgICAgLy8gVGhlIHBhc3MgZW52IGlzIHRoZSB3aG9sZSBlbnZpcm9ubWVudCwgbm90IGFuIG92ZXJsYXkgKElzc3VlICMxMDk4KTpcbiAgICAgIC8vIHdpdGhvdXQgYGNsZWFyRW52YCB0aGUgY2hpbGQgaW5oZXJpdHMgdGhlIHZhcmlhYmxlcyB0aGUgcGFzcyBzY3J1YmJlZCxcbiAgICAgIC8vIGFuZCBcIml0IHBhc3NlZCBsb2NhbGx5XCIgc3RvcHMgbWVhbmluZyB3aGF0IHRoZSBnYXRlIG1lYW5zLlxuICAgICAgZW52OiBwYXNzLmVudixcbiAgICAgIGNsZWFyRW52OiB0cnVlLFxuICAgICAgc3Rkb3V0OiBcImluaGVyaXRcIixcbiAgICAgIHN0ZGVycjogXCJpbmhlcml0XCIsXG4gICAgfSkub3V0cHV0KCk7XG4gICAgY29uc3QgZWxhcHNlZCA9IGZvcm1hdFBhc3NEdXJhdGlvbihEYXRlLm5vdygpIC0gc3RhcnRlZEF0KTtcbiAgICBjb25zdCB2ZXJkaWN0ID0gc3RhdHVzLmNvZGUgPT09IDAgPyBcIlBBU1NFRFwiIDogXCJGQUlMRURcIjtcbiAgICBjb25zb2xlLmxvZyhgPT09ICR7cGFzcy5sYWJlbH0gcGFzczogJHt2ZXJkaWN0fSBpbiAke2VsYXBzZWR9YCk7XG4gICAgLy8gU3RvcCBhdCB0aGUgZmlyc3QgZmFpbHVyZTogdGhlIHJlbWFpbmluZyBwYXNzIGNvc3RzIG1pbnV0ZXMgYW5kXG4gICAgLy8gY2Fubm90IGNoYW5nZSB0aGUgdmVyZGljdC5cbiAgICBpZiAoc3RhdHVzLmNvZGUgIT09IDApIHJldHVybiBzdGF0dXMuY29kZTtcbiAgICBpZiAocGFzcy5qdW5pdFBhdGgpIGp1bml0UGF0aHMucHVzaChwYXNzLmp1bml0UGF0aCk7XG4gIH1cblxuICBjb25zdCBidWRnZXQgPSBhd2FpdCBwYXNzZXNUaW1lQnVkZ2V0KGp1bml0UGF0aHMsIHtcbiAgICBnaXRHdWFyZFNoaW06IGF3YWl0IGdpdEd1YXJkU2hpbU9uUGF0aChEZW5vLmVudi5nZXQoXCJQQVRIXCIpKSxcbiAgfSk7XG4gIGZvciAoXG4gICAgY29uc3QgbGluZSBvZiBbXG4gICAgICAuLi5idWRnZXQuZXhlbXB0Tm90ZXMsXG4gICAgICAuLi5idWRnZXQud2FybmluZ3MsXG4gICAgICAuLi5idWRnZXQudW5lbmZvcmNlZCxcbiAgICAgIC4uLmJ1ZGdldC5mYWlsdXJlcyxcbiAgICBdXG4gICkge1xuICAgIGNvbnNvbGUubG9nKGxpbmUpO1xuICB9XG4gIHJldHVybiBidWRnZXQuZmFpbHVyZXMubGVuZ3RoID4gMCA/IDEgOiAwO1xufVxuXG5pZiAoaW1wb3J0Lm1ldGEubWFpbikgYXdhaXQgbWFpbigpO1xuIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Q0EyQkMsR0FFRCxTQUFTLHVCQUF1QixRQUFRLDZCQUE2QjtBQUNyRSxTQUNFLGtCQUFrQixFQUNsQixtQkFBbUIsRUFDbkIsc0JBQXNCLEVBRXRCLGNBQWMsUUFDVCw0QkFBNEI7QUFDbkMsU0FDRSxrQkFBa0IsRUFDbEIsZ0JBQWdCLFFBQ1gsaUNBQWlDO0FBRXhDLHdFQUF3RSxHQUN4RSxNQUFNLGNBQWM7RUFBQztFQUFNO0VBQWlCO0VBQW1CO0NBQWdCO0FBRS9FLDBFQUEwRSxHQUMxRSxlQUFlO0VBQ2IseUVBQXlFO0VBQ3pFLHNFQUFzRTtFQUN0RTtFQUVBLE1BQU0sY0FBYyxLQUFLLElBQUksQ0FBQyxRQUFR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
// denoCacheMetadata=11535994079170320667,12694614163682299888