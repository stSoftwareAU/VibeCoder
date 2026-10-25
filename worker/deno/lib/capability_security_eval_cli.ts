/**
 * Non-interactive capability-security evaluation (Issue #4368).
 *
 * Usage, from the repository root:
 *   deno run --allow-read --allow-write --allow-run \
 *     worker/deno/lib/capability_security_eval_cli.ts \
 *     --out evals/capability_security/dry-run.json
 *
 * The command does not call a model. Live comparison stays partial.
 */
import { runCapabilitySecurityEval } from "./capability_security_eval.ts";

function arg(name: string): string | undefined {
  const index = Deno.args.indexOf(name);
  if (index < 0) return undefined;
  return Deno.args[index + 1];
}

const root = decodeURIComponent(new URL("../../../", import.meta.url).pathname);
const out = arg("--out") ??
  `${root}/evals/capability_security/dry-run.json`;
const artefact = await runCapabilitySecurityEval({ root, outPath: out });
console.log(
  `capability-security-eval: wrote ${out} (${artefact.outcomes.length} outcomes, live comparison ${artefact.liveComparison})`,
);
