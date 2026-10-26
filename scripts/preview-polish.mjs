// Local visual review only: static allowlist, synthetic email data, external calls blocked.
import {createServer} from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import {extname,resolve} from 'node:path';
import {emailFixtures} from '../tests/helpers/email-fixtures.mjs';
import {bookingPreview, rutPreview} from '../tests/helpers/booking-preview.mjs';
const root=resolve(new URL('..',import.meta.url).pathname);
const port=4176;
const types={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'text/javascript','.mjs':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'};
const allowed=new Set();
async function assets(directory='') {
  for(const item of await readdir(resolve(root,directory),{withFileTypes:true})) {
    const path=directory ? `${directory}/${item.name}` : item.name;
    if(item.name.startsWith('.')) continue;
    if(item.isFile() && types[extname(item.name)]) allowed.add('/'+path);
    if(item.isDirectory() && (directory || ['vendor','images','assets','puts-gp'].includes(item.name))) await assets(path);
  }
}
await assets();
const emails=await emailFixtures();
const bookingDemo=await bookingPreview();
const rutDemo=await rutPreview();
const gallery=`<!doctype html><html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Förhandsgranskning av mejl</title><link rel="stylesheet" href="/site.css"><style>main{max-width:1100px;margin:32px auto;padding:0 20px}.samples{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:24px}.sample{border:1px solid #c9e0ea;border-radius:16px;background:white;overflow:hidden}.sample h2{font-size:1rem;margin:0;padding:16px 18px}.sample iframe{width:100%;height:650px;border:0}.sample a{display:block;padding:12px 18px;text-decoration:underline}</style></head><body><main><p class="eyebrow">Lokal förhandsgranskning</p><h1>Mejl från Berga</h1><p>Syntetiska uppgifter i systemets befintliga mallar. Inga mejl skickas.</p><div class="samples">${emails.map(mail=>`<article class="sample"><h2>${mail.title}</h2><iframe title="${mail.title}" src="/email/${mail.id}" sandbox></iframe><a href="/email/${mail.id}">Visa mejlet i hel storlek</a></article>`).join('')}</div></main></body></html>`;
createServer(async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 res.setHeader('X-Content-Type-Options','nosniff');
 res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; frame-src 'self'; form-action 'none'; object-src 'none'; base-uri 'self'");
 if(!['127.0.0.1:'+port,'localhost:'+port].includes(req.headers.host) || req.method!=='GET'){res.writeHead(403);res.end();return;}
 const url=new URL(req.url,'http://localhost');let path=url.pathname;
 if(path==='/rut-demo.html'){res.setHeader('Content-Type',types['.html']);res.end(rutDemo);return;}
 if(path==='/hantera-bokning-demo.html'){res.setHeader('Content-Type',types['.html']);res.end(bookingDemo);return;}
 if(path==='/review'){
   const pages=[['Startsida','/index.html'],['Paxning och bokning','/bokning.html'],['Personal','/personal.html'],['Admin','/admin.html'],['Betalning','/betalning.html'],['Klartmejl','/email/klart']];
   res.setHeader('Content-Type',types['.html']);res.end(`<!doctype html><html lang="sv"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mobilkontroll</title><link rel="stylesheet" href="/site.css"><style>main{padding:24px}.views{display:flex;flex-wrap:wrap;gap:24px}article{width:377px;max-width:100%}h2{font-size:18px}iframe{width:375px;max-width:100%;height:760px;border:1px solid #c9e0ea;border-radius:16px;background:white}</style></head><body><main><h1>Mobilkontroll</h1><p>Lokal visuell kontroll. Externa anrop och formulärsändningar är blockerade.</p><div class="views">${pages.map(([title,path])=>`<article><h2>${title}</h2><iframe title="${title}" src="${path}"></iframe></article>`).join('')}</div></main></body></html>`);return;
 }
 if(path==='/emails'){res.setHeader('Content-Type',types['.html']);res.end(gallery);return;}
 if(path.startsWith('/email/')){const mail=emails.find(mail=>'/email/'+mail.id===path);res.setHeader('Content-Type',types['.html']);res.writeHead(mail?200:404);res.end(mail?.html||'Saknas');return;}
 if(path.endsWith('/'))path+='index.html';
 if(!allowed.has(path)){res.writeHead(404);res.end();return;}
 try {const data=await readFile(resolve(root,'.'+path));res.setHeader('Content-Type',types[extname(path)]);res.end(data);}catch{res.writeHead(404);res.end();}
}).listen(port,'127.0.0.1',()=>console.log(`Visuell förhandsgranskning: http://127.0.0.1:${port} • Mejl: /emails • Externa anrop blockerade`));
