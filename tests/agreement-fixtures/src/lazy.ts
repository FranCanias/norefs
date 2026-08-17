export const lazily = async (): Promise<string> => {
  const mod = await import('dynamic-dep');
  return mod.lazy;
};
