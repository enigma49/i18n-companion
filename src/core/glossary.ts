import type {CompanionConfig} from './config.js';
import {diag, type Diagnostic} from './diagnostics.js';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(text: string, term: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}($|[^\\p{L}\\p{N}])`, 'iu').test(text);
}

/** Glossary entries that apply to a source message. */
export function relevantGlossary(source: string, glossary: CompanionConfig['glossary']): CompanionConfig['glossary'] {
  return Object.fromEntries(Object.entries(glossary).filter(([term]) => mentions(source, term)));
}

export function checkGlossary(source: string, target: string, locale: string, glossary: CompanionConfig['glossary'], where: {id?: string} = {}): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const [term, entry] of Object.entries(relevantGlossary(source, glossary))) {
    if ('doNotTranslate' in entry) {
      if (!target.includes(term)) {
        out.push(diag('I18N_GLOSSARY', 'error', `"${term}" must appear untranslated, exactly as written.`, {...where, locale}));
      }
    } else {
      const expected = entry.translations[locale];
      if (expected && !mentions(target, expected)) {
        out.push(diag('I18N_GLOSSARY', 'warning', `The glossary translates "${term}" as "${expected}" in ${locale}.`, {...where, locale}));
      }
    }
  }
  return out;
}
