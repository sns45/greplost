export enum Priority {
  Low = 0,
  Normal = 1,
  High = 2,
}

export type Handler = (name: string) => void;

export const VERSION = "1.0.0";
