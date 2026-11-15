// Запис у Firebase Realtime Database від імені сервісного акаунта (без сторонніх бібліотек)
import { createSign } from 'node:crypto';

export function makeFirebase(saJson, dbUrl) {
  const sa = JSON.parse(saJson);
  const base = dbUrl.replace(/\/+$/, '');
  let token = null, tokenExp = 0;

  async function accessToken() {
    if (token && Date.now() < tokenExp - 300_000) return token;
    const now = Math.floor(Date.now() / 1000);
    const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({
      iss: sa.client_email, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    });
    const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('токен Google: ' + JSON.stringify(j).slice(0, 200));
    token = j.access_token; tokenExp = Date.now() + j.expires_in * 1000;
    return token;
  }

  async function call(method, path, body) {
    const r = await fetch(`${base}/${path}.json`, {
      method, headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Firebase ${method} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return method === 'GET' ? r.json() : null;
  }
  return {
    put: (p, b) => call('PUT', p, b), patch: (p, b) => call('PATCH', p, b),
    get: p => call('GET', p), del: p => call('DELETE', p),
    rules: r => call('PUT', '.settings/rules', r),
  };
}

// moveArray → плоский словник сеансів {ключ: {d,h,t,m,s,n}}
export function flatten(moveArray) {
  const out = {};
  for (const sd of moveArray.showDates || [])
    for (const mv of sd.movies || [])
      for (const md of mv.showDates || []) {
        const d = String(md.date || sd.date || '').slice(0, 10);
        for (const s of md.sessions || []) {
          const t = String(s.timeStart || '').slice(0, 5);
          const key = `${d}_${s.hallNumber}_${t.replace(':', '-')}`.replace(/[.#$\[\]\/]/g, '-');
          out[key] = { d, h: Number(s.hallNumber), t, e: String(s.timeEnd || '').slice(0, 5), m: mv.title || '—', s: s.stringStatusSeat || '', n: Number(s.numberSeats) || 0 };
        }
      }
  return out;
}
