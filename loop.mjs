// Працює кілька годин: збирає дані всіх кінотеатрів.
// Якщо задано Firebase — щохвилини пише зміни в базу, а сайт на GitHub Pages публікує лише раз на старті.
// Без Firebase — запасний режим: публікує дані на GitHub Pages раз на 5 хв.
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import { CINEMAS, scrapeCinema } from './scrape.mjs';
import { makeFirebase, flatten } from './firebase.mjs';
import { makeNotifier } from './notify.mjs';

const RUN_MINUTES = Number(process.env.RUN_MINUTES || 340);
// адреса бази: перша з кандидатів, що відповідає (регіон бази наперед невідомий)
let FB = null, DB_URL = '';
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  for (const url of String(process.env.FIREBASE_DB_URL || '').split(/\s+/).filter(Boolean)) {
    const fb = makeFirebase(process.env.FIREBASE_SERVICE_ACCOUNT, url);
    try { await fb.patch('meta', { checkedAt: new Date().toISOString() }); FB = fb; DB_URL = url.replace(/\/+$/, ''); break; }
    catch (e) { console.log(`база ${url} не підійшла: ${e.message}`); }
  }
  if (DB_URL) {
    const f = 'site/index.html';
    writeFileSync(f, readFileSync(f, 'utf8').replaceAll('__FIREBASE_DB_URL__', DB_URL).replace('__BUILD__', process.env.GITHUB_SHA || ''));
  }
}
const INTERVAL_DAY = FB ? 60_000 : 300_000; // з Firebase щохвилини; лише Pages — раз на 5 хв (частіше GitHub гальмує)
const INTERVAL_NIGHT = 600_000;   // вночі (02:00–07:59 за Києвом): раз на 10 хв
const PAGES_URL = 'https://slade444.github.io/misciavzali/data/';
const { GITHUB_REPOSITORY, GITHUB_TOKEN, GITHUB_SHA } = process.env;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const kyivHour = () => Number(new Date().toLocaleString('en-GB', { timeZone: 'Europe/Kyiv', hour: '2-digit', hour12: false })) % 24;
const log = m => console.log(`[${new Date().toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv' })}] ${m}`);

mkdirSync('site/data', { recursive: true });
// стартові дані — з поточного сайту, щоб місто не зникло, якщо перший збір не вдасться
for (const slug of CINEMAS) {
  try { const r = await fetch(PAGES_URL + slug + '.json'); if (r.ok) writeFileSync(`site/data/${slug}.json`, await r.text()); } catch {}
}

