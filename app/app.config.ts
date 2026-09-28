// useColorMode() in b24ui reads theme settings from the TOP level of the app config — without these keys
// the theme switcher is a no-op (lesson from the client-bank-alfa-by reference app). `auto` — follows the OS.
export default defineAppConfig({
  colorMode: true,
  colorModeInitialValue: 'auto'
})
