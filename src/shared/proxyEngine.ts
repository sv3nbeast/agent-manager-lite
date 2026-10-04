// User-triggered pinned Mihomo installation; no paths or process output cross IPC.
export const enginePhases = ['idle','downloading','importing','verifying','extracting','checking','installing','completed','cancelled','failed'] as const
export type EnginePhase = typeof enginePhases[number]
export const engineErrors = {
  ENGINE_INSTALL_UNSUPPORTED:'当前系统或架构尚无支持的代理引擎',
  ENGINE_INSTALL_BUSY:'代理引擎安装或检查正在进行',
  ENGINE_INSTALL_DOWNLOAD:'官方下载失败，请重试或导入对应版本的压缩包',
  ENGINE_INSTALL_CHECKSUM:'安装包校验不匹配，请使用指定的官方安装包',
  ENGINE_INSTALL_ARCHIVE:'安装包格式无效或包含不安全的文件',
  ENGINE_INSTALL_TOO_LARGE:'安装包或解压内容超过大小限制',
  ENGINE_INSTALL_VERIFY:'已安装文件缺失或校验失败，请重新安装',
  ENGINE_INSTALL_IO:'代理引擎文件操作失败，原安装保持不变',
  ENGINE_INSTALL_TIMEOUT:'安装超时，已停止本次操作',
  ENGINE_INSTALL_CANCELLED:'已取消安装',
  ENGINE_INSTALL_START_TIMEOUT:'引擎首次启动检查超时',
  ENGINE_INSTALL_START_FAILED:'引擎无法运行，请检查系统与架构是否匹配',
  ENGINE_INSTALL_VERSION:'引擎版本与指定版本不匹配',
  PROXY_ENGINE_MISSING:'尚未安装代理引擎',
  PROXY_ENGINE_TIMEOUT:'引擎检查超时',
  PROXY_ENGINE_STOPPED:'应用正在退出'
} as const
export type EngineErrorCode=keyof typeof engineErrors
export interface EngineStatus {
  supported:boolean;version:string;installedVersion:string|null;assetName:string|null;archiveBytes:number|null
  jobId:string|null;phase:EnginePhase;receivedBytes:number;totalBytes:number|null;error:EngineErrorCode|null
}
export const engineActive=(state:EngineStatus|undefined)=>!!state&&['downloading','importing','verifying','extracting','checking','installing'].includes(state.phase)
