/* 04 · 画布：缩放、平移、选中、拖边改 rect */
(function (UK) {
  'use strict'

  var stage = null

  function applyDelta(r, dx, dy, handle) {
    if (!handle) {
      r[0] = r[0] + dx
      r[1] = r[1] + dy
    } else {
      if (handle.indexOf('w') >= 0) { r[0] = r[0] + dx; r[2] = r[2] - dx }
      if (handle.indexOf('e') >= 0) { r[2] = r[2] + dx }
      if (handle.indexOf('n') >= 0) { r[1] = r[1] + dy; r[3] = r[3] - dy }
      if (handle.indexOf('s') >= 0) { r[3] = r[3] + dy }
      if (r[2] < 4) { if (handle.indexOf('w') >= 0) r[0] = r[0] - (4 - r[2]); r[2] = 4 }
      if (r[3] < 4) { if (handle.indexOf('n') >= 0) r[1] = r[1] - (4 - r[3]); r[3] = 4 }
    }
    for (var i = 0; i < 4; i++) r[i] = Math.round(r[i])
  }

  function beginDrag(e, node, handle) {
    e.preventDefault()
    e.stopPropagation()
    if (UK.state.selected !== node.id) UK.select(node.id)

    var st = UK.state
    var startRect = node.rect.slice()
    var startX = e.clientX
    var startY = e.clientY
    var moved = false
    var finalRect = startRect.slice()
    UK.__dragging = true

    function onMove(ev) {
      var dx = (ev.clientX - startX) / st.zoom
      var dy = (ev.clientY - startY) / st.zoom
      if (!moved && Math.abs(dx) < 1 && Math.abs(dy) < 1) return
      moved = true
      finalRect = startRect.slice()
      applyDelta(finalRect, dx, dy, handle)
      node.rect = finalRect
      var box = document.querySelector('#uk-canvas [data-id="' + node.id.replace(/"/g, '\\"') + '"]')
      if (box) {
        var abs = UK.absRect(st.spec, node)
        box.style.left = abs[0] + 'px'
        box.style.top = abs[1] + 'px'
        box.style.width = abs[2] + 'px'
        box.style.height = abs[3] + 'px'
        var tag = box.querySelector('.ui-node-tag')
        if (tag) tag.textContent = finalRect.join(', ')
        if (UK.syncInspectorRect) UK.syncInspectorRect(finalRect)
      }
    }

    function onUp() {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      UK.__dragging = false
      if (moved) UK.commit({ op: 'set', id: node.id, field: 'rect', value: finalRect.slice() })
      else UK.notify()
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  UK.renderCanvas = function (host) {
    stage = host
    if (UK.__dragging) return
    var st = UK.state
    var screen = st.spec.screen || { w: 1080, h: 1920 }
    host.innerHTML = ''

    var canvas = UK.el('div', {
      class: 'ui-canvas',
      id: 'uk-canvas',
      style: {
        width: screen.w + 'px',
        height: screen.h + 'px',
        transform: 'translate(' + st.pan.x + 'px,' + st.pan.y + 'px) scale(' + st.zoom + ')'
      }
    })

    var mock = st.spec.mock
    if (mock && mock.src) {
      canvas.appendChild(UK.el('img', { src: mock.src, alt: '', draggable: 'false' }))
    } else {
      canvas.appendChild(UK.el('div', { class: 'ui-empty' }, [
        UK.el('div', { text: '没有效果图' }),
        UK.el('div', { style: { 'font-size': '11px', opacity: '.75' }, text: '节点照常显示；图放进 assets/ 后重新 build' })
      ]))
    }

    var layer = UK.el('div', { class: 'ui-nodes' })
    var nodes = (st.spec.nodes || []).slice()
    nodes.sort(function (a, b) {
      var da = UK.depthOf(st.spec, a)
      var db = UK.depthOf(st.spec, b)
      return da === db ? (a.__i || 0) - (b.__i || 0) : da - db
    })

    nodes.forEach(function (node) {
      if (!node || !node.rect) return
      var abs = UK.absRect(st.spec, node)
      var sel = st.selected === node.id
      var box = UK.el('div', {
        class: 'ui-node' + (sel ? ' sel' : '') + (node.opaque ? ' opaque' : ''),
        'data-id': node.id,
        style: { left: abs[0] + 'px', top: abs[1] + 'px', width: abs[2] + 'px', height: abs[3] + 'px' }
      })

      if (node.kind === 'text' && node.text) {
        box.appendChild(UK.el('div', {
          class: 'ui-node-text',
          style: {
            'font-size': (node.text.size || 24) + 'px',
            color: node.text.color || '#333',
            'line-height': '1.25',
            'text-align': node.text.align || 'left',
            padding: '0 2px'
          },
          text: node.text.s || ''
        }))
      }

      if (sel) {
        box.appendChild(UK.el('div', { class: 'ui-node-tag', text: node.rect.join(', ') }))
        ;['nw', 'n', 'ne', 'w', 'e', 'sw', 's', 'se'].forEach(function (h) {
          box.appendChild(UK.el('div', {
            class: 'ui-handle ' + h,
            'data-handle': h,
            onpointerdown: function (e) { beginDrag(e, node, h) }
          }))
        })
      }

      box.addEventListener('pointerdown', function (e) {
        if (e.target && e.target.getAttribute && e.target.getAttribute('data-handle')) return
        beginDrag(e, node, null)
      })
      box.addEventListener('contextmenu', function (e) {
        e.preventDefault()
        UK.openMenu(e, node)
      })
      layer.appendChild(box)
    })

    canvas.appendChild(layer)
    host.appendChild(canvas)
    if (UK.renderStatusLine) UK.renderStatusLine()
  }

  /* 缩放与平移：滚轮缩放，空白处左拖或中键拖动平移 */
  UK.bindStage = function (host) {
    host.addEventListener('wheel', function (e) {
      e.preventDefault()
      var box = host.getBoundingClientRect()
      UK.setZoom(UK.state.zoom * Math.exp(-e.deltaY * 0.0016), {
        x: e.clientX - box.left,
        y: e.clientY - box.top
      })
    }, { passive: false })

    host.addEventListener('pointerdown', function (e) {
      if (e.target && e.target.closest && e.target.closest('.ui-node')) return
      if (e.button !== 0 && e.button !== 1) return
      e.preventDefault()
      var startX = e.clientX
      var startY = e.clientY
      var pan = { x: UK.state.pan.x, y: UK.state.pan.y }
      var moved = false
      host.classList.add('panning')
      function onMove(ev) {
        var dx = ev.clientX - startX
        var dy = ev.clientY - startY
        if (!moved && Math.abs(dx) < 3 && Math.abs(dy) < 3) return
        moved = true
        UK.state.pan.x = pan.x + dx
        UK.state.pan.y = pan.y + dy
        var canvas = document.getElementById('uk-canvas')
        if (canvas) canvas.style.transform = 'translate(' + UK.state.pan.x + 'px,' + UK.state.pan.y + 'px) scale(' + UK.state.zoom + ')'
      }
      function onUp() {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        host.classList.remove('panning')
        if (!moved) UK.select(null)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    })
  }
})(window.__UIKIT__ = window.__UIKIT__ || {})
