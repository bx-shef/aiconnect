<script setup lang="ts">
// Наценки: «на всё» и правила по тегам задач. Правила проверяются сверху вниз, срабатывает
// первое, чей тег есть у задачи (#3, markup.ts). Порядок меняется стрелками.
import { cleanTag, MAX_MARKUP, MAX_TAG_LENGTH, normalizeTag } from '#shared/domain/markup'
import type { AppSettings } from '#shared/domain/settings'

const settings = defineModel<AppSettings>({ required: true })

const newTag = ref('')

/** Тег уже есть в правилах (без учёта регистра и `#`) — второе такое правило никогда не сработает. */
const duplicate = computed(() => {
  const key = normalizeTag(newTag.value)
  return !!key && settings.value.markup.tags.some(r => normalizeTag(r.tag) === key)
})

function addRule() {
  const tag = cleanTag(newTag.value)
  if (!tag || tag.length > MAX_TAG_LENGTH || duplicate.value) return
  settings.value.markup.tags.push({ tag, percent: 0 })
  newTag.value = ''
}

function move(index: number, delta: -1 | 1) {
  const list = settings.value.markup.tags
  const target = index + delta
  if (target < 0 || target >= list.length) return
  const [rule] = list.splice(index, 1)
  if (rule) list.splice(target, 0, rule)
}

function removeRule(index: number) {
  settings.value.markup.tags.splice(index, 1)
}
</script>

<template>
  <div class="space-y-6">
    <B24FormField
      label="Наценка на всё, %"
      description="Применяется, если у задачи нет ни одного тега из правил ниже"
    >
      <B24InputNumber
        v-model="settings.markup.defaultPercent"
        :min="0"
        :max="MAX_MARKUP"
        :step="1"
        class="w-40"
        data-testid="markup-default"
      />
    </B24FormField>

    <section class="space-y-2">
      <h3 class="font-medium">
        Наценки по тегам задач
      </h3>
      <p class="text-sm opacity-70">
        Правила проверяются сверху вниз: срабатывает первое, чей тег есть у задачи. Регистр и знак «#»
        не важны. Наценка относится ко всем строкам задачи.
      </p>
      <ol
        v-if="settings.markup.tags.length"
        class="space-y-2"
        data-testid="markup-tags"
      >
        <li
          v-for="(rule, index) in settings.markup.tags"
          :key="rule.tag"
          class="flex items-center gap-3"
        >
          <span class="w-6 text-right opacity-60">{{ index + 1 }}.</span>
          <span class="flex-1">#{{ rule.tag }}</span>
          <B24InputNumber
            v-model="rule.percent"
            :min="0"
            :max="MAX_MARKUP"
            class="w-32"
            :aria-label="`Наценка для тега ${rule.tag}`"
          />
          <B24Button
            size="xs"
            color="air-tertiary"
            label="↑"
            :disabled="index === 0"
            :aria-label="`Поднять правило ${rule.tag}`"
            @click="move(index, -1)"
          />
          <B24Button
            size="xs"
            color="air-tertiary"
            label="↓"
            :disabled="index === settings.markup.tags.length - 1"
            :aria-label="`Опустить правило ${rule.tag}`"
            @click="move(index, 1)"
          />
          <B24Button
            size="xs"
            color="air-tertiary"
            label="Убрать"
            @click="removeRule(index)"
          />
        </li>
      </ol>
      <p
        v-else
        class="text-sm opacity-70"
      >
        Правил пока нет — на все строки действует наценка «на всё».
      </p>
      <div class="flex gap-2">
        <B24Input
          v-model="newTag"
          class="flex-1"
          :maxlength="MAX_TAG_LENGTH"
          placeholder="Тег задачи, например «срочно»"
          aria-label="Новый тег"
          data-testid="markup-new-tag"
          @keydown.enter.prevent="addRule"
        />
        <B24Button
          color="air-secondary"
          label="Добавить правило"
          :disabled="!normalizeTag(newTag) || duplicate"
          data-testid="markup-add-tag"
          @click="addRule"
        />
      </div>
      <p
        v-if="duplicate"
        class="text-sm text-(--ui-color-accent-main-alert)"
      >
        Правило для этого тега уже есть
      </p>
    </section>
  </div>
</template>
