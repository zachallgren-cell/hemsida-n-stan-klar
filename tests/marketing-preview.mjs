// Isolated browser QA. Real marketing RPCs run against local PostgreSQL (PGlite).
// Only synthetic data. CSP blocks production and email services.
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {marketingDatabase,admin} from './helpers/marketing-db.mjs';
const c=await marketingDatabase();await c.insert(1,{utm_source:'facebook',utm_medium:'organic_social',utm_campaign:'var2027',customer_source_answer:'instagram',tracking_consent:true});await c.insert(2,{customer_source_answer:'recommendation'});
const root=path.resolve(new URL('..',import.meta.url).pathname),port=8773;
const mockClient=String.raw`
(function(){
 const role=location.pathname==='/personal.html'?'staff':'admin';
 const send=async(body)=>{const r=await fetch('/test-api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,role})});return r.json()};
 const session={access_token:'LOCAL-TEST',user:{id:role==='admin'?'10000000-0000-4000-8000-000000000001':'10000000-0000-4000-8000-000000000002',email:role+'@example.invalid'}};
 const client={auth:{getSession:async()=>({data:{session}}),getUser:async()=>({data:{user:session.user}}),onAuthStateChange(){return {data:{subscription:{unsubscribe(){}}}}},mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:'aal2',nextLevel:'aal2'}}),listFactors:async()=>({data:{totp:[],all:[]}})},signOut:async()=>({error:{message:'Lokal testvy – ingen riktig inloggning.'}})},
 rpc:(name,args={})=>send({name,args}),
 from(table){let filters=[],single=false,mutation=false;const q={select(){return q},eq(k,v){filters.push([k,v]);return q},neq(){return q},in(){return q},is(){return q},not(){return q},gte(){return q},lte(){return q},gt(){return q},lt(){return q},or(){return q},order(){return q},limit(){return q},range(){return q},single(){single=true;return q},maybeSingle(){single=true;return q},insert(){mutation=true;return q},update(){mutation=true;return q},upsert(){mutation=true;return q},delete(){mutation=true;return q},then(resolve,reject){if(mutation)return Promise.resolve({data:null,error:{message:'Denna förhandsvisning tillåter bara MKT-03-källregistrering med testdata.'}}).then(resolve,reject);return send({table,filters,single}).then(resolve,reject)}};return q},
 channel(){return {on(){return this},subscribe(){return this},unsubscribe(){}}},removeChannel(){},storage:{from(){return {createSignedUrl:async()=>({error:{message:'Ingen produktionslagring i förhandsvisningen'}})}}}};
 window.supabase={createClient:()=>client};
})();`;
const keys={marketing_list:['p_booking_id'],marketing_booking:['p_booking_id'],marketing_report:['p_start','p_end'],marketing_save:['p_id','p_revision','p_booking_id','p_label','p_source','p_campaign','p_route','p_reason']};
let queue=Promise.resolve();
http.createServer(async(req,res)=>{
 try{
  if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host)){res.writeHead(403);return res.end();}
  const url=new URL(req.url,'http://localhost');
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; object-src 'none'; frame-src 'none'; form-action 'none'");
  if(url.pathname==='/preview-client.js'){res.setHeader('Content-Type','text/javascript');return res.end(mockClient);}
  if(url.pathname==='/test-api'){
   let text='';for await(const chunk of req){text+=chunk;if(text.length>32768)throw new Error('too large');}const body=JSON.parse(text);
   const task=queue.then(async()=>{
    if(body.name){if(!keys[body.name])return {data:null,error:{message:'Endast MKT-03 i denna testvy'}};return {data:await c.as(admin,'aal2',()=>c.rpc(body.name,keys[body.name].map(k=>body.args[k]??null)))};}
    if(body.table==='bookings')return {data:(await c.db.query('select * from bookings order by id')).rows.map(b=>({...b,customer_name:'TEST Kund '+b.id,phone:'0700000000',address:'Testvägen 1',housing_type:'En våning',service_scope:'Invändig + utvändig',booking_date:'2027-04-10',booking_time:'10:00',created_at:b.created_at.toISOString(),payment_status:'unpaid',price:'1325',labor_cost_before_rut:2350,material_cost:150,transport_cost:0,rut_deduction:1175,rut_choice:'Ja, jag vill använda RUT-avdrag'}))};
    return {data:body.single?null:[],error:null};
   });queue=task.catch(()=>{});res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(await task.catch(e=>({error:{message:e.message}}))));
  }
  if(url.pathname==='/functions/v1/booking-invitation'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({active:true,date:'2027-04-10',invitationType:'reserved_date',email:'test@example.invalid',expiresAt:'2027-04-11T00:00:00Z'}));}
  if(url.pathname==='/functions/v1/booked-slots'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({bookings:[],blockedDates:[],capacityOverrides:[]}));}
  if(url.pathname.startsWith('/functions/')){res.writeHead(400,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'Lokal testvy – skickar ingen bokning eller mejl.'}));}
  if(['/admin.html','/bokning.html','/index.html'].includes(url.pathname)){
   let html=await readFile(path.join(root,url.pathname.slice(1)),'utf8');html=html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/,'').replace(/<script src="vendor\/supabase[^>]*><\/script>/,'<script src="/preview-client.js"></script>');
   html=html.replace("const SUPABASE_URL = 'https://xeyippgcoqfskcmqzazx.supabase.co';","const SUPABASE_URL = window.location.origin;");
   html=html.replace(/(<body[^>]*>)/,'$1<p style="padding:8px;background:#fff3ce;text-align:center">LOKAL MKT-03 TEST · Syntetiska uppgifter · Inga mejl eller produktionsanrop</p>');res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(html);
  }
  if(url.pathname==='/booking.js'){
   res.setHeader('Content-Type','text/javascript');return res.end((await readFile(path.join(root,'booking.js'),'utf8')).replace("'https://xeyippgcoqfskcmqzazx.functions.supabase.co'","window.location.origin + '/functions/v1'"));
  }
  if(!/^\/(?:vendor\/)?[a-zA-Z0-9._-]+\.(css|js|mjs|jpg|jpeg|png|svg|webmanifest)$/.test(url.pathname))throw new Error('not found');
  const type=path.extname(url.pathname);res.setHeader('Content-Type',({'.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.jpg':'image/jpeg','.jpeg':'image/jpeg','.png':'image/png','.svg':'image/svg+xml'})[type]||'application/json');return res.end(await readFile(path.join(root,url.pathname.slice(1))));
 }catch{res.writeHead(404);res.end('Not found');}
}).listen(port,'127.0.0.1',()=>console.log(`MKT-03 TEST http://127.0.0.1:${port}/admin.html`));