const artifacts = new DefaultArtifactClient();
let deployN = 0;
async function deploy() {
  deployN++;
  rmSync('artifact.tar', { force: true });
  execFileSync('tar', ['--dereference', '--hard-dereference', '-C', 'site', '-cf', 'artifact.tar', '.']);
  const { id } = await artifacts.uploadArtifact(`github-pages-${deployN}`, ['artifact.tar'], '.', { retentionDays: 1 });
  const oidc = await core.getIDToken();
  const r = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}/pages/deployments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ artifact_id: id, pages_build_version: GITHUB_SHA, oidc_token: oidc }),
  });
  if (!r.ok) throw new Error(`Pages ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const { status_url } = await r.json();
  // чекаємо, поки GitHub справді опублікує, інакше наступні публікації стають у чергу
  let st = '?';
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    try {
      const q = await fetch(status_url, { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } });
      st = (await q.json()).status;
    } catch {}
    if (['succeed', 'deployment_failed', 'deployment_lost', 'deployment_cancelled', 'deployment_content_failed', 'deployment_perms_error', 'deployment_attempt_error'].includes(st)) break;
  }
  if (st !== 'succeed') throw new Error(`статус публікації: ${st}`);
}
async function liveLag() {
  try {
    const r = await fetch(PAGES_URL + 'vinnytsia.json?t=' + Date.now(), { cache: 'no-store' });
    const j = await r.json();
    return Math.round((Date.now() - Date.parse(j.updatedAt)) / 1000) + ' с';
  } catch (e) { return 'н/д'; }
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  locale: 'uk-UA', timezoneId: 'Europe/Kyiv', viewport: { width: 1920, height: 1080 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
});
const page = await ctx.newPage();
const until = Date.now() + RUN_MINUTES * 60_000;
let deployFails = 0, extraWait = 0, staleCount = 0;

const last = {};   // що вже записано в Firebase, по містах
let round = 0;
async function pushFirebase(slug, json) {
  const { updatedAt, moveArray } = JSON.parse(json);
  const cur = flatten(moveArray), prev = last[slug];
  if (!prev) {
    await FB.put(`cinemas/${slug}`, { updatedAt, sessions: cur });
  } else {
    const upd = { updatedAt };
    for (const k in cur) if (JSON.stringify(cur[k]) !== JSON.stringify(prev[k])) upd[`sessions/${k}`] = cur[k];
    for (const k in prev) if (!(k in cur)) upd[`sessions/${k}`] = null;
    await FB.patch(`cinemas/${slug}`, upd);
  }
  last[slug] = cur;
}
log(FB ? `режим: Firebase (${DB_URL}), щохвилини` : 'режим: лише GitHub Pages, раз на 5 хв');
let siteOk = false;
async function ensureSite() {
  try {
    const h = await (await fetch('https://slade444.github.io/misciavzali/?t=' + Date.now(), { cache: 'no-store' })).text();
    if (h.includes(DB_URL) && h.includes(`content="${GITHUB_SHA}"`)) { if (!siteOk) log('сайт на GitHub Pages уже з живими даними'); siteOk = true; return; }
  } catch {}
  try { await deploy(); log('сайт опубліковано, перевірю ще раз за 5 хв'); } catch (e) { log(`публікація сайту не вдалася: ${e.message}`); }
}
// Ручна тривалість сеансів: сайт кладе запит у /inbox (лише з правильним PIN — це перевіряють правила бази),
// збирач переносить його в /durations (читати може кожен, писати — лише збирач).
const PIN = String(process.env.EDIT_PIN || '').trim();
if (FB && PIN) {
  try {
    await FB.rules({ rules: {
      cinemas: { '.read': true, '.write': false },
      durations: { '.read': true, '.write': false },
      inbox: { $id: {
        '.write': `!data.exists() && newData.child('pin').val() === ${JSON.stringify(PIN)}`,
        '.validate': "newData.hasChildren(['pin','slug','key','min']) && newData.child('min').isNumber() && (newData.child('min').val() === 0 || (newData.child('min').val() >= 30 && newData.child('min').val() <= 400))",
      } },
    } });
    log('правила бази оновлено (редагування тривалості з PIN)');
  } catch (e) { log(`правила бази не оновлено: ${e.message}`); }
} else if (FB) log('EDIT_PIN не задано — редагування тривалості вимкнене');
async function processInbox() {
  const inbox = await FB.get('inbox');
  if (!inbox) return;
  for (const [id, x] of Object.entries(inbox)) {
    if (x && CINEMAS.includes(x.slug) && typeof x.key === 'string' && /^[^.#$\[\]\/]{1,120}$/.test(x.key)) {
      const path = `durations/${x.slug}/${x.key}`;
      if (x.min === 0) await FB.del(path);
      else await FB.put(path, { title: String(x.title || '').slice(0, 200), min: x.min, updatedAt: new Date().toISOString() });
      log(`тривалість: ${x.slug} «${x.title}» → ${x.min || 'як на сайті'}`);
    }
    await FB.del(`inbox/${id}`);
  }
}
const TG = makeNotifier({ token: String(process.env.TELEGRAM_BOT_TOKEN || '').trim(), fb: FB, log });
if (TG) await TG.check(); else log('TELEGRAM_BOT_TOKEN не задано — сповіщення вимкнені');
if (FB) await ensureSite();

while (Date.now() < until) {
  const started = Date.now();
  let ok = 0;
  round++;
  if (FB && PIN) { try { await processInbox(); } catch (e) { log(`черга тривалостей: ${e.message}`); } }
  for (const slug of CINEMAS) {
    try {
      const { json, sessions } = await scrapeCinema(page, slug);
      writeFileSync(`site/data/${slug}.json`, json);
      if (FB) await pushFirebase(slug, json);
      if (TG) await TG.scan(slug, json);
      ok++;
      if (round === 1) log(`${slug}: ${sessions} сеансів`);
    } catch (e) { log(`${slug} ПОМИЛКА: ${e.message}`); delete last[slug]; }
  }
  if (FB && !siteOk && round % 5 === 0) await ensureSite();
  if (FB) { if (round <= 3 || round % 30 === 0) log(`раунд ${round}: записано ${ok}/${CINEMAS.length}`); }
  else if (ok) {
    try {
      await deploy(); deployFails = 0; extraWait = 0;
      const lag = await liveLag();
      log(`опубліковано #${deployN} (${ok}/${CINEMAS.length}) · на сайті дані давністю ${lag}`);
      staleCount = parseInt(lag) > 600 ? staleCount + 1 : 0;
      if (staleCount) log(`увага: сайт не показує нові дані (${staleCount} раз поспіль)`);
    }
    catch (e) { deployFails++; extraWait = Math.min(240_000, 60_000 * deployFails); log(`публікація не вдалася: ${e.message}`); }
  }
  const interval = (kyivHour() >= 2 && kyivHour() < 8) ? INTERVAL_NIGHT : INTERVAL_DAY;
  const wait = Math.max(5_000, interval + extraWait - (Date.now() - started));
  if (Date.now() + wait >= until) break;
  await sleep(wait);
}
await browser.close();
log('цикл завершено');
