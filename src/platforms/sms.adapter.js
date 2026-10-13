// ============================================================
// SMS adapter — Twilio REST API directly (Basic Auth), no `twilio`
// SDK dependency needed. Trial accounts require a verified recipient and a
// predefined trial-template key as Body (the composer provides those keys).
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

  formatMessage(content, attachments = []) {
    // SMS has no rich formatting and a length limit; keep it simple and
    // let Twilio handle multi-segment splitting for anything longer.
    return {
      formatted: content.slice(0, 1600),
      hasAttachments: attachments.length > 0,
      attachments,
    };
  }

  async send({ secret: authToken, extraInfo }, recipient, message) {
    const accountSid = extraInfo?.account_sid;
    const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');

    const params = new URLSearchParams({
      From: extraInfo?.twilio_number,
      To: recipient.handle, // E.164 phone number
      Body: message.formatted,
    });

    // Twilio is the one platform that won't take the bytes — MMS media is
    // fetched by Twilio over the public internet from the URL we hand it. That
    // means PUBLIC_BASE_URL has to be publicly resolvable (a tunnel or a
    // deployed host) for attachments to arrive; on localhost the text still
    // sends and Twilio simply reports the media as unfetchable.
    //
    // Repeated MediaUrl keys is Twilio's documented way to send several files;
    // it accepts at most 10 per message.
    for (const attachment of (message.attachments ?? []).slice(0, 10)) {
      params.append('MediaUrl', attachment.fileUrl);
    }

    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params,
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
