import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const browser = await chromium.launch({channel:'chrome'});
const page = await browser.newPage();
const results=[];
function pass(name, detail) { results.push({name,detail,pass:true}); }
try {
  await page.route('https://wanwan-audit.test/',r=>r.fulfill({
    contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset="utf-8">',
  }));
  const open = async old => {
    await page.goto('https://wanwan-audit.test/');
    await page.addScriptTag({path:require.resolve('dexie/dist/dexie.js')});
    if(old) await page.addScriptTag({content:execFileSync('git',['show','d7d95b5d39c1b144016b89f7411cf5e094bd18ee:js/db.js'],{encoding:'utf8'})});
    else {
      for(const script of ['backup-write-guard','db','data','data-stream']) {
        await page.addScriptTag({path:resolve('js/'+script+'.js')});
      }
    }
    await page.evaluate(async old=>{
      await db.open();
      if (!old) await recoverWanWanBackupImport();
    },old);
  };
  await open(true);
  await page.evaluate(async()=>{
    await db.characters.bulkPut([{id:1,name:'old-1'},{id:2,name:'old-2'}]);
    await db.chats.bulkPut([{id:1,charId:1},{id:2,charId:2}]);
    await db.messages.put({id:1,chatId:1,content:'pre-upgrade'});
    localStorage.setItem('audit','old');
    localStorage.setItem('wanwan_online_device_id','local-device');
    db.close();
  });
  await open(false);
  assert.deepEqual(await page.evaluate(async()=>[db.verno,(await db.messages.get(1)).content,localStorage.getItem('audit')]),[16,'pre-upgrade','old']);
  pass('schema-upgrade-preserves-old-data',[15,16]);
  for(const [name,source] of [
    ['invalid-json','{"version":1,"appName":"弯弯",}'],
    ['truncated','{"version":1,"appName":"弯弯","messages":[{"id":1,"chatId":1,"content":"changed"}],'],
    ['missing-version','{"appName":"弯弯","messages":[]}'],
    ['wrong-version','{"version":2,"appName":"弯弯","messages":[]}'],
    ['duplicate-table','{"version":1,"appName":"弯弯","messages":[],"messages":[]}'],
    ['duplicate-id','{"version":1,"appName":"弯弯","messages":[{"id":1},{"id":1}]}'],
    ['missing-id','{"version":1,"appName":"弯弯","messages":[{"chatId":1}]}'],
  ]){
    const result=await page.evaluate(async source=>{
      let error='';
      try {await runWanWanStreamImport(new Blob([source]),null,{clearBeforeImport:true});}
      catch(e){error=e.message;}
      return {error,persisted:(await db.messages.get(1))?.content,staged:await db.backupImportStage.count()};
    },source);
    assert.ok(result.error,name);
    assert.equal(result.persisted,'pre-upgrade',name);
    assert.equal(result.staged,0,name);
    pass(name,result.error);
  }
  const successful=await page.evaluate(async()=>{
    const long='wanwan-probe-'.repeat(65);
    const backup={
      version:1,appName:'弯弯',characters:Array.from({length:12},(_,i)=>({id:i+1,name:'role-'+(i+1)})),
      chats:Array.from({length:24},(_,i)=>({id:i+1,charId:i%12+1})),
      messages:Array.from({length:4200},(_,i)=>({id:i+1,chatId:i%24+1,content:long+i})),
      imageBlobs:[{id:1,blob:{__blob__:1,b64:btoa('X'.repeat(524288)),type:'image/png'}}],
      config:[{key:'theme',value:3}], memories:[{id:1,chatId:1,createdAt:123,sourceAt:123}],
      localStorage:{audit:'restored',wanwan_online_device_id:'external'},
    };
    const source=new Blob([JSON.stringify(backup)]);
    const events=[];
    for(let i=0;i<2;i++){
      await runWanWanStreamImport(source,(pct)=>{if(pct===100)events.push(pct);},{clearBeforeImport:true});
    }
    const chars=await db.characters.toArray(),chats=await db.chats.toArray(),messages=await db.messages.toArray();
    const exported=await window.buildBackupData();
    return {bytes:source.size,events,counts:[chars.length,chats.length,messages.length,exported.imageBlobs.length,exported.memories.length],
      orphan:messages.filter(m=>!chats.some(c=>c.id===m.chatId)).length+chats.filter(c=>!chars.some(r=>r.id===c.charId)).length,
      attachment:(await db.imageBlobs.get(1)).blob.size,device:localStorage.getItem('wanwan_online_device_id')};
  });
  assert.ok(successful.bytes>4*1024*1024);
  assert.deepEqual(successful.counts,[12,24,4200,1,1]);
  assert.deepEqual(successful.events,[100,100]);
  assert.equal(successful.orphan,0);
  assert.equal(successful.attachment,524288);
  assert.equal(successful.device,'local-device');
  pass('large-binary-repeat-and-export',successful);
  await open(false);
  const persisted=await page.evaluate(async()=>[await db.messages.count(),(await db.imageBlobs.get(1)).blob.size,localStorage.getItem('audit')]);
  assert.deepEqual(persisted,[4200,524288,'restored']);
  pass('close-and-open-document',persisted);
} catch(error) {
  results.push({pass:false,error:String(error),stack:error.stack});
  throw error;
} finally {
  await writeFile('wanwan-full-import-results.json',JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify(results,null,2));
  await browser.close();
}
