const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

/**
 * Simple but Effective BECE Exam Parser
 * Focused on detecting PAPER 1 and PAPER 2
 */

async function extractPdfText(pdfPath) {
  try {
    console.log(`Extracting text from: ${pdfPath}`);
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    
    let fullText = "";
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      
      // Simple text extraction - focus on getting all text
      const pageText = content.items
        .map(item => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      
      fullText += `=== PAGE ${pageNum} ===\n${pageText}\n\n`;
    }
    
    return fullText.trim();
  } catch (error) {
    console.error("Extraction error:", error);
    throw error;
  }
}

/**
 * Simple paper detection - looks for PAPER 1 and PAPER 2 markers
 */
function findPapers(text) {
  console.log("Looking for papers in text...");
  
  const papers = [];
  const lines = text.split("\n").map(line => line.trim());
  
  // Look for PAPER 1
  const paper1Start = lines.findIndex(line => 
    line.toLowerCase().includes("paper 1") || 
    line.toLowerCase().includes("answer all questions") ||
    /^\s*1\s*$/.test(line) && lines[lines.indexOf(line) + 1]?.toLowerCase().includes("answer all questions")
  );
  
  // Look for PAPER 2
  const paper2Start = lines.findIndex(line => 
    line.toLowerCase().includes("paper 2") || 
    line.toLowerCase().includes("answer four questions") ||
    line.toLowerCase().includes("essay")
  );
  
  console.log(`Paper 1 start index: ${paper1Start}`);
  console.log(`Paper 2 start index: ${paper2Start}`);
  
  // If we found PAPER 2, extract it
  if (paper2Start !== -1) {
    const paper2End = paper1Start !== -1 && paper1Start > paper2Start ? 
      paper1Start : lines.length;
    
    const paper2Content = lines.slice(paper2Start, paper2End).join("\n");
    const paper2Questions = extractQuestionsFromPaper(paper2Content, "essay");
    
    papers.push({
      id: "PAPER 2",
      name: "ESSAY",
      type: "essay",
      detected: true,
      startLine: paper2Start,
      content: paper2Content.substring(0, 1000),
      fullContent: paper2Content,
      questions: paper2Questions,
      questionCount: paper2Questions.length,
      instructions: extractInstructions(paper2Content)
    });
  }
  
  // If we found PAPER 1, extract it
  if (paper1Start !== -1) {
    const paper1End = lines.length;
    
    const paper1Content = lines.slice(paper1Start, paper1End).join("\n");
    const paper1Questions = extractQuestionsFromPaper(paper1Content, "objective");
    
    papers.push({
      id: "PAPER 1",
      name: "OBJECTIVE",
      type: "objective",
      detected: true,
      startLine: paper1Start,
      content: paper1Content.substring(0, 1000),
      fullContent: paper1Content,
      questions: paper1Questions,
      questionCount: paper1Questions.length,
      instructions: extractInstructions(paper1Content)
    });
  }
  
  // Fallback: If no papers found by markers, try to split by question patterns
  if (papers.length === 0) {
    console.log("No papers found by markers, trying alternative detection...");
    return findPapersByQuestions(text);
  }
  
  console.log(`Found ${papers.length} papers`);
  return papers;
}

/**
 * Alternative detection by looking for question patterns
 */
function findPapersByQuestions(text) {
  const papers = [];
  const lines = text.split("\n").map(line => line.trim());
  
  // Count different types of questions
  const essayQuestions = [];
  const objectiveQuestions = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Look for essay question patterns (numbered questions with parts)
    if (/^\d+\.\s+[A-Z].*\([a-d]\)/i.test(line) || 
        /^\d+\.\s+.*show.*workings/i.test(line) ||
        /^\d+\.\s+.*calculate.*/i.test(line) && line.length > 50) {
      essayQuestions.push({ line: i, text: line });
    }
    
    // Look for objective question patterns (numbered with options)
    if (/^\d+\.\s+.*A\.\s+.*B\.\s+.*C\.\s+.*D\./i.test(line) ||
        /^\d+\.\s+.*[A-D]\.\s+.*[A-D]\.\s+.*[A-D]\.\s+.*[A-D]\./i.test(line)) {
      objectiveQuestions.push({ line: i, text: line });
    }
  }
  
  console.log(`Found ${essayQuestions.length} potential essay questions`);
  console.log(`Found ${objectiveQuestions.length} potential objective questions`);
  
  // If we found more essay-like questions, assume that's PAPER 2
  if (essayQuestions.length > objectiveQuestions.length && essayQuestions.length > 0) {
    const essayStart = Math.max(0, essayQuestions[0].line - 10);
    const essayEnd = objectiveQuestions.length > 0 ? 
      Math.min(objectiveQuestions[0].line, lines.length) : lines.length;
    
    const essayContent = lines.slice(essayStart, essayEnd).join("\n");
    
    papers.push({
      id: "PAPER 2",
      name: "ESSAY",
      type: "essay",
      detected: true,
      detectionMethod: "question_pattern",
      startLine: essayStart,
      content: essayContent.substring(0, 1000),
      questions: extractQuestionsFromPaper(essayContent, "essay"),
      questionCount: essayQuestions.length
    });
  }
  
  // If we found objective questions
  if (objectiveQuestions.length > 0) {
    const objectiveStart = objectiveQuestions[0].line - 5;
    const objectiveEnd = lines.length;
    
    const objectiveContent = lines.slice(objectiveStart, objectiveEnd).join("\n");
    
    papers.push({
      id: "PAPER 1",
      name: "OBJECTIVE",
      type: "objective",
      detected: true,
      detectionMethod: "question_pattern",
      startLine: objectiveStart,
      content: objectiveContent.substring(0, 1000),
      questions: extractQuestionsFromPaper(objectiveContent, "objective"),
      questionCount: objectiveQuestions.length
    });
  }
  
  return papers;
}

