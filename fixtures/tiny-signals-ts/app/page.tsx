import * as React from "react";

export const runtime = "edge";

export default function Page() {
  return <main>{React.useMemo(() => "home", [])}</main>;
}
