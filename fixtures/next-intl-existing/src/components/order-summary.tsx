'use client';

import {useTranslations} from 'next-intl';

export function OrderSummary({total}: {total: string}) {
  const t = useTranslations('Common');
  return (
    <section aria-label="Order summary">
      <p>Order total: {total}</p>
      <button type="button">{t('cancel')}</button>
    </section>
  );
}
