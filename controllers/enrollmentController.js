const Class = require('../models/Class');
const mongoose = require('mongoose');

// --------------------------------------------------------------------
// 🔍 Cache for enrollment data
// --------------------------------------------------------------------
const enrollmentCache = new Map();
const CACHE_TTL = 30 * 1000; // 30 seconds

// --------------------------------------------------------------------
// 📈 Get class enrollment summary (AGGREGATION - RECOMMENDED)
// --------------------------------------------------------------------
exports.getClassEnrollmentSummary = async (req, res) => {
  try {
    const schoolId = req.user.school;

    // Cache check
    const cacheKey = `enrollment_agg_${schoolId}`;
    const cached = enrollmentCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return res.json(cached.data);
    }

    const aggregationResult = await Class.aggregate([
      // Match classes for current school
      {
        $match: {
          school: new mongoose.Types.ObjectId(schoolId)
        }
      },

      // Sort by class name
      { $sort: { name: 1 } },

      // Lookup students for each class
      {
        $lookup: {
          from: 'students',
          let: { classId: '$_id' },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ['$class', '$$classId'] },
                    { $eq: ['$school', new mongoose.Types.ObjectId(schoolId)] }
                  ]
                }
              }
            },
            {
              $lookup: {
                from: 'users',
                localField: 'user',
                foreignField: '_id',
                as: 'userInfo'
              }
            },
            { $unwind: { path: '$userInfo', preserveNullAndEmptyArrays: true } },
            {
              $project: {
                gender: 1,
                dateOfBirth: 1,
                admissionNumber: 1,
                guardianPhone: 1,
                guardianPhone2: 1,
                guardianName: 1,
                guardianOccupation: 1,
                fatherName: 1,
                fatherOccupation: 1,
                motherName: 1,
                motherOccupation: 1,
                religion: 1,
                hometown: 1,
                languageSpoken: 1,
                academicYear: 1,
                'userName': '$userInfo.name',
                'userEmail': '$userInfo.email'
              }
            }
          ],
          as: 'students'
        }
      },

      // Project final structure
      // Project final structure
      {
        $project: {
          classId: '$_id',

          // ✅ ADD THESE TWO LINES
          className: '$name',
          classDisplayName: { $ifNull: ['$displayName', '$name'] },

          boys: {
            $size: {
              $filter: {
                input: '$students',
                as: 'student',
                cond: { $eq: [{ $toLower: '$$student.gender' }, 'male'] }
              }
            }
          },
          girls: {
            $size: {
              $filter: {
                input: '$students',
                as: 'student',
                cond: { $eq: [{ $toLower: '$$student.gender' }, 'female'] }
              }
            }
          },
          total: {
            $add: [
              {
                $size: {
                  $filter: {
                    input: '$students',
                    as: 'student',
                    cond: { $eq: [{ $toLower: '$$student.gender' }, 'male'] }
                  }
                }
              },
              {
                $size: {
                  $filter: {
                    input: '$students',
                    as: 'student',
                    cond: { $eq: [{ $toLower: '$$student.gender' }, 'female'] }
                  }
                }
              }
            ]
          },
          students: {
            $map: {
              input: '$students',
              as: 'student',
              in: {
                _id: '$$student._id',
                name: { $ifNull: ['$$student.userName', 'Unnamed'] },
                email: { $ifNull: ['$$student.userEmail', null] },
                dateOfBirth: '$$student.dateOfBirth',
                admissionNumber: '$$student.admissionNumber',
                gender: '$$student.gender',
                academicYear: '$$student.academicYear',
                guardianPhone: '$$student.guardianPhone',
                guardianPhone2: '$$student.guardianPhone2',
                guardianName: '$$student.guardianName',
                guardianOccupation: '$$student.guardianOccupation',
                fatherName: '$$student.fatherName',
                fatherOccupation: '$$student.fatherOccupation',
                motherName: '$$student.motherName',
                motherOccupation: '$$student.motherOccupation',
                religion: '$$student.religion',
                hometown: '$$student.hometown',
                languageSpoken: '$$student.languageSpoken'
              }
            }
          }
        }
      }
    ]);

    // Calculate school-wide summary
    const schoolSummary = {
      totalClasses: aggregationResult.length,
      totalStudents: aggregationResult.reduce((sum, cls) => sum + cls.total, 0),
      totalBoys: aggregationResult.reduce((sum, cls) => sum + cls.boys, 0),
      totalGirls: aggregationResult.reduce((sum, cls) => sum + cls.girls, 0)
    };

    const result = {
      success: true,
      summary: schoolSummary,
      classes: aggregationResult,
      timestamp: new Date().toISOString()
    };

    // Cache the result
    enrollmentCache.set(cacheKey, { data: result, timestamp: Date.now() });

    res.json(result);

  } catch (err) {
    console.error("❌ getClassEnrollmentSummary error:", err);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch enrollment summary',
      error: err.message
    });
  }
};

// --------------------------------------------------------------------
// 🧹 Cache cleanup
// --------------------------------------------------------------------
exports.clearEnrollmentCache = (schoolId) => {
  if (schoolId) {
    enrollmentCache.delete(`enrollment_agg_${schoolId}`);
  } else {
    enrollmentCache.clear();
  }
};

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of enrollmentCache.entries()) {
    if (now - value.timestamp > CACHE_TTL) {
      enrollmentCache.delete(key);
    }
  }
}, CACHE_TTL);