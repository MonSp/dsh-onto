/**
 * dsh-onto 工作台 client half —— browser entry（classic script，零 runtime import/export）。
 *
 * 五个 tab：包管理 | 建模 | 知识库 | 校验派生 | 场景运行。
 * 远程命名空间：ontoWorkspace / ontoModel / ontoValidate / ontoDerive /
 * ontoKnowledge / ontoRuntime（inject 必须列全）。
 */

/** Remote call result: the gateway never rejects; branch on `ok`. */
type RemoteResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { message: string; code?: string } }

type ReactNode = import('react').ReactNode

interface LocaleRuntime {
  register(ns: string, dict: { zh: Record<string, string>; en: Record<string, string> }): void
  bind(ns: string): (key: string) => string
}

interface SlotsRuntime {
  inject(name: string, register: () => unknown): void
  register(spec: Record<string, unknown>, component: unknown): unknown
}

/** 远程命名空间上的方法：返回形状由 unwrap 统一解包。 */
type RemoteFn = (...args: unknown[]) => Promise<unknown>

interface Ctx {
  effect(dispose: void | (() => void), key?: string): void
  locale: LocaleRuntime
  slots: SlotsRuntime
  remote: Record<string, Record<string, RemoteFn> | undefined>
  provide(name: string, value: unknown): void
}

interface ModuleRequire {
  (id: 'react'): typeof import('react')
  (id: string): unknown
}

interface PluginModule {
  inject?: string[]
  apply(ctx: Ctx): void
}

interface Window {
  __ModuleLoader__: {
    load(entry: { id: string; factory(require: ModuleRequire): PluginModule }): void
  }
}

