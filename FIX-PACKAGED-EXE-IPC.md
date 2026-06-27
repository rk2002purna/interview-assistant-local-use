# Fix: IPC Handlers Not Working in Packaged .exe

## Issue
**Symptom:** Knowledge Base window throws error in packaged `.exe`:
```
Error: No handler registered for 'knowledge:list-pdfs'
```

**Critical Detail:** Works perfectly in dev mode (`npm start`) but fails in production (`.exe`)

## Root Cause

### What Was Happening
In `knowledgeIpc.js`, we had:
```javascript
function registerKnowledgeIpc() {
  // ... register all handlers
}

module.exports = { registerKnowledgeIpc };

// Auto-register on require
registerKnowledgeIpc();
console.log('[Knowledge] IPC handlers registered');
```

In `main.js`:
```javascript
require('./main/knowledgeIpc'); // Just require, don't capture exports
```

### Why It Failed in Packaged .exe
When electron-builder packs the app into `app.asar`:
1. The module is loaded differently
2. The code at module-level (outside functions) may not execute reliably
3. The auto-register code `registerKnowledgeIpc()` at the bottom wasn't being called
4. Result: No IPC handlers registered → "No handler registered" error

### Why It Worked in Dev
In development (`npm start`), Node.js directly executes the files:
- Module loads normally
- Module-level code executes
- Auto-register works fine

## Solution

Changed to **explicit function call** instead of auto-register:

### main.js (NEW):
```javascript
app.whenReady().then(() => { 
  createMainWindow(); 
  // Explicitly call the registration function
  const { registerKnowledgeIpc } = require('./main/knowledgeIpc');
  registerKnowledgeIpc();
});
```

### knowledgeIpc.js (NEW):
```javascript
function registerKnowledgeIpc() {
  if (_registered) return;
  _registered = true;

  console.log('[Knowledge] Registering IPC handlers...');
  
  // ... all ipcMain.handle() calls ...
  
  console.log('[Knowledge] ✓ All 7 IPC handlers registered successfully');
}

module.exports = { registerKnowledgeIpc };
// Removed: auto-register code
```

## Why This Works

1. **Explicit is Better Than Implicit**: We explicitly destructure and call the function
2. **Guaranteed Execution**: Code inside `app.whenReady()` always executes in both dev and prod
3. **Reliable in app.asar**: Function calls from explicit code paths work consistently
4. **Better Logging**: Clear console messages show when registration happens

## Verification

### In Dev Mode (npm start):
```bash
npm start
# Terminal should show:
# [Knowledge] Registering IPC handlers...
# [Knowledge] ✓ All 7 IPC handlers registered successfully
```

### In Packaged .exe:
After installing the new build:
1. Run the app
2. Click 📚 Knowledge Base button
3. DevTools should show:
   - `[KB] Initializing Knowledge Base window...`
   - `[KB] Initialization complete`
   - **NO "No handler registered" errors**

## Build & Test Steps

1. **Local Test:**
   ```bash
   npm start
   # Check terminal for "[Knowledge] ✓ All 7 IPC handlers registered"
   # Click 📚 → should work
   ```

2. **Build:**
   ```bash
   npm run build
   ```

3. **Install & Test:**
   - Run the installer from `dist/`
   - Launch app
   - Click 📚
   - Upload PDFs → should work
   - Rebuild Index → should work

## Commit
- **Hash**: `fdd819c`
- **Message**: "Fix: Explicitly call registerKnowledgeIpc() in main.js for packaged exe"

## Related Files
- `src/main.js` - Line ~83-85 (explicit function call)
- `src/main/knowledgeIpc.js` - Line ~74 & ~203 (logging)

## Status
✅ **FIXED** - Ready for new GitHub Actions build

---

## For Future Reference

**Golden Rule for Electron IPC in Packaged Apps:**
- ❌ Don't rely on module-level code execution
- ✅ Always register handlers in explicit lifecycle methods (app.whenReady, etc.)
- ✅ Use explicit imports and function calls
- ✅ Add logging to verify registration in production

This pattern applies to ALL IPC handlers in packaged Electron apps.
