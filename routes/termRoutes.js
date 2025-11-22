const express = require('express');
const router = express.Router();
const termController = require('../controllers/termController');
const { findTermByQuery } = require('../controllers/termController');


router.post('/add', termController.createTerm);

// Get all weeks in a term
router.get('/weeks', termController.getTermWeeks);

router.get('/find',  findTermByQuery); // ✅ ensure protect is in place

// Get all terms for a school
router.get('/all', termController.getTermsBySchool);

// Get academic years available
router.get('/years', termController.getAcademicYears);

// ✅ Update a term
router.put('/:id', termController.updateTerm);

// ✅ Delete a term
router.delete('/:id', termController.deleteTerm);

router.get('/current-week', termController.getCurrentWeek);

module.exports = router;
