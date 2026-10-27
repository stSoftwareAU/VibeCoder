resource "aws_iam_role" "ci" {
  name        = "ci-deploy"
  description = "Pipeline role that deploys the service"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ci_assume_admin" {
  name = "assume-admin"
  role = aws_iam_role.ci.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sts:AssumeRole"
      Resource = aws_iam_role.admin.arn
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

data "aws_iam_policy_document" "admin" {
  statement {
    actions   = ["iam:*"]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "admin_full" {
  name   = "admin"
  role   = aws_iam_role.admin.name
  policy = data.aws_iam_policy_document.admin.json
}
