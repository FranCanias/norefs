import { type ChartColors, useChartColors } from './colors';
import { attach, type PanelHandle } from './handle';
import { sidebar } from './service';

declare function handle(channel: string, listener: () => unknown): void;
declare const colors: ChartColors;
declare const panel: PanelHandle;

export function main(): void {
  useChartColors();
  void sidebar();
  attach({}, panel);
  console.log(colors.axis);
  handle('recipeBox:saveRecipe', () => 0);
  handle('recipeBox:oldRecipe', () => 0);
}
