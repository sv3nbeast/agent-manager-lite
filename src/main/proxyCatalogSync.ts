import type {State} from './store'
import type {StoredCatalogSource} from './proxyCatalog'
import {freezeProxyCatalog} from './proxyCatalogGraph'
import {encodeCatalogBinding} from './proxyCatalogBinding'
import {proxyEligible,unifiedProxyURL} from './proxyPolicy'

// Source refresh changes the catalog, never the independent resource snapshots.
// Unified has its own snapshot so shared resource references cannot reroute them.
export function syncUnifiedCatalog(state:State,source:StoredCatalogSource,inUse:(id:string)=>boolean):void{
 const unified=state.unifiedProxy,resource=state.proxyResources?.find(r=>r.id===unified?.resourceId)
 if(unified?.mode!=='all_accounts'||resource?.catalog?.sourceId!==source.id)return
 let url:string
 try{url=encodeCatalogBinding(freezeProxyCatalog(source.catalog,resource.catalog.itemId,resource.catalog.selections))}
 catch{unified.pending=false;unified.staleError='原选择在新目录中不可用，统一出口保留上次快照，请重新选择';return}
 let original:string|undefined;try{original=unifiedProxyURL(state)}catch{}
 if(original!==url&&state.accounts.some(a=>proxyEligible(a)&&!a.proxy&&inUse(a.id))){unified.pending=true;unified.staleError='来源已更新，统一出口将在相关服务、刷新和检测停止后应用';return}
 // Explicit invalidation still requires the resource repair flow.
 if(resource.catalog.invalid){unified.pending=false;unified.staleError='代理资源已失效，请先重新选择资源';return}
 unified.snapshot={url,resourceRevision:resource.revision,sourceRevision:source.revision};delete unified.pending;delete unified.staleError
}
