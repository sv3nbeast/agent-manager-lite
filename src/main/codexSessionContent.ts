import type { FileHandle } from 'node:fs/promises'
import type { SessionContentBlock, SessionContentMessage } from '../shared/sessions'
import { jsonLine, sessionLines, sessionTimestamp } from './sessionFiles'

const maxMessageCharacters = 24_000
const maxPageCharacters = 256_000
const maxBlocksPerMessage = 128
const emptySignal = new AbortController().signal

type JsonObject = Record<string, any>
export interface CodexSessionContentPage {
  page: number
  pageSize: number
  total: number
  messages: SessionContentMessage[]
  warnings: string[]
}

function object(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

function clean(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function serialized(value: unknown): string {
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? '' } catch { return '[工具参数无法显示]' }
}

function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return value == null ? '' : serialized(value)
  return value.flatMap(item => {
    const block = object(item)
    if (block?.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block?.type === 'image' || block?.type === 'document') return ['[附件内容未展开]']
    return []
  }).join('\n')
}

function timestamp(value: unknown): number | undefined {
  return sessionTimestamp(value)
}

function role(value: unknown): SessionContentMessage['role'] {
  if (value === 'user') return 'user'
  if (value === 'system' || value === 'developer') return 'system'
  return 'assistant'
}

interface ParsedMessage { message: SessionContentMessage; searchText: string; truncated: boolean }

export interface CodexRolloutContent {
  warnings: string[]
  historyBaseThreadId?: string
  historyBaseEndOrdinalExclusive?: number
  historyBaseEndByteOffset?: number
  sessionMetaId?:string
  paginated:boolean
  hasHistoryBase:boolean
}

