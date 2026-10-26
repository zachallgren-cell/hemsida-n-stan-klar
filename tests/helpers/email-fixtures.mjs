// Render real local templates with synthetic values, without executing handlers or making requests.
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { readJsonWithLimit, InvalidJsonBodyError, RequestBodyTooLargeError } from '../../supabase/functions/_shared/read-json.ts';
import { emailDocument } from '../../supabase/functions/_shared/email-presentation.ts';
export const escapeHtml = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export async function emailModule(name, exports, extra = {}) {
  const source = await readFile(new URL(`../../supabase/functions/${name}/index.ts`, import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.replace(/^import\s[\s\S]*?;\n/gm, ''));
  return runInNewContext(`${code}\n;({${exports.join(',')}})`, { emailDocument, readJsonWithLimit, InvalidJsonBodyError, RequestBodyTooLargeError, Deno:{serve(){}}, URL, Response, Headers, TextEncoder, crypto, console, fetch(){throw new Error('External calls disabled in email preview');}, ...extra });
}
async function template(name, variable, values) {
  const source = await readFile(new URL(`../../supabase/functions/${name}/index.ts`, import.meta.url), 'utf8');
  const start = source.indexOf(`const ${variable} = \``) + `const ${variable} = `.length;
  const end = source.indexOf('\n    `;', start) + 6;
  if (start < 10 || end < start) throw new Error(`Template boundary missing: ${name}`);
  return runInNewContext(source.slice(start,end), {escapeHtml,...values});
}
export async function emailFixtures() {
  const contact='test@example.invalid';
  const row={id:42,customer_name:'Testkund & Familj',email:contact,booking_date:'2027-04-17',booking_time:'10:00',address:'Testvägen 12, Åkersberga',service_scope:'In- och utvändigt',window_count:12,price:1800};
  const link='https://example.invalid/hantera-bokning.html?token=TEST%2B123&booking=42';
  const tableRow='<tr><td style="padding:8px 0;">Datum</td><td style="padding:8px 0;text-align:right;">17 april 2027, 10:00</td></tr>';
  const booking=await template('create-booking','customerEmailHtml',{
    payload:{name:row.customer_name},safeLogoUrl:'/logo-compact.png',safeContactEmail:contact,
    confirmationSection:`<p>Bekräfta bokningen för att behålla din tid.</p><p><a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 20px;background:#0b6fa4;color:white;border-radius:12px;">Bekräfta bokningen</a></p>`,
    customerDetailRows:tableRow,customerPriceDisplay:'1 800 kr',customerPriceLabel:'Att betala efter RUT',laborCostBeforeRutDisplay:'3 200 kr',laborCostLabel:'Arbetskostnad före RUT',materialCostDisplay:'200 kr',transportCostDisplay:'0 kr',priceBeforeRutDisplay:'3 400 kr',priceSectionTitle:'Prisöversikt',rutDeductionDisplay:'1 600 kr',rutFormSection:'<p>RUT-uppgifter lämnas via det säkra formuläret.</p>',safeOriginalPriceDisplay:'1 800 kr',appliedDiscount:false,safeDiscountCode:'',safeDiscountDisplay:''
  });
  const complete=await template('complete-booking','emailHtml',{
    booking:row,safeLogoUrl:'/logo-compact.png',safeContactEmail:contact,isAlreadyPaid:false,
    swishPaymentSection:'<p style="color:white;">Testnummer: 123 000 00 00<br>Referens: TEST-42<br>Belopp: 1 800 kr</p>',priceAfterRutDisplay:'1 800 kr',priceRows:'<tr><td>Arbetskostnad efter RUT</td><td>1 600 kr</td></tr><tr><td>Material</td><td>200 kr</td></tr>',detailRows:tableRow,workRows:'<tr><td>12 fönster, in- och utvändigt</td></tr>',reviewSection:''
  });
  const manage=await emailModule('manage-booking',['customerEmailHtml']);
  const reminders=await emailModule('send-booking-reminders',['buildReminderEmail']);
  const reminder=reminders.buildReminderEmail(row,contact);
  const spring = await springEmailFixtures();
  return [
    ...spring.map((mail,index)=>({id:`pax-${index}`,title:index ? 'Kvitto på vårpaxning' : 'Admin: ny vårpaxning',html:mail.html})),
    {id:'bokning',title:'Bokningsmejl',html:emailDocument(booking)},
    {id:'klart',title:'Klartmejl och betalning',html:emailDocument(complete)},
    {id:'andring',title:'Ändrad bokning',html:emailDocument(manage.customerEmailHtml('Din bokning är uppdaterad','Vi har ändrat din bokning enligt ditt önskemål.',row,link,true))},
    {id:'paminnelse',title:'Påminnelse inför besöket',html:emailDocument(reminder.html)}
  ];
}

export async function springEmailFixtures() {
  let handler;
  const emails=[];
  const env={SUPABASE_URL:'https://database.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-key',RESEND_API_KEY:'test-key',BOOKING_FROM_EMAIL:'Berga <test@example.invalid>',BOOKING_NOTIFICATION_EMAIL:'admin@example.invalid',BOOKING_CONTACT_EMAIL:'test@example.invalid'};
  await emailModule('submit-spring-pax',[],{
    Deno:{env:{get:key=>env[key]},serve:fn=>{handler=fn;}},
    fetch:async(url,options)=>{
      if(url==='https://api.resend.com/emails') { emails.push({...JSON.parse(options.body),key:options.headers['Idempotency-Key']});return Response.json({id:'test-email'}); }
      if(url.startsWith(env.SUPABASE_URL+'/rest/v1/rpc/')) return Response.json(true);
      if(url.startsWith(env.SUPABASE_URL+'/rest/v1/spring_2027_reservations?')) return Response.json([{id:42}]);
      throw new Error('Unexpected request in isolated email fixture');
    }
  });
  const response=await handler(new Request('https://example.invalid/submit-spring-pax',{method:'POST',headers:{origin:'https://bergafonsterputs.se','content-type':'application/json'},body:JSON.stringify({requestId:'d92f535e-89b3-445a-afb7-631818ebced5',formStartedAt:String(Date.now()-5000),name:'Testkund & Familj',email:'test@example.invalid',phone:'0701234567',location:'Åkersberga',requestedPeriod:'april',serviceInterest:'interior_exterior',message:'Test <innehåll> & erfarenhet'})}));
  if(response.status!==200 || emails.length!==2) throw new Error(`Synthetic reservation failed: ${response.status} ${await response.text()}`);
  return emails;
}
