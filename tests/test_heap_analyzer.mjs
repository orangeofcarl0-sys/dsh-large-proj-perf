// v1.17 分析工具测试：堆快照的 retained size / retainer path / Session 字段识别。
//
// 用 10 个节点的合成快照锁住算法：
//   root → Session → log array → FixedArray
//   root → CacheEntry → events array → 共享 SessionEvent
// 断言 Session 的 retained size 不包含被 cache 共享的事件对象。

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const { analyze, createSnapshotView } = await import('../tools/runtime-probe/analyze-heap.mjs')

const strings = ['', 'Session', 'Object', 'SessionEvent', 'FixedArray', 'CacheEntry', 's1', 'header', 'log', 'derived', 'id', 'events', 'session', 'cache']
const nodeTypes = ['hidden', 'array', 'string', 'object', 'code', 'closure', 'regexp', 'number', 'native', 'synthetic', 'concatenated string', 'sliced string', 'symbol', 'bigint', 'object shape']
const edgeTypes = ['context', 'element', 'property', 'internal', 'hidden', 'shortcut', 'weak']
const S = Object.fromEntries(strings.map((value, index) => [value, index]))
const T = Object.fromEntries(nodeTypes.map((value, index) => [value, index]))
const E = Object.fromEntries(edgeTypes.map((value, index) => [value, index]))

// [type, name, id, self, edges, detachedness]
const nodeRows = [
  [T.synthetic, S[''], 0, 0, 2, 0],       // 0 root
  [T.object, S.Session, 1, 100, 3, 0],    // 1 Session
  [T.object, S.Object, 2, 20, 1, 0],      // 2 header
  [T.array, S[''], 3, 40, 2, 0],          // 3 log
  [T.object, S.SessionEvent, 4, 1000, 0, 0], // 4 shared event
  [T.object, S.FixedArray, 5, 80, 0, 0],  // 5 log backing
  [T.array, S[''], 6, 30, 0, 0],          // 6 derived
  [T.string, S.s1, 7, 10, 0, 0],          // 7 id
  [T.object, S.CacheEntry, 8, 50, 1, 0],  // 8 cache entry
  [T.array, S[''], 9, 40, 1, 0],          // 9 cache events
]
const nodes = nodeRows.flat()
const at = (index) => index * 6
const edge = (type, name, to) => [type, name, at(to)]
const edges = [
  ...edge(E.property, S.session, 1), ...edge(E.property, S.cache, 8),
  ...edge(E.property, S.header, 2), ...edge(E.property, S.log, 3), ...edge(E.property, S.derived, 6),
  ...edge(E.property, S.id, 7),
  ...edge(E.element, 0, 4), ...edge(E.internal, 0, 5),
  ...edge(E.property, S.events, 9),
  ...edge(E.element, 0, 4),
].flat()
const snapshot = {
  snapshot: {
    meta: {
      node_fields: ['type', 'name', 'id', 'self_size', 'edge_count', 'detachedness'],
      node_types: [nodeTypes],
      edge_fields: ['type', 'name_or_index', 'to_node'],
      edge_types: [edgeTypes],
    },
    node_count: nodeRows.length,
    edge_count: edges.length / 3,
  },
  nodes,
  edges,
  strings,
}

const view = createSnapshotView(snapshot)
check('snapshot: node/edge counts', view.nodeCount === 10 && view.edgeCount === 10, `${view.nodeCount}/${view.edgeCount}`)

const sessions = view.findSessions()
check('session: found by constructor name', sessions.length === 1)
const session = sessions[0]
check('session: id resolved through header.id', session?.id === 's1', String(session?.id))
check('session: log array identified', session?.fields.log !== null && session.fields.log.node === 3)
check('session: log elements/backing bytes', session?.fields.log?.array?.elements === 1 && session.fields.log.array.internalBytes === 80)
check('session: eventsSnapshot absent', session?.fields.eventsSnapshot === null)
check('session: derived identified', session?.fields.derived?.array?.elements === 0)

// Session 自身 retained：100 + header 20 + id 10 + log 40 + backing 80 + derived 30 = 280；
// 共享事件 4 仍可从 cache 到达，不计入。
check('retained: Session excludes shared event', session?.retained === 280, String(session?.retained))
check('retained: log excludes shared event', view.retainedSize(3) === 120, String(view.retainedSize(3)))
check('retained: shared event alone is small', view.retainedSize(4) === 1000, String(view.retainedSize(4)))

const path = view.retainerPath(3)
check('retainer: path reaches root', path.length === 2, JSON.stringify(path))
check('retainer: path names Session/log', path[0]?.toName === 'Session' && path[1]?.edge === 'log', JSON.stringify(path))

const { result } = analyze(snapshot, { target: 'session:s1' })
check('analyze: target session retained', result.target?.retained === 280, String(result.target?.retained))
const logTarget = analyze(snapshot, { target: 'log:s1' }).result
check('analyze: target log retained', logTarget.target?.retained === 120, String(logTarget.target?.retained))
const missing = analyze(snapshot, { target: 'session:nope' }).result
check('analyze: missing target reports error', missing.target === null && typeof missing.targetError === 'string')

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
