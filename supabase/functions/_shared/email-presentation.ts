/** Presentation only: callers remain responsible for escaping customer content. */
export function emailDocument(content: string, card = false): string {
  const styles = `<style>
    body { -webkit-text-size-adjust:100%; margin:0; }
    table { border-spacing:0; }
    img { max-width:100%; height:auto; border:0; }
    h1,h2,h3 { line-height:1.25; }
    a { color:#084f74; text-underline-offset:3px; }
    .berga-email-content { overflow-wrap:anywhere; }
    @media only screen and (max-width:600px) {
      .berga-email-content { padding:24px 18px !important; }
      h1 { font-size:26px !important; }
      td[style*="42px"], td[style*="38px"] { padding-left:18px !important; padding-right:18px !important; }
    }
  </style>`;
  // Preserve existing full documents, including hidden preheaders and email metadata.
  if (/<html[\s>]/i.test(content)) return content.replace(/<\/head>/i, `${styles}</head>`);
  const body = card ? `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5fafc;"><tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #c9e0ea;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:20px 28px;background:#084f74;color:#ffffff;font-size:16px;font-weight:700;">Berga Fönsterputs</td></tr>
        <tr><td class="berga-email-content" style="padding:28px;color:#173042;font-size:16px;line-height:1.65;">${content}</td></tr>
      </table>
    </td></tr></table>` : content;
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Berga Fönsterputs</title>${styles}</head><body style="margin:0;background:#f5fafc;color:#173042;font-family:Arial,Helvetica,sans-serif;line-height:1.65;">${body}</body></html>`;
}
