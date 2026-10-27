// Local UI preview with fictional candidates. Never connects to email or production.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {interviewEmail,INTERVIEW_STYLES,escapeHtml} from '../interview-shared.mjs';
const root=new URL('../',import.meta.url);
const preview=`<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Intervju – lokal förhandsvisning</title><link rel="stylesheet" href="/site.css"><link rel="stylesheet" href="/jobba-hos-oss.css"><link rel="stylesheet" href="/admin-applications.css"></head><body><main class="container" style="max-width:900px;padding:24px"><p><strong>Förhandsvisning med testdata. Inga mail skickas.</strong> · <a href="/examples">Se alla tre mailförslag</a></p><div class="recruitment-dialog" style="width:100%;max-height:none"><h1>TEST – Anna Andersson</h1><section id="interviews"></section></div></main><script type="module">
import {mountInterviews} from '/admin-interviews.mjs';
let invitations=[];
const row={id:'20000000-0000-4000-8000-000000000001',answers:{name:'TEST Anna',email:'anna@example.invalid'}};
const client={from(){const q={select(){return q},eq(){return q},async order(){return {data:invitations,error:null}}};return q},functions:{async invoke(name,{body}) { const {validateInterview}=await import('/interview-shared.mjs'); invitations=[{...validateInterview(body),id:body.request_id,delivery_status:'sent',created_at:new Date().toISOString()}];return {data:{success:true}};}}};
mountInterviews({root:document.getElementById('interviews'),row,supabase:client,isCurrent:()=>true,onBusy:()=>{}});
</script></body></html>`;
const examples=Object.entries(INTERVIEW_STYLES).map(([style,value])=>{
 const mail=interviewEmail({name:'Anna',starts_at:'2026-11-03T13:00:00Z',duration_minutes:30,location:'Vårt kontor i Åkersberga (exempel)',message:'Du behöver inte förbereda något. Ta gärna med dina frågor!',style},{yes:'#exempel-ja',no:'#exempel-nej'});
 return `<section><h2>${value.label}</h2><p><strong>Ämne:</strong> ${value.subject}</p><iframe title="${value.label}" sandbox="" srcdoc="${escapeHtml(mail.html)}"></iframe></section>`;
}).join('');
const gallery=`<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tre intervjuinbjudningar | Berga Fönsterputs</title><style>body{margin:0;padding:32px;background:#f3f7fa;color:#173042;font:16px/1.6 Arial,sans-serif}h1{font-size:32px}main{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}section{min-width:0}h2{font-size:20px}iframe{width:100%;height:1050px;border:1px solid #c9dce6;border-radius:14px}p{min-height:52px}@media(max-width:1000px){main{grid-template-columns:1fr}iframe{height:850px}}</style></head><body><h1>Välkommen till Berga</h1><p>Tre sätt att bjuda in till intervju. Exempeluppgifter – inga mail skickas. Varje mall innehåller datum, plats och personliga svarsknappar.</p><main>${examples}</main></body></html>`;
export {gallery};
if(process.argv[1]===new URL(import.meta.url).pathname) createServer(async(req,res)=>{
 const path=new URL(req.url,'http://localhost').pathname;
 if(path==='/' || path==='/examples') {res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(path==='/examples'?gallery:preview);return;}
 if(!/^\/(admin-interviews\.mjs|interview-shared\.mjs|site\.css|jobba-hos-oss\.css|admin-applications\.css)$/.test(path)){res.writeHead(404);res.end();return;}
 res.writeHead(200,{'Content-Type':path.endsWith('.css')?'text/css':'text/javascript'});res.end(await readFile(new URL(path.slice(1),root)));
}).listen(8772,'127.0.0.1',()=>process.stdout.write('Intervjuförhandsvisning: http://127.0.0.1:8772\n'));
