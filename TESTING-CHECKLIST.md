# Knowledge Base Feature — Testing Checklist

## Pre-Flight Check
- [ ] `npm install` completed successfully
- [ ] All dependencies installed: @lancedb/lancedb, @xenova/transformers, pdfjs-dist
- [ ] No syntax errors in any .js files

## Local Development Testing

### Basic Functionality
- [ ] App starts with `npm start`
- [ ] Main window opens normally
- [ ] 📚 Knowledge Base button visible in titlebar (purple book icon)
- [ ] Clicking 📚 button opens Knowledge Base window
- [ ] KB window shows "Not indexed" initially

### PDF Upload & Indexing
- [ ] Click "Upload PDFs" → file dialog opens
- [ ] Select 3-5 PDFs → they appear in the uploaded list
- [ ] List shows: filename, size (KB/MB), date
- [ ] Check `%APPDATA%\Interview Assistant\knowledge-base\source-pdfs\` → PDFs copied
- [ ] Click "Rebuild Index" button
- [ ] Status changes to "Indexing..." with progress
- [ ] Console logs show (F12):
  - `[Knowledge] Extracting text from X PDFs...`
  - `[Knowledge] Created X chunks`
  - `[Knowledge] Generating embeddings...`
  - `[Knowledge] Stored X chunks in LanceDB`
- [ ] Status changes to "✅ Ready — X chunks indexed"
- [ ] Check `%APPDATA%\Interview Assistant\knowledge-base\vectordb\` → DB files exist
- [ ] Check `%APPDATA%\Interview Assistant\knowledge-base\status.json` → contains correct schema

### RAG Query (Main Window)
- [ ] In main window, ask a Guidewire-related question
- [ ] Check console (F12) for:
  - `[Knowledge] Retrieval: embed query + search`
  - `[Knowledge] Retrieved 5 chunks`
  - `[Knowledge] RAG context retrieved: X chunks`
- [ ] Answer includes source citations like "(PolicyCenter Guide, Page 12)"
- [ ] Answer is relevant to the uploaded PDFs

### Edge Cases
- [ ] **Cancel picker**: Click Upload → Cancel → no error, status unchanged
- [ ] **Duplicate name**: Upload same PDF twice → second gets timestamped name `file_1234567890.pdf`
- [ ] **Empty query**: Ask blank question → normal LLM flow (or error), no crash
- [ ] **No PDFs**: Delete all PDFs from list → Rebuild → status: "No PDFs found"
- [ ] **Corrupt PDF**: Upload .txt renamed to .pdf → logged, skipped, other PDFs still work
- [ ] **Delete KB**: Click 🗑️ Delete → confirm → all data deleted
- [ ] **After delete**: Ask question → no RAG context used, normal LLM flow, no crash

### Existing Features (Regression)
- [ ] Manual mode still works (mic button, transcription)
- [ ] Passive mode still works
- [ ] Screen Analyzer mode still works
- [ ] Settings window opens
- [ ] Chat history works
- [ ] All providers work (Groq/DigitalOcean/Gemini/DeepSeek/Cerebras)

## Packaged .exe Testing

### Build
- [ ] `npm run build` completes without errors
- [ ] `dist/Interview Assistant Setup 1.0.0.exe` created

### Install & Launch
- [ ] Run installer → installs to `%LOCALAPPDATA%\Programs\Interview Assistant\`
- [ ] App launches from Start Menu / Desktop shortcut
- [ ] No console errors on startup

### Feature Tests (Repeat All)
- [ ] 📚 button opens KB window
- [ ] Upload PDFs works
- [ ] Rebuild Index works (native LanceDB binary loads correctly)
- [ ] RAG query works
- [ ] All edge cases work
- [ ] Delete KB works

### Native Module Verification
- [ ] Check app install dir: `app.asar.unpacked\node_modules\@lancedb\` exists
- [ ] Check: `app.asar.unpacked\node_modules\@xenova\transformers\` exists
- [ ] LanceDB creates DB in `%APPDATA%\Interview Assistant\knowledge-base\vectordb\`
- [ ] Local embedding model downloads to `%USERPROFILE%\.cache\huggingface\`

## Performance Check
- [ ] Index 10 PDFs (~1000 pages) completes in <5 minutes
- [ ] Query response time <2 seconds (embedding + search)
- [ ] App remains responsive during indexing
- [ ] No memory leaks (check Task Manager during/after indexing)

## Final Smoke Test
```bash
npm start
# 1. Click 📚 → Upload 3 PDFs
# 2. Rebuild Index → wait for "Ready"
# 3. Ask: "Explain ClaimCenter policy handling"
# 4. Check DevTools → see RAG logs
# 5. Verify answer cites sources
# 6. Delete KB → ask same question → normal LLM flow
```

## Known Limitations (Expected Behavior)
- ❌ DigitalOcean embeddings: 403 Forbidden (account permission issue) → local model used instead
- ✅ First run: Downloads ~23MB embedding model (one-time, cached)
- ✅ Large PDFs (>500 pages): May take 30-60 seconds to process per PDF
- ✅ Non-English text: all-MiniLM-L6-v2 trained on English, other languages may have lower accuracy

## If Something Fails

### App won't start
- Check: `npm install` completed
- Check: No syntax errors in .js files
- Run: `npm start` from terminal to see error logs

### KB window won't open
- Check: `src/main.js` has `createKnowledgeBaseWindow()` and `require('./main/knowledgeIpc')`
- Check: `src/renderer/knowledge.html` exists

### Upload PDFs fails
- Check: File dialog permissions (Windows security)
- Check: `%APPDATA%\Interview Assistant\knowledge-base\source-pdfs\` writable

### Indexing fails
- Open DevTools → check console for error
- Common causes:
  - PDF extraction failed → corrupt PDF, skip and retry
  - Embedding failed → network issue (if using DO) or model download failed (local)
  - LanceDB init failed → check `%APPDATA%` writable

### RAG doesn't work
- Check: Index built successfully (status.json exists)
- Check: `window.knowledgeBase` defined in renderer (F12 → type `window.knowledgeBase`)
- Check: Console shows `[Knowledge] RAG search` logs

### Packaged .exe: Native modules fail
- Check: `package.json` has `asarUnpack` config
- Check: `app.asar.unpacked\node_modules\@lancedb\` exists in install dir
- Rebuild: `npm run build`

---

## Success Criteria ✅
- [ ] All 21 acceptance criteria met (see KNOWLEDGE-BASE-README.md)
- [ ] No errors in dev mode (`npm start`)
- [ ] No errors in packaged .exe
- [ ] RAG retrieval works and improves answers
- [ ] Existing features unaffected

**Status**: Ready for testing! 🚀
