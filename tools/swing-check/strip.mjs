// render a strip of poses from one page load: node strip.mjs out.png "qs" pose1,pose2,... [w] [h]
// poses: address | b0.3 | d0.38 | f0.33 | held ; camera fixed by the view in qs (load pose = first pose)
import { launch, open } from './pw.mjs';
import { execFileSync } from 'child_process';
const [out, qs, list, w = '360', h = '640'] = process.argv.slice(2);
const poses = list.split(',');
const { browser, page } = await launch(+w, +h);
await open(page, `${qs}&pose=${poses[0] === 'held' ? 'finish' : /^(i|w)/.test(poses[0]) ? 'address' : poses[0]}&wait=300`);
const files = [];
for (const [i, ps] of poses.entries()) {
  await page.evaluate((ps) => {
    const mi = /^([iw])([\d.]+)$/.exec(ps);
    if (mi) { window.__g.update({ phase: 'address', phi: 0, topPhi: 2.6, idleT: mi[1] === 'w' ? +mi[2] : 0, ...(mi[1] === 'i' ? { intro: +mi[2] } : {}) }); window.__render(); return; }
    if (/^wb/.test(ps)) { const [t, f] = ps.slice(2).split('_').map(Number); window.__g.update({ phase: 'address', phi: 0, topPhi: 2.6, idleT: t }); window.__g.update({ phase: 'back', phi: 2.6 * f, topPhi: 2.6, idleT: t }); window.__render(); return; }
    const m = /^([bdf])([\d.]+)$/.exec(ps);
    const s = ps === 'address' ? { phase: 'address', phi: 0 } : ps === 'held' || ps === 'finish' ? { phase: 'follow', phi: -3.2 } : ps === 'top' ? { phase: 'back', phi: 2.6 } : ps === 'impact' ? { phase: 'down', phi: 0 }
      : m[1] === 'b' ? { phase: 'back', phi: 2.6 * +m[2] } : m[1] === 'd' ? { phase: 'down', phi: 2.6 * +m[2] } : { phase: 'follow', phi: -3.2 * +m[2] };
    window.__g.update({ topPhi: 2.6, idleT: 3.5, ...s }); window.__render();
  }, ps);
  const f = `${out}.${i}.png`; await page.screenshot({ path: f }); files.push(f);
}
await browser.close();
execFileSync('python3', ['-c', `
import sys
from PIL import Image, ImageDraw
fs=sys.argv[2:]; ims=[Image.open(f) for f in fs]
W=sum(i.width for i in ims); H=max(i.height for i in ims)
o=Image.new('RGB',(W,H+22),'white'); x=0
d=ImageDraw.Draw(o)
for f,i,l in zip(fs,ims,sys.argv[1].split(',')):
    o.paste(i,(x,22)); d.text((x+6,4),l,fill='black'); x+=i.width
o.save(fs[0].rsplit('.',2)[0])
import os
[os.remove(f) for f in fs]
`, list, ...files]);
console.log('wrote', out);
