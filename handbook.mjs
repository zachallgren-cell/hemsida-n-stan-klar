import {categories,blockTypes,escape as e,articleHtml,searchable,articleUrl} from './handbook-core.mjs';
export function initHandbook({root=document,client,embedded=false}={}) {
const $=id=>root.querySelector('#'+id);
let authorized=!embedded, loaded=false, loading=false, generation=0;
let rows=[],published=[],admin=false,current=null,dirty=false,busy=false;
let blobs=[];
const message=t=>$('status').textContent=t;
async function rpc(name,args={}){const {data,error}=await client.rpc(name,args);if(error)throw error;return data;}
function guard(){return !dirty||window.confirm('Du har osparade ändringar. Vill du lämna dem?');}
window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
function release(){blobs.forEach(URL.revokeObjectURL);blobs=[];}
function download(data,name,type='application/json'){const url=URL.createObjectURL(new Blob([data],{type}));const a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function refreshCategories(){const previous=$('category').value;const all=[...new Set([...categories,...rows.map(a=>(admin?a.draft:a.document).category)])];$('category').innerHTML='<option value="">Alla kategorier</option>'+all.map(c=>`<option>${e(c)}</option>`).join('');$('category').value=previous;}
function list(){const query=$('search').value.toLocaleLowerCase('sv');const category=$('category').value;
 const items=rows.filter(a=>(!a.archived||$('showArchived').checked)&&(!category||(admin?a.draft:a.document).category===category)&&searchable(admin?a.draft:a.document).includes(query));
 const groups=[...new Set(items.map(a=>(admin?a.draft:a.document).category))];
 $('articles').innerHTML=groups.map(c=>`<h2>${e(c)}</h2>${items.filter(a=>(admin?a.draft:a.document).category===c).sort((a,b)=>(admin?a.draft:a.document).order-(admin?b.draft:b.document).order).map(a=>`<button data-open="${a.id}">${e((admin?a.draft:a.document).title)}${admin?`<small>${a.archived?'Arkiverad':!a.published?'Utkast':a.published_revision===a.revision?'Publicerad':'Publicerad · arbetsutkast'} · v${a.revision}</small>`:''}</button>`).join('')}`).join('')||'<p>Inga artiklar hittades.</p>';
}
async function load(){const epoch=generation;const nextPublished=await rpc('handbook_read');const nextRows=admin?await rpc('handbook_read',{p_edit:true}):nextPublished;if(epoch!==generation||!authorized)return false;published=nextPublished;rows=nextRows;refreshCategories();list();return true;}
async function hydrate(root){await Promise.all([...root.querySelectorAll('[data-asset]')].map(async node=>{const {asset:path,kind,label,alt}=node.dataset;try{
 const caption=node.querySelector('figcaption');
 let media;
 if(kind==='video'){const {data,error}=await client.storage.from('handbook').createSignedUrl(path,3600);if(error)throw error;media=document.createElement('video');media.controls=true;media.preload='metadata';media.src=data.signedUrl;}
 else if(kind==='image'){const {data,error}=await client.storage.from('handbook').download(path);if(error)throw error;const url=URL.createObjectURL(data);blobs.push(url);media=document.createElement('img');media.src=url;media.alt=alt||label||'';await new Promise(resolve=>{media.onload=resolve;media.onerror=resolve;});}
 else {media=document.createElement('button');media.type='button';media.textContent=label||'Ladda ner bilaga';media.onclick=async()=>{try{const {data,error}=await client.storage.from('handbook').download(path);if(error)throw error;download(data,path.split('/').slice(1).join('/'),data.type);}catch(err){message(err.message);}};}
 node.replaceChildren(media,...(caption?[caption]:[]));
 }catch{node.textContent='Bilagan kunde inte hämtas. Ladda om sidan eller kontakta ansvarig.';}}));}
async function show(id,updateUrl=true){if(!guard())return;dirty=false;release();const a=rows.find(a=>a.id===id);if(!a){message('Artikeln finns inte eller är inte tillgänglig för ditt konto.');return;}
 current=structuredClone(a);if(updateUrl&&!embedded)history.replaceState(null,'',articleUrl(id));
 if(admin)renderEditor();else{$('editor').hidden=true;$('reader').hidden=false;$('reader').innerHTML=articleHtml(a);await hydrate($('reader'));$('reader').scrollIntoView({behavior:'smooth',block:'start'});}
}
function readEditor(){const doc=current.draft;['title','category','owner'].forEach(k=>doc[k]=$(`edit-${k}`).value);doc.order=Number($('edit-order').value);
 doc.blocks=[...$('blocks').children].map(node=>{const b=structuredClone(doc.blocks[Number(node.dataset.index)]);node.querySelectorAll('[data-field]').forEach(input=>b[input.dataset.field]=input.value);return b;});return doc;}
function renderEditor(){const d=current.draft;$('reader').hidden=true;$('editor').hidden=false;
 $('editor').innerHTML=`<h2>${current.revision?'Redigera artikel':'Ny artikel'}</h2><p id="saveState">${dirty?'Osparade ändringar':'Inläst · version '+current.revision}</p>${current.updated_at?`<p class="hb-meta">Senast redigerad ${new Date(current.updated_at).toLocaleString('sv-SE')} · ${e(current.edited_by)}</p>`:''}${current.published?'<p>Personalen ser fortfarande den publicerade versionen tills du publicerar igen.</p>':''}
 ${['title','category','owner','order'].map((k,i)=>`<label>${['Rubrik','Kategori (byt för att flytta)','Ansvarig person','Sorteringsordning'][i]}<input id="edit-${k}" ${k==='order'?'type="number" min="0" max="999999"':'type="text"'} value="${e(d[k])}" ${k==='category'?'list="categoryOptions"':''}></label>`).join('')}<datalist id="categoryOptions">${categories.map(c=>`<option value="${e(c)}">`).join('')}</datalist><div id="blocks">${d.blocks.map((b,i)=>blockEditor(b,i)).join('')}</div>
 <div class="hb-actions"><label>Lägg till innehåll<select id="blockType">${Object.entries(blockTypes).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label><button id="addBlock">Lägg till block</button></div>
 <p class="hb-warn">Externa filmer: kontrollera delning hos videotjänsten med ett personalkonto. Olistat betyder att länken kan delas vidare. Uppladdade filer: högst 50 MB per fil. Lagring och visningar använder Supabase-kvoten.</p>
 <div class="hb-actions"><button id="save">Spara utkast</button><button id="preview">Förhandsgranska utkast</button><button id="publish">Publicera</button><button id="archive">${current.archived?(current.published?'Återaktivera publicerad version':'Återaktivera utkast'):'Arkivera'}</button><button id="versions">Versionshistorik</button></div><div id="previewArea"></div><div id="history"></div>`;
 $('editor').querySelectorAll('input,textarea,select').forEach(input=>input.addEventListener('input',()=>{dirty=true;$('saveState').textContent='Osparade ändringar';}));
 $('addBlock').onclick=()=>{readEditor();d.blocks.push({type:$('blockType').value,text:''});dirty=true;renderEditor();};
 $('blocks').onclick=event=>{const button=event.target.closest('[data-block-action]');if(!button||busy)return;readEditor();const i=Number(button.dataset.i),action=button.dataset.blockAction;if(action==='remove')d.blocks.splice(i,1);else {const j=i+(action==='up'?-1:1);if(j>=0&&j<d.blocks.length)[d.blocks[i],d.blocks[j]]=[d.blocks[j],d.blocks[i]];}dirty=true;renderEditor();};
 $('blocks').querySelectorAll('[data-upload]').forEach(input=>input.onchange=()=>upload(input));
 $('save').onclick=()=>save('save');$('publish').onclick=()=>save('publish');$('archive').onclick=()=>save(current.archived?'unarchive':'archive');
 $('preview').onclick=async()=>{readEditor();$('previewArea').innerHTML='<h2>Förhandsgranskning · utkast</h2>'+articleHtml({id:current.id,document:d,revision:current.revision,updated_at:new Date()});await hydrate($('previewArea'));};
 $('versions').onclick=versions;
}
function blockEditor(b,i){let extra='';
 if(['image','video','file'].includes(b.type))extra+=`<label>Ladda upp ${b.type==='image'?'bild':b.type==='video'?'film (MP4 eller WebM)':'bilaga'}<input type="file" data-upload="${i}" accept="${b.type==='image'?'image/png,image/jpeg,image/webp':b.type==='video'?'video/mp4,video/webm':'.pdf,.txt,.zip,.docx,.xlsx'}"></label>${b.path?`<small>Uppladdad: ${e(b.path.split('/').slice(1).join('/'))}</small>`:''}<label>Bildtext / beskrivning<input data-field="caption" value="${e(b.caption)}"></label>`;
 if(b.type==='image')extra+=`<label>Alternativtext för bilden<input data-field="alt" value="${e(b.alt)}"></label>`;
 if(['video','link'].includes(b.type)&&!b.path)extra+=`<label>Klistra in länk<input data-field="url" type="url" value="${e(b.url)}"></label>`;
 if(b.type==='article')extra+=`<label>Artikel<select data-field="articleId"><option value="">Välj…</option>${rows.filter(a=>a.id!==current.id).map(a=>`<option value="${a.id}" ${b.articleId===a.id?'selected':''}>${e(a.draft.title)}</option>`).join('')}</select></label>`;
 return `<section class="hb-block" data-index="${i}"><strong>${e(blockTypes[b.type])}</strong><label>${['steps','list'].includes(b.type)?'En punkt per rad':'Text / länktext'}<textarea data-field="text">${e(b.text)}</textarea></label>${extra}<div class="hb-block-actions">${[['up','↑ Flytta upp'],['down','↓ Flytta ned'],['remove','Ta bort']].map(([action,label])=>`<button data-block-action="${action}" data-i="${i}">${label}</button>`).join('')}</div></section>`;
}
function lock(value){busy=value;$('editor').inert=value;$('new').disabled=value;$('print').disabled=value;$('articles').inert=value;}
async function upload(input){const file=input.files[0];if(!file)return;if(file.size>50*1024*1024){message('Filen är för stor. Gränsen är 50 MB.');return;}
 readEditor();const index=Number(input.dataset.upload);const path=`${current.id}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;lock(true);message('Laddar upp…');
 try{const {error}=await client.storage.from('handbook').upload(path,file,{upsert:false});if(error)throw error;current.draft.blocks[index].path=path;delete current.draft.blocks[index].url;dirty=true;renderEditor();message('Filen är uppladdad. Spara artikeln för att behålla referensen.');}catch(err){message(err.message);}finally{lock(false);}
}
async function save(action,restore=null){if(busy)return;if(['publish','archive'].includes(action)&&!window.confirm(action==='publish'?'Publicera detta innehåll för personalen?':'Arkivera artikeln och ta bort den från personalens läsvy?'))return;
 readEditor();lock(true);message('Sparar…');
 try{current=await rpc('handbook_save',{p_id:current.id,p_expected:current.revision,p_document:current.draft,p_action:action,p_restore:restore});dirty=false;await load();renderEditor();message(action==='publish'?'Publicerat för personalen.':'Sparat i databasen.');}catch(err){message(err.message);if($('saveState'))$('saveState').textContent='Inte sparat · dina ändringar finns kvar här';}finally{lock(false);}
}
async function versions(){try{const history=await rpc('handbook_history',{p_id:current.id});$('history').innerHTML='<h3>Tidigare versioner</h3>'+history.map(v=>`<p>Version ${v.revision} · ${e(v.action)} · ${new Date(v.created_at).toLocaleString('sv-SE')} · Redigerare ${e(v.edited_by)} <button data-restore="${v.revision}">Återställ till nytt utkast</button></p><details><summary>Visa version ${v.revision}</summary>${articleHtml({id:current.id,document:v.snapshot,revision:v.revision,updated_at:v.created_at})}</details>`).join('');$('history').querySelectorAll('button').forEach(b=>b.onclick=()=>{if(guard())save('restore',Number(b.dataset.restore));});}catch(err){message(err.message);}}
$('articles').onclick=event=>{const b=event.target.closest('[data-open]');if(b)void show(b.dataset.open);};
$('search').oninput=list;$('category').onchange=list;$('showArchived').onchange=list;
$('new').onclick=()=>{if(!guard())return;dirty=true;current={id:crypto.randomUUID(),revision:0,draft:{schemaVersion:1,title:'Ny artikel',category:categories[0],owner:'Behöver utses',order:0,blocks:[]}};renderEditor();};
$('backup').onclick=async()=>{try{message('Exporterar original och historik…');const originals=await rpc('handbook_read',{p_edit:true});const history=await Promise.all(originals.map(a=>rpc('handbook_history',{p_id:a.id})));download(JSON.stringify({format:'berga-handbook',schemaVersion:1,exportedAt:new Date().toISOString(),articles:originals,history},null,2),'bergahandboken-backup.json');message('Original och historik exporterade. Kör även bilagebackup enligt installationsanvisningen för en fullständig säkerhetskopia.');}catch(err){message(err.message);}};
$('print').onclick=async()=>{try{message('Förbereder publicerat innehåll…');const articles=await rpc('handbook_read');$('printDocument').innerHTML=`<h1>Bergahandboken</h1><p>Exporterad ${new Date().toLocaleString('sv-SE')}</p><h2>Innehåll</h2><ol>${articles.map(a=>`<li><a href="#article-${a.id}">${e(a.document.category)} · ${e(a.document.title)} · v${a.revision}</a></li>`).join('')}</ol>${articles.map(articleHtml).join('')}`;await hydrate($('printDocument'));$('printHelp').hidden=false;message('Välj Spara som PDF i utskriftsdialogen.');const output=$('printDocument').cloneNode(true);output.id='';output.className='hb-print-output';document.body.append(output);document.body.classList.add('hb-printing');window.addEventListener('afterprint',()=>{output.remove();document.body.classList.remove('hb-printing');},{once:true});window.print();}catch(err){message(err.message);}};
if($('logout')) $('logout').onclick=async()=>{if(!guard())return;await client.auth.signOut();location.reload();};
client.auth.onAuthStateChange(event=>{if(event==='SIGNED_OUT'){authorized=false;generation++;loaded=false;dirty=false;release();$('app').hidden=true;$('reader').replaceChildren();$('editor').replaceChildren();$('printDocument').replaceChildren();$('login').hidden=false;}});
async function start(){
if(loading||!authorized)return;loading=true;const epoch=generation;
try{const {data}=await client.auth.getSession();if(!data.session){$('login').hidden=false;message('Logga in för att läsa handboken.');}else{if($('logout'))$('logout').hidden=false;
 if(embedded){rows=await rpc('handbook_read',{p_edit:true});admin=true;}
 if(epoch!==generation||!authorized||!await load())return;$('app').hidden=false;$('adminTools').hidden=!admin;$('backup').hidden=!admin;message(rows.length?'':'Här kommer era rutiner att samlas. Inga artiklar är publicerade ännu.');loaded=true;const id=!embedded&&new URLSearchParams(location.search).get('article');if(id)await show(id,false);
}}catch(err){message(/does not exist|schema cache|Could not find/.test(err.message)?'Handboken behöver installeras i databasen. Se installationsanvisningen i projektet.':err.message);$('login').hidden=false;}
finally{loading=false;}
}
return {
 load(view){if(view==='handbook'&&!loaded)void start();},
 setAuthorized(value){authorized=value;if(!value){generation++;loaded=false;dirty=false;admin=false;current=null;rows=[];published=[];release();$('app').hidden=true;$('reader').replaceChildren();$('editor').replaceChildren();$('articles').replaceChildren();$('printDocument').replaceChildren();}},
 start
};
}
if(document.body.hasAttribute('data-handbook-standalone')){
 const client=window.supabase.createClient('https://xeyippgcoqfskcmqzazx.supabase.co','sb_publishable_MUKxAwv0vNXDrcgumq81fQ_Uvx4eOuq');
 void initHandbook({client}).start();
}
