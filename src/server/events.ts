/**
 * NDJSON step-events the deploy operation emits on stdout (ADR 0006). `ex`
 * relays them as live progress; anything else can parse them.
 */
export type StepName =
  | "unpack"
  | "prepare"
  | "allocate"
  | "unit"
  | "verify"
  | "cutover"
  | "route"
  | "live";

export type DeployEvent =
  | { event: "step"; step: StepName; status: "start" }
  | { event: "step"; step: StepName; status: "ok" | "skip" | "fail"; detail?: string }
  | { event: "deployed"; domain: string; release: string; target: string }
  | { event: "error"; message: string };

export type Emit = (e: DeployEvent) => void;

export const stdoutEmitter: Emit = (e) => {
  console.log(JSON.stringify(e));
};
