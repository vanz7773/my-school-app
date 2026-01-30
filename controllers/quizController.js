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

const resolveSectionType = (section) => {
  if (!section) {
    console.error("❌ Section is null or undefined");
    return "unknown";
  }

  // 🟣 Check for cloze section
  if (
    typeof section.passage === "string" &&
    section.passage.trim().length > 0 &&
    Array.isArray(section.items)
  ) {
    // Even if items array is empty, it's still a cloze section structure
    return "cloze";
  }

  // 🟢 Check for standard section
  if (Array.isArray(section.questions)) {
    // Even if questions array is empty, it's still a standard section structure
    return "standard";
  }

  console.warn("⚠️ Unknown section structure, defaulting to standard", {
    hasPassage: typeof section.passage,
    hasItems: Array.isArray(section.items),
    hasQuestions: Array.isArray(section.questions),
    sectionKeys: Object.keys(section)
  });
  
  return "unknown";
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
    // 🔑 SECTION TYPE RESOLVER (SINGLE SOURCE OF TRUTH)
    // --------------------------------------------------
    const resolveSectionType = (section) => {
      if (
        typeof section.passage === "string" &&
        section.passage.trim().length &&
        Array.isArray(section.items)
      ) {
        return "cloze";
      }

      if (Array.isArray(section.questions)) {
        return "standard";
      }

      throw new Error(
        "Section must contain either { questions[] } or { passage + items[] }"
      );
    };

    // --------------------------------------------------
    // 🧪 VALIDATE STANDARD SECTION
    // --------------------------------------------------
    const validateStandardSection = (section, label) => {
      if (!section.instruction || !section.instruction.trim()) {
        throw new Error(`${label} must have an instruction`);
      }

      if (!Array.isArray(section.questions) || section.questions.length === 0) {
        throw new Error(`${label} must contain questions`);
      }

      section.questions.forEach((q, idx) => {
        if (!q.questionText || !q.questionText.trim()) {
          throw new Error(`${label}, Question ${idx + 1} missing questionText`);
        }

        if (!q.points) q.points = 1;
      });
    };

    // --------------------------------------------------
    // 🧪 VALIDATE CLOZE SECTION
    // --------------------------------------------------
    const validateClozeSection = (section, label) => {
      if (!section.instruction || !section.instruction.trim()) {
        throw new Error(`${label} must have an instruction`);
      }

      if (!section.passage || !section.passage.trim()) {
        throw new Error(`${label} must have a passage`);
      }

      if (!Array.isArray(section.items) || section.items.length === 0) {
        throw new Error(`${label} must contain cloze items`);
      }

      const seenNumbers = new Set();

      section.items.forEach((item, idx) => {
        if (typeof item.number !== "number") {
          throw new Error(`${label}, Item ${idx + 1} missing number`);
        }

        if (seenNumbers.has(item.number)) {
          throw new Error(`${label} has duplicate item number ${item.number}`);
        }
        seenNumbers.add(item.number);

        if (!Array.isArray(item.options) || item.options.length < 2) {
          throw new Error(
            `${label}, Item ${item.number} must have at least 2 options`
          );
        }

        if (!item.options.includes(item.correctAnswer)) {
          throw new Error(
            `${label}, Item ${item.number} correctAnswer must be in options`
          );
        }

        if (!item.points) item.points = 1;
      });
    };

    // --------------------------------------------------
    // 🧪 Validate FLAT QUESTIONS (LEGACY / NON-SECTION QUIZ)
    // --------------------------------------------------
    if (questions?.length) {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];

        if (!q.questionText || !q.questionText.trim()) {
          throw new Error(`Question ${i + 1} missing questionText`);
        }

        if (!q.points) q.points = 1;
      }
    }

    // --------------------------------------------------
    // 🧪 Validate SECTIONS (STANDARD + CLOZE)
    // --------------------------------------------------
    if (sections?.length) {
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        const label = `Section ${i + 1}`;

        const sectionType = resolveSectionType(section);

        if (sectionType === "standard") {
          validateStandardSection(section, label);
        }

        if (sectionType === "cloze") {
          validateClozeSection(section, label);
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
// 2. Publish/Unpublish QuizSession (WITH DEBUG LOGS)
// ---------------------------
const publishQuiz = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { quizId } = req.params;
    const { publish } = req.body;
    const school = toObjectId(req.user.school);

    console.log("🚀 [PUBLISH QUIZ] Request received", {
      quizId,
      publish,
      user: req.user._id.toString(),
      school: school?.toString(),
    });

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      console.warn("❌ Invalid quiz ID format:", quizId);
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    const quiz = await QuizSession.findOne({
      _id: toObjectId(quizId),
      school,
    }).session(session);

    if (!quiz) {
      console.warn("❌ Quiz not found:", quizId);
      await session.abortTransaction();
      return res.status(404).json({ message: "Quiz not found in your school" });
    }

    console.log("✅ Quiz loaded", {
      title: quiz.title,
      isPublished: quiz.isPublished,
      sectionsCount: quiz.sections?.length || 0,
      questionsCount: quiz.questions?.length || 0,
    });

    if (quiz.teacher.toString() !== req.user._id.toString()) {
      console.warn("🚫 Unauthorized publish attempt", {
        quizTeacher: quiz.teacher.toString(),
        requester: req.user._id.toString(),
      });
      await session.abortTransaction();
      return res
        .status(403)
        .json({ message: "You can only publish quizzes you created" });
    }

    const resolveSectionType = (section) => {
      if (
        typeof section.passage === "string" &&
        section.passage.trim().length &&
        Array.isArray(section.items)
      ) {
        return "cloze";
      }

      if (Array.isArray(section.questions)) {
        return "standard";
      }

      throw new Error("Invalid section structure");
    };

    // --------------------------------------------------
    // 🔴 FINAL VALIDATION BEFORE PUBLISH
    // --------------------------------------------------
    if (publish) {
      let hasAutoGradable = false;

      if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
        console.log("📦 Sectioned quiz detected");

        for (let i = 0; i < quiz.sections.length; i++) {
          const section = quiz.sections[i];

          // 🔍 ADD THIS LOG (RAW SECTION STATE)
          console.log("🧩 Raw section keys", {
            sectionIndex: i + 1,
            hasPassage: !!section.passage,
            passageLength: section.passage?.length,
            hasItems: Array.isArray(section.items),
            itemsLength: section.items?.length,
            hasQuestions: Array.isArray(section.questions),
            questionsLength: section.questions?.length,
          });

          const sectionType = resolveSectionType(section);

          console.log(`➡️ Validating Section ${i + 1}`, {
            sectionType,
            instruction: section.instruction,
          });

          // 🟢 STANDARD SECTION
          if (sectionType === "standard") {
            console.log(
              `🟢 Section ${i + 1} STANDARD questions count:`,
              section.questions?.length
            );

            if (
              !Array.isArray(section.questions) ||
              section.questions.length === 0
            ) {
              console.error(`❌ Section ${i + 1} has no questions`);
              await session.abortTransaction();
              return res.status(400).json({
                message: `Section ${i + 1} has no questions`,
              });
            }

            hasAutoGradable = true;
          }

          // 🟣 CLOZE SECTION
          if (sectionType === "cloze") {
            console.log(
              `🟣 Section ${i + 1} CLOZE items count:`,
              section.items?.length
            );

            if (!Array.isArray(section.items) || section.items.length === 0) {
              console.error(`❌ Cloze section ${i + 1} has no items`);
              await session.abortTransaction();
              return res.status(400).json({
                message: `Cloze section ${i + 1} has no items`,
              });
            }

            for (let idx = 0; idx < section.items.length; idx++) {
              const item = section.items[idx];

              console.log(`   🔍 Cloze item check`, {
                section: i + 1,
                index: idx,
                number: item.number,
                options: item.options,
                correctAnswer: item.correctAnswer,
              });

              if (
                !Array.isArray(item.options) ||
                item.options.length < 2 ||
                !item.options.includes(item.correctAnswer)
              ) {
                console.error(`❌ Invalid cloze item detected`, {
                  section: i + 1,
                  itemNumber: item.number,
                  options: item.options,
                  correctAnswer: item.correctAnswer,
                });

                await session.abortTransaction();
                return res.status(400).json({
                  message: `Cloze section ${i + 1}, item ${item.number} has invalid options or correctAnswer`,
                });
              }
            }

            hasAutoGradable = true;
          }
        }
      } else {
        console.log("📄 Flat (legacy) quiz detected");

        const flatQuestions = quiz.questions || [];
        console.log("🧮 Flat questions count:", flatQuestions.length);

        if (!flatQuestions.length) {
          await session.abortTransaction();
          return res.status(400).json({
            message: "Quiz has no questions and cannot be published",
          });
        }

        hasAutoGradable = true;
      }

      if (!hasAutoGradable) {
        console.warn("🚫 No auto-gradable content found");
        await session.abortTransaction();
        return res.status(400).json({
          message:
            "Quiz cannot be published because it contains no auto-gradable questions",
        });
      }

      quiz.publishedAt = new Date();
      console.log("🟢 Quiz marked for publishing");
    } else {
      quiz.publishedAt = null;
      console.log("🟡 Quiz marked for unpublishing");
    }

    quiz.isPublished = publish;
    await quiz.save({ session });

    console.log("💾 Quiz saved, committing transaction...");
    await session.commitTransaction();
    console.log("✅ Publish transaction committed");

    res.json({
      message: `Quiz ${publish ? "published" : "unpublished"} successfully`,
      quiz,
    });

  } catch (error) {
    await session.abortTransaction();
    console.error("🔥 Quiz publish/unpublish failed:", error);
    res.status(500).json({
      message: "Error updating quiz status",
      error: error.message,
    });
  } finally {
    session.endSession();
    console.log("🧹 Publish session ended");
  }
};



