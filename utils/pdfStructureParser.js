const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

/**
 * Universal Exam Parser for BECE and other exam formats
 * Supports: Paper 1 (Objective), Paper 2 (Essay), Paper 3 (Practical), etc.
 */

// Configuration for different exam patterns
const EXAM_PATTERNS = {
  BECE: {
    paperTypes: [
      { 
        name: "ESSAY", 
        keywords: ["paper 2", "essay", "answer four questions", "show workings"],
        numbering: /^\d+\.\s/,
        partMarkers: [/^\([a-d]\)/i, /^\([i-v]+\)/i]
      },
      { 
        name: "OBJECTIVE", 
        keywords: ["paper 1", "objective", "answer all questions", "multiple choice", "options a to d"],
        numbering: /^\d+\.\s/,
        optionMarkers: /^[A-D]\.\s/
      }
    ],
    commonHeaders: ["BECE", "BASIC EDUCATION CERTIFICATE", "MATHEMATICS", "ENGLISH", "SCIENCE"]
  },
  WASSCE: {
    paperTypes: [
      { name: "PAPER 1", keywords: ["paper 1", "objective"], numbering: /^\d+\.\s/ },
      { name: "PAPER 2", keywords: ["paper 2", "theory"], numbering: /^\d+\.\s/ },
      { name: "PAPER 3", keywords: ["paper 3", "practical"], numbering: /^\d+\.\s/ }
    ]
  },
  GENERAL: {
    paperTypes: [
      { name: "MULTIPLE_CHOICE", keywords: ["multiple choice", "mcq"], numbering: /^\d+\.\s/ },
      { name: "ESSAY", keywords: ["essay", "structured"], numbering: /^\d+\.\s/ },
      { name: "SHORT_ANSWER", keywords: ["short answer", "section a"], numbering: /^\d+\.\s/ }
    ]
  }
};

/**
 * 1. Extract text from any PDF with improved layout detection
 */
async function extractPdfText(pdfPath) {
  try {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    
    let fullText = "";
    const pageContents = [];
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      
      // Extract text with position for better structure
      const items = content.items.map(item => ({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height
      }));
      
      // Group by y-position (rows)
      const rows = {};
      items.forEach(item => {
        const rowKey = Math.round(item.y);
        if (!rows[rowKey]) rows[rowKey] = [];
        rows[rowKey].push(item);
      });
      
      // Sort rows top to bottom, left to right
      const sortedRows = Object.keys(rows)
        .sort((a, b) => b - a)
        .map(y => {
          return rows[y]
            .sort((a, b) => a.x - b.x)
            .map(item => item.text)
            .join(" ");
        });
      
      const pageText = sortedRows.join("\n");
      pageContents.push({
        page: pageNum,
        text: pageText,
        rawItems: items
      });
      
      fullText += pageText + "\n\n";
    }
    
    return {
      text: fullText.trim(),
      pages: pageContents,
      metadata: {
        totalPages: pdf.numPages,
        extractedAt: new Date().toISOString()
      }
    };
  } catch (error) {
    throw new Error(`PDF extraction failed: ${error.message}`);
  }
}

/**
 * 2. Detect exam format and structure
 */
function detectExamFormat(text) {
  const normalizedText = text.toLowerCase();
  let detectedFormat = "GENERAL";
  let confidence = 0;
  
  // Check for specific exam patterns
  for (const [format, pattern] of Object.entries(EXAM_PATTERNS)) {
    let matches = 0;
    const totalChecks = pattern.commonHeaders?.length || 1;
    
    // Check for format-specific headers
    if (pattern.commonHeaders) {
      pattern.commonHeaders.forEach(header => {
        if (normalizedText.includes(header.toLowerCase())) matches++;
      });
    }
    
    // Check for paper type keywords
    pattern.paperTypes.forEach(paperType => {
      paperType.keywords.forEach(keyword => {
        if (normalizedText.includes(keyword.toLowerCase())) matches++;
      });
    });
    
    const matchRatio = matches / (totalChecks + pattern.paperTypes.length * 2);
    if (matchRatio > confidence) {
      confidence = matchRatio;
      detectedFormat = format;
    }
  }
  
  return {
    format: detectedFormat,
    confidence: Math.round(confidence * 100),
    patterns: EXAM_PATTERNS[detectedFormat]
  };
}

/**
 * 3. Universal structure detector for exams
 */
