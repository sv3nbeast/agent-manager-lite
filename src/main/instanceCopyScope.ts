import {sep} from 'node:path'

// These top-level trees are runtime output, or project checkouts rather than
// profile history. Prune before enumerating descendants; a cache can contain
// more entries than the entire history copy budget. Do not filter names at
// arbitrary depths: attachments and user skills can have directories called tmp.
const excludedTrees=new Set(['.tmp','tmp','cache','log','logs','ipc','app-server-control','process_manager','worktrees',
  'thread-writer-locks','project-metadata-locks','mcp-oauth-locks','.cockpit-token-locks','.cockpit-runtime-leases'])

export function excludedInstanceCopyTree(path:string):boolean {
  return excludedTrees.has(path.split(sep)[0].toLowerCase())
}
