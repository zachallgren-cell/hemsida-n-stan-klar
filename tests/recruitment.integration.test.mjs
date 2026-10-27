import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {APPLICATION_LABELS,APPLICATION_STATUSES} from '../job-application-shared.mjs';
import {filterCandidates,overdue,stockholmToday,recruitmentStatus,validateFollowUp} from '../recruitment-ui.mjs';
import {adminId,martinId,outsiderId,candidateId,answers,database,asRole,save} from './helpers/recruitment-db.mjs';
test('REK-03 real PostgreSQL: persistence, immutable answers, auditing, conflict and RLS',async () => {
 const db=await database();
 try {
  const initial=(await db.query('select * from public.job_applications')).rows[0];
  assert.deepEqual(initial.answers,answers);assert.equal(initial.revision,1);
  const saved=await asRole(db,'authenticated',adminId,'aal2',() => save(db));
  assert.equal(saved.rows[0].status,'Intervju');
  const reloaded=await asRole(db,'authenticated',adminId,'aal2',() => db.query('select * from public.job_applications where id=$1',[candidateId]));
  const row=reloaded.rows[0];assert.equal(row.responsible,'Martin');assert.equal(row.assigned_user_id,martinId);assert.equal(row.next_step,'TEST Ring och boka intervju');assert.equal(row.follow_up_date.toISOString().slice(0,10),'2027-03-01');assert.equal(row.internal_notes,'TEST Intern anteckning');assert.equal(row.revision,2);assert.deepEqual(row.answers,answers);
  const history=await asRole(db,'authenticated',adminId,'aal2',() => db.query('select * from public.job_application_status_history'));
  assert.equal(history.rows.length,1);assert.equal(history.rows[0].changed_by,adminId);assert.equal(history.rows[0].previous_status,'Ny ansökan');assert.equal(history.rows[0].status,'Intervju');assert.ok(history.rows[0].changed_at);assert.equal(history.rows[0].changed_by_label,'Zacke');
  await assert.rejects(asRole(db,'authenticated',martinId,'aal2',() => save(db,1,{status:'Nej'})),error => error.code==='40001');
  assert.equal((await db.query('select revision from public.job_applications')).rows[0].revision,2);
  for (const changes of [{status:'Ogiltig'},{responsible:'Någon'},{follow_up_date:'2027-02-30'},{follow_up_date:'2027-3-1'},{next_step:'x'.repeat(2001)},{internal_notes:'x'.repeat(5001)},{next_step:'TEST\u0001'}]) await assert.rejects(asRole(db,'authenticated',adminId,'aal2',() => save(db,2,changes)));
  await assert.rejects(asRole(db,'anon',outsiderId,'aal1',() => db.query('select * from public.job_applications')),error => error.code==='42501');
  await assert.rejects(asRole(db,'anon',outsiderId,'aal1',() => save(db,2)),error => error.code==='42501');
  for (const [id,aal] of [[outsiderId,'aal2'],[adminId,'aal1']]) {
   assert.equal((await asRole(db,'authenticated',id,aal,() => db.query('select * from public.job_applications'))).rows.length,0);
   await assert.rejects(asRole(db,'authenticated',id,aal,() => save(db,2)),error => error.code==='42501');
   assert.equal((await asRole(db,'authenticated',id,aal,() => db.query('select * from public.job_application_status_history'))).rows.length,0);
  }
  await assert.rejects(asRole(db,'authenticated',adminId,'aal2',() => db.query("update public.job_applications set answers='{}' where id=$1",[candidateId])),error => error.code==='42501');
  await assert.rejects(asRole(db,'authenticated',adminId,'aal2',() => db.query("update public.job_applications set status='Nej' where id=$1",[candidateId])),error => error.code==='42501');
  await assert.rejects(asRole(db,'authenticated',adminId,'aal2',() => db.query("delete from public.job_application_status_history")),error => error.code==='42501');
  await asRole(db,'authenticated',adminId,'aal2',() => save(db,2,{internal_notes:'TEST Ny anteckning'}));
  assert.equal((await db.query('select * from public.job_application_status_history')).rows.length,1,'same status should not create history');
  await db.query('delete from auth.mfa_factors where user_id=$1',[adminId]);
  await assert.rejects(asRole(db,'authenticated',adminId,'aal2',() => save(db,3)),error => error.code==='42501');
 } finally {await db.close();}
});

