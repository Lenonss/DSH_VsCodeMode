/* 02 · 状态：只读 ui-spec，所有交互记成 ops，再从 base 重放 */
(function (UK) {
  'use strict'

  function readSpec() {
    var block = document.getElementById('ui-spec')
    if (!block) throw new Error('页面里没有 ui-spec 块')
    return JSON.parse(block.textContent)
  }

  var initial = readSpec()
  var baseHash = initial.hash || UK.hashSpec(initial)

  UK.state = {
    baseSpec: (function () { var s = UK.clone(initial); delete s.hash; return s })(),
    baseHash: baseHash,
    spec: UK.clone(initial),
    ops: [],
    selected: null,
    scope: [],
    note: '',
    zoom: 1,
    pan: { x: 0, y: 0 },
    drawer: false,
    filter: ''
  }

  UK.selectedNode = function () {
    var st = UK.state
    if (!st.selected) return null
    return UK.index(st.spec)[st.selected] || null
  }

  UK.notify = function () {
    if (UK.renderAll) UK.renderAll()
  }

  UK.rebuild = function () {
    var st = UK.state
    st.spec = UK.applyOps(st.baseSpec, st.ops)
    st.spec.hash = st.baseHash
    var alive = UK.index(st.spec)
    if (st.selected && !alive[st.selected]) st.selected = null
  }

  UK.commit = function (op) {
    if (!op) return
    UK.state.ops.push(op)
    UK.rebuild()
    UK.notify()
  }

  UK.removeOp = function (i) {
    UK.state.ops.splice(i, 1)
    UK.rebuild()
    UK.notify()
  }

  UK.resetOps = function () {
    UK.state.ops = []
    UK.rebuild()
    UK.notify()
  }

  UK.select = function (id) {
    UK.state.selected = id || null
    if (UK.revealInTree) UK.revealInTree(UK.state.selected)
    UK.notify()
  }

  UK.setZoom = function (zoom, anchor) {
    var st = UK.state
    var next = Math.min(4, Math.max(0.1, zoom))
    if (anchor) {
      var world = { x: (anchor.x - st.pan.x) / st.zoom, y: (anchor.y - st.pan.y) / st.zoom }
      st.pan.x = anchor.x - world.x * next
      st.pan.y = anchor.y - world.y * next
    }
    st.zoom = next
    UK.notify()
  }

  UK.fit = function (host) {
    var st = UK.state
    var screen = st.spec.screen || { w: 1080, h: 1920 }
    var box = host.getBoundingClientRect()
    if (!box.width || !box.height) return
    var z = Math.min(box.width / screen.w, box.height / screen.h) * 0.92
    st.zoom = Math.min(4, Math.max(0.1, z))
    st.pan.x = (box.width - screen.w * st.zoom) / 2
    st.pan.y = (box.height - screen.h * st.zoom) / 2
    UK.notify()
  }

  UK.dirty = function () { return UK.state.ops.length > 0 }
})(window.__UIKIT__ = window.__UIKIT__ || {})
