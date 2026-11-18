import {createHash} from 'node:crypto';
import type {ContentProvider} from '../providers/types.js';

export type {ContentProvider} from '../providers/types.js';
export {createAnthropicProvider} from '../providers/anthropic.js';

/**
 * Opt-in translation of dynamic content (product descriptions, help articles) on the server.
 * Static UI text never goes through here: it comes from the catalogs at build time.
 * Never call this from browser code; the provider holds credentials.
 */

export interface TranslateContentInput {
  /** From trusted server-side auth, never from the request body. */
  tenantId: string;
  contentId: string;
  sourceLocale: string;
  targetLocale: string;
  text: string;
  /** Short description of what the content is, e.g. "Product description". */
  context?: string;
}

export interface TranslateContentResult {
  text: string;
  locale: string;
  status: 'translated' | 'cached' | 'fallback';
  /** Why the fallback was used, when it was. */
  reason?: string;
  provenance?: {provider: string; model?: string; at: string};
}

export interface CacheEntry {
  text: string;
  provenance: {provider: string; model?: string; at: string};
  expiresAt: number;
}

/** Storage for translated content. The default is in-process; use a shared store for several instances. */
export interface ContentCache {
  get(key: string): Promise<CacheEntry | undefined> | CacheEntry | undefined;
  set(key: string, entry: CacheEntry): Promise<void> | void;
}

export interface ContentTranslatorOptions {
  provider: ContentProvider;
  cache?: ContentCache;
  /** How long a cached translation is kept. Default 7 days. */
  ttlMs?: number;
  /** Most concurrent provider calls. Default 4. */
  maxConcurrency?: number;
  /** Per-call timeout. Default 20 seconds. */
  timeoutMs?: number;
  /** Retries after a failed call. Default 1. */
  retries?: number;
  /** Longest text accepted, in characters. Default 20,000. */
  maxChars?: number;
  /** Locales content may be translated into. Requests for others get the fallback. */
  allowedLocales?: string[];
  /** Bumped whenever glossary or policy changes, so old cache entries stop matching. */
  policyVersion?: string;
  /** Spend guard: most provider calls per process lifetime. */
  maxCalls?: number;
  now?: () => number;
}

/** A small in-process LRU cache with a size bound. */
export function memoryCache(maxEntries = 5000): ContentCache {
  const map = new Map<string, CacheEntry>();
  return {
    get(key) {
      const v = map.get(key);
      if (v) {
        map.delete(key);
        map.set(key, v);
      }
      return v;
    },
    set(key, entry) {
      map.delete(key);
      map.set(key, entry);
      while (map.size > maxEntries) map.delete(map.keys().next().value!);
    },
  };
}

function canonical(locale: string): string | undefined {
  try {
    return Intl.getCanonicalLocales(locale)[0];
  } catch {
    return undefined;
  }
}

/** Plain text only: strips control characters other than line breaks and tabs. */
function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

export function cacheKey(input: TranslateContentInput, policyVersion: string): string {
  const parts = [
    input.tenantId,
    input.contentId,
    createHash('sha256').update(input.text).digest('hex'),
    input.sourceLocale,
    input.targetLocale,
    input.context ?? '',
    policyVersion,
  ];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function createContentTranslator(options: ContentTranslatorOptions) {
  const cache = options.cache ?? memoryCache();
  const ttl = options.ttlMs ?? 7 * 24 * 3600 * 1000;
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 4);
  const timeoutMs = options.timeoutMs ?? 20_000;
  const retries = Math.max(0, options.retries ?? 1);
  const maxChars = options.maxChars ?? 20_000;
  const policyVersion = options.policyVersion ?? '1';
  const now = options.now ?? Date.now;
  const allowed = options.allowedLocales?.map((l) => canonical(l)).filter((l): l is string => !!l);
  const inFlight = new Map<string, Promise<TranslateContentResult>>();
  let active = 0;
  let calls = 0;
  const queue: (() => void)[] = [];

  const acquire = (): Promise<void> =>
    active < maxConcurrency
      ? (active++, Promise.resolve())
      : new Promise<void>((resolve) => queue.push(() => (active++, resolve())));
  const release = (): void => {
    active--;
    queue.shift()?.();
  };

  async function callProvider(input: TranslateContentInput, source: string, target: string): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (options.maxCalls !== undefined && calls >= options.maxCalls) throw new Error('translation budget reached');
      calls++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const result = await Promise.race([
          options.provider.translateText({text: input.text, sourceLocale: source, targetLocale: target, context: input.context, signal: controller.signal}),
          new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('timed out')), {once: true})),
        ]);
        if (typeof result !== 'string' || result.trim() === '') throw new Error('empty translation');
        return sanitize(result);
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  async function translateContent(input: TranslateContentInput): Promise<TranslateContentResult> {
    const fallback = (reason: string): TranslateContentResult => ({text: input.text, locale: input.sourceLocale, status: 'fallback', reason});
    const source = canonical(input.sourceLocale);
    const target = canonical(input.targetLocale);
    if (!source || !target) return fallback('invalid locale');
    if (!input.tenantId || !input.contentId) return fallback('missing tenant or content id');
    if (source === target || input.text.trim() === '') return {text: input.text, locale: source, status: 'cached'};
    if (allowed && !allowed.includes(target)) return fallback('locale not allowed');
    if (input.text.length > maxChars) return fallback('content too long');

    const key = cacheKey({...input, sourceLocale: source, targetLocale: target}, policyVersion);
    const hit = await cache.get(key);
    if (hit && hit.expiresAt > now()) return {text: hit.text, locale: target, status: 'cached', provenance: hit.provenance};

    const pendingCall = inFlight.get(key);
    if (pendingCall) return pendingCall;
    const work = (async (): Promise<TranslateContentResult> => {
      await acquire();
      try {
        const text = await callProvider(input, source, target);
        const provenance = {provider: options.provider.name, model: options.provider.model, at: new Date(now()).toISOString()};
        await cache.set(key, {text, provenance, expiresAt: now() + ttl});
        return {text, locale: target, status: 'translated', provenance};
      } catch (error) {
        return fallback(`provider failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        release();
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, work);
    return work;
  }

  return {translateContent, stats: () => ({calls, active, queued: queue.length})};
}
