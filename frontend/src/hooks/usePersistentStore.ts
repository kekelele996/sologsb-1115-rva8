import { useStore } from 'zustand'
import type { StoreApi, UseBoundStore } from 'zustand'
import Dexie, { type Table } from 'dexie'
import type { Cabinet, CollectSite, Determination, Receipt, Specimen, Storage } from '@/types'
import { normalizeBackup } from '@/utils/migrate'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** Dexie 封装：标本 / 采集地 / 鉴定记录 属野外侧；保藏位置 / 接收决定 / 柜位容量 属库房侧 + 元数据表 */
class InsectLogDb extends Dexie {
  specimens!: Table<Specimen, string>
  sites!: Table<CollectSite, string>
  storages!: Table<Storage, string>
  determinations!: Table<Determination, string>
  receipts!: Table<Receipt, string>
  cabinets!: Table<Cabinet, string>
  meta!: Table<MetaRow, string>

  constructor() {
    super('gbinsectlog')
    this.version(1).stores({
      specimens: 'id, code, order, status, siteId',
      sites: 'id, code, name',
      storages: 'id, specimenId, cabinet',
      determinations: 'id, specimenId, determiner',
      meta: 'key'
    })
    // v2：新增「采集方式」字段，迁移时为历史标本补齐默认采集方式（扫网）
    this.version(2)
      .stores({
        specimens: 'id, code, order, family, status, siteId, collectDate',
        sites: 'id, code, name, habitat',
        storages: 'id, specimenId, cabinet, drawer',
        determinations: 'id, specimenId, determiner, date',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        await tx
          .table<Specimen, string>('specimens')
          .toCollection()
          .modify((specimen) => {
            if (!specimen.method) {
              specimen.method = '扫网'
            }
          })
      })
    // v3：采集登记与保藏上柜分离为野外侧 / 库房侧
    // - 库房侧新增 receipts（接收决定）与 cabinets（柜位容量）两张表
    // - 历史上柜记录补齐 receiptId / specimenCode 并生成「已接收」决定
    // - 历史标本补齐保藏方式，柜位容量按上柜记录中的柜号补齐
    this.version(SCHEMA_VERSION)
      .stores({
        specimens: 'id, code, order, family, status, siteId, collectDate, preserveMethod',
        sites: 'id, code, name, habitat',
        storages: 'id, receiptId, specimenId, specimenCode, cabinet, drawer',
        determinations: 'id, specimenId, determiner, date',
        receipts: 'id, batchNo, specimenId, decision',
        cabinets: 'id, code',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        const [specimens, storages, sites, determinations] = await Promise.all([
          tx.table<Specimen, string>('specimens').toArray(),
          tx.table<Storage, string>('storages').toArray(),
          tx.table<CollectSite, string>('sites').toArray(),
          tx.table<Determination, string>('determinations').toArray()
        ])
        const normalized = normalizeBackup({ specimens, storages, sites, determinations })
        await Promise.all([
          tx.table<Specimen, string>('specimens').bulkPut(normalized.specimens),
          tx.table<Storage, string>('storages').bulkPut(normalized.storages),
          tx.table<Receipt, string>('receipts').bulkPut(normalized.receipts),
          tx.table<Cabinet, string>('cabinets').bulkPut(normalized.cabinets)
        ])
      })
  }
}

export const db = new InsectLogDb()

/** 写入当前数据结构版本号 */
export async function stampDbVersion(): Promise<void> {
  await db.meta.put({ key: 'schemaVersion', value: SCHEMA_VERSION })
}

/** 读取整表 */
export async function loadAll<T extends object>(table: Table<T, string>): Promise<T[]> {
  return table.toArray()
}

/** 写入一条记录 */
export async function putRow<T extends object>(table: Table<T, string>, row: T): Promise<void> {
  await table.put(row)
}

/** 批量写入 */
export async function putRows<T extends object>(table: Table<T, string>, rows: T[]): Promise<void> {
  await table.bulkPut(rows)
}

/** 删除一条记录 */
export async function deleteRow<T extends object>(table: Table<T, string>, id: string): Promise<void> {
  await table.delete(id)
}

/**
 * 把 Zustand store 桥接到 React：
 * - 所有页面通过它读取 store（内部即 Dexie 表的内存镜像）
 * - 写入统一走 store 的 save / remove，由 store 调用 Dexie 并回填内存状态
 */
export function usePersistentStore<T extends object>(store: UseBoundStore<StoreApi<T>>): T
export function usePersistentStore<T extends object, S>(
  store: UseBoundStore<StoreApi<T>>,
  selector: (state: T) => S
): S
export function usePersistentStore<T extends object, S>(
  store: UseBoundStore<StoreApi<T>>,
  selector?: (state: T) => S
): T | S {
  return useStore(store, selector ?? ((state: T) => state as unknown as S))
}

