"""Check every role-specific PDF and render review pages (PyMuPDF required)."""
from pathlib import Path
import json
import pymupdf as fitz
from PIL import Image

assets = Path(__file__).resolve().parents[2] / 'lms-web' / 'server' / 'help-assets'
output = Path(__file__).resolve().parent / 'output'
checks = []
manifest = json.loads((assets / 'capture-manifest.json').read_text(encoding='utf-8'))
assert len({entry['id'] for entry in manifest}) == len(manifest), 'Duplicate guide IDs'
for entry in manifest:
    path = assets / (entry['id'] + '.pdf')
    doc = fitz.open(path)
    assert len(doc) == len(entry['steps']), (path, len(doc))
    text = ''.join(page.get_text() for page in doc)
    assert '사용 순서' in text, path
    assert '\ufffd' not in text, path
    fonts = {font[0]: font[2] for page in doc for font in page.get_fonts()}
    # Chromium embeds emoji as Type3 glyph programs rather than a font-file stream.
    assert fonts and all(doc.xref_get_key(xref, 'CharProcs')[0] in ('dict', 'xref') if kind == 'Type3' else doc.extract_font(xref)[3] for xref, kind in fonts.items()), path
    for i, page in enumerate(doc):
        step = entry['steps'][i]
        if step.get('imageAvailable') is False:
            assert '실제 화면 캡처 준비 중' in page.get_text(), (path, i)
        else:
            surface = step.get('surface', 'LMS')
            assert f'실제 {surface} 화면' in page.get_text(), (path, i)
            image = Image.open(assets / f"{entry['id']}-step-{i + 1}.jpg").convert('RGB')
            size = step.get('size', {'width': 1440, 'height': 1000})
            assert image.size == (size['width'], size['height']), (path, i)
            # The numbered orange border must actually be present in every screenshot.
            assert sum(count for count, (r, g, b) in image.getcolors(image.width * image.height) if r > 150 and 35 < g < 110 and b < 60 and r > g * 1.7) > 500, (path, i)
        assert abs(page.rect.width - 841.89) < 2 and abs(page.rect.height - 595.28) < 2, path
        for block in page.get_text('blocks'):
            assert block[0] >= 0 and block[2] <= page.rect.width and block[3] <= page.rect.height, (path, block)
    if entry['id'] in ['admin-attendance', 'main-attendance', 'group-mentoring', 'student-assignments']:
        for i, page in enumerate(doc):
            page.get_pixmap(matrix=fitz.Matrix(1.3, 1.3)).save(output / f"help-review-{entry['id']}-{i + 1}.png")
    checks.append({'id': entry['id'], 'pages': len(doc), 'embeddedFonts': len(fonts), 'textCharacters': len(text), 'bytes': path.stat().st_size})
(assets / 'pdf-checks.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'guides': len(checks), 'pages': sum(x['pages'] for x in checks), 'totalPdfBytes': sum(x['bytes'] for x in checks)}))
