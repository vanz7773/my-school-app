const express = require('express');
const router = express.Router();
const agendaController = require('../controllers/agendaController');
const { protect, requireSchool } = require('../middlewares/authMiddleware');

// 🔐 Protect all routes and require school context
router.use(protect);
router.use(requireSchool);

// --------------------------------------------------------------------
// 📅 Create new agenda
// --------------------------------------------------------------------
router.post('/', agendaController.createAgenda);

// --------------------------------------------------------------------
// 📥 Get all agendas for user's school (Admin + Teacher full access)
// --------------------------------------------------------------------
router.get('/', agendaController.getAgendas);

// --------------------------------------------------------------------
// 👨‍🎓 Student & Parent routes
// Both now use unified logic under getAgendasForStudent
// --------------------------------------------------------------------
router.get('/student', agendaController.getAgendasForStudent);
router.get('/parent', agendaController.getAgendasForParent);

// --------------------------------------------------------------------
// 👩‍🏫 Teacher-specific agendas (teaching classes + teacher events)
// --------------------------------------------------------------------
router.get('/teacher', agendaController.getAgendasForTeacher);

// --------------------------------------------------------------------
// 🏫 Admin route (unrestricted, for viewing all agendas)
// --------------------------------------------------------------------
router.get('/admin', agendaController.getAgendasForAdmin);

// --------------------------------------------------------------------
// 🗓️ Get all agenda dates with category color (for calendar highlighting)
// --------------------------------------------------------------------
router.get('/dates', agendaController.getAgendaDatesWithColors);

// --------------------------------------------------------------------
// ✏️ Update an agenda
// --------------------------------------------------------------------
router.put('/:id', agendaController.updateAgenda);

// --------------------------------------------------------------------
// ❌ Delete an agenda
// --------------------------------------------------------------------
router.delete('/:id', agendaController.deleteAgenda);

module.exports = router;
