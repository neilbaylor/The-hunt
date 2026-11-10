import { launch, open } from './pw.mjs';
const { browser, page } = await launch(320, 480);
await open(page, `pose=address&club=${process.argv[2]??6}&wait=200&view=face&${process.argv[4] ?? ""}`);
const r = await page.evaluate((code) => eval(code), process.argv[3]);
console.log(typeof r === 'string' ? r : JSON.stringify(r, null, 1));
await browser.close();
