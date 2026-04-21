/**
 * Standalone ingestion script.
 * Drop files into the knowledge/ folder, then run: node ingest.js
 * Optionally pass a specific file: node ingest.js knowledge/myfile.pdf
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ingestDocument } = require("./services/rag");

const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");

async function main() {
  const target = process.argv[2];

  if (target) {
    // Single file mode
    const result = await ingestDocument(path.resolve(target));
    console.log("Result:", result);
    return;
  }

  // Batch mode — ingest everything in knowledge/
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    fs.mkdirSync(KNOWLEDGE_DIR);
    console.log("Created knowledge/ folder. Drop files in there and re-run.");
    return;
  }

  const files = fs.readdirSync(KNOWLEDGE_DIR).filter((f) => !f.startsWith("."));
  if (files.length === 0) {
    console.log("No files found in knowledge/. Drop files in there and re-run.");
    return;
  }

  for (const file of files) {
    try {
      const result = await ingestDocument(path.join(KNOWLEDGE_DIR, file));
      console.log(`✓ ${result.fileName} — ${result.chunks} chunks (${result.docType})`);
    } catch (err) {
      console.error(`✗ ${file}:`, err.message);
    }
  }
}

main().catch(console.error);
