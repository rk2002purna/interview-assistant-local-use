'use strict';

/**
 * ragAnswerService.js
 * -----------------------------------------------------------------------------
 * Retrieval side of RAG (Feature 8 & 9). Given a question:
 *   - if no index exists → return usedRag:false (caller falls back to normal LLM)
 *   - else embed the question, search top-K chunks, format a context string,
 *     and return it. The RENDERER splices this into the existing system prompt
 *     and calls the unchanged Groq/DigitalOcean streaming flow.
 *
 * It does NOT call the LLM itself — that keeps the existing provider routing
 * (Groq / DigitalOcean GPT-OSS / Gemini) untouched.
 *
 * Returned shape (Feature 20):
 *   { usedRag:boolean, context:string, sources:[{sourceFile,pageNumber,score}] }
 * -----------------------------------------------------------------------------
 */

const embeddings = require('./embeddingService');
const vectorStore = require('./vectorStoreService');

const TOP_K = 5;                 // retrieve top 5 chunks (Feature 6 recommendation)
const MAX_CONTEXT_CHARS = 8000;  // hard cap (Feature 15) — ~2k tokens of context
const MIN_SCORE = 0.15;          // similarity floor; below this we treat as "no good match"

/**
 * Retrieve relevant chunks for a question and format them as context.
 *
 * @param {string} question
 * @param {object} [opts]
 * @param {string} [opts.apiKey]  only needed if embedding provider = digitalocean
 * @returns {Promise<{usedRag:boolean, context:string, sources:Array}>}
 */
async function retrieveContext(question, opts) {
  opts = opts || {};
  if (!question || !question.trim()) return { usedRag: false, context: '', sources: [] };

  // No index → caller falls back to the normal LLM flow (Feature 8.3).
  if (!(await vectorStore.hasIndex())) {
    console.log('[Knowledge] No index found — falling back to normal LLM flow.');
    return { usedRag: false, context: '', sources: [] };
  }

  try {
    const qVec = await embeddings.embedQuery(question, { apiKey: opts.apiKey });
    const results = await vectorStore.searchSimilar(qVec, TOP_K);
    if (!results || results.length === 0) {
      console.log('[Knowledge] Vector search returned no chunks — falling back to normal LLM flow.');
      return { usedRag: false, context: '', sources: [] };
    }

    // Drop low-similarity hits and enforce the context character budget (Feature 15).
    const good = results.filter(r => r.score >= MIN_SCORE);
    const kept = [];
    let total = 0;
    for (const r of good) {
      const piece = formatChunk(r);
      if (total + piece.length > MAX_CONTEXT_CHARS && kept.length > 0) break; // budget hit
      kept.push(r);
      total += piece.length;
      if (kept.length >= TOP_K) break;
    }

    if (kept.length === 0) {
      console.log('[Knowledge] No chunks above similarity threshold (%d results, all below %s) — falling back.', results.length, MIN_SCORE);
      return { usedRag: false, context: '', sources: [] };
    }

    const context = kept.map(formatChunk).join('\n---\n');
    const sources = kept.map(r => ({ sourceFile: r.sourceFile, pageNumber: r.pageNumber, score: +r.score.toFixed(3) }));
    console.log('[Knowledge] Retrieval query: "%s" → %d chunks retrieved (scores: %s).',
      question.slice(0, 60), kept.length, sources.map(s => s.score).join(', '));
    return { usedRag: true, context, sources };
  } catch (e) {
    // Any retrieval/embedding error must never crash the user's answer (Feature 8.3 / 12).
    console.error('[Knowledge] Retrieval failed, falling back to normal LLM flow:', e.message);
    return { usedRag: false, context: '', sources: [], error: e.message };
  }
}

/**
 * Format a single chunk for the context block (Feature 9).
 *   Source: <file>, Page: <n>
 *   Content:
 *   <chunk text>
 */
function formatChunk(chunk) {
  const pagePart = (chunk.pageNumber && chunk.pageNumber > 0)
    ? ', Page: ' + chunk.pageNumber
    : '';
  return 'Source: ' + chunk.sourceFile + pagePart + '\nContent:\n' + chunk.text.trim();
}

/**
 * The Guidewire RAG system-prompt section (Feature 8 prompt template).
 * Appended to the existing system prompt when RAG context is available.
 * {{retrieved_context}} is filled in; the question is left to the existing flow.
 */
function buildRagSystemPromptSection(context) {
  return `

=== GUIDEWIRE KNOWLEDGE BASE CONTEXT ===
Use the provided Guidewire PDF context first. Answer in a clear, practical, interview-friendly way.

If the answer is not clearly present in the provided context, say: "This is not clearly covered in my Guidewire notes, but generally..." and answer from general knowledge.

Rules:
- Do not invent Guidewire-specific facts that are not in the context.
- Keep answers concise by default; expand only when the question requires it.
- Use simple language suitable for a Java full-stack / Guidewire developer interview.
- Prefer structured answers when useful.
- Do not mention raw chunk IDs or expose internal vector database details.

Provided context:
${context}
=== END GUIDEWIRE CONTEXT ===`;
}

module.exports = {
  TOP_K,
  retrieveContext,
  buildRagSystemPromptSection,
  formatChunk
};
