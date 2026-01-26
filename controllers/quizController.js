const QuizResult = require('../models/QuizResult');
const QuizSession = require('../models/QuizSession');
const QuizAttempt = require('../models/QuizAttempt');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Class = require('../models/Class');
const mongoose = require('mongoose');
const Subject = require('../models/Subject');
const Teacher = require('../models/Teacher');
const Student = require('../models/Student');
const PushToken = require("../models/PushToken");
const { Expo } = require("expo-server-sdk");
const expo = new Expo();


// ---------------------------------------------------------
// 🔔 REUSABLE PUSH SENDER (same as Announcements controller)
// ---------------------------------------------------------
async function sendPush(userIds, title, body, data = {}) {
  if (!Array.isArray(userIds) || userIds.length === 0) return;

  const tokens = await PushToken.find({
    userId: { $in: userIds },
    disabled: false,
  }).lean();

  const valid = tokens
    .map(p => p.token)
    .filter(t => Expo.isExpoPushToken(t));

  if (valid.length === 0) return;

  const messages = valid.map(token => ({
    to: token,
    sound: "default",
    title,
    body,
    data
  }));

  const chunks = expo.chunkPushNotifications(messages);

  for (const chunk of chunks) {
    await expo.sendPushNotificationsAsync(chunk);
  }
}

async function resolveStudentId(req) {
  if (!req?.user?._id || !req?.user?.school) {
    throw new Error("Invalid request context: missing user or school");
  }

  const student = await Student.findOne({
    user: req.user._id,
    school: req.user.school,
    status: "active",
  })
    .select("_id")
    .lean();

  if (!student) {
    throw new Error("Student record not found for this user");
  }

  return student._id;
}

// Add these helper functions at the TOP of your file (after imports)
// ---------------------------
// Seeded Shuffle Functions
// ---------------------------
const createSeededRandom = (seed) => {
  let x = Math.sin(seed) * 10000;
  return () => {
    x = Math.sin(x) * 10000;
    return x - Math.floor(x);
  };
};

const seededShuffle = (array, seedString) => {
  if (!array || !Array.isArray(array)) return array;
  
  // Convert string seed to numeric seed
  let numericSeed = 0;
  for (let i = 0; i < seedString.length; i++) {
    numericSeed = ((numericSeed << 5) - numericSeed) + seedString.charCodeAt(i);
    numericSeed |= 0; // Convert to 32-bit integer
  }
  
  const random = createSeededRandom(numericSeed);
  const shuffled = [...array];
  
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  
  return shuffled;
};

// 🎯 PERFORMANCE OPTIMIZATIONS
// 1. Simple In-Memory Caching Layer (No external dependencies)
class SimpleCache {
  constructor() {
    this.cache = new Map();
    this.timers = new Map();
  }

  set(key, value, ttl = 300) {
    this.cache.set(key, {
      value,
      expires: Date.now() + (ttl * 1000)
    });

    // Clear existing timer
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
    }

    // Set new timer for expiration
    const timer = setTimeout(() => {
      this.del(key);
    }, ttl * 1000);

    this.timers.set(key, timer);
  }

  get(key) {
    const item = this.cache.get(key);
    if (!item) return undefined;

    if (Date.now() > item.expires) {
      this.del(key);
      return undefined;
    }

    return item.value;
  }

  del(key) {
    this.cache.delete(key);
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
  }

  flush() {
    this.cache.clear();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  // Delete keys by pattern (for cache invalidation)
  delPattern(pattern) {
    const keysToDelete = [];
    for (const key of this.cache.keys()) {
      if (key.includes(pattern)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach(key => this.del(key));
  }
}

// 2. Database Query Optimizations
const MAX_QUERY_TIMEOUT = 10000; // 10 seconds
const BATCH_SIZE = 50;

// 3. Cache Instance
const cache = new SimpleCache();

// 4. Cache Keys
const CACHE_KEYS = {
  QUIZ_CLASS: (classId, role, userId) => `quiz:class:${classId}:${role}:${userId}`,
  QUIZ_SCHOOL: (schoolId) => `quiz:school:${schoolId}`,
  TEACHER_SUBJECTS: (teacherId) => `teacher:subjects:${teacherId}`,
  STUDENT_PROGRESS: (studentId) => `student:progress:${studentId}`,
  QUIZ_RESULTS: (quizId) => `quiz:results:${quizId}`,
  CLASS_RESULTS_TEACHER: (teacherId) => `class:results:teacher:${teacherId}`,
  QUIZ_SINGLE: (quizId, role) => `quiz:single:${quizId}:${role}`
};

// 🔧 Helper Functions (Optimized)
const toObjectId = (id) => {
  if (!id) return null;
  try {
    return new mongoose.Types.ObjectId(id);
  } catch {
    return null;
  }
};

const resolveSubjectName = (quiz) => {
  if (!quiz) return "Unknown Subject";
  if (quiz.subject && typeof quiz.subject === "object" && quiz.subject.name)
    return quiz.subject.name;
  if (quiz.subjectName) return quiz.subjectName;
  if (typeof quiz.subject === "string") return quiz.subject;
  return "Unknown Subject";
};

// ==============================
// Helper: Resolve class names (Quizzes = class-based)
// ==============================
function resolveQuizClassNames(cls) {
  if (!cls) {
    return {
      className: "Unassigned",
      classDisplayName: null,
    };
  }

  const className = cls.name || "Unassigned";

  const classDisplayName =
    cls.displayName ||
    (cls.stream ? `${cls.name}${cls.stream}` : cls.name);

  return { className, classDisplayName };
}

// 🎯 Optimized Database Operations
const executeWithTimeout = async (operation, timeout = MAX_QUERY_TIMEOUT) => {
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error('Database operation timeout')), timeout)
  );
  return Promise.race([operation, timeoutPromise]);
};

const batchProcess = async (items, batchSize, processor) => {
  const results = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchResults = await Promise.all(batch.map(processor));
    results.push(...batchResults);
  }
  return results;
};

// 🎯 Optimized Helper Functions
const getCachedTeacherSubjects = async (teacherUserId, school) => {
  const cacheKey = CACHE_KEYS.TEACHER_SUBJECTS(teacherUserId.toString());
  const cached = cache.get(cacheKey);
  
  if (cached) {
    return cached;
  }

  const teacherDoc = await Teacher.findOne({ user: teacherUserId, school })
    .populate('subjects', 'name shortName aliases')
    .lean()
    .maxTimeMS(MAX_QUERY_TIMEOUT);

  if (!teacherDoc || !Array.isArray(teacherDoc.subjects) || teacherDoc.subjects.length === 0) {
    return [];
  }

  cache.set(cacheKey, teacherDoc.subjects, 600); // 10 min cache for teacher subjects
  return teacherDoc.subjects;
};

