import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

// Render the existing customer page using a synthetic response, then remove scripts.
// This snapshot has no live booking access, active actions or external requests.
export async function bookingPreview() {
  const source=await readFile(new URL('../../hantera-bokning.html',import.meta.url),'utf8');
  let calls=0;
  const dom=new JSDOM(source,{
    url:'http://127.0.0.1:4176/hantera-bokning-demo.html#bookingId=DEMO-42&token='+'0'.repeat(64),
    runScripts:'dangerously',
    beforeParse(window){
      window.fetch=async(url,options)=>{
        if(url!=='https://xeyippgcoqfskcmqzazx.functions.supabase.co/manage-booking'||JSON.parse(options.body).action!=='details') throw new Error('Only a synthetic booking read is allowed');
        calls++;
        return {ok:true,json:async()=>({ok:true,booking:{
          id:'DEMO-42',status:'confirmed',bookingDate:'2027-04-17',bookingTime:'10:00',
          customerName:'Testkund Solvik',email:'test@example.invalid',phone:'070 000 00 00',
          address:'Testvägen 12',postalCode:'184 00 Åkersberga',housingType:'Villa',
          serviceScope:'In- och utvändig fönsterputs',windowCount:'12 fönster',transportType:'Fastland',
          price:1800,rutRequested:true,rutSubmissionReceived:false,recurrenceWeeks:8,
          capabilities:{canConfirm:false,canSubmitRut:true,canReschedule:true,canSetRecurrence:true,canCancel:true,canDownloadCalendar:true,canRebook:true}
        }})};
      };
    }
  });
  try {
    await new Promise(resolve=>setImmediate(resolve));
    const document=dom.window.document;
    if(calls!==1||document.getElementById('bookingPanel').hidden) throw new Error('Customer preview did not render');
    document.querySelectorAll('script').forEach(script=>script.remove());
    document.querySelectorAll('button').forEach(button=>{button.type='button';});
    document.querySelectorAll('input').forEach(input=>input.setAttribute('value',input.value));
    document.querySelectorAll('select').forEach(select=>{for(const option of select.options)option.toggleAttribute('selected',option.selected);});
    const banner=document.createElement('p');banner.className='preview-note';banner.setAttribute('role','note');
    banner.textContent='Förhandsgranskning · Testbokning. Knapparna är inte aktiva.';
    document.querySelector('main').prepend(banner);
    const notes=document.querySelectorAll('#bookingPanel .security-note');
    notes.forEach(note=>{note.textContent='Detta är en lokal visning med testuppgifter. Kundens riktiga bokning öppnas via den personliga länken i mejlet.';});
    return dom.serialize();
  } finally {dom.window.close();}
}

export async function rutPreview() {
  const source=await readFile(new URL('../../rut.html',import.meta.url),'utf8');
  const dom=new JSDOM(source,{
    url:'http://127.0.0.1:4176/rut-demo.html#bookingId=DEMO-42&token='+'0'.repeat(64),
    runScripts:'dangerously',
    beforeParse(window){window.fetch=async(url)=>{
      if(!url.endsWith('/rut-booking-details'))throw new Error('Only a synthetic RUT link check is allowed');
      return {ok:true,json:async()=>({ok:true})};
    };}
  });
  try {
    await new Promise(resolve=>setImmediate(resolve));
    const document=dom.window.document;
    if(document.getElementById('submitButton').disabled)throw new Error('Synthetic RUT link did not render');
    document.querySelectorAll('script').forEach(script=>script.remove());
    document.querySelectorAll('button').forEach(button=>{button.type='button';});
    document.querySelectorAll('input[type=hidden]').forEach(input=>input.value='');
    const banner=document.createElement('p');banner.className='preview-note';
    banner.textContent='Förhandsgranskning med testuppgifter. Inget skickas eller sparas.';
    document.querySelector('main').prepend(banner);
    return dom.serialize();
  } finally {dom.window.close();}
}
