// utils/pdfTextLocator.js
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");

/**
 * Extracts approximate X/Y coordinates of a specific text string on a page.
 * 
 * @param {Buffer} pdfBuffer - PDF buffer from fs or pdf-lib save()
 * @param {number} pageIndex - Zero-based page index
 * @param {string} searchText - The text to locate (case-insensitive)
 * @returns {Promise<{x: number, y: number, text: string} | null>}
 */
async function findTextPosition(pdfBuffer, pageIndex, searchText) {
  if (!pdfBuffer) return null;

  try {
    const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
    const pdf = await loadingTask.promise;

    if (pageIndex >= pdf.numPages) return null;

    const page = await pdf.getPage(pageIndex + 1);
    const textContent = await page.getTextContent();

    const items = textContent.items;
    const searchUpper = searchText.toUpperCase();

    // Loop through extracted text items
    for (let i = 0; i < items.length; i++) {
      const t = items[i];
      if (!t || !t.str) continue;

      const contentUpper = t.str.toUpperCase();

      if (contentUpper.includes(searchUpper)) {
        const transform = t.transform;

        // PDF coordinate system (x, y)
        const x = transform[4];
        const y = transform[5];

        return {
          x,
          y,
          text: t.str
        };
      }
    }

    return null;
  } catch (err) {
    console.error("❌ pdfTextLocator findTextPosition error:", err);
    return null;
  }
}

module.exports = { findTextPosition };
