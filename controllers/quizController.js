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

    // 🎯 Parallel validation checks
    const [schoolCheck, classInfo] = await Promise.all([
      executeWithTimeout(
        Class.findOne({ school }).lean().maxTimeMS(5000)
      ),
      executeWithTimeout(
        Class.findOne({ _id: toObjectId(classId), school }).lean().maxTimeMS(5000)
      )
    ]);

    if (!schoolCheck) {
      await session.abortTransaction();
      return res.status(400).json({ message: "User does not have a valid school assigned" });
    }

    if (!classInfo) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Class not found in your school" });
    }

    // 🎯 Validate questions efficiently
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ message: "At least one question is required" });
    }

    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      if (!q.questionText || !q.type) {
        await session.abortTransaction();
        return res.status(400).json({ 
          message: `Question ${i + 1} is missing required fields (questionText or type)` 
        });
      }

      if (q.type === "multiple-choice") {
        if (!q.options || !Array.isArray(q.options) || q.correctAnswer === undefined) {
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
      } else if (q.type === "true-false" && typeof q.correctAnswer !== "boolean") {
        await session.abortTransaction();
        return res.status(400).json({ 
          message: `Question ${i + 1}: True-false questions require a boolean correctAnswer` 
        });
      }

      if (!q.points) q.points = 1;
    }

    // 🎯 Get teacher subjects with caching
    const teacherSubjects = await getCachedTeacherSubjects(teacherUserId, school);
    if (teacherSubjects.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ message: "No subjects assigned to this teacher profile." });
    }

    // 🎯 Subject resolution with early returns
    let chosenSubjectDoc = null;

    if (subjectId && mongoose.Types.ObjectId.isValid(subjectId)) {
      chosenSubjectDoc = teacherSubjects.find(s => String(s._id) === String(subjectId));
      if (!chosenSubjectDoc) {
        await session.abortTransaction();
        return res.status(403).json({
          message: "Selected subject is not assigned to this teacher",
          allowedSubjects: teacherSubjects.map(s => ({ _id: s._id, name: s.name }))
        });
      }
    }

    if (!chosenSubjectDoc && typeof subjectName === 'string' && subjectName.trim()) {
      const needle = subjectName.trim().toUpperCase();
      chosenSubjectDoc = teacherSubjects.find(s => {
        const n = (s.name || '').toUpperCase();
        const sn = (s.shortName || '').toUpperCase();
        const aliases = Array.isArray(s.aliases) ? s.aliases.map(a => String(a).toUpperCase()) : [];
        return n === needle || sn === needle || aliases.includes(needle);
      });
      if (!chosenSubjectDoc) {
        await session.abortTransaction();
        return res.status(403).json({
          message: `Subject "${subjectName}" is not assigned to this teacher`,
          allowedSubjects: teacherSubjects.map(s => ({ _id: s._id, name: s.name }))
        });
      }
    }

    if (!chosenSubjectDoc) {
      if (teacherSubjects.length === 1) {
        chosenSubjectDoc = teacherSubjects[0];
      } else {
        await session.abortTransaction();
        return res.status(400).json({
          message: "Multiple subjects found. Please specify subjectId or subjectName.",
          allowedSubjects: teacherSubjects.map(s => ({ _id: s._id, name: s.name }))
        });
      }
    }

    // 🎯 Create quiz with transaction safety
    const quiz = new QuizSession({
      school,
      teacher: teacherUserId,
      class: classId,
      subject: chosenSubjectDoc._id,
      subjectName: chosenSubjectDoc.name,
      title: title || `${chosenSubjectDoc.name} Quiz`,
      description: description || "",
      notesText: notesText || "",
      questions,
      dueDate: dueDate || null,
      timeLimit: timeLimit || null,
      startTime: startTime || null,
      shuffleQuestions: !!shuffleQuestions,
      shuffleOptions: !!shuffleOptions,
      isPublished: false,
    });

    await quiz.save({ session });

    await session.commitTransaction();

    // 🎯 Invalidate relevant caches in background
    processInBackground(() => {
      cache.del(CACHE_KEYS.QUIZ_CLASS(classId, 'teacher', teacherUserId));
      cache.del(CACHE_KEYS.QUIZ_SCHOOL(school.toString()));
    });

    res.status(201).json({
      message: "Quiz created successfully",
      quiz,
    });

  } catch (error) {
    await session.abortTransaction();
    console.error("🔥 Quiz creation failed:", error);
    res.status(500).json({ message: "Error creating quiz", error: error.message });
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
      return res.status(403).json({ message: 'You can only publish quizzes you created' });
    }

    quiz.isPublished = publish;

    if (publish) {
      quiz.publishedAt = new Date();
      
      // ===============================
      // 📌 CREATE IN-APP NOTIFICATION
      // ===============================
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
          console.error('Notification creation failed:', notifError);
        }
      });

      // ===============================
      // 🔔 SEND PUSH NOTIFICATIONS
      // ===============================
      processInBackground(async () => {
        try {
          // Get all students in the class
          const students = await Student.find({
            class: quiz.class,
            school: req.user.school
          }).select("user parent parentIds").lean();

          let recipients = [];

          students.forEach(s => {
            if (s.user) recipients.push(String(s.user));          // student userId
            if (s.parent) recipients.push(String(s.parent));      // parent (single)
            if (Array.isArray(s.parentIds)) {
              recipients.push(...s.parentIds.map(id => String(id))); // multiple parents
            }
          });

          recipients = [...new Set(recipients)]; // remove duplicates

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

    } else {
      quiz.publishedAt = null;
    }

    await quiz.save({ session });
    await session.commitTransaction();

    // ===============================
    // 🧹 CACHE INVALIDATION
    // ===============================
    processInBackground(() => {
      cache.del(CACHE_KEYS.QUIZ_CLASS(quiz.class.toString(), 'teacher', req.user._id));
      cache.delPattern(CACHE_KEYS.QUIZ_CLASS(quiz.class.toString(), 'student', ''));
      cache.del(CACHE_KEYS.QUIZ_SINGLE(quizId, 'teacher'));
      cache.del(CACHE_KEYS.QUIZ_SINGLE(quizId, 'student'));
    });

    res.json({ 
      message: `Quiz ${publish ? 'published' : 'unpublished'} successfully`,
      quiz 
    });

  } catch (error) {
    await session.abortTransaction();
    console.error('Quiz publish/unpublish failed:', error);
    res.status(500).json({ message: 'Error updating quiz status', error: error.message });
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

    // Fetch quiz with timeout
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

    // 🟢 STUDENT VIEW (with proper shuffling)
    if (req.user.role === 'student') {
      // Create a seed based on user ID and quiz ID for consistent shuffling per student
      const seed = `${userId}-${quizId}`;
      
      let quizQuestions = [...(quiz.questions || [])];

      // 🔀 Shuffle questions if enabled
      if (quiz.shuffleQuestions) {
        console.log(`🔄 Shuffling questions for student ${userId}`);
        quizQuestions = seededShuffle(quizQuestions, seed + '-questions');
      }

      // Process questions for student view
      const questionsWithoutAnswers = quizQuestions.map((q, index) => {
        if (!q) return null;
        
        let question = {
          _id: q._id || `temp-${index}`,
          questionText: q.questionText || 'No question text',
          type: q.type || 'multiple-choice',
          explanation: q.explanation || '',
          points: q.points || 1,
          options: q.options ? [...q.options] : []
        };

        // 🔀 Shuffle options if enabled
        if (quiz.shuffleOptions && Array.isArray(question.options) && question.options.length > 0) {
          console.log(`🔄 Shuffling options for question ${question._id}`);
          question.options = seededShuffle(question.options, seed + '-options-' + (q._id || index));
        }

        // Hide correct answer for students (except for debugging)
        if (process.env.NODE_ENV !== 'development') {
          delete question.correctAnswer;
        }

        return question;
      }).filter(q => q !== null); // Remove any null questions

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
        totalPoints: quiz.questions ? quiz.questions.reduce((sum, q) => sum + (q.points || 1), 0) : 0
      };

      console.log(`✅ Sending ${questionsWithoutAnswers.length} questions to student`);
      return res.json(response);
    }

    // 🟠 TEACHER VIEW (no shuffling, safe to cache)
    response = quiz;
    cache.set(cacheKey, response, 300); // 5 min cache for teachers

    console.log(`✅ Sending quiz to teacher`);
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

    // Base filter
    const filter = { school, class: toObjectId(classId) };
    if (role === "student") filter.isPublished = true;

    // Fetch quizzes
    const quizzes = await executeWithTimeout(
      QuizSession.find(filter)
        .populate({ path: "subject", select: "name shortName" })
        .select(role === "student" ? "-questions.correctAnswer" : "")
        .sort({ createdAt: -1 })
        .lean(),
      5000
    );

    if (!quizzes.length) {
      cache.set(cacheKey, [], 60);
      return res.json([]);
    }

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

      // Indexing for fast lookup
      const notifMap = Object.fromEntries(
        notifications.map(n => [n.quizId?.toString(), n])
      );

      const completedMap = new Set(completedResults.map(r => r.quizId.toString()));
      const inProgressMap = new Set(activeAttempts.map(a => a.quizId.toString()));

      const quizzesWithProgress = quizzes.map(q => {
        const id = q._id.toString();
        const completed = completedMap.has(id);
        const inProgress = !completed && inProgressMap.has(id);
        
        // 🔴 ADD: Normalize class name
        const { className, classDisplayName } = resolveQuizClassNames(q.class);

        return {
          ...q,
          subject: q.subject?.name ?? "Unknown Subject",
          className,                // 🔴 ADD: normalized className
          classDisplayName,         // 🔴 ADD: UI-ready display name
          completed,
          inProgress,
          status: completed ? "Completed" : inProgress ? "In Progress" : "Available",
          notification: notifMap[id] || null
        };
      });

      // Mark notifications read (background)
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
    // 🟠 TEACHER VIEW (Aggregation)
    // ============================

    const [resultsAgg, attemptsAgg] = await Promise.all([
      executeWithTimeout(
        QuizResult.aggregate(
          [
            { $match: { quizId: { $in: quizIds }, school } },
            {
              $group: {
                _id: "$quizId",
                submissionCount: { $sum: 1 },
                averageScore: { $avg: "$score" }
              }
            }
          ],
          { maxTimeMS: 5000 }
        ),
        5000
      ),

      executeWithTimeout(
        QuizAttempt.aggregate(
          [
            {
              $match: {
                quizId: { $in: quizIds },
                school,
                status: "in-progress",
                expiresAt: { $gt: new Date() }
              }
            },
            { $group: { _id: "$quizId", inProgressCount: { $sum: 1 } } }
          ],
          { maxTimeMS: 5000 }
        ),
        5000
      )
    ]);

    // Convert aggregations to maps
    const resultsMap = new Map(
      resultsAgg.map(r => [
        r._id.toString(),
        {
          submissionCount: r.submissionCount,
          averageScore: r.averageScore
        }
      ])
    );

    const attemptsMap = new Map(
      attemptsAgg.map(a => [a._id.toString(), a.inProgressCount])
    );

    // Merge into quizzes
    const quizzesWithStats = quizzes.map(q => {
      const id = q._id.toString();
      const stats = resultsMap.get(id) || {
        submissionCount: 0,
        averageScore: null
      };

      // 🔴 ADD: Normalize class name
      const { className, classDisplayName } = resolveQuizClassNames(q.class);

      return {
        ...q,
        subject: q.subject?.name ?? "Unknown Subject",
        className,                // 🔴 ADD: normalized className
        classDisplayName,         // 🔴 ADD: UI-ready display name
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

    // ✅ Populate subject to retrieve subject name
    const quizzes = await QuizSession.find({ school: toObjectId(schoolId) })
      .populate('teacher', 'name email')
      .populate('class', 'name')
      .populate({ path: 'subject', select: 'name shortName' })
      .sort({ createdAt: -1 });

    if (!quizzes || quizzes.length === 0) {
      return res.status(404).json({ message: 'No quizzes found for this school' });
    }

    // ✅ Format quizzes to always include readable subject name
    const formattedQuizzes = quizzes.map(q => {
      // 🔴 ADD: Normalize class name
      const { className, classDisplayName } = resolveQuizClassNames(q.class);

      return {
        _id: q._id,
        title: q.title,
        className,                // 🔴 ADD: normalized className (replaces q.class?.name)
        classDisplayName,         // 🔴 ADD: UI-ready display name
        teacher: q.teacher?.name || 'Unknown Teacher',
        subject: resolveSubjectName(q),
        totalPoints: q.totalPoints || 0,
        createdAt: q.createdAt,
        dueDate: q.dueDate,
        isPublished: q.isPublished,
      };
    });

    res.json({ quizzes: formattedQuizzes });
  } catch (error) {
    console.error('❌ Error fetching school quizzes:', error);
    res.status(500).json({ message: 'Error fetching school quizzes', error: error.message });
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
        QuizSession.findOne({ _id: toObjectId(quizId), school }).maxTimeMS(5000)
      ),
      executeWithTimeout(
        User.findOne({ _id: toObjectId(userId), school }).maxTimeMS(5000)
      )
    ]);
    
    if (!quiz) {
      return res.status(404).json({ message: 'Quiz not found in your school' });
    }

    if (req.user.role === 'student') {      
      if (!student || student.class.toString() !== quiz.class.toString()) {
        return res.status(403).json({ message: 'You are not allowed to access this quiz' });
      }
      
      if (quiz.startTime && new Date() < quiz.startTime) {
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
        await QuizSession.create({
          sessionId,
          quizId: toObjectId(quizId),
          studentId: req.user.role === 'student' ? toObjectId(userId) : null,
          expiresAt,
          startTime: new Date()
        });
      } catch (sessionError) {
        console.error('Session creation failed:', sessionError);
      }
    });

    let questions = quiz.questions;
    if (quiz.shuffleQuestions) {
      questions = [...questions].sort(() => Math.random() - 0.5);
    }

    const protectedQuestions = questions.map((q, index) => {
      const questionId = `q${index}_${sessionId}`;
      
      let options = [];
      if (q.options && q.options.length > 0) {
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
        questionText: obfuscateText(q.questionText),
        type: q.type,
        options: options,
        points: q.points || 1
      };
    });

    res.json({
      sessionId,
      quizTitle: quiz.title,
      timeLimit: quiz.timeLimit,
      questions: protectedQuestions,
      expiresAt,
      startTime: new Date()
    });
  } catch (error) {
    console.error('Error getting protected quiz:', error);
    res.status(500).json({ message: 'Error loading quiz', error: error.message });
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

    const formatted = results.map((r) => ({
      student: r.studentId?.name || 'Unknown',
      score: r.score,
      totalPoints: r.totalPoints,
      percentage: r.percentage,
      submittedAt: r.submittedAt,
      timeSpent: r.timeSpent,
      attemptNumber: r.attemptNumber,
      results: r.results,
    }));

    cache.set(cacheKey, formatted, 180); // 3 min cache
    res.json(formatted);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching results', error: error.message });
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
// 12. Update QuizSession - OPTIMIZED
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

    const { title, questions, dueDate, timeLimit, startTime, shuffleQuestions, shuffleOptions } = req.body;
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

    if (questions) {
      if (!Array.isArray(questions) || questions.length === 0) {
        await session.abortTransaction();
        return res.status(400).json({ message: 'Questions must be a non-empty array' });
      }

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (!q.questionText || !q.type) {
          await session.abortTransaction();
          return res.status(400).json({ 
            message: `Question ${i+1} is missing required fields (questionText or type)` 
          });
        }
        
        if (q.type === 'multiple-choice') {
          if (!q.options || !q.correctAnswer) {
            await session.abortTransaction();
            return res.status(400).json({ 
              message: `Question ${i+1}: Multiple-choice questions require options and correctAnswer` 
            });
          }
          
          if (!q.options.includes(q.correctAnswer)) {
            await session.abortTransaction();
            return res.status(400).json({ 
              message: `Question ${i+1}: correctAnswer must be one of the provided options` 
            });
          }
        } else if (q.type === 'true-false') {
          if (typeof q.correctAnswer !== 'boolean') {
            await session.abortTransaction();
            return res.status(400).json({ 
              message: `Question ${i+1}: True-false questions require a boolean correctAnswer` 
            });
          }
        }
      }
    }

    if (title !== undefined) quiz.title = title;
    if (questions !== undefined) quiz.questions = questions;
    if (dueDate !== undefined) quiz.dueDate = dueDate;
    if (timeLimit !== undefined) quiz.timeLimit = timeLimit;
    if (startTime !== undefined) quiz.startTime = startTime;
    if (shuffleQuestions !== undefined) quiz.shuffleQuestions = shuffleQuestions;
    if (shuffleOptions !== undefined) quiz.shuffleOptions = shuffleOptions;

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
    res.status(500).json({ message: 'Error updating quiz', error: error.message });
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
    const { answers = [], startTime, timeSpent = 0, autoSubmit = false } = req.body;
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

    // ---------------------------------------
    // 🔍 CHECK IF RESULT ALREADY EXISTS
    // ---------------------------------------
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

    // ---------------------------------------
    // 🔥 ENSURE FULL ANSWER ARRAY
    // ---------------------------------------
    let normalizedAnswers = [];

    if (Array.isArray(answers) && answers.length > 0) {
      normalizedAnswers = answers.map((a) => ({
        questionId: a.questionId,
        selectedAnswer: a.selectedAnswer ?? null,
        timeSpent: a.timeSpent ?? 0,
      }));
    } else {
      normalizedAnswers = quiz.questions.map((q) => ({
        questionId: q._id.toString(),
        selectedAnswer: null,
        timeSpent: 0,
      }));
    }

    // ---------------------------------------
    // 🔍 LOAD ACTIVE ATTEMPT (CRITICAL)
    // ---------------------------------------
    let activeAttempt = await QuizAttempt.findOne({
      quizId,
      studentId, // ✅ Student._id ONLY
      school,
      status: "in-progress",
    });

    // Safety fallback (should rarely happen)
    if (!activeAttempt) {
      const timeLimitMinutes = quiz.timeLimit ?? 60;
      const timeLimitSeconds = timeLimitMinutes * 60;

      activeAttempt = {
        sessionId: new mongoose.Types.ObjectId().toString(),
        attemptNumber: 1,
        startTime: startTime ? new Date(startTime) : now,
        expiresAt: new Date(now.getTime() + timeLimitSeconds * 1000),
      };
    }

    // ---------------------------------------
    // 🎯 Process Answers
    // ---------------------------------------
    let score = 0;
    let totalAutoGradedPoints = 0;
    let requiresManualReview = false;

    const results = quiz.questions.map((q) => {
      const type = (q.type || "").toLowerCase().replace(/\s+/g, "-");
      const studentAnswer = normalizedAnswers.find(
        (a) => a.questionId == q._id.toString()
      );

      const item = {
        questionId: q._id,
        questionText: q.questionText,
        questionType: q.type,
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
        return item;
      }

      totalAutoGradedPoints += item.points;

      const selected = studentAnswer?.selectedAnswer;
      if (selected !== null && selected !== undefined) {
        let correct = false;

        if (type === "true-false") {
          correct =
            String(q.correctAnswer).toLowerCase() ===
            String(selected).toLowerCase();
        } else {
          correct = selected === q.correctAnswer;
        }

        item.isCorrect = correct;
        item.earnedPoints = correct ? item.points : 0;
        if (correct) score += item.points;
      } else {
        item.isCorrect = false;
        item.earnedPoints = 0;
      }

      return item;
    });

    let percentage = null;
    if (!requiresManualReview && totalAutoGradedPoints > 0) {
      percentage = Number(
        ((score / totalAutoGradedPoints) * 100).toFixed(2)
      );
    }

    // ---------------------------------------
    // ✅ SAVE RESULT
    // ---------------------------------------
    const quizResultDoc = await QuizResult.findOneAndUpdate(
      { school, quizId, studentId },
      {
        school,
        quizId,
        sessionId: activeAttempt.sessionId,
        studentId,
        answers: results,
        score: requiresManualReview ? null : score,
        totalPoints: quiz.questions.reduce(
          (s, q) => s + (q.points || 1),
          0
        ),
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

    if (activeAttempt && activeAttempt._id) {
      activeAttempt.status = "submitted";
      activeAttempt.completedAt = now;
      await activeAttempt.save();
    }

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

    // 🎯 Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    console.log("📘 getResultsForStudent called:", {
      routeStudentId: studentId,
      role: user?.role,
      childId,
      quizId,
      subject,
    });

    let results = [];
    let targetStudentIds = [];

    // 🎯 Student Flow
    if (user.role === "student") {
      const studentDoc = await executeWithTimeout(
        Student.findOne({
          user: user._id,
          school: user.school
        })
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
            select: "title subject subjectName totalPoints"
          })
          .sort({ submittedAt: -1 })
          .lean()
          .maxTimeMS(8000)
      );

      // 🎯 Batch process student info resolution
      const studentInfoMap = new Map();
      for (const r of results) {
        if (!studentInfoMap.has(r.studentId.toString())) {
          studentInfoMap.set(
            r.studentId.toString(), 
            await resolveStudentInfo(r.studentId, user.school)
          );
        }
        const info = studentInfoMap.get(r.studentId.toString());
        r.childName = info.name;
        r.className = info.className;
        // 🔴 ADD: Get class display name
        const classObj = { name: info.className }; // Simplified, adjust if you have stream data
        const { classDisplayName } = resolveQuizClassNames(classObj);
        r.classDisplayName = classDisplayName || info.className;

        r.answers = Array.isArray(r.answers) ? r.answers : [];
        const pendingEssay = r.answers.some(
          a =>
            ["essay", "short-answer"].includes((a.questionType || "").toLowerCase()) &&
            (a.earnedPoints === null || a.earnedPoints === undefined)
        );

        r.status = pendingEssay ? "needs-review" : "graded";
        r.autoGraded = !pendingEssay;
      }
    }
    // 🎯 Parent Flow
    else if (user.role === "parent") {
      const childFilter = {
        school: user.school,
        $or: [{ parent: user._id }, { parentIds: { $in: [user._id] } }]
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
      const allIds = [];
      for (const c of children) {
        allIds.push(c._id);
        if (c.user?._id) allIds.push(c.user._id);
      }

      const query = { studentId: { $in: allIds }, school: user.school };
      if (quizId) query.quizId = quizId;

      results = await executeWithTimeout(
        QuizResult.find(query)
          .populate({
            path: "quizId",
            select: "title subject subjectName totalPoints"
          })
          .sort({ submittedAt: -1 })
          .lean()
          .maxTimeMS(8000)
      );

      // 🎯 Use Map for efficient child lookup
      const childMap = new Map();
      children.forEach(c => {
        childMap.set(c._id.toString(), c);
        if (c.user?._id) childMap.set(c.user._id.toString(), c);
      });

      for (const r of results) {
        const child = childMap.get(r.studentId.toString());
        if (child) {
          r.childName = child.user?.name || "Unknown Child";
          r.className = child.class?.name || "Unknown Class";
          // 🔴 ADD: Get class display name
          const { classDisplayName } = resolveQuizClassNames(child.class);
          r.classDisplayName = classDisplayName || r.className;
        } else {
          const info = await resolveStudentInfo(r.studentId, user.school);
          r.childName = info.name;
          r.className = info.className;
          // 🔴 ADD: Get class display name
          const classObj = { name: info.className };
          const { classDisplayName } = resolveQuizClassNames(classObj);
          r.classDisplayName = classDisplayName || info.className;
        }

        r.answers = Array.isArray(r.answers) ? r.answers : [];
        const pendingEssay = r.answers.some(
          a =>
            ["essay", "short-answer"].includes((a.questionType || "").toLowerCase()) &&
            (a.earnedPoints === null || a.earnedPoints === undefined)
        );

        r.status = pendingEssay ? "needs-review" : "graded";
        r.autoGraded = !pendingEssay;
      }
    } else {
      return res.status(403).json({
        message: "Access denied. Only students or parents allowed."
      });
    }

    if (!results.length) {
      const emptyResponse = {
        success: true,
        message: "No quiz results found",
        data: []
      };
      cache.set(cacheKey, emptyResponse, 60); // Cache empty for 1 min
      return res.json(emptyResponse);
    }

    // 🎯 Fetch notifications in background
    processInBackground(async () => {
      try {
        const notifications = await Notification.find({
          school: user.school,
          type: "quiz-result",
          studentId: { $in: targetStudentIds },
          $or: [{ recipientRoles: user.role }, { recipientUsers: user._id }]
        })
          .select("quizId message isRead createdAt studentId")
          .lean();

        const notifMap = {};
        notifications.forEach(n => {
          notifMap[`${n.studentId}_${n.quizId}`] = n;
        });

        results.forEach(r => {
          r.notification = notifMap[`${r.studentId}_${r.quizId?._id}`] || null;
        });

        await Notification.updateMany(
          {
            type: "quiz-result",
            studentId: { $in: targetStudentIds },
            isRead: false,
            $or: [{ recipientUsers: user._id }]
          },
          { $set: { isRead: true } }
        );
      } catch (notifError) {
        console.error('Notification processing failed:', notifError);
      }
    });

    const response = {
      success: true,
      count: results.length,
      data: results
    };

    cache.set(cacheKey, response, 180); // 3 min cache
    return res.json(response);

  } catch (err) {
    console.error("❌ Error in getResultsForStudent:", err);
    res.status(500).json({ message: "Error fetching results", error: err.message });
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

    // Fetch result and populate quiz + student
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

    // ✅ Ensure all answers contain required fields (feedback, earnedPoints, etc.)
    result.answers = (result.answers || []).map((answer) => ({
      ...answer,
      earnedPoints:
        typeof answer.earnedPoints === "number"
          ? answer.earnedPoints
          : null,
      feedback:
        typeof answer.feedback === "string"
          ? answer.feedback
          : "",
      manualReviewRequired:
        typeof answer.manualReviewRequired === "boolean"
          ? answer.manualReviewRequired
          : false,
      questionType: answer.questionType || "unknown",
      points: typeof answer.points === "number" ? answer.points : 0,
      isCorrect:
        typeof answer.isCorrect === "boolean" ? answer.isCorrect : null,
    }));

    // ✅ Recalculate total and percentage if missing or outdated
    const totalEarned = result.answers.reduce(
      (sum, a) => sum + (a.earnedPoints || 0),
      0
    );
    const totalPoints =
      result.totalPoints && result.totalPoints > 0
        ? result.totalPoints
        : result.answers.reduce((sum, a) => sum + (a.points || 0), 0);

    const percentage =
      totalPoints > 0
        ? parseFloat(((totalEarned / totalPoints) * 100).toFixed(2))
        : 0;

    result.score = totalEarned;
    result.totalPoints = totalPoints;
    result.percentage = percentage;

    cache.set(cacheKey, result, 300); // 5 min cache
    res.status(200).json(result);
  } catch (err) {
    console.error("❌ Error fetching result:", err);
    res.status(500).json({
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

    // 🎯 Check cache
    const cached = cache.get(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    // 🎯 Parallel teacher and classes lookup
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

    // 🎯 Collect class IDs efficiently
    let classIds = new Set();
    
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

    // 🎯 Fetch quizzes with optimized query
    const quizzes = await executeWithTimeout(
      QuizSession.find({
        class: { $in: classIdsArray },
        school,
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

    const quizIds = quizzes.map((q) => q._id.toString());

    // 🎯 Parallel data fetching
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

    // 🎯 Batch student info resolution
    const studentInfoPromises = results.map(result => 
      resolveStudentInfo(result.studentId, school)
    );
    const studentInfos = await Promise.all(studentInfoPromises);
    const studentInfoMap = new Map();
    results.forEach((result, index) => {
      studentInfoMap.set(result.studentId.toString(), studentInfos[index]);
    });

    // 🎯 Efficient grouping
    const groupedByClass = {};

    for (const result of results) {
      const quiz = result.quizId;
      if (!quiz || !quiz.class) continue;

      const classId = quiz.class.toString();
      const qId = quiz._id.toString();

      if (!groupedByClass[classId]) {
        const classDoc = teacherClasses.find((c) => c._id.toString() === classId);
        // 🔴 ADD: Normalize class name
        const { className, classDisplayName } = resolveQuizClassNames(classDoc);

        groupedByClass[classId] = {
          classId,
          className,                // 🔴 ADD: normalized className
          classDisplayName,         // 🔴 ADD: UI-ready display name
          quizzes: {},
        };
      }

      if (!groupedByClass[classId].quizzes[qId]) {
        groupedByClass[classId].quizzes[qId] = {
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

      groupedByClass[classId].quizzes[qId].results.push({
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
        answers: result.answers || [],
      });
    }

    const response = {
      success: true,
      results: Object.values(groupedByClass).map((cls) => ({
        classId: cls.classId,
        className: cls.className,
        classDisplayName: cls.classDisplayName,
        quizzes: Object.values(cls.quizzes),
      }))
    };

    cache.set(cacheKey, response, 300); // 5 min cache for teacher results
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

    // 🔐 Resolve canonical Student ID
    const studentId = await resolveStudentId(req);

    const cacheKey = `quiz:inprogress:${quizId}:${studentId}`;

    // 🎯 Check cache
    const cached = cache.get(cacheKey);
    if (cached !== undefined) {
      return res.json(cached);
    }

    // 🔍 Find active (non-expired) attempt
    const activeAttempt = await executeWithTimeout(
      QuizAttempt.findOne({
        quizId: toObjectId(quizId),
        studentId, // ✅ Student._id ONLY
        school,
        status: "in-progress",
        expiresAt: { $gt: new Date() },
      })
        .lean()
        .maxTimeMS(5000)
    );

    const response = { inProgress: !!activeAttempt };

    // Cache result briefly (safe now that key is Student._id)
    cache.set(cacheKey, response, 60);

    return res.json(response);
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
const resolveStudentId = require("../utils/resolveStudentId");

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
    // 🔄 Resume existing attempt
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

    const response = {
      sessionId: activeAttempt.sessionId,
      timeRemaining,
      startTime: activeAttempt.startTime,
      answers: activeAttempt.answers || {},
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

    // Update answers and last activity
    activeAttempt.answers = answers;
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
// PUT /api/quizzes/results/:resultId/grade-question - OPTIMIZED + PUSH ADDED
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
      return res.status(400).json({ message: "earnedPoints must be a valid non-negative number" });
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

    const question =
      quizResult.answers.id(questionId) ||
      quizResult.answers.find((q) => String(q.questionId) === String(questionId));

    if (!question) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Question not found" });
    }

    const qType = (question.questionType || "").toLowerCase();
    const defaultMax = qType === "essay" || qType === "short-answer" ? 5 : 1;

    if (typeof question.points !== "number" || question.points < 0) {
      question.points = defaultMax;
    }

    const maxPoints = Math.max(0, question.points);
    if (numericPoints < 0 || numericPoints > maxPoints) {
      await session.abortTransaction();
      return res.status(400).json({
        message: `For ${qType} questions, earned points must be between 0 and ${maxPoints}.`,
      });
    }

    // Grade update
    question.earnedPoints = numericPoints;
    question.feedback = typeof feedback === "string" ? feedback.trim() : "";
    question.manualReviewRequired = false;

    if (numericPoints === 0) question.isCorrect = false;
    else if (numericPoints === question.points) question.isCorrect = true;
    else question.isCorrect = null;

    question.markModified("earnedPoints");
    question.markModified("feedback");
    question.markModified("manualReviewRequired");
    question.markModified("isCorrect");
    question.markModified("points");

    const totalEarned = quizResult.answers.reduce(
      (sum, q) => sum + (typeof q.earnedPoints === "number" ? q.earnedPoints : 0),
      0
    );

    const totalPossible = quizResult.answers.reduce((sum, q) => {
      const type = (q.questionType || "").toLowerCase();
      if (typeof q.points === "number") {
        return sum + Math.max(0, q.points);
      }
      return sum + (type === "essay" || type === "short-answer" ? 5 : 1);
    }, 0);

    quizResult.totalPoints = totalPossible;
    quizResult.score = totalEarned;
    quizResult.percentage =
      totalPossible > 0 ? parseFloat(((totalEarned / totalPossible) * 100).toFixed(2)) : 0;

    quizResult.status = "graded";
    quizResult.autoGraded = false;

    await quizResult.save({ session, validateBeforeSave: true });
    await session.commitTransaction();

    // 🎯 Cache invalidation
    processInBackground(() => {
      cache.del(`quiz:result:${resultId}`);
      cache.del(CACHE_KEYS.QUIZ_RESULTS(quizResult.quizId.toString()));
      cache.del(CACHE_KEYS.STUDENT_PROGRESS(quizResult.studentId._id.toString()));
      cache.del(CACHE_KEYS.CLASS_RESULTS_TEACHER(quizResult.quizId.teacher?.toString()));
    });

    // --------------------------------------------------------------------
    // 🔔 CREATE IN-APP NOTIFICATION + PUSH NOTIFICATION
    // --------------------------------------------------------------------
    processInBackground(async () => {
      try {
        const quiz = quizResult.quizId;
        const student = quizResult.studentId?.user || null;
        const classObj = quizResult.studentId?.class || null;

        const studentUserId = student?._id;
        const studentName = student?.name || "Your child";
        const quizTitle = quiz?.title || "Quiz";

        // Parents
        const parentUsers = await User.find({
          school: req.user.school,
          $or: [
            { _id: quizResult.studentId.parent },
            { _id: { $in: quizResult.studentId.parentIds || [] } }
          ]
        }).select("_id");

        const parentIds = parentUsers.map(p => p._id);

        // 1️⃣ In-app notification
        await Notification.create({
          title: `Quiz Updated: ${quizTitle}`,
          message: `A question was graded for ${quizTitle}.`,
          type: "quiz-result",
          school: req.user.school,
          quizId: quiz._id,
          sender: req.user._id,
          class: classObj?._id || null,
          audience: "student",
          recipientUsers: [studentUserId, ...parentIds],
          recipientRoles: ["student", "parent"],
        });

        // 2️⃣ PUSH Notification — EXACT logic as Announcements + PublishQuiz
        const receivers = [studentUserId, ...parentIds].map(String);

        await sendPush(
          receivers,
          "Quiz Graded",
          `${quizTitle}: A question has been graded`,
          { quizId: quiz._id, type: "quiz-graded" }
        );

      } catch (notifErr) {
        console.error("⚠️ Notification/PUSH failed:", notifErr.message);
      }
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