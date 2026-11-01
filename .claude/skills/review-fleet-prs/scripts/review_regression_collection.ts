import {
  planRegressionChecks,
  type RegressionCheckPlan,
} from "./review_regression_plan.ts";

export interface PairedCheckRequest extends RegressionCheckPlan {
  head: string;
  base: string;
}

export type PairedObservation =
  | { status: "unavailable"; detail: string }
  | {
    status: "observed";
    head: CheckObservation;
    base: CheckObservation;
    blob: string;
  };

interface CheckObservation {
  status: "passed";
  head: string;
  tree: string;
  cwd: string;
  argv: string[];
  imageDigest: string;
  runtime: string;
  code: number;
  output: string;
  overlayBlob?: string;
}

/** Host-only coordination. Observations require a subsequent independent
 * review; this function never grants approval. */
export async function collectRegressionEvidence(
  input: {
    head: string;
    base: string;
    tests: readonly string[];
    headFiles: ReadonlySet<string>;
  },
  runPair: (request: PairedCheckRequest) => Promise<PairedObservation>,
): Promise<
  { status: "pending"; reason: string } | {
    status: "review";
    observations: PairedObservation[];
  }
> {
  if (
    !/^[0-9a-f]{40}$/.test(input.head) || !/^[0-9a-f]{40}$/.test(input.base)
  ) {
    return { status: "pending", reason: "pinned commit IDs are required" };
  }
  let plans: RegressionCheckPlan[];
  try {
    plans = planRegressionChecks(input.tests, input.headFiles);
  } catch (e) {
    return { status: "pending", reason: (e as Error).message };
  }
  const observations: PairedObservation[] = [];
  for (const plan of plans) {
    const request = { ...plan, head: input.head, base: input.base };
    let result: PairedObservation;
    try {
      result = await runPair(request);
    } catch (e) {
      return {
        status: "pending",
        reason: `runner failed: ${(e as Error).message}`,
      };
    }
    if (result.status === "unavailable") {
      return { status: "pending", reason: result.detail };
    }
    const valid = (r: CheckObservation, commit: string) =>
      typeof r === "object" && r !== null &&
      r.status === "passed" && r.runtime === "apple-container" &&
      r.head === commit &&
      /^[0-9a-f]{40}$/.test(r.tree) && r.cwd === request.cwd &&
      JSON.stringify(r.argv) === JSON.stringify(request.argv) && r.code === 0 &&
      typeof r.output === "string" && r.output.length <= 1024 * 1024 &&
      r.overlayBlob === result.blob;
    if (
      !/^[0-9a-f]{40}$/.test(result.blob) ||
      !valid(result.head, request.head) || !valid(result.base, request.base) ||
      !/^sha256:[0-9a-f]{64}$/.test(result.head.imageDigest) ||
      result.head.imageDigest !== result.base.imageDigest
    ) {
      return {
        status: "pending",
        reason: "runner result does not match the pinned request",
      };
    }
    observations.push(result);
  }
  return { status: "review", observations };
}
