/* MKT-03: booking attribution and reporting stay separate from visitor analytics. */
(() => {
  'use strict';
  const labels = {google:'Google',instagram:'Instagram',facebook:'Facebook',tiktok:'TikTok',recommendation:'Rekommendation från någon',in_person:'Såg er på plats, på bilen eller på ett event',other:'Annat',dont_remember:'Minns inte',unknown:'Okänd källa'};
  const routes = {unknown:'Okänd bokningsväg',website:'Hemsida',phone:'Telefon',email:'Mejl',message:'Meddelande',other:'Annat'};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => value == null ? 'Värde saknas' : new Intl.NumberFormat('sv-SE',{style:'currency',currency:'SEK',maximumFractionDigits:2}).format(value);
  const select = (items,value) => Object.entries(items).map(([key,label])=>`<option value="${esc(key)}" ${value===key?'selected':''}>${esc(label)}</option>`).join('');
  let client;
  async function rpc(name, args) {
    const {data,error} = await client.rpc(name,args);
    if(error) throw new Error(/function.*does not exist|schema cache/i.test(error.message) ? 'MKT-03 är inte installerat i databasen ännu.' : error.message);
    return data;
  }
  function editor(entry={},bookingId=null) {
    return `<form data-marketing-editor class="marketing-editor" data-entry="${esc(entry.id || '')}" data-revision="${esc(entry.revision || 0)}">
      <p>Manuell källa ersätter rapportens val. Originaluppgifterna bevaras. Lämna källa och kampanj tomma för att återgå till automatisk källa eller kundens svar.</p>
      <div class="booking-grid">
      <label>Förfrågans referens (valfritt)<input name="label" maxlength="120" value="${esc(entry.label || '')}" placeholder="Till exempel offertens referens"></label>
      <label>Boknings-ID att koppla till<input name="bookingId" inputmode="numeric" pattern="[0-9]+" value="${esc(bookingId || entry.booking_id || '')}" ${bookingId || entry.booking_id ? 'readonly' : ''}><small>Lämna tomt för en förfrågan. Koppla till befintligt ID när den blivit bokning.</small></label>
      <label>Kundkälla, manuellt<input name="source" maxlength="120" list="marketing-source-options" value="${esc(entry.source || '')}" placeholder="Till exempel facebook"><small>unknown = uttryckligen okänd källa.</small></label>
      <label>Kampanj, manuellt<input name="campaign" maxlength="120" value="${esc(entry.campaign || '')}"></label>
      <label>Bokningsväg<select name="route">${select(routes,entry.route || (bookingId ? 'website' : 'phone'))}</select></label>
      <label>Ändringsorsak<input name="reason" minlength="3" maxlength="300" required placeholder="Vad bygger uppgiften på?"></label>
      </div><button class="button button-primary" type="submit">Spara källa och bokningsväg</button><p role="status" data-marketing-status></p>
    </form>`;
  }
  async function bindEditor(element,onSaved) {
    const form=element.querySelector('[data-marketing-editor]');
    form?.addEventListener('submit',async event=>{
      event.preventDefault(); if(!form.reportValidity()) return;
      const values=new FormData(form),status=form.querySelector('[data-marketing-status]'),button=form.querySelector('button');
      if(values.get('campaign').trim() && !values.get('source').trim()){status.textContent='Ange källa tillsammans med manuell kampanj.';return;}
      button.disabled=true;
      try {
        await rpc('marketing_save',{p_id:form.dataset.entry || null,p_revision:Number(form.dataset.revision),p_booking_id:values.get('bookingId') || null,p_label:values.get('label'),p_source:values.get('source'),p_campaign:values.get('campaign'),p_route:values.get('route'),p_reason:values.get('reason')});
        status.textContent='Sparat.';await onSaved();
      } catch(error){ status.textContent='Kunde inte spara: '+error.message; }
      finally {button.disabled=false;}
    });
  }
  function auditHtml(audit) {
    return `<details><summary>Ändringshistorik (${audit.length})</summary>${audit.map(a=>`<p>${esc(new Date(a.occurred_at).toLocaleString('sv-SE',{timeZone:'Europe/Stockholm'}))} · Admin ${esc(a.actor)}<br>${esc(a.reason)}<br>Före: ${esc(a.old_value?.source || 'Ingen manuell källa')} / ${esc(a.old_value?.campaign || 'Ingen kampanj')} → Efter: ${esc(a.new_value?.source || 'Ingen manuell källa')} / ${esc(a.new_value?.campaign || 'Ingen kampanj')} · Bokningsväg ${esc(routes[a.old_value?.route] || 'Ej registrerad')} → ${esc(routes[a.new_value?.route] || 'Ej registrerad')} · Bokning ${esc(a.new_value?.booking_id || 'Ej kopplad')}</p>`).join('')}</details>`;
  }
  async function mountBooking({element,booking}) {
    if(!element)return;
    element.innerHTML='<h4>Kundkälla och kampanj</h4><p role="status">Hämtar källuppgifter…</p>';
    try {
      const [record,attribution]=await Promise.all([rpc('marketing_list',{p_booking_id:booking.id}),rpc('marketing_booking',{p_booking_id:booking.id})]);
      element.innerHTML=`<h4>Kundkälla och kampanj</h4><dl class="marketing-facts">
       <dt>Kundens svar</dt><dd>${esc(labels[booking.customer_source_answer] || 'Obesvarat')}</dd>
       <dt>Automatisk källa</dt><dd>${esc(booking.utm_source || booking.referrer_host || (booking.attribution_ref==='referral'?'Rekommendationslänk':'Saknas'))}</dd>
       <dt>Automatiskt medium</dt><dd>${esc(booking.utm_medium || 'Saknas')}</dd>
       <dt>Automatisk kampanj</dt><dd>${esc(booking.utm_campaign || 'Saknas')}</dd>
       <dt>UTM content / term</dt><dd>${esc(booking.utm_content || 'Saknas')} / ${esc(booking.utm_term || 'Saknas')}</dd>
       <dt>Rapportkälla och underlag</dt><dd>${esc(labels[attribution.source] || attribution.source)} · ${esc(attribution.basis)} · ${esc(attribution.traffic)}</dd>
       <dt>Rapportkampanj</dt><dd>${esc(attribution.campaign || 'Ingen tillskriven kampanj')}</dd>
       <dt>Bokningsväg</dt><dd>${esc(routes[attribution.route] || attribution.route)}</dd></dl>
       ${editor(record.entries[0] || {route:attribution.route},booking.id)}${auditHtml(record.audit)}`;
      bindEditor(element,()=>mountBooking({element,booking}));
    }catch(error){element.innerHTML=`<h4>Kundkälla och kampanj</h4><p role="status">${esc(error.message)}</p>`;}
  }
  async function loadEntries(panel) {
    const holder=panel.querySelector('[data-marketing-entries]');
    try {
      const data=await rpc('marketing_list',{});
      holder.innerHTML=data.entries.length?data.entries.map(entry=>`<details><summary>${esc(entry.label || 'Manuell registrering')} · ${esc(entry.booking_id ? 'Bokning '+entry.booking_id : 'Förfrågan – ej räknad som bokning')} · ${esc(labels[entry.source] || entry.source || 'Ingen manuell källa')}</summary><div data-marketing-entry>${editor(entry)}${auditHtml(data.audit.filter(a=>a.entry_id===entry.id))}</div></details>`).join(''):'<p>Inga manuella källregistreringar.</p>';
      holder.querySelectorAll('[data-marketing-entry]').forEach(el=>bindEditor(el,()=>loadEntries(panel)));
    }catch(error){holder.textContent=error.message;}
  }
  async function report(panel) {
    const status=panel.querySelector('[data-marketing-report-status]'),holder=panel.querySelector('[data-marketing-report]');
    status.textContent='Hämtar bokningar…';
    try {
      const data=await rpc('marketing_report',{p_start:panel.querySelector('[name="marketingStart"]').value,p_end:panel.querySelector('[name="marketingEnd"]').value});
      holder.innerHTML=`<p><strong>${esc(data.bookings)} bekräftade bokningar</strong> · ${esc(data.unique_customers)} unika kunder med identifierbar mejladress · ${esc(money(data.revenue_ex_vat))} exkl. moms</p>
       <p>${esc(data.missing_value)} bokningar saknar säkert värde. ${esc(data.customers_without_identity)} bokningar saknar kundidentitet.</p>
       <div class="marketing-table"><table><thead><tr><th>Källa</th><th>Kampanj</th><th>Underlag</th><th>Bokningar</th><th>Värde exkl. moms</th><th>Bokningar: ny kund*</th><th>Bokningar: återkommande kund*</th><th>Kundtyp okänd</th></tr></thead><tbody>${data.rows.map(row=>`<tr><td>${esc(labels[row.source] || row.source)}</td><td>${esc(row.campaign || 'Ingen tillskriven kampanj')}</td><td>${esc(row.basis)}</td><td>${esc(row.bookings)}</td><td>${esc(money(row.revenue_ex_vat))}${row.missing_value?' (värden saknas)':''}</td><td>${esc(row.new_customers)}</td><td>${esc(row.returning_customers)}</td><td>${esc(row.unknown_customer_type)}</td></tr>`).join('')}</tbody></table></div>`;
      status.textContent=data.rows.length?'Uppdaterad från bokningarnas aktuella status och pris.':'Inga bekräftade bokningar i perioden.';
    }catch(error){status.textContent=error.message;holder.replaceChildren();}
  }
  function init({supabase}) {
    client=supabase;
    const panel=document.querySelector('[data-marketing-panel]');if(!panel)return;
    const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm'}).format(new Date());
    panel.innerHTML=`<h3>Kundkällor och kampanjer</h3><p>Datumfilter: <strong>när bokningen skapades</strong>, svensk tid. Bekräftade och utförda jobb räknas; avbokade och obekräftade räknas bort. Värdet inkluderar RUT-delen, exklusive moms.</p>
     <form data-marketing-filters class="marketing-filters"><label>Från<input type="date" name="marketingStart" value="${today.slice(0,4)}-01-01" required></label><label>Till<input type="date" name="marketingEnd" value="${today}" required></label><button class="button button-primary">Visa bokningsrapport</button></form>
     <p role="status" data-marketing-report-status>Välj Visa bokningsrapport.</p><div data-marketing-report></div>
     <p>* Kundtyp gäller varje bokning och bygger på tidigare bekräftade jobb med samma normaliserade mejladress i registrerad historik. Ny betyder första registrerade bokningen. Unika kunder avser mejladresser och kan underskatta personer som delar adress eller överskatta personer som byter adress. Summera inte unika kunder mellan kanaler.</p>
     <details><summary>Registrera telefon-, mejl- eller meddelandeförfrågan</summary><div data-marketing-new>${editor()}</div></details>
     <button type="button" class="button button-secondary" data-marketing-load>Hämta manuella förfrågningar och källor</button><div data-marketing-entries></div>
     <datalist id="marketing-source-options">${Object.entries(labels).filter(([key])=>key!=='dont_remember').map(([key,label])=>`<option value="${key}">${esc(label)}</option>`).join('')}</datalist>`;
    panel.querySelector('[data-marketing-filters]').addEventListener('submit',event=>{event.preventDefault();if(event.target.reportValidity())report(panel);});
    panel.querySelector('[data-marketing-load]').addEventListener('click',()=>loadEntries(panel));
    function mountNew() {
      const target=panel.querySelector('[data-marketing-new]');target.innerHTML=editor();
      bindEditor(target,async()=>{mountNew();await loadEntries(panel);});
    }
    mountNew();

  }
  window.bergaMarketingAdmin={init,mountBooking};
})();
