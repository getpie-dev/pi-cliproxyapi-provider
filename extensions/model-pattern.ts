import { minimatch } from "minimatch";

const MINIMATCH_OPTIONS = { nocase: true } as const;

/** Drop models whose id matches a disabledModels pattern. Unset or empty patterns keep every model. */
export function omitDisabledModels<T extends { id: string }>(
  models: readonly T[],
  providerId: string,
  patterns?: readonly string[],
): T[] {
  if (!patterns?.length) return [...models];
  const disabled = new Set<T>();
  for (const pattern of patterns) {
    for (const model of modelsForPattern(models, providerId, pattern)) disabled.add(model);
  }
  return models.filter((model) => !disabled.has(model));
}

// Pi globs only for `*`, `?`, or `[`, with minimatch on `provider/id` and the bare id.
// A listed exact id wins, so `model[1m]` is not a character class while that model exists.
function modelsForPattern<T extends { id: string }>(
  models: readonly T[],
  providerId: string,
  pattern: string,
): readonly T[] {
  const spec = pattern.trim();
  if (!spec) return [];
  const exact = models.filter((model) => exactModel(spec, providerId, model.id));
  const glob = spec.includes("*") || spec.includes("?") || spec.includes("[");
  if (!glob || exact.length > 0) return exact;
  return models.filter(
    (model) =>
      minimatch(`${providerId}/${model.id}`, spec, MINIMATCH_OPTIONS) ||
      minimatch(model.id, spec, MINIMATCH_OPTIONS),
  );
}

function exactModel(spec: string, providerId: string, modelId: string): boolean {
  const folded = spec.toLowerCase();
  return folded === modelId.toLowerCase() || folded === `${providerId}/${modelId}`.toLowerCase();
}
