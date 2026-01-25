const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

/**
 * Enhanced Exam Parser for BECE and other exam formats
 * Focused on PAPER 1 and PAPER 2 detection
 */

// Enhanced configuration for exam patterns with explicit paper detection
const EXAM_PATTERNS = {
  BECE: {
    papers: [
      {
        id: "PAPER 1",
        name: "OBJECTIVE",
        markers: [
          "paper 1", 
          "answer all questions", 
          "each question is followed by four options",
          "multiple choice",
          "options a to d",
          "shade in pencil"
        ],
        type: "objective",
        questionPattern: /^\d+\.\s/
      },
      {
        id: "PAPER 2", 
        name: "ESSAY",
        markers: [
          "paper 2",
          "essay",
          "answer four questions only",
          "show workings",
          "marks will not be awarded"
        ],
        type: "essay",
        questionPattern: /^\d+\.\s/
      }
    ],
    commonHeaders: ["BECE", "BASIC EDUCATION CERTIFICATE EXAMINATION", "MATHEMATICS"]
  },
  WASSCE: {
    papers: [
      { id: "PAPER 1", name: "OBJECTIVE", markers: ["paper 1", "objective"], type: "objective" },
      { id: "PAPER 2", name: "ESSAY/THEORY", markers: ["paper 2", "essay", "theory"], type: "essay" },
      { id: "PAPER 3", name: "PRACTICAL", markers: ["paper 3", "practical"], type: "practical" }
    ]
  },
  GENERAL: {
    papers: [
      { id: "PAPER 1", name: "OBJECTIVE", markers: ["paper 1", "objective", "multiple choice"], type: "objective" },
      { id: "PAPER 2", name: "ESSAY", markers: ["paper 2", "essay", "structured"], type: "essay" }
    ]
  }
};

/**
 * 1. Extract text from PDF with improved paper detection
 */
