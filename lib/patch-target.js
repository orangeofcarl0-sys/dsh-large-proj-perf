// 方法替换的统一样板（补丁基础设施）。
//
// 三处补丁（`chunked-materialize`、`cold-writeback`、`memory-budget`）原先各写
// 一遍这套逻辑，且细节已经漂移：
//   - 有的检查 `hasOwnProperty` 决定 dispose 时是 delete 还是写回；
//   - 有的没做这个判断，dispose 后会在实例上留一个遮蔽原型的副本；
//   - 有的用 `Object.getPrototypeOf(x).method` 取「真实源码」做特征校验
//     （因为 cordis 的 Proxy 会返回 bind 过的 shadow method，`String(x.method)`
//     是 `[native code]`）。
//
// 这个模块把「取原始实现 → 生成替换 → 安装 → 还原」固化成一条路径。

/**
 * 取目标上的原始方法，并判断它来自原型还是自有属性。
 *
 * @param target - 被补丁的对象（实例）
 * @param name - 方法名
 * @returns `{ original, hadOwn }`；`original` 为 undefined 表示方法不存在
 */
export function resolveMethod(target, name) {
  if (target === null || target === void 0) return { original: void 0, hadOwn: false }
  const hadOwn = Object.prototype.hasOwnProperty.call(target, name)
  const original = target[name]
  return { original: typeof original === 'function' ? original : void 0, hadOwn }
}

/**
 * 用 `factory` 产出的函数替换 `target[name]`，并登记还原。
 *
 * 还原语义（这是三处补丁此前不一致的地方，统一为正确的一版）：
 *   - 原始是**自有属性**（测试 mock、自定义后端）→ 写回原函数；
 *   - 原始来自**原型**（真实 dsh 服务）→ `delete` 自有属性，让方法回落原型。
 *     不 delete 的话会在实例上留一个副本，遮蔽原型，上游热更新失效。
 *
 * 只在替换仍然生效时才还原（避免把别人的后续补丁覆盖掉）。
 *
 * @param target - 被补丁的对象
 * @param name - 方法名
 * @param factory - `(original) => replacement`；返回非函数则放弃安装
 * @param disposers - 数组；成功时 push 一个还原闭包
 * @returns `{ installed, original, replacement }`
 */
export function wrapMethod(target, name, factory, disposers) {
  const { original, hadOwn } = resolveMethod(target, name)
  if (original === void 0) return { installed: false, original: void 0, replacement: void 0 }

  const replacement = factory(original)
  if (typeof replacement !== 'function') return { installed: false, original, replacement: void 0 }

  target[name] = replacement
  if (Array.isArray(disposers)) {
    disposers.push(() => {
      if (target[name] !== replacement) return
      if (hadOwn) target[name] = original
      else delete target[name]
    })
  }
  return { installed: true, original, replacement }
}

/**
 * 取「真实源码文本」用于特征校验。
 *
 * cordis 的 `ctx.get(name)` 返回 Proxy，其方法被 bind 过、`String()` 得到的是
 * `function () { [native code] }`。要拿到可用于特征匹配的源码，必须沿原型链取
 * 未 bind 的那一份。
 *
 * @param target - 服务实例
 * @param name - 方法名
 * @returns 源码文本；取不到时返回空串
 */
export function sourceOf(target, name) {
  if (target === null || target === void 0) return ''
  const proto = Object.getPrototypeOf(target)
  const candidate = (proto !== null && typeof proto[name] === 'function')
    ? proto[name]
    : target[name]
  return typeof candidate === 'function' ? String(candidate) : ''
}
