/**
 * llmpath.mjs —— 在“源码同层 bili-op”和“插件内置 bili-op”两种布局下找到模型客户端
 *
 * 本地开发：dsh-bili-workbench/engine → ../../bili-op
 * 插件安装：.../dsh-bili-workbench/engine → ../bili-op
 */
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const BILI_OP = process.env.BILI_OP_DIR
  || (existsSync(join(HERE, '..', 'bili-op', 'llm.mjs'))
    ? join(HERE, '..', 'bili-op')
    : join(HERE, '..', '..', 'bili-op'))

export async function loadLLM() {
  return import(pathToFileURL(join(BILI_OP, 'llm.mjs')).href)
}
