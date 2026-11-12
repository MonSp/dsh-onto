import { h, useState, useEffect, useCallback, useMemo, useRef, setReact } from './react'
import type { ReactNode } from './types'
import type { Ctx, PluginModule } from './types'
import { zh, en } from './locale'
import { CSS } from './styles'
import { installT } from './i18n'
import { useSharedSelected } from './shared'
import { unwrap, errText, selectedStore } from './helpers'
import { Tag, Row, Card, ErrorBanner, OkBanner, Loading, Field, PipelineView } from './ui'
import { PackagesPanel, type VersionRow } from './panels/packages'
import { ModelPanel } from './panels/model'
import { KnowledgePanel } from './panels/knowledge'
import { ValidatePanel } from './panels/validate'
import { RunPanel } from './panels/run'
import { ExperiencePanel } from './panels/experience'
import { GraphWorkbench } from './workbench'

const NS = 'dsh-onto.workbench'
const PANEL_ID = 'dsh-onto-workbench'
/** 右栏「本体图谱」页型：kind 为打开名，id 为实现身份（pane.tab 的 key）。 */
const GRAPH_TAB_ID = '@dsh-onto/workbench'
const GRAPH_TAB_KIND = 'ontology-graph'

export function createPlugin(React: typeof import('react')): PluginModule {
  setReact(React)
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
      installT(t)

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
       * 根组件：tabs + 选中包状态
       * ═══════════════════════════════════════════════════════════════ */

      function AppRoot(props: { t: (k: string) => string; ctx: Ctx }) {
        const { t, ctx: apis } = props
        const [tab, setTab] = useState('packages')
        const [versions, setVersions] = useState<VersionRow[]>([])
        // 与右栏图谱 tab 共享的包选中态（P1 修正）
        const [selected, setSelectedRaw] = useSharedSelected()
        const [listError, setListError] = useState('')

        // 选中包 → 直接进画布（不再停在包表格）
        const setSelected = (s: { name: string; version: string } | null): void => {
          setSelectedRaw(s)
          if (s) setTab('model')
        }

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

        // 已有选中包时默认进画布
        useEffect(() => {
          if (selected && tab === 'packages') setTab('model')
        }, [selected])

        const nav: Array<[string, string, string]> = [
          ['model', t('tabModel'), '▣'],
          ['packages', t('tabPackages'), '☰'],
          ['knowledge', t('tabKnowledge'), '▤'],
          ['validate', t('tabValidate'), '✓'],
          ['run', t('tabRun'), '▶'],
          ['experience', t('tabExperience'), '◎'],
        ]

        const isCanvas = tab === 'model'

        return h(
          'div',
          { className: 'ow-shell' },
          h(
            'nav',
            { className: 'ow-nav', 'aria-label': t('title') },
            h('div', { className: 'brand' }, 'dsh-onto'),
            ...nav.map(([key, label, ico]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  className: tab === key ? 'on' : '',
                  onClick: () => setTab(key),
                  title: label,
                },
                h('span', { className: 'ico' }, ico),
                label,
              ),
            ),
          ),
          h(
            'div',
            { className: isCanvas ? 'ow-main canvas' : 'ow-main' },
            isCanvas
              ? null
              : h(
                  'div',
                  { className: 'ow-wrap', style: { paddingBottom: 8 } },
                  h(
                    'div',
                    { className: 'ow-head' },
                    h('h2', { className: 'ow-h1' }, t('title')),
                    h('span', { className: 'ow-sub' }, t('subtitle')),
                    selected
                      ? h('span', { className: 'ow-stat' }, `${t('selected')}: ${selected.name}@${selected.version}`)
                      : h('span', { className: 'ow-stat' }, t('none')),
                  ),
                ),
            isCanvas && listError ? h(ErrorBanner, { text: `包列表：${listError}` }) : null,
            !isCanvas && listError ? h(ErrorBanner, { text: `包列表：${listError}` }) : null,
            isCanvas
              ? h(ModelPanel, { key: 'model', t, apis, selected })
              : h(
                  'div',
                  { className: 'ow-wrap' },
                  tab === 'packages'
                    ? h(PackagesPanel, { t, apis, versions, reload, selected, setSelected })
                    : tab === 'knowledge'
                      ? h(KnowledgePanel, { t, apis, selected })
                      : tab === 'validate'
                        ? h(ValidatePanel, { t, apis, selected })
                        : tab === 'experience'
                          ? h(ExperiencePanel, { t, apis })
                          : h(RunPanel, { t, apis, selected }),
                ),
          ),
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
            ? h(
                'div',
                { className: 'ogc-right-fill' },
                h(GraphWorkbench, { t, apis: ctx, selected }),
              )
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
}
