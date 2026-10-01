import { create } from 'zustand'
import type { Receipt, Specimen, Storage, StorageMethod } from '@/types'
import { db, loadAll } from '@/hooks/usePersistentStore'
import {
  buildBatchNo,
  encodeSlot,
  findSlotConflicts,
  freeSlots,
  nextBatchSerial,
  type SlotPosition
} from '@/utils/codec'
import { uid } from '@/utils/id'

export interface AcceptBatchInput {
  /** 本批标本（按提交顺序分配插位） */
  specimenIds: string[]
  /** 接收前核对确认的保藏方式，整批统一 */
  method: StorageMethod
  cabinet: string
  drawers: number
  boxes: number
  slots: number
  handler: string
  note: string
  /** 单件拖拽入柜时指定的插位；给了就只放这一份 */
  position?: SlotPosition
}

export interface AcceptBatchResult {
  accepted: Receipt | null
  returned: Receipt | null
  /** 指定插位在提交瞬间被占用时的柜位文本（竞态兜底） */
  conflictSlot: string | null
}

export interface ReceiptState {
  rows: Receipt[]
  loaded: boolean
  hydrate: () => Promise<void>
  /**
   * 按批接收（库房侧，只写 receipts / storages，不动野外队的标本数据）：
   * 1. 先核对整批保藏方式，统一记到批次与每条柜位上；
   * 2. 只在空位里排，已经接收的批次占用的插位不动；
   * 3. 容量够就全收，不够就收下能放的，放不下的整批退回——
   *    退回部分不落任何柜位行，本次占用的插位随事务结束即释放；
   * 4. 整个接收写在一个事务里，中途失败全部回滚。
   */
  acceptBatch: (input: AcceptBatchInput) => Promise<AcceptBatchResult>
}

export const receiptStore = create<ReceiptState>((set, get) => ({
  rows: [],
  loaded: false,
  hydrate: async () => {
    const rows = await loadAll<Receipt>(db.receipts)
    rows.sort((a, b) => (b.date + b.batchNo).localeCompare(a.date + a.batchNo))
    set({ rows, loaded: true })
  },
  acceptBatch: async (input) => {
    const { specimenIds, method, cabinet, drawers, boxes, slots, handler, note, position } = input
    const empty: AcceptBatchResult = { accepted: null, returned: null, conflictSlot: null }
    if (specimenIds.length === 0) return empty

    const today = new Date().toISOString().slice(0, 10)
    const year = today.slice(0, 4)
    const cabinetKey = cabinet.toUpperCase()

    const result = await db.transaction('rw', [db.receipts, db.storages, db.specimens], async () => {
      const storages = await db.storages.toArray()

      // 分配插位：单件指定插位，或按柜容量顺序填充
      let placements: { specimenId: string; position: SlotPosition }[] = []
      let returnedIds: string[] = []
      if (position) {
        const probe: Storage = {
          id: '',
          specimenId: '',
          receiptId: '',
          method,
          cabinet: position.cabinet,
          drawer: position.drawer,
          box: position.box,
          slot: position.slot,
          storedDate: today,
          handler
        }
        if (findSlotConflicts(storages, probe).length > 0) {
          return { ...empty, conflictSlot: encodeSlot(position.cabinet, position.drawer, position.box, position.slot) }
        }
        placements = [{ specimenId: specimenIds[0], position: { ...position, cabinet: position.cabinet.toUpperCase() } }]
      } else {
        const free = freeSlots(storages, cabinetKey, drawers, boxes, slots)
        placements = specimenIds.slice(0, free.length).map((specimenId, index) => ({
          specimenId,
          position: free[index]
        }))
        returnedIds = specimenIds.slice(free.length)
      }

      // 接收那一刻的标本快照落台账，野外队之后的改动不带过来
      const specimens = await db.specimens.toArray()
      const specimenMap = new Map<string, Specimen>(specimens.map((specimen) => [specimen.id, specimen]))
      const snapshotOf = (specimenId: string): { specimenId: string; code: string; status: Specimen['status'] } => {
        const specimen = specimenMap.get(specimenId)
        return {
          specimenId,
          code: specimen?.code ?? specimenId,
          status: specimen?.status ?? '待鉴定'
        }
      }

      const existingBatchNos = (await db.receipts.toArray()).map((receipt) => receipt.batchNo)
      let serial = nextBatchSerial(year, existingBatchNos)
      const receipts: Receipt[] = []
      const storageRows: Storage[] = []

      let accepted: Receipt | null = null
      if (placements.length > 0) {
        const receipt: Receipt = {
          id: uid('rcp'),
          batchNo: buildBatchNo(year, serial),
          decision: '已接收',
          method,
          cabinet: placements[0].position.cabinet,
          handler,
          date: today,
          note,
          items: placements.map((placement) => snapshotOf(placement.specimenId))
        }
        serial += 1
        receipts.push(receipt)
        placements.forEach((placement) => {
          storageRows.push({
            id: uid('stg'),
            specimenId: placement.specimenId,
            receiptId: receipt.id,
            method,
            cabinet: placement.position.cabinet,
            drawer: placement.position.drawer,
            box: placement.position.box,
            slot: placement.position.slot,
            storedDate: today,
            handler
          })
        })
        accepted = receipt
      }

      let returned: Receipt | null = null
      if (returnedIds.length > 0) {
        // 放不下的整批退回：不写任何柜位行，本次占用的插位不落库即释放
        returned = {
          id: uid('rcp'),
          batchNo: buildBatchNo(year, serial),
          decision: '退回',
          method,
          cabinet: cabinetKey,
          handler,
          date: today,
          note: [note, '柜位容量不足，整批退回'].filter(Boolean).join('；'),
          items: returnedIds.map((specimenId) => snapshotOf(specimenId))
        }
        receipts.push(returned)
      }

      await db.receipts.bulkPut(receipts)
      await db.storages.bulkPut(storageRows)
      return { accepted, returned, conflictSlot: null }
    })

    await get().hydrate()
    return result
  }
}))
