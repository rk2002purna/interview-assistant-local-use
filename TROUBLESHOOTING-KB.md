# Knowledge Base Troubleshooting Guide

## Issue 1: Knowledge Base Window is Blank

### Symptoms
- Click 📚 button → window opens but shows blank white/black screen
- No UI elements visible

### Causes & Solutions

#### A. DevTools is now enabled (intentional for debugging)
After the latest fix, the Knowledge Base window opens with DevTools automatically. Check the console for errors.

**What to look for:**
1. Open Knowledge Base window
2. DevTools should open automatically on the right
3. Check the Console tab for errors (red text)
4. Look for `[KB] Initializing...` log

**Common errors:**
- `Cannot read properties of undefined` → IPC handlers not registered
- `knowledge:list-pdfs handler missing` → knowledgeIpc.js not loaded
- `require is not defined` → nodeIntegration not enabled

#### B. IPC Handlers Not Registered
If console shows "No handler registered for 'knowledge:...'":

**Fix:** Ensure main.js requires the IPC handlers:
```javascript
app.whenReady().then(() => { 
  createMainWindow(); 
  require('./main/knowledgeIpc'); // ← Must be here
});
```

**Verify:** Check `src/main.js` line ~90 for `require('./main/knowledgeIpc')`

#### C. JavaScript Syntax Error
If console shows "Unexpected token" or similar:

**Fix:** Check knowledge.html for syntax errors
- Missing semicolons
- Unclosed quotes
- Mismatched braces

**Test:** Open knowledge.html in a text editor and check the `<script>` section

---

## Issue 2: Cannot Store PDFs in src/ Folder

### Why src/ Won't Work

**Problem:**
```
❌ src/knowledge-base/source-pdfs/  → Won't work
✅ %APPDATA%\Interview Assistant\knowledge-base\source-pdfs\  → Correct location
```

**Reasons:**
1. **Read-only in production**: When you build the `.exe`, `src/` is packed into `app.asar` (read-only archive)
2. **No write access**: The app cannot write to `app.asar` at runtime
3. **Updates overwrite**: App updates would delete user PDFs if they were in `src/`
4. **User data separation**: PDFs are user data, not application code

### Solution 1: Use the Correct Location (Production)
PDFs are automatically stored in:
- **Windows**: `%APPDATA%\Interview Assistant\knowledge-base\source-pdfs\`
- **macOS**: `~/Library/Application Support/Interview Assistant/knowledge-base/source-pdfs/`
- **Linux**: `~/.config/Interview Assistant/knowledge-base/source-pdfs/`

**To access:**
```cmd
# Windows
explorer %APPDATA%\Interview Assistant\knowledge-base\source-pdfs

# Or press Win+R, paste the above, press Enter
```

### Solution 2: Use Seed Folder (Development Only) ✅ NEW!

For **development testing**, you can now pre-load PDFs from a seed folder:

**Setup:**
1. Place PDFs in: `knowledge-base-seed/` (project root)
2. Start app: `npm start`
3. PDFs are automatically copied to userData on first run
4. Open KB window → click "Rebuild Index"

**Example:**
```
interview-assistant/
  ├── src/
  ├── knowledge-base-seed/        ← Put PDFs here during dev
  │   ├── PolicyCenter-Guide.pdf
  │   ├── ClaimCenter-Guide.pdf
  │   └── README.md
  └── package.json
```

**After npm start:**
```
%APPDATA%\Interview Assistant\knowledge-base\source-pdfs\
  ├── PolicyCenter-Guide.pdf      ← Copied from seed folder
  └── ClaimCenter-Guide.pdf
```

**Notes:**
- ✅ Dev only (not included in `.exe`)
- ✅ PDFs only copied if they don't already exist
- ✅ Avoids manual upload during testing
- ✅ PDFs in seed folder are gitignored (won't commit)

---

## Issue 3: Upload Button Error

### Error Message
```
"Upload error: Cannot read properties of undefined (reading 'selectPdfs')"
```

### Cause
knowledge.html was trying to use `window.knowledgeBase` which doesn't exist in that window.

### Fix Applied ✅
Changed knowledge.html to use direct IPC calls:
```javascript
// Before (broken):
await window.knowledgeBase.selectPdfs();

