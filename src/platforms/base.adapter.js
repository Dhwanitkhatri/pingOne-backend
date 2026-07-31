// ============================================================
// Every platform adapter implements this interface. The worker only
// ever talks to this shape — it never knows it's Telegram vs Gmail
// vs WhatsApp vs Twilio under the hood.
// ============================================================

export class BaseAdapter {
  /** Platform code this adapter handles, e.g. 'telegram'. Override. */
  static code = 'base';

  /**
   * Validate that a decrypted credential has everything needed to send.
   * Throw an AppError (or return false) if invalid. Called once when a
   * user connects the platform, and defensively before every send.
   * @param {{ secret: string, extraInfo: object }} credential
   * @returns {Promise<boolean>}
   */
  async validate(_credential) {
    throw new Error(`${this.constructor.name}.validate() not implemented`);
  }

  /**
   * Convert a raw message body into whatever shape this platform needs
   * (plain text, HTML, SMS-safe truncated text, etc).
   *
   * @param {string} content
   * @param {Attachment[]} attachments
   * @returns {{ formatted: string|object, attachments: Attachment[], hasAttachments: boolean }}
   */
  formatMessage(_content, _attachments = []) {
    throw new Error(`${this.constructor.name}.formatMessage() not implemented`);
  }

  /**
   * Actually send the message, attachments included.
   *
   * Each platform carries files differently — Gmail inlines them as MIME parts,
   * Telegram posts multipart to sendDocument, WhatsApp uploads to /media first
   * and references the returned id, Twilio takes a public URL — so every
   * adapter handles `message.attachments` itself rather than the worker trying
   * to generalise it.
   *
   * @param {{ secret: string, extraInfo: object }} credential  decrypted
   * @param {{ handle: string }} recipient  platform-specific address (chat id, email, phone, ...)
   * @param {{ formatted: string|object, attachments: Attachment[] }} message  output of formatMessage()
   * @returns {Promise<{ platformMessageId: string, raw?: object }>}
   */
  async send(_credential, _recipient, _message) {
    throw new Error(`${this.constructor.name}.send() not implemented`);
  }
}

/**
 * What the worker hands an adapter for each file, built by
 * messages/attachments.service.loadAttachmentsForSend().
 *
 * @typedef {object} Attachment
 * @property {string} fileName       original name, for display/Content-Disposition
 * @property {string} fileUrl        publicly fetchable URL (Twilio MMS needs this)
 * @property {string} mimeType       e.g. "application/pdf"
 * @property {string} typeCode       seeded file_types code: image|video|audio|pdf|document
 * @property {Buffer} buffer         raw bytes, for platforms that upload directly
 * @property {number} fileSizeBytes
 */
