// Render a swing as PNG frames from golfer.html: node video.mjs <outdir> "<qs>" [w h]
// (dev server on :5230; one swiftshader browser). Then: ffmpeg -framerate 12 -i <outdir>/%03d.png ...
import { launch, open } from '../swing-check/pw.mjs';
const [out, qs, w = '300', h = '560'] = process.argv.slice(2);
const ease = x => x * x * (3 - 2 * x), frames = [];
for (let i = 0; i < 4; i++) frames.push({ phase: 'address', phi: 0 });
for (let i = 1; i <= 20; i++) frames.push({ phase: 'back', phi: 2.6 * ease(i / 20) });
for (let i = 1; i <= 8; i++) frames.push({ phase: 'down', phi: 2.6 * (1 - (i / 8) ** 1.6) });
for (let i = 1; i <= 16; i++) frames.push({ phase: 'follow', phi: -3.2 * (1 - (1 - i / 16) ** 2) });
for (let i = 0; i < 6; i++) frames.push({ phase: 'follow', phi: -3.2 });
const { browser, page } = await launch(+w, +h);
await open(page, `${qs}&pose=address&wait=300`);
for (const [i, s] of frames.entries()) {
  await page.evaluate(s => { window.__g.update({ topPhi: 2.6, idleT: 0, ...s }); window.__render(); }, s);
  await page.screenshot({ path: `${out}/${String(i).padStart(3, '0')}.png` });
}
await browser.close(); console.log('frames', frames.length);
