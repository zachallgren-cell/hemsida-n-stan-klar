import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';
import {marketingDatabase,admin} from './helpers/marketing-db.mjs';
const source=await readFile(new URL('../marketing-admin.js',import.meta.url),'utf8');
const ticks=()=>new Promise(r=>setTimeout(r,20));
test('MKT-03 admin UI saves inquiries, links bookings, renders original data and refreshes reporting',async()=>{
 const c=await marketingDatabase(),dom=new JSDOM('<div data-marketing-panel></div><section id="booking"></section>',{url:'https://example.invalid',runScripts:'outside-only'}),w=dom.window;
 const calls=[];
 const args={marketing_list:['p_booking_id'],marketing_booking:['p_booking_id'],marketing_report:['p_start','p_end'],marketing_save:['p_id','p_revision','p_booking_id','p_label','p_source','p_campaign','p_route','p_reason']};
 let queue=Promise.resolve();
 const client={rpc(name,values={}){calls.push({name,values});const next=queue.then(async()=>{try{return {data:await c.as(admin,'aal2',()=>c.rpc(name,args[name].map(k=>values[k]??null)))}}catch(e){return {error:{message:e.message}}}});queue=next.catch(()=>{});return next;}};
 try{
  await c.insert(1,{utm_source:'google',utm_campaign:'auto_campaign',customer_source_answer:'instagram'});
  w.eval(source);w.bergaMarketingAdmin.init({supabase:client});
  const panel=w.document.querySelector('[data-marketing-panel]');
  function change(form,name,value){form.elements.namedItem(name).value=value;}
  async function submit(form){form.dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await queue;await ticks();await queue;await ticks();}
  let form=panel.querySelector('[data-marketing-new] form');change(form,'label','TEST <script>');change(form,'source','facebook');change(form,'campaign','flyer2027');change(form,'route','phone');change(form,'reason','Kunden ringde');await submit(form);
  assert.equal((await c.db.query('select count(*) n from marketing_entries')).rows[0].n,1);assert.equal(panel.querySelector('[data-marketing-entries] script'),null);
  form=panel.querySelector('[data-marketing-entries] form');change(form,'bookingId','1');change(form,'reason','Koppla till bokning');await submit(form);
  assert.equal((await c.db.query('select booking_id from marketing_entries')).rows[0].booking_id,1);
  await w.bergaMarketingAdmin.mountBooking({element:w.document.getElementById('booking'),booking:{id:1,utm_source:'google',utm_campaign:'auto_campaign',customer_source_answer:'instagram'}});
  assert.match(w.document.getElementById('booking').textContent,/Instagram/);assert.match(w.document.getElementById('booking').textContent,/auto_campaign/);assert.match(w.document.getElementById('booking').textContent,/Manuellt registrerat/);
  assert.equal(w.document.querySelector('#booking [name="bookingId"]').readOnly,true);
  change(panel.querySelector('[data-marketing-filters]'),'marketingStart','2026-11-01');change(panel.querySelector('[data-marketing-filters]'),'marketingEnd','2026-11-30');await submit(panel.querySelector('[data-marketing-filters]'));
  assert.match(panel.querySelector('[data-marketing-report]').textContent,/1 bekräftade bokningar/);assert.match(panel.querySelector('[data-marketing-report]').textContent,/flyer2027/);
  assert.equal(calls.find(c=>c.name==='marketing_report').values.p_start,'2026-11-01');
  // Saving a second request creates one new record, not duplicate linked bookings.
  form=panel.querySelector('[data-marketing-new] form');change(form,'source','instagram');change(form,'reason','Kunden skrev');await submit(form);assert.equal((await c.db.query('select count(*) n from marketing_entries')).rows[0].n,2);
 }finally{dom.window.close();await c.db.close();}
});
test('MKT-03 optional question exists in both public forms; server errors keep entered answers',async()=>{
 const dom=new JSDOM(await readFile(new URL('../bokning.html',import.meta.url),'utf8'));
 for(const id of ['customerSourceAnswer','paxCustomerSourceAnswer']){
  const field=dom.window.document.getElementById(id);assert.ok(field);assert.equal(field.required,false);assert.equal(field.options.length,9);assert.equal(field.options[0].value,'');assert.equal(field.options[8].value,'dont_remember');
 }
 dom.window.close();
 const d=new JSDOM('<div data-marketing-panel></div>',{runScripts:'outside-only',url:'https://example.invalid'});d.window.eval(source);d.window.bergaMarketingAdmin.init({supabase:{rpc:async()=>({error:{message:'TEST server error'}})}});
 const form=d.window.document.querySelector('[data-marketing-new] form');form.elements.source.value='facebook';form.elements.reason.value='Kunden berättade';form.dispatchEvent(new d.window.Event('submit',{cancelable:true}));await ticks();assert.equal(form.elements.source.value,'facebook');assert.match(form.textContent,/TEST server error/);assert.equal(form.querySelector('button').disabled,false);d.window.close();
});
