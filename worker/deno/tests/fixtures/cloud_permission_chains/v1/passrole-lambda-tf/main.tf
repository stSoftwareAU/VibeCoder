resource "aws_iam_role" "ci" {
  name        = "ci-deploy"
  description = "Pipeline role that ships the function"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

data "aws_iam_policy_document" "ci_pass" {
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.runtime.arn]
  }
  statement {
    actions   = ["lambda:CreateFunction"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ci_pass" {
  name   = "pass-runtime"
  role   = aws_iam_role.ci.name
  policy = data.aws_iam_policy_document.ci_pass.json
}

resource "aws_iam_role" "runtime" {
  name = "runtime-admin"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "runtime_admin" {
  name = "admin"
  role = aws_iam_role.runtime.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "iam:*"  # nosemgrep: terraform.lang.security.iam.no-iam-creds-exposure.no-iam-creds-exposure, terraform.lang.security.iam.no-iam-priv-esc-funcs.no-iam-priv-esc-funcs, terraform.lang.security.iam.no-iam-priv-esc-other-users.no-iam-priv-esc-other-users, terraform.lang.security.iam.no-iam-resource-exposure.no-iam-resource-exposure -- deliberately over-privileged scanner fixture
      Resource = "*"
    }]
  })
}
