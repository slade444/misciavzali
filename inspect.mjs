// Разова діагностика: які поля є у фільмів і сеансів на сайті
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('https://cinemaciti.ua/ua/cinema-city-vinnytsia/now/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.waitForFunction(() => window.nowData && nowData.moveArray, null, { timeout: 60000 });
const info = await p.evaluate(() => {
  const ma = nowData.moveArray, sd = ma.showDates[0], mv = sd.movies[0], md = mv.showDates[0], s = md.sessions[0];
  const short = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'object' ? (Array.isArray(v) ? `[array ${v.length}]` : '{obj}') : String(v).slice(0, 60)]));
  return { nowDataKeys: Object.keys(nowData), moveArrayKeys: Object.keys(ma), showDate: short(sd), movie: short(mv), movieShowDate: short(md), session: short(s) };
});
console.log(JSON.stringify(info, null, 1));
await b.close();
