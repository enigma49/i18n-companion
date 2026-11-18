import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {REGISTRY_FILE} from './config.js';
import {CompanionError, diag} from './diagnostics.js';
import {sourceRevision, textRevision} from './hash.js';
import {parseIcu, shapeOf, type ArgType} from './icu.js';
import {flatten, getMessage, type CatalogTree} from './catalog.js';

/** Stored review state. `missing` and `stale` are never stored; they are derived. */
export type StoredState = 'draft' | 'machine-validated' | 'human-reviewed';
export type TranslationStatus = 'missing' | 'stale' | StoredState;

export type ProvenanceSource = 'assistant' | 'provider' | 'human' | 'existing';

export interface Provenance {
  by: ProvenanceSource;
  at: string;
  batchId?: string;
  model?: string;
}

export interface TranslationRecord {
  /** Hash of the text this record describes, so edits made outside the tool are noticed. */
  textRevision: string;
  /** The source revision the translation was made for. Differs from the message's → stale. */
  sourceRevision: string;
  state: StoredState;
  provenance: Provenance;
  /** A suggested replacement for a human-reviewed translation. Never applied automatically. */
  proposal?: {text: string; sourceRevision: string; provenance: Provenance};
}

export interface Occurrence {
  file: string;
  line: number;
}

export interface MessageRecord {
  source: string;
  sourceRevision: string;
  description?: string;
  args: Record<string, ArgType>;
  tags: string[];
  occurrences: Occurrence[];
  /** Present in the registry but gone from the source catalog. Kept until someone cleans up. */
  removed?: boolean;
  translations: Record<string, TranslationRecord>;
}

export interface Registry {
  version: 1;
  sourceLocale: string;
  messages: Record<string, MessageRecord>;
}

export function emptyRegistry(sourceLocale: string): Registry {
  return {version: 1, sourceLocale, messages: {}};
}

export async function readRegistry(root: string, sourceLocale: string): Promise<Registry> {
  const file = path.join(root, REGISTRY_FILE);
  if (!existsSync(file)) return emptyRegistry(sourceLocale);
  try {
    const data = JSON.parse(await readFile(file, 'utf8')) as Registry;
    if (data.version !== 1 || typeof data.messages !== 'object') throw new Error('unknown registry version');
    return data;
  } catch (error) {
    throw new CompanionError(diag('I18N_CATALOG_INVALID', 'error', `${REGISTRY_FILE} could not be read: ${String(error)}`, {file}));
  }
}

/** Stable, sorted output so the registry produces readable diffs in code review. */
export function serializeRegistry(registry: Registry): string {
  const sortObj = <T>(o: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const messages: Record<string, MessageRecord> = {};
  for (const [id, m] of Object.entries(sortObj(registry.messages))) {
    messages[id] = {...m, translations: sortObj(m.translations)};
  }
  return JSON.stringify({...registry, messages}, null, 2) + '\n';
}

export function statusOf(message: MessageRecord, locale: string, targetText: string | undefined): TranslationStatus {
  if (targetText === undefined) return 'missing';
  const record = message.translations[locale];
  if (!record) return 'human-reviewed';
  if (record.sourceRevision !== message.sourceRevision) return 'stale';
  return record.state;
}

export interface SyncChanges {
  added: string[];
  changed: string[];
  removed: string[];
  humanEdits: {id: string; locale: string}[];
  adoptedExisting: {id: string; locale: string}[];
}

/**
 * Brings the registry in line with the catalogs on disk. Source edits change a message's
 * revision, which makes its translations stale. Target text that differs from what the tool
 * last wrote is treated as a person's edit and becomes human-reviewed.
 */
export function syncRegistry(
  registry: Registry,
  source: CatalogTree,
  targets: Record<string, CatalogTree>,
  now = new Date().toISOString(),
): SyncChanges {
  const changes: SyncChanges = {added: [], changed: [], removed: [], humanEdits: [], adoptedExisting: []};
  const flat = flatten(source);
  for (const [id, text] of flat) {
    const existing = registry.messages[id];
    const parsed = parseIcu(text);
    const shape = parsed.ok ? shapeOf(parsed.ast) : {args: {}, tags: []};
    if (!existing) {
      registry.messages[id] = {
        source: text,
        sourceRevision: sourceRevision(text),
        args: shape.args,
        tags: shape.tags,
        occurrences: [],
        translations: {},
      };
      changes.added.push(id);
      continue;
    }
    if (existing.removed) delete existing.removed;
    const rev = sourceRevision(text, existing.description);
    if (rev !== existing.sourceRevision) {
      existing.source = text;
      existing.sourceRevision = rev;
      existing.args = shape.args;
      existing.tags = shape.tags;
      changes.changed.push(id);
    }
  }
  for (const [id, m] of Object.entries(registry.messages)) {
    if (!flat.has(id) && !m.removed) {
      m.removed = true;
      changes.removed.push(id);
    }
  }
  for (const [locale, tree] of Object.entries(targets)) {
    for (const [id, m] of Object.entries(registry.messages)) {
      if (m.removed) continue;
      const text = getMessage(tree, id);
      const record = m.translations[locale];
      if (text === undefined) {
        if (record) delete m.translations[locale];
        continue;
      }
      const rev = textRevision(text);
      if (!record) {
        m.translations[locale] = {textRevision: rev, sourceRevision: m.sourceRevision, state: 'human-reviewed', provenance: {by: 'existing', at: now}};
        changes.adoptedExisting.push({id, locale});
      } else if (record.textRevision !== rev) {
        m.translations[locale] = {textRevision: rev, sourceRevision: m.sourceRevision, state: 'human-reviewed', provenance: {by: 'human', at: now}};
        changes.humanEdits.push({id, locale});
      }
    }
  }
  return changes;
}
