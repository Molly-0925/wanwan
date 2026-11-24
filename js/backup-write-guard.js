// Tracks durable changes in the same transaction as each ordinary write.
(function () {
  'use strict'
  var STORE = 'backupImportRecovery'
  var KEY = 'write-version'
  var importTransactions = new WeakSet()

  function initialVersion() { return { key: KEY, generation: '', revision: 0 } }

  window.installWanWanBackupWriteGuard = function(database) {
    var tabGeneration
    database.on('ready', async function(vip) {
      if (tabGeneration === undefined) {
        tabGeneration = ((await vip.table(STORE).get(KEY)) || initialVersion()).generation
      }
    })
    database.use({
      stack: 'dbcore',
      name: 'wanwan-backup-write-guard',
      create: function(down) {
        function internal(name) { return name === STORE || name === 'backupImportStage' }
        return Object.assign({}, down, {
          transaction: function(names, mode, options) {
            if (mode === 'readwrite' && down.schema.tables.some(function(table) { return table.name === STORE }) &&
                names.some(function(name) { return !internal(name) }) && !names.includes(STORE)) {
              names = names.concat(STORE)
            }
            return down.transaction(names, mode, options)
          },
          table: function(name) {
            var target = down.table(name)
            if (internal(name)) return target
            return Object.assign({}, target, {
              mutate: async function(request) {
                if (importTransactions.has(request.trans)) return target.mutate(request)
                var journal = down.table(STORE)
                var current = await journal.get({ trans: request.trans, key: KEY }) || initialVersion()
                if (tabGeneration !== current.generation) {
                  var error = new Error('另一页面已恢复备份，请刷新后重新提交这次修改')
                  error.name = 'WanWanStaleAfterImportError'
                  if (window.toast) window.toast(error.message)
                  throw error
                }
                var result = await target.mutate(request)
                var advanced = await journal.mutate({ trans: request.trans, type: 'put',
                  values: [{ key: KEY, generation: current.generation, revision: current.revision + 1 }] })
                if (advanced.numFailures) {
                  request.trans.abort()
                  throw advanced.failures[0]
                }
                return result
              }
            })
          }
        })
      }
    })
  }

  window.readWanWanBackupWriteVersion = async function(table) {
    return await table.get(KEY) || initialVersion()
  }

  window.authorizeWanWanBackupCommit = async function(transaction, snapshot, generation) {
    var journal = transaction.table(STORE)
    var current = await window.readWanWanBackupWriteVersion(journal)
    if (snapshot.revision !== current.revision || snapshot.generation !== current.generation) {
      throw new Error('暂存期间已有其他页面保存数据，本次导入未提交，请重新发起导入')
    }
    importTransactions.add(transaction.idbtrans)
    await journal.put({ key: KEY, generation: generation, revision: current.revision + 1 })
  }
})()
