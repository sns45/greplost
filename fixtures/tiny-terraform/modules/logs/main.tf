variable "bucket" {
  type = string
}

resource "aws_s3_bucket" "logs" {
  bucket = var.bucket
}
