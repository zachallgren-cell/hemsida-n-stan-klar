import {interviewDate} from './interview-shared.mjs?v=20261027';
const params=new URLSearchParams(location.hash.slice(1)), token=params.get('token');
// Keep the bearer token in memory; don't leak it through navigation or referrers.
history.replaceState(null,'',location.pathname);
const status=document.getElementById('interviewStatus'), details=document.getElementById('interviewDetails'), form=document.getElementById('interviewReply'), retry=document.getElementById('interviewRetry');
const endpoint='https://xeyippgcoqfskcmqzazx.functions.supabase.co/interview-invitation';
let busy=false;
async function request(action,response) {
  const result=await fetch(endpoint,{method:'POST',headers:{apikey:'sb_publishable_MUKxAwv0vNXDrcgumq81fQ_Uvx4eOuq','Content-Type':'application/json'},body:JSON.stringify({action,token,response}),signal:AbortSignal.timeout(20000)});
  const data=await result.json();
  if(!result.ok || !data.invitation) throw new Error(data.error || 'Inbjudan kunde inte hämtas.');
  return data.invitation;
}
function render(invitation) {
  details.hidden=false;
  document.getElementById('interviewWhen').textContent=`${interviewDate(invitation.starts_at)} (svensk tid)`;
  document.getElementById('interviewLength').textContent=`${invitation.duration_minutes} minuter`;
  document.getElementById('interviewWhere').textContent=invitation.location;
  form.hidden=Boolean(invitation.response);
  status.textContent=invitation.response==='yes'?'Tack! Du har tackat ja till intervjun. Vi ser fram emot att träffa dig.':invitation.response==='no'?'Tack för ditt svar. Vi har registrerat att tiden inte passar. Kontakta oss gärna om du vill föreslå en annan tid.':'Välj ja eller nej och bekräfta ditt svar nedan.';
}
async function load() {
  retry.hidden=true;status.textContent='Hämtar din inbjudan…';
  if(!token || !/^[0-9a-f]{64}$/.test(token)){status.textContent='Länken är ogiltig. Öppna den personliga länken från ditt mail.';return;}
  try {
    render(await request('view'));
    const choice=params.get('choice');
    if(['yes','no'].includes(choice)) form.elements.response.value=choice;
  } catch(error) {status.textContent=error.name==='TypeError' || error.name==='TimeoutError'?'Kunde inte ansluta. Kontrollera internetanslutningen och försök igen.':error.message;retry.hidden=false;}
}
form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy || !form.reportValidity()) return;
  busy=true;form.querySelector('button').disabled=true;
  const response=form.elements.response.value;
  form.querySelector('fieldset').disabled=true;status.textContent='Sparar ditt svar…';
  try {render(await request('respond',response));}
  catch(error) {status.textContent=error.message || 'Svaret kunde inte bekräftas. Försök igen.';status.focus();}
  finally {busy=false;form.querySelector('button').disabled=false;form.querySelector('fieldset').disabled=false;}
});
retry.addEventListener('click',load);
void load();
