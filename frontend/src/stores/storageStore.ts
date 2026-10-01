import { create } from 'zustand'
import type { Cabinet, Receipt, Specimen, Storage } from '@/types'
import { STORAGE_METHODS } from '@/types'
import { db, deleteRow, loadAll, putRow } from '@/hooks/usePersistentStore'
import { findSlotConflicts } from '@/utils/codec'
import { planReceipt, slotKey, type SlotPosition } from '@/utils/receipt'
import { uid } from '@/utils/id'

/** 按批接收的结果：收下的（已分配插位）与整批退回的（柜位不足） */
export interface ReceiveResult {
  batchNo: string
  accepted: Specimen[]
  returned: Specimen[]
}

export interface StorageState {
  /** 上柜记录（仅已接收且在柜的标本） */
  rows: Storage[]
  /** 接收决定（库房侧持有） */
  receipts: Receipt[]
  /** 柜位容量配置（库房侧持有） */
  cabinets: Cabinet[]
  loaded: boolean
  hydrate: () => Promise<void>
  // —— 柜位容量 ——
  saveCabinet: (cabinet: Cabinet) => Promise<void>
  removeCabinet: (id: string) => Promise<void>
  // —— 按批接收 ——
  /**
   * 库房按批接收：先核对这批标本的保藏方式，再按柜位容量分配插位。
   * 容量够则整批收下；不够就收下能放的，放不下的整批退回（退回不产生上柜记录、释放本次占用的插位），
   * 已经接收的批次不动。返回接收/退回清单。
   */
  receiveBatch: (specimenIds: string[], handler: string) => Promise<ReceiveResult>
  // —— 上柜 / 调整 / 出柜 ——
  /** 零散上柜（拖拽/点选）：未接收的视为零散接收，已接收的直接调整插位 */
  place: (specimenId: string, position: SlotPosition, handler: string) => Promise<{ ok: boolean; message: string }>
  takeOut: (storageId: string) => Promise<void>
}

