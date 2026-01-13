// debug-server.js
import express from 'express';
import util from 'util';
import https from 'https';
import fs from 'fs';

const app = express();
const port = process.env.PORT || 8443; // HTTPS usually uses 443, but 8443 is common for local user-space

// Middleware to parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Catch-all route to log request details
app.all('*', (req, res) => {
  console.log('\n==================================');
  console.log('       --- Incoming Request ---     ');
  console.log('==================================');
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Headers:\n', util.inspect(req.headers, { showHidden: false, depth: null, colors: true }));
  console.log('Body:\n', util.inspect(req.body, { showHidden: false, depth: null, colors: true }));
  console.log('==================================\n');

  // Send a response back to the client
  res.status(200).json({
    message: 'Request received by debug HTTPS server',
    receivedMethod: req.method,
    receivedUrl: req.url,
    receivedHeaders: req.headers,
    receivedBody: req.body,
  });
});

// SSL Options
const options = {
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.cert')
};

// Start the HTTPS server
https.createServer(options, app).listen(port, () => {
  console.log(`Debug HTTPS server listening on port ${port}`);
  console.log(`Configure your Frontapp's server setting to point to: https://localhost:${port}`);
  console.log('Note: Since this uses a self-signed certificate, you may need to tell Frontapp (or your browser/client) to ignore SSL warnings (insecure mode).');
});
