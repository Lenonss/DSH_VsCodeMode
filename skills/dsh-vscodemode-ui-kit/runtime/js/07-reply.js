/* 07 · 回传：一句人话 + json 代码块，优先走计划签通道，否则复制 */
(function (UK) {
  'use strict'

  UK.buildPatch = function () {
    var st = UK.state
    var patch = { v: 1, page: 'design', base: st.baseHash, ops: UK.clone(st.ops) }
    if (st.note) patch.note = st.note
    return patch
  }

  UK.replyText = function () {
    var st = UK.state
    var head = st.note || ('设计页改了 ' + st.ops.length + ' 处：' + (st.ops.length ? UK.opLabel(st.ops[0]) : '无'))
    return head + '\n\n```json\n' + JSON.stringify(UK.buildPatch(), null, 2) + '\n```\n'
  }

  UK.copyText = function (text) {
    var done = function (ok) {
      UK.flash(ok ? '已复制，粘进对话就行' : '复制失败：手动选中抽屉里的 patch')
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true) }, function () { legacyCopy(text, done) })
    } else {
      legacyCopy(text, done)
    }
  }

  function legacyCopy(text, done) {
    try {
      var area = document.createElement('textarea')
      area.value = text
      area.style.position = 'fixed'
      area.style.left = '-9999px'
      document.body.appendChild(area)
      area.select()
      var ok = document.execCommand('copy')
      area.remove()
      done(ok)
    } catch (e) {
      done(false)
    }
  }

  UK.sendReply = function () {
    var text = UK.replyText()
    var sent = false
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ source: 'edrv-htmlplan', type: 'respond', text: text }, '*')
        sent = true
      }
    } catch (e) {
      sent = false
    }
    if (sent) {
      UK.flash('已发送到对话输入框')
      return
    }
    UK.copyText(text)
  }

  UK.flash = function (message) {
    var el = document.getElementById('uk-flash')
    if (!el) return
    el.textContent = message
    el.style.opacity = '1'
    clearTimeout(UK.__flashTimer)
    UK.__flashTimer = setTimeout(function () { el.style.opacity = '0' }, 2600)
  }
})(window.__UIKIT__ = window.__UIKIT__ || {})
