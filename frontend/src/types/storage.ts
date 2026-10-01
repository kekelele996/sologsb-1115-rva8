/** 保藏方式 */
export const STORAGE_METHODS = ['针插', '浸液', '玻片', '干燥'] as const
export type StorageMethod = (typeof STORAGE_METHODS)[number]

/** 接收决定：库房按批接收时对每份标本给出的结论 */
export type ReceiptDecision = 'accepted' | 'returned'

/**
 * Receipt 接收决定（库房侧持有）
 * 野外队管标本与鉴定结论，库房管接收决定；任一侧的修改只落在自己这边。
 */
export interface Receipt {
  id: string
  /** 批次号：同一次按批接收共用一个批次号 */
  batchNo: string
  specimenId: string
  /** 标本编号快照（库房侧留存，不随野外队事后修改而变动） */
  specimenCode: string
  /** 接收时核对的保藏方式 */
  method: StorageMethod
  decision: ReceiptDecision
  /** 退回原因（接收时为空） */
  reason: string
  receivedDate: string
  handler: string
}

/**
 * Cabinet 柜位容量配置（库房侧持有）
 * 柜号 → 抽屉数 → 每屉盒数 → 每盒插位数，总容量 = 各柜 抽屉×盒×位 之和。
 */
export interface Cabinet {
  id: string
  /** 标本柜编号 */
  code: string
  drawers: number
  boxes: number
  slots: number
}

/** Storage 保藏位置（上柜记录，仅「已接收」标本拥有） */
export interface Storage {
  id: string
  /** 关联的接收决定 */
  receiptId: string
  specimenId: string
  /** 标本编号快照 */
  specimenCode: string
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
