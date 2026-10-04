// SqueveTrack build step: shrink index.html for deployment.
//
//   npm i --no-save html-minifier-terser@7 terser@5
//   node tools/minify.mjs index.html            (rewrites the file in place)
//   node tools/minify.mjs index.html dist/index.html
//
// Run it AFTER the step that stamps __SQ_BUILD__ and __SQ_BUILD_DATE__ and BEFORE your smoke test, so the test checks
// exactly what ships. If the tokens are still there the script refuses to run: the minifier would fold the "is this build
// stamped?" check at build time and every deployed copy would report "dev".
//
// It never fails a deploy. On any problem it leaves the file untouched and exits 0 with a warning.
// Source stays readable in git; only the deployed copy is minified.

import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { minify as minifyHtml } from 'html-minifier-terser';
import { minify as minifyJs } from 'terser';

const [, , inFile = 'index.html', outFile = inFile] = process.argv;
const kb = (n) => (n / 1024).toFixed(0) + ' KB';

function skip(why) {
  console.warn('minify: skipped (' + why + '). The file is unchanged.');
  process.exit(0);
}

let src;
try { src = await readFile(inFile, 'utf8'); } catch (e) { skip('cannot read ' + inFile + ': ' + e.message); }

if (/build\s*=\s*'__SQ_BUILD__'/.test(src)) skip('version tokens are not stamped yet; run this after the stamp step');

const TERSER = {
  compress: { passes: 1 },   // toplevel stays false, so global function and variable names that inline onclick handlers use are kept
  mangle: true,              // only renames variables inside functions
  format: { comments: false },
};

let out;
try {
  out = await minifyHtml(src, {
    collapseWhitespace: true,
    conservativeCollapse: true,   // keep one space where whitespace separated inline elements
    removeComments: true,
    minifyCSS: true,
    // Minify <script> blocks only. Inline event attributes such as onclick="..." are left exactly as written.
    minifyJS: async (text, inline) => {
      if (inline) return text;
      const r = await minifyJs(text, TERSER);
      if (r.error) throw r.error;
      return r.code;
    },
  });
} catch (e) { skip('minifier error: ' + e.message); }

// Sanity checks before overwriting anything
const count = (s, re) => (s.match(re) || []).length;
const problems = [];
if (out.length >= src.length * 0.97) problems.push('output is not meaningfully smaller');
if (count(out, /<script\b/g) !== count(src, /<script\b/g)) problems.push('script tag count changed');
if (count(out, /<style\b/g) !== count(src, /<style\b/g)) problems.push('style tag count changed');
for (const mark of ['DECOY_SECRET', 'window.SQ_VERSION', 'id="lock-screen"', 'Content-Security-Policy', 'WHATS_NEW', '\u20b5'])
  if (src.includes(mark) && !out.includes(mark)) problems.push('lost marker ' + JSON.stringify(mark));
if (out.includes('\ufffd') && !src.includes('\ufffd')) problems.push('encoding damage');
if (problems.length) skip(problems.join('; '));

await writeFile(outFile, out, 'utf8');
console.log('minify: ' + kb(Buffer.byteLength(src)) + ' -> ' + kb(Buffer.byteLength(out)) +
  '  |  gzip ' + kb(gzipSync(src).length) + ' -> ' + kb(gzipSync(out).length));
