<script setup lang="ts">
// Ответ консультации BitrixGPT в окне приложения — в стиле ответов CoPilot в Битрикс24: карточка
// `outline-copilot`, иконка CoPilot, оговорка про ИИ. Разбор ответа общий с записью в ленте
// (shared/domain/answer.ts), текст — только через {{ }}: разметка из ответа модели остаётся текстом.
import CopilotIcon from '@bitrix24/b24icons-vue/solid/CopilotIcon'
import { parseAnswer, type AnswerSpan } from '#shared/domain/answer'

const props = defineProps<{
  title: string
  text: string
  /** Запись в ленту не удалась — ответ всё равно показываем, с причиной. */
  notSaved?: string
}>()

const blocks = computed(() => parseAnswer(props.text))
const tag = (span: AnswerSpan) => (span.bold ? 'strong' : span.italic ? 'em' : 'span')
</script>

<template>
  <B24Card
    variant="outline-copilot"
    data-testid="consult-answer"
  >
    <template #header>
      <div class="flex items-center gap-2">
        <CopilotIcon class="size-6 shrink-0 text-(--ui-color-design-outline-copilot-content-icon)" />
        <h3 class="font-semibold min-w-0 truncate">
          {{ title }}
        </h3>
        <B24Badge
          label="BitrixGPT"
          color="air-primary-copilot"
          size="sm"
          class="ms-auto"
        />
      </div>
    </template>

    <div class="space-y-3 text-sm leading-relaxed">
      <p
        v-if="!blocks.length"
        class="opacity-70"
      >
        BitrixGPT вернул пустой ответ.
      </p>
      <template
        v-for="(block, i) in blocks"
        :key="i"
      >
        <p
          v-if="block.kind === 'h'"
          class="font-semibold"
        >
          <component
            :is="tag(span)"
            v-for="(span, k) in block.spans"
            :key="k"
          >
            {{ span.text }}
          </component>
        </p>
        <p v-else-if="block.kind === 'p'">
          <template
            v-for="(line, j) in block.lines"
            :key="j"
          >
            <br v-if="j">
            <component
              :is="tag(span)"
              v-for="(span, k) in line"
              :key="k"
            >
              {{ span.text }}
            </component>
          </template>
        </p>
        <component
          :is="block.kind"
          v-else
          :start="block.kind === 'ol' ? block.start : undefined"
          :class="block.kind === 'ul' ? 'list-disc ps-5 space-y-1' : 'list-decimal ps-5 space-y-1'"
        >
          <li
            v-for="(item, j) in block.items"
            :key="j"
          >
            <component
              :is="tag(span)"
              v-for="(span, k) in item.spans"
              :key="k"
            >
              {{ span.text }}
            </component>
            <ul
              v-if="item.sub.length"
              class="list-[circle] ps-5 mt-1 space-y-1"
            >
              <li
                v-for="(sub, s) in item.sub"
                :key="s"
              >
                <component
                  :is="tag(span)"
                  v-for="(span, k) in sub"
                  :key="k"
                >
                  {{ span.text }}
                </component>
              </li>
            </ul>
          </li>
        </component>
      </template>
    </div>

    <template #footer>
      <p
        v-if="notSaved"
        class="text-xs text-(--ui-color-accent-main-alert)"
        data-testid="consult-not-saved"
      >
        Ответ не сохранился в ленте счёта: {{ notSaved }}
      </p>
      <p class="text-xs opacity-70">
        Ответ сформирован BitrixGPT и может быть неточным.{{ notSaved ? '' : ' Он сохранён в ленте счёта.' }}
      </p>
    </template>
  </B24Card>
</template>
