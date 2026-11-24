// SPDX-License-Identifier: GPL-3.0-only
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const start = '<!-- dsh-install:start -->'
export const end = '<!-- dsh-install:end -->'
const graphName = 'dsh-better-task-grapth'
const dynamicName = 'dsh-dynamic-context'
const ticks = value => String.fromCharCode(96) + value + String.fromCharCode(96)
const requireValue = (ok, reason) => { if (!ok) throw new Error('INSTALL_DOCS_INVALID: ' + reason) }

export function renderInstallBlock(pkg, line) {
  const graph = pkg.name === graphName
  requireValue(graph || pkg.name === dynamicName, 'package.json/name: unsupported package')
  requireValue(line.schema === 1 && Number.isInteger(line.updateRound) && line.updateRound >= 0
    && Number.isInteger(line.slot) && line.slot >= 0 && line.slot < 10, 'DSH-COMPATIBILITY.json: invalid round or slot')
  for (const key of ['taskgraph', 'dynamicContext']) requireValue(
    new RegExp('^\\d+\\.\\d+\\.\\d+-rc\\.' + (line.updateRound * 10 + line.slot) + '$').test(line[key]),
    'DSH-COMPATIBILITY.json/' + key + ': version does not match round and slot')
  requireValue(pkg.version === line[graph ? 'taskgraph' : 'dynamicContext'], 'package.json/version: differs from compatibility manifest')
  requireValue(Array.isArray(line.hosts) && line.hosts.length > 0 && line.hosts[0] === line.host
    && new Set(line.hosts).size === line.hosts.length
    && line.hosts.every(host => /^\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/.test(host)), 'DSH-COMPATIBILITY.json/hosts: invalid exact host list')
  requireValue(pkg.engines?.dsh === line.hosts.join(' || '), 'package.json/engines/dsh: differs from compatibility manifest')
  requireValue(pkg.publishConfig?.tag === line.channel && line.branch === (line.channel === 'next' ? 'main' : line.host),
    'package.json/publishConfig/tag: branch or channel differs')
  if (!graph) {
    requireValue(pkg.peerDependencies?.[graphName] === line.taskgraph, 'package.json/peerDependencies/' + graphName + ': exact companion mismatch')
    requireValue(pkg.devDependencies?.[graphName] === line.taskgraph, 'package.json/devDependencies/' + graphName + ': exact companion mismatch')
  }
  const profile = graph ? 'bettertaskgraphs' : 'task-context'
  const builds = [[graphName, line.taskgraph], ...(graph ? [] : [[dynamicName, line.dynamicContext]])]
  const exact = builds.map(([name, version]) => name + '@' + version)
  const files = builds.map(([name, version]) => '"$PWD/' + name + '-' + version + '.tgz"')
  const install = values => values.map(value => 'dsh plugin --profile ' + profile + ' add ' + value)
  return [start, '<!-- Generated from package.json and DSH-COMPATIBILITY.json. -->',
    '## 选择与 DSH 配套的构建', '',
    '本包 ' + ticks(pkg.name + '@' + pkg.version) + ' 的目标标签为 ' + ticks(line.channel) + '。本线支持的 DSH 精确版本为 ' + line.hosts.map(ticks).join('、') + '。插件 Node.js 要求为 ' + ticks(pkg.engines.node) + '，还须满足所选 DSH 本身的 Node.js 要求。', '',
    '插件的 ' + ticks('latest') + ' 跟随官方 DSH 的 ' + ticks('latest') + '，插件的 ' + ticks('next') + ' 跟随官方 DSH 的 ' + ticks('alpha') + '。两个插件须使用同一行的 RC 后缀。npm 标签可移动，安装前先运行 ' + ticks('dsh --version') + '。[本构建兼容清单](DSH-COMPATIBILITY.json)', '',
    '使用 Linux 或 WSL 中的 Linux 版 Node.js。原生 Windows 与 macOS 会收到 npm 的 ' + ticks('EBADPLATFORM') + '。本版工作流兼容周期为 ' + ticks(String(pkg.workflowCompatibilityEpoch)) + '。', '',
    ...(line.hostPreparation?.[graph ? 'taskgraph' : 'dynamicContext']
      ? ['本维护线需要一次宿主适配。在安装 Bundle 后、启动 Web 前，将 BUNDLE_DIR 指向当前已解包的插件，DSH_NODE_MODULES 指向实际运行 DSH 的 node_modules，运行以下命令再启动或重启 DSH。', '',
        '```sh', 'node "$BUNDLE_DIR/' + line.hostPreparation[graph ? 'taskgraph' : 'dynamicContext'] + '" "$DSH_NODE_MODULES"', '```', ''] : []),
    '### 安装本地候选包或已下载的 Release 附件', '',
    '将对应宿主的一组 .tgz 放在当前目录。以下命令安装到 ' + ticks(profile) + ' profile。首次创建时选用未占用的名称并运行下列第一条命令，已有 profile 从安装命令开始。', '',
    '```sh', 'dsh --profile ' + profile + ' --from-default-profile web --dump-config', ...install(files), 'dsh --profile ' + profile + ' web', '```', '',
    graph ? '单独安装提供独立任务图。完整单元模式还需在同一 profile 加入 ' + ticks(dynamicName + '@' + line.dynamicContext) + '。' : '先安装任务图基础包，再安装动态上下文。初装即启用。在新会话输入 ' + ticks('/task-graph [任务说明]') + ' 进入完整单元流程，普通聊天沿用 DSH 原流程。', '',
    '### 从 npm 安装', '',
    '下面的查询会访问公共登记库。只有两包所需版本均已公开（独立安装只需基础包）时才运行安装。若查询返回 E404，使用上一节的本地包。', '',
    '```sh', builds.map(([name, v]) => 'npm view --registry=https://registry.npmjs.org/ ' + name + '@' + v + ' version').join(' && ') + ' &&', install(exact).join(' &&\n'), '```', '',
    '### 从对应版本的源码构建', '',
    '在该维护线源码目录内运行下列命令。配套任务图尚未进入公共登记库时，构建动态上下文前先用 ' + ticks('npm cache add ./dsh-better-task-grapth-' + line.taskgraph + '.tgz') + ' 缓存同批基础包。', '',
    '```sh', 'npm ci --prefer-offline', 'mkdir -p .test-tmp', 'TMPDIR="$PWD/.test-tmp" npm test', 'npm run pack:bundle', '```', '',
    '产物为 ' + ticks('dist/' + pkg.name + '-' + pkg.version + '.tgz') + '。打开包内 [HTML 运行图谱](docs/UNIT_WORKFLOW_20261123.html) 可离线查阅流程、角色原文和联动指南。', end].join('\n')
}

