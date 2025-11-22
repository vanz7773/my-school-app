const Submission = require('../models/Submission');
const Assignment = require('../models/Assignment');
const Student = require('../models/Student');

// ✅ Submit assignment (student)
exports.submitAssignment = async (req, res) => {
  try {
    const { assignmentId, content } = req.body;

    const assignment = await Assignment.findOne({
      _id: assignmentId,
      school: req.user.school
    });

    if (!assignment) return res.status(404).json({ message: 'Assignment not found for your school' });

    const student = await Student.findOne({ user: req.user.id, school: req.user.school });
    if (!student) return res.status(403).json({ message: 'Student profile not found' });

    const existing = await Submission.findOne({
      assignment: assignmentId,
      student: student._id
    });

    if (existing) {
      return res.status(400).json({ message: 'You already submitted this assignment' });
    }

    const submission = new Submission({
      assignment: assignmentId,
      student: student._id,
      content
    });

    await submission.save();
    res.status(201).json({ message: 'Assignment submitted', submission });
  } catch (err) {
    res.status(500).json({ message: 'Submission failed', error: err.message });
  }
};

// ✅ Get submissions for a specific assignment (admin/teacher)
exports.getSubmissionsByAssignment = async (req, res) => {
  try {
    const assignmentId = req.params.id;

    const assignment = await Assignment.findOne({
      _id: assignmentId,
      school: req.user.school
    });

    if (!assignment) return res.status(404).json({ message: 'Assignment not found for your school' });

    const submissions = await Submission.find({ assignment: assignmentId })
      .populate({
        path: 'student',
        populate: { path: 'user', select: 'name email' }
      })
      .populate('assignment', 'title');

    res.json(submissions);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch submissions', error: err.message });
  }
};

// ✅ Get all submissions made by the logged-in student
exports.getStudentSubmissions = async (req, res) => {
  try {
    const student = await Student.findOne({ user: req.user.id, school: req.user.school });
    if (!student) return res.status(403).json({ message: 'Student profile not found' });

    const submissions = await Submission.find({ student: student._id })
      .populate('assignment', 'title dueDate');

    res.json(submissions);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching your submissions', error: err.message });
  }
};
