// ── 零依赖 .env 加载 ─────────────────────────────────────────────
// YingLight 等插件直接读 process.env.*（VISION_API_KEY 等）。本机没装 dotenv、
// 也没在系统/SHELL 里设这些变量时，从 app 根目录的 .env 读取。
// 仅当 .env 存在时加载；已存在的环境变量（如系统/SHELL 里的 DEEPSEEK_API_KEY）不被覆盖。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
try {
  const envPath = fileURLToPath(new URL('.env', import.meta.url))
  if (fs.existsSync(envPath)) {
    let n = 0
    const txt = fs.readFileSync(envPath, 'utf8')
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/)
      if (m && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
        n++
      }
    }
    if (n > 0) console.log(`[env] 已从 .env 加载 ${n} 个环境变量`)
  }
} catch (e) {
  console.warn('[env] 加载 .env 失败:', e?.message || e)
}

switch (process.env.app_type || process.argv[2]) {
  case "stop": {
    const cfg = (await import("./lib/config/config.js")).default
    await fetch(`http://localhost:${cfg.server.port}/exit`, {
      headers: cfg.server.auth || undefined,
    }).catch(() => {})
    process.exit()
  }
  case "daemon": {
    console.log("守护进程正在启动主进程")
    const { spawnSync } = await import("node:child_process")
    while (
      spawnSync(process.argv[0], [process.argv[1], "start", ...process.argv.slice(2)], {
        stdio: "inherit",
      }).status !== 255
    )
      console.log("守护进程正在重启主进程")
    console.log("守护进程已停止")
    process.exit()
  }
  case "pm2":
    global.start_type = "pm2"
    break
  case "start":
    global.start_type = "external"
    break
  default:
    global.start_type = "internal"
}
global.Bot = new (await import("./lib/bot.js")).default()
Bot.run()
