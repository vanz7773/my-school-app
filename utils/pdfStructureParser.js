const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

/**
 * BECE Exam Parser - Detects PAPER 2 (Essay) and PAPER 1 (Objective) within PDF text
 */

/**
 * Main parsing function - Your route is calling this
 */
async function parsePdfStructure(pdfPath) {
  try {
    console.log(`Parsing PDF: ${pdfPath}`);
    
    // 1. Extract ALL text from PDF
    const fullText = await extractAllText(pdfPath);
    
    if (!fullText || fullText.trim().length < 50) {
      throw new Error("PDF text extraction failed or returned empty text");
    }
    
    console.log(`Extracted ${fullText.length} characters`);
    
    // 2. Detect PAPER 2 and PAPER 1 in the text
    const papers = detectPapersInFullText(fullText);
    
    // 3. Transform to sections for backward compatibility
    const sections = papers.map(paper => ({
      paper: paper.id,
      instruction: paper.instructions || "",
      stimulus: paper.content ? {
        type: "paper_content",
        content: paper.content.substring(0, 500)
      } : null,
      bodyText: paper.content || "",
      questions: paper.questions || [],
      questionCount: paper.questionCount || 0
    }));
    
    return {
      papers,
      sections,
      metadata: {
        totalPapersDetected: papers.length,
        totalQuestions: papers.reduce((sum, p) => sum + (p.questionCount || 0), 0),
        format: "BECE",
        extractionDate: new Date().toISOString(),
        textLength: fullText.length,
        textSample: fullText.substring(0, 300)
      },
      success: true
    };
    
  } catch (error) {
    console.error("PDF parsing error:", error);
    return {
      papers: [],
      sections: [],
      metadata: {
        totalPapersDetected: 0,
        totalQuestions: 0,
        format: "BECE",
        extractionDate: new Date().toISOString(),
        error: error.message
      },
      success: false,
      error: error.message
    };
  }
}

/**
 * Extract ALL text from PDF (simple concatenation)
 */
async function extractAllText(pdfPath) {
  try {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    
    let fullText = "";
    
    // Extract text from each page
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      // Concatenate all text items from this page
      const pageText = textContent.items
        .map(item => item.str)
        .filter(str => str.trim().length > 0)
        .join(" ");
      
      fullText += pageText + " ";
    }
    
    return fullText.trim();
  } catch (error) {
    console.error("Text extraction error:", error);
    throw error;
  }
}

/**
 * Detect PAPER 2 and PAPER 1 in the full text
 */
