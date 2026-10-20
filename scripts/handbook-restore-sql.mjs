// Generates a reviewable, transactional restore for an EMPTY handbook database.
// Run as database operator after restoring Auth users and applying the migration.
import {readFile,writeFile} from 'node:fs/promises';
const [source,target]=process.argv.slice(2);
if(!source||!target)throw new Error('Usage: node scripts/handbook-restore-sql.mjs backup.json restore.sql');
const backup=JSON.parse(await readFile(source,'utf8'));
if(backup.format!=='berga-handbook'||backup.schemaVersion!==1||!Array.isArray(backup.articles)||!Array.isArray(backup.history))throw new Error('Unsupported backup');
const literal=data=>"'"+JSON.stringify(data).replaceAll("'","''")+"'::jsonb";
await writeFile(target,`begin;
DO $$ begin if exists(select 1 from public.handbook_articles) or exists(select 1 from public.handbook_versions) then raise exception 'Restore requires empty handbook tables'; end if; end $$;
insert into public.handbook_articles select * from jsonb_populate_recordset(null::public.handbook_articles, ${literal(backup.articles)});
insert into public.handbook_versions select * from jsonb_populate_recordset(null::public.handbook_versions, ${literal(backup.history.flat())});
commit;
`,{mode:0o600,flag:'wx'});
console.log('Restore SQL created; review before executing. Attachment files must be restored separately to the same private paths.');
