/* 08 · 外壳与启动：三栏、底栏、键盘 */
(function (UK) {
  'use strict'

  var hosts = {}
  var started = false

  UK.renderAll = function () {
    if (!started) return
    UK.renderTree(hosts.tree)
    UK.renderCanvas(hosts.stage)
    UK.renderInspector(hosts.insp)
    UK.renderDiff(hosts.drawer)
    UK.renderBar()
    UK.renderStatusLine()
  }

  UK.renderBar = function () {
    var st = UK.state
    if (hosts.zoom) hosts.zoom.textContent = Math.round(st.zoom * 100) + '%'
    if (hosts.opcount) hosts.opcount.textContent = String(st.ops.length)
    if (hosts.opcount) hosts.opcount.parentNode.classList.toggle('ui-dirty', st.ops.length > 0)
  }

  UK.renderStatusLine = function () {
    var st = UK.state
    var node = UK.selectedNode()
    var total = (st.spec.nodes || []).length
    if (!hosts.status) return
    hosts.status.textContent = node
      ? '已选 ' + node.id + ' · rect ' + (node.rect || []).join(', ') + ' · 共 ' + total + ' 个节点'
      : '未选中 · 共 ' + total + ' 个节点 · 滚轮缩放，空白拖动平移'
  }

  function buildShell(app) {
    var st = UK.state
    var screen = st.spec.screen || { name: '未命名', w: 1080, h: 1920 }
    app.className = 'ui-app'

    var zoomChip = UK.el('span', { class: 'ui-chip', text: '100%' })
    var opCount = UK.el('b', { text: '0' })
    hosts.zoom = zoomChip
    hosts.opcount = opCount

    var bar = UK.el('div', { class: 'ui-bar' }, [
      UK.el('span', { class: 'ui-title', text: screen.name || '未命名' }),
      UK.el('span', { class: 'ui-meta', text: screen.w + '×' + screen.h }),
      UK.el('span', { class: 'ui-chip', text: 'base ' + st.baseHash }),
      UK.el('span', { style: { flex: '1' } }),
      UK.el('button', { class: 'ui-btn ui-ghost', text: '−', title: '缩小', onclick: function () { UK.setZoom(st.zoom / 1.2, null) } }),
      zoomChip,
      UK.el('button', { class: 'ui-btn ui-ghost', text: '+', title: '放大', onclick: function () { UK.setZoom(st.zoom * 1.2, null) } }),
      UK.el('button', { class: 'ui-btn', text: '适应', onclick: function () { UK.fit(hosts.stage) } }),
      UK.el('button', {
        class: 'ui-btn', title: '查看改动与 patch',
        onclick: function () { st.drawer = !st.drawer; UK.renderAll() }
      }, ['改动 ', opCount])
    ])

    var tree = UK.el('aside', { class: 'ui-pane ui-tree', id: 'uk-tree' })
    var stage = UK.el('main', { class: 'ui-stage', id: 'uk-stage' })
    var insp = UK.el('aside', { class: 'ui-pane ui-insp', id: 'uk-insp' })
    hosts.tree = tree
    hosts.stage = stage
    hosts.insp = insp

    var status = UK.el('span', { class: 'ui-status', text: '' })
    hosts.status = status
    var foot = UK.el('div', { class: 'ui-foot' }, [
      status,
      UK.el('span', { class: 'ui-chip', text: '设计页不落盘，提交回传 patch' }),
      UK.el('button', { class: 'ui-btn', text: '撤销全部', onclick: function () { UK.resetOps() } }),
      UK.el('button', { class: 'ui-btn ui-primary', text: '提交改动', onclick: function () { UK.state.drawer = true; UK.renderAll() } })
    ])

    var drawer = UK.el('div', { class: 'ui-drawer', id: 'uk-drawer', hidden: 'hidden' })
    hosts.drawer = drawer

    var flash = UK.el('div', {
      id: 'uk-flash',
      style: {
        position: 'fixed', left: '50%', bottom: '56px', transform: 'translateX(-50%)',
        background: '#24211d', color: '#fff', padding: '6px 12px', 'border-radius': '6px',
        font: '12px/1.4 system-ui, sans-serif', opacity: '0', transition: 'opacity .18s',
        'pointer-events': 'none', 'z-index': '80'
      }
    })

    app.appendChild(bar)
    app.appendChild(UK.el('div', { class: 'ui-body' }, [tree, stage, insp]))
    app.appendChild(foot)
    app.appendChild(drawer)
    app.appendChild(flash)
  }

  function bindKeys() {
    window.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || ''
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      if (typing) return

      var node = UK.selectedNode()
      if (e.key === 'Escape') { UK.closeMenu(); UK.select(null); return }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault()
        if (UK.state.ops.length) UK.removeOp(UK.state.ops.length - 1)
        return
      }
      if (!node) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        UK.deleteNode(node.id)
        return
      }
      var step = e.shiftKey ? 10 : 1
      var dx = 0, dy = 0
      if (e.key === 'ArrowLeft') dx = -step
      else if (e.key === 'ArrowRight') dx = step
      else if (e.key === 'ArrowUp') dy = -step
      else if (e.key === 'ArrowDown') dy = step
      else return
      e.preventDefault()
      var rect = (node.rect || [0, 0, 4, 4]).slice()
      rect[0] = rect[0] + dx
      rect[1] = rect[1] + dy
      UK.commit({ op: 'set', id: node.id, field: 'rect', value: rect })
    })
  }

  function boot() {
    var app = document.getElementById('app')
    if (!app) return
    if (!window.__UIKIT__ || !UK.state) return
    buildShell(app)
    started = true
    UK.bindStage(hosts.stage)
    bindKeys()
    UK.renderAll()
    requestAnimationFrame(function () {
      UK.fit(hosts.stage)
    })
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})(window.__UIKIT__ = window.__UIKIT__ || {})
