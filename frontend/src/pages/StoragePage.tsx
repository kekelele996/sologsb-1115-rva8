import { useMemo, useRef, useState } from 'react'
import type { Cabinet, Storage } from '@/types'
import CabinetGrid from '@/components/common/CabinetGrid'
import StatusTag from '@/components/common/StatusTag'
import { usePersistentStore } from '@/hooks/usePersistentStore'
import { specimenStore } from '@/stores/specimenStore'
import { storageStore } from '@/stores/storageStore'
import { siteStore } from '@/stores/siteStore'
import { occupiedSlots, totalCapacity } from '@/utils/receipt'
import { specimenTaxon, storageSlotText } from '@/utils/codec'
import { exportBackup, importBackupFile } from '@/utils/backup'
/** 保藏柜位图：库房侧持有接收决定与柜位容量，按批接收、容量不足整批退回 */
export default function StoragePage(): JSX.Element {
  const specimens = usePersistentStore(specimenStore, (state) => state.rows)
  const storages = usePersistentStore(storageStore, (state) => state.rows)
  const receipts = usePersistentStore(storageStore, (state) => state.receipts)
  const cabinets = usePersistentStore(storageStore, (state) => state.cabinets)
  const sites = usePersistentStore(siteStore, (state) => state.rows)

  const [handler, setHandler] = useState('')
  const [picked, setPicked] = useState('')
  const [dragging, setDragging] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [warning, setWarning] = useState('')
  const [detail, setDetail] = useState<Storage | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [cabForm, setCabForm] = useState({ code: 'C02', drawers: 2, boxes: 3, slots: 8 })
  const fileRef = useRef<HTMLInputElement>(null)

  const codeOf = (specimenId: string): string =>
    specimens.find((item) => item.id === specimenId)?.code ??
    receipts.find((item) => item.specimenId === specimenId)?.specimenCode ??
    '未知'
  const siteName = (siteId: string): string => sites.find((site) => site.id === siteId)?.name ?? '未关联采集地'

  const acceptedIds = useMemo(
    () => new Set(receipts.filter((item) => item.decision === 'accepted').map((item) => item.specimenId)),
    [receipts]
  )
  const placedIds = useMemo(() => new Set(storages.map((item) => item.specimenId)), [storages])

  /** 待接收：野外队已登记但库房尚未给出接收决定的标本 */
  const pending = useMemo(
    () =>
      specimens
        .filter((item) => !acceptedIds.has(item.id))
        .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')),
    [specimens, acceptedIds]
  )
  /** 未入柜：已接收但暂无插位（如出柜后重新上柜）；待接收/退回的走按批接收，不在此零散上柜 */
  const unplaced = useMemo(
    () =>
      specimens
        .filter((item) => acceptedIds.has(item.id) && !placedIds.has(item.id))
        .sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN')),
    [specimens, acceptedIds, placedIds]
  )
  const returned = useMemo(
    () => receipts.filter((item) => item.decision === 'returned'),
    [receipts]
  )

  const capacity = totalCapacity(cabinets)
  const occupied = occupiedSlots(storages).size
  const free = Math.max(0, capacity - occupied)

  const toggleSelect = (id: string): void => {
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))
  }
  const toggleAll = (): void => {
    setSelected((prev) => (prev.length === pending.length ? [] : pending.map((item) => item.id)))
  }

  /** 按批接收：核对保藏方式 → 分配插位 → 收下能放的、退回放不下的 */
  const receive = async (): Promise<void> => {
    if (selected.length === 0) {
      setWarning('请先勾选要接收的标本')
      return
    }
    if (!handler.trim()) {
      setWarning('请填写经手人')
      return
    }
    try {
      const result = await storageStore.getState().receiveBatch(selected, handler.trim())
      if (result.accepted.length === 0 && result.returned.length === 0) {
        setWarning('所选标本均已接收，未做改动')
      } else {
        const parts = [`批次 ${result.batchNo}：接收 ${result.accepted.length} 份并已分配插位`]
        if (result.returned.length > 0) {
          parts.push(
            `退回 ${result.returned.length} 份（柜位不足，整批退回并释放本次插位）：${result.returned
              .map((item) => item.code)
              .join('、')}`
          )
        }
        setMessage(parts.join('；'))
        setSelected([])
      }
      setWarning('')
    } catch (error) {
      setWarning((error as Error).message)
      setMessage('')
    }
  }

  /** 拖拽 / 点选 插位：零散上柜或调整 */
  const dropSlot = async (position: { cabinet: string; drawer: number; box: number; slot: number }): Promise<void> => {
    const specimenId = dragging ?? picked
    if (!specimenId) {
      setWarning('请先在右侧选择或拖动一份标本')
      return
    }
    const result = await storageStore.getState().place(specimenId, position, handler)
    if (result.ok) {
      setMessage(result.message)
      setWarning('')
      setPicked('')
      setDragging(null)
    } else {
      setWarning(result.message)
      setMessage('')
    }
  }

  const takeOut = async (storage: Storage): Promise<void> => {
    await storageStore.getState().takeOut(storage.id)
    setMessage(`${codeOf(storage.specimenId)} 已从 ${storageSlotText(storage)} 出柜，插位已释放`)
    setDetail(null)
  }

  const addCabinet = async (): Promise<void> => {
    const code = cabForm.code.trim().toUpperCase()
    if (!code) {
      setWarning('请填写标本柜编号')
      return
    }
    const existing = cabinets.find((cab) => cab.code.toUpperCase() === code)
    const cabinet: Cabinet = {
      id: existing?.id ?? uidCab(code),
      code,
      drawers: Math.max(1, cabForm.drawers || 1),
      boxes: Math.max(1, cabForm.boxes || 1),
      slots: Math.max(1, cabForm.slots || 1)
    }
    await storageStore.getState().saveCabinet(cabinet)
    setMessage(`标本柜 ${code} 容量已保存：${cabinet.drawers} 抽屉 × ${cabinet.boxes} 盒 × ${cabinet.slots} 位`)
    setWarning('')
  }

  const removeCabinet = async (cabinet: Cabinet): Promise<void> => {
    const used = storages.some((item) => item.cabinet.toUpperCase() === cabinet.code.toUpperCase())
    if (used) {
      setWarning(`标本柜 ${cabinet.code} 仍有标本在柜，无法删除`)
      return
    }
    await storageStore.getState().removeCabinet(cabinet.id)
    setMessage(`标本柜 ${cabinet.code} 配置已删除`)
  }

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]
    if (!file) return
    try {
      const result = await importBackupFile(file)
      await Promise.all([
        specimenStore.getState().hydrate(),
        siteStore.getState().hydrate(),
        storageStore.getState().hydrate()
      ])
      setMessage(
        `备份导入完成：标本 ${result.specimens} · 采集地 ${result.sites} · 鉴定记录 ${result.determinations} · ` +
          `接收决定 ${result.receipts} · 柜位 ${result.cabinets} · 上柜记录 ${result.storages}（缺字段已按规则补齐）`
      )
      setWarning('')
    } catch (error) {
      setWarning(`备份导入失败：${(error as Error).message}`)
    }
    event.target.value = ''
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">保藏柜位图</h1>
          <p className="page-sub">
            库房侧持有接收决定与柜位容量：按批接收时先核对保藏方式，柜位不足则收下能放的、整批退回放不下的并释放本次插位；
            野外队对标本资料的修改不会影响已排定的柜位。
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" type="button" onClick={() => void exportBackup()}>
            导出备份
          </button>
          <button className="btn-ghost" type="button" onClick={() => fileRef.current?.click()}>
            导入备份
          </button>
          <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void onFile(e)} />
        </div>
      </header>

      <section className="panel flex flex-wrap items-center gap-4 text-sm">
        <span>
          柜位总容量 <b data-testid="capacity-total">{capacity}</b> 位
        </span>
        <span>
          已占用 <b className="text-field-700">{occupied}</b> 位
        </span>
        <span>
          可接收 <b className="text-emerald-700" data-testid="capacity-free">{free}</b> 位
        </span>
        <span className="text-slate-500">
          待接收 {pending.length} · 已接收 {acceptedIds.size} · 已入柜 {storages.length} · 退回 {returned.length}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="field-label">经手人</span>
          <input className="field-input w-32" value={handler} onChange={(e) => setHandler(e.target.value)} placeholder="如 覃羽" />
        </div>
      </section>

      {warning ? <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">{warning}</p> : null}
      {message ? <p className="rounded-lg border border-field-100 bg-field-50 px-3 py-2 text-sm text-field-700">{message}</p> : null}

      <section className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="flex flex-col gap-4">
          {cabinets.map((cabinet) => (
            <CabinetGrid
              key={cabinet.id}
              cabinet={cabinet.code}
              drawers={cabinet.drawers}
              boxes={cabinet.boxes}
              slots={cabinet.slots}
              storages={storages}
              codeOf={codeOf}
              draggingCode={dragging ? codeOf(dragging) : picked ? codeOf(picked) : null}
              onDropSlot={(position) => void dropSlot(position)}
              onPickStorage={(item) => setDetail(item)}
            />
          ))}

          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">柜位容量配置（库房侧）</h2>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div>
                <span className="field-label">柜号</span>
                <input
                  className="field-input w-24"
                  value={cabForm.code}
                  onChange={(e) => setCabForm((prev) => ({ ...prev, code: e.target.value.toUpperCase() }))}
                />
              </div>
              <div>
                <span className="field-label">抽屉数</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  className="field-input w-20"
                  value={cabForm.drawers}
                  onChange={(e) => setCabForm((prev) => ({ ...prev, drawers: Math.max(1, Number(e.target.value) || 1) }))}
                />
              </div>
              <div>
                <span className="field-label">每屉盒数</span>
                <input
                  type="number"
                  min={1}
                  max={8}
                  className="field-input w-20"
                  value={cabForm.boxes}
                  onChange={(e) => setCabForm((prev) => ({ ...prev, boxes: Math.max(1, Number(e.target.value) || 1) }))}
                />
              </div>
              <div>
                <span className="field-label">每盒插位</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  className="field-input w-20"
                  value={cabForm.slots}
                  onChange={(e) => setCabForm((prev) => ({ ...prev, slots: Math.max(1, Number(e.target.value) || 1) }))}
                />
              </div>
              <button className="btn-ghost" type="button" onClick={() => void addCabinet()}>
                保存柜位配置
              </button>
            </div>
            <ul className="mt-3 space-y-1 text-xs">
              {cabinets.map((cabinet) => {
                const used = storages.filter((item) => item.cabinet.toUpperCase() === cabinet.code.toUpperCase()).length
                const cap = cabinet.drawers * cabinet.boxes * cabinet.slots
                return (
                  <li key={cabinet.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
                    <span>
                      标本柜 <b className="font-mono">{cabinet.code}</b> · {cabinet.drawers} 抽屉 × {cabinet.boxes} 盒 ×{' '}
                      {cabinet.slots} 位 = {cap} 位 · 已用 {used} · 空余 {Math.max(0, cap - used)}
                    </span>
                    <button className="btn-danger" type="button" onClick={() => void removeCabinet(cabinet)}>
                      删除
                    </button>
                  </li>
                )
              })}
              {cabinets.length === 0 ? <li className="text-slate-400">尚未配置标本柜</li> : null}
            </ul>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">待接收批次（核对保藏方式后按批接收）</h2>
            <div className="mt-2 flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1 text-slate-600">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-field-600"
                  checked={pending.length > 0 && selected.length === pending.length}
                  onChange={toggleAll}
                />
                全选
              </label>
              <span className="text-slate-400">
                已选 {selected.length} / {pending.length}，可接收 {free} 位
              </span>
            </div>
            <div className="mt-2 max-h-64 space-y-2 overflow-auto">
              {pending.map((specimen) => (
                <label
                  key={specimen.id}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-slate-200 px-2 py-1.5 text-xs hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-field-600"
                    checked={selected.includes(specimen.id)}
                    onChange={() => toggleSelect(specimen.id)}
                  />
                  <span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-field-700">{specimen.code}</span>
                      <StatusTag status={specimen.status} />
                    </span>
                    <span className="text-slate-600">{specimenTaxon(specimen)}</span>
                    <span className="text-slate-400">
                      {siteName(specimen.siteId)} · 保藏方式 {specimen.preserveMethod}
                    </span>
                  </span>
                </label>
              ))}
              {pending.length === 0 ? <p className="text-xs text-slate-400">没有待接收标本</p> : null}
            </div>
            <button className="btn-primary mt-2 w-full" type="button" onClick={() => void receive()}>
              按批接收（{selected.length} 份）
            </button>
            <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
              接收时核对保藏方式；容量不足时收下能放的，放不下的整批退回并释放本次插位，已接收批次不动。
            </p>
          </div>

          {returned.length > 0 ? (
            <div className="panel">
              <h2 className="text-sm font-semibold text-slate-700">退回记录（整批退回）</h2>
              <ul className="mt-2 space-y-1.5 text-xs">
                {returned.map((rec) => (
                  <li key={rec.id} className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-1.5">
                    <span className="font-mono text-field-700">{rec.specimenCode}</span>
                    <span className="ml-2 text-slate-500">批次 {rec.batchNo}</span>
                    <span className="mt-0.5 block text-amber-700">{rec.reason || '退回'}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">未入柜标本（拖到插位可零散上柜）</h2>
            <div className="mt-2 max-h-56 space-y-2 overflow-auto">
              {unplaced.map((specimen) => (
                <div
                  key={specimen.id}
                  draggable
                  onDragStart={() => setDragging(specimen.id)}
                  onDragEnd={() => setDragging(null)}
                  onClick={() => setPicked(specimen.id)}
                  className={`cursor-grab rounded-lg border px-3 py-2 text-xs transition ${
                    picked === specimen.id ? 'border-field-500 bg-field-50' : 'border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  <p className="font-mono text-field-700">{specimen.code}</p>
                  <p className="text-slate-600">{specimenTaxon(specimen)}</p>
                  <p className="text-slate-400">
                    {siteName(specimen.siteId)} · <StatusTag status={specimen.status} /> · {specimen.preserveMethod}
                  </p>
                </div>
              ))}
              {unplaced.length === 0 ? <p className="text-xs text-slate-400">所有标本都已入柜</p> : null}
            </div>
          </div>

          <div className="panel">
            <h2 className="text-sm font-semibold text-slate-700">已入柜明细</h2>
            <ul className="mt-2 space-y-1.5 text-xs">
              {storages.map((storage) => (
                <li key={storage.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-2 py-1.5">
                  <span>
                    <span className="font-mono text-field-700">{storageSlotText(storage)}</span>
                    <span className="ml-2 text-slate-600">{storage.specimenCode || codeOf(storage.specimenId)}</span>
                    <span className="ml-1 text-slate-400">{storage.method}</span>
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
                {detail.handler || '—'}
              </p>
              <p className="text-xs text-slate-600">
                标本：{detail.specimenCode || codeOf(detail.specimenId)} · 接收批次{' '}
                {receipts.find((rec) => rec.id === detail.receiptId)?.batchNo ?? '—'}
              </p>
              <button className="btn-ghost mt-2" type="button" onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}

/** 柜位配置 id：同柜号复用，避免重复配置 */
function uidCab(code: string): string {
  return `cab_${code.toLowerCase()}`
}
