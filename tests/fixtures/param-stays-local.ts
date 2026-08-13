export function localOnly(cfg: { used: number; deadProp: number }): number {
  return cfg.used;
}
// Referenced in-file, so the export is not dead and its members stay reported.
void localOnly;
