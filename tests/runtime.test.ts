import {describe, expect, it} from 'vitest';
import {createContentTranslator, type ContentProvider, type TranslateContentInput} from '../src/runtime/index.js';

function provider(impl: (text: string, target: string, signal?: AbortSignal) => Promise<string>): ContentProvider & {calls: number} {
  const p = {
    name: 'fake',
    model: 'fake-1',
    calls: 0,
    async translateText(input: {text: string; targetLocale: string; signal?: AbortSignal}) {
      p.calls++;
      return impl(input.text, input.targetLocale, input.signal);
    },
  };
  return p;
}

const input = (over: Partial<TranslateContentInput> = {}): TranslateContentInput => ({
  tenantId: 'acme',
  contentId: 'product-1',
  sourceLocale: 'en',
  targetLocale: 'fr',
  text: 'A sturdy bag',
  ...over,
});

describe('createContentTranslator', () => {
  it('translates once, then serves the cache', async () => {
    const p = provider(async (t, l) => `[${l}] ${t}`);
    const tr = createContentTranslator({provider: p});
    expect((await tr.translateContent(input())).status).toBe('translated');
    const second = await tr.translateContent(input());
    expect(second).toMatchObject({status: 'cached', text: '[fr] A sturdy bag', locale: 'fr'});
    expect(p.calls).toBe(1);
  });

  it('misses the cache when the text changes', async () => {
    const p = provider(async (t) => `fr:${t}`);
    const tr = createContentTranslator({provider: p});
    await tr.translateContent(input());
    await tr.translateContent(input({text: 'A lighter bag'}));
    expect(p.calls).toBe(2);
  });

  it('keeps tenants apart', async () => {
    const p = provider(async (t) => `fr:${t}`);
    const tr = createContentTranslator({provider: p});
    await tr.translateContent(input({tenantId: 'acme'}));
    expect((await tr.translateContent(input({tenantId: 'globex'}))).status).toBe('translated');
    expect(p.calls).toBe(2);
  });

  it('shares one call between identical requests in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = provider(async (t) => {
      await gate;
      return `fr:${t}`;
    });
    const tr = createContentTranslator({provider: p});
    const both = Promise.all([tr.translateContent(input()), tr.translateContent(input())]);
    release();
    const [a, b] = await both;
    expect(a.text).toBe(b.text);
    expect(p.calls).toBe(1);
  });

  it('falls back to the source text when the provider times out', async () => {
    const p = provider((_t, _l, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')))));
    const tr = createContentTranslator({provider: p, timeoutMs: 20, retries: 0});
    const result = await tr.translateContent(input());
    expect(result).toMatchObject({status: 'fallback', text: 'A sturdy bag', locale: 'en'});
    expect(result.reason).toContain('timed out');
  });

  it('retries once, then succeeds', async () => {
    let n = 0;
    const p = provider(async (t) => {
      if (n++ === 0) throw new Error('flaky');
      return `fr:${t}`;
    });
    const tr = createContentTranslator({provider: p, retries: 1});
    expect((await tr.translateContent(input())).status).toBe('translated');
    expect(p.calls).toBe(2);
  });

  it('refuses locales outside the allowed list, and stops at the call budget', async () => {
    const p = provider(async (t) => `x:${t}`);
    const tr = createContentTranslator({provider: p, allowedLocales: ['fr'], maxCalls: 1, retries: 0});
    expect((await tr.translateContent(input({targetLocale: 'de'}))).reason).toBe('locale not allowed');
    expect((await tr.translateContent(input())).status).toBe('translated');
    const over = await tr.translateContent(input({contentId: 'product-2'}));
    expect(over.status).toBe('fallback');
    expect(p.calls).toBe(1);
  });

  it('expires entries after the TTL', async () => {
    let clock = 0;
    const p = provider(async (t) => `fr:${t}`);
    const tr = createContentTranslator({provider: p, ttlMs: 100, now: () => clock});
    await tr.translateContent(input());
    clock = 150;
    expect((await tr.translateContent(input())).status).toBe('translated');
    expect(p.calls).toBe(2);
  });
});
