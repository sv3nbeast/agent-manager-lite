// A paginated rollout depends on other physical segments through history_base.
// Single-rollout copying and event-level merging cannot preserve that chain.
import type {SessionTransferSource} from './sessions'
import {firstSessionEvent,openSessionFile} from './sessionFiles'
import {verifySource} from './sessionTransferFiles'

export async function assertUnpagedSessionSources(sources:SessionTransferSource[],signal:AbortSignal):Promise<void>{
  const unsupported=()=>{throw new Error('会话使用分段历史，当前单会话复制、ZIP 导出导入或同步不能保留完整记录。请在实例页面使用“复制实例”保留完整会话。')}
  for(const source of sources){
    signal.throwIfAborted()
    if(source.record.historyMode==='paginated')unsupported()
    // Imported ZIPs and independent callers have no catalog-derived historyMode.
    // Inspect the actual header instead of guessing from a filename suffix.
    await verifySource(source)
    const {file,stat}=await openSessionFile(source.root,source.path)
    try{
      const meta=await firstSessionEvent(file,stat.size,signal)
      if(meta?.type==='session_meta'&&(meta.payload?.history_mode==='paginated'||typeof meta.payload?.history_base?.thread_id==='string'&&!!meta.payload.history_base.thread_id))unsupported()
      await verifySource(source)
    }finally{await file.close()}
  }
}
