import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {stockholmInstant,validateInterview,interviewEmail,INTERVIEW_STYLES} from '../interview-shared.mjs';
import {database,asRole,adminId,outsiderId,candidateId} from './helpers/recruitment-db.mjs';
const input={date:'2027-03-01',time:'14:30',duration_minutes:'30',location:'TEST <img src=x onerror=alert(1)>',message:'TEST <script>alert(1)</script>',style:'warm'};
const now=Date.parse('2026-10-27T12:00:00Z');
test('Stockholm wall time handles DST and invalid or ambiguous dates',()=>{
 assert.equal(stockholmInstant('2027-01-10','14:30'),'2027-01-10T13:30:00.000Z');
 assert.equal(stockholmInstant('2027-07-10','14:30'),'2027-07-10T12:30:00.000Z');
 for(const [date,time] of [['2027-03-28','02:30'],['2027-10-31','02:30'],['2027-02-30','14:00'],['2027-03-01','25:00']]) assert.throws(()=>stockholmInstant(date,time));
 assert.throws(()=>validateInterview({...input,date:'2026-01-01'},now));
 assert.throws(()=>validateInterview({...input,style:'__proto__'},now));
 assert.throws(()=>validateInterview({...input,duration_minutes:0},now));
 assert.throws(()=>validateInterview({...input,location:''},now));
});
test('three actual email templates escape candidate content and preserve response links',()=>{
 for(const style of Object.keys(INTERVIEW_STYLES)) {
  const mail=interviewEmail({...validateInterview({...input,style},now),name:'TEST Åsa <script>'},{yes:'https://example.invalid/intervju.html#token=TEST&choice=yes',no:'https://example.invalid/intervju.html#token=TEST&choice=no'});
  const doc=new JSDOM(mail.html).window.document;
  assert.equal(doc.querySelectorAll('script,img').length,0);
  assert.match(doc.body.textContent,/14:30/);
  assert.match(doc.body.textContent,/TEST <script>/);
  assert.equal(doc.querySelectorAll('a').length,2);
  assert.match(doc.querySelector('a').href,/#token=TEST&choice=yes$/);
  assert.match(mail.text,/choice=no/);
 }
});
test('database protects candidate privacy, serializes responses and blocks duplicate invitations',async()=>{
 const db=await database();
 await db.exec('alter role service_role bypassrls');
 try {
  await db.exec(await readFile(new URL('../supabase/migrations/20261027163555_interview_invitations.sql',import.meta.url),'utf8'));
  const id=crypto.randomUUID();
  await db.query(`insert into public.interview_invitations(id,application_id,created_by,starts_at,duration_minutes,location,style,name,email,token_hash,delivery_status) values ($1,$2,$3,now()+interval '1 day',30,'TEST kontor','warm','TEST kandidat','test@example.invalid','HASH','sent')`,[id,candidateId,adminId]);
  await asRole(db,'authenticated',adminId,'aal2',async()=>assert.equal((await db.query('select id,response from public.interview_invitations')).rows.length,1));
  for(const [id,aal] of [[adminId,'aal1'],[outsiderId,'aal2']]) await asRole(db,'authenticated',id,aal,async()=>assert.equal((await db.query('select id from public.interview_invitations')).rows.length,0));
  await assert.rejects(asRole(db,'anon',null,null,()=>db.query('select id from public.interview_invitations')),/permission denied/);
  await assert.rejects(asRole(db,'authenticated',adminId,'aal2',()=>db.query('select token_hash from public.interview_invitations')),/permission denied/);
  await assert.rejects(asRole(db,'authenticated',adminId,'aal2',()=>db.query("select public.respond_interview('HASH','yes')")),/permission denied/);
  await assert.rejects(db.query(`insert into public.interview_invitations select $1,application_id,created_by,created_at,starts_at,duration_minutes,location,message,style,name,email,'HASH2',delivery_status,provider_id,sent_at,response,responded_at from public.interview_invitations where id=$2`,[crypto.randomUUID(),id]),/unique/);
  await asRole(db,'service_role',null,null,async()=>{
   assert.equal((await db.query("select public.respond_interview('HASH',null) as value")).rows[0].value.response,null);
   assert.equal((await db.query("select public.respond_interview('HASH','yes') as value")).rows[0].value.response,'yes');
   assert.equal((await db.query("select public.respond_interview('HASH','yes') as value")).rows[0].value.response,'yes');
  });
  await assert.rejects(asRole(db,'service_role',null,null,()=>db.query("select public.respond_interview('HASH','no')")),/redan svarat/);
  await assert.rejects(asRole(db,'service_role',null,null,()=>db.query("select public.respond_interview('WRONG','yes')")),/inte hittas/);
  await db.query("update public.interview_invitations set starts_at=now()-interval '1 minute' where id=$1",[id]);
  await assert.rejects(asRole(db,'service_role',null,null,()=>db.query("select public.respond_interview('HASH','yes')")),/gått ut/);
 } finally {await db.close();}
});
