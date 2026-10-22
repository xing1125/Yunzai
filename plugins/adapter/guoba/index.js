import pluginInfo from "./pluginInfo.js"
import { schemas, getConfigData, setConfigData } from "./configInfo.js"

export function supportGuoba() {
  return {
    pluginInfo,
    configInfo: { schemas, getConfigData, setConfigData }
  }
}
