export default {
  // 注意：锅巴以「插件目录名」为键注册（见 adapter-guoba 桥接目录），此处 name 必须与之一致
  name: "adapter-guoba",
  title: "ComWeChat 适配器 · 群成员监听",
  author: "ying",
  link: "",
  isV3: true,
  isV2: false,
  description:
    "ComWeChat 适配器的群成员轮询参数（进群/退群检测间隔、失败退避、单群超时）。" +
    "写入 adapter/config/config/comwechat.yaml，与运行时 ComWeChat.js 读取同一份文件，保存后下一轮轮询即生效。"
}
