export class Service {
  constructor(
    private readonly db: string,
    private readonly deadDep: number
  ) {}

  query(): string {
    return this.db;
  }
}

new Service('d', 1).query();
