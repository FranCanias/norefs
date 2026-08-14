// A discriminant nothing reads at runtime. `Extract` reads it on every compile:
// drop `kind` from the filter and the alias matches both branches, drop it from
// a branch and the filter matches neither.
export interface DailyRule {
  kind: 'DAILY';
  hour: number;
}

export interface WeeklyRule {
  kind: 'WEEKLY';
  deadDay: number;
}

export type Rule = DailyRule | WeeklyRule;

export type OnlyDaily = Extract<Rule, { kind: 'DAILY' }>;

export function ruleHour(rule: OnlyDaily): number {
  return rule.hour;
}

// The same match written out, with no alias in between.
export interface Envelope {
  channel: string;
  deadTimestamp: number;
}

export type Addressed<T> = T extends { channel: string } ? T : never;

export function addressOf(envelope: Addressed<Envelope>): string {
  return envelope.channel;
}