function messageFromEvent(event: JsonObject, index: number, charLimit: number): ParsedMessage | undefined {
  const payload = object(event.payload)
  if (!payload) return
  const eventType = text(event.type)
  const payloadType = text(payload.type)
  const blocks: SessionContentBlock[] = []
  let remaining = charLimit
  let truncated = false
  let searchText = ''

  const add = (type: SessionContentBlock['type'], value: unknown, name?: string): void => {
    if (blocks.length >= maxBlocksPerMessage) { truncated = true; return }
    const raw = clean(text(value))
    if (!raw && type !== 'tool_use' && type !== 'tool_result') return
    const room = Math.max(0, remaining)
    const body = raw.slice(0, room)
    const cut = body.length < raw.length
    if (cut) truncated = true
    const rawName = name?.slice(0, 200)
    const safeName = rawName?.slice(0, Math.max(0, room - body.length))
    if (rawName && (safeName?.length ?? 0) < rawName.length) truncated = true
    const block: SessionContentBlock = { type, text: body, ...(safeName ? { name: safeName } : {}), ...(cut ? { truncated: true } : {}) }
    blocks.push(block)
    remaining -= body.length + (safeName?.length ?? 0)
    searchText += body + ' ' + (safeName ?? '') + ' '
  }

  const contentBlock = (raw: unknown): void => {
    const block = object(raw)
    if (!block) { if (typeof raw === 'string') add('text', raw); return }
    const type = text(block.type)
    if (['input_text', 'output_text', 'text'].includes(type)) add('text', block.text)
    else if (['function_call', 'tool_call', 'tool_use', 'custom_tool_call'].includes(type)) {
      const args = block.arguments ?? block.input ?? block.parameters
      const rendered = args === undefined ? '' : serialized(args)
      add('tool_use', rendered, text(block.name) || text(block.tool_name) || '工具调用')
    } else if (['function_call_output', 'tool_result', 'tool_output', 'custom_tool_call_output'].includes(type)) {
      add('tool_result', contentText(block.output ?? block.content ?? block.result ?? ''), text(block.name) || text(block.tool_name) || '工具结果')
    } else if (type === 'image' || type === 'input_image' || type === 'audio' || type === 'input_audio' || type === 'document') {
      add('notice', '附件内容未展开，请在原客户端查看')
    } else if (type === 'refusal' && typeof block.refusal === 'string') add('notice', block.refusal)
    else if (type === 'reasoning') add('notice', '此处包含未在会话预览中展开的内部推理记录')
    else {
      const label = type ? type.slice(0, 100) : '未知类型'
      add('notice', '未识别的 Codex 消息块类型：' + label + '；原始内容已隐藏')
    }
  }

  let messageRole: SessionContentMessage['role'] = 'assistant'
  if (eventType === 'event_msg') {
    if (payloadType === 'user_message') {
      messageRole = 'user'
      if (typeof payload.message === 'string') add('text', payload.message)
      else if (Array.isArray(payload.message)) for (const item of payload.message) contentBlock(item)
      if ((Array.isArray(payload.images) && payload.images.length) || (Array.isArray(payload.local_images) && payload.local_images.length)) add('notice', '消息包含图片附件，未在会话预览中展开')
    } else if (payloadType === 'agent_message') {
      messageRole = 'assistant'
      if (typeof payload.message === 'string') add('text', payload.message)
      else if (Array.isArray(payload.message)) for (const item of payload.message) contentBlock(item)
    } else if (['function_call', 'tool_call', 'tool_use', 'custom_tool_call'].includes(payloadType)) {
      add('tool_use', serialized(payload.arguments ?? payload.input ?? payload.parameters ?? ''), text(payload.name) || text(payload.tool_name) || '工具调用')
    } else if (['function_call_output', 'tool_result', 'tool_output', 'custom_tool_call_output'].includes(payloadType)) {
      add('tool_result', contentText(payload.output ?? payload.content ?? payload.result ?? ''), text(payload.name) || text(payload.tool_name) || '工具结果')
    } else if (payloadType === 'web_search_call') {
      add('tool_use', serialized(payload.action ?? payload.query ?? payload), 'Web 搜索')
    } else return
  } else if (eventType === 'response_item') {
    if (payloadType === 'message') {
      messageRole = role(payload.role)
      if (typeof payload.content === 'string') add('text', payload.content)
      else if (Array.isArray(payload.content)) for (const item of payload.content) contentBlock(item)
    } else if (['function_call', 'tool_call', 'tool_use', 'custom_tool_call'].includes(payloadType)) {
      add('tool_use', serialized(payload.arguments ?? payload.input ?? payload.parameters ?? ''), text(payload.name) || text(payload.tool_name) || '工具调用')
    } else if (['function_call_output', 'tool_result', 'tool_output', 'custom_tool_call_output'].includes(payloadType)) {
      add('tool_result', contentText(payload.output ?? payload.content ?? payload.result ?? ''), text(payload.name) || text(payload.tool_name) || '工具结果')
    } else if (payloadType === 'web_search_call') {
      add('tool_use', serialized(payload.action ?? payload.query ?? payload), 'Web 搜索')
    } else if (payloadType === 'reasoning') {
      add('notice', '此处包含未在会话预览中展开的内部推理记录')
    } else {
      const label = payloadType ? payloadType.slice(0, 100) : '未知类型'
      add('notice', `未识别的 Codex 对话记录类型：${label}；原始内容已隐藏`)
    }
  } else return

  if (!blocks.length) return
  if (remaining <= 0) truncated = true
  const model = typeof payload.model === 'string' ? payload.model.slice(0, 200) : undefined
  const message: SessionContentMessage = {
    index, role: messageRole, timestamp: timestamp(event.timestamp ?? payload.timestamp),
    ...(model ? { model } : {}), blocks, ...(truncated ? { truncated: true } : {}),
  }
  return { message, searchText, truncated }
}


/** Read a Codex rollout without taking ownership of the open file.
 * Only conversation and tool events enter the returned page; account/session
 * metadata and token counters stay in their existing metadata readers. */
export async function readCodexSessionContent(
  file: FileHandle,
  size: number,
  raw: { page?: number; pageSize?: number; query?: string } = {},
  signal: AbortSignal = emptySignal,
): Promise<CodexSessionContentPage> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Codex 会话文件大小无效')
  const page = raw.page ?? 1, pageSize = raw.pageSize ?? 40, queryValue = raw.query ?? ''
  if (!Number.isInteger(page) || page < 1 || page > 100_000) throw new Error('会话内容页码无效')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new Error('会话内容每页数量无效')
  if (typeof queryValue !== 'string' || queryValue.trim().length > 200) throw new Error('会话内容搜索词无效')
  const input = { page, pageSize, query: queryValue.trim() }
  const result: CodexSessionContentPage = { page: input.page, pageSize: input.pageSize, total: 0, messages: [], warnings: [] }
  const start = (input.page - 1) * input.pageSize
  const query = input.query.toLocaleLowerCase()
  const perMessageLimit = Math.min(maxMessageCharacters, Math.floor(maxPageCharacters / input.pageSize))
  let messageIndex = 0, invalidLines = 0, searchWasTruncated = false

  for await (const line of sessionLines(file, size, signal)) {
    signal.throwIfAborted()
    if (!line.length) continue
    const event = jsonLine(line)
    if (!event) { invalidLines++; continue }
    const parsed = messageFromEvent(event, messageIndex, perMessageLimit)
    if (!parsed) continue
    messageIndex++
    if (query && !parsed.searchText.toLocaleLowerCase().includes(query)) {
      if (parsed.truncated) searchWasTruncated = true
      continue
    }
    const position = result.total++
    if (position >= start && position < start + input.pageSize) result.messages.push(parsed.message)
  }
  signal.throwIfAborted()
  if (invalidLines) result.warnings.push(invalidLines + ' 行记录格式无效，已跳过')
  if (searchWasTruncated) result.warnings.push('部分超长消息已截断，搜索不包含被省略的内容；可打开源文件查看')
  if (result.messages.some(message => message.truncated)) result.warnings.push('部分长消息或工具输出已截断，可打开源文件查看完整内容')
  return result
}

