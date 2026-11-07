/**
 * dsh-onto 工作台 client half —— browser entry（classic script，零 runtime import/export）。
 *
 * 六个 tab：包管理 | 建模 | 知识库 | 校验派生 | 场景运行 | 经验。
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
  /** 右栏 tab 类型注册表（shell 的 ui-sidebar-right reflect 服务；结构面手写，零 import）。 */
  sidebarRightTabs: { register(def: SidebarRightTabDefinitionLike): () => void }
}

/** SidebarRightTabDefinition 最小结构面（与 ui-sidebar-right 对齐）。 */
interface SidebarRightTabDefinitionLike {
  id: string
  kind: string
  priority?: 'extension' | 'builtin' | 'fallback'
  title: (address: string) => string
  guide?: Array<{ id: string; order: number; title: () => string; description?: () => string }>
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
    /** 右栏「本体图谱」页型：kind 为打开名，id 为实现身份（pane.tab 的 key）。 */
    const GRAPH_TAB_ID = '@dsh-onto/workbench'
    const GRAPH_TAB_KIND = 'ontology-graph'

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
      preflightBtn: '签发前预检',
      backlogTitle: 'backlog.md · v1.1 待办（包根附属文件）',
      backlogHint: '可在下方 YAML 导入区编辑（relPath: backlog.md）；改写不触发派生漂移，fork 自动携带',
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
      runRecords: '运行记录',
      selHint: '勾选 A/B 两条记录后对比（A=基准）',
      compareBtn: '对比两轮',
      diffTitle: '对比结果（B 相对 A）',
      sameDataset: '同数据',
      scoreAB: '风险分 A→B',
      changes: '变更（±）',
      exportAuditBtn: '导出审计',
      locator: '归档位置',
      savedAt: '落盘时间',
      digest: '数据指纹',
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
      // 对话式建模（conversational-modeling P1/P3）
      canvasView: '图谱画布',
      listView: '清单视图',
      draftHint: '虚线 = 待审草案。建模请在主对话口述（AI 起草、画布自动生长）；人审动作在节点检视器。',
      skeleton: '骨架',
      skelNone: '未建骨架（物化门未启用）',
      skelUnconfirmed: '骨架未确认（物化门已锁）',
      skelConfirmed: '骨架已确认',
      skelEdit: '编辑骨架',
      skelIds: '骨架 ID 清单（每行一个）',
      skelCode: '域码',
      skelSave: '保存骨架',
      approveMat: '批准并物化',
      prov: '溯源',
      pkgIssues: '包级问题',
      nodeIssues: '节点问题',
      noSelection: '点画布上的节点查看检视器',
      payload: '载荷',
      rationale: '依据',
      attrCount: '属性',
      draftCount: '待审草案',
      revision: '修订',
      graphTabTitle: '本体图谱',
      graphTabDesc: '对话旁的常驻画布：每轮起草自动长出节点',
      rightSelected: '图谱包',
      // 经验闭环（experience-loop P2-1）
      tabExperience: '经验',
      expTitle: '经验记录',
      expOutcome: '结论',
      expReason: '结论理由',
      expCounter: '反例',
      expReused: '复用自',
      expMis: '误迁移',
      expFocus: '复核关注',
      expReviewBtn: '回填',
      expMisBy: '判定人',
      expMisNote: '判定说明',
      expReviewHint: '误迁移只由人判，by 必填；认定在人工',
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
      preflightBtn: 'Pre-issue preflight',
      backlogTitle: 'backlog.md · v1.1 backlog (package-root sidecar)',
      backlogHint: 'Editable in the YAML import area (relPath: backlog.md); edits never trigger derive drift, forks carry it over',
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
      runRecords: 'Run records',
      selHint: 'Select A/B records to compare (A = base)',
      compareBtn: 'Compare two runs',
      diffTitle: 'Diff (B vs A)',
      sameDataset: 'Same dataset',
      scoreAB: 'Score A→B',
      changes: 'Changes (±)',
      exportAuditBtn: 'Export audit',
      locator: 'Archive locator',
      savedAt: 'Saved at',
      digest: 'Dataset digest',
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
      // conversational modeling (P1/P3)
      canvasView: 'Graph canvas',
      listView: 'List view',
      draftHint: 'Dashed = pending draft. Describe modeling in the main chat (AI drafts, canvas grows); review actions in the node inspector.',
      skeleton: 'Skeleton',
      skelNone: 'No skeleton (materialize gate inactive)',
      skelUnconfirmed: 'Skeleton unconfirmed (gate locked)',
      skelConfirmed: 'Skeleton confirmed',
      skelEdit: 'Edit skeleton',
      skelIds: 'Skeleton IDs (one per line)',
      skelCode: 'Domain code',
      skelSave: 'Save skeleton',
      approveMat: 'Approve & materialize',
      prov: 'Provenance',
      pkgIssues: 'Package-level issues',
      nodeIssues: 'Node issues',
      noSelection: 'Click a node on the canvas to inspect',
      payload: 'Payload',
      rationale: 'Rationale',
      attrCount: 'Attributes',
      draftCount: 'Pending drafts',
      revision: 'Rev',
      graphTabTitle: 'Ontology graph',
      graphTabDesc: 'Persistent canvas beside chat: drafts grow nodes per turn',
      rightSelected: 'Graph package',
      // experience-loop P2-1
      tabExperience: 'Experience',
      expTitle: 'Experience notes',
      expOutcome: 'Outcome',
      expReason: 'Outcome reason',
      expCounter: 'Counterexample',
      expReused: 'Reused from',
      expMis: 'Mis-transfer',
      expFocus: 'Review focus',
      expReviewBtn: 'Write back',
      expMisBy: 'Judged by',
      expMisNote: 'Note',
      expReviewHint: 'Mis-transfer is human-only; by required. Humans decide.',
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
     * 包选中共享态：主区工作台与右栏图谱同一来源（conversational-modeling P1 修正）
     * ═══════════════════════════════════════════════════════════════════ */

    interface SelectedPkg {
      name: string
      version: string
    }

    const selectedStore = {
      value: null as SelectedPkg | null,
      listeners: new Set<() => void>(),
      get(): SelectedPkg | null {
        return this.value
      },
      set(next: SelectedPkg | null): void {
        this.value = next
        for (const fn of [...this.listeners]) fn()
      },
      subscribe(fn: () => void): () => void {
        this.listeners.add(fn)
        return () => {
          this.listeners.delete(fn)
        }
      },
    }