function detectExamStructure(text, format = "GENERAL") {
  const sections = [];
  const patterns = EXAM_PATTERNS[format] || EXAM_PATTERNS.GENERAL;
  
  // Find all potential section starts
  const sectionMarkers = [];
  
  // Look for PAPER markers
  const paperRegex = /(?:PAPER|PAPER\s+[123]|SECTION|PART)\s*(?:[A-Z0-9]*)/gi;
  let match;
  while ((match = paperRegex.exec(text)) !== null) {
    sectionMarkers.push({
      type: "PAPER",
      label: match[0].toUpperCase(),
      index: match.index,
      text: match[0]
    });
  }
  
  // Look for question number blocks as section boundaries
  const questionStartRegex = /\n(\d+\.\s+[A-Z])/gi;
  while ((match = questionStartRegex.exec(text)) !== null) {
    sectionMarkers.push({
      type: "QUESTION_BLOCK",
      label: `Q${match[1]}`,
      index: match.index,
      text: match[0]
    });
  }
  
  // Sort markers by position
  sectionMarkers.sort((a, b) => a.index - b.index);
  
  // If no explicit sections found, try to auto-detect
  if (sectionMarkers.length === 0) {
    return autoSegmentExam(text, patterns);
  }
  
  // Create sections based on markers
  for (let i = 0; i < sectionMarkers.length; i++) {
    const marker = sectionMarkers[i];
    const startIndex = marker.index;
    const endIndex = i + 1 < sectionMarkers.length 
      ? sectionMarkers[i + 1].index 
      : text.length;
    
    const sectionText = text.substring(startIndex, endIndex).trim();
    
    // Determine section type
    let sectionType = "UNKNOWN";
    let sectionName = marker.label;
    
    // Check against known paper types
    for (const paperType of patterns.paperTypes) {
      if (paperType.keywords.some(keyword => 
        sectionText.toLowerCase().includes(keyword.toLowerCase())
      )) {
        sectionType = paperType.name;
        break;
      }
    }
    
    sections.push({
      type: sectionType,
      name: sectionName,
      startIndex,
      content: sectionText,
      detectedBy: marker.type
    });
  }
  
  return sections;
}

/**
 * 4. Auto-segment when no clear markers exist
 */
function autoSegmentExam(text, patterns) {
  const sections = [];
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  
  let currentSection = null;
  let inSection = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this line starts a new section
    let sectionType = null;
    let sectionName = "UNNAMED";
    
    for (const paperType of patterns.paperTypes) {
      if (paperType.keywords.some(keyword => 
        line.toLowerCase().includes(keyword.toLowerCase())
      )) {
        sectionType = paperType.name;
        sectionName = line.substring(0, 100); // Use first 100 chars as name
        break;
      }
    }
    
    // Check if line starts with question number
    if (/^\d+\.\s/.test(line) && !inSection) {
      sectionType = "QUESTION_BLOCK";
      sectionName = `Questions starting at: ${line.substring(0, 50)}`;
    }
    
    if (sectionType) {
      // Save previous section
      if (currentSection) {
        sections.push(currentSection);
      }
      
      // Start new section
      currentSection = {
        type: sectionType,
        name: sectionName,
        content: line,
        startLine: i
      };
      inSection = true;
    } else if (currentSection && inSection) {
      // Continue current section
      currentSection.content += "\n" + line;
    } else if (!inSection && line.length > 20) {
      // This might be the start of an unmarked section
      currentSection = {
        type: "UNMARKED",
        name: "Intro/Instructions",
        content: line,
        startLine: i
      };
      inSection = true;
    }
  }
  
  // Don't forget the last section
  if (currentSection) {
    sections.push(currentSection);
  }
  
  return sections;
}

/**
 * 5. Parse questions from any section
 */
