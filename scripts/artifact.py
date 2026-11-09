"""Turn the single-file build (dist-single/index.html) into a page fragment for a claude.ai artifact:
no <html>/<head>/<body>, and the module script moved after #app. Writes range-day.html."""
import pathlib, re
root = pathlib.Path(__file__).resolve().parent.parent
s = (root / 'dist-single/index.html').read_text()
head = s[s.index('<head>') + 6:s.rindex('</head>')]
body = s[s.rindex('<body>') + 6:s.rindex('</body>')]
head = re.sub(r'<meta charset[^>]*>\s*', '', head, count=1)
head = re.sub(r'<meta name="viewport"[^>]*>\s*', '', head, count=1)
scripts = re.findall(r'<script type="module"[^>]*>[\s\S]*?</script>', head)
for sc in scripts:
    head = head.replace(sc, '')
(root / 'range-day.html').write_text(head.strip() + '\n' + body.strip() + '\n' + '\n'.join(scripts) + '\n')
print('range-day.html', (root / 'range-day.html').stat().st_size // 1024, 'KB')
