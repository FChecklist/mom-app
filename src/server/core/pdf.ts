// Small real PDF writer (text only, Helvetica, WinAnsi). No dependencies, works in Workers.
import { fmtDate, fmtDateTime } from '../util.ts';
import { isClosed, STATUS_META, type Status } from './status.ts';

export interface PdfItem {
  t: string;
  s?: number;
  b?: boolean;
  gap?: number;
  ind?: number;
  strike?: boolean;
}

/** Keep Latin-1 (WinAnsi-compatible) characters; everything else becomes '?'. */
function clean(s: string): string {
  return String(s).replace(/→/g, '->').replace(/[\r\n\t]+/g, ' ').replace(/[^\x20-\x7e\xa1-\xff]/g, '?');
}
const esc = (s: string) => clean(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function makePdf(items: PdfItem[]): Uint8Array<ArrayBuffer> {
  const W = 595, H = 842, M = 50;
  const pages: string[][] = [[]];
  let y = H - M;
  for (const it of items) {
    const size = it.s || 11;
    const per = Math.max(10, Math.floor((W - 2 * M - (it.ind || 0)) / (size * 0.52)));
    const lines: string[] = [];
    let cur = '';
    for (const w of clean(it.t).split(' ')) {
      if ((cur + ' ' + w).trim().length > per) {
        lines.push(cur);
        cur = w;
      } else cur = (cur + ' ' + w).trim();
    }
    lines.push(cur);
    y -= it.gap || 0;
    for (const ln of lines) {
      const lead = size * 1.45;
      if (y - lead < M) {
        pages.push([]);
        y = H - M;
      }
      y -= lead;
      const pg = pages[pages.length - 1];
      const x = M + (it.ind || 0);
      pg.push(`BT /F${it.b ? 2 : 1} ${size} Tf ${x} ${y.toFixed(1)} Td (${esc(ln)}) Tj ET`);
      if (it.strike && ln) pg.push(`q 0.6 w ${x} ${(y + size * 0.3).toFixed(1)} m ${(x + ln.length * size * 0.5).toFixed(1)} ${(y + size * 0.3).toFixed(1)} l S Q`);
    }
  }
  const n = pages.length;
  let out = '%PDF-1.4\n';
  const off: number[] = [];
  const add = (id: number, body: string) => {
    off[id] = out.length;
    out += `${id} 0 obj\n${body}\nendobj\n`;
  };
  const kids = pages.map((_, i) => `${5 + 2 * i} 0 R`).join(' ');
  add(1, '<< /Type /Catalog /Pages 2 0 R >>');
  add(2, `<< /Type /Pages /Kids [${kids}] /Count ${n} >>`);
  add(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  add(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  pages.forEach((p, i) => {
    const st = p.join('\n');
    add(5 + 2 * i, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + 2 * i} 0 R >>`);
    add(6 + 2 * i, `<< /Length ${st.length} >>\nstream\n${st}\nendstream`);
  });
  const xref = out.length;
  const total = 5 + 2 * n;
  out += `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let i = 1; i < total; i++) out += String(off[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff; // all chars are <= 0xff by construction
  return bytes;
}

export interface PdfMom {
  title: string;
  date: string;
  venue: string;
  status: string;
  version: number;
  notes: string;
  attendeeNames: string[];
  points: { no: number; title: string; status: Status; ownerNames: string[]; due: string }[];
  history: { v: number; what: string; byName: string; at: string }[];
  host: string;
}

export function momPdf(m: PdfMom): Uint8Array<ArrayBuffer> {
  const it: PdfItem[] = [
    { t: m.title, s: 20, b: true },
    { t: `${fmtDate(m.date)}  |  ${m.venue}  |  ${m.status === 'published' ? 'Published' : 'Draft'} v${m.version}`, s: 10 },
    { t: 'Participants: ' + m.attendeeNames.join(', '), s: 11, gap: 10 },
    { t: 'Notes: ' + m.notes, s: 11, gap: 4 },
    { t: 'Points of action', s: 14, b: true, gap: 14 },
  ];
  for (const p of m.points) {
    it.push({ t: `${p.no}. ${p.title}  [${p.status}]`, s: 11, gap: 6, strike: isClosed(p.status) && STATUS_META[p.status].strike });
    it.push({ t: `Responsible: ${p.ownerNames.join(', ')}   Due: ${fmtDate(p.due)}`, s: 9, ind: 14 });
  }
  it.push({ t: 'History', s: 14, b: true, gap: 14 });
  for (const e of m.history) it.push({ t: `v${e.v} - ${e.what} - ${e.byName} - ${fmtDateTime(e.at)}`, s: 9, gap: 2 });
  it.push({ t: `Made with MOM (${m.host}).`, s: 8, gap: 16 });
  return makePdf(it);
}
