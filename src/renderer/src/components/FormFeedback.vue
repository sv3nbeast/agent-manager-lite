<script setup lang="ts">
defineProps<{ error?: string }>()
</script>

<template>
  <a-alert v-if="error" type="error" show-icon :message="error" class="form-footer-feedback" role="alert" />
</template>

<style scoped>
.form-footer-feedback { margin-bottom: 12px; overflow-wrap: anywhere; text-align: left; }
</style>
