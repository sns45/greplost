import { createFileRoute } from "@tanstack/react-start";
import { Button } from "../Button";

export const Route = createFileRoute("/")({
  component: Home,
  loader: load,
});

function load() {
  return { ok: true };
}

function Home() {
  return (
    <div>
      <Button label="press" />
    </div>
  );
}
