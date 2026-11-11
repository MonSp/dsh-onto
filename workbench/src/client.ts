/**
 * dsh-onto 工作台 client half —— browser entry（classic script，零 runtime import/export）。
 *
 * 六个 tab：包管理 | 建模 | 知识库 | 校验派生 | 场景运行 | 经验。
 * 远程命名空间：ontoWorkspace / ontoModel / ontoValidate / ontoDerive /
 * ontoKnowledge / ontoRuntime（inject 必须列全）。
 *
 * 源码拆分见 ./client/*；esbuild 打成单文件 IIFE 到 dist/client.js。
 */

import { createPlugin } from './client/app'

declare global {
  interface Window {
    __ModuleLoader__: {
      load(entry: { id: string; factory(require: (id: string) => unknown): unknown }): void
    }
  }
}

window.__ModuleLoader__.load({
  id: '@dsh-onto/workbench',
  factory(require) {
    const React = require('react') as typeof import('react')
    return createPlugin(React)
  },
})
