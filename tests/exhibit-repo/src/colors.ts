export interface ChartColors {
  canvas: string;
  grid: string;
  curve: string;
  axis: string;
}

/** The 0.4.0 review's colour chain: every write carries a comment beside it. */
export function useChartColors(): ChartColors {
  const canvas = theme('canvas');
  const grid = theme('grid');
  const curve = theme('curve');
  return useMemo(
    () => ({
      canvas, // light: #F9F9FA, dark: #242424
      // Grid - more visible in dark
      grid, // light: #E6E7E8, dark: #383838
      curve, // light: #94969D, dark: #FF9999
      axis: 'a',
    }),
    [canvas, grid, curve]
  );
}
