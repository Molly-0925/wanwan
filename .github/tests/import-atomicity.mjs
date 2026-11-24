import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage();
  await page.route('https://wanwan-audit.test/', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Isolated IndexedDB audit</title>',
  }));
  await page.goto('https://wanwan-audit.test/');
  await page.addScriptTag({ path: require.resolve('dexie/dist/dexie.js') });
  await page.addScriptTag({ path: resolve('js/backup-write-guard.js') });
  await page.addScriptTag({ path: resolve('js/data.js') });
  await page.addScriptTag({ path: resolve('js/data-stream.js') });
  await page.evaluate(async () => {
    const db = window.db = new Dexie('wanwan-isolated-test');
    db.version(1).stores({ config: 'key', characters: 'id', messages: 'id', imageBlobs: 'id', backupImportStage: '++id', backupImportRecovery: 'key' });
    installWanWanBackupWriteGuard(db);
    await db.open();
    await db.characters.put({ id: 1, name: 'original' });
    localStorage.setItem('audit', 'original');
    localStorage.setItem('wanwan_online_device_id', 'protected');
    const check = (condition, message) => { if (!condition) throw Error(message); };
    async function rejects(action, pattern) {
      try { await action(); } catch (error) {
        check(pattern.test(error.message), 'Unexpected failure: ' + error.message);
        return;
      }
      throw Error('Expected rejection');
    }
    async function original() {
      check((await db.characters.get(1)).name === 'original', 'Original IndexedDB row lost');
      check(localStorage.getItem('audit') === 'original', 'Original localStorage value lost');
    }
    const broken = new Blob(['{"version":1,"appName":"弯弯","characters":[{"id":1,"name":"overwritten"}],']);
    for (const clearBeforeImport of [false, true]) {
      await rejects(() => runWanWanStreamImport(broken, null, { clearBeforeImport }), /JSON/);
      await original();
    }

    const bytes = new TextEncoder().encode(JSON.stringify({
      version: 1, appName: '弯弯',
      characters: [{ id: 1, name: 'overwritten' }],
      messages: [{ content: 'missing IndexedDB primary key' }],
      localStorage: { audit: 'changed' },
    }));
    function sourceWithDelayedReads(data) {
      return {
        size: data.length,
        stream() {
          let offset = 0;
          return new ReadableStream({
            async pull(controller) {
              await new Promise(resolve => setTimeout(resolve, 10));
              if (offset >= data.length) { controller.close(); return; }
              controller.enqueue(data.slice(offset, offset + 32));
              offset += 32;
            },
          });
        },
      };
    }
    await rejects(() => runWanWanStreamImport(sourceWithDelayedReads(bytes)), /key|写入 messages|DataError/i);
    await original();
    const quotaData = {
      version: 1, appName: '弯弯',
      characters: [{ id: 1, name: 'overwritten' }],
      localStorage: { audit: 'changed', large: 'x'.repeat(6 * 1024 * 1024) },
    };
    await rejects(() => importBackupData(quotaData, null, { clearBeforeImport: true }), /quota/i);
    await original();
    const valid = new TextEncoder().encode(JSON.stringify({
      version: 1, appName: '弯弯',
      characters: [{ id: 1, name: 'new' }],
      imageBlobs: [{ id: 2, blob: { __blob__: 1, b64: 'd2Fud2Fu', type: 'text/plain' } }],
      localStorage: { audit: 'new', wanwan_online_device_id: 'source-device' },
    }));
    await runWanWanStreamImport(sourceWithDelayedReads(valid), null, {
      clearBeforeImport: true,
      preserveConfigRows: [{ key: 'syncBackend', value: 'github' }],
    });
    check((await db.characters.get(1)).name === 'new', 'Valid restore failed');
    check(await (await db.imageBlobs.get(2)).blob.text() === 'wanwan', 'Attachment did not survive restore');
    check((await db.config.get('syncBackend')).value === 'github', 'Sync config not preserved');
    check(localStorage.getItem('wanwan_online_device_id') === 'protected', 'Device identity changed');
    check(localStorage.getItem('audit') === 'new', 'New setting missing');
    db.close();
  });
  await page.reload();
  await page.addScriptTag({ path: require.resolve('dexie/dist/dexie.js') });
  const persisted = await page.evaluate(async () => {
    const db = new Dexie('wanwan-isolated-test');
    await db.open();
    return [(await db.table('characters').get(1)).name, localStorage.getItem('audit')];
  });
  assert.deepEqual(persisted, ['new', 'new']);
  console.log('PASS: Chromium IndexedDB merge/replace rollback, delayed reads, late write failure, quota rollback, valid import and reload');
} finally {
  await browser.close();
}
