import type { Cabinet, Specimen, Storage } from '@/types'
import { encodeSlot } from './codec'

export interface SlotPosition {
  cabinet: string
  drawer: number
  box: number
  slot: number
}

/** 插位唯一键：柜-屉-盒-位 */
export function slotKey(position: SlotPosition): string {
  return encodeSlot(position.cabinet, position.drawer, position.box, position.slot)
}

/** 柜位总容量 = 各柜 抽屉×盒×位 之和 */
export function totalCapacity(cabinets: Cabinet[]): number {
  return cabinets.reduce((sum, cab) => sum + cab.drawers * cab.boxes * cab.slots, 0)
}

/** 已占用插位（去重） */
export function occupiedSlots(storages: Storage[]): Set<string> {
  return new Set(storages.map(slotKey))
}

/** 按 柜→屉→盒→位 顺序分配 count 个空插位，容量不足时返回实际可分配的插位（少于 count） */
function allocateSlots(cabinets: Cabinet[], storages: Storage[], count: number): SlotPosition[] {
  const occupied = occupiedSlots(storages)
  const allocated: SlotPosition[] = []
  const sortedCabinets = [...cabinets].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
  outer: for (const cab of sortedCabinets) {
    for (let drawer = 1; drawer <= cab.drawers; drawer += 1) {
      for (let box = 1; box <= cab.boxes; box += 1) {
        for (let slot = 1; slot <= cab.slots; slot += 1) {
          const position = { cabinet: cab.code, drawer, box, slot }
          const key = slotKey(position)
          if (occupied.has(key)) continue
          occupied.add(key)
          allocated.push(position)
          if (allocated.length >= count) break outer
        }
      }
    }
  }
  return allocated
}

export interface ReceiptPlan {
  accepted: Specimen[]
  returned: Specimen[]
  /** 被接收标本的插位（specimenId → 插位） */
  positions: Map<string, SlotPosition>
}

/**
 * 按批接收计划（库房侧容量决策）：
 * - 可收数量 = 柜位总容量 - 已占用插位；
 * - 候选标本按编号排序、先到先得，收下能放的；
 * - 放不下的整批退回（不分配插位，本次试分配自动释放），已接收的不动。
 */
export function planReceipt(cabinets: Cabinet[], storages: Storage[], candidates: Specimen[]): ReceiptPlan {
  const free = totalCapacity(cabinets) - occupiedSlots(storages).size
  const sorted = [...candidates].sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
  const accepted = sorted.slice(0, Math.max(0, free))
  const returned = sorted.slice(accepted.length)
  const positions = allocateSlots(cabinets, storages, accepted.length)
  const positionMap = new Map<string, SlotPosition>()
  accepted.forEach((sp, index) => positionMap.set(sp.id, positions[index]))
  return { accepted, returned, positions: positionMap }
}
