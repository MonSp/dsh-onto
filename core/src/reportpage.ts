/**
 * 报表页定义（spec chat-run-report S2.7）：对话中用过的 surface 沉淀为可复用插件页。
 *
 * - 落 `<workspaceRoot>/reports/<pageId>.json`（与 runs/ 同径纪律：单段 id + isInsideDir 围栏）；
 * - 工作区工件：不进包、不进派生指纹、ISSUED 不动；
 * - surface 保存前过 S2.2 同一校验（数据槽位只准绑定）。
 * @module @dsh-onto/core/reportpage
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isInsideDir, isSafeRelPath, PackageStoreError } from './store.js'
import { validateReportSurface, type A2uiSurfaceMessage } from './surface.js'
import type { RunRef } from './report.js'

export const REPORTS_DIR = 'reports'

/** 一个可复用报表页：布局（surface）+ 来源运行 + 溯源信息。 */
export interface ReportPage {
  pageId: string
  name: string
  surface: A2uiSurfaceMessage
  /** 沉淀来源运行（runId + 包版本；换 run 复用时仅作缺省指向）。 */
  createdFrom: RunRef
  savedAt: string
  /** strict 身份指纹（RunRecord 同款；旧页可缺省）。 */
  accessBinding?: string
}

export function isSafePageId(pageId: unknown): pageId is string {
  return typeof pageId === 'string' && isSafeRelPath(pageId) && !/[\\/]/.test(pageId)
}

function requireSafePageId(pageId: unknown): string {
  if (!isSafePageId(pageId)) {
    throw new PackageStoreError('INVALID_ARGS', 'invalid pageId')
  }
  return pageId
}

export function reportsDir(root: string): string {
  return join(root, REPORTS_DIR)
}

function pagePath(root: string, pageId: unknown): string {
  return join(reportsDir(root), `${requireSafePageId(pageId)}.json`)
}

function assertInsideRoot(root: string, dir: string): void {
  if (!isInsideDir(root, dir)) {
    throw new PackageStoreError('INVALID_ARGS', 'invalid report page path')
  }
}

function isRunRefShaped(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  const pkg = r.package as Record<string, unknown> | undefined
  return (
    typeof r.runId === 'string' &&
    typeof r.scenarioId === 'string' &&
    typeof r.startedAt === 'string' &&
    typeof r.savedAt === 'string' &&
    typeof pkg === 'object' && pkg !== null &&
    typeof pkg.name === 'string' &&
    typeof pkg.version === 'string'
  )
}

function isReportPageShaped(v: unknown): v is ReportPage {
  if (typeof v !== 'object' || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p.pageId === 'string' &&
    typeof p.name === 'string' &&
    typeof p.savedAt === 'string' &&
    isRunRefShaped(p.createdFrom) &&
    typeof p.surface === 'object' && p.surface !== null
  )
}

/** 落盘报表页（同 pageId 覆盖；surface 非法 → INVALID_ARGS）。 */
export function saveReportPage(root: string, page: ReportPage): string {
  requireSafePageId(page.pageId)
  const validation = validateReportSurface(page.surface)
  if (!validation.ok) {
    throw new PackageStoreError(
      'INVALID_ARGS',
      `report page surface invalid: ${validation.errors.map((e) => e.code).join(';')}`,
    )
  }
  const dir = reportsDir(root)
  assertInsideRoot(root, dir)
  mkdirSync(dir, { recursive: true })
  const file = pagePath(root, page.pageId)
  writeFileSync(
    file,
    `${JSON.stringify({ ...page, surface: validation.value }, null, 2)}\n`,
    'utf8',
  )
  return file
}

/** 读取报表页。非法 pageId → INVALID_ARGS；缺失 → NOT_FOUND；损坏 → PACKAGE_MALFORMED。 */
export function loadReportPage(root: string, pageId: unknown): ReportPage {
  const file = pagePath(root, pageId)
  if (!existsSync(file)) {
    throw new PackageStoreError('NOT_FOUND', `report page ${String(pageId)} not found`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    throw new PackageStoreError('PACKAGE_MALFORMED', `report page ${String(pageId)} is corrupt`)
  }
  if (!isReportPageShaped(parsed)) {
    throw new PackageStoreError('PACKAGE_MALFORMED', `report page ${String(pageId)} is corrupt`)
  }
  return parsed
}

/** 列出报表页（损坏条目跳过——列表不因单条损坏 fail-loud，详情面再拒）。 */
export function listReportPages(root: string): ReportPage[] {
  const dir = reportsDir(root)
  if (!existsSync(dir)) return []
  const out: ReportPage[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const full = join(dir, name)
    try {
      if (!statSync(full).isFile()) continue
      const parsed: unknown = JSON.parse(readFileSync(full, 'utf8'))
      if (isReportPageShaped(parsed)) out.push(parsed)
    } catch {
      /* 跳过损坏条目 */
    }
  }
  out.sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : a.pageId < b.pageId ? 1 : -1))
  return out
}
