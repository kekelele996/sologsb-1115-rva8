import { useStore } from 'zustand'
import type { StoreApi, UseBoundStore } from 'zustand'
import Dexie, { type Table } from 'dexie'
import type { CollectSite, Determination, Receipt, Specimen, Storage } from '@/types'
import { buildBatchNo } from '@/utils/codec'
import { uid } from '@/utils/id'

/** IndexedDB 数据结构版本号 */
export const SCHEMA_VERSION = 3

export interface MetaRow {
  key: string
  value: number
}

/** Dexie 封装：标本 / 采集地 / 保藏位置 / 鉴定记录 / 接收批次 五张业务表 + 元数据表 */
class InsectLogDb extends Dexie {
  specimens!: Table<Specimen, string>
  sites!: Table<CollectSite, string>
  storages!: Table<Storage, string>
  determinations!: Table<Determination, string>
  receipts!: Table<Receipt, string>
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
    // v3：库房侧自立台账——新增「接收批次」表，保藏位置归属到批次；
    // 历史柜位第一次打开时迁移到库房侧补齐关系，缺字段的老备份照 v2 的写法补默认值
    this.version(SCHEMA_VERSION)
      .stores({
        specimens: 'id, code, order, family, status, siteId, collectDate',
        sites: 'id, code, name, habitat',
        storages: 'id, specimenId, receiptId, cabinet, drawer',
        determinations: 'id, specimenId, determiner, date',
        receipts: 'id, batchNo, decision, date',
        meta: 'key'
      })
      .upgrade(async (tx) => {
        const today = new Date().toISOString().slice(0, 10)
        // 缺字段的老备份照 v2 的导入写法补默认值
        await tx
          .table<Specimen, string>('specimens')
          .toCollection()
          .modify((specimen) => {
            if (!specimen.method) specimen.method = '扫网'
            if (!specimen.status) specimen.status = '待鉴定'
            if (!specimen.quantity) specimen.quantity = 1
          })
        await tx
          .table<Storage, string>('storages')
          .toCollection()
          .modify((storage) => {
            if (!storage.method) storage.method = '针插'
            if (!storage.storedDate) storage.storedDate = today
            if (!storage.handler) storage.handler = ''
          })
        // 历史柜位迁移到库房侧：按 入柜日期+经手人+保藏方式+柜 归并成接收批次，回填 receiptId 补齐关系
        const storages = await tx.table<Storage, string>('storages').toArray()
        if (storages.length === 0) return
        const specimens = await tx.table<Specimen, string>('specimens').toArray()
        const specimenMap = new Map(specimens.map((specimen) => [specimen.id, specimen]))
        const groups = new Map<string, Storage[]>()
        storages.forEach((storage) => {
          const key = [storage.storedDate, storage.handler, storage.method, storage.cabinet].join('|')
          const group = groups.get(key)
          if (group) group.push(storage)
          else groups.set(key, [storage])
        })
        const serialByYear = new Map<string, number>()
        const receipts: Receipt[] = []
        groups.forEach((rows) => {
          const first = rows[0]
          const year = (first.storedDate || today).slice(0, 4)
          const serial = (serialByYear.get(year) ?? 0) + 1
          serialByYear.set(year, serial)
          const receipt: Receipt = {
            id: uid('rcp'),
            batchNo: buildBatchNo(year, serial),
            decision: '已接收',
            method: first.method,
            cabinet: first.cabinet,
            handler: first.handler,
            date: first.storedDate,
            note: '历史数据迁移补录',
            items: rows.map((storage) => {
              const specimen = specimenMap.get(storage.specimenId)
              return {
                specimenId: storage.specimenId,
                code: specimen?.code ?? storage.specimenId,
                status: specimen?.status ?? '待鉴定'
              }
            })
          }
          receipts.push(receipt)
          rows.forEach((storage) => {
            storage.receiptId = receipt.id
          })
        })
        await tx.table<Receipt, string>('receipts').bulkPut(receipts)
        await tx.table<Storage, string>('storages').bulkPut(storages)
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

  await db.receipts.bulkPut([
    {
      id: 'rcp_001',
      batchNo: `IN-${today.slice(0, 4)}-0001`,
      decision: '已接收',
      method: '针插',
      cabinet: 'C01',
      handler: '覃羽',
      date: today,
      note: '首批接收',
      items: [
        { specimenId: 'sp_001', code: 'QLB-2026-0001', status: '已鉴定' },
        { specimenId: 'sp_002', code: 'QLB-2026-0002', status: '初鉴' }
      ]
    }
  ])

  await db.storages.bulkPut([
    {
      id: 'stg_001',
      specimenId: 'sp_001',
      receiptId: 'rcp_001',
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
      specimenId: 'sp_002',
      receiptId: 'rcp_001',
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
