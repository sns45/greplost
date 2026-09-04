terraform {
  required_version = ">= 1.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

locals {
  name = "tiny"
  tags = { Name = local.name }
}

resource "aws_vpc" "main" {
  cidr_block = var.cidr
  tags       = local.tags
}

resource "aws_subnet" "a" {
  vpc_id     = aws_vpc.main.id
  cidr_block = var.cidr
}

module "logs" {
  source = "./modules/logs"
  bucket = aws_vpc.main.id
}
