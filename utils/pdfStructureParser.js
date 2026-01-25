const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

/**
 * BECE Exam Parser - Direct Paper Detection
 * Fixes text extraction issue and directly searches for PAPER 1 and PAPER 2
 */

async function parsePdfStructure(pdfPath) {
  try {
    console.log(`Parsing PDF: ${pdfPath}`);
    
    // Read PDF file
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    
    let fullText = "";
    
    // Extract text from each page
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      
      // Extract text items and join them properly
      const pageText = textContent.items
        .map(item => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')  // Normalize whitespace
        .trim();
      
      fullText += pageText + "\n";
    }
    
    console.log(`Extracted ${fullText.length} characters of text`);
    
    // If text is too short, try alternative extraction method
    if (fullText.length < 100) {
      console.log("Text extraction may have failed, trying alternative method...");
      fullText = await extractTextAlternative(pdfPath);
    }
    
    // Now search for PAPERS in the extracted text
    const papers = findPapersInText(fullText);
    
    // Create sections for backward compatibility
    const sections = papers.map(paper => ({
      paper: paper.id,
      instruction: paper.instruction || "",
      stimulus: {
        type: "paper_content",
        content: paper.content.substring(0, 300)
      },
      bodyText: paper.content,
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
        totalPages: pdf.numPages,
        textExtracted: fullText.length,
        textSample: fullText.substring(0, 200)
      },
      success: true
    };
    
  } catch (error) {
    console.error("Error parsing PDF:", error);
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
 * Alternative text extraction method
 */
async function extractTextAlternative(pdfPath) {
  try {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    let text = "";
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      
      // Alternative: Use transform data to reconstruct text
      const items = content.items;
      let pageText = "";
      let lastY = null;
      
      for (const item of items) {
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 5) {
          pageText += "\n";
        }
        pageText += item.str + " ";
        lastY = y;
      }
      
      text += pageText + "\n\n";
    }
    
    return text;
  } catch (error) {
    console.error("Alternative extraction failed:", error);
    return "";
  }
}

/**
 * Find PAPER 1 and PAPER 2 in the text
 */
function findPapersInText(text) {
  const papers = [];
  
  // Convert to uppercase for easier searching
  const upperText = text.toUpperCase();
  
  console.log("Searching for papers in text...");
  
  // PAPER 2 DETECTION (Essay/Theory)
  let paper2Text = "";
  let paper2Start = -1;
  
  // Try multiple ways to find PAPER 2
  const paper2Markers = [
    "PAPER 2",
    "ESSAY",
    "THEORY",
    "ANSWER FOUR QUESTIONS",
    "SHOW YOUR WORKING",
    "SHOW WORKINGS"
  ];
  
  for (const marker of paper2Markers) {
    const index = upperText.indexOf(marker);
    if (index !== -1 && paper2Start === -1) {
      paper2Start = index;
      console.log(`Found PAPER 2 marker: ${marker} at index ${index}`);
      break;
    }
  }
  
  if (paper2Start !== -1) {
    // Find where PAPER 2 ends (look for PAPER 1 or end)
    let paper2End = text.length;
    
    // Look for PAPER 1 after PAPER 2
    const paper1After = upperText.indexOf("PAPER 1", paper2Start);
    if (paper1After !== -1) {
      paper2End = paper1After;
    } else {
      // Look for objective paper markers
      const objectiveMarkers = ["ANSWER ALL QUESTIONS", "EACH QUESTION IS FOLLOWED", "MULTIPLE CHOICE"];
      for (const marker of objectiveMarkers) {
        const markerIndex = upperText.indexOf(marker, paper2Start);
        if (markerIndex !== -1 && markerIndex < paper2End) {
          paper2End = markerIndex;
          break;
        }
      }
    }
    
    paper2Text = text.substring(paper2Start, paper2End);
    const paper2Questions = extractQuestions(paper2Text, "essay");
    
    papers.push({
      id: "PAPER 2",
      name: "ESSAY",
      type: "essay",
      detected: true,
      startIndex: paper2Start,
      content: paper2Text.substring(0, 1500),
      fullContentLength: paper2Text.length,
      questions: paper2Questions,
      questionCount: paper2Questions.length,
      instruction: extractInstructions(paper2Text, "essay")
    });
  }
  
  // PAPER 1 DETECTION (Objective/Multiple Choice)
  let paper1Text = "";
  let paper1Start = -1;
  
  // Try multiple ways to find PAPER 1
  const paper1Markers = [
    "PAPER 1",
    "OBJECTIVE",
    "ANSWER ALL QUESTIONS",
    "EACH QUESTION IS FOLLOWED",
    "MULTIPLE CHOICE",
    "OPTIONS A TO D"
  ];
  
  for (const marker of paper1Markers) {
    // Start searching from after PAPER 2 if found
    const startIndex = paper2Start !== -1 ? paper2Start + paper2Text.length : 0;
    const index = upperText.indexOf(marker, startIndex);
    
    if (index !== -1 && paper1Start === -1) {
      paper1Start = index;
      console.log(`Found PAPER 1 marker: ${marker} at index ${index}`);
      break;
    }
  }
  
  if (paper1Start === -1) {
    // If not found by markers, look for question patterns typical of objective papers
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toUpperCase();
      if ((line.includes("A.") && line.includes("B.") && line.includes("C.") && line.includes("D.")) ||
          (line.includes("SHADE") && line.includes("ANSWER"))) {
        paper1Start = text.indexOf(lines[i]);
        console.log(`Found PAPER 1 by question pattern at line ${i}`);
        break;
      }
    }
  }
  
  if (paper1Start !== -1) {
    paper1Text = text.substring(paper1Start);
    const paper1Questions = extractQuestions(paper1Text, "objective");
    
    papers.push({
      id: "PAPER 1",
      name: "OBJECTIVE",
      type: "objective",
      detected: true,
      startIndex: paper1Start,
      content: paper1Text.substring(0, 1500),
      fullContentLength: paper1Text.length,
      questions: paper1Questions,
      questionCount: paper1Questions.length,
      instruction: extractInstructions(paper1Text, "objective")
    });
  }
  
  // If no papers found by markers, try to split by question density
  if (papers.length === 0) {
    console.log("No papers found by markers, trying question-based detection");
    
    // Count questions in the whole text
    const totalQuestions = (text.match(/\d+\.\s/g) || []).length;
    
    if (totalQuestions > 10) {
      // If there are many questions, assume it's all one paper
      const hasOptions = text.includes("A.") && text.includes("B.") && text.includes("C.") && text.includes("D.");
      
      papers.push({
        id: hasOptions ? "PAPER 1" : "PAPER 2",
        name: hasOptions ? "OBJECTIVE" : "ESSAY",
        type: hasOptions ? "objective" : "essay",
        detected: true,
        detectionMethod: "question_density",
        content: text.substring(0, 2000),
        questions: extractQuestions(text, hasOptions ? "objective" : "essay"),
        questionCount: totalQuestions,
        instruction: "Auto-detected from question patterns"
      });
    }
  }
  
  console.log(`Found ${papers.length} papers`);
  return papers;
}

