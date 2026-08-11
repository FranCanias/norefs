interface Runner {
  run(): void;
}

export class TaskRunner implements Runner {
  run(): void {}
}

export function exec(r: Runner): void {
  r.run();
}

exec(new TaskRunner());
