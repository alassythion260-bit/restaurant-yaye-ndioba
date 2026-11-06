// Restaurant Yaye Ndioba : site + menu modifiable par le propriétaire.
// - "/" : la page du restaurant, avec le menu lu dans la base KV (MENU).
// - "/admin" : la page de gestion du menu (fichier public/admin.html).
// - "/api/..." : lecture et enregistrement du menu, envoi des photos.
// Tout le reste (photos du site, admin.html) est servi tel quel depuis le dossier public.

import TEMPLATE from './template.html';
import DEFAULT_MENU from './default-menu.json';

const SECTIONS = [
  { key: 'matin', fr: 'Matin', en: 'Morning' },
  { key: 'soir', fr: 'Soir', en: 'Evening' },
  { key: 'boissons', fr: 'Boissons', en: 'Drinks' },
];
const MAX_ITEMS = 60;          // plats par section
const MAX_IMAGE = 3 * 1024 * 1024; // 3 Mo par photo (elles sont compressées avant l'envoi)
const UTC_OFFSET = 0;          // Dakar = UTC+0

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if ((path === '/' || path === '/index.html') && (method === 'GET' || method === 'HEAD')) {
        return renderHome(env, url);
      }
      if (path === '/api/menu') {
        if (method === 'GET') return json(await getMenu(env), 200, { 'cache-control': 'no-store' });
        if (method === 'PUT') return saveMenu(request, env);
        return json({ error: 'method' }, 405);
      }
      if (path === '/api/login' && method === 'POST') {
        if (!(await checkAuth(request, env))) return deny();
        return json({ ok: true });
      }
      if (path === '/api/password' && method === 'POST') return changePassword(request, env);
      if (path === '/api/upload' && method === 'POST') return upload(request, env);
      if (path.startsWith('/api/img/') && (method === 'GET' || method === 'HEAD')) return image(path.slice(9), env);
      if (path.startsWith('/api/')) return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: 'server', detail: String(e && e.message || e) }, 500);
    }
    return env.ASSETS.fetch(request);
  },
};

// ---------- Menu ----------

async function getMenu(env) {
  if (!env.MENU) return DEFAULT_MENU;
  const saved = await env.MENU.get('menu', 'json');
  return saved || DEFAULT_MENU;
}

async function saveMenu(request, env) {
  if (!(await checkAuth(request, env))) return deny();
  if (!env.MENU) return json({ error: 'kv', message: 'La base MENU n’est pas reliée au site.' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'json', message: 'Données illisibles.' }, 400); }
  const clean = sanitizeMenu(body);
  if (clean.error) return json({ error: 'invalid', message: clean.error }, 400);

  // Supprime les anciennes photos qui ne sont plus utilisées
  const old = await getMenu(env);
  const used = new Set(imageIds(clean.menu));
  const removed = imageIds(old).filter((id) => !used.has(id));

  await env.MENU.put('menu', JSON.stringify(clean.menu));
  await Promise.all(removed.map((id) => env.MENU.delete('img:' + id)));
  return json({ ok: true, menu: clean.menu });
}

function imageIds(menu) {
  const ids = [];
  for (const s of SECTIONS) for (const it of (menu.sections && menu.sections[s.key]) || []) {
    const m = /^\/api\/img\/([a-z0-9-]+)$/.exec(it.img || '');
    if (m) ids.push(m[1]);
  }
  return ids;
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function sanitizeMenu(input) {
  if (!input || typeof input !== 'object' || !input.sections) return { error: 'Menu vide.' };
  const s = input.settings || {};
  let hour = parseInt(s.switchHour, 10);
  if (!(hour >= 0 && hour <= 23)) hour = 17;
  const menu = {
    settings: { switchHour: hour, matinHours: str(s.matinHours, 60), soirHours: str(s.soirHours, 60) },
    sections: {},
  };
  for (const sec of SECTIONS) {
    const list = Array.isArray(input.sections[sec.key]) ? input.sections[sec.key] : [];
    if (list.length > MAX_ITEMS) return { error: 'Trop de plats dans « ' + sec.fr + ' » (maximum ' + MAX_ITEMS + ').' };
    menu.sections[sec.key] = [];
    for (const it of list) {
      const name = str(it.name, 80);
      if (!name) return { error: 'Un plat de « ' + sec.fr + ' » n’a pas de nom.' };
      const price = Math.round(Number(String(it.price).replace(/[^\d]/g, '')));
      if (!(price >= 0 && price <= 1000000)) return { error: 'Prix invalide pour « ' + name + ' ».' };
      let img = str(it.img, 200);
      if (img && !/^\/(img\/[a-z0-9._-]+|api\/img\/[a-z0-9-]+)$/.test(img)) img = '';
      menu.sections[sec.key].push({
        id: str(it.id, 60) || crypto.randomUUID(),
        name,
        name_en: str(it.name_en, 80),
        desc: str(it.desc, 200),
        desc_en: str(it.desc_en, 200),
        price,
        img,
        available: it.available !== false,
        contain: it.contain === true,
      });
    }
  }
  return { menu };
}

// ---------- Photos ----------

async function upload(request, env) {
  if (!(await checkAuth(request, env))) return deny();
  if (!env.MENU) return json({ error: 'kv', message: 'La base MENU n’est pas reliée au site.' }, 500);
  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\/(jpeg|png|webp)$/.test(type)) return json({ error: 'type', message: 'Format de photo non accepté.' }, 415);
  const data = await request.arrayBuffer();
  if (!data.byteLength) return json({ error: 'empty', message: 'Photo vide.' }, 400);
  if (data.byteLength > MAX_IMAGE) return json({ error: 'size', message: 'Photo trop lourde (maximum 3 Mo).' }, 413);
  const id = crypto.randomUUID();
  await env.MENU.put('img:' + id, data, { metadata: { type } });
  return json({ ok: true, url: '/api/img/' + id });
}