const resolveStudentInfo = async (studentId, school) => {
  const cacheKey = `student:info:${studentId}:${school}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Try Student model first with optimized query
  let studentDoc = await Student.findOne({ _id: studentId, school })
    .populate("user", "name email")
    .populate("class", "name")
    .lean()
    .maxTimeMS(MAX_QUERY_TIMEOUT);

  if (studentDoc) {
    const result = {
      studentId: studentDoc._id,
      name: studentDoc.user?.name || "Unnamed Student",
      email: studentDoc.user?.email || "",
      className: studentDoc.class?.name || "Unknown Class",
    };
    cache.set(cacheKey, result, 300); // 5 min cache
    return result;
  }

  // Fallback to User model
  const userDoc = await User.findOne({ _id: studentId, school })
    .lean()
    .maxTimeMS(MAX_QUERY_TIMEOUT);

  if (userDoc) {
    const linkedStudent = await Student.findOne({ user: userDoc._id, school })
      .populate("class", "name")
      .lean()
      .maxTimeMS(MAX_QUERY_TIMEOUT);

    const result = {
      studentId: linkedStudent?._id || userDoc._id,
      name: userDoc.name || "Unnamed User",
      email: userDoc.email || "",
      className: linkedStudent?.class?.name || "Unknown Class",
    };
    cache.set(cacheKey, result, 300);
    return result;
  }

  const defaultResult = {
    studentId,
    name: "Unknown Student",
    email: "",
    className: "Unknown Class",
  };
  cache.set(cacheKey, defaultResult, 60); // 1 min cache for fallback
  return defaultResult;
};

// 🎯 Background Processing
const processInBackground = (operation) => {
  setImmediate(async () => {
    try {
      await operation();
    } catch (error) {
      console.error('Background processing error:', error.message);
    }
  });
};





// ---------------------------
// 1. Create Quiz Manually (Optimized with Caching)
// ---------------------------
const createQuiz = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    console.log("🚀 [CREATE QUIZ] Incoming request body:", req.body);

    const {
      title,
      questions,
      sections,              // 🔴 SECTION SUPPORT
      classId,
      dueDate,
      timeLimit,
      startTime,
      shuffleQuestions,
      shuffleOptions,
      description,
      notesText,
      subjectId,
      subjectName,
    } = req.body;

    const teacherUserId = req.user._id;
    const school = toObjectId(req.user.school);

    // --------------------------------------------------
    // 🔒 Enforce ONE structure only
    // --------------------------------------------------
    if (questions?.length && sections?.length) {
      await session.abortTransaction();
      return res.status(400).json({
        message: "Quiz cannot contain both questions and sections",
      });
    }

    if (
      (!questions || questions.length === 0) &&
      (!sections || sections.length === 0)
    ) {
      await session.abortTransaction();
      return res.status(400).json({
        message: "Quiz must contain questions or sections",
      });
    }

    // --------------------------------------------------
    // 🧪 COMMON QUESTION VALIDATOR (USED BY BOTH MODES)
    // --------------------------------------------------
    const validateQuestion = async (q, label) => {
      if (!q.questionText || !q.type) {
        throw new Error(`${label} is missing questionText or type`);
      }

      const type = q.type.toLowerCase();

      // 🟢 MULTIPLE CHOICE
      if (type === "multiple-choice") {
        if (!Array.isArray(q.options) || q.options.length < 2) {
          throw new Error(`${label}: MCQ requires at least 2 options`);
        }
        if (!q.options.includes(q.correctAnswer)) {
          throw new Error(`${label}: correctAnswer must be one of the options`);
        }
      }

      // 🟢 TRUE / FALSE
      if (type === "true-false" && typeof q.correctAnswer !== "boolean") {
        throw new Error(`${label}: True/False requires boolean correctAnswer`);
      }

      // 🟣 CLOZE (MCQ WITH BLANKS)
      if (type === "cloze") {
        if (!Array.isArray(q.blanks) || q.blanks.length === 0) {
          throw new Error(`${label}: Cloze question must have blanks`);
        }

        for (let i = 0; i < q.blanks.length; i++) {
          const b = q.blanks[i];

          if (typeof b.blankNumber !== "number") {
            throw new Error(`${label}: Blank ${i + 1} missing blankNumber`);
          }

          if (!Array.isArray(b.options) || b.options.length < 2) {
            throw new Error(`${label}: Blank ${b.blankNumber} needs ≥2 options`);
          }

          if (!b.options.includes(b.correctAnswer)) {
            throw new Error(
              `${label}: Blank ${b.blankNumber} correctAnswer must be in options`
            );
          }
        }

        // ❌ Disallow these on cloze
        delete q.correctAnswer;
        delete q.options;
      }

      if (!q.points) q.points = 1;
    };

    // --------------------------------------------------
    // 🧪 Validate FLAT QUESTIONS
    // --------------------------------------------------
    if (questions?.length) {
      for (let i = 0; i < questions.length; i++) {
        await validateQuestion(questions[i], `Question ${i + 1}`);
      }
    }

    // --------------------------------------------------
    // 🧪 Validate SECTIONS
    // --------------------------------------------------
    if (sections?.length) {
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];

        if (!section.instruction || !section.instruction.trim()) {
          await session.abortTransaction();
          return res.status(400).json({
            message: `Section ${i + 1} must have an instruction`,
          });
        }

        if (!Array.isArray(section.questions) || section.questions.length === 0) {
          await session.abortTransaction();
          return res.status(400).json({
            message: `Section ${i + 1} must contain questions`,
          });
        }

        for (let j = 0; j < section.questions.length; j++) {
          await validateQuestion(
            section.questions[j],
            `Section ${i + 1}, Question ${j + 1}`
          );
        }
      }
    }

    // --------------------------------------------------
    // 🎯 Resolve subject (UNCHANGED)
    // --------------------------------------------------
    const teacherSubjects = await getCachedTeacherSubjects(teacherUserId, school);
    if (!teacherSubjects.length) {
      await session.abortTransaction();
      return res.status(400).json({ message: "No subjects assigned to this teacher" });
    }

    let chosenSubjectDoc =
      teacherSubjects.find(s => String(s._id) === String(subjectId)) ||
      teacherSubjects.find(s => s.name === subjectName) ||
      (teacherSubjects.length === 1 ? teacherSubjects[0] : null);

    if (!chosenSubjectDoc) {
      await session.abortTransaction();
      return res.status(400).json({
        message: "Unable to resolve subject",
      });
    }

    // --------------------------------------------------
    // ✅ CREATE QUIZ
    // --------------------------------------------------
    const quiz = new QuizSession({
      school,
      teacher: teacherUserId,
      class: classId,
      subject: chosenSubjectDoc._id,
      subjectName: chosenSubjectDoc.name,
      title: title || `${chosenSubjectDoc.name} Quiz`,
      description: description || "",
      notesText: notesText || "",
      questions: sections?.length ? [] : questions,
      sections: sections?.length ? sections : [],
      dueDate: dueDate || null,
      timeLimit: timeLimit || null,
      startTime: startTime || null,
      shuffleQuestions: !!shuffleQuestions,
      shuffleOptions: !!shuffleOptions,
      isPublished: false,
    });

    await quiz.save({ session });
    await session.commitTransaction();

    processInBackground(() => {
      cache.del(CACHE_KEYS.QUIZ_CLASS(classId, "teacher", teacherUserId));
      cache.del(CACHE_KEYS.QUIZ_SCHOOL(school.toString()));
    });

    res.status(201).json({
      message: "Quiz created successfully",
      quiz,
    });

  } catch (error) {
    await session.abortTransaction();
    console.error("🔥 Quiz creation failed:", error);
    res.status(500).json({
      message: "Error creating quiz",
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};



// ---------------------------
// 2. Publish/Unpublish QuizSession (Optimized + Push Added)
// ---------------------------
const publishQuiz = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { quizId } = req.params;
    const { publish } = req.body;
    const school = toObjectId(req.user.school);

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    const quiz = await QuizSession.findOne({
      _id: toObjectId(quizId),
      school,
    }).session(session);

    if (!quiz) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Quiz not found in your school" });
    }

    if (quiz.teacher.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      return res
        .status(403)
        .json({ message: "You can only publish quizzes you created" });
    }

    // --------------------------------------------------
    // 🔴 FINAL VALIDATION BEFORE PUBLISH
    // --------------------------------------------------
    if (publish) {
      // 🔥 Flatten questions (sections OR flat)
      let allQuestions = [];

      if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
        quiz.sections.forEach(section => {
          section.questions.forEach(q => allQuestions.push(q));
        });
      } else {
        allQuestions = quiz.questions || [];
      }

      if (!allQuestions.length) {
        await session.abortTransaction();
        return res.status(400).json({
          message: "Quiz has no questions and cannot be published",
        });
      }

      let hasAutoGradable = false;

      for (let i = 0; i < allQuestions.length; i++) {
        const q = allQuestions[i];
        const type = (q.type || "").toLowerCase();

        // 🟣 CLOZE VALIDATION
        if (type === "cloze") {
          if (!Array.isArray(q.blanks) || q.blanks.length === 0) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Cloze question ${i + 1} has no blanks`,
            });
          }

          q.blanks.forEach((b, idx) => {
            if (
              !Array.isArray(b.options) ||
              b.options.length < 2 ||
              !b.options.includes(b.correctAnswer)
            ) {
              throw new Error(
                `Cloze question ${i + 1}, blank ${idx + 1} is invalid`
              );
            }
          });

          hasAutoGradable = true;
        }

        // 🟢 OBJECTIVE QUESTIONS
        if (["multiple-choice", "true-false"].includes(type)) {
          hasAutoGradable = true;
        }
      }

      // (Optional but recommended)
      if (!hasAutoGradable) {
        await session.abortTransaction();
        return res.status(400).json({
          message:
            "Quiz cannot be published because it contains no auto-gradable questions",
        });
      }

      quiz.publishedAt = new Date();
    } else {
      quiz.publishedAt = null;
    }

    quiz.isPublished = publish;
    await quiz.save({ session });
    await session.commitTransaction();

    // ===============================
    // 📌 CREATE IN-APP NOTIFICATION
    // ===============================
    if (publish) {
      processInBackground(async () => {
        try {
          await Notification.create({
            title: "New Quiz Published",
            sender: req.user._id,
            school: req.user.school,
            message: `New quiz posted: ${quiz.title}`,
            type: "online-quiz",
            audience: "student",
            class: quiz.class,
            recipientRoles: ["student", "parent"],
          });
        } catch (notifError) {
          console.error("Notification creation failed:", notifError);
        }
      });

      // ===============================
      // 🔔 SEND PUSH NOTIFICATIONS
      // ===============================
      processInBackground(async () => {
        try {
          const students = await Student.find({
            class: quiz.class,
            school: req.user.school,
          })
            .select("user parent parentIds")
            .lean();

          let recipients = [];

          students.forEach(s => {
            if (s.user) recipients.push(String(s.user));
            if (s.parent) recipients.push(String(s.parent));
            if (Array.isArray(s.parentIds)) {
              recipients.push(...s.parentIds.map(id => String(id)));
            }
          });

          recipients = [...new Set(recipients)];

          if (recipients.length > 0) {
            await sendPush(
              recipients,
              "New Quiz Published",
              `${quiz.title} is now available`,
              { quizId: quiz._id, type: "quiz-published" }
            );
          }
        } catch (err) {
          console.error("⚠️ Quiz publish push failed:", err.message);
        }
      });
    }

    // ===============================
    // 🧹 CACHE INVALIDATION
    // ===============================
    processInBackground(() => {
      cache.del(
        CACHE_KEYS.QUIZ_CLASS(quiz.class.toString(), "teacher", req.user._id)
      );
      cache.delPattern(
        CACHE_KEYS.QUIZ_CLASS(quiz.class.toString(), "student", "")
      );
      cache.del(CACHE_KEYS.QUIZ_SINGLE(quizId, "teacher"));
      cache.del(CACHE_KEYS.QUIZ_SINGLE(quizId, "student"));
    });

    res.json({
      message: `Quiz ${publish ? "published" : "unpublished"} successfully`,
      quiz,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Quiz publish/unpublish failed:", error);
    res.status(500).json({
      message: "Error updating quiz status",
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};



// ---------------------------
// 3. Get QuizSession with Caching (Fixed & Safe)
// ---------------------------
const getQuiz = async (req, res) => {
  try {
    const { quizId } = req.params;
    const school = toObjectId(req.user.school);
    const userId = req.user._id;

    console.log(`📥 Loading quiz ${quizId} for user ${userId}, role: ${req.user.role}`);

    // Validate quiz ID
    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: 'Invalid quiz ID format' });
    }

    // Never cache for students (due to shuffling)
    const cacheKey = CACHE_KEYS.QUIZ_SINGLE(quizId, req.user.role);
    if (req.user.role !== "student") {
      const cached = cache.get(cacheKey);
      if (cached) {
        return res.json(cached);
      }
    }

    // Fetch quiz
    const quiz = await executeWithTimeout(
      QuizSession.findOne({
        _id: toObjectId(quizId),
        school
      }).lean().maxTimeMS(5000)
    );

    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found in your school' });
    }

    console.log(`✅ Quiz found: ${quiz.title}, Published: ${quiz.isPublished}`);

    // Students only see it after startTime and if published
    if (req.user.role === 'student') {
      if (quiz.startTime && new Date() < new Date(quiz.startTime)) {
        return res.status(403).json({ message: 'Quiz is not available yet' });
      }

      if (!quiz.isPublished) {
        return res.status(403).json({ message: 'Quiz is not published yet' });
      }
    }

    let response;

    // =====================================================
    // 🟢 STUDENT VIEW (SECTION-AWARE + SHUFFLING)
    // =====================================================
    if (req.user.role === 'student') {
      const seed = `${userId}-${quizId}`;

      // ---------------------------------
      // 🔹 SECTIONED QUIZ
      // ---------------------------------
      if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
        const processedSections = quiz.sections.map((section, sectionIndex) => {
          let sectionQuestions = [...section.questions];

          if (quiz.shuffleQuestions) {
            sectionQuestions = seededShuffle(
              sectionQuestions,
              seed + `-section-${sectionIndex}`
            );
          }

          const safeQuestions = sectionQuestions.map((q, index) => {
            const question = {
              _id: q._id || `temp-${sectionIndex}-${index}`,
              questionText: q.questionText,
              type: q.type,
              explanation: q.explanation || '',
              points: q.points || 1,
            };

            // 🟣 CLOZE (MCQ WITH BLANKS)
            if (q.type === 'cloze' && Array.isArray(q.blanks)) {
              question.blanks = q.blanks.map(b => ({
                blankNumber: b.blankNumber,
                options: quiz.shuffleOptions
                  ? seededShuffle(
                      [...b.options],
                      seed + `-cloze-${q._id}-${b.blankNumber}`
                    )
                  : [...b.options],
              }));
            }

            // 🟢 NORMAL MCQ / TF
            if (Array.isArray(q.options) && q.options.length > 0) {
              question.options = quiz.shuffleOptions
                ? seededShuffle(
                    [...q.options],
                    seed + `-options-${q._id || index}`
                  )
                : [...q.options];
            }

            // 🔒 Never expose answers
            if (process.env.NODE_ENV !== 'development') {
              delete question.correctAnswer;
            }

            return question;
          });

          return {
            title: section.title || null,
            instruction: section.instruction,
            questions: safeQuestions,
          };
        });

        response = {
          _id: quiz._id,
          title: quiz.title,
          subject: quiz.subject,
          timeLimit: quiz.timeLimit,
          startTime: quiz.startTime,
          dueDate: quiz.dueDate,
          sections: processedSections,
          shuffleQuestions: quiz.shuffleQuestions,
          shuffleOptions: quiz.shuffleOptions,
          totalPoints: quiz.sections.reduce(
            (sum, s) =>
              sum +
              s.questions.reduce((qSum, q) => {
                if (q.type === 'cloze' && Array.isArray(q.blanks)) {
                  return qSum + q.blanks.length * (q.points || 1);
                }
                return qSum + (q.points || 1);
              }, 0),
            0
          ),
        };

        return res.json(response);
      }

      // ---------------------------------
      // 🔹 FLAT QUESTIONS (legacy)
      // ---------------------------------
      let quizQuestions = [...(quiz.questions || [])];

      if (quiz.shuffleQuestions) {
        quizQuestions = seededShuffle(quizQuestions, seed + '-questions');
      }

      const questionsWithoutAnswers = quizQuestions.map((q, index) => {
        const question = {
          _id: q._id || `temp-${index}`,
          questionText: q.questionText,
          type: q.type,
          explanation: q.explanation || '',
          points: q.points || 1,
        };

        // 🟣 CLOZE
        if (q.type === 'cloze' && Array.isArray(q.blanks)) {
          question.blanks = q.blanks.map(b => ({
            blankNumber: b.blankNumber,
            options: quiz.shuffleOptions
              ? seededShuffle(
                  [...b.options],
                  seed + `-cloze-${q._id}-${b.blankNumber}`
                )
              : [...b.options],
          }));
        }

        // 🟢 NORMAL OPTIONS
        if (Array.isArray(q.options) && q.options.length > 0) {
          question.options = quiz.shuffleOptions
            ? seededShuffle(
                [...q.options],
                seed + '-options-' + (q._id || index)
              )
            : [...q.options];
        }

        if (process.env.NODE_ENV !== 'development') {
          delete question.correctAnswer;
        }

        return question;
      });

      response = {
        _id: quiz._id,
        title: quiz.title,
        subject: quiz.subject,
        timeLimit: quiz.timeLimit,
        startTime: quiz.startTime,
        dueDate: quiz.dueDate,
        questions: questionsWithoutAnswers,
        shuffleQuestions: quiz.shuffleQuestions,
        shuffleOptions: quiz.shuffleOptions,
        totalPoints: quizQuestions.reduce((s, q) => {
          if (q.type === 'cloze' && Array.isArray(q.blanks)) {
            return s + q.blanks.length * (q.points || 1);
          }
          return s + (q.points || 1);
        }, 0),
      };

      return res.json(response);
    }

    // =====================================================
    // 🟠 TEACHER VIEW (RAW, SAFE TO CACHE)
    // =====================================================
    response = quiz;
    cache.set(cacheKey, response, 300);
    return res.json(response);

  } catch (error) {
    console.error("❌ getQuiz error:", error);
    res.status(500).json({
      message: 'Error fetching quiz',
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
};



/// ---------------------------
// 4. Get QuizSessions for a Class (Optimized & Fixed)
// ---------------------------
const getQuizzesForClass = async (req, res) => {
  try {
    const { classId } = req.params;
    const school = toObjectId(req.user.school);
    const role = req.user.role;
    const userId = req.user._id;

    if (!classId || !mongoose.Types.ObjectId.isValid(classId)) {
      return res.status(400).json({ message: "Invalid class ID format" });
    }

    // Cache key per user & class
    const cacheKey = CACHE_KEYS.QUIZ_CLASS(classId, role, userId);
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    // ---------------------------
    // Base filter
    // ---------------------------
    const filter = {
      school,
      class: toObjectId(classId),
    };

    if (role === "student") {
      filter.isPublished = true;
    }

    if (role === "teacher") {
      filter.teacher = req.user._id; // 🔐 teacher isolation
    }

    // ---------------------------
    // Fetch quizzes
    // ---------------------------
    const quizzes = await executeWithTimeout(
      QuizSession.find(filter)
        .populate({ path: "subject", select: "name shortName" })
        .select(role === "student" ? "-questions.correctAnswer -sections.questions.correctAnswer" : "")
        .sort({ createdAt: -1 })
        .lean(),
      5000
    );

    if (!quizzes.length) {
      cache.set(cacheKey, [], 60);
      return res.json([]);
    }

    // --------------------------------------------------
// 🔴 FIX: CLOZE-AWARE TOTAL POINTS CALCULATOR
// --------------------------------------------------
const computeTotalPoints = (quiz) => {
  const sumQuestions = (questions = []) =>
    questions.reduce((sum, q) => {
      // ✅ Cloze = MCQ with format === "cloze"
      if (
        q.type === "multiple-choice" &&
        q.format === "cloze" &&
        Array.isArray(q.blanks)
      ) {
        return sum + q.blanks.length * (q.points || 1);
      }

      // ✅ Normal questions
      return sum + (q.points || 1);
    }, 0);

  // ✅ Section-based quiz
  if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
    return quiz.sections.reduce(
      (total, section) => total + sumQuestions(section.questions),
      0
    );
  }

  // ✅ Flat quiz
  return sumQuestions(quiz.questions);
};

    const quizIds = quizzes.map(q => toObjectId(q._id));

    // ============================
    // 🔵 STUDENT VIEW
    // ============================
    if (role === "student") {
      const studentDoc = await executeWithTimeout(
        Student.findOne({ user: toObjectId(userId), school }).lean(),
        5000
      );

      const studentObjectId = studentDoc?._id;

      const [notifications, completedResults, activeAttempts] = await Promise.all([
        executeWithTimeout(
          Notification.find({
            school,
            type: "quiz",
            quizId: { $in: quizIds },
            $or: [
              { studentId: studentObjectId },
              { recipientUsers: userId },
              { recipientRoles: "student" }
            ]
          })
            .select("quizId message isRead createdAt")
            .lean(),
          5000
        ),

        executeWithTimeout(
          QuizResult.find({
            quizId: { $in: quizIds },
            $or: [
              { studentId: toObjectId(userId) },
              { studentId: studentObjectId }
            ],
            school
          })
            .select("quizId")
            .lean(),
          5000
        ),

        executeWithTimeout(
          QuizAttempt.find({
            quizId: { $in: quizIds },
            $or: [
              { studentId: toObjectId(userId) },
              { studentId: studentObjectId }
            ],
            school,
            status: "in-progress",
            expiresAt: { $gt: new Date() }
          })
            .select("quizId")
            .lean(),
          5000
        )
      ]);

      const notifMap = Object.fromEntries(
        notifications.map(n => [n.quizId?.toString(), n])
      );

      const completedMap = new Set(completedResults.map(r => r.quizId.toString()));
      const inProgressMap = new Set(activeAttempts.map(a => a.quizId.toString()));

      const quizzesWithProgress = quizzes.map(q => {
        const id = q._id.toString();
        const completed = completedMap.has(id);
        const inProgress = !completed && inProgressMap.has(id);

        const { className, classDisplayName } = resolveQuizClassNames(q.class);

        return {
          ...q,
          subject: q.subject?.name ?? "Unknown Subject",
          className,
          classDisplayName,
          totalPoints: computeTotalPoints(q), // 🔴 FIX
          completed,
          inProgress,
          status: completed ? "Completed" : inProgress ? "In Progress" : "Available",
          notification: notifMap[id] || null
        };
      });

      processInBackground(async () => {
        await Notification.updateMany(
          {
            quizId: { $in: quizIds },
            type: "quiz",
            isRead: false,
            $or: [{ studentId: studentObjectId }, { recipientUsers: userId }]
          },
          { $set: { isRead: true } }
        );
      });

      cache.set(cacheKey, quizzesWithProgress, 180);
      return res.json(quizzesWithProgress);
    }

    // ============================
    // 🟠 TEACHER VIEW
    // ============================
    const [resultsAgg, attemptsAgg] = await Promise.all([
      executeWithTimeout(
        QuizResult.aggregate([
          { $match: { quizId: { $in: quizIds }, school } },
          {
            $group: {
              _id: "$quizId",
              submissionCount: { $sum: 1 },
              averageScore: { $avg: "$score" }
            }
          }
        ]),
        5000
      ),

      executeWithTimeout(
        QuizAttempt.aggregate([
          {
            $match: {
              quizId: { $in: quizIds },
              school,
              status: "in-progress",
              expiresAt: { $gt: new Date() }
            }
          },
          { $group: { _id: "$quizId", inProgressCount: { $sum: 1 } } }
        ]),
        5000
      )
    ]);

    const resultsMap = new Map(
      resultsAgg.map(r => [
        r._id.toString(),
        { submissionCount: r.submissionCount, averageScore: r.averageScore }
      ])
    );

    const attemptsMap = new Map(
      attemptsAgg.map(a => [a._id.toString(), a.inProgressCount])
    );

    const quizzesWithStats = quizzes.map(q => {
      const id = q._id.toString();
      const stats = resultsMap.get(id) || {
        submissionCount: 0,
        averageScore: null
      };

      const { className, classDisplayName } = resolveQuizClassNames(q.class);

      return {
        ...q,
        subject: q.subject?.name ?? "Unknown Subject",
        className,
        classDisplayName,
        totalPoints: computeTotalPoints(q), // 🔴 FIX
        submissionCount: stats.submissionCount,
        averageScore: stats.averageScore,
        inProgressCount: attemptsMap.get(id) || 0
      };
    });

    cache.set(cacheKey, quizzesWithStats, 120);
    return res.json(quizzesWithStats);

  } catch (error) {
    console.error("❌ Error fetching quizzes with progress:", error);
    return res.status(500).json({
      message: "Error fetching quizzes",
      error: error.message
    });
  }
};



// ---------------------------
// 5. Get All QuizSessions for a School
// ---------------------------
const getQuizzesForSchool = async (req, res) => {
  try {
    const { schoolId } = req.params;

    if (!schoolId || !mongoose.Types.ObjectId.isValid(schoolId)) {
      return res.status(400).json({ message: 'Invalid school ID format' });
    }

    // Fetch quizzes
    const quizzes = await QuizSession.find({ school: toObjectId(schoolId) })
      .populate('teacher', 'name email')
      .populate('class', 'name')
      .populate({ path: 'subject', select: 'name shortName' })
      .sort({ createdAt: -1 })
      .lean(); // 🔴 ensure plain object for safe computation

    if (!quizzes || quizzes.length === 0) {
      return res.status(404).json({ message: 'No quizzes found for this school' });
    }

    // --------------------------------------------------
    // 🔴 FIX: CLOZE-AWARE TOTAL POINTS CALCULATOR
    // --------------------------------------------------
    const computeTotalPoints = (quiz) => {
      const sumQuestions = (questions = []) =>
        questions.reduce((sum, q) => {
          if (q.type === 'cloze' && Array.isArray(q.blanks)) {
            return sum + q.blanks.length * (q.points || 1);
          }
          return sum + (q.points || 1);
        }, 0);

      if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
        return quiz.sections.reduce(
          (total, section) => total + sumQuestions(section.questions),
          0
        );
      }

      return sumQuestions(quiz.questions);
    };

    // Format response
    const formattedQuizzes = quizzes.map(q => {
      const { className, classDisplayName } = resolveQuizClassNames(q.class);

      return {
        _id: q._id,
        title: q.title,
        className,
        classDisplayName,
        teacher: q.teacher?.name || 'Unknown Teacher',
        subject: resolveSubjectName(q),
        totalPoints: computeTotalPoints(q), // 🔴 FIX
        createdAt: q.createdAt,
        dueDate: q.dueDate,
        isPublished: q.isPublished,
      };
    });

    return res.json({ quizzes: formattedQuizzes });
  } catch (error) {
    console.error('❌ Error fetching school quizzes:', error);
    return res.status(500).json({
      message: 'Error fetching school quizzes',
      error: error.message,
    });
  }
};



