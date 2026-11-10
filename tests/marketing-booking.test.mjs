import test from 'node:test';
import assert from 'node:assert/strict';
import {emailModule} from './helpers/email-fixtures.mjs';
import {marketingDatabase,admin} from './helpers/marketing-db.mjs';
test('MKT-03 actual create-booking handler writes UTM, referral or no-consent data and independent answer into PostgreSQL',async()=>{
 const c=await marketingDatabase();let handler,nextId=0,mailCount=0;
 class TestDate extends Date{constructor(...args){super(...(args.length?args:['2026-11-02T12:00:00Z']));}static now(){return new Date('2026-11-02T12:00:00Z').getTime();}}
 const env={SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'TEST',RESEND_API_KEY:'TEST',BOOKING_FROM_EMAIL:'test@example.invalid',BOOKING_NOTIFICATION_EMAIL:'admin@example.invalid',PUBLIC_SITE_URL:'https://example.invalid'};
 try{
 await emailModule('create-booking',[],{URLSearchParams,Date:TestDate,Deno:{env:{get:k=>env[k]},serve:fn=>handler=fn},fetch:async(url,options={})=>{
  const body=options.body?JSON.parse(options.body):null;
  if(url==='https://api.resend.com/emails'){mailCount++;return Response.json({id:'TEST'});}
  if(url.includes('/rpc/consume_booking_rate_limit'))return Response.json(true);
  if(url.includes('/booking_invitations?'))return Response.json(url.includes('token_hash=')?[{id:1,email:'test@example.invalid',invitation_type:'spring_priority',window_start:'2027-03-01',window_end:'2027-06-15',expires_at:'2027-06-16',status:'active'}]:[]);
  if(url.includes('/booking_blocked_dates?')||url.includes('/booking_capacity_overrides?'))return Response.json([]);
  if(url.includes('/bookings?') && options.method==='POST'){
   nextId++;const keys=['utm_source','utm_medium','utm_campaign','utm_content','utm_term','attribution_ref','customer_source_answer','referrer_host','tracking_consent','price_before_rut'];
   await c.insert(nextId,{status:'awaiting_confirmation',...Object.fromEntries(keys.map(k=>[k,body[k]]))});return Response.json([{id:nextId}]);
  }
  if(url.includes('/bookings?'))return Response.json([]);
  if(url.endsWith('/rpc/finalize_booking_invitation')){await c.db.query("update bookings set status='confirmed' where id=$1",[nextId]);return Response.json(true);}
  throw new Error('Unexpected '+url);
 }});
 const payload={name:'TEST Kund',email:'test@example.invalid',phone:'0700000000',boatSize:'En våning',housingType:'En våning',rutChoice:'Nej, jag vill inte använda RUT-avdrag',windowCount:'10 fönster totalt',serviceScope:'Invändig + utvändig',addons:'8 utan spröjs, 2 med spröjs, 0 extra fönster',transportType:'Fastland',date:'2027-04-10',time:'10:00',location:'Testvägen 1',postalCode:'18400',invitationToken:'a'.repeat(43),consentAccepted:true,formStartedAt:String(TestDate.now()-10000)};
 const scenarios=[{trackingConsent:true,utmSource:'facebook',utmMedium:'organic_social',utmCampaign:'var2027',customerSourceAnswer:'instagram'}, {trackingConsent:true,referrerHost:'www.google.com'}, {trackingConsent:false,utmSource:'facebook',utmCampaign:'discarded',customerSourceAnswer:'dont_remember'}, {trackingConsent:false}];
 for(const scenario of scenarios){const response=await handler(new Request('https://example.invalid',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...payload,...scenario})}));assert.equal(response.status,200,await response.clone().text());}
 const rows=(await c.db.query('select * from bookings order by id')).rows;
 assert.equal(rows[0].utm_source,'facebook');assert.equal(rows[0].customer_source_answer,'instagram');assert.equal(rows[0].utm_campaign,'var2027');assert.equal(rows[1].referrer_host,'www.google.com');assert.equal(rows[2].utm_source,null);assert.equal(rows[2].utm_campaign,null);assert.equal(rows[2].customer_source_answer,'dont_remember');assert.equal(rows[3].customer_source_answer,null);
 assert.equal((await c.as(admin,'aal2',()=>c.rpc('marketing_report',['2026-11-01','2026-11-30']))).bookings,4);assert.equal(mailCount,8);
 }finally{await c.db.close();}
});
