<script setup lang="ts">
import { ref, watch } from 'vue'

const props = defineProps<{ label: string; accessibleLabel: string; actionClass: string; loading?: boolean }>()
const emit = defineEmits<{ click: [] }>()
const hovered = ref(false), focused = ref(false)
watch(() => props.loading, value => { if (value) focused.value = false })
function activate() { hovered.value = false; focused.value = false; emit('click') }
</script>

<template>
  <a-tooltip :title="label" :trigger="[]" :open="hovered || focused">
    <span class="account-action-wrap" @mouseenter="hovered = true" @mouseleave="hovered = false" @focusin="focused = true" @focusout="focused = false">
      <a-button :class="actionClass" type="text" size="small" :disabled="loading" :loading="loading" :aria-busy="!!loading" :aria-label="accessibleLabel" @click="activate"><template #icon><slot /></template></a-button>
    </span>
  </a-tooltip>
</template>

<style scoped>
.account-action-wrap { display: inline-flex; }
</style>