function parseQuestions(sectionContent, sectionType) {
  const questions = [];
  const lines = sectionContent.split("\n").map(l => l.trim()).filter(Boolean);
  
  let currentQuestion = null;
  let currentPart = null;
  let questionNumber = 0;
  
  // Determine parsing strategy based on section type
  const isEssay = sectionType.includes("ESSAY") || sectionType.includes("PAPER_2");
  const isObjective = sectionType.includes("OBJECTIVE") || sectionType.includes("MULTIPLE") || sectionType.includes("PAPER_1");
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect new question (main number)
    const questionMatch = line.match(/^(\d+)\.\s*(.*)/);
    if (questionMatch) {
      if (currentQuestion) {
        questions.push(currentQuestion);
      }
      
      questionNumber = parseInt(questionMatch[1]);
      currentQuestion = {
        number: questionNumber,
        text: questionMatch[2],
        type: isEssay ? "essay" : "objective",
        parts: [],
        options: [],
        marks: null,
        images: []
      };
      
      // Reset part tracking
      currentPart = null;
      continue;
    }
    
    // For essay questions: detect parts (a), (b), etc.
    if (isEssay && currentQuestion) {
      const partMatch = line.match(/^\(([a-d])\)\s*(.*)/i);
      if (partMatch) {
        currentPart = {
          letter: partMatch[1].toLowerCase(),
          text: partMatch[2],
          subparts: []
        };
        currentQuestion.parts.push(currentPart);
        continue;
      }
      
      // Detect subparts (i), (ii), etc.
      const subpartMatch = line.match(/^\(([i-v]+)\)\s*(.*)/i);
      if (subpartMatch && currentPart) {
        currentPart.subparts.push({
          number: subpartMatch[1],
          text: subpartMatch[2]
        });
        continue;
      }
    }
    
    // For objective questions: detect options
    if (isObjective && currentQuestion) {
      const optionMatch = line.match(/^([A-D])[\.\)]\s*(.*)/i);
      if (optionMatch) {
        currentQuestion.options.push({
          letter: optionMatch[1].toUpperCase(),
          text: optionMatch[2]
        });
        continue;
      }
    }
    
    // Continue text for current element
    if (currentQuestion && line.length > 0) {
      if (currentPart) {
        if (currentPart.subparts.length > 0) {
          // Append to last subpart
          const lastSubpart = currentPart.subparts[currentPart.subparts.length - 1];
          lastSubpart.text += " " + line;
        } else {
          currentPart.text += " " + line;
        }
      } else if (currentQuestion.options.length > 0) {
        // Append to last option
        const lastOption = currentQuestion.options[currentQuestion.options.length - 1];
        lastOption.text += " " + line;
      } else {
        currentQuestion.text += " " + line;
      }
    }
  }
  
  // Add the last question
  if (currentQuestion) {
    questions.push(currentQuestion);
  }
  
  // Post-process questions
  return questions.map(q => ({
    ...q,
    text: cleanText(q.text),
    // Try to extract marks if present
    marks: extractMarks(q.text) || (isEssay ? 10 : 1) // Default marks
  }));
}

/**
 * 6. Main parsing function - parseExamPdf
 */
async function parseExamPdf(pdfPath, options = {}) {
  const {
    detectFormat = true,
    extractQuestions = true,
    maxPages = 50,
    language = "en"
  } = options;
  
  try {
    // Step 1: Extract text from PDF
    const extractionResult = await extractPdfText(pdfPath);
    
    // Step 2: Detect exam format
    let formatInfo = { format: "GENERAL", confidence: 0 };
    if (detectFormat) {
      formatInfo = detectExamFormat(extractionResult.text);
    }
    
    // Step 3: Detect structure
    const sections = detectExamStructure(extractionResult.text, formatInfo.format);
    
    // Step 4: Parse questions if requested
    let parsedSections = sections;
    if (extractQuestions) {
      parsedSections = sections.map(section => ({
        ...section,
        questions: parseQuestions(section.content, section.type),
        questionCount: 0 // Will be updated after parsing
      }));
      
      // Update question counts
      parsedSections.forEach(section => {
        if (section.questions) {
          section.questionCount = section.questions.length;
        }
      });
    }
    
    // Step 5: Generate metadata
    const metadata = {
      totalPages: extractionResult.metadata.totalPages,
      totalSections: sections.length,
      examFormat: formatInfo.format,
      confidenceScore: formatInfo.confidence,
      extractionDate: extractionResult.metadata.extractedAt,
      totalQuestions: parsedSections.reduce((sum, sec) => sum + (sec.questionCount || 0), 0)
    };
    
    // Step 6: Identify common patterns (for future improvements)
    const patterns = analyzeExamPatterns(extractionResult.text, parsedSections);
    
    return {
      success: true,
      metadata,
      format: formatInfo,
      sections: parsedSections,
      patterns,
      raw: {
        text: extractionResult.text.substring(0, 1000) + "...", // First 1000 chars
        totalLength: extractionResult.text.length
      }
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    };
  }
}