/// ---------------------------
// 3. Get QuizSession with Caching (Fixed & Safe)
// ---------------------------
const getQuiz = async (req, res) => {
  try {
    const { quizId } = req.params;
    const school = toObjectId(req.user.school);
    const userId = req.user._id;

    console.log(
      `📥 Loading quiz ${quizId} for user ${userId}, role: ${req.user.role}`
    );

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    const cacheKey = CACHE_KEYS.QUIZ_SINGLE(quizId, req.user.role);
    if (req.user.role !== "student") {
      const cached = cache.get(cacheKey);
      if (cached) return res.json(cached);
    }

    const quiz = await executeWithTimeout(
      QuizSession.findOne({
        _id: toObjectId(quizId),
        school,
      })
        .lean()
        .maxTimeMS(5000)
    );

    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found in your school" });
    }

    if (req.user.role === "student") {
      if (quiz.startTime && new Date() < new Date(quiz.startTime)) {
        return res.status(403).json({ message: "Quiz is not available yet" });
      }
      if (!quiz.isPublished) {
        return res.status(403).json({ message: "Quiz is not published yet" });
      }
    }

    // --------------------------------------------------
    // 🔑 SECTION TYPE RESOLVER (SINGLE SOURCE OF TRUTH)
    // --------------------------------------------------
    const resolveSectionType = (section) => {
      if (
        typeof section.passage === "string" &&
        section.passage.trim().length &&
        Array.isArray(section.items)
      ) {
        return "cloze";
      }

      if (Array.isArray(section.questions)) {
        return "standard";
      }

      throw new Error(
        "Section must contain either { questions[] } or { passage + items[] }"
      );
    };

    let response;

    // =====================================================
    // 🟢 STUDENT VIEW
    // =====================================================
    if (req.user.role === "student") {
      const seed = `${userId}-${quizId}`;

      // ---------------------------------
      // 🔹 SECTIONED QUIZ
      // ---------------------------------
      if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
        const processedSections = quiz.sections.map(
          (section, sectionIndex) => {
            const sectionType = resolveSectionType(section);

            // 🟢 STANDARD SECTION
            if (sectionType === "standard") {
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
                  explanation: q.explanation || "",
                  points: q.points || 1,
                };

                if (Array.isArray(q.options)) {
                  question.options = quiz.shuffleOptions
                    ? seededShuffle(
                        [...q.options],
                        seed + `-options-${q._id || index}`
                      )
                    : [...q.options];
                }

                return question;
              });

              return {
                sectionType: "standard",
                title: section.title || null,
                instruction: section.instruction,
                questions: safeQuestions,
              };
            }

            // 🟣 CLOZE SECTION
            return {
              sectionType: "cloze",
              title: section.title || null,
              instruction: section.instruction,
              passage: section.passage,
              items: section.items.map((item) => ({
                number: item.number,
                options: quiz.shuffleOptions
                  ? seededShuffle(
                      [...item.options],
                      seed + `-cloze-${item.number}`
                    )
                  : [...item.options],
                points: item.points || 1,
              })),
            };
          }
        );

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
          totalPoints: quiz.sections.reduce((sum, s) => {
            const type = resolveSectionType(s);
           if (type === "cloze") {
  return sum + s.items.reduce(
    (itemSum, item) => itemSum + (item.points || 1),
    0
  );
}

            return (
              sum +
              s.questions.reduce(
                (qSum, q) => qSum + (q.points || 1),
                0
              )
            );
          }, 0),
        };

        return res.json(response);
      }

      // ---------------------------------
      // 🔹 FLAT QUESTIONS (LEGACY)
      // ---------------------------------
      let quizQuestions = [...(quiz.questions || [])];

      if (quiz.shuffleQuestions) {
        quizQuestions = seededShuffle(quizQuestions, seed + "-questions");
      }

      response = {
        _id: quiz._id,
        title: quiz.title,
        subject: quiz.subject,
        timeLimit: quiz.timeLimit,
        startTime: quiz.startTime,
        dueDate: quiz.dueDate,
        questions: quizQuestions.map((q, index) => {
          const question = {
            _id: q._id || `temp-${index}`,
            questionText: q.questionText,
            type: q.type,
            explanation: q.explanation || "",
            points: q.points || 1,
          };

          if (Array.isArray(q.options)) {
            question.options = quiz.shuffleOptions
              ? seededShuffle(
                  [...q.options],
                  seed + "-options-" + (q._id || index)
                )
              : [...q.options];
          }

          return question;
        }),
        shuffleQuestions: quiz.shuffleQuestions,
        shuffleOptions: quiz.shuffleOptions,
        totalPoints: quizQuestions.reduce(
          (s, q) => s + (q.points || 1),
          0
        ),
      };

      return res.json(response);
    }

    // =====================================================
    // 🟠 TEACHER VIEW (RAW)
    // =====================================================
    response = quiz;
    cache.set(cacheKey, response, 300);
    return res.json(response);

  } catch (error) {
    console.error("❌ getQuiz error:", error);
    res.status(500).json({
      message: "Error fetching quiz",
      error: error.message,
    });
  }
};




