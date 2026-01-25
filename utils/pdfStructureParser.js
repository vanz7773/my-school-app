const fs = require("fs");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

/**
 * Simple BECE Exam Parser with Debugging
 */

async function parsePdfStructure(pdfPath) {
  try {
    console.log(`=== Starting PDF Parse for: ${pdfPath} ===`);
    
    // Check if file exists
    if (!fs.existsSync(pdfPath)) {
      throw new Error(`File not found: ${pdfPath}`);
    }
    
    // 1. First, let's debug PDF text extraction
    const debugResult = await debugPdfExtraction(pdfPath);
    
    // If we got text, proceed
    if (debugResult.extractedText && debugResult.extractedText.length > 100) {
      const papers = extractPapersSimple(debugResult.extractedText);
      
      // Transform to expected format
      const sections = papers.map(paper => ({
        paper: paper.id,
        instruction: paper.instructions || "",
        stimulus: paper.content ? {
          type: "paper_content",
          content: paper.content.substring(0, 300)
        } : null,
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
          textLength: debugResult.extractedText.length,
          debugInfo: {
            totalPages: debugResult.totalPages,
            extractionMethod: "standard"
          }
        },
        success: true
      };
    } else {
      // Try alternative extraction method
      console.log("Standard extraction failed, trying alternative...");
      const alternativeText = await extractTextAlternative(pdfPath);
      
      if (alternativeText && alternativeText.length > 100) {
        const papers = extractPapersSimple(alternativeText);
        
        const sections = papers.map(paper => ({
          paper: paper.id,
          instruction: paper.instructions || "",
          stimulus: paper.content ? {
            type: "paper_content",
            content: paper.content.substring(0, 300)
          } : null,
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
            textLength: alternativeText.length,
            debugInfo: {
              totalPages: "unknown",
              extractionMethod: "alternative"
            }
          },
          success: true
        };
      } else {
        throw new Error(`Text extraction failed. Methods tried: 2. Text lengths: Standard=${debugResult.extractedText?.length || 0}, Alternative=${alternativeText?.length || 0}`);
      }
    }
    
  } catch (error) {
    console.error("Full parsing error:", error);
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
 * Debug PDF extraction
 */
async function debugPdfExtraction(pdfPath) {
  try {
    const data = new Uint8Array(fs.readFileSync(pdfPath));
    console.log(`PDF file size: ${data.length} bytes`);
    
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    console.log(`PDF has ${pdf.numPages} pages`);
    
    let extractedText = "";
    let pageTexts = [];
    
    // Try to extract from first 3 pages only for speed
    for (let pageNum = 1; pageNum <= Math.min(3, pdf.numPages); pageNum++) {
      try {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        
        console.log(`Page ${pageNum}: ${textContent.items.length} text items`);
        
        // Extract text
        const pageText = textContent.items
          .map(item => item.str)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        
        pageTexts.push({
          page: pageNum,
          text: pageText,
          itemCount: textContent.items.length,
          sample: pageText.substring(0, 100)
        });
        
        extractedText += pageText + "\n\n";
        
        // Log first few items for debugging
        if (pageNum === 1 && textContent.items.length > 0) {
          console.log("First 5 text items on page 1:");
          textContent.items.slice(0, 5).forEach((item, i) => {
            console.log(`  Item ${i}: "${item.str}" (transform: ${JSON.stringify(item.transform)})`);
          });
        }
        
      } catch (pageError) {
        console.error(`Error extracting page ${pageNum}:`, pageError.message);
      }
    }
    
    console.log(`Total extracted text length: ${extractedText.length}`);
    
    return {
      extractedText,
      totalPages: pdf.numPages,
      pageTexts: pageTexts
    };
    
  } catch (error) {
    console.error("Debug extraction error:", error);
    return {
      extractedText: "",
      totalPages: 0,
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
      
      // Group by Y position to preserve lines
      const lines = {};
      
      content.items.forEach(item => {
        const y = Math.round(item.transform[5]);
        if (!lines[y]) lines[y] = [];
        lines[y].push({
          text: item.str,
          x: item.transform[4]
        });
      });
      
      // Sort Y positions (top to bottom)
      const sortedY = Object.keys(lines).sort((a, b) => b - a);
      
      // For each line, sort X positions (left to right) and join
      sortedY.forEach(y => {
        const lineItems = lines[y].sort((a, b) => a.x - b.x);
        const lineText = lineItems.map(item => item.text).join(' ');
        text += lineText + "\n";
      });
      
      text += "\n"; // Page separator
    }
    
    return text.trim();
  } catch (error) {
    console.error("Alternative extraction error:", error);
    return "";
  }
}

/**
 * Simple paper extraction based on patterns
 */
function extractPapersSimple(text) {
  const papers = [];
  
  // Convert to uppercase for easier searching
  const upperText = text.toUpperCase();
  
  console.log("=== Looking for PAPERS ===");
  
  // PAPER 2 (ESSAY) - Look for markers
  const paper2Markers = [
    "PAPER 2",
    "ESSAY",
    "ANSWER FOUR QUESTIONS ONLY",
    "SHOW WORKINGS",
    "SHOW YOUR WORKING"
  ];
  
  let paper2Start = -1;
  let paper2Marker = "";
  
  for (const marker of paper2Markers) {
    const index = upperText.indexOf(marker);
    if (index !== -1) {
      paper2Start = index;
      paper2Marker = marker;
      console.log(`Found PAPER 2 marker: "${marker}" at position ${index}`);
      break;
    }
  }
  
  // If found PAPER 2
  if (paper2Start !== -1) {
    // Find end (look for PAPER 1 or objective markers)
    let paper2End = text.length;
    
    const paper1Index = upperText.indexOf("PAPER 1", paper2Start);
    if (paper1Index !== -1) {
      paper2End = paper1Index;
    } else {
      // Look for objective markers
      const objectiveMarkers = [
        "ANSWER ALL QUESTIONS",
        "OBJECTIVE TEST",
        "MULTIPLE CHOICE",
        "OPTIONS A TO D"
      ];
      
      for (const marker of objectiveMarkers) {
        const index = upperText.indexOf(marker, paper2Start);
        if (index !== -1 && index < paper2End) {
          paper2End = index;
          break;
        }
      }
    }
    
    const paper2Content = text.substring(paper2Start, paper2End);
    
    papers.push({
      id: "PAPER 2",
      name: "ESSAY",
      type: "essay",
      detected: true,
      markerFound: paper2Marker,
      content: paper2Content.substring(0, 1500),
      fullContentLength: paper2Content.length,
      questions: extractSimpleQuestions(paper2Content, "essay"),
      questionCount: countQuestions(paper2Content, "essay"),
      instructions: "Essay section - Answer four questions only"
    });
    
    console.log(`PAPER 2 extracted: ${paper2Content.length} chars`);
  }
  
  // PAPER 1 (OBJECTIVE) - Look for markers
  const paper1Markers = [
    "PAPER 1",
    "OBJECTIVE TEST",
    "ANSWER ALL QUESTIONS",
    "EACH QUESTION IS FOLLOWED BY",
    "MULTIPLE CHOICE"
  ];
  
  let paper1Start = -1;
  let paper1Marker = "";
  
  // Start search after PAPER 2 if found
  const searchStart = paper2Start !== -1 ? paper2Start + 100 : 0;
  
  for (const marker of paper1Markers) {
    const index = upperText.indexOf(marker, searchStart);
    if (index !== -1) {
      paper1Start = index;
      paper1Marker = marker;
      console.log(`Found PAPER 1 marker: "${marker}" at position ${index}`);
      break;
    }
  }
  
  // If found PAPER 1
  if (paper1Start !== -1) {
    const paper1Content = text.substring(paper1Start);
    
    papers.push({
      id: "PAPER 1",
      name: "OBJECTIVE",
      type: "objective",
      detected: true,
      markerFound: paper1Marker,
      content: paper1Content.substring(0, 1500),
      fullContentLength: paper1Content.length,
      questions: extractSimpleQuestions(paper1Content, "objective"),
      questionCount: countQuestions(paper1Content, "objective"),
      instructions: "Objective test - Answer all questions"
    });
    
    console.log(`PAPER 1 extracted: ${paper1Content.length} chars`);
  }
  
  // If no papers found, try brute force
  if (papers.length === 0) {
    console.log("No papers found by markers, trying brute force...");
    
    // Look for numbered questions
    const lines = text.split('\n').filter(line => line.trim().length > 0);
    
    let inEssay = false;
    let inObjective = false;
    let essayLines = [];
    let objectiveLines = [];
    
    for (const line of lines) {
      const upperLine = line.toUpperCase();
      
      // Check if line starts a numbered question
      if (/^\d+\.\s/.test(line) || /^\d+\)\s/.test(line)) {
        // Check what type of question
        if (upperLine.includes("A.") && upperLine.includes("B.") && 
            upperLine.includes("C.") && upperLine.includes("D.")) {
          inObjective = true;
          inEssay = false;
        } else {
          inEssay = true;
          inObjective = false;
        }
      }
      
      if (inEssay) {
        essayLines.push(line);
      } else if (inObjective) {
        objectiveLines.push(line);
      }
    }
    
    if (essayLines.length > 0) {
      const essayContent = essayLines.join('\n');
      papers.push({
        id: "PAPER 2",
        name: "ESSAY (detected)",
        type: "essay",
        detected: true,
        detectionMethod: "brute_force",
        content: essayContent.substring(0, 1000),
        questionCount: countQuestions(essayContent, "essay")
      });
    }
    
    if (objectiveLines.length > 0) {
      const objectiveContent = objectiveLines.join('\n');
      papers.push({
        id: "PAPER 1",
        name: "OBJECTIVE (detected)",
        type: "objective",
        detected: true,
        detectionMethod: "brute_force",
        content: objectiveContent.substring(0, 1000),
        questionCount: countQuestions(objectiveContent, "objective")
      });
    }
  }
  
  console.log(`Total papers found: ${papers.length}`);
  return papers;
}

/**
 * Count questions in text
 */
function countQuestions(text, type) {
  if (type === "objective") {
    // Count numbered questions with options
    return (text.match(/\d+\.\s.*[A-D]\./gi) || []).length;
  } else {
    // Count numbered questions for essay
    return (text.match(/\d+\.\s/g) || []).length;
  }
}

/**
 * Extract simple questions
 */
function extractSimpleQuestions(text, type) {
  const questions = [];
  const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0);
  
  let currentQuestion = null;
  
  for (const line of lines) {
    // Look for question number
    const match = line.match(/^(\d+)[\.\)]\s+(.*)/);
    
    if (match) {
      if (currentQuestion) {
        questions.push(currentQuestion);
      }
      
      currentQuestion = {
        number: parseInt(match[1]),
        text: match[2].substring(0, 150),
        type: type
      };
    } else if (currentQuestion && line.length > 0) {
      // Add to current question
      currentQuestion.text += " " + line.substring(0, 100);
    }
  }
  
  // Add last question
  if (currentQuestion) {
    questions.push(currentQuestion);
  }
  
  return questions.slice(0, 10); // Return max 10 questions
}

module.exports = { parsePdfStructure };