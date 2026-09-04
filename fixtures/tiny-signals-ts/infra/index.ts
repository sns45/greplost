import * as aws from "@pulumi/aws";

const bucket = new aws.s3.Bucket("logs");

const policy = new aws.s3.BucketPolicy("p", {
  bucket: bucket.id,
});

export const policyUrn = policy.urn;
