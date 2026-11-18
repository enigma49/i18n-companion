import {getTranslations} from 'next-intl/server';

export default async function HomePage() {
  const t = await getTranslations('Home');
  return <h1>{t('title', {name: 'Sam'})}</h1>;
}
