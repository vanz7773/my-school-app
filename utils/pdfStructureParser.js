const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

/**
 * STEP 1: Extract raw text from PDF
 * (Stable on Node 18 / Render)
 */
async function extractPdfText(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;

  let fullText = "";

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const pageText = content.items.map(item => item.str).join(" ");
    fullText += pageText + "\n";
  }

  return fullText.trim();
}

/**
 * STEP 2: Normalize PDF text
 */
function normalizeText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+\n/g, "\n")
    .trim();
}

/**
 * STEP 3: Detect PAPER 1 / PAPER 2
 * (BECE-aware, with safe fallback)
 */
function detectStructure(text) {
  const paperRegex = /(PAPER\s+[12])/gi;
  const matches = [...text.matchAll(paperRegex)];

  // 🔹 Fallback: no explicit PAPER found
  if (matches.length === 0) {
    return [
      parsePaper("PAPER", text)
    ];
  }

  const sections = [];

  for (let i = 0; i < matches.length; i++) {
    const paperLabel = matches[i][1].toUpperCase();
    const startIndex = matches[i].index;
    const endIndex =
      i + 1 < matches.length ? matches[i + 1].index : text.length;

    const paperText = text.slice(startIndex, endIndex).trim();
    sections.push(parsePaper(paperLabel, paperText));
  }

  return sections;
}

/**
 * Parse one PAPER block
 */
function parsePaper(paper, text) {
  // Remove "PAPER 1 / PAPER 2" heading
  const cleaned = text.replace(/PAPER\s+[12]/i, "").trim();

  const lines = cleaned.split("\n").map(l => l.trim()).filter(Boolean);

  let instruction = "";
  let stimulus = null;
  let bodyLines = [];

  // Detect instruction (usually first line)
  if (
    lines.length &&
    /^(Choose|Answer|Read|In the following|Study|Attempt)/i.test(lines[0])
  ) {
    instruction = lines.shift();
  }

  // Detect passage (before numbered questions)
  const firstQuestionIndex = lines.findIndex(line => /^\d+\./.test(line));

  if (firstQuestionIndex > 0) {
    const possiblePassage = lines.slice(0, firstQuestionIndex).join(" ");
    if (possiblePassage.length > 150) {
      stimulus = {
        type: "passage",
        content: possiblePassage,
      };
      bodyLines = lines.slice(firstQuestionIndex);
    } else {
      bodyLines = lines;
    }
  } else {
    bodyLines = lines;
  }

  return {
    paper,              // "PAPER 1" | "PAPER 2"
    instruction,
    stimulus,
    bodyText: bodyLines.join("\n"),
  };
}

/**
 * MAIN ENTRY
 */
async function parsePdfStructure(pdfPath) {
  const rawText = await extractPdfText(pdfPath);
  const normalizedText = normalizeText(rawText);
  const sections = detectStructure(normalizedText);

  return { sections };
}

module.exports = { parsePdfStructure };