function domController(client) {
 const dom=new JSDOM(`<section id="applicationsPanel"><button id="applicationsRefresh">Uppdatera</button><input id="applicationsSearch"><select id="applicationsFilter"></select><p id="applicationsMessage"></p><div id="applicationsList"></div></section><dialog id="applicationDialog"><div id="applicationDetail"></div></dialog>`,{url:'http://localhost/admin.html',runScripts:'outside-only'});
 dom.window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
 dom.window.HTMLDialogElement.prototype.close=function(){this.open=false;};
 dom.window.HTMLFormElement.prototype.reportValidity=()=>true;
 return readFile(new URL('../admin-applications.js',import.meta.url),'utf8').then(source => {
  Object.assign(dom.window,{APPLICATION_LABELS,APPLICATION_STATUSES,recruitmentStatus,stockholmToday,overdue,filterCandidates,validateFollowUp});
  dom.window.mountInterviews = () => {};
  dom.window.eval(source.replace(/^import[^\n]+\n/gm,''));
  const controller=dom.window.bergaAdminApplications.init({supabase:client});return {dom,controller};
 });
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
const sample=()=>({id:candidateId,answers:{...answers},created_at:'2026-10-01T09:00:00Z',status:null,responsible:'',next_step:'',follow_up_date:'2026-01-01',revision:1,internal_notes:''});
function fakeClient(store) {
 return {from(table) {
  let id;
  const query={select(){return query;},eq(key,value){id=value;return query;},order:async()=>({data:table==='job_application_status_history' ? store.history : store.rows,error:null}),single:async()=>({data:store.rows.find(row=>row.id===id),error:null}),then(resolve,reject){return Promise.resolve({data:table==='job_application_assignees'?[{label:'Martin',user_id:martinId},{label:'Zacke',user_id:adminId}]:store.rows,error:null}).then(resolve,reject);}};
  return query;
 },async rpc(name,args) {
  assert.equal(name,'recruitment_save_application');store.calls++;
  if(store.fail)return {error:{message:'TEST misslyckad sparning'},data:null};
  if(store.conflict)return {error:{code:'40001',message:'TEST annan administratör har ändrat'},data:null};
  const row=store.rows.find(row=>row.id===args.p_id);
  const updated={...row,status:args.p_status,responsible:args.p_responsible,next_step:args.p_next_step,follow_up_date:args.p_follow_up_date,internal_notes:args.p_internal_notes,revision:row.revision+1};
  store.rows=store.rows.map(row=>row.id===updated.id?updated:row);
  store.history=[{previous_status:'Ny ansökan',status:'Intervju',changed_at:new Date().toISOString(),changed_by_label:'Zacke'}];
  return {data:updated,error:null};
 }};
}
test('REK-03 DOM: read all answers, edit/save/reload, filter/search, failure retention and logout',async () => {
 const store={rows:[sample()],history:[],calls:0};
 const {dom,controller}=await domController(fakeClient(store));const d=dom.window.document;
 try {
  await controller.load('applications');assert.equal(d.querySelectorAll('[data-open-application]').length,0);
  controller.setAuthorized(true);await controller.load('applications');
  assert.match(d.getElementById('applicationsList').textContent,/Försenad uppföljning/);
  assert.match(d.getElementById('applicationsList').textContent,/Ny ansökan/);
  d.querySelector('[data-open-application]').click();await tick();
  assert.equal(d.querySelectorAll('.recruitment-answers dt').length,16);
  for(const value of Object.values(answers))assert.ok(d.querySelector('.recruitment-answers').textContent.includes(value));
  assert.equal(d.querySelector('script'),null);
  const assign=(id,value)=>{d.getElementById(id).value=value;d.getElementById(id).dispatchEvent(new dom.window.Event('input',{bubbles:true}));};
  assign('applicationStatus','Intervju');assign('applicationResponsible','Martin');assign('applicationNextStep','TEST Ring och boka intervju');assign('applicationFollowUpDate','2027-03-01');assign('applicationNotes','TEST Intern anteckning');
  const submit=()=>d.getElementById('applicationFollowUpForm').dispatchEvent(new dom.window.Event('submit',{bubbles:true,cancelable:true}));
  store.fail=true;submit();await tick();assert.match(d.getElementById('applicationSaveMessage').textContent,/TEST misslyckad/);assert.equal(d.getElementById('applicationNotes').value,'TEST Intern anteckning');assert.equal(d.getElementById('applicationSave').disabled,false);
  store.fail=false;store.conflict=true;submit();await tick();assert.equal(d.getElementById('applicationReloadLatest').hidden,false);assert.equal(d.getElementById('applicationNotes').value,'TEST Intern anteckning');
  store.conflict=false;submit();await tick();assert.match(d.getElementById('applicationSaveMessage').textContent,/Ändringarna är sparade/);assert.match(d.getElementById('applicationHistory').textContent,/Zacke/);
  d.querySelector('[data-close-application]').click();await controller.load('applications');d.querySelector('[data-open-application]').click();await tick();
  for(const [id,value] of Object.entries({applicationStatus:'Intervju',applicationResponsible:'Martin',applicationNextStep:'TEST Ring och boka intervju',applicationFollowUpDate:'2027-03-01',applicationNotes:'TEST Intern anteckning'}))assert.equal(d.getElementById(id).value,value);
  d.querySelector('[data-close-application]').click();assign('applicationsSearch','saknas');assert.equal(d.querySelectorAll('[data-open-application]').length,0);assign('applicationsSearch','åSA');assert.equal(d.querySelectorAll('[data-open-application]').length,1);
  d.getElementById('applicationsFilter').value='Nej';d.getElementById('applicationsFilter').dispatchEvent(new dom.window.Event('change'));assert.equal(d.querySelectorAll('[data-open-application]').length,0);
  d.getElementById('applicationsFilter').value='Intervju';d.getElementById('applicationsFilter').dispatchEvent(new dom.window.Event('change'));assert.equal(d.querySelectorAll('[data-open-application]').length,1);
  controller.setAuthorized(false);assert.equal(d.getElementById('applicationsList').textContent,'');assert.equal(d.getElementById('applicationDetail').textContent,'');
 } finally {dom.window.close();}
});
test('date validation and overdue use Stockholm day and closed candidates are excluded',()=> {
 assert.equal(stockholmToday(new Date('2026-10-04T22:30:00Z')),'2026-10-05');
 assert.equal(overdue({status:'Anställd',follow_up_date:'2020-01-01'}),false);
 assert.equal(overdue({status:'Ny ansökan',follow_up_date:'2026-10-05'},'2026-10-05'),false);
 assert.throws(()=>validateFollowUp({status:'Intervju',responsible:'Martin',next_step:'TEST',internal_notes:'TEST',follow_up_date:'2027-02-30'}));
});
