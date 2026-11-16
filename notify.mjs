// Сповіщення в Telegram: через 15 хв після початку сеансу в залі немає жодного купленого квитка
import { flatten } from './firebase.mjs';

const CHAT_ID = '-1003966176178';
const AFTER_MIN = 15;   // через скільки хвилин після початку перевіряти
const WINDOW_MIN = 45;  // до якої хвилини після початку ще можна надіслати (якщо збирач перезапускався)
const NAMES = { vinnytsia: 'Вінниця', chernivtsi: 'Чернівці', odessa: 'Одеса', kyiv: 'Київ' };
const SOLD = new Set(['S', 'V', 'T']);
const ONLY = new Set(['vinnytsia']); // поки що сповіщення лише для Вінниці

const kyivNow = () => {
  const d = new Date();
  const date = d.toLocaleDateString('sv-SE', { timeZone: 'Europe/Kyiv' });
  const [h, m] = d.toLocaleTimeString('en-GB', { timeZone: 'Europe/Kyiv', hour12: false }).split(':').map(Number);
  return { date, min: (h % 24) * 60 + m };
};
const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

export function makeNotifier({ token, fb, log }) {
  if (!token) return null;
  const api = m => `https://api.telegram.org/bot${token}/${m}`;
  const sent = new Set();          // уже надіслані за цей запуск (і завантажені з бази)
  let loaded = false;

  async function load() {
    if (loaded || !fb) { loaded = true; return; }
    const { date } = kyivNow();
    try {
      const all = (await fb.get('notified')) || {};
      for (const [slug, items] of Object.entries(all))
        for (const key of Object.keys(items || {})) {
          if (key.slice(0, 10) < date) await fb.del(`notified/${slug}/${key}`); // старі дні прибираємо
          else sent.add(`${slug}/${key}`);
        }
      loaded = true;
    } catch (e) { log(`сповіщення: не прочитав історію — ${e.message}`); }
  }

  async function send(text) {
    const r = await fetch(api('sendMessage'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram ${r.status}: ${j.description || ''}`);
  }

  return {
    async check() {
      try {
        const r = await (await fetch(api('getMe'))).json();
        log(r.ok ? `Telegram: бот @${r.result.username} готовий` : `Telegram: токен не підходить — ${r.description}`);
        return r.ok;
      } catch (e) { log(`Telegram: немає зв'язку — ${e.message}`); return false; }
    },
    async scan(slug, json) {
      if (!ONLY.has(slug)) return;
      await load();
      const { moveArray } = JSON.parse(json);
      const { date, min: now } = kyivNow();
      const due = [];
      for (const [key, s] of Object.entries(flatten(moveArray))) {
        if (s.d !== date || sent.has(`${slug}/${key}`)) continue;
        const [h, m] = s.t.split(':').map(Number), since = now - (h * 60 + m);
        if (since < AFTER_MIN || since >= WINDOW_MIN) continue;
        if ([...s.s].some(c => SOLD.has(c))) continue;
        due.push([key, s]);
      }
      due.sort((a, b) => a[1].h - b[1].h);
      for (const [key, s] of due) {
        const text = `🔴 <b>Зал ${s.h} · ${esc(s.t)}</b>\n«${esc(s.m)}»\nКуплених квитків немає — зал можна вимикати.`;
        try {
          await send(text);
          sent.add(`${slug}/${key}`);
          if (fb) await fb.put(`notified/${slug}/${key}`, true).catch(() => {});
          log(`Telegram: ${slug} зал ${s.h} ${s.t} «${s.m}» — немає куплених`);
        } catch (e) { log(`Telegram: не надіслано — ${e.message}`); }
      }
    },
  };
}
