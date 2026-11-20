#!/usr/bin/env node
'use strict';
/**
 * Builds getroadwise.app, RoadWise's website, into `web/site-dist/` (git-ignored), and with
 * `--deploy` publishes it to Vercel (production).
 *
 *   npm run site:build
 *   npm run site:deploy
 *
 * The site: the landing page, Support, Delete your account, the Privacy Policy and the Terms of
 * Service, and the share-link files (`/w/<id>`, the apple-app-site-association and assetlinks.json).
 *
 * - `web/link-site/` is copied as it is, except `_pages/` and `site.json`, and except the two
 *   association files, which are written only once `site.json` holds what they need (an association
 *   file with a placeholder in it would point the links at no app).
 * - `web/link-site/_pages/*.html` are page bodies, each with a comment header (title, description,
 *   and `hero: true` or a heading and intro); each becomes `<name>/index.html` in the site layout.
 * - `/privacy` and `/terms` are built from the local drafts in `legal/` (git-ignored), with the same
 *   parser the app uses, so the hosted text always equals the in-app text after `npm run legal:sync`.
 *
 * `web/link-site/site.json` (committed; nothing in it is secret):
 *   appleTeamId        the 10-character Apple Developer team ID: writes the apple-app-site-association
 *   appStoreId         the app's numeric App Store id: the App Store button and the share page's link
 *   playStoreLive      true once the Google Play listing is public: the Google Play button
 *   androidCertSha256  the Play app signing and upload key SHA-256 fingerprints: writes assetlinks.json
 * Until there is a store id, the landing page says RoadWise is coming soon.
 *
 * The deploy runs the Vercel CLI in `web/site-dist/`; its `.vercel/` link survives rebuilds.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { parseMarkdown } = require('../src/features/legal/markdown.ts');
const { escape, bodyHtml } = require('./legal-html.js');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'web', 'link-site');
const OUT = path.join(ROOT, 'web', 'site-dist');
const LEGAL = path.join(ROOT, 'legal');
const ORIGIN = 'https://getroadwise.app';
const BUNDLE_ID = 'com.lurp.safedrive';
const PLAY_URL = `https://play.google.com/store/apps/details?id=${BUNDLE_ID}`;

const TEAM_RE = /^[A-Z0-9]{10}$/;
const SHA256_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;

function readConfig() {
  const raw = JSON.parse(fs.readFileSync(path.join(SRC, 'site.json'), 'utf8'));
  const config = {
    appleTeamId: String(raw.appleTeamId ?? '').trim(),
    appStoreId: String(raw.appStoreId ?? '').trim(),
    playStoreLive: raw.playStoreLive === true,
    androidCertSha256: Array.isArray(raw.androidCertSha256) ? raw.androidCertSha256.map((s) => String(s).trim().toUpperCase()).filter(Boolean) : [],
  };
  if (config.appleTeamId && !TEAM_RE.test(config.appleTeamId)) throw new Error(`site.json appleTeamId must be 10 capital letters or digits, got "${config.appleTeamId}"`);
  if (config.appStoreId && !/^\d{6,12}$/.test(config.appStoreId)) throw new Error(`site.json appStoreId must be the numeric App Store id, got "${config.appStoreId}"`);
  for (const f of config.androidCertSha256) if (!SHA256_RE.test(f)) throw new Error(`site.json androidCertSha256 entries must be AB:CD:... (32 pairs), got "${f}"`);
  return config;
}

/** Empties the output folder but keeps `.vercel/` (the project link). */
function cleanOut() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const entry of fs.readdirSync(OUT)) {
    if (entry === '.vercel') continue;
    fs.rmSync(path.join(OUT, entry), { recursive: true, force: true });
  }
}

const SKIP = new Set(['_pages', 'site.json', 'README.md', 'apple-app-site-association', 'assetlinks.json']);

function copyStatic(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyStatic(a, b);
    else fs.copyFileSync(a, b);
  }
}

/** `<!-- key: value ... -->` at the top of a page body, and the body after it. */
function readPage(file) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n?/g, '\n');
  const m = /^<!--\n([\s\S]*?)\n-->\n/.exec(text);
  if (!m) throw new Error(`${path.relative(ROOT, file)} needs a <!-- title: ... --> header`);
  const meta = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (!meta.title || !meta.description) throw new Error(`${path.relative(ROOT, file)} needs a title and a description`);
  return { meta, body: text.slice(m[0].length) };
}

