#!/usr/bin/env node
// validate-index.mjs — проверяет market/index.json по правилам формата 1
// (те же ограничения, что применяет @deepseek-ai/dsh-plugin-market-index).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const file = process.argv[2] ?? join(import.meta.dirname, '..', 'market', 'index.json')
const doc = JSON.parse(readFileSync(file, 'utf8'))
const errors = []

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/
const LANGUAGE_ID = /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/
const COMMIT = /^[0-9a-f]{40}$/
const SEGMENT = /^[A-Za-z0-9._@+-]+$/

function err(path, reason) {
  errors.push(`${path} ${reason}`)
}

function localized(value, path) {
  if (typeof value === 'string') return
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return err(path, 'must be a string or an object')
  for (const [lang, text] of Object.entries(value)) {
    if (!LANGUAGE_ID.test(lang)) err(`${path}.${lang}`, 'must be a language id')
    if (typeof text !== 'string' || !text.trim()) err(`${path}.${lang}`, 'must be a non-empty string')
  }
  if (!Object.hasOwn(value, 'en')) err(path, 'must contain en')
}

if (doc.format !== 1) err('$.format', 'must be 1')
localized(doc.title, '$.title')
if (doc.description !== undefined) localized(doc.description, '$.description')

const categories = Object.keys(doc.metadata?.categories ?? {})
const labels = Object.keys(doc.metadata?.labels ?? {})

const names = new Set()
for (const [position, plugin] of (doc.plugins ?? []).entries()) {
  const at = `$.plugins[${position}]`
  if (!PACKAGE_NAME.test(plugin.name ?? '')) err(`${at}.name`, 'must be a valid npm package name')
  if (names.has(plugin.name)) err(`${at}.name`, 'duplicates a previous plugin')
  names.add(plugin.name)

  if (plugin.title !== undefined) localized(plugin.title, `${at}.title`)
  if (plugin.description !== undefined) localized(plugin.description, `${at}.description`)

  if (plugin.metadata?.category && !categories.includes(plugin.metadata.category)) {
    err(`${at}.metadata.category`, 'references an undeclared category')
  }
  for (const label of plugin.metadata?.labels ?? []) {
    if (!labels.includes(label)) err(`${at}.metadata.labels`, `references undeclared label ${label}`)
  }

  if (plugin.repository) {
    if (!/^https?:\/\//.test(plugin.repository.url ?? '')) err(`${at}.repository.url`, 'must be http(s)')
    const directory = plugin.repository.directory
    if (directory && directory.split('/').some((s) => s === '.' || s === '..' || !SEGMENT.test(s))) {
      err(`${at}.repository.directory`, 'must be a relative path')
    }
  }

  const versions = plugin.versions ?? []
  if (!Array.isArray(versions) || versions.length === 0) err(`${at}.versions`, 'must be a non-empty array')
  const seen = new Set()
  for (const [i, version] of versions.entries()) {
    const vat = `${at}.versions[${i}]`
    if (!SEMVER.test(version.version ?? '')) err(`${vat}.version`, 'must be an exact SemVer version')
    if (seen.has(version.version)) err(`${vat}.version`, 'duplicates another version')
    seen.add(version.version)

    const ts = version.publishTimestamp
    if (!Number.isInteger(ts) || ts < 0 || ts >= 1e11) err(`${vat}.publishTimestamp`, 'must be integer Unix seconds')

    const source = version.source ?? {}
    if (source.type === 'npm') {
      if (source.registry && !/^https?:\/\//.test(source.registry)) err(`${vat}.source.registry`, 'must be http(s)')
    } else if (source.type === 'git') {
      if (!/^https:\/\//.test(source.url ?? '')) err(`${vat}.source.url`, 'must be https')
      if (source.url && !/^(?:\/[^/]+){2,}$/.test(new URL(source.url).pathname)) {
        err(`${vat}.source.url`, 'must name a repository with at least two path segments')
      }
      if (!COMMIT.test(source.commit ?? '')) err(`${vat}.source.commit`, 'must be a lowercase 40-hex commit')
      if (source.path && source.path.split('/').some((s) => s === '.' || s === '..' || !SEGMENT.test(s))) {
        err(`${vat}.source.path`, 'must be a relative package path')
      }
    } else {
      err(`${vat}.source.type`, 'must be "npm" or "git"')
    }
  }
}

if (errors.length) {
  console.error(`Найдено ошибок: ${errors.length}`)
  for (const message of errors) console.error(`  ${message}`)
  process.exit(1)
}

console.log(`ok: ${doc.plugins.length} плагина, формат 1 соблюдён`)
for (const plugin of doc.plugins) {
  const version = plugin.versions[0]
  console.log(`  ${plugin.name}@${version.version} → ${version.source.type} ${version.source.commit ?? ''} ${version.source.path ?? ''}`)
}
