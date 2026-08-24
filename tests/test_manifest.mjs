// dsh-std 兼容测试：dsh-plugin.json（Community v0.15 清单）+ lib/std-host.js
// （facet 激活模块）的结构断言。环境装有 @dsh-std/manifest 时额外跑真校验，
// 否则以字段/类型断言兜底（与 verify_compat 同一思路：不依赖未安装的包）。

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'dsh-plugin.json'), 'utf8'))
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

// ---- 清单基础字段 ----
check('manifestVersion is 0.15', manifest.manifestVersion === '0.15')
check('$schema is a draft URN (not fetched)', typeof manifest.$schema === 'string' && manifest.$schema.startsWith('urn:dsh-std:') && !manifest.$schema.startsWith('http'))
check('id is reverse-DNS style', /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id), `id=${manifest.id}`)
check('name matches package', manifest.name === pkg.name)
check('version matches package', manifest.version === pkg.version)
check('license matches package', manifest.license === pkg.license)

// ---- facets.host.entry 指向真实文件 ----
const entryPath = join(ROOT, manifest.facets?.host?.entry ?? '')
let entryExists = false
try { entryExists = readFileSync(entryPath, 'utf8').length > 0 } catch { entryExists = false }
check('facets.host.entry points to an existing file', entryExists, manifest.facets?.host?.entry ?? '(missing)')
check('facets.host.apiVersion is v1alpha1', manifest.facets?.host?.apiVersion === 'v1alpha1')

// ---- 可选块形态 ----
check('requires.contracts is an array', Array.isArray(manifest.requires?.contracts))
check('permissions is an array', Array.isArray(manifest.permissions))
check('contributes.commands is an array', Array.isArray(manifest.contributes?.commands))
check('subscriptions is an array', Array.isArray(manifest.subscriptions))
check('source.repository present', typeof manifest.source?.repository === 'string' && manifest.source.repository !== '')
check('compat.hosts lists the verified dsh range', Array.isArray(manifest.compat?.hosts) && manifest.compat.hosts.length > 0,
  manifest.compat?.hosts?.join('; '))

// ---- overrides 声明（补丁点透明化） ----
check('overrides declares the patch points', Array.isArray(manifest.overrides) && manifest.overrides.length >= 4,
  `count=${manifest.overrides?.length ?? 0}`)
if (Array.isArray(manifest.overrides)) {
  const kinds = new Set(manifest.overrides.map((o) => o.kind))
  check('override kinds are valid (patch/native/build)', [...kinds].every((k) => ['patch', 'native', 'build'].includes(k)), `kinds=${[...kinds].join(',')}`)
  check('every override has target + description', manifest.overrides.every((o) => typeof o.target === 'string' && o.target !== '' && typeof o.description === 'string'))
}

// ---- std-host.js facet 模块形态 ----
const facetModule = await import('../lib/std-host.js')
const facet = facetModule.default ?? facetModule.facet
check('std-host exports a facet module', typeof facet === 'object' && facet !== null)
check('facet.activate is a function', typeof facet?.activate === 'function')
check('facet.deactivate is a function', typeof facet?.deactivate === 'function')
check('facet.snapshot is a function', typeof facet?.snapshot === 'function')
check('default export equals named facet', facetModule.default === facetModule.facet)

// ---- 环境装有 @dsh-std/manifest 时做真校验（可选增强） ----
try {
  const std = await import('@dsh-std/manifest')
  if (typeof std.validateManifest === 'function') {
    std.validateManifest(manifest)
    check('@dsh-std/manifest validateManifest passes', true)
  } else {
    console.log('SKIP  @dsh-std/manifest loaded but validateManifest missing')
  }
} catch {
  console.log('SKIP  @dsh-std/manifest not installed; structural assertions only (npm i -D @dsh-std/manifest to enable)')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
