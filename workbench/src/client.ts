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
      yamlImport: 'YAML 导入',
      yamlPath: '文件路径（如 o1-objects/object-types.yaml）',
      yamlWrite: '写入源文件',
      weight: '权重',
      expression: '表达式',
      threshold: '阈值',
      evidence: '证据模板',
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
      empty: '暂无数据',
      loading: '加载中…',
      edit: '编辑',
      delete: '删除',
      cancel: '取消',
      confirmDelete: '确认删除该元素？（引用闭合由校验器把关）',
      addElement: '新增元素',
      from: '起点对象',
      to: '终点对象',
      anchor: '锚点对象',
      goal: '目标',
      boundary: '边界',
      pipeline: '编排步骤',
      pipelineViz: 'Pipeline（只读）',
      outputs: '输出字段',
      inputs: '输入（JSON 数组）',
      mustInclude: '契约必含',
      forbiddenList: '禁语红线',
      reviewGate: '复核门禁',
      reviewRequired: '需复核',
      auditChecks: '审计项',
      attrs: '属性（每行 name:type，可带 :扩展JSON 无损往返）',
      idRule: 'ID 规则',
      lifecycle: '生命周期（每行）',
      condition: '条件表达式',
      ruleAction: '动作',
      factor: '系数',
      trigger: '触发',
      states: '状态（每行）',
      behaviorRelations: '关系类型（每行 REL ID）',
      yamlNewHint: '选择已有文件或输入新路径即可新建',
      batchUpload: '批量上传',
      pickFiles: '选择文件（可多选，按当前原料类型提交）',
      editDraft: '编辑草案',
      payloadJson: '草案载荷（JSON，可改 name/payload/rationale/confidence）',
      saveDraft: '保存草案',
      preview: '预览物化',
      previewTitle: '物化预览（干跑，不落盘）',
      merge: '标记并入',
      mergeInto: '归并到已有元素（仅记账，不写包）',
      elementName: '元素名',
      parseReport: '解析报告',
      received: '收到',
      accepted: '接受',
      idemSkip: '幂等跳过',
      invalidDrop: '非法丢弃',
      engine: '引擎',
      runHistory: '运行历史',
      emptyPipeline: '（空 pipeline）',
      errFinite: '须为有限数字',
      errIdName: 'id / name 必填',
      errDuplicateId: '重复 id',
      errInvalidJson: 'JSON 非法',
      errPatchShape: '草案 JSON 必须是对象',
      errMustBeArray: '须为 JSON 数组',
      errAttrExtra: '属性扩展 JSON 非法',
      issuedReadonly: 'ISSUED 只读',
      illegalRelPath: '非法相对路径（禁 ..、反斜杠、绝对路径）',
      mergeFallback: '模型加载失败，merge 目标改为手输',
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
      yamlImport: 'YAML import',
      yamlPath: 'File path (e.g. o1-objects/object-types.yaml)',
      yamlWrite: 'Write source file',
      weight: 'Weight',
      expression: 'Expression',
      threshold: 'Threshold',
      evidence: 'Evidence template',
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
      empty: 'No data',
      loading: 'Loading…',
      edit: 'Edit',
      delete: 'Delete',
      cancel: 'Cancel',
      confirmDelete: 'Delete this element? (reference closure is enforced by the validator)',
      addElement: 'New element',
      from: 'From object',
      to: 'To object',
      anchor: 'Anchor object',
      goal: 'Goal',
      boundary: 'Boundary',
      pipeline: 'Pipeline',
      pipelineViz: 'Pipeline (read-only)',
      outputs: 'Output fields',
      inputs: 'Inputs (JSON array)',
      mustInclude: 'Must include',
      forbiddenList: 'Forbidden phrases',
      reviewGate: 'Review gate',
      reviewRequired: 'Required',
      auditChecks: 'Audit checks',
      attrs: 'Attributes (name:type[:extraJson] per line, lossless)',
      idRule: 'ID rule',
      lifecycle: 'Lifecycle (one per line)',
      condition: 'Condition expression',
      ruleAction: 'Action',
      factor: 'Factor',
      trigger: 'Trigger',
      states: 'States (one per line)',
      behaviorRelations: 'Relation types (REL ID per line)',
      yamlNewHint: 'Pick an existing file or type a new path to create one',
      batchUpload: 'Batch upload',
      pickFiles: 'Pick files (multiple; uploaded under the current source type)',
      editDraft: 'Edit draft',
      payloadJson: 'Draft payload (JSON: name/payload/rationale/confidence)',
      saveDraft: 'Save draft',
      preview: 'Preview materialize',
      previewTitle: 'Materialize preview (dry-run, no writes)',
      merge: 'Mark merged',
      mergeInto: 'Into existing element (record-only, no write)',
      elementName: 'Element name',
      parseReport: 'Parse report',
      received: 'Received',
      accepted: 'Accepted',
      idemSkip: 'Idempotent skips',
      invalidDrop: 'Invalid dropped',
      engine: 'Engine',
      runHistory: 'Run history',
      emptyPipeline: '(empty pipeline)',
      errFinite: 'must be a finite number',
      errIdName: 'id / name required',
      errDuplicateId: 'duplicate id',
      errInvalidJson: 'invalid JSON',
      errPatchShape: 'draft JSON must be an object',
      errMustBeArray: 'must be a JSON array',
      errAttrExtra: 'bad attribute extra JSON',
      issuedReadonly: 'ISSUED read-only',
      illegalRelPath: 'illegal relPath (no .., backslash, or absolute path)',
      mergeFallback: 'model load failed; merge target falls back to free input',
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
      '.ow-err{margin:0;padding:8px 12px;border-radius:8px;background:#fee2e2;color:#b91c1c;font-size:12.5px;white-space:pre-wrap;word-break:break-word;}',
      '.ow-ok{margin:0;padding:8px 12px;border-radius:8px;background:#dcfce7;color:#166534;font-size:12.5px;white-space:pre-wrap;word-break:break-word;}',
      '.ow-loading{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.ow-loading::before{content:"";width:10px;height:10px;border:2px solid currentColor;border-top-color:transparent;border-radius:50%;animation:ow-spin .8s linear infinite;}',
      '@keyframes ow-spin{to{transform:rotate(360deg);}}',
      '.ow-form{display:flex;flex-direction:column;gap:8px;padding:10px;border:1px dashed var(--dsw-alias-line,#d1d5db);border-radius:8px;background:var(--dsw-alias-fill,#f8fafc);}',
      '.ow-form .ow-row{align-items:flex-start;}',
      '.ow-form label{font-size:12px;color:var(--dsw-alias-label-secondary,#6b7280);min-width:88px;flex-shrink:0;padding-top:7px;}',
      '.ow-pipe{display:flex;flex-direction:column;gap:4px;margin:0;padding:0;list-style:none;counter-reset:pipe;}',
      '.ow-pipe li{display:flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--dsw-alias-line,#e5e7eb);border-radius:8px;font-size:12.5px;background:transparent;}',
      '.ow-pipe li::before{counter-increment:pipe;content:counter(pipe);display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-fill,#eef2ff);font-size:11px;flex-shrink:0;}',
      '.ow-pipe .ow-mono{flex:1;}',
      '.ow-diff{border:1px solid var(--dsw-alias-line,#e5e7eb);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-fill,#f8fafc);}',
      '.ow-diff pre{margin:6px 0 0;}',
      '.ow-actions{display:flex;gap:4px;flex-wrap:wrap;}',
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

    /** 统一错误条：所有面板的错误一律走这里，可见不吞。 */
    function ErrorBanner(props: { text: string }) {
      if (!props.text) return null
      return h('p', { className: 'ow-err', role: 'alert' }, props.text)
    }

    /** 统一成功/信息条。 */
    function OkBanner(props: { text: string }) {
      if (!props.text) return null
      return h('p', { className: 'ow-ok' }, props.text)
    }

    /** 统一加载态。 */
    function Loading(props: { text: string }) {
      if (!props.text) return null
      return h('span', { className: 'ow-loading' }, props.text)
    }

    /** 表单行：label + 控件。 */
    function Field(props: { label: string; children?: ReactNode }) {
      return h(
        'div',
        { className: 'ow-row' },
        h('label', null, props.label),
        props.children,
      )
    }

    /** 场景 pipeline 只读可视化：步骤列表展示 stepType/order/skillRefs。 */
    function PipelineView(props: {
      steps: Array<{ stepId?: string; stepType?: string; order?: string; skillRefs?: string[]; label?: string }>
      emptyText: string
    }) {
      const steps = props.steps ?? []
      if (steps.length === 0) return h('p', { className: 'ow-note' }, props.emptyText)
      return h(
        'ol',
        { className: 'ow-pipe' },
        ...steps.map((s, i) =>
          h(
            'li',
            { key: s.stepId ?? i },
            h('span', { className: 'ow-mono' }, `${s.stepId ?? `s${i + 1}`}`),
            h(Tag, { text: s.stepType ?? '?' }),
            s.order ? h(Tag, { text: s.order, tone: 'warn' }) : null,
            ...(s.skillRefs ?? []).map((r) => h(Tag, { key: r, text: r, tone: 'ok' })),
            s.label ? h('span', { className: 'ow-note' }, s.label) : null,
          ),
        ),
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
        h(ErrorBanner, { text: error }),
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
         * 建模 —— 元素表格 + 编辑/删除 + YAML 通道 + pipeline 可视化
         * ═══════════════════════════════════════════════════════════════ */

        type ElemKind =
          | 'objects'
          | 'relations'
          | 'behaviors'
          | 'scoreRules'
          | 'exclusionRules'
          | 'scenarios'

        const ELEM_LABEL: Record<ElemKind, string> = {
          objects: 'objects',
          relations: 'relations',
          behaviors: 'behaviors',
          scoreRules: 'scoreRules',
          exclusionRules: 'exclusionRules',
          scenarios: 'scenarios',
        }

        /** 元素编辑状态：idx = -1 表示新增。data 全部为字符串原始值。 */
        interface ElemEdit {
          kind: ElemKind
          idx: number
          data: Record<string, string>
        }

        function lines(v: string): string[] {
          return v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
        }

        function csv(v: string): string[] {
          return v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
        }

        /**
         * 属性 ↔ 行文本：`name:type` 或 `name:type:{扩展 JSON}`。
         * 扩展字段（enumValuesRef/refObject/required/description 等）无损往返，编辑保存不丢字段。
         * name/type 段转义 `\ : 换行`，含这些字符的属性名也能无损往返。
         */
        function escapeAttrSeg(s: string): string {
          return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/\r/g, '\\r').replace(/\n/g, '\\n')
        }

        function unescapeAttrSeg(s: string): string {
          return s.replace(/\\([:\\rn])/g, (_, c: string) => (c === 'n' ? '\n' : c === 'r' ? '\r' : c))
        }

        /** 找第一个未转义的 sep 位置（\x 成对跳过）。 */
        function splitUnescaped(s: string, sep = ':'): number {
          for (let i = 0; i < s.length; i++) {
            if (s[i] === '\\') {
              i++
              continue
            }
            if (s[i] === sep) return i
          }
          return -1
        }

        function attrsToLines(attrs: unknown): string {
          return ((attrs as Array<Record<string, unknown>>) ?? [])
            .map((a) => {
              const rec = { ...(a as Record<string, unknown>) }
              const name = escapeAttrSeg(String(rec['name'] ?? ''))
              const type = escapeAttrSeg(String(rec['type'] ?? 'string'))
              delete rec['name']
              delete rec['type']
              return Object.keys(rec).length > 0 ? `${name}:${type}:${JSON.stringify(rec)}` : `${name}:${type}`
            })
            .join('\n')
        }

        function linesToAttrs(raw: string): Array<Record<string, unknown>> {
          return lines(raw).map((line) => {
            const i = splitUnescaped(line)
            if (i < 0) return { name: unescapeAttrSeg(line.trim()), type: 'string' }
            const name = unescapeAttrSeg(line.slice(0, i).trim())
            const rest = line.slice(i + 1)
            const j = splitUnescaped(rest)
            if (j < 0) return { name, type: unescapeAttrSeg(rest.trim()) || 'string' }
            const type = unescapeAttrSeg(rest.slice(0, j).trim()) || 'string'
            let extra: unknown
            try {
              extra = JSON.parse(rest.slice(j + 1))
            } catch {
              throw new Error(`${t('errAttrExtra')}: ${line.slice(0, 60)}`)
            }
            if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
              throw new Error(`${t('errAttrExtra')}: ${line.slice(0, 60)}`)
            }
            const fields: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(extra as Record<string, unknown>)) {
              if (k !== 'name' && k !== 'type') fields[k] = v
            }
            return { name, type, ...fields }
          })
        }

        /** 元素 → 表单字符串。 */
        function toFormData(kind: ElemKind, el: Record<string, unknown>): Record<string, string> {
          const d: Record<string, string> = {
            id: String(el['id'] ?? ''),
            name: String(el['name'] ?? ''),
          }
          if (kind === 'objects') {
            d['idRule'] = String(el['idRule'] ?? '')
            d['attributes'] = attrsToLines(el['attributes'])
            d['lifecycle'] = ((el['lifecycle'] as string[]) ?? []).join('\n')
            d['description'] = String(el['description'] ?? '')
          } else if (kind === 'relations') {
            d['from'] = String(el['from'] ?? '')
            d['to'] = String(el['to'] ?? '')
            d['attributes'] = attrsToLines(el['attributes'])
            d['description'] = String(el['description'] ?? '')
          } else if (kind === 'behaviors') {
            d['anchor'] = String(el['anchor'] ?? '')
            d['relations'] = ((el['relations'] as string[]) ?? []).join('\n')
            d['states'] = ((el['states'] as string[]) ?? []).join('\n')
            d['trigger'] = String(el['trigger'] ?? '')
            d['description'] = String(el['description'] ?? '')
          } else if (kind === 'scoreRules') {
            d['weight'] = String(el['weight'] ?? 0)
            d['expression'] = String(el['expression'] ?? '')
            d['threshold'] = el['threshold'] === undefined || el['threshold'] === null ? '' : String(el['threshold'])
            d['evidenceTemplate'] = String(el['evidenceTemplate'] ?? '')
            d['description'] = String(el['description'] ?? '')
          } else if (kind === 'exclusionRules') {
            d['action'] = String(el['action'] ?? 'drop')
            d['factor'] = el['factor'] === undefined || el['factor'] === null ? '' : String(el['factor'])
            d['condition'] = String(el['condition'] ?? '')
            d['description'] = String(el['description'] ?? '')
          } else if (kind === 'scenarios') {
            d['goal'] = String(el['goal'] ?? '')
            d['boundary'] = String(el['boundary'] ?? '')
            d['inputs'] = JSON.stringify(el['inputs'] ?? [], null, 2)
            d['outputs'] = ((el['outputs'] as { fields?: string[] })?.fields ?? []).join('\n')
            d['pipeline'] = JSON.stringify(el['pipeline'] ?? [], null, 2)
            const oc = (el['outputContract'] ?? {}) as { mustInclude?: string[]; forbiddenPhrases?: string[] }
            d['mustInclude'] = (oc.mustInclude ?? []).join('\n')
            d['forbiddenPhrases'] = (oc.forbiddenPhrases ?? []).join('\n')
            const rg = (el['reviewGate'] ?? {}) as { required?: boolean; threshold?: number }
            d['reviewRequired'] = rg.required === false ? 'no' : 'yes'
            d['reviewThreshold'] = String(rg.threshold ?? 0.75)
            d['auditChecks'] = ((el['auditChecks'] as string[]) ?? []).join('\n')
          }
          return d
        }

        /** 解析非空有限数字；非法返回 null（调用方报错拒绝保存）。 */
        function numOrNull(raw: string | undefined): number | null {
          if (raw === undefined || raw.trim() === '') return null
          const n = Number(raw)
          return Number.isFinite(n) ? n : null
        }

        function parseJsonField(raw: string, fallback: string): unknown {
          try {
            return JSON.parse(raw || fallback)
          } catch {
            throw new Error(`${t('errInvalidJson')}: ${raw.slice(0, 80)}`)
          }
        }

        /** 表单字符串 → 元素对象；校验失败 throw，由 doSaveEdit 展示。 */
        function fromFormData(kind: ElemKind, d: Record<string, string>): Record<string, unknown> {
          const el: Record<string, unknown> = { id: d['id']?.trim(), name: d['name']?.trim() }
          if (kind === 'objects') {
            if (d['idRule']?.trim()) el['idRule'] = d['idRule'].trim()
            el['attributes'] = linesToAttrs(d['attributes'] ?? '')
            if (lines(d['lifecycle'] ?? '').length > 0) el['lifecycle'] = lines(d['lifecycle'])
            if (d['description']?.trim()) el['description'] = d['description'].trim()
          } else if (kind === 'relations') {
            el['from'] = d['from']?.trim() ?? ''
            el['to'] = d['to']?.trim() ?? ''
            const relAttrs = linesToAttrs(d['attributes'] ?? '')
            if (relAttrs.length > 0) el['attributes'] = relAttrs
            if (d['description']?.trim()) el['description'] = d['description'].trim()
          } else if (kind === 'behaviors') {
            el['anchor'] = d['anchor']?.trim() ?? ''
            if (lines(d['relations'] ?? '').length) el['relations'] = lines(d['relations'])
            if (lines(d['states'] ?? '').length) el['states'] = lines(d['states'])
            if (d['trigger']?.trim()) el['trigger'] = d['trigger'].trim()
            if (d['description']?.trim()) el['description'] = d['description'].trim()
          } else if (kind === 'scoreRules') {
            const weight = numOrNull(d['weight'])
            if (weight === null) throw new Error(`${t('weight')} ${t('errFinite')}`)
            el['weight'] = weight
            el['expression'] = d['expression'] ?? ''
            if (d['threshold'] !== '' && d['threshold'] !== undefined) {
              const th = numOrNull(d['threshold'])
              if (th === null) throw new Error(`${t('threshold')} ${t('errFinite')}`)
              el['threshold'] = th
            }
            if (d['evidenceTemplate']?.trim()) el['evidenceTemplate'] = d['evidenceTemplate'].trim()
            if (d['description']?.trim()) el['description'] = d['description'].trim()
          } else if (kind === 'exclusionRules') {
            el['action'] = d['action'] === 'downweight' ? 'downweight' : 'drop'
            if (d['factor'] !== '' && d['factor'] !== undefined) {
              const f = numOrNull(d['factor'])
              if (f === null) throw new Error(`${t('factor')} ${t('errFinite')}`)
              el['factor'] = f
            }
            el['condition'] = d['condition'] ?? ''
            if (d['description']?.trim()) el['description'] = d['description'].trim()
          } else if (kind === 'scenarios') {
            el['goal'] = d['goal'] ?? ''
            el['boundary'] = d['boundary'] ?? ''
            const inputs = parseJsonField(d['inputs'] ?? '', '[]')
            if (!Array.isArray(inputs)) throw new Error(`${t('inputs')} ${t('errMustBeArray')}`)
            el['inputs'] = inputs
            el['outputs'] = { fields: csv(d['outputs'] ?? '') }
            const pipeline = parseJsonField(d['pipeline'] ?? '', '[]')
            if (!Array.isArray(pipeline)) throw new Error(`${t('pipeline')} ${t('errMustBeArray')}`)
            el['pipeline'] = pipeline
            el['outputContract'] = {
              mustInclude: lines(d['mustInclude'] ?? ''),
              forbiddenPhrases: lines(d['forbiddenPhrases'] ?? ''),
            }
            let th = 0.75
            const thrRaw = d['reviewThreshold']
            if (thrRaw !== undefined && thrRaw.trim() !== '') {
              const thr = numOrNull(thrRaw)
              if (thr === null) throw new Error(`${t('reviewGate')} ${t('errFinite')}`)
              th = thr
            }
            el['reviewGate'] = {
              required: d['reviewRequired'] !== 'no',
              threshold: th,
            }
            el['auditChecks'] = lines(d['auditChecks'] ?? '')
          }
          return el
        }

        /** 收集全包已用 ID（跨类查重：score/exclusion 共用 RULE 前缀；含全部集合，防与 SKL/FM 等撞车）。 */
        function collectAllIds(model: Record<string, Array<Record<string, unknown>>>): Set<string> {
          const taken = new Set<string>()
          for (const kind of ['objects', 'relations', 'dictionaries', 'behaviors', 'scoreRules', 'exclusionRules', 'skillTemplates', 'scenarios', 'fieldMaps', 'apiSources']) {
            for (const e of model[kind] ?? []) {
              const id = String(e['id'] ?? '')
              if (id) taken.add(id)
            }
          }
          return taken
        }

        function emptyFormData(kind: ElemKind, taken: Set<string>): Record<string, string> {
          const prefix = {
            objects: 'OBJ', relations: 'REL', behaviors: 'BHV',
            scoreRules: 'RULE', exclusionRules: 'RULE', scenarios: 'SCN',
          }[kind]
          let n = 1
          while (taken.has(`${prefix}-GEN-${n}`)) n++
          const base: Record<string, string> = { id: `${prefix}-GEN-${n}`, name: '' }
          if (kind === 'objects') return { ...base, idRule: '', attributes: '', lifecycle: '', description: '' }
          if (kind === 'relations') return { ...base, from: '', to: '', attributes: '', description: '' }
          if (kind === 'behaviors') return { ...base, anchor: '', relations: '', states: '', trigger: '', description: '' }
          if (kind === 'scoreRules') return { ...base, weight: '0.25', expression: 'min(1, f1)', threshold: '0.5', evidenceTemplate: '', description: '' }
          if (kind === 'exclusionRules') return { ...base, action: 'drop', factor: '', condition: "tag == 'unknown'", description: '' }
          return {
            ...base,
            goal: '', boundary: '',
            inputs: '[]',
            outputs: 'candidateId,riskScore,hitRuleIds,evidenceChains,pendingChecks',
            pipeline: JSON.stringify([
              { stepId: 's1', stepType: 'DATA_INGEST' },
              { stepId: 's2', stepType: 'BEHAVIOR_CALL' },
              { stepId: 's3', stepType: 'RULE_EVALUATE', order: 'before-scoring' },
              { stepId: 's4', stepType: 'RULE_EVALUATE' },
              { stepId: 's5', stepType: 'AUDIT_CHECK' },
              { stepId: 's6', stepType: 'HUMAN_REVIEW' },
            ], null, 2),
            mustInclude: 'candidateList,riskScore,evidenceChains,pendingChecks',
            forbiddenPhrases: '',
            reviewRequired: 'yes',
            reviewThreshold: '0.75',
            auditChecks: 'O1_CLOSED\nO2_CLOSED\nO3_CLOSED',
          }
        }

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
          const [busy, setBusy] = useState('')
          const [error, setError] = useState('')
          const [info, setInfo] = useState('')
          const [edit, setEdit] = useState<ElemEdit | null>(null)
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

          const savePkg = async (mutate: (p: Record<string, unknown>) => void, label: string): Promise<boolean> => {
            if (!api || !selected || !pkg) return false
            setBusy(label)
            setError('')
            setInfo('')
            try {
              const next = JSON.parse(JSON.stringify(pkg)) as Record<string, unknown>
              mutate(next)
              unwrap(await api.save({ name: selected.name, version: selected.version, pkg: next }))
              await reload()
              setInfo(`✓ ${label}`)
              return true
            } catch (e) {
              setError(errText(e))
              return false
            } finally {
              setBusy('')
            }
          }

          if (!selected) return h('div', { className: 'ow-card' }, h('p', { className: 'ow-note' }, t('none')))
          const model = (pkg ?? {}) as Record<string, Array<Record<string, unknown>>>
          const pkgStatus = String((pkg as { meta?: { status?: string } } | null)?.meta?.status ?? '')
          const readOnly = pkgStatus === 'ISSUED'
          // 与服务端 writeSource 同一守卫口径：..、绝对路径、反斜杠
          const badRelPath = yamlPath.includes('..') || yamlPath.startsWith('/') || yamlPath.includes('\\')

          const objIds = (model['objects'] ?? []).map((o) => String(o['id']))

          const startAdd = (kind: ElemKind) => {
            if (readOnly) return
            setEdit({ kind, idx: -1, data: emptyFormData(kind, collectAllIds(model)) })
            setInfo('')
            setError('')
          }

          const startEdit = (kind: ElemKind, idx: number) => {
            if (readOnly) return
            const el = (model[kind] ?? [])[idx]
            if (!el) return
            setEdit({ kind, idx, data: toFormData(kind, el) })
            setInfo('')
            setError('')
          }

          const doDelete = (kind: ElemKind, idx: number) => {
            if (readOnly) return
            const el = (model[kind] ?? [])[idx]
            if (!el) return
            if (!window.confirm(`${t('confirmDelete')}\n${String(el['id'])}「${String(el['name'])}」`)) return
            void savePkg((p) => {
              const arr = (p[kind] as Array<Record<string, unknown>>) ?? []
              arr.splice(idx, 1)
              p[kind] = arr
            }, 'delete')
          }

          const doSaveEdit = () => {
            if (!edit || readOnly) return
            let el: Record<string, unknown>
            try {
              el = fromFormData(edit.kind, edit.data)
            } catch (e) {
              setError(errText(e))
              return
            }
            if (!el['id'] || !el['name']) {
              setError(t('errIdName'))
              return
            }
            const idx = edit.idx
            // 跨类查重（score/exclusion 共用 RULE-*）；编辑时排除自身原位
            const taken = collectAllIds(model)
            if (idx >= 0) {
              const cur = (model[edit.kind] ?? [])[idx]
              if (cur && String(cur['id']) === String(el['id'])) taken.delete(String(el['id']))
            }
            if (taken.has(String(el['id']))) {
              setError(`${t('errDuplicateId')}: ${String(el['id'])}`)
              return
            }
            void savePkg((p) => {
              const arr = (p[edit.kind] as Array<Record<string, unknown>>) ?? []
              if (idx < 0) {
                arr.push(el)
              } else {
                // 保留 id 不变时原地替换；改 id 已在上方跨类查重；引用闭合交给校验器
                arr[idx] = el
              }
              p[edit.kind] = arr
            }, idx < 0 ? `add ${edit.kind}` : `edit ${edit.kind}`).then((ok) => {
              if (ok) setEdit(null)
            })
          }

          function elemTable(kind: ElemKind) {
            const arr = (model[kind] ?? []) as Array<Record<string, unknown>>
            const title = t(ELEM_LABEL[kind])
            return h(
              Card,
              { key: kind, title },
              h(
                'div',
                { className: 'ow-row' },
                h('span', { className: 'ow-stat' }, `${arr.length}`),
                readOnly ? null : h('button', {
                  className: 'ow-btn ghost',
                  disabled: !!busy,
                  onClick: () => startAdd(kind),
                }, `+ ${t('addElement')}`),
              ),
              arr.length === 0
                ? h('p', { className: 'ow-note' }, t('empty'))
                : h(
                    'table',
                    { className: 'ow-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, 'ID'), h('th', null, t('name')), h('th', null, t('kind')), h('th', null, t('actions')))),
                    h('tbody', null, ...arr.map((el, i) => {
                      let extra = ''
                      if (kind === 'relations') extra = `${String(el['from'] ?? '?')} → ${String(el['to'] ?? '?')}`
                      else if (kind === 'behaviors') extra = `⚓ ${String(el['anchor'] ?? '?')}`
                      else if (kind === 'scoreRules') extra = `w=${String(el['weight'] ?? 0)} ${String(el['expression'] ?? '').slice(0, 30)}`
                      else if (kind === 'exclusionRules') extra = `${String(el['action'] ?? '')} ${String(el['condition'] ?? '').slice(0, 30)}`
                      else if (kind === 'scenarios') extra = String(el['goal'] ?? '').slice(0, 40)
                      else if (kind === 'objects') {
                        const attrs = (el['attributes'] as unknown[]) ?? []
                        extra = `${attrs.length} attrs`
                      }
                      return h('tr', { key: String(el['id']) + i },
                        h('td', { className: 'ow-mono' }, String(el['id'])),
                        h('td', null, String(el['name'])),
                        h('td', { className: 'ow-note' }, extra),
                        h('td', null,
                          h('span', { className: 'ow-actions' },
                            readOnly ? null : h('button', {
                              className: 'ow-btn ghost',
                              disabled: !!busy,
                              onClick: () => startEdit(kind, i),
                            }, t('edit')),
                            readOnly ? null : h('button', {
                              className: 'ow-btn ghost',
                              disabled: !!busy,
                              onClick: () => doDelete(kind, i),
                            }, t('delete')),
                          ),
                        ),
                      )
                    })),
                  ),
              edit && edit.kind === kind ? elemForm(kind) : null,
            )
          }

          function elemForm(kind: ElemKind) {
            if (!edit) return null
            const d = edit.data
            const set = (k: string) => (e: { target: { value: string } }) =>
              setEdit({ ...edit!, data: { ...edit!.data, [k]: e.target.value } })
            const textField = (k: string, label: string, ph = '') =>
              h(Field, { label },
                h('input', { className: 'ow-in', placeholder: ph, value: d[k] ?? '', onChange: set(k) }))
            const areaField = (k: string, label: string, ph = '', minH = 70) =>
              h(Field, { label },
                h('textarea', {
                  className: 'ow-textarea', placeholder: ph,
                  style: { minHeight: minH }, value: d[k] ?? '', onChange: set(k),
                }))
            const selectField = (k: string, label: string, opts: string[]) =>
              h(Field, { label },
                h('select', { className: 'ow-sel', value: d[k] ?? '', onChange: set(k) },
                  ...opts.map((o) => h('option', { key: o, value: o }, o))))

            const isEdit = edit!.idx >= 0
            const children: ReactNode[] = [
              h('div', { className: 'ow-row' },
                h(Tag, { text: isEdit ? t('edit') : t('addElement'), tone: 'warn' }),
                h('span', { className: 'ow-note' }, t(ELEM_LABEL[kind])),
              ),
              h(Field, { label: 'ID' },
                h('input', { className: 'ow-in', value: d['id'] ?? '', onChange: set('id'), disabled: false })),
              textField('name', t('name')),
            ]

            if (kind === 'objects') {
              children.push(textField('idRule', t('idRule'), '<bank_code>:<acct_no>'))
              children.push(areaField('attributes', t('attrs'), 'acctType:enum\nopenDate:date'))
              children.push(areaField('lifecycle', t('lifecycle'), 'active\nclosed', 50))
              children.push(areaField('description', t('info'), '', 50))
            } else if (kind === 'relations') {
              children.push(selectField('from', t('from'), ['', ...objIds]))
              children.push(selectField('to', t('to'), ['', ...objIds]))
              children.push(areaField('attributes', t('attrs'), 'relKind:enum', 50))
              children.push(areaField('description', t('info'), '', 50))
            } else if (kind === 'behaviors') {
              children.push(selectField('anchor', t('anchor'), ['', ...objIds]))
              children.push(areaField('relations', t('behaviorRelations'), 'REL-GEN-1'))
              children.push(areaField('states', t('states'), 'init\nactive\nclosed', 50))
              children.push(textField('trigger', t('trigger')))
              children.push(areaField('description', t('info'), '', 50))
            } else if (kind === 'scoreRules') {
              children.push(h(Field, { label: t('weight') },
                h('input', { className: 'ow-in', style: { maxWidth: 110 }, value: d['weight'] ?? '', onChange: set('weight') })))
              children.push(textField('expression', t('expression'), 'min(1, inboundCount/10)'))
              children.push(h(Field, { label: t('threshold') },
                h('input', { className: 'ow-in', style: { maxWidth: 110 }, value: d['threshold'] ?? '', onChange: set('threshold') })))
              children.push(areaField('evidenceTemplate', t('evidence'), '近 {windowDays} 日转入 {inboundCount} 笔', 50))
              children.push(areaField('description', t('info'), '', 50))
            } else if (kind === 'exclusionRules') {
              children.push(selectField('action', t('ruleAction'), ['drop', 'downweight']))
              children.push(h(Field, { label: t('factor') },
                h('input', { className: 'ow-in', style: { maxWidth: 110 }, value: d['factor'] ?? '', onChange: set('factor') })))
              children.push(textField('condition', t('condition'), "tag == 'salary'"))
              children.push(areaField('description', t('info'), '', 50))
            } else if (kind === 'scenarios') {
              children.push(areaField('goal', t('goal'), '从客户/账户出发识别可疑交易线索', 50))
              children.push(areaField('boundary', t('boundary'), '仅输出候选线索；报送与否人工决定', 50))
              children.push(areaField('inputs', t('inputs'), '[{"name":"customerId","type":"string","required":true}]', 70))
              children.push(areaField('outputs', t('outputs'), 'candidateId\nriskScore', 50))
              children.push(areaField('mustInclude', t('mustInclude'), 'candidateList\nriskScore\nevidenceChains\npendingChecks', 60))
              children.push(areaField('forbiddenPhrases', t('forbiddenList'), '认定洗钱\n确定为地下钱庄', 60))
              children.push(selectField('reviewRequired', t('reviewRequired'), ['yes', 'no']))
              children.push(h(Field, { label: t('reviewGate') + ' ≤' },
                h('input', { className: 'ow-in', style: { maxWidth: 110 }, value: d['reviewThreshold'] ?? '', onChange: set('reviewThreshold') })))
              children.push(areaField('auditChecks', t('auditChecks'), 'O1_CLOSED\nO2_CLOSED\nO3_CLOSED', 50))
              // pipeline：JSON 可编辑 + 只读可视化
              children.push(areaField('pipeline', t('pipeline'), '[]', 90))
              let pipeSteps: Array<{ stepId?: string; stepType?: string; order?: string; skillRefs?: string[] }> = []
              try {
                pipeSteps = JSON.parse(d['pipeline'] || '[]')
              } catch {
                pipeSteps = []
              }
              children.push(
                h(Field, { label: t('pipelineViz') },
                  h('div', { className: 'ow-diff', style: { flex: 1 } },
                    h(PipelineView, { steps: pipeSteps, emptyText: t('emptyPipeline') }))),
              )
            }

            children.push(
              h('div', { className: 'ow-row' },
                h('button', {
                  className: 'ow-btn',
                  disabled: !!busy,
                  onClick: doSaveEdit,
                }, busy ? t('busy') : t('save')),
                h('button', {
                  className: 'ow-btn ghost',
                  onClick: () => { setEdit(null); setError(''); setInfo('') },
                }, t('cancel')),
              ),
            )
            return h('div', { className: 'ow-form' }, ...children)
          }

          return h(
            'div',
            { className: 'ow-card' },
            h('h3', { className: 'ow-h2' }, t('tabModel')),
            h('div', { className: 'ow-row' },
              h(Loading, { text: busy === 'load' ? t('loading') : '' }),
              busy && busy !== 'load' ? h('span', { className: 'ow-loading' }, `${t('busy')} (${busy})`) : null,
            ),
            h(ErrorBanner, { text: error }),
            h(OkBanner, { text: info }),
            readOnly
              ? h('p', { className: 'ow-note' }, `${t('issue')}: ISSUED — ${t('readme')}`)
              : null,
            h(
              'div',
              { className: 'ow-row' },
              h('span', { className: 'ow-stat' }, `${t('objects')} ${(model['objects'] ?? []).length}`),
              h('span', { className: 'ow-stat' }, `${t('relations')} ${(model['relations'] ?? []).length}`),
              h('span', { className: 'ow-stat' }, `${t('dictionaries')} ${(model['dictionaries'] ?? []).length}`),
              h('span', { className: 'ow-stat' }, `${t('behaviors')} ${(model['behaviors'] ?? []).length}`),
              h('span', { className: 'ow-stat' }, `${t('scoreRules')} ${(model['scoreRules'] ?? []).length}`),
              h('span', { className: 'ow-stat' }, `${t('exclusionRules')} ${(model['exclusionRules'] ?? []).length}`),
              h('span', { className: 'ow-stat' }, `${t('skillTemplates')} ${(model['skillTemplates'] ?? []).length}`),
              h('span', { className: 'ow-stat' }, `${t('scenarios')} ${(model['scenarios'] ?? []).length}`),
            ),
            ...(['objects', 'relations', 'behaviors', 'scoreRules', 'exclusionRules', 'scenarios'] as ElemKind[]).map(elemTable),
            h(
              Card,
              { title: t('yamlImport') },
              h('p', { className: 'ow-note' }, t('yamlNewHint')),
              h(
                Row,
                null,
                h('input', {
                  className: 'ow-in',
                  list: 'ow-yaml-files',
                  placeholder: t('yamlPath'),
                  value: yamlPath,
                  onChange: (e: { target: { value: string } }) => {
                    setYamlPath(e.target.value)
                    if (files[e.target.value] !== undefined) setYamlText(files[e.target.value])
                  },
                }),
                h('datalist', { id: 'ow-yaml-files' },
                  ...Object.keys(files).map((k) => h('option', { key: k, value: k }))),
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
                  disabled: !!busy || readOnly || !yamlPath.trim() || badRelPath,
                  title: readOnly
                    ? t('issuedReadonly')
                    : badRelPath
                      ? t('illegalRelPath')
                      : undefined,
                  onClick: () =>
                    void (async () => {
                      if (!api || !selected || readOnly) return
                      setBusy('yaml')
                      setError('')
                      setInfo('')
                      try {
                        unwrap(await api.writeSource({ name: selected.name, version: selected.version, relPath: yamlPath, text: yamlText }))
                        await reload()
                        setInfo(`✓ ${t('yamlWrite')}: ${yamlPath}`)
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
         * 知识库 —— 批量上传 / 解析报告 / 草案编辑 / diff 预览 / merge
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
          const [batchFiles, setBatchFiles] = useState<File[]>([])
          const [busy, setBusy] = useState('')
          const [error, setError] = useState('')
          const [info, setInfo] = useState('')
          const [picked, setPicked] = useState<string[]>([])
          const [parseReports, setParseReports] = useState<Record<string, string>>({})
          const [editId, setEditId] = useState('')
          const [editText, setEditText] = useState('')
          const [preview, setPreview] = useState<Array<Record<string, unknown>> | null>(null)
          const [previewFor, setPreviewFor] = useState('')
          const [mergeId, setMergeId] = useState('')
          const [mergeInto, setMergeInto] = useState('')
          const [elementNames, setElementNames] = useState<string[]>([])
          const api = apis.remote['ontoKnowledge']
          const modelApi = apis.remote['ontoModel']

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

          // merge 目标：当前包已有元素名（对象/规则/场景…）
          useEffect(() => {
            if (!modelApi || !selected) return
            void (async () => {
              try {
                const p = unwrap<{ pkg: Record<string, unknown> }>(
                  await modelApi.load({ name: selected.name, version: selected.version }),
                )
                const pkg = p.pkg as Record<string, Array<{ name?: string; id?: string }>>
                const names: string[] = []
                for (const key of ['objects', 'relations', 'behaviors', 'scoreRules', 'exclusionRules', 'scenarios', 'dictionaries', 'skillTemplates']) {
                  for (const el of pkg[key] ?? []) {
                    if (el.name) names.push(el.name)
                    else if (el.id) names.push(el.id)
                  }
                }
                setElementNames(names)
              } catch {
                /* 模型加载失败不阻塞人审；merge 目标退化为手输（提示可见，不吞） */
                setInfo(t('mergeFallback'))
              }
            })()
          }, [apis, selected])

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

          const formatReport = (r: { received: number; accepted: number; idempotentSkipped: number; invalidDropped: number; engine: string }): string =>
            `${t('parseReport')}: ${t('received')}=${r.received} ${t('accepted')}=${r.accepted} ` +
            `${t('idemSkip')}=${r.idempotentSkipped} ${t('invalidDrop')}=${r.invalidDropped} ${t('engine')}=${r.engine}`

          const doBatchUpload = async () => {
            if (!selected || batchFiles.length === 0) return
            const items: Array<{ sourceType: string; name: string; content: string }> = []
            try {
              for (const f of batchFiles) {
                items.push({ sourceType, name: f.name, content: await f.text() })
              }
            } catch (e) {
              setError(errText(e))
              return
            }
            await act('batchUpload', async () => {
              const r = unwrap<{ sources: unknown[]; skipped: number; invalid: number }>(
                await api!.uploadSources({ packageId: selected!.name, items: items as never }),
              )
              setBatchFiles([])
              setInfo(`${t('batchUpload')}: ${t('accepted')}=${r.sources.length} ${t('idemSkip')}=${r.skipped} ${t('invalidDrop')}=${r.invalid}`)
            })
          }

          const startEditDraft = (c: Record<string, unknown>) => {
            setEditId(String(c['id']))
            setEditText(JSON.stringify({
              name: c['name'],
              payload: c['payload'],
              rationale: c['rationale'],
              confidence: c['confidence'],
            }, null, 2))
            setError('')
          }

          const saveDraft = async () => {
            let parsed: { name?: string; payload?: Record<string, unknown>; rationale?: string; confidence?: number }
            try {
              parsed = JSON.parse(editText)
            } catch (e) {
              setError(`${t('errInvalidJson')}: ${errText(e)}`)
              return
            }
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              setError(t('errPatchShape'))
              return
            }
            await act('saveDraft', async () => {
              unwrap(await api!.updateCandidate({ id: editId, patch: parsed }))
              setEditId('')
              setInfo(`✓ ${t('saveDraft')}`)
            })
          }

          const doPreview = async (ids: string[], tag: string) => {
            if (!selected || ids.length === 0) return
            await act('preview', async () => {
              const r = unwrap<{ previews: Array<Record<string, unknown>> }>(
                await api!.previewMaterialize({ name: selected!.name, version: selected!.version, ids }),
              )
              setPreview(r.previews)
              setPreviewFor(tag)
            })
          }

          const doMerge = async () => {
            if (!mergeId || !mergeInto.trim()) return
            await act('merge', async () => {
              unwrap(await api!.reviewCandidate({ id: mergeId, action: 'merge', mergeIntoName: mergeInto.trim() }))
              setMergeId('')
              setMergeInto('')
              setInfo(`✓ ${t('merge')} → ${mergeInto.trim()}`)
            })
          }

          const doApprove = async (id: string) => {
            await act('approve', async () => {
              unwrap(await api!.reviewCandidate({ id, action: 'approve' }))
              setInfo(`✓ ${t('approve')}`)
            })
          }

          const doReject = async (id: string) => {
            await act('reject', async () => {
              unwrap(await api!.reviewCandidate({ id, action: 'reject' }))
              setInfo(`✓ ${t('reject')}`)
            })
          }

          return h(
            'div',
            { className: 'ow-card' },
            h('h3', { className: 'ow-h2' }, t('tabKnowledge')),
            h('div', { className: 'ow-row' },
              h(Loading, { text: busy ? `${t('busy')} (${busy})` : '' }),
            ),
            h(ErrorBanner, { text: error }),
            h(OkBanner, { text: info }),
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
                      setInfo(`✓ ${t('upload')}`)
                    }),
                },
                busy === 'upload' ? t('busy') : t('upload'),
              ),
              h('div', { className: 'ow-row' },
                h('label', { className: 'ow-label', htmlFor: 'ow-batch-files' }, t('batchUpload')),
                h('input', {
                  id: 'ow-batch-files',
                  type: 'file',
                  multiple: true,
                  className: 'ow-in',
                  style: { flex: 'none', minWidth: 260 },
                  onChange: (e: { target: { files: FileList | null } }) =>
                    setBatchFiles(e.target.files ? Array.from(e.target.files) : []),
                }),
                h('button', {
                  className: 'ow-btn ghost',
                  disabled: !!busy || batchFiles.length === 0 || !selected,
                  title: t('pickFiles'),
                  onClick: () => void doBatchUpload(),
                }, `${t('batchUpload')} (${batchFiles.length})`),
              ),
              batchFiles.length > 0
                ? h('p', { className: 'ow-note' }, batchFiles.map((f) => f.name).join(' · '))
                : null,
            ),
            h(
              Card,
              { title: t('tabKnowledge') },
              h(
                'table',
                { className: 'ow-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('sourceName')), h('th', null, t('sourceType')), h('th', null, t('status')),
                  h('th', null, t('parseReport')), h('th', null, t('actions'))),
                ),
                h(
                  'tbody',
                  null,
                  sources.length === 0
                    ? h('tr', null, h('td', { colSpan: 5 }, t('empty')))
                    : sources.map((s) =>
                        h(
                          'tr',
                          { key: s.id },
                          h('td', null, s.name),
                          h('td', null, s.sourceType),
                          h('td', null, s.parseStatus),
                          h('td', { className: 'ow-note' }, parseReports[s.id] ?? '—'),
                          h(
                            'td',
                            null,
                            h('span', { className: 'ow-actions' },
                              h('button', {
                                className: 'ow-btn ghost',
                                disabled: !!busy,
                                onClick: () =>
                                  void act('parse', async () => {
                                    const r = unwrap<{ engine: string; report: { received: number; accepted: number; idempotentSkipped: number; invalidDropped: number; engine: string } }>(
                                      await api!.parseSource({ sourceId: s.id }),
                                    )
                                    setParseReports((m) => ({ ...m, [s.id]: formatReport(r.report) }))
                                    setInfo(formatReport(r.report))
                                  }),
                              }, t('parse')),
                              h('button', {
                                className: 'ow-btn ghost',
                                disabled: !!busy,
                                onClick: () =>
                                  void act('parseApi', async () => {
                                    const r = unwrap<{ engine: string; report: { received: number; accepted: number; idempotentSkipped: number; invalidDropped: number; engine: string } }>(
                                      await api!.parseSource({ sourceId: s.id, useApi: true }),
                                    )
                                    setParseReports((m) => ({ ...m, [s.id]: formatReport(r.report) }))
                                    setInfo(formatReport(r.report))
                                  }),
                              }, t('parseApi')),
                            ),
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
                        const row: ReactNode[] = [
                          h('td', { key: 'l' }, String(c['layer'])),
                          h('td', { key: 'k' }, String(c['targetKind'])),
                          h('td', { key: 'n' }, String(c['name']),
                            c['conclusionLike'] ? h(Tag, { text: t('conclusion'), tone: 'warn' }) : null,
                            c['forcedReview'] ? h(Tag, { text: t('forcedReview'), tone: 'warn' }) : null),
                          h('td', { key: 'c' }, fmt(c['confidence'] as number, 2)),
                          h('td', { key: 's' }, status),
                        ]
                        const actions: ReactNode[] = []
                        if (status === 'pending') {
                          actions.push(h('button', {
                            key: 'edit',
                            className: 'ow-btn ghost',
                            disabled: !!busy,
                            onClick: () => startEditDraft(c),
                          }, t('editDraft')))
                          actions.push(h('button', {
                            key: 'ap',
                            className: 'ow-btn ghost',
                            disabled: !!busy,
                            onClick: () => void doApprove(id),
                          }, t('approve')))
                          actions.push(h('button', {
                            key: 'rj',
                            className: 'ow-btn ghost',
                            disabled: !!busy,
                            onClick: () => void doReject(id),
                          }, t('reject')))
                          actions.push(h('button', {
                            key: 'mg',
                            className: 'ow-btn ghost',
                            disabled: !!busy,
                            onClick: () => { setMergeId(mergeId === id ? '' : id); setMergeInto('') },
                          }, t('merge')))
                        }
                        actions.push(h('button', {
                          key: 'pv',
                          className: 'ow-btn ghost',
                          disabled: !!busy || !selected,
                          onClick: () => void doPreview([id], id),
                        }, t('preview')))
                        if (status === 'approved') {
                          actions.push(h('button', {
                            key: 'pk',
                            className: 'ow-btn ghost',
                            disabled: !!busy,
                            onClick: () => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id])),
                          }, picked.includes(id) ? '✓' : '+'))
                        }
                        row.push(h('td', { key: 'a' }, h('span', { className: 'ow-actions' }, ...actions)))

                        const extras: ReactNode[] = []
                        if (editId === id) {
                          extras.push(h('tr', { key: 'edit-row' },
                            h('td', { colSpan: 6 },
                              h('div', { className: 'ow-form' },
                                h(Field, { label: t('payloadJson') },
                                  h('textarea', {
                                    className: 'ow-textarea',
                                    style: { minHeight: 140 },
                                    value: editText,
                                    onChange: (e: { target: { value: string } }) => setEditText(e.target.value),
                                  })),
                                h('div', { className: 'ow-row' },
                                  h('button', { className: 'ow-btn', disabled: !!busy, onClick: () => void saveDraft() },
                                    busy === 'saveDraft' ? t('busy') : t('saveDraft')),
                                  h('button', { className: 'ow-btn ghost', onClick: () => setEditId('') }, t('cancel')),
                                ),
                              )),
                          ))
                        }
                        if (mergeId === id) {
                          extras.push(h('tr', { key: 'merge-row' },
                            h('td', { colSpan: 6 },
                              h('div', { className: 'ow-form' },
                                h(Field, { label: t('mergeInto') },
                                  h('input', {
                                    className: 'ow-in',
                                    list: 'ow-elem-names',
                                    placeholder: t('elementName'),
                                    value: mergeInto,
                                    onChange: (e: { target: { value: string } }) => setMergeInto(e.target.value),
                                  }),
                                  h('datalist', { id: 'ow-elem-names' },
                                    ...elementNames.map((n) => h('option', { key: n, value: n }))),
                                ),
                                h('div', { className: 'ow-row' },
                                  h('button', {
                                    className: 'ow-btn',
                                    disabled: !!busy || !mergeInto.trim(),
                                    onClick: () => void doMerge(),
                                  }, t('merge')),
                                  h('button', { className: 'ow-btn ghost', onClick: () => setMergeId('') }, t('cancel')),
                                ),
                              )),
                          ))
                        }
                        if (previewFor === id && preview) {
                          extras.push(h('tr', { key: 'preview-row' },
                            h('td', { colSpan: 6 },
                              h('div', { className: 'ow-diff' },
                                h('strong', null, t('previewTitle')),
                                ...preview.map((p) =>
                                  h('div', { key: String(p['id']) },
                                    h('p', {
                                      className: 'ow-note',
                                      style: { color: p['ok'] ? '#166534' : '#b91c1c', margin: '4px 0 0' },
                                    }, p['ok'] ? String(p['summary']) : `✗ ${String(p['error'] ?? '')}`),
                                    p['element']
                                      ? h('pre', { className: 'ow-mono' }, JSON.stringify(p['element'], null, 2))
                                      : null,
                                  )),
                                h('button', {
                                  className: 'ow-btn ghost',
                                  onClick: () => { setPreview(null); setPreviewFor('') },
                                }, t('cancel')),
                              )),
                          ))
                        }
                        return h(React.Fragment, { key: id },
                          h('tr', null, ...row),
                          ...extras,
                        )
                      }),
                ),
              ),
              h(
                'button',
                {
                  className: 'ow-btn ghost',
                  disabled: !!busy || picked.length === 0 || !selected,
                  onClick: () => void doPreview(picked, 'bulk'),
                },
                `${t('preview')} (${picked.length})`,
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
                      else setInfo(`✓ ${t('materialize')}: ${r.applied.length}`)
                    }),
                },
                busy === 'materialize' ? t('busy') : `${t('materialize')} (${picked.length})`,
              ),
              previewFor === 'bulk' && preview
                ? h('div', { className: 'ow-diff' },
                    h('strong', null, t('previewTitle')),
                    ...preview.map((p) =>
                      h('div', { key: String(p['id']) },
                        h('p', {
                          className: 'ow-note',
                          style: { color: p['ok'] ? '#166534' : '#b91c1c', margin: '4px 0 0' },
                        }, p['ok'] ? String(p['summary']) : `✗ ${String(p['error'] ?? '')}`),
                        p['element']
                          ? h('pre', { className: 'ow-mono' }, JSON.stringify(p['element'], null, 2))
                          : null,
                      )),
                    h('button', {
                      className: 'ow-btn ghost',
                      onClick: () => { setPreview(null); setPreviewFor('') },
                    }, t('cancel')),
                  )
                : null,
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
            h('div', { className: 'ow-row' }, h(Loading, { text: busy ? `${t('busy')} (${busy})` : '' })),
            h(ErrorBanner, { text: error }),
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
          // P1：本地暂存最近 N 次运行（不持久化，v0.4 再入库）
          const [history, setHistory] = useState<Array<{ hid: string; label: string; result: Record<string, unknown> }>>([])
          const [viewHid, setViewHid] = useState('')
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
          const res = (viewHid ? history.find((x) => x.hid === viewHid)?.result : result) as {
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
            h('div', { className: 'ow-row' }, h(Loading, { text: busy ? `${t('busy')} (${busy})` : '' })),
            h(ErrorBanner, { text: error }),
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
                        setViewHid('')
                        const hid = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
                        const label = `${scenarioId} @ ${new Date().toLocaleTimeString()}`
                        setHistory((hlist) => [{ hid, label, result: out.result }, ...hlist].slice(0, 10))
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
            history.length > 0
              ? h(
                  Row,
                  { label: t('runHistory') },
                  ...history.map((x) => {
                    const isCurrent = viewHid ? viewHid === x.hid : x === history[0]
                    return h('button', {
                      key: x.hid,
                      className: 'ow-btn ghost',
                      style: isCurrent ? { outline: '2px solid var(--dsw-alias-brand,#3b6fd4)' } : undefined,
                      disabled: !!busy,
                      onClick: () => setViewHid(x.hid === viewHid ? '' : x.hid),
                    }, x.label)
                  }),
                )
              : null,
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
              ? h(ErrorBanner, { text: `包列表：${listError}` })
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
