export const recipeSteps = { chop: 1, simmer: 2 } as const;

/** `keyof typeof` is the code saying the keys get enumerated elsewhere. */
export type RecipeStep = keyof typeof recipeSteps;