// ---------------------------
// 6. Get Protected QuizSession (Anti-Cheating for Mobile)
// ---------------------------
const getProtectedQuiz = async (req, res) => {
  try {
    const { quizId } = req.params;
    const school = toObjectId(req.user.school);
    const userId = req.user._id;

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: 'Invalid quiz ID format' });
    }

    // 🎯 Parallel validation checks
    const [quiz, student] = await Promise.all([
      executeWithTimeout(
        QuizSession.findOne({ _id: toObjectId(quizId), school })
          .lean()
          .maxTimeMS(5000)
      ),
      executeWithTimeout(
        User.findOne({ _id: toObjectId(userId), school })
          .lean()
          .maxTimeMS(5000)
      )
    ]);

    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found in your school' });
    }

    if (req.user.role === 'student') {
      if (!student || student.class?.toString() !== quiz.class.toString()) {
        return res.status(403).json({ message: 'You are not allowed to access this quiz' });
      }

      if (quiz.startTime && new Date() < new Date(quiz.startTime)) {
        return res.status(403).json({ message: 'Quiz is not available yet' });
      }

      if (!quiz.isPublished) {
        return res.status(403).json({ message: 'Quiz is not published yet' });
      }
    }

    const sessionId = new mongoose.Types.ObjectId();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // 🎯 Background session creation
    processInBackground(async () => {
      try {
        await QuizAttempt.create({
          sessionId,
          quizId: toObjectId(quizId),
          studentId: req.user.role === 'student' ? toObjectId(userId) : null,
          school,
          startTime: new Date(),
          expiresAt,
          status: "in-progress",
          answers: {} // 🔴 REQUIRED FOR CLOZE
        });
      } catch (sessionError) {
        console.error('Session creation failed:', sessionError);
      }
    });

    // --------------------------------------------------
    // 🔥 FLATTEN QUESTIONS (SECTIONS OR FLAT)
    // --------------------------------------------------
    let questions = [];

    if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
      quiz.sections.forEach(section => {
        section.questions.forEach(q => {
          questions.push({
            ...q,
            __sectionInstruction: section.instruction || null
          });
        });
      });
    } else {
      questions = quiz.questions || [];
    }

    // --------------------------------------------------
    // 🔀 SHUFFLE QUESTIONS
    // --------------------------------------------------
    if (quiz.shuffleQuestions) {
      questions = [...questions].sort(() => Math.random() - 0.5);
    }

    // --------------------------------------------------
    // 🔒 OBFUSCATE QUESTIONS (CLOZE-SAFE)
    // --------------------------------------------------
    const protectedQuestions = questions.map((q, index) => {
      const questionId = `q${index}_${sessionId}`;

      // ----------------------------
      // 🟣 CLOZE QUESTION
      // ----------------------------
      if (q.type === 'cloze' && Array.isArray(q.blanks)) {
        return {
          id: questionId,
          questionId: q._id, // 🔴 needed for submit mapping
          questionText: obfuscateText(q.questionText),
          type: 'cloze',
          points: q.points || 1,
          blanks: q.blanks.map(blank => ({
            blankNumber: blank.blankNumber,
            options: (blank.options || []).map(opt => ({
              text: obfuscateText(opt),
              id: `opt_${Math.random().toString(36).substr(2, 9)}`,
              value: opt
            }))
          }))
        };
      }

      // ----------------------------
      // 🟢 NORMAL QUESTIONS
      // ----------------------------
      let options = [];
      if (Array.isArray(q.options) && q.options.length > 0) {
        options = [...q.options];

        if (quiz.shuffleOptions) {
          options = options.sort(() => Math.random() - 0.5);
        }

        options = options.map(opt => ({
          text: obfuscateText(opt),
          id: `opt_${Math.random().toString(36).substr(2, 9)}`,
          value: opt
        }));
      }

      return {
        id: questionId,
        questionId: q._id,
        questionText: obfuscateText(q.questionText),
        type: q.type,
        options,
        points: q.points || 1
      };
    });

    return res.json({
      sessionId,
      quizTitle: quiz.title,
      timeLimit: quiz.timeLimit,
      questions: protectedQuestions,
      expiresAt,
      startTime: new Date()
    });

  } catch (error) {
    console.error('Error getting protected quiz:', error);
    return res.status(500).json({
      message: 'Error loading quiz',
      error: error.message
    });
  }
};

