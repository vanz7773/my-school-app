const mongoose = require('mongoose');
const ReleaseNote = require('../models/ReleaseNote');
const AuditLog = require('../models/AuditLog');

const allowedAudiences = ReleaseNote.audiences;
const allowedPlatforms = ReleaseNote.platforms;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const getUserSchoolId = (req) => req.user?.school || req.school || null;

const isSuperAdmin = (req) => req.user?.role === 'superadmin';

const normalizeArray = (value, allowedValues, fallback = 'all') => {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

  const cleaned = raw.filter((item) => allowedValues.includes(item));

  if (!cleaned.length) return [fallback];
  if (cleaned.includes('all')) return ['all'];
  return [...new Set(cleaned)];
};

const parseDateOrNull = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const normalizePayload = (body, req, existing = {}) => {
  const title = String(body.title || existing.title || '').trim();
  const startsAt = parseDateOrNull(body.startsAt) || existing.startsAt || new Date();
  const endsAt = parseDateOrNull(body.endsAt);

  let school = existing.school || null;
  if (isSuperAdmin(req)) {
    school = body.school === '' || body.school === null || body.school === undefined ? null : body.school;
  } else {
    school = getUserSchoolId(req);
  }

  return {
    title,
    summary: String(body.summary || '').trim(),
    details: String(body.details || '').trim(),
    version: String(body.version || '').trim(),
    audiences: normalizeArray(body.audiences, allowedAudiences),
    platforms: normalizeArray(body.platforms, allowedPlatforms),
    school,
    startsAt,
    endsAt,
    isActive: body.isActive === undefined ? existing.isActive !== false : Boolean(body.isActive),
    updatedBy: req.user?._id,
  };
};

const buildSchoolScope = (req, includeGlobal = true) => {
  if (isSuperAdmin(req)) return {};
  const schoolId = getUserSchoolId(req);
  if (!schoolId) return { school: null };
  if (!includeGlobal) return { school: schoolId };
  return { $or: [{ school: schoolId }, { school: null }] };
};

const buildVisibleFilter = (req, platform = 'mobile') => {
  const now = new Date();
  const role = req.user?.role || 'all';
  const schoolId = getUserSchoolId(req);
  const schoolScope = schoolId ? [{ school: schoolId }, { school: null }] : [{ school: null }];

  return {
    isActive: true,
    $and: [
      { $or: [{ startsAt: { $lte: now } }, { startsAt: null }, { startsAt: { $exists: false } }] },
      { $or: [{ endsAt: { $gte: now } }, { endsAt: null }, { endsAt: { $exists: false } }] },
      { $or: [{ audiences: 'all' }, { audiences: role }] },
      { $or: [{ platforms: 'all' }, { platforms: platform }] },
      { $or: schoolScope },
      { 'seenBy.user': { $ne: req.user._id } },
    ],
  };
};

const writeAuditLog = async ({ req, action, resourceId, metadata = {} }) => {
  try {
    await AuditLog.create({
      actor: req.user._id,
      school: getUserSchoolId(req),
      action,
      resourceType: 'ReleaseNote',
      resourceId,
      metadata,
    });
  } catch (error) {
    console.warn('Failed to write release note audit entry:', error.message);
  }
};

const isManagedByUser = (req, note) => {
  if (isSuperAdmin(req)) return true;
  const schoolId = getUserSchoolId(req);
  return schoolId && note.school && String(note.school) === String(schoolId);
};

