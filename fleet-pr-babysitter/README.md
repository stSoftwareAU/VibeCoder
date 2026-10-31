# Fleet PR babysitter

Run `./fleet-pr-babysitter/setup.sh` from the VibeCoder checkout for
interactive setup. It asks before installing a macOS launch agent; answer no
until you have manually tested a fix.

Run `./fleet-pr-babysitter/run.sh --dry-run` to list candidates without a
model, or `./fleet-pr-babysitter/run.sh` for one fixing pass. Pass `--watch`
for the five-minute loop.

The runner uses the configured GitHub App and its own API quota. Read the
[operator guide](../docs/workflows/fleet-pr-babysitter.md)
for setup, shared-lock requirements and limitations before running it.
