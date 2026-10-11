#!/usr/bin/env bash
# 安全写入 npm 发布用 token 到 ~/.npmrc（token 不回显、不进 shell 历史）。
#
# 用法：
#   bash scripts/set-npm-token.sh
# 然后按提示粘贴 token（输入不可见），回车确认。
#
# 前置：在 https://www.npmjs.com/settings/<用户名>/tokens 生成
#       **Granular Access Token** 并勾选 "Bypass 2FA"（或选 Automation 类型），
#       权限至少包含 dsh-large-proj-perf 的 Read and write。
set -euo pipefail

NPMRC="${HOME}/.npmrc"
REGISTRY_LINE='//registry.npmjs.org/:_authToken='

printf '粘贴 npm token（输入不可见，回车确认）: '
IFS= read -rs TOKEN
printf '\n'

if [ -z "${TOKEN}" ]; then
  echo "错误：token 为空，未做任何修改。" >&2
  exit 1
fi
case "${TOKEN}" in
  npm_*|*[![:space:]]*) : ;;
  *) echo "错误：token 含空白字符，疑似误粘贴。" >&2; exit 1 ;;
esac

# 备份现有 npmrc（若存在）
if [ -f "${NPMRC}" ]; then
  cp "${NPMRC}" "${NPMRC}.bak-$(date +%Y%m%d-%H%M%S)"
  # 移除旧的 registry.npmjs.org token 行（保留其他 registry 配置）
  grep -v '^//registry.npmjs.org/:_authToken=' "${NPMRC}" > "${NPMRC}.tmp" || true
  mv "${NPMRC}.tmp" "${NPMRC}"
fi

printf '%s%s\n' "${REGISTRY_LINE}" "${TOKEN}" >> "${NPMRC}"
chmod 600 "${NPMRC}" 2>/dev/null || true

echo "已写入 ${NPMRC}（权限 600）。"
echo "校验身份："
npm whoami --registry=https://registry.npmjs.org || {
  echo "身份校验失败——token 可能无效或权限不足。" >&2
  exit 1
}
echo "完成。现在可以执行：npm publish --registry=https://registry.npmjs.org"
