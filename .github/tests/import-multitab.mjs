import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const browser = await chromium.launch({ channel: 'chrome' });
const passed = [];
const outcome = [];
const scenarios = ['chat-during-stage', 'role-during-stage', 'stale-after-import', 'double-import',
  'secondary-refresh', 'secondary-close', 'visibility-switch'];
const payload = name => ({
  version:1, appName:'弯弯', characters:[{id:1,name}], chats:[{id:1,charId:1}],
  messages:[{id:1,chatId:1,content:name}], localStorage:{audit:name}
});
async function open(page) {
  await page.goto('https://wanwan-audit.test/');
  await page.addScriptTag({ path: require.resolve('dexie/dist/dexie.js') });
  await page.addScriptTag({ path: resolve('js/data.js') });
  await page.addScriptTag({ path: resolve('js/data-stream.js') });
  await page.evaluate(async () => {
    window.db = new Dexie('wanwan-multitab-audit');
    db.version(1).stores({config:'key', characters:'id', chats:'id', messages:'id',
      backupImportStage:'++id',backupImportRecovery:'key'});
    await db.open();
  });
}
function runImport(page, data) {
  return page.evaluate(async data => {
    try {
      await runWanWanStreamImport(new Blob([JSON.stringify(data)]), null, {clearBeforeImport:true});
      return {ok:true};
    } catch (e) { return {ok:false,error:e.message}; }
  }, data);
}
try {
for(const name of scenarios) {
  const context = await browser.newContext();
  try {
    await context.route('https://wanwan-audit.test/', route => route.fulfill({contentType:'text/html',body:'<!doctype html><meta charset="utf-8">'}));
    const a = await context.newPage(), b = await context.newPage();
    await Promise.all([open(a),open(b)]);
    await a.evaluate(async () => {
      await db.characters.put({id:1,name:'old'});
      await db.chats.put({id:1,charId:1});
      await db.messages.put({id:1,chatId:1,content:'old'});
    });
    await b.evaluate(async () => {window.previousRole = await db.characters.get(1);});
    let release;
    const gate = new Promise(resolve => {release = resolve;});
    let reached;
    const waiting = new Promise(resolve => {reached = resolve;});
    await a.exposeFunction('pauseBeforeCommit', () => {reached(); return gate;});
    await a.evaluate(() => {
      const put = db.backupImportRecovery.put.bind(db.backupImportRecovery);
      db.backupImportRecovery.put = async (...args) => {
        await window.pauseBeforeCommit();
        return put(...args);
      };
    });
    const first = runImport(a,payload('restored'));
    const timeout = new AbortController();
    try {
      await Promise.race([waiting,first.then(result => {throw Error('Import ended before pause '+JSON.stringify(result));}),
        delay(10000,null,{signal:timeout.signal}).then(()=>{throw Error('Import pause timeout');})]);
    } finally {timeout.abort();}
    let runnerB, concurrent;
    if (name==='chat-during-stage' || name==='visibility-switch') {
      if (name==='visibility-switch') await b.bringToFront();
      concurrent = await b.evaluate(async () => {await db.messages.add({id:2,chatId:1,content:'tab-b'}); return true;});
    }
    if(name==='role-during-stage') concurrent = await b.evaluate(async ()=>!!await db.characters.update(1,{name:'tab-b'}));
    if(name==='double-import') {
      runnerB = runImport(b,payload('second'));
      await delay(200);
      concurrent = await b.evaluate(async ()=>{
        const state = await navigator.locks.query();
        return state.pending.some(lock=>lock.name==='wanwan-backup-import');
      });
    }
    if(name==='secondary-refresh') {await b.reload(); await open(b);}
    if(name==='secondary-close') await b.close();
    release();
    const firstResult = await first;
    const secondResult = runnerB ? await runnerB : null;
    if(name==='stale-after-import') {
      concurrent = await b.evaluate(async ()=>{
        try { await db.characters.put({...window.previousRole, oldPage:true}); return true; }
        catch(error) { return error.message; }
      });
    }
    const final = await a.evaluate(async () => ({
      role:await db.characters.get(1), messages:await db.messages.toArray(),
      chats:await db.chats.toArray(), settings:localStorage.getItem('audit')
    }));
    const expected = {
      'chat-during-stage': (!firstResult.ok && final.messages.some(r=>r.id===2)) || final.messages.some(r=>r.id===2),
      'role-during-stage': final.role?.name==='tab-b',
      'stale-after-import': firstResult.ok && final.role?.name==='restored' && !final.role?.oldPage,
      'double-import': firstResult.ok && secondResult?.ok && concurrent && final.role?.name==='second',
      'secondary-refresh': firstResult.ok && final.role?.name==='restored',
      'secondary-close': firstResult.ok && final.role?.name==='restored',
      'visibility-switch': final.messages.some(r=>r.id===2),
    }[name];
    const pass = Boolean(expected && !final.messages.some(m=>!final.chats.some(c=>c.id===m.chatId)));
    if(pass) passed.push(name);
    outcome.push({name,concurrent,firstResult,secondResult,final,pass});
  } catch(error) {outcome.push({name,error:String(error),pass:false});}
  finally {await context.close();}
}
} finally {await browser.close();}
await writeFile('wanwan-multitab-results.json', JSON.stringify(outcome,null,2)+'\n');
console.log(JSON.stringify(outcome,null,2));
assert.equal(passed.length,scenarios.length,'Multitab gate failed');
