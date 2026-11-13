// Працює кілька годин: щохвилини збирає дані всіх кінотеатрів і публікує сайт на GitHub Pages.
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import { CINEMAS, scrapeCinema } from './scrape.mjs';

const RUN_MINUTES = Number(process.env.RUN_MINUTES || 340);
const INTERVAL_DAY = 60_000;      // вдень: щохвилини
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
let deployFails = 0, extraWait = 0;

while (Date.now() < until) {
  const started = Date.now();
  let ok = 0;
  for (const slug of CINEMAS) {
    try {
      const { json, sessions } = await scrapeCinema(page, slug);
      writeFileSync(`site/data/${slug}.json`, json);
      ok++;
      if (deployN === 0) log(`${slug}: ${sessions} сеансів`);
    } catch (e) { log(`${slug} ПОМИЛКА: ${e.message}`); }
  }
  if (ok) {
    try { await deploy(); deployFails = 0; extraWait = 0; log(`опубліковано #${deployN} (${ok}/${CINEMAS.length}) · на сайті дані давністю ${await liveLag()}`); }
    catch (e) { deployFails++; extraWait = Math.min(240_000, 60_000 * deployFails); log(`публікація не вдалася: ${e.message}`); }
  }
  const interval = (kyivHour() >= 2 && kyivHour() < 8) ? INTERVAL_NIGHT : INTERVAL_DAY;
  const wait = Math.max(5_000, interval + extraWait - (Date.now() - started));
  if (Date.now() + wait >= until) break;
  await sleep(wait);
}
await browser.close();
log('цикл завершено');
