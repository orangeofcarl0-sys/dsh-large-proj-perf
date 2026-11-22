// V8 heap snapshot 分析：self size 汇总 + 单目标 retained size / retainer path。
//
// 旧版只读 nodes[].self_size，无法回答“一个 Session.log 到底保留了多少”。
// 新版解析 edges、建反向邻接，并支持按目标做“阻塞 BFS”：
//   retained(target) = 把 target 从图中移除后，从 root 不可达的节点 self_size 之和
//
//   node --max-old-space-size=8192 tools/runtime-probe/analyze-heap.mjs <snapshot> \
//     [--target session:<id>|log:<id>|node:<nodeIndex>] [--json]
//
// 目标识别依赖 V8 snapshot 的构造名与属性边（Session.header.id /
// Session.log / Session.eventsSnapshot / Session.derived）。私有字段可能随 dsh
// 版本变化；找不到时输出可用的 summary，不抛错。

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const MiB = (bytes) => (bytes / 1048576).toFixed(1)

export function createSnapshotView(snapshot) {
  const meta = snapshot.snapshot?.meta
  if (meta === undefined) throw new Error('not a V8 heap snapshot: snapshot.meta is missing')
  const nodeFields = meta.node_fields
  const edgeFields = meta.edge_fields
  const nodeStride = nodeFields.length
  const edgeStride = edgeFields.length
  const typeNames = meta.node_types[0]
  const edgeTypeNames = meta.edge_types[0]
  const strings = snapshot.strings
  const nodeCount = snapshot.snapshot.node_count ?? snapshot.nodes.length / nodeStride
  const edgeCount = snapshot.snapshot.edge_count ?? snapshot.edges.length / edgeStride
  if (snapshot.nodes.length !== nodeCount * nodeStride) throw new Error('node array length does not match node_count')
  if (snapshot.edges.length !== edgeCount * edgeStride) throw new Error('edge array length does not match edge_count')

  const nodes = Int32Array.from(snapshot.nodes)
  const edges = Int32Array.from(snapshot.edges)
  const selfOff = nodeFields.indexOf('self_size')
  const edgeCountOff = nodeFields.indexOf('edge_count')
  const nameOff = nodeFields.indexOf('name')
  const typeOff = nodeFields.indexOf('type')
  if ([selfOff, edgeCountOff, nameOff, typeOff].some((offset) => offset < 0)) {
    throw new Error(`unsupported node_fields: ${nodeFields.join(',')}`)
  }

  const edgeStart = new Int32Array(nodeCount + 1)
  for (let i = 0; i < nodeCount; i++) {
    edgeStart[i + 1] = edgeStart[i] + nodes[i * nodeStride + edgeCountOff]
  }
  if (edgeStart[nodeCount] !== edgeCount) throw new Error('edge_count sum does not match edge_count')

  const nodeType = (index) => typeNames[nodes[index * nodeStride + typeOff]]
  const nodeName = (index) => strings[nodes[index * nodeStride + nameOff]] ?? `<${nodes[index * nodeStride + nameOff]}>`
  const nodeSelf = (index) => nodes[index * nodeStride + selfOff]
  const edgeTarget = (edgeIndex) => edges[edgeIndex * edgeStride + 2] / nodeStride
  const edgeType = (edgeIndex) => edgeTypeNames[edges[edgeIndex * edgeStride]]

  const edgeName = (edgeIndex) => {
    const type = edgeType(edgeIndex)
    const raw = edges[edgeIndex * edgeStride + 1]
    if (type === 'element' || type === 'hidden') return `[${raw}]`
    return strings[raw] ?? `#${raw}`
  }

  const outEdges = (nodeIndex) => {
    const result = []
    for (let e = edgeStart[nodeIndex]; e < edgeStart[nodeIndex + 1]; e++) result.push(e)
    return result
  }
  const findProperty = (nodeIndex, name, wantedType) => {
    for (let e = edgeStart[nodeIndex]; e < edgeStart[nodeIndex + 1]; e++) {
      if (wantedType !== undefined && edgeType(e) !== wantedType) continue
      if (edgeName(e) === name) return e
    }
    return -1
  }
  const propertyTarget = (nodeIndex, name, wantedType = 'property') => {
    const e = findProperty(nodeIndex, name, wantedType)
    return e === -1 ? -1 : edgeTarget(e)
  }
  const propertyString = (nodeIndex, name) => {
    const target = propertyTarget(nodeIndex, name)
    if (target < 0 || nodeType(target) !== 'string') return null
    return nodeName(target)
  }
  const isArrayLike = (nodeIndex) => nodeType(nodeIndex) === 'array'
    || (nodeType(nodeIndex) === 'object' && nodeName(nodeIndex) === 'Array')
  const arrayInfo = (nodeIndex) => {
    if (nodeIndex < 0 || !isArrayLike(nodeIndex)) return null
    let directElements = 0
    let backingElements = 0
    let internalBytes = 0
    for (let e = edgeStart[nodeIndex]; e < edgeStart[nodeIndex + 1]; e++) {
      if (edgeType(e) === 'element') {
        directElements += 1
      } else if (edgeType(e) === 'internal') {
        const target = edgeTarget(e)
        internalBytes += nodeSelf(target)
        // 冻结/COW 数组把元素放在 "(object elements)" backing store 的
        // 编号 internal 边里；只在没有直接 element 边时用它计数，避免双算。
        if (nodeType(target) === 'array') {
          let count = 0
          for (let inner = edgeStart[target]; inner < edgeStart[target + 1]; inner++) {
            if (edgeType(inner) === 'internal' && /^\[?\d+\]?$/.test(edgeName(inner))) count += 1
          }
          backingElements = Math.max(backingElements, count)
        }
      }
    }
    return {
      self: nodeSelf(nodeIndex),
      elements: directElements > 0 ? directElements : backingElements,
      internalBytes,
      total: nodeSelf(nodeIndex) + internalBytes,
    }
  }

  const totalSelf = (() => {
    let total = 0
    for (let i = 0; i < nodeCount; i++) total += nodeSelf(i)
    return total
  })()

  const retainedCache = new Map()
  const retainedSize = (target) => {
    if (retainedCache.has(target)) return retainedCache.get(target)
    const visited = new Uint8Array(nodeCount)
    const queue = new Int32Array(nodeCount)
    let head = 0
    let tail = 0
    visited[0] = 1
    queue[tail++] = 0
    while (head < tail) {
      const current = queue[head++]
      for (let e = edgeStart[current]; e < edgeStart[current + 1]; e++) {
        if (edgeType(e) === 'weak') continue
        const next = edgeTarget(e)
        if (next === target || visited[next] === 1) continue
        visited[next] = 1
        queue[tail++] = next
      }
    }
    let retained = 0
    for (let i = 0; i < nodeCount; i++) if (visited[i] === 0) retained += nodeSelf(i)
    retainedCache.set(target, retained)
    return retained
  }

  // 反向邻接按需构建（retainer path 用；大快照约 2 × edges × 4B）。
  let reverse = null
  const buildReverse = () => {
    if (reverse !== null) return reverse
    const revStart = new Int32Array(nodeCount + 1)
    let strong = 0
    for (let e = 0; e < edgeCount; e++) {
      if (edgeType(e) === 'weak') continue
      const to = edgeTarget(e)
      revStart[to + 1] += 1
      strong += 1
    }
    for (let i = 0; i < nodeCount; i++) revStart[i + 1] += revStart[i]
    const cursor = revStart.slice()
    const revFrom = new Int32Array(strong)
    const revEdge = new Int32Array(strong)
    for (let from = 0; from < nodeCount; from++) {
      for (let e = edgeStart[from]; e < edgeStart[from + 1]; e++) {
        if (edgeType(e) === 'weak') continue
        const to = edgeTarget(e)
        const slot = cursor[to]++
        revFrom[slot] = from
        revEdge[slot] = e
      }
    }
    reverse = { revStart, revFrom, revEdge }
    return reverse
  }

  const retainerPath = (target) => {
    if (target === 0) return []
    const { revStart, revFrom, revEdge } = buildReverse()
    const prev = new Int32Array(nodeCount).fill(-1)
    const via = new Int32Array(nodeCount).fill(-1)
    const queue = new Int32Array(nodeCount)
    let head = 0
    let tail = 0
    prev[target] = target
    queue[tail++] = target
    while (head < tail) {
      const current = queue[head++]
      if (current === 0) break
      for (let slot = revStart[current]; slot < revStart[current + 1]; slot++) {
        const from = revFrom[slot]
        if (prev[from] !== -1) continue
        prev[from] = current
        via[from] = revEdge[slot]
        queue[tail++] = from
      }
    }
    if (prev[0] === -1) return []
    const path = []
    let current = 0
    while (current !== target) {
      const next = prev[current]
      if (next === -1) break
      const edge = via[current]
      path.push({
        from: current,
        fromName: nodeName(current),
        fromType: nodeType(current),
        edge: edge === -1 ? null : edgeName(edge),
        edgeType: edge === -1 ? null : edgeType(edge),
        to: next,
        toName: nodeName(next),
        toType: nodeType(next),
      })
      current = next
    }
    return path
  }

  const findSessions = () => {
    const sessions = []
    for (let i = 0; i < nodeCount; i++) {
      if (nodeType(i) !== 'object' || nodeName(i) !== 'Session') continue
      const header = propertyTarget(i, 'header')
      const id = header < 0 ? null : propertyString(header, 'id')
      const fields = {}
      for (const key of ['log', 'eventsSnapshot', 'derived']) {
        const target = propertyTarget(i, key)
        fields[key] = target < 0 || !isArrayLike(target)
          ? null
          : { node: target, array: arrayInfo(target), retained: retainedSize(target) }
      }
      sessions.push({ node: i, id, self: nodeSelf(i), retained: retainedSize(i), fields })
    }
    return sessions
  }

  const summaryByType = () => {
    const byType = new Map()
    const byName = new Map()
    for (let i = 0; i < nodeCount; i++) {
      const type = nodeType(i)
      const name = nodeName(i)
      const self = nodeSelf(i)
      byType.set(type, (byType.get(type) ?? 0) + self)
      const key = `${type}\u0000${name}`
      const record = byName.get(key) ?? { bytes: 0, count: 0 }
      record.bytes += self
      record.count += 1
      byName.set(key, record)
    }
    return { byType, byName }
  }

  return {
    nodeCount, edgeCount, totalSelf,
    nodeType, nodeName, nodeSelf, nodeCountValue: () => nodeCount,
    outEdges, edgeTarget, edgeType, edgeName,
    propertyTarget, propertyString, arrayInfo,
    retainedSize, retainerPath, findSessions, summaryByType,
  }
}

