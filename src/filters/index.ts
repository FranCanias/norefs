import type { Finding } from '../types';

export interface FilterOptions {
  anonymous: boolean;
}

export function applyFilters(findings: Finding[], options: FilterOptions): Finding[] {
  return findings.filter(f => options.anonymous || !f.anonymous);
}
