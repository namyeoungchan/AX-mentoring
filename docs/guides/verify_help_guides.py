"""Check every role-specific PDF and render review pages (PyMuPDF required)."""
from pathlib import Path
import json
import fitz

assets = Path(__file__).resolve().parents[2] / 'lms-web' / 'server' / 'help-assets'
output = Path(__file__).resolve().parent / 'output'
checks = []
for entry in json.loads((assets / 'capture-manifest.json').read_text(encoding='utf-8')):
    path = assets / (entry['id'] + '.pdf')
    doc = fitz.open(path)
    assert len(doc) == 2, (path, len(doc))
    text = ''.join(page.get_text() for page in doc)
    assert '실제 LMS 화면' in text and '사용 순서' in text, path
    assert '\ufffd' not in text, path
    fonts = {font[0] for page in doc for font in page.get_fonts()}
    assert fonts and all(doc.extract_font(xref)[3] for xref in fonts), path
    for page in doc:
        assert abs(page.rect.width - 841.89) < 2 and abs(page.rect.height - 595.28) < 2, path
        for block in page.get_text('blocks'):
            assert block[0] >= 0 and block[2] <= page.rect.width and block[3] <= page.rect.height, (path, block)
    if entry['id'] in ['admin-attendance', 'main-attendance', 'group-mentoring', 'student-assignments']:
        for i, page in enumerate(doc):
            page.get_pixmap(matrix=fitz.Matrix(1.3, 1.3)).save(output / f"help-review-{entry['id']}-{i + 1}.png")
    checks.append({'id': entry['id'], 'pages': len(doc), 'embeddedFonts': len(fonts), 'textCharacters': len(text), 'bytes': path.stat().st_size})
(assets / 'pdf-checks.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'guides': len(checks), 'pages': sum(x['pages'] for x in checks), 'totalPdfBytes': sum(x['bytes'] for x in checks)}))
