// useColorMode() в b24ui читает настройки темы с ВЕРХНЕГО уровня app config — без этих ключей
// переключатель темы — пустышка (урок эталона client-bank-alfa-by). `auto` — как в ОС.
export default defineAppConfig({
  colorMode: true,
  colorModeInitialValue: 'auto'
})
