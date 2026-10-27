resource "aws_iam_role" "ci" {
  name        = "ci-deploy"
  description = "Pipeline role that runs post-deploy checks"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "ci_run_command" {
  name = "run-command"
  role = aws_iam_role.ci.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "ssm:SendCommand"
      Resource = "*"
    }]
  })
}

resource "aws_iam_role" "app" {
  name = "app-instance"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "app_admin" {
  name = "admin"
  role = aws_iam_role.app.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "iam:*"  # nosemgrep: terraform.lang.security.iam.no-iam-creds-exposure.no-iam-creds-exposure, terraform.lang.security.iam.no-iam-priv-esc-funcs.no-iam-priv-esc-funcs, terraform.lang.security.iam.no-iam-priv-esc-other-users.no-iam-priv-esc-other-users, terraform.lang.security.iam.no-iam-resource-exposure.no-iam-resource-exposure -- deliberately over-privileged scanner fixture
      Resource = "*"
    }]
  })
}

resource "aws_iam_instance_profile" "app" {
  name = "app-instance"
  role = aws_iam_role.app.name
}

resource "aws_instance" "app" {
  ami                  = "ami-0123456789abcdef0"
  instance_type        = "t3.micro"
  iam_instance_profile = aws_iam_instance_profile.app.name
  tags = {
    Name = "app"
  }
}
