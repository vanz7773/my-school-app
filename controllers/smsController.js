const smsService = require('../services/smsService');
const SmsLog = require('../models/SmsLog');
const SchoolSmsSettings = require('../models/SchoolSmsSettings');
const Student = require('../models/Student');

exports.getSettings = async (req, res) => {
  try {
    const settings = await smsService.getSchoolSettings(req.user.school);
    res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.updateSettings = async (req, res) => {
  try {
    const { smsEnabled, senderId, autoTriggers } = req.body;
    const settings = await SchoolSmsSettings.findOneAndUpdate(
      { school: req.user.school },
      { smsEnabled, senderId, autoTriggers },
      { new: true, upsert: true }
    );
    res.json({ success: true, settings, message: 'Settings updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getBalance = async (req, res) => {
  try {
    if (req.user.role === 'superadmin') {
      // Superadmin sees the actual Arkesel master balance
      const balanceData = await smsService.checkBalance();
      res.json({ success: true, balance: balanceData });
    } else if (req.user.role === 'admin') {
      // Regular school admin sees their school's allocated balance
      const settings = await SchoolSmsSettings.findOne({ school: req.user.school });
      res.json({ 
        success: true, 
        balance: { balance: settings ? settings.smsBalance : 0 } 
      });
    } else {
      return res.status(403).json({ message: 'Unauthorized' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.getLogs = async (req, res) => {
  try {
    const { page = 1, limit = 50, messageType, status, search } = req.query;
    
    const query = { school: req.user.school };
    if (messageType) query.messageType = messageType;
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { recipientPhone: new RegExp(search, 'i') },
        { message: new RegExp(search, 'i') }
      ];
    }

    const logs = await SmsLog.find(query)
      .sort({ sentAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await SmsLog.countDocuments(query);

    res.json({
      success: true,
      logs,
      totalPages: Math.ceil(total / limit),
      currentPage: parseInt(page),
      total
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.sendBulkSms = async (req, res) => {
  try {
    const { message, messageType, recipientIds, recipientType } = req.body;

    if (!message || !messageType || !recipientIds || !Array.isArray(recipientIds)) {
      return res.status(400).json({ message: 'Missing required fields or invalid format' });
    }

    // Determine phone numbers
    let phones = [];
    if (recipientType === 'student_parents') {
      const students = await Student.find({ _id: { $in: recipientIds }, school: req.user.school });
      
      const parentUserIds = new Set();

      students.forEach(student => {
        // 1. Primary: Guardian Phones stored directly on Student
        if (student.guardianPhone) {
          phones.push(student.guardianPhone);
        }
        if (student.guardianPhone2) {
          phones.push(student.guardianPhone2);
        }
        
        // 2. Fallback: Collect all Parent/Guardian User IDs
        if (student.parent) parentUserIds.add(String(student.parent._id || student.parent));
        if (Array.isArray(student.parentIds)) {
          student.parentIds.forEach(pId => parentUserIds.add(String(pId._id || pId)));
        }
      });

      // Fetch all unique parent Users to get their phone numbers
      if (parentUserIds.size > 0) {
        const User = require('../models/User');
        const parentUsers = await User.find({ _id: { $in: Array.from(parentUserIds) } }).select('phone');
        parentUsers.forEach(pu => {
          if (pu.phone) phones.push(pu.phone);
        });
      }
    } else if (recipientType === 'teachers') {
      const User = require('../models/User');
      const teachers = await User.find({ school: req.user.school, role: 'teacher' }).select('phone');
      teachers.forEach(t => {
        if (t.phone) phones.push(t.phone);
      });
    } else if (recipientType === 'direct_phones') {
      phones = recipientIds; // Assuming recipientIds is actually an array of phone numbers
    }

    // Filter out empties and clean
    phones = [...new Set(phones.filter(Boolean))];

    if (phones.length === 0) {
      return res.status(400).json({ message: 'No valid phone numbers found for selected recipients' });
    }

    const result = await smsService.sendSms({
      schoolId: req.user.school,
      recipients: phones,
      message,
      messageType
    });

    res.json({ success: true, result, message: 'Bulk SMS processed' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.sendSingleSms = async (req, res) => {
  try {
    const { phone, message, messageType } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ message: 'Phone and message are required' });
    }

    const result = await smsService.sendSms({
      schoolId: req.user.school,
      recipients: [phone],
      message,
      messageType: messageType || 'custom'
    });

    res.json({ success: true, result, message: 'SMS processed' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.triggerOverdueFeesSms = async (req, res) => {
  try {
    const { TermBill } = require('../models/allModels');
    const Term = require('../models/term');
    const User = require('../models/User');

    const today = new Date();
    const currentTerm = await Term.findOne({ 
      school: req.user.school,
      startDate: { $lte: today },
      endDate: { $gte: today }
    });

    if (!currentTerm) {
      return res.status(400).json({ success: false, message: 'No active term found to calculate overdue fees.' });
    }

    const overdueBills = await TermBill.find({
      school: req.user.school,
      term: currentTerm.term,
      academicYear: currentTerm.academicYear,
      balance: { $gt: 0 }
    }).populate({
      path: 'student',
      populate: { path: 'user' }
    });

    if (overdueBills.length === 0) {
      return res.status(400).json({ success: false, message: 'No students have overdue balances for the current term.' });
    }

    const phoneMessages = {};
    let totalMessagesQueued = 0;
    
    for (const bill of overdueBills) {
      if (!bill.student) continue;
      
      const studentData = await Student.findById(bill.student._id).populate('parent parentIds');
      if (!studentData) continue;

      const studentName = bill.student.user?.name || studentData.name || 'Student';
      const message = `Fee Reminder: ${studentName} has an outstanding balance of GHS ${bill.balance}. Please arrange payment.`;

      const phones = new Set();
      if (studentData.guardianPhone) phones.add(studentData.guardianPhone);
      if (studentData.guardianPhone2) phones.add(studentData.guardianPhone2);
      
      const parentIds = [];
      if (studentData.parent) parentIds.push(studentData.parent._id || studentData.parent);
      if (Array.isArray(studentData.parentIds)) {
        studentData.parentIds.forEach(p => parentIds.push(p._id || p));
      }

      if (parentIds.length > 0) {
        const parentUsers = await User.find({ _id: { $in: parentIds } }).select('phone');
        parentUsers.forEach(pu => { if (pu.phone) phones.add(pu.phone); });
      }

      for (const phone of phones) {
        if (!phoneMessages[phone]) phoneMessages[phone] = [];
        phoneMessages[phone].push(message);
        totalMessagesQueued++;
      }
    }

    let sentCount = 0;
    for (const [phone, msgs] of Object.entries(phoneMessages)) {
      const combinedMessage = msgs.join(' ');
      try {
        await smsService.sendSms({
          schoolId: req.user.school,
          recipients: [phone],
          message: combinedMessage,
          messageType: 'fees'
        });
        sentCount++;
      } catch(err) {
        console.error('Failed to send manual overdue SMS:', err.message);
      }
    }

    res.json({ success: true, message: `Overdue fees SMS sent successfully to ${sentCount} parents.` });

  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