async function image(id, env) {
  if (!env.MENU || !/^[a-z0-9-]+$/.test(id)) return new Response('Not found', { status: 404 });
  const { value, metadata } = await env.MENU.getWithMetadata('img:' + id, 'arrayBuffer');
  if (!value) return new Response('Not found', { status: 404 });
  return new Response(value, {
    headers: {
      'content-type': (metadata && metadata.type) || 'image/jpeg',
      // chaque photo envoyée a une adresse unique : le navigateur peut la garder longtemps
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

// ---------- Mot de passe ----------

// Deux mots de passe sont acceptés :
//  - celui que le propriétaire choisit lui-même dans /admin (enregistré chiffré dans la base, clé "auth") ;
//  - le code de secours ADMIN_PASSWORD (secret Cloudflare), pour la maintenance ou si le propriétaire oublie le sien.
const PBKDF2_ITER = 10000;

function sameBytes(a, b) {
  const x = new Uint8Array(a), y = new Uint8Array(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
function toHex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
function fromHex(h) { return new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16))); }

async function hashPassword(pw, salt) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256);
}

async function checkAuth(request, env) {
  const given = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  let ok = false;
  if (given) {
    const owner = env.MENU ? await env.MENU.get('auth', 'json') : null;
    if (owner && owner.hash && owner.salt) {
      ok = sameBytes(await hashPassword(given, fromHex(owner.salt)), fromHex(owner.hash));
    }
    if (!ok && env.ADMIN_PASSWORD) {
      const enc = new TextEncoder();
      const [a, b] = await Promise.all([
        crypto.subtle.digest('SHA-256', enc.encode(given)),
        crypto.subtle.digest('SHA-256', enc.encode(env.ADMIN_PASSWORD)),
      ]);
      ok = sameBytes(a, b);
    }
  }
  if (!ok) await new Promise((r) => setTimeout(r, 800)); // ralentit les essais au hasard
  return ok;
}

async function changePassword(request, env) {
  if (!(await checkAuth(request, env))) return deny();
  if (!env.MENU) return json({ error: 'kv', message: 'La base MENU n’est pas reliée au site.' }, 500);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'json', message: 'Données illisibles.' }, 400); }
  const pw = typeof body.password === 'string' ? body.password : '';
  if (pw.length < 8) return json({ error: 'short', message: 'Le mot de passe doit faire au moins 8 caractères.' }, 400);
  if (pw.length > 100) return json({ error: 'long', message: 'Le mot de passe est trop long.' }, 400);
  if (env.ADMIN_PASSWORD && pw === env.ADMIN_PASSWORD) return json({ error: 'same', message: 'Choisissez un mot de passe différent du code de secours.' }, 400);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await hashPassword(pw, salt);
  await env.MENU.put('auth', JSON.stringify({ salt: toHex(salt), hash: toHex(hash), at: new Date().toISOString() }));
  return json({ ok: true });
}

function deny() {
  return json({ error: 'auth', message: 'Mot de passe incorrect.' }, 401);
}

// ---------- Page d'accueil ----------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function priceFr(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' FCFA'; }
function priceEn(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + ' FCFA'; }
function both(fr, en) {
  return '<span data-l="fr">' + esc(fr) + '</span><span data-l="en">' + esc(en || fr) + '</span>';
}

