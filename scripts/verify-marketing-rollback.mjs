import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const migration=process.argv.includes('--installed')?'':await readFile(new URL('supabase/migrations/20261102082305_mkt03_booking_attribution.sql',root),'utf8');
const checks=await readFile(new URL('tests/marketing-rollback-checks.sql',root),'utf8');
process.stdout.write("begin;\nset local lock_timeout='3s';\nset local statement_timeout='30s';\n"+migration+'\n'+checks+'\nrollback;\n');
