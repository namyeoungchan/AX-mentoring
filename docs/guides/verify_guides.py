"""Verify printable PDFs and build the combined handout and review previews."""
from pathlib import Path
import json
from shutil import copyfile
import pymupdf
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parent / 'output'
guides = [('admin-guide', '워크스페이스 관리자'), ('mentor-guide', '멘토'), ('student-guide', '학생')]
combined = pymupdf.open()
toc, checks, previews = [], [], []
for name, role in guides:
    doc = pymupdf.open(root / (name + '.pdf'))
    assert len(doc) == 3, (name, len(doc))
    toc.append([1, role, len(combined) + 1])
    text = ''.join(page.get_text() for page in doc)
    assert role in text and '\ufffd' not in text and '\u25a1' not in text
    assert 'Discord' in text
    assert '/출석' in text and '2026.09.18' in text
    font_ids = {font[0] for page in doc for font in page.get_fonts()}
    # Chrome embeds Apple Korean glyphs as Type 3 CharProcs.
    assert all(doc.extract_font(xref)[3] or doc.xref_get_key(xref, 'CharProcs')[0] in ('dict', 'xref') for xref in font_ids), 'Missing embedded glyphs'
    links = [link for page in doc for link in page.get_links() if link.get('uri')]
    assert any(link['uri'].startswith('https://ax-learningops-web.onrender.com') for link in links)
    for i, page in enumerate(doc):
        assert abs(page.rect.width - 595.28) < 2 and abs(page.rect.height - 841.89) < 2
        pix = page.get_pixmap(matrix=pymupdf.Matrix(1.4, 1.4))
        preview = root / f'{name}-{i+1}.png'
        pix.save(preview)
        previews.append((preview, f'{role} {i+1}/3'))
    if name == 'student-guide':
        assert '초기 비밀번호' in text and '가입 없이' in text
    checks.append({'file': name + '.pdf', 'pages': len(doc), 'embeddedFonts': len(font_ids), 'links': len(links), 'textCharacters': len(text), 'a4': True})
    combined.insert_pdf(doc)
combined.set_toc(toc)
combined.set_metadata({'title': 'AX LearningOps 역할별 운영 가이드', 'author': 'AX LearningOps'})
combined.save(root / 'all-role-guides.pdf', garbage=4, deflate=True)
# Vite and the production Docker image serve these reviewed PDFs verbatim.
public = root.parents[2] / 'lms-web' / 'public' / 'guides'
public.mkdir(parents=True, exist_ok=True)
for name in ['admin-guide', 'mentor-guide', 'student-guide', 'all-role-guides']:
    copyfile(root / (name + '.pdf'), public / (name + '.pdf'))
sheet = Image.new('RGB', (1050, 1500), '#e6ede8')
draw = ImageDraw.Draw(sheet)
for i, (path, _) in enumerate(previews):
    preview = Image.open(path)
    preview.thumbnail((330, 467))
    x, y = i % 3 * 350 + 10, i // 3 * 500 + 20
    sheet.paste(preview, (x, y))
    draw.text((x, y + 466), path.stem, fill='black')
sheet.save(root / 'review-contact-sheet.png')
(root / 'pdf-checks.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(checks, ensure_ascii=False))
