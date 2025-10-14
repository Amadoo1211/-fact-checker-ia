// Polyfills for Node < 20
try {
  const { Blob, File } = require('buffer');
  const { fetch, FormData, Headers, Request, Response } = require('undici');

  if (!globalThis.fetch) globalThis.fetch = fetch;
  if (!globalThis.Headers) globalThis.Headers = Headers;
  if (!globalThis.Request) globalThis.Request = Request;
  if (!globalThis.Response) globalThis.Response = Response;
  if (!globalThis.FormData) globalThis.FormData = FormData;
  if (!globalThis.Blob) globalThis.Blob = Blob;
  if (!globalThis.File) globalThis.File = File;
} catch (err) {
  console.warn('Polyfill load failed:', err.message);
}

if (typeof ReadableStream === 'undefined') {
  global.ReadableStream = require('stream/web').ReadableStream;
}

const express = require('express');
const cors = require('cors');
const { scheduleDailyReset } = require('./src/utils/resetCounters');
const { resetAllCounters } = require('./src/services/quotaService');
const initDb = require('./src/services/dbInit');

const authRoutes = require('./src/routes/auth');
const verifyRoutes = require('./src/routes/verify');
const verifyOttoRoutes = require('./src/routes/verifyOtto');
const quotaRoutes = require('./src/routes/quota');
const adminRoutes = require('./src/routes/admin');
const stripeRoutes = require('./src/routes/stripe');
const miscRoutes = require('./src/routes/misc');

const app = express();

app.use(cors({ origin: '*', credentials: true }));
app.use('/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '5mb' }));

app.use(authRoutes);
app.use(verifyRoutes);
app.use(verifyOttoRoutes);
app.use(quotaRoutes);
app.use(adminRoutes);
app.use(stripeRoutes);
app.use(miscRoutes);

scheduleDailyReset(resetAllCounters);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initDb();
});