    function useSharedSelected(): [SelectedPkg | null, (next: SelectedPkg | null) => void] {
      const [v, setV] = useState<SelectedPkg | null>(selectedStore.get())
      useEffect(() => selectedStore.subscribe(() => setV(selectedStore.get())), [])
      return [v, (next) => selectedStore.set(next)]
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
      '.ogc-toolbar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;}',
      '.ogc-grid{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:12px;align-items:start;}',
      '.ogc-box{border:1px solid var(--dsw-alias-line,#e5e7eb);border-radius:10px;overflow:hidden;background:transparent;}',
      '.ogc-box svg{display:block;width:100%;height:auto;}',
      '.ogc-legend{display:flex;gap:10px;flex-wrap:wrap;padding:6px 10px;border-top:1px dashed var(--dsw-alias-line,#e5e7eb);font-size:11px;color:var(--dsw-alias-label-secondary,#6b7280);}',
      '.ogc-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:4px;vertical-align:middle;}',
      '.ogc-insp{border:1px solid var(--dsw-alias-line,#e5e7eb);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px;max-height:560px;overflow:auto;font-size:12.5px;}',
      '.ogc-insp h4{margin:0;font-size:13px;font-weight:650;word-break:break-all;}',
      '.ogc-kv{display:flex;gap:8px;font-size:12px;}',
      '.ogc-kv b{color:var(--dsw-alias-label-secondary,#6b7280);font-weight:600;min-width:52px;flex-shrink:0;}',
      '.ogc-issue{border-left:3px solid #dc2626;padding:2px 8px;margin:2px 0;font-size:12px;background:#fee2e2;color:#7f1d1d;border-radius:0 6px 6px 0;word-break:break-word;}',
      '.ogc-issue.warn{border-left-color:#d97706;background:#fef3c7;color:#78350f;}',
      '.ogc-skel{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:12px;padding:6px 10px;border:1px dashed var(--dsw-alias-line,#d1d5db);border-radius:8px;}',

      '.ogc-node{cursor:pointer;}',
      '.ogc-right .ogc-grid{grid-template-columns:1fr;}',
      '.ogc-right{max-width:none;}',
      '.ogc-node:hover text{text-decoration:underline;}',
      '.ogc-lbl{font-size:10px;fill:var(--dsw-alias-label-primary,#1c2333);pointer-events:none;}',
      '.ogc-edge{stroke-width:1;fill:none;opacity:.65;}',
      '@media (max-width:900px){.ogc-grid{grid-template-columns:1fr;}}',
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
        'sidebarRightTabs',
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

        /* ═══════════════════════════════════════════════════════════════
         * 图谱画布（conversational-modeling P1）：分层力导 GraphCanvas + 检视器
         * ═══════════════════════════════════════════════════════════════ */

        interface OgNode {
          id: string
          kind: string
          layer: 'O1' | 'O2' | 'O3'
          name: string
          draft: boolean
          provenance?: { turnId?: string; sourceId?: string; runId?: string }
          issueLevel?: 'error' | 'warn' | 'info'
          forcedReview?: boolean
          runHit?: boolean
        }
        interface OgEdge {
          from: string
          to: string
          kind: string
          label?: string
        }
        interface OgIssue {
          level: 'error' | 'warn' | 'info'
          code: string
          message: string
          where: string
        }
        interface OgGraph {
          package: string
          version: string
          status: string
          nodes: OgNode[]
          edges: OgEdge[]
          issues: OgIssue[]
          revision: number
          skeleton?: { confirmed: boolean; ids: string[] }
        }

        const OG_W = 880
        const OG_H = 460
        const OG_FILL: Record<string, string> = { O1: '#eaf0f7', O2: '#fdf1e2', O3: '#e9f7ef' }
        const OG_STROKE: Record<string, string> = { O1: '#4a6fa5', O2: '#e8933a', O3: '#3d9970' }
        const OG_EDGE: Record<string, string> = {
          relation: '#4a6fa5',
          anchor: '#e8933a',
          dict: '#b8a46b',
          'skill-rule': '#e8933a',
          'scenario-step': '#4a6fa5',
          ref: '#9aa3b2',
          applies: '#9aa3b2',
        }

        /** 分层力导向：按 O1/O2/O3/草案分列初始 + 固定轮数迭代（确定性，无随机）。 */
        function layoutGraph(graph: OgGraph): Map<string, { x: number; y: number }> {
          const nodes = graph.nodes
          const n = nodes.length
          const pos = new Map<string, { x: number; y: number }>()
          if (n === 0) return pos
          const colX: Record<string, number> = { O1: OG_W * 0.16, O2: OG_W * 0.5, O3: OG_W * 0.8, draft: OG_W * 0.93 }
          const buckets: Record<string, OgNode[]> = { O1: [], O2: [], O3: [], draft: [] }
          for (const nd of nodes) buckets[nd.draft ? 'draft' : nd.layer].push(nd)
          for (const key of Object.keys(buckets)) {
            const arr = buckets[key]
            const spread = (OG_H - 72) / Math.max(arr.length, 1)
            arr.forEach((nd, i) => {
              pos.set(nd.id, { x: colX[key], y: 36 + spread * (i + 0.5) })
            })
          }
          if (n > 420) return pos // 大图退化为分列布局（斥力 O(n²) 设上限）
          const K = 4200
          const REST = 96
          for (let tick = 0; tick < 130; tick++) {
            const fx = new Map<string, { x: number; y: number }>()
            const add = (id: string, dx: number, dy: number): void => {
              const cur = fx.get(id) ?? { x: 0, y: 0 }
              cur.x += dx
              cur.y += dy
              fx.set(id, cur)
            }
            for (let i = 0; i < n; i++) {
              for (let j = i + 1; j < n; j++) {
                const a = nodes[i]
                const b = nodes[j]
                const pa = pos.get(a.id)
                const pb = pos.get(b.id)
                if (!pa || !pb) continue
                let dx = pa.x - pb.x
                let dy = pa.y - pb.y
                let d2 = dx * dx + dy * dy
                if (d2 < 1) {
                  dx = (i % 7) - 3 || 1
                  dy = (j % 5) - 2 || 1
                  d2 = dx * dx + dy * dy
                }
                const d = Math.sqrt(d2)
                const f = K / d2
                add(a.id, (dx / d) * f, (dy / d) * f)
                add(b.id, (-dx / d) * f, (-dy / d) * f)
              }
            }
            for (const e of graph.edges) {
              const pa = pos.get(e.from)
              const pb = pos.get(e.to)
              if (!pa || !pb) continue
              const dx = pb.x - pa.x
              const dy = pb.y - pa.y
              const d = Math.sqrt(dx * dx + dy * dy) || 1
              const f = (d - REST) * 0.04
              add(e.from, (dx / d) * f, (dy / d) * f)
              add(e.to, (-dx / d) * f, (-dy / d) * f)
            }
            for (const nd of nodes) {
              const p = pos.get(nd.id)
              if (!p) continue
              const tx = colX[nd.draft ? 'draft' : nd.layer]
              add(nd.id, (tx - p.x) * 0.045, (OG_H / 2 - p.y) * 0.012)
            }
            for (const nd of nodes) {
              const d = fx.get(nd.id)
              const p = pos.get(nd.id)
              if (!d || !p) continue
              const mag = Math.sqrt(d.x * d.x + d.y * d.y) || 1
              const lim = Math.max(13 - tick * 0.08, 1.5)
              const step = Math.min(mag, lim) * 0.6
              p.x += (d.x / mag) * step
              p.y += (d.y / mag) * step
              p.x = Math.max(52, Math.min(OG_W - 52, p.x))
              p.y = Math.max(24, Math.min(OG_H - 24, p.y))
            }
          }
          return pos
        }

        function GraphCanvas(props: { graph: OgGraph; selected: string | null; onSelect: (id: string) => void }) {
          const { graph, selected, onSelect } = props
          const pos = useMemo(() => layoutGraph(graph), [graph])
          return h(
            'svg',
            { viewBox: `0 0 ${OG_W} ${OG_H}`, role: 'img', 'aria-label': 'ontology graph' },
            h(
              'defs',
              null,
              h(
                'marker',
                { id: 'ogc-ar', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto' },
                h('path', { d: 'M1,1 L6,4 L1,7', fill: 'none', stroke: '#9aa3b2', strokeWidth: 1.2 }),
              ),
            ),
            ...graph.edges.map((e, i) => {
              const a = pos.get(e.from)
              const b = pos.get(e.to)
              if (!a || !b) return null
              return h('line', {
                key: `e${i}`,
                className: 'ogc-edge',
                x1: a.x,
                y1: a.y,
                x2: b.x,
                y2: b.y,
                stroke: OG_EDGE[e.kind] ?? '#9aa3b2',
                markerEnd: 'url(#ogc-ar)',
              })
            }),
            ...graph.nodes.map((nd) => {
              const p = pos.get(nd.id)
              if (!p) return null
              const label = nd.name.length > 12 ? `${nd.name.slice(0, 11)}…` : nd.name
              const w = Math.max(56, Math.min(140, 30 + label.length * 11))
              const stroke = nd.runHit
                ? '#dc2626'
                : nd.issueLevel === 'error'
                  ? '#dc2626'
                  : nd.issueLevel === 'warn'
                    ? '#d97706'
                    : OG_STROKE[nd.layer] ?? '#9aa3b2'
              const isSel = selected === nd.id
              return h(
                'g',
                {
                  key: nd.id,
                  className: 'ogc-node',
                  transform: `translate(${p.x - w / 2},${p.y - 14})`,
                  onClick: () => onSelect(nd.id),
                },
                h('title', null, `${nd.id}${nd.draft ? '（草案）' : ''}${nd.runHit ? '（运行命中）' : ''}`),
                h('rect', {
                  width: w,
                  height: 28,
                  rx: 7,
                  fill: OG_FILL[nd.layer] ?? '#f3f4f6',
                  fillOpacity: nd.draft ? 0.5 : 1,
                  stroke,
                  strokeWidth: isSel ? 2.4 : 1.4,
                  strokeDasharray: nd.draft ? '5 3' : undefined,
                }),
                h('text', { className: 'ogc-lbl', x: w / 2, y: 18, textAnchor: 'middle' }, label),
              )
            }),
          )
        }

        /** issue.where → 当前节点（graph.issues.where 已在 core 归一为「节点 ID | 'package'」；PREFIX 形态为兼容保留）。 */
        function matchIssueWhere(where: string, id: string): boolean {
          if (where === id || where.startsWith(`${id}.`)) return true
          const m = /^([A-Z]{2,4}) ([A-Z]+-[A-Z0-9-]+)(?:\.[A-Za-z0-9_-]+)?$/.exec(where)
          return m !== null && m[2] === id
        }

        function findElement(
          pkg: Record<string, unknown> | null,
          id: string,
        ): { key: string; el: Record<string, unknown> } | null {
          if (!pkg) return null
          for (const key of [
            'objects',
            'relations',
            'dictionaries',
            'behaviors',
            'scoreRules',
            'exclusionRules',
            'skillTemplates',
            'scenarios',
            'fieldMaps',
            'apiSources',
          ]) {
            const arr = pkg[key] as Array<Record<string, unknown>> | undefined
            const hit = arr?.find((x) => String(x['id']) === id)
            if (hit) return { key, el: hit }
          }
          return null
        }

        function InspectorView(props: {
          t: (k: string) => string
          graph: OgGraph
          node: OgNode | null
          pkg: Record<string, unknown> | null
          candidates: Array<Record<string, unknown>>
          busy: string
          readOnly: boolean
          onDraftAction: (id: string, action: 'approve' | 'reject') => void
        }) {
          const { t, graph, node, pkg, candidates, busy, readOnly, onDraftAction } = props
          if (!node) {
            return h('div', { className: 'ogc-insp' }, h('p', { className: 'ow-note' }, t('noSelection')))
          }
          const issues = graph.issues.filter((i) => i.level !== 'info' && matchIssueWhere(i.where, node.id))
          const found = node.draft ? null : findElement(pkg, node.id)
          const cand = node.draft ? candidates.find((c) => String(c['id']) === node.id) ?? null : null
          const kv = (label: string, value: unknown): ReactNode =>
            h('div', { className: 'ogc-kv' }, h('b', null, label), h('span', null, String(value ?? '—')))
          const rows: ReactNode[] = [
            h('div', { key: 'tags', className: 'ow-row' },
              h(Tag, { text: `${node.layer} · ${node.kind}` }),
              node.draft ? h(Tag, { text: t('queue'), tone: 'warn' }) : null,
              node.forcedReview ? h(Tag, { text: t('forcedReview'), tone: 'warn' }) : null,
              node.issueLevel ? h(Tag, { text: node.issueLevel, tone: node.issueLevel === 'error' ? 'err' : 'warn' }) : null,
              node.runHit ? h(Tag, { text: 'run-hit', tone: 'ok' }) : null,
            ),
            kv(t('name'), node.name),
          ]
          if (node.provenance?.turnId || node.provenance?.sourceId || node.provenance?.runId) {
            rows.push(kv(t('prov'), [node.provenance.turnId, node.provenance.sourceId, node.provenance.runId].filter(Boolean).join(' · ')))
          }
          if (found) {
            const el = found.el
            if (el['idRule']) rows.push(kv(t('idRule'), el['idRule']))
            if (el['from'] !== undefined && el['to'] !== undefined) rows.push(kv(t('from'), `${el['from']} → ${el['to']}`))
            if (el['anchor'] !== undefined) rows.push(kv(t('anchor'), el['anchor']))
            if (el['weight'] !== undefined) rows.push(kv(t('weight'), `${el['weight']}  ${String(el['expression'] ?? '')}`))
            if (el['condition'] !== undefined) rows.push(kv(t('condition'), el['condition']))
            if (el['goal'] !== undefined) rows.push(kv(t('goal'), el['goal']))
            if (el['boundary'] !== undefined) rows.push(kv(t('boundary'), el['boundary']))
            const attrs = el['attributes'] as unknown[] | undefined
            if (Array.isArray(attrs)) rows.push(kv(t('attrCount'), attrs.length))
            const values = el['values'] as unknown[] | undefined
            if (Array.isArray(values)) rows.push(kv(t('dictionaries'), values.join(', ')))
          }
          if (issues.length > 0) {
            rows.push(
              h('div', { key: 'issues' },
                h('b', { className: 'ow-note' }, t('nodeIssues')),
                ...issues.map((i, k) =>
                  h('div', { key: k, className: i.level === 'warn' ? 'ogc-issue warn' : 'ogc-issue' },
                    h('b', null, `${i.code} @ ${i.where}`), ' ', i.message))),
            )
          }
          if (cand) {
            rows.push(kv(t('confidence'), cand['confidence']))
            if (cand['rationale']) rows.push(kv(t('rationale'), cand['rationale']))
            rows.push(
              h('pre', { key: 'payload', className: 'ow-mono', style: { maxHeight: 140, overflow: 'auto', margin: 0 } },
                JSON.stringify(cand['payload'] ?? {}, null, 2)),
            )
            rows.push(
              h('div', { key: 'act', className: 'ow-row' },
                readOnly
                  ? null
                  : h('button', {
                      className: 'ow-btn',
                      disabled: !!busy,
                      onClick: () => onDraftAction(node.id, 'approve'),
                    }, busy ? t('busy') : t('approveMat')),
                readOnly
                  ? null
                  : h('button', {
                      className: 'ow-btn ghost',
                      disabled: !!busy,
                      onClick: () => onDraftAction(node.id, 'reject'),
                    }, t('reject'))),
            )
          }
          return h('div', { className: 'ogc-insp' }, h('h4', null, node.id), ...rows)
        }

        /* ═══════════════════════════════════════════════════════════════
         * GraphWorkbench —— 画布工作台（主区建模视图与右栏图谱 tab 共用）
         * 状态自带：图谱轮询 / 人审物化 / 骨架门（P1/P3）。草拟单一入口在
         * dsh 主对话（agent → draft_elements），画布只展示状态与人审动作。
         * ═══════════════════════════════════════════════════════════════ */

        function GraphWorkbench(props: {
          t: (k: string) => string
          apis: Ctx
          selected: { name: string; version: string } | null
          /** 主区视图传入：物化后刷新 pkg/统计（右栏 tab 不传）。 */
          onChanged?: () => void
        }) {
          const { t, apis, selected, onChanged } = props
          const api = apis.remote['ontoModel']
          const kApi = apis.remote['ontoKnowledge']
          const [graph, setGraph] = useState<OgGraph | null>(null)
          const [selNode, setSelNode] = useState<string | null>(null)
          const [candidates, setCandidates] = useState<Array<Record<string, unknown>>>([])
          const [skelOpen, setSkelOpen] = useState(false)
          const [skelIds, setSkelIds] = useState('')
          const [skelCode, setSkelCode] = useState('')
          const [skelConfirmed, setSkelConfirmed] = useState(false)
          const [busy, setBusy] = useState('')
          const [error, setError] = useState('')
          const [info, setInfo] = useState('')
          const [pkg, setPkg] = useState<Record<string, unknown> | null>(null)

          const loadGraph = useCallback(async () => {
            if (!api || !kApi || !selected) return
            try {
              const out = unwrap<{ graph: OgGraph }>(
                await api.getGraph({ name: selected.name, version: selected.version }),
              )
              setGraph(out.graph)
              const cq = unwrap<{ items: Array<Record<string, unknown>> }>(
                await kApi.listCandidates({ packageId: selected.name }),
              )
              setCandidates(cq.items)
              const p = unwrap<{ pkg: Record<string, unknown> }>(
                await api.load({ name: selected.name, version: selected.version }),
              )
              setPkg(p.pkg)
            } catch {
              /* 画布刷新失败静默（DRAFT/空包轮询） */
            }
          }, [apis, selected])

          useEffect(() => {
            void loadGraph()
          }, [loadGraph])

          // P1 订阅刷新：轮询 revision——dsh 会话起草 / 知识库人审后画布增量生长
          useEffect(() => {
            const timer = setInterval(() => {
              void loadGraph()
            }, 4000)
            return () => clearInterval(timer)
          }, [loadGraph])

          // 骨架输入只在非编辑态同步（防轮询覆盖正在输入的内容）
          useEffect(() => {
            if (!skelOpen && graph) {
              setSkelIds(graph.skeleton ? graph.skeleton.ids.join('\n') : '')
              setSkelConfirmed(graph.skeleton ? graph.skeleton.confirmed : false)
            }
          }, [graph, skelOpen])

          const readOnly = graph?.status === 'ISSUED'

          const draftAction = (id: string, action: 'approve' | 'reject'): void => {
            if (!selected || readOnly || !kApi) return
            void (async () => {
              setBusy(action)
              setError('')
              setInfo('')
              try {
                unwrap(await kApi.reviewCandidate({ id, action }))
                if (action === 'approve') {
                  const res = unwrap<{ applied: string[]; skipped: Array<{ id: string; reason: string }> }>(
                    await kApi.materialize({ name: selected.name, version: selected.version, ids: [id] }),
                  )
                  setInfo(
                    res.applied.length > 0
                      ? `✓ ${t('approveMat')}`
                      : `✓ ${t('approve')} — ${res.skipped.map((s) => s.reason).join('; ') || t('empty')}`,
                  )
                } else {
                  setInfo(`✓ ${t('reject')}`)
                }
                await loadGraph()
                onChanged?.()
              } catch (e) {
                setError(errText(e))
                void loadGraph()
              } finally {
                setBusy('')
              }
            })()
          }

          const saveSkeleton = (): void => {
            if (!selected || !kApi) return
            const domainCode = skelCode.trim() || skelDomainFallback(graph)
            const ids = skelIds
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean)
            void (async () => {
              setBusy('skel')
              setError('')
              setInfo('')
              try {
                unwrap(
                  await kApi.saveSkeleton({
                    name: selected.name,
                    version: selected.version,
                    domainCode,
                    confirmed: skelConfirmed,
                    ids,
                  }),
                )
                await loadGraph()
                setInfo(`✓ ${t('skelSave')}`)
              } catch (e) {
                setError(errText(e))
              } finally {
                setBusy('')
                setSkelOpen(false)
              }
            })()
          }

          if (!selected) return h('p', { className: 'ow-note' }, t('none'))

          const EMPTY_GRAPH: OgGraph = { package: '', version: '', status: '', nodes: [], edges: [], issues: [], revision: 0 }
          const g = graph ?? EMPTY_GRAPH
          const nodeObj: OgNode | null = selNode ? g.nodes.find((nd) => nd.id === selNode) ?? null : null
          const pkgIssues = g.issues.filter((i) => i.where === 'package' && i.level !== 'info')
          const draftCount = g.nodes.filter((nd) => nd.draft).length
          const domain = skelDomainFallback(graph)

          const canvasChildren: ReactNode[] = []
          if (graph) {
            canvasChildren.push(
              h(
                'div',
                { key: 'skel', className: 'ogc-skel' },
                h(Tag, {
                  text: t('skeleton'),
                  tone: graph.skeleton ? (graph.skeleton.confirmed ? 'ok' : 'warn') : undefined,
                }),
                h(
                  'span',
                  { className: 'ow-note' },
                  graph.skeleton
                    ? `${graph.skeleton.confirmed ? t('skelConfirmed') : t('skelUnconfirmed')} · ${graph.skeleton.ids.length} ID`
                    : t('skelNone'),
                ),
                readOnly
                  ? null
                  : h('button', {
                      className: 'ow-btn ghost',
                      disabled: !!busy,
                      onClick: () => setSkelOpen((v) => !v),
                    }, t('skelEdit')),
                skelOpen
                  ? h(
                      'div',
                      { className: 'ow-form', style: { width: '100%' } },
                      h(Field, { label: t('skelCode') },
                        h('input', {
                          className: 'ow-in',
                          value: skelCode,
                          placeholder: domain,
                          onChange: (e: { target: { value: string } }) => setSkelCode(e.target.value),
                        })),
                      h(Field, { label: t('skelIds') },
                        h('textarea', {
                          className: 'ow-textarea',
                          style: { minHeight: 90 },
                          value: skelIds,
                          onChange: (e: { target: { value: string } }) => setSkelIds(e.target.value),
                        })),
                      h(
                        'div',
                        { className: 'ow-row' },
                        h('label', { className: 'ow-note', style: { display: 'flex', gap: 6, alignItems: 'center' } },
                          h('input', {
                            type: 'checkbox',
                            checked: skelConfirmed,
                            onChange: (e: { target: { checked: boolean } }) => setSkelConfirmed(e.target.checked),
                          }),
                          t('skelConfirmed')),
                        h('button', { className: 'ow-btn', disabled: !!busy, onClick: saveSkeleton }, t('skelSave')),
                        h('button', { className: 'ow-btn ghost', onClick: () => setSkelOpen(false) }, t('cancel')),
                      ),
                    )
                  : null,
              ),
            )
          }
          if (!readOnly) {
            // 草拟单一入口在 dsh 主对话（P1：对话是入口，画布是状态）——此处只留引导。
            canvasChildren.push(h('p', { key: 'hint', className: 'ow-note' }, t('draftHint')))
          }
          canvasChildren.push(
            h(
              'div',
              { key: 'grid', className: 'ogc-grid' },
              graph
                ? h(
                    'div',
                    { className: 'ogc-box' },
                    h(GraphCanvas, { graph, selected: selNode, onSelect: setSelNode }),
                    h(
                      'div',
                      { className: 'ogc-legend' },
                      h('span', null, h('i', { className: 'ogc-dot', style: { background: OG_FILL.O1, border: '1.5px solid #4a6fa5' } }), ' O1'),
                      h('span', null, h('i', { className: 'ogc-dot', style: { background: OG_FILL.O2, border: '1.5px solid #e8933a' } }), ' O2'),
                      h('span', null, h('i', { className: 'ogc-dot', style: { background: OG_FILL.O3, border: '1.5px solid #3d9970' } }), ' O3'),
                      h('span', null, h('i', { className: 'ogc-dot', style: { background: '#fff', border: '1.5px dashed #999' } }), ` ${t('queue')}`),
                      h('span', null, h('i', { className: 'ogc-dot', style: { background: '#fff', border: '1.5px solid #dc2626' } }), ' error / run-hit'),
                    ),
                  )
                : h('p', { className: 'ow-note' }, t('loading')),
              h(InspectorView, {
                t,
                graph: g,
                node: nodeObj,
                pkg,
                candidates,
                busy,
                readOnly,
                onDraftAction: draftAction,
              }),
            ),
          )
          if (pkgIssues.length > 0) {
            canvasChildren.push(
              h(
                'div',
                { key: 'pkgissues', style: { marginTop: 8 } },
                h('b', { className: 'ow-note' }, `${t('pkgIssues')}（${pkgIssues.length}）`),
                ...pkgIssues.slice(0, 12).map((i, k) =>
                  h(
                    'div',
                    { key: k, className: i.level === 'warn' ? 'ogc-issue warn' : 'ogc-issue' },
                    h('b', null, i.code),
                    ' ',
                    i.message,
                  )),
              ),
            )
          }

          return h(
            'div',
            { className: 'ogc-work' },
            h(
              'div',
              { className: 'ow-row' },
              h('span', { className: 'ow-stat' }, `${t('draftCount')} ${draftCount}`),
              graph ? h('span', { className: 'ow-stat' }, `${t('revision')} ${graph.revision}`) : null,
              h('button', { className: 'ow-btn ghost', disabled: !!busy, onClick: () => void loadGraph() }, t('refresh')),
            ),
            h(ErrorBanner, { text: error }),
            h(OkBanner, { text: info }),
            ...canvasChildren,
          )
        }

        /** 骨架域码回退：无图谱时用包 ID 派生的占位（保存时优先 skelCode 输入）。 */
        function skelDomainFallback(graph: OgGraph | null): string {
          if (graph && graph.package) return (graph.package.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12) || 'GEN')
          return 'GEN'
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
          // 画布状态与动作在 GraphWorkbench（主区视图与右栏 tab 共用；P1 修正）
          const [view, setView] = useState<'canvas' | 'list'>('canvas')
          // D4：清单视图的待审草案可见性——此前只有画布有虚线态与计数，
          // 走清单人审会误以为没有草案（压测 C1 观察）。
          const [pendingDrafts, setPendingDrafts] = useState<Array<Record<string, unknown>>>([])
          const [draftTick, setDraftTick] = useState(0)

          const reload = useCallback(async () => {
            if (!api || !selected) return
            setBusy('load')
            setError('')
            try {
              const p = unwrap<{ pkg: Record<string, unknown> }>(await api.load({ name: selected.name, version: selected.version }))
              setPkg(p.pkg)
              const f = unwrap<{ files: Record<string, string> }>(await api.readSources({ name: selected.name, version: selected.version }))
              setFiles(f.files)
              setDraftTick((n) => n + 1)
            } catch (e) {
              setError(errText(e))
            } finally {
              setBusy('')
            }
          }, [apis, selected])

          useEffect(() => {
            void reload()
          }, [reload])

          // 清单视图挂载/切换/包变更时拉取待审草案（画布态由 GraphWorkbench 自取，互不耦合）。
          useEffect(() => {
            const kApi = apis.remote['ontoKnowledge']
            if (view !== 'list' || !selected || !kApi) {
              setPendingDrafts([])
              return
            }
            let alive = true
            void kApi
              .listCandidates({ packageId: selected.name })
              .then((q) => {
                if (!alive) return
                const items = unwrap<{ items: Array<Record<string, unknown>> }>(q).items ?? []
                setPendingDrafts(items.filter((d) => d.status === 'pending'))
              })
              .catch(() => {
                if (alive) setPendingDrafts([])
              })
            return () => {
              alive = false
            }
          }, [apis, view, selected, draftTick])

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
            h(
              'div',
              { className: 'ogc-toolbar', style: { marginTop: 10 } },
              h('button', {
                className: view === 'canvas' ? 'ow-btn' : 'ow-btn ghost',
                onClick: () => setView('canvas'),
              }, t('canvasView')),
              h('button', {
                className: view === 'list' ? 'ow-btn' : 'ow-btn ghost',
                onClick: () => setView('list'),
              }, t('listView')),
            ),
            ...(view === 'canvas'
              ? [h(GraphWorkbench, { key: 'gw', t, apis, selected, onChanged: reload })]
              : [
                  // D4：待审草案先于物化清单可见（计数 + 明细 + 恢复提示）
                  h(
                    'div',
                    { key: 'pending-drafts', className: 'ow-row', style: { flexDirection: 'column', alignItems: 'stretch', gap: 4, marginBottom: 8 } },
                    h('b', { className: 'ow-note' }, `${t('draftCount')}：${pendingDrafts.length}`),
                    h('span', { className: 'ow-note' }, t('draftHint')),
                    ...pendingDrafts.slice(0, 40).map((d, i) =>
                      h(
                        'div',
                        { key: `pd-${i}`, className: 'ow-note' },
                        `${String(d.name ?? d.id ?? '')} · ${String(d.targetKind ?? '')} · ${String(d.layer ?? '')} · conf ${String(d.confidence ?? '')}${d.conclusionLike === true ? ' · 结论性→RedLine' : ''}${typeof (d.provenance as { runId?: string } | undefined)?.runId === 'string' ? ` · run:${(d.provenance as { runId: string }).runId}` : ''}`,
                      )),
                    pendingDrafts.length > 40
                      ? h('span', { className: 'ow-note' }, `… +${pendingDrafts.length - 40}`)
                      : null,
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
            // P-2：包根 backlog.md（附属文件）只读展示——读面由 exportVersion 携带
            ...(files['backlog.md']
              ? [
                  h(
                    Card,
                    { key: 'backlog', title: t('backlogTitle') },
                    h('pre', {
                      className: 'ow-note',
                      style: { whiteSpace: 'pre-wrap', margin: 0, maxHeight: 200, overflow: 'auto' },
                    }, files['backlog.md']),
                    h('p', { className: 'ow-note' }, t('backlogHint')),
                  ),
                ]
              : []),
            ]
            )
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
          // D11：签发前一键预检清单（校验写盘 → 派生 → 加载门禁；签发动作仍人工）
          const [preflight, setPreflight] = useState<string[] | null>(null)

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
              h(
                'button',
                {
                  className: 'ow-btn',
                  disabled: !!busy,
                  onClick: () =>
                    void act('preflight', async () => {
                      const lines: string[] = []
                      // 1) 校验写盘（质量报告落盘，同「执行校验」）
                      const vOut = unwrap<{ report: Record<string, unknown> }>(
                        await vApi!.validate({ name: selected.name, version: selected.version }),
                      )
                      setReport(vOut.report)
                      const vr = vOut.report as { score?: number; errors?: unknown[]; warnings?: unknown[] }
                      const errN = (vr.errors ?? []).length
                      const warnN = (vr.warnings ?? []).length
                      lines.push(
                        errN === 0
                          ? `✓ 校验：质量分 ${String(vr.score ?? '')}，错误 0，警告 ${warnN}`
                          : `✗ 校验：错误 ${errN} —— 先修复再签发`,
                      )
                      if (errN > 0) {
                        setPreflight(lines)
                        return
                      }
                      // 2) 派生（写 derived/** + manifest）
                      const dOut = unwrap<{ sources: number; derived: number; sourceDigest: string }>(
                        await dApi!.derive({ name: selected.name, version: selected.version }),
                      )
                      setDeriveInfo(`sources=${dOut.sources} derived=${dOut.derived} digest=${dOut.sourceDigest.slice(0, 12)}…`)
                      lines.push(`✓ 派生：sources=${dOut.sources}，derived=${dOut.derived}`)
                      // 3) 加载门禁
                      const g = unwrap<Record<string, unknown>>(
                        await dApi!.gate({ name: selected.name, version: selected.version }),
                      )
                      setGate(g)
                      lines.push(g['ok'] ? '✓ 加载门禁通过' : `✗ 加载门禁：${String(g['reason'] ?? '')}`)
                      if (g['ok']) lines.push('→ 可「提交评审」→ 人工签发（签发只能人工）')
                      setPreflight(lines)
                    }),
                },
                busy === 'preflight' ? t('busy') : t('preflightBtn'),
              ),
            ),
            preflight
              ? h(
                  'div',
                  { key: 'preflight', style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 } },
                  ...preflight.map((l, i) => h('div', { key: i, className: 'ow-note' }, l)),
                )
              : null,
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
          // 持久运行记录（run-insight S2.5）：workspace runs/ 落盘面，两轮对比 + 审计导出。
          const [runs, setRuns] = useState<Array<{
            runId: string
            scenarioId: string
            package: { name: string; version: string }
            datasetDigest: string
            auditPassed: boolean
            savedAt: string
          }>>([])
          const [selA, setSelA] = useState('')
          const [selB, setSelB] = useState('')
          const [diff, setDiff] = useState<Record<string, unknown> | null>(null)
          const [exportInfo, setExportInfo] = useState('')
          const api = apis.remote['ontoRuntime']

