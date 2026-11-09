"""Inline the portrait renders (bg/*.jpg) into index.html as data URIs → board.html (the artifact file).
Refresh the renders first with: npx vite --port 5201 --strictPort  (repo root), then node shoot.cjs."""
import base64, pathlib
here = pathlib.Path(__file__).resolve().parent
html = (here / 'index.html').read_text()
for jpg in sorted((here / 'bg').glob('*.jpg')):
    uri = 'data:image/jpeg;base64,' + base64.b64encode(jpg.read_bytes()).decode()
    html = html.replace(f'bg/{jpg.name}', uri)
(here / 'board.html').write_text(html)
print('board.html', round((here / 'board.html').stat().st_size / 1e6, 2), 'MB')
