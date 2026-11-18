import {execFileSync} from 'node:child_process';
import {analyzeFile} from '../adapters/next-intl/index.js';
import {flatten, getMessage} from './catalog.js';
import {diag, type Diagnostic} from './diagnostics.js';
import {listFiles} from './fsutil.js';
import {validateMessage, validateTranslation} from './icu.js';
import {readState, type Project} from './project.js';
import {statusOf, type TranslationStatus} from './registry.js';

export type FailReason = 'invalid' | 'hardcoded' | 'missing' | 'stale' | 'draft' | 'orphan' | 'review';

export interface LocaleSummary {
  locale: string;
  total: number;
  coverage: number;
  reviewed: number;
  counts: Record<TranslationStatus, number>;
}

export interface CheckResult {
  ok: boolean;
  failedOn: FailReason[];
  locales: LocaleSummary[];
  filesChecked: number;
  diagnostics: Diagnostic[];
}

export interface CheckOptions {
  /** Only scan these files for hardcoded text (e.g. the files changed in a pull request). */
  files?: string[];
  /** Diff base for `changed`; files changed since this ref plus uncommitted ones. */
  changedSince?: string;
}

/** Files changed since a git ref, plus uncommitted and untracked ones. */
export function changedFiles(root: string, base: string): string[] {
  const run = (args: string[]): string[] => {
    try {
      return execFileSync('git', args, {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  };
  const mergeBase = run(['merge-base', base, 'HEAD'])[0] ?? base;
  return [...new Set([...run(['diff', '--name-only', mergeBase]), ...run(['ls-files', '--others', '--exclude-standard'])])];
}

/** The CI check: catalogs are valid, translations are current, and no new text is hardcoded. */
export async function checkProject(project: Project, options: CheckOptions = {}): Promise<CheckResult> {
  const {config, root} = project;
  const state = await readState(project);
  const failOn = new Set(config.policy.failOn);
  const diagnostics: Diagnostic[] = [];
  const reasons = new Set<FailReason>();
  const fail = (reason: FailReason, d: Diagnostic): void => {
    if (failOn.has(reason)) {
      reasons.add(reason);
      diagnostics.push({...d, severity: 'error'});
    } else diagnostics.push({...d, severity: d.severity === 'error' ? 'warning' : d.severity});
  };

  const source = flatten(state.source.tree);
  for (const [id, text] of source) for (const d of validateMessage(text, config.sourceLocale, {id})) fail('invalid', d);

  const locales: LocaleSummary[] = [];
  for (const locale of config.targetLocales) {
    const tree = state.targets[locale]!.tree;
    const counts: Record<TranslationStatus, number> = {missing: 0, stale: 0, draft: 0, 'machine-validated': 0, 'human-reviewed': 0};
    for (const [id, src] of source) {
      const msg = state.registry.messages[id]!;
      const text = getMessage(tree, id);
      const status = statusOf(msg, locale, text);
      counts[status]++;
      if (text !== undefined) {
        for (const d of validateTranslation(src, text, locale, {id})) {
          if (d.severity === 'error') fail('invalid', d);
          else diagnostics.push(d);
        }
      }
      if (status === 'missing') fail('missing', diag('I18N_MISSING_TRANSLATION', 'warning', `${id} has no ${locale} translation.`, {id, locale}));
      if (status === 'stale') fail('stale', diag('I18N_STALE', 'warning', `${id} (${locale}) is out of date with the source text.`, {id, locale}));
      if (status === 'draft') fail('draft', diag('I18N_DRAFT', 'info', `${id} (${locale}) is a draft nobody has checked.`, {id, locale}));
      if (msg.translations[locale]?.proposal) {
        diagnostics.push(diag('I18N_PROPOSAL_WAITING', 'info', `${id} (${locale}) has a suggested update waiting next to the reviewed text.`, {id, locale}));
      }
      for (const rule of config.policy.requireReview) {
        const applies = rule.ids.some((p) => id === p || id.startsWith(p.endsWith('.') ? p : `${p}.`)) && (!rule.locales || rule.locales.includes(locale));
        if (applies && status !== 'human-reviewed') {
          fail('review', diag('I18N_REVIEW_REQUIRED', 'warning', `${id} (${locale}) must be reviewed by a person before release.`, {id, locale}));
        }
      }
    }
    for (const id of flatten(tree).keys()) {
      if (!source.has(id)) fail('orphan', diag('I18N_ORPHAN_KEY', 'warning', `${locale} has ${id}, which the source catalog no longer has.`, {id, locale}));
    }
    const total = source.size;
    const translated = total - counts.missing;
    locales.push({
      locale,
      total,
      coverage: total ? Math.round((translated / total) * 100) : 100,
      reviewed: total ? Math.round((counts['human-reviewed'] / total) * 100) : 100,
      counts,
    });
  }

  const all = await listFiles(root, config.include, config.exclude);
  let files = all;
  if (options.files) files = all.filter((f) => options.files!.includes(f));
  else if (options.changedSince) {
    const changed = new Set(changedFiles(root, options.changedSince));
    files = all.filter((f) => changed.has(f));
  }
  for (const file of files) {
    const {analysis} = await analyzeFile(root, file);
    for (const d of analysis.diagnostics) {
      if (d.code === 'I18N_HARDCODED_STRING') fail('hardcoded', {...d, hint: d.hint ?? 'ask your assistant to "localize the changed files"'});
      else if (d.code === 'I18N_PARSE_ERROR') diagnostics.push(d);
      else if (d.code !== 'I18N_UNSUPPORTED_SHAPE') diagnostics.push(d);
    }
    for (const u of analysis.usages) {
      if (u.id && !source.has(u.id)) {
        fail('invalid', diag('I18N_UNKNOWN_KEY', 'error', `${u.id} is used in code but missing from the ${config.sourceLocale} catalog.`, {file: u.file, line: u.line, id: u.id}));
      }
    }
  }
  return {ok: reasons.size === 0, failedOn: [...reasons], locales, filesChecked: files.length, diagnostics};
}
