import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { groupInputSchema, groupMembersSchema, type AccountGroup } from '../shared/types'
import { Store, type State } from './store'

export function saveGroup(store: Store, input: unknown): void {
  const value = z.object({ id: z.string().uuid().optional(), group: groupInputSchema }).strict().parse(input)
  store.transaction(state => {
    if (state.groups.some(g => g.id !== value.id && g.name === value.group.name)) throw new Error('分组名称已存在')
    if (value.id) {
      const group = state.groups.find(g => g.id === value.id)
      if (!group) throw new Error('分组已删除')
      Object.assign(group, value.group)
    } else {
      state.groups.push({ ...value.group, id: randomUUID(), sortOrder: state.groups.length, accountIds: [], createdAt: Date.now() })
    }
  })
}

export function deleteGroup(store: Store, id: string): void {
  z.string().uuid().parse(id)
  store.transaction(state => { state.groups = state.groups.filter(g => g.id !== id) })
}

export function reorderGroups(store: Store, raw: unknown): void {
  const ids = z.array(z.string().uuid()).max(10000).parse(raw)
  store.transaction(state => {
    if (new Set(ids).size !== ids.length || ids.length !== state.groups.length || ids.some(id => !state.groups.some(g => g.id === id))) throw new Error('分组列表已改变，请重新加载')
    state.groups = ids.map((id, sortOrder) => ({ ...state.groups.find(g => g.id === id)!, sortOrder }))
  })
}

export function updateGroupMembers(store: Store, input: unknown): void {
  const { id, ids, mode } = groupMembersSchema.parse(input)
  store.transaction(state => {
    const group = state.groups.find(g => g.id === id)
    if (!group) throw new Error('分组已删除')
    const wanted = new Set(ids)
    if (ids.some(id => !state.accounts.some(a => a.id === id))) throw new Error('部分账号已删除，请重新加载')
    // Cockpit permits multiple memberships. Keep add/remove; offer an explicit
    // move operation that atomically removes old memberships before assigning.
    if (mode === 'move') for (const other of state.groups) other.accountIds = other.accountIds.filter(id => !wanted.has(id))
    group.accountIds = mode === 'remove' ? group.accountIds.filter(id => !wanted.has(id))
      : mode === 'replace' ? [...wanted] : [...new Set([...group.accountIds, ...ids])]
  })
}

export function removeGroupReferences(state: State, ids: Set<string>): void {
  for (const group of state.groups) group.accountIds = group.accountIds.filter(id => !ids.has(id))
}

export function groupRefreshMinutes(id: string, groups: AccountGroup[], global: number): number {
  // Resolve overlapping memberships in visible group order, as upstream's find().
  const first = [...groups].sort((a, b) => a.sortOrder - b.sortOrder).find(g => g.accountIds.includes(id))
  return first?.quotaAutoRefreshMinutes ?? global
}

export function bulkRefreshIds(state: State): string[] {
  const disabled = new Set(state.groups.filter(g => g.quotaAutoRefreshMinutes === -1).flatMap(g => g.accountIds))
  return state.accounts.filter(a => !disabled.has(a.id)).map(a => a.id)
}
