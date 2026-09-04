import { describe, expect, test } from "bun:test";
import { isNodeKind, nodeId, splitNodeId } from "../src/schema.ts";

describe("node ids (schema 2)", () => {
  test("round-trips a resource id and rejects forbidden characters", () => {
    const id = nodeId("infra/main.tf", "resource", "aws_s3_bucket.logs");
    expect(id).toBe("infra/main.tf#resource.aws_s3_bucket.logs");
    expect(splitNodeId(id)).toEqual({ file: "infra/main.tf", kind: "resource", name: "aws_s3_bucket.logs" });
    expect(() => nodeId("a.tf", "resource", "bad#name")).toThrow();
  });
  test("a plain symbol id is not a node id", () => {
    expect(splitNodeId("packages/core/src/registry.ts#Registry.register")).toBeNull();
    expect(splitNodeId("packages/core/src/registry.ts")).toBeNull();
    expect(isNodeKind("function")).toBe(false);
    expect(isNodeKind("route")).toBe(true);
  });
});
