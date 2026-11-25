// Guard: every page carries exactly one approved "१३९" mark, and the shared CSS matches the approved text.
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const pages: string[] = [];
const walk = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p); else if (n.endsWith('.html')) pages.push(p);
  }
};
walk(join(root, 'public'));

const MARKUP = '<div class="mark139" lang="hi" aria-hidden="true"><span>१३९</span></div>';
const CSS1 = '.mark139{position:absolute;top:0;left:0;right:0;margin:0;padding:1px 0 0;text-align:center;line-height:1;pointer-events:none;user-select:none;z-index:2147483647;font-family:"Noto Sans Devanagari","Mukta","Nirmala UI","Mangal","Kohinoor Devanagari","Devanagari Sangam MN",sans-serif;font-size:6px;font-weight:700;color:#0B2A6B}';
const CSS2 = '.mark139 span{display:inline-block;border-bottom:.5px solid #7A1010;padding-bottom:.5px}';

test('there is at least one page', () => { expect(pages.length).toBeGreaterThan(0); });

test('every page has exactly one approved mark, first in body', () => {
  for (const p of pages) {
    const s = readFileSync(p, 'utf8');
    expect(s.split('class="mark139"').length - 1, p).toBe(1);
    expect(s.includes(MARKUP), p).toBe(true);
    expect(/<body[^>]*>\s*<div class="mark139"/.test(s), p).toBe(true);
  }
});

test('shared stylesheet holds the approved CSS once and every page loads it', () => {
  const css = readFileSync(join(root, 'public', 'style.css'), 'utf8');
  expect(css.split('.mark139{').length - 1).toBe(1);
  expect(css.includes(CSS1)).toBe(true);
  expect(css.includes(CSS2)).toBe(true);
  for (const p of pages) expect(readFileSync(p, 'utf8')).toContain('href="style.css"');
});
