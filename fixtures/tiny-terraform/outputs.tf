output "vpc_id" {
  value = aws_vpc.main.id
}

output "logs_arn" {
  value = module.logs.arn
}