window.__ModuleLoader__.load({
  id: '@dsh-onto/workbench',
  factory(require): PluginModule {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const NS = 'dsh-onto.workbench'
    const PANEL_ID = 'dsh-onto-workbench'

    const zh = {
      panel: 'dsh-onto',
      title: 'dsh-onto 业务本体建模平台',
      subtitle: '判定在规则引擎，认定在人工',
      tabPackages: '包管理',
      tabModel: '建模',
      tabKnowledge: '知识库',
      tabValidate: '校验派生',
      tabRun: '场景运行',
      selected: '当前包',
      none: '（未选择）',
      name: '名称',
      version: '版本',
      domain: '域',
      status: '状态',
      actions: '操作',
      create: '新建包',
      fork: 'Fork 新版本',
      toReview: '提交评审',
      issue: '签发',
      issueBy: '签发人（人工）',
      exportBtn: '导出',
      importBtn: '导入',
      importHint: '粘贴导出的 JSON 归档',
      select: '选择',
      refresh: '刷新',
      objects: '对象',
      relations: '关系',
      dictionaries: '字典',
      behaviors: '行为',
      scoreRules: '打分规则',
      exclusionRules: '排除规则',
      skillTemplates: '方法论模板',
      scenarios: '场景',
      fieldMaps: '字段映射',
      apiSources: '数据源',
      yamlImport: 'YAML 导入',
      yamlPath: '文件路径（如 o1-objects/object-types.yaml）',
      yamlText: 'YAML 内容',
      yamlWrite: '写入源文件',
      modelFiles: '源文件',
      addScoreRule: '加打分规则',
      addObject: '加对象类型',
      ruleName: '规则名',
      weight: '权重',
      expression: '表达式',
      threshold: '阈值',
      evidence: '证据模板',
      objectName: '对象名',
      attrNames: '属性名（逗号分隔）',
      save: '保存模型',
      upload: '上传原料',
      sourceType: '原料类型',
      sourceName: '原料名',
      content: '内容',
      parse: 'LLM 解析',
      parseApi: '解析（DeepSeek API）',
      queue: '候选队列',
      approve: '批准',
      reject: '驳回',
      materialize: '物化进包',
      confidence: '置信度',
      forcedReview: '强制人审',
      conclusion: '结论性',
      layer: '层',
      kind: '类型',
      validateBtn: '执行校验',
      deriveBtn: '执行派生',
      gateBtn: '加载门禁',
      score: '质量分',
      errors: '错误',
      warnings: '警告',
      info: '信息',
      gateOk: '门禁通过',
      drift: '派生漂移（DERIVED_DRIFT）',
      scenario: '场景',
      dataset: '运行数据（JSON）',
      runBtn: '执行场景',
      candidates: '候选',
      riskScore: '风险分',
      hits: '命中规则',
      evidenceChains: '证据链',
      pending: '待核实',
      narrative: '叙述',
      excluded: '已排除',
      audit: '审计',
      humanReview: '需人工复核',
      forbidden: '禁语命中',
      passed: '通过',
      failed: '未闭合',
      busy: '处理中…',
      error: '错误',
      empty: '暂无数据',
      readme: '建模到运行：建包 → 建模/知识库物化 → 校验 → 签发 → 派生 → 场景运行。ISSUED 只读，改需 fork。',
    }
    const en = {
      panel: 'dsh-onto',
      title: 'dsh-onto Business Ontology Platform',
      subtitle: 'Rules judge; humans decide',
      tabPackages: 'Packages',
      tabModel: 'Modeling',
      tabKnowledge: 'Knowledge',
      tabValidate: 'Validate & Derive',
      tabRun: 'Scenarios',
      selected: 'Current package',
      none: '(none)',
      name: 'Name',
      version: 'Version',
      domain: 'Domain',
      status: 'Status',
      actions: 'Actions',
      create: 'New package',
      fork: 'Fork version',
      toReview: 'Submit review',
      issue: 'Issue',
      issueBy: 'Issued by (human)',
      exportBtn: 'Export',
      importBtn: 'Import',
      importHint: 'Paste an exported JSON archive',
      select: 'Select',
      refresh: 'Refresh',
      objects: 'Objects',
      relations: 'Relations',
      dictionaries: 'Dictionaries',
      behaviors: 'Behaviors',
      scoreRules: 'Score rules',
      exclusionRules: 'Exclusion rules',
      skillTemplates: 'Skill templates',
      scenarios: 'Scenarios',
      fieldMaps: 'Field maps',
      apiSources: 'API sources',
      yamlImport: 'YAML import',
      yamlPath: 'File path (e.g. o1-objects/object-types.yaml)',
      yamlText: 'YAML content',
      yamlWrite: 'Write source file',
      modelFiles: 'Source files',
      addScoreRule: 'Add score rule',
      addObject: 'Add object type',
      ruleName: 'Rule name',
      weight: 'Weight',
      expression: 'Expression',
      threshold: 'Threshold',
      evidence: 'Evidence template',
      objectName: 'Object name',
      attrNames: 'Attribute names (comma separated)',
      save: 'Save model',
      upload: 'Upload source',
      sourceType: 'Source type',
      sourceName: 'Source name',
      content: 'Content',
      parse: 'Parse (LLM)',
      parseApi: 'Parse (DeepSeek API)',
      queue: 'Candidate queue',
      approve: 'Approve',
      reject: 'Reject',
      materialize: 'Materialize',
      confidence: 'Confidence',
      forcedReview: 'Forced review',
      conclusion: 'Conclusion-like',
      layer: 'Layer',
      kind: 'Kind',
      validateBtn: 'Validate',
      deriveBtn: 'Derive',
      gateBtn: 'Load gate',
      score: 'Score',
      errors: 'Errors',
      warnings: 'Warnings',
      info: 'Info',
      gateOk: 'Gate passed',
      drift: 'Derived drift (DERIVED_DRIFT)',
      scenario: 'Scenario',
      dataset: 'Dataset (JSON)',
      runBtn: 'Run scenario',
      candidates: 'Candidates',
      riskScore: 'Risk score',
      hits: 'Hit rules',
      evidenceChains: 'Evidence',
      pending: 'Pending checks',
      narrative: 'Narrative',
      excluded: 'Excluded',
      audit: 'Audit',
      humanReview: 'Human review required',
      forbidden: 'Forbidden hits',
      passed: 'Closed',
      failed: 'Not closed',
      busy: 'Working…',
      error: 'Error',
      empty: 'No data',
      readme: 'Flow: create → model/knowledge → validate → issue → derive → run. ISSUED is read-only; fork to edit.',
    }

    function errText(e: unknown): string {
      if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
        return (e as { message: string }).message
      }
      if (typeof e === 'string') return e
      try {
        return JSON.stringify(e)
      } catch {
        return String(e)
      }
    }

    function unwrap<T>(result: unknown): T {
      if (result && typeof result === 'object' && 'ok' in (result as Record<string, unknown>)) {
        const r = result as RemoteResult<T>
        if (r.ok) return r.value
        throw new Error(errText(r.error))
      }
      return result as T
    }

    function fmt(n: number | undefined, digits = 3): string {
      return typeof n === 'number' ? n.toFixed(digits) : '—'
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 样式
     * ═══════════════════════════════════════════════════════════════════ */

    const CSS = [
      '.ow-wrap{display:flex;flex-direction:column;gap:12px;padding:16px 20px 40px;color:var(--dsw-alias-label-primary,#1c2333);font-family:var(--dsw-font-family);max-width:1080px;margin:0 auto;}',
      '.ow-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}',
      '.ow-h1{margin:0;font-size:19px;font-weight:700;}',
      '.ow-sub{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.ow-tabs{display:flex;gap:6px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-line,#e5e7eb);padding-bottom:8px;}',
      '.ow-tab{padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-line,#e5e7eb);background:transparent;cursor:pointer;font-size:13px;}',
      '.ow-tab.on{background:var(--dsw-alias-brand,#3b6fd4);color:#fff;border-color:transparent;}',
      '.ow-card{border:1px solid var(--dsw-alias-line,#e5e7eb);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px;}',
      '.ow-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
      '.ow-label{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);min-width:64px;}',
      '.ow-in{padding:6px 10px;border:1px solid var(--dsw-alias-line,#d1d5db);border-radius:8px;font-size:13px;flex:1;min-width:120px;background:transparent;color:inherit;}',
      '.ow-btn{padding:6px 14px;border-radius:8px;border:1px solid var(--dsw-alias-brand,#3b6fd4);background:var(--dsw-alias-brand,#3b6fd4);color:#fff;cursor:pointer;font-size:13px;}',
      '.ow-btn.ghost{background:transparent;color:var(--dsw-alias-brand,#3b6fd4);}',
      '.ow-btn:disabled{opacity:.5;cursor:default;}',
      '.ow-table{width:100%;border-collapse:collapse;font-size:12.5px;}',
      '.ow-table th,.ow-table td{border-bottom:1px solid var(--dsw-alias-line,#e5e7eb);padding:6px 8px;text-align:left;vertical-align:top;}',
      '.ow-table th{color:var(--dsw-alias-label-secondary,#6b7280);font-weight:600;}',
      '.ow-tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;background:var(--dsw-alias-fill,#eef2ff);margin-right:4px;}',
      '.ow-tag.warn{background:#fef3c7;color:#92400e;}',
      '.ow-tag.err{background:#fee2e2;color:#b91c1c;}',
      '.ow-tag.ok{background:#dcfce7;color:#166534;}',
      '.ow-mono{font-family:var(--dsw-font-mono,monospace);font-size:12px;white-space:pre-wrap;word-break:break-all;}',
      '.ow-h2{margin:0;font-size:15px;font-weight:650;}',
      '.ow-note{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);line-height:1.6;}',
      '.ow-textarea{width:100%;min-height:110px;padding:8px 10px;border:1px solid var(--dsw-alias-line,#d1d5db);border-radius:8px;font-size:12px;font-family:var(--dsw-font-mono,monospace);background:transparent;color:inherit;box-sizing:border-box;}',
      '.ow-sel{padding:6px 10px;border:1px solid var(--dsw-alias-line,#d1d5db);border-radius:8px;font-size:13px;background:transparent;color:inherit;}',
      '.ow-stat{display:inline-flex;align-items:center;gap:4px;padding:2px 10px;border-radius:8px;background:var(--dsw-alias-fill,#f3f4f6);font-size:12px;}',
    ].join('\n')

    /* ═══════════════════════════════════════════════════════════════════
     * 小组件
     * ═══════════════════════════════════════════════════════════════════ */

    function Tag(props: { text: string; tone?: 'ok' | 'warn' | 'err' }) {
      const cls = props.tone ? `ow-tag ${props.tone}` : 'ow-tag'
      return h('span', { className: cls }, props.text)
    }

    function Row(props: { label?: string; children?: ReactNode }) {
      return h(
        'div',
        { className: 'ow-row' },
        props.label ? h('span', { className: 'ow-label' }, props.label) : null,
        props.children,
      )
    }

    function Card(props: { title?: string; children?: ReactNode }) {
      return h(
        'div',
        { className: 'ow-card' },
        props.title ? h('h3', { className: 'ow-h2' }, props.title) : null,
        props.children,
      )
    }

    /* ═══════════════════════════════════════════════════════════════════
     * 包管理
     * ═══════════════════════════════════════════════════════════════════ */

    interface VersionRow {
      name: string
      version: string
      status: string
      domain: string
      dir: string
    }

    function PackagesPanel(props: {
      t: (k: string) => string
      apis: Ctx
      versions: VersionRow[]
      reload: () => void
      selected: { name: string; version: string } | null
      setSelected: (s: { name: string; version: string } | null) => void
    }) {
      const { t, apis, versions, reload } = props
      const [name, setName] = useState('')
      const [version, setVersion] = useState('1.0.0')
      const [domain, setDomain] = useState('')
      const [issuedBy, setIssuedBy] = useState('')
      const [forkTo, setForkTo] = useState('')
      const [importText, setImportText] = useState('')
      const [exportText, setExportText] = useState('')
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')

      const api = apis.remote['ontoWorkspace']
      const call = useCallback(
        async (label: string, fn: () => Promise<unknown>) => {
          if (!api) {
            setError('remote ontoWorkspace missing')
            return
          }
          setBusy(label)
          setError('')
          try {
            await fn()
            reload()
          } catch (e) {
            setError(errText(e))
          } finally {
            setBusy('')
          }
        },
        [apis, reload],
      )

      return h(
        'div',
        { className: 'ow-card' },
        h('h3', { className: 'ow-h2' }, t('tabPackages')),
        h('p', { className: 'ow-note' }, t('readme')),
        error ? h('p', { className: 'ow-note', style: { color: '#b91c1c' } }, error) : null,
        h(
          Row,
          { label: t('create') },
          h('input', { className: 'ow-in', placeholder: t('name'), value: name, onChange: (e: { target: { value: string } }) => setName(e.target.value) }),
          h('input', { className: 'ow-in', placeholder: t('version'), value: version, onChange: (e: { target: { value: string } }) => setVersion(e.target.value) }),
          h('input', { className: 'ow-in', placeholder: t('domain'), value: domain, onChange: (e: { target: { value: string } }) => setDomain(e.target.value) }),
          h(
            'button',
            {
              className: 'ow-btn',
              disabled: !name || !domain || !!busy,
              onClick: () =>
                void call('create', async () => {
                  unwrap(await api!.createPackage({ name, version, domain }))
                }),
            },
            busy === 'create' ? t('busy') : t('create'),
          ),
        ),
        h(
          'table',
          { className: 'ow-table' },
          h(
            'thead',
            null,
            h('tr', null,
              h('th', null, t('name')), h('th', null, t('version')), h('th', null, t('domain')),
              h('th', null, t('status')), h('th', null, t('actions'))),
          ),
          h(
            'tbody',
            null,
            versions.length === 0
              ? h('tr', null, h('td', { colSpan: 5 }, t('empty')))
              : versions.map((v) =>
                  h(
                    'tr',
                    { key: `${v.name}@${v.version}` },
                    h('td', null, v.name),
                    h('td', null, v.version),
                    h('td', null, v.domain),
                    h('td', null,
                      h(Tag, {
                        text: v.status,
                        tone: v.status === 'ISSUED' ? 'ok' : v.status === 'IN_REVIEW' ? 'warn' : undefined,
                      }),
                      props.selected && props.selected.name === v.name && props.selected.version === v.version
                        ? h(Tag, { text: '✓', tone: 'ok' })
                        : null,
                    ),
                    h(
                      'td',
                      null,
                      h('button', {
                        className: 'ow-btn ghost',
                        onClick: () => props.setSelected({ name: v.name, version: v.version }),
                      }, t('select')),
                      ' ',
                      v.status === 'DRAFT'
                        ? h('button', {
                            className: 'ow-btn ghost',
                            disabled: !!busy,
                            onClick: () =>
                              void call('review', async () => {
                                unwrap(await api!.transition({ name: v.name, version: v.version, to: 'IN_REVIEW' }))
                              }),
                          }, t('toReview'))
                        : null,
                      v.status === 'IN_REVIEW'
                        ? h('button', {
                            className: 'ow-btn ghost',
                            disabled: !!busy || !issuedBy.trim(),
                            title: t('issueBy'),
                            onClick: () =>
                              void call('issue', async () => {
                                unwrap(await api!.transition({
                                  name: v.name,
                                  version: v.version,
                                  to: 'ISSUED',
                                  issuedBy: issuedBy.trim(),
                                }))
                              }),
                          }, t('issue'))
                        : null,
                      ' ',
                      h('button', {
                        className: 'ow-btn ghost',
                        disabled: !!busy || !forkTo.trim(),
                        onClick: () =>
                          void call('fork', async () => {
                            unwrap(await api!.forkVersion({ name: v.name, fromVersion: v.version, toVersion: forkTo.trim() }))
                          }),
                      }, t('fork')),
                      ' ',
                      h('button', {
                        className: 'ow-btn ghost',
                        disabled: !!busy,
                        onClick: () =>
                          void call('export', async () => {
                            const r = unwrap<{ archive: unknown }>(await api!.exportVersion({ name: v.name, version: v.version }))
                            setExportText(JSON.stringify(r.archive, null, 2))
                          }),
                      }, t('exportBtn')),
                    ),
                  ),
                ),
          ),
        ),
        h(
          Row,
          { label: t('issueBy') },
          h('input', { className: 'ow-in', value: issuedBy, onChange: (e: { target: { value: string } }) => setIssuedBy(e.target.value) }),
          h('input', {
            className: 'ow-in',
            placeholder: t('fork') + ' → ' + t('version'),
            value: forkTo,
            onChange: (e: { target: { value: string } }) => setForkTo(e.target.value),
          }),
        ),
        exportText
          ? h('div', null, h('div', { className: 'ow-label' }, t('exportBtn')), h('pre', { className: 'ow-mono' }, exportText))
          : null,
        h(
          Card,
          { title: t('importBtn') },
          h('p', { className: 'ow-note' }, t('importHint')),
          h('textarea', {
            className: 'ow-textarea',
            value: importText,
            onChange: (e: { target: { value: string } }) => setImportText(e.target.value),
          }),
          h(
            'button',
            {
              className: 'ow-btn',
              disabled: !!busy || !importText.trim(),
              onClick: () =>
                void call('import', async () => {
                  const archive = JSON.parse(importText) as { meta: unknown; files: Record<string, string> }
                  unwrap(await api!.importVersion({ archive }))
                  setImportText('')
                }),
            },
            t('importBtn'),
          ),
        ),
      )
    }

    return {
      inject: [
        'slots',
        'locale',
        'remote',
        'remote.ontoWorkspace',
        'remote.ontoModel',
        'remote.ontoValidate',
        'remote.ontoDerive',
        'remote.ontoKnowledge',
        'remote.ontoRuntime',
      ],
      apply(ctx: Ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-onto-workbench: dictionaries')
        const t = ctx.locale.bind(NS)

        ctx.effect(() => {
          const style = document.createElement('style')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'dsh-onto-workbench: styles')

        function PanelIcon({ size }: { size?: number }) {
          const px = size || 20
          return h(
            'svg',
            { viewBox: '0 0 24 24', width: px, height: px, 'aria-hidden': true, style: { display: 'block' } },
            h('rect', { x: 4, y: 4, width: 16, height: 16, rx: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8 }),
            h('path', { d: 'M8 9h8M8 12h8M8 15h5', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
          )
        }

        function Workbench() {
          return h(AppRoot, { t, ctx })
        }

        /* ═══════════════════════════════════════════════════════════════
         * 建模
         * ═══════════════════════════════════════════════════════════════ */

        function ModelPanel(props: {
          t: (k: string) => string
          apis: Ctx
          selected: { name: string; version: string } | null
        }) {
          const { t, apis, selected } = props
          const [pkg, setPkg] = useState<Record<string, unknown> | null>(null)
          const [files, setFiles] = useState<Record<string, string>>({})
          const [yamlPath, setYamlPath] = useState('o1-objects/object-types.yaml')
          const [yamlText, setYamlText] = useState('')
          const [objName, setObjName] = useState('')
          const [attrNames, setAttrNames] = useState('')
          const [ruleName, setRuleName] = useState('')
          const [weight, setWeight] = useState('0.25')
          const [expression, setExpression] = useState('min(1, f1)')
          const [threshold, setThreshold] = useState('0.5')
          const [evidence, setEvidence] = useState('')
          const [busy, setBusy] = useState('')
          const [error, setError] = useState('')
          const api = apis.remote['ontoModel']

          const reload = useCallback(async () => {
            if (!api || !selected) return
            setBusy('load')
            setError('')
            try {
              const p = unwrap<{ pkg: Record<string, unknown> }>(await api.load({ name: selected.name, version: selected.version }))
              setPkg(p.pkg)
              const f = unwrap<{ files: Record<string, string> }>(await api.readSources({ name: selected.name, version: selected.version }))
              setFiles(f.files)
            } catch (e) {
              setError(errText(e))
            } finally {
              setBusy('')
            }
          }, [apis, selected])

          useEffect(() => {
            void reload()
          }, [reload])

          const savePkg = async (mutate: (p: Record<string, unknown>) => void, label: string) => {
            if (!api || !selected || !pkg) return
            setBusy(label)
            setError('')
            try {
              const next = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>
              mutate(next)
              unwrap(await api.save({ name: selected.name, version: selected.version, pkg: next }))
              await reload()
            } catch (e) {
              setError(errText(e))
            } finally {
              setBusy('')
            }
          }

          if (!selected) return h('div', { className: 'ow-card' }, h('p', { className: 'ow-note' }, t('none')))
          const model = (pkg ?? {}) as {
            objects?: Array<{ id: string; name: string }>
            relations?: Array<{ id: string; name: string }>
            dictionaries?: Array<{ id: string; name: string }>
            behaviors?: Array<{ id: string; name: string }>
            scoreRules?: Array<{ id: string; name: string; weight: number }>
            exclusionRules?: Array<{ id: string; name: string }>
            skillTemplates?: Array<{ id: string; name: string }>
            scenarios?: Array<{ id: string; name: string }>
            fieldMaps?: Array<{ id: string }>
            apiSources?: Array<{ id: string; name: string }>
          }

          return h(
            'div',
            { className: 'ow-card' },
            h('h3', { className: 'ow-h2' }, t('tabModel')),
            error ? h('p', { className: 'ow-note', style: { color: '#b91c1c' } }, error) : null,
            h(
              'div',
              { className: 'ow-row' },
              h('span', { className: 'ow-stat' }, `${t('objects')} ${model.objects?.length ?? 0}`),
              h('span', { className: 'ow-stat' }, `${t('relations')} ${model.relations?.length ?? 0}`),
              h('span', { className: 'ow-stat' }, `${t('dictionaries')} ${model.dictionaries?.length ?? 0}`),
              h('span', { className: 'ow-stat' }, `${t('behaviors')} ${model.behaviors?.length ?? 0}`),
              h('span', { className: 'ow-stat' }, `${t('scoreRules')} ${model.scoreRules?.length ?? 0}`),
              h('span', { className: 'ow-stat' }, `${t('exclusionRules')} ${model.exclusionRules?.length ?? 0}`),
              h('span', { className: 'ow-stat' }, `${t('skillTemplates')} ${model.skillTemplates?.length ?? 0}`),
              h('span', { className: 'ow-stat' }, `${t('scenarios')} ${model.scenarios?.length ?? 0}`),
            ),
            h(
              Card,
              { title: t('addObject') },
              h(
                Row,
                null,
                h('input', { className: 'ow-in', placeholder: t('objectName'), value: objName, onChange: (e: { target: { value: string } }) => setObjName(e.target.value) }),
                h('input', { className: 'ow-in', placeholder: t('attrNames'), value: attrNames, onChange: (e: { target: { value: string } }) => setAttrNames(e.target.value) }),
                h(
                  'button',
                  {
                    className: 'ow-btn',
                    disabled: !!busy || !objName.trim(),
                    onClick: () =>
                      void savePkg((p) => {
                        const objects = (p['objects'] as Array<Record<string, unknown>>) ?? []
                        const attrs = attrNames.split(',').map((s) => s.trim()).filter(Boolean)
                        objects.push({
                          id: `OBJ-GEN-${objects.length + 1}`,
                          name: objName.trim(),
                          attributes: attrs.map((n) => ({ name: n, type: 'string' })),
                        })
                        p['objects'] = objects
                      }, 'addObject'),
                  },
                  busy === 'addObject' ? t('busy') : t('addObject'),
                ),
              ),
            ),
            h(
              Card,
              { title: t('addScoreRule') },
              h(
                Row,
                null,
                h('input', { className: 'ow-in', placeholder: t('ruleName'), value: ruleName, onChange: (e: { target: { value: string } }) => setRuleName(e.target.value) }),
                h('input', { className: 'ow-in', style: { maxWidth: 90 }, placeholder: t('weight'), value: weight, onChange: (e: { target: { value: string } }) => setWeight(e.target.value) }),
                h('input', { className: 'ow-in', placeholder: t('expression'), value: expression, onChange: (e: { target: { value: string } }) => setExpression(e.target.value) }),
                h('input', { className: 'ow-in', style: { maxWidth: 90 }, placeholder: t('threshold'), value: threshold, onChange: (e: { target: { value: string } }) => setThreshold(e.target.value) }),
                h('input', { className: 'ow-in', placeholder: t('evidence'), value: evidence, onChange: (e: { target: { value: string } }) => setEvidence(e.target.value) }),
                h(
                  'button',
                  {
                    className: 'ow-btn',
                    disabled: !!busy || !ruleName.trim(),
                    onClick: () =>
                      void savePkg((p) => {
                        const rules = (p['scoreRules'] as Array<Record<string, unknown>>) ?? []
                        rules.push({
                          id: `RULE-GEN-${rules.length + 1}`,
                          name: ruleName.trim(),
                          weight: Number(weight) || 0,
                          expression,
                          threshold: Number(threshold) || 0,
                          evidenceTemplate: evidence || undefined,
                        })
                        p['scoreRules'] = rules
                      }, 'addRule'),
                  },
                  busy === 'addRule' ? t('busy') : t('addScoreRule'),
                ),
              ),
            ),
            h(
              Card,
              { title: t('yamlImport') },
              h(
                Row,
                null,
                h('select', {
                  className: 'ow-sel',
                  value: yamlPath,
                  onChange: (e: { target: { value: string } }) => {
                    setYamlPath(e.target.value)
                    setYamlText(files[e.target.value] ?? '')
                  },
                }, ...Object.keys(files).map((k) => h('option', { key: k, value: k }, k))),
                h('button', { className: 'ow-btn ghost', onClick: () => setYamlText(files[yamlPath] ?? '') }, t('refresh')),
              ),
              h('textarea', {
                className: 'ow-textarea',
                value: yamlText,
                onChange: (e: { target: { value: string } }) => setYamlText(e.target.value),
              }),
              h(
                'button',
                {
                  className: 'ow-btn',
                  disabled: !!busy || !yamlPath.trim(),
                  onClick: () =>
                    void (async () => {
                      if (!api || !selected) return
                      setBusy('yaml')
                      setError('')
                      try {
                        unwrap(await api.writeSource({ name: selected.name, version: selected.version, relPath: yamlPath, text: yamlText }))
                        await reload()
                      } catch (e) {
                        setError(errText(e))
                      } finally {
                        setBusy('')
                      }
                    })(),
                },
                busy === 'yaml' ? t('busy') : t('yamlWrite'),
              ),
            ),
          )
        }

        /* ═══════════════════════════════════════════════════════════════
         * 知识库
         * ═══════════════════════════════════════════════════════════════ */

        function KnowledgePanel(props: {
          t: (k: string) => string
          apis: Ctx
          selected: { name: string; version: string } | null
        }) {
          const { t, apis, selected } = props
          const [sources, setSources] = useState<Array<{ id: string; name: string; sourceType: string; parseStatus: string }>>([])
          const [queue, setQueue] = useState<Array<Record<string, unknown>>>([])
          const [sourceType, setSourceType] = useState('LEGACY_SYS')
          const [sourceName, setSourceName] = useState('')
          const [content, setContent] = useState('')
          const [busy, setBusy] = useState('')
          const [error, setError] = useState('')
          const [info, setInfo] = useState('')
          const [picked, setPicked] = useState<string[]>([])
          const api = apis.remote['ontoKnowledge']

          const packageId = selected ? selected.name : ''

          const reload = useCallback(async () => {
            if (!api || !packageId) return
            try {
              const s = unwrap<{ sources: Array<{ id: string; name: string; sourceType: string; parseStatus: string }> }>(
                await api.listSources({ packageId }),
              )
              setSources(s.sources)
              const q = unwrap<{ items: Array<Record<string, unknown>> }>(await api.listCandidates({ packageId }))
              setQueue(q.items)
            } catch (e) {
              setError(errText(e))
            }
          }, [apis, packageId])

          useEffect(() => {
            void reload()
          }, [reload])

          const act = async (label: string, fn: () => Promise<void>) => {
            setBusy(label)
            setError('')
            setInfo('')
            try {
              await fn()
              await reload()
            } catch (e) {
              setError(errText(e))
            } finally {
              setBusy('')
            }
          }

          return h(
            'div',
            { className: 'ow-card' },
            h('h3', { className: 'ow-h2' }, t('tabKnowledge')),
            error ? h('p', { className: 'ow-note', style: { color: '#b91c1c' } }, error) : null,
            info ? h('p', { className: 'ow-note', style: { color: '#166534' } }, info) : null,
            !selected ? h('p', { className: 'ow-note' }, t('none')) : null,
            h(
              Card,
              { title: t('upload') },
              h(
                Row,
                null,
                h('select', {
                  className: 'ow-sel',
                  value: sourceType,
                  onChange: (e: { target: { value: string } }) => setSourceType(e.target.value),
                }, ...['LEGACY_SYS', 'CASE_SAMPLE', 'POLICY', 'SCHEMA_API', 'WORK_ORDER'].map((k) => h('option', { key: k, value: k }, k))),
                h('input', { className: 'ow-in', placeholder: t('sourceName'), value: sourceName, onChange: (e: { target: { value: string } }) => setSourceName(e.target.value) }),
              ),
              h('textarea', {
                className: 'ow-textarea',
                placeholder: t('content'),
                value: content,
                onChange: (e: { target: { value: string } }) => setContent(e.target.value),
              }),
              h(
                'button',
                {
                  className: 'ow-btn',
                  disabled: !!busy || !sourceName.trim() || !content.trim() || !selected,
                  onClick: () =>
                    void act('upload', async () => {
                      unwrap(await api!.uploadSource({
                        packageId: selected!.name,
                        sourceType: sourceType as never,
                        name: sourceName.trim(),
                        content,
                      }))
                      setSourceName('')
                      setContent('')
                    }),
                },
                busy === 'upload' ? t('busy') : t('upload'),
              ),
            ),
            h(
              Card,
              { title: t('tabKnowledge') },
              h(
                'table',
                { className: 'ow-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('sourceName')), h('th', null, t('sourceType')), h('th', null, t('status')), h('th', null, t('actions'))),
                ),
                h(
                  'tbody',
                  null,
                  sources.length === 0
                    ? h('tr', null, h('td', { colSpan: 4 }, t('empty')))
                    : sources.map((s) =>
                        h(
                          'tr',
                          { key: s.id },
                          h('td', null, s.name),
                          h('td', null, s.sourceType),
                          h('td', null, s.parseStatus),
                          h(
                            'td',
                            null,
                            h('button', {
                              className: 'ow-btn ghost',
                              disabled: !!busy,
                              onClick: () =>
                                void act('parse', async () => {
                                  const r = unwrap<{ engine: string }>(await api!.parseSource({ sourceId: s.id }))
                                  setInfo(`${t('parse')}: engine=${r.engine}`)
                                }),
                            }, t('parse')),
                            ' ',
                            h('button', {
                              className: 'ow-btn ghost',
                              disabled: !!busy,
                              onClick: () =>
                                void act('parseApi', async () => {
                                  const r = unwrap<{ engine: string }>(await api!.parseSource({ sourceId: s.id, useApi: true }))
                                  setInfo(`${t('parseApi')}: engine=${r.engine}`)
                                }),
                            }, t('parseApi')),
                          ),
                        ),
                      ),
                ),
              ),
            ),
            h(
              Card,
              { title: t('queue') },
              h(
                'table',
                { className: 'ow-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('layer')), h('th', null, t('kind')), h('th', null, t('name')),
                  h('th', null, t('confidence')), h('th', null, t('status')), h('th', null, t('actions'))),
                ),
                h(
                  'tbody',
                  null,
                  queue.length === 0
                    ? h('tr', null, h('td', { colSpan: 6 }, t('empty')))
                    : queue.map((c) => {
                        const id = String(c['id'])
                        const status = String(c['status'])
                        return h(
                          'tr',
                          { key: id },
                          h('td', null, String(c['layer'])),
                          h('td', null, String(c['targetKind'])),
                          h('td', null, String(c['name']),
                            c['conclusionLike'] ? h(Tag, { text: t('conclusion'), tone: 'warn' }) : null,
                            c['forcedReview'] ? h(Tag, { text: t('forcedReview'), tone: 'warn' }) : null),
                          h('td', null, fmt(c['confidence'] as number, 2)),
                          h('td', null, status),
                          h(
                            'td',
                            null,
                            status === 'pending'
                              ? h('button', {
                                  className: 'ow-btn ghost',
                                  disabled: !!busy,
                                  onClick: () => void act('approve', async () => { unwrap(await api!.reviewCandidate({ id, action: 'approve' })) }),
                                }, t('approve'))
                              : null,
                            status === 'pending'
                              ? h('button', {
                                  className: 'ow-btn ghost',
                                  disabled: !!busy,
                                  onClick: () => void act('reject', async () => { unwrap(await api!.reviewCandidate({ id, action: 'reject' })) }),
                                }, t('reject'))
                              : null,
                            status === 'approved'
                              ? h('button', {
                                  className: 'ow-btn ghost',
                                  disabled: !!busy,
                                  onClick: () => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
                                }, picked.includes(id) ? '✓' : '+')
                              : null,
                          ),
                        )
                      }),
                ),
              ),
              h(
                'button',
                {
                  className: 'ow-btn',
                  disabled: !!busy || picked.length === 0 || !selected,
                  onClick: () =>
                    void act('materialize', async () => {
                      const r = unwrap<{ applied: string[]; skipped: Array<{ id: string; reason: string }> }>(
                        await api!.materialize({ name: selected!.name, version: selected!.version, ids: picked }),
                      )
                      setPicked([])
                      if (r.skipped.length > 0) setError(r.skipped.map((s) => `${s.id}: ${s.reason}`).join('; '))
                    }),
                },
                busy === 'materialize' ? t('busy') : `${t('materialize')} (${picked.length})`,
              ),
            ),
          )
        }

        /* ═══════════════════════════════════════════════════════════════
         * 校验派生
         * ═══════════════════════════════════════════════════════════════ */

        function ValidatePanel(props: {
          t: (k: string) => string
          apis: Ctx
          selected: { name: string; version: string } | null
        }) {
          const { t, apis, selected } = props
          const [report, setReport] = useState<Record<string, unknown> | null>(null)
          const [gate, setGate] = useState<Record<string, unknown> | null>(null)
          const [deriveInfo, setDeriveInfo] = useState('')
          const [busy, setBusy] = useState('')
          const [error, setError] = useState('')

          const act = async (label: string, fn: () => Promise<void>) => {
            setBusy(label)
            setError('')
            try {
              await fn()
            } catch (e) {
              setError(errText(e))
            } finally {
              setBusy('')
            }
          }

          if (!selected) return h('div', { className: 'ow-card' }, h('p', { className: 'ow-note' }, t('none')))
          const vApi = apis.remote['ontoValidate']
          const dApi = apis.remote['ontoDerive']
          const r = report as { score?: number; passed?: boolean; errors?: Array<Record<string, string>>; warnings?: Array<Record<string, string>>; info?: Array<Record<string, string>> } | null

          return h(
            'div',
            { className: 'ow-card' },
            h('h3', { className: 'ow-h2' }, t('tabValidate')),
            error ? h('p', { className: 'ow-note', style: { color: '#b91c1c' } }, error) : null,
            h(
              'div',
              { className: 'ow-row' },
              h(
                'button',
                {
                  className: 'ow-btn',
                  disabled: !!busy,
                  onClick: () =>
                    void act('validate', async () => {
                      const out = unwrap<{ report: Record<string, unknown> }>(await vApi!.validate({ name: selected.name, version: selected.version }))
                      setReport(out.report)
                    }),
                },
                busy === 'validate' ? t('busy') : t('validateBtn'),
              ),
              h(
                'button',
                {
                  className: 'ow-btn',
                  disabled: !!busy,
                  onClick: () =>
                    void act('derive', async () => {
                      const out = unwrap<{ sources: number; derived: number; sourceDigest: string }>(
                        await dApi!.derive({ name: selected.name, version: selected.version }),
                      )
                      setDeriveInfo(`sources=${out.sources} derived=${out.derived} digest=${out.sourceDigest.slice(0, 12)}…`)
                    }),
                },
                busy === 'derive' ? t('busy') : t('deriveBtn'),
              ),
              h(
                'button',
                {
                  className: 'ow-btn ghost',
                  disabled: !!busy,
                  onClick: () =>
                    void act('gate', async () => {
                      const out = unwrap<Record<string, unknown>>(await dApi!.gate({ name: selected.name, version: selected.version }))
                      setGate(out)
                    }),
                },
                busy === 'gate' ? t('busy') : t('gateBtn'),
              ),
            ),
            deriveInfo ? h('p', { className: 'ow-note' }, deriveInfo) : null,
            gate
              ? h(
                  'p',
                  { className: 'ow-note' },
                  (gate['ok'] ? t('gateOk') : `${t('drift')}: ${String(gate['reason'] ?? '')}`),
                )
              : null,
            r
              ? h(
                  'div',
                  null,
                  h(
                    'div',
                    { className: 'ow-row' },
                    h(Tag, { text: `${t('score')} ${String(r.score ?? '')}`, tone: r.passed ? 'ok' : 'err' }),
                    h('span', { className: 'ow-stat' }, `${t('errors')} ${r.errors?.length ?? 0}`),
                    h('span', { className: 'ow-stat' }, `${t('warnings')} ${r.warnings?.length ?? 0}`),
                  ),
                  ...(['errors', 'warnings', 'info'] as const).map((level) =>
                    h(
                      'div',
                      { key: level },
                      h('div', { className: 'ow-label' }, t(level)),
                      h(
                        'table',
                        { className: 'ow-table' },
                        h(
                          'tbody',
                          null,
                          ...((r[level] ?? []) as Array<Record<string, string>>).map((issue, i: number) =>
                            h(
                              'tr',
                              { key: i },
                              h('td', null, h(Tag, { text: issue['code'] ?? '', tone: level === 'errors' ? 'err' : level === 'warnings' ? 'warn' : undefined })),
                              h('td', { className: 'ow-mono' }, `${issue['where'] ?? ''} ${issue['message'] ?? ''}`),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                )
              : null,
          )
        }

        /* ═══════════════════════════════════════════════════════════════
         * 场景运行
         * ═══════════════════════════════════════════════════════════════ */

        function RunPanel(props: {
          t: (k: string) => string
          apis: Ctx
          selected: { name: string; version: string } | null
        }) {
          const { t, apis, selected } = props
          const [scenarios, setScenarios] = useState<Array<{ id: string; name: string; goal: string }>>([])
          const [scenarioId, setScenarioId] = useState('')
          const [datasetText, setDatasetText] = useState('{\n  "objects": [],\n  "relations": [],\n  "behaviors": [],\n  "candidates": []\n}')
          const [result, setResult] = useState<Record<string, unknown> | null>(null)
          const [busy, setBusy] = useState('')
          const [error, setError] = useState('')
          const api = apis.remote['ontoRuntime']

          useEffect(() => {
            if (!api || !selected) return
            void (async () => {
              try {
                const out = unwrap<{ scenarios: Array<{ id: string; name: string; goal: string }> }>(
                  await api.listScenarios({ name: selected.name, version: selected.version }),
                )
                setScenarios(out.scenarios)
                if (out.scenarios.length > 0) setScenarioId((s) => s || out.scenarios[0].id)
              } catch (e) {
                setError(errText(e))
              }
            })()
          }, [apis, selected])

          if (!selected) return h('div', { className: 'ow-card' }, h('p', { className: 'ow-note' }, t('none')))
          const res = result as {
            humanReviewRequired?: boolean
            reviewGate?: { threshold: number; requireReviewFor: string[] }
            candidates?: Array<{
              candidateId: string
              riskScore: number
              hitRuleIds: string[]
              evidenceChains: Array<{ ruleId: string; score: number; evidence: string }>
              narrative: string[]
              pendingChecks: Array<{ note: string }>
              pendingVerification: boolean
            }>
            excluded?: Array<{ candidateId: string; ruleId: string }>
            audit?: {
              checks: Array<{ check: string; closed: boolean; detail: string }>
              forbiddenPhraseHits: Array<{ phrase: string; where: string }>
              passed: boolean
            }
          } | null

          return h(
            'div',
            { className: 'ow-card' },
            h('h3', { className: 'ow-h2' }, t('tabRun')),
            error ? h('p', { className: 'ow-note', style: { color: '#b91c1c' } }, error) : null,
            h(
              Row,
              { label: t('scenario') },
              h('select', {
                className: 'ow-sel',
                value: scenarioId,
                onChange: (e: { target: { value: string } }) => setScenarioId(e.target.value),
              }, ...scenarios.map((s) => h('option', { key: s.id, value: s.id }, `${s.name} (${s.id})`))),
              h(
                'button',
                {
                  className: 'ow-btn',
                  disabled: !!busy || !scenarioId,
                  onClick: () =>
                    void (async () => {
                      setBusy('run')
                      setError('')
                      try {
                        const dataset = JSON.parse(datasetText) as unknown
                        const out = unwrap<{ result: Record<string, unknown> }>(
                          await api!.runScenario({ name: selected.name, version: selected.version, scenarioId, dataset }),
                        )
                        setResult(out.result)
                      } catch (e) {
                        setError(errText(e))
                      } finally {
                        setBusy('')
                      }
                    })(),
                },
                busy === 'run' ? t('busy') : t('runBtn'),
              ),
            ),
            h('div', { className: 'ow-label' }, t('dataset')),
            h('textarea', {
              className: 'ow-textarea',
              style: { minHeight: 140 },
              value: datasetText,
              onChange: (e: { target: { value: string } }) => setDatasetText(e.target.value),
            }),
            res
              ? h(
                  'div',
                  { className: 'ow-card' },
                  h(
                    'div',
                    { className: 'ow-row' },
                    h(Tag, { text: t('humanReview'), tone: 'warn' }),
                    h(Tag, {
                      text: `${t('audit')}: ${res.audit?.passed ? t('passed') : t('failed')}`,
                      tone: res.audit?.passed ? 'ok' : 'err',
                    }),
                    h(Tag, {
                      text: `${t('forbidden')}: ${res.audit?.forbiddenPhraseHits?.length ?? 0}`,
                      tone: (res.audit?.forbiddenPhraseHits?.length ?? 0) === 0 ? 'ok' : 'err',
                    }),
                    h('span', { className: 'ow-stat' }, `review≤${String(res.reviewGate?.threshold ?? '')}: ${(res.reviewGate?.requireReviewFor ?? []).join(', ') || '—'}`),
                  ),
                  h(
                    'table',
                    { className: 'ow-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, 'ID'), h('th', null, t('riskScore')), h('th', null, t('hits')),
                      h('th', null, t('evidenceChains')), h('th', null, t('pending')), h('th', null, t('narrative'))),
                    ),
                    h(
                      'tbody',
                      null,
                      ...(res.candidates ?? []).map((c) =>
                        h(
                          'tr',
                          { key: c.candidateId },
                          h('td', null, c.candidateId),
                          h('td', null, h(Tag, { text: fmt(c.riskScore), tone: c.riskScore >= 0.75 ? 'err' : undefined })),
                          h('td', { className: 'ow-mono' }, (c.hitRuleIds ?? []).join('\n') || '—'),
                          h('td', { className: 'ow-mono' }, (c.evidenceChains ?? []).map((e) => `${e.ruleId}: ${e.evidence}`).join('\n') || '—'),
                          h('td', { className: 'ow-mono' }, (c.pendingChecks ?? []).map((p) => p.note).join('\n') || '—'),
                          h('td', { className: 'ow-mono' }, (c.narrative ?? []).join('\n')),
                        ),
                      ),
                    ),
                  ),
                  (res.excluded ?? []).length > 0
                    ? h('p', { className: 'ow-note' }, `${t('excluded')}: ${(res.excluded ?? []).map((x) => `${cand(x)}←${x.ruleId}`).join(', ')}`)
                    : null,
                  h(
                    'table',
                    { className: 'ow-table' },
                    h('thead', null, h('tr', null, h('th', null, t('audit')), h('th', null, t('status')), h('th', null, t('info')))),
                    h(
                      'tbody',
                      null,
                      ...(res.audit?.checks ?? []).map((a) =>
                        h(
                          'tr',
                          { key: a.check },
                          h('td', null, a.check),
                          h('td', null, h(Tag, { text: a.closed ? t('passed') : t('failed'), tone: a.closed ? 'ok' : 'err' })),
                          h('td', { className: 'ow-mono' }, a.detail),
                        ),
                      ),
                    ),
                  ),
                )
              : null,
          )

          function cand(x: { candidateId: string }): string {
            return x.candidateId
          }
        }

        /* ═══════════════════════════════════════════════════════════════
         * 根组件：tabs + 选中包状态
         * ═══════════════════════════════════════════════════════════════ */

        function AppRoot(props: { t: (k: string) => string; ctx: Ctx }) {
          const { t, ctx: apis } = props
          const [tab, setTab] = useState('packages')
          const [versions, setVersions] = useState<VersionRow[]>([])
          const [selected, setSelected] = useState<{ name: string; version: string } | null>(null)
          const [listError, setListError] = useState('')

          const reload = useCallback(async () => {
            const api = apis.remote['ontoWorkspace']
            if (!api) {
              setListError('remote.ontoWorkspace missing')
              return
            }
            try {
              const raw = await api.listVersions()
              const out = unwrap<VersionRow[]>(raw)
              setVersions(Array.isArray(out) ? out : [])
              setListError(Array.isArray(out) ? '' : `unexpected listVersions payload: ${errText(raw).slice(0, 160)}`)
            } catch (e) {
              setVersions([])
              setListError(errText(e))
            }
          }, [apis])

          useEffect(() => {
            void reload()
          }, [reload])

          const tabs: Array<[string, string]> = [
            ['packages', t('tabPackages')],
            ['model', t('tabModel')],
            ['knowledge', t('tabKnowledge')],
            ['validate', t('tabValidate')],
            ['run', t('tabRun')],
          ]

          return h(
            'div',
            { className: 'ow-wrap' },
            h(
              'div',
              { className: 'ow-head' },
              h('h2', { className: 'ow-h1' }, t('title')),
              h('span', { className: 'ow-sub' }, t('subtitle')),
              selected
                ? h('span', { className: 'ow-stat' }, `${t('selected')}: ${selected.name}@${selected.version}`)
                : h('span', { className: 'ow-stat' }, t('none')),
            ),
            h(
              'div',
              { className: 'ow-tabs' },
              ...tabs.map(([key, label]) =>
                h(
                  'button',
                  {
                    key,
                    className: tab === key ? 'ow-tab on' : 'ow-tab',
                    onClick: () => setTab(key),
                  },
                  label,
                ),
              ),
            ),
            listError
              ? h('p', { className: 'ow-note', style: { color: '#b91c1c' } }, `包列表：${listError}`)
              : null,
            tab === 'packages'
              ? h(PackagesPanel, { t, apis, versions, reload, selected, setSelected })
              : tab === 'model'
                ? h(ModelPanel, { t, apis, selected })
                : tab === 'knowledge'
                  ? h(KnowledgePanel, { t, apis, selected })
                  : tab === 'validate'
                    ? h(ValidatePanel, { t, apis, selected })
                    : h(RunPanel, { t, apis, selected }),
          )
        }

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, Workbench),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 1, locale: NS, label: () => t('panel') },
            PanelIcon,
          ),
        )
      },
    }
  },
})
