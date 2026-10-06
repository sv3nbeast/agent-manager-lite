import {sep} from 'node:path'

// These top-level trees are runtime output, or project checkouts rather than
// profile history. Prune before enumerating descendants; a cache can contain
// more entries than the entire history copy budget. Do not filter names at
// arbitrary depths: attachments and user skills can have directories called tmp.
const excludedTrees=new Set(['.tmp','tmp','cache','log','logs','ipc','app-server-control','process_manager','worktrees',
  'thread-writer-locks','project-metadata-locks','mcp-oauth-locks','.cockpit-token-locks','.cockpit-runtime-leases'])
// The primary desktop state is validated and projected into the new profile.
// Its rotated backups and atomic-write scratch files are runtime artifacts;
// copying them can race a writer and restore another instance's preferences.
const desktopStateArtifacts=/^\.{1,2}codex-global-state\.json(?:(?:\.bak)+(?:\.tmp(?:-.+)?)?|\.tmp(?:-.+)?)$/

export function excludedInstanceCopyTree(path:string):boolean {
  const top=path.split(sep)[0].toLowerCase()
  return excludedTrees.has(top)||desktopStateArtifacts.test(top)
}
