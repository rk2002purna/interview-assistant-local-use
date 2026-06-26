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

/** List every .pdf file in the source-pdfs directory. */
function listPdfFiles() {
  const dir = paths.getSourcePdfDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.pdf'))
    .map(f => path.join(dir, f));
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
      const pdfPages = await extractPdf(file);
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
  listPdfFiles,
  extractPdf,
  extractAllPdfs
};
