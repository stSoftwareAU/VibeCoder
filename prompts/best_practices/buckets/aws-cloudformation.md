# Bucket: `aws-cloudformation`

Canonical guides — link, do not restate:

- AWS Well-Architected Framework —
  <https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html>
  (Reliability and Security pillars in particular).
- CloudFormation best practices —
  <https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/best-practices.html>

Apply these checks to CloudFormation templates: YAML or JSON files
containing `AWSTemplateFormatVersion`, plus CDK-emitted templates.

## Checks

1. **Least-privilege IAM.** `AWS::IAM::Role` and policy resources
   scope `Action` and `Resource` to the narrowest set required.
   Flag wildcard `Action: "*"`, `Resource: "*"`, and policies that
   grant `iam:PassRole` on `*`. Reference the AWS Security pillar.
2. **Encryption at rest defaults on.** `AWS::S3::Bucket`,
   `AWS::RDS::DBInstance`, `AWS::DynamoDB::Table`,
   `AWS::EBS::Volume`, and EFS/SNS/SQS resources declare
   server-side encryption (KMS-backed where the data is sensitive).
   Flag templates that rely on account-level defaults instead of
   making encryption explicit in the template.
3. **Encryption in transit.** S3 buckets attach a bucket policy
   denying `aws:SecureTransport: false`; ALB / API Gateway
   listeners terminate TLS; RDS parameter groups require SSL
   connections where the engine supports it. Flag plaintext-only
   listeners.
4. **No public exposure by default.** Security groups do not open
   `0.0.0.0/0` on management ports (22, 3389, database ports).
   S3 buckets enable `PublicAccessBlockConfiguration` with all four
   flags `true` unless the bucket is intentionally public (e.g. a
   static website) and that intent is documented in the template.
5. **Drift-friendly resource design.** Resources use logical IDs
   that are stable across stack updates; physical names use
   `!Sub` with `AWS::StackName` so cross-environment reuse works;
   avoid hard-coded ARNs that pin the template to one account.
   Flag hard-coded account IDs in templates.
6. **Outputs and exports kept minimal.** Cross-stack `Export` is
   irreversible once consumed by another stack — every export
   creates a tight coupling. Flag templates that export every
   resource by default; export only what is actually consumed.
7. **Reliability — backups and multi-AZ.** Stateful resources
   (RDS, DynamoDB, EBS) declare backup retention and, for
   production-tier templates, multi-AZ deployment. Flag absent
   `BackupRetentionPeriod` on RDS and absent
   `PointInTimeRecoverySpecification` on DynamoDB in production
   templates.
8. **DeletionPolicy on data resources.** S3 buckets, RDS instances,
   and DynamoDB tables that hold production data carry
   `DeletionPolicy: Retain` (or `Snapshot` for RDS) so a stack
   teardown does not vaporise the data. Flag missing
   `DeletionPolicy` on data resources.

## Cost, speed and reliability

Concrete, evidence-cited checks only: skip anything you cannot tie to a
file and line. Each finding carries an `**Estimated effect:**` line
derived from the cited source and marked estimated, plus a `**Risk:**`
line naming what the change could break, and competes for the reserved
slot in Phase 3. Severity is `severity:low`, or `severity:medium` on a
production path; never `severity:high`. Each stable id uses the standard
`BP-<12 hex>` recipe with the title given and the cited file.

9. **Lambda on x86_64.** Flag an `AWS::Lambda::Function` (or
   `AWS::Serverless::Function` with no `Globals` override) without
   `Architectures: [arm64]`. Effect: arm64 is about 20% cheaper per
   GB-second. Risk: native dependencies and container images must be
   rebuilt for arm64. Stable id: title `Lambda <LogicalId> runs on
   x86_64`.
10. **Lambda memory and timeout sizing.** Flag `MemorySize` of 3008 or
    more with no tuning evidence (a Power Tuning result or comment), and
    a `Timeout` above 29 seconds on a function behind API Gateway, which
    stops waiting at 29 seconds. Effect: cost scales linearly with
    `MemorySize`. Risk: less memory also means less CPU, so latency may
    rise. Stable id: title `Lambda <LogicalId> memory or timeout
    oversized`.
11. **Lambda logs kept for ever.** Flag a function with no
    `AWS::Logs::LogGroup` carrying `RetentionInDays` for it (by
    `/aws/lambda/<name>` or `LoggingConfig.LogGroup`). Effect: storage
    cost stops growing without bound. Risk: logs older than the period
    are gone, so match any audit requirement. Stable id: title `Lambda
    <LogicalId> has no log retention`.
12. **Provisioned capacity without scaling.** Flag
    `AWS::DynamoDB::Table` with `BillingMode: PROVISIONED` and no
    `AWS::ApplicationAutoScaling::ScalableTarget` for it. Effect: pay
    for use rather than the provisioned peak. Risk: on-demand costs more
    under steady high load, so cite the traffic evidence. Stable id:
    title `DynamoDB <LogicalId> provisioned without scaling`.
13. **Always-on resources in non-production.** Flag
    `AWS::EC2::NatGateway`, RDS instances and similar hourly-billed
    resources not gated by a `Condition` in a template whose parameters
    or conditions define a non-production environment. Effect: a NAT
    gateway alone is roughly USD 30 a month plus data charges
    (region-dependent). Risk: non-production diverges from production.
    Stable id: title `<LogicalId> always on in non-production`.
14. **S3 bucket without lifecycle rules.** Flag an `AWS::S3::Bucket`
    holding logs, artefacts or uploads with no `LifecycleConfiguration`
    (expiry, storage-class transition, or
    `AbortIncompleteMultipartUpload`). Effect: storage stops growing
    without bound. Risk: expired objects are gone. Stable id: title `S3
    bucket <LogicalId> has no lifecycle rules`.
15. **No alarm or dead-letter queue on async work.** Flag a Lambda
    event source or SQS queue with no `RedrivePolicy` or
    `DestinationConfig.OnFailure`, and cost-bearing resources with no
    `AWS::CloudWatch::Alarm` on errors, throttles or queue depth.
    Effect: failures surface instead of retrying silently. Risk: alarm
    noise until thresholds are tuned. Stable id: title `<LogicalId> has
    no failure alarm or dead-letter queue`.

Checks 9 and 11 are also detected mechanically: an `aws-cloudformation`
run lists any hits under `## Deterministic pre-scan candidates` below.
