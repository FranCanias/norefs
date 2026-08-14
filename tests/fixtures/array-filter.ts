// A filter one level in, where the property holds an array. The literal
// describes one element, so both sides shed their array together: `done` is
// read on `Step`, and the member beside it still goes.
export interface Step {
  done: boolean;
  deadNote: string;
}

export interface Job {
  steps: Step[];
}

export type FinishedJob = Extract<Job, { steps: { done: true }[] }>;

export function stepsOf(job: FinishedJob): Step[] {
  return job.steps;
}

// The same filter written without the array. `Step[]` is not a `{ ready: true }`,
// so this selects nothing — and a name it reads on the way selects nothing
// either. Crediting `ready` here would keep a dead member alive on the strength
// of a filter that can never match.
export interface Batch {
  label: string;
  ready: boolean;
  deadCount: number;
}

export interface Run {
  batches: Batch[];
}

export type ReadyRun = Extract<Run, { batches: { ready: true } }>;

export function readyRuns(): ReadyRun[] {
  return [];
}

export function firstLabel(run: Run): string {
  return run.batches[0].label;
}
