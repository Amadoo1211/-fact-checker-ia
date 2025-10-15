const pdf = require('pdf-parse');
const fs = require('fs/promises');

async function extractPdfText(filePath) {
  const data = await fs.readFile(filePath);
  const result = await pdf(data);
  return result.text || '';
}

module.exports = { extractPdfText };
