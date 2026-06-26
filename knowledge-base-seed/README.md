# Development PDF Seed Folder

## Purpose
This folder allows you to **pre-load PDFs during development** without manually uploading them through the UI.

## How It Works
1. Place your Guidewire PDFs in this folder: `knowledge-base-seed/`
2. Start the app: `npm start`
3. On first load, PDFs are automatically copied to `%APPDATA%\Interview Assistant\knowledge-base\source-pdfs\`
4. You can then click "Rebuild Index" in the Knowledge Base window

## Important Notes
- ✅ **Dev only**: This only works in development mode (`npm start`)
- ✅ **First time only**: PDFs are only copied if they don't already exist in userData
- ✅ **Not in .exe**: This folder is NOT included in the packaged executable
- ✅ **Real location**: The actual PDFs are stored in `%APPDATA%\Interview Assistant\knowledge-base\`

## Example
```
knowledge-base-seed/
  ├── PolicyCenter-Admin-Guide.pdf
  ├── ClaimCenter-Developer-Guide.pdf
  └── Guidewire-Studio-Reference.pdf
```

After `npm start`:
```
%APPDATA%\Interview Assistant\knowledge-base\source-pdfs\
  ├── PolicyCenter-Admin-Guide.pdf
  ├── ClaimCenter-Developer-Guide.pdf
  └── Guidewire-Studio-Reference.pdf
```

## Why Not Just Put PDFs in src/?
- `src/` gets packed into `app.asar` (read-only)
- User data must be writable (uploads, deletes, updates)
- PDFs in `src/` won't work in the packaged `.exe`

This seed folder is purely a **development convenience** so you don't have to click "Upload" every time you delete and rebuild the knowledge base during testing.
