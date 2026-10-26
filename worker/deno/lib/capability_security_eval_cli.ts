/** Trusted fixture self-test or explicitly bounded subscription comparison (#4368). */
import { runCapabilitySecurityEval } from "./capability_security_eval.ts";
import { compareCapabilityGuidance } from "./capability_security_comparison.ts";
import { invokeCapabilityModel } from "./capability_security_eval_provider.ts";
import { runIsolatedCapabilitySource } from "./capability_security_eval_container.ts";
import { dirname } from "node:path";

function arg(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  if (index < 0) return undefined;
  const value = Deno.args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

const root = decodeURIComponent(new URL("../../../", import.meta.url).pathname);
const live = Deno.args.includes("--live");
const out = arg("--out") ??
  `${root}/evals/capability_security/${live ? "comparison" : "dry-run"}.json`;
if (live) {
  const model = arg("--model");
  if (!model) throw new Error("--live requires an explicit --model");
  const runtime = arg("--runtime");
  if (
    runtime && runtime !== "apple" && runtime !== "docker" &&
    runtime !== "podman"
  ) throw new Error("unsupported --runtime");
  const selectedRuntime: "apple" | "docker" | "podman" | undefined =
    runtime === "apple" || runtime === "docker" || runtime === "podman"
      ? runtime
      : undefined;
  const image = arg("--image");
  const artefact = await compareCapabilityGuidance({
    root,
    model,
    effort: arg("--effort") ?? "low",
    samples: Number(arg("--samples") ?? "2"),
    timeoutMs: Number(arg("--timeout-ms") ?? "60000"),
  }, {
    invoke: invokeCapabilityModel,
    execute: (request) =>
      runIsolatedCapabilitySource({
        ...request,
        ...(selectedRuntime ? { runtime: selectedRuntime } : {}),
        ...(image ? { image } : {}),
      }),
  });
  await Deno.mkdir(dirname(out), { recursive: true });
  await Deno.writeTextFile(out, `${JSON.stringify(artefact, null, 2)}\n`);
  console.log(
    `capability-security-eval: ${artefact.liveComparison}; ${artefact.generations.length} generations, ${artefact.reviews.length} reviews; wrote ${out}`,
  );
  if (artefact.liveComparison === "partial") {
    console.error(artefact.blockers.join("\n"));
    Deno.exitCode = 2;
  }
} else {
  const artefact = await runCapabilitySecurityEval({ root, outPath: out });
  console.log(
    `capability-security-eval: trusted fixtures only; ${artefact.outcomes.length} outcomes; wrote ${out}`,
  );
}
