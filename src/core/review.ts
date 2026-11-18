import {getMessage, serializeCatalog, setMessage} from './catalog.js';
import {CompanionError, diag} from './diagnostics.js';
import {textRevision} from './hash.js';
import {writeTransaction} from './fsutil.js';
import {readState, type Project} from './project.js';
import {serializeRegistry, statusOf, type TranslationStatus} from './registry.js';
import {REGISTRY_FILE, WORK_DIR} from './config.js';
import path from 'node:path';

export interface StatusRow {
  id: string;
  source: string;
  locale: string;
  status: TranslationStatus;
  text?: string;
  proposal?: string;
  provenance?: string;
}

function matches(id: string, selector: string): boolean {
  return selector === '*' || id === selector || id.startsWith(selector.endsWith('.') ? selector : `${selector}.`);
}

export async function messageStatus(project: Project, selector = '*', locales?: string[]): Promise<StatusRow[]> {
  const state = await readState(project);
  const rows: StatusRow[] = [];
  const targetLocales = locales?.length ? locales : project.config.targetLocales;
  for (const [id, msg] of Object.entries(state.registry.messages).sort(([a], [b]) => a.localeCompare(b))) {
    if (msg.removed || !matches(id, selector)) continue;
    for (const locale of targetLocales) {
      const text = getMessage(state.targets[locale]?.tree ?? {}, id);
      const rec = msg.translations[locale];
      rows.push({
        id,
        source: msg.source,
        locale,
        status: statusOf(msg, locale, text),
        text,
        proposal: rec?.proposal?.text,
        provenance: rec ? `${rec.provenance.by} · ${rec.provenance.at.slice(0, 10)}` : undefined,
      });
    }
  }
  return rows;
}

export interface ReviewOptions {
  locales?: string[];
  /** Replace the reviewed text with the waiting proposal, then mark it reviewed. */
  acceptProposal?: boolean;
  /** Discard a waiting proposal and keep the reviewed text. */
  rejectProposal?: boolean;
}

/**
 * Records that a person reviewed translations. This is the only way the tool marks text as
 * human-reviewed besides noticing a person's edit in a catalog file.
 */
export async function reviewTranslations(project: Project, selector: string, options: ReviewOptions = {}): Promise<StatusRow[]> {
  const state = await readState(project);
  const locales = options.locales?.length ? options.locales : project.config.targetLocales;
  const now = new Date().toISOString();
  const changed: StatusRow[] = [];
  const touched = new Set<string>();
  for (const [id, msg] of Object.entries(state.registry.messages)) {
    if (msg.removed || !matches(id, selector)) continue;
    for (const locale of locales) {
      const tree = state.targets[locale]!.tree;
      const rec = msg.translations[locale];
      if (options.rejectProposal) {
        if (rec?.proposal) {
          delete rec.proposal;
          changed.push({id, source: msg.source, locale, status: statusOf(msg, locale, getMessage(tree, id))});
        }
        continue;
      }
      if (options.acceptProposal) {
        if (!rec?.proposal) continue;
        setMessage(tree, id, rec.proposal.text);
        msg.translations[locale] = {textRevision: textRevision(rec.proposal.text), sourceRevision: rec.proposal.sourceRevision, state: 'human-reviewed', provenance: {by: 'human', at: now}};
        touched.add(locale);
        changed.push({id, source: msg.source, locale, status: statusOf(msg, locale, rec.proposal.text), text: rec.proposal.text});
        continue;
      }
      const text = getMessage(tree, id);
      if (text === undefined || !rec) continue;
      if (rec.state === 'human-reviewed' && rec.sourceRevision === msg.sourceRevision) continue;
      msg.translations[locale] = {...rec, state: 'human-reviewed', sourceRevision: msg.sourceRevision, provenance: {by: 'human', at: now}};
      changed.push({id, source: msg.source, locale, status: 'human-reviewed', text});
    }
  }
  if (!changed.length) {
    throw new CompanionError(diag('I18N_NOTHING_TO_DO', 'info', `Nothing to review for "${selector}".`), 0);
  }
  const writes = [...touched].map((l) => ({file: state.targets[l]!.file, data: serializeCatalog(state.targets[l]!)}));
  writes.push({file: path.join(project.root, REGISTRY_FILE), data: serializeRegistry(state.registry)});
  await writeTransaction(writes, path.join(project.root, WORK_DIR, 'backup-review'));
  return changed;
}
