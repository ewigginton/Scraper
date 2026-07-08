'use strict';

require('dotenv').config();

const { sendMail, pingHealthcheck } = require('../lib/notify');

/**
 * Send a one-off test email (and healthcheck ping) to verify delivery.
 * Usage: node scripts/test-email.js   (or via scripts/setup-production.sh)
 */
(async () => {
  const to = process.env.EMAIL_TO;
  if (!to) {
    console.error('EMAIL_TO is not set in .env — nothing to send to.');
    process.exit(1);
  }

  const body = [
    'If you are reading this, email delivery from the CCL land scraper works.',
    '',
    `Sent: ${new Date().toString()}`,
    `Via: ${process.env.SMTP_HOST ? `SMTP (${process.env.SMTP_HOST})` : 'local mail command (SMTP not configured — delivery not guaranteed)'}`,
    `Healthcheck monitoring: ${process.env.HEALTHCHECK_URL ? 'configured' : 'NOT configured'}`,
  ].join('\n');

  const ok = await sendMail(to, 'CCL Scraper — test email', body);
  await pingHealthcheck(ok);

  if (ok) {
    console.log(`Test email sent to ${to} — check the inbox (and spam folder).`);
    process.exit(0);
  } else {
    console.error('Test email FAILED — check the SMTP_* values in .env.');
    process.exit(1);
  }
})();
