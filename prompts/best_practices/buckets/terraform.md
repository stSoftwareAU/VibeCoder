# Bucket: `terraform`

Canonical guides — link, do not restate:

- Terraform style guide —
  <https://developer.hashicorp.com/terraform/language/style>
- Module composition —
  <https://developer.hashicorp.com/terraform/language/modules/develop>
- Recommended practices —
  <https://developer.hashicorp.com/terraform/cloud-docs/recommended-practices>

Apply these checks to `*.tf` and `*.tfvars` files.

## Checks

1. **Module structure.** Each module exposes a clear interface in
   `variables.tf` and `outputs.tf`; resources live in
   `main.tf` (or grouped files such as `network.tf`, `iam.tf`).
   Flag modules that mix variables, outputs, and resources in a
   single file beyond a small example.
2. **Variable typing and validation.** Every `variable` declares a
   `type` (`string`, `number`, `bool`, `list(...)`, `map(...)`,
   `object({...})`) and, where the value is constrained, a
   `validation` block. Flag untyped variables and string variables
   that should be enumerated (e.g. environment names).
3. **No hardcoded credentials.** AWS access keys, GCP service
   account JSON, database passwords, and API tokens are sourced
   from variables, environment, or a secrets manager — never
   committed in `.tf` or `.tfvars`. Flag any literal-looking
   secret pattern (AKIA-prefix, `password = "..."`).
4. **`terraform fmt`-clean.** Code is formatted to canonical
   spacing and alignment. Flag obvious formatting drift — but
   prefer to suggest running `terraform fmt -recursive` rather
   than nitpicking line-by-line.
5. **Remote state — encrypted at rest and lock-protected.**
   Production-tier modules configure a remote state backend
   (`backend "s3"`, `backend "gcs"`, Terraform Cloud, etc.) with
   **encryption at rest** and **state locking**. For the S3
   backend that means `encrypt = true` plus a DynamoDB lock table
   (or the native S3 lockfile on Terraform 1.10+); for `gcs`,
   `azurerm`, and Terraform Cloud the backend-native equivalents
   apply (GCS bucket CMEK / default encryption, Azure storage
   account encryption + blob lease, Terraform Cloud workspace
   locking). Flag root modules that rely on local state
   (`terraform.tfstate` in the repo) for shared environments,
   that omit `encrypt = true` on S3, or that configure no
   locking mechanism. Cite the `backend` block. **Severity:**
   `severity:medium` by default; `severity:high` when state is
   provably unencrypted on a backend known to hold sensitive
   outputs (DB endpoints with passwords, generated tokens).
6. **Provider version pinning.** `required_providers` blocks pin
   provider versions with a `~>` operator at minimum (e.g.
   `~> 5.0`) so a patch update does not break the plan. Flag
   unpinned providers.
7. **Sensitive outputs marked `sensitive = true`.** Outputs that
   surface secrets (DB endpoints with passwords, generated
   tokens) declare `sensitive = true` so `terraform output` does
   not print them in plaintext logs.
8. **No `count`-and-`for_each` mixing on the same resource.**
   Pick one. Mixing causes confusing index churn on every change.
   Prefer `for_each` over `count` for resources keyed by a stable
   identifier (HashiCorp style guide).
9. **Terraform security scanner in CI.** Production Terraform
   repos wire a static IaC security scanner — `tfsec`,
   `trivy config`, or `checkov` — into CI so misconfigurations
   (open security groups, unencrypted resources, public S3
   buckets) are caught before `terraform apply`. Inspect
   `.github/workflows/*.yml` (and equivalents for GitLab CI,
   CircleCI, Buildkite) for a step invoking one of those
   scanners against `*.tf` paths. Flag Terraform repos with no
   such step. This is a **configuration audit** — **do not run**
   the scanner inside the best-practices template; static
   evidence (CI workflow) is the only signal. Suggested fix:
   add a `tfsec`/`trivy config`/`checkov` step to the existing
   Terraform CI job. **Severity:** `severity:medium`.

## Cost, speed and reliability

Concrete, evidence-cited checks only: skip anything you cannot tie to a
file and line. Each finding carries an `**Estimated effect:**` line
derived from the cited source and marked estimated, plus a `**Risk:**`
line naming what the change could break, and competes for the reserved
slot in Phase 3. Severity is `severity:low`, or `severity:medium` on a
production path; never `severity:high`. Each stable id uses the standard
`BP-<12 hex>` recipe with the title given and the cited file.

10. **Lambda on x86_64.** Flag `aws_lambda_function` without
    `architectures = ["arm64"]`. Effect: arm64 is about 20% cheaper per
    GB-second. Risk: native dependencies and images must be rebuilt for
    arm64. Stable id: title `Lambda <resource name> runs on x86_64`.
11. **Lambda memory and timeout sizing.** Flag `memory_size` of 3008 or
    more with no tuning evidence, and `timeout` above 29 seconds on a
    function behind API Gateway. Effect: cost scales linearly with
    memory. Risk: less memory also means less CPU. Stable id: title
    `Lambda <resource name> memory or timeout oversized`.
12. **Logs kept for ever.** Flag a Lambda with no
    `aws_cloudwatch_log_group` for `/aws/lambda/<name>`, and any
    `aws_cloudwatch_log_group` without `retention_in_days` (or set to
    `0`). Effect: storage cost stops growing without bound. Risk: older
    logs are gone, so match any audit requirement. Stable id: title
    `<resource name> has no log retention`.
13. **Provisioned capacity without scaling.** Flag
    `aws_dynamodb_table` with `billing_mode = "PROVISIONED"` and no
    `aws_appautoscaling_target` for it. Effect: pay for use rather than
    the provisioned peak. Risk: on-demand costs more under steady high
    load, so cite the traffic evidence. Stable id: title `DynamoDB
    <resource name> provisioned without scaling`.
14. **Always-on resources in non-production.** Flag `aws_nat_gateway`,
    `aws_db_instance` and similar hourly-billed resources that no
    `count` or `for_each` gates on the environment, in a module deployed
    to non-production. Effect: a NAT gateway alone is roughly USD 30 a
    month plus data charges (region-dependent). Risk: non-production
    diverges from production. Stable id: title `<resource name> always
    on in non-production`.
15. **S3 bucket without lifecycle rules.** Flag an `aws_s3_bucket`
    holding logs, artefacts or uploads with no
    `aws_s3_bucket_lifecycle_configuration`. Effect: storage stops
    growing without bound. Risk: expired objects are gone. Stable id:
    title `S3 bucket <resource name> has no lifecycle rules`.
16. **No alarm or dead-letter queue on async work.** Flag an
    `aws_sqs_queue` or `aws_lambda_event_source_mapping` with no
    `redrive_policy` or failure destination, and cost-bearing resources
    with no `aws_cloudwatch_metric_alarm` on errors, throttles or queue
    depth. Effect: failures surface instead of retrying silently. Risk:
    alarm noise until thresholds are tuned. Stable id: title `<resource
    name> has no failure alarm or dead-letter queue`.
