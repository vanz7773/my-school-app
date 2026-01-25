const fs = require("fs");

/**
 * STEP 1: Extract raw text from PDF
 * (Node 18 / Render safe)
 */
async function extractPdfText(pdfPath) {
  const buffer = fs.readFileSync(pdfPath);

  const mod = await import("pdf-parse");

  // 🔥 unwrap until we get the actual function
  let pdfParse = mod;
  while (pdfParse && typeof pdfParse !== "function") {
    pdfParse = pdfParse.default;
  }

  if (typeof pdfParse !== "function") {
    throw new Error("Failed to load pdf-parse as a function");
  }

  const data = await pdfParse(buffer);
  return data.text || "";
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