/** 生成批次号：JH-yyyyMMdd-流水号 */
function nextBatchNo(receipts: Receipt[], date: string): string {
  const prefix = `JH-${date.replace(/-/g, '')}-`
  let max = 0
  for (const rec of receipts) {
    if (rec.batchNo.startsWith(prefix)) {
      const seq = Number(rec.batchNo.slice(prefix.length))
      if (Number.isFinite(seq) && seq > max) max = seq
    }
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`
}

export const storageStore = create<StorageState>((set, get) => ({
  rows: [],
  receipts: [],
  cabinets: [],
  loaded: false,

  hydrate: async () => {
    const [rows, receipts, cabinets] = await Promise.all([
      loadAll<Storage>(db.storages),
      loadAll<Receipt>(db.receipts),
      loadAll<Cabinet>(db.cabinets)
    ])
    rows.sort((a, b) => slotKey(a).localeCompare(slotKey(b)))
    receipts.sort((a, b) => (b.receivedDate + b.batchNo + b.id).localeCompare(a.receivedDate + a.batchNo + a.id))
    cabinets.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
    set({ rows, receipts, cabinets, loaded: true })
  },

  saveCabinet: async (cabinet) => {
    await putRow<Cabinet>(db.cabinets, cabinet)
    await get().hydrate()
  },

  removeCabinet: async (id) => {
    await deleteRow<Cabinet>(db.cabinets, id)
    await get().hydrate()
  },

  receiveBatch: async (specimenIds, handler) => {
    const { rows: storages, receipts, cabinets } = get()
    const wanted = new Set(specimenIds)
    const specimens = (await loadAll<Specimen>(db.specimens)).filter((sp) => wanted.has(sp.id))
    if (specimens.length === 0) {
      return { batchNo: '', accepted: [], returned: [] }
    }

    // 已经接收（有 accepted 决定）的批次不动
    const acceptedIds = new Set(receipts.filter((rec) => rec.decision === 'accepted').map((rec) => rec.specimenId))
    const candidates = specimens.filter((sp) => !acceptedIds.has(sp.id))
    if (candidates.length === 0) {
      return { batchNo: '', accepted: [], returned: [] }
    }

    // 核对这批标本的保藏方式：缺失或非法则整批不予接收
    const invalid = candidates.filter(
      (sp) => !sp.preserveMethod || !(STORAGE_METHODS as readonly string[]).includes(sp.preserveMethod)
    )
    if (invalid.length > 0) {
      throw new Error(
        `以下标本保藏方式缺失或无法识别，请先由野外队补录后再接收：${invalid.map((sp) => sp.code).join('、')}`
      )
    }

    // 柜位容量决策：收下能放的，放不下的整批退回（退回不占插位）
    const plan = planReceipt(cabinets, storages, candidates)
    const date = new Date().toISOString().slice(0, 10)
    const batchNo = nextBatchNo(receipts, date)

    const newReceipts: Receipt[] = []
    const newStorages: Storage[] = []
    plan.accepted.forEach((sp) => {
      const receiptId = uid('rec')
      newReceipts.push({
        id: receiptId,
        batchNo,
        specimenId: sp.id,
        specimenCode: sp.code,
        method: sp.preserveMethod,
        decision: 'accepted',
        reason: '',
        receivedDate: date,
        handler
      })
      const position = plan.positions.get(sp.id)!
      newStorages.push({
        id: uid('stg'),
        receiptId,
        specimenId: sp.id,
        specimenCode: sp.code,
        method: sp.preserveMethod,
        cabinet: position.cabinet,
        drawer: position.drawer,
        box: position.box,
        slot: position.slot,
        storedDate: date,
        handler
      })
    })
    plan.returned.forEach((sp) => {
      newReceipts.push({
        id: uid('rec'),
        batchNo,
        specimenId: sp.id,
        specimenCode: sp.code,
        method: sp.preserveMethod,
        decision: 'returned',
        reason: '柜位容量不足，整批退回',
        receivedDate: date,
        handler
      })
    })

    // 退回的标本不产生上柜记录 → 本次试分配的插位自动释放
    await db.transaction('rw', [db.receipts, db.storages], async () => {
      await db.receipts.bulkPut(newReceipts)
      await db.storages.bulkPut(newStorages)
    })
    await get().hydrate()
    return { batchNo, accepted: plan.accepted, returned: plan.returned }
  },

  place: async (specimenId, position, handler) => {
    const { rows: storages, receipts } = get()
    const specimen = (await loadAll<Specimen>(db.specimens)).find((sp) => sp.id === specimenId)
    if (!specimen) {
      return { ok: false, message: '标本不存在，无法上柜' }
    }
    if (!specimen.preserveMethod || !(STORAGE_METHODS as readonly string[]).includes(specimen.preserveMethod)) {
      return { ok: false, message: `${specimen.code} 保藏方式缺失，请先由野外队补录后再接收` }
    }
    const existing = storages.find((item) => item.specimenId === specimenId)
    const candidate: Storage = {
      id: existing?.id ?? uid('stg'),
      receiptId: existing?.receiptId ?? '',
      specimenId,
      specimenCode: specimen.code,
      method: specimen.preserveMethod,
      cabinet: position.cabinet,
      drawer: position.drawer,
      box: position.box,
      slot: position.slot,
      storedDate: new Date().toISOString().slice(0, 10),
      handler: handler.trim()
    }
    const conflicts = findSlotConflicts(storages, candidate)
    if (conflicts.length > 0) {
      return {
        ok: false,
        message: `柜位 ${slotKey(position)} 已被占用：${conflicts
          .map((item) => `${item.specimenCode || item.specimenId}（${item.method}）`)
          .join('、')}，请换一个插位或先出柜`
      }
    }

    // 未接收的标本零散上柜：补一条已接收决定（零散接收批次）
    if (!candidate.receiptId) {
      const accepted = receipts.find((rec) => rec.specimenId === specimenId && rec.decision === 'accepted')
      if (accepted) {
        candidate.receiptId = accepted.id
      } else {
        const date = new Date().toISOString().slice(0, 10)
        const receipt: Receipt = {
          id: uid('rec'),
          batchNo: `LS-${date.replace(/-/g, '')}`,
          specimenId,
          specimenCode: specimen.code,
          method: specimen.preserveMethod,
          decision: 'accepted',
          reason: '',
          receivedDate: date,
          handler: handler.trim()
        }
        candidate.receiptId = receipt.id
        await putRow<Receipt>(db.receipts, receipt)
      }
    }

    await putRow<Storage>(db.storages, candidate)
    await get().hydrate()
    return { ok: true, message: `${specimen.code} 已入柜 ${slotKey(candidate)}` }
  },

  takeOut: async (storageId) => {
    // 出柜只删上柜记录（释放插位），接收决定作为库房历史保留
    await deleteRow<Storage>(db.storages, storageId)
    await get().hydrate()
  }
}))

