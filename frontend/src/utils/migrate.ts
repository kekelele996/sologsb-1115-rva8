import { STORAGE_METHODS } from '@/types'
import type {
  Cabinet,
  CollectSite,
  Determination,
  Receipt,
  ReceiptDecision,
  Specimen,
  Storage,
  StorageMethod
} from '@/types'
import { uid } from './id'

/**
 * 备份文件结构（导出 / 导入共用）。
 * 缺表、缺字段都按「有多少补多少」处理，规则与 Dexie 升级迁移一致。
 */
export interface BackupPayload {
  exportedAt?: string
  schemaVersion?: number
  sites?: unknown[]
  specimens?: unknown[]
  determinations?: unknown[]
  cabinets?: unknown[]
  receipts?: unknown[]
  storages?: unknown[]
}

export interface NormalizedBackup {
  sites: CollectSite[]
  specimens: Specimen[]
  determinations: Determination[]
  cabinets: Cabinet[]
  receipts: Receipt[]
  storages: Storage[]
}

const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback)
const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback
const bool = (value: unknown, fallback = false): boolean => (typeof value === 'boolean' ? value : fallback)

/** 保藏方式：非法值回退为默认针插 */
export function asStorageMethod(value: unknown): StorageMethod {
  return (STORAGE_METHODS as readonly unknown[]).includes(value) ? (value as StorageMethod) : '针插'
}

function normalizeSite(row: unknown): CollectSite {
  const raw = (row ?? {}) as Record<string, unknown>
  return {
    id: str(raw.id, uid('site')),
    code: str(raw.code).toUpperCase(),
    name: str(raw.name),
    region: str(raw.region),
    longitude: num(raw.longitude, 0),
    latitude: num(raw.latitude, 0),
    altitude: num(raw.altitude, 0),
    habitat: (['阔叶林', '针阔混交林', '草甸', '农田', '湿地', '溪流边'] as const).find((h) => h === raw.habitat) ?? '阔叶林',
    microHabitat: str(raw.microHabitat),
    microClimate: str(raw.microClimate),
    dateStart: str(raw.dateStart),
    dateEnd: str(raw.dateEnd)
  }
}

function normalizeSpecimen(row: unknown): Specimen {
  const raw = (row ?? {}) as Record<string, unknown>
  return {
    id: str(raw.id, uid('sp')),
    code: str(raw.code),
    order: str(raw.order),
    family: str(raw.family),
    genus: str(raw.genus),
    species: str(raw.species),
    tempName: str(raw.tempName),
    collectDate: str(raw.collectDate),
    collector: str(raw.collector),
    sex: (['雌', '雄', '未知'] as const).find((s) => s === raw.sex) ?? '未知',
    stage: (['成虫', '幼虫', '蛹', '卵'] as const).find((s) => s === raw.stage) ?? '成虫',
    bodyLength: num(raw.bodyLength, 0),
    method: (['扫网', '灯诱', '巴氏罐诱', '马氏网', '徒手'] as const).find((m) => m === raw.method) ?? '扫网',
    quantity: num(raw.quantity, 1),
    // 保藏方式先保留原值（可能缺字段），后面统一补齐
    preserveMethod: str(raw.preserveMethod) as StorageMethod,
    status: (['待鉴定', '初鉴', '已鉴定', '待复核'] as const).find((s) => s === raw.status) ?? '待鉴定',
    determiner: str(raw.determiner),
    siteId: str(raw.siteId),
    note: str(raw.note)
  }
}

function normalizeDetermination(row: unknown): Determination {
  const raw = (row ?? {}) as Record<string, unknown>
  return {
    id: str(raw.id, uid('det')),
    specimenId: str(raw.specimenId),
    determiner: str(raw.determiner),
    date: str(raw.date),
    conclusion: str(raw.conclusion),
    reference: str(raw.reference),
    confidence: (['高', '中', '低'] as const).find((c) => c === raw.confidence) ?? '中',
    needReview: bool(raw.needReview)
  }
}

function normalizeStorage(row: unknown): Storage {
  const raw = (row ?? {}) as Record<string, unknown>
  return {
    id: str(raw.id, uid('stg')),
    receiptId: str(raw.receiptId),
    specimenId: str(raw.specimenId),
    specimenCode: str(raw.specimenCode),
    method: asStorageMethod(raw.method),
    cabinet: str(raw.cabinet, 'C01').toUpperCase(),
    drawer: num(raw.drawer, 1),
    box: num(raw.box, 1),
    slot: num(raw.slot, 1),
    storedDate: str(raw.storedDate),
    handler: str(raw.handler)
  }
}

