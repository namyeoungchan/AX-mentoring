"""Generate the downloadable roster without copying participant personal data."""
from pathlib import Path
from xml.sax.saxutils import escape
from zipfile import ZipFile, ZIP_DEFLATED

HEADERS = ['학생ID', '상태', '팀', '성명', '학교', '학과', '학년', '성별', '연락처', '이메일', '전공 계열', 'AI 수준(1-4)', '코딩 경험', '개발경험 수', '개발 가능', '희망 역할', '노트북 OS', '설문 제출', '9/14', '9/15-1', '9/15-2', '9/15-3', '9/15-4', '9/17-1', '9/17-2', '9/17-3', '9/17-4', '출석 합계', '비고']

def column(number):
    value = ''
    while number:
        number, digit = divmod(number - 1, 26)
        value = chr(65 + digit) + value
    return value

def sheet(rows):
    content = ''.join(f'<row r="{i}">' + ''.join(f'<c r="{column(j)}{i}" t="inlineStr"><is><t>{escape(str(v))}</t></is></c>' for j, v in enumerate(row, 1)) + '</row>' for i, row in enumerate(rows, 1))
    return '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="29" width="18" customWidth="1"/></cols><sheetData>' + content + '</sheetData></worksheet>'

def create(path, rows=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(path, 'w', ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
        z.writestr('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>')
        z.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="명단" sheetId="1" r:id="rId1"/><sheet name="작성 안내" sheetId="2" r:id="rId2"/></sheets></workbook>')
        z.writestr('xl/_rels/workbook.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/></Relationships>')
        z.writestr('xl/worksheets/sheet1.xml', sheet([HEADERS, *(rows or [])]))
        z.writestr('xl/worksheets/sheet2.xml', sheet([
            ['항목', '작성 방법'], ['학생ID', '필수. DK-01처럼 영문·숫자·._- 4~32자. 영문은 소문자로 저장됩니다.'],
            ['상태', '참여 또는 제외. 제외 행은 계정을 생성하지 않습니다.'], ['팀', '참여자 필수. 1팀, 2팀 등 실제 팀 이름을 입력하세요.'],
            ['성명', '필수. 1~50자.'], ['학교·학과·연락처·이메일', '선택. 등록 후 수강생 정보 수정에서 변경할 수 있습니다.'],
            ['나머지 열', '원본 양식과 호환하기 위한 열입니다. 설문·출결 정보는 계정 등록에 반영하지 않습니다.'],
            ['처리 순서', '엑셀 업로드 → 등록 가능·실패·제외 확인 → 적용 또는 취소 → 최종 처리 결과 확인'],
            ['초기 비밀번호', 'bdaxuser1! (첫 로그인 시 변경 필수)'], ['중복 등록', '기존 계정은 유지되며 비밀번호를 초기화하지 않습니다.'],
            ['제한', '파일 2MB 이하, 한 번에 참여자 100명 이하. 명단 시트 이름과 제목 행을 유지하세요.'],
        ]))

if __name__ == '__main__':
    create(Path(__file__).resolve().parents[1] / 'public/templates/student-roster-template.xlsx')
