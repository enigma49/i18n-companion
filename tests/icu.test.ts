import {describe, expect, it} from 'vitest';
import {validateTranslation} from '../src/core/icu.js';
import {checkGlossary} from '../src/core/glossary.js';

const codes = (list: {code: string}[]) => list.map((d) => d.code);
const ITEMS = '{count, plural, one {# item} other {# items}}';

describe('validateTranslation', () => {
  it('accepts a translation with the same placeholders', () => {
    expect(validateTranslation('Welcome back, {name}', 'Bon retour, {name}', 'fr')).toEqual([]);
  });

  it('rejects a missing or renamed placeholder', () => {
    expect(codes(validateTranslation('Welcome back, {name}', 'Bon retour', 'fr'))).toEqual(['I18N_PLACEHOLDER_MISMATCH']);
    expect(codes(validateTranslation('Welcome back, {name}', 'Bon retour, {nom}', 'fr'))).toEqual(['I18N_PLACEHOLDER_MISMATCH']);
  });

  it('rejects a placeholder whose type changed', () => {
    expect(codes(validateTranslation('{n, number} left', '{n} restants', 'fr'))).toEqual(['I18N_PLACEHOLDER_MISMATCH']);
  });

  it('rejects changed rich-text tags', () => {
    expect(codes(validateTranslation('Read the <b>terms</b>', 'Lisez les <i>conditions</i>', 'fr'))).toEqual(['I18N_TAG_MISMATCH']);
  });

  it('rejects invalid ICU and empty text', () => {
    expect(codes(validateTranslation('Hello', 'Bonjour {', 'fr'))).toEqual(['I18N_ICU_SYNTAX']);
    expect(codes(validateTranslation('Hello', '  ', 'fr'))).toEqual(['I18N_EMPTY_TRANSLATION']);
  });

  it('rejects a plural without "other"', () => {
    expect(codes(validateTranslation(ITEMS, '{count, plural, one {# article}}', 'fr'))).toContain('I18N_PLURAL_MISSING_OTHER');
  });

  it('accepts all six Arabic plural categories', () => {
    const ar = '{count, plural, zero {لا عناصر} one {عنصر واحد} two {عنصران} few {# عناصر} many {# عنصرًا} other {# عنصر}}';
    expect(validateTranslation(ITEMS, ar, 'ar')).toEqual([]);
  });

  it('warns about a category the target locale never uses', () => {
    const result = validateTranslation(ITEMS, '{count, plural, one {# Artikel} few {# Artikel} other {# Artikel}}', 'de');
    expect(result.map((d) => [d.code, d.severity])).toEqual([['I18N_PLURAL_CATEGORY', 'warning']]);
  });

  it('allows exact-value branches like =0', () => {
    expect(validateTranslation(ITEMS, '{count, plural, =0 {Aucun article} one {# article} other {# articles}}', 'fr')).toEqual([]);
  });
});

describe('glossary', () => {
  const glossary = {VAIR: {doNotTranslate: true as const}, cart: {translations: {fr: 'panier'}}};

  it('requires do-not-translate terms to stay as written', () => {
    expect(codes(checkGlossary('Open VAIR', 'Ouvrir VAIR', 'fr', glossary))).toEqual([]);
    expect(checkGlossary('Open VAIR', 'Ouvrir Vair', 'fr', glossary).map((d) => d.severity)).toEqual(['error']);
  });

  it('warns when a preferred translation is not used', () => {
    expect(checkGlossary('Your cart', 'Votre chariot', 'fr', glossary).map((d) => d.severity)).toEqual(['warning']);
    expect(checkGlossary('Your cart', 'Votre panier', 'fr', glossary)).toEqual([]);
  });
});