const formatPath = (path) => path.map((step) => `${step.fromName} -${step.edgeType}:${step.edge}-> ${step.toName}`).join('\n  ')

export function analyze(snapshot, { target = null, json = false } = {}) {
  const view = createSnapshotView(snapshot)
  const sessions = view.findSessions()
  const { byType, byName } = view.summaryByType()
  const result = {
    nodes: view.nodeCount,
    edges: view.edgeCount,
    totalSelf: view.totalSelf,
    sessions: sessions.map((session) => ({
      id: session.id,
      node: session.node,
      self: session.self,
      retained: session.retained,
      log: session.fields.log === null ? null : {
        node: session.fields.log.node, ...session.fields.log.array, retained: session.fields.log.retained,
      },
      eventsSnapshot: session.fields.eventsSnapshot === null ? null : {
        node: session.fields.eventsSnapshot.node, ...session.fields.eventsSnapshot.array, retained: session.fields.eventsSnapshot.retained,
      },      derived: session.fields.derived === null ? null : {
        node: session.fields.derived.node, ...session.fields.derived.array, retained: session.fields.derived.retained,
      },
      retainer: view.retainerPath(session.node),
    })),
    byType: [...byType].sort((a, b) => b[1] - a[1]).map(([type, bytes]) => ({ type, bytes })),
    top: [...byName.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 40).map(([key, record]) => {
      const [type, name] = key.split('\u0000')
      return { type, name, bytes: record.bytes, count: record.count }
    }),
  }
  if (target !== null) {
    const sessionTarget = target.startsWith('session:') ? sessions.find((session) => session.id === target.slice(8))
      : target.startsWith('log:') ? sessions.find((session) => session.id === target.slice(4))?.fields.log
        : null
    if (sessionTarget !== null && sessionTarget !== undefined) {
      result.target = {
        kind: target.split(':')[0],
        node: sessionTarget.node,
        retained: view.retainedSize(sessionTarget.node),
        retainer: view.retainerPath(sessionTarget.node),
      }
    } else if (target.startsWith('node:')) {
      const node = Number(target.slice(5))
      if (!Number.isInteger(node) || node < 0 || node >= view.nodeCount) throw new Error(`invalid node index: ${node}`)
      result.target = { kind: 'node', node, retained: view.retainedSize(node), retainer: view.retainerPath(node) }
    } else {
      result.target = null
      result.targetError = `target not found: ${target}`
    }
  }
  return { result, view }
}

