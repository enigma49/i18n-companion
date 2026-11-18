import type {Diagnostic} from './diagnostics.js';
import type {PlanFile} from './plan.js';

/** Diagnostics that need a person's decision; the assistant must report them, never guess. */
const NEEDS_DECISION = new Set(['I18N_DYNAMIC_KEY', 'I18N_AMBIGUOUS_PROP', 'I18N_UNSUPPORTED_SHAPE', 'I18N_UNSUPPORTED_REGION', 'I18N_PARSE_ERROR']);

export interface PlanSummary {
  planId: string;
  scope: PlanFile['scope'];
  filesToChange: string[];
  messagesToAdd: number;
  /** Translation work per locale, by reason. */
  work: Record<string, {new: number; missing: number; stale: number}>;
  staged: number;
  gaveUp: number;
  applied: boolean;
  needsDecision: Diagnostic[];
  diagnostics: Diagnostic[];
}

/** A compact view of a plan for people and assistants; the plan file itself is much larger. */
export function summarizePlan(plan: PlanFile): PlanSummary {
  const work: PlanSummary['work'] = {};
  for (const locale of plan.targetLocales) work[locale] = {new: 0, missing: 0, stale: 0};
  for (const w of plan.work) (work[w.locale] ??= {new: 0, missing: 0, stale: 0})[w.reason]++;
  return {
    planId: plan.id,
    scope: plan.scope,
    filesToChange: plan.files.map((f) => f.file),
    messagesToAdd: plan.newMessages.length,
    work,
    staged: plan.staged.length,
    gaveUp: plan.gaveUp.length,
    applied: Boolean(plan.appliedAt),
    needsDecision: plan.diagnostics.filter((d) => NEEDS_DECISION.has(d.code)),
    diagnostics: plan.diagnostics.filter((d) => !NEEDS_DECISION.has(d.code)),
  };
}