function obfuscateText(text) {
  if (!text) return text;
  const words = text.split(' ');
  return words.map(word => word.split('').join('\u200B')).join(' ');
}



// ---------------------------
// 7. Validate QuizSession Session - OPTIMIZED
// ---------------------------
const validateQuizSession = async (req, res, next) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ message: 'Session ID is required' });
    }
    
    const session = await executeWithTimeout(
      QuizSession.findOne({ 
        sessionId, 
        expiresAt: { $gt: new Date() } 
      }).maxTimeMS(5000)
    );
    
    if (!session) {
      return res.status(403).json({ message: 'Invalid or expired quiz session' });
    }
    
    if (req.user.role === 'student' && session.studentId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'This session does not belong to you' });
    }
    
    req.quizSession = session;
    next();
  } catch (error) {
    res.status(500).json({ message: 'Session validation failed', error: error.message });
  }
};

// ---------------------------
// 9. Get QuizSession Results (Optimized)
// ---------------------------
const getQuizResults = async (req, res) => {
  try {
    const { quizId } = req.params;
    const school = toObjectId(req.user.school);
    const cacheKey = CACHE_KEYS.QUIZ_RESULTS(quizId);

    // 🎯 Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: 'Invalid quiz ID format' });
    }

    const results = await executeWithTimeout(
      QuizResult.find({
        quizId: toObjectId(quizId),
        school
      })
        .populate('studentId', 'name email')
        .sort({ submittedAt: -1 })
        .lean()
        .maxTimeMS(8000)
    );

    const formatted = results.map((r) => {
      const answers = Array.isArray(r.answers) ? r.answers : [];

      // --------------------------------------------------
      // 🔴 GROUP ANSWERS BY SECTION
      // --------------------------------------------------
      const sectionsMap = {};

      answers.forEach(a => {
        const sectionKey = a.sectionInstruction || '__NO_SECTION__';
        if (!sectionsMap[sectionKey]) {
          sectionsMap[sectionKey] = [];
        }
        sectionsMap[sectionKey].push(a);
      });

      const sections =
        Object.keys(sectionsMap).length > 0
          ? Object.entries(sectionsMap).map(([instruction, rawAnswers]) => {
              // -----------------------------------------
              // 🟣 GROUP CLOZE BY QUESTION
              // -----------------------------------------
              const grouped = {};
              rawAnswers.forEach(ans => {
                const key = ans.questionId?.toString();
                if (!grouped[key]) grouped[key] = [];
                grouped[key].push(ans);
              });

              const questions = Object.values(grouped).map(group => {
                const base = group[0];
                const type = (base.questionType || '').toLowerCase();

                // 🟣 CLOZE
                if (type === 'multiple-choice' && group.length > 1) {
                  return {
                    questionId: base.questionId,
                    questionText: base.questionText,
                    questionType: 'cloze',
                    blanks: group.map(b => ({
                      selectedAnswer: b.selectedAnswer,
                      correctAnswer: b.correctAnswer,
                      isCorrect: b.isCorrect,
                      earnedPoints: b.earnedPoints,
                      points: b.points
                    })),
                    totalPoints: group.reduce((s, g) => s + (g.points || 1), 0),
                    earnedPoints: group.reduce((s, g) => s + (g.earnedPoints || 0), 0)
                  };
                }

                // 🟢 NORMAL
                return base;
              });

              return {
                instruction: instruction === '__NO_SECTION__' ? null : instruction,
                questions
              };
            })
          : null;

      return {
        student: r.studentId?.name || 'Unknown',
        studentEmail: r.studentId?.email || '',
        score: r.score,
        totalPoints: r.totalPoints,
        percentage: r.percentage,
        submittedAt: r.submittedAt,
        timeSpent: r.timeSpent,
        attemptNumber: r.attemptNumber,

        // 🔹 BACKWARD COMPATIBLE
        answers,

        // 🔴 NEW (section + cloze aware)
        sections
      };
    });

    cache.set(cacheKey, formatted, 180); // 3 min cache
    return res.json(formatted);

  } catch (error) {
    console.error("❌ getQuizResults error:", error);
    return res.status(500).json({
      message: 'Error fetching results',
      error: error.message
    });
  }
};



// --------------------------- 
// 10. Get Average Scores Per Subject (Optimized Aggregation)
// ---------------------------
const getAverageScoresPerSubject = async (req, res) => {
  try {
    console.log("🚀 [START] getAverageScoresPerSubject called");
    const schoolId = req.query.schoolId || req.user.school;
    const cacheKey = `radar:${schoolId}`;

    // 🎯 Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    if (!schoolId) {
      console.log("❌ No schoolId provided in request");
      return res.status(400).json({ message: 'School ID is required' });
    }

    const school = toObjectId(schoolId);

    if (req.user.school && req.user.school.toString() !== school.toString()) {
      console.log("🚫 Unauthorized school access attempt by user:", req.user.school);
      return res.status(403).json({ message: 'You do not have access to this school' });
    }

    const results = await executeWithTimeout(
      QuizResult.aggregate([
        { $match: { school } },
        { $lookup: { from: 'quizsessions', localField: 'quizId', foreignField: '_id', as: 'quiz' } },
        { $unwind: '$quiz' },
        { $match: { 'quiz.school': school } },
        {
          $addFields: {
            subjectNormalized: {
              $cond: [
                { 
                  $and: [
                    { $eq: [{ $type: '$quiz.subject' }, 'string'] },
                    { $eq: [{ $strLenCP: '$quiz.subject' }, 24] }
                  ]
                },
                { $toObjectId: '$quiz.subject' },
                '$quiz.subject'
              ]
            }
          }
        },
        {
          $group: {
            _id: '$subjectNormalized',
            avgScore: { $avg: '$percentage' },
            totalQuizzes: { $addToSet: '$quizId' },
            totalAttempts: { $sum: 1 }
          }
        },
        {
          $project: {
            avgScore: 1,
            totalAttempts: 1,
            totalQuizzes: { $size: '$totalQuizzes' }
          }
        },
        {
          $lookup: {
            from: 'subjects',
            let: { subjectKey: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $or: [
                      { $eq: ['$_id', '$$subjectKey'] },
                      { $eq: ['$name', '$$subjectKey'] }
                    ]
                  }
                }
              }
            ],
            as: 'subjectDetails'
          }
        },
        { $unwind: { path: '$subjectDetails', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            subject: { $ifNull: ['$subjectDetails.name', 'Unknown Subject'] },
            avgScore: { $round: ['$avgScore', 2] },
            totalQuizzes: 1,
            totalAttempts: 1,
            _id: 0
          }
        }
      ]).option({ maxTimeMS: 10000 })  // ⬅️ Updated here
    );

    cache.set(cacheKey, results, 300); // 5 min cache for radar data
    res.json(results);
  } catch (error) {
    console.error('❌ Error fetching radar chart data:', error);
    res.status(500).json({
      message: 'Error fetching radar chart data',
      error: error.message
    });
  }
};


// ---------------------------
// 11. Get Student Progress (Optimized)
// ---------------------------
const getStudentProgress = async (req, res) => {
  try {
    const { studentId } = req.params;
    const school = toObjectId(req.user.school);
    const cacheKey = CACHE_KEYS.STUDENT_PROGRESS(studentId);

    // 🎯 Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    if (!studentId || !mongoose.Types.ObjectId.isValid(studentId)) {
      return res.status(400).json({ message: 'Invalid student ID format' });
    }

    if (req.user.role === 'student' && req.user._id.toString() !== studentId) {
      return res.status(403).json({ message: 'You can only view your own progress' });
    }

    const results = await executeWithTimeout(
      QuizResult.find({ 
        studentId: toObjectId(studentId), 
        school 
      })
      .populate({
        path: 'quizId',
        select: 'title subject subjectName',
        populate: { path: 'subject', select: 'name shortName' }
      })
      .sort({ submittedAt: 1 })
      .lean()
      .maxTimeMS(8000)
    );

    const progress = results.map(r => {
      const quiz = r.quizId;
      return {
        date: r.submittedAt,
        score: r.score,
        totalPoints: r.totalPoints,
        percentage: r.percentage,
        quiz: quiz?.title || 'Unknown Quiz',
        subject: resolveSubjectName(quiz),
      };
    });

    cache.set(cacheKey, progress, 300); // 5 min cache
    res.json(progress);
  } catch (error) {
    console.error('❌ Error fetching student progress:', error);
    res.status(500).json({ message: 'Error fetching student progress', error: error.message });
  }
};

