import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('dist/client');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const urls = [...html.matchAll(/(?:src|href)="(\/qr-code-xp\/[^"?#]+)(?:[^"\s]*)"/g)]
  .map((match) => match[1]);
if (!urls.some((url) => url.endsWith('.css')) || !urls.some((url) => url.endsWith('.js'))) {
  throw new Error('Static homepage must reference CSS and JavaScript.');
}
for (const url of new Set(urls)) {
  if (!existsSync(resolve(root, url.slice('/qr-code-xp/'.length)))) {
    throw new Error(`Missing Pages resource: ${url}`);
  }
}
console.log('Homepage CSS, JavaScript and image paths verified.');
