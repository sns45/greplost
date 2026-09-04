import { createFileRoute } from "@tanstack/react-start";

export const Route = createFileRoute("/posts/$id")({
  loader: fetchPost,
});

async function fetchPost() {
  return { id: "1" };
}