// ---------------------------
// 12. Update QuizSession - OPTIMIZED (SECTION-AWARE)
// ---------------------------
const updateQuiz = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { quizId } = req.params;

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Invalid quiz ID format' });
    }

    const {
      title,
      questions,
      sections,
      dueDate,
      timeLimit,
      startTime,
      shuffleQuestions,
      shuffleOptions
    } = req.body;

    const school = toObjectId(req.user.school);

    const quiz = await QuizSession.findOne({
      _id: toObjectId(quizId),
      school
    }).session(session);

    if (!quiz) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Quiz not found in your school' });
    }

    if (quiz.teacher.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ message: 'You can only update quizzes you created' });
    }

    // --------------------------------------------------
    // 🔒 Enforce ONE structure only
    // --------------------------------------------------
    if (questions?.length && sections?.length) {
      await session.abortTransaction();
      return res.status(400).json({
        message: "Quiz cannot contain both questions and sections"
      });
    }

    if (
      (questions && questions.length === 0) ||
      (sections && sections.length === 0)
    ) {
      await session.abortTransaction();
      return res.status(400).json({
        message: "Questions or sections cannot be empty"
      });
    }

    // --------------------------------------------------
    // 🧪 Validate FLAT QUESTIONS (CLOZE AWARE)
    // --------------------------------------------------
    if (Array.isArray(questions)) {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const type = (q.type || "").toLowerCase();

        if (!q.questionText || !q.type) {
          await session.abortTransaction();
          return res.status(400).json({
            message: `Question ${i + 1} is missing required fields (questionText or type)`
          });
        }

        // 🟢 NORMAL MCQ
        if (type === 'multiple-choice') {
          if (!Array.isArray(q.options) || q.correctAnswer === undefined) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Question ${i + 1}: Multiple-choice questions require options and correctAnswer`
            });
          }

          if (!q.options.includes(q.correctAnswer)) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Question ${i + 1}: correctAnswer must be one of the provided options`
            });
          }
        }

        // 🟣 CLOZE (MCQ WITH BLANKS)
        if (type === 'cloze') {
          if (!Array.isArray(q.blanks) || q.blanks.length === 0) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Question ${i + 1}: Cloze questions must contain blanks`
            });
          }

          for (let b = 0; b < q.blanks.length; b++) {
            const blank = q.blanks[b];

            if (
              !Array.isArray(blank.options) ||
              blank.correctAnswer === undefined
            ) {
              await session.abortTransaction();
              return res.status(400).json({
                message: `Question ${i + 1}, Blank ${b + 1}: options and correctAnswer are required`
              });
            }

            if (!blank.options.includes(blank.correctAnswer)) {
              await session.abortTransaction();
              return res.status(400).json({
                message: `Question ${i + 1}, Blank ${b + 1}: correctAnswer must be one of the options`
              });
            }
          }
        }

        // 🟢 TRUE / FALSE
        if (type === 'true-false' && typeof q.correctAnswer !== 'boolean') {
          await session.abortTransaction();
          return res.status(400).json({
            message: `Question ${i + 1}: True-false questions require a boolean correctAnswer`
          });
        }

        if (!q.points) q.points = 1;
      }
    }

    // --------------------------------------------------
    // 🧪 Validate SECTIONS (CLOZE AWARE)
    // --------------------------------------------------
    if (Array.isArray(sections)) {
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];

        if (!section.instruction || !section.instruction.trim()) {
          await session.abortTransaction();
          return res.status(400).json({
            message: `Section ${i + 1} must have an instruction`
          });
        }

        if (!Array.isArray(section.questions) || section.questions.length === 0) {
          await session.abortTransaction();
          return res.status(400).json({
            message: `Section ${i + 1} must contain at least one question`
          });
        }

        for (let j = 0; j < section.questions.length; j++) {
          const q = section.questions[j];
          const type = (q.type || "").toLowerCase();

          if (!q.questionText || !q.type) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Section ${i + 1}, Question ${j + 1} is missing required fields`
            });
          }

          // 🟣 CLOZE INSIDE SECTION
          if (type === 'cloze') {
            if (!Array.isArray(q.blanks) || q.blanks.length === 0) {
              await session.abortTransaction();
              return res.status(400).json({
                message: `Section ${i + 1}, Question ${j + 1}: Cloze must contain blanks`
              });
            }
          }
        }
      }
    }

    // --------------------------------------------------
    // ✅ APPLY UPDATES
    // --------------------------------------------------
    if (title !== undefined) quiz.title = title;
    if (dueDate !== undefined) quiz.dueDate = dueDate;
    if (timeLimit !== undefined) quiz.timeLimit = timeLimit;
    if (startTime !== undefined) quiz.startTime = startTime;
    if (shuffleQuestions !== undefined) quiz.shuffleQuestions = shuffleQuestions;
    if (shuffleOptions !== undefined) quiz.shuffleOptions = shuffleOptions;

    // 🔴 STRUCTURE SWITCH
    if (sections !== undefined) {
      quiz.sections = sections;
      quiz.questions = [];
    }

    if (questions !== undefined) {
      quiz.questions = questions;
      quiz.sections = [];
    }

    await quiz.save({ session });
    await session.commitTransaction();

    // 🎯 Cache invalidation
    processInBackground(() => {
      cache.del(CACHE_KEYS.QUIZ_SINGLE(quizId, 'teacher'));
      cache.del(CACHE_KEYS.QUIZ_SINGLE(quizId, 'student'));
      cache.del(CACHE_KEYS.QUIZ_CLASS(quiz.class.toString(), 'teacher', req.user._id));
      cache.delPattern(CACHE_KEYS.QUIZ_CLASS(quiz.class.toString(), 'student', ''));
    });

    res.json({
      message: 'Quiz updated successfully',
      quiz
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Quiz update failed:', error);
    res.status(500).json({
      message: 'Error updating quiz',
      error: error.message
    });
  } finally {
    session.endSession();
  }
};



// ---------------------------
// 13. Delete QuizSession - OPTIMIZED
// ---------------------------
const deleteQuiz = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { quizId } = req.params;
    const school = toObjectId(req.user.school);

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      await session.abortTransaction();
      return res.status(400).json({ message: 'Invalid quiz ID format' });
    }

    const quiz = await QuizSession.findOne({ 
      _id: toObjectId(quizId), 
      school 
    }).session(session);
    
    if (!quiz) {
      await session.abortTransaction();
      return res.status(404).json({ message: 'Quiz not found in your school' });
    }

    if (quiz.teacher.toString() !== req.user._id.toString()) {
      await session.abortTransaction();
      return res.status(403).json({ message: 'You can only delete quizzes you created' });
    }

    // 🎯 Parallel deletion operations
    await Promise.all([
      executeWithTimeout(
        QuizResult.deleteMany({ quizId: toObjectId(quizId) }).session(session)
      ),
      executeWithTimeout(
        QuizSession.deleteMany({ quizId: toObjectId(quizId) }).session(session)
      ),
      executeWithTimeout(
        QuizSession.findByIdAndDelete(toObjectId(quizId)).session(session)
      )
    ]);

    await session.commitTransaction();

    // 🎯 Comprehensive cache invalidation
    processInBackground(() => {
      cache.del(CACHE_KEYS.QUIZ_SINGLE(quizId, 'teacher'));
      cache.del(CACHE_KEYS.QUIZ_SINGLE(quizId, 'student'));
      cache.del(CACHE_KEYS.QUIZ_CLASS(quiz.class.toString(), 'teacher', req.user._id));
      cache.delPattern(CACHE_KEYS.QUIZ_CLASS(quiz.class.toString(), 'student', ''));
      cache.del(CACHE_KEYS.QUIZ_SCHOOL(school.toString()));
      cache.del(CACHE_KEYS.QUIZ_RESULTS(quizId));
    });

    res.json({ message: 'Quiz deleted successfully' });
  } catch (error) {
    await session.abortTransaction();
    console.error('Quiz deletion failed:', error);
    res.status(500).json({ message: 'Error deleting quiz', error: error.message });
  } finally {
    session.endSession();
  }
};

