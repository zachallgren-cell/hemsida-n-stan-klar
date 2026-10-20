export const categories = ['Välkommen till Berga','Kom igång','Före jobbet','Under jobbet','Efter jobbet','Kundbemötande','Försäljning','Praktisk personalinformation'];
export const blockTypes = {text:'Text',heading:'Rubrik',steps:'Steg för steg',list:'Lista',info:'Informationsruta',image:'Bild',video:'Film',file:'Bilaga / PDF',link:'Länk',article:'Annan artikel'};
export const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function safeUrl(value) { try { const u=new URL(value); return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:''; } catch { return ''; } }
export function videoEmbed(value) {
 try {
  const u=new URL(value); if(u.protocol!=='https:') return '';
  let id;
  if(['youtube.com','www.youtube.com','m.youtube.com','youtube-nocookie.com','www.youtube-nocookie.com'].includes(u.hostname)) {
   id=u.pathname==='/watch'?u.searchParams.get('v'):u.pathname.match(/^\/(?:embed|shorts)\/([\w-]+)\/?$/)?.[1];
  } else if(u.hostname==='youtu.be') id=u.pathname.slice(1);
  if(id && /^[\w-]{11}$/.test(id)) return `https://www.youtube-nocookie.com/embed/${id}`;
  if(['vimeo.com','www.vimeo.com','player.vimeo.com'].includes(u.hostname)) {
   const m=u.pathname.match(/^\/(?:video\/)?(\d+)(?:\/([a-zA-Z0-9]+))?\/?$/);
   if(m) { const hash=m[2]||u.searchParams.get('h'); return `https://player.vimeo.com/video/${m[1]}${hash&&/^[a-zA-Z0-9]+$/.test(hash)?`?h=${hash}`:''}`; }
  }
 } catch {} return '';
}
export const articleUrl=id=>`handbok.html?article=${encodeURIComponent(id)}`;
export function blockHtml(b) {
 const t=escape(b.text), caption=escape(b.caption), url=safeUrl(b.url), link=url?`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${t||'Öppna länk'}</a>`:'<p>Ogiltig eller saknad länk.</p>';
 if(b.type==='heading') return `<h2>${t}</h2>`;
 if(b.type==='steps'||b.type==='list') { const tag=b.type==='steps'?'ol':'ul'; return `<${tag}>${String(b.text||'').split('\n').filter(Boolean).map(s=>`<li>${escape(s)}</li>`).join('')}</${tag}>`; }
 if(b.type==='info') return `<aside class="hb-info">${t}</aside>`;
 if(b.type==='article') return /^[0-9a-f-]{36}$/.test(b.articleId||'')?`<a href="${articleUrl(b.articleId)}">${t||'Läs instruktionen'}</a>`:'<p>Välj en artikel.</p>';
 if(b.path) return `<figure data-asset="${escape(b.path)}" data-kind="${escape(b.type)}" data-label="${t}" data-alt="${escape(b.alt)}"><p>Hämtar ${t||'bilaga'}…</p><figcaption>${caption}</figcaption></figure>`;
 if(b.type==='video') { const embed=videoEmbed(b.url); return `${embed?`<iframe src="${escape(embed)}" title="${t||'Instruktionsfilm'}" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="fullscreen; picture-in-picture" allowfullscreen></iframe>`:''}${link}`; }
 if(b.type==='link'||b.type==='file') return link;
 return `<p class="hb-text">${t}</p>`;
}
export function articleHtml(a) { const d=a.document; return `<article class="hb-article" id="article-${escape(a.id)}"><p>${escape(d.category)}</p><h1>${escape(d.title)}</h1><p class="hb-meta">Ansvarig: ${escape(d.owner)} · Uppdaterad ${new Date(a.updated_at).toLocaleDateString('sv-SE')} · Version ${a.revision}</p>${d.blocks.map(blockHtml).join('')}</article>`; }
export function searchable(d) { return [d.title,d.category,...d.blocks.map(b=>[b.text,b.caption].join(' '))].join(' ').toLocaleLowerCase('sv'); }
