/**
 * issue #30 WP-B — listSourceConfigs：页面选源跑批的登记摘要面。
 * 口径：按包过滤、最小披露（apiBaseUrl/apiTokenEnv 不过页面）、配置损坏 fail-loud。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { OntoRuntime } from '../dist/index.js'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'onto-source-config-wire-'))
  const dataDir = join(dir, 'dsh-onto')
  mkdirSync(dataDir, { recursive: true })
  const ctx = new Context()
  ctx.reflect.provide('profileContext', { dir })
  const service = new OntoRuntime(ctx)
  return {
    dir,
    dataDir,
    service,
    writeRaw(text) {
      writeFileSync(join(dataDir, 'source-configs.json'), text, 'utf8')
    },
    writeConfigs(sources) {
      this.writeRaw(JSON.stringify({ format: 'dsh-onto-source-configs/1', sources }, null, 2))
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

const CFG_A = {
  sourceId: 'SRC-A',
  package: { name: 'pkg-a', version: '1.0.0' },
  sourceKind: 'formal',
  apiBaseUrl: 'https://api.example.internal',
  apiTokenEnv: 'DSH_TOKEN_A',
  registeredAt: '2026-11-24T00:00:00.000Z',
}
const CFG_B = {
  sourceId: 'SRC-B',
  package: { name: 'pkg-b', version: '2.0.0' },
  sourceKind: 'simulated',
  apiBaseUrl: 'http://127.0.0.1:3912',
  registeredAt: '2026-11-24T01:00:00.000Z',
}

test('listSourceConfigs：按包过滤 + 最小披露（apiBaseUrl/apiTokenEnv 不过页面）', async () => {
  const f = fixture()
  try {
    f.writeConfigs([CFG_A, CFG_B])
    const { sources } = await f.service.remoteExportListSourceConfigs({ name: 'pkg-a', version: '1.0.0' })
    assert.equal(sources.length, 1)
    const row = sources[0]
    assert.equal(row.sourceId, 'SRC-A')
    assert.deepEqual(row.package, { name: 'pkg-a', version: '1.0.0' })
    assert.equal(row.sourceKind, 'formal')
    assert.equal(typeof row.registeredAt, 'string')
    assert.equal(row.apiBaseUrl, undefined, 'apiBaseUrl 不得过页面')
    assert.equal(row.apiTokenEnv, undefined, 'apiTokenEnv 不得过页面')
    const dumped = JSON.stringify(sources)
    assert.ok(!dumped.includes('DSH_TOKEN_A'), '令牌 env 名不得过页面')
    assert.ok(!dumped.includes('api.example.internal'), '基址不得过页面')
  } finally {
    f.dispose()
  }
})

test('listSourceConfigs：同名不同版本不漏出；无配置文件 → 空表', async () => {
  const f = fixture()
  try {
    // 同名 pkg-a 但 1.0.1 —— 与 1.0.0 不同版本，不得串面
    f.writeConfigs([CFG_A, { ...CFG_A, sourceId: 'SRC-A2', package: { name: 'pkg-a', version: '1.0.1' } }])
    const { sources } = await f.service.remoteExportListSourceConfigs({ name: 'pkg-a', version: '1.0.1' })
    assert.deepEqual(sources.map((s) => s.sourceId), ['SRC-A2'])

    // 无文件 → 空表（不是错误）
    rmSync(join(f.dataDir, 'source-configs.json'))
    const empty = await f.service.remoteExportListSourceConfigs({ name: 'pkg-a', version: '1.0.0' })
    assert.deepEqual(empty.sources, [])
  } finally {
    f.dispose()
  }
})

test('listSourceConfigs：配置损坏 fail-loud，不静默空表', async () => {
  const f = fixture()
  try {
    f.writeRaw('{ not json')
    await assert.rejects(
      () => f.service.remoteExportListSourceConfigs({ name: 'pkg-a', version: '1.0.0' }),
      (e) => {
        assert.match(String(e.message ?? e), /无法解析|bad-request|INVALID_ARGS/)
        return true
      },
    )
  } finally {
    f.dispose()
  }
})