/**
 * Extract questions from paper text
 */
function extractQuestions(text, paperType) {
  const questions = [];
  
  // Split by lines and clean
  const lines = text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  let currentQuestion = null;
  let questionNumber = 0;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Look for question numbers (e.g., "1.", "2.", etc.)
    const match = line.match(/^(\d+)\.\s+(.*)/);
    
    if (match) {
      // Save previous question
      if (currentQuestion) {
        questions.push(currentQuestion);
      }
      
      // Start new question
      questionNumber = parseInt(match[1]);
      currentQuestion = {
        number: questionNumber,
        text: match[2],
        type: paperType,
        parts: [],
        options: []
      };
    } else if (currentQuestion) {
      // Continue current question text
      if (line.length > 0) {
        currentQuestion.text += " " + line;
      }
      
      // For objective papers, extract options
      if (paperType === "objective") {
        const optionMatch = line.match(/^([A-D])[\.\)]\s+(.*)/i);
        if (optionMatch) {
          currentQuestion.options.push({
            letter: optionMatch[1].toUpperCase(),
            text: optionMatch[2]
          });
        }
      }
      
      // For essay papers, extract parts
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
  
  // Limit to reasonable number and clean text
  return questions.slice(0, 50).map(q => ({
    ...q,
    text: cleanText(q.text).substring(0, 200)
  }));
}

/**
 * Extract instructions from paper text
 */
function extractInstructions(text, paperType) {
  const lines = text.split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  
  // Take first 5-10 lines as potential instructions
  const instructionLines = lines.slice(0, Math.min(10, lines.length));
  
  // Look for common instruction keywords
  const commonInstructions = {
    essay: [
      "Answer four questions only",
      "Show all workings",
      "All questions carry equal marks",
      "Marks will not be awarded"
    ],
    objective: [
      "Answer all questions",
      "Each question is followed by four options",
      "Choose the correct answer",
      "Shade the answer space"
    ]
  };
  
  // Check if any common instructions are in the text
  const instructions = commonInstructions[paperType] || [];
  for (const instruction of instructions) {
    if (text.toUpperCase().includes(instruction.toUpperCase())) {
      return instruction;
    }
  }
  
  // Fallback: return first few lines
  return instructionLines.join(" ").substring(0, 200);
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