import { useMemo, useState } from 'react'
import type { Receipt, Storage, StorageMethod } from '@/types'
import { STORAGE_METHODS } from '@/types'
import CabinetGrid from '@/components/common/CabinetGrid'
import StatusTag from '@/components/common/StatusTag'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { specimenStore } from '@/stores/specimenStore'
import { storageStore } from '@/stores/storageStore'
import { receiptStore, type AcceptBatchResult } from '@/stores/receiptStore'
import { siteStore } from '@/stores/siteStore'
import { encodeSlot, findSlotConflicts, specimenTaxon, storageSlotText, type SlotPosition } from '@/utils/codec'

/** 保藏柜位图：库房按批接收（核对保藏方式 + 柜位容量），柜-抽屉-盒-位三级展开，拖拽可单件入柜 */
export default function StoragePage(): JSX.Element {
  const specimens = usePersistentStore(specimenStore, (state) => state.rows)
  const storages = usePersistentStore(storageStore, (state) => state.rows)
  const receipts = usePersistentStore(receiptStore, (state) => state.rows)
  const sites = usePersistentStore(siteStore, (state) => state.rows)

  const [cabinet, setCabinet] = useState('C01')
  const [drawers, setDrawers] = useState(2)
  const [boxes, setBoxes] = useState(3)
  const [slots, setSlots] = useState(8)
  const [method, setMethod] = useState<StorageMethod>('针插')
  const [handler, setHandler] = useState('')
  const [note, setNote] = useState('')
  const [batchIds, setBatchIds] = useState<string[]>([])
  const [picked, setPicked] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [warning, setWarning] = useState('')
  const [detail, setDetail] = useState<Storage | null>(null)
  const [openReceipt, setOpenReceipt] = useState<string | null>(null)

  /** 库房侧自持状态：标本被野外队改挂/删除时，编号仍可从接收快照里取 */
  const snapshotCode = useMemo(() => {
    const map = new Map<string, string>()
    receipts.forEach((receipt) =>
      receipt.items.forEach((item) => {
        if (!map.has(item.specimenId)) map.set(item.specimenId, item.code)
      })
    )
    return map
  }, [receipts])
  const codeOf = (specimenId: string): string =>
    specimens.find((item) => item.id === specimenId)?.code ?? snapshotCode.get(specimenId) ?? '未知'
  const siteName = (siteId: string): string => sites.find((site) => site.id === siteId)?.name ?? '未关联采集地'

  const placedIds = useMemo(() => new Set(storages.map((item) => item.specimenId)), [storages])
  const unplaced = specimens.filter((item) => !placedIds.has(item.id))
  const slotBySpecimen = useMemo(() => {
    const map = new Map<string, Storage>()
    storages.forEach((storage) => map.set(storage.specimenId, storage))
    return map
  }, [storages])
  const receiptById = useMemo(() => new Map(receipts.map((receipt) => [receipt.id, receipt])), [receipts])

  /** 当前柜的容量账：容量 / 已用 / 空余 */
  const capacity = drawers * boxes * slots
  const usedCount = storages.filter((item) => item.cabinet.toUpperCase() === cabinet.toUpperCase()).length
  const freeCount = Math.max(0, capacity - usedCount)
  const returnCount = Math.max(0, batchIds.length - freeCount)

  const toggleBatch = (id: string): void => {
    setBatchIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }

  const report = (result: AcceptBatchResult): void => {
    const { accepted, returned } = result
    if (accepted && returned) {
      setMessage(
        `批次 ${accepted.batchNo}：已接收 ${accepted.items.length} 份（${accepted.method}）并入柜；` +
          `柜位容量不足，其余 ${returned.items.length} 份整批退回（批次 ${returned.batchNo}），本次占用的插位已释放`
      )
    } else if (accepted) {
      setMessage(`批次 ${accepted.batchNo}：已接收 ${accepted.items.length} 份（${accepted.method}），全部入柜`)
    } else if (returned) {
      setWarning(`柜位容量不足，本批 ${returned.items.length} 份整批退回（批次 ${returned.batchNo}），未留下占用插位`)
    }
  }

  /** 按批接收：先核对保藏方式，再按柜容量收下能放的，放不下的整批退回 */
  const acceptSelected = async (): Promise<void> => {
    if (batchIds.length === 0) {
      setWarning('请先勾选本批要接收的标本')
      return
    }
    setWarning('')
    setMessage('')
    const result = await receiptStore.getState().acceptBatch({
      specimenIds: batchIds,
      method,
      cabinet,
      drawers,
      boxes,
      slots,
      handler: handler.trim(),
      note: note.trim()
    })
    await storageStore.getState().hydrate()
    setBatchIds([])
    setNote('')
    report(result)
  }

  /** 退回批次重新接收：已入柜的不再动，只处理仍未入柜的 */
  const reaccept = async (receipt: Receipt): Promise<void> => {
    const ids = receipt.items.map((item) => item.specimenId).filter((id) => !placedIds.has(id))
    if (ids.length === 0) {
      setMessage(`批次 ${receipt.batchNo} 的标本已全部入柜，无需重新接收`)
      return
    }
    setWarning('')
    setMessage('')
    const result = await receiptStore.getState().acceptBatch({
      specimenIds: ids,
      method: receipt.method,
      cabinet,
      drawers,
      boxes,
      slots,
      handler: handler.trim() || receipt.handler,
      note: `退回批次 ${receipt.batchNo} 重新接收`
    })
    await storageStore.getState().hydrate()
    report(result)
  }

  /** 单件入柜（拖到插位 / 选中后点插位）：同样落一个接收批次 */
  const place = async (position: SlotPosition): Promise<void> => {
    const specimenId = dragging ?? picked
    if (!specimenId) {
      setWarning('请先在右侧选择或拖动一份未入柜标本')
      return
    }
    const probe: Storage = {
      id: '',
      specimenId,
      receiptId: '',
      method,
      cabinet: position.cabinet,
      drawer: position.drawer,
      box: position.box,
      slot: position.slot,
      storedDate: new Date().toISOString().slice(0, 10),
      handler: handler.trim()
    }
    const conflicts = findSlotConflicts(storages, probe)
    if (conflicts.length > 0) {
      setWarning(
        `柜位 ${encodeSlot(position.cabinet, position.drawer, position.box, position.slot)} 已被占用：` +
          conflicts.map((item) => `${codeOf(item.specimenId)}（${item.method}）`).join('、') +
          '，请换一个插位或先出柜'
      )
      return
    }
    setWarning('')
    const result = await receiptStore.getState().acceptBatch({
      specimenIds: [specimenId],
      method,
      cabinet,
      drawers,
      boxes,
      slots,
      handler: handler.trim(),
      note: note.trim(),
      position
    })
    await storageStore.getState().hydrate()
    if (result.conflictSlot) {
      setWarning(`柜位 ${result.conflictSlot} 刚刚被占用，请换一个插位`)
      return
    }
    setMessage(
      `${codeOf(specimenId)} 已入柜 ${encodeSlot(position.cabinet, position.drawer, position.box, position.slot)}` +
        (result.accepted ? `（批次 ${result.accepted.batchNo}）` : '')
    )
    setPicked('')
    setDragging(null)
  }

  const takeOut = async (storage: Storage): Promise<void> => {
    await storageStore.getState().remove(storage.id)
    setMessage(`${codeOf(storage.specimenId)} 已从 ${storageSlotText(storage)} 出柜（接收批次台账保留）`)
    setDetail(null)
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="page-title">保藏柜位图</h1>
        <p className="page-sub">
          库房按批接收：先核对整批保藏方式，再按柜位容量收下能放的，放不下的整批退回并释放本次插位；已接收的批次不动。拖动标本到插位可单件入柜。
        </p>
      </header>

      <section className="panel flex flex-wrap items-end gap-3">
        <div>
          <span className="field-label">标本柜编号</span>
          <input className="field-input w-28" value={cabinet} onChange={(e) => setCabinet(e.target.value.toUpperCase())} />
        </div>
        <div>
          <span className="field-label">抽屉数</span>
          <input type="number" min={1} max={8} className="field-input w-20" value={drawers} onChange={(e) => setDrawers(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div>
          <span className="field-label">每屉盒数</span>
          <input type="number" min={1} max={8} className="field-input w-20" value={boxes} onChange={(e) => setBoxes(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div>
          <span className="field-label">每盒插位</span>
          <input type="number" min={1} max={20} className="field-input w-20" value={slots} onChange={(e) => setSlots(Math.max(1, Number(e.target.value) || 1))} />
        </div>
        <div className="text-xs text-slate-500">
          柜 {cabinet} 容量 {capacity} 位 · 已用 {usedCount} 位 · <b className="text-field-700">空余 {freeCount} 位</b>
          <br />
          已入柜 {storages.length} 份 · 未入柜 {unplaced.length} 份
          {picked ? ` · 当前选中 ${codeOf(picked)}` : ''}
        </div>
      </section>

      {warning ? <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</p> : null}
      {message ? <p className="rounded-lg border border-field-100 bg-field-50 px-3 py-2 text-sm text-field-700">{message}</p> : null}

      <section className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          <CabinetGrid
            cabinet={cabinet}
            drawers={drawers}
            boxes={boxes}
            slots={slots}
            storages={storages}
            codeOf={codeOf}
            draggingCode={dragging ? codeOf(dragging) : picked ? codeOf(picked) : null}
            onDropSlot={(position) => void place(position)}
            onPickStorage={(storage) => setDetail(storage)}
          />

          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">已入柜明细</h2>
            <ul className="mt-2 space-y-1.5 text-xs">
              {storages.map((storage) => (
                <li key={storage.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
                  <span>
                    <span className="font-mono text-field-700">{storageSlotText(storage)}</span>
                    <span className="ml-2 text-slate-600">{codeOf(storage.specimenId)}</span>
                    <span className="ml-1 text-slate-400">{storage.method}</span>
                    <span className="ml-1 text-slate-400">批次 {receiptById.get(storage.receiptId)?.batchNo ?? '—'}</span>
                  </span>
                  <button className="btn-danger" type="button" onClick={() => void takeOut(storage)}>
                    出柜
                  </button>
                </li>
              ))}
              {storages.length === 0 ? <li className="text-slate-400">暂无入柜记录</li> : null}
            </ul>
          </div>

          {detail ? (
            <div className="panel">
              <h2 className="text-sm font-semibold text-slate-700">插位明细</h2>
              <p className="mt-1 text-xs text-slate-600">
                柜位 {storageSlotText(detail)} · {detail.method} · 入柜日期 {detail.storedDate} · 经手人{' '}
                {detail.handler || '—'} · 批次 {receiptById.get(detail.receiptId)?.batchNo ?? '—'}
              </p>
              <p className="text-xs text-slate-600">标本：{codeOf(detail.specimenId)}</p>
              <button className="btn-ghost mt-2" type="button" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col gap-4">
          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">按批接收（库房）</h2>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div>
                <span className="field-label">保藏方式（接收前核对）</span>
                <select className="field-input" value={method} onChange={(e) => setMethod(e.target.value as StorageMethod)}>
                  {STORAGE_METHODS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <span className="field-label">经手人</span>
                <input className="field-input" value={handler} onChange={(e) => setHandler(e.target.value)} placeholder="如 覃羽" />
              </div>
            </div>
            <div className="mt-2">
              <span className="field-label">批次备注</span>
              <input className="field-input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="如 2026 春季灯诱批次" />
            </div>

            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-500">未入柜标本（勾选入批，可拖拽单件入柜）</span>
              <button
                className="btn-ghost !px-2 !py-0.5 text-xs"
                type="button"
                onClick={() => setBatchIds((prev) => (prev.length === unplaced.length ? [] : unplaced.map((item) => item.id)))}
              >
                {batchIds.length === unplaced.length && unplaced.length > 0 ? '清空' : '全选'}
              </button>
            </div>
            <div className="mt-1 max-h-64 space-y-2 overflow-auto">
              {unplaced.map((specimen) => (
                <div
                  key={specimen.id}
                  draggable
                  onDragStart={() => setDragging(specimen.id)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => setPicked(specimen.id)}
                  className={`flex cursor-grab items-start gap-2 rounded-lg border px-3 py-2 text-xs transition ${
                    picked === specimen.id ? 'border-field-500 bg-field-50' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <input
                    type="checkbox"
                    aria-label={`本批接收 ${specimen.code}`}
                    className="mt-0.5 h-4 w-4 accent-field-600"
                    checked={batchIds.includes(specimen.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleBatch(specimen.id)}
                  />
                  <div className="min-w-0">
                    <p className="font-mono text-field-700">{specimen.code}</p>
                    <p className="text-slate-600">{specimenTaxon(specimen)}</p>
                    <p className="text-slate-400">
                      {siteName(specimen.siteId)} · <StatusTag status={specimen.status} />
                    </p>
                  </div>
                </div>
              ))}
              {unplaced.length === 0 ? <p className="text-xs text-slate-400">所有标本都已入柜</p> : null}
            </div>

            <p className="mt-2 text-xs text-slate-500">
              本批 {batchIds.length} 份 · 空余插位 {freeCount} 个
              {batchIds.length > 0 ? ` · 预计接收 ${Math.min(batchIds.length, freeCount)} 份` : ''}
              {returnCount > 0 ? `，退回 ${returnCount} 份` : ''}
            </p>
            <button className="btn-primary mt-2 w-full" type="button" onClick={() => void acceptSelected()}>
              核对无误，接收本批（{batchIds.length} 份 · {method}）
            </button>
          </div>

          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">接收批次台账（{receipts.length}）</h2>
            <ul className="mt-2 space-y-2 text-xs">
              {receipts.map((receipt) => (
                <li key={receipt.id} className="rounded-lg border border-slate-200 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-field-700">{receipt.batchNo}</span>
                    <span
                      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] ${
                        receipt.decision === '已接收'
                          ? 'border-emerald-300 bg-emerald-50 text-emerald-700'
                          : 'border-rose-300 bg-rose-50 text-rose-600'
                      }`}
                    >
                      {receipt.decision}
                    </span>
                  </div>
                  <p className="mt-1 text-slate-500">
                    {receipt.method} · 柜 {receipt.cabinet} · {receipt.items.length} 份 · {receipt.date} · 经手人{' '}
                    {receipt.handler || '—'}
                  </p>
                  {receipt.note ? <p className="mt-0.5 text-slate-400">{receipt.note}</p> : null}
                  <div className="mt-1.5 flex gap-2">
                    <button
                      className="btn-ghost !px-2 !py-0.5 text-xs"
                      type="button"
                      onClick={() => setOpenReceipt((prev) => (prev === receipt.id ? null : receipt.id))}
                    >
                      {openReceipt === receipt.id ? '收起明细' : '查看明细'}
                    </button>
                    {receipt.decision === '退回' ? (
                      <button className="btn-primary !px-2 !py-0.5 text-xs" type="button" onClick={() => void reaccept(receipt)}>
                        重新接收
                      </button>
                    ) : null}
                  </div>
                  {openReceipt === receipt.id ? (
                    <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                      {receipt.items.map((item) => {
                        const current = slotBySpecimen.get(item.specimenId)
                        return (
                          <li key={item.specimenId} className="flex items-center justify-between gap-2">
                            <span className="font-mono text-slate-700">{item.code}</span>
                            <span className="flex items-center gap-1.5">
                              <StatusTag status={item.status} />
                              <span className="text-slate-400">
                                {current ? storageSlotText(current) : receipt.decision === '退回' ? '未入柜' : '已出柜'}
                              </span>
                            </span>
                          </li>
                        )
                      })}
                    </ul>
                  ) : null}
                </li>
              ))}
              {receipts.length === 0 ? <li className="text-slate-400">暂无接收批次</li> : null}
            </ul>
          </div>
        </div>
      </section>
    </div>
  )
}
