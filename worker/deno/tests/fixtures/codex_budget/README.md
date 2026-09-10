# Codex budget fixtures (Issue #1697)

Rollout session lines and rate-limit snapshots in the shapes the **pinned**
Codex CLI produces — `openai/codex` at tag `rust-v0.147.0`, the tag
`container/providers/codex.sh` downloads and checksums against
`container/tools.json`.

Each shape is derived from the pinned source, not invented:

| Fixture                              | Shape from                                                                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `rollout_chatgpt_subscription.jsonl` | `RolloutLine` + `RolloutItem::EventMsg` (`codex-rs/protocol/src/protocol.rs`), `TokenCountEvent`, `RateLimitSnapshot`, `RateLimitWindow` |
| `rollout_no_rate_limits.jsonl`       | the common `token_count` with `rate_limits: null`, plus non-`event_msg` lines                                                            |
| `rollout_malformed.jsonl`            | truncated JSON, wrong types and a missing `used_percent`                                                                                 |

`used_percent` is a percentage in `0`–`100`, `window_minutes` a duration in
minutes and `resets_at` a Unix timestamp in **seconds** — all three per the doc
comments on `RateLimitWindow`.
