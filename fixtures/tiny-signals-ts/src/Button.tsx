import * as React from "react";

export interface Props {
  label: string;
}

export function Button(props: Props) {
  const [pressed, setPressed] = React.useState(false);
  return <button onClick={() => setPressed(!pressed)}>{props.label}</button>;
}
