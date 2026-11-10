"""Build the hand-drawn finish options board from real-game frames rendered by the option-board script.
   python3 concepts/styles/options.py <frames dir> <face box intro x,y,w,h in 390-wide coords> <head-and-shoulders box intro x,y,w,h>
Writes concepts/styles/options.html (artifact page fragment) and <frames dir>/options-sheet.jpg."""
import base64, io, os, sys
from PIL import Image, ImageDraw
src = sys.argv[1]
fi = [int(v) for v in sys.argv[2].split(',')]
ff = [int(v) for v in sys.argv[3].split(',')]
here = os.path.dirname(os.path.abspath(__file__))
V = [
  ('none', 'Real', 'Today\'s plain render, for comparison.'),
  ('soft', 'Polished (new default)', 'Gentle edge-preserving paint smoothing that hides CG flaws, soft specular roll-off, a touch of warmth. No lines, no hatching.'),
  ('painterly', 'Painterly light', 'Edge-preserving paint smoothing, soft brush texture in flat areas, a faint silhouette line.'),
  ('gouache', 'Gouache', 'Flatter value bands, matte chalky finish, warm shadows, no lines. Illustrated golf poster.'),
  ('inkwash', 'Ink + wash', 'Faint warm ink silhouette over a soft watercolour wash, paper edges darkening.'),
  ('pencil', 'Coloured-pencil whisper', 'Style 9 at about a quarter: pencil grain only in the shadows, light contour.'),
  ('graphic', 'Graphic realism', 'Crisp silhouettes, slightly posterised shadows, bold rim light. Broadcast illustration.'),
  ('dream', 'Soft-focus painterly', 'Dreamy golden-hour paint: glow on the lights, warm haze, gentle strokes.'),
]
FR = [('intro', 'Intro'), ('address', 'Address'), ('landing', 'Course')]
def img(name): return Image.open(f'{src}/{name}.png').convert('RGB')
def crop(im, box):
    k = im.width / 390; x, y, w, h = box
    return im.crop((int(x * k), int(y * k), int((x + w) * k), int((y + h) * k)))
def uri(im, w):
    im = im.copy(); im.thumbnail((w, 4000)); b = io.BytesIO(); im.save(b, 'JPEG', quality=80)
    return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()
# contact sheet
CW, CH, FW = 260, 563, 260
sheet = Image.new('RGB', (len(FR) * (CW + 6) + 2 * (FW + 6) + 170, len(V) * (CH + 6) + 6), (15, 26, 43))
d = ImageDraw.Draw(sheet)
cards = []
for r, (key, name, desc) in enumerate(V):
    y = 6 + r * (CH + 6); d.text((8, y + 8), name, fill=(242, 194, 27))
    x = 170
    for f, _ in FR:
        sheet.paste(img(f'{f}-{key}').resize((CW, CH)), (x, y)); x += CW + 6
    for f, box in (('intro', fi), ('intro', ff)):
        fc = crop(img(f'{f}-{key}'), box).resize((FW, int(FW * box[3] / box[2])))
        sheet.paste(fc, (x, y)); x += FW + 6
    figs = ''.join(f'<figure><img src="{uri(img(f"{f}-{key}"), 520)}" alt="{name}: {lab}"><figcaption>{lab}</figcaption></figure>' for f, lab in FR)
    faces = ''.join(f'<figure class="face"><img src="{uri(crop(img(f"{f}-{key}"), box), 520)}" alt="{name}: face, {lab}"><figcaption>Face · {lab}</figcaption></figure>' for f, box, lab in (('intro', fi, 'close'), ('intro', ff, 'head & shoulders')))
    tag = '<code>?style=real</code>' if key == 'none' else ('<code>default</code>' if key == 'soft' else f'<code>?style={key}</code>')
    cards.append(f'<article class="v{" real" if key == "none" else ""}"><header><h2>{name}</h2>{tag}<p>{desc}</p></header><div class="faces">{faces}</div><div class="frames">{figs}</div></article>')
sheet.save(f'{src}/options-sheet.jpg', quality=82)
html = '''<title>Hand-Drawn Finish Options</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700&display=swap">
<style>
/* One card per finish: two face crops first (where the band-aid matters most), then the same three real-game frames. */
:root { --bg: #0f1a2b; --card: #17243a; --line: #263753; --fg: #f4efe3; --muted: #a9b5c9; --flag: #f2c21b; --display: 'Fredoka', system-ui, sans-serif; --body: 'Nunito', system-ui, sans-serif; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --bg: #f5f1e6; --card: #fffdf7; --line: #e2dccb; --fg: #182338; --muted: #5d6779; --flag: #b8890a; color-scheme: light; } }
:root[data-theme="light"] { --bg: #f5f1e6; --card: #fffdf7; --line: #e2dccb; --fg: #182338; --muted: #5d6779; --flag: #b8890a; color-scheme: light; }
body { background: var(--bg); color: var(--fg); font: 16px/1.5 var(--body); }
.wrap { max-width: 1100px; margin: 0 auto; padding: 28px max(16px, env(safe-area-inset-right, 0px)) 56px max(16px, env(safe-area-inset-left, 0px)); display: grid; gap: 18px; }
.kicker { font: 600 13px var(--display); letter-spacing: .14em; text-transform: uppercase; color: var(--flag); }
h1 { margin: 0; font: 700 clamp(32px, 7vw, 52px)/1.02 var(--display); text-wrap: balance; }
.lede { margin: 0; color: var(--muted); max-width: 66ch; }
.v { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 16px; display: grid; gap: 12px; min-width: 0; }
.v.real { border-style: dashed; }
.v header { display: grid; gap: 2px; }
h2 { margin: 0; font: 600 24px/1.1 var(--display); }
code { justify-self: start; font: 600 13px ui-monospace, monospace; color: var(--flag); }
.v p { margin: 0; color: var(--muted); font-size: 15px; }
.faces { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.frames { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
figure { margin: 0; display: grid; gap: 4px; min-width: 0; }
figure img { width: 100%; height: auto; border-radius: 10px; display: block; }
figcaption { font: 600 11px var(--display); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
</style>
<div class="wrap"><header><div class="kicker">The Hunt · finish options</div><h1>Hand-drawn finish options</h1>
<p class="lede">A band-aid that also looks cool: each finish is a post-process over the real game, meant to make the realism gaps (plastic skin, likeness, stiff hands, CG cloth, low-poly trees) forgivable without going cartoon. Same frozen game frames for every option, rendered at phone size (390×844, 2×). Try any of them in the game with <code>?style=…</code>; <code>?style=real</code> turns the finish off.</p></header>
''' + '\n'.join(cards) + '\n</div>\n'
open(os.path.join(here, 'options.html'), 'w').write(html)
print('options.html', os.path.getsize(os.path.join(here, 'options.html')) // 1024, 'KB')
