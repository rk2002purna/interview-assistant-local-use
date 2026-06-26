# Fix: IPC Handlers Not Registered

## Error
```
Error: No handler registered for 'knowledge:list-pdfs'
```

## Root Cause
The `knowledgeIpc.js` file exported a function `registerKnowledgeIpc()` but it was never called. 

**Before:**
```javascript
// knowledgeIpc.js
function registerKnowledgeIpc() {
  // ... all the ipcMain.handle() calls
}
module.exports = { registerKnowledgeIpc };

// main.js
require('./main/knowledgeIpc'); // ← Just required the module, didn't call the function
```

The handlers were defined inside `registerKnowledgeIpc()` but that function was never invoked, so `ipcMain.handle()` was never called.

## Solution
Added auto-registration at the end of `knowledgeIpc.js`:

```javascript
module.exports = { registerKnowledgeIpc };

// Auto-register on require
registerKnowledgeIpc();
console.log('[Knowledge] IPC handlers registered');
```

Now when `main.js` does `require('./main/knowledgeIpc')`, the handlers are automatically registered.

## Verify the Fix

1. **Restart the app:**
   ```bash
   npm start
   ```

2. **Check terminal output:**
   You should see:
   ```
   [Knowledge] IPC handlers registered
   ```

3. **Open Knowledge Base window:**
   - Click 📚 button
   - Window should show UI (not blank)
   - DevTools console should show:
     ```
     [KB] Initializing Knowledge Base window...
     [KB] Initialization complete
     ```

4. **No more errors:**
   - No "No handler registered" errors
   - All buttons should work

## Status
✅ **FIXED** - Handlers now auto-register on module load
