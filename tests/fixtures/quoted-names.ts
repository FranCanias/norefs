export interface QuotedNames {
  'evt:used': number;
  'evt:dead': number;
}

export function readQuoted(v: QuotedNames): number {
  return v['evt:used'];
}
