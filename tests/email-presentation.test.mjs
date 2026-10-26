import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import {emailDocument} from '../supabase/functions/_shared/email-presentation.ts';
import {emailFixtures,springEmailFixtures} from './helpers/email-fixtures.mjs';
test('email frame preserves escaped customer content, amounts and signed links verbatim',()=>{
 const content='<h1>Hej Test &amp; Familj</h1><p>1 800 kr • TEST-42</p><a href="https://example.invalid/?token=TEST%2B123&amp;booking=42">Öppna</a><p>&lt;script&gt;test&lt;/script&gt;</p>';
 const html=emailDocument(content,true);
 assert.ok(html.includes(content));
 const document=new JSDOM(html).window.document;
 assert.equal(document.querySelector('html').lang,'sv');
 assert.equal(document.querySelectorAll('html').length,1);
 assert.equal(document.querySelector('a').href,'https://example.invalid/?token=TEST%2B123&booking=42');
 assert.equal(document.querySelectorAll('script').length,0);
 assert.match(document.body.textContent,/1 800 kr • TEST-42/);
});
test('existing full email keeps its preheader and metadata without a second document',()=>{
 const original='<!doctype html><html lang="sv"><head><title>Påminnelse</title></head><body><div hidden>Inför besöket</div><p>Detaljer</p></body></html>';
 const html=emailDocument(original);
 assert.equal((html.match(/<!doctype/gi)||[]).length,1);
 assert.equal(new JSDOM(html).window.document.title,'Påminnelse');
 assert.ok(html.includes('<div hidden>Inför besöket</div>'));
});
test('real customer templates render dates, RUT and payment details with usable links',async()=>{
 const mails=await emailFixtures();assert.equal(mails.length,6);
 for(const mail of mails){
  const document=new JSDOM(mail.html).window.document;
  assert.equal(document.querySelectorAll('h1').length,1,mail.id);
  assert.equal(document.querySelectorAll('script').length,0,mail.id);
  assert.ok(document.querySelector('meta[name="viewport"]'),mail.id);
  assert.doesNotMatch(document.body.textContent,/undefined|\[object Object\]/,mail.id);
 }
 const complete=new JSDOM(mails.find(x=>x.id==='klart').html).window.document;
 assert.match(complete.body.textContent,/TEST-42/);assert.match(complete.body.textContent,/1 800 kr/);
 const booking=new JSDOM(mails.find(x=>x.id==='bokning').html).window.document;
 assert.match(booking.body.textContent,/RUT/);
 assert.equal(booking.querySelector('a[href*="token="]').getAttribute('href'),'https://example.invalid/hantera-bokning.html?token=TEST%2B123&booking=42');
});
test('actual reservation sender keeps recipients, reply-to, idempotency and escaping',async()=>{
 const [admin,customer]=await springEmailFixtures();
 assert.deepEqual(Array.from(admin.to),['admin@example.invalid']);assert.deepEqual(Array.from(customer.to),['test@example.invalid']);
 assert.equal(admin.reply_to,'test@example.invalid');
 assert.equal(admin.key,'spring-2027-admin-d92f535e-89b3-445a-afb7-631818ebced5');
 assert.match(customer.key,/d92f535e-89b3-445a-afb7-631818ebced5$/);
 assert.ok(admin.html.includes('Test &lt;innehåll&gt; &amp; erfarenhet'));
 assert.match(new JSDOM(customer.html).window.document.body.textContent,/inte bindande/);
});
