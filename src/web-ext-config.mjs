export default {
  sourceDir: './dist/extension',
  artifactsDir: './web-ext-artifacts',
  run: {
    target: ['firefox-desktop'],
    startUrl: ['about:debugging#/runtime/this-firefox'],
    browserConsole: true,
  },
  lint: {
    selfHosted: true,
  },
};
