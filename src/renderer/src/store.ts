import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppSnapshot } from '../../shared/types'
import { useFormFeedback } from './formFeedback'

function displayError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
}

export const useManager = defineStore('manager', () => {
  const data = ref<AppSnapshot>()
  const loading = ref(false)
  const error = ref('')
  useFormFeedback(error)
  let mutation = 0, refreshRequest = 0
  async function execute(action: () => Promise<AppSnapshot>): Promise<boolean> {
    const current = ++mutation
    loading.value = true; error.value = ''
    try { const next = await action(); if (current === mutation) data.value = next; return true }
    catch (e) { if (current === mutation) error.value = displayError(e); return false }
    finally { if (current === mutation) loading.value = false }
  }
  async function refresh(): Promise<void> {
    const generation = mutation, request = ++refreshRequest
    try { const next = await window.manager.load(); if (!loading.value && generation === mutation && request === refreshRequest) data.value = next }
    catch (e) { if (!loading.value && generation === mutation && request === refreshRequest) error.value = displayError(e) }
  }
  return { data, loading, error, execute, refresh, load: () => execute(() => window.manager.load()) }
})
