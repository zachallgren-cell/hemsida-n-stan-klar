import { validateInterview, interviewEmail } from '../../../interview-shared.mjs';
import { readJsonWithLimit } from '../_shared/read-json.ts';
const origins=new Set(['https://bergafonsterputs.se','https://www.bergafonsterputs.se']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sha=async(value:string)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))).map(x=>x.toString(16).padStart(2,'0')).join('');
Deno.serve(async req=>{
  const origin=req.headers.get('origin') || '';
  const allowed=origins.has(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  const headers={'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',Vary:'Origin',...(allowed?{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS'}:{})};
  const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(req.method==='OPTIONS') return new Response(null,{status:allowed?204:403,headers});
  if(req.method!=='POST') return json({error:'Method not allowed'},405);
  if(origin && !allowed) return json({error:'Origin not allowed'},403);
  if(!/^application\/json(?:;|$)/i.test(req.headers.get('content-type') || '')) return json({error:'JSON krävs.'},415);
  try {
    const body=await readJsonWithLimit<Record<string,any>>(req,12000);
    const url=Deno.env.get('SUPABASE_URL')!, key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    if(!url || !key) return json({error:'Serverkonfiguration saknas.'},503);
    const service={apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
    const rest=async(path:string,init:RequestInit={})=>fetch(`${url}/rest/v1/${path}`,{...init,headers:{...service,...init.headers}});
    if(body.action==='view' || body.action==='respond') {
      if(typeof body.token!=='string' || !/^[0-9a-f]{64}$/.test(body.token)) return json({error:'Länken är ogiltig.'},400);
      if(body.action==='respond' && !['yes','no'].includes(body.response)) return json({error:'Välj ja eller nej.'},400);
      const result=await rest('rpc/respond_interview',{method:'POST',body:JSON.stringify({p_token_hash:await sha(body.token),p_response:body.action==='respond'?body.response:null})});
      if(!result.ok) { const failure=await result.json(); return json({error:failure.message || 'Inbjudan kunde inte öppnas.'},400); }
      return json({invitation:await result.json()});
    }
    if(body.action!=='send' || !uuid.test(body.application_id) || !uuid.test(body.request_id)) return json({error:'Ogiltig begäran.'},400);
    body.request_id=body.request_id.toLowerCase();
    body.application_id=body.application_id.toLowerCase();
    const auth=req.headers.get('authorization') || '';
    if(!auth.startsWith('Bearer ')) return json({error:'Logga in som administratör.'},401);
    // Verify live user identity, then read through RLS (including the existing aal2 admin guard).
    const userRes=await fetch(`${url}/auth/v1/user`,{headers:{apikey:key,Authorization:auth}});
    if(!userRes.ok) return json({error:'Sessionen har gått ut.'},401);
    const user=await userRes.json();
    const candidateRes=await fetch(`${url}/rest/v1/job_applications?id=eq.${body.application_id}&select=id,answers`,{headers:{apikey:Deno.env.get('SUPABASE_ANON_KEY') || key,Authorization:auth}});
    if(!candidateRes.ok) return json({error:'Adminbehörighet med tvåstegsverifiering krävs.'},403);
    const candidate=(await candidateRes.json())[0];
    if(!candidate) return json({error:'Ansökan saknas eller behörighet nekas.'},403);
    const apiKey=Deno.env.get('RESEND_API_KEY'), from=Deno.env.get('BOOKING_FROM_EMAIL');
    if(!apiKey || !from) return json({error:'E-postkonfiguration saknas. Kontakta administratören.'},503);
    let values;
    try { values=validateInterview(body); } catch(error) {return json({error:(error as Error).message},400);}
    const hmacKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(key),{name:'HMAC',hash:'SHA-256'},false,['sign']);
    const token=Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',hmacKey,new TextEncoder().encode(`interview:${body.request_id}`)))).map(x=>x.toString(16).padStart(2,'0')).join('');
    let lookup=await rest(`interview_invitations?id=eq.${body.request_id}&select=*`);
    if(!lookup.ok) throw new Error('Storage lookup');
    let invitation=(await lookup.json())[0];
    if(invitation && (invitation.application_id!==body.application_id || Object.keys(values).some(k=>k==='starts_at'?Date.parse(invitation[k])!==Date.parse(values[k]):invitation[k]!==values[k]))) return json({error:'Försöket har redan andra uppgifter. Öppna ansökan igen.'},409);
    if(!invitation) {
      const expired=await rest(`interview_invitations?application_id=eq.${body.application_id}&response=is.null&starts_at=lte.${encodeURIComponent(new Date().toISOString())}`,{method:'PATCH',body:JSON.stringify({delivery_status:'expired'})});
      if(!expired.ok) throw new Error('Expire old invitations');
      const email=String(candidate.answers.email || '').trim();
      if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({error:'Kandidaten saknar en giltig e-postadress.'},400);
      const insert=await rest('interview_invitations?select=*',{method:'POST',headers:{Prefer:'return=representation'},body:JSON.stringify({id:body.request_id,application_id:body.application_id,created_by:user.id,...values,name:candidate.answers.name,email,token_hash:await sha(token)})});
      if(!insert.ok) {
        // A retry with the same ID can race the first request. Other IDs stay blocked.
        lookup=await rest(`interview_invitations?id=eq.${body.request_id}&select=*`);
        if(!lookup.ok) throw new Error('Retry lookup');
        invitation=(await lookup.json())[0];
        if(!invitation || invitation.application_id!==body.application_id) return json({error:'Det finns redan en obesvarad inbjudan. Uppdatera ansökan för att se status.'},409);
        if(Object.keys(values).some(k=>k==='starts_at'?Date.parse(invitation[k])!==Date.parse(values[k]):invitation[k]!==values[k])) return json({error:'Inbjudan har andra uppgifter. Uppdatera ansökan.'},409);
      } else invitation=(await insert.json())[0];
    }
    if(invitation.delivery_status==='sent') return json({success:true,id:invitation.id});
    // Resend retains idempotency keys for 24h. Never retry an uncertain send after that window.
    if(Date.now()-Date.parse(invitation.created_at)>23*3600000) return json({error:'Leveransen behöver kontrolleras manuellt innan ett nytt mail skickas.'},409);
    const site=(Deno.env.get('PUBLIC_SITE_URL') || 'https://bergafonsterputs.se').replace(/\/+$/,'');
    const link=`${site}/intervju.html#token=${token}`;
    const mail=interviewEmail(invitation,{yes:`${link}&choice=yes`,no:`${link}&choice=no`});
    const sent=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json','Idempotency-Key':`interview-${invitation.id}`},body:JSON.stringify({from,to:[invitation.email],reply_to:Deno.env.get('BOOKING_CONTACT_EMAIL') || 'info@bergafonsterputs.se',...mail})});
    if(!sent.ok) return json({error:'Mailleveransen kunde inte bekräftas. Försök igen med samma inbjudan.'},502);
    const receipt=await sent.json();
    const update=await rest(`interview_invitations?id=eq.${invitation.id}`,{method:'PATCH',body:JSON.stringify({delivery_status:'sent',provider_id:receipt.id,sent_at:new Date().toISOString()})});
    if(!update.ok) return json({error:'Mailet accepterades men status kunde inte sparas. Försök igen med samma inbjudan.'},502);
    return json({success:true,id:invitation.id});
  } catch { return json({error:'Förfrågan kunde inte slutföras. Försök igen med samma uppgifter.'},500); }
});
