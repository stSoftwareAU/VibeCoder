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
