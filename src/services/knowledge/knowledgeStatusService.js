'use strict';

/**
 * knowledgeStatusService.js
 * -----------------------------------------------------------------------------
 * Persists indexing metadata to status.json and holds a small in-memory
 * "progress" object that the UI polls while indexing runs (Feature 16).
 *
 * status.json schema (Feature 19):
 * {
 *   "indexed": true,
 *   "pdfCount": 10,
 *   "chunkCount": 684,
 *   "lastIndexedAt": "2026-06-27T10:30:00.000Z",
 *   "embeddingModel": "local:Xenova/all-MiniLM-L6-v2",
 *   "embeddingDimension": 384,
 *   "vectorDbProvider": "lancedb",
 *   "lastError": null
 * }
 * -----------------------------------------------------------------------------
 */

const fs = require('fs');
const paths = require('./knowledgePaths');

const STATUS_DEFAULT = Object.freeze({
  indexed: false,
  pdfCount: 0,
  chunkCount: 0,
  lastIndexedAt: null,
  embeddingModel: null,
  embeddingDimension: 0,
  vectorDbProvider: 'lancedb',
  lastError: null
});

// ---- On-disk status (durable across restarts) ----

function readStatus() {
  try {
    const p = paths.getStatusPath();
    if (!fs.existsSync(p)) return { ...STATUS_DEFAULT };
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { ...STATUS_DEFAULT, ...data };
  } catch (e) {
    console.error('[Knowledge] Failed to read status.json:', e.message);
    return { ...STATUS_DEFAULT, lastError: e.message };
  }
}

function writeStatus(partial) {
  try {
    paths.ensureDirectories();
    const current = readStatus();
    const next = { ...current, ...partial };
    fs.writeFileSync(paths.getStatusPath(), JSON.stringify(next, null, 2));
    return next;
  } catch (e) {
    console.error('[Knowledge] Failed to write status.json:', e.message);
    return readStatus();
  }
}

function resetStatus() {
  return writeStatus({ ...STATUS_DEFAULT });
}

// ---- In-memory progress (transient, during a single indexing run) ----
// The UI calls knowledge:status to render this.
let progress = {
  state: 'idle', // idle | indexing | ready | error
  message: '',
  currentPdf: 0,
  totalPdfs: 0,
  currentChunk: 0,
  totalChunks: 0,
  phase: '' // e.g. "Extracting text", "Generating embeddings"
};

function getProgress() {
  return { ...progress };
}

function setProgress(update) {
  progress = { ...progress, ...update };
  return progress;
}

function resetProgress() {
  progress = {
    state: 'idle', message: '', currentPdf: 0, totalPdfs: 0,
    currentChunk: 0, totalChunks: 0, phase: ''
  };
  return progress;
}

/**
 * Derive a human-friendly status line for the UI (Feature 5).
 * Prefers live progress during indexing; falls back to durable status.
 */
function describeStatus() {
  const p = progress;
  const s = readStatus();
  if (p.state === 'indexing') {
    if (p.phase && p.totalChunks > 0 && p.currentChunk > 0) {
      return `${p.phase} ${p.currentChunk}/${p.totalChunks}...`;
    }
    if (p.phase && p.totalPdfs > 0 && p.currentPdf > 0) {
      return `${p.phase} ${p.currentPdf}/${p.totalPdfs}...`;
    }
    if (p.phase) return p.phase + '...';
    return 'Indexing in progress...';
  }
  if (p.state === 'error') return 'Indexing failed: ' + (p.message || s.lastError || 'unknown error');
  if (s.indexed) {
    return `Knowledge base ready — ${s.pdfCount} PDF${s.pdfCount === 1 ? '' : 's'}, ${s.chunkCount} chunks`;
  }
  // Not indexed yet
  const fs = require('fs');
  let pdfCount = 0;
  try {
    pdfCount = fs.readdirSync(paths.getSourcePdfDir()).filter(f => f.toLowerCase().endsWith('.pdf')).length;
  } catch (e) { /* dir may not exist yet */ }
  return pdfCount > 0 ? `${pdfCount} PDF${pdfCount === 1 ? '' : 's'} uploaded — index not built yet` : 'No PDFs uploaded';
}

module.exports = {
  STATUS_DEFAULT,
  readStatus,
  writeStatus,
  resetStatus,
  getProgress,
  setProgress,
  resetProgress,
  describeStatus
};
