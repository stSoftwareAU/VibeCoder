variable "role_arn" {
  type = string
}

resource "aws_iam_role" "ci" {
  name        = "ci-deploy"
  description = "Pipeline role that assumes a role passed in as a variable"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ci_assume" {
  name = "assume"
  role = aws_iam_role.ci.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sts:AssumeRole"  # nosemgrep: terraform.lang.security.iam.no-iam-creds-exposure.no-iam-creds-exposure -- deliberate scanner fixture
      Resource = var.role_arn
    }]
  })
}

resource "aws_iam_role" "admin" {
  name = "admin-deploy"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { AWS = aws_iam_role.ci.arn }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "admin_full" {
  name = "admin"
  role = aws_iam_role.admin.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "iam:*"  # nosemgrep: terraform.lang.security.iam.no-iam-creds-exposure.no-iam-creds-exposure, terraform.lang.security.iam.no-iam-priv-esc-funcs.no-iam-priv-esc-funcs, terraform.lang.security.iam.no-iam-priv-esc-other-users.no-iam-priv-esc-other-users, terraform.lang.security.iam.no-iam-resource-exposure.no-iam-resource-exposure -- deliberately over-privileged scanner fixture
      Resource = "*"
    }]
  })
}
