// Збирає дані про місця з сторінок сеансів Cinema City
export const CINEMAS = ['vinnytsia', 'chernivtsi', 'odessa', 'kyiv'];
const DAYS = 3; // скільки днів наперед зберігати

export async function scrapeCinema(page, slug) {
  const URL = `https://cinemaciti.ua/ua/cinema-city-${slug}/now/`;
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForFunction(
    () => !!(window.nowData && nowData.moveArray && Array.isArray(nowData.moveArray.showDates) && nowData.moveArray.showDates.length > 0),
    null, { timeout: 45000 }
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
  if (!sessions) throw new Error('сеансів не знайдено — структура сайту могла змінитися');
  return { json: JSON.stringify({ updatedAt: new Date().toISOString(), source: URL, moveArray: { showDates } }), sessions };
}
