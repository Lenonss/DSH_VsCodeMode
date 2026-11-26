/* 03 · 树：折叠、选中、右键菜单 */
(function (UK) {
  'use strict'

  var collapsed = {}

  UK.toggleCollapse = function (id) {
    collapsed[id] = !collapsed[id]
    UK.renderAll()
  }

  UK.revealInTree = function (id) {
    var spec = UK.state.spec
    var byId = UK.index(spec)
    var p = id ? (byId[id] || {}).parent : null
    while (p && byId[p]) { collapsed[p] = false; p = byId[p].parent }
  }

  function leafName(id) {
    var parts = String(id || '').split('/')
    return parts[parts.length - 1] || id
  }

  UK.renderTree = function (host) {
    host.innerHTML = ''
    var spec = UK.state.spec
    var nodes = spec.nodes || []
    if (!nodes.length) {
      host.appendChild(UK.el('div', { class: 'ui-empty-note', text: '还没有节点。在画布上右键新增，或让 agent 写进 spec。' }))
      return
    }

    var wrap = UK.el('div', { class: 'ui-tree' })
    var roots = nodes.filter(function (n) { return n && (n.parent == null || !UK.index(spec)[n.parent]) })
    var renderInto = function (parentId, depth) {
      var kids = nodes.filter(function (n) { return n && n.parent === parentId })
      kids.forEach(function (node) {
        var children = UK.childrenOf(spec, node.id)
        var open = !collapsed[node.id]
        var hasBind = !!node.bind
        var row = UK.el('div', {
          class: 'ui-row' + (UK.state.selected === node.id ? ' sel' : ''),
          'data-id': node.id,
          style: { paddingLeft: 4 + depth * 12 + 'px' },
          title: node.id + (node.bind ? ' · ' + node.bind : ''),
          onclick: function (e) { e.stopPropagation(); UK.select(node.id) },
          oncontextmenu: function (e) { e.preventDefault(); e.stopPropagation(); UK.openMenu(e, node) }
        }, [
          UK.el('span', {
            class: 'ui-caret',
            text: children.length ? (open ? '▾' : '▸') : '',
            onclick: function (e) {
              if (!children.length) return
              e.stopPropagation()
              UK.toggleCollapse(node.id)
            }
          }),
          hasBind ? UK.el('span', { class: 'ui-binddot' }) : null,
          UK.el('span', { class: 'ui-name', text: leafName(node.id) }),
          UK.el('span', { class: 'ui-kind', text: node.kind || '?' })
        ])
        wrap.appendChild(row)
        if (children.length && open) renderInto(node.id, depth + 1)
      })
    }
    renderInto(null, 0)
    host.appendChild(wrap)
  }

  /* 右键菜单：存库、定范围、删除 */
  UK.openMenu = function (event, node) {
    UK.closeMenu()
    UK.select(node.id)
    var menu = UK.el('div', {
      class: 'ui-menu',
      id: 'uk-menu',
      style: { left: Math.min(event.clientX, window.innerWidth - 170) + 'px', top: Math.min(event.clientY, window.innerHeight - 150) + 'px' }
    })

    menu.appendChild(UK.el('button', {
      text: '存成库条目…',
      onclick: function () { UK.closeMenu(); UK.openExtract(node) }
    }))
    menu.appendChild(UK.el('button', {
      text: '框定本次范围',
      onclick: function () {
        UK.closeMenu()
        UK.state.scope = [node.id]
        UK.commit({ op: 'scope', ids: [node.id] })
      }
    }))
    menu.appendChild(UK.el('button', {
      text: '在父节点里新建兄弟',
      onclick: function () {
        UK.closeMenu()
        UK.addNode(node.parent || null)
      }
    }))
    menu.appendChild(UK.el('hr'))
    menu.appendChild(UK.el('button', {
      text: '删除节点',
      onclick: function () { UK.closeMenu(); UK.deleteNode(node.id) }
    }))

    document.body.appendChild(menu)
    setTimeout(function () { document.addEventListener('mousedown', UK.closeMenu, { once: true }) }, 0)
  }

  UK.closeMenu = function () {
    var m = document.getElementById('uk-menu')
    if (m) m.remove()
  }

  /* 新增节点：放在父节点里，落在可见区域中间偏上 */
  UK.addNode = function (parentId) {
    var spec = UK.state.spec
    var byId = UK.index(spec)
    var parent = parentId ? byId[parentId] : null
    var pw = parent ? parent.rect[2] : (spec.screen || {}).w || 1080
    var ph = parent ? parent.rect[3] : (spec.screen || {}).h || 1920
    var n = 1
    var base = (parent ? parent.id : 'Node') + '/New'
    var id = base
    while (byId[id]) { id = base + (++n) }
    var rect = [Math.round(pw * 0.1), Math.round(ph * 0.1), Math.round(Math.min(pw * 0.6, 240)), 44]
    UK.commit({
      op: 'add',
      parent: parentId,
      node: {
        id: id, parent: parentId, kind: 'text', rect: rect,
        text: { s: '新文本', size: 24, color: '#333333' },
        anchor: { min: [0, 0], max: [0, 0], pivot: [0, 0] }
      }
    })
    UK.select(id)
  }

  UK.deleteNode = function (id) {
    var node = UK.index(UK.state.spec)[id]
    if (!node) return
    UK.commit({ op: 'del', id: id })
    if (UK.state.selected === id) UK.select(null)
  }
})(window.__UIKIT__ = window.__UIKIT__ || {})
