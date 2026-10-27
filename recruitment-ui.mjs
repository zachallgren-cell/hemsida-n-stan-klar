import { APPLICATION_STATUSES } from './job-application-shared.mjs';
export function recruitmentStatus(row) { return row.status || 'Ny ansökan'; }
export function stockholmToday(now = new Date()) {
  return new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Stockholm',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function overdue(row, today = stockholmToday()) {
  return Boolean(row.follow_up_date && row.follow_up_date < today && !['Anställd','Nej'].includes(recruitmentStatus(row)));
}
export function filterCandidates(rows, query, status) {
  const search = query.trim().toLocaleLowerCase('sv-SE');
  return rows.filter(row => String(row.answers?.name || '').toLocaleLowerCase('sv-SE').includes(search) && (!status || recruitmentStatus(row) === status));
}
export function validateFollowUp(values) {
  if (!APPLICATION_STATUSES.includes(values.status)) throw new Error('Välj en giltig status.');
  if (!['','Zacke','Martin'].includes(values.responsible)) throw new Error('Välj en ansvarig.');
  if (values.next_step.length > 2000 || values.internal_notes.length > 5000) throw new Error('Nästa steg får ha högst 2 000 tecken och anteckningar högst 5 000 tecken.');
  if (values.follow_up_date) {
    const value = values.follow_up_date;
    const date = new Date(`${value}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value || value < '1900-01-01' || value > '2100-12-31') throw new Error('Ange ett giltigt uppföljningsdatum mellan 1900 och 2100.');
  }
  return values;
}
