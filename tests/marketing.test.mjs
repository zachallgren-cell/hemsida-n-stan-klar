import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {marketingDatabase,admin,outsider} from './helpers/marketing-db.mjs';
import {emailModule} from './helpers/email-fixtures.mjs';
const site=await readFile(new URL('../site.js',import.meta.url),'utf8');
function browser(url,referrer='',consent='accepted',stored=null){
 const dom=new JSDOM('<!doctype html><body></body>',{url,...(referrer?{referrer}:{}),runScripts:'outside-only'}),w=dom.window;
 if(consent)w.localStorage.setItem('berga_cookie_consent',consent);
 if(stored)w.sessionStorage.setItem('bergaCampaignAttribution',stored);
 w.eval(site);return {dom,w,get:()=>JSON.parse(w.sessionStorage.getItem('bergaCampaignAttribution')||'{}')};
}
test('MKT-03 UTM, external referral, internal navigation, latest source, direct return and visit expiry',()=>{
 const first=browser('https://bergafonsterputs.se/?utm_source=facebook&utm_medium=organic_social&utm_campaign=var2027&utm_content=post&utm_term=fonster');
 assert.equal(first.get().utmCampaign,'var2027');assert.equal(first.get().utmTerm,'fonster');
 const internal=browser('https://bergafonsterputs.se/bokning.html?utm_source=wrong','https://bergafonsterputs.se/priser.html','accepted',JSON.stringify(first.get()));
 assert.equal(internal.get().utmSource,'facebook');
 const direct=browser('https://bergafonsterputs.se/bokning.html','','accepted',JSON.stringify(internal.get()));assert.equal(direct.get().utmSource,'facebook');
 const latest=browser('https://bergafonsterputs.se/bokning.html','https://www.google.com/search?q=secret&token=private','accepted',JSON.stringify(direct.get()));
 assert.equal(latest.get().referrerHost,'www.google.com');assert.equal(latest.get().utmCampaign,'');assert.equal(JSON.stringify(latest.get()).includes('secret'),false);
 const expired={...first.get(),lastActivity:Date.now()-31*60*1000};
 const next=browser('https://bergafonsterputs.se/bokning.html','','accepted',JSON.stringify(expired));assert.deepEqual(next.get(),{});
 for(const b of [first,internal,direct,latest,next])b.dom.window.close();
});
test('MKT-03 no consent, withdrawal, blocked storage and unsafe incoming values never block booking',()=>{
 const denied=browser('https://bergafonsterputs.se/?utm_source=facebook','','necessary');assert.deepEqual(denied.get(),{});
 const accepted=browser('https://bergafonsterputs.se/?utm_source=facebook');accepted.w.localStorage.setItem('berga_cookie_consent','necessary');accepted.w.dispatchEvent(new accepted.w.CustomEvent('berga:consent-change',{detail:{value:'necessary'}}));assert.deepEqual(accepted.get(),{});
 const blocked=browser('https://bergafonsterputs.se/');Object.defineProperty(blocked.w,'sessionStorage',{get(){throw new Error('blocked')}});assert.deepEqual({...blocked.w.bergaAttribution.get()},{});
 const unsafe=browser('https://bergafonsterputs.se/?utm_source=user%40example.com&utm_campaign='+ 'x'.repeat(300));assert.deepEqual(unsafe.get(),{});
 for(const b of [denied,accepted,blocked,unsafe])b.dom.window.close();
});
test('MKT-03 actual server field validation on booking and spring request separates answer and consent',async()=>{
 for(const name of ['create-booking','submit-spring-pax']){
  const {marketingFields}=await emailModule(name,['marketingFields']);
  const data=marketingFields({trackingConsent:true,customerSourceAnswer:'instagram',utmSource:'facebook',utmMedium:'organic_social',utmCampaign:'var2027',utmContent:'post',utmTerm:'fönster',referrerHost:'www.google.com'});
  assert.equal(data.customer_source_answer,'instagram');assert.equal(data.utm_source,'facebook');assert.equal(data.utm_campaign,'var2027');assert.equal(data.referrer_host,'www.google.com');
  const denied=marketingFields({trackingConsent:false,customerSourceAnswer:'dont_remember',utmSource:'facebook',referrerHost:'google.com'});assert.equal(denied.customer_source_answer,'dont_remember');assert.equal(denied.utm_source,null);assert.equal(denied.referrer_host,null);
  const invalid=marketingFields({trackingConsent:true,customerSourceAnswer:'invented',utmSource:'x@example.com',utmCampaign:'x'.repeat(121),utmTerm:'0701234567',referrerHost:'https://google.com/?secret=1'});for(const key of ['customer_source_answer','utm_source','utm_campaign','utm_term','referrer_host'])assert.equal(invalid[key],null);
 }
});
test('MKT-03 SQL attribution and reporting: separate answers, paid evidence, unknown, value/RUT and booking lifecycle',async()=>{
 const c=await marketingDatabase();try{
  await c.insert(1,{utm_source:'facebook',utm_medium:'paid_social',utm_campaign:'var2027',customer_source_answer:'instagram',tracking_consent:true});
  await c.insert(2,{referrer_host:'www.google.com',price_before_rut:3750});
  await c.insert(3,{customer_source_answer:'recommendation'});await c.insert(4,{customer_source_answer:'dont_remember'});await c.insert(5,{price_before_rut:null});
  await c.insert(6,{status:'awaiting_confirmation'});await c.insert(7,{status:'cancelled'});
  await c.insert(8,{email:'test1@example.invalid',status:'completed',created_at:'2026-11-03T10:00:00Z'});
  const campaignOnly=(await c.db.query("select private.marketing_attribution('{\"utm_campaign\":\"explicit_campaign\",\"customer_source_answer\":\"facebook\"}'::jsonb) result")).rows[0].result;
  const paidReferral=(await c.db.query("select private.marketing_attribution('{\"referrer_host\":\"www.google.com\",\"utm_medium\":\"cpc\"}'::jsonb) result")).rows[0].result;
  assert.equal(paidReferral.traffic,'Betald');
  assert.equal(campaignOnly.campaign,'explicit_campaign');assert.equal(campaignOnly.source,'facebook');assert.match(campaignOnly.basis,/Självrapporterat/);
  const attr=id=>c.as(admin,'aal2',()=>c.rpc('marketing_booking',[id]));
  assert.equal((await attr(1)).source,'facebook');assert.equal((await attr(1)).traffic,'Betald');assert.equal((await attr(1)).campaign,'var2027');
  assert.equal((await attr(2)).traffic,'Betald/organisk okänd');assert.equal((await attr(2)).campaign,null);
  assert.equal((await attr(3)).basis,'Självrapporterat');assert.equal((await attr(4)).source,'unknown');assert.equal((await attr(5)).source,'unknown');
  let report=await c.report();assert.equal(report.bookings,6);assert.equal(report.unique_customers,5);assert.equal(report.missing_value,1);assert.equal(report.revenue_ex_vat,11000);assert.equal(report.rows.reduce((n,r)=>n+r.returning_customers,0),1);
  await c.db.exec("update bookings set booking_date='2027-04-20',price_before_rut=5000 where id=1");
  report=await c.report();assert.equal(report.bookings,6);assert.equal(report.revenue_ex_vat,13000);
  await c.db.exec("update bookings set status='cancelled' where id=1");report=await c.report();assert.equal(report.bookings,5);assert.equal(report.revenue_ex_vat,9000);
  // Date boundary is Swedish time, not job date or UTC date.
  await c.insert(9,{created_at:'2026-10-31T23:30:00Z'});report=await c.report();assert.equal(report.bookings,6);
 }finally{await c.db.close();}
});
test('MKT-03 manual inquiry becomes one booking; originals, audit, revisions and permissions',async()=>{
 const c=await marketingDatabase();try{
  await c.insert(1,{utm_source:'google',utm_medium:'organic',utm_campaign:'original'});
  const save=args=>c.as(admin,'aal2',()=>c.rpc('marketing_save',args));
  let entry=await save([null,0,null,'TEST mejlförfrågan','facebook','flyer2027','email','Kunden berättade per mejl']);
  assert.equal((await c.report()).bookings,1);
  entry=await save([entry.id,entry.revision,1,entry.label,'facebook','flyer2027','email','Förfrågan blev bokning 1']);
  let attr=await c.as(admin,'aal2',()=>c.rpc('marketing_booking',[1]));assert.equal(attr.source,'facebook');assert.equal(attr.basis,'Manuellt registrerat');assert.equal(attr.route,'email');assert.equal((await c.report()).bookings,1);
  assert.equal((await c.db.query('select utm_campaign from bookings where id=1')).rows[0].utm_campaign,'original');
  await assert.rejects(()=>save([entry.id,1,1,'','instagram',null,'phone','Gammal revision']),/Ladda om/);
  await assert.rejects(()=>save([null,0,1,'','tiktok',null,'phone','Dubbel koppling']),/unique/i);
  const history=await c.as(admin,'aal2',()=>c.rpc('marketing_list',[1]));assert.equal(history.audit.length,2);assert.equal(history.audit[0].actor,admin);
  await save([entry.id,entry.revision,1,entry.label,null,null,'email','Ta bort felaktig tillskrivning']);attr=await c.as(admin,'aal2',()=>c.rpc('marketing_booking',[1]));assert.equal(attr.source,'google');
  for(const [id,aal,role] of [[outsider,'aal2','authenticated'],[admin,'aal1','authenticated'],[admin,null,'authenticated'],[null,null,'anon']]){
   for(const [rpc,args] of [['marketing_list',[]],['marketing_report',['2026-11-01','2026-11-30']],['marketing_booking',[1]],['marketing_save',[null,0,null,'','google',null,'phone','TEST ändring']]])await assert.rejects(()=>c.as(id,aal,()=>c.rpc(rpc,args),role));
  }
  await assert.rejects(()=>c.as(admin,'aal2',()=>c.db.exec("update marketing_entries set source='tiktok'")),/permission denied/);
  await assert.rejects(()=>c.as(admin,'aal2',()=>c.db.exec('delete from marketing_audit')),/permission denied/);
 }finally{await c.db.close();}
});
test('MKT-03 spring invitation transfers source once; newer booking attribution takes precedence',async()=>{
 const c=await marketingDatabase();try{
  const pax=crypto.randomUUID();await c.db.query("insert into spring_2027_reservations(id,customer_source_answer,utm_source,utm_campaign) values($1,'instagram','facebook','spring2027')",[pax]);
  await c.insert(1);await c.insert(2,{utm_source:'google',utm_campaign:'newer'});
  for(const id of [1,2]){await c.db.query('insert into booking_invitations(id,spring_reservation_id) values($1,$2)',[id,pax]);await c.db.query('update booking_invitations set booking_id=$1 where id=$2',[String(id),id]);}
  const rows=(await c.db.query('select id,utm_source,utm_campaign,customer_source_answer from bookings order by id')).rows;
  assert.equal(rows[0].utm_source,'facebook');assert.equal(rows[0].customer_source_answer,'instagram');assert.equal(rows[1].utm_source,'google');assert.equal(rows[1].utm_campaign,'newer');assert.equal((await c.report()).bookings,2);
 }finally{await c.db.close();}
});