const main = () => {
  const file = process.argv[2]
  if (file === undefined) {
    console.error('usage: analyze-heap.mjs <snapshot> [--target session:<id>|log:<id>|node:<n>] [--json]')
    process.exit(2)
  }
  const targetIndex = process.argv.indexOf('--target')
  const target = targetIndex === -1 ? null : process.argv[targetIndex + 1]
  const json = process.argv.includes('--json')
  const snapshot = JSON.parse(readFileSync(file, 'utf8'))
  const { result } = analyze(snapshot, { target, json })
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`snapshot: ${file}`)
  console.log(`nodes: ${result.nodes}  edges: ${result.edges}  self_size total: ${MiB(result.totalSelf)} MiB`)
  console.log('\nby type:')
  for (const row of result.byType) console.log(`${String(row.type).padEnd(18)} ${MiB(row.bytes).padStart(8)} MiB`)
  console.log('\ntop 40 by self size:')
  for (const row of result.top) {
    console.log(`${MiB(row.bytes).padStart(8)} MiB  ${String(row.count).padStart(8)}  ${row.type.padEnd(14)} ${JSON.stringify(row.name)}`)
  }
  if (result.sessions.length > 0) {
    console.log('\nSessions:')
    for (const session of result.sessions) {
      console.log(`- ${session.id ?? '<unknown>'} node=${session.node} self=${MiB(session.self)} MiB retained=${MiB(session.retained)} MiB`)
      for (const key of ['log', 'eventsSnapshot', 'derived']) {
        const field = session[key]
        if (field === null) continue
        console.log(`    ${key}: self=${MiB(field.self)} MiB internal=${MiB(field.internalBytes)} MiB elements=${field.elements} retained=${MiB(field.retained)} MiB node=${field.node}`)
      }
      if (session.retainer.length > 0) console.log(`    retainer:\n  ${formatPath(session.retainer)}`)
    }
  }
  if (result.target !== undefined && result.target !== null) {
    console.log(`\ntarget ${result.target.kind} node=${result.target.node} retained=${MiB(result.target.retained)} MiB`)
    if (result.target.retainer.length > 0) console.log(`retainer:\n  ${formatPath(result.target.retainer)}`)
  } else if (result.targetError !== undefined) {
    console.log(`\n${result.targetError}`)
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
