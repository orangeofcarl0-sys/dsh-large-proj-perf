// 投影缓存行 identity 的单一构造器。
//
// 缓存行的 identity 必须与上游 `dsh-session-projection-cache` 的 `identityOf()`
// **逐字段、逐顺序**一致——`identityMatches()` 是严格比较，任何一个字段名拼错、
// 顺序无关但字段值语义偏一点，行都会永久失配并静默回退到全量重折。
//
// 历史教训：`warmup.js` 与 `backfill.js` 曾各抄一份，字段与条件展开很容易漂移
// （例如忘记把 `formatVersion` 放首位、或把 `cwd` 无条件展开成 `undefined`）。
// 现在只在这里定义一次。
//
// 上游实现（dsh 0.2.2-rc.1，`dsh-session-projection-cache/lib/index.js:363-379`）：
//   lifecycleIdentityOf(header) => {
//     formatVersion: header.version,
//     createdAt: header.createdAt,
//     ...(header.cwd === void 0 ? {} : { cwd: header.cwd }),
//     isSeeded: header.isSeeded
//   }
//   identityOf(header, inheritedEventCount) => {
//     const cut = SessionLogOffset(inheritedEventCount)
//     if (!header.isSeeded && cut !== 0) throw ...
//     return { ...lifecycleIdentityOf(header), inheritedEventCount: cut }
//   }
//
// 注意 `isSeeded` 是无条件写入的（不像 cwd 那样条件展开）；`inheritedEventCount`
// 归一化为 SessionLogOffset（非负安全整数 brand）。

// SessionLogOffset 的真实实现由 runtime.js 顶层探测得到；这里收一个函数注入，
// 避免本模块与 runtime.js 形成循环依赖。
export function makeCacheIdentity(sessionLogOffset) {
  const offset = typeof sessionLogOffset === 'function' ? sessionLogOffset : (v) => v

  // header + 继承前缀长度 → 完整缓存 identity。
  // `header.version` 缺失时上游会让 `formatVersion` 为 undefined，构造出的行
  // 永远失配；这里保持同样行为（不做兜底猜测），让失配显式发生。
  return function cacheIdentityOf(header, inheritedEventCount) {
    const cut = offset(inheritedEventCount ?? 0)
    return {
      formatVersion: header?.version,
      createdAt: header?.createdAt,
      ...(header?.cwd === void 0 ? {} : { cwd: header.cwd }),
      isSeeded: header?.isSeeded ?? false,
      inheritedEventCount: cut,
    }
  }
}
