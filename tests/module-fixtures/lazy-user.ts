// Two shapes reach a module by destructuring it: the awaited call, and the
// callback `then` hands the namespace to. `plated` is renamed on the way in,
// which names the export through `propertyName` rather than `name`.
export async function serve(): Promise<number> {
  const { plated: dish, Course } = await import('./lazy');
  return dish + Course.Main.length;
}

export function serveLater(): Promise<number> {
  return import('./lazy').then(({ poured }) => poured);
}
