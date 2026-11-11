// v1.10 测试：方法替换样板（patch-target.js）
//
// 这套样板此前在三个模块里各写一遍且细节漂移过，其中最严重的分歧是
// **dispose 时该 delete 还是该写回**：
//   - 原始方法来自原型（真实 dsh 服务）→ 必须 delete 自有属性，让方法回落原型；
//     不 delete 会在实例上留副本遮蔽原型，上游热更新失效。
//   - 原始方法是自有属性（测试 mock、自定义后端）→ 必须写回原函数。
// 本套件把两种情形都钉死。

let failures = 0
const check = (label, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`)
  if (!cond) failures++
}

const { resolveMethod, wrapMethod, sourceOf } = await import('../lib/patch-target.js')

// ---- resolveMethod ----
{
  class Base { greet() { return 'base' } }
  const inst = new Base()
  const own = { greet() { return 'own' } }

  const a = resolveMethod(inst, 'greet')
  check('resolve: prototype method found', typeof a.original === 'function' && a.hadOwn === false)
  const b = resolveMethod(own, 'greet')
  check('resolve: own method flagged', typeof b.original === 'function' && b.hadOwn === true)
  const c = resolveMethod(inst, 'missing')
  check('resolve: missing method yields undefined', c.original === void 0)
  const d = resolveMethod(null, 'x')
  check('resolve: null target is safe', d.original === void 0 && d.hadOwn === false)
  const e = resolveMethod({ notFn: 42 }, 'notFn')
  check('resolve: non-function is not a method', e.original === void 0)
}

// ---- wrapMethod：原型方法 → dispose 后 delete 自有属性 ----
{
  class Base { m() { return 'base' } }
  const inst = new Base()
  const protoMethod = Object.getPrototypeOf(inst).m
  const disposers = []
  const { installed } = wrapMethod(inst, 'm', (orig) => function () { return `wrapped(${orig.call(this)})` }, disposers)
  check('wrap: installed', installed === true)
  check('wrap: replacement active', inst.m() === 'wrapped(base)')
  check('wrap: becomes own property', Object.prototype.hasOwnProperty.call(inst, 'm'))
  check('wrap: prototype untouched', Object.getPrototypeOf(inst).m === protoMethod)
  for (const d of disposers.splice(0)) d()
  check('wrap: dispose removes own property', !Object.prototype.hasOwnProperty.call(inst, 'm'))
  check('wrap: falls back to prototype', inst.m() === 'base')
}

// ---- wrapMethod：自有属性 → dispose 后写回原函数 ----
{
  const obj = { m() { return 'own' } }
  const original = obj.m
  const disposers = []
  wrapMethod(obj, 'm', () => function () { return 'wrapped' }, disposers)
  check('wrap own: replacement active', obj.m() === 'wrapped')
  for (const d of disposers.splice(0)) d()
  check('wrap own: restored exact original', obj.m === original)
  check('wrap own: still own property', Object.prototype.hasOwnProperty.call(obj, 'm'))
}

// ---- wrapMethod：不覆盖他人的后续补丁 ----
{
  const obj = { m() { return 'a' } }
  const disposers = []
  wrapMethod(obj, 'm', () => function () { return 'first' }, disposers)
  const first = obj.m
  // 第二个补丁叠在上面
  obj.m = function () { return 'second' }
  for (const d of disposers.splice(0)) d()
  check('wrap: does not clobber a later patch', obj.m() === 'second')
  check('wrap: first replacement still referenced', typeof first === 'function')
}

// ---- wrapMethod：方法不存在 / factory 返回非函数 ----
{
  const obj = {}
  const disposers = []
  const a = wrapMethod(obj, 'absent', () => function () {}, disposers)
  check('wrap: absent method not installed', a.installed === false)
  check('wrap: absent method adds nothing', !('absent' in obj))
  const b = wrapMethod({ m() {} }, 'm', () => null, disposers)
  check('wrap: non-function factory not installed', b.installed === false)
  check('wrap: no disposer registered on failure', disposers.length === 0)
}

// ---- sourceOf：跳过 Proxy/bind 后的 shadow method，取真实源码 ----
{
  class Base {
    doThing(a, b) { return a + b }
  }
  const inst = new Base()
  check('sourceOf: sees real prototype source', sourceOf(inst, 'doThing').includes('doThing(a, b)'))

  // 模拟 cordis 的 shadow method：bind 后的函数 String 是 [native code]
  const shadow = { doThing: inst.doThing.bind(inst) }
  check('sourceOf: bound shadow string would be native code',
    String(shadow.doThing).includes('native code'))
  // sourceOf 会沿原型链找——shadow 对象自身没有原型方法，所以拿不到真实源码，
  // 这是预期行为（调用方应传真实服务实例而非 shadow 包装）。
  check('sourceOf: unbound instance still yields source', sourceOf(inst, 'doThing').length > 20)
  check('sourceOf: missing method yields empty string', sourceOf(inst, 'nope') === '')
  check('sourceOf: null target yields empty string', sourceOf(null, 'x') === '')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAIL`)
process.exit(failures === 0 ? 0 : 1)
