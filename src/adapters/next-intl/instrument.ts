import ts from 'typescript';
import type {Candidate, ComponentInfo, FileAnalysis} from './analyze.js';

export interface Edit {
  start: number;
  end: number;
  text: string;
}

export interface PlannedMessage {
  id: string;
  source: string;
  occurrences: {file: string; line: number}[];
}

export interface FileEdits {
  file: string;
  edits: Edit[];
}

const ATTR_SUFFIX: Record<string, string> = {
  'aria-label': 'Label',
  'aria-description': 'Description',
  'aria-placeholder': 'Placeholder',
  'aria-valuetext': 'ValueText',
  'aria-roledescription': 'Role',
  title: 'Title',
  placeholder: 'Placeholder',
  alt: 'Alt',
};

function pascal(words: string[]): string {
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

function asciiWords(text: string): string[] {
  return (
    text
      .replace(/\{[^}]*\}/g, ' ')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .match(/[A-Za-z0-9]+/g) ?? []
  ).map((w) => w.toLowerCase());
}

export function keyFromText(message: string, attribute?: string, propName?: string): string {
  const words = asciiWords(message).slice(0, 4);
  let key = words.length ? words[0]! + pascal(words.slice(1)) : 'text';
  if (/^\d/.test(key)) key = 'text' + pascal([key]);
  const suffix = attribute ? (ATTR_SUFFIX[attribute] ?? pascal([propName ?? attribute.replace(/\W/g, '')])) : '';
  return (key + suffix).slice(0, 48);
}

/** `CheckoutPage` → `Checkout`; an anonymous default export in app/checkout/page.tsx → `Checkout`. */
export function deriveNamespace(component: ComponentInfo, file: string): string {
  const generic = component.name === 'default' || /^(Page|Layout|Component|Default)$/.test(component.name);
  if (!generic) {
    const stripped = component.name.replace(/(Page|Layout|Component|Section|View|Screen)$/, '');
    return stripped || component.name;
  }
  const segments = file.split('/').slice(0, -1).filter((s) => !/^[([@]/.test(s) && s !== 'app' && s !== 'src');
  const last = segments[segments.length - 1] ?? 'Home';
  return pascal(last.split(/[-_]/).filter(Boolean)) || 'Home';
}

function jsString(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function argsObject(c: Candidate): string {
  if (!c.args.length) return '';
  const props = c.args.map((a) => (a.expression === a.name ? a.name : `${a.name}: ${a.expression}`));
  return `, {${props.join(', ')}}`;
}

function indentAt(text: string, pos: number): string {
  // Indentation of the first non-blank line after pos (the body's first statement).
  const rest = text.slice(pos);
  const m = /\n([ \t]*)\S/.exec(rest);
  return m?.[1] ?? '  ';
}

interface ImportNeed {
  api: 'useTranslations' | 'getTranslations';
  module: 'next-intl' | 'next-intl/server';
}

function importInsertion(sf: ts.SourceFile, need: ImportNeed): Edit | undefined {
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === need.module) {
      const named = st.importClause?.namedBindings;
      if (named && ts.isNamedImports(named) && named.elements.some((e) => e.name.text === need.api)) return undefined;
    }
  }
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const line = `import {${need.api}} from '${need.module}';`;
  if (imports.length) {
    const last = imports[imports.length - 1]!;
    return {start: last.end, end: last.end, text: `\n${line}`};
  }
  const first = sf.statements[0];
  if (first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression)) {
    return {start: first.end, end: first.end, text: `\n\n${line}`};
  }
  return {start: 0, end: 0, text: `${line}\n\n`};
}

/**
 * Turns the candidates of one file into source edits and new messages. Pure: it reads the
 * catalog state it is given and returns what should change.
 */
export function instrumentFile(
  analysis: FileAnalysis,
  text: string,
  existing: Map<string, string>,
  planned: Map<string, PlannedMessage>,
): {edits: Edit[]; messages: PlannedMessage[]} {
  if (!analysis.candidates.length) return {edits: [], messages: []};
  const sf = ts.createSourceFile(analysis.file, text, ts.ScriptTarget.Latest, true, analysis.file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.JSX);
  const edits: Edit[] = [];
  const newMessages: PlannedMessage[] = [];
  const needs = new Map<string, ImportNeed>();
  const handled = new Map<ComponentInfo, {varName: string; namespace: string}>();

  const idTaken = (id: string): string | undefined => existing.get(id) ?? planned.get(id)?.source;

  for (const c of analysis.candidates) {
    const comp = c.component;
    let binding = handled.get(comp);
    if (!binding) {
      if (comp.translator && comp.translator.namespace) {
        binding = {varName: comp.translator.varName, namespace: comp.translator.namespace};
      } else {
        const namespace = deriveNamespace(comp, analysis.file);
        const bodyText = text.slice(comp.bodyStart, comp.bodyEnd);
        const varName = comp.translator ? comp.translator.varName : /\bt\b/.test(bodyText) ? 'tr' : 't';
        binding = {varName, namespace: comp.translator ? '' : namespace};
        if (!comp.translator) {
          const api = comp.isAsync ? 'getTranslations' : 'useTranslations';
          needs.set(api, {api, module: comp.isAsync ? 'next-intl/server' : 'next-intl'});
          const call = comp.isAsync ? `await getTranslations(${jsString(namespace)})` : `useTranslations(${jsString(namespace)})`;
          if (comp.blockBody) {
            const indent = indentAt(text, comp.bodyStart);
            edits.push({start: comp.bodyStart, end: comp.bodyStart, text: `\n${indent}const ${varName} = ${call};`});
          } else {
            edits.push({start: comp.bodyStart, end: comp.bodyStart, text: `{\n  const ${varName} = ${call};\n  return `});
            edits.push({start: comp.bodyEnd, end: comp.bodyEnd, text: `;\n}`});
          }
        }
      }
      handled.set(comp, binding);
    }
    // With a root translator (useTranslations() with no namespace) keys carry the namespace.
    const nsForKey = binding.namespace || deriveNamespace(comp, analysis.file);
    const baseKey = keyFromText(c.message, c.attribute);
    let key = baseKey;
    let n = 2;
    let id = `${nsForKey}.${key}`;
    while (idTaken(id) !== undefined && idTaken(id) !== c.message) {
      key = `${baseKey}${n++}`;
      id = `${nsForKey}.${key}`;
    }
    const callKey = binding.namespace ? key : `${nsForKey}.${key}`;
    edits.push({start: c.start, end: c.end, text: `{${binding.varName}(${jsString(callKey)}${argsObject(c)})}`});
    const occurrence = {file: analysis.file, line: c.line};
    const already = planned.get(id) ?? newMessages.find((m) => m.id === id);
    if (already) already.occurrences.push(occurrence);
    else if (existing.get(id) === undefined) {
      const msg = {id, source: c.message, occurrences: [occurrence]};
      newMessages.push(msg);
      planned.set(id, msg);
    }
  }
  for (const need of needs.values()) {
    const e = importInsertion(sf, need);
    if (e) edits.push(e);
  }
  return {edits, messages: newMessages};
}

/** Applies edits right to left. Throws on overlap, which would mean a bug in planning. */
export function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  let limit = Infinity;
  for (const e of sorted) {
    if (e.end > limit) throw new Error(`Overlapping edits at ${e.start}-${e.end}`);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    limit = e.start;
  }
  return out;
}
