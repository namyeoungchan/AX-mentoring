import { crc32, deflateRawSync } from 'node:zlib';

// Minimal SpreadsheetML writer: string/number cells, bold header row, column widths.
const escape = value => String(value).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
    // XML 1.0 forbids most control characters; keep tab/newline/carriage return.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
const column = index => { let name = ''; for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + (n - 1) % 26) + name; return name; };

export function sheetName(value, used) {
    const base = (String(value).replace(/[[\]:*?/\\]/g, ' ').replace(/^'+|'+$/g, '').trim() || '시트').slice(0, 31);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base.slice(0, 31 - String(n).length - 1)}-${n}`;
    used.add(name.toLowerCase());
    return name;
}

function sheetXml({ rows, widths = [] }) {
    const cols = widths.length ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '';
    const body = rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
        if (value === null || value === undefined || value === '') return '';
        const ref = `${column(c)}${r + 1}`, style = r === 0 ? ' s="1"' : typeof value === 'number' ? '' : ' s="2"';
        return typeof value === 'number' && Number.isFinite(value) ? `<c r="${ref}"${style}><v>${value}</v></c>`
            : `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${body}</sheetData></worksheet>`;
}

function zip(files) {
    const local = [], central = [];
    let offset = 0;
    for (const [name, text] of files) {
        const data = Buffer.from(text, 'utf8'), packed = deflateRawSync(data), path = Buffer.from(name, 'utf8'), crc = crc32(data);
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6); header.writeUInt16LE(8, 8);
        header.writeUInt32LE(crc, 14); header.writeUInt32LE(packed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(path.length, 26);
        const entry = Buffer.alloc(46);
        entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8); entry.writeUInt16LE(8, 10);
        entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(packed.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(path.length, 28); entry.writeUInt32LE(offset, 42);
        local.push(header, path, packed); central.push(entry, path);
        offset += header.length + path.length + packed.length;
    }
    const size = central.reduce((sum, b) => sum + b.length, 0), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...local, ...central, end]);
}

// sheets: [{ name, rows: [[header...], [cell...]], widths?: [number] }]
export function workbook(sheets) {
    const ns = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    return zip([
        ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
        ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${ns}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
        ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${ns}"><sheets>${sheets.map((s, i) => `<sheet name="${escape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
        ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${ns}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${ns}/styles" Target="styles.xml"/></Relationships>`],
        ['xl/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE8EFEA"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="3"><xf/><xf fontId="1" fillId="2" applyFont="1" applyFill="1"/><xf applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs></styleSheet>'],
        ...sheets.map((s, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s)]),
    ]);
}
