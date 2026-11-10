"""Five-view before/after sheet: real (?style=real) vs the default finish, from the option-board frames.
   python3 concepts/styles/beforeafter.py <frames dir>   -> <frames dir>/default-vs-real.jpg"""
import os, sys
from PIL import Image, ImageDraw
src = sys.argv[1]
V = ['intro', 'address', 'aim', 'flight', 'landing']
W, H, G = 390, 844, 8
c = Image.new('RGB', (5 * W + 6 * G, 2 * H + 3 * G + 44), (15, 26, 43)); d = ImageDraw.Draw(c)
for r, (key, lab) in enumerate((('none', 'BEFORE  ?style=real'), ('soft', 'AFTER  default finish (soft)'))):
    y = G + 22 + r * (H + G + 22); d.text((G, y - 18), lab, fill=(242, 194, 27))
    for i, v in enumerate(V):
        f = f'{src}/{v}-{key}.png'
        if os.path.exists(f): c.paste(Image.open(f).convert('RGB').resize((W, H), Image.LANCZOS), (G + i * (W + G), y))
c.save(f'{src}/default-vs-real.jpg', quality=86); print(f'{src}/default-vs-real.jpg')
