# Bug Fix: Knowledge.html Upload Button Error

## Issue
When clicking the "Upload PDFs" button in the Knowledge Base window, the error occurred:
```
"Upload error: Cannot read properties of undefined (reading 'selectPdfs')"
```

## Root Cause
The knowledge.html window was trying to use `window.knowledgeBase.selectPdfs()`, but `window.knowledgeBase` is only exposed in the main window via the preload.js bridge. The Knowledge Base window is a separate `BrowserWindow` instance that doesn't have access to that preload bridge.

## Solution
Changed knowledge.html to use direct IPC calls via `ipcRenderer.invoke()` instead of going through the preload bridge.

### Before (Broken):
```javascript
const res = await window.knowledgeBase.selectPdfs();
```

### After (Fixed):
```javascript
const { ipcRenderer } = require('electron');
const res = await ipcRenderer.invoke('knowledge:select-pdfs');
```

## Changes Made
Replaced all `window.knowledgeBase.*` calls in knowledge.html with direct `ipcRenderer.invoke()` calls:

1. `window.knowledgeBase.selectPdfs()` → `ipcRenderer.invoke('knowledge:select-pdfs')`
2. `window.knowledgeBase.listPdfs()` → `ipcRenderer.invoke('knowledge:list-pdfs')`
3. `window.knowledgeBase.getStats()` → `ipcRenderer.invoke('knowledge:stats')`
4. `window.knowledgeBase.getStatus()` → `ipcRenderer.invoke('knowledge:status')`
5. `window.knowledgeBase.rebuildIndex()` → `ipcRenderer.invoke('knowledge:rebuild-index')`
6. `window.knowledgeBase.deleteKnowledgeBase()` → `ipcRenderer.invoke('knowledge:delete')`

## Why This Works
Both the main window and Knowledge Base window have:
- `nodeIntegration: true`
- `contextIsolation: false`

This means both can directly use `require('electron')` and call `ipcRenderer.invoke()`. The preload bridge (`window.knowledgeBase`) is only needed for the main window's convenience since index.html uses it extensively.

## Testing
After this fix:
1. Start the app: `npm start`
2. Click 📚 Knowledge Base button
3. Click "Upload PDFs" → file dialog should open
4. Select PDFs → they should be copied and listed
5. All other buttons (Rebuild Index, Delete) should work

Status: **FIXED** ✅
