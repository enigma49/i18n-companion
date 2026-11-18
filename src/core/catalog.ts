import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {CompanionError, diag} from './diagnostics.js';

/**
 * A next-intl JSON catalog: nested objects whose leaves are ICU strings. A message id is the
 * path joined with dots (`Checkout.payNow`); it is stored nested, never as a dotted key.
 */
export type CatalogTree = {[key: string]: string | CatalogTree};

export interface Catalog {
  locale: string;
  file: string;
  exists: boolean;
  tree: CatalogTree;
  /** Formatting detected on read, reused on write so diffs stay small. */
  indent: string;
  trailingNewline: boolean;
}

export function catalogPath(root: string, messagesDir: string, locale: string): string {
  return path.join(root, messagesDir, `${locale}.json`);
}

export async function readCatalog(root: string, messagesDir: string, locale: string): Promise<Catalog> {
  const file = catalogPath(root, messagesDir, locale);
  if (!existsSync(file)) return {locale, file, exists: false, tree: {}, indent: '  ', trailingNewline: true};
  const text = await readFile(file, 'utf8');
  let tree: unknown;
  try {
    tree = text.trim() === '' ? {} : JSON.parse(text);
  } catch (error) {
    throw new CompanionError(diag('I18N_CATALOG_INVALID', 'error', `${path.relative(root, file)} is not valid JSON: ${String(error)}`, {file, locale}));
  }
  assertTree(tree, file, locale, root);
  const indentMatch = /\n([ \t]+)"/.exec(text);
  return {locale, file, exists: true, tree, indent: indentMatch?.[1] ?? '  ', trailingNewline: text.endsWith('\n')};
}

function assertTree(value: unknown, file: string, locale: string, root: string, at = ''): asserts value is CatalogTree {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CompanionError(diag('I18N_CATALOG_INVALID', 'error', `${path.relative(root, file)}: ${at || 'the top level'} must be an object.`, {file, locale}));
  }
  for (const [k, v] of Object.entries(value)) {
    if (k.includes('.')) {
      throw new CompanionError(diag('I18N_CATALOG_INVALID', 'error', `${path.relative(root, file)}: key "${k}" contains a dot, which next-intl does not allow.`, {file, locale}));
    }
    if (typeof v !== 'string') assertTree(v, file, locale, root, at ? `${at}.${k}` : k);
  }
}

export function flatten(tree: CatalogTree, prefix = '', out = new Map<string, string>()): Map<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const id = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(id, value);
    else flatten(value, id, out);
  }
  return out;
}

export function getMessage(tree: CatalogTree, id: string): string | undefined {
  let node: string | CatalogTree | undefined = tree;
  for (const part of id.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = node[part];
  }
  return typeof node === 'string' ? node : undefined;
}

/** Sets a message, keeping existing key order and appending new keys at the end. */
export function setMessage(tree: CatalogTree, id: string, value: string): void {
  const parts = id.split('.');
  let node: CatalogTree = tree;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (typeof next === 'string') {
      throw new Error(`Cannot add "${id}": "${part}" is already a message, not a namespace.`);
    }
    if (next === undefined) node[part] = {};
    node = node[part] as CatalogTree;
  }
  const last = parts[parts.length - 1]!;
  if (typeof node[last] === 'object') throw new Error(`Cannot set "${id}": it is a namespace, not a message.`);
  node[last] = value;
}

export function serializeCatalog(catalog: Pick<Catalog, 'tree' | 'indent' | 'trailingNewline'>): string {
  return JSON.stringify(catalog.tree, null, catalog.indent) + (catalog.trailingNewline ? '\n' : '');
}
