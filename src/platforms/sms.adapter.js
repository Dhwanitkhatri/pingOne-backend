// ============================================================
// SMS adapter — Twilio REST API directly (Basic Auth), no `twilio`
// SDK dependency needed. Requires a paid/trial Twilio number; trial
// accounts can only send to verified numbers, fine for a demo.
// ============================================================

import { BaseAdapter } from './base.adapter.js';
import { AppError } from '../utils/AppError.js';

export class SmsAdapter extends BaseAdapter {
  static code = 'sms';

  async validate({ secret: authToken, extraInfo }) {
    const accountSid = extraInfo?.account_sid;
    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}.json`, {
      headers: { Authorization: `Basic ${basicAuth}` },
    });
    if (!res.ok) {
      throw AppError.badRequest('Twilio credentials could not be verified', {
        code: 'INVALID_TWILIO_CREDENTIAL',
      });
    }
    return true;
  }

  formatMessage(content) {
    // SMS has no rich formatting and a length limit; keep it simple and
    // let Twilio handle multi-segment splitting for anything longer.
    return { formatted: content.slice(0, 1600) };
  }

  async send({ secret: authToken, extraInfo }, recipient, message) {
    const accountSid = extraInfo?.account_sid;
    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          From: extraInfo?.twilio_number,
          To: recipient.handle, // E.164 phone number
          Body: message.formatted,
        }),
      }
    );
    const data = await res.json();

    if (!res.ok) {
      throw AppError.badRequest(`SMS send failed: ${data.message}`, {
        code: 'SMS_SEND_FAILED',
        details: data,
      });
    }

    return { platformMessageId: data.sid, raw: data };
  }
}
