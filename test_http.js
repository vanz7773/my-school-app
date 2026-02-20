const http = require('http');

const options = {
  hostname: 'localhost',
  port: 5000,
  path: '/api/dashboard/weekly-attendance',
  method: 'GET',
};

// We don't have the token. Can we read it from frontend? Yes, wait no, token depends on the browser.
// If the backend process is running, we can check its routes or find its logs.