exports.getReleaseNotes = async (req, res) => {
  try {
    const {
      search = '',
      audience = '',
      platform = '',
      active = '',
      page = 1,
      limit = 50,
    } = req.query;

    const filter = {};
    const schoolScope = buildSchoolScope(req);
    if (Object.keys(schoolScope).length) {
      filter.$and = [schoolScope];
    }

    if (search.trim()) {
      filter.$and = [
        ...(filter.$and || []),
        {
          $or: [
            { title: { $regex: escapeRegex(search.trim()), $options: 'i' } },
            { summary: { $regex: escapeRegex(search.trim()), $options: 'i' } },
          ],
        },
      ];
    }

    if (allowedAudiences.includes(audience)) filter.audiences = audience;
    if (allowedPlatforms.includes(platform)) filter.platforms = platform;
    if (active === 'true') filter.isActive = true;
    if (active === 'false') filter.isActive = false;

    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.min(100, Math.max(1, Number(limit) || 50));
    const skip = (pageNumber - 1) * limitNumber;

    const [notes, total, activeCount] = await Promise.all([
      ReleaseNote.find(filter)
        .populate('school', 'name')
        .populate('createdBy', 'name email')
        .populate('updatedBy', 'name email')
        .sort({ startsAt: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),
      ReleaseNote.countDocuments(filter),
      ReleaseNote.countDocuments({ ...buildSchoolScope(req), isActive: true }),
    ]);

    return res.json({
      success: true,
      notes,
      audiences: allowedAudiences,
      platforms: allowedPlatforms,
      summary: { total, active: activeCount },
      pagination: {
        total,
        page: pageNumber,
        limit: limitNumber,
        pages: Math.ceil(total / limitNumber),
      },
    });
  } catch (error) {
    console.error('Error fetching release notes:', error);
    return res.status(500).json({ message: 'Error fetching release notes', error: error.message });
  }
};

exports.createReleaseNote = async (req, res) => {
  try {
    const payload = normalizePayload(req.body, req);

    if (!payload.title) {
      return res.status(400).json({ message: 'Title is required' });
    }

    if (payload.school && !mongoose.Types.ObjectId.isValid(String(payload.school))) {
      return res.status(400).json({ message: 'Invalid school selected' });
    }

    const note = await ReleaseNote.create({
      ...payload,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    await writeAuditLog({
      req,
      action: 'release_note.create',
      resourceId: note._id,
      metadata: { title: note.title, audiences: note.audiences, platforms: note.platforms },
    });

    const populated = await ReleaseNote.findById(note._id)
      .populate('school', 'name')
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
      .lean();

    return res.status(201).json({ success: true, message: 'Release note created successfully', note: populated });
  } catch (error) {
    console.error('Error creating release note:', error);
    return res.status(500).json({ message: 'Error creating release note', error: error.message });
  }
};

exports.updateReleaseNote = async (req, res) => {
  try {
    const note = await ReleaseNote.findOne({ _id: req.params.id, ...buildSchoolScope(req) });

    if (!note || !isManagedByUser(req, note)) {
      return res.status(404).json({ message: 'Release note not found' });
    }

    const payload = normalizePayload(req.body, req, note);

    if (!payload.title) {
      return res.status(400).json({ message: 'Title is required' });
    }

    if (payload.school && !mongoose.Types.ObjectId.isValid(String(payload.school))) {
      return res.status(400).json({ message: 'Invalid school selected' });
    }

    Object.assign(note, payload);
    await note.save();

    await writeAuditLog({
      req,
      action: 'release_note.update',
      resourceId: note._id,
      metadata: { title: note.title, audiences: note.audiences, platforms: note.platforms },
    });

    const populated = await ReleaseNote.findById(note._id)
      .populate('school', 'name')
      .populate('createdBy', 'name email')
      .populate('updatedBy', 'name email')
      .lean();

    return res.json({ success: true, message: 'Release note updated successfully', note: populated });
  } catch (error) {
    console.error('Error updating release note:', error);
    return res.status(500).json({ message: 'Error updating release note', error: error.message });
  }
};

exports.deleteReleaseNote = async (req, res) => {
  try {
    const note = await ReleaseNote.findOne({ _id: req.params.id, ...buildSchoolScope(req) });

    if (!note || !isManagedByUser(req, note)) {
      return res.status(404).json({ message: 'Release note not found' });
    }

    await ReleaseNote.deleteOne({ _id: note._id });

    await writeAuditLog({
      req,
      action: 'release_note.delete',
      resourceId: note._id,
      metadata: { title: note.title },
    });

    return res.json({ success: true, message: 'Release note deleted successfully' });
  } catch (error) {
    console.error('Error deleting release note:', error);
    return res.status(500).json({ message: 'Error deleting release note', error: error.message });
  }
};

exports.getUnseenReleaseNotes = async (req, res) => {
  try {
    const platform = allowedPlatforms.includes(req.query.platform) ? req.query.platform : 'mobile';
    const limit = Math.min(5, Math.max(1, Number(req.query.limit) || 3));

    const notes = await ReleaseNote.find(buildVisibleFilter(req, platform))
      .sort({ startsAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({ success: true, notes });
  } catch (error) {
    console.error('Error fetching unseen release notes:', error);
    return res.status(500).json({ message: 'Error fetching what is new', error: error.message });
  }
};

exports.markReleaseNoteSeen = async (req, res) => {
  try {
    const note = await ReleaseNote.findOne({ _id: req.params.id, ...buildSchoolScope(req) });

    if (!note) {
      return res.status(404).json({ message: 'Release note not found' });
    }

    const alreadySeen = note.seenBy.some((entry) => String(entry.user) === String(req.user._id));
    if (!alreadySeen) {
      note.seenBy.push({ user: req.user._id, seenAt: new Date() });
      await note.save();
    }

    return res.json({ success: true, message: 'Release note marked as seen' });
  } catch (error) {
    console.error('Error marking release note as seen:', error);
    return res.status(500).json({ message: 'Error marking release note as seen', error: error.message });
  }
};
