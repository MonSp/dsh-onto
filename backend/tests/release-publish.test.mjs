/**
 * 发布业务 v1（平台免重启声明式发布）行为验收：
 * publish（台账收编 + 连接器登记）→ 未激活拒运行 → activate（批准卡 + 宿主身份）→ 运行放行
 * → 未登记源拒（缺配置 fail-closed）→ 身份缺席激活拒（越权 fail-closed）→ 回滚无上一版本拒。
 * 不是源码关键词断言（交付要求：防线改动须行为测试）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from '../dist/agent-tools.js'
import { dataSources } from '../dist/data-sources.js'
import { businessPolicy } from '../dist/business-policy.js'
import { currentRuntimeContext, provideRuntimeContext } from '@dsh-onto/runtime'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const WST_SRC = join(REPO, 'packages', 'wst', '1.0.0')

function setupPublish() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-onto-pub-'))
  const versionDir = join(root, 'dsh-onto', 'workspace', 'packages', 'wst-ops', '1.0.0')
  mkdirSync(join(versionDir, '..'), { recursive: true })
  // 原样复制（不重派生：保持包内指纹自洽，发布锚点链照常过）
  cpSync(WST_SRC, versionDir, { recursive: true })

  const services = new Map()
  services.set('profileContext', { dir: root })
  let approvalRequests = 0
  services.set('approval', {
    request: async () => {
      approvalRequests++
      return 'allowed-once'
    },
  })
  const tools = new Map()
  const ctx = {
    on: () => undefined,
    root: { get: (k) => services.get(k) },
    tools: {
      guard: () => () => undefined,
      register: (d) => {
        tools.set(d.name, d)
      },
    },
  }
  provideRuntimeContext(ctx.root, currentRuntimeContext())
  apply(ctx)
  return {
    root,
    tools,
    approvalCount: () => approvalRequests,
    dispose: () => {
      businessPolicy.setIdentityProvider(null)
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const SESSION = { id: 's-pub' }
const EXEC = { agent: { session: SESSION }, callId: 'c-pub' }
const IDENTITY = {
  userId: 'ops-deployer',
  tenant: 'tenant-a',
  roles: ['analyst'],
  dataScope: { objectTypes: [] },
}

const DATASET = {
  objects: [
    { id: 'BIN-1', type: 'OBJ-WST-BIN', attrs: { binId: 'BIN-1', binNo: 'B1' } },
  ],
  relations: [],
  behaviors: [],
  candidates: [
    {
      candidateId: 'ALERT-1',
      objectRef: 'BIN-1',
      features: { fillRatio: 0.9, mixCount: 0, hazardFlag: 0 },
      tags: [],
    },
  ],
}

test('发布业务 v1：publish 登记连接器并收编台账 → 未激活拒运行 → activate 后放行（批准卡 + 宿主身份）', async () => {
  const chain = setupPublish()
  try {
    businessPolicy.setIdentityProvider(() => IDENTITY)

    // 1) publish：连接器即时登记（免重启）+ 发布台账收编；不激活
    const pub = await chain.tools.get('publish_business').execute(
      {
        name: 'wst-ops',
        version: '1.0.0',
        sourceId: 'SRC-WST-CORE',
        sourceKind: 'simulated',
        apiBaseUrl: 'http://127.0.0.1:3912',
        humanApproved: true,
      },
      EXEC,
    )
    assert.equal(pub.activated, false)
    assert.equal(pub.sourceId, 'SRC-WST-CORE')
    assert.equal(dataSources.has('SRC-WST-CORE'), true, 'publish 须即时登记连接器（运行中 registry）')
    assert.equal(chain.approvalCount(), 1, 'publish 须过批准卡')

    // 2) 已导入未激活 → 新运行拒绝（受管闸 fail-closed）
    await assert.rejects(
      () =>
        chain.tools.get('run_scenario').execute(
          { name: 'wst-ops', version: '1.0.0', scenarioId: 'SCN-WST-HAZARD-MIX', dataset: DATASET },
          EXEC,
        ),
      (e) => e.code === 'RELEASE_NOT_ACTIVE',
    )

    // 3) activate：批准卡 + 授权人 = 宿主用户 id（不收模型自称）
    const act = await chain.tools.get('activate_business').execute(
      { name: 'wst-ops', version: '1.0.0', humanApproved: true },
      EXEC,
    )
    assert.equal(act.activated, true)
    assert.equal(act.authorizedBy, 'ops-deployer')
    assert.equal(chain.approvalCount(), 2)

    // 4) 激活后运行放行：规则引擎同口径（FILL 命中、人审恒真）
    const run = await chain.tools.get('run_scenario').execute(
      { name: 'wst-ops', version: '1.0.0', scenarioId: 'SCN-WST-HAZARD-MIX', dataset: DATASET },
      EXEC,
    )
    const value = run.values?.[0] ?? run.value ?? run
    const payload = JSON.parse(JSON.stringify(value))
    assert.equal(payload.humanReviewRequired, true)
    const cand = payload.candidates[0]
    assert.ok(cand.hitRuleIds.includes('RULE-WST-SCORE-FILL'), `命中规则: ${JSON.stringify(cand.hitRuleIds)}`)
  } finally {
    chain.dispose()
  }
})

test('发布业务 v1：缺配置/越权/回滚 三态 fail-closed', async () => {
  const chain = setupPublish()
  try {
    businessPolicy.setIdentityProvider(() => IDENTITY)
    await chain.tools.get('publish_business').execute(
      {
        name: 'wst-ops',
        version: '1.0.0',
        sourceId: 'SRC-WST-CORE',
        sourceKind: 'simulated',
        apiBaseUrl: 'http://127.0.0.1:3912',
        humanApproved: true,
      },
      EXEC,
    )
    await chain.tools.get('activate_business').execute(
      { name: 'wst-ops', version: '1.0.0', humanApproved: true },
      EXEC,
    )

    // 缺配置：注销连接器后 sourceId 运行拒绝（deny-by-default）
    dataSources.unregister('SRC-WST-CORE')
    await assert.rejects(
      () =>
        chain.tools.get('run_scenario').execute(
          { name: 'wst-ops', version: '1.0.0', scenarioId: 'SCN-WST-HAZARD-MIX', sourceId: 'SRC-WST-CORE' },
          EXEC,
        ),
      (e) => e.code === 'INVALID_ARGS' && /数据源未登记/.test(e.message),
    )

    // 越权：身份缺席（可信宿主/认证服务缺席）→ 激活拒绝
    businessPolicy.setIdentityProvider(null)
    await assert.rejects(
      () => chain.tools.get('activate_business').execute({ name: 'wst-ops', version: '1.0.0', humanApproved: true }, EXEC),
      (e) => e.code === 'OBJECT_NOT_GRANTED' || e.code === 'APPROVAL_DENIED' || e.code === 'APPROVAL_UNAVAILABLE',
    )

    // 回滚：无上一活动版本 → 拒绝（目标不存在），不静默
    businessPolicy.setIdentityProvider(() => IDENTITY)
    await assert.rejects(
      () => chain.tools.get('rollback_business').execute({ name: 'wst-ops', humanApproved: true }, EXEC),
      (e) => e.code === 'RELEASE_NOT_FOUND' || /回滚/.test(e.message),
    )
  } finally {
    chain.dispose()
  }
})

test('发布业务 v1：受控数据源配置与意图声明校验', async () => {
  const chain = setupPublish()
  try {
    businessPolicy.setIdentityProvider(() => IDENTITY)
    const pub = chain.tools.get('publish_business')
    // 非回环 http 拒（受控配置）
    await assert.rejects(
      () =>
        pub.execute(
          {
            name: 'wst-ops',
            version: '1.0.0',
            sourceId: 'SRC-WST-CORE',
            sourceKind: 'simulated',
            apiBaseUrl: 'http://example.com:8080',
            humanApproved: true,
          },
          EXEC,
        ),
      (e) => e.code === 'INVALID_ARGS' && /受控数据源配置/.test(e.message),
    )
    // sourceKind 白名单
    await assert.rejects(
      () =>
        pub.execute(
          {
            name: 'wst-ops',
            version: '1.0.0',
            sourceId: 'SRC-WST-CORE',
            sourceKind: 'unknown-kind',
            apiBaseUrl: 'http://127.0.0.1:3912',
            humanApproved: true,
          },
          EXEC,
        ),
      (e) => e.code === 'INVALID_ARGS',
    )
    // humanApproved 意图声明：false 不弹批准卡不落动作
    await assert.rejects(
      () =>
        pub.execute(
          {
            name: 'wst-ops',
            version: '1.0.0',
            sourceId: 'SRC-WST-CORE',
            sourceKind: 'simulated',
            apiBaseUrl: 'http://127.0.0.1:3912',
            humanApproved: false,
          },
          EXEC,
        ),
      (e) => e.code === 'INVALID_ARGS' && /humanApproved/.test(e.message),
    )
    assert.equal(chain.approvalCount(), 0, '校验不过不得弹批准卡')
  } finally {
    chain.dispose()
  }
})
