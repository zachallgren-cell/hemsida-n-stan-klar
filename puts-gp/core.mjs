export const finalTime = (rawTimeMs, penalties) => rawTimeMs + penalties.reduce((sum, p) => sum + p.count * p.secondsPerItem * 1000, 0);
export const rank = (attempts) => attempts.filter(a => a.status === 'published' && !a.deletedAt).sort((a,b) => a.finalTimeMs-b.finalTimeMs || a.penaltyMs-b.penaltyMs || new Date(a.publishedAt)-new Date(b.publishedAt));
export const average = (attempts) => { const xs=rank(attempts); return xs.length ? xs.reduce((s,x)=>s+x.finalTimeMs,0)/xs.length : 0; };
export const badges = (attempt, attempts) => { const xs=rank(attempts), position=xs.findIndex(x=>x.id===attempt.id)+1, avg=average(xs); return [position===1&&'Banrekord',position>0&&position<=3&&'Topp 3',position>0&&position<=10&&'Topp 10',attempt.penaltyMs===0&&'Noll straff',attempt.finalTimeMs<avg&&'Under genomsnittet',position===1&&xs.length===1&&'Första deltagaren'].filter(Boolean); };
export const publicResult = ({fullName,phoneNumber,birthYear,adminNote,...safe}) => safe;
export const canShowPhoto = (participant) => Boolean(participant.publicPhotoConsent && participant.photoPublicUrl);
export const specialAwards = (participants, attempts) => {
  const xs = rank(attempts), eligible = participants.filter(p => !p.deletedAt);
  return { bestTime: xs[0]?.participantId || null, youngest: [...eligible].sort((a,b)=>b.birthYear-a.birthYear)[0]?.id || null, oldest: [...eligible].sort((a,b)=>a.birthYear-b.birthYear)[0]?.id || null, underAverage: xs.filter(x=>x.finalTimeMs<average(xs)).map(x=>x.participantId) };
};
export const tokenAccess = (record, token, now = new Date()) => Boolean(record && record.token === token && !record.revokedAt && (!record.expiresAt || new Date(record.expiresAt) > now));
export const transition = (attempt, status, patch = {}) => {
  if (attempt.status === 'deleted') throw new Error('Deleted attempts cannot change');
  if (status === 'disqualified' && !patch.reason) throw new Error('Reason required');
  if (status === 'published' && (attempt.status !== 'reviewing' || attempt.rawTimeMs == null)) throw new Error('Only reviewed attempts can publish');
  return { ...attempt, ...patch, status };
};
export function createTimer(now=()=>performance.now()){let start=0,elapsed=0,active=false;return{start(){if(active)return false;active=true;start=now();return true},stop(){if(!active)return elapsed;elapsed+=now()-start;active=false;return elapsed},get active(){return active},get elapsed(){return active?elapsed+now()-start:elapsed}}}
