// shared Playwright launcher: one swiftshader browser, generous timeouts
import { createRequire } from 'module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
export const SWING = process.env.SWING ?? "keyed";
export const BASE = "http://localhost:5230/golfer.html";
export async function launch(w = 540, h = 960) {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  page.setDefaultTimeout(240000);
  page.on('pageerror', e => console.error('PAGEERR', e.message));
  page.on('console', m => { if (m.type() === 'error' && !m.text().includes('404')) console.error('CONSOLE', m.text()); else if (m.type() === 'log') console.log('LOG', m.text()); });
  // no HMR: other agents edit the tree and a reload would kill a capture mid-run
  await page.route('**/@vite/client', r => r.fulfill({ contentType: 'application/javascript', body: 'export function createHotContext(){return {accept(){},acceptExports(){},dispose(){},prune(){},invalidate(){},on(){},off(){},send(){},data:{}}}; export function updateStyle(){} export function removeStyle(){} export function injectQuery(u){return u} export class ErrorOverlay{}' }));
  return { browser, page };
}
export async function open(page, qs) {
  await page.goto(`${BASE}?swing=${SWING}&${qs}`, { timeout: 240000 });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 240000, polling: 500 });
}
