import { db } from '@/hooks/usePersistentStore'
import { downloadJson } from './export'
import { normalizeBackup, type BackupPayload } from './migrate'

/** 组装当前全库备份 */
async function collectPayload(): Promise<BackupPayload> {
  const [sites, specimens, determinations, storages, receipts, cabinets] = await Promise.all([
    db.sites.toArray(),
    db.specimens.toArray(),
    db.determinations.toArray(),
    db.storages.toArray(),
    db.receipts.toArray(),
    db.cabinets.toArray()
  ])
  return {
    schemaVersion: 3,
    sites,
    specimens,
    determinations,
    storages,
    receipts,
    cabinets
  }
}

/** 导出 JSON 备份（含野外侧与库房侧全部数据） */
export async function exportBackup(): Promise<void> {
  const payload = await collectPayload()
  const date = new Date().toISOString().slice(0, 10)
  downloadJson(`昆虫标本备份-${date}.json`, { exportedAt: new Date().toISOString(), ...payload })
}

export interface ImportResult {
  sites: number
  specimens: number
  determinations: number
  receipts: number
  cabinets: number
  storages: number
}

/**
 * 导入 JSON 备份：
 * - 缺字段的老备份按现有迁移写法补齐（缺省字段 + 历史上柜记录补接收决定 + 补柜位容量）；
 * - 事务内整库替换，避免半套数据。
 */
export async function importBackupFile(file: File): Promise<ImportResult> {
  const text = await file.text()
  const raw = JSON.parse(text) as BackupPayload
  const normalized = normalizeBackup(raw)
  await db.transaction(
    'rw',
    [db.sites, db.specimens, db.determinations, db.storages, db.receipts, db.cabinets, db.meta],
    async () => {
      await Promise.all([
        db.sites.clear(),
        db.specimens.clear(),
        db.determinations.clear(),
        db.storages.clear(),
        db.receipts.clear(),
        db.cabinets.clear()
      ])
      await Promise.all([
        db.sites.bulkPut(normalized.sites),
        db.specimens.bulkPut(normalized.specimens),
        db.determinations.bulkPut(normalized.determinations),
        db.storages.bulkPut(normalized.storages),
        db.receipts.bulkPut(normalized.receipts),
        db.cabinets.bulkPut(normalized.cabinets),
        db.meta.put({ key: 'schemaVersion', value: 3 })
      ])
    }
  )
  return {
    sites: normalized.sites.length,
    specimens: normalized.specimens.length,
    determinations: normalized.determinations.length,
    receipts: normalized.receipts.length,
    cabinets: normalized.cabinets.length,
    storages: normalized.storages.length
  }
}
