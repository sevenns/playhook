// Applies the Fluent theme tokens to <html> BEFORE the fluent-* elements register/upgrade. This module
// is imported FIRST in settings.ts, ahead of the component `*/define.js` side-effect imports.
//
// Why the order matters: `*/define.js` calls customElements.define(), which SYNCHRONOUSLY upgrades the
// matching elements already in the parsed HTML — they compute their first styles right then. Fluent's
// setTheme publishes the design tokens (colorNeutralForeground1, …) as custom properties on <html>. If
// that happens AFTER the elements have already computed styles (as it did when setTheme ran in the
// settings.ts module body, i.e. after all the define imports), the very first paint renders with the
// tokens missing, and Chromium doesn't reliably re-resolve those inherited custom properties inside the
// shadow roots when the token stylesheet is added afterwards — so labels/controls stay dim until the
// first interaction forces a style recalc. Setting the tokens here, before any define import runs, makes
// the first paint correct.
//
// `system` is only the pre-paint guess; settings.ts refines to the persisted theme (and installs the
// OS-change listener) once settings load.
import { setTheme } from '@fluentui/web-components';
import { webDarkTheme, webLightTheme } from '@fluentui/tokens';

setTheme(window.matchMedia('(prefers-color-scheme: dark)').matches ? webDarkTheme : webLightTheme);
