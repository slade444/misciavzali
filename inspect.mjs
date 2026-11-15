// Разова діагностика: сеанси, що вже почались, — які в них поля
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ timezoneId: 'Europe/Kyiv' });
await p.goto('https://cinemaciti.ua/ua/cinema-city-vinnytsia/now/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => window.nowData && nowData.moveArray, null, { timeout: 60000 });
const out = await p.evaluate(() => {
  const res = [];
  for (const sd of nowData.moveArray.showDates.slice(0, 1))
    for (const mv of sd.movies) for (const md of mv.showDates) for (const s of md.sessions)
      res.push(`${s.hallNumber} ${s.timeStart} end=${JSON.stringify(s.timeEnd)} date=${s.date} runtime=${mv.runtime} keys=${Object.keys(s).length}`);
  return res.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
});
console.log(out.join('\n'));
await b.close();
