import {
  parse,
  TYPE,
  type MessageFormatElement,
  type PluralElement,
  type SelectElement,
  type TagElement,
} from '@formatjs/icu-messageformat-parser';
import {diag, type Diagnostic} from './diagnostics.js';

export type ArgType = 'string' | 'number' | 'date' | 'time' | 'plural' | 'selectordinal' | 'select';

export interface MessageShape {
  args: Record<string, ArgType>;
  tags: string[];
}

export type ParseResult = {ok: true; ast: MessageFormatElement[]} | {ok: false; error: string};

export function parseIcu(message: string): ParseResult {
  try {
    // ignoreTag:false so rich-text tags like <b>…</b> are parsed and compared.
    return {ok: true, ast: parse(message, {ignoreTag: false, requiresOtherClause: false})};
  } catch (error) {
    const e = error as {message?: string; location?: {start?: {offset?: number}}};
    const at = e.location?.start?.offset;
    return {ok: false, error: `${e.message ?? String(error)}${at === undefined ? '' : ` (at character ${at})`}`};
  }
}

function argTypeOf(el: MessageFormatElement): ArgType | undefined {
  switch (el.type) {
    case TYPE.argument:
      return 'string';
    case TYPE.number:
      return 'number';
    case TYPE.date:
      return 'date';
    case TYPE.time:
      return 'time';
    case TYPE.select:
      return 'select';
    case TYPE.plural:
      return (el as PluralElement).pluralType === 'ordinal' ? 'selectordinal' : 'plural';
    default:
      return undefined;
  }
}

/** Walks every element, including inside plural/select branches and tags. */
export function walk(ast: MessageFormatElement[], visit: (el: MessageFormatElement) => void): void {
  for (const el of ast) {
    visit(el);
    if (el.type === TYPE.plural || el.type === TYPE.select) {
      for (const option of Object.values((el as PluralElement | SelectElement).options)) walk(option.value, visit);
    } else if (el.type === TYPE.tag) {
      walk((el as TagElement).children, visit);
    }
  }
}

export function shapeOf(ast: MessageFormatElement[]): MessageShape {
  const args: Record<string, ArgType> = {};
  const tags = new Set<string>();
  walk(ast, (el) => {
    const t = argTypeOf(el);
    if (t && 'value' in el && typeof el.value === 'string') args[el.value] = t;
    if (el.type === TYPE.tag) tags.add((el as TagElement).value);
  });
  return {args, tags: [...tags].sort()};
}

function pluralCategories(locale: string, type: 'cardinal' | 'ordinal'): Set<string> {
  try {
    return new Set(new Intl.PluralRules(locale, {type}).resolvedOptions().pluralCategories);
  } catch {
    return new Set(['other']);
  }
}

/** Plural and select checks that depend on the target locale. */
export function checkBranches(ast: MessageFormatElement[], locale: string, where: {id?: string}): Diagnostic[] {
  const out: Diagnostic[] = [];
  walk(ast, (el) => {
    if (el.type !== TYPE.plural && el.type !== TYPE.select) return;
    const options = Object.keys((el as PluralElement | SelectElement).options);
    if (!options.includes('other')) {
      out.push(diag('I18N_PLURAL_MISSING_OTHER', 'error', `{${el.value}} has no "other" branch, so some values would show nothing.`, {...where, locale}));
    }
    if (el.type === TYPE.plural) {
      const allowed = pluralCategories(locale, (el as PluralElement).pluralType === 'ordinal' ? 'ordinal' : 'cardinal');
      for (const option of options) {
        if (option.startsWith('=') || allowed.has(option)) continue;
        out.push(
          diag('I18N_PLURAL_CATEGORY', 'warning', `"${option}" is not a plural category in ${locale} (it uses: ${[...allowed].join(', ')}). That branch will never be shown.`, {
            ...where,
            locale,
          }),
        );
      }
    }
  });
  return out;
}

/**
 * Validates a translation against its source message: syntax, same placeholders with the same
 * types, same rich-text tags, and plural branches that make sense for the target locale.
 */
export function validateTranslation(source: string, target: string, locale: string, where: {id?: string} = {}): Diagnostic[] {
  if (target.trim() === '') return [diag('I18N_EMPTY_TRANSLATION', 'error', 'The translation is empty.', {...where, locale})];
  const t = parseIcu(target);
  if (!t.ok) return [diag('I18N_ICU_SYNTAX', 'error', `Invalid ICU message: ${t.error}`, {...where, locale})];
  const s = parseIcu(source);
  if (!s.ok) return [diag('I18N_ICU_SYNTAX', 'error', `The source message itself is invalid ICU: ${s.error}`, {...where})];
  const out: Diagnostic[] = [];
  const sShape = shapeOf(s.ast);
  const tShape = shapeOf(t.ast);
  const sNames = Object.keys(sShape.args).sort();
  const tNames = Object.keys(tShape.args).sort();
  const missing = sNames.filter((n) => !(n in tShape.args));
  const extra = tNames.filter((n) => !(n in sShape.args));
  if (missing.length || extra.length) {
    const parts = [];
    if (missing.length) parts.push(`missing ${missing.map((n) => `{${n}}`).join(', ')}`);
    if (extra.length) parts.push(`unexpected ${extra.map((n) => `{${n}}`).join(', ')}`);
    out.push(
      diag('I18N_PLACEHOLDER_MISMATCH', 'error', `Placeholders differ from the source: ${parts.join('; ')}. Expected exactly: ${sNames.map((n) => `{${n}}`).join(', ') || 'none'}.`, {
        ...where,
        locale,
      }),
    );
  }
  for (const name of sNames) {
    const st = sShape.args[name];
    const tt = tShape.args[name];
    if (tt && st && tt !== st) {
      out.push(diag('I18N_PLACEHOLDER_MISMATCH', 'error', `{${name}} is a ${st} in the source but a ${tt} in the translation.`, {...where, locale}));
    }
  }
  if (sShape.tags.join() !== tShape.tags.join()) {
    out.push(
      diag('I18N_TAG_MISMATCH', 'error', `Rich-text tags differ: source has <${sShape.tags.join('>, <') || 'none'}>, translation has <${tShape.tags.join('>, <') || 'none'}>.`, {
        ...where,
        locale,
      }),
    );
  }
  out.push(...checkBranches(t.ast, locale, where));
  return out;
}

/** Syntax and branch checks for a message on its own (used for the source catalog). */
export function validateMessage(message: string, locale: string, where: {id?: string} = {}): Diagnostic[] {
  const p = parseIcu(message);
  if (!p.ok) return [diag('I18N_ICU_SYNTAX', 'error', `Invalid ICU message: ${p.error}`, {...where, locale})];
  return checkBranches(p.ast, locale, where);
}

/** ICU-escapes literal text so it can be embedded in a message. */
export function escapeIcuLiteral(text: string): string {
  // An apostrophe only starts quoting before a syntax character, so escape those cases only.
  return text.replace(/'(?=[{}#<])/g, "''").replace(/[{}]/g, (c) => `'${c}'`);
}