function storesHtml(config) {
  const buttons = [];
  if (config.appStoreId) buttons.push(`<a class="button" href="https://apps.apple.com/app/id${config.appStoreId}">Download on the App Store</a>`);
  if (config.playStoreLive) buttons.push(`<a class="button${buttons.length ? ' ghost' : ''}" href="${PLAY_URL}">Get it on Google Play</a>`);
  if (buttons.length === 0) return '<p class="soon">Coming soon to iPhone and Android. Free.</p>';
  return `${buttons.join('\n        ')}\n        <p class="soon">Free.</p>`;
}

const NAV = `<nav aria-label="Site">
          <a href="/support">Support</a>
          <a href="/privacy">Privacy</a>
          <a href="/terms">Terms</a>
        </nav>`;

function layout({ title, description, pathname, header, body }) {
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en" data-sky="day">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)}</title>
  <meta name="description" content="${escape(description)}">
  <link rel="canonical" href="${ORIGIN}${pathname}">
  <meta property="og:title" content="${escape(title)}">
  <meta property="og:description" content="${escape(description)}">
  <meta property="og:url" content="${ORIGIN}${pathname}">
  <meta property="og:image" content="${ORIGIN}/icon.png">
  <meta property="og:type" content="website">
  <meta name="theme-color" content="#0b3f73">
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="stylesheet" href="/site.css">
  <script src="/sky.js"></script>
</head>
<body>
  <header class="sky">
    <span class="disc" aria-hidden="true"></span>
    <div class="wrap">
      <div class="topbar">
        <a class="brand" href="/"><img src="/icon.png" alt="" width="36" height="36">RoadWise</a>
        ${NAV}
      </div>
${header}
    </div>
  </header>
${body.trimEnd()}
  <footer>
    <div class="wrap">
      <nav aria-label="Footer">
        <a href="/support">Support</a>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="/delete-account">Delete your account</a>
      </nav>
      <p>&copy; ${year} Julian Huang. Made in Washington State.</p>
    </div>
  </footer>
</body>
</html>
`;
}

function heroHeader(config) {
  return `      <div class="hero">
        <div class="hero-text">
          <h1>RoadWise</h1>
          <p class="lede">A free driving coach for new drivers. It records your drives on its own and shows you how to drive safer.</p>
          <div class="stores">
          ${storesHtml(config)}
          </div>
        </div>
        <figure class="shot hero-shot">
          <div class="phone hud" role="img" aria-label="The RoadWise driving screen: 33 miles per hour in a speed limit 35 zone">
            <div class="island" aria-hidden="true"></div>
            <div class="screen" aria-hidden="true">
              <svg class="hud-svg" viewBox="0 0 393 852" preserveAspectRatio="xMidYMid meet">
                <defs>
                  <filter id="hud-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="9"/></filter>
                </defs>
                <text class="hud-clock" x="58" y="40">7:42</text>
                <rect class="hud-plate" x="16" y="71" width="90" height="112" rx="5.4"/>
                <rect class="hud-plate-edge" x="19" y="74" width="84" height="106" rx="4"/>
                <text class="hud-legend" x="61" y="100">SPEED</text>
                <text class="hud-legend" x="61" y="120">LIMIT</text>
                <text class="hud-limit" x="61" y="170">35</text>
                <circle class="hud-face" cx="61" cy="236" r="28"/>
                <path class="hud-call" transform="translate(48 223) scale(1.08)" d="M6.6 3.5h2.6l1.4 4.1-2 1.5a12 12 0 006.3 6.3l1.5-2 4.1 1.4v2.6c0 1-.8 1.8-1.8 1.8A16.2 16.2 0 014.8 5.3c0-1 .8-1.8 1.8-1.8z"/>
                <circle class="hud-face" cx="329" cy="115" r="40"/>
                <path class="hud-nav" transform="translate(329 115) rotate(45) translate(-14 -16)" d="M14 0 L28 32 L14 24 L0 32Z"/>
                <text class="hud-caption" x="329" y="173">Navigate</text>
                <circle class="hud-glow" cx="196.5" cy="430.5" r="123.02" filter="url(#hud-glow)"/>
                <circle class="hud-ring" cx="196.5" cy="430.5" r="123.02" stroke-width="20"/>
                <g class="hud-ticks"><line x1="236.5" y1="281.2" x2="238.0" y2="275.7" stroke-width="1.5"/><line x1="273.8" y1="296.6" x2="276.6" y2="291.7" stroke-width="1.5"/><line x1="304.4" y1="322.6" x2="311.2" y2="315.8" stroke-width="2.5"/><line x1="330.4" y1="353.2" x2="335.3" y2="350.4" stroke-width="1.5"/><line x1="345.8" y1="390.5" x2="351.3" y2="389.0" stroke-width="1.5"/><line x1="345.8" y1="470.5" x2="351.3" y2="472.0" stroke-width="1.5"/><line x1="330.4" y1="507.8" x2="335.3" y2="510.6" stroke-width="1.5"/><line x1="304.4" y1="538.4" x2="311.2" y2="545.2" stroke-width="2.5"/><line x1="273.8" y1="564.4" x2="276.6" y2="569.3" stroke-width="1.5"/><line x1="236.5" y1="579.8" x2="238.0" y2="585.3" stroke-width="1.5"/><line x1="156.5" y1="579.8" x2="155.0" y2="585.3" stroke-width="1.5"/><line x1="119.2" y1="564.4" x2="116.4" y2="569.3" stroke-width="1.5"/><line x1="88.6" y1="538.4" x2="81.8" y2="545.2" stroke-width="2.5"/><line x1="62.6" y1="507.8" x2="57.7" y2="510.6" stroke-width="1.5"/><line x1="47.2" y1="470.5" x2="41.7" y2="472.0" stroke-width="1.5"/><line x1="47.2" y1="390.5" x2="41.7" y2="389.0" stroke-width="1.5"/><line x1="62.6" y1="353.2" x2="57.7" y2="350.4" stroke-width="1.5"/><line x1="88.6" y1="322.6" x2="81.8" y2="315.8" stroke-width="2.5"/><line x1="119.2" y1="296.6" x2="116.4" y2="291.7" stroke-width="1.5"/><line x1="156.5" y1="281.2" x2="155.0" y2="275.7" stroke-width="1.5"/></g>
                <text class="hud-n" x="196.5" y="279.9">N</text><text class="hud-cl" x="353.9" y="437.3">E</text><text class="hud-cl" x="196.5" y="594.7">S</text><text class="hud-cl" x="39.1" y="437.3">W</text>
                <path class="hud-mark" d="M196.5 281.9 L203.5 290.9 L189.5 290.9Z"/>
                <text class="hud-speed" x="196.5" y="485">33</text>
                <text class="hud-unit" x="196.5" y="514">mph</text>
                <text class="hud-not" x="196.5" y="698">Not driving?</text>
                <rect class="hud-face" x="16" y="726" width="361" height="76" rx="38"/>
                <circle class="hud-knob" cx="54" cy="764" r="31"/>
                <rect class="hud-stop" x="45" y="755" width="18" height="18" rx="3"/>
                <text class="hud-end" x="220" y="771">End drive</text>
              </svg>
            </div>
          </div>
        </figure>
      </div>`;
}

function titleHeader(heading, intro) {
  return `      <div class="page-title">
        <h1>${escape(heading)}</h1>
        ${intro ? `<p>${escape(intro)}</p>` : ''}
      </div>`;
}

function writePage(rel, html) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html, 'utf8');
}

function buildPages(config) {
  for (const name of fs.readdirSync(path.join(SRC, '_pages'))) {
    if (!name.endsWith('.html')) continue;
    const { meta, body } = readPage(path.join(SRC, '_pages', name));
    const slug = name.replace(/\.html$/, '');
    const isHome = slug === 'index';
    const header = meta.hero === 'true' ? heroHeader(config) : titleHeader(meta.heading ?? meta.title, meta.intro);
    const filled = body.replace(/\{\{stores\}\}/g, storesHtml(config));
    writePage(isHome ? 'index.html' : `${slug}/index.html`, layout({ title: meta.title, description: meta.description, pathname: isHome ? '/' : `/${slug}`, header, body: filled }));
  }
}

function buildLegal() {
  const docs = [
    { slug: 'privacy', file: 'privacy-policy', description: 'What RoadWise collects, how it is used and shared, how long it is kept, and your choices.' },
    { slug: 'terms', file: 'terms-of-service', description: 'The terms for using RoadWise.' },
  ];
  for (const doc of docs) {
    const src = path.join(LEGAL, `${doc.file}.md`);
    if (!fs.existsSync(src)) throw new Error(`missing ${path.relative(ROOT, src)}: the legal drafts live in legal/ (git-ignored) on the machine that writes them`);
    const blocks = parseMarkdown(fs.readFileSync(src, 'utf8').replace(/\r\n?/g, '\n'));
    const [first, ...rest] = blocks;
    if (!first || first.kind !== 'heading' || first.level !== 1) throw new Error(`${doc.file}.md must start with a # title`);
    const heading = first.text.replace(/^RoadWise\s+/, '');
    const body = `<main class="wrap">\n  <div class="prose">\n${bodyHtml(rest)}\n  </div>\n</main>\n`;
    writePage(`${doc.slug}/index.html`, layout({ title: `${heading} | RoadWise`, description: doc.description, pathname: `/${doc.slug}`, header: titleHeader(heading, ''), body }));
  }
}

