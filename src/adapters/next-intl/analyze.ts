import ts from 'typescript';
import {diag, type Diagnostic} from '../../core/diagnostics.js';
import {escapeIcuLiteral} from '../../core/icu.js';

/**
 * Static analysis of one source file for the next-intl adapter. It finds user-facing text that is
 * still hardcoded, the translators already in use, and anything it cannot handle safely.
 * It never decides wording or applies edits; instrument.ts turns candidates into edits.
 */

export type ComponentKind = 'client' | 'server-async' | 'server';

export interface TranslatorBinding {
  varName: string;
  namespace: string;
  api: 'useTranslations' | 'getTranslations';
}

export interface ComponentInfo {
  name: string;
  kind: ComponentKind;
  /** Position right after the opening `{` of the body, or the body expression start. */
  bodyStart: number;
  bodyEnd: number;
  blockBody: boolean;
  isAsync: boolean;
  translator?: TranslatorBinding;
}

export interface CandidateArg {
  name: string;
  expression: string;
}

export interface Candidate {
  kind: 'text' | 'sentence' | 'attribute';
  file: string;
  line: number;
  column: number;
  /** Source range that will be replaced. */
  start: number;
  end: number;
  /** The ICU source message, e.g. `Hello {name}`. */
  message: string;
  args: CandidateArg[];
  attribute?: string;
  /** Whether the original was an attribute string literal (`a="x"`) rather than an expression. */
  attributeLiteral?: boolean;
  component: ComponentInfo;
}

export interface Usage {
  file: string;
  line: number;
  /** Full message id when it can be resolved statically. */
  id?: string;
  namespace: string;
}

export interface FileAnalysis {
  file: string;
  isClient: boolean;
  usesExtracted: boolean;
  ignored: boolean;
  candidates: Candidate[];
  usages: Usage[];
  diagnostics: Diagnostic[];
}

/** Attributes whose string value is always shown to people (or read by assistive tech). */
const USER_FACING_ATTRS = new Set(['aria-label', 'aria-description', 'aria-placeholder', 'aria-valuetext', 'aria-roledescription', 'title', 'placeholder', 'alt']);
/** Component props that usually carry user-facing text. Converted only when the value reads like prose. */
const LIKELY_TEXT_PROPS = new Set(['label', 'description', 'heading', 'subtitle', 'message', 'tooltip', 'helperText', 'emptyText', 'buttonText', 'caption', 'text', 'hint', 'errorMessage']);
const SKIP_ELEMENTS = new Set(['code', 'pre', 'script', 'style', 'kbd', 'samp', 'var']);
const INLINE_MARKUP = new Set(['b', 'strong', 'em', 'i', 'a', 'span', 'code', 'u', 'small', 'mark', 'sup', 'sub', 'br', 'Link']);
const HAS_LETTER = /\p{L}/u;

function lineCol(sf: ts.SourceFile, pos: number): {line: number; column: number} {
  const lc = sf.getLineAndCharacterOfPosition(pos);
  return {line: lc.line + 1, column: lc.character + 1};
}

function looksLikeNonProse(text: string): boolean {
  const t = text.trim();
  if (!HAS_LETTER.test(t)) return true;
  if (/^(https?:|mailto:|tel:|\/|#|\.\/|\.\.\/)/i.test(t)) return true;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return true;
  return false;
}

/** Prop values like "primary", "btn-lg" or "onClose" are identifiers, not prose. */
function looksLikeIdentifier(text: string): boolean {
  const t = text.trim();
  return /^[a-z][\w-]*$/.test(t) && !/\s/.test(t);
}

/** React's JSX whitespace rule: trim each line's indentation, drop blank lines, join with spaces. */
export function normalizeJsxText(raw: string): string {
  const lines = raw.split(/\r\n|\n|\r/);
  if (lines.length === 1) return raw;
  const parts: string[] = [];
  lines.forEach((line, i) => {
    let l = line;
    if (i !== 0) l = l.replace(/^[ \t]+/, '');
    if (i !== lines.length - 1) l = l.replace(/[ \t]+$/, '');
    if (l) parts.push(l);
  });
  return parts.join(' ');
}

function containsJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) return true;
  return ts.forEachChild(node, (c) => (containsJsx(c) ? true : undefined)) ?? false;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)));
}

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  const tag = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  return tag.getText();
}

