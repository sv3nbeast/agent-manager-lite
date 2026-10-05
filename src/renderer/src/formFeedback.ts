import { getCurrentScope, nextTick, onScopeDispose, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { message } from 'ant-design-vue'

let nextFeedbackId = 0

/** Keep errors visible even when the form's scroll position hides its inline feedback. */
export function useFormFeedback(
  source: MaybeRefOrGetter<string | undefined | null>,
  options: { active?: MaybeRefOrGetter<boolean> } = {}
): () => void {
  const key = `form-feedback-${++nextFeedbackId}`
  const stop = watch(() => options.active !== undefined && !toValue(options.active) ? '' : toValue(source), value => {
    if (typeof document === 'undefined') return
    const content = value?.trim()
    if (content) message.error({ key, content, duration: 6 })
    else message.destroy(key)
  }, { immediate: true, flush: 'sync' })
  const dispose = () => { stop(); if (typeof document !== 'undefined') message.destroy(key) }
  if (getCurrentScope()) onScopeDispose(dispose)
  return dispose
}

/** Reveal the first invalid field inside the active form after validation renders. */
export async function focusFirstInvalidField(rootSelector: string): Promise<void> {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
  await nextTick();await nextTick()
  const invalid = document.querySelector(rootSelector)?.querySelector<HTMLElement>('.ant-form-item-has-error')
  if (!invalid) return
  invalid.scrollIntoView?.({ block: 'center' })
  invalid.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])')?.focus({ preventScroll: true })
}

interface ValidationIssue { path: (string | number)[]; message: string; code: string; type?: string; minimum?: number | bigint; maximum?: number | bigint; inclusive?: boolean; expected?: unknown }

/** Translate schema failures into field feedback without exposing raw validation JSON. */
export function validationErrors(issues: ValidationIssue[], labels: Record<string, string>): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const issue of issues) {
    const field = String(issue.path[0] ?? 'form')
    if (errors[field]) continue
    const label = labels[field] ?? '配置'
    errors[field] = issue.code === 'too_small' && issue.type === 'number' && issue.minimum !== undefined
      ? `${label}${issue.inclusive === false ? '必须大于' : '不能小于'} ${issue.minimum}`
      : issue.code === 'too_big' && issue.type === 'number' && issue.maximum !== undefined
        ? `${label}${issue.inclusive === false ? '必须小于' : '不能大于'} ${issue.maximum}`
      : issue.code === 'invalid_type' && issue.expected === 'integer'
        ? `${label}必须为整数`
      : issue.code === 'invalid_type' && issue.expected === 'number'
        ? `${label}必须为数字`
      : issue.code === 'too_small' && issue.minimum === 1
        ? `请${issue.type === 'array' ? '至少添加一个' : '填写'}${label}`
      : issue.code === 'too_small' && issue.minimum !== undefined
        ? `${label}至少需要 ${issue.minimum} ${issue.type === 'array' ? '项' : '个字符'}`
      : issue.code === 'too_big' && issue.maximum !== undefined
        ? `${label}${issue.type === 'array' ? '最多支持' : '不能超过'} ${issue.maximum} ${issue.type === 'array' ? '项' : '个字符'}`
        : /[^\x00-\x7F]/.test(issue.message) ? issue.message : `请检查${label}的格式`
  }
  return errors
}
