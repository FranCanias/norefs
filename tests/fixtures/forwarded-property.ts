interface Sink {
  items: Array<{ id: string; label: string }>;
}

export function convert(raw: unknown): Sink {
  const data = raw as { items?: Array<{ id: string; label: string; extra?: number }> };
  return { items: data.items ?? [] };
}

export function readSink(s: Sink): string {
  return s.items.map(i => i.id + i.label).join(',');
}