function attrs(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxAttributes {
  return ts.isJsxElement(node) ? node.openingElement.attributes : node.attributes;
}

function hasOptOut(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  return attrs(node).properties.some(
    (p) =>
      ts.isJsxAttribute(p) &&
      ((p.name.getText() === 'translate' && p.initializer && ts.isStringLiteral(p.initializer) && p.initializer.text === 'no') ||
        p.name.getText() === 'data-i18n-ignore'),
  );
}

function isFunctionLike(node: ts.Node): node is ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression {
  return ts.isFunctionDeclaration(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function functionName(fn: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression): string | undefined {
  if (fn.name) return fn.name.getText();
  const parent = fn.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isCallExpression(parent) && ts.isVariableDeclaration(parent.parent) && ts.isIdentifier(parent.parent.name)) return parent.parent.name.text; // memo(), forwardRef()
  return undefined;
}

function isDefaultExport(fn: ts.Node): boolean {
  if (ts.isFunctionDeclaration(fn)) return !!fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  return ts.isExportAssignment(fn.parent);
}

function argNameFor(expr: ts.Expression): string {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isCallExpression(expr)) {
    const callee = argNameFor(expr.expression as ts.Expression);
    const stripped = callee.replace(/^(format|get|to|render)(?=[A-Z])/, '');
    return stripped.charAt(0).toLowerCase() + stripped.slice(1);
  }
  if (ts.isElementAccessExpression(expr) && ts.isStringLiteral(expr.argumentExpression)) return expr.argumentExpression.text.replace(/\W/g, '') || 'value';
  if (ts.isParenthesizedExpression(expr)) return argNameFor(expr.expression);
  return 'value';
}

/** Finds `const t = useTranslations('Ns')` / `await getTranslations(...)` bindings in a function. */
function findTranslator(fn: ts.Node): TranslatorBinding | undefined {
  let found: TranslatorBinding | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== fn && isFunctionLike(node)) return;
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let init: ts.Expression = node.initializer;
      if (ts.isAwaitExpression(init)) init = init.expression;
      if (ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
        const api = init.expression.text;
        if (api === 'useTranslations' || api === 'getTranslations') {
          const arg = init.arguments[0];
          let namespace = '';
          if (arg && ts.isStringLiteral(arg)) namespace = arg.text;
          else if (arg && ts.isObjectLiteralExpression(arg)) {
            const ns = arg.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText() === 'namespace') as ts.PropertyAssignment | undefined;
            if (ns && ts.isStringLiteral(ns.initializer)) namespace = ns.initializer.text;
          }
          found = {varName: node.name.text, namespace, api};
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(fn);
  return found;
}

export function analyzeSource(file: string, text: string): FileAnalysis {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const result: FileAnalysis = {file, isClient: false, usesExtracted: text.includes('useExtracted'), ignored: false, candidates: [], usages: [], diagnostics: []};
  const parseErrors = (sf as unknown as {parseDiagnostics?: ts.Diagnostic[]}).parseDiagnostics ?? [];
  if (parseErrors.length) {
    const first = parseErrors[0]!;
    result.diagnostics.push(
      diag('I18N_PARSE_ERROR', 'error', `Could not parse: ${ts.flattenDiagnosticMessageText(first.messageText, ' ')}`, {file, ...lineCol(sf, first.start ?? 0)}),
    );
    return result;
  }
  if (/i18n-companion-ignore-file/.test(text)) {
    result.ignored = true;
    return result;
  }
  const first = sf.statements[0];
  result.isClient = !!first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression) && first.expression.text === 'use client';

  const lines = text.split('\n');
  const ignoredByComment = (pos: number): boolean => {
    const {line} = lineCol(sf, pos);
    return /i18n-companion-ignore(?!-file)/.test(lines[line - 1] ?? '') || /i18n-companion-ignore(?!-file)/.test(lines[line - 2] ?? '');
  };

  const componentCache = new Map<ts.Node, ComponentInfo | {unsupported: string}>();
  const componentFor = (node: ts.Node): ComponentInfo | {unsupported: string} => {
    let outer: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression | undefined;
    for (let p: ts.Node | undefined = node.parent; p; p = p.parent) if (isFunctionLike(p)) outer = p;
    if (!outer) return {unsupported: 'The text is not inside a component function.'};
    const cached = componentCache.get(outer);
    if (cached) return cached;
    const name = functionName(outer);
    const isComponent = (name !== undefined && /^[A-Z]/.test(name)) || isDefaultExport(outer);
    let info: ComponentInfo | {unsupported: string};
    if (!isComponent) {
      info = {unsupported: `The text is inside "${name ?? 'an anonymous function'}", which is not a React component, so a translation hook cannot be added there. Pass \`t\` in or move the text into a component.`};
    } else {
      const isAsync = !!outer.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
      const body = outer.body!;
      const blockBody = ts.isBlock(body);
      info = {
        name: name ?? 'default',
        kind: result.isClient ? 'client' : isAsync ? 'server-async' : 'server',
        bodyStart: blockBody ? body.getStart(sf) + 1 : body.getStart(sf),
        bodyEnd: body.getEnd(),
        blockBody,
        isAsync,
        translator: findTranslator(outer),
      };
    }
    componentCache.set(outer, info);
    return info;
  };

  const pushCandidate = (c: Omit<Candidate, 'component' | 'file' | 'line' | 'column'>, anchor: ts.Node): void => {
    const comp = componentFor(anchor);
    const lc = lineCol(sf, c.start);
    if ('unsupported' in comp) {
      result.diagnostics.push(diag('I18N_HARDCODED_STRING', 'warning', `"${c.message}" is hardcoded. ${comp.unsupported}`, {file, ...lc, hint: 'needs a manual decision'}));
      result.diagnostics.push(diag('I18N_UNSUPPORTED_SHAPE', 'warning', comp.unsupported, {file, ...lc}));
      return;
    }
    result.candidates.push({...c, file, ...lc, component: comp});
  };

  const handleChildren = (el: ts.JsxElement | ts.JsxFragment): void => {
    const children = el.children;
    const hasText = children.some((c) => ts.isJsxText(c) && HAS_LETTER.test(c.text));
    if (!hasText) return;
    const inlineMarkup = children.some(
      (c) => (ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c)) && INLINE_MARKUP.has(tagName(c)),
    );
    if (inlineMarkup) {
      const lc = lineCol(sf, children[0]!.getStart(sf));
      result.diagnostics.push(
        diag('I18N_UNSUPPORTED_SHAPE', 'warning', 'This sentence contains inline markup, so it was not split into fragments. Convert it by hand with t.rich() and tags.', {
          file,
          ...lc,
        }),
      );
      result.diagnostics.push(diag('I18N_HARDCODED_STRING', 'warning', 'Hardcoded sentence with inline markup.', {file, ...lc, hint: 'needs a manual decision'}));
      return;
    }
    // Split children into runs separated by elements; each run with letters becomes one message.
    let run: ts.JsxChild[] = [];
    const flush = (): void => {
      if (run.length) handleRun(run);
      run = [];
    };
    for (const child of children) {
      if (ts.isJsxText(child) || ts.isJsxExpression(child)) run.push(child);
      else flush();
    }
    flush();
  };

  const handleRun = (run: ts.JsxChild[]): void => {
    const textNodes = run.filter((c): c is ts.JsxText => ts.isJsxText(c) && HAS_LETTER.test(c.text));
    if (!textNodes.length) return;
    // Expressions that are already translations or contain JSX/conditionals end the sentence.
    for (const c of run) {
      if (!ts.isJsxExpression(c) || !c.expression) continue;
      const e = c.expression;
      if (ts.isConditionalExpression(e) || ts.isBinaryExpression(e)) {
        if (ts.isConditionalExpression(e) && (ts.isStringLiteral(e.whenTrue) || ts.isStringLiteral(e.whenFalse))) {
          result.diagnostics.push(
            diag('I18N_AMBIGUOUS_PROP', 'warning', 'Text chosen by a condition needs a manual decision: make each branch its own message, or use an ICU select.', {
              file,
              ...lineCol(sf, e.getStart(sf)),
            }),
          );
        }
        // Treat the text pieces around it individually.
        for (const t of textNodes) handleRun([t]);
        return;
      }
      const isTranslatorCall = ts.isCallExpression(e) && ts.isIdentifier(e.expression) && /^t\w*$/.test(e.expression.text);
      if (isTranslatorCall || containsJsx(e)) {
        for (const t of textNodes) handleRun([t]);
        return;
      }
    }
    if (textNodes.some((t) => ignoredByComment(t.getStart(sf)))) return;
    let message = '';
    const args: CandidateArg[] = [];
    const used = new Set<string>();
    for (const c of run) {
      if (ts.isJsxText(c)) {
        message += escapeIcuLiteral(decodeEntities(normalizeJsxText(c.text)));
      } else if (ts.isJsxExpression(c) && c.expression) {
        const e = c.expression;
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
          message += escapeIcuLiteral(e.text);
          continue;
        }
        let name = argNameFor(e);
        if (!/^[A-Za-z_]\w*$/.test(name)) name = 'value';
        const base = name;
        let n = 2;
        while (used.has(name)) name = `${base}${n++}`;
        used.add(name);
        args.push({name, expression: e.getText(sf)});
        message += `{${name}}`;
      }
      // An empty `{}` or a comment-only expression contributes nothing.
    }
    message = message.replace(/\s+/g, ' ').trim();
    if (looksLikeNonProse(message.replace(/\{\w+\}/g, ''))) return;
    // Range: from the first non-whitespace character to the last one, so surrounding layout stays.
    const firstNode = run[0]!;
    const lastNode = run[run.length - 1]!;
    const firstRaw = text.slice(firstNode.pos, firstNode.end);
    const lastRaw = text.slice(lastNode.pos, lastNode.end);
    const start = ts.isJsxText(firstNode) ? firstNode.pos + (firstRaw.length - firstRaw.trimStart().length) : firstNode.getStart(sf);
    const end = ts.isJsxText(lastNode) ? lastNode.end - (lastRaw.length - lastRaw.trimEnd().length) : lastNode.end;
    pushCandidate({kind: args.length ? 'sentence' : 'text', start, end, message, args}, firstNode);
  };

  const handleAttribute = (attr: ts.JsxAttribute, element: ts.JsxElement | ts.JsxSelfClosingElement): void => {
    const name = attr.name.getText(sf);
    const init = attr.initializer;
    if (!init) return;
    let value: string | undefined;
    let literal = false;
    if (ts.isStringLiteral(init)) {
      value = init.text;
      literal = true;
    } else if (ts.isJsxExpression(init) && init.expression) {
      const e = init.expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) value = e.text;
      else if (ts.isConditionalExpression(e) && (ts.isStringLiteral(e.whenTrue) || ts.isStringLiteral(e.whenFalse))) {
        const isTextProp = USER_FACING_ATTRS.has(name) || LIKELY_TEXT_PROPS.has(name);
        if (isTextProp) {
          result.diagnostics.push(
            diag('I18N_AMBIGUOUS_PROP', 'warning', `${name}={${e.getText(sf)}} picks text with a condition; it needs a manual decision (two messages, or an ICU select).`, {
              file,
              ...lineCol(sf, attr.getStart(sf)),
            }),
          );
        }
        return;
      }
    }
    if (value === undefined || looksLikeNonProse(value)) return;
    const isComponent = /^[A-Z]/.test(tagName(element));
    const convert = USER_FACING_ATTRS.has(name) || (isComponent && LIKELY_TEXT_PROPS.has(name) && !looksLikeIdentifier(value));
    if (!convert) {
      if (isComponent && /\s/.test(value.trim()) && !name.startsWith('data-') && !['className', 'class', 'style', 'href', 'src', 'id', 'key'].includes(name)) {
        result.diagnostics.push(
          diag('I18N_AMBIGUOUS_PROP', 'info', `${name}="${value}" on <${tagName(element)}> may be user-facing. Translate it by hand if it is.`, {
            file,
            ...lineCol(sf, attr.getStart(sf)),
          }),
        );
      }
      return;
    }
    if (ignoredByComment(attr.getStart(sf))) return;
    pushCandidate(
      {kind: 'attribute', start: init.getStart(sf), end: init.getEnd(), message: escapeIcuLiteral(value.replace(/\s+/g, ' ').trim()), args: [], attribute: name, attributeLiteral: literal},
      attr,
    );
  };

  const translatorVars = new Map<string, string>(); // var name -> namespace (file-wide approximation)
  const collectTranslators = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const b = findTranslator(node);
      if (b) translatorVars.set(b.varName, b.namespace);
    }
    ts.forEachChild(node, collectTranslators);
  };
  collectTranslators(sf);

  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = tagName(node);
      if (SKIP_ELEMENTS.has(tag) || hasOptOut(node)) return;
      for (const p of attrs(node).properties) if (ts.isJsxAttribute(p)) handleAttribute(p, node);
      if (ts.isJsxElement(node)) handleChildren(node);
    } else if (ts.isJsxFragment(node)) {
      handleChildren(node);
    } else if (ts.isCallExpression(node)) {
      let callee: ts.Expression = node.expression;
      if (ts.isPropertyAccessExpression(callee) && ['rich', 'markup', 'raw', 'has'].includes(callee.name.text)) callee = callee.expression;
      if (ts.isIdentifier(callee) && translatorVars.has(callee.text)) {
        const namespace = translatorVars.get(callee.text)!;
        const arg = node.arguments[0];
        const lc = lineCol(sf, node.getStart(sf));
        if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
          result.usages.push({file, line: lc.line, namespace, id: namespace ? `${namespace}.${arg.text}` : arg.text});
        } else {
          result.usages.push({file, line: lc.line, namespace});
          result.diagnostics.push(
            diag('I18N_DYNAMIC_KEY', 'warning', `${node.getText(sf).slice(0, 80)} builds its key at runtime, so it cannot be checked. Prefer explicit keys for each case.`, {
              file,
              ...lc,
            }),
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (result.usesExtracted) {
    result.diagnostics.push(diag('I18N_UNSUPPORTED_REGION', 'warning', 'This file uses useExtracted, which this adapter does not rewrite.', {file}));
    result.candidates = [];
  }
  for (const c of result.candidates) {
    result.diagnostics.push(diag('I18N_HARDCODED_STRING', 'info', `"${c.message}" is hardcoded.`, {file, line: c.line, column: c.column}));
  }
  return result;
}
