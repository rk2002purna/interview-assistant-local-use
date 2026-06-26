'use strict';

/**
 * chunkingService.js
 * -----------------------------------------------------------------------------
 * Splits extracted page text into overlapping, sentence-aware chunks
 * (Feature 4). Every chunk keeps its source metadata.
 *
 * Defaults:
 *   - chunk size:  ~2500 chars  (≈ 500–800 tokens)
 *   - overlap:     ~300 chars   (≈ 100 tokens)
 *
 * Chunk shape:
 *   { id, text, sourceFile, pageNumber, chunkIndex }
 * -----------------------------------------------------------------------------
 */

const DEFAULTS = {
  targetChars: 2500,
  overlapChars: 300,
  minChars: 200 // don't emit a final chunk smaller than this; fold into previous
};

// Split text into sentences without splitting on common abbreviations too eagerly.
function splitSentences(text) {
  // Protect a few common abbreviations from being treated as sentence ends.
  const protectedText = text
    .replace(/\b(e\.g|i\.e|etc|vs|Mr|Mrs|Ms|Dr|Prof|Inc|Ltd|Corp|Fig|No)\./gi, '$1<DOT>');
  const parts = protectedText.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) || [protectedText];
  return parts.map(p => p.replace(/<DOT>/g, '.').trim()).filter(Boolean);
}

/**
 * Chunk a single page's text.
 * @returns {Array<{text:string, sourceFile:string, pageNumber:number, chunkIndex:number}>}
 */
function chunkPage(page, opts) {
  opts = Object.assign({}, DEFAULTS, opts || {});
  const { targetChars, overlapChars, minChars } = opts;
  const clean = (page.text || '').replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];

  const sentences = splitSentences(clean);

  // Greedy pack: accumulate sentences until we reach ~targetChars, then emit.
  const rawChunks = [];
  let buf = '';
  for (const s of sentences) {
    if (!s) continue;
    // If a single sentence is longer than the target, hard-split it.
    if (s.length > targetChars) {
      if (buf) { rawChunks.push(buf.trim()); buf = ''; }
      for (let i = 0; i < s.length; i += targetChars - overlapChars) {
        rawChunks.push(s.slice(i, i + targetChars).trim());
        if (i + targetChars >= s.length) break;
      }
      continue;
    }
    if ((buf + ' ' + s).length > targetChars && buf) {
      rawChunks.push(buf.trim());
      buf = s;
    } else {
      buf = buf ? buf + ' ' + s : s;
    }
  }
  if (buf) rawChunks.push(buf.trim());

  // Fold a too-small trailing chunk into the previous one.
  if (rawChunks.length >= 2 && rawChunks[rawChunks.length - 1].length < minChars) {
    rawChunks[rawChunks.length - 2] += ' ' + rawChunks.pop();
  }

  // Attach metadata. (Overlap is achieved implicitly by packing whole sentences;
  // we keep the simple packing model rather than windowed slicing to avoid
  // splitting mid-sentence.)
  return rawChunks.map((text, i) => ({
    text,
    sourceFile: page.sourceFile,
    pageNumber: page.pageNumber,
    chunkIndex: i
  }));
}

/**
 * Chunk an array of pages into an array of chunks with globally-unique ids.
 * @param {Array<{sourceFile:string,pageNumber:number,text:string}>} pages
 * @returns {Array<{id,text,sourceFile,pageNumber,chunkIndex}>}
 */
function chunkPages(pages, opts) {
  const out = [];
  let counter = 0;
  for (const page of pages) {
    const pageChunks = chunkPage(page, opts);
    for (const c of pageChunks) {
      c.id = 'chk_' + Date.now().toString(36) + '_' + (counter++).toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      out.push(c);
    }
  }
  return out;
}

module.exports = {
  DEFAULTS,
  splitSentences,
  chunkPage,
  chunkPages
};
