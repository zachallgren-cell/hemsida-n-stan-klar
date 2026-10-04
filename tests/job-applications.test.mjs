import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateApplication, APPLICATION_LABELS} from '../supabase/functions/_shared/job-application.mjs';
const answers = {name:'TEST – Sökande',email:'test@example.invalid',phone:'0701234567',location:'TEST Åkersberga',adult:'Nej',license:'Nej',weekends:'Nej',minimumHours:'Nej',transport:'TEST Buss',motivation:'TEST Jag vill lära mig.'};
let handler;
globalThis.Deno = { env:{get:key => ({SUPABASE_URL:'https://test.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-service-key'})[key]}, serve:fn => {handler=fn;} };
await import('../supabase/functions/submit-job-application/index.ts');
const originalFetch = globalThis.fetch;
const request = (overrides={},method='POST',origin='http://localhost:8765') => new Request('http://localhost/submit-job-application',{method,headers:{origin,'content-type':'application/json'},...(method==='POST' ? {body:JSON.stringify({...answers,requestId:'87e13e57-d0b3-4b67-97f6-209983f5322e',formStartedAt:String(Date.now()-10000),...overrides})} : {})});
test('server validates every answer and accepts applicants who answer no', () => {
  assert.equal(validateApplication(answers).adult,'Nej');
  for (const key of ['name','email','phone','location','adult','license','weekends','minimumHours','transport','motivation']) assert.throws(() => validateApplication({...answers,[key]:''}));
  assert.throws(() => validateApplication({...answers,motivation:'x'.repeat(1001)}));
  assert.throws(() => validateApplication({...answers,phone:'abc'}));
  assert.throws(() => validateApplication({...answers,adult:'invalid'}));
  assert.throws(() => validateApplication({...answers,name:{a:1}}));
  assert.equal(Object.keys(validateApplication(answers)).length,16);
});
test('endpoint persists test answers, acknowledges retries and never emails',async () => {
  const rows = new Map(); let inserts=0;
  globalThis.fetch=async (url,options={}) => {
    assert.match(url,/^https:\/\/test.invalid\/rest\/v1\//);
    if (url.includes('/rpc/')) return Response.json(true);
    if (options.method==='POST') {
      const row=JSON.parse(options.body); inserts++;
      if (rows.has(row.request_id)) return Response.json([]);
      rows.set(row.request_id,{...row,id:'test-application-id',status:'Ny ansökan',created_at:new Date().toISOString()});
      return Response.json([{id:'test-application-id'}]);
    }
    return Response.json([{id:'test-application-id'}]);
  };
  try {
    let response=await handler(request()); assert.equal(response.status,200);
    assert.deepEqual(await response.json(),{success:true,applicationId:'test-application-id'});
    response=await handler(request());assert.equal(response.status,200);
    assert.equal(rows.size,1);assert.equal(inserts,2);
    const saved=[...rows.values()][0];assert.equal(saved.status,'Ny ansökan');assert.deepEqual(saved.answers,validateApplication(answers));
    assert.ok(saved.created_at);
  } finally {globalThis.fetch=originalFetch;}
});
test('endpoint blocks invalid input, spam, foreign origins and public reads',async () => {
  let calls=0;globalThis.fetch=async () => {calls++;return Response.json(true);};
  try {
    assert.equal((await handler(request({},'GET'))).status,405);
    assert.equal((await handler(request({},'POST','https://attacker.invalid'))).status,403);
    for (const bad of [{website:'spam'},{formStartedAt:String(Date.now())},{motivation:'x'.repeat(1001)},{adult:'invalid'}]) assert.equal((await handler(request(bad))).status,400);
    assert.equal(calls,0);
    assert.equal((await handler(request({motivation:'x'.repeat(13000)}))).status,413);
    globalThis.fetch=async () => Response.json(false);
    assert.equal((await handler(request())).status,429);
    globalThis.fetch=async url => url.includes('/rpc/') ? Response.json(true) : Response.json({error:'failed'},{status:500});
    const response=await handler(request()); assert.equal(response.status,502);assert.equal((await response.json()).success,undefined);
  } finally {globalThis.fetch=originalFetch;}
});
test('database permits only MFA admins to read and update follow-up, public insert is revoked',async () => {
  const sql=await readFile(new URL('../supabase/migrations/20261004000000_add_job_applications.sql',import.meta.url),'utf8');
  assert.match(sql,/enable row level security/);
  assert.match(sql,/revoke all on table public.job_applications from public, anon, authenticated/);
  assert.match(sql,/for select to authenticated using \(private.is_booking_admin\(\)\)/);
  assert.match(sql,/grant update \(status, next_step, responsible, follow_up_date\)/);
  assert.doesNotMatch(sql,/grant (select|insert|update).*to anon/);
  const helper=await readFile(new URL('../supabase/migrations/20260715020000_finalize_rut_security.sql',import.meta.url),'utf8');
  assert.match(helper,/aal2/);assert.match(helper,/public.admin_users/);assert.match(helper,/auth.mfa_factors/);
});
test('page has all labelled fields, masked data and genuine server confirmation',async () => {
  const html=await readFile(new URL('../jobba-hos-oss.html',import.meta.url),'utf8');
  for (const key of Object.keys(APPLICATION_LABELS)) {
    assert.match(html,new RegExp(`name="${key}"`));assert.match(html,new RegExp(`for="job-${key}"`));
  }
  assert.match(html,/data-clarity-mask="true"/);assert.match(html,/role="alert"/);
  const js=await readFile(new URL('../jobba-hos-oss.js',import.meta.url),'utf8');
  assert.match(js,/body.success !== true/);assert.match(js,/!body.applicationId/);assert.match(js,/if \(sending/);
});

test('client retains answers on failure, blocks concurrent sends and only confirms a receipt',async () => {
  const {runInNewContext} = await import('node:vm');
  const source=(await readFile(new URL('../jobba-hos-oss.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'');
  let submit,resolveFetch,calls=0;
  const elements=Object.fromEntries(['jobForm','jobSubmit','jobStatus','jobConfirmation','jobReceipt','jobConfirmationTitle'].map(id => [id,{hidden:id !== 'jobForm',textContent:'',disabled:false,setAttribute(){},removeAttribute(){},focus(){},reportValidity:() => true,addEventListener(type,fn){if(type==='submit') submit=fn;}}]));
  class TestFormData {constructor(){return Object.entries(answers)[Symbol.iterator]();}}
  runInNewContext(source,{document:{getElementById:id => elements[id]},crypto,Date,FormData:TestFormData,validateApplication,AbortSignal,fetch:() => {calls++;return new Promise(resolve => {resolveFetch=resolve;});}});
  const pending=submit({preventDefault(){}});
  assert.equal(elements.jobSubmit.disabled,true);
  await submit({preventDefault(){}});assert.equal(calls,1);
  resolveFetch(Response.json({error:'TEST serverfel'},{status:502}));await pending;
  assert.equal(elements.jobForm.hidden,false);assert.equal(elements.jobStatus.textContent,'TEST serverfel');assert.equal(elements.jobSubmit.disabled,false);
  const retry=submit({preventDefault(){}});resolveFetch(Response.json({success:true,applicationId:'test-id'}));await retry;
  assert.equal(elements.jobForm.hidden,true);assert.equal(elements.jobConfirmation.hidden,false);assert.match(elements.jobReceipt.textContent,/test-id/);
});

test('admin renders all saved test answers safely, and clears them on logout',async () => {
  const {runInNewContext} = await import('node:vm');
  const source=(await readFile(new URL('../admin-applications.js',import.meta.url),'utf8')).replace(/^import[^\n]+\n/,'');
  const elements=Object.fromEntries(['applicationsPanel','applicationsList','applicationsMessage','applicationsRefresh'].map(id => [id,{textContent:'',innerHTML:'',addEventListener(){},replaceChildren(){this.innerHTML='';},classList:{add(){}}}]));
  const unsafe={...validateApplication(answers),name:'TEST <script>alert(1)</script>'};
  let reads=0;const client={from(table){assert.equal(table,'job_applications');return {select(){return {order:async () => {reads++;return {data:[{id:'test-id',answers:unsafe,status:'Ny ansökan',created_at:'2026-10-04T12:00:00Z',responsible:'',next_step:'',follow_up_date:null}],error:null};}};}};}};
  const window={};const {APPLICATION_STATUSES}=await import('../supabase/functions/_shared/job-application.mjs');
  runInNewContext(source,{window,document:{getElementById:id => elements[id]},APPLICATION_LABELS,APPLICATION_STATUSES,Date,FormData});
  const admin=window.bergaAdminApplications.init({supabase:client});
  await admin.load('applications');assert.equal(reads,0);
  admin.setAuthorized(true);await admin.load('applications');assert.equal(reads,1);
  const html=elements.applicationsList.innerHTML;
  assert.match(html,/TEST &lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  for(const label of Object.values(APPLICATION_LABELS)) assert.ok(html.includes(label));
  assert.match(html,/Ny ansökan/);assert.match(html,/test-id/);
  admin.setAuthorized(false);assert.equal(elements.applicationsList.innerHTML,'');
  await admin.load('applications');assert.equal(reads,1);
});