function renderItem(it, drinks) {
  const out = !it.available;
  const img = it.img
    ? '<img src="' + esc(it.img) + '" alt="' + esc(it.name) + '"' + (it.contain ? ' class="contain"' : '') +
      ' loading="lazy" decoding="async" width="720" height="' + (drinks ? '1080' : '540') + '">'
    : '';
  return '      <article class="dish-card' + (out ? ' out' : '') + '">\n        ' + img +
    '\n        <div class="dish-body"><div class="dish-head"><b>' + both(it.name, it.name_en) + '</b>' +
    '<span class="price">' + both(priceFr(it.price), priceEn(it.price)) + '</span></div>' +
    (out ? '<span class="badge">' + both('Épuisé pour le moment', 'Sold out for now') + '</span>' : '') +
    (it.desc ? '<span class="sub">' + both(it.desc, it.desc_en) + '</span>' : '') +
    '</div>\n      </article>';
}

function currentSection(menu) {
  const hour = (new Date().getUTCHours() + UTC_OFFSET + 24) % 24;
  const switchHour = menu.settings && menu.settings.switchHour != null ? menu.settings.switchHour : 17;
  const wanted = hour >= switchHour || hour < 4 ? 'soir' : 'matin';
  const has = (k) => (menu.sections[k] || []).length > 0;
  if (has(wanted)) return wanted;
  if (has('matin')) return 'matin';
  if (has('soir')) return 'soir';
  return 'boissons';
}

function renderMenu(menu) {
  const active = currentSection(menu);
  const st = menu.settings || {};
  const hours = { matin: st.matinHours, soir: st.soirHours };
  let tabs = '    <div class="tabs" role="tablist" aria-label="Menu">\n';
  let panels = '';
  for (const s of SECTIONS) {
    const on = s.key === active;
    tabs += '      <button class="tab" role="tab" id="tab-' + s.key + '" aria-selected="' + on + '" aria-controls="panel-' + s.key + '">' + both(s.fr, s.en) + '</button>\n';
    const items = menu.sections[s.key] || [];
    const drinks = s.key === 'boissons';
    let inner = '';
    if (hours[s.key]) inner += '      <p class="svc-hours" style="grid-column:1/-1">' + both(s.fr + ' · ' + hours[s.key], s.en + ' · ' + hours[s.key]) + '</p>\n';
    if (items.length) {
      inner += items.map((it) => renderItem(it, drinks)).join('\n');
    } else {
      inner += '      <div class="menu-empty" style="grid-column:1/-1"><span>' +
        both('Ce menu sera bientôt en ligne. Demandez les plats du jour sur WhatsApp.', 'This menu is coming soon. Ask for today’s dishes on WhatsApp.') +
        '</span><a class="btn btn-green" href="https://wa.me/221764957855" data-wa>' + both('Demander sur WhatsApp', 'Ask on WhatsApp') + '</a></div>';
    }
    panels += '\n    <div id="panel-' + s.key + '" role="tabpanel" aria-labelledby="tab-' + s.key + '" class="dish-grid' + (drinks ? ' drinks' : '') + '"' + (on ? '' : ' hidden') + '>\n' + inner + '\n    </div>\n';
  }
  tabs += '    </div>\n';
  return tabs + panels;
}

function renderJsonLd(menu, origin) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    name: 'Restaurant Yaye Ndioba',
    servesCuisine: 'Sénégalaise',
    telephone: '+221764957855',
    url: origin + '/',
    image: origin + '/img/devanture.webp',
    priceRange: 'FCFA',
    paymentAccepted: 'Orange Money, Wave',
    address: { '@type': 'PostalAddress', streetAddress: 'Rue 9', addressLocality: 'Médina, Dakar', addressCountry: 'SN' },
    geo: { '@type': 'GeoCoordinates', latitude: 14.6791572, longitude: -17.4481207 },
    hasMenu: {
      '@type': 'Menu',
      hasMenuSection: SECTIONS.filter((s) => (menu.sections[s.key] || []).length).map((s) => ({
        '@type': 'MenuSection',
        name: s.fr,
        hasMenuItem: menu.sections[s.key].map((it) => ({
          '@type': 'MenuItem',
          name: it.name,
          description: it.desc || undefined,
          offers: { '@type': 'Offer', price: it.price, priceCurrency: 'XOF', availability: it.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock' },
        })),
      })),
    },
  };
  return '<script type="application/ld+json">' + JSON.stringify(data).replace(/</g, '\\u003c') + '</script>';
}

async function renderHome(env, url) {
  const menu = await getMenu(env);
  const prices = ['matin', 'soir'].flatMap((k) => (menu.sections[k] || []).filter((i) => i.available && i.price > 0).map((i) => i.price));
  const min = prices.length ? Math.min(...prices) : 1500;
  const html = TEMPLATE
    .replace('<!--MENU-->', renderMenu(menu))
    .replace('<!--JSONLD-->', renderJsonLd(menu, url.origin))
    .replace('<!--MIN_FR-->', priceFr(min))
    .replace('<!--MIN_EN-->', priceEn(min));
  return new Response(html, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
  });
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}