// --------------------------- 
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
        .select(
          role === "student"
            ? "-questions.correctAnswer -sections.questions.correctAnswer -sections.items.correctAnswer"
            : ""
        )
        .sort({ createdAt: -1 })
        .lean(),
      5000
    );

    if (!quizzes.length) {
      cache.set(cacheKey, [], 60);
      return res.json([]);
    }

    // --------------------------------------------------
    // 🔴 SECTION-AWARE TOTAL POINTS CALCULATOR (FINAL)
    // --------------------------------------------------
   const computeTotalPoints = (quiz) => {
  // 🔹 Legacy flat quiz
  if (Array.isArray(quiz.questions) && quiz.questions.length > 0) {
    return quiz.questions.reduce(
      (sum, q) => sum + (q.points || 1),
      0
    );
  }

  // 🔹 Section-based quiz (authoritative)
  if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
    return quiz.sections.reduce((total, section) => {
      try {
        const sectionType = resolveSectionType(section);

        // 🟣 CLOZE SECTION
        if (sectionType === "cloze" && Array.isArray(section.items)) {
          return (
            total +
            section.items.reduce(
              (s, item) => s + (item.points || 1),
              0
            )
          );
        }

        // 🟢 STANDARD SECTION
        if (
          sectionType === "standard" &&
          Array.isArray(section.questions)
        ) {
          return (
            total +
            section.questions.reduce(
              (s, q) => s + (q.points || 1),
              0
            )
          );
        }

        return total;
      } catch (error) {
        console.warn(`⚠️ Error processing section, skipping: ${error.message}`);
        return total; // Skip this section
      }
    }, 0);
  }

  return 0;
};

    const quizIds = quizzes.map((q) => toObjectId(q._id));

    // ============================
    // 🔵 STUDENT VIEW
    // ============================
    if (role === "student") {
      const studentDoc = await executeWithTimeout(
        Student.findOne({ user: toObjectId(userId), school }).lean(),
        5000
      );

      const studentObjectId = studentDoc?._id;

      const [notifications, completedResults, activeAttempts] =
        await Promise.all([
          executeWithTimeout(
            Notification.find({
              school,
              type: "quiz",
              quizId: { $in: quizIds },
              $or: [
                { studentId: studentObjectId },
                { recipientUsers: userId },
                { recipientRoles: "student" },
              ],
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
                { studentId: studentObjectId },
              ],
              school,
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
                { studentId: studentObjectId },
              ],
              school,
              status: "in-progress",
              expiresAt: { $gt: new Date() },
            })
              .select("quizId")
              .lean(),
            5000
          ),
        ]);

      const notifMap = Object.fromEntries(
        notifications.map((n) => [n.quizId?.toString(), n])
      );

      const completedMap = new Set(
        completedResults.map((r) => r.quizId.toString())
      );
      const inProgressMap = new Set(
        activeAttempts.map((a) => a.quizId.toString())
      );

      const quizzesWithProgress = quizzes.map((q) => {
        const id = q._id.toString();
        const completed = completedMap.has(id);
        const inProgress = !completed && inProgressMap.has(id);

        const { className, classDisplayName } = resolveQuizClassNames(q.class);

        return {
          ...q,
          subject: q.subject?.name ?? "Unknown Subject",
          className,
          classDisplayName,
          totalPoints: computeTotalPoints(q),
          completed,
          inProgress,
          status: completed
            ? "Completed"
            : inProgress
            ? "In Progress"
            : "Available",
          notification: notifMap[id] || null,
        };
      });

      processInBackground(async () => {
        await Notification.updateMany(
          {
            quizId: { $in: quizIds },
            type: "quiz",
            isRead: false,
            $or: [
              { studentId: studentObjectId },
              { recipientUsers: userId },
            ],
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
              averageScore: { $avg: "$score" },
            },
          },
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
              expiresAt: { $gt: new Date() },
            },
          },
          { $group: { _id: "$quizId", inProgressCount: { $sum: 1 } } },
        ]),
        5000
      ),
    ]);

    const resultsMap = new Map(
      resultsAgg.map((r) => [
        r._id.toString(),
        {
          submissionCount: r.submissionCount,
          averageScore: r.averageScore,
        },
      ])
    );

    const attemptsMap = new Map(
      attemptsAgg.map((a) => [a._id.toString(), a.inProgressCount])
    );

    const quizzesWithStats = quizzes.map((q) => {
      const id = q._id.toString();
      const stats = resultsMap.get(id) || {
        submissionCount: 0,
        averageScore: null,
      };

      const { className, classDisplayName } = resolveQuizClassNames(q.class);

      return {
        ...q,
        subject: q.subject?.name ?? "Unknown Subject",
        className,
        classDisplayName,
        totalPoints: computeTotalPoints(q),
        submissionCount: stats.submissionCount,
        averageScore: stats.averageScore,
        inProgressCount: attemptsMap.get(id) || 0,
      };
    });

    cache.set(cacheKey, quizzesWithStats, 120);
    return res.json(quizzesWithStats);
  } catch (error) {
    console.error("❌ Error fetching quizzes with progress:", error);
    return res.status(500).json({
      message: "Error fetching quizzes",
      error: error.message,
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
      return res.status(400).json({ message: "Invalid school ID format" });
    }

    // Fetch quizzes
    const quizzes = await QuizSession.find({ school: toObjectId(schoolId) })
      .populate("teacher", "name email")
      .populate("class", "name")
      .populate({ path: "subject", select: "name shortName" })
      .sort({ createdAt: -1 })
      .lean(); // 🔴 ensure plain object for safe computation

    if (!quizzes || quizzes.length === 0) {
      return res.status(404).json({ message: "No quizzes found for this school" });
    }

    // --------------------------------------------------
    // 🔴 SECTION-AWARE TOTAL POINTS CALCULATOR
    // --------------------------------------------------
    const computeTotalPoints = (quiz) => {
      // 🔹 Flat (legacy)
      if (Array.isArray(quiz.questions) && quiz.questions.length > 0) {
        return quiz.questions.reduce(
          (sum, q) => sum + (q.points || 1),
          0
        );
      }

      // 🔹 Section-based (authoritative)
      if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
        return quiz.sections.reduce((total, section) => {
          const sectionType = resolveSectionType(section);

          // 🟣 CLOZE SECTION
          if (sectionType === "cloze" && Array.isArray(section.items)) {
            return (
              total +
              section.items.reduce(
                (s, item) => s + (item.points || 1),
                0
              )
            );
          }

          // 🟢 STANDARD SECTION
          if (
            sectionType === "standard" &&
            Array.isArray(section.questions)
          ) {
            return (
              total +
              section.questions.reduce(
                (s, q) => s + (q.points || 1),
                0
              )
            );
          }

          return total;
        }, 0);
      }

      return 0;
    };

    // Format response
    const formattedQuizzes = quizzes.map((q) => {
      const { className, classDisplayName } = resolveQuizClassNames(q.class);

      return {
        _id: q._id,
        title: q.title,
        className,
        classDisplayName,
        teacher: q.teacher?.name || "Unknown Teacher",
        subject: resolveSubjectName(q),
        totalPoints: computeTotalPoints(q), // ✅ FIXED
        createdAt: q.createdAt,
        dueDate: q.dueDate,
        isPublished: q.isPublished,
      };
    });

    return res.json({ quizzes: formattedQuizzes });
  } catch (error) {
    console.error("❌ Error fetching school quizzes:", error);
    return res.status(500).json({
      message: "Error fetching school quizzes",
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
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    // 🎯 Parallel validation checks
    const [quiz, user] = await Promise.all([
      executeWithTimeout(
        QuizSession.findOne({ _id: toObjectId(quizId), school })
          .lean()
          .maxTimeMS(5000)
      ),
      executeWithTimeout(
        User.findOne({ _id: toObjectId(userId), school })
          .lean()
          .maxTimeMS(5000)
      ),
    ]);

    if (!quiz) {
      return res.status(404).json({ message: "Quiz not found in your school" });
    }

    if (req.user.role === "student") {
      if (!user || user.class?.toString() !== quiz.class.toString()) {
        return res
          .status(403)
          .json({ message: "You are not allowed to access this quiz" });
      }

      if (quiz.startTime && new Date() < new Date(quiz.startTime)) {
        return res.status(403).json({ message: "Quiz is not available yet" });
      }

      if (!quiz.isPublished) {
        return res.status(403).json({ message: "Quiz is not published yet" });
      }
    }

    const sessionId = new mongoose.Types.ObjectId().toString();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // 🎯 Background attempt creation
    processInBackground(async () => {
      try {
        await QuizAttempt.create({
          sessionId,
          quizId: toObjectId(quizId),
          studentId: req.user.role === "student" ? toObjectId(userId) : null,
          school,
          startTime: new Date(),
          expiresAt,
          status: "in-progress",
          answers: {}, // 🔴 REQUIRED (CLOZE + STANDARD)
        });
      } catch (err) {
        console.error("Session creation failed:", err);
      }
    });

    // ==================================================
    // 🔒 BUILD PROTECTED PAYLOAD (SECTION-AWARE)
    // ==================================================
    const protectedSections = [];

    if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
      quiz.sections.forEach((section, sectionIndex) => {
        const sectionType = resolveSectionType(section);

        // ==========================
        // 🟣 CLOZE SECTION
        // ==========================
        if (sectionType === "cloze") {
          protectedSections.push({
            id: `section_${sectionIndex}_${sessionId}`,
            sectionType: "cloze",
            instruction: section.instruction,
            passage: obfuscateText(section.passage),
            items: section.items.map((item) => ({
              number: item.number,
              points: item.points || 1,
              options: item.options.map((opt) => ({
                id: `opt_${Math.random().toString(36).slice(2, 9)}`,
                text: obfuscateText(opt),
                value: opt, // 🔴 required for submit mapping
              })),
            })),
          });

          return;
        }

        // ==========================
        // 🟢 STANDARD SECTION
        // ==========================
        let questions = [...section.questions];

        if (quiz.shuffleQuestions) {
          questions = questions.sort(() => Math.random() - 0.5);
        }

        protectedSections.push({
          id: `section_${sectionIndex}_${sessionId}`,
          sectionType: "standard",
          instruction: section.instruction,
          questions: questions.map((q, qIndex) => {
            let options = [];

            if (Array.isArray(q.options) && q.options.length > 0) {
              options = [...q.options];

              if (quiz.shuffleOptions) {
                options = options.sort(() => Math.random() - 0.5);
              }

              options = options.map((opt) => ({
                id: `opt_${Math.random().toString(36).slice(2, 9)}`,
                text: obfuscateText(opt),
                value: opt,
              }));
            }

            return {
              id: `q_${sectionIndex}_${qIndex}_${sessionId}`,
              questionId: q._id, // 🔴 required for submitQuiz
              questionText: obfuscateText(q.questionText),
              type: q.type,
              points: q.points || 1,
              options,
            };
          }),
        });
      });
    }

    return res.json({
      sessionId,
      quizTitle: quiz.title,
      timeLimit: quiz.timeLimit,
      startTime: new Date(),
      expiresAt,
      sections: protectedSections,
    });
  } catch (error) {
    console.error("Error getting protected quiz:", error);
    return res.status(500).json({
      message: "Error loading quiz",
      error: error.message,
    });
  }
};

