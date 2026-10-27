// Isolated REK-03 preview. TEST fixtures only; no connection to Supabase or email.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {database,asRole,adminId,candidateId} from './helpers/recruitment-db.mjs';
const db=await database();
await db.exec(await readFile(new URL('../supabase/migrations/20261027163555_interview_invitations.sql',import.meta.url),'utf8'));
await db.query("update public.job_applications set follow_up_date='2026-01-01' where id=$1",[candidateId]);
const root=new URL('../',import.meta.url);
const html=await readFile(new URL('admin.html',root),'utf8');
const panel=html.match(/<section[^>]*id="applicationsPanel"[\s\S]*?<\/section>/)[0].replace('admin-view hidden','admin-view');
const dialog=html.match(/<dialog id="applicationDialog"[\s\S]*?<\/dialog>/)[0];
const preview=`<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>REK-03 – lokal testmiljö</title><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/jobba-hos-oss.css"><link rel="stylesheet" href="/admin-applications.css"></head><body><main class="container" style="padding:24px 0"><p><strong>Lokal testmiljö för REK-03 – endast TEST-data. Ingen produktionskoppling.</strong></p>${panel}${dialog}</main><script type="module">
import '/admin-applications.js';
const send=async payload=>{const response=await fetch('/__rek03',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});return await response.json();};
const client={functions:{async invoke(){return {error:{message:'Denna lokala testmiljö skickar inga mail.'}};}},from(table){let id;const query={select(){return query;},eq(key,value){id=value;return query;},order(){return send({action:'read',table,id});},single(){return send({action:'read',table,id,single:true});},then(resolve,reject){return send({action:'read',table,id}).then(resolve,reject);}};return query;},rpc(name,args){return send({action:'save',args});}};
const controller=window.bergaAdminApplications.init({supabase:client});controller.setAuthorized(true);await controller.load('applications');
</script></body></html>`;
const allowed=new Set(['site.css','jobba-hos-oss.css','admin-applications.css','admin-applications.js','job-application-shared.mjs','recruitment-ui.mjs','admin-interviews.mjs','interview-shared.mjs']);
const normalize=row=>({...row, ...(row.follow_up_date instanceof Date ? {follow_up_date:row.follow_up_date.toISOString().slice(0,10)}:{})});
createServer(async(req,res)=>{
 try {
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/' || path==='/recruitment-preview.html'){res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'});res.end(preview);return;}
  if(path==='/__rek03' && req.method==='POST'){
   let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>20000)throw new Error('Too large');}
   const payload=JSON.parse(raw);
   const data=await asRole(db,'authenticated',adminId,'aal2',async()=>{
    if(payload.action==='save'){
     const a=payload.args;
     return (await db.query('select * from public.recruitment_save_application($1,$2,$3,$4,$5,$6,$7)',[a.p_id,a.p_revision,a.p_status,a.p_responsible,a.p_next_step,a.p_follow_up_date,a.p_internal_notes])).rows[0];
    }
    if(!['job_applications','job_application_assignees','job_application_status_history','interview_invitations'].includes(payload.table))throw new Error('Unknown table');
    const table=payload.table;
    const where=payload.id ? (['job_application_status_history','interview_invitations'].includes(table)?' where application_id=$1':' where id=$1') : '';
    const rows=(await db.query(`select ${table==='interview_invitations'?'id,application_id,created_at,starts_at,duration_minutes,location,message,style,name,email,delivery_status,sent_at,response,responded_at':'*'} from public.${table}${where}`,payload.id?[payload.id]:[])).rows;
    return payload.single?rows[0]:rows;
   });
   res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({data:Array.isArray(data)?data.map(normalize):normalize(data),error:null}));return;
  }
  const file=path.slice(1);
  if(!allowed.has(file)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':'text/javascript','Cache-Control':'no-store'});res.end(await readFile(new URL(file,root)));
 }catch(error){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:null,error:{message:error.message,code:error.code}}));}
}).listen(8766,'127.0.0.1',()=>process.stdout.write('REK-03 TEST preview: http://127.0.0.1:8766/recruitment-preview.html\n'));
