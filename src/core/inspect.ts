import {detectProject, type Detection} from './detect.js';
import {CompanionError, diag, type Diagnostic} from './diagnostics.js';
import {loadProject, readState, type Project} from './project.js';
import {statusOf, type TranslationStatus} from './registry.js';
import {flatten, getMessage} from './catalog.js';
import {findConfigFile} from './config.js';
import {VERSION} from '../version.js';

export interface Inspection {
  tool: string;
  node: string;
  ok: boolean;
  detection: Detection;
  config: {file?: string; valid: boolean; sourceLocale?: string; targetLocales?: string[]; mode?: string};
  /** Translation state per target locale, when the config is valid. */
  locales: {locale: string; total: number; counts: Record<TranslationStatus, number>}[];
  diagnostics: Diagnostic[];
}

const MIN_NODE = [22, 17] as const;

function nodeOk(version = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/**
 * Read-only health report: what the project is, whether the config loads, and how far each
 * locale has got. It never throws for a broken project; problems come back as diagnostics.
 */
export async function inspectProject(root: string): Promise<Inspection> {
  const detection = await detectProject(root);
  const diagnostics: Diagnostic[] = [...detection.diagnostics];
  if (!nodeOk()) {
    diagnostics.push(diag('I18N_NO_FRAMEWORK', 'error', `Node ${process.versions.node} is too old; i18n-companion needs ${MIN_NODE.join('.')} or newer.`));
  }
  const result: Inspection = {tool: VERSION, node: process.versions.node, ok: false, detection, config: {valid: false}, locales: [], diagnostics};
  const file = findConfigFile(root);
  if (!file) {
    diagnostics.push(diag('I18N_CONFIG_MISSING', detection.support === 'full' ? 'warning' : 'info', 'No config yet.', {hint: 'Run `npx i18n-companion init`.'}));
    result.ok = false;
    return result;
  }
  let project: Project;
  try {
    project = await loadProject(root);
  } catch (error) {
    if (error instanceof CompanionError) diagnostics.push(error.diagnostic);
    else throw error;
    result.config = {file, valid: false};
    return result;
  }
  const {config} = project;
  result.config = {file, valid: true, sourceLocale: config.sourceLocale, targetLocales: config.targetLocales, mode: config.translation.mode};
  try {
    const state = await readState(project);
    if (!state.source.exists) {
      diagnostics.push(diag('I18N_CATALOG_MISSING', 'error', `The source catalog ${config.messagesDir}/${config.sourceLocale}.json does not exist.`));
    }
    const source = flatten(state.source.tree);
    for (const locale of config.targetLocales) {
      const target = state.targets[locale]!;
      if (!target.exists) diagnostics.push(diag('I18N_CATALOG_MISSING', 'warning', `${config.messagesDir}/${locale}.json does not exist yet; it is created on the first apply.`, {locale}));
      const counts: Record<TranslationStatus, number> = {missing: 0, stale: 0, draft: 0, 'machine-validated': 0, 'human-reviewed': 0};
      for (const id of source.keys()) counts[statusOf(state.registry.messages[id]!, locale, getMessage(target.tree, id))]++;
      result.locales.push({locale, total: source.size, counts});
    }
  } catch (error) {
    if (error instanceof CompanionError) diagnostics.push(error.diagnostic);
    else throw error;
  }
  result.ok = detection.support === 'full' && !diagnostics.some((d) => d.severity === 'error');
  return result;
}