// --------------------------- 
// 14. Submit Quiz (NON-TRANSACTION VERSION, FIXED FOR AUTO-SUBMIT)
// ---------------------------
const submitQuiz = async (req, res) => {
  try {
    const { quizId } = req.params;
    const { answers = {}, startTime, timeSpent = 0, autoSubmit = false } = req.body;
    const school = toObjectId(req.user.school);
    const now = new Date();

    console.log("🚀 [submitQuiz] Incoming request", {
      quizId,
      autoSubmit,
      answersCount: Array.isArray(answers)
        ? answers.length
        : Object.keys(answers || {}).length,
    });

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    // --------------------------------------------------
    // 🔐 Resolve canonical Student ID (SOURCE OF TRUTH)
    // --------------------------------------------------
    const studentId = await resolveStudentId(req);

    // --------------------------------------------------
    // 🎯 Load quiz
    // --------------------------------------------------
    const quiz = await QuizSession.findById(quizId).lean().maxTimeMS(5000);
    if (!quiz) return res.status(404).json({ message: "Quiz not found" });

    // --------------------------------------------------
    // 🔍 CHECK IF RESULT ALREADY EXISTS
    // --------------------------------------------------
    const existingResult = await QuizResult.findOne({
      quizId,
      studentId,
      school,
    });

    if (existingResult && autoSubmit) {
      return res.status(200).json({
        message: "Quiz already submitted manually. Auto-submit skipped.",
        status: "already-submitted",
      });
    }

    if (existingResult && !autoSubmit) {
      return res.status(409).json({
        message: "You have already submitted this quiz.",
        status: "duplicate-submission",
        result: existingResult,
      });
    }

    // --------------------------------------------------
    // 🔥 FLATTEN QUESTIONS (sections OR flat)
    // --------------------------------------------------
    let allQuestions = [];

    if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
      quiz.sections.forEach(section => {
        section.questions.forEach(q => {
          allQuestions.push({
            ...q,
            __sectionInstruction: section.instruction || null,
          });
        });
      });
    } else {
      allQuestions = quiz.questions || [];
    }

    // --------------------------------------------------
    // 🔍 LOAD ACTIVE ATTEMPT
    // --------------------------------------------------
    let activeAttempt = await QuizAttempt.findOne({
      quizId,
      studentId,
      school,
      status: "in-progress",
    });

    if (!activeAttempt) {
      const timeLimitMinutes = quiz.timeLimit ?? 60;
      activeAttempt = await QuizAttempt.create({
        quizId,
        studentId,
        school,
        sessionId: new mongoose.Types.ObjectId().toString(),
        attemptNumber: 1,
        startTime: startTime ? new Date(startTime) : now,
        expiresAt: new Date(now.getTime() + timeLimitMinutes * 60 * 1000),
        answers: {},                 // 🔴 FIX: ensure answers map exists
      });
    }

    // --------------------------------------------------
    // 🔴 FIX: SYNC SUBMITTED ANSWERS INTO ATTEMPT
    // --------------------------------------------------
    if (answers && typeof answers === "object") {
      Object.entries(answers).forEach(([key, value]) => {
        activeAttempt.answers.set
          ? activeAttempt.answers.set(key, value)
          : (activeAttempt.answers[key] = value);
      });
    }

    // --------------------------------------------------
    // 🎯 PROCESS ANSWERS (SECTION-AWARE)
    // --------------------------------------------------
    let score = 0;
    let totalAutoGradedPoints = 0;
    let requiresManualReview = false;

    const results = [];

    for (const q of allQuestions) {
      const type = (q.type || "").toLowerCase();

      // ============================
      // 🟣 CLOZE (MCQ WITH BLANKS)
      // ============================
      if (type === "cloze" && Array.isArray(q.blanks)) {
        for (const blank of q.blanks) {
          const key = `${q._id}:${blank.blankNumber}`;

          const studentValue =
            activeAttempt.answers?.get?.(key) ??
            activeAttempt.answers?.[key] ??
            null;

          const isCorrect = studentValue === blank.correctAnswer;

          results.push({
            questionId: q._id,
            questionText: q.questionText,
            questionType: "multiple-choice",
            sectionInstruction: q.__sectionInstruction || null,
            selectedAnswer: studentValue,
            correctAnswer: blank.correctAnswer,
            explanation: q.explanation || null,
            isCorrect,
            points: q.points || 1,
            earnedPoints: isCorrect ? (q.points || 1) : 0,
            manualReviewRequired: false,
            timeSpent: 0,
          });

          totalAutoGradedPoints += q.points || 1;
          if (isCorrect) score += q.points || 1;
        }

        continue;
      }

      // ============================
      // 🟢 NORMAL QUESTIONS
      // ============================
      const studentAnswer =
        Array.isArray(answers)
          ? answers.find(a => a.questionId == q._id.toString())
          : null;

      const item = {
        questionId: q._id,
        questionText: q.questionText,
        questionType: q.type,
        sectionInstruction: q.__sectionInstruction || null,
        selectedAnswer: studentAnswer?.selectedAnswer ?? null,
        explanation: q.explanation ?? null,
        manualReviewRequired: false,
        isCorrect: null,
        correctAnswer: q.correctAnswer,
        points: q.points || 1,
        earnedPoints: 0,
        timeSpent: studentAnswer?.timeSpent || 0,
      };

      if (["essay", "short-answer"].includes(type)) {
        requiresManualReview = true;
        item.manualReviewRequired = true;
        results.push(item);
        continue;
      }

      totalAutoGradedPoints += item.points;

      if (item.selectedAnswer !== null) {
        const correct =
          type === "true-false"
            ? String(item.selectedAnswer).toLowerCase() ===
              String(q.correctAnswer).toLowerCase()
            : item.selectedAnswer === q.correctAnswer;

        item.isCorrect = correct;
        item.earnedPoints = correct ? item.points : 0;
        if (correct) score += item.points;
      } else {
        item.isCorrect = false;
      }

      results.push(item);
    }

    let percentage = null;
    if (!requiresManualReview && totalAutoGradedPoints > 0) {
      percentage = Number(((score / totalAutoGradedPoints) * 100).toFixed(2));
    }

    // --------------------------------------------------
    // 🔴 FIX: TOTAL POINTS MUST MATCH AUTO-GRADED TOTAL
    // --------------------------------------------------
    const totalPoints = totalAutoGradedPoints;

    // --------------------------------------------------
    // ✅ SAVE RESULT
    // --------------------------------------------------
    const quizResultDoc = await QuizResult.findOneAndUpdate(
      { school, quizId, studentId },
      {
        school,
        quizId,
        sessionId: activeAttempt.sessionId,
        studentId,
        answers: results,
        score: requiresManualReview ? null : score,
        totalPoints,
        percentage: requiresManualReview ? null : percentage,
        startTime: activeAttempt.startTime,
        submittedAt: now,
        timeSpent,
        attemptNumber: activeAttempt.attemptNumber,
        status: requiresManualReview ? "needs-review" : "submitted",
        autoGraded: !requiresManualReview,
        autoSubmit: !!autoSubmit,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    activeAttempt.status = "submitted";
    activeAttempt.completedAt = now;
    await activeAttempt.save();

    return res.json({
      message: autoSubmit
        ? "Quiz auto-submitted (time expired)"
        : "Quiz submitted",
      score: quizResultDoc.score,
      totalPoints: quizResultDoc.totalPoints,
      percentage: quizResultDoc.percentage,
      status: quizResultDoc.status,
      autoGraded: quizResultDoc.autoGraded,
      answers: results,
    });
  } catch (err) {
    console.error("❌ submitQuiz error:", err);
    return res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
};





// ---------------------------
// 15. Get Results for Student/Parent (Optimized)
// ---------------------------
const getResultsForStudent = async (req, res) => {
  try {
    const { studentId } = req.params;
    const { childId, quizId, subject } = req.query;
    const user = req.user;
    const cacheKey = `student:results:${studentId}:${childId}:${quizId}:${user.role}`;

    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    let results = [];
    let targetStudentIds = [];

    // ============================
    // 🎓 STUDENT FLOW
    // ============================
    if (user.role === "student") {
      const studentDoc = await executeWithTimeout(
        Student.findOne({ user: user._id, school: user.school })
          .populate("user", "name email")
          .populate("class", "name")
          .lean()
          .maxTimeMS(5000)
      );

      if (!studentDoc) {
        return res.status(404).json({ message: "Student record not found" });
      }

      targetStudentIds = [studentDoc._id];
      const validIds = [studentDoc._id, user._id];

      const filter = { studentId: { $in: validIds }, school: user.school };
      if (quizId) filter.quizId = quizId;

      results = await executeWithTimeout(
        QuizResult.find(filter)
          .populate({
            path: "quizId",
            select: "title subject subjectName totalPoints",
          })
          .sort({ submittedAt: -1 })
          .lean()
          .maxTimeMS(8000)
      );

      for (const r of results) {
        const info = await resolveStudentInfo(r.studentId, user.school);
        r.childName = info.name;
        r.className = info.className;

        const { classDisplayName } = resolveQuizClassNames({ name: info.className });
        r.classDisplayName = classDisplayName || info.className;

        r.answers = Array.isArray(r.answers) ? r.answers : [];

        // 🔴 GROUP BY SECTION
        const sectionsMap = {};
        r.answers.forEach(a => {
          if (a.sectionInstruction) {
            if (!sectionsMap[a.sectionInstruction]) {
              sectionsMap[a.sectionInstruction] = [];
            }
            sectionsMap[a.sectionInstruction].push(a);
          }
        });

        r.sections =
          Object.keys(sectionsMap).length > 0
            ? Object.entries(sectionsMap).map(([instruction, questions]) => ({
                instruction,
                questions,
              }))
            : null;

        // 🧠 FINAL STATUS (CLOZE SAFE)
        const pendingManual = r.answers.some(a => {
          const type = (a.questionType || "").toLowerCase();
          return (
            (type === "essay" || type === "short-answer") &&
            (a.earnedPoints === null || a.earnedPoints === undefined)
          );
        });

        r.status = pendingManual ? "needs-review" : "graded";
        r.autoGraded = !pendingManual;
      }
    }

    // ============================
    // 👨‍👩‍👧 PARENT FLOW
    // ============================
    else if (user.role === "parent") {
      const childFilter = {
        school: user.school,
        $or: [{ parent: user._id }, { parentIds: { $in: [user._id] } }],
      };

      if (childId) childFilter._id = childId;
      else if (studentId && studentId !== "undefined") childFilter._id = studentId;

      const children = await executeWithTimeout(
        Student.find(childFilter)
          .populate("user", "name email")
          .populate("class", "name")
          .lean()
          .maxTimeMS(5000)
      );

      if (!children.length) {
        return res.status(404).json({ message: "No linked children found" });
      }

      targetStudentIds = children.map(c => c._id);
      const allIds = children.flatMap(c => [c._id, c.user?._id].filter(Boolean));

      const query = { studentId: { $in: allIds }, school: user.school };
      if (quizId) query.quizId = quizId;

      results = await executeWithTimeout(
        QuizResult.find(query)
          .populate({
            path: "quizId",
            select: "title subject subjectName totalPoints",
          })
          .sort({ submittedAt: -1 })
          .lean()
          .maxTimeMS(8000)
      );

      for (const r of results) {
        const info = await resolveStudentInfo(r.studentId, user.school);
        r.childName = info.name;
        r.className = info.className;

        const { classDisplayName } = resolveQuizClassNames({ name: info.className });
        r.classDisplayName = classDisplayName || info.className;

        r.answers = Array.isArray(r.answers) ? r.answers : [];

        // 🔴 GROUP BY SECTION
        const sectionsMap = {};
        r.answers.forEach(a => {
          if (a.sectionInstruction) {
            if (!sectionsMap[a.sectionInstruction]) {
              sectionsMap[a.sectionInstruction] = [];
            }
            sectionsMap[a.sectionInstruction].push(a);
          }
        });

        r.sections =
          Object.keys(sectionsMap).length > 0
            ? Object.entries(sectionsMap).map(([instruction, questions]) => ({
                instruction,
                questions,
              }))
            : null;

        const pendingManual = r.answers.some(a => {
          const type = (a.questionType || "").toLowerCase();
          return (
            (type === "essay" || type === "short-answer") &&
            (a.earnedPoints === null || a.earnedPoints === undefined)
          );
        });

        r.status = pendingManual ? "needs-review" : "graded";
        r.autoGraded = !pendingManual;
      }
    } else {
      return res.status(403).json({
        message: "Access denied. Only students or parents allowed.",
      });
    }

    if (!results.length) {
      const emptyResponse = {
        success: true,
        message: "No quiz results found",
        data: [],
      };
      cache.set(cacheKey, emptyResponse, 60);
      return res.json(emptyResponse);
    }

    const response = {
      success: true,
      count: results.length,
      data: results,
    };

    cache.set(cacheKey, response, 180);
    return res.json(response);

  } catch (err) {
    console.error("❌ Error in getResultsForStudent:", err);
    res.status(500).json({
      message: "Error fetching results",
      error: err.message,
    });
  }
};



// ---------------------------
// 16. Get Quiz Result by ID (Final Persistent Version) - OPTIMIZED
// ---------------------------
const getQuizResultById = async (req, res) => {
  try {
    const { resultId } = req.params;
    const cacheKey = `quiz:result:${resultId}`;

    // 🎯 Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.status(200).json(cached);
    }

    if (!resultId || !mongoose.Types.ObjectId.isValid(resultId)) {
      return res.status(400).json({ message: "Invalid result ID" });
    }

    // --------------------------------------------------
    // 🎯 Fetch result and populate quiz + student
    // --------------------------------------------------
    const result = await executeWithTimeout(
      QuizResult.findById(resultId)
        .populate("quizId", "title")
        .populate("studentId", "name email")
        .lean({ virtuals: true })
        .maxTimeMS(5000)
    );

    if (!result) {
      return res.status(404).json({ message: "Result not found" });
    }

    // --------------------------------------------------
    // ✅ Normalize answers (safe defaults)
    // --------------------------------------------------
    result.answers = (result.answers || []).map(answer => ({
      ...answer,
      earnedPoints:
        typeof answer.earnedPoints === "number" ? answer.earnedPoints : null,
      feedback: typeof answer.feedback === "string" ? answer.feedback : "",
      manualReviewRequired:
        typeof answer.manualReviewRequired === "boolean"
          ? answer.manualReviewRequired
          : false,
      questionType: answer.questionType || "unknown",
      points: typeof answer.points === "number" ? answer.points : 0,
      isCorrect:
        typeof answer.isCorrect === "boolean" ? answer.isCorrect : null,
      sectionInstruction: answer.sectionInstruction || null
    }));

    // --------------------------------------------------
    // 🔴 GROUP BY SECTION + CLOZE
    // --------------------------------------------------
    const sectionsMap = {};

    result.answers.forEach(a => {
      const sectionKey = a.sectionInstruction || "__NO_SECTION__";
      if (!sectionsMap[sectionKey]) {
        sectionsMap[sectionKey] = [];
      }
      sectionsMap[sectionKey].push(a);
    });

    result.sections =
      Object.keys(sectionsMap).length > 0
        ? Object.entries(sectionsMap).map(([instruction, rawAnswers]) => {
            // group by questionId
            const grouped = {};
            rawAnswers.forEach(ans => {
              const key = ans.questionId?.toString();
              if (!grouped[key]) grouped[key] = [];
              grouped[key].push(ans);
            });

            const questions = Object.values(grouped).map(group => {
              const base = group[0];
              const type = (base.questionType || "").toLowerCase();

              // 🟣 CLOZE (multiple blanks)
              if (type === "multiple-choice" && group.length > 1) {
                return {
                  questionId: base.questionId,
                  questionText: base.questionText,
                  questionType: "cloze",
                  blanks: group.map(b => ({
                    selectedAnswer: b.selectedAnswer,
                    correctAnswer: b.correctAnswer,
                    isCorrect: b.isCorrect,
                    earnedPoints: b.earnedPoints,
                    points: b.points
                  })),
                  totalPoints: group.reduce(
                    (s, g) => s + (g.points || 1),
                    0
                  ),
                  earnedPoints: group.reduce(
                    (s, g) => s + (g.earnedPoints || 0),
                    0
                  )
                };
              }

              // 🟢 NORMAL QUESTION
              return base;
            });

            return {
              instruction:
                instruction === "__NO_SECTION__" ? null : instruction,
              questions
            };
          })
        : null;

    // --------------------------------------------------
    // ✅ Recalculate totals (cloze-safe)
    // --------------------------------------------------
    const totalEarned = result.answers.reduce(
      (sum, a) => sum + (a.earnedPoints || 0),
      0
    );

    const totalPoints =
      result.totalPoints && result.totalPoints > 0
        ? result.totalPoints
        : result.answers.reduce((sum, a) => sum + (a.points || 0), 0);

    result.score = totalEarned;
    result.totalPoints = totalPoints;
    result.percentage =
      totalPoints > 0
        ? Number(((totalEarned / totalPoints) * 100).toFixed(2))
        : 0;

    cache.set(cacheKey, result, 300); // 5 min cache
    return res.status(200).json(result);

  } catch (err) {
    console.error("❌ Error fetching result:", err);
    return res.status(500).json({
      message: "Error fetching result",
      error: err.message
    });
  }
};



// ---------------------------
// 16c. Get All Quiz Results for Teacher (Highly Optimized)
// ---------------------------
const getAllClassQuizResultsForTeacher = async (req, res) => { 
  try {
    const teacherUserId = req.user._id;
    const school = toObjectId(req.user.school);
    const cacheKey = CACHE_KEYS.CLASS_RESULTS_TEACHER(teacherUserId.toString());

    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const [teacherDoc, relatedClasses] = await Promise.all([
      executeWithTimeout(
        Teacher.findOne({ user: teacherUserId, school })
          .lean()
          .maxTimeMS(5000)
      ),
      executeWithTimeout(
        Class.find({
          school,
          $or: [{ teachers: teacherUserId }, { classTeacher: teacherUserId }],
        }).select("_id name").lean().maxTimeMS(5000)
      )
    ]);

    if (!teacherDoc) {
      return res.status(404).json({ message: "Teacher record not found" });
    }

    const classIds = new Set();
    if (teacherDoc.assignedClass) classIds.add(teacherDoc.assignedClass.toString());
    if (Array.isArray(teacherDoc.assignedClasses)) {
      teacherDoc.assignedClasses.forEach(id => classIds.add(id.toString()));
    }
    relatedClasses.forEach(c => classIds.add(c._id.toString()));

    if (classIds.size === 0) {
      const emptyResponse = { success: true, results: [] };
      cache.set(cacheKey, emptyResponse, 60);
      return res.json(emptyResponse);
    }

    const classIdsArray = Array.from(classIds);

    const quizzes = await executeWithTimeout(
      QuizSession.find({
        class: { $in: classIdsArray },
        school,
        teacher: teacherUserId,
      })
        .select("_id class title subject subjectName totalPoints")
        .populate({ path: "subject", select: "name shortName" })
        .lean()
        .maxTimeMS(8000)
    );

    if (!quizzes.length) {
      const emptyResponse = { success: true, results: [] };
      cache.set(cacheKey, emptyResponse, 60);
      return res.json(emptyResponse);
    }

    const quizIds = quizzes.map(q => q._id.toString());

    const [results, teacherClasses] = await Promise.all([
      executeWithTimeout(
        QuizResult.find({
          quizId: { $in: quizIds },
          school,
        })
          .populate({
            path: "quizId",
            select: "title subject subjectName class totalPoints",
            populate: { path: "subject", select: "name shortName" },
          })
          .sort({ submittedAt: -1 })
          .lean()
          .maxTimeMS(10000)
      ),
      executeWithTimeout(
        Class.find({ _id: { $in: classIdsArray } })
          .select("name _id")
          .lean()
          .maxTimeMS(5000)
      )
    ]);

    if (!results.length) {
      const emptyResponse = { success: true, results: [] };
      cache.set(cacheKey, emptyResponse, 60);
      return res.json(emptyResponse);
    }

    const studentInfos = await Promise.all(
      results.map(r => resolveStudentInfo(r.studentId, school))
    );

    const studentInfoMap = new Map();
    results.forEach((r, i) => {
      studentInfoMap.set(r.studentId.toString(), studentInfos[i]);
    });

    const groupedByClass = {};

    for (const result of results) {
      const quiz = result.quizId;
      if (!quiz || !quiz.class) continue;

      const classId = quiz.class.toString();
      const quizIdStr = quiz._id.toString();

      if (!groupedByClass[classId]) {
        const classDoc = teacherClasses.find(c => c._id.toString() === classId);
        const { className, classDisplayName } = resolveQuizClassNames(classDoc);

        groupedByClass[classId] = {
          classId,
          className,
          classDisplayName,
          quizzes: {},
        };
      }

      if (!groupedByClass[classId].quizzes[quizIdStr]) {
        groupedByClass[classId].quizzes[quizIdStr] = {
          quiz: {
            _id: quiz._id,
            title: quiz.title || "Untitled Quiz",
            subject: resolveSubjectName(quiz),
            totalPoints: quiz.totalPoints || 0,
          },
          results: [],
        };
      }

      const studentInfo = studentInfoMap.get(result.studentId.toString());
      const answers = Array.isArray(result.answers) ? result.answers : [];

      // --------------------------------------------------
      // 🔴 SECTION + CLOZE GROUPING
      // --------------------------------------------------
      const sectionsMap = {};
      answers.forEach(a => {
        const key = a.sectionInstruction || "__NO_SECTION__";
        if (!sectionsMap[key]) sectionsMap[key] = [];
        sectionsMap[key].push(a);
      });

      const sections =
        Object.keys(sectionsMap).length > 0
          ? Object.entries(sectionsMap).map(([instruction, rawAnswers]) => {
              const grouped = {};
              rawAnswers.forEach(ans => {
                const qKey = ans.questionId?.toString();
                if (!grouped[qKey]) grouped[qKey] = [];
                grouped[qKey].push(ans);
              });

              const questions = Object.values(grouped).map(group => {
                const base = group[0];
                const type = (base.questionType || "").toLowerCase();

                // 🟣 CLOZE
                if (type === "multiple-choice" && group.length > 1) {
                  return {
                    questionId: base.questionId,
                    questionText: base.questionText,
                    questionType: "cloze",
                    blanks: group.map(b => ({
                      selectedAnswer: b.selectedAnswer,
                      correctAnswer: b.correctAnswer,
                      isCorrect: b.isCorrect,
                      earnedPoints: b.earnedPoints,
                      points: b.points
                    })),
                    totalPoints: group.reduce((s, g) => s + (g.points || 1), 0),
                    earnedPoints: group.reduce((s, g) => s + (g.earnedPoints || 0), 0)
                  };
                }

                return base;
              });

              return {
                instruction: instruction === "__NO_SECTION__" ? null : instruction,
                questions
              };
            })
          : null;

      groupedByClass[classId].quizzes[quizIdStr].results.push({
        _id: result._id,
        student: {
          _id: studentInfo.id,
          name: studentInfo.name,
          email: studentInfo.email,
          className: studentInfo.className,
        },
        score: result.score,
        totalPoints: result.totalPoints,
        percentage: result.percentage,
        timeSpent: result.timeSpent || 0,
        completedAt: result.submittedAt || result.completedAt,

        // 🔹 BACKWARD COMPATIBLE
        answers,

        // 🔴 SECTION + CLOZE AWARE
        sections,
      });
    }

    const response = {
      success: true,
      results: Object.values(groupedByClass).map(cls => ({
        classId: cls.classId,
        className: cls.className,
        classDisplayName: cls.classDisplayName,
        quizzes: Object.values(cls.quizzes),
      }))
    };

    cache.set(cacheKey, response, 300);
    return res.json(response);

  } catch (error) {
    console.error("❌ Error fetching class quiz results for teacher:", error);
    res.status(500).json({
      message: "Error fetching quiz results",
      error: error.message,
    });
  }
};



// ---------------------------
// 17. Check if student has completed a quiz (Hybrid ID Safe Version) - OPTIMIZED
// ---------------------------
const checkQuizCompletion = async (req, res) => {
  try {
    const { quizId } = req.params;
    const userId = req.user._id;
    const school = toObjectId(req.user.school);
    const cacheKey = `quiz:completion:${quizId}:${userId}`;

    // 🎯 Check cache
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return res.json(cached);
    }

    // Validate quiz ID
    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    // Try to locate the corresponding Student record (linked to this user)
    const studentDoc = await executeWithTimeout(
      Student.findOne({ user: userId, school }).lean().maxTimeMS(5000)
    );

    // Build a list of possible student identifiers to match
    const idsToCheck = [toObjectId(userId)];
    if (studentDoc?._id) idsToCheck.push(toObjectId(studentDoc._id));

    // Check for a matching quiz result under either ID
    const result = await executeWithTimeout(
      QuizResult.findOne({
        quizId: toObjectId(quizId),
        studentId: { $in: idsToCheck },
        school,
      }).maxTimeMS(5000)
    );

    const response = { completed: !!result };
    cache.set(cacheKey, response, 180); // 3 min cache
    res.json(response);
  } catch (error) {
    console.error("❌ Error checking quiz completion:", error);
    res.status(500).json({
      message: "Error checking quiz completion",
      error: error.message,
    });
  }
};

