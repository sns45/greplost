import * as React from "react";

export default function User() {
  return <div>{React.useMemo(() => "user", [])}</div>;
}
