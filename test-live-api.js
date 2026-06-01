const fetch = require('node-fetch');

async function test() {
  const payload = {
    schoolId: "dummy",
    classId: "dummy",
    termId: "dummy",
    subjectId: "dummy",
    records: [
      {
        student: "dummy_student",
        classWork: 10,
        classTest1: 20,
        classTest2: 20,
        projectWork: 10,
        exams: 0
      }
    ]
  };

  console.log("Sending payload to live server...");
  // We will send a POST request without auth. If the server is running the old code,
  // it might reject it, but let's see. Wait, we need an auth token. 
  // Let me just explain instead of guessing.
}
test();
