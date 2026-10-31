
import 'dotenv/config';
import twilio from 'twilio';

const requiredVariables = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_WHATSAPP_FROM',
  'TWILIO_WHATSAPP_TO',
  'TWILIO_WHATSAPP_CONTENT_SID',
];

for (const key of requiredVariables) {
  if (!process.env[key]?.trim()) {
    throw new Error(`Missing environment variable: ${key}`);
  }
}

const from = process.env.TWILIO_WHATSAPP_FROM.trim();
const to = process.env.TWILIO_WHATSAPP_TO.trim();
const contentSid = process.env.TWILIO_WHATSAPP_CONTENT_SID.trim();

if (!/^whatsapp:\+[1-9]\d{6,14}$/.test(from)) {
  throw new Error('Invalid TWILIO_WHATSAPP_FROM format.');
}

if (!/^\+[1-9]\d{6,14}$/.test(to)) {
  throw new Error('TWILIO_WHATSAPP_TO must be in E.164 format.');
}

if (!/^HX[0-9a-fA-F]{32}$/.test(contentSid)) {
  throw new Error('TWILIO_WHATSAPP_CONTENT_SID is not a valid-looking SID.');
}

const client = twilio(
  process.env.TWILIO_ACCOUNT_SID.trim(),
  process.env.TWILIO_AUTH_TOKEN.trim()
);

try {
  const message = await client.messages.create({
    from,
    to: `whatsapp:${to}`,
    contentSid,
  });

  console.log('Message submitted to Twilio.');
  console.log('Message SID:', message.sid);
  console.log('Initial status:', message.status);
} catch (error) {
  console.error('Twilio error:', error.message);
  if (error.code) console.error('Error code:', error.code);
  process.exitCode = 1;
}
