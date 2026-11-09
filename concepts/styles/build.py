"""Build concepts/styles/board.html (artifact page fragment) from rendered style images.
   python3 concepts/styles/build.py <image dir>   (expects e-face-address-sN.jpg, e-portrait-address-sN.jpg, e-portrait-finish-sN.jpg)"""
import base64, io, os, sys
from PIL import Image
src = sys.argv[1]
here = os.path.dirname(os.path.abspath(__file__))
STYLES = [  # (id, name, description, what it hides, simplification 0-5), in board order: the picks first
  (0, 'Realistic (today)', 'The game as it renders now: tone-mapped and graded, no illustration.', 'Nothing. Every texture and modelling flaw shows.', 0),
  (7, 'Graphic Realism · Light', 'The realistic render with a light hand-drawn finish: fine ink contours that swell and taper, a little hatching in the deepest shadows, faint paper grain.', 'Blotchy fabric shading and texture noise; edges read cleaner. The face stays photographic.', 2),
  (8, 'Graphic Realism · Medium', 'Pushed further: stronger contours and interior lines, cross-hatching in shadows, crisper highlights, visible paper.', 'Most fabric and turf texture flaws and some modelling softness. The face reads as a drawn portrait.', 3),
  (5, 'Graphic Novel', 'High-contrast colour, heavy cross-hatching in shadows and thick ink contours.', 'Shadow noise and flat cloth; hatching adds form. Strongest drawn look of the realistic family.', 3),
  (6, 'Cover Art', 'Sports-game cover illustration: flat saturated colour in a few clean bands, black contours and a bright rim.', 'Almost all texture; the face reads from its big features (hair, nose, jaw, smile).', 4),
  (1, 'Ink & Wash', 'A transparent watercolour wash over bold brown ink lines, colour floating slightly off the line work, cold-press paper.', 'Skin and fabric texture, small seams, turf tiling.', 3),
  (2, 'Painterly', 'Big oil-paint strokes following the forms, canvas weave, a crisp edge on the golfer.', 'Nearly all surface detail: cloth weave, hair strands, grass noise.', 4),
  (3, 'Sports Poster', 'Flat cel bands, heavy navy outlines and big halftone dots in the shadows.', 'Texture detail and small shape errors.', 4),
  (4, 'Gouache', 'Opaque paint in four values, visible brush direction, a warm palette and paint-tinted outlines.', 'Most texture and lighting noise; the face becomes a few planes of colour.', 4),
]
def uri(path, w):
    im = Image.open(path).convert('RGB'); im.thumbnail((w, 4000))
    b = io.BytesIO(); im.save(b, 'JPEG', quality=80); return 'data:image/jpeg;base64,' + base64.b64encode(b.getvalue()).decode()
cards = []
for idx, (sid, name, desc, hides, simp) in enumerate(STYLES):
    face = uri(f'{src}/e-face-address-s{sid}.jpg', 700)
    a = uri(f'{src}/e-portrait-address-s{sid}.jpg', 560)
    f = uri(f'{src}/e-portrait-finish-s{sid}.jpg', 560)
    dots = ''.join(f'<i class="{"on" if k < simp else ""}"></i>' for k in range(5))
    cards.append(f'''<article class="style" id="s{sid}">
  <header><span class="num">{idx}</span><div><h2>{name}</h2><p>{desc}</p></div></header>
  <div class="frames">
    <figure class="face"><img src="{face}" alt="{name}: Neil's face, front three-quarter"><figcaption>Face</figcaption></figure>
    <figure><img src="{a}" alt="{name}: address in the portrait swing camera"><figcaption>Address · swing cam</figcaption></figure>
    <figure><img src="{f}" alt="{name}: finish"><figcaption>Finish</figcaption></figure>
  </div>
  <dl><div><dt>What it hides</dt><dd>{hides}</dd></div><div><dt>How much simpler the art gets</dt><dd><span class="dots" aria-label="{simp} of 5">{dots}</span></dd></div></dl>
</article>''')
html = '''<title>Hand-Drawn Style Lab</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700&display=swap">
<style>
/* Layout: one column of style cards; each card shows the portrait game frame at address, the finish and a close-up. Dark-first, clubhouse navy with flag yellow. */
:root { --bg: #0f1a2b; --card: #17243a; --line: #263753; --fg: #f4efe3; --muted: #a9b5c9; --flag: #f2c21b; --display: 'Fredoka', 'Arial Rounded MT Bold', system-ui, sans-serif; --body: 'Nunito', system-ui, sans-serif; color-scheme: dark; }
@media (prefers-color-scheme: light) { :root:not([data-theme="dark"]) { --bg: #f5f1e6; --card: #fffdf7; --line: #e2dccb; --fg: #182338; --muted: #5d6779; --flag: #b8890a; color-scheme: light; } }
:root[data-theme="light"] { --bg: #f5f1e6; --card: #fffdf7; --line: #e2dccb; --fg: #182338; --muted: #5d6779; --flag: #b8890a; color-scheme: light; }
body { background: var(--bg); color: var(--fg); font: 16px/1.5 var(--body); }
.wrap { max-width: 1100px; margin: 0 auto; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-block: 28px 56px; display: grid; gap: 22px; }
.kicker { font: 600 13px var(--display); letter-spacing: .14em; text-transform: uppercase; color: var(--flag); }
h1 { margin: 0; font: 700 clamp(34px, 7vw, 56px)/1 var(--display); text-wrap: balance; }
.lede { margin: 0; color: var(--muted); max-width: 64ch; }
.style { background: var(--card); border: 1px solid var(--line); border-radius: 18px; padding: 16px; display: grid; gap: 14px; min-width: 0; }
.style header { display: flex; gap: 12px; align-items: flex-start; }
.num { flex: none; width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: var(--flag); color: #182338; font: 700 18px var(--display); }
h2 { margin: 0; font: 600 24px/1.1 var(--display); }
.style p { margin: 4px 0 0; color: var(--muted); font-size: 15px; }
.frames { display: grid; grid-template-columns: 1.6fr 1fr 1fr; gap: 10px; align-items: start; }
figure { margin: 0; display: grid; gap: 4px; min-width: 0; }
figure img { width: 100%; height: auto; border-radius: 10px; display: block; }
figcaption { font: 600 12px var(--display); letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
dl { margin: 0; display: grid; grid-template-columns: 2fr 1fr; gap: 12px; }
dt { font: 600 12px var(--display); letter-spacing: .08em; text-transform: uppercase; color: var(--flag); }
dd { margin: 2px 0 0; font-size: 15px; }
.dots { display: inline-flex; gap: 5px; margin-top: 4px; } .dots i { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--flag); } .dots i.on { background: var(--flag); }
@media (max-width: 560px) { .frames { grid-template-columns: repeat(2, minmax(0, 1fr)); } .frames figure.face { grid-column: 1 / -1; } dl { grid-template-columns: 1fr; } }
</style>
<div class="wrap">
  <header><div class="kicker">The Hunt · art direction</div><h1>Hand-drawn style lab</h1>
  <p class="lede">His face first (front three-quarter, friendly expression), then the portrait swing camera at address and at the finish. Same golfer, range and lighting throughout: each finish is a post-process over the realistic render, so proportions and swing stay real. Frames are the portrait swing camera on a phone. More dots means the finish hides more of the procedural texture and modelling, so the art needs less detail to look good.</p></header>
''' + '\n'.join(cards) + '\n</div>\n'
open(os.path.join(here, 'board.html'), 'w').write(html)
print('board.html', os.path.getsize(os.path.join(here, 'board.html')) // 1024, 'KB')