/**
 * 7. parsePdfStructure function - The function your route is calling
 * This is a wrapper around parseExamPdf to match the expected structure
 */
async function parsePdfStructure(pdfPath, options = {}) {
  try {
    // Use parseExamPdf as the main parser
    const result = await parseExamPdf(pdfPath, options);
    
    // Transform the result to match the expected structure from your route
    if (result.success) {
      return {
        sections: result.sections.map(section => ({
          paper: section.type || section.name,
          instruction: extractInstructions(section.content),
          stimulus: section.content ? { 
            type: "text", 
            content: section.content.substring(0, 500) + (section.content.length > 500 ? "..." : "")
          } : null,
          bodyText: section.content,
          questions: section.questions || [],
          questionCount: section.questionCount || 0
        }))
      };
    } else {
      throw new Error(result.error || "Failed to parse PDF");
    }
  } catch (error) {
    console.error("parsePdfStructure error:", error);
    throw error;
  }
}

/**
 * Helper: Extract instructions from section content
 */
function extractInstructions(content) {
  if (!content) return "";
  
  const lines = content.split("\n").map(l => l.trim()).filter(Boolean);
  let instructions = [];
  
  // Look for instruction-like lines (usually at the beginning)
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const line = lines[i];
    if (line.match(/^(Answer|Read|Study|Attempt|Do not|Write your|This booklet|Each question)/i)) {
      instructions.push(line);
    } else if (line.length < 100 && instructions.length > 0) {
      // Continue if line is short and we're already collecting instructions
      instructions.push(line);
    } else if (instructions.length > 0) {
      // Stop if we hit a long line (likely question text)
      break;
    }
  }
  
  return instructions.join(" ").substring(0, 300);
}

/**
 * 8. Helper functions
 */
function cleanText(text) {
  if (!text) return "";
  
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/([.,;:])\s+/g, "$1 ")
    .replace(/image\[\[.*?\]\]/g, "[IMAGE]")
    .replace(/[\u00A0\u200B\uFEFF]/g, " ")
    .trim();
}

function extractMarks(text) {
  const markMatch = text.match(/\[(\d+)\s*(?:marks?|points?)\]/i);
  if (markMatch) return parseInt(markMatch[1]);
  
  const parenMatch = text.match(/\((\d+)\s*(?:m|marks?)\)/i);
  if (parenMatch) return parseInt(parenMatch[1]);
  
  return null;
}

function analyzeExamPatterns(text, sections) {
  const patterns = {
    questionNumbering: [],
    hasMultipleChoice: false,
    hasEssayQuestions: false,
    hasParts: false,
    hasImages: false,
    commonTerms: []
  };
  
  // Check each section
  sections.forEach(section => {
    if (section.questions) {
      section.questions.forEach(q => {
        if (q.type === "objective") patterns.hasMultipleChoice = true;
        if (q.type === "essay") patterns.hasEssayQuestions = true;
        if (q.parts && q.parts.length > 0) patterns.hasParts = true;
        if (q.text.includes("[IMAGE]")) patterns.hasImages = true;
      });
    }
  });
  
  // Find common question numbering patterns
  const numberingMatches = text.match(/\b(\d+\.)\s+[A-Z]/g);
  if (numberingMatches) {
    patterns.questionNumbering = [...new Set(numberingMatches.map(m => m.split(".")[0] + "."))];
  }
  
  // Find common terms
  const commonExamTerms = ["solve", "calculate", "find", "show", "prove", "explain", "describe"];
  patterns.commonTerms = commonExamTerms.filter(term => 
    text.toLowerCase().includes(term.toLowerCase())
  );
  
  return patterns;
}

/**
 * 9. Export functions for different use cases
 */
module.exports = {
  // Main parsing functions
  parsePdfStructure,  // <- This is the function your route is calling
  parseExamPdf,       // Alternative main function
  
  // Individual components for customization
  extractPdfText,
  detectExamFormat,
  detectExamStructure,
  parseQuestions,
  
  // Configuration
  EXAM_PATTERNS,
  
  // Utilities
  cleanText,
  extractMarks,
  extractInstructions,
  
  // Version info
  version: "2.0.0",
  description: "Universal Exam PDF Parser for BECE, WASSCE, and other exam formats"
};