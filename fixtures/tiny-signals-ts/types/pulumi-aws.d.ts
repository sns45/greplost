import { CustomResource, Output } from "@pulumi/pulumi";

export declare namespace s3 {
  class Bucket extends CustomResource {
    constructor(name: string, args?: { tags?: Record<string, string> });
    readonly arn: Output<string>;
  }
  class BucketPolicy extends CustomResource {
    constructor(name: string, args: { bucket: unknown; policy?: unknown });
  }
}