async function extractPdfText(pdfPath) {
  try {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    
    let fullText = "";
    const pages = [];
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      
      // Group text by lines
      const lines = {};
      for (const item of content.items) {
        const y = Math.round(item.transform[5]);
        if (!lines[y]) lines[y] = [];
        lines[y].push({
          text: item.str,
          x: item.transform[4]
        });
      }
      
      // Sort lines and join text
      const pageLines = Object.keys(lines)
        .sort((a, b) => b - a)
        .map(y => {
          return lines[y]
            .sort((a, b) => a.x - b.x)
            .map(item => item.text)
            .join(" ");
        });
      
      const pageText = pageLines.join("\n");
      pages.push({
        page: pageNum,
        text: pageText,
        lines: pageLines
      });
      
      fullText += pageText + "\n\n";
    }
    
    return {
      text: fullText.trim(),
      pages,
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
 * 2. Detect and extract PAPER 1 and PAPER 2 sections
 */
function detectPapers(text, format = "BECE") {
  const papers = [];
  const patterns = EXAM_PATTERNS[format] || EXAM_PATTERNS.GENERAL;
  const textLower = text.toLowerCase();
  
  // Initialize papers array with default structure
  patterns.papers.forEach(paperConfig => {
    papers.push({
      id: paperConfig.id,
      name: paperConfig.name,
      type: paperConfig.type,
      content: "",
      detected: false,
      startIndex: -1,
      endIndex: -1,
      markersFound: []
    });
  });
  
  // First pass: Find paper markers in text
  const lines = text.split("\n");
  
  papers.forEach(paper => {
    const paperConfig = patterns.papers.find(p => p.id === paper.id);
    
    // Look for paper markers in each line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      
      // Check if this line contains any marker for this paper
      const matchingMarker = paperConfig.markers.find(marker => 
        line.includes(marker.toLowerCase())
      );
      
      if (matchingMarker && !paper.detected) {
        paper.detected = true;
        paper.startIndex = i;
        paper.markersFound.push(matchingMarker);
        
        // Look for paper boundary (next paper or end)
        for (let j = i + 1; j < lines.length; j++) {
          const nextLine = lines[j].toLowerCase();
          
          // Check if next paper starts
          const nextPaper = patterns.papers.find(p => 
            p.id !== paper.id && 
            p.markers.some(m => nextLine.includes(m.toLowerCase()))
          );
          
          if (nextPaper) {
            paper.endIndex = j;
            paper.content = lines.slice(i, j).join("\n");
            break;
          }
          
          // If we reach the end of text
          if (j === lines.length - 1) {
            paper.endIndex = lines.length;
            paper.content = lines.slice(i).join("\n");
            break;
          }
        }
        
        break;
      }
    }
  });
  
  // Second pass: If papers weren't detected by markers, try to find them by content patterns
  papers.forEach(paper => {
    if (!paper.detected) {
      // Look for paper by question patterns
      const paperConfig = patterns.papers.find(p => p.id === paper.id);
      
      if (paperConfig.type === "objective") {
        // Look for objective paper patterns
        const objectiveMarkers = ["A.", "B.", "C.", "D.", "shade", "options"];
        for (let i = 0; i < lines.length; i++) {
          if (objectiveMarkers.some(m => lines[i].includes(m))) {
            paper.detected = true;
            paper.startIndex = i;
            // Find end (look for next paper or end)
            for (let j = i + 1; j < lines.length; j++) {
              if (papers.some(p => p.id !== paper.id && lines[j].includes(p.id))) {
                paper.endIndex = j;
                break;
              }
            }
            if (paper.endIndex === -1) paper.endIndex = lines.length;
            paper.content = lines.slice(paper.startIndex, paper.endIndex).join("\n");
            break;
          }
        }
      } else if (paperConfig.type === "essay") {
        // Look for essay paper patterns
        const essayMarkers = ["show workings", "essay", "marks", "explain"];
        for (let i = 0; i < lines.length; i++) {
          if (essayMarkers.some(m => lines[i].toLowerCase().includes(m))) {
            paper.detected = true;
            paper.startIndex = i;
            // Find end
            for (let j = i + 1; j < lines.length; j++) {
              if (lines[j].includes("PAPER 1") || lines[j].includes("Answer all questions")) {
                paper.endIndex = j;
                break;
              }
            }
            if (paper.endIndex === -1) paper.endIndex = lines.length;
            paper.content = lines.slice(paper.startIndex, paper.endIndex).join("\n");
            break;
          }
        }
      }
    }
  });
  
  return papers;
}

/**
 * 3. Parse questions from a paper
 */
function parsePaperQuestions(paperContent, paperType) {
  const questions = [];
  const lines = paperContent.split("\n").map(l => l.trim()).filter(Boolean);
  
  let currentQuestion = null;
  let currentPart = null;
  let inQuestion = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Detect question number (e.g., "1.", "2.", etc.)
    const questionMatch = line.match(/^(\d+)\.\s*(.*)/);
    
    if (questionMatch) {
      // Save previous question
      if (currentQuestion) {
        questions.push(currentQuestion);
      }
      
      // Start new question
      currentQuestion = {
        number: parseInt(questionMatch[1]),
        text: questionMatch[2],
        type: paperType,
        parts: [],
        options: [],
        marks: null
      };
      inQuestion = true;
      currentPart = null;
      continue;
    }
    
    // For essay papers: detect parts (a), (b), etc.
    if (paperType === "essay" && currentQuestion) {
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
    
    // For objective papers: detect options A, B, C, D
    if (paperType === "objective" && currentQuestion) {
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
    if (inQuestion && line.length > 0) {
      if (currentPart) {
        if (currentPart.subparts && currentPart.subparts.length > 0) {
          // Append to last subpart
          const lastSubpart = currentPart.subparts[currentPart.subparts.length - 1];
          lastSubpart.text += " " + line;
        } else {
          currentPart.text += " " + line;
        }
      } else if (currentQuestion.options && currentQuestion.options.length > 0) {
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
    marks: extractMarks(q.text) || (paperType === "essay" ? 10 : 1)
  }));
}

/**
 * 4. Extract instructions from paper content
 */
function extractPaperInstructions(paperContent, paperId) {
  const lines = paperContent.split("\n").map(l => l.trim()).filter(Boolean);
  const instructions = [];
  
  // Look for instruction lines (usually first few lines after paper marker)
  let inInstructions = true;
  
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i];
    
    // Skip empty lines at the beginning
    if (i === 0 && line.length === 0) continue;
    
    // Check if this is still part of instructions (not a question yet)
    if (inInstructions) {
      if (/^\d+\.\s/.test(line) || /^\([a-d]\)/.test(line) || /^[A-D]\./.test(line)) {
        inInstructions = false;
        break;
      }
      if (line.length > 0) {
        instructions.push(line);
      }
    }
  }
  
  return instructions.join(" ").substring(0, 500);
}

/**
 * 5. Main parsing function - parsePdfStructure
 */
