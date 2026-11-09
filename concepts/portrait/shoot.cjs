// node shoot.cjs [shot ...] → renders shots into bg/*.jpg (780×1688). Needs `npx vite --port 5201 --strictPort` running at the repo root.
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');
(async () => {
  const shots = process.argv.slice(2).length ? process.argv.slice(2) : ['address', 'top', 'finish', 'flight', 'landing'];
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const s of shots) {
    const p = await b.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
    p.on('pageerror', e => console.log('ERR', s, e.message));
    await p.goto(`http://localhost:5201/concepts/portrait/shots.html?shot=${s}&pr=2`, { timeout: 300000 });
    await p.waitForFunction(() => window.__ready === true, null, { timeout: 600000, polling: 1000 });
    const url = await p.evaluate(() => document.querySelector('canvas').toDataURL('image/jpeg', 0.82));
    fs.writeFileSync(path.join(__dirname, 'bg', s + '.jpg'), Buffer.from(url.split(',')[1], 'base64'));
    console.log('shot', s);
    await p.close();
  }
  await b.close();
})();
