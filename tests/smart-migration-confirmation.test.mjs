import test, { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { confirmLinkedMigrations as actualConfirm, cliHistoryArgs } from '../scripts/smart-migration-confirmation.mjs';
import { executeDeployment } from '../scripts/smart-deploy-flow.mjs';

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smart-cli-'));
fs.mkdirSync(path.join(fixtureRoot,'supabase/.temp'),{recursive:true});
const projectRef='abcdefghijklmnopqrst';
fs.writeFileSync(path.join(fixtureRoot,'supabase/.temp/project-ref'),projectRef);
after(()=>fs.rmSync(fixtureRoot,{recursive:true,force:true}));
const help='--linked --project-ref --output-format';
function confirmLinkedMigrations(versions, {spawn}) {
  return actualConfirm(versions,{cwd:fixtureRoot,binary:process.execPath,projectRef,spawn:(command,args,options)=>{
    if(args[0]==='--version')return {status:0,stdout:'2.121.0'};
    if(args.includes('--help'))return {status:0,stdout:help};
    return spawn(command,args,options);
  }});
}
const versions = Array.from({ length: 101 }, (_, i) => String(i + 1).padStart(3, '0'));
const history = (pending = false) => JSON.stringify({ migrations: versions.map((local, i) => ({ local, remote: pending && i === 100 ? '' : local, time: local })), message: 'Migrations listed' });
const capture = stdout => ({ status: 0, stdout, stderr: 'Initialising login role...\nConnecting to remote database...\n' });
function fixture(outputs) {
  const calls = [];
  let published = false;
  const io = {
    preflight: async () => {}, validate: async () => {}, confirm: async () => 'DEPLOY', revalidate: async () => {},
    loadProgress: async () => null, saveProgress: async () => {}, isPublished: async () => published,
    confirmMigrations: () => confirmLinkedMigrations(versions, { spawn: (command, args, options) => {
      calls.push('history');
      assert.equal(command, process.execPath);
      assert.deepEqual(args, ['migration', 'list', '--linked', '--project-ref='+projectRef, '--output-format', 'text']);
      assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
      assert.equal(options.encoding, 'utf8'); assert.equal(options.env.SUPABASE_TELEMETRY_DISABLED, '1');
      return capture(outputs.shift());
    } }),
    migrate: async () => { calls.push('db push'); },
    push: async () => { calls.push('git push'); published = true; },
    verifyPublished: async () => {}, complete: async () => {}, clearProgress: async () => {}
  };
  return { calls, io, plan: { mode: 'execute', target: 'target', base: 'base', classification: { migration: true } } };
}

for (const next of ['', 'not-json', '{invalid']) test(`previous valid capture never authorizes deployment when fresh capture is ${JSON.stringify(next)}`, async () => {
  // Prior independent read/dry-run is valid; execute must still require its fresh read.
  assert.equal(confirmLinkedMigrations(versions, { spawn: () => capture(history()) }), true);
  const f = fixture([next]);
  await assert.rejects(executeDeployment(f.plan, f.io), /Unrecognized/);
  assert.deepEqual(f.calls, ['history']); // no db push or publication
});

test('normal 101/101 needs one fresh query and no db push', async () => {
  const f = fixture([history()]); await executeDeployment(f.plan, f.io);
  assert.deepEqual(f.calls, ['history', 'git push']);
});

test('divergent history blocks every write', async () => {
  const f = fixture([history().replace('"remote":"101"', '"remote":"999"')]);
  await assert.rejects(executeDeployment(f.plan, f.io), /diverges/);
  assert.deepEqual(f.calls, ['history']);
});

test('proven pending migration requires a fresh post-migration confirmation', async () => {
  const f = fixture([history(true), history()]); await executeDeployment(f.plan, f.io);
  assert.deepEqual(f.calls, ['history', 'db push', 'history', 'git push']);
});

for (const next of ['', 'invalid']) test(`pending migration followed by ${next || 'empty'} history blocks publication without repeating db push`, async () => {
  const f = fixture([history(true), next]);
  await assert.rejects(executeDeployment(f.plan, f.io), /Unrecognized/);
  assert.deepEqual(f.calls, ['history', 'db push', 'history']);
});

test('capture error/nonzero exit cannot authorize writes even with valid JSON', () => {
  for (const result of [{ ...capture(history()), status: 1 }, { ...capture(history()), error: new Error('buffer exceeded') }]) {
    assert.throws(() => confirmLinkedMigrations(versions, { spawn: () => result }), /failed/);
  }
});

test('installed-version capability gate rejects unknown version/help and malformed refs',()=>{
  assert.deepEqual(cliHistoryArgs('2.121.0',help,projectRef),['migration','list','--linked','--project-ref='+projectRef,'--output-format','text']);
  assert.throws(()=>cliHistoryArgs('2.99.0',help,projectRef),/Unvalidated/);
  assert.throws(()=>cliHistoryArgs('2.121.0','--output',projectRef),/Unvalidated/);
  assert.throws(()=>cliHistoryArgs('2.121.0',help,'bad'),/ref required/);
});
