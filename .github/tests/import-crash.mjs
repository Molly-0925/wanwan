import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const scripts = new Map(await Promise.all([
  ['/dexie.js', require.resolve('dexie/dist/dexie.js')],
  ['/data.js', resolve('js/data.js')],
  ['/data-stream.js', resolve('js/data-stream.js')],
].map(async ([url, path]) => [url, await readFile(path)])));
const server = createServer((req, res) => {
  if (scripts.has(req.url)) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
    res.end(scripts.get(req.url));
  } else {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta charset="utf-8"><script src="/dexie.js"></script><script src="/data.js"></script><script src="/data-stream.js"></script>');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
const root = await mkdtemp(join(tmpdir(), 'wanwan-crash-'));

async function launch(profile) {
  await mkdir(profile, {recursive:true});
  let diagnostic = '';
  const proc = spawn('google-chrome', [
    '--headless', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage', '--disable-gpu',
    '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
  ], { stdio: ['ignore','ignore','pipe'], detached: true });
  proc.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-6500); });
  const exited = new Promise(resolve => proc.once('exit', resolve));
  try {
    for (let i = 0; i < 160 && proc.exitCode === null; i++) {
      const port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      if (port) {
        const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port.split('\n')[0]);
        return { browser, context: browser.contexts()[0], async kill() {
          process.kill(-proc.pid, 'SIGKILL');
          await exited;
          await rm(join(profile, 'DevToolsActivePort'), { force: true });
          for (const name of ['SingletonLock','SingletonSocket','SingletonCookie']) await rm(join(profile,name),{force:true});
        } };
      }
      await delay(75);
    }
    throw Error('Chrome did not start (' + proc.exitCode + '): ' + diagnostic);
  } catch (e) {
    if (proc.exitCode === null) process.kill(-proc.pid, 'SIGKILL');
    throw e;
  }
}
async function open(page) {
  await page.goto(url);
  await page.evaluate(async () => {
    window.db = new Dexie('wanwan-crash-audit');
    db.version(1).stores({config:'key', characters:'id', chats:'id', messages:'id', imageBlobs:'id',backupImportStage:'++id',backupImportRecovery:'key'});
    await db.open();
    await recoverWanWanBackupImport();
  });
}
const cases = [
  ['before-start','kill'], ['parsed-staged','kill'], ['first-write','kill'], ['first-batch','kill'],
  ['multiple-batches','kill'], ['last-batch','kill'], ['before-commit','kill'],
  ['settings-before-commit','kill'], ['post-commit-pre-feedback','kill'],
  ['first-batch','reload'], ['multiple-batches','close'],
];
const results = [];
console.log('Crash test revision:', process.env.GITHUB_SHA || 'local');
console.log('Isolation: dedicated Chrome process group and clean profile per case.');
try {
for (const [phase, termination] of cases) {
  const profile = join(root, phase + '-' + termination);
  let session = await launch(profile);
  try {
    const page = await session.context.newPage();
    await open(page);
    await page.evaluate(async () => {
      await db.characters.bulkPut([{id: 1, epoch:'old'}, {id: 2, epoch:'old'}]);
      await db.chats.bulkPut([{id: 1, charId:1, epoch:'old'}, {id: 2, charId:2, epoch:'old'}]);
      await db.messages.bulkPut(Array.from({length: 3}, (_, i) => ({id: i+1, chatId:i%2+1, epoch:'old'})));
      await db.imageBlobs.put({id: 1, blob: new Blob(['old-image'])});
      localStorage.setItem('audit', 'old');
    });
    // Let Chrome persist the seeded localStorage before testing abrupt exit.
    await delay(6500);
    const reached = new Promise(resolve => page.on('console', msg => {
      if (msg.text() === 'WANWAN_PAUSE ' + phase) resolve();
    }));
    const execution = page.evaluate(async phase => {
      let active;
      const hold = () => new Promise(() => {});
      const signal = () => console.log('WANWAN_PAUSE ' + phase);
      const prepare = db.backupImportRecovery.put.bind(db.backupImportRecovery);
      if (phase === 'parsed-staged') {
        db.backupImportRecovery.put = async (...args) => {
          signal();
          await hold();
          return prepare(...args);
        };
      }
      const orig = db.transaction.bind(db);
      db.transaction = async (mode, tables, callback) => {
        const result = await orig(mode, tables, async tx => {
          active = tx;
          let messagesWritten = 0;
          const instrumented = new WeakSet();
          const table = tx.table.bind(tx);
          tx.table = name => {
            const bound = table(name);
            if (instrumented.has(bound)) return bound;
            instrumented.add(bound);
            if (name === 'characters' || name === 'messages') {
              const write = bound.bulkPut.bind(bound);
              bound.bulkPut = rows => {
                const request = write(rows);
                if (name === 'messages') messagesWritten += rows.length;
                const limit = {'first-batch':200,'multiple-batches':400,'last-batch':601}[phase];
                if ((phase === 'first-write' && name === 'characters') ||
                    (name === 'messages' && messagesWritten === limit)) {
                  signal();
                  return tx.waitFor(request.then(hold));
                }
                return request;
              };
            }
            if (phase === 'before-commit' && name === 'backupImportRecovery') {
              const write = bound.put.bind(bound);
              bound.put = record => {
                signal();
                return tx.waitFor(hold()).then(() => write(record));
              };
            }
            return bound;
          };
          const result = await callback(tx);
          if (phase === 'settings-before-commit') {
            signal();
            await tx.waitFor(hold());
          }
          return result;
        });
        if (phase === 'post-commit-pre-feedback') { signal(); await hold(); }
        return result;
      };
      if (phase === 'before-start') { signal(); await hold(); }
      const payload = JSON.stringify({
        version:1, appName:'弯弯',
        characters:[{id:1,epoch:'new'},{id:2,epoch:'new'}],
        chats:[{id:1,charId:1,epoch:'new'},{id:2,charId:2,epoch:'new'}],
        messages:Array.from({length:601},(_,i)=>({id:i+1,chatId:i%2+1,epoch:'new'})),
        imageBlobs:[{id:1,blob:{__blob__:1,b64:'bmV3LWltYWdl',type:'text/plain'}}],
        localStorage:{audit:'new'}
      });
      const source = new Blob([payload]);
      await runWanWanStreamImport(source, pct => {
        if (pct === 100) console.log('WANWAN_SUCCESS_FEEDBACK');
      }, {clearBeforeImport:true});
    }, phase).catch(error => String(error));
    const timeout = new AbortController();
    try {
      await Promise.race([reached, execution.then(error => { throw Error('Ended before pause: '+error); }),
        delay(15000, null, {signal:timeout.signal}).then(() => {throw Error('Pause timed out');})]);
    } finally { timeout.abort(); }
    let feedback = false;
    page.on('console', msg => { if (msg.text() === 'WANWAN_SUCCESS_FEEDBACK') feedback = true; });
    if (termination === 'kill') {
      if (phase === 'settings-before-commit' || phase === 'post-commit-pre-feedback') await delay(6500);
      await session.kill();
      session = await launch(profile);
    } else if (termination === 'close') { await page.close(); }
    else { await page.reload({waitUntil:'domcontentloaded'}); }
    const reopened = await session.context.newPage();
    await open(reopened);
    const observed = await reopened.evaluate(async () => {
      const characters = await db.characters.toArray();
      const chats = await db.chats.toArray();
      const messages = await db.messages.toArray();
      const attachments = await db.imageBlobs.toArray();
      return {counts:[characters.length,chats.length,messages.length,attachments.length],
        generations:[...new Set([...characters,...chats,...messages].map(r=>r.epoch))],
        orphanMessages:messages.filter(m=>!chats.some(c=>c.id===m.chatId)).length,
        orphanChats:chats.filter(c=>!characters.some(r=>r.id===c.charId)).length,
        attachment:await attachments[0]?.blob.text(), setting:localStorage.getItem('audit')};
    });
    const expected = phase === 'post-commit-pre-feedback' ? 'new' : 'old';
    const idbOK = JSON.stringify(observed.counts)===JSON.stringify([2,2,expected==='new'?601:3,1])
      && observed.generations.join()===expected && observed.attachment===expected+'-image'
      && !observed.orphanChats && !observed.orphanMessages;
    results.push({phase,termination,expected,observed,feedback,pass:idbOK&&observed.setting===expected&&!feedback});
  } catch (error) {
    results.push({phase,termination,pass:false,error:String(error)});
  } finally {
    await session.kill().catch(()=>{});
  }
}
} finally {
  server.close();
  await rm(root,{recursive:true,force:true});
}
await writeFile('wanwan-crash-results.json',JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify(results,null,2));
assert.ok(results.every(result=>result.pass), 'Crash recovery gate failed');
