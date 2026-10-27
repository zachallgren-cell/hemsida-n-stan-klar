export const INTERVIEW_STYLES = {
  warm: {label:'Varm och personlig', subject:'Vi vill gärna träffa dig – intervju hos Berga Fönsterputs', intro:'Tack för din ansökan! Vi blev nyfikna på dig och vill gärna bjuda in dig till ett samtal om jobbet hos oss.', outro:'Vi ser fram emot att lära känna dig och berätta mer om vårt team.'},
  professional: {label:'Stilren och professionell', subject:'Inbjudan till arbetsintervju – Berga Fönsterputs', intro:'Tack för ditt intresse för Berga Fönsterputs. Vi vill bjuda in dig till en arbetsintervju för att prata om din erfarenhet och rollen hos oss.', outro:'Under intervjun får du också möjlighet att ställa frågor om tjänsten och vår verksamhet.'},
  concise: {label:'Kort och tydlig', subject:'Välkommen på intervju hos Berga Fönsterputs', intro:'Tack för din ansökan. Vi vill gärna träffa dig för en arbetsintervju.', outro:'Bekräfta gärna om tiden passar med knapparna nedan.'}
};
export const escapeHtml = value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export const interviewDate = value => new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm',dateStyle:'full',timeStyle:'short'}).format(new Date(value));
// Resolve a wall-clock time in Stockholm independently of the browser/server timezone.
// Reject the missing spring hour and the ambiguous autumn hour instead of guessing.
export function stockholmInstant(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) throw new Error('Välj datum och tid.');
  const wall = `${date}T${time}`;
  const base = Date.parse(`${wall}:00Z`);
  const format = new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const matches = [1,2].map(offset=>new Date(base-offset*3600000)).filter(value=>Number.isFinite(value.getTime()) && format.format(value).replace(' ','T')===wall);
  if (matches.length!==1) throw new Error('Tiden är ogiltig eller tvetydig vid bytet mellan sommar- och vintertid. Välj en annan tid.');
  return matches[0].toISOString();
}
export function validateInterview(input, now = Date.now()) {
  const starts_at=stockholmInstant(String(input.date || ''),String(input.time || ''));
  if (Date.parse(starts_at)<=now || Date.parse(starts_at)>now+366*86400000) throw new Error('Välj en framtida tid inom ett år.');
  const duration_minutes=Number(input.duration_minutes);
  if (![15,30,45,60,90].includes(duration_minutes)) throw new Error('Välj en giltig längd.');
  const location=String(input.location || '').trim(), message=String(input.message || '').trim();
  if (!location || location.length>500 || message.length>2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(location+message)) throw new Error('Ange plats (högst 500 tecken) och ett meddelande på högst 2 000 tecken.');
  if (!Object.hasOwn(INTERVIEW_STYLES,input.style)) throw new Error('Välj en mailmall.');
  return {starts_at,duration_minutes,location,message,style:input.style};
}
export function interviewEmail(invite, links) {
  const style=INTERVIEW_STYLES[invite.style], e=escapeHtml;
  const details=`${interviewDate(invite.starts_at)} (svensk tid)\nLängd: ${invite.duration_minutes} minuter\nPlats: ${invite.location}`;
  const text=`Hej ${invite.name}!\n\n${style.intro}\n\n${details}\n\n${style.outro}\n${invite.message || ''}\n\nJa, jag kommer: ${links.yes}\nNej, tiden passar inte: ${links.no}\nDu bekräftar ditt svar på sidan som öppnas. Svara före intervjustarten. Om tiden inte passar är du välkommen att svara på mailet för att föreslå en annan tid.\n\nVänliga hälsningar\nBerga Fönsterputs`;
  const html=`<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(style.subject)}</title></head><body style="margin:0;background:#eff5f8;font:16px/1.7 Arial,Helvetica,sans-serif;color:#173042"><div style="display:none;max-height:0;overflow:hidden">Välkommen på intervju. Bekräfta om tiden passar dig.</div><table role="presentation" width="100%"><tr><td align="center" style="padding:28px 12px"><table role="presentation" width="100%" style="max-width:600px;background:white;border-radius:16px;overflow:hidden"><tr><td style="background:#084f74;color:white;padding:22px 28px;font-weight:bold">BERGA FÖNSTERPUTS · VI VÄXER</td></tr><tr><td style="padding:28px"><p style="color:#527183;font-size:12px;letter-spacing:2px">DIN NÄSTA MÖJLIGHET</p><h1 style="font-size:28px;line-height:1.25">Välkommen på intervju</h1><p>Hej ${e(invite.name)}!</p><p>${e(style.intro)}</p><div style="padding:20px;background:#eff7fa;border-left:4px solid #1681a8"><strong>${e(interviewDate(invite.starts_at))}</strong><br>Svensk tid · ${invite.duration_minutes} minuter<br><strong>Plats:</strong> ${e(invite.location)}</div><p>${e(style.outro)}</p>${invite.message ? `<p style="white-space:pre-wrap">${e(invite.message)}</p>`:''}<p><a href="${e(links.yes)}" style="display:inline-block;background:#084f74;color:white;padding:13px 20px;border-radius:8px;text-decoration:none;font-weight:bold;margin:0 8px 12px 0">Ja, jag kommer</a><a href="${e(links.no)}" style="display:inline-block;background:#edf2f5;color:#173042;padding:13px 20px;border-radius:8px;text-decoration:none;margin-bottom:12px">Nej, tiden passar inte</a></p><p style="font-size:13px;color:#526c7b">Du bekräftar ditt svar på sidan som öppnas. Svara före intervjustarten. Passar inte tiden? Svara gärna på detta mail och föreslå en annan tid.</p><p>Vänliga hälsningar,<br><strong>Berga Fönsterputs</strong></p></td></tr></table></td></tr></table></body></html>`;
  return {subject:style.subject,text,html};
}
