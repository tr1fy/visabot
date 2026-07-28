#!/usr/bin/env node
// Builds public/index.html + public/robots.txt from guide_template.html +
// bookmarklet.js.
//
// This script used to substitute the live TELEGRAM_BOT_TOKEN into the page.
// It no longer does, and must never do so again: the output is served publicly
// by Vercel, so baking the token in published it to the internet. The token now
// stays in the relay functions' server environment (api/*.js) and the browser
// only ever receives a per-user HMAC key minted by /api/enroll.
//
// Required env:
//   RELAY_URL  -- public origin of this deployment, e.g. https://visabot.vercel.app
//                 (falls back to VERCEL_PROJECT_PRODUCTION_URL / VERCEL_URL)
//
// The relay functions themselves need TELEGRAM_BOT_TOKEN set in the Vercel
// project's Environment Variables -- but at runtime, not at build time.

const fs = require('fs');
const path = require('path');

function resolveRelayUrl() {
  if (process.env.RELAY_URL) return process.env.RELAY_URL.replace(/\/+$/, '');
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  if (host) return `https://${host}`.replace(/\/+$/, '');
  return null;
}

const relayUrl = resolveRelayUrl();
if (!relayUrl) {
  console.error(
    "RELAY_URL is not set and no Vercel URL was available -- refusing to build.\n" +
      "Set RELAY_URL to this deployment's public origin, e.g.\n" +
      '  RELAY_URL=https://visabot-nine.vercel.app node build_guide.js',
  );
  process.exit(1);
}

if (process.env.TELEGRAM_BOT_TOKEN) {
  console.warn(
    'note: TELEGRAM_BOT_TOKEN is set but is NOT used by this build -- that is intentional.\n' +
      '      It is read at runtime by api/*.js. Nothing secret goes into public/.',
  );
}

const jsPath = path.join(__dirname, 'bookmarklet.js');
const templatePath = path.join(__dirname, 'guide_template.html');
const outDir = path.join(__dirname, 'public');

const lines = fs.readFileSync(jsPath, 'utf8').split('\n');
const startIdx = lines.findIndex((l) => l.startsWith('(function'));
if (startIdx === -1) throw new Error('could not find bookmarklet body start in bookmarklet.js');

const minified = lines
  .slice(startIdx)
  .map((l) => l.replace(/^\s+/, ''))
  .join('\n')
  .split('__RELAY_URL__')
  .join(relayUrl);

// __CHAT_ID__ and __USER_KEY__ stay as placeholders: the guide page fills them
// in per visitor, after /api/enroll has verified they control that chat.
if (minified.includes('__BOT_TOKEN__')) {
  throw new Error('__BOT_TOKEN__ is still referenced in bookmarklet.js -- refusing to build');
}

const template = fs.readFileSync(templatePath, 'utf8');
const injected = template
  .replace('__BOOKMARKLET_SOURCE_JSON__', JSON.stringify(minified))
  .split('__RELAY_URL__')
  .join(relayUrl);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), injected, 'utf8');
fs.writeFileSync(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');

console.log(`wrote ${path.join(outDir, 'index.html')} (${injected.length} chars), relay ${relayUrl}`);