/** 首次打开时写入示例数据，保证各页面进入即有事可做 */
export async function seedDemoData(): Promise<void> {
  const count = await db.sites.count()
  if (count > 0) return

  const today = new Date().toISOString().slice(0, 10)

  await db.sites.bulkPut([
    {
      id: 'site_qlb',
      code: 'QLB',
      name: '青龙背斜阔叶林样地',
      region: '黔南州 · 平塘县',
      longitude: 107.2136,
      latitude: 25.8123,
      altitude: 986,
      habitat: '阔叶林',
      microHabitat: '林下腐殖层厚，倒木与落叶堆积',
      microClimate: '午后无风，湿度偏高',
      dateStart: today,
      dateEnd: today
    },
    {
      id: 'site_shr',
      code: 'SHR',
      name: '双河湿地芦苇荡',
      region: '黔南州 · 惠水县',
      longitude: 106.7521,
      latitude: 26.1178,
      altitude: 812,
      habitat: '湿地',
      microHabitat: '水边芦苇与香蒲混生，浅水区',
      microClimate: '傍晚起雾，风速 1 级',
      dateStart: today,
      dateEnd: today
    }
  ])

  await db.specimens.bulkPut([
    {
      id: 'sp_001',
      code: 'QLB-2026-0001',
      order: '鞘翅目',
      family: '步甲科',
      genus: 'Carabus',
      species: 'sp.',
      tempName: '大黑步甲',
      collectDate: today,
      collector: '陆昀',
      sex: '雄',
      stage: '成虫',
      bodyLength: 28.4,
      method: '徒手',
      quantity: 1,
      preserveMethod: '针插',
      status: '已鉴定',
      determiner: '覃羽',
      siteId: 'site_qlb',
      note: '倒木下采集，鞘翅完整'
    },
    {
      id: 'sp_002',
      code: 'QLB-2026-0002',
      order: '鳞翅目',
      family: '夜蛾科',
      genus: '',
      species: '',
      tempName: '灰褐夜蛾',
      collectDate: today,
      collector: '陆昀',
      sex: '未知',
      stage: '成虫',
      bodyLength: 16.2,
      method: '灯诱',
      quantity: 3,
      preserveMethod: '针插',
      status: '初鉴',
      determiner: '覃羽',
      siteId: 'site_qlb',
      note: '灯诱 20:30–22:00，翅面有磨损'
    },
    {
      id: 'sp_003',
      code: 'SHR-2026-0001',
      order: '蜻蜓目',
      family: '蜻科',
      genus: 'Sympetrum',
      species: '',
      tempName: '赤蜻（待复核）',
      collectDate: today,
      collector: '蓝澈',
      sex: '雌',
      stage: '成虫',
      bodyLength: 38.1,
      method: '扫网',
      quantity: 2,
      preserveMethod: '针插',
      status: '待复核',
      determiner: '蓝澈',
      siteId: 'site_shr',
      note: '与相近种混淆，需核对翅脉'
    },
    {
      id: 'sp_004',
      code: 'SHR-2026-0002',
      order: '双翅目',
      family: '摇蚊科',
      genus: '',
      species: '',
      tempName: '摇蚊未定种',
      collectDate: today,
      collector: '蓝澈',
      sex: '未知',
      stage: '幼虫',
      bodyLength: 6.5,
      method: '巴氏罐诱',
      quantity: 12,
      preserveMethod: '浸液',
      status: '待鉴定',
      determiner: '',
      siteId: 'site_shr',
      note: '酒精浸液保存，待制片'
    }
  ])

  await db.determinations.bulkPut([
    {
      id: 'det_001',
      specimenId: 'sp_001',
      determiner: '覃羽',
      date: today,
      conclusion: 'Carabus smaragdinus',
      reference: '《中国步甲志》第二卷 P.218',
      confidence: '高',
      needReview: false
    },
    {
      id: 'det_002',
      specimenId: 'sp_002',
      determiner: '覃羽',
      date: today,
      conclusion: 'Noctuidae sp.',
      reference: '《中国蛾类图鉴》Vol.3',
      confidence: '中',
      needReview: true
    }
  ])

  await db.cabinets.bulkPut([
    { id: 'cab_c01', code: 'C01', drawers: 2, boxes: 3, slots: 8 }
  ])

  await db.receipts.bulkPut([
    {
      id: 'rec_001',
      batchNo: 'HISTORY',
      specimenId: 'sp_001',
      specimenCode: 'QLB-2026-0001',
      method: '针插',
      decision: 'accepted',
      reason: '',
      receivedDate: today,
      handler: '覃羽'
    },
    {
      id: 'rec_002',
      batchNo: 'HISTORY',
      specimenId: 'sp_002',
      specimenCode: 'QLB-2026-0002',
      method: '针插',
      decision: 'accepted',
      reason: '',
      receivedDate: today,
      handler: '覃羽'
    }
  ])

  await db.storages.bulkPut([
    {
      id: 'stg_001',
      receiptId: 'rec_001',
      specimenId: 'sp_001',
      specimenCode: 'QLB-2026-0001',
      method: '针插',
      cabinet: 'C01',
      drawer: 1,
      box: 2,
      slot: 3,
      storedDate: today,
      handler: '覃羽'
    },
    {
      id: 'stg_002',
      receiptId: 'rec_002',
      specimenId: 'sp_002',
      specimenCode: 'QLB-2026-0002',
      method: '针插',
      cabinet: 'C01',
      drawer: 1,
      box: 2,
      slot: 5,
      storedDate: today,
      handler: '覃羽'
    }
  ])
}