function buildShareLinks(config) {
  // The share page: "Get RoadWise" goes to the App Store listing once there is one, else home.
  const page = path.join(OUT, 'w', 'index.html');
  const appStore = config.appStoreId ? `https://apps.apple.com/app/id${config.appStoreId}` : `${ORIGIN}/`;
  fs.writeFileSync(page, fs.readFileSync(page, 'utf8').replace('https://apps.apple.com/app/idAPP_STORE_ID', appStore), 'utf8');
  // Android: Google Play once the listing is public, home until then (open.js reads it from here).
  const openJs = path.join(OUT, 'w', 'open.js');
  const play = config.playStoreLive ? PLAY_URL : `${ORIGIN}/`;
  fs.writeFileSync(openJs, fs.readFileSync(openJs, 'utf8').replace(`'${PLAY_URL}'`, `'${play}'`), 'utf8');

  const wellKnown = path.join(OUT, '.well-known');
  fs.mkdirSync(wellKnown, { recursive: true });
  const notes = [];
  if (config.appleTeamId) {
    const aasa = JSON.parse(fs.readFileSync(path.join(SRC, '.well-known', 'apple-app-site-association'), 'utf8'));
    aasa.applinks.details[0].appIDs = [`${config.appleTeamId}.${BUNDLE_ID}`];
    fs.writeFileSync(path.join(wellKnown, 'apple-app-site-association'), JSON.stringify(aasa, null, 2) + '\n', 'utf8');
  } else notes.push('no appleTeamId in web/link-site/site.json: apple-app-site-association left out (share links open the web page on iPhone)');
  if (config.androidCertSha256.length > 0) {
    const links = JSON.parse(fs.readFileSync(path.join(SRC, '.well-known', 'assetlinks.json'), 'utf8'));
    links[0].target.sha256_cert_fingerprints = config.androidCertSha256;
    fs.writeFileSync(path.join(wellKnown, 'assetlinks.json'), JSON.stringify(links, null, 2) + '\n', 'utf8');
  } else notes.push('no androidCertSha256 in web/link-site/site.json: assetlinks.json left out (share links open the web page on Android)');
  if (fs.readdirSync(wellKnown).length === 0) fs.rmdirSync(wellKnown);
  return notes;
}

