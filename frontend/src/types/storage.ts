import type { DetStatus } from './specimen'

/** 保藏方式 */
export const STORAGE_METHODS = ['针插', '浸液', '玻片', '干燥'] as const
export type StorageMethod = (typeof STORAGE_METHODS)[number]

/** 接收决定 */
export const RECEIPT_DECISIONS = ['已接收', '退回'] as const
export type ReceiptDecision = (typeof RECEIPT_DECISIONS)[number]

/**
 * 接收时的标本快照。
 * 库房侧自持的一份状态：野外队之后补改标本资料，台账里的编号与鉴定状态不受影响。
 */
export interface ReceiptItem {
  specimenId: string
  /** 接收那一刻的标本编号 */
  code: string
  /** 接收那一刻的鉴定状态（有没有定完名，库房据此判断） */
  status: DetStatus
}

/** Receipt 接收批次（库房侧台账，只增不改） */
export interface Receipt {
  id: string
  /** 批次号：IN-年份-流水号，如 IN-2026-0003 */
  batchNo: string
  decision: ReceiptDecision
  /** 接收时核对确认的保藏方式 */
  method: StorageMethod
  /** 目标标本柜 */
  cabinet: string
  handler: string
  date: string
  note: string
  items: ReceiptItem[]
}

/** Storage 保藏位置 */
export interface Storage {
  id: string
  specimenId: string
  /** 所属接收批次（库房侧关系） */
  receiptId: string
  method: StorageMethod
  /** 标本柜编号 */
  cabinet: string
  /** 抽屉号 */
  drawer: number
  /** 标本盒号 */
  box: number
  /** 插位序号 */
  slot: number
  storedDate: string
  handler: string
}
