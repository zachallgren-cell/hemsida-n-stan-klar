import {INTERVIEW_STYLES,validateInterview,interviewEmail,interviewDate,escapeHtml as e} from './interview-shared.mjs?v=20261027';
const columns='id,application_id,created_at,starts_at,duration_minutes,location,message,style,name,email,delivery_status,sent_at,response,responded_at';
export function mountInterviews({root,row,supabase,isCurrent,onBusy}) {
  let requestId=crypto.randomUUID(), sending=false, existing=null;
  root.innerHTML=`<h3>Bjud in till arbetsintervju</h3><p>Skicka till <strong>${e(row.answers?.email)}</strong>. Kandidaten svarar ja eller nej via en personlig länk.</p><div data-interview-history role="status">Hämtar inbjudningar…</div><form data-interview-form><fieldset disabled><div class="job-grid"><div class="job-field"><label for="interviewDate">Datum</label><input id="interviewDate" name="date" type="date" required></div><div class="job-field"><label for="interviewTime">Tid (Sverige)</label><input id="interviewTime" name="time" type="time" required></div><div class="job-field"><label for="interviewDuration">Längd</label><select id="interviewDuration" name="duration_minutes">${[15,30,45,60,90].map(n=>`<option value="${n}" ${n===30?'selected':''}>${n} minuter</option>`).join('')}</select></div><div class="job-field"><label for="interviewStyle">Mailmall</label><select id="interviewStyle" name="style">${Object.entries(INTERVIEW_STYLES).map(([key,style])=>`<option value="${key}">${style.label}</option>`).join('')}</select></div><div class="job-field job-wide"><label for="interviewLocation">Plats eller möteslänk</label><input id="interviewLocation" name="location" maxlength="500" required placeholder="Exempel: Kontoret, Storgatan 1, Åkersberga"></div><div class="job-field job-wide"><label for="interviewMessage">Personligt tillägg (valfritt)</label><textarea id="interviewMessage" name="message" rows="3" maxlength="2000" placeholder="Exempel: Du behöver inte förbereda något. Ta gärna med dina frågor!"></textarea></div></div></fieldset><p data-interview-message role="status" tabindex="-1"></p><div class="recruitment-actions"><button type="button" data-interview-preview disabled>Förhandsvisa mail</button><button type="submit" class="btn" data-interview-send disabled>Skicka intervjuinbjudan</button></div><div data-interview-preview-area hidden><p><strong data-interview-subject></strong></p><iframe title="Förhandsvisning av intervjuinbjudan" sandbox="" referrerpolicy="no-referrer"></iframe></div></form>`;
  const form=root.querySelector('form'), fieldset=form.querySelector('fieldset'), notice=root.querySelector('[data-interview-message]'), send=root.querySelector('[data-interview-send]'), preview=root.querySelector('[data-interview-preview]'), history=root.querySelector('[data-interview-history]');
  const values=()=>Object.fromEntries(new FormData(form));
  function fill(invite) {
    const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Stockholm',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(invite.starts_at)).split(' ');
    for(const [key,value] of Object.entries({...invite,date:parts[0],time:parts[1]})) if(form.elements.namedItem(key)) form.elements.namedItem(key).value=value;
  }
  async function load() {
    const {data,error}=await supabase.from('interview_invitations').select(columns).eq('application_id',row.id).order('created_at',{ascending:false});
    if(!isCurrent()) return;
    if(error) {history.textContent='Inbjudningar kunde inte hämtas. Stäng och öppna ansökan för att försöka igen. Funktionen kräver den nya databasmigrationen.';return;}
    history.innerHTML=data?.length?`<ul>${data.map(item=>`<li><strong>${e(interviewDate(item.starts_at))}</strong> · ${e(item.location)}<br>${e(item.response==='yes'?'Tackat ja':item.response==='no'?'Tackat nej':Date.parse(item.starts_at)<=Date.now()?'Svarstiden har gått ut':item.delivery_status==='sent'?'Skickad · Väntar på svar':'Leverans ej bekräftad · Försök igen med samma inbjudan')}${item.responded_at?` · ${e(interviewDate(item.responded_at))}`:''}</li>`).join('')}</ul>`:'<p>Ingen intervjuinbjudan skickad ännu.</p>';
    existing=data?.find(item=>!item.response && Date.parse(item.starts_at)>Date.now() && item.delivery_status!=='expired');
    if(existing) {
      fill(existing); requestId=existing.id;
      fieldset.disabled=true; preview.disabled=false;
      send.disabled=existing.delivery_status==='sent';
      send.textContent=send.disabled?'Inbjudan skickad':'Försök skicka samma inbjudan igen';
    } else {fieldset.disabled=false;send.disabled=false;preview.disabled=false;}
  }
  const draft=()=>existing || validateInterview(values());
  preview.addEventListener('click',()=>{
    try {
      const mail=interviewEmail({...draft(),name:row.answers?.name},{yes:'#preview-yes',no:'#preview-no'});
      root.querySelector('[data-interview-subject]').textContent=`Ämne: ${mail.subject}`;
      root.querySelector('iframe').srcdoc=mail.html;
      root.querySelector('[data-interview-preview-area]').hidden=false;
      notice.textContent='Förhandsvisning. Svarsknapparna är inaktiva här.';
    } catch(error) {notice.textContent=error.message;}
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault(); event.stopPropagation();
    if(sending || !isCurrent()) return;
    let input;
    try {
      input=existing?{...existing,...Object.fromEntries(['date','time'].map(k=>[k,form.elements.namedItem(k).value]))}:values();
      input=Object.fromEntries(['date','time','duration_minutes','location','message','style'].map(key=>[key,input[key]]));
      validateInterview(input);
    } catch(error) {notice.textContent=error.message;return;}
    sending=true;onBusy(true);fieldset.disabled=true;send.disabled=true;preview.disabled=true;send.setAttribute('aria-busy','true');
    // Freeze this attempt on uncertain network errors. Retrying uses the same request ID and payload.
    existing={...validateInterview(input),...input,id:requestId};
    notice.textContent='Skickar inbjudan…';
    try {
      const {data,error}=await supabase.functions.invoke('interview-invitation',{body:{action:'send',application_id:row.id,request_id:requestId,...input}});
      if(error || !data?.success) {
        let explanation=data?.error;
        if(!explanation && error?.context) {try {explanation=(await error.context.json()).error;} catch { /* generic message below */ }}
        throw new Error(explanation || 'Leveransen kunde inte bekräftas. Försök igen med samma inbjudan.');
      }
      if(!isCurrent()) return;
      notice.textContent='Inbjudan har skickats. Kandidatens svar visas här när du öppnar ansökan igen.';
      await load();
    } catch(error) {
      if(isCurrent()) {notice.textContent=error.message;send.disabled=false;send.textContent='Försök skicka samma inbjudan igen';preview.disabled=false;}
    } finally {sending=false;onBusy(false);send.removeAttribute('aria-busy');}
  });
  void load();
}
