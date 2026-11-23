/**
 * 发布业务 v1（平台免重启声明式发布）行为验收：
 * publish（台账收编 + 连接器登记）→ 未激活拒运行 → activate（批准卡 + 宿主身份）→ 运行放行
 * → 未登记源拒（缺配置 fail-closed）→ 身份缺席激活拒（越权 fail-closed）→ 回滚无上一版本拒。
 * 不是源码关键词断言（交付要求：防线改动须行为测试）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../dist/agent-tools.js'
import { apply as applyBackend } from '../dist/index.js'
import { dataSources, registerDataSourceForTest } from '../dist/data-sources.js'
import { businessPolicy } from '../dist/business-policy.js'
import {
  currentRuntimeContext, provideRuntimeContext, runtimeContextForHost,
  OntoRuntime, loadSourceConfigs, restoreManagedDataSources, upsertSourceConfig, sourceConfigsPath,
  parseControlledBaseUrl,
} from '@dsh-onto/runtime'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const WST_SRC = join(REPO, 'packages', 'wst', '1.0.0')

function setupPublish(approvalOutcome = 'allowed-once') {
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
      return approvalOutcome
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
  // 注册表是模块级共享：先清位，防上个用例残留登记污染断言
  if (dataSources.has('SRC-WST-CORE')) dataSources.unregister('SRC-WST-CORE')
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

    // 越权：身份缺席（可信宿主/认证服务缺席）→ 激活拒绝（身份先于批准卡，确定性 OBJECT_NOT_GRANTED）
    businessPolicy.setIdentityProvider(null)
    await assert.rejects(
      () => chain.tools.get('activate_business').execute({ name: 'wst-ops', version: '1.0.0', humanApproved: true }, EXEC),
      (e) => e.code === 'OBJECT_NOT_GRANTED',
    )

    // 回滚：无上一活动版本 → 拒绝（目标不存在），不静默
    businessPolicy.setIdentityProvider(() => IDENTITY)
    await assert.rejects(
      () => chain.tools.get('rollback_business').execute({ name: 'wst-ops', humanApproved: true }, EXEC),
      (e) => e.code === 'RELEASE_NOT_FOUND',
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
    // 回环白名单口径：IPv6 回环（[::1]）与 https 放行；非回环 http 已在上方拒绝
    assert.doesNotThrow(() => parseControlledBaseUrl('http://[::1]:3912'), 'IPv6 回环 http 须放行')
    assert.doesNotThrow(() => parseControlledBaseUrl('http://localhost:3912'))
    assert.doesNotThrow(() => parseControlledBaseUrl('https://api.example.com'))
    assert.throws(() => parseControlledBaseUrl('http://[::ffff:169.254.169.254]/'), /受控数据源配置/)
  } finally {
    chain.dispose()
  }
})

test('受管闸 wire 面（业务页 runScenario 入口）：未激活拒（onto/conflict + origCode）→ activate 后放行', async () => {
  const chain = setupPublish()
  const wireCtx = new Context()
  wireCtx.reflect.provide('profileContext', { dir: chain.root })
  const wireRuntime = runtimeContextForHost(wireCtx.root)
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

    const service = new OntoRuntime(wireCtx)
    const runArgs = { name: 'wst-ops', version: '1.0.0', scenarioId: 'SCN-WST-HAZARD-MIX', dataset: DATASET }

    // 已受管未激活：wire 面（workbench 场景运行 tab 的实际入口）同样受管闸 fail-closed
    await assert.rejects(
      () => service.remoteExportRunScenario(runArgs),
      (e) =>
        e.code === 'onto/conflict'
        && e.details?.origCode === 'RELEASE_NOT_ACTIVE'
        && /已导入未激活/.test(e.message),
    )

    // activate（工具面，批准卡 + 宿主身份）→ wire 面放行，规则引擎同口径
    await chain.tools.get('activate_business').execute(
      { name: 'wst-ops', version: '1.0.0', humanApproved: true },
      EXEC,
    )
    const { result } = await service.remoteExportRunScenario(runArgs)
    assert.equal(result.humanReviewRequired, true)
    const cand = result.candidates[0]
    assert.ok(cand.hitRuleIds.includes('RULE-WST-SCORE-FILL'), `命中规则: ${JSON.stringify(cand.hitRuleIds)}`)
  } finally {
    wireRuntime.dispose()
    chain.dispose()
  }
})

test('发布业务 v1：受控数据源配置随宿主启动恢复（重启后 sourceId 自动再登记；令牌只存 env 名不落盘）', async () => {
  const chain = setupPublish()
  process.env.DSH_PUB_TOKEN_TEST = 'secret-token-42'
  try {
    businessPolicy.setIdentityProvider(() => IDENTITY)
    await chain.tools.get('publish_business').execute(
      {
        name: 'wst-ops',
        version: '1.0.0',
        sourceId: 'SRC-WST-CORE',
        sourceKind: 'simulated',
        apiBaseUrl: 'http://127.0.0.1:3912',
        apiTokenEnv: 'DSH_PUB_TOKEN_TEST',
        humanApproved: true,
      },
      EXEC,
    )
    const dataDir = join(chain.root, 'dsh-onto')
    // 部署配置落盘（与发布台账分离）；令牌只存 env 变量名——值不入包、不落台账、不落配置
    assert.ok(existsSync(sourceConfigsPath(dataDir)), '受控数据源配置须落盘')
    const configs = loadSourceConfigs(dataDir)
    assert.equal(configs.length, 1)
    assert.equal(configs[0].apiTokenEnv, 'DSH_PUB_TOKEN_TEST')
    const configRaw = readFileSync(sourceConfigsPath(dataDir), 'utf8')
    assert.ok(!configRaw.includes('secret-token-42'), '令牌值不得落 source-configs.json')
    const manifestRaw = readFileSync(join(dataDir, 'releases', 'manifests', 'wst-ops', '1.0.0.json'), 'utf8')
    assert.ok(!manifestRaw.includes('secret-token-42'), '令牌不得入发布台账 manifest')
    const historyRaw = readFileSync(join(dataDir, 'releases', 'history.jsonl'), 'utf8')
    assert.ok(!historyRaw.includes('secret-token-42'), '令牌不得落 history 台账')
    assert.ok(historyRaw.includes('approvalDigest'), '批准卡凭证摘要须留痕入 history（T2.1）')
    const pkgRaw = readFileSync(join(dataDir, 'workspace', 'packages', 'wst-ops', '1.0.0', 'package.yaml'), 'utf8')
    assert.ok(!pkgRaw.includes('secret-token-42'), '令牌不得入包')

    // 模拟重启：全新宿主运行上下文（登记表为空）→ backend 启动装配 → 按配置自动恢复登记
    dataSources.unregister('SRC-WST-CORE')
    const disposers = []
    const bootCtx = {
      root: { get: (k) => (k === 'profileContext' ? { dir: chain.root } : undefined) },
      plugin() {},
      effect(factory) { disposers.push(factory()) },
    }
    const bootRuntime = runtimeContextForHost(bootCtx.root)
    try {
      applyBackend(bootCtx)
      const restored = bootRuntime.run(() => dataSources.has('SRC-WST-CORE'))
      assert.equal(restored, true, '宿主启动须按受控数据源配置恢复登记')
    } finally {
      for (const dispose of disposers) dispose()
    }
  } finally {
    delete process.env.DSH_PUB_TOKEN_TEST
    chain.dispose()
  }
})

test('启动恢复 fail-closed：配置复核失败/包契约缺失不登记；已登记不覆盖；损坏配置整表拒', () => {
  const chain = setupPublish()
  try {
    const dataDir = join(chain.root, 'dsh-onto')
    const at = new Date().toISOString()
    upsertSourceConfig(dataDir, {
      sourceId: 'SRC-BAD-URL', package: { name: 'wst-ops', version: '1.0.0' },
      sourceKind: 'simulated', apiBaseUrl: 'http://example.com:8080', registeredAt: at,
    })
    upsertSourceConfig(dataDir, {
      sourceId: 'SRC-NO-PKG', package: { name: 'ghost-pkg', version: '9.9.9' },
      sourceKind: 'simulated', apiBaseUrl: 'http://127.0.0.1:3912', registeredAt: at,
    })
    upsertSourceConfig(dataDir, {
      sourceId: 'SRC-KEPT', package: { name: 'wst-ops', version: '1.0.0' },
      sourceKind: 'simulated', apiBaseUrl: 'http://127.0.0.1:3912', registeredAt: at,
    })
    upsertSourceConfig(dataDir, {
      sourceId: 'SRC-WST-CORE', package: { name: 'wst-ops', version: '1.0.0' },
      sourceKind: 'formal', apiBaseUrl: 'https://api.example.com', registeredAt: at,
    })
    // 已登记的不被恢复覆盖（部署 env / 插件登记优先）
    registerDataSourceForTest('SRC-KEPT', {
      version: 'stub', nature: 'simulated',
      async fetch() { throw new Error('stub-kept') },
    })

    const report = restoreManagedDataSources(dataDir)
    assert.deepEqual(report.restored, ['SRC-WST-CORE'])
    assert.deepEqual(report.skipped.map((s) => s.sourceId).sort(), ['SRC-BAD-URL', 'SRC-KEPT', 'SRC-NO-PKG'])
    assert.equal(dataSources.has('SRC-WST-CORE'), true)
    assert.equal(dataSources.has('SRC-BAD-URL'), false, '非回环 http 配置复核失败 → fail-closed 不登记')
    assert.equal(dataSources.has('SRC-NO-PKG'), false, '包契约缺失 → fail-closed 不登记')
    assert.ok(
      report.skipped.find((s) => s.sourceId === 'SRC-KEPT')?.reason.includes('不覆盖'),
      '已登记 sourceId 须标注不覆盖',
    )

    // 配置整体损坏 → 全部不登记 + loadError（fail-closed）
    writeFileSync(sourceConfigsPath(dataDir), '{corrupt', 'utf8')
    const corrupt = restoreManagedDataSources(dataDir)
    assert.equal(corrupt.loadError !== undefined, true, '配置损坏须报 loadError')
    assert.deepEqual(corrupt.restored, [])
  } finally {
    chain.dispose()
  }
})

test('发布业务 v1：rollback 成功路径 + 回滚后闸状态（回滚版放行/新版拒）', async () => {
  const chain = setupPublish()
  // 二版同名（wst-ops 1.0.0 / 1.0.1，均随仓已签发）：回滚 = 活动指针回上一活动版
  cpSync(join(REPO, 'packages', 'wst-ops', '1.0.1'), join(chain.root, 'dsh-onto', 'workspace', 'packages', 'wst-ops', '1.0.1'), { recursive: true })
  try {
    businessPolicy.setIdentityProvider(() => IDENTITY)
    const pubArgs = (version) => ({
      name: 'wst-ops', version, sourceId: 'SRC-WST-CORE',
      sourceKind: 'simulated', apiBaseUrl: 'http://127.0.0.1:3912', humanApproved: true,
    })
    await chain.tools.get('publish_business').execute(pubArgs('1.0.0'), EXEC)
    await chain.tools.get('activate_business').execute({ name: 'wst-ops', version: '1.0.0', humanApproved: true }, EXEC)
    await chain.tools.get('publish_business').execute(pubArgs('1.0.1'), EXEC)
    await chain.tools.get('activate_business').execute({ name: 'wst-ops', version: '1.0.1', humanApproved: true }, EXEC)

    const rolled = await chain.tools.get('rollback_business').execute({ name: 'wst-ops', humanApproved: true }, EXEC)
    assert.equal(rolled.rolledBackTo, '1.0.0')

    // 回滚后闸状态：回滚版放行（新运行绑 1.0.0）；被回滚版拒（指针绑定）
    const run = await chain.tools.get('run_scenario').execute(
      { name: 'wst-ops', version: '1.0.0', scenarioId: 'SCN-WST-HAZARD-MIX', dataset: DATASET },
      EXEC,
    )
    const value = run.values?.[0] ?? run.value ?? run
    assert.equal(JSON.parse(JSON.stringify(value)).humanReviewRequired, true)
    await assert.rejects(
      () => chain.tools.get('run_scenario').execute(
        { name: 'wst-ops', version: '1.0.1', scenarioId: 'SCN-WST-HAZARD-MIX', dataset: DATASET },
        EXEC,
      ),
      (e) => e.code === 'RELEASE_VERSION_NOT_ACTIVE',
    )
  } finally {
    chain.dispose()
  }
})

test('发布业务 v1：批准卡 rejected → 零状态变更（fail-closed）', async () => {
  const chain = setupPublish('rejected')
  try {
    businessPolicy.setIdentityProvider(() => IDENTITY)
    await assert.rejects(
      () =>
        chain.tools.get('publish_business').execute(
          {
            name: 'wst-ops', version: '1.0.0', sourceId: 'SRC-WST-CORE',
            sourceKind: 'simulated', apiBaseUrl: 'http://127.0.0.1:3912', humanApproved: true,
          },
          EXEC,
        ),
      (e) => e.code === 'APPROVAL_DENIED',
    )
    const dataDir = join(chain.root, 'dsh-onto')
    assert.ok(!existsSync(join(dataDir, 'releases', 'manifests', 'wst-ops', '1.0.0.json')), '未放行不得写发布台账')
    assert.equal(dataSources.has('SRC-WST-CORE'), false, '未放行不得登记连接器')
    assert.ok(!existsSync(sourceConfigsPath(dataDir)), '未放行不得落受控数据源配置')
  } finally {
    chain.dispose()
  }
})

test('发布业务 v1：sourceId 归属冲突 → 拒（幂等替换只留给同包重发布）', async () => {
  const chain = setupPublish()
  try {
    businessPolicy.setIdentityProvider(() => IDENTITY)
    const dataDir = join(chain.root, 'dsh-onto')
    upsertSourceConfig(dataDir, {
      sourceId: 'SRC-WST-CORE',
      package: { name: 'other-ops', version: '2.0.0' },
      sourceKind: 'simulated',
      apiBaseUrl: 'http://127.0.0.1:3912',
      registeredAt: new Date().toISOString(),
    })
    await assert.rejects(
      () =>
        chain.tools.get('publish_business').execute(
          {
            name: 'wst-ops', version: '1.0.0', sourceId: 'SRC-WST-CORE',
            sourceKind: 'simulated', apiBaseUrl: 'http://127.0.0.1:3912', humanApproved: true,
          },
          EXEC,
        ),
      (e) => e.code === 'INVALID_ARGS' && /占用/.test(e.message),
    )
    assert.equal(chain.approvalCount(), 0, '归属冲突不得弹批准卡')
  } finally {
    chain.dispose()
  }
})

test('发布业务 v1：apiTokenEnv 声明但宿主 env 缺失 → fail-closed（不登记不落盘）', async () => {
  const chain = setupPublish()
  delete process.env.DSH_MISSING_TOKEN_TEST
  try {
    businessPolicy.setIdentityProvider(() => IDENTITY)
    await assert.rejects(
      () =>
        chain.tools.get('publish_business').execute(
          {
            name: 'wst-ops', version: '1.0.0', sourceId: 'SRC-WST-CORE',
            sourceKind: 'simulated', apiBaseUrl: 'http://127.0.0.1:3912',
            apiTokenEnv: 'DSH_MISSING_TOKEN_TEST', humanApproved: true,
          },
          EXEC,
        ),
      (e) => e.code === 'INVALID_ARGS' && /令牌 env/.test(e.message),
    )
    assert.equal(chain.approvalCount(), 0, '令牌缺失不得弹批准卡')
    assert.equal(dataSources.has('SRC-WST-CORE'), false)
  } finally {
    chain.dispose()
  }
})
