/**
 * 运行时加载门禁（规范 §8.1）：
 * 缺 manifest / 指纹不符 / 未派生 → 拒绝加载（DERIVED_DRIFT）。
 * 场景执行与规则加载前必须过此门禁；重新派生可恢复。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readManifest, sha256Text, sourceDigestOf, sourceFileSha256 } from './derive.js'
import { isSafeRelPath, listSourceFiles, readPackageMeta, readSourceFile } from './store.js'
import type { LoadGateResult } from './types.js'

/** manifest 条目路径必须是安全 rel（tool-face-policy P2.1 读写成对）；恶意清单直接漂移拒绝。 */
function safeEntryPath(rel: string): boolean {
  return isSafeRelPath(rel)
}

/**
 * 校验派生链指纹。任何不一致都拒绝加载，错误码 `DERIVED_DRIFT`。
 */
export function verifyDerived(versionDir: string): LoadGateResult {
  const manifest = readManifest(versionDir)
  if (manifest === null) {
    return { ok: false, code: 'DERIVED_DRIFT', reason: 'missing manifest (never derived)' }
  }

  // 源指纹：逐一比对 + 聚合摘要 + 清单完整性（磁盘上多出的源文件也算漂移）
  const onDisk = listSourceFiles(versionDir)
  const listed = new Set(manifest.sources.map((e) => e.path))
  for (const rel of onDisk) {
    if (!listed.has(rel)) {
      return { ok: false, code: 'DERIVED_DRIFT', reason: `source file not in manifest: ${rel}` }
    }
  }
  for (const entry of manifest.sources) {
    if (!safeEntryPath(entry.path)) {
      return { ok: false, code: 'DERIVED_DRIFT', reason: `unsafe manifest path: ${entry.path}` }
    }
    const full = join(versionDir, entry.path)
    if (!existsSync(full)) {
      return { ok: false, code: 'DERIVED_DRIFT', reason: `source file missing: ${entry.path}` }
    }
    const actual = sourceFileSha256(entry.path, readSourceFile(versionDir, entry.path))
    if (actual !== entry.sha256) {
      return { ok: false, code: 'DERIVED_DRIFT', reason: `source fingerprint mismatch: ${entry.path}` }
    }
  }
  const digest = sourceDigestOf(manifest.sources)
  if (digest !== manifest.sourceDigest) {
    return { ok: false, code: 'DERIVED_DRIFT', reason: 'sourceDigest mismatch' }
  }

  // 派生物指纹
  for (const entry of manifest.derived) {
    if (!safeEntryPath(entry.path)) {
      return { ok: false, code: 'DERIVED_DRIFT', reason: `unsafe manifest path: ${entry.path}` }
    }
    const full = join(versionDir, entry.path)
    if (!existsSync(full)) {
      return { ok: false, code: 'DERIVED_DRIFT', reason: `derived file missing: ${entry.path}` }
    }
    const actual = sha256Text(readFileSync(full, 'utf8'))
    if (actual !== entry.sha256) {
      return { ok: false, code: 'DERIVED_DRIFT', reason: `derived fingerprint mismatch: ${entry.path}` }
    }
  }

  // 库外锚点：仅当最后一条签发记录属于**当前版本**时才校验——
  // fork 会原样携带上一版本的 issueRecord（含其 manifestDigest），
  // 旧版本锚点对新 manifest 必然失配，不得阻断新版本门禁（D15）。
  try {
    const meta = readPackageMeta(versionDir)
    const last = meta.issueRecord[meta.issueRecord.length - 1]
    if (last && last.version === meta.version && last.manifestDigest) {
      const manifestSha = sha256Text(readFileSync(join(versionDir, 'derived/manifest.yaml'), 'utf8'))
      if (manifestSha !== last.manifestDigest) {
        return {
          ok: false,
          code: 'DERIVED_DRIFT',
          reason: 'manifest anchor mismatch (manifest itself was altered)',
        }
      }
    }
  } catch {
    /* 元数据不可读时由源指纹兜底 */
  }

  return { ok: true, manifest }
}