async function parsePdfStructure(pdfPath, options = {}) {
  const {
    format = "BECE",
    extractQuestions = true,
    includeRawText = false
  } = options;
  
  try {
    // Step 1: Extract text from PDF
    const extractionResult = await extractPdfText(pdfPath);
    const text = extractionResult.text;
    
    // Step 2: Detect papers (PAPER 1, PAPER 2, etc.)
    const papers = detectPapers(text, format);
    
    // Step 3: Process each paper
    const processedPapers = papers.map(paper => {
      if (!paper.detected || !paper.content) {
        return {
          id: paper.id,
          name: paper.name,
          type: paper.type,
          detected: false,
          content: null,
          questions: [],
          questionCount: 0,
          instructions: ""
        };
      }
      
      // Extract instructions
      const instructions = extractPaperInstructions(paper.content, paper.id);
      
      // Parse questions
      const questions = extractQuestions ? parsePaperQuestions(paper.content, paper.type) : [];
      
      // Calculate question count
      const questionCount = questions.length || 
        (paper.content.match(/^\d+\.\s/gm) || []).length;
      
      // Clean paper content for display
      const cleanContent = cleanText(paper.content.substring(0, 2000));
      
      return {
        id: paper.id,
        name: paper.name,
        type: paper.type,
        detected: true,
        markers: paper.markersFound,
        content: cleanContent + (paper.content.length > 2000 ? "..." : ""),
        fullContentLength: paper.content.length,
        instructions,
        questions,
        questionCount,
        startLine: paper.startIndex + 1,
        endLine: paper.endIndex + 1
      };
    });
    
    // Step 4: Organize output by papers
    const output = {
      papers: processedPapers.filter(p => p.detected),
      metadata: {
        totalPapersDetected: processedPapers.filter(p => p.detected).length,
        totalQuestions: processedPapers.reduce((sum, paper) => sum + paper.questionCount, 0),
        format,
        extractionDate: extractionResult.metadata.extractedAt,
        totalPages: extractionResult.metadata.totalPages
      }
    };
    
    // Add raw text if requested
    if (includeRawText) {
      output.rawText = text.substring(0, 5000) + (text.length > 5000 ? "..." : "");
    }
    
    // Transform to sections format for backward compatibility
    const sections = output.papers.map(paper => ({
      paper: paper.id,
      name: paper.name,
      instruction: paper.instructions,
      stimulus: paper.content ? {
        type: "paper_content",
        content: paper.content.substring(0, 1000)
      } : null,
      bodyText: paper.content,
      questions: paper.questions,
      questionCount: paper.questionCount
    }));
    
    return {
      papers: output.papers,
      sections, // For backward compatibility
      metadata: output.metadata,
      success: true
    };
    
  } catch (error) {
    console.error("PDF parsing error:", error);
    return {
      success: false,
      error: error.message,
      papers: [],
      sections: [],
      metadata: {}
    };
  }
}

/**
 * 6. Alternative function: parseExamPdf
 */
async function parseExamPdf(pdfPath, options = {}) {
  return await parsePdfStructure(pdfPath, options);
}

/**
 * 7. Helper functions
 */
function cleanText(text) {
  if (!text) return "";
  
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/([.,;:])\s+/g, "$1 ")
    .replace(/image\[\[.*?\]\]/g, "[IMAGE]")
    .replace(/[\u00A0\u200B\uFEFF]/g, " ")
    .replace(/\\notin/g, "¢")
    .replace(/\\mathrm\{GH\}/g, "GH¢")
    .trim();
}

function extractMarks(text) {
  const markMatch = text.match(/\[(\d+)\s*(?:marks?|points?)\]/i);
  if (markMatch) return parseInt(markMatch[1]);
  
  const parenMatch = text.match(/\((\d+)\s*(?:m|marks?)\)/i);
  if (parenMatch) return parseInt(parenMatch[1]);
  
  const wordMatch = text.match(/(\d+)\s*(?:marks?|points?)/i);
  if (wordMatch) return parseInt(wordMatch[1]);
  
  return null;
}

/**
 * 8. Export functions
 */
module.exports = {
  // Main parsing functions
  parsePdfStructure,  // Returns papers array with PAPER 1, PAPER 2 structure
  parseExamPdf,       // Alias for parsePdfStructure
  
  // Helper functions
  extractPdfText,
  detectPapers,
  parsePaperQuestions,
  extractPaperInstructions,
  cleanText,
  extractMarks,
  
  // Configuration
  EXAM_PATTERNS,
  
  // Version info
  version: "3.0.0",
  description: "Exam PDF Parser focused on PAPER 1 and PAPER 2 detection"
};