// ---------------------------
// 18. Check if student has an in-progress quiz attempt (Hybrid ID Safe Version) - OPTIMIZED
// ---------------------------
const checkQuizInProgress = async (req, res) => {
  try {
    const { quizId } = req.params;
    const school = toObjectId(req.user.school);

    // Validate quiz ID
    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    // 🔐 Resolve canonical Student ID (SOURCE OF TRUTH)
    const studentId = await resolveStudentId(req);

    // 🔍 ALWAYS query database (NO CACHE)
    const activeAttempt = await executeWithTimeout(
      QuizAttempt.findOne({
        quizId: toObjectId(quizId),
        studentId,            // ✅ Student._id ONLY
        school,
        status: "in-progress",
        expiresAt: { $gt: new Date() },
      })
        .lean()
        .maxTimeMS(5000)
    );

    return res.json({
      inProgress: !!activeAttempt,
    });

  } catch (error) {
    console.error("❌ Error checking quiz progress:", error);
    return res.status(500).json({
      message: "Error checking quiz progress",
      error: error.message,
    });
  }
};



// ---------------------------
// 19. Start a new quiz attempt (Strict due date + completion lock) - FIXED
// ---------------------------



const startQuizAttempt = async (req, res) => {
  let session = null;

  try {
    const { quizId } = req.params;
    const userId = req.user._id;
    const school = toObjectId(req.user.school);
    const now = new Date();
    const startTime = now;

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    console.log(`🚀 [START ATTEMPT] User ${userId} starting quiz ${quizId}`);

    // --------------------------------------------------
    // 🎯 Parallel validation checks (NO SESSION YET)
    // --------------------------------------------------
    const [quiz, userRecord] = await Promise.all([
      QuizSession.findOne({
        _id: toObjectId(quizId),
        school,
        isPublished: true,
      }).maxTimeMS(5000),

      User.findOne({ _id: userId, school }).lean().maxTimeMS(5000),
    ]);

    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found or not published" });
    }

    // --------------------------------------------------
    // 🔐 Resolve canonical Student ID (SOURCE OF TRUTH)
    // --------------------------------------------------
    const studentId = await resolveStudentId(req);

    // --------------------------------------------------
    // ⏰ Time validation
    // --------------------------------------------------
    const quizStart = quiz.startTime ? new Date(quiz.startTime) : null;
    const quizDue = quiz.dueDate ? new Date(quiz.dueDate) : null;

    if (quizStart && now < quizStart) {
      return res.status(403).json({ message: "Quiz is not available yet" });
    }

    if (quizDue && now > quizDue) {
      return res.status(403).json({ message: "Quiz has expired" });
    }

    // --------------------------------------------------
    // 🎓 Enrollment check
    // --------------------------------------------------
    if (
      userRecord?.class &&
      quiz.class &&
      userRecord.class.toString() !== quiz.class.toString()
    ) {
      return res
        .status(403)
        .json({ message: "You are not enrolled in this class" });
    }

    // --------------------------------------------------
    // 🔍 Check existing result & active attempt (NO SESSION)
    // --------------------------------------------------
    const [existingResult, activeAttempt, attemptCount] = await Promise.all([
      QuizResult.findOne({
        quizId: toObjectId(quizId),
        studentId,
        school,
      }).maxTimeMS(5000),

      QuizAttempt.findOne({
        quizId: toObjectId(quizId),
        studentId,
        school,
        status: "in-progress",
        expiresAt: { $gt: now },
      }).maxTimeMS(5000),

      QuizResult.countDocuments({
        quizId: toObjectId(quizId),
        studentId,
      }).maxTimeMS(5000),
    ]);

    // --------------------------------------------------
    // 🔒 Already completed
    // --------------------------------------------------
    if (existingResult) {
      return res.status(409).json({
        message: "You have already completed this quiz and cannot retake it.",
        alreadyCompleted: true,
      });
    }

    // --------------------------------------------------
    // 🔄 Resume existing attempt (FAST PATH)
    // --------------------------------------------------
    if (activeAttempt) {
      console.log(`🔄 Resuming existing attempt for student ${studentId}`);
      return res.json({
        sessionId: activeAttempt.sessionId,
        timeRemaining: Math.floor(
          (new Date(activeAttempt.expiresAt) - now) / 1000
        ),
        startTime: activeAttempt.startTime,
        resumed: true,
      });
    }

    // --------------------------------------------------
    // 🚫 Max attempts check
    // --------------------------------------------------
    const attemptNumber = attemptCount + 1;
    if (quiz.maxAttempts && attemptNumber > quiz.maxAttempts) {
      return res
        .status(400)
        .json({ message: "Maximum number of attempts exceeded" });
    }

    // --------------------------------------------------
    // 🆕 Create new attempt WITH TRANSACTION
    // --------------------------------------------------
    session = await mongoose.startSession();
    session.startTransaction();

    const timeLimitMinutes = quiz.timeLimit ?? 60;
    const timeLimitSeconds = timeLimitMinutes * 60;
    const expiresAt = new Date(now.getTime() + timeLimitSeconds * 1000);
    const sessionId = new mongoose.Types.ObjectId().toString();

    await QuizAttempt.create(
      [
        {
          quizId: toObjectId(quizId),
          studentId, // ✅ ALWAYS Student._id
          school,
          sessionId,
          attemptNumber,
          startTime,
          expiresAt,
          status: "in-progress",
          lastActivity: now,
        },
      ],
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    console.log(
      `✅ New attempt created for student ${studentId}, session: ${sessionId}`
    );

    return res.json({
      sessionId,
      timeRemaining: timeLimitSeconds,
      startTime: startTime.toISOString(),
      resumed: false,
    });

  } catch (error) {
    // --------------------------------------------------
    // 🔁 CRITICAL FIX: DUPLICATE ACTIVE ATTEMPT → RESUME
    // --------------------------------------------------
    if (error?.code === 11000) {
      console.warn(
        `⚠️ Duplicate active attempt detected — resuming for student ${studentId}`
      );

      const existingAttempt = await QuizAttempt.findOne({
        quizId: toObjectId(quizId),
        studentId,
        school,
        status: "in-progress",
        expiresAt: { $gt: new Date() },
      });

      if (existingAttempt) {
        return res.json({
          sessionId: existingAttempt.sessionId,
          timeRemaining: Math.floor(
            (new Date(existingAttempt.expiresAt) - new Date()) / 1000
          ),
          startTime: existingAttempt.startTime,
          resumed: true,
        });
      }
    }

    // --------------------------------------------------
    // 🧹 Safe session cleanup
    // --------------------------------------------------
    if (session && session.inTransaction()) {
      try {
        await session.abortTransaction();
        session.endSession();
      } catch (sessionError) {
        console.error("Session cleanup error:", sessionError);
      }
    }

    console.error("❌ Error starting quiz attempt:", error);

    return res.status(500).json({
      message: "Error starting quiz attempt",
      error: error.message,
    });
  }
};






