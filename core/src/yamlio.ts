/**
 * YAML 读写薄封装：包文件的序列化边界。
 */
import { parse, stringify } from 'yaml'

/** 解析 YAML 文档为普通对象；空文档返回 null。 */
export function loadYaml(text: string): unknown {
  return parse(text)
}

/** 将对象序列化为 YAML（键按插入序，2 空格缩进）。 */
export function dumpYaml(value: unknown): string {
  return stringify(value, { indent: 2, lineWidth: 100 })
}
