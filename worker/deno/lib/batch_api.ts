/**
 * Anthropic Batch API client for non-time-sensitive worker phases (Issue #1264).
 *
 * The Batch API offers a 50% cost discount for requests that can tolerate
 * up to 24 hours of processing time (though results often arrive much faster).
 *
 * This module provides:
 *   - Request/response types matching the Anthropic Batch API schema
 *   - Request construction helpers
 *   - Response parsing with validation
 *   - Phase eligibility assessment
 *   - Cost savings estimation
 *
 * ## Feasibility Analysis (Issue #1264)
 *
 * ### Architecture
 * The worker currently invokes Claude exclusively via the CLI (`claude` command).
 * The Batch API is only available via the HTTP API (`/v1/messages/batches`).
 *
 * ### Candidate Phases
 * Phases eligible for batch processing must meet ALL criteria:
 *   1. **Non-blocking** — results are not needed to continue the current pipeline
 *   2. **Simple output** — short text responses, not full code generation
 *   3. **Latency-tolerant** — can wait minutes to hours for results
 *
 * Eligible phases:
 *   - `health` — pre-flight check, runs on a timer, trivial prompt
 *   - `summarise` — content compression, can be queued ahead of need
 *   - `spelling_fix` — low-priority typo fixes, not blocking main pipeline
 *   - `clarification` — clarity assessment, analysis task with simple output
 *
 * Ineligible phases:
 *   - `execute` — main implementation, needs immediate interactive results
 *   - `planning` — architectural decisions, output drives sub-issue creation
 *   - `ci_fix` — reactive to CI failures, blocking PR merge
 *   - `pr_feedback` — reactive to reviewer comments, blocking PR iteration
 *   - `quality_fix` — blocking the quality gate
 *   - `refinement` — interactive with issue author
 *   - `revision` — blocking PR iteration cycle
 *   - `question` — user-facing answer, latency matters
 *
 * ### Authentication
 * A live HTTP path against `/v1/messages/batches` would require an
 * `ANTHROPIC_API_KEY` environment variable, separate from the CLI's own
 * authentication path. The submission/polling lifecycle was never wired up
 * and has been removed (Issue #2951); this module now provides only the
 * pure request/response/eligibility/estimation helpers.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import type { Result } from "../types.ts";
import { MODEL_PRICING, type ModelPricing } from "./token_usage.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Base URL for the Anthropic Batch API. */
export const BATCH_API_BASE_URL =
  "https://api.anthropic.com/v1/messages/batches";

/** API version header value (required by Anthropic API). */
export const BATCH_API_VERSION = "2023-06-01";

/**
 * Discount percentage offered by the Batch API.
 *
 * Module-private: consumed only by `estimateBatchSavings` below. It is not
 * exported because no in-repo module imports it (Issue #2952 dead-export
 * cleanup).
 */
const BATCH_DISCOUNT_PERCENTAGE = 50;

/**
 * Phases eligible for batch processing.
 *
 * These phases produce simple output, tolerate latency, and do not
 * block the main issue processing pipeline.
 */
export const BATCH_ELIGIBLE_PHASES: readonly string[] = [
  "health",
  "summarise",
  "spelling_fix",
  "clarification",
] as const;

/**
 * Phases ineligible for batch processing, with reasons.
 *
 * Documenting why each phase is excluded aids future reassessment.
 */
const INELIGIBLE_PHASE_REASONS: Readonly<Record<string, string>> = {
  execute:
    "Main implementation phase — needs immediate interactive results and full code generation",
  planning:
    "Architectural decisions — output directly drives sub-issue creation",
  ci_fix: "Reactive to CI failures — blocks PR merge, needs fast turnaround",
  pr_feedback: "Reactive to reviewer comments — blocks PR iteration cycle",
  quality_fix: "Blocks the quality gate — must complete before PR creation",
  refinement:
    "Interactive with issue author — latency would harm collaboration",
  revision: "Blocks PR iteration — reviewer is waiting for changes",
  question: "User-facing answer — latency degrades the experience",
};

/**
 * Reasons why eligible phases qualify for batch processing.
 */