export interface CodexRolloutSegmentSource {
  file:FileHandle
  size:number
  maxLineBytes?:number
  startOrdinal:number
  endOrdinalExclusive?:number
  expectedEndByteOffset?:number
  expectedInitialOrdinal?:number
}

/** Read verified Codex rollout lineage segments in thread order. The caller
 * resolves history_base rollout IDs and opens every file within the same
 * managed CODEX_HOME. A segment boundary is checked against the source byte
 * offset before any messages are returned. */
export async function readCodexSessionLineageContent(
  segments:CodexRolloutSegmentSource[],
  raw:{page?:number;pageSize?:number;query?:string}={},
  signal:AbortSignal=emptySignal,
):Promise<CodexSessionContentPage>{
  const pageNumber=raw.page??1,pageSize=raw.pageSize??40,queryValue=raw.query??''
  if(!Number.isInteger(pageNumber)||pageNumber<1||pageNumber>100_000)throw new Error('会话内容页码无效')
  if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new Error('会话内容每页数量无效')
  if(typeof queryValue!=='string'||queryValue.trim().length>200)throw new Error('会话内容搜索词无效')
  if(!segments.length||segments.length>100)throw new Error('Codex 分段历史数量无效')
  const input={page:pageNumber,pageSize,query:queryValue.trim()},result:CodexSessionContentPage={page:pageNumber,pageSize,total:0,messages:[],warnings:[]}
  const start=(input.page-1)*input.pageSize,query=input.query.toLocaleLowerCase(),perMessageLimit=Math.min(maxMessageCharacters,Math.floor(maxPageCharacters/input.pageSize))
  let messageIndex=0,invalidLines=0,searchWasTruncated=false,totalBytes=0
  for(const segment of segments){
    signal.throwIfAborted()
    if(!Number.isSafeInteger(segment.size)||segment.size<0||!Number.isSafeInteger(segment.startOrdinal)||segment.startOrdinal<0||segment.endOrdinalExclusive!==undefined&&(!Number.isSafeInteger(segment.endOrdinalExclusive)||segment.endOrdinalExclusive<segment.startOrdinal))throw new Error('Codex rollout 分段范围无效')
    totalBytes+=segment.size;if(totalBytes>1024*1024*1024)throw new Error('Codex 分段历史超过 1 GiB 读取上限')
    let offset=0,firstRecord=true,lastOrdinal=-1,boundaryOffset:number|undefined,firstOrdinal:number|undefined
    for await(const line of sessionLines(segment.file,segment.size,signal,segment.maxLineBytes??4*1024*1024)){
      signal.throwIfAborted()
      const lineStart=offset,nextOffset=offset+line.length+(offset+line.length<segment.size?1:0),event=line.length?jsonLine(line):undefined
      if(line.length&&!event){invalidLines++;offset=nextOffset;firstRecord=false;continue}
      if(event){
        const ordinal=event.ordinal
        if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal<=lastOrdinal)throw new Error('Codex 分段 rollout ordinal 无效或未按顺序递增')
        if(firstOrdinal===undefined)firstOrdinal=ordinal
        lastOrdinal=ordinal
        if(firstRecord&&event.type!=='session_meta')throw new Error('Codex rollout 首条记录不是 session_meta')
        if(firstRecord&&event.type==='session_meta'&&(object(event.payload)??event).history_mode!=='paginated')throw new Error('Codex lineage 包含非分页 rollout')
        firstRecord=false
        if(segment.endOrdinalExclusive!==undefined&&boundaryOffset===undefined&&ordinal>=segment.endOrdinalExclusive)boundaryOffset=lineStart
        if(ordinal>=segment.startOrdinal&&(segment.endOrdinalExclusive===undefined||ordinal<segment.endOrdinalExclusive)){
          const parsed=messageFromEvent(event,messageIndex,perMessageLimit)
          if(parsed){messageIndex++;if(query&&!parsed.searchText.toLocaleLowerCase().includes(query)){if(parsed.truncated)searchWasTruncated=true}else{const position=result.total++;if(position>=start&&position<start+input.pageSize)result.messages.push(parsed.message)}}
        }
      }else if(line.length){invalidLines++;firstRecord=false}
      offset=nextOffset
    }
    if(firstRecord)throw new Error('Codex rollout 缺少 session_meta')
    if(segment.expectedInitialOrdinal!==undefined&&firstOrdinal!==segment.expectedInitialOrdinal)throw new Error('Codex history_base ordinal 与来源 rollout 起始边界不一致')
    if(segment.endOrdinalExclusive!==undefined){
      if(segment.expectedEndByteOffset===undefined)throw new Error('Codex history_base 字节边界与来源 rollout 不一致')
      if(segment.expectedEndByteOffset===segment.size){
        if(boundaryOffset!==undefined||lastOrdinal>=segment.endOrdinalExclusive)throw new Error('Codex history_base EOF ordinal 与来源 rollout 不一致')
      }else if(boundaryOffset!==segment.expectedEndByteOffset)throw new Error('Codex history_base 字节边界与来源 rollout 不一致')
    }
  }
  signal.throwIfAborted()
  if(invalidLines)result.warnings.push(invalidLines+' 行记录格式无效，已跳过')
  if(searchWasTruncated)result.warnings.push('部分超长消息已截断，搜索不包含被省略的内容。')
  if(result.messages.some(message=>message.truncated))result.warnings.push('部分长消息或工具输出已截断，可打开原始会话文件查看完整记录。')
  return result
}