function detectPapersInFullText(text) {
  const papers = [];
  const lowerText = text.toLowerCase();
  
  console.log("Looking for PAPERS in text...");
  
  // PAPER 2 DETECTION (ESSAY/THEORY)
  // Look for PAPER 2 markers
  const paper2Markers = [
    "paper 2",
    "essay",
    "answer four questions only",
    "show workings",
    "marks will not be awarded"
  ];
  
  let paper2Start = -1;
  let paper2MarkerFound = "";
  
  for (const marker of paper2Markers) {
    const index = lowerText.indexOf(marker);
    if (index !== -1) {
      paper2Start = index;
      paper2MarkerFound = marker;
      console.log(`Found PAPER 2 marker: "${marker}" at position ${index}`);
      break;
    }
  }
  
  // If we found PAPER 2
  if (paper2Start !== -1) {
    // Find where PAPER 2 ends (look for PAPER 1 or objective markers)
    let paper2End = text.length;
    
    // Look for PAPER 1
    const paper1Index = lowerText.indexOf("paper 1");
    if (paper1Index !== -1 && paper1Index > paper2Start) {
      paper2End = paper1Index;
    } else {
      // Look for objective test markers
      const objectiveMarkers = [
        "answer all questions",
        "each question is followed by",
        "multiple choice",
        "options a to d",
        "shade in pencil"
      ];
      
      for (const marker of objectiveMarkers) {
        const index = lowerText.indexOf(marker, paper2Start + 1);
        if (index !== -1 && index < paper2End) {
          paper2End = index;
          break;
        }
      }
    }
    
    // Extract PAPER 2 content
    const paper2Content = text.substring(paper2Start, paper2End);
    const paper2Questions = extractQuestionsFromPaper(paper2Content, "essay");
    
    papers.push({
      id: "PAPER 2",
      name: "ESSAY/THEORY",
      type: "essay",
      detected: true,
      markerFound: paper2MarkerFound,
      startPosition: paper2Start,
      content: paper2Content.substring(0, 2000),
      fullContentLength: paper2Content.length,
      questions: paper2Questions,
      questionCount: paper2Questions.length,
      instructions: extractInstructions(paper2Content)
    });
    
    console.log(`PAPER 2: Found ${paper2Questions.length} questions`);
  }
  
  // PAPER 1 DETECTION (OBJECTIVE/MULTIPLE CHOICE)
  // Look for PAPER 1 markers
  const paper1Markers = [
    "paper 1",
    "objective test",
    "answer all questions",
    "each question is followed by",
    "multiple choice",
    "options a to d"
  ];
  
  let paper1Start = -1;
  let paper1MarkerFound = "";
  
  // Start searching from after PAPER 2 if found
  const searchStart = paper2Start !== -1 ? paper2Start + 100 : 0;
  
  for (const marker of paper1Markers) {
    const index = lowerText.indexOf(marker, searchStart);
    if (index !== -1) {
      paper1Start = index;
      paper1MarkerFound = marker;
      console.log(`Found PAPER 1 marker: "${marker}" at position ${index}`);
      break;
    }
  }
  
  // If we found PAPER 1
  if (paper1Start !== -1) {
    // PAPER 1 content goes to end of text
    const paper1Content = text.substring(paper1Start);
    const paper1Questions = extractQuestionsFromPaper(paper1Content, "objective");
    
    papers.push({
      id: "PAPER 1",
      name: "OBJECTIVE/MULTIPLE CHOICE",
      type: "objective",
      detected: true,
      markerFound: paper1MarkerFound,
      startPosition: paper1Start,
      content: paper1Content.substring(0, 2000),
      fullContentLength: paper1Content.length,
      questions: paper1Questions,
      questionCount: paper1Questions.length,
      instructions: extractInstructions(paper1Content)
    });
    
    console.log(`PAPER 1: Found ${paper1Questions.length} questions`);
  }
  
  // If no papers found by markers, try alternative detection
  if (papers.length === 0) {
    console.log("No papers found by markers, trying alternative detection...");
    return detectPapersByContent(text);
  }
  
  return papers;
}

/**
 * Alternative paper detection based on content patterns
 */
