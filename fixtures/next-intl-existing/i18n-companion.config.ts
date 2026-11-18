// i18n-companion configuration for the test fixture.
export default {
  sourceLocale: 'en',
  targetLocales: ['fr', 'de'],
  adapter: 'next-intl',
  messagesDir: 'messages',
  include: ['src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
};
