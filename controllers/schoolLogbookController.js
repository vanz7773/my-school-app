const SchoolLogbookEntry = require('../models/SchoolLogbookEntry');
const AuditLog = require('../models/AuditLog');

const getSchoolId = (req) => req.user?.school;

const cleanTextArray = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const normalizePayload = (body) => {
  const followUpRequired = Boolean(body.followUpRequired);

  return {
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    activityDate: body.activityDate ? new Date(body.activityDate) : new Date(),
    category: body.category || 'General',
    priority: body.priority || 'Normal',
    location: String(body.location || '').trim(),
    peopleInvolved: cleanTextArray(body.peopleInvolved),
    actionTaken: String(body.actionTaken || '').trim(),
    followUpRequired,
    followUpDate: followUpRequired && body.followUpDate ? new Date(body.followUpDate) : null,
    status: body.status || 'Open',
  };
};

const writeAuditLog = async ({ req, action, resourceId, metadata = {} }) => {
  try {
    await AuditLog.create({
      actor: req.user._id,
      school: getSchoolId(req),
      action,
      resourceType: 'SchoolLogbookEntry',
      resourceId,
      metadata,
    });
  } catch (error) {
    console.warn('Failed to write school logbook audit entry:', error.message);
  }
};

exports.getLogbookEntries = async (req, res) => {
  try {
    const schoolId = getSchoolId(req);
    const {
      search = '',
      category = '',
      priority = '',
      status = '',
      followUpRequired = '',
      dateFrom = '',
      dateTo = '',
      page = 1,
      limit = 25,
    } = req.query;

    const filter = { school: schoolId };

    if (category) filter.category = category;
    if (priority) filter.priority = priority;
    if (status) filter.status = status;
    if (followUpRequired !== '') filter.followUpRequired = followUpRequired === 'true';

    if (dateFrom || dateTo) {
      filter.activityDate = {};
      if (dateFrom) filter.activityDate.$gte = new Date(dateFrom);
      if (dateTo) {
        const endDate = new Date(dateTo);
        endDate.setHours(23, 59, 59, 999);
        filter.activityDate.$lte = endDate;
      }
    }

    if (search.trim()) {
      filter.$text = { $search: search.trim() };
    }

    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.min(100, Math.max(1, Number(limit) || 25));
    const skip = (pageNumber - 1) * limitNumber;

    const [entries, total, summaryAgg] = await Promise.all([
      SchoolLogbookEntry.find(filter)
        .populate('createdBy', 'name email')
        .populate('updatedBy', 'name email')
        .sort({ activityDate: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      SchoolLogbookEntry.countDocuments(filter),
      SchoolLogbookEntry.aggregate([
        { $match: { school: schoolId } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            open: { $sum: { $cond: [{ $eq: ['$status', 'Open'] }, 1, 0] } },
            inProgress: { $sum: { $cond: [{ $eq: ['$status', 'In Progress'] }, 1, 0] } },
            followUps: { $sum: { $cond: ['$followUpRequired', 1, 0] } },
            critical: { $sum: { $cond: [{ $eq: ['$priority', 'Critical'] }, 1, 0] } },
          },
        },
      ]),
    ]);

    return res.json({
      success: true,
      entries,
      pagination: {
        total,
        page: pageNumber,
        limit: limitNumber,
        pages: Math.ceil(total / limitNumber),
      },
      summary:
        summaryAgg[0] || {
          total: 0,
          open: 0,
          inProgress: 0,
          followUps: 0,
          critical: 0,
        },
    });
  } catch (error) {
    console.error('Error fetching school logbook entries:', error);
    return res.status(500).json({ message: 'Error fetching school logbook entries', error: error.message });
  }
};

exports.createLogbookEntry = async (req, res) => {
  try {
    const schoolId = getSchoolId(req);
    const payload = normalizePayload(req.body);

    if (!payload.title || !payload.description) {
      return res.status(400).json({ message: 'Title and description are required' });
    }

    const entry = await SchoolLogbookEntry.create({
      ...payload,
      school: schoolId,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    await writeAuditLog({
      req,
      action: 'school_logbook.create',
      resourceId: entry._id,
      metadata: { title: entry.title, category: entry.category, priority: entry.priority },
    });

    const populated = await SchoolLogbookEntry.findById(entry._id)
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
      .lean();

    return res.status(201).json({ success: true, message: 'Logbook entry recorded successfully', entry: populated });
  } catch (error) {
    console.error('Error creating school logbook entry:', error);
    return res.status(500).json({ message: 'Error creating school logbook entry', error: error.message });
  }
};

exports.updateLogbookEntry = async (req, res) => {
  try {
    const schoolId = getSchoolId(req);
    const payload = normalizePayload(req.body);

    if (!payload.title || !payload.description) {
      return res.status(400).json({ message: 'Title and description are required' });
    }

    const entry = await SchoolLogbookEntry.findOneAndUpdate(
      { _id: req.params.id, school: schoolId },
      {
        ...payload,
        updatedBy: req.user._id,
      },
      { new: true, runValidators: true }
    )
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email');

    if (!entry) {
      return res.status(404).json({ message: 'Logbook entry not found' });
    }

    await writeAuditLog({
      req,
      action: 'school_logbook.update',
      resourceId: entry._id,
      metadata: { title: entry.title, category: entry.category, priority: entry.priority, status: entry.status },
    });

    return res.json({ success: true, message: 'Logbook entry updated successfully', entry });
  } catch (error) {
    console.error('Error updating school logbook entry:', error);
    return res.status(500).json({ message: 'Error updating school logbook entry', error: error.message });
  }
};

exports.deleteLogbookEntry = async (req, res) => {
  try {
    const schoolId = getSchoolId(req);
    const entry = await SchoolLogbookEntry.findOneAndDelete({ _id: req.params.id, school: schoolId });

    if (!entry) {
      return res.status(404).json({ message: 'Logbook entry not found' });
    }

    await writeAuditLog({
      req,
      action: 'school_logbook.delete',
      resourceId: entry._id,
      metadata: { title: entry.title, category: entry.category, priority: entry.priority },
    });

    return res.json({ success: true, message: 'Logbook entry deleted successfully' });
  } catch (error) {
    console.error('Error deleting school logbook entry:', error);
    return res.status(500).json({ message: 'Error deleting school logbook entry', error: error.message });
  }
};
