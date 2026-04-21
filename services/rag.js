require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Pinecone } = require("@pinecone-database/pinecone");
const { Mistral } = require("@mistralai/mistralai");

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });
const INDEX_NAME = process.env.PINECONE_INDEX || "sonic-rag";

// ─── Text Extraction ─────────────────────────────────────────────────────────
function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}


async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".txt" || ext === ".md") return fs.readFileSync(filePath, "utf-8");

  if (ext === ".docx" || ext === ".doc") {
    const mammoth = require("mammoth");
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  if (ext === ".csv") return fs.readFileSync(filePath, "utf-8");

  if (ext === ".xlsx" || ext === ".xls") {
    const XLSX = require("xlsx");
    const wb = XLSX.readFile(filePath);
    return wb.SheetNames.map((n) => `Sheet: ${n}\n${XLSX.utils.sheet_to_csv(wb.Sheets[n])}`).join("\n\n");
  }

  if (ext === ".pdf") {
    const { PDFParse } = require("pdf-parse");
    const parser = new PDFParse({ data: fs.readFileSync(filePath) });
    const result = await parser.getText();
    return result.pages.map((p) => p.text).join("\n");
  }

  // images / pptx → Mistral OCR
  const base64 = fs.readFileSync(filePath).toString("base64");
  const response = await mistral.ocr.process({
    model: "mistral-ocr-latest",
    document: { type: "document_url", documentUrl: `data:application/octet-stream;base64,${base64}` },
    includeImageBase64: false,
  });
  return response.pages.map((p) => p.markdown).join("\n\n");
}

let _embedder = null;
async function embed(text) {
  if (!_embedder) {
    const { pipeline } = await import("@xenova/transformers");
    _embedder = await pipeline("feature-extraction", "Xenova/bge-small-en-v1.5");
  }
  const out = await _embedder(text, { pooling: "mean", normalize: true });
  return Array.from(out.data);
}


// ─── Chunking ────────────────────────────────────────────────────────────────

function chunkText(text, maxChars = 2048, overlapChars = 200) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const paraBreak = text.lastIndexOf("\n\n", end);
      const sentBreak = text.lastIndexOf(". ", end);
      if (paraBreak > start + maxChars * 0.5) end = paraBreak;
      else if (sentBreak > start + maxChars * 0.5) end = sentBreak + 1;
    }
    const chunk = text.slice(start, end).trim();
    if (chunk.length > 50) chunks.push(chunk);
    start = Math.max(start + 1, end - overlapChars); // always advance
  }
  return chunks;
}

async function semanticChunk(text, maxChars = 2048, threshold = 0.5) {
  const chunks = [];
  const sentences = text.split('\n').filter(s => s.trim().length > 0);
  let prevEmbed = await embed(sentences[0]);
  let presentChunk = sentences[0];

  for (let i = 1; i < sentences.length; i++) {
    const currEmbed = await embed(sentences[i]);
    if (presentChunk.length + sentences[i].length <= maxChars && cosineSim(currEmbed, prevEmbed) >= threshold) {
      presentChunk += '\n' + sentences[i];
    } else {
      chunks.push(presentChunk);
      presentChunk = sentences[i];
    }
    prevEmbed = currEmbed;
  }

  chunks.push(presentChunk); 
  return chunks.filter(c => c.trim().length > 0);
}


// ─── Ingest ──────────────────────────────────────────────────────────────────

async function ingestDocument(filePath, metadata = {}) {
  const fileName = path.basename(filePath);
  console.log(`[RAG] Ingesting ${fileName}...`);

  const text = await extractText(filePath);
  const chunks = chunkText(text);
  console.log(`[RAG] ${chunks.length} chunks`);

  const index = pinecone.index({ name: INDEX_NAME });

  // Pinecone native embedding — send text directly, no local model needed
  const records = chunks.map((chunk, i) => ({
    id: `${fileName}-${i}`,
    text: chunk,
    source: fileName,
    chunkIndex: i,
    uploadedAt: new Date().toISOString(),
    ...metadata,
  }));

  for (let i = 0; i < records.length; i += 90) {
    await index.upsertRecords({ records: records.slice(i, i + 90) });
    console.log(`[RAG] Upserted ${Math.min(i + 90, records.length)}/${records.length}`);
    if (i + 90 < records.length) await new Promise((r) => setTimeout(r, 8000)); // respect rate limit
  }

  console.log(`[RAG] Done`);
  return { success: true, fileName, chunks: records.length };
}

// ─── Query ───────────────────────────────────────────────────────────────────

async function queryRAG(query, topK = 5) {
  const index = pinecone.index({ name: INDEX_NAME });

  const results = await index.searchRecords({
    query: { inputs: { text: query }, topK },
  });

  return (results.result?.hits || []).slice(0, 3).map((h) => ({
    text: h.fields?.text,
    source: h.fields?.source,
    score: h._score,
  }));
}



module.exports = { ingestDocument, queryRAG };