/** Read a bounded current rollout so it can be joined to a verified native
 * paginated-history prefix before applying search and pagination. */
export async function readCodexSessionContentForMerge(
  file: FileHandle, size: number, sessionId: string|undefined, signal: AbortSignal = emptySignal,
  maxLineBytes=4*1024*1024,
): Promise<CodexRolloutContent> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Codex 会话文件大小无效')
  const warnings: string[] = []
  let invalidLines = 0, records = 0, first = true, baseThreadId: string | undefined, baseEndOrdinal: number | undefined,baseEndByteOffset:number|undefined,metaId:string|undefined,hasHistoryBase=false,paginated=false
  for await (const line of sessionLines(file, size, signal,maxLineBytes)) {
    signal.throwIfAborted()
    if (!line.length) continue
    if (Buffer.byteLength(line) > maxLineBytes || ++records > 2_000_000) throw new Error('Codex 当前会话超过安全读取上限')
    const event = jsonLine(line)
    if (!event) { invalidLines++; first = false; continue }
    if (first) {
      first = false
      const payload = object(event.payload)??(event.type==='session_meta'?event:undefined), historyBase = object(payload?.history_base)
      if (event.type === 'session_meta' && typeof payload?.id==='string' && (!sessionId||payload.id===sessionId)) {
        metaId=payload.id
        paginated=payload.history_mode==='paginated'
        if(historyBase){
        hasHistoryBase=true
        if(typeof historyBase.thread_id==='string')baseThreadId = historyBase.thread_id
        if (Number.isSafeInteger(historyBase.end_ordinal_exclusive) && (historyBase.end_ordinal_exclusive as number) >= 0) baseEndOrdinal = historyBase.end_ordinal_exclusive as number
        if (Number.isSafeInteger(historyBase.end_byte_offset) && (historyBase.end_byte_offset as number) >= 0) baseEndByteOffset = historyBase.end_byte_offset as number
        }
      }
    }
  }
  signal.throwIfAborted()
  if (invalidLines) warnings.push(invalidLines + ' 行记录格式无效，已跳过')
  return {warnings,hasHistoryBase,paginated,...metaId?{sessionMetaId:metaId}:{},...(baseThreadId ? { historyBaseThreadId: baseThreadId } : {}), ...(baseEndOrdinal !== undefined ? { historyBaseEndOrdinalExclusive: baseEndOrdinal } : {}),...(baseEndByteOffset!==undefined?{historyBaseEndByteOffset:baseEndByteOffset}:{}) }
}
