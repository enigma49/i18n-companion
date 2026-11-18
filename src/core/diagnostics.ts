/**
 * Diagnostics are the stable, machine-readable vocabulary the CLI, the MCP server and the
 * assistant skill share. Codes never change meaning once released; add new ones instead.
 */
export type Severity = 'error' | 'warning' | 'info';

export const DIAGNOSTIC_CODES = {
  // project and configuration
  I18N_CONFIG_MISSING: 'No i18n-companion config file was found.',
  I18N_CONFIG_INVALID: 'The config file failed validation.',
  I18N_INVALID_LOCALE: 'A locale tag is not a valid BCP 47 tag.',
  I18N_NO_FRAMEWORK: 'No supported framework was detected.',
  I18N_NO_LIBRARY: 'No i18n library is installed yet.',
  I18N_UNSUPPORTED_LIBRARY: 'The i18n library in this project has no adapter yet.',
  I18N_UNSUPPORTED_REGION: 'This part of the project uses an API the adapter does not handle.',
  I18N_CATALOG_MISSING: 'An expected catalog file does not exist.',
  I18N_CATALOG_INVALID: 'A catalog file is not valid JSON or has an unexpected shape.',
  // source analysis
  I18N_HARDCODED_STRING: 'User-facing text is hardcoded instead of going through the translator.',
  I18N_DYNAMIC_KEY: 'A translation key is built at runtime, so it cannot be checked statically.',
  I18N_AMBIGUOUS_PROP: 'A string in a component prop may or may not be user-facing.',
  I18N_UNSUPPORTED_SHAPE: 'The code around this text cannot be rewritten safely by the adapter.',
  I18N_UNKNOWN_KEY: 'Code uses a message id that does not exist in the source catalog.',
  I18N_PARSE_ERROR: 'A source file could not be parsed.',
  // messages and translations
  I18N_ICU_SYNTAX: 'The message is not valid ICU MessageFormat.',
  I18N_PLACEHOLDER_MISMATCH: 'The translation does not use the same placeholders as the source.',
  I18N_TAG_MISMATCH: 'The translation does not use the same rich-text tags as the source.',
  I18N_PLURAL_MISSING_OTHER: 'A plural or select is missing its required "other" branch.',
  I18N_PLURAL_CATEGORY: 'A plural branch is not a category this locale uses.',
  I18N_GLOSSARY: 'A glossary rule was not followed.',
  I18N_STALE_REVISION: 'The translation was made for an older version of the source text.',
  I18N_UNEXPECTED_ID: 'The response contains an id that was not part of the requested work.',
  I18N_WRONG_LOCALE: 'The response is for a locale that was not requested for this id.',
  I18N_DUPLICATE_ENTRY: 'The response contains the same id and locale twice.',
  I18N_EMPTY_TRANSLATION: 'The translation is empty.',
  I18N_GAVE_UP: 'Validation kept failing, so the source-language fallback stays in place.',
  I18N_RESPONSE_INVALID: 'The response does not match the required JSON shape.',
  I18N_STALE: 'The translation is out of date with the source text.',
  I18N_MISSING_TRANSLATION: 'A target locale has no translation for this message.',
  I18N_DRAFT: 'The translation has not been checked by a person yet.',
  I18N_REVIEW_REQUIRED: 'Policy requires a person to review this translation.',
  I18N_ORPHAN_KEY: 'A target catalog has a key the source catalog no longer has.',
  I18N_PROPOSAL_WAITING: 'A new suggestion is waiting next to a reviewed translation.',
  // plans and writes
  I18N_PLAN_CONFLICT: 'A file changed after the plan was made; make a new plan.',
  I18N_PLAN_INVALID: 'The plan file is missing or malformed.',
  I18N_NOTHING_TO_DO: 'There is nothing to do.',
  I18N_WRITE_FAILED: 'Writing files failed; the previous files were restored.',
  I18N_PROVIDER_ERROR: 'The translation provider failed.',
} as const;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  file?: string;
  line?: number;
  column?: number;
  id?: string;
  locale?: string;
  hint?: string;
}

export function diag(
  code: DiagnosticCode,
  severity: Severity,
  message: string,
  extra: Omit<Diagnostic, 'code' | 'severity' | 'message'> = {},
): Diagnostic {
  return {code, severity, message, ...extra};
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === 'error');
}

export class CompanionError extends Error {
  constructor(
    readonly diagnostic: Diagnostic,
    readonly exitCode = 2,
  ) {
    super(diagnostic.message);
    this.name = 'CompanionError';
  }
}
