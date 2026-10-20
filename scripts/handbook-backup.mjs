// Server-side operator utility. Never include this token in a page or commit it.
// HANDBOOK_TOKEN: existing AAL2 admin access token.
import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const token=process.env.HANDBOOK_TOKEN;
if(!token)throw new Error('Set HANDBOOK_TOKEN to a short-lived MFA admin token.');
const destination=resolve(process.argv[2]||`handbook-backup-${new Date().toISOString().replace(/[:.]/g,'-')}`);
const base='https://xeyippgcoqfskcmqzazx.supabase.co';
const headers={apikey:'sb_publishable_MUKxAwv0vNXDrcgumq81fQ_Uvx4eOuq',Authorization:`Bearer ${token}`};
async function request(path,options={}){const response=await fetch(base+path,{...options,headers:{...headers,...options.headers}});if(!response.ok)throw new Error(`Backup request failed (${response.status}); nothing is marked complete.`);return response;}
async function rpc(name,args){return (await request('/rest/v1/rpc/'+name,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)})).json();}
await mkdir(destination,{mode:0o700});
const articles=await rpc('handbook_read',{p_edit:true});
const history=await Promise.all(articles.map(a=>rpc('handbook_history',{p_id:a.id})));
const paths=[...new Set([...articles.flatMap(a=>[a.draft,a.published]),...history.flat().map(v=>v.snapshot)].filter(Boolean).flatMap(d=>d.blocks.map(b=>b.path).filter(Boolean)))];
const assets=[];
await mkdir(join(destination,'assets'),{mode:0o700});
for(const [index,path] of paths.entries()){
 const response=await request('/storage/v1/object/authenticated/handbook/'+path.split('/').map(encodeURIComponent).join('/'));
 const contentType=response.headers.get('content-type')||'application/octet-stream';
 const data=Buffer.from(await response.arrayBuffer());
 const file=`assets/${index}.bin`;await writeFile(join(destination,file),data,{mode:0o600});assets.push({path,file,contentType,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
}
await writeFile(join(destination,'manifest.json'),JSON.stringify({format:'berga-handbook',schemaVersion:1,exportedAt:new Date().toISOString(),articles,history,assets},null,2),{mode:0o600});
console.log(`Backup complete: ${articles.length} articles, ${history.flat().length} versions, ${assets.length} assets. ${destination}`);