/**
 * Extract questions from paper content
 */
function extractQuestionsFromPaper(content, paperType) {
  const questions = [];
  const lines = content.split("\n").map(line => line.trim()).filter(line => line.length > 0);
  
  let currentQuestion = null;
  let questionNumber = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Look for question numbers
    const match = line.match(/^(\d+)\.\s+(.*)/);
    
    if (match) {
      // Save previous question
      if (currentQuestion) {
        questions.push(currentQuestion);
      }
      
      questionNumber = parseInt(match[1]);
      currentQuestion = {
        number: questionNumber,
        text: match[2],
        type: paperType,
        parts: [],
        options: []
      };
    } else if (currentQuestion) {
      // Continue current question
      currentQuestion.text += " " + line;
      
      // For objective papers, look for options
      if (paperType === "objective") {
        const optionMatch = line.match(/^([A-D])[\.\)]\s+(.*)/i);
        if (optionMatch) {
          currentQuestion.options.push({
            letter: optionMatch[1].toUpperCase(),
            text: optionMatch[2]
          });
        }
      }
      
      // For essay papers, look for parts
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
  
  // Add the last question
  if (currentQuestion) {
    questions.push(currentQuestion);
  }
  
  return questions.map(q => ({
    ...q,
    text: cleanText(q.text.substring(0, 500))
  }));
}

/**
 * Extract instructions from paper
 */
function extractInstructions(content) {
  const lines = content.split("\n").map(line => line.trim());
  
  // Look for instruction lines in first 10 lines
  const instructionLines = [];
  for (let i = 0; i < Math.min(10, lines.length); i++) {
    const line = lines[i];
    if (line.toLowerCase().includes('answer') || 
        line.toLowerCase().includes('question') ||
        line.toLowerCase().includes('choose') ||
        line.toLowerCase().includes('select') ||
        line.toLowerCase().includes('write') ||
        line.toLowerCase().includes('show')) {
      instructionLines.push(line);
    }
  }
  
  return instructionLines.join(' ').substring(0, 300);
}

/**
 * Main parsing function
 */
async function parsePdfStructure(pdfPath) {
  try {
    console.log(`Starting PDF parsing for: ${pdfPath}`);
    
    // Extract text
    const text = await extractPdfText(pdfPath);
    console.log(`Extracted ${text.length} characters`);
    
    // Find papers
    const papers = findPapers(text);
    
    // Transform to sections for backward compatibility
    const sections = papers.map(paper => ({
      paper: paper.id,
      instruction: paper.instructions || "",
      stimulus: paper.content ? {
        type: "paper_content",
        content: paper.content.substring(0, 500)
      } : null,
      bodyText: paper.content,
      questions: paper.questions,
      questionCount: paper.questionCount
    }));
    
    return {
      papers,
      sections,
      metadata: {
        totalPapersDetected: papers.length,
        totalQuestions: papers.reduce((sum, paper) => sum + (paper.questionCount || 0), 0),
        format: "BECE",
        extractionDate: new Date().toISOString(),
        textSample: text.substring(0, 500)
      },
      success: true,
      debug: {
        textLength: text.length,
        first500Chars: text.substring(0, 500),
        paperDetection: papers.map(p => ({
          id: p.id,
          detected: p.detected,
          questionCount: p.questionCount,
          startLine: p.startLine
        }))
      }
    };
    
  } catch (error) {
    console.error("Parse error:", error);
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
 * Helper function
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