const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
/**
 * STEP 1: Extract raw text from PDF
 * (Node 18 / Render safe)
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
 * STEP 3: Detect sections, instructions, passages
 */
function detectStructure(text) {
  const sectionRegex = /(SECTION|Section)\s+([A-E])/g;
  const matches = [...text.matchAll(sectionRegex)];

  const sections = [];

  for (let i = 0; i < matches.length; i++) {
    const sectionLetter = matches[i][2];
    const startIndex = matches[i].index;
    const endIndex =
      i + 1 < matches.length ? matches[i + 1].index : text.length;

    const sectionText = text.slice(startIndex, endIndex).trim();
    sections.push(parseSection(sectionLetter, sectionText));
  }

  return sections;
}

/**
 * Parse one section block
 */
function parseSection(section, text) {
  const cleaned = text.replace(/(SECTION|Section)\s+[A-E]/i, "").trim();

  const lines = cleaned.split("\n").map(l => l.trim()).filter(Boolean);

  let instruction = "";
  let stimulus = null;
  let bodyLines = [];

  if (
    lines.length &&
    /^(Choose|Answer|Read|In the following|Study)/i.test(lines[0])
  ) {
    instruction = lines.shift();
  }

  const firstQuestionIndex = lines.findIndex(line => /^\d+\./.test(line));

  if (firstQuestionIndex > 0) {
    const possiblePassage = lines.slice(0, firstQuestionIndex).join(" ");
    if (possiblePassage.length > 150) {
      stimulus = { type: "passage", content: possiblePassage };
      bodyLines = lines.slice(firstQuestionIndex);
    } else {
      bodyLines = lines;
    }
  } else {
    bodyLines = lines;
  }

  return {
    section,
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
