#!/usr/bin/env node
// Builds public/index.html + public/robots.txt from guide_template.html +
// bookmarklet.js, substituting the live bot token from the TELEGRAM_BOT_TOKEN
// environment variable -- never from a committed file. This is the script
// Vercel runs as the Build Command; set TELEGRAM_BOT_TOKEN in the project's
// Environment Variables (Production + Preview) before deploying.
//
// For local builds, export TELEGRAM_BOT_TOKEN yourself first, e.g.:
//   TELEGRAM_BOT_TOKEN=$(grep bot_token config.ini | cut -d= -f2 | tr -d ' ') node build_guide.js

const fs = require('fs');
const path = require('path');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN is not set -- refusing to build without it.');
  process.exit(1);
}

const jsPath = path.join(__dirname, 'bookmarklet.js');
const templatePath = path.join(__dirname, 'guide_template.html');
const outDir = path.join(__dirname, 'public');

const lines = fs.readFileSync(jsPath, 'utf8').split('\n');
const startIdx = lines.findIndex((l) => l.startsWith('(function'));
if (startIdx === -1) throw new Error('could not find bookmarklet body start in bookmarklet.js');
const body = lines.slice(startIdx).join('\n');
const minified = body
  .split('\n')
  .map((l) => l.replace(/^\s+/, ''))
  .join('\n')
  .split('__BOT_TOKEN__')
  .join(token);

const template = fs.readFileSync(templatePath, 'utf8');
const injected = template.replace('__BOOKMARKLET_SOURCE_JSON__', JSON.stringify(minified));

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'index.html'), injected, 'utf8');
fs.writeFileSync(path.join(outDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n', 'utf8');

console.log(`wrote ${path.join(outDir, 'index.html')} (${injected.length} chars)`);