// ---------------------------
// 20. Resume quiz attempt - OPTIMIZED
// ---------------------------
const resumeQuizAttempt = async (req, res) => {
  try {
    const { quizId } = req.params;
    const school = toObjectId(req.user.school);

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    // 🔐 Resolve canonical student ID
    const studentId = await resolveStudentId(req);

    const cacheKey = `quiz:resume:${quizId}:${studentId}`;

    // 🎯 Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const activeAttempt = await executeWithTimeout(
      QuizAttempt.findOne({
        quizId: toObjectId(quizId),
        studentId, // ✅ Student._id
        school,
        status: "in-progress",
        expiresAt: { $gt: new Date() },
      }).maxTimeMS(5000)
    );

    if (!activeAttempt) {
      return res.status(404).json({ message: "No active quiz attempt found" });
    }

    // Update last activity
    activeAttempt.lastActivity = new Date();
    await activeAttempt.save();

    const quiz = await executeWithTimeout(
      QuizSession.findById(quizId).maxTimeMS(5000)
    );

    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found" });
    }

    // ⏱ Calculate time remaining (seconds)
    const timeRemaining = Math.floor(
      (new Date(activeAttempt.expiresAt) - new Date()) / 1000
    );

    // --------------------------------------------------
    // 🔴 FIX: CONVERT MAP → PLAIN OBJECT (CLOZE SAFE)
    // --------------------------------------------------
    const answersObject =
      activeAttempt.answers instanceof Map
        ? Object.fromEntries(activeAttempt.answers.entries())
        : activeAttempt.answers || {};

    const response = {
      sessionId: activeAttempt.sessionId,
      timeRemaining,
      startTime: activeAttempt.startTime,
      answers: answersObject,
    };

    cache.set(cacheKey, response, 30); // 30s cache
    return res.json(response);
  } catch (error) {
    console.error("Error resuming quiz attempt:", error);
    return res.status(500).json({
      message: "Error resuming quiz attempt",
      error: error.message,
    });
  }
};




// ---------------------------
// 21. Save quiz progress - OPTIMIZED
// ---------------------------
const saveQuizProgress = async (req, res) => {
  try {
    const { quizId } = req.params;
    const { answers } = req.body;
    const school = toObjectId(req.user.school);

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    // 🔐 Resolve canonical student ID
    const studentId = await resolveStudentId(req);

    const activeAttempt = await executeWithTimeout(
      QuizAttempt.findOne({
        quizId: toObjectId(quizId),
        studentId, // ✅ Student._id
        school,
        status: "in-progress",
        expiresAt: { $gt: new Date() },
      }).maxTimeMS(5000)
    );

    if (!activeAttempt) {
      return res.status(404).json({ message: "No active quiz attempt found" });
    }

    // --------------------------------------------------
    // 🔴 FIX: MERGE ANSWERS SAFELY (DO NOT OVERWRITE MAP)
    // --------------------------------------------------
    if (answers && typeof answers === "object") {
      Object.entries(answers).forEach(([key, value]) => {
        if (activeAttempt.answers?.set) {
          activeAttempt.answers.set(key, value);
        } else {
          activeAttempt.answers[key] = value;
        }
      });
    }

    activeAttempt.lastActivity = new Date();
    await activeAttempt.save();

    // 🎯 Invalidate resume cache (use Student._id)
    cache.del(`quiz:resume:${quizId}:${studentId}`);

    return res.json({ message: "Progress saved successfully" });
  } catch (error) {
    console.error("Error saving quiz progress:", error);
    return res.status(500).json({
      message: "Error saving quiz progress",
      error: error.message,
    });
  }
};



// ---------------------------
// PUT /api/quizzes/results/:resultId/grade-question
// ---------------------------
const gradeQuestion = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { resultId } = req.params;
    const { questionId, earnedPoints, feedback } = req.body;

    if (!mongoose.Types.ObjectId.isValid(resultId)) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid result ID" });
    }

    if (!questionId) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Question ID is required" });
    }

    const numericPoints = Number(earnedPoints);
    if (isNaN(numericPoints) || numericPoints < 0) {
      await session.abortTransaction();
      return res
        .status(400)
        .json({ message: "earnedPoints must be a valid non-negative number" });
    }

    const quizResult = await QuizResult.findById(resultId)
      .populate({
        path: "studentId",
        populate: { path: "class user", select: "name email class" }
      })
      .populate({ path: "quizId", select: "title subjectName teacher" })
      .session(session);

    if (!quizResult) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Result not found" });
    }

    // --------------------------------------------------
    // 🔍 Find answer entry
    // --------------------------------------------------
    const question =
      quizResult.answers.id(questionId) ||
      quizResult.answers.find(q => String(q.questionId) === String(questionId));

    if (!question) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Question not found" });
    }

    const qType = (question.questionType || "").toLowerCase();

    // --------------------------------------------------
    // 🛑 BLOCK CLOZE MANUAL GRADING
    // --------------------------------------------------
    if (qType === "cloze" || qType === "multiple-choice") {
      await session.abortTransaction();
      return res.status(400).json({
        message:
          "Cloze and multiple-choice questions are auto-graded and cannot be manually graded.",
      });
    }

    // --------------------------------------------------
    // 🧮 POINT VALIDATION
    // --------------------------------------------------
    const maxPoints =
      qType === "essay" || qType === "short-answer" ? 5 : 1;

    if (numericPoints > maxPoints) {
      await session.abortTransaction();
      return res.status(400).json({
        message: `For ${qType} questions, earned points must be between 0 and ${maxPoints}.`,
      });
    }

    // --------------------------------------------------
    // ✅ APPLY GRADE
    // --------------------------------------------------
    question.points = maxPoints;
    question.earnedPoints = numericPoints;
    question.feedback = typeof feedback === "string" ? feedback.trim() : "";
    question.manualReviewRequired = false;
    question.isCorrect =
      numericPoints === maxPoints ? true : numericPoints === 0 ? false : null;

    question.markModified("earnedPoints");
    question.markModified("feedback");
    question.markModified("manualReviewRequired");
    question.markModified("isCorrect");
    question.markModified("points");

    // --------------------------------------------------
    // 🔢 RECALCULATE TOTALS (CLOZE-SAFE)
    // --------------------------------------------------
    const totalEarned = quizResult.answers.reduce(
      (sum, q) =>
        sum + (typeof q.earnedPoints === "number" ? q.earnedPoints : 0),
      0
    );

    const totalPossible = quizResult.answers.reduce(
      (sum, q) => sum + (typeof q.points === "number" ? q.points : 0),
      0
    );

    quizResult.score = totalEarned;
    quizResult.totalPoints = totalPossible;
    quizResult.percentage =
      totalPossible > 0
        ? Number(((totalEarned / totalPossible) * 100).toFixed(2))
        : 0;

    quizResult.status = "graded";
    quizResult.autoGraded = false;

    await quizResult.save({ session, validateBeforeSave: true });
    await session.commitTransaction();

    // --------------------------------------------------
    // 🧹 CACHE INVALIDATION
    // --------------------------------------------------
    processInBackground(() => {
      cache.del(`quiz:result:${resultId}`);
      cache.del(CACHE_KEYS.QUIZ_RESULTS(quizResult.quizId.toString()));
      cache.del(CACHE_KEYS.STUDENT_PROGRESS(quizResult.studentId._id.toString()));
      cache.del(
        CACHE_KEYS.CLASS_RESULTS_TEACHER(
          quizResult.quizId.teacher?.toString()
        )
      );
    });

    return res.json({
      success: true,
      message: "Question graded successfully",
      updated: {
        questionId: question._id || questionId,
        earnedPoints: question.earnedPoints,
        feedback: question.feedback,
        score: quizResult.score,
        totalPoints: quizResult.totalPoints,
        percentage: quizResult.percentage,
        status: quizResult.status,
      },
    });

  } catch (err) {
    await session.abortTransaction();
    console.error("❌ Grade save failed:", err);
    return res.status(500).json({
      message: "Failed to save grade",
      error: err.message,
    });
  } finally {
    session.endSession();
  }
};




// 🎯 ADD autoSubmitQuiz TO YOUR EXPORTS AT THE BOTTOM OF THE FILE
module.exports = {
  createQuiz,
  publishQuiz,
  getQuiz,
  getQuizzesForClass,
  getQuizzesForSchool,
  getProtectedQuiz,
  validateQuizSession,
  getQuizResults,
  getAverageScoresPerSubject,
  getStudentProgress,
  updateQuiz,
  deleteQuiz,
  submitQuiz,
  getResultsForStudent,
  getQuizResultById,
  getAllClassQuizResultsForTeacher,
  checkQuizCompletion,
  checkQuizInProgress,
  startQuizAttempt,
  resumeQuizAttempt,
  saveQuizProgress,
  gradeQuestion,

};