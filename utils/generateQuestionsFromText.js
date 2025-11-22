// utils/generateQuestionsFromText.js

async function generateQuestionsFromText(notesText, numQuestions = 20) {
  // For now we’ll just mock AI — later you can connect OpenAI
  const questions = [];

  for (let i = 1; i <= numQuestions; i++) {
    questions.push({
      question: `Sample Question ${i} based on notes: ${notesText.substring(0, 30)}...`,
      options: [
        "Option A",
        "Option B",
        "Option C",
        "Option D"
      ],
      correctAnswer: "Option A" // default placeholder
    });
  }

  return questions;
}

module.exports = generateQuestionsFromText;
