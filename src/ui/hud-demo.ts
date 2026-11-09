// Dev page for the HUD alone, over a still render: /src/ui/hud-demo.html?bg=address|top|finish|flight|landing
// window.demo.* drives the states so the HUD can be checked without the 3D game.
import { Hud, type CardData } from './hud';
import { NEIL } from '../golfer/profile';
import type { ShotPlan } from '../game/shot';

const q = new URLSearchParams(location.search);
const bg = (n: string) => { document.getElementById('bg')!.style.backgroundImage = `url(/concepts/portrait/bg/${n}.jpg)`; };
bg(q.get('bg') ?? 'address');
const hud = new Hud(document.body, NEIL);
hud.render(null);
const plan = (word: ShotPlan['tempoWord'], cls: ShotPlan['tempoCls']): ShotPlan => ({
  launch: { speed: 50, launch: 0.3, azimuth: 0, spinRpm: 6000, tilt: 0 }, targetCarryYds: 160,
  tempoWord: word, tempoCls: cls, driftWord: 'Straight', driftCls: 'good', shape: 'Draw', shapeWord: 'Draw', why: 'Draw · pushed 5° left', error: 0,
});
let card: CardData | null = null;
const trail: [number, number][] = Array.from({ length: 12 }, (_, i) => [i * 0.3, i * 6.5]);
(window as any).demo = {
  hud,
  address() { bg('address'); hud.setState(true, false, !card); hud.setPad([0, 0], [], [], false); },
  top() { bg('top'); hud.setState(false, false, !card); hud.setPad([3, 72], trail, [], true); },
  strike(word: ShotPlan['tempoWord'] = 'Perfect', cls: ShotPlan['tempoCls'] = 'good') {
    bg('flight'); card = { plan: plan(word, cls), power: 0.92, offMs: cls === 'good' ? 40 : 260, done: false };
    hud.card(card); hud.toast(word, plan(word, cls).why, cls); hud.showSpin(true); hud.setState(false, true, false);
    hud.setPad([0, 0], trail, [[3, 72], [1, 30], [-2, -10], [-4, -50]], false);
  },
  landed() { bg('landing'); if (card) { card.carry = 158; card.apex = 31; hud.card(card); } hud.spinDone(); hud.setState(false, false, false); },
  result(green = true) {
    if (card) { Object.assign(card, { done: true, carry: 158, total: 163, offline: -3 }); hud.card(card); }
    hud.toast(green ? 'Green!' : '163 yds', green ? 'On the 150 green · 6 yds from the pin' : '163 yds · 3 left', green ? 'good' : 'warn');
  },
  club() { (document.querySelector('[data-act=club]') as HTMLElement).click(); },
  mode() { (document.querySelector('[data-act=mode]') as HTMLElement).click(); },
  spin(x: number, y: number) { hud.spin = { x, y }; },
};
let last = performance.now();
const loop = (t: number) => { hud.tickSpin((t - last) / 1000, true); last = t; requestAnimationFrame(loop); };
requestAnimationFrame(loop);
(window as any).__ready = true;

// ?intro: the real intro (styles pulled from index.html, markup as main.ts builds it)
if (q.has('intro')) {
  const html = await fetch('/index.html').then(r => r.text());
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const intro = document.createElement('div'); intro.className = 'intro';
  intro.innerHTML = `<span class="brand"><i class="crest" aria-hidden="true"></i><b>The Hunt</b></span><div class="intro-card">
  <span class="kick">Player 1</span><h1>${NEIL.name}</h1>
  <span class="tap">Tap anywhere to start</span></div>`;
  intro.dataset.nameStyle = q.get('name') ?? 'c';
  document.body.appendChild(intro); hud.el.classList.add('hidden');
}
