// Відкриває сторінки сеансів Cinema City і зберігає дані про місця у site/data/<місто>.json
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const CINEMAS = ['vinnytsia', 'chernivtsi', 'odessa', 'kyiv'];
const PAGES_URL = 'https://slade444.github.io/misciavzali/data/';
const DAYS = 3; // скільки днів наперед зберігати

mkdirSync('site/data', { recursive: true });
const browser = await chromium.launch();
let okCount = 0;
for (const slug of CINEMAS) {
  const URL = `https://cinemaciti.ua/ua/cinema-city-${slug}/now/`;
  let page;
  try {
  page = await browser.newPage({
    locale: 'uk-UA',
    timezoneId: 'Europe/Kyiv',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    viewport: { width: 1920, height: 1080 },
  });
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () => !!(window.nowData && nowData.moveArray && Array.isArray(nowData.moveArray.showDates) && nowData.moveArray.showDates.length > 0),
    null, { timeout: 60000 }
  );
  const raw = await page.evaluate(() => window.nowData.moveArray);

  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  const keepDates = [...new Set(raw.showDates.map(d => String(d.date || '').slice(0, 10)))]
    .filter(d => d >= today).sort().slice(0, DAYS);
  const keep = d => keepDates.includes(String(d || '').slice(0, 10));

  const showDates = raw.showDates.filter(sd => keep(sd.date)).map(sd => ({
    date: sd.date,
    movies: (sd.movies || []).map(mv => ({
      title: mv.title,
      showDates: (mv.showDates || []).filter(md => keep(md.date)).map(md => ({
        date: md.date,
        sessions: (md.sessions || []).map(s => ({
          hallNumber: s.hallNumber,
          timeStart: s.timeStart,
          stringStatusSeat: s.stringStatusSeat,
          numberSeats: s.numberSeats,
        })),
      })),
    })),
  }));

  const sessions = showDates.flatMap(sd => sd.movies.flatMap(m => m.showDates.flatMap(md => md.sessions))).length;
  if (!sessions) throw new Error('Сеансів не знайдено — структура сайту могла змінитися');

  writeFileSync(`site/data/${slug}.json`, JSON.stringify({ updatedAt: new Date().toISOString(), source: URL, moveArray: { showDates } }));
  const all = showDates.flatMap(sd => sd.movies.flatMap(m => m.showDates.flatMap(md => md.sessions.map(x => ({ t: m.title, ...x })))));
  const chars = [...new Set(all.flatMap(x => [...String(x.stringStatusSeat || '')]))].join('');
  const ex = all[0];
  okCount++;
  console.log(`${slug} OK: ${keepDates.join(', ')} · сеансів: ${sessions}`);
  console.log(`Приклад: зал ${ex.hallNumber}, ${ex.timeStart}, місць ${ex.numberSeats}, символи схеми: ${JSON.stringify(chars)}`);
  } catch (e) {
    console.log(`${slug} ПОМИЛКА: ${e.message}`);
    // лишаємо попередні дані, щоб місто не зникло з сайту
    try {
      const r = await fetch(PAGES_URL + slug + '.json');
      if (r.ok) { writeFileSync(`site/data/${slug}.json`, await r.text()); console.log(`${slug}: залишено попередні дані`); }
    } catch {}
  } finally {
    if (page) await page.close();
  }
}
await browser.close();
if (!okCount) { console.error('Жоден кінотеатр не оновився'); process.exit(1); }
