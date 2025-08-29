// Minimal boot-only server to get the app running cleanly.
// (No IMAP/auth here yet; we’ll add it after the app stays up.)

const path = require('path');
const express = require('express');

const app = express();

// Trust proxy for Heroku
app.set('trust proxy', 1);

// --- Static assets ---
app.use('/public', express.static(path.join(__dirname, 'public')));

// Root-level assets (logo & favicon)
app.get('/logo.jpg', (req, res) => res.sendFile(path.join(__dirname, 'logo.jpg')));
app.get('/favicon.ico', (req, res) => res.sendFile(path.join(__dirname, 'favicon.ico')));

// --- Pages ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/dashboard', (req, res) => {
  // temporary: not protected; just to verify rendering.
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'privacy.html'));
});

// --- Health + HEAD helpers ---
app.get('/healthz', (req, res) => res.type('text').send('ok'));
app.head('/', (req, res) => res.status(200).end());
app.head('/dashboard', (req, res) => res.status(200).end());

// --- 404 fallback ---
app.use((req, res) => res.status(404).type('text').send('Not found'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Staff portal running on ${PORT}`));
