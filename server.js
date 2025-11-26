const express = require('express');
const mongoose = require('mongoose');
const dotenv = require('dotenv');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// Load environment variables
dotenv.config();

const app = express();
const server = http.createServer(app);

// ✅ Setup Socket.IO
const io = new Server(server, {
  cors: {
    origin: '*',   // allow all origins during development
    methods: ['GET', 'POST']
  }
});


// Store connected clients
const connectedUsers = new Map();

// Handle Socket.IO connections
io.on('connection', (socket) => {
  console.log('🔌 A user connected:', socket.id);

  // Listen for user ID binding
  socket.on('register', (userId) => {
    connectedUsers.set(userId, socket.id);
    console.log(`✅ User ${userId} registered with socket ${socket.id}`);
  });

  socket.on('disconnect', () => {
    for (let [userId, socketId] of connectedUsers.entries()) {
      if (socketId === socket.id) {
        connectedUsers.delete(userId);
        console.log(`❌ User ${userId} disconnected`);
        break;
      }
    }
  });
});

// Attach io and connectedUsers globally (accessible in controllers)
app.set('io', io);
app.set('connectedUsers', connectedUsers);

// ✅ Enable CORS for all mobile and web clients
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));




// Parse JSON requests
app.use(express.json());

// MongoDB connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB connected'))
  .catch((err) => console.error('❌ DB connection error:', err));

  // In your server.js or app.js after mongoose connects

const { GridFSBucket } = require('mongodb');

mongoose.connection.once('open', () => {
  const db = mongoose.connection.db;
  const bucket = new GridFSBucket(db, { bucketName: 'uploads' });
  app.set('bucket', bucket);
});


// Import routes
const authRoutes = require('./routes/authRoutes');
const studentRoutes = require('./routes/studentRoutes');
const parentRoutes = require('./routes/parentRoutes');
const studentAttendanceRoutes = require('./routes/studentAttendanceRoutes');
const gradeRoutes = require('./routes/gradeRoutes');
const timetableRoutes = require('./routes/timetableRoutes');
const announcementRoutes = require('./routes/announcementRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const teacherRoutes = require('./routes/teacherRoutes');
const classRoutes = require('./routes/classRoutes');
const adminStudentViewRoutes = require('./routes/adminStudentViewRoutes');
const assignmentRoutes = require('./routes/assignmentRoutes');
const submissionRoutes = require('./routes/submissionRoutes');
const enrollmentRoutes = require('./routes/enrollmentRoutes');
const weeklyExerciseRoutes = require('./routes/weeklyExerciseRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const migrateRoutes = require('./routes/migrateRoutes')
const teacherAttendanceRoutes = require('./routes/teacherAttendanceRoutes');
const adminAttendanceRoutes = require('./routes/teacherAttendanceRoutes');
const termRoutes = require('./routes/termRoutes');
const agendaRoutes = require('./routes/agendaRoutes');
const feedingFeeRoutes = require('./routes/feedingFeeRoutes');
const allRoutes = require('./routes/allRoutes');
const schoolInfoRoutes = require('./routes/schoolInfoRoutes');
const quizRoutes = require('./routes/quizRoutes');
const path = require('path');
const profileRoutes = require('./routes/profileRoutes');
const movementRoutes = require('./routes/movementRoutes');
const schoolRoutes = require('./routes/schoolRoutes');
const deviceBindingRoutes = require('./routes/deviceBindingRoutes');
const sbaRoutes = require('./routes/sbaRoutes');
const subjectRoutes = require("./routes/subjectRoutes");

// Define API routes
app.use('/api/auth', authRoutes);
app.use('/api/students', studentRoutes);
app.use('/api/parents', parentRoutes);
app.use('/api/attendance', studentAttendanceRoutes);
app.use('/api/grades', gradeRoutes);
app.use('/api/timetable', timetableRoutes);
app.use('/api/announcements', announcementRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/teachers', teacherRoutes);
app.use('/api/classes', classRoutes);
app.use('/api/admin', adminStudentViewRoutes);
app.use('/api/assignments', assignmentRoutes);
app.use('/api/submissions', submissionRoutes);
app.use('/api/enrollments', enrollmentRoutes);
app.use('/api/exercises', weeklyExerciseRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/migrate', migrateRoutes);
app.use('/api/attendance/teacher', teacherAttendanceRoutes);
app.use('/api/attendance/admin', adminAttendanceRoutes);
app.use('/api/term', termRoutes);
app.use('/api/attendance', studentAttendanceRoutes);
app.use('/api/agenda', agendaRoutes);
app.use('/api/feeding-fees', feedingFeeRoutes);
app.use('/api/fees', allRoutes);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/school-info', schoolInfoRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/movements', movementRoutes);
app.use('/api/school', schoolRoutes);
app.use('/api/device-binding', deviceBindingRoutes);
app.use('/api/sba', sbaRoutes);
app.use("/api/subjects", subjectRoutes);








// Default root route
app.get('/', (req, res) => res.send('🎓 School Management API Running with Realtime Notifications'));

// Start server with Socket.IO support
const PORT = process.env.PORT || 5001;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
