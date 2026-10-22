import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// ComWeChat 适配器锅巴配置页（进群/退群检测间隔 + 失败退避，可网页端调整，无需重启）
// 与运行时 ComWeChat.js 读取同一对 yaml（默认 config/default_config/comwechat.yaml + 用户 config/config/comwechat.yaml）。
// 此处刻意零依赖（不引 yaml），用极简解析，避免运行进程缺依赖导致加载异常。
const _guobaDir = path.dirname(fileURLToPath(import.meta.url))
const _pluginDir = path.resolve(_guobaDir, "..")
const CFG_NAME = "comwechat"
const DEF_PATH = path.resolve(_pluginDir, `config/default_config/${CFG_NAME}.yaml`)
const USR_PATH = path.resolve(_pluginDir, `config/config/${CFG_NAME}.yaml`)

// 极简 YAML 读取（仅顶层 key: value 标量），无外部依赖
function readYaml(p) {
  try {
    const out = {}
    const txt = fs.readFileSync(p, "utf8")
    for (const raw of txt.split("\n")) {
      const line = raw.split("#")[0].trim()
      if (!line.includes(":")) continue
      const i = line.indexOf(":")
      const k = line.slice(0, i).trim()
      let v = line.slice(i + 1).trim()
      if (v && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1)
      out[k] = v
    }
    return out
  } catch (_) { return {} }
}
function getMerged() {
  return { ...readYaml(DEF_PATH), ...readYaml(USR_PATH) }
}
function unflatten(flat) {
  const out = {}
  for (const [k, v] of Object.entries(flat || {})) {
    const parts = String(k).split(".")
    let cur = out
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof cur[parts[i]] !== "object" || cur[parts[i]] === null) cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
    cur[parts[parts.length - 1]] = v
  }
  return out
}

export const schemas = [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "ComWeChat 适配器"
  },
  {
    field: "comwechat.memberWatchIntervalSec",
    label: "进群/退群检测间隔(秒)",
    bottomHelpMessage: "适配器定时拉各群成员列表差分、合成进群/退群事件的轮询间隔。默认 180(3分钟)，范围 30~600。群少且中小群可设小；同账号 ≥4 个大群建议回到 300(5分钟) 避免拖垮 COM 通道导致掉线。",
    component: "InputNumber",
    componentProps: { min: 30, max: 600, step: 30 }
  },
  {
    field: "comwechat.memberWatchBackoffTicks",
    label: "失败退避周期数",
    bottomHelpMessage: "某群连续获取成员列表失败后跳过轮询的周期数，退避≈间隔×此值(默认 17≈51分钟)。范围 1~60。",
    component: "InputNumber",
    componentProps: { min: 1, max: 60, step: 1 }
  },
  {
    field: "comwechat.memberWatchGroupTimeoutMs",
    label: "单群拉取超时(毫秒)",
    bottomHelpMessage: "单群成员列表 race 超时。大群经 COM 读全量成员常需 60~90s，原 45s 过短会每轮必败并整片退避；默认 110000(110秒)，范围 30000~180000。放宽到大于大群真实耗时即可正常取回。",
    component: "InputNumber",
    componentProps: { min: 30000, max: 180000, step: 5000 }
  },
  {
    field: "comwechat.memberWatchBackoffAfter",
    label: "连续失败几次才退避",
    bottomHelpMessage: "原为「首次失败即退避」，对偶发 COM 抖动过于敏感（一次抖动黑掉约 51 分钟）。改为连续 N 次才退避（默认 3，范围 1~10），偶发超时下轮重试、不黑群。",
    component: "InputNumber",
    componentProps: { min: 1, max: 10, step: 1 }
  },
  {
    component: "SOFT_GROUP_END"
  }
]

export function getConfigData() {
  const c = getMerged()
  return {
    "comwechat": {
      memberWatchIntervalSec: Number(c.memberWatchIntervalSec) || 180,
      memberWatchBackoffTicks: Number(c.memberWatchBackoffTicks) || 17,
      memberWatchGroupTimeoutMs: Number(c.memberWatchGroupTimeoutMs) || 110000,
      memberWatchBackoffAfter: Number(c.memberWatchBackoffAfter) || 3
    }
  }
}

export function setConfigData(data, { Result }) {
  // data：扁平点分字段，如 { "comwechat.memberWatchIntervalSec": 180 }
  const inner = {}
  for (const [k, v] of Object.entries(data || {})) {
    if (!k.startsWith("comwechat.")) continue
    inner[k.slice("comwechat.".length)] = v
  }
  const merged = { ...readYaml(USR_PATH), ...unflatten(inner) }
  try { fs.mkdirSync(path.dirname(USR_PATH), { recursive: true }) } catch (_) {}
  const lines = Object.entries(merged).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n"
  fs.writeFileSync(USR_PATH, lines, "utf8")
  return Result.ok({}, "保存成功")
}
