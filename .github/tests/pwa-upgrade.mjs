import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright';
const require = createRequire(import.meta.url);
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8','.png':'image/png','.mp3':'audio/mpeg','.json':'application/json; charset=utf-8',
  '.jpg':'image/jpeg','.svg':'image/svg+xml'};
const oldRoot=resolve('.wanwan-baseline');
await stat(oldRoot);
let root=oldRoot;
const server=createServer(async (req,res)=>{
  try {
    const path=new URL(req.url,'http://127.0.0.1').pathname;
    const file=resolve(root,'.'+(path==='/'?'/index.html':path));
    if(!file.startsWith(root+sep)) {res.writeHead(404).end();return;}
    const data=await readFile(file);
    res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':'no-store'}).end(data);
  } catch {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'chrome'});
const page=await browser.newPage();
const evidence={origin,externalAssets:'Dexie pinned locally; unused cross-origin assets blocked in isolated test'};
try {
  const dexie=await readFile(require.resolve('dexie/dist/dexie.js'));
  await page.route('https://**/*',route=>{
    if(route.request().url().includes('dexie@4.4.3')) return route.fulfill({body:dexie,contentType:'text/javascript; charset=utf-8'});
    return route.abort();
  });
  await page.goto(origin);
  const baseline=await page.evaluate(async()=>{
    await waitForDB();
    await db.open();
    await navigator.serviceWorker.ready;
    await db.characters.put({id:51,name:'retained-role'});
    await db.chats.put({id:52,charId:51});
    await db.messages.put({id:53,chatId:52,content:'retained-chat'});
    await db.imageBlobs.put({id:54,blob:new Blob(['retained-image'],{type:'text/plain'})});
    localStorage.setItem('audit','retained-setting');
    return db.verno;
  });
  assert.equal(baseline,15);
  root=resolve('.');
  await page.reload();
  await page.waitForFunction(()=>window.db?.verno===16 && document.querySelector('#splash-tap')?.classList.contains('ready'));
  const current=await page.evaluate(async()=>{
    await navigator.serviceWorker.ready;
    const paths=['/','/manifest.json','/img/wanwan-192.png','/img/wanwan-512.png','/audio/blank.mp3','/css/base.css','/js/main.js','/js/backup-write-guard.js','/service.js'];
    const assets=Object.fromEntries(await Promise.all(paths.map(async path=>[path,(await fetch(path)).status])));
    return {schema:db.verno,assets,controller:navigator.serviceWorker.controller?.scriptURL,
      role:(await db.characters.get(51)).name,chat:(await db.messages.get(53)).content,
      image:await (await db.imageBlobs.get(54)).blob.text(),setting:localStorage.getItem('audit'),
      caches: await caches.keys()};
  });
  for(const status of Object.values(current.assets)) assert.equal(status,200);
  assert.ok(current.controller?.endsWith('/service.js'));
  assert.deepEqual([current.role,current.chat,current.image,current.setting],
    ['retained-role','retained-chat','retained-image','retained-setting']);
  assert.deepEqual(current.caches,[]);
  evidence.baselineSchema=baseline;
  evidence.current=current;
  evidence.pass=true;
} catch(error) {
  evidence.pass=false;
  evidence.error=error.stack;
  throw error;
} finally {
  await writeFile('wanwan-pwa-upgrade-results.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
  await browser.close();
  server.close();
}
