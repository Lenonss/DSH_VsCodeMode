/* 06 · 改动抽屉：逐条列 op、撤单条、预览 patch */
(function (UK) {
  'use strict'

  UK.renderDiff = function (host) {
    var st = UK.state
    host.innerHTML = ''
    if (!st.drawer) { host.hidden = true; return }
    host.hidden = false

    host.appendChild(UK.el('div', { class: 'ui-drawer-head' }, [
      UK.el('b', { text: '本次改动 ' + st.ops.length + ' 条' }),
      UK.el('span', { class: 'ui-chip', text: 'base ' + st.baseHash }),
      UK.el('span', { class: 'ui-spacer', style: { flex: '1' } }),
      UK.el('button', { class: 'ui-btn ui-ghost', text: '关闭', onclick: function () { st.drawer = false; UK.renderAll() } })
    ]))

    var list = UK.el('div', { class: 'ui-ops' })
    if (!st.ops.length) {
      list.appendChild(UK.el('div', { class: 'ui-empty-note', text: '还没有改动。拖一拖、改个数值，这里会出现一条。' }))
    }
    st.ops.forEach(function (op, i) {
      list.appendChild(UK.el('div', { class: 'ui-op' }, [
        UK.el('span', { class: 'ui-op-kind ' + op.op, text: op.op }),
        UK.el('span', { class: 'ui-op-body', text: UK.opLabel(op) }),
        UK.el('button', {
          class: 'ui-op-x',
          title: '撤销这一条',
          text: '✕',
          onclick: function () { UK.removeOp(i) }
        })
      ]))
    })
    host.appendChild(list)

    var foot = UK.el('div', { class: 'ui-drawer-foot' })
    var note = UK.el('textarea', { placeholder: '一句人话：改了什么，为什么' })
    note.value = st.note || ''
    note.addEventListener('input', function () { st.note = note.value })
    foot.appendChild(note)

    var patch = UK.buildPatch()
    foot.appendChild(UK.el('pre', { class: 'ui-patch', text: JSON.stringify(patch, null, 2) }))

    foot.appendChild(UK.el('div', { style: { display: 'flex', gap: '6px' } }, [
      UK.el('button', { class: 'ui-btn', text: '撤销全部', onclick: function () { UK.resetOps() } }),
      UK.el('button', { class: 'ui-btn', text: '复制 patch', onclick: function () { UK.copyText(UK.replyText()) } }),
      UK.el('button', { class: 'ui-btn ui-primary', text: '提交给 agent', onclick: function () { UK.sendReply() } })
    ]))
    host.appendChild(foot)
  }
})(window.__UIKIT__ = window.__UIKIT__ || {})
