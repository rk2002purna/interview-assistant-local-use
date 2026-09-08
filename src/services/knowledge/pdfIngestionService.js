'use strict';

/**
 * pdfIngestionService.js
 * -----------------------------------------------------------------------------
 * Reads all PDFs from the source-pdfs folder and extracts text page-by-page
 * using pdfjs-dist (Feature 3). Page-level extraction lets us preserve the
 * page number for every chunk, which is useful for source tracking.
 *
 * Output shape per page:
 *   { sourceFile: "Guidewire_PolicyCenter.pdf", pageNumber: 12, text: "..." }
 *
 * pdfjs-dist v4 ships as ESM, so we load it with a dynamic import. It is lazy
 * (only loaded on first extraction) to keep app startup fast.
 * -----------------------------------------------------------------------------
 */

const fs = require('fs');
const path = require('path');
const paths = require('./knowledgePaths');

let _pdfjsPromise = null;

async function getPdfjs() {
  if (!_pdfjsPromise) {
    // `legacy` build works under Node without a DOM. `.mjs` = ESM entrypoint.
    _pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  }
  return _pdfjsPromise;
}

/**
 * Document formats we can ingest. Markdown/plain text are preferred over PDF:
 * their text needs no reconstruction, so no column interleaving, hyphenation
 * splits, or header/footer noise — which matters most for keyword retrieval.
 */
const SUPPORTED_EXTENSIONS = ['.pdf', '.md', '.markdown', '.txt'];

function isSupportedDocument(fileName) {
  const lower = String(fileName).toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** List every ingestible document in the source directory. */
function listPdfFiles() {
  const dir = paths.getSourcePdfDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(isSupportedDocument)
    .map(f => path.join(dir, f));
}

/**
 * Reduce Markdown to plain prose while keeping the words intact.
 * Deliberately conservative: `_` and `*` are left alone so identifiers like
 * `policy_period` are not mangled, and fenced-code CONTENT is kept (only the
 * fence markers go) because code is often the useful part.
 */
function stripMarkdown(md) {
  return String(md)
    .replace(/```[a-zA-Z0-9+-]*\n?/g, '')       // fence markers only
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')          // heading markers, keep the text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')        // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')     // links → link text
    .replace(/^\s{0,3}>\s?/gm, '')               // blockquote markers
    .replace(/\*\*/g, '')                        // bold
    .replace(/`/g, '')                           // inline code ticks
    .replace(/^\s{0,3}[-*+]\s+/gm, '')           // bullet markers
    .replace(/^\s*\|?[\s:|-]{5,}\|?\s*$/gm, '')  // table separator rows
    .replace(/\|/g, ' ')                         // table cell pipes
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Extract text from a Markdown or plain-text document.
 *
 * Markdown is split on headings so each "page" is one coherent topic, and the
 * heading text stays attached to its body (its keywords are usually the best
 * match for a question). Plain text is returned whole and left to the chunker.
 *
 * @returns {{sourceFile:string, pageNumber:number, text:string}[]}
 */
function extractTextDocument(filePath) {
  const sourceFile = path.basename(filePath);
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');

  if (!/\.(md|markdown)$/i.test(filePath)) {
    const text = stripMarkdown(raw);
    return text ? [{ sourceFile, pageNumber: 1, text }] : [];
  }

  const sections = [];
  let current = [];
  for (const line of raw.split('\n')) {
    const isHeading = /^\s{0,3}#{1,3}\s+\S/.test(line);
    if (isHeading && current.some((l) => l.trim())) {
      sections.push(current.join('\n'));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length) sections.push(current.join('\n'));

  const out = [];
  let sectionNumber = 0;
  for (const section of sections) {
    const text = stripMarkdown(section);
    if (!text) continue;
    sectionNumber++;
    out.push({ sourceFile, pageNumber: sectionNumber, text });
  }
  return out;
}

/**
 * Extract text from a single PDF file, one entry per non-empty page.
 * @param {string} filePath absolute path to the PDF
 * @returns {Promise<{sourceFile:string, pageNumber:number, text:string}[]>}
 */
async function extractPdf(filePath) {
  const sourceFile = path.basename(filePath);
  const pdfjs = await getPdfjs();
  const data = new Uint8Array(fs.readFileSync(filePath));

  // useSystemFonts avoids a Node-side StandardFontDataUrl fetch.
  const doc = await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Join text items; pdfjs gives runs as separate items, so join with spaces
    // and collapse whitespace. Also include explicit newlines from item.hasEOL.
    let parts = [];
    for (const item of content.items) {
      if (!item || typeof item.str !== 'string') continue;
      parts.push(item.str);
      if (item.hasEOL) parts.push('\n');
    }
    let text = parts.join(' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    // Skip empty pages (Feature 3.5)
    if (text.length === 0) continue;
    pages.push({ sourceFile, pageNumber: i, text });
  }
  try { await doc.destroy(); } catch (e) { /* ignore */ }
  return pages;
}

/**
 * Extract text from ALL PDFs in the source-pdfs directory.
 *
 * @param {object} [opts]
 * @param {(current:number, total:number, fileName:string)=>void} [opts.onProgress]
 *   Called before each PDF is processed.
 * @returns {Promise<{pages: Array, pdfCount:number, pageCount:number, failedFiles:string[], chars:number}>}
 */
async function extractAllPdfs(opts) {
  opts = opts || {};
  const onProgress = opts.onProgress || function () {};
  const files = listPdfFiles();
  const failedFiles = [];
  const pages = [];
  let pageCount = 0;
  let chars = 0;

  for (let idx = 0; idx < files.length; idx++) {
    const file = files[idx];
    const fileName = path.basename(file);
    onProgress(idx + 1, files.length, fileName);
    console.log(`[Knowledge] Extracting text from ${fileName} (${idx + 1}/${files.length})...`);
    try {
      // PDFs go through pdfjs; Markdown/text is read directly (no native deps,
      // no extraction loss).
      const pdfPages = /\.pdf$/i.test(file)
        ? await extractPdf(file)
        : extractTextDocument(file);
      for (const p of pdfPages) {
        pages.push(p);
        pageCount++;
        chars += p.text.length;
      }
      console.log(`[Knowledge]   ${fileName}: ${pdfPages.length} pages, ${pdfPages.reduce((s, p) => s + p.text.length, 0)} chars`);
    } catch (e) {
      // Handle extraction errors gracefully (Feature 3.4) — record and continue.
      console.error(`[Knowledge]   Failed to extract ${fileName}:`, e.message);
      failedFiles.push(fileName);
    }
  }

  console.log(`[Knowledge] Extraction complete: ${pages.length} pages, ${chars} chars from ${files.length} PDFs (${failedFiles.length} failed)`);
  return { pages, pdfCount: files.length, pageCount, failedFiles, chars };
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  isSupportedDocument,
  listPdfFiles,
  listDocumentFiles: listPdfFiles, // clearer alias now that PDF is not the only format
  extractPdf,
  extractTextDocument,
  stripMarkdown,
  extractAllPdfs
};