export function syncReadme(readme, pkg, line) {
  requireValue(readme.split(start).length === 2 && readme.split(end).length === 2
    && readme.indexOf(start) < readme.indexOf(end), 'README.md: expected one installation block')
  const a = readme.indexOf(start), b = readme.indexOf(end) + end.length
  return readme.slice(0, a) + renderInstallBlock(pkg, line) + readme.slice(b)
}

export function checkReadme(readme, pkg, line) {
  const expected = syncReadme(readme, pkg, line)
  if (readme !== expected) {
    let offset = 0
    while (readme[offset] === expected[offset]) offset++
    const row = readme.slice(0, offset).split('\n').length
    throw new Error(`INSTALL_DOCS_STALE: README.md:${row}: run npm run docs:sync; expected ${pkg.name}@${pkg.version}, task graph ${line.taskgraph}`)
  }
  const outside = readme.slice(0, readme.indexOf(start)) + readme.slice(readme.indexOf(end) + end.length)
  requireValue(!/dsh-(?:dynamic-context|better-task-grapth)(?:@|-)\d+\.\d+\.\d+-rc\.\d+(?:\.tgz)?/.test(outside),
    'README.md: install-version reference outside generated block')
  return true
}

export function releaseDocs(root, write = false) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const line = JSON.parse(fs.readFileSync(path.join(root, 'DSH-COMPATIBILITY.json'), 'utf8'))
  const atlas = 'docs/UNIT_WORKFLOW_20261123.html'
  requireValue(pkg.files.includes(atlas) && fs.statSync(path.join(root, atlas), { throwIfNoEntry: false })?.isFile(), 'Offline workflow atlas missing')
  const file = path.join(root, 'README.md'), readme = fs.readFileSync(file, 'utf8')
  if (write) fs.writeFileSync(file, syncReadme(readme, pkg, line))
  checkReadme(fs.readFileSync(file, 'utf8'), pkg, line)
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 3 || !['--write', '--check'].includes(process.argv[2])) throw new Error('Use --write or --check')
  releaseDocs(fileURLToPath(new URL('../', import.meta.url)), process.argv[2] === '--write')
}
