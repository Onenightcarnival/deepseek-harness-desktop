'use strict'
function updateLabels() {
  document.getElementById('stage').textContent = desktopI18n.translate('正在启动…', window.desktopLocale?.get() || document.documentElement.lang)
}
updateLabels()
window.addEventListener('desktop-language-change', updateLabels)