          const loadRuns = () => {
            if (!api) return
            void (async () => {
              try {
                const out = unwrap<{ runs: typeof runs }>(await api.listRuns())
                setRuns(out.runs)
              } catch (e) {
                setError(errText(e))
              }
            })()
          }

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

          useEffect(() => {
            loadRuns()
          }, [apis])

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
                        loadRuns()
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
            // 持久运行记录（S2.5）：列表 + 两轮对比 + 审计导出（只读薄视图）。
            h('h4', { className: 'ow-h2' }, t('runRecords')),
            h(
              'div',
              { className: 'ow-row' },
              h('span', { className: 'ow-note' }, t('selHint')),
              h(
                'button',
                {
                  className: 'ow-btn',
                  disabled: !!busy || !selA || !selB || selA === selB,
                  onClick: () =>
                    void (async () => {
                      setBusy('compare')
                      setError('')
                      setDiff(null)
                      try {
                        const out = unwrap<{ diff: Record<string, unknown> }>(
                          await api!.compareRuns({ runIdA: selA, runIdB: selB }),
                        )
                        setDiff(out.diff)
                      } catch (e) {
                        setError(errText(e))
                      } finally {
                        setBusy('')
                      }
                    })(),
                },
                busy === 'compare' ? t('busy') : t('compareBtn'),
              ),
              h('button', { className: 'ow-btn ghost', disabled: !!busy, onClick: () => loadRuns() }, t('refresh')),
            ),
            runs.length > 0
              ? h(
                  'table',
                  { className: 'ow-table' },
                  h(
                    'thead',
                    null,
                    h('tr', null,
                      h('th', null, 'A'), h('th', null, 'B'), h('th', null, 'runId'), h('th', null, t('scenario')),
                      h('th', null, t('name')), h('th', null, t('digest')), h('th', null, t('audit')),
                      h('th', null, t('savedAt')), h('th', null, t('actions'))),
                  ),
                  h(
                    'tbody',
                    null,
                    ...runs.map((r) =>
                      h(
                        'tr',
                        { key: r.runId },
                        h('td', null, h('input', {
                          type: 'radio', name: 'onto-run-a', checked: selA === r.runId,
                          onChange: () => setSelA(r.runId),
                        })),
                        h('td', null, h('input', {
                          type: 'radio', name: 'onto-run-b', checked: selB === r.runId,
                          onChange: () => setSelB(r.runId),
                        })),
                        h('td', { className: 'ow-mono' }, r.runId),
                        h('td', null, r.scenarioId),
                        h('td', null, `${r.package.name}@${r.package.version}`),
                        h('td', { className: 'ow-mono' }, r.datasetDigest),
                        h('td', null, h(Tag, {
                          text: r.auditPassed ? t('passed') : t('failed'),
                          tone: r.auditPassed ? 'ok' : 'err',
                        })),
                        h('td', null, r.savedAt),
                        h('td', null, h(
                          'button',
                          {
                            className: 'ow-btn ghost',
                            disabled: !!busy,
                            onClick: () =>
                              void (async () => {
                                setBusy('export')
                                setError('')
                                try {
                                  const out = unwrap<{ locator: string }>(
                                    await api!.exportAudit({ runId: r.runId }),
                                  )
                                  setExportInfo(out.locator)
                                } catch (e) {
                                  setError(errText(e))
                                } finally {
                                  setBusy('')
                                }
                              })(),
                          },
                          t('exportAuditBtn'),
                        )),
                      ),
                    ),
                  ),
                )
              : h('p', { className: 'ow-note' }, t('empty')),
            exportInfo
              ? h('p', { className: 'ow-note ow-mono' }, `${t('locator')}: ${exportInfo}`)
              : null,
            ...diffView(),
          )

          function diffView(): ReactNode[] {
            if (!diff) return []
            const d = diff as unknown as {
              runIdA: string
              runIdB: string
              sameDataset: boolean
              auditPassedA: boolean
              auditPassedB: boolean
              candidates: Array<{
                candidateId: string
                riskScoreA: number | null
                riskScoreB: number | null
                riskScoreDelta: number | null
                hitRuleIdsAdded: string[]
                hitRuleIdsRemoved: string[]
                pendingChecksAdded: string[]
                pendingChecksRemoved: string[]
              }>
              excludedAdded: Array<{ candidateId: string; ruleId: string }>
              excludedRemoved: Array<{ candidateId: string; ruleId: string }>
            }
            return [
              h('h4', { className: 'ow-h2' }, t('diffTitle')),
              h(
                'div',
                { className: 'ow-row' },
                h(Tag, { text: `${d.runIdA} → ${d.runIdB}` }),
                h(Tag, {
                  text: `${t('sameDataset')}: ${d.sameDataset ? t('passed') : t('failed')}`,
                  tone: d.sameDataset ? 'ok' : 'err',
                }),
                h(Tag, { text: `A ${d.auditPassedA ? t('passed') : t('failed')}`, tone: d.auditPassedA ? 'ok' : 'err' }),
                h(Tag, { text: `B ${d.auditPassedB ? t('passed') : t('failed')}`, tone: d.auditPassedB ? 'ok' : 'err' }),
                h(Tag, { text: t('humanReview'), tone: 'warn' }),
              ),
              h(
                'table',
                { className: 'ow-table' },
                h('thead', null, h('tr', null,
                  h('th', null, 'ID'), h('th', null, t('scoreAB')), h('th', null, t('hits')), h('th', null, t('pending')))),
                h(
                  'tbody',
                  null,
                  ...d.candidates.map((c) =>
                    h(
                      'tr',
                      { key: c.candidateId },
                      h('td', null, c.candidateId),
                      h('td', { className: 'ow-mono' },
                        `${c.riskScoreA ?? '—'} → ${c.riskScoreB ?? '—'}${c.riskScoreDelta === null ? '' : ` (Δ=${c.riskScoreDelta})`}`),
                      h('td', { className: 'ow-mono' },
                        [...c.hitRuleIdsAdded.map((x) => `+${x}`), ...c.hitRuleIdsRemoved.map((x) => `-${x}`)].join('\n') || '—'),
                      h('td', { className: 'ow-mono' },
                        [...c.pendingChecksAdded.map((x) => `+${x}`), ...c.pendingChecksRemoved.map((x) => `-${x}`)].join('\n') || '—'),
                    ),
                  ),
                ),
              ),
              d.excludedAdded.length + d.excludedRemoved.length > 0
                ? h('p', { className: 'ow-note' },
                    `${t('excluded')}: ${[
                      ...d.excludedAdded.map((x) => `+${x.candidateId}←${x.ruleId}`),
                      ...d.excludedRemoved.map((x) => `-${x.candidateId}←${x.ruleId}`),
                    ].join(', ')}`)
                : null,
            ]
          }

          function cand(x: { candidateId: string }): string {
            return x.candidateId
          }
        }

        /* ═══════════════════════════════════════════════════════════════
         * 经验闭环（experience-loop P2-1）：经验列表 + 人审回填
         * ═══════════════════════════════════════════════════════════════ */

        function ExperiencePanel(props: {
          t: (k: string) => string
          apis: Ctx
        }) {
          const { t, apis } = props
          const [rows, setRows] = useState<Array<{
            runId: string
            scenarioId: string
            packageScope: string
            outcome: string
            counterexample: boolean
            reusedFrom: string | null
            misTransferJudged: boolean
            reviewFocus: string[]
            savedAt: string
          }>>([])
          const [error, setError] = useState('')
          const [busy, setBusy] = useState('')
          const [viewRun, setViewRun] = useState('')
          const [viewNote, setViewNote] = useState<Record<string, unknown> | null>(null)
          // 回填表单
          const [formOutcome, setFormOutcome] = useState('')
          const [formReason, setFormReason] = useState('')
          // 三态：'' 不改 | 'true' 判误迁移 | 'false' 判非误迁移（by 两者皆必填）
          const [formMis, setFormMis] = useState('')
          const [formBy, setFormBy] = useState('')
          const [formNote, setFormNote] = useState('')
          const [formFocus, setFormFocus] = useState('')
          const api = apis.remote['ontoRuntime']

          const load = () => {
            if (!api) return
            void (async () => {
              try {
                const out = unwrap<{ experiences: typeof rows }>(await api.listExperiences())
                setRows(out.experiences)
              } catch (e) {
                setError(errText(e))
              }
            })()
          }

          useEffect(() => {
            load()
          }, [apis])

          const review = (runId: string) => {
            if (!api) return
            void (async () => {
              setBusy('review')
              setError('')
              try {
                const patch: Record<string, unknown> = { runId }
                if (formOutcome) patch.outcome = formOutcome
                if (formReason.trim()) patch.outcomeReason = formReason
                if (formMis === 'true' || formMis === 'false') {
                  patch.misTransfer = { judged: formMis === 'true', by: formBy, note: formNote }
                }
                if (formFocus.trim()) patch.reviewFocus = formFocus.split(',').map((s) => s.trim()).filter(Boolean)
                const out = unwrap<{ note: Record<string, unknown> }>(await api.reviewExperience(patch as never))
                setViewNote(out.note)
                load()
              } catch (e) {
                setError(errText(e))
              } finally {
                setBusy('')
              }
            })()
          }

          return h(
            'div',
            { className: 'ow-card' },
            h('h3', { className: 'ow-h2' }, t('expTitle')),
            h('p', { className: 'ow-note' }, t('expReviewHint')),
            h(ErrorBanner, { text: error }),
            h(
              'div',
              { className: 'ow-row' },
              h('button', { className: 'ow-btn ghost', disabled: !!busy, onClick: () => load() }, t('refresh')),
            ),
            rows.length > 0
              ? h(
                  'table',
                  { className: 'ow-table' },
                  h(
                    'thead',
                    null,
                    h('tr', null,
                      h('th', null, 'runId'), h('th', null, t('scenario')), h('th', null, 'scope'),
                      h('th', null, t('expOutcome')), h('th', null, t('expCounter')),
                      h('th', null, t('expReused')), h('th', null, t('expMis')),
                      h('th', null, t('expFocus')), h('th', null, t('savedAt')), h('th', null, t('actions'))),
                  ),
                  h(
                    'tbody',
                    null,
                    ...rows.map((r) =>
                      h(
                        'tr',
                        { key: r.runId },
                        h('td', { className: 'ow-mono' }, r.runId),
                        h('td', null, r.scenarioId),
                        h('td', null, r.packageScope),
                        h('td', null, h(Tag, {
                          text: r.outcome,
                          tone: r.outcome === 'success' ? 'ok' : r.outcome === 'failure' ? 'err' : 'warn',
                        })),
                        h('td', null, r.counterexample ? '✓' : '—'),
                        h('td', { className: 'ow-mono' }, r.reusedFrom ?? '—'),
                        h('td', null, r.misTransferJudged ? '✓' : '—'),
                        h('td', null, r.reviewFocus.join(', ') || '—'),
                        h('td', null, r.savedAt),
                        h('td', null, h(
                          'button',
                          {
                            className: 'ow-btn ghost',
                            disabled: !!busy,
                            onClick: () =>
                              void (async () => {
                                setBusy('show')
                                setError('')
                                setViewRun(r.runId)
                                setFormOutcome('')
                                setFormReason('')
                                setFormMis('')
                                setFormBy('')
                                setFormNote('')
                                setFormFocus(r.reviewFocus.join(', '))
                                try {
                                  const out = unwrap<{ note: Record<string, unknown> }>(
                                    await api!.showExperience({ runId: r.runId }),
                                  )
                                  setViewNote(out.note)
                                } catch (e) {
                                  setError(errText(e))
                                } finally {
                                  setBusy('')
                                }
                              })(),
                          },
                          t('expReviewBtn'),
                        )),
                      ),
                    ),
                  ),
                )
              : h('p', { className: 'ow-note' }, t('empty')),
            viewRun && viewNote
              ? h(
                  'div',
                  { className: 'ow-row' },
                  h('span', { className: 'ow-stat' }, `${viewRun}`),
                  h('select', {
                    className: 'ow-sel',
                    value: formOutcome,
                    onChange: (e: { target: { value: string } }) => setFormOutcome(e.target.value),
                  },
                    h('option', { value: '' }, '—'),
                    h('option', { value: 'success' }, 'success'),
                    h('option', { value: 'partial' }, 'partial'),
                    h('option', { value: 'failure' }, 'failure'),
                    h('option', { value: 'pending-human' }, 'pending-human')),
                  h('input', {
                    className: 'ow-in',
                    placeholder: t('expReason'),
                    value: formReason,
                    onChange: (e: { target: { value: string } }) => setFormReason(e.target.value),
                  }),
                  h('select', {
                    className: 'ow-sel',
                    value: formMis,
                    onChange: (e: { target: { value: string } }) => setFormMis(e.target.value),
                  },
                    h('option', { value: '' }, `${t('expMis')} —`),
                    h('option', { value: 'true' }, `${t('expMis')} true`),
                    h('option', { value: 'false' }, `${t('expMis')} false`)),
                  formMis !== ''
                    ? h('input', {
                        className: 'ow-in',
                        placeholder: t('expMisBy'),
                        value: formBy,
                        onChange: (e: { target: { value: string } }) => setFormBy(e.target.value),
                      })
                    : null,
                  formMis !== ''
                    ? h('input', {
                        className: 'ow-in',
                        placeholder: t('expMisNote'),
                        value: formNote,
                        onChange: (e: { target: { value: string } }) => setFormNote(e.target.value),
                      })
                    : null,
                  h('input', {
                    className: 'ow-in',
                    placeholder: t('expFocus'),
                    value: formFocus,
                    onChange: (e: { target: { value: string } }) => setFormFocus(e.target.value),
                  }),
                  h(
                    'button',
                    {
                      className: 'ow-btn',
                      disabled:
                        !!busy ||
                        (!formOutcome && !formReason.trim() && formMis === '' && !formFocus.trim()),
                      onClick: () => review(viewRun),
                    },
                    t('expReviewBtn'),
                  ),
                )
              : null,
          )
        }

        /* ═══════════════════════════════════════════════════════════════
         * 根组件：tabs + 选中包状态
         * ═══════════════════════════════════════════════════════════════ */

        function AppRoot(props: { t: (k: string) => string; ctx: Ctx }) {
          const { t, ctx: apis } = props
          const [tab, setTab] = useState('packages')
          const [versions, setVersions] = useState<VersionRow[]>([])
          // 与右栏图谱 tab 共享的包选中态（P1 修正）
          const [selected, setSelected] = useSharedSelected()
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
            ['experience', t('tabExperience')],
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
                    : tab === 'experience'
                      ? h(ExperiencePanel, { t, apis })
                      : h(RunPanel, { t, apis, selected }),
          )
        }

        /* ═══════════════════════════════════════════════════════════════
         * 右栏「本体图谱」tab：对话留 main，图谱常驻右栏（P1 修正）
         * ═══════════════════════════════════════════════════════════════ */

        function GraphRightTab() {
          const [selected, setSelected] = useSharedSelected()
          const [versions, setVersions] = useState<VersionRow[]>([])
          const [listError, setListError] = useState('')
          useEffect(() => {
            const api = ctx.remote['ontoWorkspace']
            if (!api) return
            void (async () => {
              try {
                const out = unwrap<VersionRow[]>(await api.listVersions())
                const rows = Array.isArray(out) ? out : []
                setVersions(rows)
                setListError('')
                // 未选包时自动选第一个（右栏首开即有图）
                if (!selectedStore.get() && rows.length > 0) {
                  selectedStore.set({ name: rows[0].name, version: rows[0].version })
                }
              } catch (e) {
                setListError(errText(e))
              }
            })()
          }, [])
          const selValue = selected ? `${selected.name}@${selected.version}` : ''
          return h(
            'div',
            { className: 'ow-wrap ogc-right' },
            h(
              'div',
              { className: 'ow-row' },
              h('span', { className: 'ow-label' }, t('rightSelected')),
              h(
                'select',
                {
                  className: 'ow-sel',
                  value: selValue,
                  onChange: (e: { target: { value: string } }) => {
                    const v = e.target.value
                    const at = v.lastIndexOf('@')
                    if (at > 0) setSelected({ name: v.slice(0, at), version: v.slice(at + 1) })
                  },
                },
                versions.length === 0
                  ? h('option', { key: '', value: '' }, t('none'))
                  : null,
                ...versions.map((v) =>
                  h(
                    'option',
                    { key: `${v.name}@${v.version}`, value: `${v.name}@${v.version}` },
                    `${v.name}@${v.version}（${v.status}）`,
                  )),
              ),
            ),
            listError ? h(ErrorBanner, { text: listError }) : null,
            selected
              ? h(GraphWorkbench, { t, apis: ctx, selected })
              : h('p', { className: 'ow-note' }, t('none')),
          )
        }

        // 右栏 tab 类型（guide 卡片可发现）+ tab 内容席位
        ctx.effect(
          () =>
            ctx.sidebarRightTabs.register({
              id: GRAPH_TAB_ID,
              kind: GRAPH_TAB_KIND,
              title: () => t('graphTabTitle'),
              guide: [
                {
                  id: 'main',
                  order: 100,
                  title: () => t('graphTabTitle'),
                  description: () => t('graphTabDesc'),
                },
              ],
            }),
          'dsh-onto-workbench: ontology-graph tab',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                { name: 'sidebar.right.pane.tab', key: GRAPH_TAB_ID, locale: NS },
                GraphRightTab,
              ),
            ),
          'dsh-onto-workbench: ontology-graph body',
        )

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