// After (fixed):
const { ipcRenderer } = require('electron');
await ipcRenderer.invoke('knowledge:select-pdfs');
```

**Status:** Fixed in latest version

---

## Issue 4: Rebuild Index Fails

### Symptom
Click "Rebuild Index" → status shows error or gets stuck

### Common Causes

#### A. No PDFs Uploaded
**Error:** "No PDFs found"
**Fix:** Upload PDFs first (or use seed folder in dev)

#### B. Corrupt PDF
**Log:** `[Knowledge] Skipped corrupt PDF: file.pdf`
**Fix:** Remove/replace corrupt PDFs, retry rebuild

#### C. Embedding Model Download Fails
**Error:** "Failed to download model"
**Fix:** 
1. Check internet connection (first run only)
2. Model downloads to `%USERPROFILE%\.cache\huggingface\`
3. ~23MB download for all-MiniLM-L6-v2
4. Subsequent runs are offline (cached)

#### D. LanceDB Native Binary Missing
**Error:** "Cannot find module '@lancedb/lancedb'"
**Fix:** 
```bash
cd C:\interview-assistantt\interview-assistant
npm install
# Verify: node_modules/@lancedb/lancedb-win32-x64-msvc/ exists
```

---

## Issue 5: RAG Not Working (No Context Retrieved)

### Symptom
Ask a question → answer doesn't cite sources from your PDFs

### Diagnostics

1. **Check index status:**
   - Open KB window
   - Look at "Chunks" stat → should be > 0
   - "Last Indexed" should show a recent date

2. **Check DevTools console (main window):**
   - Press F12
   - Ask a question
   - Look for `[Knowledge] RAG context retrieved: X chunks`
   - If you see `[Knowledge] No index found` → rebuild index

3. **Check question relevance:**
   - RAG only retrieves relevant chunks
   - If your question is about Python but PDFs are about Guidewire → no matches
   - Try a question directly related to your PDF content

4. **Check vector search:**
   - Open KB window DevTools
   - Click Rebuild Index
   - Look for `[Knowledge] Stored X chunks in LanceDB`
   - If 0 chunks → PDFs might be empty/scanned images

---

## Issue 6: Packaged .exe Issues

### Native Modules Don't Load

**Error:** "Cannot find module '@lancedb/lancedb'" in packaged app

**Fix:** Ensure package.json has asarUnpack:
```json
{
  "build": {
    "asarUnpack": [
      "node_modules/@lancedb/**/*",
      "node_modules/@xenova/transformers/**/*"
    ]
  }
}
```

**Verify after install:**
```cmd
cd "%LOCALAPPDATA%\Programs\Interview Assistant\resources"
dir app.asar.unpacked\node_modules\@lancedb
# Should show lancedb-win32-x64-msvc folder
```

---

## Quick Diagnostic Steps

### 1. Check Main App Logs
```bash
npm start
# Watch terminal for errors during startup
```

### 2. Check KB Window Logs
1. Click 📚 → KB window opens
2. DevTools should open automatically
3. Console tab → look for `[KB]` logs
4. Any red errors?

### 3. Check IPC Registration
```bash
# Terminal should show on startup:
[Knowledge] Seeded X PDFs from development folder  # (if seed folder has PDFs)
[Knowledge] IPC handlers registered
```

### 4. Check File Paths
```powershell
# Check userData location:
cd "%APPDATA%\Interview Assistant\knowledge-base"
dir /s
# Should show: source-pdfs\, vectordb\, status.json
```

### 5. Check Dependencies
```bash
cd C:\interview-assistantt\interview-assistant
npm list @lancedb/lancedb
npm list @xenova/transformers
npm list pdfjs-dist
# All should show installed versions
```

---

## Success Checklist

After fixes, verify:
- [x] KB window opens and shows UI (not blank)
- [x] DevTools shows `[KB] Initialization complete`
- [x] Upload button shows file picker
- [x] PDFs copied to `%APPDATA%\...\source-pdfs\`
- [x] Rebuild Index completes (status: "Ready")
- [x] Stats show chunk count > 0
- [x] Ask question in main window → sees `[Knowledge] RAG context retrieved`
- [x] Answer cites sources from your PDFs

---

## Still Having Issues?

### Enable Full Logging
Open `src/services/knowledge/ragIndexingService.js` and set:
```javascript
const DEBUG = true; // line 5
```

Then check terminal for detailed logs during indexing.

### Check System Resources
- **Disk space**: Needs ~500MB for embeddings + vector DB
- **Memory**: Needs ~2GB RAM during indexing
- **Network**: First run needs internet to download embedding model

### Common Gotchas
- ❌ PDFs are scanned images (no text) → 0 chunks created
- ❌ PDFs are password-protected → extraction fails
- ❌ Antivirus blocking file operations → disable temporarily
- ❌ Windows path too long (>260 chars) → use shorter folder names
- ❌ Running multiple instances → close all, restart one

---

## Getting Help

If still stuck:
1. Open DevTools (F12) in both main window and KB window
2. Copy all console errors (red text)
3. Check terminal logs from `npm start`
4. Note: What action triggered the error?
5. Note: Dev mode or packaged .exe?
