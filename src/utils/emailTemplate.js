// ============================================================
// One HTML layout for every email PingOne sends as itself — verification,
// password reset, the summary digest and the permanent-failure alert — so
// they all look like the same product.
//
// Email clients are not browsers: Gmail strips <style> in places, Outlook
// renders with Word, and nothing runs scripts. So this is deliberately old-
// fashioned — table layout, inline styles only, web-safe font stacks, no
// images (the wordmark is text, so nothing is blocked behind "show images").
// Colours mirror the app's light theme (pingOne-frontend/src/index.css).
//
// Every value interpolated into the HTML goes through `escapeHtml`; callers
// pass plain strings, never markup.
// ============================================================

const COLOR = Object.freeze({
  page: '#f5f0e8',
  card: '#fffdf8',
  text: '#1a2e22',
  muted: '#6b7a6e',
  primary: '#0d7a4e',
  primarySoft: '#e8f4ee',
  danger: '#c0392b',
  dangerSoft: '#fbeceb',
  border: '#e3ddd1',
});

const FONT = "'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const BRAND_FONT = "Lora, Georgia, 'Times New Roman', serif";

/** Make any value safe to place inside HTML text or an attribute. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── Building blocks — each returns an HTML string for the card body ──── */

export const paragraph = (text, { muted = false, size = 15 } = {}) =>
  `<p style="margin:0 0 16px;font-family:${FONT};font-size:${size}px;line-height:1.6;color:${muted ? COLOR.muted : COLOR.text};">${escapeHtml(text)}</p>`;

/** The big call-to-action, plus the raw link underneath for clients that block buttons. */
export const button = (label, url) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;">
    <tr><td style="border-radius:999px;background:${COLOR.primary};">
      <a href="${escapeHtml(url)}" target="_blank"
         style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:999px;">${escapeHtml(label)}</a>
    </td></tr>
  </table>
  <p style="margin:0 0 20px;font-family:${FONT};font-size:12px;line-height:1.5;color:${COLOR.muted};">
    Button not working? Copy this link into your browser:<br>
    <a href="${escapeHtml(url)}" style="color:${COLOR.primary};word-break:break-all;">${escapeHtml(url)}</a>
  </p>`;

/** Label/value rows in a tinted panel — e.g. the details of a failed delivery. */
export const detailsPanel = (rows, { tone = 'neutral' } = {}) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin:4px 0 20px;background:${tone === 'danger' ? COLOR.dangerSoft : COLOR.primarySoft};border-radius:12px;">
    ${rows
      .map(
        ([label, value]) => `
    <tr>
      <td style="padding:10px 16px;font-family:${FONT};font-size:13px;color:${COLOR.muted};width:34%;vertical-align:top;">${escapeHtml(label)}</td>
      <td style="padding:10px 16px;font-family:${FONT};font-size:14px;color:${COLOR.text};vertical-align:top;word-break:break-word;">${escapeHtml(value)}</td>
    </tr>`
      )
      .join('')}
  </table>`;

/** A row of big-number tiles — the summary's headline figures. */
export const statTiles = (tiles) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 20px;">
    <tr>
      ${tiles
        .map(
          ({ label, value, tone }) => `
      <td width="${Math.floor(100 / tiles.length)}%" style="padding:4px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="background:${tone === 'danger' ? COLOR.dangerSoft : COLOR.primarySoft};border-radius:12px;">
          <tr><td style="padding:14px 8px 4px;text-align:center;font-family:${FONT};font-size:24px;font-weight:700;color:${tone === 'danger' ? COLOR.danger : tone === 'good' ? COLOR.primary : COLOR.text};">${escapeHtml(value)}</td></tr>
          <tr><td style="padding:0 8px 14px;text-align:center;font-family:${FONT};font-size:12px;color:${COLOR.muted};">${escapeHtml(label)}</td></tr>
        </table>
      </td>`
        )
        .join('')}
    </tr>
  </table>`;

/** A titled two-column list — the summary's per-platform breakdown. */
export const countList = (title, rows) => `
  <p style="margin:0 0 8px;font-family:${FONT};font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${COLOR.muted};">${escapeHtml(title)}</p>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="margin:0 0 20px;border:1px solid ${COLOR.border};border-radius:12px;">
    ${rows
      .map(
        ([label, value], index) => `
    <tr>
      <td style="padding:10px 16px;font-family:${FONT};font-size:14px;color:${COLOR.text};${index ? `border-top:1px solid ${COLOR.border};` : ''}">${escapeHtml(label)}</td>
      <td style="padding:10px 16px;font-family:${FONT};font-size:14px;font-weight:600;color:${COLOR.text};text-align:right;${index ? `border-top:1px solid ${COLOR.border};` : ''}">${escapeHtml(value)}</td>
    </tr>`
      )
      .join('')}
  </table>`;

/**
 * The page around every email: wordmark, a heading, the body blocks in a
 * card, and a footer note.
 *
 * @param {{ preheader?: string, heading: string, body: string[], footer?: string }} parts
 *   preheader — the grey preview line inbox lists show after the subject
 *   body      — HTML strings from the building blocks above
 * @returns {string} a complete HTML document
 */
export function renderEmail({ preheader = '', heading, body, footer = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${COLOR.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.page};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr><td style="padding:0 4px 20px;font-family:${BRAND_FONT};font-size:24px;font-weight:600;color:${COLOR.primary};">
          &#9889; PingOne
        </td></tr>
        <tr><td style="background:${COLOR.card};border:1px solid ${COLOR.border};border-radius:20px;padding:32px 28px;">
          <h1 style="margin:0 0 18px;font-family:${BRAND_FONT};font-size:24px;line-height:1.3;font-weight:600;color:${COLOR.text};">${escapeHtml(heading)}</h1>
          ${body.join('\n')}
        </td></tr>
        <tr><td style="padding:20px 8px 0;font-family:${FONT};font-size:12px;line-height:1.6;color:${COLOR.muted};text-align:center;">
          ${footer ? `${escapeHtml(footer)}<br>` : ''}
          PingOne &middot; Write once, deliver everywhere.
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
