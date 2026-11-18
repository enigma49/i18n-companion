import {importResponse, nextBatch, readPlan, type ImportResult, type PlanFile} from '../core/plan.js';
import type {Project} from '../core/project.js';
import {createAnthropicProvider} from './anthropic.js';
import type {TranslationProvider} from './types.js';
import {CompanionError, diag} from '../core/diagnostics.js';

export function providerFromConfig(project: Project): TranslationProvider {
  const p = project.config.translation.provider;
  if (!p) {
    throw new CompanionError(
      diag('I18N_PROVIDER_ERROR', 'error', 'No provider is configured. Add translation.provider to the config, e.g. {name: "anthropic"}.'),
    );
  }
  return createAnthropicProvider({model: p.model, apiKeyEnv: p.apiKeyEnv});
}

export interface ProviderRunResult {
  batches: number;
  accepted: number;
  rejected: number;
  gaveUp: number;
  results: ImportResult[];
}

/**
 * Translates every pending item in a plan with a provider: batch, translate, import, repeat.
 * Rejected items come back in a later batch with their errors, and are dropped after the
 * attempt limit, so the loop always ends.
 */
export async function translatePlanWithProvider(
  project: Project,
  planRef: string,
  provider: TranslationProvider,
  options: {batchSize?: number; maxBatches?: number; onBatch?: (r: ImportResult, locale: string) => void} = {},
): Promise<ProviderRunResult> {
  let plan: PlanFile = await readPlan(project, planRef);
  const size = options.batchSize ?? project.config.translation.provider?.maxBatchSize ?? 25;
  const limit = options.maxBatches ?? 500;
  const out: ProviderRunResult = {batches: 0, accepted: 0, rejected: 0, gaveUp: 0, results: []};
  while (out.batches < limit) {
    const batch = await nextBatch(project, plan, size);
    if (!batch.batchId || !batch.items.length) break;
    const response = await provider.translateBatch(batch);
    plan = await readPlan(project, plan.id);
    // Items the model skipped count as failed attempts, so they cannot loop forever.
    const answered = new Set(response.translations.map((t) => t.id));
    for (const item of batch.items) {
      if (!answered.has(item.id)) {
        response.translations.push({id: item.id, locale: batch.targetLocale!, sourceRevision: item.sourceRevision, text: ''});
      }
    }
    const result = await importResponse(project, plan, response, 'provider', provider.model);
    plan = await readPlan(project, plan.id);
    out.batches++;
    out.accepted += result.accepted.length;
    out.rejected += result.rejected.length;
    out.gaveUp += result.gaveUp.length;
    out.results.push(result);
    options.onBatch?.(result, batch.targetLocale!);
  }
  return out;
}