function normalizeReceipt(row: unknown): Receipt {
  const raw = (row ?? {}) as Record<string, unknown>
  const decision: ReceiptDecision = raw.decision === 'returned' ? 'returned' : 'accepted'
  return {
    id: str(raw.id, uid('rec')),
    batchNo: str(raw.batchNo, 'HISTORY'),
    specimenId: str(raw.specimenId),
    specimenCode: str(raw.specimenCode),
    method: asStorageMethod(raw.method),
    decision,
    reason: str(raw.reason),
    receivedDate: str(raw.receivedDate),
    handler: str(raw.handler)
  }
}

function normalizeCabinet(row: unknown): Cabinet {
  const raw = (row ?? {}) as Record<string, unknown>
  return {
    id: str(raw.id, uid('cab')),
    code: str(raw.code, 'C01').toUpperCase(),
    drawers: num(raw.drawers, 2),
    boxes: num(raw.boxes, 3),
    slots: num(raw.slots, 8)
  }
}

/**
 * 历史数据迁移 / 老备份补齐（Dexie 升级与 JSON 导入共用同一套规则）：
 * 1. 各表缺字段按默认值补齐；
 * 2. 野外队标本缺保藏方式的，沿用上柜记录的保藏方式，再缺省「针插」；
 * 3. 老的上柜记录补齐 receiptId / specimenCode，并生成「已接收」接收决定（历史批次 HISTORY）；
 * 4. 按上柜记录里出现的柜号补齐柜位容量配置（默认 2 屉 × 3 盒 × 8 位）。
 */
export function normalizeBackup(payload: BackupPayload): NormalizedBackup {
  const sites = (payload.sites ?? []).map(normalizeSite)
  const specimens = (payload.specimens ?? []).map(normalizeSpecimen)
  const determinations = (payload.determinations ?? []).map(normalizeDetermination)
  const storages = (payload.storages ?? []).map(normalizeStorage)
  const receipts = (payload.receipts ?? []).map(normalizeReceipt)
  const cabinets = (payload.cabinets ?? []).map(normalizeCabinet)

  const codeOf = new Map(specimens.map((sp) => [sp.id, sp.code]))
  const legacyReceipts: Receipt[] = []

  // 上柜记录 → 补齐接收决定与关联
  for (const storage of storages) {
    if (!storage.specimenCode) {
      storage.specimenCode = codeOf.get(storage.specimenId) ?? ''
    }
    if (!storage.receiptId) {
      const existing = receipts.find(
        (rec) => rec.specimenId === storage.specimenId && rec.decision === 'accepted'
      )
      if (existing) {
        storage.receiptId = existing.id
      } else {
        const receipt: Receipt = {
          id: uid('rec'),
          batchNo: 'HISTORY',
          specimenId: storage.specimenId,
          specimenCode: storage.specimenCode,
          method: storage.method,
          decision: 'accepted',
          reason: '',
          receivedDate: storage.storedDate,
          handler: storage.handler
        }
        legacyReceipts.push(receipt)
        storage.receiptId = receipt.id
      }
    }
  }
  const allReceipts = [...legacyReceipts, ...receipts]

  // 标本保藏方式补齐：沿用上柜方式 → 默认针插
  for (const specimen of specimens) {
    if (!specimen.preserveMethod) {
      const placed = storages.find((item) => item.specimenId === specimen.id)
      specimen.preserveMethod = placed ? placed.method : '针插'
    }
  }

  // 柜位容量：按上柜记录中出现的柜号补齐配置
  const cabinetCodes = new Set(cabinets.map((cab) => cab.code.toUpperCase()))
  for (const storage of storages) {
    const code = storage.cabinet.toUpperCase()
    if (!cabinetCodes.has(code)) {
      cabinets.push({ id: uid('cab'), code, drawers: 2, boxes: 3, slots: 8 })
      cabinetCodes.add(code)
    }
  }
  if (cabinets.length === 0) {
    cabinets.push({ id: 'cab_c01', code: 'C01', drawers: 2, boxes: 3, slots: 8 })
  }

  return { sites, specimens, determinations, cabinets, receipts: allReceipts, storages }
}