function detectPapersByContent(text) {
  const papers = [];
  const lowerText = text.toLowerCase();
  
  // Split text into chunks to analyze
  const chunks = text.split(/\n\s*\n/).filter(chunk => chunk.trim().length > 100);
  
  let essayChunks = [];
  let objectiveChunks = [];
  
  // Analyze each chunk
  chunks.forEach((chunk, index) => {
    const chunkLower = chunk.toLowerCase();
    
    // Check if chunk looks like essay content
    const hasEssayMarkers = 
      chunkLower.includes("show workings") ||
      chunkLower.includes("explain") ||
      chunkLower.includes("describe") ||
      chunkLower.includes("calculate") ||
      (chunkLower.includes("(a)") && chunkLower.includes("(b)"));
    
    // Check if chunk looks like objective content  
    const hasObjectiveMarkers =
      (chunkLower.includes("a.") && chunkLower.includes("b.") && 
       chunkLower.includes("c.") && chunkLower.includes("d.")) ||
      chunkLower.includes("shade") ||
      chunkLower.includes("multiple choice");
    
    if (hasEssayMarkers && !hasObjectiveMarkers) {
      essayChunks.push({ index, chunk });
    } else if (hasObjectiveMarkers) {
      objectiveChunks.push({ index, chunk });
    }
  });
  
  // Create PAPER 2 from essay chunks
  if (essayChunks.length > 0) {
    const essayContent = essayChunks.map(c => c.chunk).join("\n\n");
    const essayQuestions = extractQuestionsFromPaper(essayContent, "essay");
    
    papers.push({
      id: "PAPER 2",
      name: "ESSAY/THEORY",
      type: "essay",
      detected: true,
      detectionMethod: "content_analysis",
      content: essayContent.substring(0, 1500),
      questions: essayQuestions,
      questionCount: essayQuestions.length,
      instructions: "Auto-detected essay content"
    });
  }
  
  // Create PAPER 1 from objective chunks
  if (objectiveChunks.length > 0) {
    const objectiveContent = objectiveChunks.map(c => c.chunk).join("\n\n");
    const objectiveQuestions = extractQuestionsFromPaper(objectiveContent, "objective");
    
    papers.push({
      id: "PAPER 1",
      name: "OBJECTIVE/MULTIPLE CHOICE",
      type: "objective",
      detected: true,
      detectionMethod: "content_analysis",
      content: objectiveContent.substring(0, 1500),
      questions: objectiveQuestions,
      questionCount: objectiveQuestions.length,
      instructions: "Auto-detected objective/multiple choice content"
    });
  }
  
  return papers;
}

/**
 * Extract questions from paper content
 */
function extractQuestionsFromPaper(content, paperType) {
  const questions = [];
  
  // Split by lines and clean
  const lines = content.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  let currentQuestion = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Look for question numbers (e.g., "1.", "2.", "3.", etc.)
    // Also handle variations like "1)" or just "1 "
    const questionMatch = line.match(/^(\d+)[\.\)]\s+(.*)/) || 
                         line.match(/^(\d+)\s+(.*)/);
    
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
        options: []
      };
    } else if (currentQuestion) {
      // Continue current question text
      if (line.length > 0) {
        currentQuestion.text += " " + line;
        
        // For objective papers, look for options A, B, C, D
        if (paperType === "objective") {
          const optionMatch = line.match(/^([A-D])[\.\)]\s+(.*)/i);
          if (optionMatch) {
            currentQuestion.options.push({
              letter: optionMatch[1].toUpperCase(),
              text: optionMatch[2]
            });
          }
        }
        
        // For essay papers, look for parts (a), (b), etc.
        if (paperType === "essay") {
          const partMatch = line.match(/^\(([a-d])\)\s+(.*)/i);
          if (partMatch) {
            currentQuestion.parts.push({
              letter: partMatch[1].toLowerCase(),
              text: partMatch[2]
            });
          }
        }
      }
    }
  }
  
  // Add the last question
  if (currentQuestion) {
    questions.push(currentQuestion);
  }
  
  // Clean up question text
  return questions.slice(0, 50).map(q => ({
    ...q,
    text: cleanText(q.text).substring(0, 200)
  }));
}

/**
 * Extract instructions from paper
 */
function extractInstructions(content) {
  const lines = content.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  // Take first 5-8 lines as potential instructions
  const potentialInstructions = lines.slice(0, Math.min(8, lines.length));
  
  // Look for common instruction keywords
  const instructionKeywords = [
    "answer", "choose", "select", "write", "show", 
    "calculate", "explain", "describe", "shade", "do not"
  ];
  
  const instructionLines = potentialInstructions.filter(line => {
    const lowerLine = line.toLowerCase();
    return instructionKeywords.some(keyword => lowerLine.includes(keyword));
  });
  
  if (instructionLines.length > 0) {
    return instructionLines.join(" ").substring(0, 300);
  }
  
  // Fallback: return first few lines
  return potentialInstructions.join(" ").substring(0, 200);
}

/**
 * Clean text
 */
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:])/g, "$1")
    .replace(/([.,;:])\s+/g, "$1 ")
    .trim();
}

module.exports = { parsePdfStructure };