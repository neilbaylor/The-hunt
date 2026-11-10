// node shot.mjs out.png "qs" [w h]: one frame
import { launch, open } from './pw.mjs';
const [out, qs, w = '400', h = '600'] = process.argv.slice(2);
const { browser, page } = await launch(+w, +h);
await open(page, qs + '&wait=300'); await page.screenshot({ path: out }); await browser.close(); console.log('wrote', out);
