/**
 * The 0.4.0 review's IPC bridge. The class is used in its own file only, so
 * it is over-exported: the fix drops a keyword and every sender lives on.
 * `oldRecipe` is the one that dies, and only its handler is stranded.
 */
export class RecipeBoxService {
  saveRecipe(recipe: unknown): Promise<unknown> {
    return api.invoke('recipeBox:saveRecipe', recipe);
  }
  oldRecipe(): Promise<unknown> {
    return api.invoke('recipeBox:oldRecipe');
  }
}

export const sidebar = (): Promise<unknown> => new RecipeBoxService().saveRecipe(1);
