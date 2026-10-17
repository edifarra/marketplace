import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(process.env.PGLITE_MODULE).href);

test('cron follows config atomically, preserving job and credentials', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema cron;
      create table cron.job(jobid bigint primary key, jobname text, active boolean);
      insert into cron.job values(4,'telegram-pending-dispatch',true);
      create function cron.alter_job(job_id bigint, active boolean) returns void language sql as
        'update cron.job set active = $2 where jobid = $1';
      create table telegram_notification_config(id boolean primary key,enabled boolean,dispatch_enabled boolean,bot_token_encrypted text,chat_id text);
      insert into telegram_notification_config values(true,false,false,'encrypted-token','saved-chat');
    `);
    await db.exec(readFileSync(new URL('../supabase/migrations/20261017023442_telegram_dispatch_lifecycle.sql', import.meta.url),'utf8'));
    const active = async () => (await db.query('select active from cron.job where jobid=4')).rows[0].active;
    assert.equal(await active(), false);
    for (const [enabled, dispatch, expected] of [[true,false,false],[true,true,true],[false,true,false],[true,true,true],[true,false,false]]) {
      await db.query('update telegram_notification_config set enabled=$1,dispatch_enabled=$2', [enabled,dispatch]);
      assert.equal(await active(), expected);
    }
    assert.deepEqual((await db.query('select bot_token_encrypted,chat_id from telegram_notification_config')).rows[0], { bot_token_encrypted:'encrypted-token',chat_id:'saved-chat' });
    await db.exec("delete from cron.job");
    await assert.rejects(db.exec('update telegram_notification_config set enabled=false'), /ausente/);
    assert.equal((await db.query('select enabled from telegram_notification_config')).rows[0].enabled, true);
    assert.equal((await db.query("select has_function_privilege('service_role','private.sync_telegram_dispatch_cron()','execute') as allowed")).rows[0].allowed, false);
  } finally { await db.close(); }
});
