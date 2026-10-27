import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {runInNewContext} from 'node:vm';
import {validateInterview,interviewEmail} from '../interview-shared.mjs';
import {readJsonWithLimit} from '../supabase/functions/_shared/read-json.ts';
const application_id='20000000-0000-4000-8000-000000000001',request_id='30000000-0000-4000-8000-000000000001';
const future=new Date(Date.now()+7*86400000).toISOString().slice(0,10);
const input={action:'send',application_id,request_id,date:future,time:'14:30',duration_minutes:'30',location:'TEST kontor',message:'TEST',style:'warm'};
async function endpoint(state={}) {
 let handler;const calls=[];
 const source=(await readFile(new URL('../supabase/functions/interview-invitation/index.ts',import.meta.url),'utf8')).replace(/^import .*;\n/gm,'');
 runInNewContext(stripTypeScriptTypes(source),{Deno:{serve:fn=>handler=fn,env:{get:key=>({SUPABASE_URL:'https://db.invalid',SUPABASE_SERVICE_ROLE_KEY:'TEST-SECRET',SUPABASE_ANON_KEY:'TEST-PUBLIC',RESEND_API_KEY:state.noConfig?undefined:'TEST-RESEND',BOOKING_FROM_EMAIL:'TEST <noreply@example.invalid>',PUBLIC_SITE_URL:'https://example.invalid'})[key]}},crypto,Uint8Array,TextEncoder,Response,Request,Date,validateInterview,interviewEmail,readJsonWithLimit,fetch:async(url,options={})=>{
  const body=options.body?JSON.parse(options.body):null;calls.push({url,options,body});
  if(url.endsWith('/auth/v1/user'))return Response.json({id:'TEST-admin'},{status:state.authFailure?401:200});
  if(url.includes('/job_applications?'))return Response.json(state.forbidden?[]:[{id:application_id,answers:{name:'TEST <kandidat>',email:'test@example.invalid'}}]);
  if(url.endsWith('/rpc/respond_interview'))return Response.json(state.invalidToken?{message:'Inbjudan kunde inte hittas.'}:{starts_at:future+'T13:30:00Z',response:body.p_response},{status:state.invalidToken?400:200});
  if(url.includes('/interview_invitations?')) {
   if(options.method==='POST') {
    if(state.conflict)return Response.json({},{status:409});
    state.invitation={...body,created_at:new Date().toISOString(),delivery_status:'pending'};return Response.json([state.invitation]);
   }
   if(options.method==='PATCH') {
    if(body.delivery_status==='sent') {
     if(state.patchFailure)return Response.json({},{status:500});
     Object.assign(state.invitation,body);
    }
    return new Response(null,{status:204});
   }
   return Response.json(state.invitation?[state.invitation]:[]);
  }
  if(url==='https://api.resend.com/emails')return Response.json({id:'TEST-provider'},{status:state.mailFailure?500:200});
  throw new Error('Unexpected '+url);
 }});
 return {calls,state,call:(body=input,headers={})=>handler(new Request('https://edge.invalid',{method:'POST',headers:{'Content-Type':'application/json',origin:'https://bergafonsterputs.se',Authorization:'Bearer TEST-user',...headers},body:JSON.stringify(body)}))};
}
test('actual handler reserves before sending, mails only saved candidate and repeats safely',async()=>{
 const {call,calls,state}=await endpoint();
 assert.equal((await call({...input,email:'attacker@example.invalid'})).status,200);
 const sent=calls.find(c=>c.url==='https://api.resend.com/emails');
 assert.deepEqual(Array.from(sent.body.to),['test@example.invalid']);
 assert.equal(sent.options.headers['Idempotency-Key'],'interview-'+request_id);
 assert.match(sent.body.html,/#token=[a-f0-9]{64}&amp;choice=yes/);
 assert.doesNotMatch(sent.body.html,/TEST-SECRET/);
 assert.match(state.invitation.token_hash,/^[a-f0-9]{64}$/);
 assert.equal((await call()).status,200);
 assert.equal(calls.filter(c=>c.url==='https://api.resend.com/emails').length,1);
 assert.equal((await call({...input,location:'Changed'})).status,409);
});
test('uncertain provider/storage results retry with the same email and provider key',async()=>{
 for(const failure of ['mailFailure','patchFailure']) {
  const state={[failure]:true};const {call,calls}=await endpoint(state);
  assert.equal((await call()).status,502);
  state[failure]=false;
  assert.equal((await call()).status,200);
  const mails=calls.filter(c=>c.url==='https://api.resend.com/emails');
  assert.equal(mails.length,2);assert.deepEqual(mails[0].body,mails[1].body);assert.equal(mails[0].options.headers['Idempotency-Key'],mails[1].options.headers['Idempotency-Key']);
 }
});
test('send endpoint rejects unauthorized callers, invalid dates, duplicates and missing mail config',async()=>{
 for(const [state,body,status] of [[{authFailure:true},input,401],[{forbidden:true},input,403],[{conflict:true},input,409],[{noConfig:true},input,503],[{},{...input,date:'2020-01-01'},400]]) {
  const {call,calls}=await endpoint(state);assert.equal((await call(body)).status,status);assert.equal(calls.some(c=>c.url==='https://api.resend.com/emails'),false);
 }
 const {call}=await endpoint();assert.equal((await call(input,{origin:'https://evil.invalid'})).status,403);
});
test('public view has no write response; explicit yes/no uses token hash and no admin auth',async()=>{
 const {call,calls}=await endpoint();
 assert.equal((await call({action:'view',token:'a'.repeat(64)},{Authorization:''})).status,200);
 assert.equal(calls[0].body.p_response,null);
 assert.match(calls[0].body.p_token_hash,/^[a-f0-9]{64}$/);assert.notEqual(calls[0].body.p_token_hash,'a'.repeat(64));
 assert.equal((await call({action:'respond',token:'a'.repeat(64),response:'yes'},{Authorization:''})).status,200);
 assert.equal(calls.at(-1).body.p_response,'yes');
 assert.equal((await call({action:'respond',token:'a'.repeat(64),response:'maybe'})).status,400);
 assert.equal((await call({action:'view',token:'bad'})).status,400);
 assert.equal(calls.some(c=>c.url==='https://api.resend.com/emails'),false);
});
