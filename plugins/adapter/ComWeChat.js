import cfg from "../../lib/config/config.js"
import { ulid } from "ulid"
import sharp from 'sharp'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { fileURLToPath } from 'node:url'

// ============ 适配器自身配置（锅巴可配：进群/退群检测间隔 + 失败退避）============
// 默认：config/default_config/comwechat.yaml（随插件分发）
// 用户：config/config/comwechat.yaml（由锅巴网页端写入，覆盖默认值）
// 全部防御式读取：文件缺失/非法/解析失败都安全回退到 3 分钟间隔与 17 退避周期，绝不抛错拖垮适配器。
// 注意：此处刻意不用 yaml 依赖（运行进程里不保证可解析），改用零依赖极简解析（仅顶层 key: value 标量）。
const _cwAdapterDir = path.dirname(fileURLToPath(import.meta.url))
const _CW_DEF = path.resolve(_cwAdapterDir, "config/default_config/comwechat.yaml")
const _CW_USR = path.resolve(_cwAdapterDir, "config/config/comwechat.yaml")
function _readCwYamlSafe(p) {
  try {
    const out = {}
    const txt = fs.readFileSync(p, "utf8")
    for (const raw of txt.split("\n")) {
      const line = raw.split("#")[0].trim()           // 去行内注释
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
let _cwCfgCache = null
let _cwCfgAt = 0
const _CW_TTL = 15000
function getComWeChatCfg() {
  const now = Date.now()
  if (_cwCfgCache && now - _cwCfgAt < _CW_TTL) return _cwCfgCache
  _cwCfgCache = { ..._readCwYamlSafe(_CW_DEF), ..._readCwYamlSafe(_CW_USR) }
  _cwCfgAt = now
  return _cwCfgCache
}
// 检测间隔（毫秒）：默认 180000(3分钟)，限制在 30s~600s 之间，避免极端值拖垮 COM 通道。
function resolveWatchInterval() {
  try {
    const sec = Number(getComWeChatCfg().memberWatchIntervalSec)
    if (!Number.isFinite(sec) || sec <= 0) return 180000
    return Math.round(Math.min(600, Math.max(30, sec)) * 1000)
  } catch (_) { return 180000 }
}
// 失败退避周期数：默认 17（≈间隔×17；3分钟×17≈51分钟），限制 1~60。
function resolveWatchSkipTicks() {
  try {
    const t = Math.floor(Number(getComWeChatCfg().memberWatchBackoffTicks))
    if (!Number.isFinite(t) || t <= 0) return 17
    return Math.min(60, Math.max(1, t))
  } catch (_) { return 17 }
}
// 单群成员列表拉取超时（毫秒）：默认 110000，限制 30s~180s。
// 大群 get_group_member_list 经 COM 读全量成员列表常需 60~90s，原 45s race 超时过短会导致每轮必败、
// 单群首次失败就退避，≥4 个大群会同时掉进退避使进退群检测整片失效。
// 放宽到 110s 让大群有机会在超时前真正取回（而非被提前放弃后级联拖垮其余群）。
function resolveWatchGroupTimeoutMs() {
  try {
    const ms = Number(getComWeChatCfg().memberWatchGroupTimeoutMs)
    if (!Number.isFinite(ms) || ms <= 0) return 110000
    return Math.round(Math.min(180000, Math.max(30000, ms)))
  } catch (_) { return 110000 }
}
// 连续失败几次才进入退避：默认 3，限制 1~10。
// 原先「首次失败即退避」对偶发卡顿过于敏感——一次 COM 抖动就把群黑掉 51 分钟。
// 改为连续 N 次才退避，偶发超时只记一笔并在下轮重试，避免整片失效。
function resolveWatchBackoffAfter() {
  try {
    const n = Math.floor(Number(getComWeChatCfg().memberWatchBackoffAfter))
    if (!Number.isFinite(n) || n <= 0) return 3
    return Math.min(10, Math.max(1, n))
  } catch (_) { return 3 }
}

Bot.adapter.push(
  new (class ComWeChatAdapter {
    id = "WeChat"
    name = "ComWeChat"
    path = this.name
    echo = new Map()
    timeout = 120000
    maxRetries = 3
    retryDelay = 5000
    // 防撤回：缓存已收消息的原文，撤回事件到达时取回
    recallCache = new Map()
    recallCacheCap = 2000

    makeLog(msg) {
      return Bot.String(msg).replace(/(base64:\/\/|"type":"data","data":").*?"/g, '$1..."')
    }

    async callApi(data, ws, action, params = {}, retries = this.maxRetries) {
      const echo = ulid()
      const request = { action, params, echo }
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const promise = new Promise((resolve, reject) => {
            const cache = { resolve, reject }
            this.echo.set(echo, cache)
            const timeout = setTimeout(() => {
              cache.reject(Bot.makeError("请求超时", request, { timeout: this.timeout }))
              Bot.makeLog("error", ["请求超时", request], data.self_id)
            }, this.timeout)
            cache.timeout = timeout
          })
          ws.sendMsg(request)
          const response = await promise
          if (response.retcode !== 0) {
            const err = Bot.makeError(response.message || "内部服务错误", request, { error: response })
            err.retcode = response.retcode
            throw err
          }
          return response.data
            ? new Proxy(response, { get: (target, prop) => target.data[prop] ?? target[prop] })
            : response
        } catch (err) {
          Bot.makeLog("error", `API ${action} 调用失败 (尝试 ${attempt}/${retries}): ${err.message}`, data.self_id)
          if (attempt === retries) throw err
          await Bot.sleep(this.retryDelay)
          const old = this.echo.get(echo)
          if (old && old.timeout) clearTimeout(old.timeout)
          this.echo.delete(echo)
        }
      }
    }

    sendApi(data, ws, action, params = {}) {
      return this.callApi(data, ws, action, params, 1)
    }

    async uploadFile(data, file) {
      file = await Bot.fileType(file, { http: true, size: 10485760 })
      const isImage = file.name && /\.(jpg|jpeg|png|webp|bmp)$/i.test(file.name);
      if (Buffer.isBuffer(file.buffer) && isImage) {
        Bot.makeLog("info", `[图片处理] 原图大小: ${file.buffer.length} 字节`, data.self_id);
        try {
          const isWebP = file.name.toLowerCase().endsWith('.webp');
          const isLarge = file.buffer.length > 10 * 1024 * 1024; // 10MB 阈值

          if (isWebP || isLarge) {
            let pipeline = sharp(file.buffer);
            let actionMsg = "";
            if (isLarge) {
              pipeline = pipeline.resize(4096, 4096, { fit: 'inside', withoutEnlargement: true });
              pipeline = pipeline.jpeg({ quality: 95 });
              actionMsg = `超大图压缩 (缩放至4096x4096, 质量95)`;
            } else if (isWebP) {
              pipeline = pipeline.jpeg({ quality: 100 });
              actionMsg = `WebP 转 JPEG (无损)`;
            }
            const processedBuffer = await pipeline.toBuffer();
            file.buffer = processedBuffer;
            if (!file.name.toLowerCase().endsWith('.jpg')) {
              file.name = file.name.replace(/\.[^.]+$/, '.jpg');
            }
            Bot.makeLog("info", `[图片处理] ${actionMsg}，处理后大小: ${file.buffer.length} 字节`, data.self_id);
          } else {
            Bot.makeLog("info", `[图片处理] 原图清晰且未超限，保持原样发送`, data.self_id);
          }
        } catch (err) {
          Bot.makeLog("warn", `[图片处理] 处理失败: ${err.message}，将发送原图`, data.self_id);
        }
      }

      const opts = { name: file.name }

      // ================= 关键修复：Buffer 不再转 Base64，改用临时文件 =================
      if (Buffer.isBuffer(file.buffer)) {
        const tmpFilePath = path.join(os.tmpdir(), `comwechat_${Date.now()}_${file.name}`);
        fs.writeFileSync(tmpFilePath, file.buffer);
        opts.type = "path";
        opts.path = tmpFilePath;
        Bot.makeLog("info", `[上传优化] 使用临时文件: ${tmpFilePath}`, data.self_id);
        // 5秒后自动清理临时文件
        setTimeout(() => {
          try { fs.unlinkSync(tmpFilePath) } catch (e) {}
        }, 5000);
      } else if (typeof file.buffer === 'string' && file.buffer.match(/^https?:\/\//)) {
        Bot.makeLog("info", `[主动下载] 开始下载: ${file.buffer}`, data.self_id)
        try {
          const response = await fetch(file.buffer, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          let buffer = Buffer.from(await response.arrayBuffer())
          const contentType = response.headers.get('content-type') || ''
          let ext = ''
          if (contentType.includes('image/jpeg')) ext = 'jpg'
          else if (contentType.includes('image/png')) ext = 'png'
          else if (contentType.includes('image/webp')) ext = 'webp'
          else if (contentType.includes('image/gif')) ext = 'gif'
          else if (contentType.includes('video/mp4')) ext = 'mp4'
          else ext = 'bin'
          let finalName = (file.name && file.name !== file.buffer && /\.(jpg|jpeg|png|webp|bmp|gif)$/i.test(file.name)) ? file.name : `download.${ext}`
          const isWebP = ext === 'webp' || buffer.slice(8, 12).toString('latin1') === 'WEBP'
          const isLarge = buffer.length > 10 * 1024 * 1024
          if (isWebP || isLarge) {
            try {
              let pipeline = sharp(buffer)
              if (isLarge) pipeline = pipeline.resize(4096, 4096, { fit: 'inside', withoutEnlargement: true })
              pipeline = pipeline.jpeg({ quality: 92 })
              buffer = await pipeline.toBuffer()
              finalName = finalName.replace(/\.[^.]+$/, '') + '.jpg'
              Bot.makeLog("info", `[图片处理] ${isWebP ? 'WebP 转 JPEG' : '超大图压缩'}，处理后大小: ${buffer.length} 字节`, data.self_id)
            } catch (e) {
              Bot.makeLog("warn", `[图片处理] 处理失败: ${e.message}，将发送原图`, data.self_id)
            }
          }
          const safeName = finalName.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)
          const tmpFilePath = path.join(os.tmpdir(), `comwechat_${Date.now()}_${safeName}`)
          fs.writeFileSync(tmpFilePath, buffer)
          opts.type = "path"
          opts.path = tmpFilePath
          opts.name = safeName
          setTimeout(() => { try { fs.unlinkSync(tmpFilePath) } catch (e) {} }, 5000)
          Bot.makeLog("info", `[主动下载] 成功，大小: ${buffer.length} 字节`, data.self_id)
        } catch (err) {
          Bot.makeLog("error", `[主动下载] 失败: ${err.message}，将尝试直接发送 URL`, data.self_id)
          opts.type = "url"
          opts.url = file.buffer
        }
      } else {
        let realPath = file.buffer;
        if (typeof realPath === 'string') {
            realPath = realPath.replace(/^file:\/\/\/?/, '');
        }
        opts.type = "path"
        opts.path = realPath
      }
      // ============================================================================

      Bot.makeLog("info", `上传文件：${this.makeLog(opts)}`, data.self_id)
      return data.bot.sendApi("upload_file", opts)
    }

    async makeMsg(data, msg, send) {
      if (!Array.isArray(msg)) msg = [msg]
      const msgs = []
      for (let i of msg) {
        if (typeof i !== "object") i = { type: "text", data: { text: i } }
        else if (!i.data) i = { type: i.type, data: { ...i, type: undefined } }
        if (i.data.file) i.data = { file_id: (await this.uploadFile(data, i.data)).file_id }
        switch (i.type) {
          case "text": case "image": case "file": case "wx.emoji": case "wx.link": break
          case "record": case "video": i.type = "file"; break
          case "at":
            if (i.data.qq === "all") i = { type: "mention_all", data: {} }
            else i = { type: "mention", data: { user_id: i.data.qq } }
            break
          case "reply": case "button": continue
          case "node": await Bot.sendForwardMsg(send, i.data); continue
          case "raw": i = i.data; break
          default: i = { type: "text", data: { text: Bot.String(i) } }
        }
        msgs.push(i)
      }
      return msgs
    }

    async sendFriendMsg(data, msg) {
      const message = await this.makeMsg(data, msg, msg => this.sendFriendMsg(data, msg))
      Bot.makeLog("info", `发送好友消息：${this.makeLog(message)}`, `${data.self_id} => ${data.user_id}`, true)
      return data.bot.sendApi("send_message", { detail_type: "private", user_id: data.user_id, message })
    }

    async sendGroupMsg(data, msg) {
      const message = await this.makeMsg(data, msg, msg => this.sendGroupMsg(data, msg))
      Bot.makeLog("info", `发送群消息：${this.makeLog(message)}`, `${data.self_id} => ${data.group_id}`, true)
      return data.bot.sendApi("send_message", { detail_type: "group", group_id: data.group_id, message })
    }

    async getFriendArray(data, retries = this.maxRetries) {
      const response = await this.callApi(data, data.bot.ws, "get_friend_list", {}, retries)
      const array = []
      for (const i of response.data) {
        array.push({ ...i, nickname: i.user_remark === "null" ? i.user_displayname || i.user_name : i.user_remark })
      }
      return array
    }
    async getFriendList(data) {
      const array = []
      for (const { user_id } of await this.getFriendArray(data)) array.push(user_id)
      return array
    }
    async getFriendMap(data) {
      const map = new Map()
      for (const i of await this.getFriendArray(data)) map.set(i.user_id, i)
      data.bot.fl = map
      return map
    }
    async getFriendInfo(data) {
      const info = (await this.callApi(data, data.bot.ws, "get_user_info", { user_id: data.user_id })).data
      data.bot.fl.set(data.user_id, info)
      return info
    }
    async getGroupArray(data, retries = this.maxRetries) {
      return (await this.callApi(data, data.bot.ws, "get_group_list", {}, retries)).data
    }
    async getGroupList(data) {
      const array = []
      for (const { group_id } of await this.getGroupArray(data)) array.push(group_id)
      return array
    }
    async getGroupMap(data) {
      const map = new Map()
      for (const i of await this.getGroupArray(data)) map.set(i.group_id, i)
      data.bot.gl = map
      return map
    }
    async getGroupInfo(data) {
      const info = (await this.callApi(data, data.bot.ws, "get_group_info", { group_id: data.group_id })).data
      data.bot.gl.set(data.group_id, info)
      return info
    }
    async getMemberArray(data, retries = this.maxRetries) {
      const response = await this.callApi(data, data.bot.ws, "get_group_member_list", { group_id: data.group_id }, retries)
      const array = []
      for (const i of response.data) {
        const nickname = i.nickname || i.name ||
          (i.user_remark && i.user_remark !== "null" ? i.user_remark : (i.user_displayname || i.user_name || ""))
        array.push({ ...i, nickname, name: nickname })
      }
      return array
    }
    async getMemberList(data) {
      const array = []
      for (const { user_id } of await this.getMemberArray(data)) array.push(user_id)
      return array
    }
    async getMemberMap(data) {
      const map = new Map()
      for (const i of await this.getMemberArray(data)) map.set(i.user_id, i)
      data.bot.gml.set(data.group_id, map)
      return map
    }
    async getGroupMemberMap(data) {
      // 默认开启群成员缓存：只有显式配置为 false 时才跳过，
      // 否则 gml 永远为空，导致群消息发送者昵称（尤其非好友成员）识别为空。
      if (cfg.bot.cache_group_member === false) return this.getGroupMap(data)
      for (const [group_id] of await this.getGroupMap(data)) {
        if (group_id === "filehelper") continue
        await this.getMemberMap({ ...data, group_id }).catch(err => {
          Bot.makeLog("error", `获取群 ${group_id} 成员列表失败: ${err.message}`, data.self_id)
        })
      }
    }
    async getMemberInfo(data) {
      const info = (await this.callApi(data, data.bot.ws, "get_group_member_info", {
        group_id: data.group_id,
        user_id: data.user_id,
      })).data
      let gml = data.bot.gml.get(data.group_id)
      if (!gml) { gml = new Map(); data.bot.gml.set(data.group_id, gml) }
      gml.set(data.user_id, info)
      return info
    }

    pickFriend(data, user_id) {
      const i = { ...data.bot.fl.get(user_id), ...data, user_id }
      return {
        ...i, sendMsg: this.sendFriendMsg.bind(this, i),
        sendFile: (file, name) => this.sendFriendMsg(i, segment.file(file, name)),
        getInfo: this.getFriendInfo.bind(this, i),
        async getAvatarUrl() { return this["wx.avatar"] || (await this.getInfo())["wx.avatar"] }
      }
    }
    pickMember(data, group_id, user_id) {
      const i = { ...data.bot.gml.get(group_id)?.get(user_id), ...data, group_id, user_id }
      return { ...this.pickFriend(i, user_id), ...i, getInfo: this.getMemberInfo.bind(this, i) }
    }
    pickGroup(data, group_id) {
      const i = { ...data.bot.gl.get(group_id), ...data, group_id }
      return {
        ...i, sendMsg: this.sendGroupMsg.bind(this, i),
        sendFile: (file, name) => this.sendGroupMsg(i, segment.file(file, name)),
        getInfo: this.getGroupInfo.bind(this, i),
        async getAvatarUrl() { return this["wx.avatar"] || (await this.getInfo())["wx.avatar"] },
        getMemberArray: this.getMemberArray.bind(this, i),
        getMemberList: this.getMemberList.bind(this, i),
        getMemberMap: this.getMemberMap.bind(this, i),
        pickMember: this.pickMember.bind(this, i, group_id)
      }
    }

    async waitForReady(data, ws, maxWait = 30000, interval = 2000) {
      const start = Date.now()
      while (Date.now() - start < maxWait) {
        try {
          const selfInfo = await this.callApi(data, ws, "get_self_info", {}, 1)
          if (selfInfo && selfInfo.data) {
            Bot.makeLog("info", "后端已就绪", data.self_id)
            return selfInfo.data
          }
        } catch (err) {}
        await Bot.sleep(interval)
      }
      throw Bot.makeError("等待后端就绪超时", {}, { timeout: maxWait })
    }

    async connect(data, ws) {
      for (const bot of data.status.bots) data.self_id = bot.self.user_id
      Bot[data.self_id] = {
        adapter: this, ws: ws, sendApi: this.sendApi.bind(this, data, ws),
        stat: { ...data.status, start_time: data.time },
        info: {},
        get uin() { return this.info.user_id },
        get nickname() { return this.info.user_name },
        get avatar() { return this.info["wx.avatar"] },
        pickFriend: this.pickFriend.bind(this, data),
        get pickUser() { return this.pickFriend },
        getFriendArray: this.getFriendArray.bind(this, data),
        getFriendList: this.getFriendList.bind(this, data),
        getFriendMap: this.getFriendMap.bind(this, data),
        fl: new Map(),
        pickMember: this.pickMember.bind(this, data),
        pickGroup: this.pickGroup.bind(this, data),
        getGroupArray: this.getGroupArray.bind(this, data),
        getGroupList: this.getGroupList.bind(this, data),
        getGroupMap: this.getGroupMap.bind(this, data),
        getGroupMemberMap: this.getGroupMemberMap.bind(this, data),
        gl: new Map(), gml: new Map()
      }
      data.bot = Bot[data.self_id]
      if (!Bot.uin.includes(data.self_id)) Bot.uin.push(data.self_id)
      try { await this.waitForReady(data, ws) } catch (err) {
        Bot.makeLog("error", `后端未就绪: ${err.message}，请检查 ComWeChat 服务`, data.self_id)
        ws.terminate(); return
      }
      data.bot.info = (await this.callApi(data, ws, "get_self_info")).data
      data.bot.version = { ...(await this.callApi(data, ws, "get_version")).data, id: this.id, name: this.name }
      Promise.all([
        data.bot.getFriendMap().catch(err => {
          Bot.makeLog("error", `获取好友列表失败: ${err.message}`, data.self_id)
          setTimeout(() => data.bot.getFriendMap().catch(e => Bot.makeLog("error", `好友列表重试失败: ${e.message}`, data.self_id)), 30000)
        }),
        data.bot.getGroupMemberMap().catch(err => {
          Bot.makeLog("error", `获取群组列表失败: ${err.message}`, data.self_id)
          setTimeout(() => data.bot.getGroupMemberMap().catch(e => Bot.makeLog("error", `群组列表重试失败: ${e.message}`, data.self_id)), 30000)
        })
      ])
      this.startMemberWatch(data)
      Bot.makeLog("mark", `${this.name}(${this.id}) ${data.bot.version.impl}-${data.bot.version.version} 已连接`, data.self_id)
      Bot.em(`connect.${data.self_id || 'unknown'}`, data)
    }

    // ======================= 深度清洗，确保 null 被替换为空字符串 =======================
    // 必须做两件事，否则会 RangeError: Maximum call stack size exceeded：
    //   1) 用 WeakSet 兜底循环引用（bot/ws/adapter 等运行时对象存在自引用）；
    //   2) 跳过 bot / ws / adapter 这些运行时复杂对象，保留原引用、禁止深拷贝，
    //      否则既会无限递归，又会给插件一个被克隆坏的 e.bot。
    sanitize(obj, seen = new WeakSet()) {
      if (obj === null || obj === undefined) return '';
      const t = typeof obj;
      if (t === 'string' || t === 'number' || t === 'boolean') return obj;
      // 函数、Buffer、日期、集合、Promise 等非「纯数据」对象直接保留，不深拷贝
      if (t === 'function' || Buffer.isBuffer(obj) || obj instanceof Date ||
          obj instanceof Map || obj instanceof Set || obj instanceof Promise) {
        return obj;
      }
      if (Array.isArray(obj)) {
        return obj.map(item => this.sanitize(item, seen));
      }
      if (t === 'object') {
        if (seen.has(obj)) return '[Circular]'; // 兜底：循环引用返回占位，避免爆栈
        seen.add(obj);
        const result = {};
        for (const [key, value] of Object.entries(obj)) {
          if (key === 'bot' || key === 'ws' || key === 'adapter') {
            result[key] = value; // 保留运行时复杂对象的原引用，不递归
            continue;
          }
          result[key] = this.sanitize(value, seen);
        }
        seen.delete(obj);
        return result;
      }
      return obj;
    }
    // ===============================================================================

    // 防撤回：把一条消息的原文存进 recallCache，撤回事件到达时取回展示
    _cacheRecall(messageId, info) {
      if (!messageId) return;
      this.recallCache.set(messageId, info);
      // 超过上限则丢弃最旧的条目，避免无界增长
      if (this.recallCache.size > this.recallCacheCap) {
        const oldest = this.recallCache.keys().next().value;
        if (oldest !== undefined) this.recallCache.delete(oldest);
      }
    }

    // 非文本消息（图片/文件/语音等）没有 raw_message，给个简短摘要，撤回时也能看出类型
    _msgSummary(message) {
      if (!Array.isArray(message) || message.length === 0) return "";
      const tag = (t) => {
        switch (t) {
          case "image": return "[图片]";
          case "file": return "[文件]";
          case "record": return "[语音]";
          case "video": return "[视频]";
          case "emoji": return "[表情]";
          case "link": return "[链接]";
          case "at": return "@人";
          case "reply": return "[回复]";
          case "node": return "[合并转发]";
          case "raw": return "[原始消息]";
          default: return `[${t}]`;
        }
      };
      return message.map(i => i && i.type ? tag(i.type) : "").filter(Boolean).join(" ");
    }

    makeMessage(data) {
      data.detail_type = data.detail_type || 'unknown';
      data.message_type = data.detail_type;

      data.post_type = data.type || 'unknown';
      data.sub_type = data.sub_type || '';
      data.raw_message = data.alt_message || '';
      data.sender = { ...data.bot.fl.get(data.user_id), user_id: data.user_id || '' }
      // bot 自身多种 id 形态（用于可靠判断「引用了 bot 自己消息」，避免 wxid 格式不一致漏判）
      const botIds = new Set(
        [data.self_id, data.bot?.info?.user_id, ...(Array.isArray(data.bot?.uin) ? data.bot.uin : [])]
          .filter(v => v != null && String(v) !== '').map(v => String(v))
      )
      const message = []
      for (const i of data.message || [])
        switch (i.type) {
          case "mention": message.push({ type: "at", qq: i.data.user_id }); break
          case "mention_all": message.push({ type: "at", qq: "all" }); break
          case "voice": message.push({ type: "record", ...i.data }); break
          case "reply":
            // isSelf：引用的正好是 bot 自己发的消息 → 视为被直接叫到，可靠触发唤醒
            message.push({ type: "reply", id: i.data.message_id, user_id: i.data.user_id, isSelf: botIds.has(String(i.data.user_id)) }); break
          default: message.push({ type: i.type, ...i.data })
        }
      // 引用原文回填（2026-09-17 修复「引用一直为空」；2026-09-16 增强）：
      // 微信引用 appmsg 里，紧随 reply 的 text 段(title)通常是「用户自己追加的话」，被引原文要靠
      // refermsg/svrid 去取，而 ComWeChat 未实现 get_msg。但适配器已对收到的每条消息按 message_id
      // 缓存了原文（recallCache，上限 2000 条、覆盖本会话近期消息），正好可用 reply.id(=svrid) 直接命中——
      // 这是最可靠的被引原文来源（含 bot 自己被回灌的消息，所以引用 bot 自己也能命中）。
      // 决策：
      //   ① 优先用 recallCache 命中的被引原文（真实内容）；
      //   ② 若它存在且不同于紧随 reply 的 text 段(title)，说明 title 是用户追加的新话 → 保留在消息体里（不删），
      //      模型既能看到「引用了啥」也能看到「用户又说了啥」；
      //   ③ 仅当缓存取不到时，才退而把 title 段当被引原文用掉并移出（尽力而为，兼容旧行为）。
      const ri = message.findIndex(s => s.type === 'reply')
      if (ri >= 0) {
        // reply 段后紧跟的 text 段（title）可能是被引原文，也可能是用户追加的话
        let fromSeg = ''
        let segIdx = -1
        for (let k = ri + 1; k < message.length; k++) {
          if (message[k].type === 'text') {
            fromSeg = (message[k].text || message[k].data?.text || '').toString().trim()
            segIdx = k
            break
          }
        }
        const cached = this.recallCache.get(message[ri].id)
        const fromCache = (cached?.text || '').toString().trim()
        if (!fromCache) logger.debug(`[ComWeChat] 引用缓存未命中 id=${message[ri].id}（原消息可能重启前收到/超 2000 条上限/或 id 空间不符）→ 退 title 兜底`)
        // sender 修正（2026-10-05）：客户端旧版 handle_quote 把 refermsg/<fromusr>（=会话 id，群聊即群 id）
        // 当作发送者塞进 reply.user_id → isSelf 恒 false、「引用 bot 自己消息」永不唤醒。
        // 缓存里存的是收消息时的真实发送者（cache.sender）→ user_id 是群 id 形态时用缓存修正并重算 isSelf。
        if (cached?.sender && String(message[ri].user_id || '').endsWith('@chatroom')) {
          message[ri].user_id = cached.sender
          message[ri].isSelf = botIds.has(String(cached.sender))
        }
        let quoted = fromCache || fromSeg
        let keepNewText = false
        if (fromCache && fromSeg && fromCache !== fromSeg) {
          // 缓存命中且与被引 title 不同 → title 是用户追加的新内容，保留它作为 e.msg 的一部分
          quoted = fromCache
          keepNewText = true
        }
        if (quoted) {
          message[ri] = { ...message[ri], text: quoted }
          // 仅当 title 被当作被引原文用掉时才移出消息体（避免重复喂模型）；
          // 若 title 是用户追加的新话（keepNewText），保留它。
          if (segIdx >= 0 && !keepNewText) message.splice(segIdx, 1)
          logger.info(`[ComWeChat] 引用原文回填: "${quoted.slice(0, 40)}${quoted.length > 40 ? '…' : ''}"${keepNewText ? '（保留用户追加文本）' : ''}`)
        }
        // 诊断：引用消息关键字段（warn 级落盘 command.log，排查「引用不回复」）
        logger.warn(`[ComWeChat] 引用诊断 user_id=${JSON.stringify(message[ri]?.user_id)} isSelf=${message[ri]?.isSelf} botIds=${JSON.stringify([...botIds])} fromSeg=${JSON.stringify(fromSeg)} fromCache=${JSON.stringify(fromCache)} 回填后message=${JSON.stringify(message)}`)
      }
      data.message = message
      switch (data.message_type) {
        case "private": Bot.makeLog("info", `好友消息：${data.raw_message}`, `${data.self_id} <= ${data.user_id}`, true); break
        case "group": Bot.makeLog("info", `群消息：${data.raw_message}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true); break
        default: Bot.makeLog("warn", `未知消息（类型 ${data.message_type}）：${logger.magenta(data.raw)}`, data.self_id)
      }
      // 防撤回：缓存原文，撤回事件到达时取回（非文本消息用结构摘要兜底）
      this._cacheRecall(data.message_id, {
        text: data.raw_message || this._msgSummary(message),
        sender: data.user_id,
        group: data.group_id || "",
        time: Date.now()
      });
      Bot.em(`${data.post_type}.${data.message_type}`, this.sanitize(data));
    }

    makeNotice(data) {
      data.detail_type = data.detail_type || 'unknown';
      data.post_type = data.type || 'unknown';
      data.notice_type = data.group_id ? "group" : "friend";
      data.sub_type = data.sub_type || '';
      switch (data.detail_type) {
        case "private_message_delete": {
          Bot.makeLog("info", `好友消息撤回：${data.message_id}`, `${data.self_id} <= ${data.user_id}`, true);
          data.sub_type = "recall";
          const c = this.recallCache.get(data.message_id);
          if (c) { data.original_content = c.text; data.original_sender = c.sender; }
          break;
        }
        case "group_message_delete": {
          Bot.makeLog("info", `群消息撤回：${data.operator_id} => ${data.user_id} ${data.message_id}`, `${data.self_id} <= ${data.group_id}`, true);
          data.sub_type = "recall";
          const c = this.recallCache.get(data.message_id);
          if (c) { data.original_content = c.text; data.original_sender = c.sender; }
          break;
        }
        case "wx.get_private_file": Bot.makeLog("info", `私聊文件：${data.file_name} ${data.file_length} ${data.md5}`, `${data.self_id} <= ${data.user_id}`, true); break
        case "wx.get_group_file": Bot.makeLog("info", `群文件：${data.file_name} ${data.file_length} ${data.md5}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true); break
        case "wx.get_private_redbag": Bot.makeLog("info", `好友红包`, `${data.self_id} <= ${data.user_id}`, true); break
        case "wx.get_group_redbag": Bot.makeLog("info", `群红包`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true); break
        case "wx.get_private_poke": data.operator_id = data.from_user_id; data.target_id = data.user_id; Bot.makeLog("info", `好友拍一拍：${data.operator_id} => ${data.target_id}`, data.self_id); break
        case "wx.get_group_poke": data.operator_id = data.from_user_id; data.target_id = data.user_id; Bot.makeLog("info", `群拍一拍：${data.operator_id} => ${data.target_id}`, `${data.self_id} <= ${data.group_id}`, true); break
        case "wx.get_private_card": Bot.makeLog("info", `好友用户名片：${data.v3} ${data.v4} ${data.nickname} ${data.head_url} ${data.province} ${data.city} ${data.sex}`, `${data.self_id} <= ${data.user_id}`, true); break
        case "wx.get_group_card": Bot.makeLog("info", `群用户名片：${data.v3} ${data.v4} ${data.nickname} ${data.head_url} ${data.province} ${data.city} ${data.sex}`, `${data.self_id} <= ${data.group_id}, ${data.user_id}`, true); break
        case "wx.get_transfer": Bot.makeLog("info", `收到转账：${data.amount} 来自 ${data.user_id}${data.group_id ? " 群 " + data.group_id : ""}`, `${data.self_id} <= ${data.user_id}`, true); break
        case "wx.get_group_invite": Bot.makeLog("info", `群邀请：${data.user_id} 邀请进入「${data.group_name}」${data.group_id ? " (" + data.group_id + ")" : ""}`, `${data.self_id} <= ${data.user_id}`, true); break
        case "wx.system_notice":
          data.sub_type = "system"
          Bot.makeLog("info", `系统提示：${data.category || ""} ${data.notice_text || ""}`, `${data.self_id} <= ${data.user_id}${data.group_id ? " @ " + data.group_id : ""}`, true)
          break
        default:
          Bot.makeLog("warn", `未知通知（可能是鸿蒙特有）：${logger.magenta(data.raw)}`, data.self_id)
          Bot.makeLog("debug", `[鸿蒙原始数据] ${JSON.stringify(data)}`, data.self_id)
          return
      }
      if (!data.sub_type && data.detail_type && typeof data.detail_type === 'string') {
        data.sub_type = data.detail_type.split("_").pop()
      }
      if (!data.sub_type) data.sub_type = 'unknown';
      Bot.em(`${data.post_type}.${data.notice_type}.${data.sub_type}`, this.sanitize(data));
    }

    makeRequest(data) {
      data.detail_type = data.detail_type || 'unknown';
      data.post_type = data.type || 'unknown';
      data.request_type = data.group_id ? "group" : "friend";
      data.sub_type = data.sub_type || '';
      switch (data.detail_type) {
        case "wx.friend_request":
          Bot.makeLog("info", `加好友请求：${data.v3} ${data.v4} ${data.nickname} ${data.content} ${data.province} ${data.city}`, `${data.self_id} <= ${data.user_id}`, true)
          data.sub_type = "add"; break
        default:
          Bot.makeLog("warn", `未知请求（可能是鸿蒙特有）：${logger.magenta(data.raw)}`, data.self_id)
          Bot.makeLog("debug", `[鸿蒙原始数据] ${JSON.stringify(data)}`, data.self_id)
          return
      }
      if (!data.sub_type && data.detail_type && typeof data.detail_type === 'string') {
        data.sub_type = data.detail_type.split("_").pop()
      }
      if (!data.sub_type) data.sub_type = 'unknown';
      Bot.em(`${data.post_type}.${data.request_type}.${data.sub_type}`, this.sanitize(data));
    }

    makeMeta(data, ws) {
      switch (data.detail_type) {
        case "heartbeat": break
        case "connect": break
        case "status_update": this.connect(data, ws); break
        default: Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id)
      }
    }

    message(data, ws) {
      try { data = { ...JSON.parse(data), raw: Bot.String(data) } } catch (err) { return Bot.makeLog("error", ["解码数据失败", data, err]) }
      if (data.self?.user_id) data.self_id = data.self.user_id; else data.self_id = data.id
      if (data.type) {
        if (data.type !== "meta" && !Bot.uin.includes(data.self_id)) {
          Bot.makeLog("warn", `找不到对应Bot，忽略消息：${logger.magenta(data.raw)}`, data.self_id); return false
        }
        data.bot = Bot[data.self_id]
        switch (data.type) {
          case "meta": return this.makeMeta(data, ws)
          case "message": return this.makeMessage(data)
          case "notice": return this.makeNotice(data)
          case "request": return this.makeRequest(data)
        }
      } else if (data.echo) {
        const cache = this.echo.get(data.echo)
        if (cache) { if (cache.timeout) clearTimeout(cache.timeout); cache.resolve(data) }
        return
      }
      Bot.makeLog("warn", `未知消息：${logger.magenta(data.raw)}`, data.self_id)
    }

    // ======================= 进群/退群事件合成 =======================
    // ComWeChat-Client v0.0.8 不 emit 成员进群/退群 notice，导致群管插件收不到。
    // 这里定时拉取各群成员列表并与上一次快照差分，新增/消失即合成
    // notice.group.increase / notice.group.decrease，使现有群管插件无需改动即可工作。
    startMemberWatch(data) {
      this.memberSnapshots = this.memberSnapshots || new Map()
      this.memberFailStreak = this.memberFailStreak || new Map()
      this.memberSkipUntil = this.memberSkipUntil || new Map()
      // 默认 3 分钟轮询一次（可由锅巴「ComWeChat」配置页 memberWatchIntervalSec 调整，30~600s），
      // 在 COM 通道压力与通知时效间取平衡：
      // 个别大群 get_group_member_list 在 COM 里读成员列表会很慢（60~90s 常见，>120s 偶发），
      // 单群 race 超时已放宽到 110s（memberWatchGroupTimeoutMs），让大群能在超时前真正取回，
      // 并加「单轮 COM 预算(间隔×0.6)+超时熔断」避免单轮过长拖垮连接；群少且多为中小群时 3 分钟安全。
      // 同账号 ≥4 个超大群且单群耗时逼近预算时，检测延迟会变长（轮询被分摊到多轮），此时可回退 300s。
      // 3 分钟把进退群检测延迟压到 3 分钟内（中小群可达），比 5 分钟更及时。
      this.watchInterval = resolveWatchInterval()
      // 连续失败几次才退避（默认 3，可锅巴 memberWatchBackoffAfter 调整，1~10）：
      // 不再「首次失败即踢出」——大群 COM 读成员列表偶发卡顿很常见，一次抖动不该黑掉 51 分钟。
      // 仍保留 fail-fast 精神：真正连续多次失败的群才退避，保护客户端单连接不被反复阻塞。
      this.watchBackoffAfter = resolveWatchBackoffAfter()
      // 退避时跳过的 tick 数（watchInterval×该值 ≈ 退避总时长，默认 17≈180s×17≈51分钟后再试；
      // 可由锅巴 memberWatchBackoffTicks 调整，1~60）
      this.watchSkipTicks = resolveWatchSkipTicks()
      this.watchToken = (this.watchToken || 0) + 1
      const token = this.watchToken
      Bot.makeLog("info", `启动群成员轮询(间隔 ${this.watchInterval / 1000}s)，用于合成进群/退群事件`, data.self_id)
      this.watchTick(data, token)
    }

    async watchTick(data, token) {
      if (token !== this.watchToken) return
      if (!data.bot?.ws) return
      // 每轮重新解析配置（15s TTL 缓存），锅巴改间隔/退避/超时/连续次数后下一轮即生效，无需重启
      this.watchInterval = resolveWatchInterval()
      this.watchSkipTicks = resolveWatchSkipTicks()
      this.watchGroupTimeoutMs = resolveWatchGroupTimeoutMs()
      this.watchBackoffAfter = resolveWatchBackoffAfter()
      try {
        if (!data.bot.gl || data.bot.gl.size === 0) {
          await data.bot.getGroupMap(data).catch(() => {})
        }
        const tickStart = Date.now()
        const tickBudget = this.watchInterval * 0.6   // 单轮 COM 占用上限，留余量给心跳/消息，防止单轮过长拖累连接
        let circuitOpen = false                        // 本轮出现超时则熔断，停止继续打 COM（客户端正忙）
        for (const [group_id] of (data.bot.gl || new Map())) {
          if (group_id === "filehelper") continue
          // 退避中：递减计数并跳过，避免对已知卡顿的群反复发请求
          const skipLeft = this.memberSkipUntil.get(group_id) || 0
          if (skipLeft > 0) {
            this.memberSkipUntil.set(group_id, skipLeft - 1)
            continue
          }
          // 熔断：本轮机有群超时（客户端 COM 正忙），不再继续打其余群，等下轮，避免级联超时
          if (circuitOpen) {
            Bot.makeLog("warn", `群 ${group_id} 本轮跳过：检测到客户端 COM 繁忙，避免级联超时`, data.self_id)
            continue
          }
          // 单轮时间预算耗尽（多为存在大群拖慢），剩余群下轮再查，防止单轮过长拖累连接
          if (Date.now() - tickStart > tickBudget) {
            Bot.makeLog("warn", `群 ${group_id} 及后续本轮跳过：已达单轮 COM 预算(${Math.round(tickBudget / 1000)}s)，下轮续查`, data.self_id)
            continue
          }
          try {
            // 单群 race 超时兜底（可锅巴配置，默认 110s）：放宽到大于大群真实 COM 耗时，
            // 让大群能在超时前真正取回，而非 45s 被提前放弃后级联拖垮其余群。
            let timedOut = false
            const members = await Promise.race([
              this.getMemberArray({ ...data, group_id }, 1)
                .then(m => ({ ok: true, m }))
                .catch(e => ({ ok: false, e })),
              new Promise(res => { setTimeout(() => { timedOut = true; res(null) }, this.watchGroupTimeoutMs) })
            ])
            if (timedOut) {
              // 客户端 COM 繁忙/卡顿：记一次失败并熔断本轮，不再继续打其余群
              const fail = (this.memberFailStreak.get(group_id) || 0) + 1
              this.memberFailStreak.set(group_id, fail)
              circuitOpen = true
              if (fail >= this.watchBackoffAfter) {
                this.memberSkipUntil.set(group_id, this.watchSkipTicks)
                this.memberFailStreak.set(group_id, 0)
                Bot.makeLog("error", `群 ${group_id} 成员列表连续 ${fail} 次超时，进入退避（跳过后续 ${this.watchSkipTicks} 个轮询周期，约 ${Math.round(this.watchInterval / 1000 * this.watchSkipTicks / 60)} 分钟后再试）`, data.self_id)
              } else {
                Bot.makeLog("error", `群 ${group_id} 成员列表获取超时（连续 ${fail} 次），本轮熔断，下轮重试`, data.self_id)
              }
              continue
            }
            if (!members || !members.ok || !Array.isArray(members.m)) {
              const fail = (this.memberFailStreak.get(group_id) || 0) + 1
              this.memberFailStreak.set(group_id, fail)
              if (fail >= this.watchBackoffAfter) {
                this.memberSkipUntil.set(group_id, this.watchSkipTicks)
                this.memberFailStreak.set(group_id, 0)
                Bot.makeLog("error", `群 ${group_id} 成员列表连续 ${fail} 次获取失败，进入退避（跳过后续 ${this.watchSkipTicks} 个轮询周期，约 ${Math.round(this.watchInterval / 1000 * this.watchSkipTicks / 60)} 分钟后再试）`, data.self_id)
              } else {
                Bot.makeLog("error", `群 ${group_id} 成员列表获取失败（连续 ${fail} 次），下轮重试`, data.self_id)
              }
              continue
            }
            this.memberFailStreak.set(group_id, 0)
            const cur = new Map()
            for (const m of members.m) cur.set(m.user_id, m.nickname || m.name || "")
            const prev = this.memberSnapshots.get(group_id)
            // 首次仅建立基线，不发事件，避免误欢迎/误退群通知
            if (!prev) { this.memberSnapshots.set(group_id, cur); continue }
            for (const [uid, nick] of cur) {
              if (!prev.has(uid)) this.emitGroupNotice(data, group_id, uid, "increase", nick)
            }
            for (const [uid, nick] of prev) {
              if (!cur.has(uid)) this.emitGroupNotice(data, group_id, uid, "leave", nick)
            }
            this.memberSnapshots.set(group_id, cur)
          } catch (e) {
            const fail = (this.memberFailStreak.get(group_id) || 0) + 1
            this.memberFailStreak.set(group_id, fail)
            Bot.makeLog("error", `群 ${group_id} 成员轮询异常: ${e.message}`, data.self_id)
          }
          await Bot.sleep(2000)   // 群间留 2s 空隙，给客户端 COM/心跳喘息
        }
      } catch (e) {
        Bot.makeLog("error", `成员轮询异常: ${e.message}`, data.self_id)
      } finally {
        if (token === this.watchToken) {
          this.watchTimer = setTimeout(() => this.watchTick(data, token), this.watchInterval)
        }
      }
    }

    emitGroupNotice(data, group_id, user_id, sub_type, nickname) {
      // sub_type: "increase" -> 进群；"leave" -> 退群。
      // 进群用标准事件 notice.group.increase；退群映射到标准事件 notice.group.decrease，
      // 这样现有群管插件（监听 notice.group.decrease）无需改动即可工作。
      const isLeave = sub_type === "leave"
      const eventName = isLeave ? "decrease" : "increase"
      const payload = {
        post_type: "notice",
        notice_type: "group",
        // 注意：Yunzai loader 用 post_type.notice_type.sub_type 拼事件名来匹配插件
        // （见 loader.js eventMap.notice），所以 sub_type 必须与事件名一致，
        // 否则 notice.group.decrease/increase 监听器收不到。不能用 leave/add。
        sub_type: isLeave ? "decrease" : "increase",
        detail_type: `group.${eventName}`,
        group_id,
        user_id,
        self_id: data.self_id,
        member: { user_id, nickname: nickname || "", card: nickname || "", name: nickname || "" },
        time: Math.floor(Date.now() / 1000),
      }
      Bot.makeLog("info", `合成${isLeave ? "退群" : "进群"}事件: ${group_id} ${user_id} ${nickname || ""}`, data.self_id)
      Bot.em(`notice.group.${eventName}`, this.sanitize(payload))
    }
    // ===================================================================

    load() {
      if (!Array.isArray(Bot.wsf[this.path])) Bot.wsf[this.path] = []
      Bot.wsf[this.path].push((ws, ...args) => ws.on("message", data => this.message(data, ws, ...args)))
    }
  })(),
)