function writeVercelConfig() {
  const security = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
    {
      key: 'Content-Security-Policy',
      value: "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; script-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  ];
  const json = { key: 'Content-Type', value: 'application/json' };
  const config = {
    cleanUrls: true,
    trailingSlash: false,
    // cleanUrls serves w/index.html at /w: every /w/<id> answers with that page.
    rewrites: [{ source: '/w/:id', destination: '/w' }],
    redirects: [{ source: '/:path*', has: [{ type: 'host', value: 'www.getroadwise.app' }], destination: `${ORIGIN}/:path*`, permanent: true }],
    headers: [
      { source: '/(.*)', headers: security },
      { source: '/.well-known/apple-app-site-association', headers: [json] },
      { source: '/.well-known/assetlinks.json', headers: [json] },
      { source: '/fonts/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    ],
  };
  fs.writeFileSync(path.join(OUT, 'vercel.json'), JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function main() {
  const config = readConfig();
  cleanOut();
  copyStatic(SRC, OUT);
  buildPages(config);
  buildLegal();
  const notes = buildShareLinks(config);
  writeVercelConfig();
  fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nDisallow: /w/\n\nSitemap: ${ORIGIN}/sitemap.xml\n`, 'utf8');
  const urls = ['/', '/support', '/privacy', '/terms', '/delete-account'].map((p) => `  <url><loc>${ORIGIN}${p === '/' ? '/' : p}</loc></url>`).join('\n');
  fs.writeFileSync(path.join(OUT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`, 'utf8');
  console.log(`built ${path.relative(ROOT, OUT)}`);
  for (const n of notes) console.log(`note: ${n}`);

  if (process.argv.includes('--deploy')) {
    // shell: Windows runs the CLI through its .cmd shim.
    execFileSync('vercel', ['deploy', '--prod', '--yes'], { cwd: OUT, stdio: 'inherit', shell: process.platform === 'win32' });
  }
}

main();