const ELIGIBLE_PHASE_REASONS: Readonly<Record<string, string>> = {
  health:
    "Pre-flight check running on a timer — trivial prompt, result can be cached",
  summarise: "Content compression — can be queued ahead of need, simple output",
  spelling_fix:
    "Low-priority typo fixes — not blocking the main issue pipeline",
  clarification:
    "Clarity assessment — analysis task with structured, simple output",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single message in a batch request. */
export interface BatchMessage {
  /** Role of the message sender. */
  role: "user" | "assistant";
  /** Content of the message. */
  content: string;
}

/** Parameters for a single batch request item (matches Anthropic API schema). */
export interface BatchRequestItemParams {
  /** Model to use for this request. */
  model: string;
  /** Maximum tokens to generate. */
  max_tokens: number;
  /** Optional system prompt. */
  system?: string;
  /** Conversation messages. */
  messages: BatchMessage[];
}

/** A single item in a batch request. */
export interface BatchRequestItem {
  /** Unique identifier for correlating results (max 64 chars). */
  custom_id: string;
  /** Request parameters. */
  params: BatchRequestItemParams;
}

/** Top-level batch creation request. */
export interface BatchRequest {
  /** Array of request items to process. */
  requests: BatchRequestItem[];
}

/** Request counts from the batch status response. */
export interface BatchRequestCounts {
  /** Number of requests still processing. */
  processing: number;
  /** Number of successfully completed requests. */
  succeeded: number;
  /** Number of requests that errored. */
  errored: number;
  /** Number of cancelled requests. */
  canceled: number;
  /** Number of expired requests. */
  expired: number;
}

/** Parsed batch status response. */
export interface BatchResponse {
  /** Unique batch identifier. */
  id: string;
  /** Current processing status. */
  processingStatus: "in_progress" | "canceling" | "ended";
  /** Counts of requests in each state. */
  requestCounts: BatchRequestCounts;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 completion timestamp, or null if still processing. */
  endedAt: string | null;
  /** URL to fetch results, or null if not yet available. */
  resultsUrl: string | null;
}

/** A parsed result item from the batch results NDJSON. */
export interface BatchResultItem {
  /** Correlation ID matching the request's custom_id. */
  customId: string;
  /** Result type: succeeded, errored, canceled, or expired. */
  resultType: "succeeded" | "errored" | "canceled" | "expired";
  /** Extracted text output (empty string for non-succeeded results). */
  text: string;
  /** Error message if the result errored. */
  errorMessage?: string;
  /** Input tokens consumed (if available). */
  inputTokens?: number;
  /** Output tokens generated (if available). */
  outputTokens?: number;
}

/** Phase eligibility assessment entry. */
export interface BatchPhaseEligibility {
  /** Phase name. */
  phase: string;
  /** Whether the phase is eligible for batch processing. */
  eligible: boolean;
  /** Reason for the eligibility decision. */
  reason: string;
}

/** Cost savings estimation for batch vs standard processing. */
export interface BatchSavingsEstimate {
  /** Standard API cost in USD. */
  standardCost: number;
  /** Batch API cost in USD (with discount). */
  batchCost: number;
  /** Savings in USD. */
  savings: number;
  /** Discount percentage. */
  discountPercentage: number;
}

/** Options for building a batch request item. */
export interface BuildBatchRequestItemOptions {
  /** Unique correlation ID (max 64 chars). */
  customId: string;
  /** Model to use. */
  model: string;
  /** Maximum tokens to generate. */
  maxTokens: number;
  /** Optional system prompt. */
  systemPrompt?: string;
  /** Conversation messages. */
  messages: BatchMessage[];
}

/** Options for estimating batch savings. */
export interface EstimateBatchSavingsOptions {
  /** Number of input tokens. */
  inputTokens: number;
  /** Number of output tokens. */
  outputTokens: number;
  /** Model identifier for pricing lookup. */
  model: string;
}

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

/**
 * Build a single batch request item.
 *
 * @param options - Item configuration
 * @returns Formatted batch request item matching the Anthropic API schema
 */
export function buildBatchRequestItem(
  options: BuildBatchRequestItemOptions,
): BatchRequestItem {
  const params: BatchRequestItemParams = {
    model: options.model,
    max_tokens: options.maxTokens,
    messages: options.messages,
  };

  if (options.systemPrompt !== undefined) {
    params.system = options.systemPrompt;
  }

  return {
    custom_id: options.customId,
    params,
  };
}

/**
 * Build a batch creation request from an array of items.
 *
 * @param items - Array of batch request items
 * @returns Batch request ready for submission
 */
export function buildBatchRequest(items: BatchRequestItem[]): BatchRequest {
  return { requests: items };
}

// ---------------------------------------------------------------------------
// Response parsers
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw batch status response from the Anthropic API.
 *
 * @param raw - Raw JSON object from the API
 * @returns Parsed BatchResponse or validation error
 */
export function parseBatchResponse(
  raw: Record<string, unknown>,
): Result<BatchResponse> {
  if (typeof raw.id !== "string" || raw.id === "") {
    return {
      ok: false,
      error: new Error("Missing or invalid 'id' in batch response"),
    };
  }

  if (
    typeof raw.processing_status !== "string" || raw.processing_status === ""
  ) {
    return {
      ok: false,
      error: new Error(
        "Missing or invalid 'processing_status' in batch response",
      ),
    };
  }

  const counts = raw.request_counts as Record<string, number> | undefined;
  if (!counts || typeof counts !== "object") {
    return {
      ok: false,
      error: new Error("Missing or invalid 'request_counts' in batch response"),
    };
  }

  return {
    ok: true,
    value: {
      id: raw.id as string,
      processingStatus: raw
        .processing_status as BatchResponse["processingStatus"],
      requestCounts: {
        processing: counts.processing ?? 0,
        succeeded: counts.succeeded ?? 0,
        errored: counts.errored ?? 0,
        canceled: counts.canceled ?? 0,
        expired: counts.expired ?? 0,
      },
      createdAt: (raw.created_at as string) ?? "",
      endedAt: (raw.ended_at as string) ?? null,
      resultsUrl: (raw.results_url as string) ?? null,
    },
  };
}

/**
 * Parse batch results from NDJSON (newline-delimited JSON) format.
 *
 * The Anthropic Batch API returns results as NDJSON — one JSON object
 * per line. Each line contains the custom_id and result for one request.
 *
 * @param ndjson - Raw NDJSON string from the results endpoint
 * @returns Parsed result items or parse error
 */
export function parseBatchResults(
  ndjson: string,
): Result<BatchResultItem[]> {
  const lines = ndjson.split("\n").filter((line) => line.trim() !== "");
  const items: BatchResultItem[] = [];

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      return {
        ok: false,
        error: new Error(
          `Failed to parse batch result line: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      };
    }

    const customId = parsed.custom_id as string;
    const result = parsed.result as Record<string, unknown> | undefined;

    if (!result) {
      return {
        ok: false,
        error: new Error(`Missing 'result' for custom_id '${customId}'`),
      };
    }

    const resultType = result.type as string;
    let text = "";
    let errorMessage: string | undefined;
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;

    if (resultType === "succeeded") {
      const message = result.message as Record<string, unknown> | undefined;
      if (message) {
        const content = message.content as
          | Array<Record<string, unknown>>
          | undefined;
        if (content && content.length > 0) {
          // Extract text from content blocks
          text = content
            .filter((block) => block.type === "text")
            .map((block) => block.text as string)
            .join("");
        }
        const usage = message.usage as Record<string, number> | undefined;
        if (usage) {
          inputTokens = usage.input_tokens;
          outputTokens = usage.output_tokens;
        }
      }
    } else if (resultType === "errored") {
      const error = result.error as Record<string, unknown> | undefined;
      if (error) {
        errorMessage = `${error.type}: ${error.message}`;
      }
    }

    items.push({
      customId,
      resultType: resultType as BatchResultItem["resultType"],
      text,
      errorMessage,
      inputTokens,
      outputTokens,
    });
  }

  return { ok: true, value: items };
}

// ---------------------------------------------------------------------------
// Phase eligibility
// ---------------------------------------------------------------------------

/**
 * Check whether a phase is eligible for batch processing.
 *
 * @param phase - Phase name to check
 * @returns true if the phase can use the Batch API
 */
export function isBatchEligiblePhase(phase: string): boolean {
  return BATCH_ELIGIBLE_PHASES.includes(phase);
}

/**
 * Get eligibility assessment for all known phases.
 *
 * Returns both eligible and ineligible phases with reasons,
 * useful for documentation and reporting.
 *
 * @returns Array of phase eligibility assessments
 */
export function getBatchEligiblePhases(): BatchPhaseEligibility[] {
  const phases: BatchPhaseEligibility[] = [];

  // Add eligible phases
  for (const phase of BATCH_ELIGIBLE_PHASES) {
    phases.push({
      phase,
      eligible: true,
      reason: ELIGIBLE_PHASE_REASONS[phase] ?? "Eligible for batch processing",
    });
  }

  // Add ineligible phases
  for (const [phase, reason] of Object.entries(INELIGIBLE_PHASE_REASONS)) {
    phases.push({
      phase,
      eligible: false,
      reason,
    });
  }

  return phases;
}

// ---------------------------------------------------------------------------
// Cost savings estimation
// ---------------------------------------------------------------------------

/**
 * Look up pricing for a model identifier.
 *
 * Matches against known model pricing prefixes from token_usage.ts.
 */
function lookupPricing(model: string): ModelPricing | undefined {
  for (const [prefix, pricing] of MODEL_PRICING) {
    if (model.includes(prefix) || model.startsWith(prefix)) {
      return pricing;
    }
  }
  // Fallback: try matching tier name within model string
  for (const [prefix, pricing] of MODEL_PRICING) {
    const tier = prefix.replace("claude-", "").split("-")[0];
    if (tier && model.includes(tier)) {
      return pricing;
    }
  }
  return undefined;
}

/**
 * Estimate cost savings from using the Batch API vs standard API.
 *
 * The Batch API offers a flat 50% discount on all token costs.
 *
 * @param options - Token counts and model for pricing
 * @returns Cost comparison with savings
 */
export function estimateBatchSavings(
  options: EstimateBatchSavingsOptions,
): BatchSavingsEstimate {
  const pricing = lookupPricing(options.model);
  if (!pricing) {
    return {
      standardCost: 0,
      batchCost: 0,
      savings: 0,
      discountPercentage: BATCH_DISCOUNT_PERCENTAGE,
    };
  }

  const inputCost = (options.inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (options.outputTokens / 1_000_000) *
    pricing.outputPerMillion;
  const standardCost = inputCost + outputCost;
  const batchCost = standardCost * (1 - BATCH_DISCOUNT_PERCENTAGE / 100);
  const savings = standardCost - batchCost;

  return {
    standardCost,
    batchCost,
    savings,
    discountPercentage: BATCH_DISCOUNT_PERCENTAGE,
  };
}
