// address face-on + DTL for driver, 7 iron, wedge side by side
import { launch, open } from './pw.mjs';
import { execFileSync } from 'child_process';
const { browser, page } = await launch(300, 460); const fs = [];
for (const view of ['face', 'dtl']) for (const [c, tee] of [[0, 0.037], [6, 0], [12, 0]]) {
  await open(page, `pose=address&club=${c}&tee=${tee}&view=${view}&wait=300`);
  await page.evaluate(() => { window.__g.update({ phase: 'address', phi: 0, topPhi: 2.6, idleT: 3.5 }); window.__render(); });
  const f = `shots/_a_${view}_${c}.png`; await page.screenshot({ path: f }); fs.push(f);
}
await browser.close();
execFileSync('python3', ['-c', `
import sys
from PIL import Image, ImageDraw
fs=sys.argv[1:]; o=Image.new('RGB',(900,940),'white'); d=ImageDraw.Draw(o)
for i,f in enumerate(fs):
    o.paste(Image.open(f),((i%3)*300,(i//3)*470+10)); d.text(((i%3)*300+6,(i//3)*470),['driver','7 iron','60 wedge'][i%3]+(' face-on' if i<3 else ' down the line'),fill='black')
o.save('shots/address_clubs.png')`, ...fs]);
console.log('shots/address_clubs.png');