// --------------------------------------------------
// 🔒 TEXT OBFUSCATION (ANTI-COPY)
// --------------------------------------------------
function obfuscateText(text) {
  if (!text) return text;
  return text
    .split(" ")
    .map((word) => word.split("").join("\u200B"))
    .join(" ");
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
// 9. Get QuizSession Results (Section + Cloze Aware)
// ---------------------------
const getQuizResults = async (req, res) => {
  try {
    const { quizId } = req.params;
    const school = toObjectId(req.user.school);
    const cacheKey = CACHE_KEYS.QUIZ_RESULTS(quizId);

    // 🎯 Cache check
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    const results = await executeWithTimeout(
      QuizResult.find({
        quizId: toObjectId(quizId),
        school,
      })
        .populate("studentId", "name email")
        .sort({ submittedAt: -1 })
        .lean()
        .maxTimeMS(8000)
    );

    const formatted = results.map((r) => {
      const answers = Array.isArray(r.answers) ? r.answers : [];

      // ==================================================
      // 🔴 AUTHORITATIVE SECTION BUILD (NO GUESSING)
      // ==================================================
      const sectionsMap = {};

      answers.forEach((a) => {
        const key = a.sectionId || a.sectionInstruction || "__NO_SECTION__";

        if (!sectionsMap[key]) {
          sectionsMap[key] = {
            sectionId: a.sectionId || null,
            sectionTitle: a.sectionTitle || null,
            sectionInstruction: a.sectionInstruction || null,
            clozePassage: a.clozePassage || null,
            items: [],
          };
        }

        sectionsMap[key].items.push(a);
      });

      const sections = Object.values(sectionsMap).map((section) => {
        const clozeItems = section.items.filter(
          (i) => i.questionType === "cloze"
        );

        // ==========================
        // 🟣 CLOZE SECTION
        // ==========================
        if (clozeItems.length > 0) {
          return {
            sectionType: "cloze",
            sectionTitle: section.sectionTitle,
            instruction: section.sectionInstruction,
            passage: section.clozePassage, // 🔥 THIS WAS MISSING
            questions: clozeItems.map((q) => ({
              questionId: q.questionId,
              number: q.clozeNumber,
              selectedAnswer: q.selectedAnswer,
              correctAnswer: q.correctAnswer,
              isCorrect: q.isCorrect,
              points: q.points,
              earnedPoints: q.earnedPoints,
            })),
            totalPoints: clozeItems.reduce(
              (s, q) => s + (q.points || 1),
              0
            ),
            earnedPoints: clozeItems.reduce(
              (s, q) => s + (q.earnedPoints || 0),
              0
            ),
          };
        }

        // ==========================
        // 🟢 STANDARD SECTION
        // ==========================
        return {
          sectionType: "standard",
          sectionTitle: section.sectionTitle,
          instruction: section.sectionInstruction,
          questions: section.items.map((q) => ({
            questionId: q.questionId,
            questionText: q.questionText,
            questionType: q.questionType,
            selectedAnswer: q.selectedAnswer,
            correctAnswer: q.correctAnswer,
            explanation: q.explanation,
            isCorrect: q.isCorrect,
            points: q.points,
            earnedPoints: q.earnedPoints,
            manualReviewRequired: q.manualReviewRequired,
          })),
          totalPoints: section.items.reduce(
            (s, q) => s + (q.points || 1),
            0
          ),
          earnedPoints: section.items.reduce(
            (s, q) => s + (q.earnedPoints || 0),
            0
          ),
        };
      });

      return {
        student: r.studentId?.name || "Unknown",
        studentEmail: r.studentId?.email || "",
        score: r.score,
        totalPoints: r.totalPoints,
        percentage: r.percentage,
        submittedAt: r.submittedAt,
        timeSpent: r.timeSpent,
        attemptNumber: r.attemptNumber,

        // 🔹 BACKWARD COMPATIBILITY
        answers,

        // 🔥 AUTHORITATIVE STRUCTURE (FRONTEND USES THIS)
        sections,
      };
    });

    cache.set(cacheKey, formatted, 180);
    return res.json(formatted);

  } catch (error) {
    console.error("❌ getQuizResults error:", error);
    return res.status(500).json({
      message: "Error fetching results",
      error: error.message,
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
// 12. Update QuizSession - OPTIMIZED (SECTION-AWARE, CLOZE-SAFE)
// ---------------------------
const updateQuiz = async (req, res) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { quizId } = req.params;

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      await session.abortTransaction();
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    const {
      title,
      questions,
      sections,
      dueDate,
      timeLimit,
      startTime,
      shuffleQuestions,
      shuffleOptions,
    } = req.body;

    const school = toObjectId(req.user.school);

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
        .json({ message: "You can only update quizzes you created" });
    }

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
      (questions && questions.length === 0) ||
      (sections && sections.length === 0)
    ) {
      await session.abortTransaction();
      return res.status(400).json({
        message: "Questions or sections cannot be empty",
      });
    }

    // --------------------------------------------------
    // 🧪 Validate FLAT QUESTIONS (STANDARD ONLY)
    // --------------------------------------------------
    if (Array.isArray(questions)) {
      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const type = (q.type || "").toLowerCase();

        if (!q.questionText || !q.type) {
          await session.abortTransaction();
          return res.status(400).json({
            message: `Question ${i + 1} is missing required fields`,
          });
        }

        // 🟢 MULTIPLE CHOICE
        if (type === "multiple-choice") {
          if (!Array.isArray(q.options) || q.options.length < 2) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Question ${i + 1}: MCQ requires options`,
            });
          }

          if (!q.options.includes(q.correctAnswer)) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Question ${i + 1}: correctAnswer must be one of the options`,
            });
          }
        }

        // 🟢 TRUE / FALSE
        if (type === "true-false" && typeof q.correctAnswer !== "boolean") {
          await session.abortTransaction();
          return res.status(400).json({
            message: `Question ${i + 1}: True/False requires boolean correctAnswer`,
          });
        }

        // 🟢 ESSAY / SHORT ANSWER → no auto validation

        if (!q.points) q.points = 1;
      }
    }

    // --------------------------------------------------
    // 🧪 Validate SECTIONS (STANDARD vs CLOZE)
    // --------------------------------------------------
    if (Array.isArray(sections)) {
      for (let i = 0; i < sections.length; i++) {
        const section = sections[i];

        if (!section.instruction || !section.instruction.trim()) {
          await session.abortTransaction();
          return res.status(400).json({
            message: `Section ${i + 1} must have an instruction`,
          });
        }

        const sectionType = resolveSectionType(section);

        // ==========================
        // 🟢 STANDARD SECTION
        // ==========================
        if (sectionType === "standard") {
          if (
            !Array.isArray(section.questions) ||
            section.questions.length === 0
          ) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Section ${i + 1} must contain questions`,
            });
          }

          for (let j = 0; j < section.questions.length; j++) {
            const q = section.questions[j];
            const type = (q.type || "").toLowerCase();

            if (!q.questionText || !q.type) {
              await session.abortTransaction();
              return res.status(400).json({
                message: `Section ${i + 1}, Question ${j + 1} is missing required fields`,
              });
            }

            if (type === "multiple-choice") {
              if (
                !Array.isArray(q.options) ||
                !q.options.includes(q.correctAnswer)
              ) {
                await session.abortTransaction();
                return res.status(400).json({
                  message: `Section ${i + 1}, Question ${j + 1}: Invalid MCQ`,
                });
              }
            }

            if (type === "true-false" && typeof q.correctAnswer !== "boolean") {
              await session.abortTransaction();
              return res.status(400).json({
                message: `Section ${i + 1}, Question ${j + 1}: Invalid True/False`,
              });
            }

            if (!q.points) q.points = 1;
          }
        }

        // ==========================
        // 🟣 CLOZE SECTION
        // ==========================
        if (sectionType === "cloze") {
          if (!section.passage || !section.passage.trim()) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Section ${i + 1}: Cloze section must have a passage`,
            });
          }

          if (!Array.isArray(section.items) || section.items.length === 0) {
            await session.abortTransaction();
            return res.status(400).json({
              message: `Section ${i + 1}: Cloze section must contain items`,
            });
          }

          for (let k = 0; k < section.items.length; k++) {
            const item = section.items[k];

            if (typeof item.number !== "number") {
              await session.abortTransaction();
              return res.status(400).json({
                message: `Section ${i + 1}, Item ${k + 1}: Missing number`,
              });
            }

            if (
              !Array.isArray(item.options) ||
              item.options.length < 2 ||
              !item.options.includes(item.correctAnswer)
            ) {
              await session.abortTransaction();
              return res.status(400).json({
                message: `Section ${i + 1}, Item ${item.number}: Invalid options or correctAnswer`,
              });
            }

            if (!item.points) item.points = 1;
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
    if (shuffleQuestions !== undefined)
      quiz.shuffleQuestions = shuffleQuestions;
    if (shuffleOptions !== undefined)
      quiz.shuffleOptions = shuffleOptions;

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

    // 🧹 Cache invalidation
    processInBackground(() => {
      cache.del(CACHE_KEYS.QUIZ_SINGLE(quizId, "teacher"));
      cache.del(CACHE_KEYS.QUIZ_SINGLE(quizId, "student"));
      cache.del(
        CACHE_KEYS.QUIZ_CLASS(quiz.class.toString(), "teacher", req.user._id)
      );
      cache.delPattern(
        CACHE_KEYS.QUIZ_CLASS(quiz.class.toString(), "student", "")
      );
    });

    res.json({
      message: "Quiz updated successfully",
      quiz,
    });
  } catch (error) {
    await session.abortTransaction();
    console.error("Quiz update failed:", error);
    res.status(500).json({
      message: "Error updating quiz",
      error: error.message,
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
      answersCount: Object.keys(answers || {}).length,
    });

    if (!quizId || !mongoose.Types.ObjectId.isValid(quizId)) {
      return res.status(400).json({ message: "Invalid quiz ID format" });
    }

    // --------------------------------------------------
    // 🔐 Resolve canonical Student ID
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
    // 🔑 SECTION TYPE RESOLVER (SINGLE SOURCE OF TRUTH)
    // --------------------------------------------------
    const resolveSectionType = (section) => {
      if (
        typeof section.passage === "string" &&
        section.passage.trim().length &&
        Array.isArray(section.items)
      ) {
        return "cloze";
      }

      if (Array.isArray(section.questions)) {
        return "standard";
      }

      throw new Error(
        "Section must contain either { questions[] } or { passage + items[] }"
      );
    };

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
        answers: {},
      });
    }

    // --------------------------------------------------
    // 🔴 SYNC SUBMITTED ANSWERS INTO ATTEMPT
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

    // ----------------------------------------------
    // 🔹 SECTIONED QUIZ
    // ----------------------------------------------
    if (Array.isArray(quiz.sections) && quiz.sections.length > 0) {
      for (const section of quiz.sections) {
        const sectionType = resolveSectionType(section);

        // ==========================
        // 🟢 STANDARD SECTION
        // ==========================
        if (sectionType === "standard") {
          for (const q of section.questions) {
            const studentAnswer = answers[q._id] ?? null;

            const item = {
              questionId: q._id,
              questionText: q.questionText,
              questionType: q.type,
              sectionInstruction: section.instruction || null,
              selectedAnswer: studentAnswer,
              correctAnswer: q.correctAnswer,
              explanation: q.explanation || null,
              points: q.points || 1,
              earnedPoints: 0,
              isCorrect: null,
              manualReviewRequired: false,
              timeSpent: 0,
            };

            if (["essay", "short-answer"].includes(q.type)) {
              requiresManualReview = true;
              item.manualReviewRequired = true;
              results.push(item);
              continue;
            }

            totalAutoGradedPoints += item.points;

            if (studentAnswer !== null) {
              const correct =
                q.type === "true-false"
                  ? String(studentAnswer).toLowerCase() ===
                    String(q.correctAnswer).toLowerCase()
                  : studentAnswer === q.correctAnswer;

              item.isCorrect = correct;
              item.earnedPoints = correct ? item.points : 0;
              if (correct) score += item.points;
            } else {
              item.isCorrect = false;
            }

            results.push(item);
          }
        }

        // ==========================
        // 🟣 CLOZE SECTION
        // ==========================
        if (sectionType === "cloze") {
          for (const item of section.items) {
            const studentValue = answers[item.number] ?? null;
            const isCorrect = studentValue === item.correctAnswer;
            const points = item.points || 1;

            results.push({
              questionId: null,
              questionText: `Cloze ${item.number}`,
              questionType: "cloze",
              sectionInstruction: section.instruction || null,
              selectedAnswer: studentValue,
              correctAnswer: item.correctAnswer,
              explanation: null,
              points,
              earnedPoints: isCorrect ? points : 0,
              isCorrect,
              manualReviewRequired: false,
              timeSpent: 0,
            });

            totalAutoGradedPoints += points;
            if (isCorrect) score += points;
          }
        }
      }
    }

    // ----------------------------------------------
    // 🔹 FLAT (LEGACY) QUIZ
    // ----------------------------------------------
    else {
      for (const q of quiz.questions || []) {
        const studentAnswer = answers[q._id] ?? null;

        const item = {
          questionId: q._id,
          questionText: q.questionText,
          questionType: q.type,
          sectionInstruction: null,
          selectedAnswer: studentAnswer,
          correctAnswer: q.correctAnswer,
          explanation: q.explanation || null,
          points: q.points || 1,
          earnedPoints: 0,
          isCorrect: null,
          manualReviewRequired: false,
          timeSpent: 0,
        };

        if (["essay", "short-answer"].includes(q.type)) {
          requiresManualReview = true;
          item.manualReviewRequired = true;
          results.push(item);
          continue;
        }

        totalAutoGradedPoints += item.points;

        if (studentAnswer !== null) {
          const correct =
            q.type === "true-false"
              ? String(studentAnswer).toLowerCase() ===
                String(q.correctAnswer).toLowerCase()
              : studentAnswer === q.correctAnswer;

          item.isCorrect = correct;
          item.earnedPoints = correct ? item.points : 0;
          if (correct) score += item.points;
        } else {
          item.isCorrect = false;
        }

        results.push(item);
      }
    }

    let percentage = null;
    if (!requiresManualReview && totalAutoGradedPoints > 0) {
      percentage = Number(((score / totalAutoGradedPoints) * 100).toFixed(2));
    }

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
        totalPoints: totalAutoGradedPoints,
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
    const { childId, quizId } = req.query;
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

        const { classDisplayName } = resolveQuizClassNames({
          name: info.className,
        });
        r.classDisplayName = classDisplayName || info.className;

        r.answers = Array.isArray(r.answers) ? r.answers : [];

        // --------------------------------------------------
        // 🔴 GROUP BY SECTION (AUTHORITATIVE)
        // --------------------------------------------------
        const sectionsMap = {};
        r.answers.forEach((a) => {
          const key = a.sectionInstruction || "__NO_SECTION__";
          if (!sectionsMap[key]) sectionsMap[key] = [];
          sectionsMap[key].push(a);
        });

        r.sections =
          Object.keys(sectionsMap).length > 0
            ? Object.entries(sectionsMap).map(
                ([instruction, sectionAnswers]) => {
                  const clozeItems = sectionAnswers.filter(
  (a) => a.questionType === "cloze"
);


                  // 🟣 CLOZE SECTION
                  if (clozeItems.length > 0) {
                    return {
                      instruction:
                        instruction === "__NO_SECTION__" ? null : instruction,
                      sectionType: "cloze",
                      items: clozeItems.map((item) => ({
                        number: Number(
                          (item.questionText || "").replace("Cloze ", "")
                        ),
                        selectedAnswer: item.selectedAnswer,
                        correctAnswer: item.correctAnswer,
                        isCorrect: item.isCorrect,
                        earnedPoints: item.earnedPoints,
                        points: item.points,
                      })),
                    };
                  }

                  // 🟢 STANDARD SECTION
                  return {
                    instruction:
                      instruction === "__NO_SECTION__" ? null : instruction,
                    sectionType: "standard",
                    questions: sectionAnswers.map((q) => ({
                      questionId: q.questionId,
                      questionText: q.questionText,
                      questionType: q.questionType,
                      selectedAnswer: q.selectedAnswer,
                      correctAnswer: q.correctAnswer,
                      explanation: q.explanation,
                      isCorrect: q.isCorrect,
                      points: q.points,
                      earnedPoints: q.earnedPoints,
                      manualReviewRequired: q.manualReviewRequired,
                    })),
                  };
                }
              )
            : null;

        // --------------------------------------------------
        // 🧠 FINAL STATUS (CLOZE SAFE)
        // --------------------------------------------------
        const pendingManual = r.answers.some(
          (a) =>
            ["essay", "short-answer"].includes(
              (a.questionType || "").toLowerCase()
            ) &&
            (a.earnedPoints === null || a.earnedPoints === undefined)
        );

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
      else if (studentId && studentId !== "undefined")
        childFilter._id = studentId;

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

      targetStudentIds = children.map((c) => c._id);
      const allIds = children.flatMap((c) =>
        [c._id, c.user?._id].filter(Boolean)
      );

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

        const { classDisplayName } = resolveQuizClassNames({
          name: info.className,
        });
        r.classDisplayName = classDisplayName || info.className;

        r.answers = Array.isArray(r.answers) ? r.answers : [];

        // --------------------------------------------------
        // 🔴 GROUP BY SECTION (AUTHORITATIVE)
        // --------------------------------------------------
        const sectionsMap = {};
        r.answers.forEach((a) => {
          const key = a.sectionInstruction || "__NO_SECTION__";
          if (!sectionsMap[key]) sectionsMap[key] = [];
          sectionsMap[key].push(a);
        });

        r.sections =
          Object.keys(sectionsMap).length > 0
            ? Object.entries(sectionsMap).map(
                ([instruction, sectionAnswers]) => {
                  const clozeItems = sectionAnswers.filter(
  (a) => a.questionType === "cloze"
);


                  if (clozeItems.length > 0) {
                    return {
                      instruction:
                        instruction === "__NO_SECTION__" ? null : instruction,
                      sectionType: "cloze",
                      items: clozeItems.map((item) => ({
                        number: Number(
                          (item.questionText || "").replace("Cloze ", "")
                        ),
                        selectedAnswer: item.selectedAnswer,
                        correctAnswer: item.correctAnswer,
                        isCorrect: item.isCorrect,
                        earnedPoints: item.earnedPoints,
                        points: item.points,
                      })),
                    };
                  }

                  return {
                    instruction:
                      instruction === "__NO_SECTION__" ? null : instruction,
                    sectionType: "standard",
                    questions: sectionAnswers.map((q) => ({
                      questionId: q.questionId,
                      questionText: q.questionText,
                      questionType: q.questionType,
                      selectedAnswer: q.selectedAnswer,
                      correctAnswer: q.correctAnswer,
                      explanation: q.explanation,
                      isCorrect: q.isCorrect,
                      points: q.points,
                      earnedPoints: q.earnedPoints,
                      manualReviewRequired: q.manualReviewRequired,
                    })),
                  };
                }
              )
            : null;

        const pendingManual = r.answers.some(
          (a) =>
            ["essay", "short-answer"].includes(
              (a.questionType || "").toLowerCase()
            ) &&
            (a.earnedPoints === null || a.earnedPoints === undefined)
        );

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
    result.answers = (result.answers || []).map((a) => ({
      ...a,
      earnedPoints:
        typeof a.earnedPoints === "number" ? a.earnedPoints : 0,
      feedback: typeof a.feedback === "string" ? a.feedback : "",
      manualReviewRequired: !!a.manualReviewRequired,
      questionType: a.questionType || "unknown",
      points: typeof a.points === "number" ? a.points : 0,
      isCorrect:
        typeof a.isCorrect === "boolean" ? a.isCorrect : null,
      sectionInstruction: a.sectionInstruction || null,
    }));

    // --------------------------------------------------
    // 🔴 GROUP BY SECTION (AUTHORITATIVE)
    // --------------------------------------------------
    const sectionsMap = {};

    result.answers.forEach((a) => {
      const sectionKey = a.sectionInstruction || "__NO_SECTION__";
      if (!sectionsMap[sectionKey]) {
        sectionsMap[sectionKey] = [];
      }
      sectionsMap[sectionKey].push(a);
    });

    result.sections =
      Object.keys(sectionsMap).length > 0
        ? Object.entries(sectionsMap).map(([instruction, sectionAnswers]) => {
            // -----------------------------------------
            // 🟣 DETECT CLOZE VS STANDARD
            // -----------------------------------------
            const clozeItems = sectionAnswers.filter(
  (a) => a.questionType === "cloze"
);


            // ==========================
            // 🟣 CLOZE SECTION
            // ==========================
            if (clozeItems.length > 0) {
              const items = clozeItems.map((item) => ({
                number: Number(
                  (item.questionText || "").replace("Cloze ", "")
                ),
                selectedAnswer: item.selectedAnswer,
                correctAnswer: item.correctAnswer,
                isCorrect: item.isCorrect,
                earnedPoints: item.earnedPoints,
                points: item.points,
              }));

              return {
                instruction:
                  instruction === "__NO_SECTION__" ? null : instruction,
                sectionType: "cloze",
                items,
                totalPoints: items.reduce(
                  (s, i) => s + (i.points || 1),
                  0
                ),
                earnedPoints: items.reduce(
                  (s, i) => s + (i.earnedPoints || 0),
                  0
                ),
              };
            }

            // ==========================
            // 🟢 STANDARD SECTION
            // ==========================
            return {
              instruction:
                instruction === "__NO_SECTION__" ? null : instruction,
              sectionType: "standard",
              questions: sectionAnswers.map((q) => ({
                questionId: q.questionId,
                questionText: q.questionText,
                questionType: q.questionType,
                selectedAnswer: q.selectedAnswer,
                correctAnswer: q.correctAnswer,
                explanation: q.explanation,
                isCorrect: q.isCorrect,
                points: q.points,
                earnedPoints: q.earnedPoints,
                manualReviewRequired: q.manualReviewRequired,
              })),
              totalPoints: sectionAnswers.reduce(
                (s, q) => s + (q.points || 1),
                0
              ),
              earnedPoints: sectionAnswers.reduce(
                (s, q) => s + (q.earnedPoints || 0),
                0
              ),
            };
          })
        : null;

    // --------------------------------------------------
    // ✅ Recalculate totals (section + cloze safe)
    // --------------------------------------------------
    const totalEarned = result.answers.reduce(
      (sum, a) => sum + (a.earnedPoints || 0),
      0
    );

    const totalPoints =
      typeof result.totalPoints === "number" && result.totalPoints > 0
        ? result.totalPoints
        : result.answers.reduce(
            (sum, a) => sum + (a.points || 0),
            0
          );

    result.score = totalEarned;
    result.totalPoints = totalPoints;
    result.percentage =
      totalPoints > 0
        ? Number(((totalEarned / totalPoints) * 100).toFixed(2))
        : 0;

    cache.set(cacheKey, result, 300);
    return res.status(200).json(result);

  } catch (err) {
    console.error("❌ Error fetching result:", err);
    return res.status(500).json({
      message: "Error fetching result",
      error: err.message,
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
        })
          .select("_id name")
          .lean()
          .maxTimeMS(5000)
      ),
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
      ),
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
      // 🔴 GROUP BY SECTION (AUTHORITATIVE)
      // --------------------------------------------------
      const sectionsMap = {};
      answers.forEach(a => {
        const key = a.sectionInstruction || "__NO_SECTION__";
        if (!sectionsMap[key]) sectionsMap[key] = [];
        sectionsMap[key].push(a);
      });

      const sections =
        Object.keys(sectionsMap).length > 0
          ? Object.entries(sectionsMap).map(([instruction, sectionAnswers]) => {
              const clozeItems = sectionAnswers.filter(
  (a) => a.questionType === "cloze"
);


              // ==========================
              // 🟣 CLOZE SECTION
              // ==========================
              if (clozeItems.length > 0) {
                const items = clozeItems.map(item => ({
                  number: Number(
                    (item.questionText || "").replace("Cloze ", "")
                  ),
                  selectedAnswer: item.selectedAnswer,
                  correctAnswer: item.correctAnswer,
                  isCorrect: item.isCorrect,
                  earnedPoints: item.earnedPoints,
                  points: item.points,
                }));

                return {
                  instruction:
                    instruction === "__NO_SECTION__" ? null : instruction,
                  sectionType: "cloze",
                  items,
                  totalPoints: items.reduce(
                    (s, i) => s + (i.points || 1),
                    0
                  ),
                  earnedPoints: items.reduce(
                    (s, i) => s + (i.earnedPoints || 0),
                    0
                  ),
                };
              }

              // ==========================
              // 🟢 STANDARD SECTION
              // ==========================
              return {
                instruction:
                  instruction === "__NO_SECTION__" ? null : instruction,
                sectionType: "standard",
                questions: sectionAnswers.map(q => ({
                  questionId: q.questionId,
                  questionText: q.questionText,
                  questionType: q.questionType,
                  selectedAnswer: q.selectedAnswer,
                  correctAnswer: q.correctAnswer,
                  explanation: q.explanation,
                  isCorrect: q.isCorrect,
                  points: q.points,
                  earnedPoints: q.earnedPoints,
                  manualReviewRequired: q.manualReviewRequired,
                })),
                totalPoints: sectionAnswers.reduce(
                  (s, q) => s + (q.points || 1),
                  0
                ),
                earnedPoints: sectionAnswers.reduce(
                  (s, q) => s + (q.earnedPoints || 0),
                  0
                ),
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
      })),
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