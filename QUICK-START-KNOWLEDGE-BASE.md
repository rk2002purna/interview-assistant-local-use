# Knowledge Base — Quick Start Guide

## 🎯 What It Does
Uploads your Guidewire PDFs (PolicyCenter, ClaimCenter, BillingCenter docs), indexes them locally, and retrieves relevant excerpts when you ask interview questions — so the AI can cite specific pages instead of guessing.

---

## 🚀 5-Minute Setup

### Step 1: Start the App
```bash
cd C:\interview-assistantt\interview-assistant
npm start
```

### Step 2: Open Knowledge Base
- Click the **📚** button in the titlebar (purple book icon)
- Knowledge Base window opens

### Step 3: Upload Your PDFs
- Click **"📄 Upload PDFs"**
- Select 5-10 Guidewire PDFs (admin guides, developer docs, etc.)
- They appear in the list with size and date

### Step 4: Build the Index
- Click **"🔄 Rebuild Index"**
- Wait ~30 seconds per 100 pages (first run downloads 23MB embedding model)
- Status changes to **"✅ Ready — 234 chunks indexed"**

### Step 5: Ask a Question
- Go back to the **main Interview Assistant window**
- Type a question like:
  - *"Explain the ClaimCenter loss adjustor workflow"*
  - *"How do I configure PolicyCenter underwriting rules?"*
- Press Enter or click Ask
- The answer will cite your uploaded PDFs: *"According to PolicyCenter Admin Guide (Page 12)..."*

---

## 📂 Where Files Live

All data is stored locally in:
```
%APPDATA%\Interview Assistant\knowledge-base\
  ├── source-pdfs\        ← Your uploaded PDFs
  ├── vectordb\           ← Local database (LanceDB)
  └── status.json         ← Index metadata
```

To find it: Press `Win+R` → type `%APPDATA%\Interview Assistant\knowledge-base\` → Enter

---

## 🔄 Update the Index

When you add new PDFs:
1. Upload new PDFs in the Knowledge Base window
2. Click **"🔄 Rebuild Index"** again
3. Old + new PDFs are re-indexed together

---

## 🗑️ Delete Everything

To start fresh or remove all KB data:
1. Open Knowledge Base window
2. Click **"🗑️ Delete Knowledge Base"**
3. Confirm
4. All PDFs, database, and status deleted
5. Questions now use normal AI (no RAG) until you rebuild

---

## 💡 Tips

### Better Answers
- Upload high-quality PDFs (OCR text-based, not scanned images)
- Include relevant Guidewire modules (PolicyCenter, ClaimCenter, etc.)
- More PDFs = better coverage (but longer indexing time)

### Faster Indexing
- First run: ~1-2 minutes (downloads embedding model once)
- Subsequent runs: ~20-30 seconds per 100 pages
- Close other apps if your machine is slow

### Debugging
- Press **F12** in the main window to see console logs
- Look for `[Knowledge]` logs during indexing and queries
- If something fails, check the console for error messages

---

## 🎓 Example Questions That Work Well

With Guidewire PDFs uploaded:
- *"What is the difference between Policy and Account in Guidewire?"*
- *"Explain the ClaimCenter FNOL process"*
- *"How do I create a custom rule in PolicyCenter?"*
- *"What are the main ClaimCenter entities and their relationships?"*
- *"How does BillingCenter handle invoice generation?"*

Without Knowledge Base (normal AI):
- General software questions
- Behavioral interview questions
- Non-Guidewire technical questions

---

## 🛠️ Troubleshooting

### "No PDFs found" error
→ You haven't uploaded any PDFs yet. Click "Upload PDFs" first.

### Indexing stuck / slow
→ First run downloads a 23MB model (one-time). Check your internet connection. Subsequent runs are much faster.

### Upload button doesn't work
→ Check Windows permissions. Try running as Administrator once.

### RAG not working (no sources cited)
→ Open DevTools (F12), check for `[Knowledge]` logs. If status is "Not indexed", rebuild the index.

### App won't start after build
→ Ensure `npm run build` completed. Check `dist/` folder for the .exe installer.

---

## 📊 What Happens Under the Hood

1. **Upload**: PDFs copied to `%APPDATA%\...\source-pdfs\`
2. **Extract**: Text extracted page-by-page from each PDF
3. **Chunk**: Text split into ~2500 character chunks with overlap
4. **Embed**: Each chunk converted to a 384-dimension vector (all-MiniLM-L6-v2 local model)
5. **Store**: Vectors stored in LanceDB (local embedded database)
6. **Query**: Your question is converted to a vector → top-5 most similar chunks retrieved → sent to AI with your question
7. **Answer**: AI sees the relevant excerpts + your question → cites sources in the response

**Privacy**: Everything happens locally. No PDFs or chunks are sent to external servers except the final top-5 excerpts (≤8000 chars) included in the LLM prompt.

---

## 🎉 You're Ready!

Upload your PDFs, rebuild the index, and start asking Guidewire questions with citations. Good luck with your interviews! 🚀
